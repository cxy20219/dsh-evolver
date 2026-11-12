import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The memory store.
 *
 * Everything lives in the plugin's own folder as plain files:
 *
 *   memories.jsonl    one record per line (last line wins, deleted removes)
 *
 * Plain files were chosen over an embedded database on purpose: they are
 * readable, greppable, diffable, and they travel with the folder when it is
 * backed up or moved. The keyword index is rebuilt from them on start, so it
 * can always be thrown away and regenerated.
 *
 * Writes are debounced and serialised. Every flush writes a temporary file
 * with a unique name and renames it into place, so two flushes that overlap
 * (the debounce timer and a shutdown, say) cannot consume each other's temp
 * file. Only the collections that actually changed are rewritten.
 */

const MEMORIES_FILE = 'memories.jsonl'

/** The symbolic names a dirty mark may use. */
const MEMORIES = 'memories'

/** How long a change waits before it is written out. */
const FLUSH_DELAY_MS = 400

/** The longest wait between retries of a failed write. */
const FLUSH_RETRY_MAX_MS = 30_000

/** The longest text one record may carry; well above the 4000-char card cap. */
const MAX_RECORD_TEXT_CHARS = 64 * 1024

/** BM25 parameters. */
const BM25_K1 = 1.2
const BM25_B = 0.75

const LATIN = /[a-z0-9][a-z0-9_.-]*/gi
const CJK_RUN = /[一-鿿]+/g

/** The empty token set, shared so lookups never allocate. */
const NO_TOKENS = new Set()

/**
 * Split text into the tokens the keyword index uses.
 *
 * Latin words plus CJK bigrams: Chinese has no spaces, and a unigram index
 * over Chinese matches almost everything.
 *
 * @param {string} text - Source text.
 * @returns {string[]} Tokens.
 */
export function tokenize(text) {
	const value = String(text ?? '')
	const tokens = []
	for (const match of value.matchAll(LATIN)) tokens.push(match[0].toLowerCase())
	for (const match of value.matchAll(CJK_RUN)) {
		const run = match[0]
		if (run.length === 1) {
			tokens.push(run)
			continue
		}
		for (let index = 0; index + 2 <= run.length; index += 1) tokens.push(run.slice(index, index + 2))
	}
	return tokens
}

/**
 * Whether one log record has the field types the index expects.
 *
 * The log is append-only and written by this process, but it also arrives via
 * import and can be edited by hand. Parsing tells us it is JSON, not that it is
 * a record.
 *
 * @param {object} record - The parsed record.
 * @returns {boolean} True when every present field has the expected type.
 */
function isWellShaped(record) {
	if (record.tags !== undefined && !Array.isArray(record.tags)) return false
	if (record.tags !== undefined && record.tags.some((tag) => typeof tag !== 'string')) return false
	for (const field of ['body', 'text', 'label', 'summary']) {
		const value = record[field]
		if (value === undefined) continue
		if (typeof value !== 'string') return false
		// Cards are capped at 4000 characters when written; a body orders of
		// magnitude above that arrived from an imported log, and one such
		// record would be re-serialised into every list response.
		if (value.length > MAX_RECORD_TEXT_CHARS) return false
	}
	return true
}

/**
 * The memory store: records and a keyword index.
 */
