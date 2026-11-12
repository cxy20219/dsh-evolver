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
 * Build one ustar header for a regular file.
 *
 * @param {{path: string, size: number, mode?: number, mtime?: number}} file - The entry.
 * @returns {Buffer} The 512-byte header.
 */
export function buildTarHeader({ path, size, mode = 0o644, mtime = Math.floor(Date.now() / 1000) }) {
	if (!Number.isFinite(size) || size < 0) throw new Error('tar 条目大小不合法')
	const { name, prefix } = splitPath(path)
	const header = Buffer.alloc(BLOCK)
	writeField(header, name, 0, NAME_LENGTH)
	writeField(header, octal(mode, 8), 100, 8)
	writeField(header, octal(0, 8), 108, 8)
	writeField(header, octal(0, 8), 116, 8)
	writeField(header, octal(size, 12), 124, 12)
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
	return header
}

/**
 * Validate one ustar header and extract its fields.
 *
 * @param {Buffer} header - One 512-byte block.
 * @returns {{path: string, size: number, mode: number, type: string}} The parsed entry.
 */
export function parseTarHeader(header) {
	const stored = Number.parseInt(readField(header, 148, 8).replace(/[^0-7]/g, ''), 8)
	let sum = 0
	for (let index = 0; index < BLOCK; index += 1) {
		sum += index >= 148 && index < 156 ? 0x20 : header[index]
	}
	if (!Number.isFinite(stored) || stored !== sum) {
		throw new Error('tar 头校验失败')
	}
	const name = readField(header, 0, NAME_LENGTH)
	const prefix = readField(header, 345, PREFIX_LENGTH)
	const mode = Number.parseInt(readField(header, 100, 8).replace(/[^0-7]/g, ''), 8)
	const size = Number.parseInt(readField(header, 124, 12).replace(/[^0-7]/g, ''), 8)
	const type = String.fromCharCode(header[156])
	if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
		// A pax/GNU extension carries the real path of the next entry.
		// Ignoring it would import files under truncated names, so refuse.
		throw new Error('tar 使用了 GNU/pax 扩展头，无法安全解析；请用 ustar 格式（本插件的导出即为 ustar）。')
	}
	if (!Number.isFinite(size) || size < 0 || size > MAX_ENTRY_BYTES) {
		throw new Error('tar 条目大小不合法')
	}
	const path = prefix === '' ? name : `${prefix}/${name}`
	if (path.split('/').some((segment) => segment === '..' || segment === '')) {
		throw new Error(`tar 条目路径不安全：${path}`)
	}
	return { path, size, mode, type }
}
