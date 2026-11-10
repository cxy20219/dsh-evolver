import { cosine } from './embed.js'
import { tokenize } from './db.js'
import { lifecycleBoost } from './lifecycle.js'

/**
 * The hybrid retrieval pipeline.
 *
 * The order follows the reference implementation, because the order is the
 * point: a query is answered by the best *textual* match, then the lifecycle
 * decides how much that match is worth, and diversity decides which of the
 * surviving matches are worth showing.
 *
 *   query → BM25 + vector → RRF fusion → [rerank] → lifecycle boost
 *         → length normalisation → hard minimum → MMR diversity
 */

/** The rank constant of reciprocal rank fusion. */
export const RRF_K = 60

/** The weight of the vector side of the fusion. */
export const VECTOR_WEIGHT = 0.7

/** The weight of the keyword side of the fusion. */
export const BM25_WEIGHT = 0.3

/** The shortest result that is still worth showing. */
export const HARD_MIN_SCORE = 0.12

/**
 * How many standard deviations above the corpus baseline a vector match has
 * to be.
 *
 * Absolute thresholds do not travel between models: the hashing embedder
 * separates cleanly (a hit at 0.6, noise at 0.3) while a multilingual model
 * puts both in the same band (a hit at 0.90, noise at 0.85). So a model
 * backend is judged *relative to the corpus*: the winner has to stand out
 * from the other memories for this query.
 */
export const VECTOR_SIGMA = 2.5

/** The smallest spread the rule will divide by. */
export const MIN_SIGMA = 0.01

/**
 * The smallest corpus the sigma rule can judge.
 *
 * With one or two vectors the standard deviation is a quarter of their
 * distance, so "baseline + 2.5σ" is always above the best score and every
 * semantic hit is filtered out. A small store therefore uses the backend's
 * absolute floor (or no floor at all) instead.
 */
export const MIN_SIGMA_SAMPLE = 5

/**
 * The share of the query's tokens a memory has to match.
 *
 * One shared bigram is not evidence: 「怎么」appears in half of Chinese.
 * A quarter of the query's tokens is the point where a match starts to mean
 * something.
 */
export const KEYWORD_MIN_OVERLAP = 0.25

/** How much of the final selection favours relevance over variety. */
export const MMR_LAMBDA = 0.7

/** Two results this alike say the same thing; only the better one is kept. */
export const DUPLICATE_THRESHOLD = 0.9

/**
 * Fuse several rankings with reciprocal rank fusion.
 *
 * Rank fusion is used rather than a weighted sum of scores because BM25 and
 * cosine live on different scales: only their *order* is comparable.
 *
 * @param {Array<{id: string, score: number}[]>} rankings - The rankings to fuse.
 * @param {number[]} [weights] - One weight per ranking.
 * @returns {Map<string, number>} The fused score per id.
 */
export function rrfFusion(rankings, weights = []) {
	const fused = new Map()
	for (let index = 0; index < rankings.length; index += 1) {
		const ranking = rankings[index]
		const weight = weights[index] ?? 1
		ranking.forEach((item, position) => {
			fused.set(item.id, (fused.get(item.id) ?? 0) + weight / (RRF_K + position + 1))
		})
	}
	return fused
}

/**
 * The vector ranking of a query against every stored vector.
 *
 * @param {{vectors: Map<string, number[]>, memories: Map<string, object>}} db - The store.
 * @param {Float32Array | number[] | undefined} queryVector - The query vector.
 * @param {number} [limit] - Maximum hits.
 * @returns {Array<{id: string, score: number}>} The hits, best first.
 */
export function vectorRanking(db, queryVector, limit = 50) {
	return allVectorScores(db, queryVector).slice(0, limit)
}

