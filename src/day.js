/**
 * The local day key.
 *
 * Calendar-facing data (the activity heatmap, the organize ledger) uses the
 * user's local day, not UTC: a file written at 00:30 belongs to that calendar
 * day even though UTC still says yesterday.
 */

/**
 * The local day, as `YYYY-MM-DD`.
 *
 * @param {Date} [date] - The moment.
 * @returns {string} The day key.
 */
export function dayKey(date = new Date()) {
	const year = date.getFullYear()
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${year}-${month}-${day}`
}
