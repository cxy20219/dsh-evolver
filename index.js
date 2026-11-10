/**
 * dsh-evolver — the Host half.
 *
 * The plugin owns three things:
 *
 *   1. **the data** — one folder (`~/.dsh/evolver` by default) with the
 *      practice layer, the sight layer and the global preferences;
 *   2. **the injection** — two prompt sections: the practice index (a routing
 *      table, never the bodies) and the soul document;
 *   3. **the tools** — `practice_*` for the curated layer and `memory_*` for
 *      the sight layer.
 *
 * Nothing is imported from the Harness installation: the storage engine only
 * uses Node's own file system, and the API the browser calls is registered on
 * the Connection service the Host already provides.
 */

import { isAbsolute, join } from 'node:path'

import { Evolver, resolveDshHome } from './src/evolver.js'
import { MemoryStore } from './src/memory/store.js'
import { createMemoryActions } from './src/memory-actions.js'
import { createEvolverHandler, ENDPOINTS } from './src/remote.js'
import { createTools } from './src/tools.js'

/** The plugin's row name. */
export const name = 'dsh-evolver'

/** The API prefix the browser calls. */
export const API_PREFIX = '/api/evolver'

/** How often the injected text is refreshed, in milliseconds. */
const REFRESH_MS = 60_000

/** How large a request body the panel API accepts. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024

/**
 * The evolver's data folder.
 *
 * @param {unknown} configured - The configured data directory.
 * @returns {string} The absolute folder path.
 */
function resolveRoot(configured) {
	if (typeof configured === 'string' && configured.trim() !== '') {
		const value = configured.trim()
		// A relative path would silently follow whatever directory the Host
		// happened to start in, which is not something a data folder may do.
		if (!isAbsolute(value)) {
			throw new Error(`dsh-evolver: dataDir 必须是绝对路径，收到的是 ${value}`)
		}
		return value
	}
	return join(resolveDshHome(), 'evolver')
}

/**
 * Start the evolver: prepare the folder, publish the injection, register the
 * tools and the API.
 *
 * @param {object} ctx - Host plugin context.
 * @param {object} [config] - The row's configuration.
 */
export async function apply(ctx, config) {
	// Every registration below belongs to this plugin's context, so a failure
	// half-way through must not leave a timer or a route behind.
	const connection = ctx.get('connection')
	if (connection === undefined) {
		throw new Error('dsh-evolver: the Host connection service is not available')
	}

	const root = resolveRoot(config?.dataDir)
	const evolver = new Evolver({
		root,
		logger: ctx.logger,
		dshHome: resolveDshHome(),
		indexBytes: typeof config?.indexBytes === 'number' ? config.indexBytes : undefined,
	})
	await evolver.ensure()
	await evolver.migrate()
	await evolver.linkGlobalIfNeeded()

	const store = new MemoryStore({ dataDir: join(root, 'sight'), logger: ctx.logger })
	await store.init()
	const memory = createMemoryActions(store)

	/** Everything that has to be undone, in registration order. */
	const disposers = []

	ctx.effect(() => () => {
		for (const dispose of disposers) {
			try {
				dispose()
			} catch {
				// A failing disposer must not stop the others.
			}
		}
		// Writing out the debounced memory saves is part of shutting down.
		return store.close().catch(() => {})
	}, 'dsh-evolver: resources')

	for (const tool of createTools({ practice: evolver, memory })) {
		disposers.push(ctx.tools.register(tool))
	}

	// The two injected blocks. Their text is served from a cache so the
	// assembled prompt stays byte-stable between changes.
	await evolver.refresh()
	disposers.push(ctx.systemPrompt.section({
		name: 'dsh-evolver:practice',
		order: 900,
		interpolate: false,
		text: () => evolver.cache.practice,
	}))
	disposers.push(ctx.systemPrompt.section({
		name: 'dsh-evolver:soul',
		order: 910,
		interpolate: false,
		text: () => evolver.cache.soul,
	}))

	// The panel edits the same data, so the injected text has to follow it.
	// The refresh itself is cheap: unchanged entries are not re-parsed.
	ctx.effect(() => {
		const timer = setInterval(() => {
			void evolver.refresh().catch(() => {})
		}, REFRESH_MS)
		timer.unref?.()
		return () => clearInterval(timer)
	}, 'dsh-evolver: index refresh')

	const handler = createEvolverHandler({ evolver, memory })
	for (const endpoint of ENDPOINTS) {
		disposers.push(connection.fetch.register({
			path: `${API_PREFIX}/${endpoint}`,
			methods: ['POST'],
			requestBody: 'buffered',
			fetch: async (request) => {
				const declared = Number(request.headers.get('content-length') ?? '')
				if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
					return Response.json({
						error: {
							code: 'evolver/request-too-large',
							message: `请求体超过 ${MAX_REQUEST_BYTES} 字节。`,
							details: {},
						},
					}, { status: 413 })
				}
				let payload = {}
				try {
					payload = await request.json()
				} catch {
					payload = {}
				}
				const result = await handler(endpoint, payload)
				if (!result.ok) {
					return Response.json({ error: result.error }, { status: 400 })
				}
				return Response.json(result.value ?? null)
			},
		}))
	}

	ctx.logger.info(`dsh-evolver: serving ${root} on ${API_PREFIX}`)
}
