/**
 * The browser-facing API of 元始.
 *
 * One authenticated prefix (`/api/yuanshi`) owns every endpoint the panel
 * calls. The handler takes plain JSON and returns plain JSON; the route layer
 * in `index.js` turns a thrown error into `{error:{...}}` with HTTP 400.
 *
 * The panel never sends a file path: ids resolve through the store, and the
 * store derives the path from the id and the sanitised name. Previews are
 * capped, and uploads are decoded and size-checked here.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { indexText } from './injection.js'
import { isTextMime } from './names.js'

/** The endpoints the panel may call. */
export const ENDPOINTS = [
	'overview',
	'file-list',
	'file-read',
	'file-write',
	'file-upload',
	'file-preview',
	'file-archive',
	'file-remove',
	'graph',
	'settings',
	'settings-save',
	'logs',
]

/** A preview larger than this is not sent as base64. */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024

/** One uploaded file may not exceed this many decoded bytes. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** How much text one preview returns. */
const MAX_PREVIEW_TEXT = 200 * 1024

/**
 * Read one string field.
 *
 * @param {object} payload - The request payload.
 * @param {string} field - The field name.
 * @param {string} [fallback] - Used when the field is absent.
 * @returns {string} The field value.
 */
function text(payload, field, fallback = '') {
	const value = payload?.[field]
	return typeof value === 'string' ? value : fallback
}

/**
 * Read one array field, accepting a comma-separated string too.
 *
 * @param {object} payload - The request payload.
 * @param {string} field - The field name.
 * @returns {string[] | undefined} The array, or undefined when absent.
 */
function list(payload, field) {
	const value = payload?.[field]
	if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
	if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter((item) => item !== '')
	return undefined
}

/**
 * Resolve a full id or a unique suffix.
 *
 * @param {object} store - The file store.
 * @param {unknown} value - The id or suffix.
 * @returns {string} The full id, or the raw string when it is already full.
 */
function resolveId(store, value) {
	const raw = String(value ?? '').trim()
	if (raw === '') return ''
	const resolved = store.resolveId(raw)
	return resolved ?? raw
}

/**
 * A file without its body text, for list/write responses.
 *
 * @param {object} file - A file as `read()` returns it.
 * @returns {object} The summary.
 */
function summary(file) {
	if (file === null || typeof file !== 'object') return file
	const { text: _text, ...rest } = file
	void _text
	return rest
}

/**
 * Read the tail of the plugin log.
 *
 * @param {string} root - The data root.
 * @param {number} [limit] - Maximum lines.
 * @returns {Promise<{path: string, lines: string[]}>} The tail.
 */
async function logTail(root, limit = 300) {
	const path = join(root, 'system', 'logs', 'plugin.log')
	const content = await readFile(path, 'utf8').catch(() => '')
	const lines = content.split('\n').filter((line) => line !== '')
	return { path, lines: lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 300))) }
}

/**
 * Create the endpoint handler.
 *
 * @param {{store: object, settings: object, logs: object, root: string, version?: string}} deps - The open store and its satellites.
 * @returns {(endpoint: string, payload: object) => Promise<any>} The handler.
 */
