/**
 * The keyword store the card layer talks to.
 *
 * Its public surface is deliberately small: the card store owns cards; this
 * class only loads the log, keeps the BM25 index with it, and flushes files.
 */

import { MemoryDatabase } from './db.js'

/**
 * The memory store.
 */
export class MemoryStore {
	/**
	 * @param {{dataDir: string, logger?: object, folder?: string, logName?: string}} deps - Store dependencies.
	 */
	constructor({ dataDir, logger, folder, logName }) {
		this.db = new MemoryDatabase({ dataDir, logger, folder, logName })
	}

	/**
	 * Open the store.
	 *
	 * @returns {Promise<void>} Resolves once the records are loaded.
	 */
	async init() {
		await this.db.init()
	}

	async close() {
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
	 * A counter that changes whenever the record set does.
	 *
	 * Derived views cache against it.
	 *
	 * @returns {number} The version.
	 */
	get version() {
		return this.db.version
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
	 * Store one record.
	 *
	 * @param {object} memory - The record.
	 * @returns {Promise<object>} The stored record.
	 */
	async putMemory(memory) {
		await this.db.put(memory)
		return memory
	}

	/**
	 * Remove one record.
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
