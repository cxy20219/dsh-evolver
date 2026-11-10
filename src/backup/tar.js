/**
 * A tiny ustar reader/writer.
 *
 * A cloud backup needs one object per snapshot, not one per file, and the
 * plugin takes no dependencies. The format is deliberately plain ustar: any
 * `tar -xf` can read a backup, which matters more than compression here (the
 * data folder is text, and most of it compresses on the OSS side anyway).
 *
 * Only regular files are written; directory entries are skipped because the
 * data folder's directories are recreated by the plugin on restore.
 */

const BLOCK = 512
const NAME_LENGTH = 100
const PREFIX_LENGTH = 155
const MAX_ENTRY_BYTES = 512 * 1024 * 1024

/**
 * Format one octal field.
 *
 * @param {number} value - The value.
 * @param {number} length - The field width, including its terminator.
 * @returns {string} The field text.
 */
function octal(value, length) {
	const digits = Math.max(0, Math.floor(value)).toString(8)
	if (digits.length > length - 1) throw new Error(`tar 字段溢出：${value}`)
	return digits.padStart(length - 1, '0') + '\0'
}

/**
 * Write a string into a fixed-width field.
 *
 * @param {Buffer} buffer - The header.
 * @param {string} value - The text.
 * @param {number} offset - Where the field starts.
 * @param {number} length - The field width.
 * @returns {void}
 */
function writeField(buffer, value, offset, length) {
	const bytes = Buffer.from(value, 'utf8')
	if (bytes.length > length) throw new Error(`tar 字段太长：${value}`)
	bytes.copy(buffer, offset)
}

/**
 * Read a NUL-terminated field.
 *
 * @param {Buffer} buffer - The header.
 * @param {number} offset - Where the field starts.
 * @param {number} length - The field width.
 * @returns {string} The text.
 */
function readField(buffer, offset, length) {
	const slice = buffer.subarray(offset, offset + length)
	const end = slice.indexOf(0)
	return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8')
}

/**
 * Split a path into the ustar name and prefix fields.
 *
 * @param {string} path - A relative path using forward slashes.
 * @returns {{name: string, prefix: string}} The fields.
 */
function splitPath(path) {
	const clean = path.replace(/\\/g, '/').replace(/^\.\/+/, '')
	if (Buffer.byteLength(clean) <= NAME_LENGTH) return { name: clean, prefix: '' }
	const parts = clean.split('/')
	for (let index = 1; index < parts.length; index += 1) {
		const prefix = parts.slice(0, index).join('/')
		const name = parts.slice(index).join('/')
		if (Buffer.byteLength(prefix) <= PREFIX_LENGTH && Buffer.byteLength(name) <= NAME_LENGTH) {
			return { name, prefix }
		}
	}
	throw new Error(`tar 路径太长：${path}`)
}

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
		const { name, prefix } = splitPath(file.path)
		const header = Buffer.alloc(BLOCK)
		writeField(header, name, 0, NAME_LENGTH)
		writeField(header, octal(file.mode ?? 0o644, 8), 100, 8)
		writeField(header, octal(0, 8), 108, 8)
		writeField(header, octal(0, 8), 116, 8)
		writeField(header, octal(content.length, 12), 124, 12)
		writeField(header, octal(mtime, 12), 136, 12)
		// The checksum is computed with the field filled with spaces.
		header.fill(0x20, 148, 156)
		header[156] = 0x30 // '0': regular file
		writeField(header, 'ustar\0', 257, 6)
		writeField(header, '00', 263, 2)
		writeField(header, prefix, 345, PREFIX_LENGTH)
		let sum = 0
		for (const byte of header) sum += byte
		writeField(header, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
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
		const stored = Number.parseInt(readField(header, 148, 8).replace(/[^0-7]/g, ''), 8)
		let sum = 0
		for (let index = 0; index < BLOCK; index += 1) {
			sum += index >= 148 && index < 156 ? 0x20 : header[index]
		}
		if (!Number.isFinite(stored) || stored !== sum) {
			throw new Error(`tar 头校验失败（偏移 ${offset}）`)
		}
		const name = readField(header, 0, NAME_LENGTH)
		const prefix = readField(header, 345, PREFIX_LENGTH)
		const mode = Number.parseInt(readField(header, 100, 8).replace(/[^0-7]/g, ''), 8)
		const size = Number.parseInt(readField(header, 124, 12).replace(/[^0-7]/g, ''), 8)
		const type = String.fromCharCode(header[156])
		if (!Number.isFinite(size) || size < 0 || size > MAX_ENTRY_BYTES) {
			throw new Error('tar 条目大小不合法')
		}
		offset += BLOCK
		if (offset + size > archive.length) throw new Error('tar 内容被截断')
		if (type === '0' || type === '\0') {
			const path = prefix === '' ? name : `${prefix}/${name}`
			if (path.split('/').some((segment) => segment === '..' || segment === '')) {
				throw new Error(`tar 条目路径不安全：${path}`)
			}
			files.push({
				path,
				content: Buffer.from(archive.subarray(offset, offset + size)),
				mode: Number.isFinite(mode) ? mode : undefined,
			})
		}
		offset += Math.ceil(size / BLOCK) * BLOCK
	}
	return files
}
