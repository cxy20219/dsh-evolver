/**
 * The plugin's own log file.
 *
 * The host's stdout is gone after a restart, so a background failure that
 * nobody watched leaves no evidence. This sink writes one line per event into
 * `<dataDir>/logs/plugin.log`, rotates at 256 KB and keeps three files, and
 * forwards the message to the host logger so the panel console still sees it.
 */

import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** One log file may grow to this size before it rotates. */
const DEFAULT_MAX_BYTES = 256 * 1024

/** How many rotated files to keep. */
const DEFAULT_KEEP = 3

/**
 * Create one log sink for a data directory.
 *
 * @param {{dataDir: string, forward?: object, maxBytes?: number, keep?: number}} options - The data directory, the host logger and rotation bounds.
 * @returns {{info: Function, warn: Function, error: Function, close: Function, path: string}} The sink.
 */
export function createLogSink({ dataDir, forward, maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP }) {
	const dir = join(dataDir, 'logs')
	const path = join(dir, 'plugin.log')
	let queue = Promise.resolve()

	/**
	 * Rotate the log when the next line would cross the limit.
	 *
	 * @param {number} incoming - Bytes about to be appended.
	 * @returns {Promise<void>} Resolves when the file is ready.
	 */
	async function rotate(incoming) {
		const info = await stat(path).catch(() => undefined)
		if (info === undefined || info.size + incoming <= maxBytes) return
		for (let index = keep - 1; index >= 1; index -= 1) {
			await rename(`${path}.${index}`, `${path}.${index + 1}`).catch(() => {})
		}
		await rename(path, `${path}.1`).catch(() => {})
		await rm(`${path}.${keep + 1}`, { force: true }).catch(() => {})
	}

	/**
	 * Write one line.
	 *
	 * @param {'info' | 'warn' | 'error'} level - The level.
	 * @param {unknown} message - The message.
	 * @returns {void}
	 */
	function write(level, message) {
		const text = String(message ?? '').replace(/\r?\n/g, ' ')
		const line = `${new Date().toISOString()} ${level} ${text}\n`
		queue = queue.then(async () => {
			await mkdir(dir, { recursive: true, mode: 0o700 })
			await rotate(Buffer.byteLength(line, 'utf8'))
			await appendFile(path, line, { mode: 0o600 })
		}).catch(() => {})
		const target = typeof forward?.[level] === 'function' ? forward[level] : forward?.info
		if (typeof target === 'function') target.call(forward, text)
	}

	return {
		path,
		info: (message) => write('info', message),
		warn: (message) => write('warn', message),
		error: (message) => write('error', message),
		close: () => queue,
	}
}
