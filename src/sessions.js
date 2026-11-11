/**
 * Turning past sessions into bounded excerpts for the ingest job.
 *
 * A session log is large and mostly mechanical (tool calls, tool results,
 * system prompts, reasoning). The digest keeps only what a memory can be
 * extracted from: the user's messages and the assistant's final text, after
 * the last processed sequence. Nothing is copied into the data folder; the
 * excerpt is read by the scheduled agent and whatever it chooses to keep is
 * saved through the normal memory tools.
 *
 * The ledger lives at `sight/sessions.json` and stores one `lastSeq` per
 * session, so a session that keeps growing is read incrementally instead of
 * being re-digested from the start.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { redactSecrets } from './secrets.js'

/** Marks the scheduled ingest session so it is never digested itself. */
export const SESSION_MARKER = '[evolver-ingest]'

/** Rough bounds that keep one digest around six thousand tokens. */
const MAX_MESSAGE_CHARS = 800
const MAX_TOTAL_CHARS = 24_000
const MAX_SCAN = 40
const MAX_LEDGER_ENTRIES = 1_000

/**
 * The persisted per-session cursor.
 */
export class SessionLedger {
	/**
	 * @param {{dataDir?: string, path?: string}} options - Where the ledger lives.
	 */
	constructor({ dataDir, path }) {
		this.path = path ?? join(dataDir, 'sight', 'sessions.json')
		this.data = undefined
	}

	/**
	 * Read the ledger once, tolerating a missing or corrupt file.
	 *
	 * @returns {Promise<object>} The ledger state.
	 */
	async load() {
		if (this.data !== undefined) return this.data
		const raw = await readFile(this.path, 'utf8').catch(() => null)
		let parsed
		try {
			parsed = raw === null ? undefined : JSON.parse(raw)
		} catch {
			parsed = undefined
		}
		const sessions = {}
		const source = parsed?.sessions !== null && typeof parsed?.sessions === 'object' ? parsed.sessions : {}
		for (const [id, value] of Object.entries(source)) {
			if (typeof id !== 'string' || value === null || typeof value !== 'object') continue
			const lastSeq = Number(value.lastSeq)
			if (!Number.isFinite(lastSeq) || lastSeq < 0) continue
			sessions[id] = {
				lastSeq,
				processedAt: typeof value.processedAt === 'string' ? value.processedAt : '',
			}
		}
		this.data = {
			version: 1,
			sessions,
			lastCommitAt: typeof parsed?.lastCommitAt === 'string' ? parsed.lastCommitAt : '',
		}
		return this.data
	}

	/**
	 * The sequence already processed for one session.
	 *
	 * @param {string} id - Session id.
	 * @returns {Promise<number>} The last processed seq, or -1.
	 */
	async through(id) {
		const data = await this.load()
		return data.sessions[id]?.lastSeq ?? -1
	}