/**
 * The cosine of a query against every stored vector.
 *
 * The whole distribution matters, not only the top: the relevance rule
 * compares a hit against the corpus baseline for this query.
 *
 * @param {{vectors: Map<string, number[]>, memories: Map<string, object>}} db - The store.
 * @param {Float32Array | number[] | undefined} queryVector - The query vector.
 * @returns {Array<{id: string, score: number}>} The scores, best first.
 */
export function allVectorScores(db, queryVector) {
	if (!queryVector || queryVector.length === 0) return []
	const hits = []
	for (const [id, vector] of db.vectors) {
		if (db.memories.get(id) === undefined) continue
		const similarity = cosine(queryVector, vector)
		if (similarity <= 0) continue
		hits.push({ id, score: similarity })
	}
	return hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
}

/**
 * A length normalisation factor.
 *
 * Long memories match more words by accident and would crowd out short,
 * precise ones.
 *
 * @param {string} text - The memory text.
 * @returns {number} The factor in (0, 1].
 */
export function lengthFactor(text) {
	const size = String(text ?? '').length
	if (size <= 500) return 1
	return 1 / (1 + 0.5 * Math.log2(size / 500))
}

/**
 * Pick a set of results that are both relevant and varied.
 *
 * Maximal marginal relevance: at each step take the candidate with the best
 * trade-off between its own score and its similarity to what is already
 * selected.
 *
 * @param {Array<{id: string, score: number, text: string}>} candidates - The candidates.
 * @param {{lambda?: number, limit?: number}} [options] - Selection options.
 * @returns {Array<object>} The selected candidates.
 */
export function mmrSelect(candidates, {
	lambda = MMR_LAMBDA,
	limit = 8,
	similarity = (left, right) => textOverlap(left.text, right.text),
} = {}) {
	const selected = []
	const pool = [...candidates]
	while (pool.length > 0 && selected.length < limit) {
		let bestIndex = 0
		let bestValue = -Infinity
		for (let index = 0; index < pool.length; index += 1) {
			const candidate = pool[index]
			let worst = 0
			for (const chosen of selected) {
				const value = similarity(chosen, candidate)
				if (value > worst) worst = value
			}
			const value = lambda * candidate.score - (1 - lambda) * worst
			if (value > bestValue) {
				bestValue = value
				bestIndex = index
			}
		}
		selected.push(pool.splice(bestIndex, 1)[0])
	}
	return selected
}

/**
 * The share of words two texts have in common.
 *
 * @param {string} left - First text.
 * @param {string} right - Second text.
 * @returns {number} The similarity in [0, 1].
 */
export function textOverlap(left, right) {
	// Tokenised overlap rather than whitespace overlap: Chinese is written
	// without spaces, so splitting on whitespace made every Chinese memory a
	// single token and every similarity either 0 or 1 — MMR and the duplicate
	// threshold silently never fired for the language most of this store is in.
	const a = new Set(tokenize(left))
	const b = new Set(tokenize(right))
	if (a.size === 0 || b.size === 0) return 0
	let shared = 0
	for (const token of a) if (b.has(token)) shared += 1
	return shared / Math.min(a.size, b.size)
}

/**
 * Run the whole pipeline.
 *
 * @param {object} options - Query options.
 * @param {object} options.db - The store.
 * @param {string} options.query - The query text.
 * @param {Float32Array | number[] | undefined} options.queryVector - The query vector.
 * @param {number} [options.limit] - Maximum results.
 * @param {number} [options.minScore] - The hard minimum.
 * @param {(ids: string[]) => Promise<Map<string, number>>} [options.rerank] - An optional reranker.
 * @param {Date} [options.now] - Clock.
 * @returns {Promise<Array<{id: string, score: number, memory: object}>>} The results.
 */
