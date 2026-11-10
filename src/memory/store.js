/**
 * The vector/keyword store the card layer talks to.
 *
 * Its public surface is deliberately small: the card store owns cards; this
 * class only loads the log, keeps the BM25 index and vectors aligned with the
 * configured embedding backend, and flushes the files.
 */

import { createEmbedder } from './embed.js'
import { MemoryDatabase } from './db.js'

/** How many memories one embedding request carries. */
const REEMBED_BATCH = 32

/**
 * The memory store.
 */
export class MemoryStore {
	/**
	 * @param {{dataDir: string, embedding?: object, logger?: object, folder?: string, logName?: string}} deps - Store dependencies.
	 */
	constructor({ dataDir, embedding, logger, folder, logName }) {
		this.dataDir = dataDir
		this.logger = logger
		this.embedder = embedding === undefined ? createEmbedder({ provider: 'local' }) : embedding
		this.db = new MemoryDatabase({ dataDir, embedder: this.embedder, logger, folder, logName })
		/**
		 * Whether every stored vector belongs to the configured embedder.
		 *
		 * A fresh save sets the metadata on its own vector, so metadata alone
		 * cannot answer this: an interrupted rebuild leaves a store that is
		 * half old space, half new space. The read path trusts this flag.
		 */
		this.vectorsAligned = false
	}

	/**
	 * Open the store.
	 *
	 * Loading records is local; rebuilding embeddings may talk to a network
	 * backend, so it runs in the background. Until it finishes, retrieval runs
	 * keyword-only — activation is never held up by an embedding provider.
	 *
	 * @returns {Promise<void>} Resolves once the records are loaded.
	 */
	async init() {
		await this.db.init()
		this.ready = this.reembedIfNeeded().catch((error) => {
			this.vectorsAligned = false
			this.logger?.warn?.(`dsh-evolver: embedding rebuild failed: ${error instanceof Error ? error.message : String(error)}`)
		})
	}

	/**
	 * What the embedding panel needs.
	 *
	 * @returns {{embedder: string, dimensions: number, aligned: boolean, ready: boolean, backend: string | null, model: string | null, entries: number}} The state.
	 */
	status() {
		return {
			embedder: this.embedder?.id ?? 'none',
			dimensions: this.embedder?.dimensions || this.db.vectorDimensions || 0,
			aligned: this.vectorsAligned === true,
			ready: this.vectorsReady(),
			backend: this.db.vectorBackend ?? null,
			model: this.db.vectorModel ?? null,
			entries: this.db.memories.size,
		}
	}

	/**
	 * Whether the stored vectors belong to the configured embedder.
	 *
	 * @returns {boolean} True when vector search is meaningful.
	 */
	vectorsReady() {
		if (this.vectorsAligned !== true) return false
		if (this.embedder === undefined || this.embedder.id === 'none') return false
		if (this.db.vectorBackend !== this.embedder.id) return false
		return this.db.vectorModel === this.embedder.modelName
	}

	/**
	 * Re-embed every record when the backend changed.
	 *
	 * The rebuild is staged: vectors are collected first and applied only when
	 * every batch succeeded. A half-rebuilt store would mix two spaces and
	 * quietly produce wrong rankings.
	 *
	 * @returns {Promise<void>} Resolves once the vectors are consistent.
	 */
	async reembedIfNeeded() {
		if (this.embedder === undefined || this.embedder.id === 'none') return
		const backend = this.db.vectorBackend
		const model = this.db.vectorModel
		if (backend === this.embedder.id && model === this.embedder.modelName) {
			this.vectorsAligned = true
			return
		}
		const memories = this.db.all()
		if (memories.length === 0) {
			this.db.vectorBackend = this.embedder.id
			this.db.vectorModel = this.embedder.modelName
			this.vectorsAligned = true
			return
		}
		this.logger?.info?.(`dsh-evolver: embedding changed (${backend ?? 'none'}/${model ?? 'none'} → ${this.embedder.id}/${this.embedder.modelName}), re-embedding ${memories.length} records`)
		const staged = []
		let failures = 0
		for (let start = 0; start < memories.length; start += REEMBED_BATCH) {
			const batch = memories.slice(start, start + REEMBED_BATCH)
			try {
				const vectors = await this.embedTexts(batch.map((memory) => this.db.searchableText(memory)))
				if (vectors.length !== batch.length) throw new Error(`嵌入返回 ${vectors.length} 条，期望 ${batch.length} 条`)
				for (let index = 0; index < batch.length; index += 1) {
					if (vectors[index]?.length > 0) staged.push([batch[index].id, vectors[index]])
				}
			} catch (error) {
				failures += 1
				this.logger?.warn?.(`dsh-evolver: 批量嵌入失败（第 ${Math.floor(start / REEMBED_BATCH) + 1} 批）：${error instanceof Error ? error.message : String(error)}`)
				if (failures >= 2) {
					this.logger?.warn?.('dsh-evolver: 嵌入后端不可用，放弃本次重建，旧向量保持不变。')
					return
				}
			}
		}
		if (failures > 0) {
			this.logger?.warn?.('dsh-evolver: 有批次失败，放弃本次重建，旧向量保持不变。')
			return
		}
		for (const [id, vector] of staged) await this.db.setVector(id, vector, { adopt: true })
		await this.db.flush()
		this.vectorsAligned = true
	}

	/**
	 * Embed a batch of texts with whichever method the backend offers.
	 *
	 * @param {string[]} texts - The texts.
	 * @returns {Promise<Array<Float32Array | number[]>>} One vector per text.
	 */
	async embedTexts(texts) {
		if (texts.length === 0) return []
		if (typeof this.embedder.embedBatch === 'function') return this.embedder.embedBatch(texts)
		const embed = this.embedder.embedDocument ?? this.embedder.embed
		const vectors = []
		for (const text of texts) vectors.push(await embed.call(this.embedder, text))
		return vectors
	}

	/**
	 * Write the store out and stop the debounce timer.
	 *
	 * @returns {Promise<void>} Resolves once the files are written.
	 */
	async close() {
		await this.ready?.catch(() => {})
		await this.db.close()
	}

	/**
	 * The records, insertion order.
	 *
	 * @returns {object[]} The records.
	 */
	all() {
		return this.db.all()
	}

	/**
	 * One record.
	 *
	 * @param {string} id - The id.
	 * @returns {object | undefined} The record.
	 */
	getEntry(id) {
		return this.db.get(id)
	}

	/**
	 * Store one record and its embedding.
	 *
	 * @param {object} memory - The record.
	 * @returns {Promise<object>} The stored record.
	 */
	async putMemory(memory) {
		await this.db.put(memory)
		await this.db.embedMemory(memory)
		return memory
	}

	/**
	 * Remove one record and its vector.
	 *
	 * @param {string} id - The id.
	 * @returns {Promise<boolean>} Whether it existed.
	 */
	async deleteMemory(id) {
		return this.db.remove(id)
	}

	/** Write the store out. */
	async flush() {
		await this.db.flush()
	}
}
