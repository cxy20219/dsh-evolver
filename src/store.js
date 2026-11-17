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
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { dayKey } from './day.js'
import { IndexDatabase } from './db.js'
import { fileId, isFileId } from './ids.js'
import {
	DEFAULT_DESCRIPTION_CHARS,
	META_FILE,
	assertDescription,
	assertTags,
	buildMeta,
	normalizeLinks,
	normalizeMeta,
	normalizeSource,
	normalizeTag,
	serializeMeta,
} from './meta.js'
import { assertNotReservedName, contentTypeOf, extensionOf, isExecutablePayload, isScriptName, isTextMime, isTextual, safeName } from './names.js'

/** One file may not exceed this many bytes by default. */
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

/** How much of a text file `read()` returns by default. */
export const DEFAULT_READ_TEXT_BYTES = 256 * 1024

/** How many bytes of an old payload are enough to sniff its MIME type. */
const MIME_SNIFF_BYTES = 8192

/**
 * How many entity folders one scan reads in parallel.
 *
 * A cold start walks the whole library; sixteen lanes turn three or four serial
 * system calls per folder into a mostly-waiting pool without swamping old disks.
 */
const SCAN_CONCURRENCY = 16

/**
 * How much of a payload the full-text index keeps.
 *
 * The body is a fallback signal, not a copy of the library: enough leading text
 * to catch the terms a description missed, small enough that a large file does
 * not turn every write into a multi-megabyte tokenise. 32 KB is dozens of
 * pages of prose.
 */
const FTS_BODY_BYTES = 32 * 1024

/** The Windows namespaces that name devices and pipes rather than files. */
const WINDOWS_NAMESPACE = /^[\\/]{2}[.?][\\/]/

/** Windows resolves these names to hardware even with an extension. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Whether a path names a Windows device or pipe rather than a file.
 *
 * `file_write({from})` reads whatever host path it is given, so the one class
 * of "path" that must never reach `readFile` is the class where open has side
 * effects or never returns: `\\.\pipe\...` blocks until a peer appears, and
 * `CON`/`NUL` are consoles and sinks, not files. Node can often make a scratch
 * file with such a literal name, but a caller cannot tell the two apart here,
 * so the path is refused instead of opened.
 *
 * @param {string} path - The caller-supplied source path.
 * @returns {boolean} True when the path is a device namespace or name.
 */
function isWindowsSpecialPath(path) {
	if (WINDOWS_NAMESPACE.test(path)) return true
	const segments = path.split(/[\\/]+/).filter((segment) => segment !== '')
	const last = segments.at(-1) ?? ''
	return WINDOWS_DEVICE_NAME.test(last.replace(/[. ]+$/, ''))
}

/**
 * Read a payload source: verify it is a regular file with a known size first.
 *
 * `file_write({from})` deliberately reads files outside the library, so the
 * size and type check must happen *before* the bytes are read. A 96 MiB sparse
 * file used to be read whole and only then rejected by the size limit, which turns one
 * tool call into a host-memory spike. A symlink is resolved first (reading
 * through a link is part of the documented capability) and the resolved target
 * is what gets checked, so a link can only ever widen the check, never skip it;
 * directories, devices and pipes are not regular files and are refused.
 *
 * @param {string} sourcePath - The host path the caller asked for.
 * @param {number} maxBytes - The store's payload limit.
 * @param {{readBytes?: (path: string) => Promise<Buffer>}} [options] - The body reader; injectable for tests.
 * @returns {Promise<Buffer>} The payload bytes.
 */
export async function readPayloadSource(sourcePath, maxBytes, { readBytes = readFile } = {}) {
	const raw = typeof sourcePath === 'string' ? sourcePath : ''
	if (raw === '') throw new Error('sourcePath 不能为空。')
	if (process.platform === 'win32' && isWindowsSpecialPath(raw)) {
		throw new Error(`不支持设备/管道路径：${raw}`)
	}
	// Resolve the link first so the size/type check sees the file that would
	// actually be read; a dangling link falls through to "not found".
	const canonical = await realpath(raw).catch(() => undefined)
	const info = await stat(canonical ?? raw).catch(() => undefined)
	if (info === undefined) throw new Error(`文件不存在或不可读：${raw}`)
	if (!info.isFile()) throw new Error(`不是普通文件（目录/设备/管道不导入）：${raw}`)
	const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Number(maxBytes) : DEFAULT_MAX_BYTES
	if (info.size > limit) throw new Error(`文件超过 ${Math.max(1, Math.round(limit / 1024 / 1024))} MB 上限。`)
	const buffer = await readBytes(canonical ?? raw)
	// The size can change between the stat and the read (TOCTOU); the second
	// check keeps the memory bound even when it does.
	if (buffer.length > limit) throw new Error(`文件超过 ${Math.max(1, Math.round(limit / 1024 / 1024))} MB 上限。`)
	return buffer
}

