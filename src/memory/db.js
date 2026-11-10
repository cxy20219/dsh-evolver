import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The memory store.
 *
 * Everything lives in the plugin's own folder as plain files:
 *
 *   memories.jsonl    one memory per line
 *   reflections.jsonl one reflection per line
 *   learnings.jsonl   one self-improvement entry per line
 *   edges.jsonl       one edge per line
 *   vectors.json      embedding vectors, keyed by memory id
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
const REFLECTIONS_FILE = 'reflections.jsonl'
const LEARNINGS_FILE = 'learnings.jsonl'
const VECTORS_FILE = 'vectors.json'
const EDGES_FILE = 'edges.jsonl'

/** The symbolic names a dirty mark may use. */
const MEMORIES = 'memories'
const REFLECTIONS = 'reflections'
const LEARNINGS = 'learnings'
const VECTORS = 'vectors'
const EDGES = 'edges'

/** How long a change waits before it is written out. */
const FLUSH_DELAY_MS = 400

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
 * Encode a vector as base64 of its 32-bit floats.
 *
 * The previous format was a JSON array of numbers, which costs roughly two
 * and a half times the bytes of the binary payload and is slower to parse.
 *
 * @param {Float32Array | number[]} vector - The vector.
 * @returns {string} The encoded vector.
 */
export function encodeVector(vector) {
	const view = vector instanceof Float32Array ? vector : Float32Array.from(vector)
	return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64')
}

/**
 * Decode a stored vector, accepting both the current and the old format.
 *
 * @param {unknown} value - The stored value.
 * @returns {Float32Array | undefined} The vector.
 */
export function decodeVector(value) {
	if (typeof value === 'string') {
		const buffer = Buffer.from(value, 'base64')
		if (buffer.byteLength === 0 || buffer.byteLength % 4 !== 0) return undefined
		return new Float32Array(Uint8Array.from(buffer).buffer)
	}
	if (Array.isArray(value)) return Float32Array.from(value)
	return undefined
}

/**
 * The memory store: records, a keyword index, and the vectors.
 */
export class MemoryDatabase {
	/**
	 * @param {{dataDir: string, embedder?: object, logger?: object}} deps - Store dependencies.
	 */
	constructor({ dataDir, embedder, logger }) {
		this.dataDir = dataDir
		this.embedder = embedder
		this.logger = logger
		/** @type {Map<string, object>} */
		this.memories = new Map()
		/** @type {Map<string, object>} */
		this.reflections = new Map()
		/** @type {Map<string, object>} */
		this.learnings = new Map()
		/** @type {Map<string, Float32Array>} */
		this.vectors = new Map()
		/** @type {Map<string, object>} */
		this.edges = new Map()
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
		/** Which embedding backend produced the stored vectors. */
		this.vectorBackend = undefined
		/** The width of the stored vectors. */
		this.vectorDimensions = undefined
		/** Which model produced the stored vectors. */
		this.vectorModel = undefined
	}

	/** The folder the store owns. */
	get folder() {
		return join(this.dataDir, 'memory')
	}

	/**
	 * Load the store from disk and build the keyword index.
	 *
	 * @returns {Promise<void>} Resolves once the store is ready.
	 */
	async init() {
		await mkdir(this.folder, { recursive: true, mode: 0o700 })
		this.logLength = 0
		this.pendingAppends = []
		this.logRewrite = false
		this.memories = await this.readMemories()
		this.reflections = await this.readRecords(REFLECTIONS_FILE)
		this.learnings = await this.readRecords(LEARNINGS_FILE)
		this.edges = await this.readRecords(EDGES_FILE)
		await this.readVectors()
		this.rebuildIndex()
		// Whatever was on disk is the current state; nothing to write back.
		this.dirty.clear()
	}

