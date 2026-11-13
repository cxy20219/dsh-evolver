/**
 * The injected file index and its daily snapshot.
 *
 * The runtime context must not change on every write: a card write used to
 * invalidate the whole prompt prefix. The index is therefore read from
 * `<dataDir>/index.json`, which is built when the plugin opens and, at most,
 * once per day. A write changes the library, not the injected text, until the
 * next snapshot.
 *
 * The snapshot is a *semantic* index only: short id, description, tags, type
 * and degree. It never contains a payload. The model decides what to read.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic } from './atomic.js'

/** The snapshot schema version. */
export const INDEX_VERSION = 1

/** How many files are named in the injected index. */
export const TOP_COUNT = 12

/** How many of them are chosen by link degree rather than recency. */
const HUB_COUNT = 10

/**
 * The local day, as `YYYY-MM-DD`.
 *
 * Local time, not UTC: the snapshot is a daily artifact for the user's day.
 *
 * @param {Date} [date] - The moment.
 * @returns {string} The day key.
 */
export function dayKey(date = new Date()) {
	const year = date.getFullYear()
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${year}-${month}-${day}`
}

/**
 * A short label for one MIME type.
 *
 * @param {unknown} mime - The MIME type.
 * @returns {string} The label.
 */
function typeLabel(mime) {
	const value = String(mime ?? '')
	if (value === 'text/markdown') return 'md'
	if (value === 'text/plain') return 'txt'
	if (value === 'application/json') return 'json'
	if (value === 'application/pdf') return 'pdf'
	if (value.includes('wordprocessingml')) return 'docx'
	if (value.includes('spreadsheetml')) return 'xlsx'
	if (value.includes('presentationml')) return 'pptx'
	if (value.startsWith('image/')) return 'img'
	if (value.startsWith('audio/')) return 'audio'
	if (value.startsWith('video/')) return 'video'
	if (value.startsWith('text/')) return value.slice(5).slice(0, 8)
	if (value.startsWith('application/')) return value.slice(12).split('+')[0].slice(0, 8)
	return value.slice(0, 8)
}

/**
 * The degree of one file, tolerating a missing object.
 *
 * @param {object} file - A listed file.
 * @returns {number} The degree.
 */
function degreeOf(file) {
	return Number(file?.degree?.in ?? 0) + Number(file?.degree?.out ?? 0)
}

/**
 * Build a snapshot from the current library.
 *
 * `store.list({limit: 500})` is enough for the index because the index keeps
 * only twelve files; the cap is a guard for a library much larger than this
 * one. If the library ever grows past 500, replace this with a SQL top-by-
 * degree query rather than raising the cap.
 *
 * @param {object} store - The file store.
 * @returns {Promise<object>} The snapshot.
 */
export async function snapshotOf(store) {
	const listed = await store.list({ limit: 500 })
	const stats = store.stats()
	const files = listed.files ?? []
	const byDegree = [...files].sort((left, right) => degreeOf(right) - degreeOf(left)
		|| String(right.updated).localeCompare(String(left.updated))
		|| String(left.id).localeCompare(String(right.id)))
	const hubs = byDegree.slice(0, HUB_COUNT)
	const hubIds = new Set(hubs.map((file) => file.id))
	const recent = byDegree
		.filter((file) => !hubIds.has(file.id))
		.sort((left, right) => String(right.updated).localeCompare(String(left.updated))
			|| String(left.id).localeCompare(String(right.id)))
		.slice(0, TOP_COUNT - hubs.length)
	const chosen = [...hubs, ...recent]
	const types = (stats.mimes ?? []).slice(0, 6).map((row) => ({ label: typeLabel(row.mime), count: row.count }))
	return {
		version: INDEX_VERSION,
		day: dayKey(),
		top: chosen.map((file) => ({
			id: file.id,
			short: file.short ?? file.id,
			description: file.description ?? '',
			tags: file.tags ?? [],
			mime: file.mime ?? '',
			degree: file.degree ?? { in: 0, out: 0 },
		})),
		summary: {
			files: stats.files,
			archived: stats.archived,
			links: stats.links,
			orphans: stats.orphans,
			types,
		},
	}
}

/**
 * The snapshot path for one store.
 *
 * @param {object} store - The file store.
 * @returns {string} The absolute path.
 */
function indexPath(store) {
	return join(store.dataDir, 'index.json')
}

/**
 * Read the snapshot, if it is well formed.
 *
 * @param {object} store - The file store.
 * @returns {Promise<object | undefined>} The snapshot.
 */
export async function readIndex(store) {
	const text = await readFile(indexPath(store), 'utf8').catch(() => undefined)
	if (text === undefined) return undefined
	try {
		const parsed = JSON.parse(text)
		if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.top) || typeof parsed.day !== 'string') {
			return undefined
		}
		return parsed
	} catch {
		return undefined
	}
}

/**
 * Rebuild and write the snapshot.
 *
 * The content is compared before writing: the daily job must not touch the
 * file when nothing changed, or the injected text would change for no reason.
 * The snapshot deliberately has no build timestamp — every rebuild of the
 * same library produces identical bytes, so "wrote" is meaningful and the
 * prompt prefix stays stable.
 *
 * @param {object} store - The file store.
 * @returns {Promise<{snapshot: object, path: string, wrote: boolean}>} The result.
 */
export async function refreshIndex(store) {
	const snapshot = await snapshotOf(store)
	const text = `${JSON.stringify(snapshot, null, '\t')}\n`
	const path = indexPath(store)
	const current = await readFile(path, 'utf8').catch(() => undefined)
	if (current === text) return { snapshot, path, wrote: false }
	await writeFileAtomic(path, text)
	return { snapshot, path, wrote: true }
}

/**
 * The snapshot for today, rebuilding it when it is missing or from yesterday.
 *
 * @param {object} store - The file store.
 * @returns {Promise<object>} The snapshot.
 */
export async function ensureIndex(store) {
	const existing = await readIndex(store)
	if (existing !== undefined && existing.day === dayKey()) return existing
	return (await refreshIndex(store)).snapshot
}

/**
 * One line for the library's shape.
 *
 * @param {object} summary - The snapshot summary.
 * @returns {string} The line.
 */
function summaryLine(summary) {
	const types = (summary?.types ?? []).map((row) => `${row.label} ${row.count}`).join(' · ')
	const base = `共 ${summary?.files ?? 0} 个文件${types === '' ? '' : `（${types}）`}，${summary?.links ?? 0} 条链接`
	const archived = Number(summary?.archived ?? 0)
	return archived > 0 ? `${base}；归档 ${archived} 个。` : `${base}。`
}

/**
 * Cut text to a byte budget without splitting a character.
 *
 * @param {string} text - The text.
 * @param {number} budget - The byte budget.
 * @returns {string} The text.
 */
function clipToBytes(text, budget) {
	if (Buffer.byteLength(text, 'utf8') <= budget) return text
	let out = ''
	let used = 0
	for (const char of text) {
		const size = Buffer.byteLength(char, 'utf8')
		if (used + size > budget) break
		out += char
		used += size
	}
	return out
}

/**
 * Render the runtime context.
 *
 * Degradation is by detail, never by structure: descriptions go first, then
 * rows, while the summary line stays as long as anything fits.
 *
 * @param {object} store - The file store.
 * @param {number} [budget] - The byte budget.
 * @returns {Promise<string>} The injected text.
 */
export async function indexText(store, budget = 4096) {
	let snapshot
	try {
		snapshot = await ensureIndex(store)
	} catch {
		// A read-only data folder must not turn every request into an error.
		snapshot = await snapshotOf(store)
	}
	const top = Array.isArray(snapshot.top) ? snapshot.top : []
	if (top.length === 0) {
		return '[文件] 库是空的：用 file_write 写第一个文件（description + 至少一个标签）。'
	}
	const summary = summaryLine(snapshot.summary)
	const withDescription = top.map((file) => `- ${file.short}｜${file.description}`)
	const bare = top.map((file) => `- ${file.short}`)
	const fits = (rows) => Buffer.byteLength(`${rows.join('\n')}\n${summary}`, 'utf8') <= budget
	let rows = withDescription
	if (!fits(rows)) rows = bare
	while (rows.length > 1 && !fits(rows)) rows = rows.slice(0, -1)
	const text = `${rows.join('\n')}\n${summary}`
	return Buffer.byteLength(text, 'utf8') <= budget ? text : clipToBytes(text, budget)
}
