/**
 * One archive for the whole data folder, written and read as a stream.
 *
 * The local export and the cloud backup share the same collector, so a file
 * exported by hand and a snapshot uploaded to OSS contain exactly the same
 * tree. The wrapper is tar + gzip: tar keeps the structure and file modes,
 * gzip is built into Node, and both `tar -xzf` and our own importer can read
 * the result.
 *
 * Everything streams. A data folder holds card attachments and can grow to
 * hundreds of megabytes; building the tar (and then the gzip) in memory would
 * duplicate the whole folder. The writer reads one file at a time; the
 * importer parses headers and writes each entry as it arrives.
 *
 * Importing accepts plain tar too, because that is what the cloud backup
 * stores — a downloaded snapshot can be imported without converting it.
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

import { buildTarHeader, parseTarHeader } from './tar.js'
import { canonicalPath, isInsidePath, isReallyInside, isTransient } from '../workspace.js'

/** The largest archive file the panel will accept. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024

/**
 * The largest amount of data one import may unpack.
 *
 * Separate from the archive size on purpose: a small .tar.gz can inflate to
 * gigabytes, and the data folder this plugin manages is a card library with
 * attachments, not a media collection.
 */
export const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024

/** The largest single entry an import may unpack. */
const MAX_EXTRACTED_ENTRY_BYTES = 64 * 1024 * 1024

/**
 * The largest entry count an import will process.
 *
 * @internal exported for tests
 */
export const MAX_IMPORT_ENTRIES = 20000

/** The only top-level folders an archive may write into. */
const IMPORT_ROOTS = ['knowledge/', 'sight/', 'preferences/']

/**
 * Walk the data folder without reading file contents.
 *
 * Symbolic links are skipped, not followed: the archive must be a snapshot of
 * this folder, not of wherever a link points.
 *
 * @param {string} root - The data folder.
 * @returns {Promise<Array<{path: string, absPath: string, size: number, mode: number, mtimeMs: number}>>} The entries.
 */
async function collectFileEntries(root) {
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
	const buffer = Buffer.allocUnsafe(64 * 1024)
	for (const entry of entries) {
		// Stat the handle we are about to read, and let that decide the header.
		// Between listing and opening, `cards.jsonl` may have been appended to
		// and `consolidation.json` renamed over. A header that disagrees with
		// the bytes that follow shifts every later block, so the archive is
		// corrupt while still being reported as written.
		const handle = await open(entry.absPath, 'r').catch(() => undefined)
		if (handle === undefined) continue
		let size
		let mode
		let mtime
		try {
			const info = await handle.stat()
			if (!info.isFile()) continue
			size = info.size
			mode = info.mode & 0o777
			mtime = Math.floor(info.mtimeMs / 1000)
		} catch {
			await handle.close().catch(() => {})
			continue
		}
		try {
			yield buildTarHeader({ path: entry.path, size, mode, mtime })
			let offset = 0
			while (offset < size) {
				const want = Math.min(buffer.length, size - offset)
				const { bytesRead } = await handle.read(buffer, 0, want, offset)
				// The file shrank while we read it. Sending the short read would
				// desynchronise the archive; failing the whole write is honest.
				if (bytesRead === 0) throw new Error(`备份时文件被截断：${entry.path}`)
				yield Buffer.from(buffer.subarray(0, bytesRead))
				offset += bytesRead
			}
			const remainder = size % 512
			if (remainder !== 0) yield Buffer.alloc(512 - remainder)
			stats.files += 1
			stats.bytes += size
		} finally {
			await handle.close().catch(() => {})
		}
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
 * Whether a folder resolves inside `base`, even when it does not exist yet.
 *
 * The nearest existing ancestor is the one that can be canonicalised; walking
 * up to it distinguishes `base/new/sub` (safe) from `base/link/sub`, where
 * `link` points outside.
 *
 * @param {string} base - The canonical data folder.
 * @param {string} folder - The folder an entry would be written into.
 * @returns {Promise<boolean>} True when the resolved parent stays inside.
 */
async function insideExistingAncestor(base, folder) {
	let probe = folder
	for (let depth = 0; depth < 32; depth += 1) {
		if ((await lstat(probe).catch(() => undefined)) !== undefined) return isReallyInside(base, probe)
		const parent = dirname(probe)
		if (parent === probe) return false
		probe = parent
	}
	return false
}

/**
 * Extract an archive file into a data folder.
 *
 * Only `knowledge/`, `sight/`, `preferences/` are accepted: an
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
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const input = createReadStream(source)
	const stream = gzipped ? input.pipe(createGunzip()) : input
	// `pipe` does not forward a source error to the destination: an EIO on the
	// archive would otherwise surface as an unhandled 'error' and take the
	// process down, with the reader still waiting.
	if (gzipped) input.once('error', (error) => stream.destroy(error))
	const reader = new ChunkReader(stream)
	let files = 0
	let bytes = 0
	let readBytes = 0
	let entries = 0
	let skipped = 0
	let sawEntry = false
	for (;;) {
		const header = await reader.take(512)
		if (header === null) break
		if (header.every((byte) => byte === 0)) break
		const parsed = parseTarHeader(header)
		sawEntry = true
		const padding = (512 - (parsed.size % 512)) % 512
		// Counted for *every* entry, written or skipped: an archive full of
		// entries outside the allowlist must still pay for the bytes it makes
		// the gunzip stream produce, or a tiny archive can keep the importer
		// decompressing for hours.
		entries += 1
		readBytes += parsed.size + padding
		if (entries > MAX_IMPORT_ENTRIES) throw new Error(`压缩包条目过多（上限 ${MAX_IMPORT_ENTRIES}）。`)
		if (readBytes > MAX_EXTRACTED_BYTES) throw new Error(`压缩包解压后超过 ${MAX_EXTRACTED_BYTES / 1024 / 1024} MB 上限。`)
		const regular = parsed.type === '0' || parsed.type === '\0'
		if (!regular || !isImportable(parsed.path)) {
			await reader.skip(parsed.size + padding)
			skipped += 1
			continue
		}
		if (parsed.size > MAX_EXTRACTED_ENTRY_BYTES) throw new Error(`压缩包里有超大条目：${parsed.path}`)
		// Validate before creating anything: with a symlinked `knowledge/`,
		// `mkdir` used to create the folder outside the data directory before
		// the check could refuse it. The base is the *real* data folder, so the
		// macOS `/var` → `/private/var` spelling difference does not reject a
		// folder that simply does not exist yet.
		const base = await canonicalPath(root)
		const target = join(base, ...parsed.path.split('/'))
		const folder = dirname(target)
		if (!isInsidePath(base, target) || !(await insideExistingAncestor(base, folder))) {
			throw new Error(`压缩包里的条目指向数据目录之外：${parsed.path}`)
		}
		await mkdir(folder, { recursive: true, mode: 0o700 })
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
		// An import that overwrites is the one operation that can replace the
		// files behind the system prompt. Keep what it replaced, so the change
		// can be undone without asking git or a backup.
		if (existing !== undefined && existing.isFile()) {
			await copyFile(target, `${target}.before-import-${stamp}`).catch(() => {})
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
