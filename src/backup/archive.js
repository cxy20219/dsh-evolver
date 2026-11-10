/**
 * One archive for the whole data folder.
 *
 * The local export and the cloud backup share the same collector, so a file
 * exported by hand and a snapshot uploaded to OSS contain exactly the same
 * tree. The wrapper is tar + gzip: tar keeps the structure and file modes,
 * gzip is built into Node, and both `tar -xzf` and our own importer can read
 * the result.
 *
 * Importing accepts plain tar too, because that is what the cloud backup
 * stores — a downloaded snapshot can be imported without converting it.
 */

import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { createTar, readTar } from './tar.js'
import { isInsidePath, isReallyInside } from '../workspace.js'

/** The largest data folder one archive may carry. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

/** The largest a compressed archive may decompress to. */
export const MAX_UNPACKED_BYTES = 256 * 1024 * 1024

/** The entry count one import will process. */
const MAX_ENTRIES = 5000

/** The only top-level folders an archive may write into. */
const IMPORT_ROOTS = ['practice/', 'sight/', 'preferences/']

/** Files that are never part of an archive. */
function isTransient(name) {
	if (name === '.DS_Store') return true
	return name.endsWith('.tmp')
}

/**
 * Read the data folder into the entries one archive carries.
 *
 * Symbolic links are skipped, not followed: the archive must be a snapshot of
 * this folder, not of wherever a link points.
 *
 * @param {string} root - The data folder.
 * @returns {Promise<Array<{path: string, content: Buffer, mode: number}>>} The entries.
 */
export async function collectDataFiles(root) {
	const files = []
	let total = 0
	/**
	 * Walk one folder.
	 *
	 * @param {string} folder - The folder to walk.
	 * @param {string} prefix - The path prefix inside the archive.
	 * @returns {Promise<void>} Resolves when it was walked.
	 */
	async function walk(folder, prefix) {
		const names = await readdir(folder).catch(() => [])
		for (const name of names.sort()) {
			if (isTransient(name)) continue
			const path = join(folder, name)
			const info = await lstat(path).catch(() => undefined)
			if (info === undefined) continue
			if (info.isSymbolicLink()) continue
			if (info.isDirectory()) {
				await walk(path, `${prefix}${name}/`)
				continue
			}
			if (!info.isFile()) continue
			total += info.size
			if (total > MAX_ARCHIVE_BYTES) {
				throw new Error(`数据目录超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB，暂不支持打包。`)
			}
			files.push({ path: `${prefix}${name}`, content: await readFile(path), mode: info.mode & 0o777 })
		}
	}
	await walk(root, '')
	return files
}

/**
 * Build one compressed archive of the data folder.
 *
 * @param {string} root - The data folder.
 * @param {{now?: Date}} [options] - Clock, for tar timestamps.
 * @returns {Promise<{archive: Buffer, files: number}>} The archive and its entry count.
 */
export async function packDataDir(root, { now } = {}) {
	const files = await collectDataFiles(root)
	const tar = createTar(files, now === undefined ? undefined : { now })
	return { archive: gzipSync(tar, { level: 9 }), files: files.length }
}

/**
 * Whether a buffer starts with the gzip magic bytes.
 *
 * @param {Buffer} buffer - The file content.
 * @returns {boolean} True when it is gzipped.
 */
export function isGzip(buffer) {
	return buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
}

/**
 * Read an archive into entries.
 *
 * @param {Buffer} buffer - File content, gzipped or plain tar.
 * @returns {Array<{path: string, content: Buffer, mode?: number}>} The entries.
 */
export function unpackArchive(buffer) {
	if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('压缩包是空的。')
	let tar = buffer
	if (isGzip(buffer)) {
		try {
			tar = gunzipSync(buffer, { maxOutputLength: MAX_UNPACKED_BYTES })
		} catch (error) {
			throw new Error(`不是可读的 .tar.gz：${error instanceof Error ? error.message : String(error)}`)
		}
	}
	const entries = readTar(tar)
	// A short garbage file parses as "zero entries"; that is not a backup.
	if (entries.length === 0) throw new Error('压缩包里没有可导入的条目（可能不是 tar 格式）。')
	return entries
}

/**
 * Write one archive's entries into a data folder.
 *
 * Only `practice/`, `sight/` and `preferences/` are accepted: an archive is a
 * data folder backup, not a way to drop arbitrary files next to it. Symlinked
 * parents are refused after the directories are created, so an archive cannot
 * redirect a write outside the folder.
 *
 * @param {string} root - The data folder.
 * @param {Array<{path: string, content: Buffer, mode?: number}>} entries - The archive entries.
 * @param {{force?: boolean}} [options] - Overwrite behaviour.
 * @returns {Promise<{root: string, files: number, bytes: number, skipped: number}>} What was written.
 */
export async function restoreEntries(root, entries, { force = false } = {}) {
	if (entries.length > MAX_ENTRIES) {
		throw new Error(`压缩包条目过多（${entries.length}），拒绝导入。`)
	}
	let files = 0
	let bytes = 0
	let skipped = 0
	for (const entry of entries) {
		const path = String(entry.path ?? '')
		const segments = path.split('/')
		const allowed = IMPORT_ROOTS.some((prefix) => path.startsWith(prefix))
		if (!allowed || path.startsWith('/') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
			skipped += 1
			continue
		}
		const target = join(root, path)
		const folder = dirname(target)
		await mkdir(folder, { recursive: true, mode: 0o700 })
		if (!isInsidePath(root, target) || !(await isReallyInside(root, folder))) {
			throw new Error(`压缩包里的条目指向数据目录之外：${path}`)
		}
		const existing = await lstat(target).catch(() => undefined)
		if (existing !== undefined) {
			// A link is never overwritten: `writeFile` would follow it out of
			// the data folder even though the archive looks self-contained.
			if (!force || existing.isSymbolicLink()) {
				skipped += 1
				continue
			}
		}
		await writeFile(target, entry.content, { mode: (entry.mode ?? 0o600) & 0o777 })
		files += 1
		bytes += entry.content.length
	}
	return { root, files, bytes, skipped }
}

/**
 * Write an archive to a file, atomically.
 *
 * @param {string} target - The archive path.
 * @param {Buffer} archive - The bytes.
 * @returns {Promise<void>} Resolves once the file is in place.
 */
export async function writeArchive(target, archive) {
	const temp = `${target}.${process.pid}.${Date.now()}.tmp`
	await writeFile(temp, archive, { mode: 0o600 })
	await rename(temp, target)
}
