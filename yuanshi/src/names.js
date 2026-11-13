/**
 * File names and content types.
 *
 * One entity is one file, so the name is both the display title and the on-disk
 * file name. It is sanitised to a single path segment before it ever reaches
 * the file system: a stored file must not be able to point outside its own
 * folder, and a name that is legal on Linux but breaks ustar (the backup
 * format) must be shortened here rather than in every exporter.
 *
 * The MIME type is derived from the extension first and from the bytes second.
 * A file with an unknown extension that decodes as UTF-8 is text; everything
 * else is binary. That is the only distinction the rest of the store needs:
 * text files are indexed and returned inline, binary files are addressed by
 * path and described by their metadata.
 */

import { basename } from 'node:path'

/** The longest name a store will accept, in UTF-8 bytes. */
export const MAX_NAME_BYTES = 88

/** Extensions longer than this are treated as unknown. */
const MAX_EXTENSION = 10

/** A MIME type for each extension the store knows. */
const MIME_BY_EXTENSION = {
	md: 'text/markdown',
	markdown: 'text/markdown',
	mdx: 'text/markdown',
	txt: 'text/plain',
	text: 'text/plain',
	log: 'text/plain',
	csv: 'text/csv',
	tsv: 'text/tab-separated-values',
	json: 'application/json',
	jsonl: 'application/x-ndjson',
	ndjson: 'application/x-ndjson',
	yaml: 'application/yaml',
	yml: 'application/yaml',
	toml: 'application/toml',
	ini: 'text/plain',
	xml: 'application/xml',
	html: 'text/html',
	htm: 'text/html',
	css: 'text/css',
	scss: 'text/x-scss',
	less: 'text/x-less',
	js: 'text/javascript',
	mjs: 'text/javascript',
	cjs: 'text/javascript',
	jsx: 'text/javascript',
	ts: 'application/typescript',
	tsx: 'application/typescript',
	py: 'text/x-python',
	rb: 'text/x-ruby',
	php: 'application/x-httpd-php',
	java: 'text/x-java',
	kt: 'text/x-kotlin',
	go: 'text/x-go',
	rs: 'text/x-rust',
	c: 'text/x-c',
	h: 'text/x-c',
	cc: 'text/x-c++',
	cpp: 'text/x-c++',
	hpp: 'text/x-c++',
	cs: 'text/x-csharp',
	swift: 'text/x-swift',
	sh: 'application/x-sh',
	bash: 'application/x-sh',
	zsh: 'application/x-sh',
	fish: 'application/x-sh',
	ps1: 'application/x-powershell',
	sql: 'application/sql',
	graphql: 'application/graphql',
	dockerfile: 'text/plain',
	makefile: 'text/plain',
	gitignore: 'text/plain',
	env: 'text/plain',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
	tif: 'image/tiff',
	tiff: 'image/tiff',
	avif: 'image/avif',
	pdf: 'application/pdf',
	zip: 'application/zip',
	gz: 'application/gzip',
	tgz: 'application/gzip',
	tar: 'application/x-tar',
	'7z': 'application/x-7z-compressed',
	rar: 'application/vnd.rar',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	flac: 'audio/flac',
	m4a: 'audio/mp4',
	mp4: 'video/mp4',
	mov: 'video/quicktime',
	webm: 'video/webm',
	avi: 'video/x-msvideo',
	doc: 'application/msword',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xls: 'application/vnd.ms-excel',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ppt: 'application/vnd.ms-powerpoint',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	epub: 'application/epub+zip',
	ttf: 'font/ttf',
	otf: 'font/otf',
	woff: 'font/woff',
	woff2: 'font/woff2',
}

/** MIME types that are text even though they do not start with `text/`. */
const TEXT_MIME_TYPES = new Set([
	'application/json',
	'application/x-ndjson',
	'application/yaml',
	'application/x-yaml',
	'application/toml',
	'application/xml',
	'application/xhtml+xml',
	'application/javascript',
	'application/typescript',
	'application/sql',
	'application/graphql',
	'application/x-sh',
	'application/x-powershell',
	'application/x-httpd-php',
	'image/svg+xml',
])

/**
 * Shorten a name to a byte budget, keeping a short extension.
 *
 * Truncating by characters is not enough: a Chinese name is three bytes per
 * character, so 120 characters can be 360 bytes. The extension is kept because
 * it decides the MIME type and the preview.
 *
 * @param {string} name - The sanitised name.
 * @param {number} budget - Maximum UTF-8 bytes.
 * @returns {string} A name that fits.
 */
function clipToBytes(name, budget) {
	const dot = name.lastIndexOf('.')
	const suffix = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : ''
	const stemBudget = budget - Buffer.byteLength(suffix)
	let stem = suffix === '' ? name : name.slice(0, dot)
	while (Buffer.byteLength(stem) > stemBudget) stem = stem.slice(0, -1)
	return stem === '' ? `file${suffix}` : stem + suffix
}

