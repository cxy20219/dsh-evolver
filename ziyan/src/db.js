/**
 * The SQLite index.
 *
 * The sidecars are the source of truth; this database is a derived view built
 * from them. That ordering matters: losing `ziyan.db` costs one rebuild, not
 * the library. Every write therefore updates the sidecar first and this index
 * second, and `rebuild()` can reconstruct every table from `meta.json` plus the
 * text files.
 *
 * `node:sqlite` is used because the desktop runtime ships it (Node 24),
 * FTS5 is available, and a plugin with no native dependency is a plugin that
 * installs. The API is synchronous; at this library's scale (thousands of
 * files, not millions) a query is sub-millisecond and a write is a few.
 */

import { DatabaseSync } from 'node:sqlite'

import { matchExpression, tokenize } from './text.js'

/** The index schema version. */
export const INDEX_SCHEMA = 2

/** The separator `group_concat` joins list columns with (unit separator). */
const SEP = '\u001f'

/** The DDL. `IF NOT EXISTS` makes open idempotent; migrations bump the version. */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	mime TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	created TEXT NOT NULL,
	updated TEXT NOT NULL,
	archived INTEGER NOT NULL DEFAULT 0,
	source TEXT NOT NULL DEFAULT '',
	legacy_id TEXT
);
CREATE INDEX IF NOT EXISTS files_updated ON files(updated DESC);
CREATE INDEX IF NOT EXISTS files_mime ON files(mime);
CREATE TABLE IF NOT EXISTS links (
	from_id TEXT NOT NULL,
	to_id TEXT NOT NULL,
	PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS links_to ON links(to_id);
CREATE TABLE IF NOT EXISTS tags (
	file_id TEXT NOT NULL,
	tag TEXT NOT NULL,
	PRIMARY KEY (file_id, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
-- Only the description (and the name/tags it carries) is indexed. The body
-- is the agent's job: read the payload, parse it, understand it. This keeps
-- the index a semantic catalogue instead of a second copy of the library.
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
	id UNINDEXED,
	name,
	description,
	tokenize='unicode61'
);
`

/** The SELECT that materialises one file with its tags and outgoing links. */
const SELECT_FILE = `
SELECT f.*,
	(SELECT group_concat(tag, char(31)) FROM tags WHERE file_id = f.id) AS tag_list,
	(SELECT group_concat(to_id, char(31)) FROM links WHERE from_id = f.id) AS link_list
FROM files f
`

/**
 * Split one `group_concat` column.
 *
 * @param {unknown} value - The concatenated value.
 * @returns {string[]} The members, sorted for a deterministic read.
 */
function splitList(value) {
	if (typeof value !== 'string' || value === '') return []
	return value.split(SEP).filter((item) => item !== '').sort()
}

/**
 * Turn one database row into the metadata shape the rest of the store uses.
 *
 * @param {object} row - A row from `files` plus `tag_list`/`link_list`.
 * @returns {object} The metadata.
 */
function rowToMeta(row) {
	let source
	if (typeof row.source === 'string' && row.source !== '') {
		try {
			source = JSON.parse(row.source)
		} catch {
			source = undefined
		}
	}
	return {
		schema: 1,
		id: row.id,
		name: row.name,
		description: row.description,
		tags: splitList(row.tag_list),
		links: splitList(row.link_list),
		...(source === undefined ? {} : { source }),
		created: row.created,
		updated: row.updated,
		mime: row.mime,
		bytes: Number(row.bytes),
		sha256: row.sha256,
		archived: Number(row.archived) === 1,
		...(typeof row.legacy_id === 'string' && row.legacy_id !== '' ? { legacyId: row.legacy_id } : {}),
	}
}

/**
 * The derived index.
 */
export class IndexDatabase {
	/**
	 * @param {{path: string, logger?: object}} options - The database file and a logger.
	 */
	constructor({ path, logger }) {
		this.path = path
		this.logger = logger
		this.db = null
		this.statements = new Map()
		// Bumped on every committed change. The store caches derived views (the
		// short-id map) against it instead of rebuilding them per read.
		this.version = 0
	}

	/**
	 * Open the database and ensure the schema exists.
	 *
	 * @returns {void}
	 */
	open() {
		if (this.db !== null) return
		this.db = new DatabaseSync(this.path)
		this.db.prepare('PRAGMA journal_mode = WAL').get()
		this.db.exec('PRAGMA synchronous = NORMAL')
		this.db.exec('PRAGMA busy_timeout = 3000')
		this.db.exec(SCHEMA_SQL)
		const version = this.readMeta('schema_version')
		if (version === undefined) {
			this.writeMeta('schema_version', String(INDEX_SCHEMA))
		} else if (Number(version) !== INDEX_SCHEMA) {
			throw new Error(`自衍中枢索引版本不匹配：${String(version)} ≠ ${INDEX_SCHEMA}；请重建索引。`)
		}
	}

	/**
	 * Prepare and cache one statement.
	 *
	 * @param {string} key - The cache key.
	 * @param {string} sql - The SQL.
	 * @returns {object} The statement.
	 */
	statement(key, sql) {
		const cached = this.statements.get(key)
		if (cached !== undefined) return cached
		const statement = this.db.prepare(sql)
		this.statements.set(key, statement)
		return statement
	}

	/**
	 * Run one function inside a write transaction.
	 *
	 * @param {() => any} fn - The work.
	 * @returns {any} Whatever `fn` returned.
	 */
	transaction(fn) {
		this.db.exec('BEGIN IMMEDIATE')
		try {
			const result = fn()
			this.db.exec('COMMIT')
			return result
		} catch (error) {
			try {
				this.db.exec('ROLLBACK')
			} catch {
				// A rollback can fail when the connection is already broken; the
				// original error is the useful one.
			}
			throw error
		}
	}

	/**
	 * Read one key from the index metadata table.
	 *
	 * @param {string} key - The key.
	 * @returns {string | undefined} The value.
	 */
	readMeta(key) {
		const row = this.statement('meta-get', 'SELECT value FROM meta WHERE key = ?').get(key)
		return row === undefined ? undefined : String(row.value)
	}

	/**
	 * Write one key into the index metadata table.
	 *
	 * @param {string} key - The key.
	 * @param {string} value - The value.
	 * @returns {void}
	 */
	writeMeta(key, value) {
		this.statement(
			'meta-set',
			'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
		).run(key, String(value))
	}

	/**
	 * The text columns of one FTS row.
	 *
	 * There is no body column by design: search is a match on the semantic
	 * catalogue (name, description, tags), and the agent reads the payload for
	 * everything else. Tags are folded into the description so a tag is also a
	 * search term.
	 *
	 * @param {object} meta - The metadata.
	 * @returns {{name: string, description: string}} Tokenised columns.
	 */
	searchColumns(meta) {
		return {
			name: tokenize(meta.name).join(' '),
			description: tokenize(`${meta.description} ${(meta.tags ?? []).join(' ')}`).join(' '),
		}
	}

	/**
	 * Insert or replace one file, without opening a transaction.
	 *
	 * @param {object} meta - The metadata.
	 * @returns {void}
	 */
	upsertRow(meta) {
		this.statement(
			'files-upsert',
			`INSERT INTO files(id, name, description, mime, bytes, sha256, created, updated, archived, source, legacy_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				name = excluded.name, description = excluded.description, mime = excluded.mime,
				bytes = excluded.bytes, sha256 = excluded.sha256, created = excluded.created,
				updated = excluded.updated, archived = excluded.archived, source = excluded.source,
				legacy_id = excluded.legacy_id`,
		).run(
			meta.id,
			meta.name,
			meta.description,
			meta.mime,
			meta.bytes,
			meta.sha256,
			meta.created,
			meta.updated,
			meta.archived === true ? 1 : 0,
			meta.source === undefined ? '' : JSON.stringify(meta.source),
			meta.legacyId ?? null,
		)

		const deleteLinks = this.statement('links-delete', 'DELETE FROM links WHERE from_id = ?')
		const insertLink = this.statement('links-insert', 'INSERT OR IGNORE INTO links(from_id, to_id) VALUES (?, ?)')
		deleteLinks.run(meta.id)
		for (const target of meta.links ?? []) insertLink.run(meta.id, target)

		const deleteTags = this.statement('tags-delete', 'DELETE FROM tags WHERE file_id = ?')
		const insertTag = this.statement('tags-insert', 'INSERT OR IGNORE INTO tags(file_id, tag) VALUES (?, ?)')
		deleteTags.run(meta.id)
		for (const tag of meta.tags ?? []) insertTag.run(meta.id, tag)

		const columns = this.searchColumns(meta)
		this.statement('fts-delete', 'DELETE FROM files_fts WHERE id = ?').run(meta.id)
		this.statement(
			'fts-insert',
			'INSERT INTO files_fts(id, name, description) VALUES (?, ?, ?)',
		).run(meta.id, columns.name, columns.description)
	}

	/**
	 * Store one file, transactionally.
	 *
	 * @param {object} meta - The metadata.
	 * @returns {void}
	 */
	upsert(meta) {
		this.transaction(() => this.upsertRow(meta))
		this.version += 1
	}

	/**
	 * Remove one file from the index.
	 *
	 * Incoming links are deliberately left in place: another file's sidecar
	 * still declares the link, and the query layer marks the missing target.
	 * Outgoing links, tags and the FTS row belong to this file and go with it.
	 *
	 * @param {string} id - The file id.
	 * @returns {boolean} Whether a row existed.
	 */
	remove(id) {
		const removed = this.transaction(() => {
			const result = this.statement('files-delete', 'DELETE FROM files WHERE id = ?').run(id)
			this.statement('links-delete-from', 'DELETE FROM links WHERE from_id = ?').run(id)
			this.statement('tags-delete-file', 'DELETE FROM tags WHERE file_id = ?').run(id)
			this.statement('fts-delete-id', 'DELETE FROM files_fts WHERE id = ?').run(id)
			return Number(result.changes) > 0
		})
		this.version += 1
		return removed
	}

	/**
	 * Read one file.
	 *
	 * @param {string} id - The file id.
	 * @returns {object | undefined} The metadata.
	 */
	get(id) {
		const row = this.statement('files-get', `${SELECT_FILE} WHERE f.id = ?`).get(id)
		return row === undefined ? undefined : rowToMeta(row)
	}

	/**
	 * List files, newest first.
	 *
	 * @param {{limit?: number, offset?: number, archived?: boolean, mime?: string}} [options] - Filters.
	 * @returns {object[]} The metadata rows.
	 */
	list({ limit = 50, offset = 0, archived = false, mime = '' } = {}) {
		const capped = Math.max(1, Math.min(500, Math.round(Number(limit) || 50)))
		const skip = Math.max(0, Math.round(Number(offset) || 0))
		const sql = mime === ''
			? `${SELECT_FILE} WHERE f.archived = ? ORDER BY f.updated DESC, f.id DESC LIMIT ? OFFSET ?`
			: `${SELECT_FILE} WHERE f.archived = ? AND f.mime = ? ORDER BY f.updated DESC, f.id DESC LIMIT ? OFFSET ?`
		const rows = mime === ''
			? this.statement('files-list', sql).all(archived === true ? 1 : 0, capped, skip)
			: this.statement('files-list-mime', sql).all(archived === true ? 1 : 0, mime, capped, skip)
		return rows.map((row) => rowToMeta(row))
	}

	/**
	 * Search the keyword index.
	 *
	 * The result is deliberately only `{id, rank}`: ranking, recency, degree
	 * and snippets are policy, and policy lives in the store where it can be
	 * changed without touching the schema.
	 *
	 * @param {string} query - The query.
	 * @param {{limit?: number, includeArchived?: boolean}} [options] - Bounds.
	 * @returns {Array<{id: string, rank: number}>} The hits, best first.
	 */
	search(query, { limit = 50, includeArchived = false } = {}) {
		const match = matchExpression(tokenize(query))
		if (match === '') return []
		const capped = Math.max(1, Math.min(200, Math.round(Number(limit) || 50)))
		const sql = includeArchived
			? `SELECT files_fts.id AS id, bm25(files_fts, 0, 6, 10) AS rank
			   FROM files_fts JOIN files f ON f.id = files_fts.id
			   WHERE files_fts MATCH ? ORDER BY rank LIMIT ?`
			: `SELECT files_fts.id AS id, bm25(files_fts, 0, 6, 10) AS rank
			   FROM files_fts JOIN files f ON f.id = files_fts.id
			   WHERE files_fts MATCH ? AND f.archived = 0 ORDER BY rank LIMIT ?`
		const rows = this.statement(includeArchived ? 'search-all' : 'search-live', sql).all(match, capped)
		return rows.map((row) => ({ id: String(row.id), rank: Number(row.rank) }))
	}

	/**
	 * Incoming and outgoing degree for every file.
	 *
	 * @returns {Map<string, {in: number, out: number}>} The degrees.
	 */
	degrees() {
		const rows = this.statement(
			'degrees',
			`SELECT f.id AS id,
				(SELECT COUNT(*) FROM links l WHERE l.from_id = f.id) AS out_deg,
				(SELECT COUNT(*) FROM links l WHERE l.to_id = f.id) AS in_deg
			 FROM files f`,
		).all()
		const map = new Map()
		for (const row of rows) map.set(String(row.id), { in: Number(row.in_deg), out: Number(row.out_deg) })
		return map
	}

	/**
	 * The files that link to one id.
	 *
	 * @param {string} id - The target id.
	 * @returns {string[]} Source ids, sorted.
	 */
	backlinks(id) {
		return this.statement('backlinks', 'SELECT from_id FROM links WHERE to_id = ? ORDER BY from_id')
			.all(id)
			.map((row) => String(row.from_id))
	}

	/**
	 * Counts for the overview and the injected summary.
	 *
	 * @returns {{files: number, archived: number, links: number, tags: number, tagAssignments: number, mimes: Array<{mime: string, count: number}>}} The stats.
	 */
	stats() {
		const files = Number(this.statement('count-files', 'SELECT COUNT(*) AS c FROM files WHERE archived = 0').get().c)
		const archived = Number(this.statement('count-archived', 'SELECT COUNT(*) AS c FROM files WHERE archived = 1').get().c)
		const links = Number(this.statement('count-links', 'SELECT COUNT(*) AS c FROM links').get().c)
		// `tags` means distinct tag paths on live files; the flat tag table has
		// one row per assignment, which is a different number. Keep the latter
		// as `tagAssignments` for callers that need usage volume.
		const tags = Number(this.statement(
			'count-tags',
			'SELECT COUNT(DISTINCT tags.tag) AS c FROM tags JOIN files ON files.id = tags.file_id WHERE files.archived = 0',
		).get().c)
		const tagAssignments = Number(this.statement('count-tag-assignments', 'SELECT COUNT(*) AS c FROM tags').get().c)
		const mimes = this.statement(
			'count-mimes',
			'SELECT mime, COUNT(*) AS c FROM files WHERE archived = 0 GROUP BY mime ORDER BY c DESC, mime ASC',
		).all().map((row) => ({ mime: String(row.mime), count: Number(row.c) }))
		return { files, archived, links, tags, tagAssignments, mimes }
	}

	/**
	 * The most-used tags on live files, for the overview and `file_index`.
	 *
	 * Full paths only; the store's filter expands a parent to its descendants,
	 * but the count table stays a flat list of what was written. Archived files
	 * are excluded so the overview's tag count and tag tree describe the live
	 * library.
	 *
	 * @param {number} [limit] - Maximum tags.
	 * @returns {Array<{tag: string, count: number}>} The counts.
	 */
	tagCounts(limit = 200) {
		const capped = Math.max(1, Math.min(1000, Math.round(Number(limit) || 200)))
		return this.statement(
			'tag-counts',
			'SELECT tags.tag AS tag, COUNT(*) AS c FROM tags JOIN files ON files.id = tags.file_id WHERE files.archived = 0 GROUP BY tags.tag ORDER BY c DESC, tags.tag ASC LIMIT ?',
		).all(capped).map((row) => ({ tag: String(row.tag), count: Number(row.c) }))
	}

	/**
	 * Creation timestamps for the activity heatmap.
	 *
	 * @returns {string[]} The stored ISO timestamps.
	 */
	createdDates() {
		return this.statement('created-dates', 'SELECT created FROM files').all().map((row) => String(row.created))
	}

	/**
	 * The number of live files.
	 *
	 * @returns {number} The count.
	 */
	count() {
		return Number(this.statement('count-live', 'SELECT COUNT(*) AS c FROM files WHERE archived = 0').get().c)
	}

	/**
	 * The number of files in the index, archived included.
	 *
	 * `open()` uses this rather than `count()`: a library where every file is
	 * archived is not an empty index, and must not trigger a rebuild on every
	 * start.
	 *
	 * @returns {number} The count.
	 */
	total() {
		return Number(this.statement('count-total', 'SELECT COUNT(*) AS c FROM files').get().c)
	}

	/**
	 * Every file id in the index.
	 *
	 * Short ids are assigned against this set, so a suffix is only used when it
	 * is unique in the whole library, not just in one result page.
	 *
	 * @returns {string[]} The ids.
	 */
	ids() {
		return this.statement('ids', 'SELECT id FROM files').all().map((row) => String(row.id))
	}

	/**
	 * Replace every table from a scanned set of sidecars.
	 *
	 * @param {Array<{meta: object}>} entries - The scanned entities.
	 * @returns {void}
	 */
	rebuild(entries) {
		this.transaction(() => {
			this.db.exec('DELETE FROM files')
			this.db.exec('DELETE FROM links')
			this.db.exec('DELETE FROM tags')
			this.db.exec('DELETE FROM files_fts')
			for (const entry of entries) this.upsertRow(entry.meta)
			this.writeMeta('built_at', new Date().toISOString())
		})
		this.version += 1
	}

	/** Close the database. */
	close() {
		if (this.db === null) return
		this.statements.clear()
		this.db.close()
		this.db = null
	}
}
