/**
 * Portable snapshots of a 自衍中枢 data directory.
 *
 * The archive is tar + gzip: tar keeps the relative layout and executable
 * bits, gzip is built into Node. Only canonical content is exported — the
 * `files/` tree and `system/settings.json`; the SQLite index, snapshots, logs
 * and trash are derived/local state and are rebuilt on the next start.
 *
 * The reader is deliberately strict: one manifest, one settings file, and
 * `files/` entries only. Absolute paths, `..`, backslashes, symlinks and other
 * tar types are refused before anything is written outside the new root.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

import { buildTarHeader, parseTarHeader } from './tar.js'

/** The manifest file at the archive root. */
export const MANIFEST_NAME = 'yuanshi-export.json'

/** The largest compressed archive accepted or produced for browser transfer. */
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024

/** The largest amount of data one import may unpack. */
export const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024

/** The largest single entry. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

/** The largest number of entries. */
export const MAX_ENTRIES = 20000

/**
 * Whether a name is transient and must not enter an archive.
 *
 * @param {string} name - A path segment.
 * @returns {boolean} True for temp files.
 */
function isTransient(name) {
	return name.startsWith('.tmp-') || name.endsWith('.tmp')
}

/**
 * Whether a path is allowed inside an import.
 *
 * @param {string} path - A tar path.
 * @returns {boolean} True for the manifest, settings, or files/.
 */
function isAllowedPath(path) {
	return path === MANIFEST_NAME
		|| path === 'system/settings.json'
		|| path.startsWith('files/')
}

/**
 * Walk the canonical part of a data directory.
 *
 * @param {string} root - The data root.
 * @returns {Promise<{entries: Array<object>, entities: number, bytes: number}>} Files to archive.
 */
async function collectEntries(root) {
	const entries = []
	let entities = 0
	let bytes = 0
	/**
	 * Walk one directory.
	 *
	 * @param {string} folder - The absolute folder.
	 * @param {string} prefix - Its archive prefix.
	 * @returns {Promise<void>} Resolves when walked.
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
				mtime: Math.floor(info.mtimeMs / 1000),
			})
			bytes += info.size
		}
	}
	await walk(join(root, 'files'), 'files/')
	for (const entry of entries) {
		if (entry.path.endsWith('/meta.json')) entities += 1
	}
	const settings = await stat(join(root, 'system', 'settings.json')).catch(() => undefined)
	if (settings?.isFile()) {
		entries.push({
			path: 'system/settings.json',
			absPath: join(root, 'system', 'settings.json'),
			size: settings.size,
			mode: settings.mode & 0o777,
			mtime: Math.floor(settings.mtimeMs / 1000),
		})
		bytes += settings.size
	}
	return { entries, entities, bytes }
}

/**
 * Yield one archive's tar blocks.
 *
 * @param {string} root - The data root.
 * @param {{files: number, bytes: number}} stats - Filled while yielding.
 * @param {string} version - The plugin version for the manifest.
 * @returns {AsyncGenerator<Buffer>} Tar chunks.
 */
async function* tarChunks(root, stats, version) {
	const collected = await collectEntries(root)
	const manifest = Buffer.from(`${JSON.stringify({
		schema: 1,
		kind: 'yuanshi-export',
		version,
		createdAt: new Date().toISOString(),
		counts: { files: collected.entities, bytes: collected.bytes },
	}, null, 2)}\n`, 'utf8')
	stats.files = collected.entities
	stats.bytes = collected.bytes
	yield buildTarHeader({ path: MANIFEST_NAME, size: manifest.length, mode: 0o600, mtime: Math.floor(Date.now() / 1000) })
	yield manifest
	if (manifest.length % 512 !== 0) yield Buffer.alloc(512 - (manifest.length % 512))

	for (const entry of collected.entries) {
		const handle = await open(entry.absPath, 'r').catch(() => undefined)
		if (handle === undefined) continue
		try {
			const info = await handle.stat()
			if (!info.isFile()) continue
			const size = info.size
			yield buildTarHeader({ path: entry.path, size, mode: entry.mode, mtime: entry.mtime })
			let offset = 0
			while (offset < size) {
				const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - offset))
				const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset)
				if (bytesRead === 0) throw new Error(`导出时文件被截断：${entry.path}`)
				yield chunk.subarray(0, bytesRead)
				offset += bytesRead
			}
			if (size % 512 !== 0) yield Buffer.alloc(512 - (size % 512))
		} finally {
			await handle.close().catch(() => {})
		}
	}
	yield Buffer.alloc(1024)
}

/**
 * Write one `.tar.gz` snapshot.
 *
 * @param {string} root - The data root.
 * @param {string} target - The destination archive path.
 * @param {{version?: string}} [options] - Manifest version.
 * @returns {Promise<{files: number, bytes: number, archiveBytes: number}>} Statistics.
 */
