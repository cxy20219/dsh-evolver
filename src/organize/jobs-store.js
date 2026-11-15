/**
 * The organizer's two durable files: the job list and the automatic
 * scheduler's ledger.
 *
 * Jobs live in `system/organize-jobs.json` so a job is displayable while it
 * runs and after a restart. Only the job list is owned here — starting and
 * settling a job is the executor's business; this module normalises what was
 * read back, writes what is in memory, and appends the log tails.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic } from '../atomic.js'
import {
	JOB_KINDS,
	JOB_STATUSES,
	JOBS_FILE,
	MAX_CHANGES,
	MAX_LOG_LINES,
	MAX_PERSISTED_JOBS,
	MAX_SESSIONS,
	clock,
	errorMessage,
	iso,
	newJobId,
} from './budget.js'

/**
 * Normalise the automatic scheduler's ledger.
 *
 * The ledger is the only durable memory of automatic runs: for each session,
 * the `updatedAt` it was last made durable at, and for the library, the local
 * day it was last organized on. A malformed file degrades to an empty ledger —
 * the worst case is one redundant run, never a failed plugin load.
 *
 * `sessionsScan.offset` is a resume point for the paged pending scan: when the
 * newest pages are already recorded there is no reason for every minute to walk
 * them again. It is bookkeeping only; losing it costs one full scan.
 *
 * Timestamps are epoch milliseconds rather than the ISO strings the session
 * listing uses: the comparison is numeric and does not depend on formatting.
 *
 * @param {unknown} raw - The parsed file.
 * @returns {{sessions: Record<string, number>, sessionsScan: {offset: number}, files: {lastDay: string}}} The ledger.
 */
export function normalizeLedger(raw) {
	const sessions = {}
	const stored = raw?.sessions
	if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
		for (const [id, updatedAt] of Object.entries(stored)) {
			if (!/^session-[0-9a-zA-Z-]+$/.test(id)) continue
			const value = Number(updatedAt)
			if (Number.isFinite(value) && value > 0) sessions[id] = Math.round(value)
		}
	}
	const lastDay = typeof raw?.files?.lastDay === 'string' ? raw.files.lastDay : ''
	const offset = Number(raw?.sessionsScan?.offset)
	return {
		sessions,
		sessionsScan: { offset: Number.isFinite(offset) && offset > 0 ? Math.round(offset) : 0 },
		files: { lastDay: /^\d{4}-\d{2}-\d{2}$/.test(lastDay) ? lastDay : '' },
	}
}

/**
 * Normalise one persisted job record.
 *
 * @param {unknown} raw - The parsed record.
 * @returns {object | null} The valid job, or null when unusable.
 */
function normalizeJob(raw) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
	const status = JOB_STATUSES.includes(raw.status) ? raw.status : 'failed'
	const kind = JOB_KINDS.includes(raw.kind) ? raw.kind : 'files'
	const number = (value) => {
		const parsed = Number(value)
		return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0
	}
	const text = (value) => (typeof value === 'string' ? value : '')
	return {
		id: text(raw.id) === '' ? newJobId() : text(raw.id),
		kind,
		status,
		dryRun: raw.dryRun === true,
		allowRemove: raw.allowRemove === true,
		phase: text(raw.phase),
		progress: {
			processed: number(raw.progress?.processed),
			total: number(raw.progress?.total),
			steps: number(raw.progress?.steps),
			toolCalls: number(raw.progress?.toolCalls),
			writes: number(raw.progress?.writes),
		},
		selection: {
			provider: text(raw.selection?.provider),
			model: text(raw.selection?.model),
			...(text(raw.selection?.reasoningEffort) === '' ? {} : { reasoningEffort: text(raw.selection.reasoningEffort) }),
		},
		sessionIds: Array.isArray(raw.sessionIds)
			? raw.sessionIds.filter((item) => typeof item === 'string' && item !== '').slice(0, MAX_SESSIONS)
			: [],
		startedAt: text(raw.startedAt),
		finishedAt: text(raw.finishedAt),
		message: text(raw.message),
		error: text(raw.error) === '' ? null : text(raw.error),
		result: {
			created: number(raw.result?.created),
			updated: number(raw.result?.updated),
			merged: number(raw.result?.merged),
			archived: number(raw.result?.archived),
			removed: number(raw.result?.removed),
			retagged: number(raw.result?.retagged),
			linked: number(raw.result?.linked),
		},
		changes: Array.isArray(raw.changes)
			? raw.changes
				.filter((change) => change !== null && typeof change === 'object')
				.slice(0, MAX_CHANGES)
				.map((change) => ({ op: text(change.op), id: text(change.id) }))
			: [],
		log: Array.isArray(raw.log)
			? raw.log.filter((line) => typeof line === 'string').slice(-MAX_LOG_LINES)
			: [],
	}
}

