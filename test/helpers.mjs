/**
 * A temporary store for one test.
 *
 * Every test gets its own data folder, so tests can run in parallel across
 * files and a failed assertion cannot leave a database behind in the repo.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileStore } from '../src/store.js'

/**
 * Run one test body against a fresh store.
 *
 * @param {(store: FileStore, dir: string) => Promise<any>} body - The test.
 * @param {object} [options] - Extra FileStore options.
 * @returns {Promise<any>} Whatever the body returned.
 */
export async function withStore(body, options = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'ziyan-test-'))
	const store = new FileStore({ dataDir: dir, ...options })
	await store.open()
	try {
		return await body(store, dir)
	} finally {
		store.close()
		await rm(dir, { recursive: true, force: true })
	}
}

/**
 * A fresh temporary directory the caller cleans up.
 *
 * @returns {Promise<string>} The path.
 */
export async function tempDir() {
	return mkdtemp(join(tmpdir(), 'ziyan-test-'))
}
