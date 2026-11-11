import { tokenize } from './db.js'
import { lifecycleBoost } from './lifecycle.js'

/**
 * The retrieval pipeline.
 *
 * The order is the point: a query is answered by the best *textual* match,
 * then the lifecycle decides how much that match is worth, and diversity
 * decides which of the surviving matches are worth showing.
 *
 *   query → BM25 → [rerank] → lifecycle boost → length normalisation
 *         → hard minimum → MMR diversity
 *
 * Match, not meaning: an embedding model was measured against this on the
 * real library and moved ranking, never recall — 90% either way on
 * paraphrased questions — while costing 592 MB and a startup pause. The
 * reference design does the same thing, with a text search over transcripts.
 */

/** The shortest result that is still worth showing. */
const HARD_MIN_SCORE = 0.12

/**
 * The share of the query's tokens a memory has to match.
 *
 * One shared bigram is not evidence: 「怎么」appears in half of Chinese.
 * A quarter of the query's tokens is the point where a match starts to mean
 * something.
 */
const KEYWORD_MIN_OVERLAP = 0.25

/**
 * How close to the best keyword hit a memory has to score to count as a
 * confident keyword match.
 *
 * BM25 already weighs terms by rarity, so re-testing the winner with a crude
 * "share of query tokens" is how a paraphrase question — 「改完插件为什么界面
 * 上看不到变化」 against a card that says 「接口要同时在两处登记」 — ended up
 * returning nothing at all: too few shared words to clear the overlap gate.
 */
const KEYWORD_CONFIDENT_SHARE = 0.45

/** How much of the final selection favours relevance over variety. */
const MMR_LAMBDA = 0.7

/** Two results this alike say the same thing; only the better one is kept. */
const DUPLICATE_THRESHOLD = 0.9

/**
 * A length normalisation factor.
 *
 * Long memories match more words by accident and would crowd out short,
 * precise ones.
 *
 * @param {string} text - The memory text.
 * @returns {number} The factor in (0, 1].
 */
function lengthFactor(text) {
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
function mmrSelect(candidates, {
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
 * @param {number} [options.limit] - Maximum results.
 * @param {number} [options.minScore] - The hard minimum.
 * @param {(ids: string[]) => Promise<Map<string, number>>} [options.rerank] - An optional reranker.
 * @param {Date} [options.now] - Clock.
 * @returns {Promise<Array<{id: string, score: number, memory: object}>>} The results.
 */
export async function hybridRetrieve({ db, query, limit = 8, minScore = HARD_MIN_SCORE, rerank, now = new Date() }) {
	const keyword = db.bm25(query, 50)
	const keywordScores = new Map(keyword.map(item => [item.id, item.score]))

	// BM25 scores are not comparable across queries, so the ranking is scaled
	// against its own best hit before anything else looks at it. Without this
	// the hard minimum would throw every result away for a rare-word query.
	const top = keyword.length === 0 ? 0 : keyword[0].score
	let scored = keyword.map(item => ({
		id: item.id,
		score: top > 0 ? item.score / top : 0,
		keywordScore: keywordScores.get(item.id) ?? 0,
		memory: db.memories.get(item.id),
	})).filter(item => item.memory !== undefined)

	// The relevance gate: a memory has to match the query somehow — enough of
	// its words, or a strong enough keyword score to stand on its own. The
	// second branch is what keeps a paraphrase question from returning
	// nothing: BM25 already weighed rarity and ranked that memory first.
	const queryTokens = new Set(tokenize(query))
	scored = scored.map(item => {
		const memoryTokens = db.tokenSet(item.id)
		let shared = 0
		for (const token of queryTokens) if (memoryTokens.has(token)) shared += 1
		return { ...item, overlap: queryTokens.size === 0 ? 0 : shared / queryTokens.size }
	})
	// An empty query is a request for "what is stored", not for a match.
	if (queryTokens.size > 0) {
		const bestKeyword = keyword.length === 0 ? 0 : keyword[0].score
		const confident = (item) => bestKeyword > 0 && item.keywordScore >= bestKeyword * KEYWORD_CONFIDENT_SHARE
		scored = scored.filter(item => item.overlap >= KEYWORD_MIN_OVERLAP || confident(item))
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
		const normalised = boosted * lengthFactor(item.memory.body ?? item.memory.text)
		return { ...item, score: Number(normalised.toFixed(4)) }
	}).filter(item => item.score >= minScore)

	scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))

	// MMR only reorders; it does not remove. Two memories that say the same
	// thing would still both be shown, so the near-duplicates go. Both use the
	// same index-time token sets, so this costs no extra tokenisation.
	// MMR and the duplicate filter ask the same question about the same pair
	// many times — every round of selection re-tests every candidate against
	// everything already chosen. Caching the answer by id pair turns that from
	// O(candidates² × selected) intersections into one per distinct pair.
	const pairs = new Map()
	const similarityOf = (left, right) => {
		const key = left.id < right.id ? `${left.id}\u0000${right.id}` : `${right.id}\u0000${left.id}`
		const cached = pairs.get(key)
		if (cached !== undefined) return cached
		const a = db.tokenSet(left.id)
		const b = db.tokenSet(right.id)
		let value = 0
		if (a.size > 0 && b.size > 0) {
			let shared = 0
			for (const token of a) if (b.has(token)) shared += 1
			value = shared / Math.min(a.size, b.size)
		}
		pairs.set(key, value)
		return value
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
