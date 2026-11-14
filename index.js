/**
 * dsh-ziyan — the Host half.
 *
 * The plugin owns three things:
 *
 *   1. **the data** — one folder (`~/.dsh/ziyan` by default) holding files,
 *      sidecars, the SQLite index, settings, logs and trash. Only a one-line
 *      pointer (`~/.dsh/ziyan.home.json`) may live beside that folder;
 *   2. **the tools** — file query/read/write/import/link/index/archive/remove,
 *      plus the `project_harness_*` set that maintains a project's own
 *      `harness/` resources and promotes the reusable ones into the library;
 *   3. **the injection** — one static system section, and nothing else. No
 *      library index is injected, so a write never rewrites the prompt prefix;
 *      an agent that needs a file searches for it with `file_query`.
 *
 * The browser half is `client.js`: the panel tabs, settings, and data
 * import/export. The host half remains loadable on its own for tools and
 * injection.
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { createDataJobs } from './src/data-jobs.js'
import { projectRootOf } from './src/harness/store.js'
import { createHarnessTools } from './src/harness/tools.js'
import { dataDirPointerPath, readDataDirPointer } from './src/home.js'
import { createLogSink } from './src/logs.js'
import { createOrganizer } from './src/organize-jobs.js'
import { staticSection } from './src/prompt.js'
import { createZiyanHandler, ENDPOINTS } from './src/remote.js'
import { SettingsStore } from './src/settings.js'
import { FileStore } from './src/store.js'
import { createTools } from './src/tools.js'

/** The plugin's row name. */
export const name = 'dsh-ziyan'

/** The API prefix the browser calls. */
export const API_PREFIX = '/api/ziyan'

/** The largest request body the panel API goes on to parse. */
const MAX_REQUEST_BYTES = 48 * 1024 * 1024

/**
 * The DSH home directory.
 *
 * @param {Record<string, string | undefined>} [env] - The environment.
 * @returns {string} The absolute path.
 */
export function resolveDshHome(env = process.env) {
	const configured = env.DSH_HOME
	if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
	return join(homedir(), '.dsh')
}

/**
 * The plugin's own version, read from the package it ships in.
 *
 * @returns {Promise<string>} The version, or an empty string.
 */
async function readVersion() {
	try {
		const text = await readFile(new URL('./package.json', import.meta.url), 'utf8')
		const parsed = JSON.parse(text)
		return typeof parsed?.version === 'string' ? parsed.version : ''
	} catch {
		return ''
	}
}

/**
 * Register the host half.
 *
 * @param {object} ctx - The Cordis context.
 * @param {object} [config] - The composition config (`dataDir`).
 * @returns {Promise<object>} The opened root, store and settings (for tests).
 */
