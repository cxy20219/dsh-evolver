/**
 * The organizer's limits, timings and the tiny primitives they are measured
 * with.
 *
 * Every number a job is bounded by lives here, so the tool loop, the prompt
 * builder and the scheduler agree on one budget table. The helpers below are
 * pure and depend on nothing else in the module: they moved here from the old
 * single file unchanged, which is why the module also owns the clock/error
 * primitives rather than growing a dedicated `util` layer.
 */

import { randomUUID } from 'node:crypto'

/** The kinds of organize job the panel may start. */
export const JOB_KINDS = ['sessions', 'files', 'all']

/** Every state one job can be in. */
export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled']

/** How many sessions one job may ingest. */
export const MAX_SESSIONS = 5

/** How many character of one session's transcript may reach the prompt. */
export const MAX_SESSION_CHARS = 24_000

/** The hard step budget per kind: a model turn that does not settle is a bug. */
export const MAX_STEPS = { sessions: 12, files: 12, all: 20 }

/** The hard tool-call budget per job. */
export const MAX_TOOL_CALLS = 30

/** One tool result kept in the conversation may not exceed this. */
export const MAX_TOOL_RESULT_CHARS = 8_000

/** All tool results together may not exceed this before the tools are withdrawn. */
export const MAX_TOOL_RESULT_TOTAL = 60_000

/** How many output tokens one model turn may use. */
export const MAX_OUTPUT_TOKENS = 4_096

/**
 * How many output tokens the closing turn may use.
 *
 * A tool round only has to emit a call or two, but the closing turn carries the
 * whole result the person reads. Reasoning-heavy routes spend most of a small
 * budget on thinking and hand back an empty answer, which is how a dry-run lost
 * its plan while reporting "done".
 */
export const MAX_FINAL_TOKENS = 8_192

/** How many files one job may create/update/archive before the model is told to stop. */
export const MAX_WRITES = 24

/** Persisted job records and their tails. */
export const MAX_PERSISTED_JOBS = 20
export const MAX_LOG_LINES = 40
export const MAX_CHANGES = 50

/** The job store, inside `system/`. */
export const JOBS_FILE = 'organize-jobs.json'

/** The automatic scheduler's durable memory, inside `system/`. */
export const LEDGER_FILE = 'organize-ledger.json'

/**
 * How often the automatic scheduler checks its triggers.
 *
 * Off by default: the switches live in the settings file, and both are false
 * until the person turns one on in the panel.
 */
export const AUTO_TICK_MS = 60_000

/** The max the list endpoint may return. */
export const MAX_LISTED_JOBS = 20

/** How much of the model's closing summary is kept. */
export const MAX_MESSAGE_CHARS = 2_400

/** How many characters of a tag table the prompt may carry. */
export const TAG_TABLE_BUDGET = 2_000

/**
 * How long one model turn may stay silent before it is treated as hung.
 *
 * An adapter that never settles its stream, or that ignores the abort signal,
 * would otherwise hold the single-job gate for ever; the turn budget is what
 * makes a single stuck request cost one turn instead of the whole plugin.
 */
export const TURN_TIMEOUT_MS = 120_000

/** The whole job's wall-clock budget, the last line of defence for the gate. */
export const JOB_TIMEOUT_MS = 15 * 60_000

/**
 * How long a cancelled job may take to settle before it is forcibly ended.
 *
 * Cancellation is cooperative: the model stream, a tool execution or a disk
 * write can be the step that does not observe the signal. The grace window is
 * what guarantees the record and the single-job gate are released anyway.
 */
export const CANCEL_GRACE_MS = 10_000

/** How many sessions one listing page holds while the pending scan pages. */
export const SESSION_SCAN_PAGE = 50

/** How many pages one pending scan may walk before deferring the rest. */
export const MAX_SESSION_SCAN_PAGES = 20

/**
 * The current time as an ISO string.
 *
 * @param {number} ms - Milliseconds since the epoch.
 * @returns {string} The ISO timestamp.
 */