	/**
	 * Record that a batch of sessions was processed.
	 *
	 * @param {Array<{id: string, seq: number}>} entries - What was processed.
	 * @param {string} at - ISO timestamp.
	 * @returns {Promise<void>} Resolves after the atomic write.
	 */
	async commit(entries, at) {
		if (entries.length === 0) return
		const data = await this.load()
		for (const entry of entries) {
			data.sessions[entry.id] = { lastSeq: entry.seq, processedAt: at }
		}
		data.lastCommitAt = at
		const ids = Object.keys(data.sessions)
		if (ids.length > MAX_LEDGER_ENTRIES) {
			ids.sort((left, right) => String(data.sessions[left].processedAt).localeCompare(String(data.sessions[right].processedAt)))
			for (const id of ids.slice(0, ids.length - MAX_LEDGER_ENTRIES)) delete data.sessions[id]
		}
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
		const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`
		try {
			await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
			await rename(temp, this.path)
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {})
			throw error
		}
	}

	/**
	 * A compact view for the panel.
	 *
	 * @returns {Promise<{processed: number, lastCommitAt: string}>} The counters.
	 */
	async snapshot() {
		const data = await this.load()
		return { processed: Object.keys(data.sessions).length, lastCommitAt: data.lastCommitAt }
	}
}

/**
 * Extract the text blocks of one message content value.
 *
 * @param {unknown} content - A string or content-block array.
 * @returns {string} The visible text.
 */
function contentText(content) {
	if (typeof content === 'string') return content.trim()
	if (!Array.isArray(content)) return ''
	return content
		.filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text.trim())
		.filter((text) => text !== '')
		.join('\n')
}

/**
 * The visible text of one user or assistant event.
 *
 * @param {object} event - A session event.
 * @returns {string} The text, or an empty string.
 */
function eventText(event) {
	if (event?.type === 'user/message') return contentText(event.data?.content)
	if (event?.type === 'assistant/message') return contentText(event.data?.message?.content ?? event.data?.content)
	return ''
}

/**
 * Whether one event is worth reading into a digest.
 *
 * @param {object} event - A session event.
 * @returns {boolean} True for user and assistant messages.
 */
function isMessageEvent(event) {
	return event?.type === 'user/message' || event?.type === 'assistant/message'
}

/**
 * Whether a session belongs in the digest at all.
 *
 * @param {object} record - A SessionRecord.
 * @returns {boolean} True for a top-level, user-visible session.
 */
function eligible(record) {
	const header = record?.header
	if (header === null || typeof header !== 'object' || typeof header.id !== 'string') return false
	if (header.isSeeded === true) return false
	if (header.origin === 'subagent') return false
	if (header.parentSession !== undefined) return false
	if (Number(header.delegationDepth ?? 0) > 0) return false
	return true
}

/**
 * Read the unprocessed part of recent sessions into bounded excerpts.
 *
 * @param {object} options - Query and bounds.
 * @param {object} options.query - The Host `sessionQuery` service.
 * @param {SessionLedger} options.ledger - The per-session cursor.
 * @param {number} [options.sinceDays] - Only sessions active in the last N days; 0 means all.
 * @param {number} [options.limit] - Maximum sessions to return.
 * @param {boolean} [options.commit] - Mark the returned sessions processed.
 * @param {number} [options.now] - Clock.
 * @returns {Promise<object>} The digest.
 */
export async function digestSessions({ query, ledger, sinceDays = 0, limit = 5, commit = false, now = Date.now() }) {
	if (query === undefined || typeof query.listSessions !== 'function') {
		throw new Error('这个宿主没有提供会话读取能力（sessionQuery）。')
	}
	const days = Math.max(0, Math.min(30, Math.round(Number(sinceDays) || 0)))
	const count = Math.max(1, Math.min(10, Math.round(Number(limit) || 5)))
	const data = await ledger.load()
	const records = await query.listSessions()
	const since = days > 0 ? now - days * 86_400_000 : 0
	const candidates = []
	for (const record of records) {
		if (!eligible(record)) continue
		const events = await query.listEvents(record.header.id).catch(() => [])
		if (!Array.isArray(events) || events.length === 0) continue
		const last = events[events.length - 1]
		if (since > 0 && Number(last.time) < since) continue
		const processed = data.sessions[record.header.id]?.lastSeq ?? -1
		if (Number(last.seq) <= processed) continue
		candidates.push({ record, events, last, processed })
		if (candidates.length >= MAX_SCAN) break
	}

	const sessions = []
	const commits = []
	const empty = []
	let totalChars = 0
	let pending = 0
	for (const candidate of candidates) {
		if (sessions.length >= count || totalChars >= MAX_TOTAL_CHARS) {
			pending += 1
			continue
		}
		const id = candidate.record.header.id
		const snapshot = await query.readSession(id).catch(() => undefined)
		if (snapshot === undefined || !Array.isArray(snapshot.events)) continue
		const messages = []
		let text = ''
		let marked = false
		let hasUser = false
		let through = candidate.processed
		for (const event of snapshot.events) {
			if (Number(event.seq) <= candidate.processed || !isMessageEvent(event)) continue
			// Runtime context, skill catalogues, reminders and goal rounds are
			// all appended as user messages. Only what the person typed has
			// `source.kind === 'user'`; the rest must never become a memory.
			if (event.type === 'user/message') {
				const source = event.data?.source
				if (source !== undefined && source.kind !== 'user') continue
			}
			const value = eventText(event)
			if (value === '') continue
			if (event.type === 'user/message' && value.includes(SESSION_MARKER)) {
				marked = true
				break
			}
			const clean = redactSecrets(value)
			const clipped = clean.length > MAX_MESSAGE_CHARS ? `${clean.slice(0, MAX_MESSAGE_CHARS)}…` : clean
			if (event.type === 'user/message') hasUser = true
			messages.push({ role: event.type === 'user/message' ? 'user' : 'assistant', text: clipped })
			text += clipped
			through = Number(event.seq)
			if (totalChars + text.length >= MAX_TOTAL_CHARS) break
		}
		const lastSeq = Math.max(...snapshot.events.map((event) => Number(event.seq)).filter((seq) => Number.isFinite(seq)))
		if (marked || !hasUser || messages.length === 0) {
			// Nothing a memory can come from (or the ingest's own conversation):
			// mark it done so it does not stay in the pending count forever.
			empty.push({ id, seq: lastSeq })
			continue
		}
		const title = await query.readTitle(id).catch(() => undefined)
		sessions.push({
			id,
			title: typeof title?.title === 'string' ? title.title : '',
			cwd: typeof candidate.record.header.cwd === 'string' ? candidate.record.header.cwd : '',
			createdAt: Number(candidate.record.header.createdAt) || 0,
			lastEventAt: Number(candidate.last.time) || 0,
			through,
			messages,
		})
		totalChars += text.length
		if (commit) commits.push({ id, seq: through })
	}
	if (commit) {
		const all = [...commits, ...empty]
		if (all.length > 0) await ledger.commit(all, new Date(now).toISOString())
	}
	return {
		success: true,
		sessions,
		empty,
		pending,
		scanned: candidates.length,
		truncated: totalChars >= MAX_TOTAL_CHARS,
		...(commit ? { committed: [...commits, ...empty].map((entry) => entry.id) } : {}),
	}
}

/**
 * Count sessions with new events, without reading their text.
 *
 * Used by the idle watcher before it spends a model call.
 *
 * @param {object} options - Query and bounds.
 * @param {object} options.query - The Host `sessionQuery` service.
 * @param {SessionLedger} options.ledger - The per-session cursor.
 * @param {number} [options.sinceDays] - Only sessions active in the last N days.
 * @param {number} [options.now] - Clock.
 * @returns {Promise<{pending: number, scanned: number}>} The count.
 */
export async function probeSessions({ query, ledger, sinceDays = 7, now = Date.now() }) {
	if (query === undefined || typeof query.listSessions !== 'function') return { pending: 0, scanned: 0 }
	const days = Math.max(0, Math.min(30, Math.round(Number(sinceDays) || 0)))
	const data = await ledger.load()
	const records = await query.listSessions()
	const since = days > 0 ? now - days * 86_400_000 : 0
	let pending = 0
	let scanned = 0
	for (const record of records) {
		if (!eligible(record)) continue
		scanned += 1
		const events = await query.listEvents(record.header.id).catch(() => [])
		if (!Array.isArray(events) || events.length === 0) continue
		const last = events[events.length - 1]
		if (since > 0 && Number(last.time) < since) continue
		const processed = data.sessions[record.header.id]?.lastSeq ?? -1
		// A session with no new user message has nothing a memory could be
		// extracted from; tool noise alone must not wake the model.
		const hasUser = events.some((event) => event.type === 'user/message' && Number(event.seq) > processed)
		if (hasUser) pending += 1
		if (scanned >= MAX_SCAN) break
	}
	return { pending, scanned }
}
