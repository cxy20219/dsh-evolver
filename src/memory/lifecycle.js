/**
 * Memory lifecycle: how much a match is discounted for being stale.
 *
 * Cards written by this plugin carry `updated` and nothing else: there is no
 * access counter or importance field on a card, so a composite 40/30/30 score
 * would silently be a recency score with two zero terms. Keep the honest
 * version — one Weibull-shaped recency curve — and a boost in [0.5, 1].
 */

/** The tier parameters: the shape of the fade. */
const TIERS = {
	core: { beta: 0.8, floor: 0.9, halfLifeDays: 90 },
	working: { beta: 1.0, floor: 0.7, halfLifeDays: 30 },
	peripheral: { beta: 1.3, floor: 0.5, halfLifeDays: 10 },
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The tier a memory belongs to, defaulting to `working`.
 *
 * `tier` is only present on imported records; the card writer never sets it.
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
	const updated = Date.parse(String(memory?.updated ?? memory?.updatedAt ?? ''))
	if (!Number.isFinite(updated)) return 0
	const days = Math.max(0, (now.getTime() - updated) / DAY_MS)
	const tier = TIERS[tierOf(memory)]
	const lambda = Math.LN2 / Math.max(1, tier.halfLifeDays)
	const value = Math.exp(-lambda * Math.pow(days, tier.beta))
	return Math.max(tier.floor, Math.min(1, value))
}

/**
 * The boost a memory gets in the retrieval pipeline.
 *
 * Multiplicative, in [0.9, 1.2]: recency reorders near-ties without letting an
 * old note outrank a match on its own.
 *
 * @param {object} memory - The memory record.
 * @param {Date} [now] - Clock.
 * @returns {number} The multiplier.
 */
export function lifecycleBoost(memory, now = new Date()) {
	return 0.5 + 0.5 * recency(memory, now)
}
