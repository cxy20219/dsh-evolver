/**
 * Atomic file writes.
 *
 * One rule for every file the plugin owns: write a uniquely named temporary
 * file in the destination directory, then rename it into place. A reader never
 * sees a half-written JSON file, and two writers cannot consume each other's
 * temp file because the name carries the pid and a UUID.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Write one file atomically.
 *
 * @param {string} path - The destination.
 * @param {string | Buffer} data - The bytes.
 * @param {{mode?: number}} [options] - File mode.
 * @returns {Promise<void>} Resolves once renamed.
 */
export async function writeFileAtomic(path, data, { mode = 0o600 } = {}) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	const temp = join(dirname(path), `.tmp-${process.pid}-${randomUUID()}`)
	try {
		await writeFile(temp, data, { mode })
		await rename(temp, path)
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {})
		throw error
	}
}
