/**
 * The file store.
 *
 * One entity is one file plus one sidecar. The sidecar is the source of truth,
 * the payload is the bytes, and `IndexDatabase` is a rebuildable view over
 * both. This class owns the ordering that makes that true:
 *
 *   1. validate and construct the metadata;
 *   2. write the payload atomically (temp file + rename);
 *   3. write the sidecar atomically;
 *   4. update the index.
 *
 * A crash between 3 and 4 costs a rebuild, not a file. A crash between 2 and 3
 * leaves an orphan payload in an id folder, which `rebuild()` reports instead
 * of guessing a description for it.
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { IndexDatabase } from './db.js'
import { fileId, isFileId, shortIds } from './ids.js'
import {
	META_FILE,
	assertDescription,
	buildMeta,
	clipDescription,
	normalizeDescription,
	normalizeLinks,
	normalizeMeta,
	normalizeSource,
	normalizeTags,
	serializeMeta,
} from './meta.js'
import { contentTypeOf, extensionOf, isTextMime, isTextual, safeName } from './names.js'
import { clipChars, snippetOf, tokenize } from './text.js'

/** One file may not exceed this many bytes by default. */
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

/** How much of a text file `read()` returns by default. */
export const DEFAULT_READ_TEXT_BYTES = 256 * 1024

/** How many code points of a text file are tokenised into the index. */
export const DEFAULT_INDEX_TEXT_CHARS = 512 * 1024

/** The filesystem timestamp format used for trash folders. */
function stamp(now = new Date()) {
	return now.toISOString().replace(/[:.]/g, '-')
}

/**
 * A recency score in (0, 1]; a file updated today is 1, a month old is 0.5.
 *
 * @param {string} updated - ISO timestamp.
 * @param {number} [now] - Current milliseconds.
 * @returns {number} The score.
 */
function recency(updated, now = Date.now()) {
	const at = Date.parse(updated)
	if (!Number.isFinite(at)) return 0
	const days = Math.max(0, (now - at) / 86_400_000)
	return 1 / (1 + days / 30)
}

/**
 * The content of one file entity.
 */
export class FileStore {
	/**
	 * @param {{dataDir: string, logger?: object, maxBytes?: number, readTextBytes?: number, indexTextChars?: number}} options - Where the library lives and its bounds.
	 */
	constructor({ dataDir, logger, maxBytes, readTextBytes, indexTextChars }) {
		if (typeof dataDir !== 'string' || dataDir === '') throw new Error('数据目录不能为空。')
		this.dataDir = resolve(dataDir)
		this.filesDir = join(this.dataDir, 'files')
		this.trashDir = join(this.dataDir, 'trash')
		this.dbPath = join(this.dataDir, 'yuanshi.db')
		this.logger = logger
		this.maxBytes = Math.max(1, Math.round(Number(maxBytes) || DEFAULT_MAX_BYTES))
		this.readTextBytes = Math.max(1, Math.round(Number(readTextBytes) || DEFAULT_READ_TEXT_BYTES))
		this.indexTextChars = Math.max(1, Math.round(Number(indexTextChars) || DEFAULT_INDEX_TEXT_CHARS))
		this.db = new IndexDatabase({ path: this.dbPath, logger })
		this.shortCache = { version: -1, map: new Map() }
	}

	/**
	 * The short-id map, cached against the index version.
	 *
	 * `create()` returns `read()`, so computing this per call would turn a
	 * thousand writes into a quadratic scan of the whole library. The map is
	 * derived data: one version check decides whether it can be reused.
	 *
	 * @returns {Map<string, string>} Full id to display suffix.
	 */
	shortMap() {
		const version = this.db.version
		if (this.shortCache.version !== version) {
			this.shortCache = { version, map: shortIds(this.db.ids()) }
		}
		return this.shortCache.map
	}

	/**
	 * Open the store and, when the index is missing, rebuild it from sidecars.
	 *
	 * @returns {Promise<void>} Resolves when ready.
	 */
	async open() {
		await mkdir(this.filesDir, { recursive: true, mode: 0o700 })
		await mkdir(this.trashDir, { recursive: true, mode: 0o700 })
		const existed = await stat(this.dbPath).then(() => true, () => false)
		this.db.open()
		if (!existed || this.db.total() === 0) {
			const scanned = await this.scan()
			if (scanned.entries.length > 0) this.db.rebuild(scanned.entries)
			if (scanned.problems.length > 0) {
				this.logger?.warn?.(`元始：重建索引时跳过 ${scanned.problems.length} 个问题文件`)
			}
		}
	}

