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
export const TIERS = {
	core: { beta: 0.8, floor: 0.9, halfLifeDays: 90 },
	working: { beta: 1.0, floor: 0.7, halfLifeDays: 30 },
	peripheral: { beta: 1.3, floor: 0.5, halfLifeDays: 10 },
}

/** The weights of the composite score. */
export const COMPOSITE_WEIGHTS = { recency: 0.4, frequency: 0.3, intrinsic: 0.3 }

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The tier a memory belongs to, defaulting to `working`.
 *
 * @param {object} memory - The memory record.
 * @returns {string} The tier name.
 */
export function tierOf(memory) {
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
export function recency(memory, now = new Date()) {
	const updated = Date.parse(String(memory?.updatedAt ?? ''))
	if (!Number.isFinite(updated)) return 0
	const days = Math.max(0, (now.getTime() - updated) / DAY_MS)
	const tier = TIERS[tierOf(memory)]
	const lambda = Math.LN2 / Math.max(1, tier.halfLifeDays)
	const value = Math.exp(-lambda * Math.pow(days, tier.beta))
	return Math.max(tier.floor, Math.min(1, value))
}

/**
 * The effective half-life of a memory.
 *
 * An important memory lasts longer, and so does one the model keeps reaching
 * for: the access count extends the half-life logarithmically, capped so a
 * popular memory never becomes permanent.
 *
 * @param {object} memory - The memory record.
 * @returns {number} The half-life in days.
 */
export function effectiveHalfLifeDays(memory) {
	const tier = TIERS[tierOf(memory)]
	const importance = Number(memory?.importance)
	const importanceFactor = Number.isFinite(importance) ? Math.exp(0.6 * importance) : 1
	const count = Number(memory?.accessCount ?? 0)
	const reinforcement = Number.isFinite(count) && count > 0 ? Math.min(3, 1 + Math.log2(1 + count)) : 1
	return tier.halfLifeDays * importanceFactor * reinforcement
}

/**
 * The frequency term: how often the memory has been recalled.
 *
 * Logarithmic, so the tenth recall is worth much less than the first.
 *
 * @param {object} memory - The memory record.
 * @returns {number} The frequency in [0, 1].
 */
export function frequency(memory) {
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
export function intrinsic(memory) {
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
export function compositeScore(memory, now = new Date()) {
	const score = COMPOSITE_WEIGHTS.recency * recency(memory, now)
		+ COMPOSITE_WEIGHTS.frequency * frequency(memory)
		+ COMPOSITE_WEIGHTS.intrinsic * intrinsic(memory)
	return Math.min(1, Math.max(0, score))
}

/**
 * The tier a memory should be in, given how it has been used.
 *
 * Promotion needs sustained use, not a single recall: a memory is promoted
 * when it is both used and important, and demoted when it has been neither
 * touched nor important for a long time.
 *
 * @param {object} memory - The memory record.
 * @param {Date} [now] - Clock.
 * @returns {string} The tier the memory should have.
 */
export function suggestedTier(memory, now = new Date()) {
	const current = tierOf(memory)
	const score = compositeScore(memory, now)
	const count = Number(memory?.accessCount ?? 0)
	const importance = Number(memory?.importance ?? 0)
	const updated = Date.parse(String(memory?.updatedAt ?? ''))
	const days = Number.isFinite(updated) ? (now.getTime() - updated) / DAY_MS : Infinity
	if (current === 'peripheral') {
		if (count >= 3 && score >= 0.55) return 'working'
		return 'peripheral'
	}
	if (current === 'working') {
		if (count >= 5 && score >= 0.7 && importance >= 0.7) return 'core'
		if (count === 0 && days > 60 && score < 0.35) return 'peripheral'
		return 'working'
	}
	if (count === 0 && days > 180 && score < 0.3) return 'working'
	return 'core'
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