/**
 * Drop a trailing incomplete UTF-8 sequence from a byte prefix.
 *
 * The MIME sniff reads only the head of the payload, but `isTextual` decodes
 * the bytes it is given strictly: a multi-byte character cut in half at the
 * boundary would make a text file look binary and change its stored MIME type
 * on a rename. Trimming the partial sequence keeps the prefix decodable.
 *
 * @param {Buffer} buffer - The head bytes.
 * @returns {Buffer} A prefix that ends on a character boundary.
 */
function trimIncompleteUtf8(buffer) {
	for (let length = 1; length <= 4 && length <= buffer.length; length += 1) {
		const byte = buffer[buffer.length - length]
		if ((byte & 0x80) === 0) return buffer
		if ((byte & 0xc0) === 0x80) continue
		const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2
		return length < expected ? buffer.subarray(0, buffer.length - length) : buffer
	}
	return buffer
}

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
	 * @param {{dataDir: string, logger?: object, maxBytes?: number, readTextBytes?: number, descriptionMaxChars?: number}} options - Where the library lives and its bounds.
	 */
	constructor({ dataDir, logger, maxBytes, readTextBytes, descriptionMaxChars }) {
		if (typeof dataDir !== 'string' || dataDir === '') throw new Error('数据目录不能为空。')
		this.dataDir = resolve(dataDir)
		// Content and system data are two separate trees under one root:
		// files/ holds only entities, system/ holds the index and its satellites.
		this.filesDir = join(this.dataDir, 'files')
		this.systemDir = join(this.dataDir, 'system')
		this.trashDir = join(this.systemDir, 'trash')
		this.dbPath = join(this.systemDir, 'ziyan.db')
		this.logger = logger
		this.maxBytes = Math.max(1, Math.round(Number(maxBytes) || DEFAULT_MAX_BYTES))
		this.readTextBytes = Math.max(1, Math.round(Number(readTextBytes) || DEFAULT_READ_TEXT_BYTES))
		this.descriptionMaxChars = Math.min(200, Math.max(20, Math.round(Number(descriptionMaxChars) || DEFAULT_DESCRIPTION_CHARS)))
		this.db = new IndexDatabase({ path: this.dbPath, logger })
		// Aggregates the overview asks for are computed from index scans; cache
		// them against the index version so a panel refresh is free until the
		// library changes. The version alone only covers writes made through
		// this connection, so the cache key also carries SQLite's
		// data-version: maintenance committed by another process (repair,
		// second host) bumps it without touching `db.version`.
		this.statsCache = { version: -1, dataVersion: -1, value: null }
		this.tagCache = { version: -1, dataVersion: -1, byLimit: new Map() }
	}

	/**
	 * The short-id index, maintained incrementally by the database.
	 *
	 * A short id is a display handle; the database owns the map so a write only
	 * has to add or remove one entry instead of rebuilding the whole library's
	 * suffix table.
	 *
	 * @returns {import('./ids.js').ShortIdIndex} The index.
	 */
	shortIndex() {
		return this.db.shortIdIndex()
	}

	/**
	 * Open the store and, when the index is missing, rebuild it from sidecars.
	 *
	 * A corrupt or version-mismatched database is quarantined and rebuilt
	 * rather than surfaced as a load failure: the sidecars are the truth and
	 * the index is deliberately disposable, so "one bad file in system/"
	 * must not cost the host its tools and panel. The bad file is kept under a
	 * `.corrupt-<timestamp>` name for diagnosis; it is never deleted here.
	 *
	 * @returns {Promise<void>} Resolves when ready.
	 */
	async open() {
		await mkdir(this.filesDir, { recursive: true, mode: 0o700 })
		await mkdir(this.systemDir, { recursive: true, mode: 0o700 })
		await mkdir(this.trashDir, { recursive: true, mode: 0o700 })
		let existed = await stat(this.dbPath).then(() => true, () => false)
		try {
			this.db.open()
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			// `db.open()` closes its own handle; close again is a no-op for the
			// double-failure case and documents the ordering requirement.
			this.db.close()
			const quarantined = await this.quarantineDatabase().catch((failure) => {
				const detail = failure instanceof Error ? failure.message : String(failure)
				throw new Error(`自衍中枢：索引不可用（${reason}），且无法隔离 ${this.dbPath}：${detail}`)
			})
			this.logger?.warn?.(`自衍中枢：索引不可用（${reason}），已移到 ${quarantined}，从边车重建。`)
			this.db.open()
			existed = false
		}
		if (!existed || this.db.total() === 0) {
			// The timestamp is taken before the walk starts: a create() that
			// happens while the walk is in flight is newer than this and must
			// survive the reconciliation.
			const scanStartedAt = new Date().toISOString()
			const scanned = await this.scan()
			if (scanned.entries.length > 0) this.db.rebuild(scanned.entries, { scanStartedAt })
			if (scanned.problems.length > 0) {
				this.logger?.warn?.(`自衍中枢：重建索引时跳过 ${scanned.problems.length} 个问题文件`)
			}
		}
	}

	/**
	 * Rename an unusable index aside so a fresh one can be built at its path.
	 *
	 * The rename preserves whatever the broken file contains for diagnosis and
	 * moves it out of SQLite's way in one step. The `-wal`/`-shm` companions go
	 * with it: a stale write-ahead log next to a freshly created database is
	 * one way a "recovered" index comes back corrupt. A companion that cannot
	 * be renamed is removed instead — it is derived data, and the main file has
	 * already been preserved.
	 *
	 * @returns {Promise<string>} The new path of the quarantined database.
	 */
	async quarantineDatabase() {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-')
		const target = `${this.dbPath}.corrupt-${stamp}`
		await rename(this.dbPath, target)
		for (const suffix of ['-wal', '-shm']) {
			const from = `${this.dbPath}${suffix}`
			const moved = await rename(from, `${target}${suffix}`).then(() => true, () => false)
			if (!moved) await rm(from, { force: true }).catch(() => {})
		}
		return target
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
	/**
	 * The part of a payload that may enter the full-text index.
	 *
	 * Binary payloads contribute nothing — a description is their only visible
	 * face — and text is cut to `FTS_BODY_BYTES`.
	 *
	 * @param {Buffer | undefined} buffer - The payload bytes.
	 * @param {string} mime - The detected or declared type.
	 * @returns {string} The indexable head, or an empty string.
	 */
	indexableBody(buffer, mime) {
		if (!Buffer.isBuffer(buffer) || buffer.length === 0) return ''
		if (!isTextMime(mime)) return ''
		// A binary sniffed into text still ok; a large file is cut, not guessed at.
		return buffer.subarray(0, FTS_BODY_BYTES).toString('utf8')
	}

	/**
	 * Read the leading bytes of a payload without loading the whole file.
	 *
	 * Used when an update leaves the content alone: the index still has to
	 * describe what is on disk, and re-reading 32 KB is cheaper than holding a
	 * whole payload in memory just to index its head.
	 *
	 * @param {string} path - The payload path.
	 * @param {string} mime - The type, from the sidecar.
	 * @returns {Promise<string>} The indexable head, or an empty string.
	 */
	async readIndexableBody(path, mime) {
		if (!isTextMime(mime)) return ''
		const handle = await open(path, 'r').catch(() => undefined)
		if (handle === undefined) return ''
		try {
			const buffer = Buffer.alloc(FTS_BODY_BYTES)
			const { bytesRead } = await handle.read(buffer, 0, FTS_BODY_BYTES, 0)
			return buffer.subarray(0, bytesRead).toString('utf8')
		} catch {
			return ''
		} finally {
			await handle.close().catch(() => {})
		}
	}

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
	 * Set the payload mode from its shape: scripts run, documents are read.
	 *
	 * The mode is the authority `read()` reports back; the metadata does not
	 * carry an `executable` flag that could drift from the file system.
	 *
	 * @param {string} path - The payload path.
	 * @param {string} name - The stored name.
	 * @param {Buffer} [buffer] - The bytes, when known.
	 * @returns {Promise<void>} Resolves after chmod.
	 */
	async applyMode(path, name, buffer) {
		const executable = buffer === undefined ? isScriptName(name) : isExecutablePayload(name, buffer)
		await chmod(path, executable ? 0o700 : 0o600)
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
		return normalizeMeta(JSON.parse(text), { descriptionMaxChars: this.descriptionMaxChars })
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
			// Check type and size before reading anything: `file_write({from})` accepts
			// arbitrary host paths, and a 100 MB file must be refused, not loaded
			// and then refused.
			const buffer = await readPayloadSource(input.sourcePath, this.maxBytes)
			return { buffer, sourceName: basename(input.sourcePath) }
		}
		throw new Error('新建文件需要 content（字符串/Buffer）或 sourcePath。')
	}

	/**
	 * Read the head of a payload, for a MIME sniff that must not read it whole.
	 *
	 * Renaming a file to an extension the store does not know needs a look at
	 * the bytes to tell text from binary; the first few kilobytes are enough,
	 * and reading the whole old payload just to classify it was an unbounded
	 * read.
	 *
	 * @param {string} path - The payload path.
	 * @returns {Promise<Buffer>} At most {@link MIME_SNIFF_BYTES} bytes.
	 */
	async readHead(path) {
		const handle = await open(path, 'r').catch(() => undefined)
		if (handle === undefined) return Buffer.alloc(0)
		try {
			const buffer = Buffer.alloc(MIME_SNIFF_BYTES)
			const { bytesRead } = await handle.read(buffer, 0, MIME_SNIFF_BYTES, 0)
			return trimIncompleteUtf8(buffer.subarray(0, bytesRead))
		} finally {
			await handle.close().catch(() => {})
		}
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
	 * Create one file.
	 *
	 * @param {object} input - `{name, description, content|sourcePath, tags, links, source, created, archived, id}`.
	 * @returns {Promise<object>} The stored file, as `read()` returns it.
	 */
	async create(input = {}) {
		const description = assertDescription(input.description, this.descriptionMaxChars)
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
		const warnings = []
		const links = this.resolveLinks(input.links, { selfId: id, warnings })
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
		}, { descriptionMaxChars: this.descriptionMaxChars })
		const dir = this.entityDir(id)
		await mkdir(dir, { recursive: true, mode: 0o700 })
		await this.atomicWrite(this.entityPath(meta), buffer)
		await this.applyMode(this.entityPath(meta), name, buffer)
		await this.writeMeta(meta)
		this.db.upsert(meta, this.indexableBody(buffer, meta.mime))
		const file = await this.read(id, { text: input.text !== false })
		return warnings.length === 0 ? file : { ...file, warnings }
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
		const warnings = []
		const hasContent = patch.content !== undefined || patch.sourcePath !== undefined
		const { buffer, sourceName } = hasContent ? await this.payloadOf(patch) : { buffer: undefined, sourceName: '' }
		if (buffer !== undefined && buffer.length > this.maxBytes) {
			throw new Error(`文件超过 ${Math.round(this.maxBytes / 1024 / 1024)} MB 上限。`)
		}
		const rawName = typeof patch.name === 'string' && patch.name !== '' ? patch.name : (hasContent ? sourceName : current.name)
		const name = rawName === '' ? current.name : assertNotReservedName(safeName(rawName))
		if (name === '') throw new Error(`文件名不合法：${String(rawName)}`)
		const mime = buffer !== undefined
			? contentTypeOf(name, buffer)
			: extensionOf(name) === extensionOf(current.name)
				? current.mime
				: contentTypeOf(name, await this.readHead(this.entityPath(current)))
		const oldPath = this.entityPath(current)
		const nextPath = join(this.entityDir(id), name)
		let bytes = current.bytes
		let sha256 = current.sha256
		if (buffer !== undefined) {
			bytes = buffer.length
			sha256 = this.hashOf(buffer)
			await this.atomicWrite(nextPath, buffer)
			await this.applyMode(nextPath, name, buffer)
		} else if (oldPath !== nextPath) {
			await rename(oldPath, nextPath)
			await this.applyMode(nextPath, name)
		}
		const meta = buildMeta({
			id,
			name,
			description: patch.description === undefined ? current.description : assertDescription(patch.description, this.descriptionMaxChars),
			tags: patch.tags === undefined ? current.tags : assertTags(patch.tags),
			links: patch.links === undefined ? current.links : this.resolveLinks(patch.links, { selfId: id, warnings }),
			source: patch.source === undefined ? current.source : normalizeSource(patch.source),
			created: current.created,
			updated: new Date().toISOString(),
			mime,
			bytes,
			sha256,
			archived: patch.archived === undefined ? current.archived : patch.archived === true,
		}, { descriptionMaxChars: this.descriptionMaxChars })
		await this.writeMeta(meta)
		if (buffer !== undefined && oldPath !== nextPath) await rm(oldPath, { force: true }).catch(() => {})
		const body = buffer !== undefined
			? this.indexableBody(buffer, meta.mime)
			: await this.readIndexableBody(this.entityPath(meta), meta.mime)
		this.db.upsert(meta, body)
		const file = await this.read(id, { text: true })
		return warnings.length === 0 ? file : { ...file, warnings }
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
		// Windows has no POSIX permission bits — `chmod` there only toggles the
		// read-only flag — so the mode never carries 0o111 and every script would
		// look non-executable. Fall back to the name-level rule, which is exactly
		// what the write path uses when it renames without new content; a shebang
		// in a `.txt` therefore stays non-executable on both platforms.
		const windows = process.platform === 'win32'
		const modeExecutable = info !== undefined && (Number(info.mode) & 0o111) !== 0
		const executable = modeExecutable || (windows && isScriptName(meta.name))
		const out = { ...meta, path, missing, executable, ...(unsafe ? { unsafe: 'symlink' } : {}) }
		if (text && !missing && isTextMime(meta.mime)) {
			const buffer = await readFile(path).catch(() => undefined)
			if (buffer !== undefined) {
				const truncated = buffer.length > this.readTextBytes
				const slice = truncated ? buffer.subarray(0, this.readTextBytes) : buffer
				out.text = slice.toString('utf8')
				out.truncated = truncated
			}
		}
		out.short = this.db.shortFor(id)
		out.degree = this.db.degreesFor([id]).get(id) ?? { in: 0, out: 0 }
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
		const resolved = this.resolveId(to)
		if (resolved === from) throw new Error('不能链接到文件自己。')
		const [target] = this.resolveLinks([to], { selfId: from })
		if (target === undefined) throw new Error(`链接目标不存在或不唯一：${String(to)}`)
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
	 * @param {{query?: string, tag?: string, tags?: string[], mime?: string, archived?: boolean, limit?: number, offset?: number}} [options] - Filters.
	 * @returns {Promise<{total: number, files: object[]}>} The page.
	 */
	async list(options = {}) {
		const limit = Math.max(1, Math.min(500, Math.round(Number(options.limit) || 50)))
		const offset = Math.max(0, Math.round(Number(options.offset) || 0))
		const archived = options.archived === true
		const requested = [
			...(typeof options.tag === 'string' ? [options.tag] : []),
			...(Array.isArray(options.tags) ? options.tags : []),
		].map((value) => normalizeTag(value)).filter((value) => value !== '')
		// Multiple tags are AND-ed: a file must carry every requested path (or a
		// descendant of it). A single tag keeps the historical behaviour.
		const wanted = [...new Set(requested)]
		const mime = typeof options.mime === 'string' ? options.mime.trim() : ''
		// `null` means "no filter"; `''` means "names with no extension", which
		// is a real bucket in the type matrix.
		const suffix = typeof options.suffix === 'string' ? options.suffix : null
		const query = typeof options.query === 'string' ? options.query.trim() : ''

		if (query === '') {
			// Paging and filtering happen in SQL: the total has to be the real
			// total, or the panel's "load more" stops at whatever window the
			// index happened to fetch.
			const page = this.db.page({ limit, offset, archived, mime, tags: wanted, suffix })
			const degrees = this.db.degreesFor(page.rows.map((meta) => meta.id))
			return {
				total: page.total,
				files: page.rows.map((meta) => this.decorate(meta, degrees.get(meta.id), {})),
			}
		}

		// Search candidates come from the index with the same tag/mime/suffix
		// filters applied before the candidate window: filtering a ranked window
		// in memory is how a tagged document's length penalty used to hide every
		// hit of "keyword + tag".
		const hits = this.db.search(query, {
			limit: 200,
			includeArchived: archived,
			tags: wanted,
			mime,
			suffix,
		})
		const now = Date.now()
		const maxRank = Math.max(...hits.map((hit) => -hit.rank), Number.EPSILON)
		const degrees = this.db.degreesFor(hits.map((hit) => hit.id))
		const scored = []
		for (const hit of hits) {
			const meta = this.db.get(hit.id)
			if (meta === undefined) continue
			const degree = degrees.get(meta.id) ?? { in: 0, out: 0 }
			const score = (Math.max(0, -hit.rank) / maxRank) * 0.8
				+ recency(meta.updated, now) * 0.15
				+ Math.min(1, (degree.in + degree.out) / 20) * 0.05
			scored.push({ meta, degree, score })
		}
		scored.sort((left, right) => right.score - left.score
			|| right.meta.updated.localeCompare(left.meta.updated)
			|| left.meta.id.localeCompare(right.meta.id))
		const page = scored.slice(offset, offset + limit)
		const files = page.map((item) => this.decorate(item.meta, item.degree, { score: Number(item.score.toFixed(4)) }))
		return { total: scored.length, files }
	}

	/**
	 * Add the derived display fields to one file row.
	 *
	 * @param {object} meta - The metadata.
	 * @param {{in: number, out: number}} [degree] - The already-fetched degree.
	 * @param {object} [extra] - Extra fields (e.g. a search score).
	 * @returns {object} The decorated file.
	 */
	decorate(meta, degree = { in: 0, out: 0 }, extra = {}) {
		return {
			...meta,
			short: this.db.shortFor(meta.id),
			degree,
			...extra,
		}
	}


	/**
	 * Walk the link graph from one or more seeds.
	 *
	 * This is the shape the "search → document → markdown → script" scenario
	 * needs: a bounded breadth-first walk over outgoing and incoming links,
	 * returning nodes and directed edges. It is deliberately not a ranking
	 * function; `list()` ranks, this one navigates.
	 *
	 * @param {string | string[]} ids - Seed ids or unique suffixes.
	 * @param {{hops?: number, limit?: number}} [options] - Walk bounds.
	 * @returns {{nodes: object[], edges: Array<{from: string, to: string}>}} The subgraph.
	 */
	graph(ids, { hops = 1, limit = 100 } = {}) {
		const seeds = (Array.isArray(ids) ? ids : [ids])
			.map((value) => this.resolveId(value))
			.filter((value) => value !== undefined)
		const cap = Math.max(1, Math.min(500, Math.round(Number(limit) || 100)))
		const depth = Math.max(1, Math.min(3, Math.round(Number(hops) || 1)))
		const nodes = new Map()
		const edges = []
		const edgeKeys = new Set()
		const addNode = (id) => {
			if (nodes.has(id)) return false
			const meta = this.db.get(id)
			nodes.set(id, meta === undefined
				? { id, short: this.db.shortFor(id), missing: true }
				: {
					id,
					short: this.db.shortFor(id),
					name: meta.name,
					description: meta.description,
					mime: meta.mime,
					tags: meta.tags ?? [],
				})
			return true
		}
		for (const seed of seeds) {
			if (nodes.size >= cap) break
			addNode(seed)
		}
		let frontier = [...nodes.keys()]
		for (let step = 0; step < depth && frontier.length > 0; step += 1) {
			const next = []
			for (const id of frontier) {
				const meta = this.db.get(id)
				if (meta === undefined) continue
				const related = [
					...(meta.links ?? []).map((to) => ({ from: id, to })),
					...this.db.backlinks(id).map((from) => ({ from, to: id })),
				]
				for (const edge of related) {
					const endpoints = [edge.from, edge.to]
					if (nodes.size < cap) {
						for (const endpoint of endpoints) {
							if (addNode(endpoint)) next.push(endpoint)
						}
					}
					if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue
					const key = `${edge.from}\u001f${edge.to}`
					if (!edgeKeys.has(key)) {
						edgeKeys.add(key)
						edges.push(edge)
					}
				}
			}
			frontier = next
		}
		// Degrees are fetched once for the final node set: one grouped index scan
		// instead of a full-library degree map (which every read used to pay).
		const degrees = this.db.degreesFor([...nodes.keys()])
		for (const [id, node] of nodes) {
			if (node.missing === true) continue
			node.degree = degrees.get(id) ?? { in: 0, out: 0 }
		}
		return { nodes: [...nodes.values()], edges }
	}

	/**
	 * The whole live library as a graph: every file, every link between them.
	 *
	 * `graph()` walks outwards from a seed set, which is the right shape for
	 * "open this file and look around". The panel's graph views need the
	 * opposite: one picture of everything. Edges whose endpoint fell outside
	 * the node cap are dropped here so a caller never has to check, and the
	 * caller reports the missing nodes from its own stats.
	 *
	 * @param {{limit?: number}} [options] - The node cap.
	 * @returns {{nodes: object[], edges: Array<{from: string, to: string}>}} The library graph.
	 */
	libraryGraph({ limit = 3000 } = {}) {
		const snapshot = this.db.snapshot({ limit })
		const degrees = this.db.degreesFor(snapshot.rows.map((meta) => meta.id))
		const nodes = snapshot.rows.map((meta) => ({
			id: meta.id,
			short: this.db.shortFor(meta.id),
			name: meta.name,
			description: meta.description,
			mime: meta.mime,
			tags: meta.tags ?? [],
			degree: degrees.get(meta.id) ?? { in: 0, out: 0 },
		}))
		return { nodes, edges: snapshot.edges }
	}

	/**
	 * The tidy-up report: what the organize page should point a human at.
	 *
	 * Counts come from the index, names come from the same rows the counts are
	 * built from, so a card and its sample list can never disagree.
	 *
	 * @param {{staleDays?: number, sample?: number}} [options] - The staleness window and sample size.
	 * @returns {object} Counts with samples.
	 */
	organizeReport({ staleDays = 90, sample = 5, now = Date.now() } = {}) {
		const days = Math.max(1, Math.min(3650, Math.round(Number(staleDays) || 90)))
		const staleBefore = new Date(now - days * 86_400_000).toISOString()
		const report = this.db.organize({ staleBefore, sample })
		const brief = (meta) => ({
			id: meta.id,
			name: meta.name,
			description: meta.description,
			updated: meta.updated,
		})
		const singleTags = this.db.tagCounts(1000).filter((tag) => tag.count === 1)
		return {
			staleDays: days,
			staleBefore,
			files: this.stats(),
			orphans: { total: report.orphans.total, sample: report.orphans.files.map(brief) },
			stale: { total: report.stale.total, sample: report.stale.files.map(brief) },
			dangling: {
				total: report.dangling.total,
				sample: report.dangling.links.map((link) => {
					const source = this.db.get(link.from)
					return { from: link.from, fromName: source === undefined ? '' : source.name, to: link.to }
				}),
			},
			singleTags: { total: singleTags.length, sample: singleTags.slice(0, Math.max(1, sample)) },
		}
	}

	/**
	 * Apply new limits to an open store.
	 *
	 * The panel changes these without reopening the library; the next write or
	 * read uses the new bounds, and the stored metadata is unaffected.
	 *
	 * @param {{maxBytes?: number, readTextBytes?: number, descriptionMaxChars?: number}} limits - The new bounds.
	 * @returns {void}
	 */
	setLimits({ maxBytes, readTextBytes, descriptionMaxChars } = {}) {
		if (maxBytes !== undefined) this.maxBytes = Math.max(1, Math.round(Number(maxBytes) || DEFAULT_MAX_BYTES))
		if (readTextBytes !== undefined) this.readTextBytes = Math.max(1, Math.round(Number(readTextBytes) || DEFAULT_READ_TEXT_BYTES))
		if (descriptionMaxChars !== undefined) {
			this.descriptionMaxChars = Math.min(200, Math.max(20, Math.round(Number(descriptionMaxChars) || DEFAULT_DESCRIPTION_CHARS)))
		}
	}

	/**
	 * The most-used tags.
	 *
	 * Cached against the index version and SQLite's data-version: the tag tree
	 * is drawn on every overview and only changes when the library does, but
	 * another process committing maintenance must invalidate it too.
	 *
	 * @param {number} [limit] - Maximum tags.
	 * @returns {Array<{tag: string, count: number}>} The counts.
	 */
	tagCounts(limit = 200) {
		const dataVersion = this.db.dataVersion()
		if (this.tagCache.version !== this.db.version || this.tagCache.dataVersion !== dataVersion) {
			this.tagCache = { version: this.db.version, dataVersion, byLimit: new Map() }
		}
		const key = Math.max(1, Math.min(1000, Math.round(Number(limit) || 200)))
		const cached = this.tagCache.byLimit.get(key)
		if (cached !== undefined) return cached
		const rows = this.db.tagCounts(key)
		this.tagCache.byLimit.set(key, rows)
		return rows
	}


	/**
	 * Live files grouped by the last suffix in their name.
	 *
	 * A suffix is the human-facing type distinction (`.md`, `.sh`, `.png`);
	 * MIME is the transport hint and can collapse many suffixes into one.
	 * Names without a dot get an empty suffix.
	 *
	 * @returns {Array<{suffix: string, count: number}>} Counts, busiest first.
	 */
	suffixCounts() {
		return this.db.suffixCounts()
	}

	/**
	 * Calendar activity for the overview heatmap.
	 *
	 * Files, including archived ones, stay on the day they were created: the
	 * heatmap is a record of writing history, not of the current live count.
	 * The day key is local, matching the daily injection snapshot; the counts
	 * come from an index scan over the precomputed day column.
	 *
	 * @param {{days?: number, now?: Date}} [options] - Window length and clock.
	 * @returns {{activity: Array<{date: string, count: number}>, days: number, activeDays: number, notes: number}} The activity.
	 */
	activity({ days = 365, now = new Date() } = {}) {
		const rows = this.db.activityDays()
		if (rows.length === 0) return { activity: [], days: 0, activeDays: 0, notes: 0 }
		const counts = new Map(rows.map((row) => [row.day, row.count]))
		const firstParts = rows[0].day.split('-').map(Number)
		const first = new Date(firstParts[0], firstParts[1] - 1, firstParts[2]).getTime()
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
		const activity = []
		for (let offset = Math.max(1, days) - 1; offset >= 0; offset -= 1) {
			const date = new Date(today)
			date.setDate(date.getDate() - offset)
			const key = dayKey(date)
			activity.push({ date: key, count: counts.get(key) ?? 0 })
		}
		const notes = activity.reduce((sum, item) => sum + item.count, 0)
		return {
			activity,
			days: Number.isFinite(first) ? Math.max(1, Math.floor((today - first) / 86_400_000) + 1) : activity.length,
			activeDays: activity.filter((item) => item.count > 0).length,
			notes,
		}
	}

	/**
	 * Counts for the overview and the injected summary.
	 *
	 * Cached against the index version and SQLite's data-version, so both a
	 * write through this store and a commit from another connection invalidate
	 * it. The orphan count is arithmetic over two index counts instead of a
	 * per-file probe.
	 *
	 * @returns {{files: number, archived: number, links: number, tags: number, tagAssignments: number, orphans: number, mimes: Array<{mime: string, count: number}>}} The stats.
	 */
	stats() {
		const dataVersion = this.db.dataVersion()
		if (this.statsCache.version === this.db.version && this.statsCache.dataVersion === dataVersion) {
			return this.statsCache.value
		}
		const base = this.db.stats()
		const orphans = base.files + base.archived - this.db.linkedCount()
		const value = { ...base, orphans }
		this.statsCache = { version: this.db.version, dataVersion, value }
		return value
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
		const scanStartedAt = new Date().toISOString()
		const scanned = await this.scan()
		this.db.rebuild(scanned.entries, { scanStartedAt })
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
	 * Each folder is a handful of independent file-system reads (sidecar,
	 * directory listing, stat, maybe the payload for a repair), so the walk runs
	 * a bounded pool of lanes instead of one `await` at a time — the serial loop
	 * spent most of a cold start waiting on the file system. Results are
	 * collected by position, so the output keeps the directory order and stays
	 * deterministic however the lanes interleave.
	 *
	 * @returns {Promise<{entries: Array<{meta: object}>, problems: Array<{id: string, reason: string}>}>} The scan.
	 */
	async scan() {
		const names = await readdir(this.filesDir, { withFileTypes: true }).catch(() => [])
		const ids = names.filter((entry) => entry.isDirectory() && isFileId(entry.name)).map((entry) => entry.name)
		const outcomes = new Array(ids.length)
		let cursor = 0
		const lanes = Math.min(SCAN_CONCURRENCY, ids.length)
		const worker = async () => {
			for (;;) {
				const index = cursor
				cursor += 1
				if (index >= ids.length) return
				outcomes[index] = await this.scanEntity(ids[index])
			}
		}
		await Promise.all(Array.from({ length: lanes }, worker))
		const entries = []
		const problems = []
		for (const outcome of outcomes) {
			if (outcome.entry !== undefined) entries.push(outcome.entry)
			if (outcome.problem !== undefined) problems.push(outcome.problem)
		}
		return { entries, problems }
	}

	/**
	 * Read one entity folder during a scan.
	 *
	 * @param {string} id - The folder name (a file id).
	 * @returns {Promise<{entry?: {meta: object}, problem?: {id: string, reason: string}}>} What the folder yielded.
	 */
	async scanEntity(id) {
		try {
			const meta = await this.readMeta(id)
			if (meta === undefined) return { problem: { id, reason: '缺少 meta.json' } }
			const dir = this.entityDir(id)
			const dataDir = join(dir, meta.name)
			// Fast path: the sidecar names the payload and a stat confirms its
			// size, which is the healthy case for every file. A cold start is
			// three system calls per file instead of four; the directory listing
			// is only needed to diagnose a missing, renamed or resized payload.
			const direct = await lstat(dataDir).catch(() => undefined)
			if (direct !== undefined && !direct.isSymbolicLink() && direct.isFile() && direct.size === meta.bytes) {
				// The payload matches its sidecar, so no repair is needed — but the
				// full-text index still wants the head of the body, and a rebuild
				// has no other way to get it. 32 KB per file keeps this a head read
				// rather than a full-file load.
				const body = await this.readIndexableBody(dataDir, meta.mime)
				return { entry: { meta, body } }
			}
			const files = (await readdir(dir)).filter((name) => name !== META_FILE && !name.startsWith('.tmp-'))
			if (files.length === 0) return { problem: { id, reason: '没有文件本体' } }
			const payloadName = files.includes(meta.name) ? meta.name : files[0]
			const mismatch = payloadName !== meta.name
				? { id, reason: `meta 名与实际文件不一致：${meta.name} vs ${payloadName}` }
				: undefined
			const path = join(dir, payloadName)
			const info = await lstat(path)
			if (info.isSymbolicLink()) {
				return { problem: { id, reason: '拒绝符号链接（可能指向库外）' } }
			}
			if (payloadName === meta.name && info.size === meta.bytes) {
				const body = await this.readIndexableBody(path, meta.mime)
				return { entry: { meta, body }, problem: mismatch }
			}
			const buffer = await readFile(path)
			let repaired = meta
			if (payloadName !== meta.name || buffer.length !== meta.bytes) {
				// A concurrent update may have landed between our sidecar
				// read and this repair. Its record is the newer truth (the
				// write order is bytes → sidecar → index), so the scan
				// reports it instead of writing the stale snapshot back
				// over it.
				const latest = await this.readMeta(id).catch(() => undefined)
				if (latest !== undefined && latest.updated !== meta.updated) {
					repaired = latest
				} else {
					repaired = buildMeta({
						...meta,
						name: payloadName,
						mime: contentTypeOf(payloadName, buffer),
						bytes: buffer.length,
						sha256: this.hashOf(buffer),
					}, { descriptionMaxChars: this.descriptionMaxChars })
					await this.writeMeta(repaired)
				}
			}
			return { entry: { meta: repaired, body: this.indexableBody(buffer, repaired.mime) }, problem: mismatch }
		} catch (error) {
			return { problem: { id, reason: error instanceof Error ? error.message : String(error) } }
		}
	}

	/**
	 * Resolve caller link values to full ids.
	 *
	 * A full id must exist; a short suffix is accepted only when it identifies
	 * exactly one file. Unknown targets are dropped with a warning instead of
	 * failing the whole write — a dead link should not make a file unwritable.
	 *
	 * @param {unknown} values - The raw link list.
	 * @param {{selfId?: string, warnings?: string[]}} [options] - The writer's id and a sink for dropped edges.
	 * @returns {string[]} Resolved ids.
	 */
	resolveLinks(values, { selfId = '', warnings } = {}) {
		const out = []
		const seen = new Set()
		for (const raw of normalizeLinks(values)) {
			const resolved = this.resolveId(raw)
			if (resolved === undefined) {
				warnings?.push(`链接目标不存在或不唯一：${raw}`)
				continue
			}
			if (resolved === selfId) {
				warnings?.push(`不能链接到文件自己：${raw}`)
				continue
			}
			if (seen.has(resolved)) continue
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
		return this.db.resolveId(value)
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
}
