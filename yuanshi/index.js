/**
 * dsh-yuanshi — the Host half.
 *
 * The plugin owns three things:
 *
 *   1. **the data** — one folder (`~/.dsh/yuanshi` by default) holding files,
 *      sidecars, the SQLite index, the injected snapshot, settings, logs and
 *      trash. Nothing lives beside that folder;
 *   2. **the tools** — file query/read/write/import/link/index/archive/remove;
 *   3. **the injection** — a static system section and a runtime file index
 *      read from a snapshot, so a write does not rewrite the prompt prefix.
 *
 * The browser half (the panel) is the next phase; this half is loadable on its
 * own as a host plugin.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { indexText, refreshIndex, dayKey } from './src/injection.js'
import { createLogSink } from './src/logs.js'
import { staticSection } from './src/prompt.js'
import { SettingsStore } from './src/settings.js'
import { FileStore } from './src/store.js'
import { createTools } from './src/tools.js'

/** The plugin's row name. */
export const name = 'dsh-yuanshi'

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
		throw new Error('dsh-yuanshi: tools/systemPrompt services are not available')
	}
	const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : ''
	if (configured !== '' && !isAbsolute(configured)) {
		throw new Error('dsh-yuanshi: dataDir 必须是绝对路径。')
	}
	const root = configured === '' ? join(resolveDshHome(), 'yuanshi') : resolve(configured)

	const logs = createLogSink({ dataDir: root, forward: ctx.logger })
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
		logs.warn(`元始：构建注入快照失败：${error instanceof Error ? error.message : String(error)}`)
	}
	let injected = await indexText(store, current.injectionBudget)

	const disposers = []
	for (const tool of createTools({ store })) disposers.push(ctx.tools.register(tool))
	disposers.push(ctx.systemPrompt.section({
		name: 'dsh-yuanshi:files',
		order: 900,
		interpolate: false,
		text: () => staticSection(),
	}))
	disposers.push(ctx.systemPrompt.context({
		name: 'dsh-yuanshi:files',
		order: 900,
		interpolate: false,
		// Served from memory, not from disk: the prompt prefers a plain string,
		// and the text must stay byte-stable until the snapshot is refreshed.
		text: () => injected,
	}))

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
			logs.info('元始：跨日，已刷新注入快照')
		} catch (error) {
			logs.warn(`元始：刷新注入快照失败：${error instanceof Error ? error.message : String(error)}`)
		}
	}, SNAPSHOT_HEARTBEAT_MS)
	timer.unref?.()

	const version = await readVersion()
	logs.info(`元始 ${version}：数据目录 ${root}`)

	ctx.effect?.(() => async () => {
		clearInterval(timer)
		for (const dispose of disposers) {
			try {
				await dispose?.()
			} catch {
				// One broken registration must not keep the store open.
			}
		}
		await logs.close?.()
		store.close()
	})

	return { root, store, settings }
}
