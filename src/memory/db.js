import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The memory store.
 *
 * Everything lives in the panel's own folder as plain files:
 *
 *   memories.jsonl    one memory per line
 *   reflections.jsonl one reflection per line
 *   learnings.jsonl   one self-improvement entry per line
 *   vectors.json      embedding vectors, keyed by memory id
 *
 * Plain files were chosen over an embedded database on purpose: they are
 * readable, greppable, diffable, and they travel with the panel folder when
 * it is backed up or moved. The keyword index is rebuilt from them on start,
 * so it can always be thrown away and regenerated.
 */

const MEMORIES_FILE = 'memories.jsonl'
const REFLECTIONS_FILE = 'reflections.jsonl'
const LEARNINGS_FILE = 'learnings.jsonl'
const VECTORS_FILE = 'vectors.json'
const EDGES_FILE = 'edges.jsonl'

/** BM25 parameters. */
const BM25_K1 = 1.2
const BM25_B = 0.75

const LATIN = /[a-z0-9][a-z0-9_.-]*/gi
const CJK_RUN = /[一-鿿]+/g

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
		/** @type {Map<string, number[]>} */
		this.vectors = new Map()
		/** @type {Map<string, object>} */
		this.edges = new Map()
		/** @type {Map<string, Map<string, number>>} */
		this.postings = new Map()
		/** @type {Map<string, number>} */
		this.documentFrequency = new Map()
		this.averageLength = 1
		this.pendingFlush = false
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
		this.memories = await this.readRecords(MEMORIES_FILE)
		this.reflections = await this.readRecords(REFLECTIONS_FILE)
		this.learnings = await this.readRecords(LEARNINGS_FILE)
		this.edges = await this.readRecords(EDGES_FILE)
		try {
			const raw = await readFile(join(this.folder, VECTORS_FILE), 'utf8')
			const parsed = JSON.parse(raw)
			const store = parsed?.vectors ?? parsed
			for (const [id, vector] of Object.entries(store ?? {})) {
				if (Array.isArray(vector)) this.vectors.set(id, vector)
			}
			this.vectorBackend = typeof parsed?.backend === 'string' ? parsed.backend : undefined
			this.vectorDimensions = typeof parsed?.dimensions === 'number' ? parsed.dimensions : undefined
			this.vectorModel = typeof parsed?.model === 'string' ? parsed.model : undefined
		} catch {
			this.vectors = new Map()
			this.vectorBackend = undefined
			this.vectorDimensions = undefined
			this.vectorModel = undefined
		}
		this.rebuildIndex()
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
		}
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
		this.scheduleFlush()
		return memory
	}

	/**
	 * Index one memory, replacing what the previous version contributed.
	 *
	 * @param {object} memory - The memory record.
	 * @param {object} [previous] - The record it replaces.
	 */
	indexOne(memory, previous) {
		if (previous !== undefined) {
			const oldTokens = new Set(tokenize(this.searchableText(previous)))
			for (const token of oldTokens) {
				const posting = this.postings.get(token)
				if (posting === undefined) continue
				posting.delete(previous.id)
				if (posting.size === 0) {
					this.postings.delete(token)
					this.documentFrequency.delete(token)
				} else {
					this.documentFrequency.set(token, posting.size)
				}
			}
		}
		const counts = new Map()
		for (const token of tokenize(this.searchableText(memory))) counts.set(token, (counts.get(token) ?? 0) + 1)
		for (const [token, count] of counts) {
			if (!this.postings.has(token)) this.postings.set(token, new Map())
			this.postings.get(token).set(memory.id, count)
			this.documentFrequency.set(token, this.postings.get(token).size)
		}
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
		this.indexOne({ id, text: '', l0Abstract: '', l1Overview: '', tags: [] }, previous)
		this.vectors.delete(id)
		this.scheduleFlush()
		return true
	}

	//#endregion

	//#region keyword search

	/**
	 * The BM25 score of a query against the index.
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
				const memory = this.memories.get(id)
				if (memory === undefined) continue
				const length = tokenize(this.searchableText(memory)).length
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
	 * @returns {number[] | undefined} The vector.
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
	async setVector(id, vector) {
		if (!vector || vector.length === 0) return
		this.vectors.set(id, Array.from(vector))
		this.vectorBackend = this.embedder?.id
		this.vectorModel = this.embedder?.modelName
		this.vectorDimensions = vector.length
		this.scheduleFlush()
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
			this.logger?.warn?.(`dsh-panel: embedding failed for ${memory.id}: ${error instanceof Error ? error.message : String(error)}`)
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
		this.scheduleFlush()
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
		if (removed) this.scheduleFlush()
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
		this.scheduleFlush()
		return reflection
	}

	/** Every reflection, newest first. */
	allReflections() {
		return [...this.reflections.values()].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
	}

	/**
	 * Store a self-improvement entry.
	 *
	 * @param {object} learning - The learning record.
	 * @returns {Promise<object>} The stored learning.
	 */
	async putLearning(learning) {
		this.learnings.set(learning.id, learning)
		this.scheduleFlush()
		return learning
	}

	/** Every self-improvement entry, newest first. */
	allLearnings() {
		return [...this.learnings.values()].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
	}

	//#endregion

	//#region persistence

	/**
	 * Write the store out.
	 *
	 * @returns {Promise<void>} Resolves once every file is committed.
	 */
	async flush() {
		this.pendingFlush = false
		await mkdir(this.folder, { recursive: true, mode: 0o700 })
		await this.writeLines(MEMORIES_FILE, this.memories.values())
		await this.writeLines(REFLECTIONS_FILE, this.reflections.values())
		await this.writeLines(LEARNINGS_FILE, this.learnings.values())
		await this.writeLines(EDGES_FILE, this.edges.values())
		const vectors = {}
		for (const [id, vector] of this.vectors) vectors[id] = vector
		const document = {
			backend: this.vectorBackend,
			model: this.vectorModel,
			dimensions: this.vectorDimensions,
			vectors,
		}
		await this.writeFileAtomic(VECTORS_FILE, `${JSON.stringify(document)}\n`)
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
		const temp = `${target}.tmp`
		await writeFile(temp, content, { mode: 0o600 })
		await rename(temp, target)
	}

	/**
	 * Schedule a write-out.
	 *
	 * @returns {void}
	 */
	scheduleFlush() {
		if (this.pendingFlush) return
		this.pendingFlush = true
		const timer = setTimeout(() => {
			void this.flush().catch(error => {
				this.logger?.warn?.(`dsh-panel: memory write failed: ${error instanceof Error ? error.message : String(error)}`)
			})
		}, 400)
		timer.unref?.()
	}

	//#endregion
}
