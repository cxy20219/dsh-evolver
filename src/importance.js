/**
 * Tokenisation, keyword extraction and candidate scoring.
 *
 * Pure and deterministic: the same input always produces the same ranking, so
 * a recall result never depends on when it was asked for beyond the explicit
 * `now` the caller passes in.
 */

const STOPWORDS = new Set([
	// Chinese function words
	'的', '了', '和', '是', '在', '我', '你', '他', '她', '它', '们',
	'这', '那', '个', '有', '会', '要', '就', '也', '都', '而', '与',
	'把', '被', '让', '给', '对', '从', '到', '为', '以', '及', '或',
	'不', '没', '很', '更', '最', '可', '能', '但', '却', '还', '又',
	'上', '下', '里', '中', '外', '时', '后', '前', '么', '呢', '吧',
	'啊', '呀', '哦', '嗯', '一个', '这个', '那个', '什么', '怎么',
	'现在', '然后', '所以', '因为', '但是', '如果', '已经', '可以',
	// English function words
	'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
	'to', 'of', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this',
	'it', 'its', 'in', 'on', 'at', 'by', 'for', 'with', 'as', 'from',
	'i', 'you', 'we', 'they', 'he', 'she', 'do', 'does', 'did', 'done',
	'can', 'could', 'should', 'would', 'will', 'may', 'might', 'must',
	'have', 'has', 'had', 'not', 'no', 'yes', 'so', 'such', 'there',
	'here', 'what', 'which', 'who', 'when', 'where', 'why', 'how',
])

export { STOPWORDS }

const LATIN = /[a-z0-9][a-z0-9_.-]*/gi
const CJK_RUN = /[\u4e00-\u9fff]+/g

/**
 * Tokenise text into lowercase latin words plus CJK bigrams.
 *
 * Bigrams are used for CJK because there are no spaces to split on and a
 * unigram index over Chinese matches almost everything. 「不要改配置」yields
 * 不要/要改/改配/配置.
 *
 * @param {string} text - Source text.
 * @returns {string[]} Deduplicated tokens, capped at 2 occurrences each.
 */
export function tokenize(text) {
	const value = String(text ?? '')
	const counts = new Map()
	const push = token => {
		if (token.length < 2 && !/^[a-z0-9]$/.test(token)) return
		const count = counts.get(token) ?? 0
		if (count >= 2) return
		counts.set(token, count + 1)
	}
	for (const match of value.matchAll(LATIN)) push(match[0].toLowerCase())
	for (const match of value.matchAll(CJK_RUN)) {
		const run = match[0]
		if (run.length === 1) {
			push(run)
			continue
		}
		for (let index = 0; index + 2 <= run.length; index += 1) push(run.slice(index, index + 2))
	}
	return [...counts.keys()]
}

/**
 * Extract ranked keywords: tokens that carry meaning, longest first, then by
 * first appearance. Deterministic for a given text.
 *
 * @param {string} text - Source text.
 * @param {{limit?: number}} [options] - Maximum keywords.
 * @returns {string[]} Keywords.
 */
export function extractKeywords(text, { limit = 8 } = {}) {
	const firstSeen = new Map()
	const tokens = tokenize(text)
	for (let index = 0; index < tokens.length; index += 1) {
		if (!firstSeen.has(tokens[index])) firstSeen.set(tokens[index], index)
	}
	const ranked = [...firstSeen.keys()]
		.filter(token => !STOPWORDS.has(token))
		.filter(token => token.length <= 32)
		.sort((left, right) => right.length - left.length || firstSeen.get(left) - firstSeen.get(right) || left.localeCompare(right))
	return ranked.slice(0, Math.max(0, limit))
}

/**
 * Exponential half-life decay, clamped to [0, 1].
 *
 * @param {number} importance - Original importance.
 * @param {{ageMs: number, halfLifeMs: number}} options - Age and half-life.
 * @returns {number} Decayed importance.
 */
export function decayImportance(importance, { ageMs, halfLifeMs }) {
	const value = Number(importance)
	if (!Number.isFinite(value)) return 0
	if (!(ageMs > 0)) return Math.min(1, Math.max(0, value))
	if (!(halfLifeMs > 0)) return Math.min(1, Math.max(0, value))
	const decayed = value * 0.5 ** (ageMs / halfLifeMs)
	return Math.min(1, Math.max(0, decayed))
}

const FRESH_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000

/** A frequently used memory stays fresh longer; the extension is capped. */
const MAX_HALF_LIFE_MULTIPLIER = 3

/** Reference length for the length normalisation. */
const LENGTH_ANCHOR = 500

function overlapRatio(queryTokens, candidateTokens) {
	if (queryTokens.size === 0) return 0
	let hits = 0
	for (const token of queryTokens) if (candidateTokens.has(token)) hits += 1
	return hits / queryTokens.size
}

/**
 * The share of the query's tokens a candidate matches.
 *
 * The recall filter needs the keyword part of the score on its own: a
 * candidate that matches nothing in the query is noise, however important or
 * fresh it is.
 *
 * @param {object} candidate - Candidate record.
 * @param {string} query - Search query.
 * @returns {number} The overlap ratio in [0, 1].
 */