	/**
	 * Load the vectors, tolerating a broken file.
	 *
	 * A store whose vectors are unreadable still has its memories; the vectors
	 * are derived data and can be rebuilt. The broken file is kept next to the
	 * new one so the reason is not lost.
	 *
	 * @returns {Promise<void>} Resolves once the vectors are loaded.
	 */
	async readVectors() {
		let raw
		try {
			raw = await readFile(join(this.folder, VECTORS_FILE), 'utf8')
		} catch {
			return
		}
		try {
			const parsed = JSON.parse(raw)
			const stored = parsed?.vectors ?? parsed
			for (const [id, value] of Object.entries(stored ?? {})) {
				const vector = decodeVector(value)
				if (vector !== undefined && vector.length > 0) this.vectors.set(id, vector)
			}
			this.vectorBackend = typeof parsed?.backend === 'string' ? parsed.backend : undefined
			this.vectorDimensions = typeof parsed?.dimensions === 'number' ? parsed.dimensions : undefined
			this.vectorModel = typeof parsed?.model === 'string' ? parsed.model : undefined
		} catch (error) {
			this.logger?.warn?.(`dsh-evolver: vectors.json 无法解析，向量会在下次嵌入时重建：${error instanceof Error ? error.message : String(error)}`)
			await rename(join(this.folder, VECTORS_FILE), join(this.folder, `${VECTORS_FILE}.broken`)).catch(() => {})
			this.vectors = new Map()
			this.vectorBackend = undefined
			this.vectorDimensions = undefined
			this.vectorModel = undefined
		}
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
		let raw
		try {
			raw = await readFile(join(this.folder, MEMORIES_FILE), 'utf8')
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
				if (record.deleted === true) records.delete(record.id)
				else records.set(record.id, record)
			} catch {
				// A broken line is skipped; the rest of the log still loads.
			}
		}
		return records
	}

	/**
	 * Read a newline-delimited JSON file into a map.
	 *
	 * @param {string} name - File name.
	 * @returns {Promise<Map<string, object>>} The records.
	 */
	async readRecords(name) {
		const records = new Map()
		let raw
		try {
			raw = await readFile(join(this.folder, name), 'utf8')
		} catch {
			return records
		}
		for (const line of raw.split('\n')) {
			const trimmed = line.trim()
			if (trimmed === '') continue
			try {
				const record = JSON.parse(trimmed)
				if (record && typeof record.id === 'string') records.set(record.id, record)
			} catch {
				// A broken line is skipped; the rest of the file still loads.
			}
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
		return [memory.l0Abstract, memory.text, memory.l1Overview, (memory.tags ?? []).join(' ')]
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

	/** Every memory, newest first. */
	all() {
		return [...this.memories.values()].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
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
		this.vectors.delete(id)
		this.pendingAppends.push({ id, deleted: true })
		this.markDirty(MEMORIES)
		this.markDirty(VECTORS)
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

	//#region vectors

	/**
	 * The vector of a memory.
	 *
	 * @param {string} id - Memory id.
	 * @returns {Float32Array | undefined} The vector.
	 */
	vector(id) {
		return this.vectors.get(id)
	}

	/**
	 * Store the vector of a memory.
	 *
	 * @param {string} id - Memory id.
	 * @param {Float32Array | number[]} vector - The vector.
	 * @returns {Promise<void>} Resolves once the vector is scheduled for writing.
	 */
	async setVector(id, vector, { adopt = false } = {}) {
		if (!vector || vector.length === 0) return
		const first = this.vectors.size === 0
		this.vectors.set(id, vector instanceof Float32Array ? vector : Float32Array.from(vector))
		const backend = this.embedder?.id
		const model = this.embedder?.modelName
		const sameSpace = this.vectorBackend === backend && this.vectorModel === model
		// The metadata describes the *whole* vector set. A single save must not
		// relabel old vectors as belonging to a new backend: after a restart the
		// store would believe it was aligned and compare vectors from two
		// different spaces. Only a rebuild (adopt) or an empty store may relabel.
		if (adopt || first || sameSpace) {
			this.vectorBackend = backend
			this.vectorModel = model
			this.vectorDimensions = vector.length
		}
		this.markDirty(VECTORS)
	}

	/**
	 * Embed and store the vector of a memory.
	 *
	 * @param {object} memory - The memory record.
	 * @returns {Promise<void>} Resolves once the vector is scheduled for writing.
	 */
	async embedMemory(memory) {
		if (this.embedder === undefined || this.embedder.id === 'none') return
		try {
			const embed = this.embedder.embedDocument ?? this.embedder.embed
			const vector = await embed.call(this.embedder, this.searchableText(memory))
			await this.setVector(memory.id, vector)
		} catch (error) {
			this.logger?.warn?.(`dsh-evolver: embedding failed for ${memory.id}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	//#endregion

	//#region edges

	/**
	 * Store an edge between two memories.
	 *
	 * @param {object} edge - The edge record.
	 * @returns {Promise<object>} The stored edge.
	 */
	async putEdge(edge) {
		this.edges.set(edge.id, edge)
		this.markDirty(EDGES)
		return edge
	}

	/** Every edge. */
	allEdges() {
		return [...this.edges.values()]
	}

	/**
	 * Remove an edge.
	 *
	 * @param {string} id - Edge id.
	 * @returns {Promise<boolean>} Whether an edge was removed.
	 */
	async removeEdge(id) {
		const removed = this.edges.delete(id)
		if (removed) this.markDirty(EDGES)
		return removed
	}

	//#endregion

	//#region reflections and learnings

	/**
	 * Store a reflection.
	 *
	 * @param {object} reflection - The reflection record.
	 * @returns {Promise<object>} The stored reflection.
	 */
	async putReflection(reflection) {
		this.reflections.set(reflection.id, reflection)
		this.markDirty(REFLECTIONS)
		return reflection
	}

	/** Every reflection, newest first. */
	allReflections() {
		return [...this.reflections.values()].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
	}

	/**
	 * Remove a reflection.
	 *
	 * @param {string} id - Reflection id.
	 * @returns {Promise<boolean>} Whether a reflection was removed.
	 */
	async removeReflection(id) {
		const removed = this.reflections.delete(id)
		if (removed) this.markDirty(REFLECTIONS)
		return removed
	}

	/**
	 * Store a self-improvement entry.
	 *
	 * @param {object} learning - The learning record.
	 * @returns {Promise<object>} The stored learning.
	 */
	async putLearning(learning) {
		this.learnings.set(learning.id, learning)
		this.markDirty(LEARNINGS)
		return learning
	}

	/** Every self-improvement entry, newest first. */
	allLearnings() {
		return [...this.learnings.values()].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
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
			if (pending.has(REFLECTIONS)) await this.writeLines(REFLECTIONS_FILE, this.reflections.values())
			if (pending.has(LEARNINGS)) await this.writeLines(LEARNINGS_FILE, this.learnings.values())
			if (pending.has(EDGES)) await this.writeLines(EDGES_FILE, this.edges.values())
			if (pending.has(VECTORS)) await this.writeFileAtomic(VECTORS_FILE, this.vectorsDocument())
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
				await this.writeLines(MEMORIES_FILE, this.memories.values())
				this.logLength = this.memories.size
				this.logRewrite = false
				// The compaction carries every record currently in memory; any
				// record saved after that snapshot stays queued for the next
				// append instead of being dropped.
				this.pendingAppends = appends.slice(written)
			} else if (written > 0) {
				await appendFile(
					join(this.folder, MEMORIES_FILE),
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
	 * The on-disk shape of the vectors.
	 *
	 * @returns {string} The JSON document.
	 */
	vectorsDocument() {
		const vectors = {}
		for (const [id, vector] of this.vectors) vectors[id] = encodeVector(vector)
		return `${JSON.stringify({
			backend: this.vectorBackend,
			model: this.vectorModel,
			dimensions: this.vectorDimensions,
			encoding: 'f32-base64',
			vectors,
		})}\n`
	}

	/**
	 * Write a newline-delimited JSON file.
	 *
	 * @param {string} name - File name.
	 * @param {Iterable<object>} records - The records.
	 * @returns {Promise<void>} Resolves once the file is committed.
	 */
	async writeLines(name, records) {
		const lines = []
		for (const record of records) lines.push(JSON.stringify(record))
		await this.writeFileAtomic(name, lines.length === 0 ? '' : `${lines.join('\n')}\n`)
	}

	/**
	 * Write a file atomically.
	 *
	 * @param {string} name - File name.
	 * @param {string} content - File content.
	 * @returns {Promise<void>} Resolves once the file is committed.
	 */
	async writeFileAtomic(name, content) {
		const target = join(this.folder, name)
		this.writeSequence += 1
		const temp = `${target}.${process.pid}.${this.writeSequence}.tmp`
		try {
			await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
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
	scheduleFlush() {
		if (this.flushTimer !== undefined) return
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined
			void this.flush().catch(error => {
				this.logger?.warn?.(`dsh-evolver: memory write failed: ${error instanceof Error ? error.message : String(error)}`)
			})
		}, FLUSH_DELAY_MS)
	}

	//#endregion
}
