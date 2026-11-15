/**
 * The automatic scheduler: when an organize job runs without anyone asking.
 *
 * The host ticks this every minute. Two triggers share the single-job gate with
 * the panel: "these sessions have been idle long enough" and "the library has
 * not been organized today". The durable memory of what already ran is the
 * ledger in `system/organize-ledger.json`; a failed run has its attempt rolled
 * back by the executor, so a model outage never burns the pending queue.
 *
 * Both switches are off by default: the organizer must not spend model calls by
 * itself on a fresh install.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic } from '../atomic.js'
import { dayKey } from '../day.js'
import { listSessions } from '../sessions.js'
import {
	AUTO_TICK_MS,
	LEDGER_FILE,
	MAX_SESSION_SCAN_PAGES,
	MAX_SESSIONS,
	SESSION_SCAN_PAGE,
	errorMessage,
} from './budget.js'
import { normalizeLedger } from './jobs-store.js'

/**
 * Create the scheduler over one organizer's shared runtime.
 *
 * @param {{runtime: object, settings: object, sessionsRoot: string, now: () => number, logs?: object}} deps - The shared runtime bag, the settings store, the host sessions folder, the clock and the plugin log.
 * @returns {object} The scheduler methods.
 */
export function createScheduler({ runtime, settings, sessionsRoot, now, logs }) {
	const ledgerPath = join(runtime.root, 'system', LEDGER_FILE)
	/** The automatic scheduler's durable memory, loaded on first use. */
	let ledger = null
	let ledgerPromise = null
	/** One automatic pass at a time; a pass that starts a job waits for it. */
	let ticking = false
	/** The host timer that runs `tick()`; stopped by `stopScheduler()`. */
	let schedulerTimer = null

	/**
	 * Load the automatic scheduler's ledger once.
	 *
	 * @returns {Promise<{sessions: Record<string, number>, sessionsScan: {offset: number}, files: {lastDay: string}}>} The ledger.
	 */
	async function loadLedger() {
		if (ledger !== null) return ledger
		if (ledgerPromise !== null) return ledgerPromise
		ledgerPromise = (async () => {
			const text = await readFile(ledgerPath, 'utf8').catch(() => undefined)
			let parsed
			try {
				parsed = text === undefined ? undefined : JSON.parse(text)
			} catch {
				parsed = undefined
			}
			ledger = normalizeLedger(parsed)
			return ledger
		})()
		return ledgerPromise
	}

	/**
	 * Persist the ledger, best effort.
	 *
	 * The ledger is bookkeeping, not a fact about the library: a failed write
	 * costs at most one redundant automatic run.
	 *
	 * @returns {Promise<void>} Resolves when written or logged.
	 */
	async function persistLedger() {
		if (ledger === null) return
		try {
			await writeFileAtomic(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`)
		} catch (error) {
			logs?.warn?.(`自衍中枢：整理台账写入失败：${errorMessage(error)}`)
		}
	}

	/**
	 * Mark a batch of sessions as attempted, remembering what to restore.
	 *
	 * The ledger records the attempt, not the success: it is written before the
	 * model runs so a concurrent pass cannot pick the same conversation twice,
	 * and rolled back by the job boundary when the run fails. The timestamp is
	 * the `updatedAt` seen at selection time, not the current one, so a write
	 * that lands while the job runs is still pending next time.
	 *
	 * @param {Array<{id: string, updatedAt: number}>} batch - The selected sessions.
	 * @returns {Promise<Record<string, number | undefined>>} The previous values, keyed by session id.
	 */
	async function recordSessions(batch) {
		const current = await loadLedger()
		const previous = {}
		let changed = false
		for (const session of batch) {
			if (typeof session?.id !== 'string' || !Number.isFinite(session.updatedAt)) continue
			previous[session.id] = current.sessions[session.id]
			if (current.sessions[session.id] === session.updatedAt) continue
			current.sessions[session.id] = session.updatedAt
			changed = true
		}
		if (changed) await persistLedger()
		return previous
	}

	/**
	 * Restore the ledger entries one job consumed.
	 *
	 * A failed or cancelled run did not organize anything, so its sessions must
	 * stay pending: recording the attempt without a rollback is what silently
	 * drained the queue after one broken model route. Restoring the previous
	 * value (instead of deleting) also undoes the timestamp bump of a retry.
	 *
	 * @param {object} entry - The finished entry.
	 * @returns {Promise<void>} Resolves when restored.
	 */
	async function rollbackLedger(entry) {
		const previous = entry.ledgerPrevious
		if (previous === null || previous === undefined) return
		entry.ledgerPrevious = null
		const current = await loadLedger()
		let changed = false
		for (const [id, value] of Object.entries(previous)) {
			if (value === undefined) {
				if (Object.prototype.hasOwnProperty.call(current.sessions, id)) {
					delete current.sessions[id]
					changed = true
				}
			} else if (current.sessions[id] !== value) {
				current.sessions[id] = value
				changed = true
			}
		}
		if (changed) await persistLedger()
	}

	/**
	 * Remember which local day the library was last organized on.
	 *
	 * Recorded when the automatic run starts, so a failing run is retried at
	 * most once per day instead of every minute.
	 *
	 * @param {string} day - The local day key.
	 * @returns {Promise<void>} Resolves when recorded.
	 */
	async function recordFilesDay(day) {
		const current = await loadLedger()
		if (current.files.lastDay === day) return
		current.files.lastDay = day
		await persistLedger()
	}

	/**
	 * Sessions the organizer would ingest now, oldest first.
	 *
	 * A session is pending when it is a real human conversation (not a
	 * subagent, a seeded session or a delegation child), has at least one
	 * prompt, has been idle for the configured minutes, and has been updated
	 * since the ledger's record. The idle test is what keeps the organizer from
	 * summarizing a conversation that is still being written; the ledger is
	 * what keeps it from summarizing the same content twice.
	 *
	 * The listing is paged: the newest page is always read (a fresh
	 * conversation is the common case), and when that page is fully recorded
	 * the scan resumes from the ledger's saved cursor instead of declaring the
	 * backlog empty. That is what keeps sessions older than the newest 50 from
	 * starving for ever while still bounding one pass to a fixed number of
	 * pages.
	 *
	 * @returns {Promise<Array<{id: string, updatedAt: number}>>} The pending sessions, oldest first.
	 */
	async function pendingSessions() {
		if (typeof sessionsRoot !== 'string' || sessionsRoot === '') return []
		const auto = settings.get()?.organize?.auto?.sessions ?? {}
		const idleMinutes = Math.max(5, Math.min(240, Math.round(Number(auto.idleMinutes) || 30)))
		const idleMs = idleMinutes * 60_000
		const at = now()
		const current = await loadLedger()
		const saved = current.sessionsScan?.offset ?? 0
		let offset = 0
		let cursor = saved
		let total = 0
		for (let page = 0; page < MAX_SESSION_SCAN_PAGES; page += 1) {
			const listing = await listSessions({ root: sessionsRoot, limit: SESSION_SCAN_PAGE, offset })
				.catch(() => ({ sessions: [], total: 0 }))
			const pending = []
			for (const session of listing.sessions) {
				if (session.origin === 'subagent' || session.isSeeded === true || session.delegationDepth > 0) continue
				if (!(session.prompts > 0)) continue
				const updatedAt = Date.parse(session.updatedAt)
				if (!Number.isFinite(updatedAt)) continue
				const recorded = current.sessions[session.id]
				if (Number.isFinite(recorded) && updatedAt <= recorded) continue
				if (at - updatedAt < idleMs) continue
				pending.push({ id: session.id, updatedAt })
			}
			total = Number.isFinite(Number(listing.total)) ? Number(listing.total) : 0
			if (pending.length > 0) {
				pending.sort((left, right) => left.updatedAt - right.updatedAt)
				// Resume from this page next time instead of walking the recorded
				// prefix again; the newest page is still read first every pass.
				if (cursor !== offset) {
					current.sessionsScan = { offset }
					cursor = offset
					await persistLedger()
				}
				return pending
			}
			if (offset === 0 && saved > 0) {
				offset = saved
				continue
			}
			offset += SESSION_SCAN_PAGE
			if (offset >= total) break
		}
		// The pass ended without finding anything pending. A pass that walked the
		// whole listing starts over from the top next time; one that only used
		// its page budget keeps the progress, so a history larger than the budget
		// still gets scanned to the end across passes instead of starving.
		const exhausted = offset >= total
		const nextOffset = exhausted ? 0 : offset
		if (cursor !== nextOffset) {
			current.sessionsScan = { offset: nextOffset }
			await persistLedger()
		}
		return []
	}

	/**
	 * The compact record of the latest job of one kind, for the two cards.
	 *
	 * @param {'sessions' | 'files'} kind - The job kind.
	 * @returns {null | {id: string, status: string, startedAt: string, finishedAt: string, message: string, error: null | string, result: object}} The summary.
	 */
	function lastRunOf(kind) {
		const job = runtime.state.jobs.find((item) => item.kind === kind)
		if (job === undefined) return null
		return {
			id: job.id,
			status: job.status,
			startedAt: job.startedAt,
			finishedAt: job.finishedAt,
			message: job.message,
			error: job.error,
			result: { ...job.result },
		}
	}

	/**
	 * The automatic organizer's two switches, detached.
	 *
	 * @returns {{sessions: {enabled: boolean, idleMinutes: number}, files: {enabled: boolean, hour: number}}} The switches.
	 */
	function autoSettings() {
		const auto = settings.get()?.organize?.auto ?? {}
		return {
			sessions: {
				enabled: auto.sessions?.enabled === true,
				idleMinutes: Math.max(5, Math.min(240, Math.round(Number(auto.sessions?.idleMinutes) || 30))),
			},
			files: {
				enabled: auto.files?.enabled === true,
				hour: Math.max(0, Math.min(23, Math.round(Number(auto.files?.hour) || 0))),
			},
		}
	}

	/**
	 * One automatic-scheduling pass.
	 *
	 * The host calls this every minute; tests call it directly with a fake
	 * clock. At most one job starts per pass, and a job that does start is
	 * awaited before the pass returns: the session and file triggers share the
	 * single-job gate with the panel, so the next trigger waits for the
	 * current run to settle.
	 *
	 * Both switches are off by default. The ledger records the batch before the
	 * job runs so a concurrent pass cannot double-book it, and the job boundary
	 * rolls that record back when the run fails, so a model outage cannot burn
	 * the pending queue.
	 *
	 * @returns {Promise<{started: string | null, reason: string}>} What this pass did.
	 */
	async function tick() {
		if (ticking) return { started: null, reason: 'busy' }
		ticking = true
		try {
			await runtime.load()
			if (runtime.activeJob() !== null) {
				return { started: null, reason: 'running' }
			}
			const auto = autoSettings()
			if (auto.sessions.enabled) {
				const pending = await pendingSessions()
				if (pending.length > 0) {
					const batch = pending.slice(0, MAX_SESSIONS)
					logs?.info?.(`自衍中枢：自动整理 ${batch.length} 个空闲会话（${batch.map((item) => item.id).join(', ')}）`)
					const started = await runtime.startJob(
						{ kind: 'sessions', sessionIds: batch.map((item) => item.id) },
						{ auto: true, batch },
					)
					await started.entry.promise
					return { started: started.job.id, reason: 'sessions' }
				}
			}
			if (auto.files.enabled) {
				const at = now()
				const today = dayKey(new Date(at))
				if (new Date(at).getHours() >= auto.files.hour) {
					const current = await loadLedger()
					if (current.files.lastDay !== today) {
						logs?.info?.(`自衍中枢：自动整理文件（每天 ${auto.files.hour} 点后首次）`)
						await recordFilesDay(today)
						const started = await runtime.startJob({ kind: 'files' }, { auto: true })
						await started.entry.promise
						return { started: started.job.id, reason: 'files' }
					}
				}
			}
			return { started: null, reason: 'idle' }
		} catch (error) {
			// A pass that cannot start a job (no model, no llm, no data folder) is
			// a log line, not a crash: the panel is where the setting is fixed.
			logs?.warn?.(`自衍中枢：自动整理跳过：${errorMessage(error)}`)
			return { started: null, reason: 'error' }
		} finally {
			ticking = false
		}
	}

	/**
	 * Start the host timer that runs `tick()`.
	 *
	 * The automatic pass runs on the host's clock. It is unref'd so it never
	 * keeps the process alive by itself, and `stopScheduler()` clears it on
	 * plugin disposal; tests drive `tick()` directly rather than waiting a
	 * minute.
	 *
	 * @returns {void}
	 */
	function startScheduler() {
		schedulerTimer = setInterval(() => { void tick() }, AUTO_TICK_MS)
		schedulerTimer.unref?.()
	}

	/**
	 * Stop the host timer.
	 *
	 * @returns {void}
	 */
	function stopScheduler() {
		if (schedulerTimer !== null) {
			clearInterval(schedulerTimer)
			schedulerTimer = null
		}
	}

	return {
		loadLedger,
		persistLedger,
		recordSessions,
		rollbackLedger,
		recordFilesDay,
		pendingSessions,
		lastRunOf,
		autoSettings,
		tick,
		startScheduler,
		stopScheduler,
	}
}
