/**
 * File metadata: validation, normalisation and the sidecar format.
 *
 * A file entity is `{ id, name, description, tags, links, source, created,
 * updated, mime, bytes, sha256, archived }`. The sidecar (`meta.json`) is the
 * source of truth; the database is a rebuildable index over it. That choice is
 * why this module is strict: a malformed sidecar is a broken entity, and it
 * must fail loudly enough for the rebuild report to name it rather than
 * silently become a file with no description.
 */

import { fileCreatedAt, fileId, isFileId } from './ids.js'
import { safeName } from './names.js'

/** The sidecar schema version. */
export const META_SCHEMA = 1

/** The sidecar file name inside one entity folder. */
export const META_FILE = 'meta.json'

/** The longest a description may be. */
export const MAX_DESCRIPTION_CHARS = 200

/** The default description cap (the injected index clips it further). */
export const DEFAULT_DESCRIPTION_CHARS = 160

/** A description shorter than this says nothing. */
export const MIN_DESCRIPTION_CHARS = 4

/** The most tags one file may carry. */
export const MAX_TAGS = 32

/** The longest one tag may be. */
export const MAX_TAG_CHARS = 64

/** The most links one file may carry. */
export const MAX_LINKS = 500

/** The longest verbatim quote a file may carry. */
export const MAX_SOURCE_QUOTE_CHARS = 160

/**
 * Descriptions that name a slot instead of filling it.
 *
 * A file's description is the only thing the injected index and the search
 * result show next to its id; a placeholder turns the index back into a list
 * of opaque ids, so it is rejected rather than stored.
 */
const PLACEHOLDER_DESCRIPTION = /^(描述|说明|摘要|简述|简介|占位|占位符|待补|待定|待写|补充|暂无|没有|无|略|同上|待|todo|tbd|n\/a|na|none|null|undefined|na\.|示例|样例|测试|test)[\s。.!?，,、~～-]*$/i

/** Control characters that would break a one-line field. */
const CONTROL = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g

/** The same set, without the global flag, for `.test()`. */
const CONTROL_TEST = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/

/**
 * Normalise a one-line description.
 *
 * @param {unknown} value - The proposed description.
 * @returns {string} The clean description, `''` when unusable.
 */
