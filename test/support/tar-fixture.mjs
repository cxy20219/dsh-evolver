/**
 * Tar builders for tests only.
 *
 * Production code never builds or parses a whole archive in memory — the
 * exporter and importer stream (`src/backup/archive.js`). Tests do need a
 * cheap way to fabricate archives, including deliberately corrupt ones, so
 * these two helpers live next to the fixtures instead of in `tar.js`.
 *
 * `buildTarHeader` / `parseTarHeader` stay in `src/backup/tar.js` because
 * both the real exporter and the real importer use them.
 */

import { buildTarHeader, parseTarHeader } from '../../src/backup/tar.js'

const BLOCK = 512

/**
 * Whether a block is all zeroes.
 *
 * @param {Buffer} block - One 512-byte block.
 * @returns {boolean} True when the block ends the archive.
 */
function isZeroBlock(block) {
	for (const byte of block) if (byte !== 0) return false
	return true
}

/**
 * Build one tar archive.
 *
 * @param {Array<{path: string, content: Buffer | string, mode?: number}>} files - The entries.
 * @param {{now?: Date}} [options] - Clock, for the mtime field.
 * @returns {Buffer} The archive.
 */
export function createTar(files, { now = new Date() } = {}) {
	const chunks = []
	const mtime = Math.floor(now.getTime() / 1000)
	for (const file of files) {
		const content = Buffer.isBuffer(file.content)
			? file.content
			: Buffer.from(String(file.content ?? ''), 'utf8')
		const header = buildTarHeader({ path: file.path, size: content.length, mode: file.mode, mtime })
		chunks.push(header, content)
		const remainder = content.length % BLOCK
		if (remainder !== 0) chunks.push(Buffer.alloc(BLOCK - remainder))
	}
	chunks.push(Buffer.alloc(BLOCK * 2))
	return Buffer.concat(chunks)
}

/**
 * Read every regular file out of a tar archive.
 *
 * @param {Buffer} archive - The archive.
 * @returns {Array<{path: string, content: Buffer, mode?: number}>} The entries.
 */
export function readTar(archive) {
	const files = []
	let offset = 0
	while (offset + BLOCK <= archive.length) {
		const header = archive.subarray(offset, offset + BLOCK)
		if (isZeroBlock(header)) break
		let parsed
		try {
			parsed = parseTarHeader(header)
		} catch (error) {
			throw new Error(`${error instanceof Error ? error.message : String(error)}（偏移 ${offset}）`)
		}
		offset += BLOCK
		if (offset + parsed.size > archive.length) throw new Error('tar 内容被截断')
		if (parsed.type === '0' || parsed.type === '\0') {
			files.push({
				path: parsed.path,
				content: Buffer.from(archive.subarray(offset, offset + parsed.size)),
				mode: Number.isFinite(parsed.mode) ? parsed.mode : undefined,
			})
		}
		offset += Math.ceil(parsed.size / BLOCK) * BLOCK
	}
	return files
}