/**
 * Turn an arbitrary file name into one safe path segment.
 *
 * @param {unknown} value - The raw name.
 * @returns {string} A safe name, or an empty string when nothing is left.
 */
export function safeName(value) {
	const raw = String(value ?? '').replace(/\\/g, '/')
	let name = basename(raw)
		.normalize('NFC')
		.replace(/[^\p{L}\p{N}._-]+/gu, '-')
		.replace(/-+/g, '-')
		.replace(/^[-_]+|[-_]+$/g, '')
		.slice(0, 120)
	if (Buffer.byteLength(name) > MAX_NAME_BYTES) name = clipToBytes(name, MAX_NAME_BYTES)
	if (name === '' || name === '.' || name === '..') return ''
	// One path segment, starting with a letter or digit. A leading dot is not
	// allowed, so `.env` becomes `env` rather than a hidden file the panel
	// would not list.
	if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,119}$/u.test(name)) return ''
	return name
}

/**
 * The lower-case extension of a name, without the dot.
 *
 * @param {unknown} value - The name.
 * @returns {string} The extension, or an empty string.
 */
export function extensionOf(value) {
	const name = String(value ?? '')
	const dot = name.lastIndexOf('.')
	if (dot <= 0 || dot === name.length - 1) return ''
	const extension = name.slice(dot + 1).toLowerCase()
	return extension.length > MAX_EXTENSION ? '' : extension
}

/**
 * The MIME type implied by a name, if the extension is known.
 *
 * @param {unknown} name - The file name.
 * @returns {string} A MIME type, or an empty string.
 */
export function mimeOf(name) {
	return MIME_BY_EXTENSION[extensionOf(name)] ?? ''
}

/**
 * Whether a MIME type carries text the store can index and return inline.
 *
 * @param {unknown} mime - The MIME type.
 * @returns {boolean} True for text-like types.
 */
export function isTextMime(mime) {
	if (typeof mime !== 'string' || mime === '') return false
	if (mime.startsWith('text/')) return true
	return TEXT_MIME_TYPES.has(mime)
}

/**
 * Whether a buffer decodes as UTF-8 text.
 *
 * A NUL byte in the head is the cheap signal for binary. The fatal decoder is
 * the second signal: random bytes usually fail it, while a UTF-8 document with
 * an unknown extension passes.
 *
 * @param {Buffer} buffer - The bytes.
 * @returns {boolean} True when the buffer looks like text.
 */
export function isTextual(buffer) {
	if (!Buffer.isBuffer(buffer) || buffer.length === 0) return true
	if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return false
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(buffer)
		return true
	} catch {
		return false
	}
}

/**
 * The MIME type to store for one name and payload.
 *
 * @param {string} name - The safe file name.
 * @param {Buffer} buffer - The bytes.
 * @returns {string} The MIME type.
 */
export function contentTypeOf(name, buffer) {
	const known = mimeOf(name)
	if (known !== '') return known
	return isTextual(buffer) ? 'text/plain' : 'application/octet-stream'
}

/** Extensions whose files are meant to be run, not just read. */
const EXECUTABLE_EXTENSIONS = new Set([
	'sh', 'bash', 'zsh', 'fish', 'py', 'js', 'mjs', 'cjs', 'ts', 'rb', 'pl', 'php', 'lua', 'ps1',
])

/**
 * Whether a name looks like a script that can be executed directly.
 *
 * This is a name-level hint, not a promise: a `.py` file without a shebang
 * still needs `python3`. The store uses it to set the executable bit, and
 * `file_read` reports the real mode so the caller can check before running.
 *
 * @param {unknown} name - The file name.
 * @returns {boolean} True for a script extension.
 */
export function isScriptName(name) {
	return EXECUTABLE_EXTENSIONS.has(extensionOf(name))
}

/**
 * Whether a payload starts with a shebang.
 *
 * @param {Buffer} buffer - The bytes.
 * @returns {boolean} True when the first two bytes are `#!`.
 */
export function hasShebang(buffer) {
	return Buffer.isBuffer(buffer) && buffer.length >= 2 && buffer[0] === 0x23 && buffer[1] === 0x21
}

/**
 * Whether one payload should carry the executable bit.
 *
 * A script extension or a shebang is enough. Native binaries are intentionally
 * not covered: importing an unknown executable and making it runnable on a
 * click is the failure mode the old audit called out, so only script-shaped
 * files are marked.
 *
 * @param {string} name - The file name.
 * @param {Buffer} buffer - The bytes.
 * @returns {boolean} True when the file is script-like.
 */
export function isExecutablePayload(name, buffer) {
	return isScriptName(name) || hasShebang(buffer)
}
