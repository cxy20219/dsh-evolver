/**
 * The file endpoints: the library's read/write surface for the panel.
 *
 * The panel never sends a file path: ids resolve through the store, and the
 * store derives the path from the id and the sanitised name. Previews are
 * capped, and uploads are decoded and size-checked here.
 */

import { lstat, readFile } from 'node:fs/promises'

import { isTextMime } from '../names.js'
import { list, resolveId, summary, text } from './support.js'

/** A preview larger than this is not sent as base64. */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024

/** One uploaded file may not exceed this many decoded bytes. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** How much text one preview returns. */
const MAX_PREVIEW_TEXT = 200 * 1024

/** The endpoints this module owns. */
export const filesHandlers = {
	'file-list': async (payload, { store }) => store.list({
		query: text(payload, 'query'),
		tags: list(payload, 'tags'),
		// The type matrix sends an extension; '' asks for names with
		// none, and an absent field means "no suffix filter".
		suffix: typeof payload?.suffix === 'string' ? payload.suffix : null,
		archived: payload?.archived === true,
		limit: Math.min(200, Math.max(1, Math.round(Number(payload?.limit) || 50))),
		offset: Math.max(0, Math.round(Number(payload?.offset) || 0)),
	}),

	'file-read': async (payload, { store }) => {
		const id = resolveId(store, payload?.id)
		if (id === '') return { found: false, id: '' }
		const file = await store.read(id, { text: true, neighbors: true })
		return file === undefined ? { found: false, id } : file
	},

	'file-write': async (payload, { store }) => {
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
	},

	'file-upload': async (payload, { store }) => {
		const raw = text(payload, 'data')
		const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
		if (base64 === '') throw new Error('上传内容为空。')
		// Estimate the decoded size before decoding: a base64 string is
		// the largest thing the request can carry, and decoding first
		// spends that memory a second time before the limit can refuse it.
		if (Math.floor((base64.length * 3) / 4) > MAX_UPLOAD_BYTES + 2) {
			throw new Error(`上传文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB 上限。`)
		}
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
	},

	'file-preview': async (payload, { store }) => {
		const id = resolveId(store, payload?.id)
		if (id === '') throw new Error('文件不存在。')
		const file = await store.read(id, { text: false, neighbors: false })
		if (file === undefined) throw new Error('文件不存在。')
		if (file.missing === true) throw new Error('文件本体缺失。')
		if (isTextMime(file.mime)) {
			const full = await store.read(id, { text: true, neighbors: false })
			const value = String(full?.text ?? '')
			return {
				kind: 'text',
				text: value.slice(0, MAX_PREVIEW_TEXT),
				truncated: value.length > MAX_PREVIEW_TEXT || full?.truncated === true,
			}
		}
		// The payload is known to be a binary by its metadata; stat it
		// before reading, so an oversized image is refused by number
		// rather than loaded into memory only to be measured.
		const info = await lstat(file.path).catch(() => undefined)
		if (info === undefined || !info.isFile()) throw new Error('文件本体缺失。')
		if (info.size > MAX_PREVIEW_BYTES) return { kind: 'binary', bytes: info.size }
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
	},

	'file-archive': async (payload, { store }) => {
		const id = resolveId(store, payload?.id)
		if (id === '') throw new Error('文件不存在。')
		return summary(await store.archive(id, payload?.archived !== false))
	},

	'file-remove': async (payload, { store }) => {
		const id = resolveId(store, payload?.id)
		if (id === '') throw new Error('文件不存在。')
		return store.remove(id)
	},
}