export function normalizeDescription(value) {
	return String(value ?? '')
		.replace(CONTROL, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Cut a sentence down to a description, on a boundary and with an ellipsis.
 *
 * Used when a description is derived from existing text (a migration, a
 * generated note). Cutting mid-word is what makes an index read as broken
 * text, so the cut prefers punctuation in the back half.
 *
 * @param {unknown} value - The text.
 * @param {number} [maxChars] - The cap.
 * @returns {string} A description no longer than the cap.
 */
export function clipDescription(value, maxChars = DEFAULT_DESCRIPTION_CHARS) {
	const clean = normalizeDescription(value)
	const limit = Math.max(MIN_DESCRIPTION_CHARS, Math.min(MAX_DESCRIPTION_CHARS, Math.round(Number(maxChars) || DEFAULT_DESCRIPTION_CHARS)))
	const chars = [...clean]
	if (chars.length <= limit) return clean
	const head = chars.slice(0, limit - 1)
	const breakAt = /[，。；：、！？,;]/
	for (let index = head.length - 1; index >= Math.floor(limit * 0.4); index -= 1) {
		if (breakAt.test(head[index])) return head.slice(0, index + 1).join('') + '…'
	}
	return head.join('') + '…'
}

/**
 * Validate the description a caller is writing.
 *
 * @param {unknown} value - The raw description.
 * @param {number} [maxChars] - The cap.
 * @returns {string} The normalised description.
 */
export function assertDescription(value, maxChars = DEFAULT_DESCRIPTION_CHARS) {
	const clean = normalizeDescription(value)
	if (clean === '') {
		throw new Error('文件必须写 description：一句话说清这个文件是什么、回答什么问题。')
	}
	if (PLACEHOLDER_DESCRIPTION.test(clean)) {
		throw new Error('描述不能是占位词（「暂无」「TODO」之类）：索引里显示的就是这段文本。')
	}
	if ([...clean].length < MIN_DESCRIPTION_CHARS) {
		throw new Error(`描述至少 ${MIN_DESCRIPTION_CHARS} 字：一句话说清这个文件是什么。`)
	}
	const limit = Math.max(MIN_DESCRIPTION_CHARS, Math.min(MAX_DESCRIPTION_CHARS, Math.round(Number(maxChars) || DEFAULT_DESCRIPTION_CHARS)))
	if ([...clean].length > limit) {
		throw new Error(`描述最多 ${limit} 字：它是一句话索引，不是摘要。`)
	}
	return clean
}

/**
 * Normalise one free-form tag.
 *
 * Tags are optional in the file model: links are the primary structure, and a
 * tag is only a filter. They are therefore not forced into the old six-branch
 * taxonomy. A leading `#` is accepted because that is how people write tags.
 *
 * @param {unknown} value - The raw tag.
 * @returns {string} The clean tag, or an empty string.
 */
export function normalizeTag(value) {
	let tag = String(value ?? '')
		.replace(CONTROL, ' ')
		.replace(/^#+/, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[-/]+|[-/]+$/g, '')
		.trim()
	if (tag === '') return ''
	if ([...tag].length > MAX_TAG_CHARS) tag = [...tag].slice(0, MAX_TAG_CHARS).join('')
	return tag
}

/**
 * Normalise a tag list.
 *
 * @param {unknown} value - The raw list.
 * @param {number} [limit] - The maximum tags to keep.
 * @returns {string[]} Unique tags, in caller order.
 */
export function normalizeTags(value, limit = MAX_TAGS) {
	const list = Array.isArray(value) ? value : []
	const out = []
	const seen = new Set()
	for (const item of list) {
		const tag = normalizeTag(item)
		if (tag === '' || seen.has(tag)) continue
		seen.add(tag)
		out.push(tag)
		if (out.length >= limit) break
	}
	return out
}

/**
 * Normalise a link list without resolving it.
 *
 * The values may be full ids or unique suffixes; resolution needs the library,
 * so it happens in the store. This function only guarantees the shape: strings,
 * deduplicated, bounded.
 *
 * @param {unknown} value - The raw list.
 * @param {number} [limit] - The maximum links to keep.
 * @returns {string[]} The link candidates, in caller order.
 */
export function normalizeLinks(value, limit = MAX_LINKS) {
	const list = Array.isArray(value) ? value : []
	const out = []
	const seen = new Set()
	for (const item of list) {
		const link = String(item ?? '').trim()
		if (link === '' || link.length > 64 || CONTROL_TEST.test(link)) continue
		if (seen.has(link)) continue
		seen.add(link)
		out.push(link)
		if (out.length >= limit) break
	}
	return out
}

/**
 * Normalise a provenance record.
 *
 * @param {unknown} value - The raw source.
 * @returns {{quote: string, session?: string} | undefined} The stored source.
 */
export function normalizeSource(value) {
	if (value === null || typeof value !== 'object') return undefined
	const quote = normalizeDescription(value.quote).slice(0, MAX_SOURCE_QUOTE_CHARS)
	const session = typeof value.session === 'string' ? value.session.trim().slice(0, 120) : ''
	if (quote === '' && session === '') return undefined
	return session === '' ? { quote } : { quote, session }
}

/**
 * Build a validated metadata record for a new or updated file.
 *
 * @param {object} input - The fields.
 * @returns {object} The normalised metadata.
 */
export function buildMeta(input) {
	const id = input?.id
	if (!isFileId(id)) throw new Error('文件 id 不合法。')
	const name = safeName(input.name)
	if (name === '') throw new Error('文件名不合法。')
	const description = assertDescription(input.description)
	const mime = String(input.mime ?? '').trim()
	if (mime === '') throw new Error('文件缺少 MIME 类型。')
	const bytes = Number(input.bytes)
	if (!Number.isFinite(bytes) || bytes < 0) throw new Error('文件大小不合法。')
	const sha256 = String(input.sha256 ?? '').toLowerCase()
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('文件摘要不合法。')
	const created = typeof input.created === 'string' && input.created !== '' ? input.created : fileCreatedAt(id)
	const updated = typeof input.updated === 'string' && input.updated !== '' ? input.updated : created
	if (!Number.isFinite(Date.parse(created)) || !Number.isFinite(Date.parse(updated))) {
		throw new Error('文件时间戳不合法。')
	}
	const legacyId = typeof input.legacyId === 'string' && input.legacyId !== '' ? input.legacyId : undefined
	const source = normalizeSource(input.source)
	return {
		schema: META_SCHEMA,
		id,
		name,
		description,
		tags: normalizeTags(input.tags),
		links: normalizeLinks(input.links),
		...(source === undefined ? {} : { source }),
		created,
		updated,
		mime,
		bytes,
		sha256,
		archived: input.archived === true,
		...(legacyId === undefined ? {} : { legacyId }),
	}
}

/**
 * Parse and validate a sidecar record.
 *
 * A sidecar is written by this store, but it is also the thing a user may edit
 * by hand and the thing a restore may bring back from an older version. Every
 * field is therefore re-checked; the error names the field so a rebuild report
 * can say which file is broken.
 *
 * @param {unknown} raw - The parsed JSON.
 * @returns {object} The normalised metadata.
 */
export function normalizeMeta(raw) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('meta.json 不是一个对象。')
	}
	if (raw.schema !== undefined && raw.schema !== META_SCHEMA) {
		throw new Error(`meta.json schema 版本不支持：${String(raw.schema)}`)
	}
	const meta = buildMeta({
		id: raw.id,
		name: raw.name,
		description: raw.description,
		tags: raw.tags,
		links: raw.links,
		source: raw.source,
		created: raw.created,
		updated: raw.updated,
		mime: raw.mime,
		bytes: raw.bytes,
		sha256: raw.sha256,
		archived: raw.archived,
		legacyId: raw.legacyId,
	})
	// `buildMeta` recalculates nothing about the bytes; a sidecar that claims a
	// different size than the file on disk is caught by the store's rebuild,
	// which stats the file. Keeping this check out of validation lets a file be
	// read while its payload is temporarily unavailable.
	return meta
}

/**
 * Serialise one sidecar with a trailing newline, so a diff is clean.
 *
 * @param {object} meta - The metadata.
 * @returns {string} The file content.
 */
export function serializeMeta(meta) {
	return `${JSON.stringify(meta, null, '\t')}\n`
}

/**
 * Create a fresh id for a file being written now.
 *
 * @param {number} [now] - Millisecond timestamp.
 * @returns {string} The id.
 */
export function newFileId(now = Date.now()) {
	return fileId(now)
}
