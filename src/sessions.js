/**
 * Reading the host's session logs for the organize page.
 *
 * A session log is a JSONL file that grows one append at a time, and every
 * append is its own zstd frame — one 1.5 MB log held 693 of them. Node's
 * `zstdDecompressSync` stops after the first frame, so the frames are split on
 * the zstd magic and decoded one by one.
 *
 * Two levels leave this module:
 *
 *   - `listSessions` returns summaries only (id, title, counts, timestamps) —
 *     the panel needs nothing more to list conversations;
 *   - `readSessionText` returns bounded user/assistant text for the organize
 *     job. That is the one place message text crosses this boundary, and it is
 *     read on demand for a session the person explicitly selected, never
 *     stored. The organizer feeds it to a model in a comment-free transcript;
 *     nothing here writes it to the data folder.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** The four bytes that start a zstd frame. */
const FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** A log bigger than this is summarised from its first frames only. */
const MAX_LOG_BYTES = 8 * 1024 * 1024

/** A log bigger than this is refused for full-text reading. */
const MAX_FULL_LOG_BYTES = 16 * 1024 * 1024

/** How many sessions one listing may read. */
const DEFAULT_LIMIT = 20

/** Bounds for one full-text read: messages, total characters, per-message characters. */
const FULL_MAX_MESSAGES = 200
const FULL_MAX_CHARS = 24_000
const FULL_MESSAGE_CHARS = 4_000

/** A session id is a folder name; anything else must not reach the filesystem. */
const SESSION_ID_PATTERN = /^session-[0-9a-zA-Z-]+$/

/** Per-path memo, keyed by size and mtime so an append invalidates it. */
const cache = new Map()

/**
 * Concatenate every zstd frame in one buffer.
 *
 * The magic also occurs inside compressed payloads, so a slice that fails to
 * decode is not a frame boundary: the slice is extended to the next candidate.
 *
 * @param {Buffer} buffer - The whole log.
 * @returns {Buffer} The decoded lines.
 */
function decodeFrames(buffer) {
	const parts = []
	let start = 0
	for (let index = 1; index < buffer.length - 3; index += 1) {
		if (buffer[index] !== FRAME_MAGIC[0] || buffer[index + 1] !== FRAME_MAGIC[1]
			|| buffer[index + 2] !== FRAME_MAGIC[2] || buffer[index + 3] !== FRAME_MAGIC[3]) continue
		try {
			parts.push(zstdDecompressSync(buffer.subarray(start, index)))
			start = index
		} catch {
			// Not a real boundary; keep accumulating.
		}
	}
	try {
		parts.push(zstdDecompressSync(buffer.subarray(start)))
	} catch {
		// A truncated tail is not worth failing the whole session over.
	}
	return Buffer.concat(parts)
}

/**
 * Parse the decoded lines into JSON entries, skipping unreadable ones.
 *
 * @param {Buffer | string} text - The decoded log.
 * @returns {object[]} The entries.
 */
function parseEntries(text) {
	const entries = []
	for (const line of text.toString('utf8').split('\n')) {
		if (line === '') continue
		try {
			entries.push(JSON.parse(line))
		} catch {
			// A truncated tail or a hand-edited line is not worth failing over.
		}
	}
	return entries
}

/**
 * Summarise one decoded log.
 *
 * @param {string} id - The session id from the folder name.
 * @param {string} workspace - The encoded workspace folder name.
 * @param {Buffer} text - The decoded lines.
 * @returns {object} The summary.
 */