export class MemoryDatabase {
	/**
	 * @param {{dataDir: string, logger?: object}} deps - Store dependencies.
	 */
	constructor({ dataDir, logger, folder = 'memory', logName = MEMORIES_FILE }) {
		this.dataDir = dataDir
		this.folderName = folder
		this.logName = logName
		this.logger = logger
		/** @type {Map<string, object>} */
		this.memories = new Map()
		/** @type {Map<string, Map<string, number>>} */
		this.postings = new Map()
		/** @type {Map<string, number>} */
		this.documentFrequency = new Map()
		/** @type {Map<string, Set<string>>} The tokens of one memory, for overlap checks. */
		this.tokenSets = new Map()
		/** @type {Map<string, number>} The token count of one memory. */
		this.docLengths = new Map()
		/** The total token count, kept so `averageLength` can follow the store. */
		this.totalTokens = 0
		this.averageLength = 1
		/** Which files changed since the last write. */
		this.dirty = new Set()
		/** The debounce timer; kept so a shutdown can flush it immediately. */
		this.flushTimer = undefined
		/**
		 * Bumped whenever the record set changes.
		 *
		 * Callers that derive a view of every record (the card layer builds a
		 * label for each) can cache it against this number instead of
		 * rebuilding on every read.
		 */
		this.version = 0
		/** Why the last background write failed, if it did. */
		this.lastWriteError = ''
		/** The wait before the next retry, doubled on every failure. */
		this.writeRetryDelay = FLUSH_DELAY_MS
		/** The write chain: flushes never overlap. */
		this.queue = Promise.resolve()
		/** Names the temporary files of this process. */
		this.writeSequence = 0
		/** Memory records waiting to be appended to the log. */
		this.pendingAppends = []
		/** How many records the log holds, so compaction can be decided. */
		this.logLength = 0
		/** Forces the next memory write to rewrite instead of append. */
		this.logRewrite = false
	}

	/** The folder the store owns. */
	get folder() {
		return join(this.dataDir, this.folderName)
	}

	/**
	 * Load the store from disk and build the keyword index.
	 *
	 * @returns {Promise<void>} Resolves once the store is ready.
	 */
	async init() {
		await mkdir(this.folder, { recursive: true, mode: 0o700 })
		await this.repairTornTail()
		this.logLength = 0
		this.pendingAppends = []
		this.logRewrite = false
		this.memories = await this.readMemories()
		this.rebuildIndex()
		this.version += 1
		// Whatever was on disk is the current state; nothing to write back.
		this.dirty.clear()
	}

	/**
	 * Terminate a last line that a crash left without its newline.
	 *
	 * The log is split on newlines, so a torn tail (power loss mid-append) is
	 * skipped as one broken record — fine. But the *next* append would be glued
	 * to that partial line and lost with it. Writing the missing newline first
	 * keeps the damage to the one record that was already broken.
	 *
	 * @returns {Promise<void>} Resolves when the log ends on a line boundary.
	 */
	async repairTornTail() {
		const path = join(this.folder, this.logName)
		let raw
		try {
			raw = await readFile(path, 'utf8')
		} catch {
			return
		}
		if (raw === '' || raw.endsWith('\n')) return
		await appendFile(path, '\n', { encoding: 'utf8', mode: 0o600 })
	}

	/**
	 * Read the memory log.
	 *
	 * The log is append-only: the last line for an id wins, and a line marked
	 * `deleted` removes it. That keeps a save O(1) instead of rewriting every
	 * memory, and a torn last line only costs that one record.
	 *
	 * @returns {Promise<Map<string, object>>} The live records.
	 */
	async readMemories() {
		const records = new Map()
		let broken = 0
		let raw
		try {
			raw = await readFile(join(this.folder, this.logName), 'utf8')
		} catch {
			return records
		}
		for (const line of raw.split('\n')) {
			const trimmed = line.trim()
			if (trimmed === '') continue
			this.logLength += 1
			try {
				const record = JSON.parse(trimmed)
				if (!record || typeof record.id !== 'string') continue
				// A line that parses but has the wrong shapes would blow up the
				// index build, and a throw here means the whole plugin fails to
				// activate. One bad record must cost one record, not the store.
				if (!isWellShaped(record)) {
					broken += 1
					continue
				}
				if (record.deleted === true) records.delete(record.id)
				else records.set(record.id, record)
			} catch {
				// A broken line is skipped; the rest of the log still loads.
			}
		}
		if (broken > 0) {
			this.logger?.warn?.(`dsh-evolver: 跳过了 ${broken} 条结构异常的记忆记录（字段类型不对），其余照常加载。`)
		}
		return records
	}

