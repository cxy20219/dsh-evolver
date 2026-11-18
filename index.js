/**
 * dsh-ziyan — the Host half.
 *
 * The plugin owns three things:
 *
 *   1. **the data** — one folder (`~/.dsh/ziyan` by default) holding files,
 *      sidecars, the SQLite index, settings, logs and trash. Only a one-line
 *      pointer (`~/.dsh/ziyan.home.json`) may live beside that folder;
 *   2. **the tools** — four verbs: search, read, write and edit. They serve
 *      the file library and ordinary project files; a project's own
 *      `harness/` is just another folder now, written by whatever tool the
 *      project uses;
 *   3. **the injection** — one static system section, and nothing else. No
 *      library index is injected, so a write never rewrites the prompt prefix;
 *      an agent that needs a file searches for it with `file_search`.
 *
 * The browser half is `client.js`: the panel tabs, settings, and data
 * import/export. The host half remains loadable on its own for tools and
 * injection.
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { createDataJobs } from './src/data-jobs.js'
import { dataDirPointerPath, readDataDirPointer } from './src/home.js'
import { createLogSink } from './src/logs.js'
import { createMcpService, mintToken } from './src/mcp/server.js'
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

	const disposers = []
	// The verbs are no longer registered with the host: an agent reaches the
	// library through `ziyan` (bin/ziyan.mjs) or the ziyan-evolver skill, not
	// through four tools that ride on every request. `tools` still exists for
	// two readers that must not drift from the CLI — the panel's tool page and
	// the MCP endpoint — so both describe the same verbs the CLI exposes.
	const tools = createTools({ store, paths: async () => ({}) })

	// The MCP endpoint hands the same four verbs to other agents. It is off
	// unless the settings say otherwise, and it only ever binds 127.0.0.1; the
	// token is minted once and reused so a client config keeps working.
	const mcp = createMcpService({ tools, log: logs, serverInfo: { name: 'ziyan', version } })
	if (current.mcp.token === '') await settings.save({ mcp: { token: mintToken() } })
	if (current.mcp.enabled) {
		await mcp.start({ port: current.mcp.port, token: settings.get().mcp.token })
	}
	disposers.push(ctx.systemPrompt.section({
		name: 'dsh-ziyan:discipline',
		order: 900,
		interpolate: false,
		text: () => staticSection(),
	}))

	const connection = ctx.get('connection')
	if (connection !== undefined) {
		const handler = createZiyanHandler({ store, settings, logs, root, version, data, tools, mcp, organize: organizer })
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
			// Free the port before anything else: a restart that cannot rebind
			// would leave the endpoint dead while the panel still says "on".
			await mcp.stop().catch(() => {})
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

	// The JSDoc above promises these and the tests use them; the panel and the
	// CLI read the same store, so handing it back is also the cheapest way to
	// prove the assembly wired one library rather than three.
	return { root, store, settings, tools }
}
