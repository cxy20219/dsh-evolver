/**
 * The daily health row.
 *
 * This is instrumentation, not knowledge: it used to be written into a card of
 * its own, which meant a dashboard lived in the library, took one of the two
 * "recently written" slots in the injected index every morning, and had to be
 * excluded from its own numbers. It is a log line now — one per day, next to
 * the plugin's other records — and the panel reads the series from the ledger.
 *
 * The numbers themselves are computed in `cards/health.js`; this file owns the
 * ledger, the once-a-day decision and the line it writes.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeJsonAtomic } from './atomic.js'

import { MAX_ROWS, healthMetrics, renderReport } from './cards/health.js'

/** How often to look at the clock. */
const CHECK_INTERVAL_MS = 10 * 60_000

/** The hour the day's row is written, local time. */
const REPORT_HOUR = 9

import { dayKeyOf } from './time.js'
// Kept as a re-export for the callers that import the health job's day key.
export { dayKeyOf }

/**
 * Create the daily health card job.
 *
 * @param {{store: Function, logger?: object, now?: Function, cache?: Function, isBusy?: () => boolean, maintainIndex?: Function}} deps - The services the job uses.
 * @returns {{check: Function, runNow: Function, start: Function}} The job.
 */
export function createHealthJob({ store, logger, now = () => Date.now(), cache, isBusy, maintainIndex }) {
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
	 * @returns {Promise<{rows: object[], lastRunAt: string}>} The ledger.
	 */
	async function readLedger() {
		try {
			const parsed = JSON.parse(await readFile(ledgerPath(), 'utf8'))
			return {
				rows: Array.isArray(parsed?.rows) ? parsed.rows.filter((row) => typeof row?.date === 'string') : [],
				lastRunAt: typeof parsed?.lastRunAt === 'string' ? parsed.lastRunAt : '',
			}
		} catch {
			return { rows: [], lastRunAt: '' }
		}
	}

	/**
	 * Write the series without leaving a half-written file.
	 *
	 * @param {object} ledger - The ledger.
	 * @returns {Promise<void>} Resolves once it is on disk.
	 */
	async function writeLedger(ledger) {
		await writeJsonAtomic(ledgerPath(), ledger)
	}

	/**
	 * Compute today's row and append it to the series.
	 *
	 * @returns {Promise<object>} What was recorded.
	 */
	async function performRun() {
		const current = store()
		if (current === undefined) throw new Error('卡片库还没有打开。')
		const ledger = await readLedger()
		const metrics = healthMetrics(current.all(), current.backlinks())
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
		// Keep the newest MAX_ROWS; the oldest fall off rather than the series
		// growing without bound.
		const kept = rows.slice(-MAX_ROWS)
		await writeLedger({ rows: kept, lastRunAt: new Date(now()).toISOString() })
		// The log line carries the whole row: it is the record, and grepping for
		// "health" is how the trend is read without opening the panel.
		logger?.info?.(
			`dsh-evolver: health ${date} cards=${metrics.cards} improvised=${metrics.fleeting}`
				+ ` unfiled=${metrics.unfiled} outbound=${metrics.outbound} inbound=${metrics.inbound} islands=${metrics.islands}`
				+ (cacheStats === null || cacheStats === undefined
					? ''
					: ` cache=${Math.round(cacheStats.hit)}% misses=${cacheStats.misses}`),
		)
		return { date, ...metrics }
	}

	/**
	 * Run the job, refusing a second concurrent run.
	 *
	 * @returns {Promise<object>} The result.
	 */
	async function runNow() {
		if (typeof isBusy === 'function' && isBusy() === true) {
			throw new Error('数据目录操作正在进行，健康度日报已跳过。')
		}
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
		// The injected index is a daily snapshot, and the organiser that
		// rewrites it can be switched off. Keeping it fresh here means the
		// prompt does not fall back to a live ranking (which a single card
		// write invalidates) from midnight until the next open. It is a
		// no-op when today's snapshot already exists.
		if (typeof maintainIndex === 'function') {
			try {
				await maintainIndex()
			} catch (error) {
				logger?.warn?.(`dsh-evolver: index heartbeat skipped: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		const current = now()
		if (new Date(current).getHours() < REPORT_HOUR) return null
		const ledger = await readLedger()
		if (ledger.rows.some((row) => row.date === dayKeyOf(current))) return null
		return runNow()
	}

	/**
	 * The series as the panel shows it.
	 *
	 * @returns {Promise<{rows: object[], lastRunAt: string, text: string}>} The ledger plus the rendered table.
	 */
	async function status() {
		const ledger = await readLedger()
		return { rows: ledger.rows, lastRunAt: ledger.lastRunAt, text: renderReport(ledger.rows) }
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

	return { check, runNow, start, status }
}