export function createYuanshiHandler({ store, settings, logs, root, version = '' }) {
	return async function handleYuanshi(endpoint, payload = {}) {
		switch (endpoint) {
			case 'overview': {
				const recent = await store.list({ limit: 8 })
				return {
					version,
					stats: store.stats(),
					tags: store.tagCounts(20),
					recent: recent.files,
					injection: await indexText(store, settings.get().injectionBudget),
					settings: settings.publicView(),
				}
			}
			case 'file-list': {
				return store.list({
					query: text(payload, 'query'),
					tags: list(payload, 'tags'),
					tag: text(payload, 'tag'),
					mime: text(payload, 'mime'),
					archived: payload?.archived === true,
					limit: Math.min(200, Math.max(1, Math.round(Number(payload?.limit) || 50))),
					offset: Math.max(0, Math.round(Number(payload?.offset) || 0)),
				})
			}
			case 'file-read': {
				const id = resolveId(store, payload?.id)
				if (id === '') return { found: false, id: '' }
				const file = await store.read(id, { text: true, neighbors: true })
				return file === undefined ? { found: false, id } : file
			}
			case 'file-write': {
				const id = resolveId(store, payload?.id)
				if (id !== '') {
					const patch = {}
					for (const field of ['name', 'description', 'content']) {
						if (payload?.[field] !== undefined) patch[field] = text(payload, field)
					}
					if (payload?.tags !== undefined) patch.tags = list(payload, 'tags') ?? []
					if (payload?.links !== undefined) patch.links = list(payload, 'links') ?? []
					return summary(await store.update(id, patch))
				}
				return summary(await store.create({
					name: text(payload, 'name'),
					description: text(payload, 'description'),
					tags: list(payload, 'tags') ?? [],
					links: list(payload, 'links') ?? [],
					content: text(payload, 'content'),
				}))
			}
			case 'file-upload': {
				const raw = text(payload, 'data')
				const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
				if (base64 === '') throw new Error('上传内容为空。')
				const bytes = Buffer.from(base64, 'base64')
				if (bytes.length === 0) throw new Error('上传内容无法解码。')
				if (bytes.length > MAX_UPLOAD_BYTES) {
					throw new Error(`上传文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB 上限。`)
				}
				return summary(await store.create({
					name: text(payload, 'name'),
					description: text(payload, 'description'),
					tags: list(payload, 'tags') ?? [],
					links: list(payload, 'links') ?? [],
					content: bytes,
				}))
			}
			case 'file-preview': {
				const id = resolveId(store, payload?.id)
				if (id === '') throw new Error('文件不存在。')
				const file = await store.read(id, { text: false, neighbors: false })
				if (file === undefined) throw new Error('文件不存在。')
				if (isTextMime(file.mime)) {
					const full = await store.read(id, { text: true, neighbors: false })
					const value = String(full?.text ?? '')
					return {
						kind: 'text',
						text: value.slice(0, MAX_PREVIEW_TEXT),
						truncated: value.length > MAX_PREVIEW_TEXT || full?.truncated === true,
					}
				}
				const bytes = await readFile(file.path).catch(() => undefined)
				if (bytes === undefined) throw new Error('文件本体缺失。')
				if (bytes.length > MAX_PREVIEW_BYTES) return { kind: 'binary', bytes: bytes.length }
				if (file.mime.startsWith('image/')) {
					return { kind: 'image', mime: file.mime, base64: bytes.toString('base64') }
				}
				if (file.mime === 'application/pdf') {
					return { kind: 'pdf', mime: file.mime, base64: bytes.toString('base64') }
				}
				return { kind: 'binary', bytes: bytes.length }
			}
			case 'file-archive': {
				const id = resolveId(store, payload?.id)
				if (id === '') throw new Error('文件不存在。')
				return summary(await store.archive(id, payload?.archived !== false))
			}
			case 'file-remove': {
				const id = resolveId(store, payload?.id)
				if (id === '') throw new Error('文件不存在。')
				return store.remove(id)
			}
			case 'graph': {
				const listed = await store.list({ limit: 500 })
				const graph = store.graph(listed.files.map((file) => file.id), { hops: 1, limit: 500 })
				const stats = store.stats()
				return {
					...graph,
					totals: {
						files: stats.files,
						links: stats.links,
						shown: graph.nodes.length,
						hidden: Math.max(0, stats.files - listed.files.length),
					},
				}
			}
			case 'settings': {
				return settings.publicView()
			}
			case 'settings-save': {
				const patch = {}
				for (const field of ['descriptionMaxChars', 'maxFileBytes', 'readTextBytes', 'injectionBudget']) {
					if (payload?.[field] !== undefined) patch[field] = Number(payload[field])
				}
				const saved = await settings.save(patch)
				store.setLimits({
					maxBytes: saved.maxFileBytes,
					readTextBytes: saved.readTextBytes,
					descriptionMaxChars: saved.descriptionMaxChars,
				})
				return settings.publicView()
			}
			case 'logs': {
				const tail = await logTail(root, payload?.limit)
				return { ...tail, status: { dataDir: root, settings: settings.publicView() } }
			}
			default:
				throw new Error(`未知接口：${String(endpoint)}`)
		}
	}
}
