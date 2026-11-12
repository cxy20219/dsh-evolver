/**
 * The daily health card.
 *
 * A job rather than a script on purpose: the card lives in the same store the
 * plugin writes, and a second process appending to `cards.jsonl` would leave
 * the running plugin with a stale picture of its own library until restart.
 *
 * The numbers themselves are computed in `cards/health.js`; this file owns the
 * ledger, the once-a-day decision and the card itself.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { MAX_ROWS, REPORT_TAGS, REPORT_TITLE, healthMetrics, renderReport } from './cards/health.js'

/** How often to look at the clock. */
const CHECK_INTERVAL_MS = 10 * 60_000

/** The hour the day's row is written, local time. */
const REPORT_HOUR = 9

/** The local calendar key of a date. */
export function dayKeyOf(stamp) {
	const date = new Date(stamp)
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Create the daily health card job.
 *
 * @param {{store: Function, logger?: object, now?: Function, cache?: Function, isBusy?: () => boolean}} deps - The services the job uses.
 * @returns {{check: Function, runNow: Function, start: Function}} The job.
 */
export function createHealthJob({ store, logger, now = () => Date.now(), cache, isBusy }) {
	let timer
	let inFlight = null

	/**
	 * Where the series lives.
	 *
	 * It is kept next to the other ledgers rather than on the card, because
	 * the card body is capped and a year of rows would not fit.
	 *
	 * @returns {string} The path.
	 */
	function ledgerPath() {
		const current = store()
		if (current === undefined) throw new Error('卡片库还没有打开。')
		return join(current.dataDir, 'knowledge', 'health.json')
	}

	/**
	 * Read the series, tolerating a missing or broken file.
	 *
	 * @returns {Promise<{cardId: string, rows: object[], lastRunAt: string}>} The ledger.
	 */
	async function readLedger() {
		try {
			const parsed = JSON.parse(await readFile(ledgerPath(), 'utf8'))
			return {
				cardId: typeof parsed?.cardId === 'string' ? parsed.cardId : '',
				rows: Array.isArray(parsed?.rows) ? parsed.rows.filter((row) => typeof row?.date === 'string') : [],
				lastRunAt: typeof parsed?.lastRunAt === 'string' ? parsed.lastRunAt : '',
			}
		} catch {
			return { cardId: '', rows: [], lastRunAt: '' }
		}
	}

	/**
	 * Write the series without leaving a half-written file.
	 *
	 * @param {object} ledger - The ledger.
	 * @returns {Promise<void>} Resolves once it is on disk.
	 */
	async function writeLedger(ledger) {
		const path = ledgerPath()
		await mkdir(dirname(path), { recursive: true, mode: 0o700 })
		const temp = `${path}.${process.pid}.tmp`
		await writeFile(temp, `${JSON.stringify(ledger, null, '\t')}\n`, { mode: 0o600 })
		await rename(temp, path)
	}

	/**
	 * Replace the card's body, creating the card the first time.
	 *
	 * @param {object} current - The card store.
	 * @param {object} ledger - The ledger, updated in place with the card id.
	 * @param {string} body - The rendered report.
	 * @returns {Promise<void>} Resolves once the card is saved.
	 */
	async function saveCard(current, ledger, body) {
		const existing = ledger.cardId === '' ? undefined : current.get(ledger.cardId)
		if (existing !== undefined) {
			await current.put({ id: existing.id, body, tags: existing.tags, links: existing.links })
			return
		}
		const created = await current.put({ body, tags: REPORT_TAGS })
		ledger.cardId = created.id
	}

	/**
	 * Compute today's row and rewrite the card.
	 *
	 * @returns {Promise<object>} What was written.
	 */
	async function performRun() {
		const current = store()
		if (current === undefined) throw new Error('卡片库还没有打开。')
		const ledger = await readLedger()
		// The report card is instrumentation, not knowledge: counting it would
		// make the numbers drift with the report itself.
		const cards = current.all().filter((card) => !String(card.label ?? '').startsWith(REPORT_TITLE))
		const metrics = healthMetrics(cards, current.backlinks())
		const date = dayKeyOf(now())
		// The cache numbers are a probe of the day's sessions, not of the card
		// store, so they are optional: an unavailable provider leaves the
		// columns empty rather than greeting the day with zeros.
		const cacheStats = typeof cache === 'function'
			? await cache(date).catch(() => null)
			: null
		const rows = ledger.rows.filter((row) => row.date !== date)
		rows.push({
			date,
			...metrics,
			...(cacheStats === null || cacheStats === undefined
				? {}
				: { cacheHit: cacheStats.hit, cacheMisses: cacheStats.misses, cacheSessions: cacheStats.sessions }),
		})
		// Keep the newest MAX_ROWS; the oldest fall off rather than the card
		// growing until it hits the body cap.
		const kept = rows.slice(-MAX_ROWS)
		await saveCard(current, ledger, renderReport(kept))
		await current.flush?.()
		await writeLedger({ cardId: ledger.cardId, rows: kept, lastRunAt: new Date(now()).toISOString() })
		logger?.info?.(
			`dsh-evolver: health ${date} cards=${metrics.cards} improvised=${metrics.fleeting} outbound=${metrics.outbound}` +
				(cacheStats === null || cacheStats === undefined ? '' : ` cache=${Math.round(cacheStats.hit)}% misses=${cacheStats.misses}`),
		)
		return { date, cardId: ledger.cardId, ...metrics }
	}

	/**
	 * Run the job, refusing a second concurrent run.
	 *
	 * @returns {Promise<object>} The result.
	 */
	async function runNow() {
		if (inFlight !== null) throw new Error('健康度日报正在生成，请稍等。')
		inFlight = performRun()
		try {
			return await inFlight
		} finally {
			inFlight = null
		}
	}

	/**
	 * Write the day's row once, after the report hour.
	 *
	 * @returns {Promise<object | null>} The result, or null when nothing was due.
	 */
	async function check() {
		// Moving, exporting or importing the data folder closes and reopens the
		// store; a card written into the old one during that window is lost from
		// the library the user is looking at. The job is retryable, so it skips.
		if (typeof isBusy === 'function' && isBusy() === true) return null
		if (store() === undefined) return null
		const current = now()
		if (new Date(current).getHours() < REPORT_HOUR) return null
		const ledger = await readLedger()
		if (ledger.rows.some((row) => row.date === dayKeyOf(current))) return null
		return runNow()
	}

	/**
	 * Start the timer.
	 *
	 * @returns {() => void} Stops it.
	 */
	function start() {
		if (timer !== undefined) return () => {}
		timer = setInterval(() => {
			check().catch(() => {})
		}, CHECK_INTERVAL_MS)
		timer.unref?.()
		return () => {
			clearInterval(timer)
			timer = undefined
		}
	}

	return { check, runNow, start }
}

export { REPORT_TITLE, MAX_ROWS }