function summarize(id, workspace, text) {
	let title = ''
	let cwd = ''
	let origin = ''
	let isSeeded = false
	let delegationDepth = 0
	let createdAt = 0
	let updatedAt = 0
	let prompts = 0
	let replies = 0
	for (const entry of parseEntries(text)) {
		const time = Number(entry.time)
		if (Number.isFinite(time) && time > updatedAt) updatedAt = time
		if (entry.type === 'session') {
			cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
			if (typeof entry.origin === 'string') origin = entry.origin
			isSeeded = entry.isSeeded === true
			const depth = Number(entry.delegationDepth)
			if (Number.isFinite(depth) && depth > 0) delegationDepth = Math.round(depth)
			const created = Number(entry.createdAt)
			if (Number.isFinite(created)) createdAt = created
		} else if (entry.type === 'session/title') {
			if (typeof entry.data?.title === 'string') title = entry.data.title
		} else if (entry.type === 'user/message') {
			prompts += 1
		} else if (entry.type === 'assistant/message') {
			replies += 1
		}
	}
	return {
		id,
		workspace,
		cwd,
		origin,
		isSeeded,
		delegationDepth,
		title: title.trim(),
		createdAt: createdAt === 0 ? '' : new Date(createdAt).toISOString(),
		updatedAt: updatedAt === 0 ? '' : new Date(updatedAt).toISOString(),
		prompts,
		replies,
	}
}

/**
 * The visible text blocks of one message content value.
 *
 * @param {unknown} content - A string or a content-block array.
 * @returns {string} The text.
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
 * Assistant text lives under `data.message.content` in the v4 log; user text
 * under `data.content`. Both fall back to the other shape so an older log does
 * not read as an empty conversation.
 *
 * @param {object} entry - A session event.
 * @returns {string} The text, or an empty string.
 */
function eventText(entry) {
	if (entry?.type === 'user/message') return contentText(entry.data?.content ?? entry.data?.message?.content)
	if (entry?.type === 'assistant/message') return contentText(entry.data?.message?.content ?? entry.data?.content)
	return ''
}

/**
 * Whether one user event is what the person actually typed.
 *
 * Runtime context, workspace instructions, skill catalogues and reminders are
 * all appended as user messages; only `source.kind === 'user'` is human input.
 * An older log without a source is treated as human so the read stays useful.
 *
 * @param {object} entry - A session event.
 * @returns {boolean} True for human input.
 */
function isUserTyped(entry) {
	const source = entry?.data?.source
	return source === undefined || source === null || source.kind === 'user'
}

/**
 * Find one session log folder by its id.
 *
 * @param {string} root - The sessions root.
 * @param {string} id - The validated session id.
 * @returns {Promise<{path: string, workspace: string, size: number, mtime: number} | undefined>} The log facts.
 */
async function findSession(root, id) {
	const workspaces = await readdir(root, { withFileTypes: true }).catch(() => [])
	for (const workspace of workspaces) {
		if (!workspace.isDirectory() || workspace.name.startsWith('.')) continue
		const path = join(root, workspace.name, id, 'session.v4.jsonl.zstd')
		const info = await stat(path).catch(() => undefined)
		if (info !== undefined) return { path, workspace: workspace.name, size: info.size, mtime: info.mtimeMs }
	}
	return undefined
}

/**
 * Read and cache one session log.
 *
 * @param {{path: string, id: string, workspace: string, size: number, mtime: number}} entry - The file facts.
 * @returns {Promise<object | undefined>} The summary.
 */
async function readOne(entry) {
	const cached = cache.get(entry.path)
	if (cached !== undefined && cached.size === entry.size && cached.mtime === entry.mtime) return cached.summary
	const buffer = await readFile(entry.path).catch(() => undefined)
	if (buffer === undefined) return undefined
	const summary = summarize(entry.id, entry.workspace, decodeFrames(buffer))
	cache.set(entry.path, { size: entry.size, mtime: entry.mtime, summary })
	return summary
}

/**
 * The newest sessions, newest first.
 *
 * @param {{root: string, limit?: number}} options - Where the logs live and how many to read.
 * @returns {Promise<{sessions: object[], total: number, unreadable: number}>} The listing.
 */
