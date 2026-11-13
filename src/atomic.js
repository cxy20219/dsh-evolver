/**
 * Write-through-temp helpers.
 *
 * Every file this plugin replaces is read back by something else (the prompt,
 * the next boot, the panel), so a reader must see the old complete file or the
 * new complete file, never a half-written one. `rename` on the same file
 * system gives that for free; the only thing that has to be right is the
 * temporary name.
 *
 * The name used to be `${path}.${pid}.tmp` in several places, which two
 * concurrent writers in one process share: the first rename consumes the temp
 * file and the second fails with ENOENT (or, worse, writes another document's
 * bytes). A process-wide counter makes every write name unique, and the
 * `mkdir` keeps the 0700 folder / 0600 file modes the data folder relies on.
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Counts writes so two in the same millisecond cannot pick the same name. */
let sequence = 0

/**
 * Replace one file atomically.
 *
 * @param {string} path - Destination.
 * @param {string | Buffer} data - The complete content.
 * @param {{mode?: number, encoding?: BufferEncoding}} [options] - File options.
 * @returns {Promise<void>} Resolves once the rename is committed.
 */
export async function writeFileAtomic(path, data, { mode = 0o600, encoding = 'utf8' } = {}) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	sequence += 1
	const temp = `${path}.${process.pid}.${sequence}.tmp`
	try {
		await writeFile(temp, data, { mode, encoding })
		await rename(temp, path)
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {})
		throw error
	}
}

/**
 * Replace one JSON file atomically.
 *
 * @param {string} path - Destination.
 * @param {unknown} value - The value to serialise.
 * @param {{indent?: string | number}} [options] - Serialisation options.
 * @returns {Promise<void>} Resolves once the rename is committed.
 */
export function writeJsonAtomic(path, value, { indent = '\t' } = {}) {
	return writeFileAtomic(path, `${JSON.stringify(value, null, indent)}\n`)
}
