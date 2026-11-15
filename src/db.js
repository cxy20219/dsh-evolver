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
 * installs. The API is synchronous.
 */

import { DatabaseSync } from 'node:sqlite'

import { dayKey } from './day.js'
import { ShortIdIndex, isFileId } from './ids.js'
import { extensionOf } from './names.js'
import { matchExpression, tokenize } from './text.js'

/** The index schema version. */
export const INDEX_SCHEMA = 3

/** The separator `group_concat` joins list columns with (unit separator). */
const SEP = '\u001f'

/**
 * How many FTS matches a search is allowed to rank.
 *
 * BM25 is computed by SQLite for every match it sorts, and a common two-word
 * query can match hundreds of thousands of descriptions; ranking all of them
 * costs seconds at a million files. A search therefore ranks a bounded window
 * of the newest matches (`rowid DESC`) and reports the best of that window.
 * The window is well above the 200 candidates the store ever asks for, so the
 * result reads as "the best recent matches" instead of "the best matches ever",
 * which is the same bias the store's own recency scoring already applies.
 */
const SEARCH_WINDOW = 5000

/** The most search candidates one call may return (the store asks for 200). */
const SEARCH_CANDIDATES = 200

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
	suffix TEXT NOT NULL DEFAULT '',
	created_day TEXT NOT NULL DEFAULT ''
);
-- Live paging is the hot path: the index holds exactly the rows the default
-- list can return, already in display order, so both COUNT and LIMIT/OFFSET
-- are index scans instead of a filtered table scan plus a sort.
CREATE INDEX IF NOT EXISTS files_live_updated ON files(updated DESC, id DESC) WHERE archived = 0;
CREATE INDEX IF NOT EXISTS files_archived_updated ON files(updated DESC, id DESC) WHERE archived = 1;
-- The type matrix and the suffix matrix aggregate the live library; these
-- covering partial indexes turn both into one ordered index scan.
CREATE INDEX IF NOT EXISTS files_live_mime ON files(mime) WHERE archived = 0;
CREATE INDEX IF NOT EXISTS files_live_suffix ON files(suffix) WHERE archived = 0;
-- The activity heatmap groups by local creation day; a covering index keeps
-- that aggregate from touching the row payload.
CREATE INDEX IF NOT EXISTS files_created_day ON files(created_day);
CREATE TABLE IF NOT EXISTS links (
	from_id TEXT NOT NULL,
	to_id TEXT NOT NULL,
	PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS links_to ON links(to_id);
CREATE TABLE IF NOT EXISTS tags (
	file_id TEXT NOT NULL,
	tag TEXT NOT NULL,
	archived INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (file_id, tag)
);
-- The tag side is read two ways: a file's own tags (the primary key) and "which
-- files carry this tag path" (this index). The third column makes the latter a
-- covering read — without it every tag hit is a random row lookup into the tag
-- table, which is what made the overview aggregates quadratic at scale.
CREATE INDEX IF NOT EXISTS tags_live ON tags(archived, tag, file_id);
-- Files that take part in at least one link, so "orphans" is a count instead of
-- a per-file probe pair. Maintained by the write path and rebuilt in bulk.
CREATE TABLE IF NOT EXISTS linked_ids (
	id TEXT PRIMARY KEY,
	archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS linked_archived ON linked_ids(archived);
-- Only the description (and the name/tags it carries) is indexed. The body
-- is the agent's job: read the payload, parse it, understand it. This keeps
-- the index a semantic catalogue instead of a second copy of the library.
--
-- The rowid is not implicit: it is the files.rowid of the row being
-- indexed. id is UNINDEXED inside FTS5, so deleting by id is a full scan,
-- while deleting by rowid is the FTS5 primary key lookup. upsertRow writes
-- with an explicit rowid for exactly that reason.
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
 * Escape the LIKE wildcards in a literal value.
 *
 * MIME prefixes are literals, so a `_` or `%` inside one must not turn into a
 * wildcard; every LIKE in this file pairs with `ESCAPE '\'`.
 *
 * @param {string} value - The literal.
 * @returns {string} The escaped literal.
 */
function escapeLike(value) {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

/**
 * Escape one literal for a GLOB pattern.
 *
 * A parent tag matches its descendants through a GLOB prefix (`工作/*`): LIKE
 * cannot use the tag index for that shape, GLOB can. Tags are free-form text,
 * so a `*`, `?`, `[` or `]` inside a tag is a literal that must be escaped as
 * a one-character class.
 *
 * @param {string} value - The literal.
 * @returns {string} The escaped literal.
 */
function escapeGlob(value) {
	return value.replace(/[*?[\]]/g, (match) => `[${match}]`)
}

/**
 * The GLOB pattern that selects one tag path and its descendants.
 *
 * @param {string} tag - The parent tag.
 * @returns {string} The pattern.
 */
function tagPattern(tag) {
	return `${escapeGlob(tag)}/*`
}

/**
 * The suffix filter value in the form the index stores it.
 *
 * @param {unknown} suffix - A caller-supplied extension without the dot.
 * @returns {string} The normalised suffix (`''` means "no extension").
 */
function normalizeSuffix(suffix) {
	return String(suffix ?? '').trim().toLowerCase()
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
	}
}

/**
 * The index's placeholder rowid for a not-yet-written file.
 *
 * @param {object} row - A statement row that should carry a rowid.
 * @returns {number} The rowid.
 */
function rowidOf(row) {
	const rowid = Number(row?.rowid)
	if (!Number.isFinite(rowid)) throw new Error('索引写入没有拿到 rowid。')
	return rowid
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
		// Bumped on every committed change. The store caches derived views
		// (stats, tag counts) against it instead of recomputing them per read.
		this.version = 0
		// The short-id index is maintained incrementally by the write path; it
		// is built from `ids()` on first use after open/rebuild.
		this.shortIndex = null
		// Whether SQLite can run the JS tokenizer as a SQL function; when it
		// cannot, the FTS bulk rebuild falls back to a per-row loop.
		this.bulkTokenizer = false
	}

	/**
	 * Open the database and ensure the schema exists.
	 *
	 * The index is derived data: a corrupt file or a schema from a future
	 * version is recoverable by rebuilding from the sidecars. Failing here must
	 * leave no connection behind, though — the recovery path renames or deletes
	 * the very file this handle has open, which Windows refuses while it is
	 * still locked.
	 *
	 * @returns {void}
	 */
	open() {
		if (this.db !== null) return
		try {
			this.db = new DatabaseSync(this.path)
			this.db.prepare('PRAGMA journal_mode = WAL').get()
			this.db.exec('PRAGMA synchronous = NORMAL')
			this.db.exec('PRAGMA busy_timeout = 3000')
			this.db.exec(SCHEMA_SQL)
			// The tokenizer is used by the bulk FTS rebuild: it turns a name or
			// description into exactly the token stream the write path stores,
			// so a rebuilt index is indistinguishable from an incrementally
			// maintained one.
			if (typeof this.db.function === 'function') {
				this.db.function('ziyan_tokens', { deterministic: true }, (value) => tokenize(String(value ?? '')).join(' '))
				this.bulkTokenizer = true
			}
			const version = this.readMeta('schema_version')
			if (version === undefined) {
				this.writeMeta('schema_version', String(INDEX_SCHEMA))
			} else if (Number(version) !== INDEX_SCHEMA) {
				throw new Error(`自衍中枢索引版本不匹配：${String(version)} ≠ ${INDEX_SCHEMA}；索引将从边车重建。`)
			}
		} catch (error) {
			this.close()
			throw error
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
	 * SQLite's cross-connection change counter.
	 *
	 * `this.version` only counts writes made through this connection. Cached
	 * views also need to notice maintenance that commits elsewhere (a repair
	 * script, or another host on the same data directory): SQLite bumps this
	 * pragma when another connection writes, and leaves it alone for our own
	 * writes, so reading it is cheap enough to do per cached read.
	 *
	 * @returns {number} The connection's data-version counter; 0 when closed.
	 */
	dataVersion() {
		if (this.db === null) return 0
		const row = this.statement('data-version', 'PRAGMA data_version').get()
		return Number(row?.data_version) || 0
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
	 * The tags linked from one file, before a write replaces them.
	 *
	 * @param {string} id - The file id.
	 * @returns {string[]} Target ids.
	 */
	oldLinks(id) {
		return this.statement('links-from', 'SELECT to_id FROM links WHERE from_id = ?')
			.all(id)
			.map((row) => String(row.to_id))
	}

	/**
	 * Insert or replace the file row, its links and its tags.
	 *
	 * This is the part of a write every caller needs; the FTS row and the
	 * derived link bookkeeping are layered on top by `upsertRow` because a
	 * rebuild writes thousands of rows and then rebuilds those derived tables
	 * in bulk instead of row by row.
	 *
	 * @param {object} meta - The metadata.
	 * @returns {{rowid: number, oldTargets: string[]}} The rowid and the replaced outgoing links.
	 */
	writeCore(meta) {
		const oldTargets = this.oldLinks(meta.id)
		const row = this.statement(
			'files-upsert',
			`INSERT INTO files(id, name, description, mime, bytes, sha256, created, updated, archived, source, suffix, created_day)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				name = excluded.name, description = excluded.description, mime = excluded.mime,
				bytes = excluded.bytes, sha256 = excluded.sha256, created = excluded.created,
				updated = excluded.updated, archived = excluded.archived, source = excluded.source,
				suffix = excluded.suffix, created_day = excluded.created_day
			 RETURNING rowid`,
		).get(
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
			extensionOf(meta.name),
			dayKey(new Date(meta.created)),
		)
		const insertLink = this.statement('links-insert', 'INSERT OR IGNORE INTO links(from_id, to_id) VALUES (?, ?)')
		this.statement('links-delete', 'DELETE FROM links WHERE from_id = ?').run(meta.id)
		for (const target of meta.links ?? []) insertLink.run(meta.id, target)
		const archived = meta.archived === true ? 1 : 0
		const insertTag = this.statement('tags-insert', 'INSERT OR IGNORE INTO tags(file_id, tag, archived) VALUES (?, ?, ?)')
		this.statement('tags-delete', 'DELETE FROM tags WHERE file_id = ?').run(meta.id)
		for (const tag of meta.tags ?? []) insertTag.run(meta.id, tag, archived)
		return { rowid: rowidOf(row), oldTargets }
	}

	/**
	 * Insert or replace one file, without opening a transaction.
	 *
	 * @param {object} meta - The metadata.
	 * @returns {void}
	 */
	upsertRow(meta) {
		const { rowid, oldTargets } = this.writeCore(meta)
		const columns = this.searchColumns(meta)
		this.statement('fts-delete-rowid', 'DELETE FROM files_fts WHERE rowid = ?').run(rowid)
		this.statement(
			'fts-insert',
			'INSERT INTO files_fts(rowid, id, name, description) VALUES (?, ?, ?, ?)',
		).run(rowid, meta.id, columns.name, columns.description)
		this.refreshLinked([meta.id, ...oldTargets, ...(meta.links ?? [])])
	}

	/**
	 * Refresh the `linked_ids` rows of the files a write may have touched.
	 *
	 * A link change moves one file's outgoing edge, so the file itself and the
	 * old/new targets are the only rows whose "has at least one edge" state can
	 * change. Each is a key lookup plus one small write.
	 *
	 * @param {string[]} ids - Candidate ids (duplicates are fine).
	 * @returns {void}
	 */
	refreshLinked(ids) {
		const status = this.statement(
			'linked-status',
			`SELECT f.archived AS archived,
				EXISTS (SELECT 1 FROM links l WHERE l.from_id = f.id) AS outgoing,
				EXISTS (SELECT 1 FROM links l WHERE l.to_id = f.id) AS incoming
			 FROM files f WHERE f.id = ?`,
		)
		const remove = this.statement('linked-delete', 'DELETE FROM linked_ids WHERE id = ?')
		const upsert = this.statement(
			'linked-upsert',
			'INSERT INTO linked_ids(id, archived) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET archived = excluded.archived',
		)
		for (const id of new Set(ids)) {
			if (typeof id !== 'string' || id === '') continue
			const row = status.get(id)
			if (row === undefined || (Number(row.outgoing) === 0 && Number(row.incoming) === 0)) {
				remove.run(id)
			} else {
				upsert.run(id, Number(row.archived))
			}
		}
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
		this.shortIndex?.add(meta.id)
	}

	/**
	 * Remove one file from the index.
	 *
	 * Incoming links are deliberately left in place: another file's sidecar
	 * still declares the link, and the query layer marks the missing target.
	 * Outgoing links, tags, the FTS row and the link bookkeeping for this file
	 * go with it.
	 *
	 * @param {string} id - The file id.
	 * @returns {boolean} Whether a row existed.
	 */
	remove(id) {
		const removed = this.transaction(() => {
			const oldTargets = this.oldLinks(id)
			const row = this.statement('files-delete-rowid', 'DELETE FROM files WHERE id = ? RETURNING rowid').get(id)
			this.statement('links-delete-from', 'DELETE FROM links WHERE from_id = ?').run(id)
			this.statement('tags-delete-file', 'DELETE FROM tags WHERE file_id = ?').run(id)
			if (row !== undefined) {
				this.statement('fts-delete-by-rowid', 'DELETE FROM files_fts WHERE rowid = ?').run(rowidOf(row))
			}
			this.refreshLinked([id, ...oldTargets])
			return row !== undefined
		})
		this.version += 1
		this.shortIndex?.remove(id)
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
	 * The short-id index, built from the current ids on first use.
	 *
	 * @returns {ShortIdIndex} The index.
	 */
	shortIdIndex() {
		if (this.shortIndex === null) this.shortIndex = new ShortIdIndex(this.ids())
		return this.shortIndex
	}

	/**
	 * The display suffix of one id.
	 *
	 * @param {string} id - The full id.
	 * @returns {string} The suffix (or the full id when no suffix is unique).
	 */
	shortFor(id) {
		return this.shortIdIndex().shortOf(id)
	}

	/**
	 * Resolve one id or unique suffix.
	 *
	 * A full id must exist; a shorter value is accepted only when exactly one
	 * file id ends with it.
	 *
	 * @param {unknown} value - The id or suffix.
	 * @returns {string | undefined} The full id.
	 */
	resolveId(value) {
		const raw = String(value ?? '').trim()
		if (raw === '') return undefined
		if (isFileId(raw)) return this.get(raw) === undefined ? undefined : raw
		return this.shortIdIndex().resolve(raw)
	}

	/**
	 * Page through files, newest first, with every filter applied in SQL.
	 *
	 * The filters live here rather than in the store because the total has to be
	 * the real total: a library of thousands of files cannot be listed by
	 * fetching a fixed window and filtering in memory — that window becomes the
	 * library's apparent size, and no offset past it returns anything.
	 *
	 * Two phases: first the ids of the page (an index walk with no row payload
	 * and no `group_concat` projections), then one batched lookup for exactly
	 * those rows. The old one-phase query projected every skipped row through
	 * two correlated subqueries, which made deep offsets linear in the offset.
	 *
	 * @param {{limit?: number, offset?: number, archived?: boolean, mime?: string, tags?: string[], suffix?: string | null}} [options] - Filters. `suffix` is an extension without the dot; `''` selects names with no extension, `null` disables the filter.
	 * @returns {{total: number, rows: object[]}} The total that matches, and one page.
	 */
	page({ limit = 50, offset = 0, archived = false, mime = '', tags = [], suffix = null } = {}) {
		const capped = Math.max(1, Math.min(500, Math.round(Number(limit) || 50)))
		const skip = Math.max(0, Math.round(Number(offset) || 0))
		const wanted = (Array.isArray(tags) ? tags : []).filter((tag) => typeof tag === 'string' && tag !== '')
		const clauses = ['f.archived = ?']
		const values = [archived === true ? 1 : 0]
		if (mime !== '') {
			if (mime.endsWith('/')) {
				clauses.push("f.mime LIKE ? ESCAPE '\\'")
				values.push(`${escapeLike(mime)}%`)
			} else {
				clauses.push('f.mime = ?')
				values.push(mime)
			}
		}
		const suffixValue = typeof suffix === 'string' ? normalizeSuffix(suffix) : null
		if (suffixValue !== null) {
			clauses.push('f.suffix = ?')
			values.push(suffixValue)
		}
		// A parent tag matches its descendants: `工作` selects `工作/项目/x`.
		const tagClause = '(t.tag = ? OR t.tag GLOB ?)'
		const tagExists = `EXISTS (SELECT 1 FROM tags t WHERE t.file_id = f.id AND ${tagClause})`
		for (const tag of wanted) {
			clauses.push(tagExists)
			values.push(tag, tagPattern(tag))
		}
		const where = clauses.join(' AND ')

		// The total. Without a tag filter the page query's own WHERE counts the
		// partial index; with one, counting from the tag index avoids one random
		// probe per candidate file (the shape that made tag pages seconds long).
		let total
		if (wanted.length > 0 && mime === '' && suffixValue === null) {
			const archivedValue = archived === true ? 1 : 0
			const ownTagClause = '(tag = ? OR tag GLOB ?)'
			const tagSql = `SELECT file_id FROM tags WHERE archived = ? AND ${ownTagClause}`
			const tagValues = wanted.flatMap((tag) => [archivedValue, tag, tagPattern(tag)])
			if (wanted.length === 1) {
				total = Number(this.statement(
					'count-tag',
					`SELECT COUNT(DISTINCT file_id) AS c FROM tags WHERE archived = ? AND ${ownTagClause}`,
				).get(...tagValues).c)
			} else {
				total = Number(this.statement(
					`count-tags ${wanted.length}`,
					`SELECT COUNT(*) AS c FROM (${wanted.map(() => tagSql).join(' INTERSECT ')})`,
				).get(...tagValues).c)
			}
		} else {
			total = Number(this.statement(`count ${where}`, `SELECT COUNT(*) AS c FROM files f WHERE ${where}`)
				.get(...values).c)
		}

		const idsSql = `SELECT f.id AS id FROM files f WHERE ${where} ORDER BY f.updated DESC, f.id DESC LIMIT ? OFFSET ?`
		const ids = this.statement(`page-ids ${where}`, idsSql).all(...values, capped, skip)
			.map((row) => String(row.id))
		if (ids.length === 0) return { total, rows: [] }
		const marks = ids.map(() => '?').join(',')
		const fetched = this.statement(`page-rows ${ids.length}`, `${SELECT_FILE} WHERE f.id IN (${marks})`).all(...ids)
		const byId = new Map(fetched.map((row) => [String(row.id), rowToMeta(row)]))
		return { total, rows: ids.map((id) => byId.get(id)).filter((row) => row !== undefined) }
	}

	/**
	 * The SQL WHERE fragment for the read-path filters a search shares with a
	 * list, plus its values.
	 *
	 * @param {{includeArchived?: boolean, mime?: string, suffix?: string | null, tags?: string[]}} options - The filters.
	 * @returns {{sql: string, values: unknown[]}} The fragment (already prefixed with ` AND `) and values.
	 */
	searchFilter({ includeArchived = false, mime = '', suffix = null, tags = [] } = {}) {
		const clauses = []
		const values = []
		if (includeArchived !== true) clauses.push('f.archived = 0')
		if (typeof mime === 'string' && mime !== '') {
			if (mime.endsWith('/')) {
				clauses.push("f.mime LIKE ? ESCAPE '\\'")
				values.push(`${escapeLike(mime)}%`)
			} else {
				clauses.push('f.mime = ?')
				values.push(mime)
			}
		}
		const suffixValue = typeof suffix === 'string' ? normalizeSuffix(suffix) : null
		if (suffixValue !== null) {
			clauses.push('f.suffix = ?')
			values.push(suffixValue)
		}
		const tagClause = '(t.tag = ? OR t.tag GLOB ?)'
		for (const tag of Array.isArray(tags) ? tags : []) {
			if (typeof tag !== 'string' || tag === '') continue
			// The tag filter runs before the candidate window: taking the newest
			// N matches *then* filtering by tag is how a multi-tag document's
			// length penalty used to push every tagged hit out of the window and
			// return zero results.
			//
			// No archive column check here: the file-side filter already pins
			// `f.archived`, and each file's tag rows carry its archive state, so
			// the correlated lookup stays a primary-key probe (`file_id` is the
			// first key column). Adding `t.archived = 0` makes SQLite prefer the
			// tag-path index instead and turns the probe into a scan of every
			// live tag row — measured 3.9 s per query at 10k files.
			clauses.push(`EXISTS (SELECT 1 FROM tags t WHERE t.file_id = f.id AND ${tagClause})`)
			values.push(tag, tagPattern(tag))
		}
		return { sql: clauses.length === 0 ? '' : ` AND ${clauses.join(' AND ')}`, values }
	}

	/**
	 * Rank one FTS expression over a bounded window of its matches.
	 *
	 * The inner subquery selects the newest {@link SEARCH_WINDOW} matches
	 * without ranking them (FTS5 walks the match list in rowid order and stops);
	 * the outer query ranks only that window. Ranking every match is what made
	 * common words take seconds at scale.
	 *
	 * @param {string} expression - The MATCH expression.
	 * @param {{sql: string, values: unknown[]}} filter - The filter fragment.
	 * @param {number} limit - How many ranked candidates to return.
	 * @returns {Array<{id: string, rank: number}>} The hits, best first.
	 */
	searchWindow(expression, filter, limit) {
		const sql = `SELECT id, rank FROM (
			SELECT f.id AS id, bm25(files_fts, 0, 6, 10) AS rank
			FROM files_fts JOIN files f ON f.rowid = files_fts.rowid
			WHERE files_fts MATCH ?${filter.sql}
			ORDER BY files_fts.rowid DESC
			LIMIT ?
		) ORDER BY rank LIMIT ?`
		return this.statement(`search-window ${filter.sql}`, sql)
			.all(expression, ...filter.values, SEARCH_WINDOW, limit)
			.map((row) => ({ id: String(row.id), rank: Number(row.rank) }))
	}

	/**
	 * Search the keyword index.
	 *
	 * A query with several words first requires all of them (AND): that is the
	 * precise reading of a multi-word query, and the candidates are then ranked
	 * inside the same bounded window. Only when the AND reading cannot fill the
	 * requested page does the query widen to OR, which is what keeps a natural
	 * language question ("reverse proxy rewrites Host") from matching nothing.
	 * A file that matches one word is still findable — it is just ranked after
	 * the files that match every word.
	 *
	 * The result is deliberately only `{id, rank}`: ranking, recency, degree
	 * and snippets are policy, and policy lives in the store where it can be
	 * changed without touching the schema.
	 *
	 * @param {string} query - The query.
	 * @param {{limit?: number, includeArchived?: boolean, tags?: string[], mime?: string, suffix?: string | null}} [options] - Bounds and filters.
	 * @returns {Array<{id: string, rank: number}>} The hits, best first.
	 */
	search(query, { limit = 50, includeArchived = false, tags = [], mime = '', suffix = null } = {}) {
		const tokens = [...new Set(tokenize(query).filter((token) => token !== ''))]
		if (tokens.length === 0) return []
		const capped = Math.max(1, Math.min(SEARCH_CANDIDATES, Math.round(Number(limit) || 50)))
		const filter = this.searchFilter({ includeArchived, mime, suffix, tags })
		const quoted = tokens.map((token) => `"${token.replace(/"/g, '')}"`)
		const orExpression = quoted.join(' OR ')
		const primary = tokens.length > 1 ? quoted.join(' AND ') : orExpression
		const rows = this.searchWindow(primary, filter, capped)
		if (tokens.length === 1 || rows.length >= capped) return rows
		// Fewer all-word matches than one page: widen to OR and append the new
		// ids, keeping the AND hits (and their, better, scores) ahead of them.
		const wider = this.searchWindow(orExpression, filter, capped)
		const seen = new Set(rows.map((row) => row.id))
		for (const row of wider) {
			if (rows.length >= capped) break
			if (seen.has(row.id)) continue
			seen.add(row.id)
			rows.push(row)
		}
		return rows
	}

	/**
	 * Incoming and outgoing degree for a set of files.
	 *
	 * Two grouped index scans for the requested ids — no per-file correlated
	 * subquery and no library-wide map. Read paths ask for exactly the rows
	 * they are about to show.
	 *
	 * @param {string[]} ids - The file ids.
	 * @returns {Map<string, {in: number, out: number}>} Degree per id that exists (zeros included).
	 */
	degreesFor(ids) {
		const unique = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)))]
		const map = new Map()
		if (unique.length === 0) return map
		for (const id of unique) map.set(id, { in: 0, out: 0 })
		const marks = unique.map(() => '?').join(',')
		const outRows = this.statement(
			`degrees-out ${unique.length}`,
			`SELECT from_id AS id, COUNT(*) AS c FROM links WHERE from_id IN (${marks}) GROUP BY from_id`,
		).all(...unique)
		for (const row of outRows) {
			const entry = map.get(String(row.id))
			if (entry !== undefined) entry.out = Number(row.c)
		}
		const inRows = this.statement(
			`degrees-in ${unique.length}`,
			`SELECT to_id AS id, COUNT(*) AS c FROM links WHERE to_id IN (${marks}) GROUP BY to_id`,
		).all(...unique)
		for (const row of inRows) {
			const entry = map.get(String(row.id))
			if (entry !== undefined) entry.in = Number(row.c)
		}
		return map
	}

	/**
	 * How many files take part in at least one link.
	 *
	 * @param {{archived?: boolean}} [options] - Restrict to one archive state.
	 * @returns {number} The count.
	 */
	linkedCount({ archived } = {}) {
		if (archived === true) {
			return Number(this.statement('linked-count-archived', 'SELECT COUNT(*) AS c FROM linked_ids WHERE archived = 1').get().c)
		}
		if (archived === false) {
			return Number(this.statement('linked-count-live', 'SELECT COUNT(*) AS c FROM linked_ids WHERE archived = 0').get().c)
		}
		return Number(this.statement('linked-count', 'SELECT COUNT(*) AS c FROM linked_ids').get().c)
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
	 * Every live file and every link between them, for the graph views.
	 *
	 * The panel draws the whole library, so the snapshot cannot be one page of
	 * it: a graph that stops at a page boundary shows a shape the library does
	 * not have. The node cap stays because the canvas is not a database — the
	 * caller reports what was left out.
	 *
	 * Edges are read from the node set's side only: an edge whose source is
	 * outside the cap is dropped by the caller anyway, and reading the whole
	 * `links` table (a million rows at 1M) to filter it in JS is what made the
	 * old snapshot allocate hundreds of megabytes.
	 *
	 * @param {{limit?: number}} [options] - The node cap.
	 * @returns {{rows: object[], edges: Array<{from: string, to: string}>}} The snapshot.
	 */
	snapshot({ limit = 3000 } = {}) {
		const capped = Math.max(1, Math.min(5000, Math.round(Number(limit) || 3000)))
		const rows = this.statement(
			'graph-nodes',
			`${SELECT_FILE} WHERE f.archived = 0 ORDER BY f.updated DESC, f.id DESC LIMIT ?`,
		).all(capped)
		const ids = rows.map((row) => String(row.id))
		if (ids.length === 0) return { rows: [], edges: [] }
		const marks = ids.map(() => '?').join(',')
		const inSet = new Set(ids)
		const edges = this.statement(
			`graph-edges ${ids.length}`,
			`SELECT from_id, to_id FROM links WHERE from_id IN (${marks})`,
		).all(...ids)
			.map((row) => ({ from: String(row.from_id), to: String(row.to_id) }))
			.filter((edge) => inSet.has(edge.to))
		return { rows: rows.map((row) => rowToMeta(row)), edges }
	}

	/**
	 * Counts for the overview and the injected summary.
	 *
	 * Every count is a covering index scan or a small table scan; none of them
	 * joins the wide `files` row back to another table.
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
			'SELECT COUNT(*) AS c FROM (SELECT tag FROM tags WHERE archived = 0 GROUP BY tag)',
		).get().c)
		const tagAssignments = Number(this.statement('count-tag-assignments', 'SELECT COUNT(*) AS c FROM tags').get().c)
		const mimes = this.statement(
			'count-mimes',
			'SELECT mime, COUNT(*) AS c FROM files WHERE archived = 0 GROUP BY mime ORDER BY c DESC, mime ASC',
		).all().map((row) => ({ mime: String(row.mime), count: Number(row.c) }))
		return { files, archived, links, tags, tagAssignments, mimes }
	}

	/**
	 * What a tidy-up would touch: orphans, dangling links and stale files.
	 *
	 * Each count and its sample come from the same WHERE, so the number on a
	 * card always matches the list under it.
	 *
	 * @param {{staleBefore: string, sample?: number}} options - The staleness cut-off and how many samples to return.
	 * @returns {{orphans: object, dangling: object, stale: object}} Counts with samples.
	 */
	organize({ staleBefore, sample = 5 } = {}) {
		const take = Math.max(1, Math.min(20, Math.round(Number(sample) || 5)))
		const rows = (sql, ...values) => this.statement(sql, sql).all(...values).map((row) => rowToMeta(row))
		const count = (sql, ...values) => Number(this.statement(sql, sql).get(...values).c)
		const all = (sql, ...values) => this.statement(sql, sql).all(...values)

		// Orphans: no outgoing and no incoming edge, so the library has nothing
		// to find them by except a search. Both sides of the count are index
		// scans over the `linked_ids` bookkeeping, not a probe per file.
		const orphanWhere = 'f.archived = 0 AND NOT EXISTS (SELECT 1 FROM linked_ids l WHERE l.id = f.id)'
		// Stale: untouched for longer than the caller's cut-off.
		const staleWhere = 'f.archived = 0 AND f.updated < ?'
		// Dangling: a sidecar still names a target that no longer exists. The
		// store never creates one, but a delete or a hand-edited sidecar can.
		const danglingJoins = 'FROM links l LEFT JOIN files f ON f.id = l.to_id WHERE f.id IS NULL'

		return {
			orphans: {
				total: count(`SELECT (SELECT COUNT(*) FROM files WHERE archived = 0)
					- (SELECT COUNT(*) FROM linked_ids WHERE archived = 0) AS c`),
				files: rows(`${SELECT_FILE} WHERE ${orphanWhere} ORDER BY f.updated ASC LIMIT ?`, take),
			},
			stale: {
				total: count(`SELECT COUNT(*) AS c FROM files f WHERE ${staleWhere}`, staleBefore),
				files: rows(`${SELECT_FILE} WHERE ${staleWhere} ORDER BY f.updated ASC LIMIT ?`, staleBefore, take),
			},
			dangling: {
				total: count(`SELECT COUNT(*) AS c ${danglingJoins}`),
				links: all(`SELECT l.from_id AS from_id, l.to_id AS to_id ${danglingJoins} ORDER BY l.from_id LIMIT ?`, take)
					.map((row) => ({ from: String(row.from_id), to: String(row.to_id) })),
			},
		}
	}

	/**
	 * The most-used tags on live files, for the overview and `file_search`.
	 *
	 * Full paths only; the store's filter expands a parent to its descendants,
	 * but the count table stays a flat list of what was written. Archived files
	 * are excluded so the overview's tag count and tag tree describe the live
	 * library. The covering `tags_live` index makes this one ordered scan of the
	 * live tag rows.
	 *
	 * @param {number} [limit] - Maximum tags.
	 * @returns {Array<{tag: string, count: number}>} The counts.
	 */
	tagCounts(limit = 200) {
		const capped = Math.max(1, Math.min(1000, Math.round(Number(limit) || 200)))
		return this.statement(
			'tag-counts',
			'SELECT tag, COUNT(*) AS c FROM tags WHERE archived = 0 GROUP BY tag ORDER BY c DESC, tag ASC LIMIT ?',
		).all(capped).map((row) => ({ tag: String(row.tag), count: Number(row.c) }))
	}

	/**
	 * Live files grouped by the last suffix in their name.
	 *
	 * The suffix is maintained as a column because it is what the type matrix
	 * groups by; the partial index makes the aggregate one ordered scan instead
	 * of shipping every name to JavaScript.
	 *
	 * @returns {Array<{suffix: string, count: number}>} Counts, busiest first.
	 */
	suffixCounts() {
		return this.statement(
			'suffix-counts',
			'SELECT suffix, COUNT(*) AS c FROM files WHERE archived = 0 GROUP BY suffix',
		).all()
			.map((row) => ({ suffix: String(row.suffix), count: Number(row.c) }))
			.sort((left, right) => right.count - left.count || left.suffix.localeCompare(right.suffix))
	}

	/**
	 * Creation counts per local day, for the activity heatmap.
	 *
	 * Archived files count too: the heatmap is a record of writing history, not
	 * of the current live count. The day key is local, matching the daily
	 * injection snapshot; it is precomputed on write so this is one index scan.
	 *
	 * @returns {Array<{day: string, count: number}>} Counts, oldest first.
	 */
	activityDays() {
		return this.statement(
			'activity-days',
			'SELECT created_day AS day, COUNT(*) AS c FROM files GROUP BY created_day ORDER BY created_day ASC',
		).all().map((row) => ({ day: String(row.day), count: Number(row.c) }))
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
	 * Short ids are derived from this set, so a suffix is only used when it is
	 * unique in the whole library, not just in one result page.
	 *
	 * @returns {string[]} The ids.
	 */
	ids() {
		return this.statement('ids', 'SELECT id FROM files').all().map((row) => String(row.id))
	}

	/**
	 * Rebuild the FTS table from the current rows.
	 *
	 * One `DELETE` plus one `INSERT ... SELECT`: the tokenizer is exposed to
	 * SQLite as a function, so the whole index is built inside SQLite instead of
	 * round-tripping every row through JavaScript. The rowid is taken from
	 * `files`, which keeps the delete path a primary-key lookup.
	 *
	 * @returns {void}
	 */
	rebuildFts() {
		this.db.exec('DELETE FROM files_fts')
		if (this.bulkTokenizer) {
			this.db.exec(`INSERT INTO files_fts(rowid, id, name, description)
				SELECT f.rowid, f.id, ziyan_tokens(f.name),
					ziyan_tokens(f.description || ' ' || COALESCE((SELECT group_concat(tag, ' ') FROM tags WHERE file_id = f.id), ''))
				FROM files f`)
			return this.ftsCount()
		}
		const insert = this.statement(
			'fts-insert',
			'INSERT INTO files_fts(rowid, id, name, description) VALUES (?, ?, ?, ?)',
		)
		const source = this.statement(
			'fts-source',
			`SELECT f.rowid AS rowid, f.id AS id, f.name AS name, f.description AS description,
				(SELECT group_concat(tag, ' ') FROM tags WHERE file_id = f.id) AS tag_list
			 FROM files f`,
		)
		for (const row of source.all()) {
			const columns = this.searchColumns({
				name: row.name,
				description: row.description,
				tags: typeof row.tag_list === 'string' && row.tag_list !== '' ? row.tag_list.split(' ') : [],
			})
			insert.run(rowidOf(row), String(row.id), columns.name, columns.description)
		}
		return this.ftsCount()
	}

	/**
	 * The number of FTS rows, for a rebuild's self-check.
	 *
	 * @returns {number} The count.
	 */
	ftsCount() {
		return Number(this.statement('count-fts', 'SELECT COUNT(*) AS c FROM files_fts').get().c)
	}

	/**
	 * Rebuild the "files with at least one link" set from the current links.
	 *
	 * @returns {number} The number of linked files.
	 */
	rebuildLinkedIds() {
		this.db.exec('DELETE FROM linked_ids')
		this.db.exec(`INSERT INTO linked_ids(id, archived)
			SELECT f.id, f.archived FROM files f
			WHERE f.id IN (SELECT from_id FROM links) OR f.id IN (SELECT to_id FROM links)`)
		return this.linkedCount()
	}

	/**
	 * Reconcile every table from a scanned set of sidecars.
	 *
	 * The index is derived, so the scan is authoritative for the rows it saw —
	 * but clearing every table first used to erase a file created while the
	 * scan was walking the folders: its `create()` had already written the row,
	 * and the rebuild transaction dropped it and re-inserted only the older
	 * snapshot. Nothing rebuilt the index again (`open()` sees a non-empty DB),
	 * so the file stayed invisible to `file_search` until someone
	 * deleted the database and gambled on the same window.
	 *
	 * Only rows the scan did not see *and* that are older than the start of the
	 * scan are removed. An unseen row newer than that is a concurrent write
	 * whose sidecar was not in the snapshot — it is the newer truth and stays.
	 *
	 * The FTS table and the link bookkeeping are derived from the reconciled
	 * tables in bulk after the row loop, so a rebuild is one linear pass instead
	 * of a per-row delete-and-insert into FTS.
	 *
	 * @param {Array<{meta: object}>} entries - The scanned entities.
	 * @param {{scanStartedAt?: string}} [options] - When the scan snapshot began.
	 * @returns {void}
	 */
	rebuild(entries, { scanStartedAt = new Date().toISOString() } = {}) {
		this.transaction(() => {
			const seen = new Set()
			for (const entry of entries) {
				this.writeCore(entry.meta)
				seen.add(entry.meta.id)
			}
			const stale = this.statement('files-stale', 'SELECT id FROM files WHERE updated < ?')
				.all(scanStartedAt)
				.map((row) => String(row.id))
				.filter((id) => !seen.has(id))
			if (stale.length > 0) {
				const deleteFile = this.statement('files-delete', 'DELETE FROM files WHERE id = ?')
				const deleteLinks = this.statement('links-delete-from', 'DELETE FROM links WHERE from_id = ?')
				const deleteTags = this.statement('tags-delete-file', 'DELETE FROM tags WHERE file_id = ?')
				for (const id of stale) {
					deleteFile.run(id)
					deleteLinks.run(id)
					deleteTags.run(id)
				}
			}
			this.rebuildFts()
			this.rebuildLinkedIds()
			this.writeMeta('built_at', new Date().toISOString())
		})
		this.version += 1
		this.shortIndex = null
	}

	/** Close the database. */
	close() {
		if (this.db === null) return
		this.statements.clear()
		this.db.close()
		this.db = null
	}
}