	/**
	 * Rebuild the keyword index from the records.
	 *
	 * The index is derived data: losing it costs one pass over the file.
	 */
	rebuildIndex() {
		this.postings = new Map()
		this.documentFrequency = new Map()
		this.tokenSets = new Map()
		this.docLengths = new Map()
		let total = 0
		for (const memory of this.memories.values()) {
			const tokens = tokenize(this.searchableText(memory))
			total += tokens.length
			const counts = new Map()
			for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
			for (const [token, count] of counts) {
				if (!this.postings.has(token)) this.postings.set(token, new Map())
				this.postings.get(token).set(memory.id, count)
				this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1)
			}
			this.tokenSets.set(memory.id, new Set(counts.keys()))
			this.docLengths.set(memory.id, tokens.length)
		}
		this.totalTokens = total
		this.averageLength = this.memories.size === 0 ? 1 : Math.max(1, total / this.memories.size)
	}

	/**
	 * The text a memory is searched by.
	 *
	 * @param {object} memory - The memory record.
	 * @returns {string} The searchable text.
	 */
	searchableText(memory) {
		return [memory.label ?? memory.l0Abstract, memory.description ?? '', memory.body ?? memory.text, memory.summary ?? memory.l1Overview, (memory.tags ?? []).join(' ')]
			.filter(value => typeof value === 'string' && value !== '')
			.join('\n')
	}

	/**
	 * The tokens of one memory.
	 *
	 * Retrieval asks for these once per candidate; computing them at index time
	 * keeps a query from re-tokenising the whole store.
	 *
	 * @param {string} id - Memory id.
	 * @returns {Set<string>} The tokens.
	 */
	tokenSet(id) {
		const known = this.tokenSets.get(id)
		if (known !== undefined) return known
		const memory = this.memories.get(id)
		if (memory === undefined) return NO_TOKENS
		const tokens = new Set(tokenize(this.searchableText(memory)))
		this.tokenSets.set(id, tokens)
		this.docLengths.set(id, tokens.size)
		return tokens
	}

	//#region memories

	/** Every memory in insertion order, without the view mapping or sorting. */
	values() {
		return [...this.memories.values()]
	}

	/** Every memory, newest first. */
	all() {
		return [...this.memories.values()].sort((left, right) => String(right.updated ?? right.updatedAt).localeCompare(String(left.updated ?? left.updatedAt)))
	}

	/**
	 * One memory by id.
	 *
	 * @param {string} id - Memory id.
	 * @returns {object | undefined} The memory.
	 */
	get(id) {
		return this.memories.get(id)
	}

	/**
	 * Store a memory and index it.
	 *
	 * @param {object} memory - The memory record.
	 * @returns {Promise<object>} The stored memory.
	 */
	async put(memory) {
		const previous = this.memories.get(memory.id)
		this.memories.set(memory.id, memory)
		this.indexOne(memory, previous)
		this.version += 1
		this.pendingAppends.push(memory)
		this.markDirty(MEMORIES)
		return memory
	}

	/**
	 * Index one memory, replacing what the previous version contributed.
	 *
	 * @param {object} memory - The memory record.
	 * @param {object} [previous] - The record it replaces.
	 */
	indexOne(memory, previous) {
		if (previous !== undefined) this.unindex(previous.id)
		if (memory === undefined) return
		const tokens = tokenize(this.searchableText(memory))
		const counts = new Map()
		for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
		for (const [token, count] of counts) {
			if (!this.postings.has(token)) this.postings.set(token, new Map())
			this.postings.get(token).set(memory.id, count)
			this.documentFrequency.set(token, this.postings.get(token).size)
		}
		this.tokenSets.set(memory.id, new Set(counts.keys()))
		this.docLengths.set(memory.id, tokens.length)
		this.totalTokens += tokens.length
		this.averageLength = this.memories.size === 0 ? 1 : Math.max(1, this.totalTokens / this.memories.size)
	}

	/**
	 * Remove one memory from the keyword index.
	 *
	 * @param {string} id - Memory id.
	 */
	unindex(id) {
		const tokens = this.tokenSets.get(id)
		if (tokens !== undefined) {
			for (const token of tokens) {
				const posting = this.postings.get(token)
				if (posting === undefined) continue
				posting.delete(id)
				if (posting.size === 0) {
					this.postings.delete(token)
					this.documentFrequency.delete(token)
				} else {
					this.documentFrequency.set(token, posting.size)
				}
			}
		}
		this.totalTokens -= this.docLengths.get(id) ?? 0
		this.tokenSets.delete(id)
		this.docLengths.delete(id)
		this.averageLength = this.memories.size === 0 ? 1 : Math.max(1, this.totalTokens / this.memories.size)
	}

	/**
	 * Remove a memory.
	 *
	 * @param {string} id - Memory id.
	 * @returns {Promise<boolean>} Whether a memory was removed.
	 */
	async remove(id) {
		const previous = this.memories.get(id)
		if (previous === undefined) return false
		this.memories.delete(id)
		this.unindex(id)
		this.version += 1
		this.pendingAppends.push({ id, deleted: true })
		this.markDirty(MEMORIES)
		return true
	}

	//#endregion

	//#region keyword search

	/**
	 * The BM25 score of a query against the index.
	 *
	 * Document lengths are read from the index instead of being recomputed per
	 * posting: a query used to tokenise every candidate document again, which
	 * made recall cost grow with the whole store rather than with the match.
	 *
	 * @param {string} query - The query text.
	 * @param {number} [limit] - Maximum hits.
	 * @returns {Array<{id: string, score: number}>} The hits, best first.
	 */
	bm25(query, limit = 50) {
		const tokens = tokenize(query)
		if (tokens.length === 0 || this.memories.size === 0) return []
		const total = this.memories.size
		const scores = new Map()
		for (const token of new Set(tokens)) {
			const posting = this.postings.get(token)
			if (posting === undefined) continue
			const df = this.documentFrequency.get(token) ?? posting.size
			const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
			for (const [id, tf] of posting) {
				if (!this.memories.has(id)) continue
				const length = Math.max(1, this.docLengths.get(id) ?? 0)
				const norm = 1 - BM25_B + BM25_B * (length / this.averageLength)
				const contribution = idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm))
				scores.set(id, (scores.get(id) ?? 0) + contribution)
			}
		}
		return [...scores.entries()]
			.map(([id, score]) => ({ id, score }))
			.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
			.slice(0, limit)
	}

	//#endregion

	//#region persistence

	/**
	 * Mark one collection as changed and schedule a write.
	 *
	 * @param {string} name - One of the symbolic collection names.
	 * @returns {void}
	 */
	markDirty(name) {
		this.dirty.add(name)
		this.scheduleFlush()
	}

	/**
	 * Write the store out, one flush at a time.
	 *
	 * @returns {Promise<void>} Resolves once the write is committed.
	 */
	flush() {
		// Chaining instead of running in parallel: two flushes sharing a temp
		// file name used to make the second rename fail with ENOENT.
		this.queue = this.queue.then(
			() => this.writeAll(),
			() => this.writeAll(),
		)
		return this.queue
	}

	/**
	 * Write a pending change away and stop the debounce timer.
	 *
	 * @returns {Promise<void>} Resolves once everything is on disk.
	 */
	async close() {
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer)
			this.flushTimer = undefined
		}
		await this.flush()
	}

	/**
	 * Write the collections that changed.
	 *
	 * @returns {Promise<void>} Resolves once every changed file is committed.
	 */
	async writeAll() {
		const pending = new Set(this.dirty)
		this.dirty.clear()
		if (pending.size === 0) return
		try {
			await mkdir(this.folder, { recursive: true, mode: 0o700 })
			if (pending.has(MEMORIES)) await this.writeMemories()
		} catch (error) {
			// Nothing was committed as a whole; keep the marks so the next
			// attempt (or the shutdown flush) retries them.
			for (const name of pending) this.dirty.add(name)
			throw error
		}
	}

	/**
	 * Write the memory log: append what changed, rewrite when it has grown
	 * enough that the dead lines outweigh the live records.
	 *
	 * @returns {Promise<void>} Resolves once the change is on disk.
	 */
	async writeMemories() {
		const appends = this.pendingAppends
		// Records saved while this write is in flight are pushed onto the same
		// array; only the first `written` belong to this pass.
		const written = appends.length
		const limit = Math.max(64, this.memories.size * 3)
		const compact = this.logRewrite || this.logLength + written > limit
		try {
			if (compact) {
				await this.writeLines(this.logName, this.memories.values())
				this.logLength = this.memories.size
				this.logRewrite = false
				// The compaction carries every record currently in memory; any
				// record saved after that snapshot stays queued for the next
				// append instead of being dropped.
				this.pendingAppends = appends.slice(written)
			} else if (written > 0) {
				await appendFile(
					join(this.folder, this.logName),
					`${appends.slice(0, written).map(record => JSON.stringify(record)).join('\n')}\n`,
					{ encoding: 'utf8', mode: 0o600 },
				)
				this.logLength += written
				this.pendingAppends = appends.slice(written)
			} else {
				this.pendingAppends = []
			}
		} catch (error) {
			// Re-queue everything (including what arrived during the attempt):
			// a duplicate line is harmless (last one wins), a lost save is not.
			this.pendingAppends = appends
			throw error
		}
	}

	/**
	 * Write a newline-delimited JSON file.
	 *
	 * @param {string} name - File name.
	 * @param {Iterable<object>} records - The records.
	 * @returns {Promise<void>} Resolves once the file is committed.
	 */
	async writeLines(name, records) {
		// Written in chunks rather than one giant string: a 5000-card log is
		// 9 MB, and building it as one string doubles the peak memory of every
		// compaction and hands the garbage collector a large object to sweep.
		const target = join(this.folder, name)
		this.writeSequence += 1
		const temp = `${target}.${process.pid}.${this.writeSequence}.tmp`
		try {
			const handle = await open(temp, 'w', 0o600)
			try {
				const batch = []
				for (const record of records) {
					batch.push(JSON.stringify(record))
					if (batch.length >= 512) {
						await handle.write(`${batch.join('\n')}\n`)
						batch.length = 0
					}
				}
				if (batch.length > 0) await handle.write(`${batch.join('\n')}\n`)
			} finally {
				await handle.close()
			}
			await rename(temp, target)
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {})
			throw error
		}
	}

	/**
	 * Schedule a write-out.
	 *
	 * The timer is deliberately *ref'd*: a plugin that exits within the debounce
	 * window would otherwise lose the memory it just accepted, because an
	 * unref'd timer does not keep the process alive long enough to write.
	 *
	 * @returns {void}
	 */
	scheduleFlush(delay = FLUSH_DELAY_MS) {
		if (this.flushTimer !== undefined) return
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined
			void this.flush().then(() => {
				this.lastWriteError = ''
				this.writeRetryDelay = FLUSH_DELAY_MS
			}, error => {
				// A failed write used to leave the changes marked dirty with no
				// timer armed, so nothing ever tried again — a full disk read as
				// a silent loss. Keep trying, backing off, and record why.
				this.lastWriteError = error instanceof Error ? error.message : String(error)
				this.logger?.warn?.(`dsh-evolver: memory write failed: ${this.lastWriteError}`)
				this.writeRetryDelay = Math.min(this.writeRetryDelay * 2, FLUSH_RETRY_MAX_MS)
				this.scheduleFlush(this.writeRetryDelay)
			})
		}, delay)
		// The first attempt is ref'd on purpose (see above); a retry is not, or
		// a disk that stays broken would keep the process alive forever.
		if (delay > FLUSH_DELAY_MS) this.flushTimer.unref?.()
	}

	//#endregion
}
