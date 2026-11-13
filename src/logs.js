/**
 * The plugin's own log file, small and self-rotating.
 *
 * DSH writes plugin logs to the process' stdout, and a desktop app's stdout is
 * gone the moment it restarts: exactly when a background job misbehaves, the
 * evidence is the thing that disappears. This sink keeps the recent lines on
 * disk instead, so "why did the ingest do nothing" can be answered after the
 * fact.
 *
 * Rotation is by size, and the constraint is deliberately hard: a log that can
 * grow without bound is a new failure mode (the disk fills, the write slows
 * down, the plugin stalls), not a diagnostic. `keep` files of `maxBytes` each
 * is the whole budget, and the oldest is dropped first.
 *
 * Nothing here may throw into a caller: a log that breaks the job it observes
 * is worse than no log.
 */

import { appendFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** How many bytes the current file may hold before it rotates. */
const MAX_BYTES = 256 * 1024

/** How many files the ring keeps, the current one included. */
const KEEP = 3

/** The longest single line kept; a stack trace is not worth a megabyte. */
const MAX_MESSAGE_CHARS = 4000

/** How many entries one read returns by default. */
const DEFAULT_TAIL = 200

/**
 * The log directory inside a data folder.
 *
 * @param {string} dataDir - The data folder.
 * @returns {string} The absolute path.
 */
function logDir(dataDir) {
	return join(dataDir, 'knowledge', 'logs')
}

/**
 * One file of the ring.
 *
 * @param {string} dataDir - The data folder.
 * @param {number} index - 0 is the current file, 1 the previous, and so on.
 * @returns {string} The absolute path.
 */
function logPath(dataDir, index) {
	return join(logDir(dataDir), index === 0 ? 'plugin.log' : `plugin.${index}.log`)
}

/**
 * One log line, as it is stored.
 *
 * @param {string} level - `info`, `warn` or `error`.
 * @param {string} message - The text.
 * @param {number} at - Milliseconds.
 * @returns {string} The JSONL line, newline included.
 */
function lineOf(level, message, at) {
	const text = String(message ?? '').replace(/\s+/g, ' ').trim()
	const clipped = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text
	return `${JSON.stringify({ at: new Date(at).toISOString(), level, message: clipped })}\n`
}

/**
 * Parse the entries of one file, newest last.
 *
 * A half-written last line is dropped rather than reported as a broken entry:
 * the file is appended to while it is being read.
 *
 * @param {string} raw - The file contents.
 * @returns {object[]} The entries.
 */
function parseEntries(raw) {
	const entries = []
	for (const line of raw.split('\n')) {
		const text = line.trim()
		if (text === '') continue
		let entry
		try {
			entry = JSON.parse(text)
		} catch {
			continue
		}
		if (entry === null || typeof entry !== 'object') continue
		entries.push({
			at: typeof entry.at === 'string' ? entry.at : '',
			level: entry.level === 'warn' || entry.level === 'error' ? entry.level : 'info',
			message: typeof entry.message === 'string' ? entry.message : '',
		})
	}
	return entries
}

/**
 * Create the plugin log sink.
 *
 * @param {object} options - Options.
 * @param {() => string} options.dataDir - The current data folder (it moves with migration).
 * @param {object} [options.forward] - The host logger; entries are mirrored there.
 * @param {() => number} [options.now] - Clock.
 * @param {number} [options.maxBytes] - Rotation threshold.
 * @param {number} [options.keep] - How many files to keep.
 * @returns {object} The sink: `info`, `warn`, `error`, `tail`, `status`.
 */
export function createLogSink({ dataDir, forward, now = () => Date.now(), maxBytes = MAX_BYTES, keep = KEEP }) {
	const limit = Math.max(1, Math.round(Number(maxBytes) || MAX_BYTES))
	const files = Math.max(1, Math.round(Number(keep) || KEEP))
	/** Bytes written to the current file since it was opened; -1 until known. */
	let bytes = -1
	/** Writes run one after another, so two lines never interleave. */
	let chain = Promise.resolve()

	/**
	 * The current file's size, read once and tracked afterwards.
	 *
	 * @param {string} root - The data folder.
	 * @returns {Promise<number>} The size in bytes.
	 */
	async function sizeOf(root) {
		if (bytes >= 0) return bytes
		try {
			bytes = (await stat(logPath(root, 0))).size
		} catch {
			bytes = 0
		}
		return bytes
	}

	/**
	 * Shift the ring one step, dropping the oldest file.
	 *
	 * @param {string} root - The data folder.
	 * @returns {Promise<void>} Resolves when the ring is ready for the next line.
	 */
	async function rotate(root) {
		// Drop the oldest file, then shift every other one down a slot; the
		// current file becomes the first history file.
		await unlink(logPath(root, files - 1)).catch(() => {})
		for (let index = files - 2; index >= 0; index -= 1) {
			await rename(logPath(root, index), logPath(root, index + 1)).catch(() => {})
		}
		bytes = 0
	}

	/**
	 * Append one entry, rotating first when it would cross the threshold.
	 *
	 * @param {string} level - The level.
	 * @param {string} message - The text.
	 * @returns {Promise<void>} Resolves once the line is on disk.
	 */
	async function append(level, message) {
		const root = dataDir()
		if (typeof root !== 'string' || root === '') return
		const line = lineOf(level, message, now())
		const size = Buffer.byteLength(line, 'utf8')
		await mkdir(logDir(root), { recursive: true, mode: 0o700 })
		const current = await sizeOf(root)
		if (current + size > limit) {
			await rotate(root)
			bytes = 0
		}
		await appendFile(logPath(root, 0), line, { mode: 0o600 })
		bytes += size
	}

	/**
	 * Record one entry and mirror it to the host logger.
	 *
	 * @param {string} level - The level.
	 * @param {string} message - The text.
	 * @returns {void}
	 */
	function record(level, message) {
		chain = chain.then(() => append(level, message)).catch(() => {})
		if (typeof forward?.[level] === 'function') {
			try {
				forward[level](String(message ?? ''))
			} catch {
				// A host logger that throws must not cost the file entry.
			}
		}
	}

	/**
	 * Read the most recent entries, newest last.
	 *
	 * @param {number} [count] - How many to return.
	 * @returns {Promise<object[]>} The entries.
	 */
	async function tail(count = DEFAULT_TAIL) {
		const wanted = Math.max(1, Math.min(2000, Math.round(Number(count) || DEFAULT_TAIL)))
		const root = dataDir()
		if (typeof root !== 'string' || root === '') return []
		const entries = []
		for (let index = files - 1; index >= 0 && entries.length < wanted; index -= 1) {
			let raw
			try {
				raw = await readFile(logPath(root, index), 'utf8')
			} catch {
				continue
			}
			// Oldest file first, so its lines belong at the front of the result.
			entries.push(...parseEntries(raw))
		}
		return entries.slice(-wanted)
	}

	/**
	 * What the panel needs to describe the ring.
	 *
	 * @returns {Promise<object>} `{files, bytes, maxBytes, dir}`.
	 */
	async function status() {
		const root = dataDir()
		const kept = []
		let total = 0
		for (let index = 0; index < files; index += 1) {
			let size = 0
			try {
				size = (await stat(logPath(root, index))).size
			} catch {
				continue
			}
			kept.push({ name: `plugin${index === 0 ? '' : `.${index}`}.log`, bytes: size })
			total += size
		}
		return { files: kept, bytes: total, maxBytes: limit, keep: files, dir: logDir(root) }
	}

	return {
		info: (message) => record('info', message),
		warn: (message) => record('warn', message),
		error: (message) => record('error', message),
		/** Wait until everything queued so far is on disk. */
		flush: async () => {
			await chain.catch(() => {})
		},
		tail,
		status,
	}
}
