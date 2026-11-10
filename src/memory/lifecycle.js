/**
 * Memory lifecycle: how fast a memory fades, and when it is promoted or
 * demoted between tiers.
 *
 * The model is a Weibull decay: `recency = exp(-λ · daysSince^β)`. The
 * exponent decides the shape of the curve — below 1 the decline is gentle,
 * above 1 it accelerates. Three tiers give three shapes:
 *
 *   core       β=0.8  a constraint that should stay
 *   working    β=1.0  the current job, ordinary exponential decay
 *   peripheral β=1.3  something useful but forgettable
 *
 * A tier also sets a floor, so even a long-neglected core memory keeps a
 * visible share of its weight.
 */

/** The three tiers and their parameters. */
const TIERS = {
	core: { beta: 0.8, floor: 0.9, halfLifeDays: 90 },
	working: { beta: 1.0, floor: 0.7, halfLifeDays: 30 },
	peripheral: { beta: 1.3, floor: 0.5, halfLifeDays: 10 },
}

/** The weights of the composite score. */
const COMPOSITE_WEIGHTS = { recency: 0.4, frequency: 0.3, intrinsic: 0.3 }

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The tier a memory belongs to, defaulting to `working`.
 *
 * @param {object} memory - The memory record.
 * @returns {string} The tier name.
 */
function tierOf(memory) {
	const tier = typeof memory?.tier === 'string' ? memory.tier : undefined
	return tier !== undefined && TIERS[tier] !== undefined ? tier : 'working'
}

/**
 * The Weibull recency of a memory.
 *
 * @param {object} memory - The memory record.
 * @param {Date} [now] - Clock.
 * @returns {number} The recency in [0, 1].
 */
function recency(memory, now = new Date()) {
	const updated = Date.parse(String(memory?.updatedAt ?? ''))
	if (!Number.isFinite(updated)) return 0
	const days = Math.max(0, (now.getTime() - updated) / DAY_MS)
	const tier = TIERS[tierOf(memory)]
	const lambda = Math.LN2 / Math.max(1, tier.halfLifeDays)
	const value = Math.exp(-lambda * Math.pow(days, tier.beta))
	return Math.max(tier.floor, Math.min(1, value))
}

/**
 * The frequency term: how often the memory has been recalled.
 *
 * Logarithmic, so the tenth recall is worth much less than the first.
 *
 * @param {object} memory - The memory record.
 * @returns {number} The frequency in [0, 1].
 */
function frequency(memory) {
	const count = Number(memory?.accessCount ?? 0)
	if (!Number.isFinite(count) || count <= 0) return 0
	return Math.min(1, Math.log2(1 + count) / 6)
}

/**
 * The intrinsic term: how important and how trustworthy the memory is.
 *
 * @param {object} memory - The memory record.
 * @returns {number} The intrinsic score in [0, 1].
 */
function intrinsic(memory) {
	const importance = Number(memory?.importance)
	const confidence = Number(memory?.confidence ?? 0.7)
	if (!Number.isFinite(importance)) return 0
	return Math.min(1, Math.max(0, importance)) * Math.min(1, Math.max(0, confidence))
}

/**
 * The composite lifecycle score of a memory.
 *
 * Recency 40%, frequency 30%, intrinsic 30% — the same weighting the
 * reference implementation uses.
 *
 * @param {object} memory - The memory record.
 * @param {Date} [now] - Clock.
 * @returns {number} The composite score in [0, 1].
 */
function compositeScore(memory, now = new Date()) {
	const score = COMPOSITE_WEIGHTS.recency * recency(memory, now)
		+ COMPOSITE_WEIGHTS.frequency * frequency(memory)
		+ COMPOSITE_WEIGHTS.intrinsic * intrinsic(memory)
	return Math.min(1, Math.max(0, score))
}

/**
 * The boost a memory gets in the retrieval pipeline.
 *
 * The lifecycle multiplies the fused score rather than adding to it, so a
 * fresh, used, important memory outranks a stale one without letting the
 * boost decide the match on its own.
 *
 * @param {object} memory - The memory record.
 * @param {Date} [now] - Clock.
 * @returns {number} The multiplier in [0.5, 1.5].
 */
export function lifecycleBoost(memory, now = new Date()) {
	return 0.5 + compositeScore(memory, now)
}
