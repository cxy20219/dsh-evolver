/**
 * Reading the host's session logs for the organize page.
 *
 * A session log is a JSONL file that grows one append at a time, and every
 * append is its own zstd frame — one 1.5 MB log held 693 of them. Node's
 * `zstdDecompressSync` stops after the first frame, so the frames are split on
 * the zstd magic and decoded one by one.
 *
 * Only the summary leaves this module: id, title, counts, timestamps. Message
 * text is never returned or stored, because the panel has no use for it and
 * turning a conversation into files is the agent's job, not the store's.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** The four bytes that start a zstd frame. */
const FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** A log bigger than this is summarised from its first frames only. */
const MAX_LOG_BYTES = 8 * 1024 * 1024

/** How many sessions one listing may read. */
const DEFAULT_LIMIT = 20

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
	let createdAt = 0
	let updatedAt = 0
	let prompts = 0
	let replies = 0
	for (const line of text.toString('utf8').split('\n')) {
		if (line === '') continue
		let entry
		try {
			entry = JSON.parse(line)
		} catch {
			continue
		}
		const time = Number(entry.time)
		if (Number.isFinite(time) && time > updatedAt) updatedAt = time
		if (entry.type === 'session') {
			cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
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
		title: title.trim(),
		createdAt: createdAt === 0 ? '' : new Date(createdAt).toISOString(),
		updatedAt: updatedAt === 0 ? '' : new Date(updatedAt).toISOString(),
		prompts,
		replies,
	}
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