export async function hybridRetrieve({ db, query, queryVector, limit = 8, minScore = HARD_MIN_SCORE, floor, rerank, now = new Date() }) {
	const keyword = db.bm25(query, 50)
	const vector = allVectorScores(db, queryVector)
	const keywordScores = new Map(keyword.map(item => [item.id, item.score]))
	const vectorScores = new Map(vector.map(item => [item.id, item.score]))
	const fused = rrfFusion([vector.slice(0, 50), keyword], [VECTOR_WEIGHT, BM25_WEIGHT])

	// The relevance line: either the backend knows where its hits start, or
	// the winner has to stand out from the corpus for this query.
	const baseline = vector.length === 0
		? 0
		: vector.reduce((sum, item) => sum + item.score, 0) / vector.length
	const spread = vector.length === 0
		? 0
		: Math.sqrt(vector.reduce((sum, item) => sum + (item.score - baseline) ** 2, 0) / vector.length)
	const relativeFloor = vector.length < MIN_SIGMA_SAMPLE
		? 0
		: baseline + VECTOR_SIGMA * Math.max(spread, MIN_SIGMA)
	// A backend that knows where its hits start has an absolute floor; one
	// that does not is judged against the corpus baseline alone.
	const vectorFloor = typeof floor === 'number'
		? Math.max(relativeFloor, floor)
		: relativeFloor

	// Rank fusion produces small numbers (1/(k+rank)), so the fused scores
	// are scaled against the best one before anything else looks at them.
	// Without this the hard minimum would throw every result away.
	const top = [...fused.values()].reduce((max, value) => Math.max(max, value), 0)
	let scored = [...fused.entries()].map(([id, score]) => {
		const memory = db.memories.get(id)
		return {
			id,
			score: top > 0 ? score / top : 0,
			fusedScore: score,
			keywordScore: keywordScores.get(id) ?? 0,
			vectorScore: vectorScores.get(id) ?? 0,
			memory,
		}
	}).filter(item => item.memory !== undefined)

	// The relevance gate: a memory has to match the query somehow — enough of
	// its words, or an embedding close enough to believe.
	const queryTokens = new Set(tokenize(query))
	scored = scored.map(item => {
		const memoryTokens = db.tokenSet(item.id)
		let shared = 0
		for (const token of queryTokens) if (memoryTokens.has(token)) shared += 1
		return { ...item, overlap: queryTokens.size === 0 ? 0 : shared / queryTokens.size }
	})
	// An empty query is a request for "what is stored", not for a match.
	if (queryTokens.size > 0) {
		scored = scored.filter(item => item.overlap >= KEYWORD_MIN_OVERLAP || item.vectorScore >= vectorFloor)
	}

	if (rerank !== undefined && scored.length > 0) {
		try {
			const reranked = await rerank(scored.map(item => item.id))
			for (const item of scored) {
				const value = reranked.get(item.id)
				if (value !== undefined) item.score = item.score * 0.4 + value * 0.6
			}
		} catch {
			// A failed rerank leaves the fused order alone.
		}
	}

	scored = scored.map(item => {
		const boosted = item.score * lifecycleBoost(item.memory, now)
		const normalised = boosted * lengthFactor(item.memory.text)
		return { ...item, score: Number(normalised.toFixed(4)) }
	}).filter(item => item.score >= minScore)

	scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))

	// MMR only reorders; it does not remove. Two memories that say the same
	// thing would still both be shown, so the near-duplicates go. Both use the
	// same index-time token sets, so this costs no extra tokenisation.
	const similarityOf = (left, right) => {
		const a = db.tokenSet(left.id)
		const b = db.tokenSet(right.id)
		if (a.size === 0 || b.size === 0) return 0
		let shared = 0
		for (const token of a) if (b.has(token)) shared += 1
		return shared / Math.min(a.size, b.size)
	}
	const selected = []
	for (const item of mmrSelect(scored, { limit, similarity: similarityOf })) {
		const redundant = selected.some(other => similarityOf(other, item) >= DUPLICATE_THRESHOLD)
		if (redundant) continue
		selected.push(item)
	}
	return selected.map(item => ({
		id: item.id,
		score: item.score,
		memory: item.memory,
	}))
}