export async function listSessions({ root, limit = DEFAULT_LIMIT }) {
	const capped = Math.max(1, Math.min(50, Math.round(Number(limit) || DEFAULT_LIMIT)))
	const entries = []
	const workspaces = await readdir(root, { withFileTypes: true }).catch(() => [])
	for (const workspace of workspaces) {
		if (!workspace.isDirectory() || workspace.name.startsWith('.')) continue
		const folder = join(root, workspace.name)
		const sessions = await readdir(folder, { withFileTypes: true }).catch(() => [])
		for (const session of sessions) {
			if (!session.isDirectory() || !session.name.startsWith('session-')) continue
			const path = join(folder, session.name, 'session.v4.jsonl.zstd')
			const info = await stat(path).catch(() => undefined)
			if (info === undefined) continue
			entries.push({ path, id: session.name, workspace: workspace.name, size: info.size, mtime: info.mtimeMs })
		}
	}
	entries.sort((left, right) => right.mtime - left.mtime)
	const sessions = []
	let unreadable = 0
	for (const entry of entries.slice(0, capped)) {
		if (entry.size > MAX_LOG_BYTES) {
			unreadable += 1
			continue
		}
		const summary = await readOne(entry)
		if (summary === undefined) unreadable += 1
		else sessions.push({ ...summary, bytes: entry.size })
	}
	return { sessions, total: entries.length, unreadable }
}

/**
 * Read the visible user/assistant text of one session.
 *
 * This is the one place message text leaves the sessions module. It is meant
 * for the organize job, which reads only the sessions the person selected and
 * forwards a bounded transcript to a model. Nothing here writes the text to
 * disk, and the bounds are enforced while collecting — a long session costs
 * one decompression, not an unbounded string.
 *
 * Only human input is collected for the user side: the host also appends
 * runtime context, instructions and reminders as user messages, and those are
 * never something a memory can come from. Assistant text comes from
 * `data.message.content`; reasoning and tool-call blocks are skipped.
 *
 * @param {{root: string, id: string, maxMessages?: number, maxChars?: number, maxMessageChars?: number}} options - Where the logs live, which session, and the caps.
 * @returns {Promise<object | undefined>} The bounded text view, or undefined when the session is absent.
 */
export async function readSessionText({
	root,
	id,
	maxMessages = FULL_MAX_MESSAGES,
	maxChars = FULL_MAX_CHARS,
	maxMessageChars = FULL_MESSAGE_CHARS,
}) {
	const sessionId = String(id ?? '').trim()
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		throw new Error(`会话 id 不合法：${sessionId === '' ? '（空）' : sessionId}`)
	}
	const bounded = {
		messages: Math.max(1, Math.min(1000, Math.round(Number(maxMessages) || FULL_MAX_MESSAGES))),
		chars: Math.max(1000, Math.min(200_000, Math.round(Number(maxChars) || FULL_MAX_CHARS))),
		messageChars: Math.max(200, Math.min(20_000, Math.round(Number(maxMessageChars) || FULL_MESSAGE_CHARS))),
	}
	const found = await findSession(root, sessionId)
	if (found === undefined) return undefined
	if (found.size > MAX_FULL_LOG_BYTES) {
		throw new Error(`会话日志超过 ${Math.round(MAX_FULL_LOG_BYTES / 1024 / 1024)} MB，拒绝读取全文。`)
	}
	const buffer = await readFile(found.path).catch(() => undefined)
	if (buffer === undefined) return undefined
	const decoded = decodeFrames(buffer)
	const summary = summarize(sessionId, found.workspace, decoded)
	const entries = parseEntries(decoded)
	const messages = []
	let chars = 0
	let truncated = false
	for (const entry of entries) {
		if (entry.type !== 'user/message' && entry.type !== 'assistant/message') continue
		if (entry.type === 'user/message' && !isUserTyped(entry)) continue
		const text = eventText(entry)
		if (text === '') continue
		if (messages.length >= bounded.messages) {
			truncated = true
			break
		}
		const clipped = text.length > bounded.messageChars ? `${text.slice(0, bounded.messageChars)}…` : text
		if (chars + clipped.length > bounded.chars) {
			truncated = true
			break
		}
		messages.push({
			role: entry.type === 'user/message' ? 'user' : 'assistant',
			text: clipped,
			time: Number(entry.time) || 0,
		})
		chars += clipped.length
	}
	let throughSeq = 0
	for (const entry of entries) {
		const seq = Number(entry.seq)
		if (Number.isFinite(seq) && seq > throughSeq) throughSeq = seq
	}
	return {
		...summary,
		bytes: found.size,
		messages,
		chars,
		truncated,
		throughSeq,
	}
}
