/**
 * One archive for the whole data folder, written and read as a stream.
 *
 * The local export and the cloud backup share the same collector, so a file
 * exported by hand and a snapshot uploaded to OSS contain exactly the same
 * tree. The wrapper is tar + gzip: tar keeps the structure and file modes,
 * gzip is built into Node, and both `tar -xzf` and our own importer can read
 * the result.
 *
 * Everything streams. Model weights are data now and can be hundreds of
 * megabytes; building the tar (and then the gzip) in memory would duplicate
 * the whole folder. The writer reads one file at a time; the importer parses
 * headers and writes each entry as it arrives.
 *
 * Importing accepts plain tar too, because that is what the cloud backup
 * stores — a downloaded snapshot can be imported without converting it.
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

import { buildTarHeader, parseTarHeader } from './tar.js'
import { isInsidePath, isReallyInside } from '../workspace.js'

/** The largest archive an import will accept, in bytes. */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024 * 1024

/** The largest entry count an import will process. */
const MAX_IMPORT_ENTRIES = 20000

/** The only top-level folders an archive may write into. */
const IMPORT_ROOTS = ['knowledge/', 'sight/', 'preferences/', 'models/']

/** Files that are never part of an archive. */
function isTransient(name) {
	if (name === '.DS_Store') return true
	return name.endsWith('.tmp') || name.endsWith('.part')
}

/**
 * Walk the data folder without reading file contents.
 *
 * Symbolic links are skipped, not followed: the archive must be a snapshot of
 * this folder, not of wherever a link points.
 *
 * @param {string} root - The data folder.
 * @returns {Promise<Array<{path: string, absPath: string, size: number, mode: number, mtimeMs: number}>>} The entries.
 */
export async function collectFileEntries(root) {
	const entries = []
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
			if (info === undefined || info.isSymbolicLink()) continue
			if (info.isDirectory()) {
				await walk(path, `${prefix}${name}/`)
				continue
			}
			if (!info.isFile()) continue
			entries.push({
				path: `${prefix}${name}`,
				absPath: path,
				size: info.size,
				mode: info.mode & 0o777,
				mtimeMs: info.mtimeMs,
			})
		}
	}
	await walk(root, '')
	return entries
}

/**
 * Yield the tar bytes of the data folder, one file at a time.
 *
 * @param {string} root - The data folder.
 * @param {{files: number, bytes: number}} stats - Filled while walking.
 * @returns {AsyncGenerator<Buffer>} The tar chunks.
 */
async function* tarChunks(root, stats) {
	const entries = await collectFileEntries(root)
	for (const entry of entries) {
		yield buildTarHeader({
			path: entry.path,
			size: entry.size,
			mode: entry.mode,
			mtime: Math.floor(entry.mtimeMs / 1000),
		})
		for await (const chunk of createReadStream(entry.absPath)) yield chunk
		const remainder = entry.size % 512
		if (remainder !== 0) yield Buffer.alloc(512 - remainder)
		stats.files += 1
		stats.bytes += entry.size
	}
	// Two zero blocks end the archive.
	yield Buffer.alloc(1024)
}

/**
 * Write the data folder as one plain tar file.
 *
 * @param {string} root - The data folder.
 * @param {string} target - The destination file.
 * @returns {Promise<{files: number, bytes: number, contentMd5: string}>} The archive size and its MD5.
 */
export async function writeTarFile(root, target) {
	const temp = `${target}.${process.pid}.${Date.now()}.tmp`
	const stats = { files: 0, bytes: 0 }
	const hash = createHash('md5')
	/**
	 * Pass every chunk through the hasher on its way to the file.
	 *
	 * @returns {AsyncGenerator<Buffer>} The same chunks.
	 */
	async function* hashed() {
		for await (const chunk of tarChunks(root, stats)) {
			hash.update(chunk)
			yield chunk
		}
	}
	try {
		await pipeline(Readable.from(hashed()), createWriteStream(temp, { mode: 0o600 }))
		// The upload needs the size of the tar *file* (headers plus padding),
		// not the sum of the payloads; a mismatch would declare the wrong
		// Content-Length and stall the PUT.
		const size = (await stat(temp)).size
		await rename(temp, target)
		return { files: stats.files, bytes: size, contentMd5: hash.digest('base64') }
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {})
		throw error
	}
}

/**
 * Write the data folder as one `.tar.gz` archive.
 *
 * @param {string} root - The data folder.
 * @param {string} target - The destination file.
 * @returns {Promise<{files: number, bytes: number}>} The file count and the compressed size.
 */
export async function writeArchiveFile(root, target) {
	const temp = `${target}.${process.pid}.${Date.now()}.tmp`
	const stats = { files: 0, bytes: 0 }
	try {
		await pipeline(
			Readable.from(tarChunks(root, stats)),
			createGzip({ level: 9 }),
			createWriteStream(temp, { mode: 0o600 }),
		)
		const size = (await stat(temp)).size
		await rename(temp, target)
		return { files: stats.files, bytes: size }
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {})
		throw error
	}
}

/**
 * Whether a buffer starts with the gzip magic bytes.
 *
 * @param {Buffer} buffer - The file content.
 * @returns {boolean} True when it is gzipped.
 */
export function isGzip(buffer) {
	return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
}

/**
 * A buffered reader over a byte stream.
 */
class ChunkReader {
	/**
	 * @param {AsyncIterable<Buffer>} stream - The tar stream (already gunzipped if needed).
	 */
	constructor(stream) {
		this.iterator = stream[Symbol.asyncIterator]()
		this.buffer = Buffer.alloc(0)
		this.done = false
	}