export function keywordOverlap(candidate, query) {
	if (candidate === undefined || candidate === null) return 0
	const queryTokens = new Set(tokenize(query))
	if (queryTokens.size === 0) return 0
	const text = [candidate.title, candidate.text].filter(value => typeof value === 'string').join('\n')
	const candidateTokens = new Set([...tokenize(text), ...(Array.isArray(candidate.keywords) ? candidate.keywords.flatMap(keyword => tokenize(keyword)) : [])])
	return overlapRatio(queryTokens, candidateTokens)
}

/**
 * The half-life of a memory's freshness, extended by how often it is used.
 *
 * A memory the model keeps reaching for should not fade like one it never
 * touches. The extension grows logarithmically and is capped, so a popular
 * memory stays alive but never becomes permanent.
 *
 * @param {number} useCount - How often the memory has been recalled.
 * @returns {number} The multiplier in [1, MAX_HALF_LIFE_MULTIPLIER].
 */
export function reinforcementMultiplier(useCount) {
	const count = Number(useCount)
	if (!Number.isFinite(count) || count <= 0) return 1
	return Math.min(MAX_HALF_LIFE_MULTIPLIER, 1 + Math.log2(1 + count))
}

/**
 * A length normalisation factor.
 *
 * Long entries match more tokens by accident and would crowd out short,
 * precise ones. Entries at or below the anchor are untouched; longer ones are
 * scaled down as they grow.
 *
 * @param {number} length - Text length in characters.
 * @returns {number} The factor in (0, 1].
 */
export function lengthFactor(length) {
	const size = Number(length)
	if (!Number.isFinite(size) || size <= LENGTH_ANCHOR) return 1
	return 1 / (1 + 0.5 * Math.log2(size / LENGTH_ANCHOR))
}

/**
 * Score one candidate against a query.
 *
 * Components, each bounded so no single signal can dominate:
 *   - keyword overlap (0 .. 0.6): exact tokens only, no substring matching;
 *   - weight (0 .. 0.25): alpha for archived spans, else importance;
 *   - freshness (0 .. 0.1): decayed over a 30-day half-life;
 *   - pinned bonus (0 .. 0.05).
 * A candidate whose `beta` is negative is contradicted or untrusted material,
 * so it is scaled down rather than deleted: it can still be recalled when it
 * is the only match, but it never outranks trusted content.
 *
 * @param {object} candidate - Candidate record.
 * @param {string} query - Search query.
 * @param {{now?: Date}} [options] - Clock.
 * @returns {number} Score in [0, 1], rounded to 4 decimals.
 */
export function scoreCandidate(candidate, query, { now = new Date() } = {}) {
	if (candidate === undefined || candidate === null) return 0
	const overlap = keywordOverlap(candidate, query) * 0.55

	const weightSource = typeof candidate.alpha === 'number'
		? candidate.alpha
		: typeof candidate.importance === 'number' ? candidate.importance : 0.5
	const weight = Math.min(1, Math.max(0, weightSource)) * 0.22

	let freshness = 0
	if (typeof candidate.updatedAt === 'string') {
		const age = now.getTime() - Date.parse(candidate.updatedAt)
		if (Number.isFinite(age)) {
			const halfLife = FRESH_HALF_LIFE_MS * reinforcementMultiplier(candidate.useCount)
			freshness = decayImportance(1, { ageMs: age, halfLifeMs: halfLife }) * 0.1
		}
	}

	// How often the memory has been recalled. Logarithmic, so the tenth
	// recall is worth much less than the first.
	const count = Number(candidate.useCount)
	const frequency = Number.isFinite(count) && count > 0
		? Math.min(1, Math.log2(1 + count) / 4) * 0.08
		: 0

	const pinnedBonus = candidate.pinned === true ? 0.05 : 0
	let score = (overlap + weight + freshness + frequency + pinnedBonus) * lengthFactor(textLength(candidate))
	if (typeof candidate.beta === 'number' && candidate.beta < 0) score *= 0.25
	return Number(Math.min(1, Math.max(0, score)).toFixed(4))
}

/**
 * The share of tokens two texts have in common.
 *
 * The similarity is measured over the *smaller* text's tokens, so a short
 * statement fully contained in a longer one counts as the same thing.
 *
 * @param {string} left - First text.
 * @param {string} right - Second text.
 * @returns {number} The similarity in [0, 1].
 */
export function textSimilarity(left, right) {
	const a = new Set(tokenize(left))
	const b = new Set(tokenize(right))
	if (a.size === 0 || b.size === 0) return 0
	let shared = 0
	for (const token of a) if (b.has(token)) shared += 1
	return shared / Math.min(a.size, b.size)
}

/**
 * The length of a candidate's text, used by the length normalisation.
 *
 * @param {object} candidate - Candidate record.
 * @returns {number} The character count.
 */
function textLength(candidate) {
	const text = [candidate.title, candidate.text].filter(value => typeof value === 'string').join('')
	return text.length
}