export async function writeArchiveFile(root, target, { version = '' } = {}) {
	const temp = `${target}.${process.pid}.${Date.now()}.tmp`
	const stats = { files: 0, bytes: 0 }
	try {
		await pipeline(
			Readable.from(tarChunks(root, stats, version)),
			createGzip({ level: 9 }),
			createWriteStream(temp, { mode: 0o600 }),
		)
		const info = await stat(temp)
		await rename(temp, target)
		return { files: stats.files, bytes: stats.bytes, archiveBytes: info.size }
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {})
		throw error
	}
}

/**
 * A buffered reader over a byte stream.
 */
class ChunkReader {
	/**
	 * @param {AsyncIterable<Buffer>} stream - The tar stream.
	 */
	constructor(stream) {
		this.iterator = stream[Symbol.asyncIterator]()
		this.buffer = Buffer.alloc(0)
		this.done = false
	}

	/**
	 * Fill at least `count` bytes.
	 *
	 * @param {number} count - The desired byte count.
	 * @returns {Promise<void>} Resolves when enough bytes or the stream ends.
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
	 * @param {number} count - The byte count.
	 * @returns {Promise<Buffer | null>} The bytes, or null at a clean end.
	 */
	async take(count) {
		await this.fill(count)
		if (this.buffer.length === 0) return null
		if (this.buffer.length < count) throw new Error('tar 内容被截断')
		const value = this.buffer.subarray(0, count)
		this.buffer = this.buffer.subarray(count)
		return value
	}
}

/**
 * Whether a file begins with gzip magic.
 *
 * @param {string} path - The file.
 * @returns {Promise<boolean>} True for gzip.
 */
async function isGzipFile(path) {
	const handle = await open(path, 'r').catch(() => undefined)
	if (handle === undefined) return false
	try {
		const buffer = Buffer.alloc(2)
		const { bytesRead } = await handle.read(buffer, 0, 2, 0)
		return bytesRead === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
	} finally {
		await handle.close().catch(() => {})
	}
}

/**
 * Extract one snapshot into a new directory.
 *
 * The caller must pass a target that does not exist (or is empty); this
 * function creates it and refuses any path outside it. On error the caller
 * should remove the target.
 *
 * @param {string} source - The archive path.
 * @param {string} target - The new data root.
 * @returns {Promise<{manifest: object, files: number, bytes: number}>} Import statistics.
 */
export async function readArchiveFile(source, target) {
	const info = await stat(source).catch(() => undefined)
	if (info === undefined || !info.isFile()) throw new Error('压缩包不存在。')
	if (info.size > MAX_ARCHIVE_BYTES) throw new Error(`压缩包超过 ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB 上限。`)
	await mkdir(target, { recursive: false, mode: 0o700 })
	const root = resolve(target)
	const gzip = await isGzipFile(source)
	const stream = createReadStream(source)
	const reader = new ChunkReader(gzip ? stream.pipe(createGunzip()) : stream)
	let manifest
	let files = 0
	let bytes = 0
	let entries = 0
	try {
		while (true) {
			const header = await reader.take(512)
			if (header === null) break
			if (header.every((byte) => byte === 0)) break
			const parsed = parseTarHeader(header)
			entries += 1
			if (entries > MAX_ENTRIES) throw new Error('压缩包条目过多。')
			if (parsed.type !== '0') throw new Error(`压缩包包含非普通文件条目：${parsed.type}`)
			if (!isAllowedPath(parsed.path)) throw new Error(`压缩包包含不允许的路径：${parsed.path}`)
			const destination = resolve(target, parsed.path)
			if (destination !== root && !destination.startsWith(root + sep)) throw new Error(`压缩包路径越界：${parsed.path}`)
			if (parsed.size > MAX_ENTRY_BYTES) throw new Error(`压缩包单文件过大：${parsed.path}`)
			bytes += parsed.size
			if (bytes > MAX_EXTRACTED_BYTES) throw new Error('压缩包解压后超过大小上限。')
			const content = await reader.take(parsed.size)
			if (content === null && parsed.size > 0) throw new Error('tar 内容被截断')
			const remainder = parsed.size % 512
			if (remainder !== 0) {
				const padding = await reader.take(512 - remainder)
				if (padding === null) throw new Error('tar 内容被截断')
			}
			await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
			await writeFile(destination, content ?? Buffer.alloc(0), { mode: parsed.mode & 0o777 })
			await chmod(destination, parsed.mode & 0o777).catch(() => {})
			if (parsed.path === MANIFEST_NAME) {
				try {
					manifest = JSON.parse((content ?? Buffer.alloc(0)).toString('utf8'))
				} catch {
					throw new Error('归档清单不是合法 JSON。')
				}
			}
			if (parsed.path.startsWith('files/') && !parsed.path.endsWith('/meta.json')) files += 1
		}
	} catch (error) {
		stream.destroy()
		throw new Error(`不能读取压缩包：${error instanceof Error ? error.message : String(error)}`)
	}
	if (manifest === undefined || manifest.kind !== 'yuanshi-export' || manifest.schema !== 1) {
		throw new Error('不是自衍中枢导出包（缺少合法清单）。')
	}
	return { manifest, files, bytes }
}
