/**
 * dsh-ziyan — the Host half.
 *
 * The plugin owns three things:
 *
 *   1. **the data** — one folder (`~/.dsh/ziyan` by default) holding files,
 *      sidecars, the SQLite index, the injected snapshot, settings, logs and
 *      trash. Only a one-line pointer (`~/.dsh/ziyan.home.json`) may live
 *      beside that folder;
 *   2. **the tools** — file query/read/write/import/link/index/archive/remove;
 *   3. **the injection** — a static system section and a runtime file index
 *      read from a snapshot, so a write does not rewrite the prompt prefix.
 *
 * The browser half is `client.js`: five tabs, settings, and data import/export.
 * The host half remains loadable on its own for tools and injection.
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { indexText, refreshIndex, dayKey } from './src/injection.js'
import { createDataJobs } from './src/data-jobs.js'
import { dataDirPointerPath, readDataDirPointer } from './src/home.js'
import { createLogSink } from './src/logs.js'
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

/** How often the midnight snapshot check runs. */
const SNAPSHOT_HEARTBEAT_MS = 10 * 60 * 1000

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

	// Build the snapshot once, before the first request. A fresh install, a
	// moved folder or an imported archive has none, and the fallback would rank
	// the whole library on every request until the next daily run.
	try {
		await refreshIndex(store)
	} catch (error) {
		logs.warn(`自衍中枢：构建注入快照失败：${error instanceof Error ? error.message : String(error)}`)
	}
	let injected = await indexText(store, current.injectionBudget)
	const version = await readVersion()
	const data = createDataJobs({ root, pointerPath, settings, logger: logs, version })

	const disposers = []
	for (const tool of createTools({ store })) disposers.push(ctx.tools.register(tool))
	disposers.push(ctx.systemPrompt.section({
		name: 'dsh-ziyan:files',
		order: 900,
		interpolate: false,
		text: () => staticSection(),
	}))
	disposers.push(ctx.systemPrompt.context({
		name: 'dsh-ziyan:files',
		order: 900,
		interpolate: false,
		// Served from memory, not from disk: the prompt prefers a plain string,
		// and the text must stay byte-stable until the snapshot is refreshed.
		text: () => injected,
	}))

	const connection = ctx.get('connection')
	if (connection !== undefined) {
		const handler = createZiyanHandler({ store, settings, logs, root, version, data })
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

	// The injected text is a daily artifact. A host that stays open across
	// midnight gets one rebuild per day; writes in between do not touch it.
	let day = dayKey()
	const timer = setInterval(async () => {
		const nextDay = dayKey()
		if (nextDay === day) return
		day = nextDay
		try {
			await refreshIndex(store)
			injected = await indexText(store, settings.get().injectionBudget)
			logs.info('自衍中枢：跨日，已刷新注入快照')
		} catch (error) {
			logs.warn(`自衍中枢：刷新注入快照失败：${error instanceof Error ? error.message : String(error)}`)
		}
	}, SNAPSHOT_HEARTBEAT_MS)
	timer.unref?.()

	logs.info(`自衍中枢 ${version}：数据目录 ${root}（文件 files/，系统数据 system/）`)
	if (pointer !== undefined) logs.info(`自衍中枢：数据目录由指针 ${pointerPath} 指定`)

	ctx.effect(() => () => {
		clearInterval(timer)
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
