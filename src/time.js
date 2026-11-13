/**
 * The clock helpers the two unattended organisers share.
 *
 * Both of them decide "is this a new day" from local time (the day the user is
 * living in, not UTC), and both call a model with a deadline. Three copies of
 * the day key had already appeared before this module existed; the copies are
 * the kind of duplication that drifts the moment one of them is fixed.
 */

/**
 * The local calendar key of a date.
 *
 * @param {number | Date} stamp - Milliseconds or a Date.
 * @returns {string} `YYYY-MM-DD` in local time.
 */
export function dayKeyOf(stamp) {
	const date = stamp instanceof Date ? stamp : new Date(stamp)
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${date.getFullYear()}-${month}-${day}`
}

/**
 * A signal that aborts one call after a deadline.
 *
 * @param {number} milliseconds - The deadline.
 * @returns {AbortSignal | undefined} The signal, or undefined on a runtime
 * without `AbortSignal.timeout`.
 */
export function timeoutSignal(milliseconds) {
	return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(milliseconds) : undefined
}