export function iso(ms) {
	const date = new Date(ms)
	return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

/**
 * A short wall-clock stamp for one log line.
 *
 * @param {number} ms - Milliseconds since the epoch.
 * @returns {string} `HH:MM:SS`.
 */
export function clock(ms) {
	return iso(ms).slice(11, 19)
}

/**
 * The message of an error.
 *
 * @param {unknown} error - Anything thrown.
 * @returns {string} The text.
 */
export function errorMessage(error) {
	if (error instanceof Error) return error.message
	return String(error ?? '')
}

/**
 * An abort-shaped error, so the job boundary can tell cancellation from failure.
 *
 * @returns {Error} The error.
 */
export function abortError() {
	const error = new Error('整理作业已取消。')
	error.name = 'AbortError'
	return error
}

/**
 * A timeout-shaped error, so a hung step is reported as a failure with a
 * readable reason instead of being mistaken for a cancellation.
 *
 * @param {string} message - The person-facing reason.
 * @returns {Error} The error.
 */
export function timeoutError(message) {
	const error = new Error(message)
	error.name = 'TimeoutError'
	return error
}

/**
 * The error to throw when one model turn's combined signal aborted.
 *
 * The only two sources are the job's own cancellation (the parent signal) and
 * the per-turn deadline this module adds; keeping them apart is what lets the
 * job record say "cancelled" only when a person cancelled it.
 *
 * @param {AbortSignal} parentSignal - The job's cancellation signal.
 * @param {number} turnTimeoutMs - The per-turn deadline.
 * @returns {Error} The error.
 */
export function turnAbortError(parentSignal, turnTimeoutMs) {
	if (parentSignal.aborted) return abortError()
	const seconds = Math.max(1, Math.round(turnTimeoutMs / 1_000))
	return timeoutError(`模型轮次超过 ${seconds} 秒未返回，已终止。`)
}

/**
 * Close an abandoned iterator without awaiting it.
 *
 * A hung adapter may never settle its pending `next()`, so requesting a return
 * is best effort: awaiting it would move the hang instead of ending the turn.
 *
 * @param {object} iterator - The stream iterator.
 * @returns {void}
 */
export function closeIteratorQuietly(iterator) {
	try {
		const closed = iterator?.return?.()
		if (closed !== null && closed !== undefined && typeof closed.catch === 'function') closed.catch(() => {})
	} catch {
		// Closing a broken iterator is not worth failing the job over.
	}
}

/**
 * A duration from caller options, falling back to the module default.
 *
 * @param {unknown} value - The raw option.
 * @param {number} fallback - The default.
 * @returns {number} A positive integer number of milliseconds.
 */
export function duration(value, fallback) {
	const number = Number(value)
	return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback
}

/**
 * Clip one string to a character budget.
 *
 * @param {unknown} value - The value.
 * @param {number} max - The cap.
 * @returns {string} The clipped text.
 */
export function clip(value, max) {
	const text = typeof value === 'string' ? value : String(value ?? '')
	return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Clip a tool result to a character budget without breaking its JSON.
 *
 * A raw slice leaves `{"total":28,"files":[{"schema":1,"id":"file-01M7…`
 * behind. The model cannot parse half an object, so it re-runs the query with
 * other words and spends the job's tool budget without ever reaching a write:
 * the 2026-11-16 logs show jobs with 25 tool calls and zero writes, six of them
 * ending on "工具结果预算用尽". Cutting on structure keeps the payload
 * parseable, and `truncated`/`omitted` say what was dropped instead of
 * pretending the list was whole.
 *
 * Scalar fields are always kept; whole list entries are dropped from the
 * longest array first, because that is where a search result spends its
 * characters. A value with no structure to cut (a bare string) falls back to a
 * preview inside a valid envelope.
 *
 * @param {unknown} value - The tool result.
 * @param {number} max - The cap, in characters.
 * @returns {string} JSON the model can parse, preferably within `max`.
 */
export function clipJson(value, max) {
	const full = JSON.stringify(value ?? {})
	if (full.length <= max) return full
	const envelope = () => JSON.stringify({ truncated: true, preview: full.slice(0, Math.max(0, max - 60)) })
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return envelope()
	let copy
	try {
		copy = JSON.parse(full)
	} catch {
		return envelope()
	}
	// Room for the two flags this function adds at the end.
	const target = max - 40
	const lists = Object.entries(copy)
		.filter(([, item]) => Array.isArray(item))
		.sort((left, right) => right[1].length - left[1].length)
	let omitted = 0
	for (const [, list] of lists) {
		while (list.length > 0 && JSON.stringify(copy).length > target) {
			list.pop()
			omitted += 1
		}
		if (JSON.stringify(copy).length <= target) break
	}
	if (omitted === 0) {
		// Nothing left to cut: the scalars themselves overflow.
		return envelope()
	}
	const encoded = JSON.stringify({ ...copy, truncated: true, omitted })
	return encoded.length <= max ? encoded : envelope()
}

/**
 * A new job id: sortable by creation time and unique.
 *
 * @returns {string} The id.
 */
export function newJobId() {
	return `organize-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
}

/**
 * A fresh message id for the hand-built tool-loop history.
 *
 * The host's message values carry a stable id; the runtime does not mint one
 * for a hand-built request, so the organizer does.
 *
 * @returns {string} The id.
 */
export function newMessageId() {
	return randomUUID()
}