export async function apply(ctx, config) {
	if (ctx?.tools === undefined || ctx?.systemPrompt === undefined) {
		throw new Error('dsh-ziyan: tools/systemPrompt services are not available')
	}
	const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : ''
	if (configured !== '' && !isAbsolute(configured)) {
		throw new Error('dsh-ziyan: dataDir 必须是绝对路径。')
	}
	const dshHome = resolveDshHome()
	const pointerPath = dataDirPointerPath(dshHome)
	const pointer = await readDataDirPointer(pointerPath)
	if (pointer !== undefined) {
		const pointerInfo = await stat(join(pointer.dataDir, 'files')).catch(() => undefined)
		if (pointerInfo === undefined || !pointerInfo.isDirectory()) {
			throw new Error(`dsh-ziyan: 数据目录指针指向的不是自衍中枢库：${pointer.dataDir}（删掉 ${pointerPath} 可回到默认目录）`)
		}
		if (configured !== '' && resolve(configured) !== pointer.dataDir) {
			ctx.logger?.warn?.(`dsh-ziyan: 数据目录指针覆盖了组合配置 dataDir（${configured}）`)
		}
	}
	const root = pointer?.dataDir ?? (configured === '' ? join(dshHome, 'ziyan') : resolve(configured))

	const systemDir = join(root, 'system')
	const logs = createLogSink({ dataDir: systemDir, forward: ctx.logger })
	const settings = new SettingsStore({ dataDir: root, logger: logs })
	await settings.load()
	const current = settings.get()
	const store = new FileStore({
		dataDir: root,
		logger: logs,
		maxBytes: current.maxFileBytes,
		readTextBytes: current.readTextBytes,
		descriptionMaxChars: current.descriptionMaxChars,
	})
	await store.open()

	const version = await readVersion()
	const data = createDataJobs({ root, pointerPath, settings, logger: logs, version })
	// The organize engine is optional at the transport level: a host without
	// `llm` still gets a working status endpoint and a readable start refusal.
	// It starts a job only when the panel asks, or when the auto-organize
	// switches (off by default) fire; the plugin never spends model calls by
	// itself on a fresh install.
	const organizer = createOrganizer({
		store,
		settings,
		logs,
		root,
		llm: ctx.get('llm'),
		modelSelection: ctx.get('agentDefaultModel'),
		sessionsRoot: join(dshHome, 'sessions'),
	})

	/**
	 * Find the project a harness tool call belongs to.
	 *
	 * Tools do not receive a working directory — the run context carries only
	 * the agent id — so it is read back from the session header, which the host
	 * records when the session starts. `sessionQuery` is optional: a host
	 * without it still loads, and the tools ask for an explicit `project`.
	 *
	 * @param {{project?: string, agent?: {id?: string}}} exec - The call context.
	 * @returns {Promise<string | undefined>} The project root.
	 */
	// One entry per agent id; a long-lived host would otherwise keep every id
	// it has ever seen. Small enough to make the lookup still worth it.
	const projectCache = new Map()
	const PROJECT_CACHE_MAX = 64
	async function resolveProject(exec) {
		const explicit = String(exec?.project ?? '').trim()
		if (explicit !== '') return projectRootOf(explicit)
		const id = String(exec?.agent?.id ?? '')
		if (id === '') return undefined
		if (projectCache.has(id)) return projectCache.get(id)
		const query = ctx.get('sessionQuery')
		if (query === undefined || typeof query.filterSessions !== 'function') return undefined
		const records = await query.filterSessions([{ kind: 'id', values: [id] }]).catch(() => [])
		const cwd = records?.[0]?.header?.cwd
		const resolved = typeof cwd === 'string' ? await projectRootOf(cwd) : undefined
		if (projectCache.size >= PROJECT_CACHE_MAX) projectCache.delete(projectCache.keys().next().value)
		projectCache.set(id, resolved)
		return resolved
	}

	const disposers = []
	// One array goes to both places on purpose: registering and describing must
	// stay the same set, so the panel cannot show a tool the model does not have
	// (or miss one it does).
	const tools = [...createTools({ store }), ...createHarnessTools({ resolveProject, store })]
	for (const tool of tools) disposers.push(ctx.tools.register(tool))
	disposers.push(ctx.systemPrompt.section({
		name: 'dsh-ziyan:discipline',
		order: 900,
		interpolate: false,
		text: () => staticSection(),
	}))

	const connection = ctx.get('connection')
	if (connection !== undefined) {
		const handler = createZiyanHandler({ store, settings, logs, root, version, data, tools, organize: organizer })
		for (const endpoint of ENDPOINTS) {
			disposers.push(connection.fetch.register({
				path: `${API_PREFIX}/${endpoint}`,
				methods: ['POST'],
				requestBody: 'buffered',
				fetch: async (request) => {
					const declared = Number(request.headers.get('content-length') ?? '')
					if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
						return Response.json({
							error: { code: 'ziyan/request-too-large', message: `请求体超过 ${MAX_REQUEST_BYTES} 字节。` },
						}, { status: 413 })
					}
					let payload = {}
					try {
						payload = await request.json()
					} catch {
						payload = {}
					}
					try {
						const value = await handler(endpoint, payload)
						return Response.json(value ?? null)
					} catch (error) {
						return Response.json({
							error: { code: 'ziyan/error', message: error instanceof Error ? error.message : String(error) },
						}, { status: 400 })
					}
				},
			}))
		}
		logs.info(`自衍中枢：面板接口 ${ENDPOINTS.length} 个，前缀 ${API_PREFIX}`)
	} else {
		logs.warn('自衍中枢：connection 服务不可用，面板接口未注册；工具与注入仍然可用。')
	}

	// The injected text is a constant: no daily rebuild, no timer. A host that
	// stays open for weeks sends the same prompt prefix.
	logs.info(`自衍中枢 ${version}：数据目录 ${root}（文件 files/，系统数据 system/）`)
	if (pointer !== undefined) logs.info(`自衍中枢：数据目录由指针 ${pointerPath} 指定`)

	ctx.effect(() => () => {
		// Abort an in-flight organize job before the store closes; its record is
		// already on disk, and the next start reads it back as interrupted.
		organizer.close()
		return (async () => {
			for (const dispose of disposers) {
				try {
					await dispose?.()
				} catch {
					// One broken registration must not keep the store open.
				}
			}
			await logs.close?.()
			store.close()
		})()
	}, 'dsh-ziyan: resources')

}
