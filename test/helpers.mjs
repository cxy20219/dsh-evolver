/**
 * A temporary store for one test.
 *
 * Every test gets its own data folder, so tests can run in parallel across
 * files and a failed assertion cannot leave a database behind in the repo.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileStore } from '../src/store.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Evaluate `client.js` outside a browser.
 *
 * The browser half is one `window.__ModuleLoader__.load` factory with no import
 * surface, so the only way for `node --test` to reach its pure layout math is
 * to run the file against a fake `window`/`document` and a stub `react`. The
 * returned module carries that math under `__graph`; nothing here renders a
 * panel or touches a canvas.
 *
 * @returns {Promise<{registration: object, module: object}>} What the loader
 *   registered, and what the factory returned.
 */
export async function loadClient() {
	const source = await readFile(join(ROOT, 'client.js'), 'utf8')
	let registration
	const window = {
		__ModuleLoader__: {
			load(config) {
				registration = config
			},
		},
	}
	const document = {
		createElement() {
			return { dataset: {}, textContent: '', remove() {} }
		},
		head: { appendChild() {} },
	}
	new Function('window', 'document', source)(window, document)
	const react = {
		createElement() {
			return null
		},
		Component: function Component() {},
		useState(value) {
			return [value, function () {}]
		},
		useEffect() {},
		useCallback(fn) {
			return fn
		},
		useMemo(fn) {
			return fn()
		},
		useRef(value) {
			return { current: value }
		},
	}
	return { registration, module: registration.factory(function () { return react }) }
}

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