	/**
	 * Pull until the buffer holds `count` bytes, or the stream ends.
	 *
	 * @param {number} count - The number of bytes the buffer should hold.
	 * @returns {Promise<void>} Resolves when the buffer is big enough or the stream ended.
	 */
	async fill(count) {
		while (this.buffer.length < count && !this.done) {
			const next = await this.iterator.next()
			if (next.done === true) {
				this.done = true
				break
			}
			this.buffer = this.buffer.length === 0
				? Buffer.from(next.value)
				: Buffer.concat([this.buffer, next.value])
		}
	}

	/**
	 * Take exactly `count` bytes.
	 *
	 * @param {number} count - How many bytes.
	 * @returns {Promise<Buffer | null>} The bytes, or null at a clean end of stream.
	 */
	async take(count) {
		await this.fill(count)
		if (this.buffer.length === 0 && this.done) return null
		if (this.buffer.length < count) throw new Error('tar 内容被截断')
		const out = this.buffer.subarray(0, count)
		this.buffer = this.buffer.subarray(count)
		return out
	}

	/**
	 * Drop `count` bytes.
	 *
	 * @param {number} count - How many bytes.
	 * @returns {Promise<void>} Resolves when they are consumed.
	 */
	async skip(count) {
		let left = count
		while (left > 0) {
			await this.fill(1)
			if (this.buffer.length === 0) throw new Error('tar 内容被截断')
			const take = Math.min(left, this.buffer.length)
			this.buffer = this.buffer.subarray(take)
			left -= take
		}
	}

	/**
	 * Copy `count` bytes into a file handle.
	 *
	 * @param {number} count - How many bytes.
	 * @param {import('node:fs/promises').FileHandle} handle - The open file.
	 * @returns {Promise<void>} Resolves when the bytes are written.
	 */
	async pipeTo(count, handle) {
		let left = count
		while (left > 0) {
			await this.fill(1)
			if (this.buffer.length === 0) throw new Error('tar 内容被截断')
			const take = Math.min(left, this.buffer.length)
			await handle.write(this.buffer.subarray(0, take))
			this.buffer = this.buffer.subarray(take)
			left -= take
		}
	}
}

/**
 * Whether an entry may be restored.
 *
 * @param {string} path - The archive path.
 * @returns {boolean} True when it is inside one of the known folders.
 */
function isImportable(path) {
	return IMPORT_ROOTS.some((prefix) => path.startsWith(prefix))
}

/**
 * Extract an archive file into a data folder.
 *
 * Only `knowledge/`, `sight/`, `preferences/` and `models/` are accepted: an
 * archive is a data folder backup, not a way to drop arbitrary files next to
 * it. Symlinked parents are refused after the directories are created, so an
 * archive cannot redirect a write outside the folder.
 *
 * @param {string} source - The archive file.
 * @param {string} root - The data folder.
 * @param {{force?: boolean}} [options] - Overwrite behaviour.
 * @returns {Promise<{root: string, files: number, bytes: number, skipped: number}>} What was written.
 */
export async function extractArchiveFile(source, root, { force = false } = {}) {
	const handle = await open(source, 'r')
	let gzipped = false
	try {
		const head = Buffer.alloc(2)
		const { bytesRead } = await handle.read(head, 0, 2, 0)
		gzipped = bytesRead === 2 && isGzip(head)
	} finally {
		await handle.close()
	}
	const input = createReadStream(source)
	const stream = gzipped ? input.pipe(createGunzip()) : input
	const reader = new ChunkReader(stream)
	let files = 0
	let bytes = 0
	let skipped = 0
	let sawEntry = false
	for (;;) {
		const header = await reader.take(512)
		if (header === null) break
		if (header.every((byte) => byte === 0)) break
		const parsed = parseTarHeader(header)
		sawEntry = true
		const padding = (512 - (parsed.size % 512)) % 512
		const regular = parsed.type === '0' || parsed.type === '\0'
		if (!regular || !isImportable(parsed.path)) {
			await reader.skip(parsed.size + padding)
			skipped += 1
			continue
		}
		if (files + 1 > MAX_IMPORT_ENTRIES) throw new Error(`压缩包条目过多（上限 ${MAX_IMPORT_ENTRIES}）。`)
		if (bytes + parsed.size > MAX_IMPORT_BYTES) throw new Error('压缩包解压后超过大小上限。')
		const target = join(root, ...parsed.path.split('/'))
		const folder = dirname(target)
		await mkdir(folder, { recursive: true, mode: 0o700 })
		if (!isInsidePath(root, target) || !(await isReallyInside(root, folder))) {
			throw new Error(`压缩包里的条目指向数据目录之外：${parsed.path}`)
		}
		const existing = await lstat(target).catch(() => undefined)
		if (existing !== undefined) {
			// A link is never overwritten: writing through it would leave the
			// data folder even though the archive looks self-contained.
			if (!force || existing.isSymbolicLink()) {
				await reader.skip(parsed.size + padding)
				skipped += 1
				continue
			}
		}
		const temp = `${target}.${process.pid}.${Date.now()}.part`
		const file = await open(temp, 'w', 0o600)
		try {
			await reader.pipeTo(parsed.size, file)
			await file.close()
			if (Number.isFinite(parsed.mode)) await chmod(temp, parsed.mode & 0o777)
			await rename(temp, target)
		} catch (error) {
			await file.close().catch(() => {})
			await rm(temp, { force: true }).catch(() => {})
			throw error
		}
		await reader.skip(padding)
		files += 1
		bytes += parsed.size
	}
	if (!sawEntry) throw new Error('压缩包里没有可导入的条目（可能不是 tar 格式）。')
	return { root, files, bytes, skipped }
}
