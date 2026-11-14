/**
 * The one path that lives outside the data directory.
 *
 * Settings, files and indexes all live under the chosen root; only a tiny
 * pointer has to live beside it, otherwise changing the root would move the
 * file that tells the next start where the root is. The pointer contains one
 * absolute path and nothing else.
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { writeFileAtomic } from './atomic.js'

/** The pointer schema version. */
export const POINTER_SCHEMA = 1

/** The pointer file name under DSH_HOME. */
export const POINTER_FILE = 'ziyan.home.json'

/**
 * Path of the pointer file.
 *
 * @param {string} dshHome - The DSH home directory.
 * @returns {string} The absolute pointer path.
 */
export function dataDirPointerPath(dshHome) {
	return join(dshHome, POINTER_FILE)
}

/**
 * Read the data-directory pointer.
 *
 * @param {string} path - The pointer path.
 * @returns {Promise<{dataDir: string} | undefined>} The pointer, or undefined when absent.
 */
export async function readDataDirPointer(path) {
	const text = await readFile(path, 'utf8').catch((error) => {
		if (error?.code === 'ENOENT') return undefined
		throw error
	})
	if (text === undefined) return undefined
	let parsed
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new Error(`数据目录指针不是合法 JSON：${path}`)
	}
	if (parsed === null || typeof parsed !== 'object' || typeof parsed.dataDir !== 'string' || parsed.dataDir.trim() === '') {
		throw new Error(`数据目录指针缺少 dataDir：${path}`)
	}
	if (!isAbsolute(parsed.dataDir)) throw new Error(`数据目录指针必须是绝对路径：${parsed.dataDir}`)
	return { dataDir: resolve(parsed.dataDir) }
}

/**
 * Write the data-directory pointer atomically.
 *
 * @param {string} path - The pointer path.
 * @param {string} dataDir - The new absolute data directory.
 * @returns {Promise<void>} Resolves once written.
 */
export async function writeDataDirPointer(path, dataDir) {
	if (!isAbsolute(dataDir)) throw new Error(`数据目录必须是绝对路径：${dataDir}`)
	await writeFileAtomic(path, `${JSON.stringify({
		schema: POINTER_SCHEMA,
		dataDir: resolve(dataDir),
		updatedAt: new Date().toISOString(),
	}, null, 2)}\n`, { mode: 0o600 })
}