/**
 * A detached copy of one job, safe to return over the panel API.
 *
 * @param {object} job - The live job.
 * @returns {object} The snapshot.
 */
export function snapshot(job) {
	return {
		id: job.id,
		kind: job.kind,
		status: job.status,
		dryRun: job.dryRun,
		allowRemove: job.allowRemove,
		phase: job.phase,
		progress: { ...job.progress },
		selection: { ...job.selection },
		sessionIds: [...job.sessionIds],
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		message: job.message,
		error: job.error,
		result: { ...job.result },
		changes: job.changes.map((change) => ({ ...change })),
		log: [...job.log],
	}
}

/**
 * The in-memory job list and its file.
 *
 * The state object is returned rather than copied: the job recorder and the
 * panel listing must observe the same list, and one job runs at a time, so
 * there is no concurrent writer to guard against.
 *
 * @param {{root: string, now: () => number, logs?: object}} deps - The data root, the clock and the plugin log.
 * @returns {{state: {jobs: object[]}, load: () => Promise<void>, persist: () => Promise<void>, appendLog: (job: object, line: string) => void}} The jobs store.
 */
export function createJobsStore({ root, now, logs }) {
	const jobsPath = join(root, 'system', JOBS_FILE)
	const state = { jobs: [] }
	let loaded = false
	let loadPromise = null

	/**
	 * Persist the job list, best effort.
	 *
	 * A failed write must not fail the job: the library writes are the durable
	 * part, the job record is the dashboard.
	 *
	 * @returns {Promise<void>} Resolves when written or logged.
	 */
	async function persist() {
		if (!loaded) return
		try {
			await writeFileAtomic(jobsPath, `${JSON.stringify({ version: 1, jobs: state.jobs }, null, 2)}\n`)
		} catch (error) {
			logs?.warn?.(`自衍中枢：整理作业记录写入失败：${errorMessage(error)}`)
		}
	}

	/**
	 * Append one line to a job's tail.
	 *
	 * Lines stay chronological and the newest is last, which is what the panel
	 * renders without re-sorting.
	 *
	 * @param {object} job - The job.
	 * @param {string} line - The text.
	 * @returns {void}
	 */
	function appendLog(job, line) {
		job.log.push(`[${clock(now())}] ${line}`)
		if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES)
	}

	/**
	 * Load the persisted job list once.
	 *
	 * A job that was running when the process stopped can never resume: no
	 * model call survives a restart. It is marked failed instead of staying
	 * "running" for ever in the panel.
	 *
	 * @returns {Promise<void>} Resolves when loaded.
	 */
	async function load() {
		if (loaded) return
		if (loadPromise !== null) return loadPromise
		loadPromise = (async () => {
			const text = await readFile(jobsPath, 'utf8').catch(() => undefined)
			let parsed
			try {
				parsed = text === undefined ? undefined : JSON.parse(text)
			} catch {
				parsed = undefined
			}
			const jobs = []
			for (const raw of Array.isArray(parsed?.jobs) ? parsed.jobs : []) {
				const job = normalizeJob(raw)
				if (job !== null) jobs.push(job)
			}
			jobs.sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
			let interrupted = false
			for (const job of jobs) {
				if (job.status !== 'queued' && job.status !== 'running') continue
				job.status = 'failed'
				job.phase = '完成'
				job.error = '宿主重启，作业已中断'
				job.message = job.error
				job.finishedAt = iso(now())
				appendLog(job, '宿主重启，作业已中断')
				interrupted = true
			}
			state.jobs = jobs.slice(0, MAX_PERSISTED_JOBS)
			loaded = true
			if (interrupted) await persist()
		})()
		return loadPromise
	}

	return { state, load, persist, appendLog }
}