	/** Close the index. */
	close() {
		this.db.close()
	}

	/**
	 * The on-disk folder of one entity.
	 *
	 * @param {string} id - The file id.
	 * @returns {string} The absolute folder.
	 */
	entityDir(id) {
		if (!isFileId(id)) throw new Error('文件 id 不合法。')
		return join(this.filesDir, id)
	}

	/**
	 * The on-disk path of one entity's payload.
	 *
	 * @param {object} meta - The metadata.
	 * @returns {string} The absolute path.
	 */
	entityPath(meta) {
		return join(this.entityDir(meta.id), meta.name)
	}

	/**
	 * Write one file atomically: a unique temp name in the same directory, then
	 * rename. The temp name never collides with a real file and never crosses a
	 * filesystem boundary.
	 *
	 * @param {string} path - The destination.
	 * @param {string | Buffer} data - The bytes.
	 * @returns {Promise<void>} Resolves once renamed.
	 */
	async atomicWrite(path, data) {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 })
		const temp = join(dirname(path), `.tmp-${process.pid}-${randomUUID()}`)
		try {
			await writeFile(temp, data, { mode: 0o600 })
			await rename(temp, path)
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {})
			throw error
		}
	}

	/**
	 * Write one sidecar.
	 *
	 * @param {object} meta - The metadata.
	 * @returns {Promise<void>} Resolves once written.
	 */
	async writeMeta(meta) {
		await this.atomicWrite(join(this.entityDir(meta.id), META_FILE), serializeMeta(meta))
	}

	/**
	 * Read and validate one sidecar.
	 *
	 * @param {string} id - The file id.
	 * @returns {Promise<object | undefined>} The metadata, or undefined when absent.
	 */
	async readMeta(id) {
		if (!isFileId(id)) return undefined
		const text = await readFile(join(this.entityDir(id), META_FILE), 'utf8').catch(() => undefined)
		if (text === undefined) return undefined
		return normalizeMeta(JSON.parse(text))
	}

	/**
	 * Turn a caller's content into bytes plus a default name.
	 *
	 * @param {object} input - `content` (string|Buffer) or `sourcePath`.
	 * @returns {Promise<{buffer: Buffer, sourceName: string}>} The payload.
	 */
	async payloadOf(input) {
		if (Buffer.isBuffer(input.content)) return { buffer: Buffer.from(input.content), sourceName: '' }
		if (typeof input.content === 'string') return { buffer: Buffer.from(input.content, 'utf8'), sourceName: '' }
		if (typeof input.sourcePath === 'string' && input.sourcePath !== '') {
			const buffer = await readFile(input.sourcePath)
			return { buffer, sourceName: basename(input.sourcePath) }
		}
		throw new Error('新建文件需要 content（字符串/Buffer）或 sourcePath。')
	}

	/**
	 * Decide the stored name and MIME type for one payload.
	 *
	 * @param {object} input - The caller input.
	 * @param {Buffer} buffer - The bytes.
	 * @param {string} sourceName - A name derived from the source path.
	 * @returns {{name: string, mime: string}} The stored identity.
	 */
	identityOf(input, buffer, sourceName) {
		const raw = typeof input.name === 'string' && input.name !== '' ? input.name : sourceName
		let candidate = raw
		if (candidate === '') candidate = isTextual(buffer) ? 'untitled.md' : 'untitled.bin'
		const name = safeName(candidate)
		if (name === '') throw new Error(`文件名不合法：${String(candidate)}`)
		return { name, mime: contentTypeOf(name, buffer) }
	}

	/**
	 * The raw text to index for one payload.
	 *
	 * Long files are indexed from their head only: the whole file is still
	 * readable through `path`, but one 25 MB log must not make a write or a
	 * startup slow.
	 *
	 * @param {Buffer} buffer - The bytes.
	 * @param {string} mime - The MIME type.
	 * @returns {string} The text (possibly clipped), or '' for binary.
	 */
	indexTextOf(buffer, mime) {
		if (!isTextMime(mime)) return ''
		return clipChars(buffer.toString('utf8'), this.indexTextChars)
	}

	/**
	 * Create one file.
	 *
	 * @param {object} input - `{name, description, content|sourcePath, tags, links, source, created, archived, id}`.
	 * @returns {Promise<object>} The stored file, as `read()` returns it.
	 */
	async create(input = {}) {
		const description = assertDescription(input.description)
		const { buffer, sourceName } = await this.payloadOf(input)
		if (buffer.length > this.maxBytes) {
			throw new Error(`文件超过 ${Math.round(this.maxBytes / 1024 / 1024)} MB 上限。`)
		}
		const { name, mime } = this.identityOf(input, buffer, sourceName)
		const id = input.id === undefined ? fileId() : input.id
		if (!isFileId(id)) throw new Error('文件 id 不合法。')
		if (input.id !== undefined && await stat(this.entityDir(id)).then(() => true, () => false)) {
			throw new Error('文件 id 已存在。')
		}
		const now = new Date().toISOString()
		const links = this.resolveLinks(input.links, { selfId: id })
		const meta = buildMeta({
			id,
			name,
			description,
			tags: input.tags,
			links,
			source: input.source,
			created: input.created ?? now,
			updated: now,
			mime,
			bytes: buffer.length,
			sha256: this.hashOf(buffer),
			archived: input.archived === true,
			legacyId: input.legacyId,
		})
		const dir = this.entityDir(id)
		await mkdir(dir, { recursive: true, mode: 0o700 })
		await this.atomicWrite(this.entityPath(meta), buffer)
		await this.writeMeta(meta)
		this.db.upsert(meta, this.indexTextOf(buffer, meta.mime))
		return this.read(id, { text: input.text !== false })
	}

	/**
	 * Update one file.
	 *
	 * Only the fields present in `patch` change. Content can be replaced by
	 * `content`/`sourcePath`; the name can change without touching the content;
	 * links are resolved against the current library.
	 *
	 * @param {string} id - The file id.
	 * @param {object} patch - `{name, description, content, sourcePath, tags, links, source, archived}`.
	 * @returns {Promise<object>} The updated file.
	 */
	async update(id, patch = {}) {
		const current = await this.readMeta(id)
		if (current === undefined) throw new Error('文件不存在。')
		const hasContent = patch.content !== undefined || patch.sourcePath !== undefined
		const { buffer, sourceName } = hasContent ? await this.payloadOf(patch) : { buffer: undefined, sourceName: '' }
		if (buffer !== undefined && buffer.length > this.maxBytes) {
			throw new Error(`文件超过 ${Math.round(this.maxBytes / 1024 / 1024)} MB 上限。`)
		}
		const rawName = typeof patch.name === 'string' && patch.name !== '' ? patch.name : (hasContent ? sourceName : current.name)
		const name = rawName === '' ? current.name : safeName(rawName)
		if (name === '') throw new Error(`文件名不合法：${String(rawName)}`)
		const mime = buffer !== undefined
			? contentTypeOf(name, buffer)
			: extensionOf(name) === extensionOf(current.name)
				? current.mime
				: contentTypeOf(name, await readFile(this.entityPath(current)).catch(() => Buffer.alloc(0)))
		const oldPath = this.entityPath(current)
		const nextPath = join(this.entityDir(id), name)
		let bytes = current.bytes
		let sha256 = current.sha256
		if (buffer !== undefined) {
			bytes = buffer.length
			sha256 = this.hashOf(buffer)
			await this.atomicWrite(nextPath, buffer)
		} else if (oldPath !== nextPath) {
			await rename(oldPath, nextPath)
		}
		const meta = buildMeta({
			id,
			name,
			description: patch.description === undefined ? current.description : assertDescription(patch.description),
			tags: patch.tags === undefined ? current.tags : normalizeTags(patch.tags),
			links: patch.links === undefined ? current.links : this.resolveLinks(patch.links, { selfId: id }),
			source: patch.source === undefined ? current.source : normalizeSource(patch.source),
			created: current.created,
			updated: new Date().toISOString(),
			mime,
			bytes,
			sha256,
			archived: patch.archived === undefined ? current.archived : patch.archived === true,
			legacyId: current.legacyId,
		})
		await this.writeMeta(meta)
		if (buffer !== undefined && oldPath !== nextPath) await rm(oldPath, { force: true }).catch(() => {})
		const bodyText = buffer === undefined
			? this.indexTextOf(await readFile(nextPath).catch(() => Buffer.alloc(0)), meta.mime)
			: this.indexTextOf(buffer, meta.mime)
		this.db.upsert(meta, bodyText)
		return this.read(id, { text: true })
	}

	/**
	 * Read one file: metadata, payload access and neighbours.
	 *
	 * @param {string} id - The file id.
	 * @param {{text?: boolean, neighbors?: boolean}} [options] - Whether to inline text and neighbours.
	 * @returns {Promise<object | undefined>} The file, or undefined when absent.
	 */
	async read(id, { text = true, neighbors = true } = {}) {
		if (!isFileId(id)) return undefined
		let meta = await this.readMeta(id).catch(() => undefined)
		if (meta === undefined) meta = this.db.get(id)
		if (meta === undefined) return undefined
		const path = this.entityPath(meta)
		const info = await lstat(path).catch(() => undefined)
		// A symlink in an entity folder can point anywhere on the machine. The
		// store never creates one, so a symlink is either a hand edit or an
		// attack; it is reported instead of followed.
		const unsafe = info?.isSymbolicLink() === true
		const missing = info === undefined || unsafe
		const out = { ...meta, path, missing, ...(unsafe ? { unsafe: 'symlink' } : {}) }
		if (text && !missing && isTextMime(meta.mime)) {
			const buffer = await readFile(path).catch(() => undefined)
			if (buffer !== undefined) {
				const truncated = buffer.length > this.readTextBytes
				const slice = truncated ? buffer.subarray(0, this.readTextBytes) : buffer
				out.text = slice.toString('utf8')
				out.truncated = truncated
			}
		}
		out.short = this.shortMap().get(id) ?? id
		if (neighbors) {
			const outgoing = []
			for (const target of meta.links ?? []) {
				const found = this.db.get(target)
				outgoing.push(found === undefined
					? { id: target, missing: true }
					: { id: found.id, name: found.name, description: found.description, mime: found.mime })
			}
			const incoming = this.db.backlinks(id).map((sourceId) => {
				const found = this.db.get(sourceId)
				return found === undefined
					? { id: sourceId, missing: true }
					: { id: found.id, name: found.name, description: found.description, mime: found.mime }
			})
			out.neighbors = { out: outgoing, in: incoming }
		}
		return out
	}

	/**
	 * Add one link, without rewriting the payload.
	 *
	 * @param {string} from - The source id.
	 * @param {string} to - The target id.
	 * @returns {Promise<object>} The updated source file.
	 */
	async link(from, to) {
		const current = await this.readMeta(from)
		if (current === undefined) throw new Error('来源文件不存在。')
		const [target] = this.resolveLinks([to], { selfId: from })
		if (target === undefined) throw new Error(`链接目标不存在：${String(to)}`)
		if ((current.links ?? []).includes(target)) return this.read(from)
		return this.update(from, { links: [...(current.links ?? []), target] })
	}

	/**
	 * Remove one link.
	 *
	 * @param {string} from - The source id.
	 * @param {string} to - The target id.
	 * @returns {Promise<object>} The updated source file.
	 */
	async unlink(from, to) {
		const current = await this.readMeta(from)
		if (current === undefined) throw new Error('来源文件不存在。')
		const resolved = this.resolveId(to)
		const links = (current.links ?? []).filter((link) => link !== resolved)
		if (links.length === (current.links ?? []).length) return this.read(from)
		return this.update(from, { links })
	}

	/**
	 * Move one file between the live set and the archive.
	 *
	 * @param {string} id - The file id.
	 * @param {boolean} [archived] - The new state.
	 * @returns {Promise<object>} The updated file.
	 */
	async archive(id, archived = true) {
		return this.update(id, { archived: archived === true })
	}

	/**
	 * Remove one file, moving its folder to trash first.
	 *
	 * Incoming links in other sidecars are left alone: they are that file's
	 * statement, and a missing target is a state the store already understands.
	 *
	 * @param {string} id - The file id.
	 * @returns {Promise<{id: string, trashed: boolean}>} What happened.
	 */
	async remove(id) {
		if (!isFileId(id)) throw new Error('文件 id 不合法。')
		const meta = await this.readMeta(id).catch(() => undefined)
		const dir = this.entityDir(id)
		const exists = await stat(dir).then(() => true, () => false)
		let trashed = false
		if (exists) {
			const destination = join(this.trashDir, `${stamp()}-${id}`)
			await rename(dir, destination)
			trashed = true
		}
		const removed = this.db.remove(id)
		return { id, trashed: trashed || removed || meta !== undefined }
	}

	/**
	 * List and search files.
	 *
	 * Search is FTS candidates first, then policy: normalised BM25, recency and
	 * degree. Snippets are read from the payload, not from the pre-tokenised
	 * FTS columns, so they stay readable.
	 *
	 * @param {{query?: string, tag?: string, mime?: string, archived?: boolean, limit?: number, offset?: number}} [options] - Filters.
	 * @returns {Promise<{total: number, files: object[]}>} The page.
	 */
	async list(options = {}) {
		const limit = Math.max(1, Math.min(500, Math.round(Number(options.limit) || 50)))
		const offset = Math.max(0, Math.round(Number(options.offset) || 0))
		const archived = options.archived === true
		const tag = typeof options.tag === 'string' ? options.tag.trim() : ''
		const mime = typeof options.mime === 'string' ? options.mime.trim() : ''
		const query = typeof options.query === 'string' ? options.query.trim() : ''
		const degrees = this.db.degrees()
		const shortMap = this.shortMap()
		const decorate = (meta, extra = {}) => ({
			...meta,
			short: shortMap.get(meta.id) ?? meta.id,
			degree: degrees.get(meta.id) ?? { in: 0, out: 0 },
			...extra,
		})
		const keep = (meta) => {
			if (tag !== '' && !(meta.tags ?? []).some((item) => item === tag || item.startsWith(`${tag}/`))) return false
			if (mime !== '' && !(meta.mime === mime || (mime.endsWith('/') && meta.mime.startsWith(mime)))) return false
			return true
		}

		if (query === '') {
			const rows = this.db.list({ limit: 500, archived })
			const filtered = rows.filter(keep)
			const page = filtered.slice(offset, offset + limit)
			const files = await Promise.all(page.map(async (meta) => decorate(meta, this.snippetFor(meta, []))))
			return { total: filtered.length, files }
		}

		const hits = this.db.search(query, { limit: 200, includeArchived: archived })
		const now = Date.now()
		const maxRank = Math.max(...hits.map((hit) => -hit.rank), Number.EPSILON)
		const tokens = tokenize(query)
		const scored = []
		for (const hit of hits) {
			const meta = this.db.get(hit.id)
			if (meta === undefined || !keep(meta)) continue
			const degree = degrees.get(meta.id) ?? { in: 0, out: 0 }
			const score = (Math.max(0, -hit.rank) / maxRank) * 0.8
				+ recency(meta.updated, now) * 0.15
				+ Math.min(1, (degree.in + degree.out) / 20) * 0.05
			scored.push({ meta, score })
		}
		scored.sort((left, right) => right.score - left.score
			|| right.meta.updated.localeCompare(left.meta.updated)
			|| left.meta.id.localeCompare(right.meta.id))
		const page = scored.slice(offset, offset + limit)
		const files = await Promise.all(page.map(async (item) => {
			const snippets = await this.snippetFor(item.meta, tokens)
			return decorate(item.meta, { ...snippets, score: Number(item.score.toFixed(4)) })
		}))
		return { total: scored.length, files }
	}

	/**
	 * A query snippet for one file, read from the payload.
	 *
	 * @param {object} meta - The metadata.
	 * @param {string[]} tokens - The query tokens.
	 * @returns {Promise<{snippet?: string}>} The snippet when the file is text.
	 */
	async snippetFor(meta, tokens) {
		if (tokens.length === 0 || !isTextMime(meta.mime)) return {}
		const buffer = await readFile(this.entityPath(meta)).catch(() => undefined)
		if (buffer === undefined) return {}
		const text = buffer.subarray(0, this.readTextBytes).toString('utf8')
		const snippet = snippetOf(text, tokens)
		return snippet === '' ? {} : { snippet }
	}

	/**
	 * Counts for the overview and the injected summary.
	 *
	 * @returns {{files: number, archived: number, links: number, tags: number, orphans: number, mimes: Array<{mime: string, count: number}>}} The stats.
	 */
	stats() {
		const base = this.db.stats()
		let orphans = 0
		for (const degree of this.db.degrees().values()) {
			if (degree.in + degree.out === 0) orphans += 1
		}
		return { ...base, orphans }
	}

	/**
	 * Rebuild the index from sidecars and payloads.
	 *
	 * The scan is also the repair path: a payload whose size no longer matches
	 * its sidecar is re-hashed and the sidecar is corrected, and a folder with
	 * no readable sidecar is reported rather than silently dropped.
	 *
	 * @returns {Promise<{files: number, links: number, tags: number, problems: Array<{id: string, reason: string}>}>} A report.
	 */
	async rebuild() {
		const scanned = await this.scan()
		this.db.rebuild(scanned.entries)
		return {
			files: scanned.entries.length,
			links: scanned.entries.reduce((sum, entry) => sum + (entry.meta.links?.length ?? 0), 0),
			tags: scanned.entries.reduce((sum, entry) => sum + (entry.meta.tags?.length ?? 0), 0),
			problems: scanned.problems,
		}
	}

	/**
	 * Scan every entity folder.
	 *
	 * @returns {Promise<{entries: Array<{meta: object, bodyText: string}>, problems: Array<{id: string, reason: string}>}>} The scan.
	 */
	async scan() {
		const names = await readdir(this.filesDir, { withFileTypes: true }).catch(() => [])
		const entries = []
		const problems = []
		for (const entry of names) {
			if (!entry.isDirectory() || !isFileId(entry.name)) continue
			const id = entry.name
			try {
				const meta = await this.readMeta(id)
				if (meta === undefined) {
					problems.push({ id, reason: '缺少 meta.json' })
					continue
				}
				const dir = this.entityDir(id)
				const files = (await readdir(dir)).filter((name) => name !== META_FILE && !name.startsWith('.tmp-'))
				if (files.length === 0) {
					problems.push({ id, reason: '没有文件本体' })
					continue
				}
				const payloadName = files.includes(meta.name) ? meta.name : files[0]
				if (payloadName !== meta.name) {
					problems.push({ id, reason: `meta 名与实际文件不一致：${meta.name} vs ${payloadName}` })
				}
				const path = join(dir, payloadName)
				const info = await lstat(path)
				if (info.isSymbolicLink()) {
					problems.push({ id, reason: '拒绝符号链接（可能指向库外）' })
					continue
				}
				const buffer = await readFile(path)
				let repaired = meta
				if (payloadName !== meta.name || buffer.length !== meta.bytes) {
					repaired = buildMeta({
						...meta,
						name: payloadName,
						mime: contentTypeOf(payloadName, buffer),
						bytes: buffer.length,
						sha256: this.hashOf(buffer),
					})
					await this.writeMeta(repaired)
				}
				entries.push({ meta: repaired, bodyText: this.indexTextOf(buffer, repaired.mime) })
			} catch (error) {
				problems.push({ id, reason: error instanceof Error ? error.message : String(error) })
			}
		}
		return { entries, problems }
	}

	/**
	 * Resolve caller link values to full ids.
	 *
	 * A full id must exist; a short suffix is accepted only when it identifies
	 * exactly one file. Unknown targets are dropped with a warning instead of
	 * failing the whole write — a dead link should not make a file unwritable.
	 *
	 * @param {unknown} values - The raw link list.
	 * @param {{selfId?: string}} [options] - The writer's id.
	 * @returns {string[]} Resolved ids.
	 */
	resolveLinks(values, { selfId = '' } = {}) {
		const out = []
		const seen = new Set()
		for (const raw of normalizeLinks(values)) {
			const resolved = this.resolveId(raw)
			if (resolved === undefined || resolved === selfId || seen.has(resolved)) continue
			seen.add(resolved)
			out.push(resolved)
		}
		return out
	}

	/**
	 * Resolve one id or unique suffix.
	 *
	 * @param {unknown} value - The id or suffix.
	 * @returns {string | undefined} The full id.
	 */
	resolveId(value) {
		const raw = String(value ?? '').trim()
		if (raw === '') return undefined
		if (isFileId(raw)) return this.db.get(raw) === undefined ? undefined : raw
		if (raw.length < 5) return undefined
		const matches = this.db.ids().filter((id) => id.endsWith(raw))
		return matches.length === 1 ? matches[0] : undefined
	}

	/**
	 * The SHA-256 of one payload.
	 *
	 * @param {Buffer} buffer - The bytes.
	 * @returns {string} The hex digest.
	 */
	hashOf(buffer) {
		return createHash('sha256').update(buffer).digest('hex')
	}

	/**
	 * A description derived from a text, for imports that have none.
	 *
	 * @param {string} text - The text.
	 * @param {number} [maxChars] - The cap.
	 * @returns {string} The description.
	 */
	describeText(text, maxChars = 160) {
		return clipDescription(text, maxChars)
	}

	/**
	 * A normalised description, for callers that need the rule without writing.
	 *
	 * @param {unknown} value - The raw description.
	 * @returns {string} The clean description.
	 */
	cleanDescription(value) {
		return normalizeDescription(value)
	}
}
