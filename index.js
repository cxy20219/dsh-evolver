/**
 * dsh-evolver — the Host half.
 *
 * The plugin owns four things:
 *
 *   1. **the data** — one folder (`~/.dsh/evolver` by default) with the card
 *      log and resources, the soul and the global preferences;
 *   2. **the injection** — the 2 KB tag tree, the soul and the
 *      proactive protocol;
 *   3. **the tools** — card-native query/read/write/index/promote/archive/
 *      remove, plus `evolve_review` and `session_digest`;
 *   4. **the settings** — where the data folder lives, its card budget, and
 *      how its whole content is backed up to OSS.
 *
 * Nothing is imported from the Harness installation: the storage engine only
 * uses Node's own file system, and the API the browser calls is registered on
 * the Connection service the Host already provides.
 */

import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { MAX_IMPORT_BYTES, extractArchiveFile, writeArchiveFile } from './src/backup/archive.js'
import { BackupService } from './src/backup/service.js'
import { EMBEDDING_MODELS, ModelDownloader, embeddingConfig, embeddingLocations, modelPresent, probeEmbedding, runtimeState } from './src/embedding.js'
import { Evolver, resolveDshHome } from './src/evolver.js'
import { createIngestController } from './src/ingest.js'
import { SessionLedger, digestSessions } from './src/sessions.js'
import { createEmbedder } from './src/memory/embed.js'
import { createEvolverHandler, ENDPOINTS } from './src/remote.js'
import { SettingsStore } from './src/settings.js'
import { createTools } from './src/tools.js'
import { PROACTIVE_PROTOCOL } from './src/proactive.js'
import { createCardAgent } from './src/cards/agent.js'
import { seedStarterCards } from './src/cards/seed.js'
import { cardPrompt, DEFAULT_PROMPT_BUDGET } from './src/cards/prompt.js'
import { CardStore } from './src/cards/store.js'
import { TAG_DESCRIPTIONS } from './src/cards/tags.js'
import { copyTree, countEntries, isDirectory, isInsidePath, pathsOverlap } from './src/workspace.js'

/** The plugin's row name. */
export const name = 'dsh-evolver'

/** The API prefix the browser calls. */
export const API_PREFIX = '/api/evolver'

/** How often the injected text is refreshed, in milliseconds. */
const REFRESH_MS = 60_000

/** How large a request body the panel API accepts. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024

/**
 * The plugin's own version, read from the package it ships in.
 *
 * The panel shows it, so it has to come from the installed copy rather than
 * from anything hard-coded here.
 *
 * @returns {Promise<string>} The version, or an empty string when unreadable.
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
 * Decide which data folder to open.
 *
 * The panel's setting wins over the composition config: the panel is where the
 * user changes it, and a value that silently lost to an older config would be
 * impossible to explain. A stored folder that has gone missing is *not*
 * recreated — that is how a disconnected external disk turns into an empty
 * practice store — the default is used with a warning instead.
 *
 * @param {{configured?: unknown, stored?: unknown, defaultRoot: string}} options - The candidates.
 * @returns {Promise<{root: string, source: string, warning: string}>} The decision.
 */
async function resolveRoot({ configured, stored, defaultRoot }) {
	const candidates = [
		{ value: stored, source: 'settings' },
		{ value: configured, source: 'config' },
	]
	for (const candidate of candidates) {
		if (typeof candidate.value !== 'string' || candidate.value.trim() === '') continue
		const raw = candidate.value.trim()
		if (!isAbsolute(raw)) {
			// A stored setting must never brick the plugin, so it falls back
			// with a warning. A composition path is developer configuration:
			// failing loudly is the only way it gets fixed.
			if (candidate.source === 'config') {
				throw new Error(`dsh-evolver: dataDir 必须是绝对路径，收到的是 ${raw}`)
			}
			return { root: defaultRoot, source: 'default', warning: `设置里的数据目录不是绝对路径（${raw}），已使用默认目录。` }
		}
		const path = resolve(raw)
		if (candidate.source === 'settings' && !(await isDirectory(path))) {
			return { root: defaultRoot, source: 'default', warning: `设置里记录的数据目录不存在（${path}），本次使用默认目录。` }
		}
		return { root: path, source: candidate.source, warning: '' }
	}
	return { root: defaultRoot, source: 'default', warning: '' }
}

/**
 * Validate one absolute path a workspace action was given.
 *
 * @param {unknown} value - The path from the request.
 * @returns {string} The resolved path.
 */
function requestPath(value) {
	const text = String(value ?? '').trim()
	if (text === '') throw new Error('请填写路径。')
	if (text.includes('\u0000') || /[\r\n]/.test(text)) throw new Error('路径不合法。')
	if (!isAbsolute(text)) throw new Error(`必须是绝对路径：${text}`)
	const resolved = resolve(text)
	// `dirname('/') === '/'`: a root folder would turn a copy into a system
	// write, however the user got there.
	if (resolved === dirname(resolved)) throw new Error('不能把文件系统根目录当作目标。')
	return resolved
}

/**
 * Resolve a path to the directory it physically names.
 *
 * Two spellings of the same folder (a symlinked parent, for example) must be
 * recognised as the same folder before anything is copied; a missing target
 * falls back to its parent's real path plus the requested name.
 *
 * @param {string} path - The absolute path.
 * @returns {Promise<string>} The canonical path.
 */
async function canonicalPath(path) {
	try {
		return await realpath(path)
	} catch {
		const parent = await realpath(dirname(path)).catch(() => undefined)
		return parent === undefined ? path : join(parent, basename(path))
	}
}

/**
 * Refuse a copy whose destination overlaps its source.
 *
 * @param {string} current - The data folder.
 * @param {string} target - The requested destination.
 * @param {string} label - What the destination is for.
 * @returns {void}
 */
function assertSeparate(current, target, label) {
	if (pathsOverlap(current, target)) throw new Error(`${label}不能与数据目录相同或互相包含。`)
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

	const dshHome = resolveDshHome()
	const defaultRoot = join(dshHome, 'evolver')
	const settings = new SettingsStore({ path: join(dshHome, 'evolver.config.json'), logger: ctx.logger })
	await settings.load()
	const resolved = await resolveRoot({
		configured: config?.dataDir,
		stored: settings.get().dataDir,
		defaultRoot,
	})
	if (resolved.warning !== '') ctx.logger.warn(`dsh-evolver: ${resolved.warning}`)

	const evolver = new Evolver({
		root: resolved.root,
		logger: ctx.logger,
		dshHome,
		version: await readVersion(),
	})
	await evolver.ensure()
	await evolver.linkGlobalIfNeeded()
	// The card store is replaced whenever the data folder changes, so the
	// tools and the API talk to small proxies rather than to one instance.
	const cardStoreRef = { current: undefined }
	const cardAgentRef = { current: undefined }
	// The injected text is rendered synchronously on every request, so the
	// effective tag descriptions are cached here and refreshed on every write.
	const tagDescriptionsRef = { current: { ...TAG_DESCRIPTIONS } }

	/**
	 * The embedding configuration the settings currently ask for.
	 *
	 * @returns {object} The createEmbedder configuration.
	 */
	function currentEmbeddingConfig() {
		return embeddingConfig(settings.get().embedding, { dataDir: evolver.root, dshHome, logger: ctx.logger })
	}

	/**
	 * Rebuild the store after the embedding backend changed.
	 *
	 * The new store is opened before the old one is dropped, so a failing
	 * backend never leaves the plugin without a memory store.
	 *
	 * @returns {Promise<void>} Resolves once the swap is done.
	 */
	async function reopenEmbedding() {
		const nextCards = await createCards(evolver.root)
		const previousCards = cardStoreRef.current
		useCards(nextCards)
		await previousCards?.close().catch(() => {})
		ctx.logger.info(`dsh-evolver: embedding backend reopened (${nextCards.status().embedder})`)
	}

	/**
	 * Build (and initialise) the card store of one data folder.
	 *
	 * @param {string} root - The data folder.
	 * @returns {Promise<object>} The opened store.
	 */
	async function createCards(root) {
		const store = new CardStore({
			dataDir: root,
			logger: ctx.logger,
			embedding: createEmbedder(currentEmbeddingConfig()),
			cardMaxChars: settings.get().cardMaxChars,
		})
		await store.init()
		try {
			const seeded = await seedStarterCards(store)
			if (seeded > 0) ctx.logger.info(`dsh-evolver: seeded ${seeded} starter card(s)`)
		} catch (error) {
			ctx.logger.warn(`dsh-evolver: seeding cards failed: ${error instanceof Error ? error.message : String(error)}`)
		}
		return store
	}

	/**
	 * Make one card store the one the tools use.
	 *
	 * The store is replaced whenever the data folder changes, so the cached
	 * tag descriptions are reloaded from the new folder right here.
	 *
	 * @param {object} store - The opened store.
	 * @returns {void}
	 */
	function useCards(store) {
		cardStoreRef.current = store
		cardAgentRef.current = createCardAgent(store)
		void store.tagDescriptions()
			.then((descriptions) => { tagDescriptionsRef.current = descriptions })
			.catch((error) => {
				ctx.logger.warn(`dsh-evolver: reading tag descriptions failed: ${error instanceof Error ? error.message : String(error)}`)
			})
	}

	/**
	 * Open the card store of one data folder.
	 *
	 * @param {string} root - The data folder.
	 * @returns {Promise<object>} The opened store.
	 */
	async function openCards(root) {
		const store = await createCards(root)
		useCards(store)
		return store
	}

	await openCards(resolved.root)

	// Tools and the ingest job talk to this proxy; a data-folder switch
	// replaces the agent behind it without changing tool identities.
	const cardAgent = {
		write: (...args) => cardAgentRef.current.write(...args),
		saveFleeting: (...args) => cardAgentRef.current.saveFleeting(...args),
		query: (...args) => cardAgentRef.current.query(...args),
		read: (...args) => cardAgentRef.current.read(...args),
		promote: (...args) => cardAgentRef.current.promote(...args),
		archive: (...args) => cardAgentRef.current.archive(...args),
		remove: (...args) => cardAgentRef.current.remove(...args),
		index: (...args) => cardAgentRef.current.index(...args),
		review: (...args) => cardAgentRef.current.review(...args),
	}

	/**
	 * The browser-facing card API.
	 *
	 * Reads enrich link ids with labels; writes go through the same CardStore
	 * as the tools, so the panel and the agent cannot disagree.
	 */
	/**
	 * The local calendar key of a date.
	 *
	 * @param {Date} date - The date.
	 * @returns {string} `YYYY-MM-DD` in local time.
	 */
	function dayKey(date) {
		const year = date.getFullYear()
		const month = String(date.getMonth() + 1).padStart(2, '0')
		const day = String(date.getDate()).padStart(2, '0')
		return `${year}-${month}-${day}`
	}

	/**
	 * Count visible characters, ignoring whitespace.
	 *
	 * @param {string} text - Card body.
	 * @returns {number} Character count.
	 */
	function characterCount(text) {
		return [...String(text ?? '').replace(/\s+/gu, '')].length
	}

	/**
	 * Build overview statistics: totals and a 365-day heatmap.
	 *
	 * @param {object[]} cards - The card views.
	 * @returns {object} Totals, year metrics and daily activity.
	 */
	function overviewStats(cards) {
		const createdDays = cards
			.map((card) => new Date(card.created))
			.filter((date) => Number.isFinite(date.getTime()))
			.map((date) => {
				date.setHours(0, 0, 0, 0)
				return date
			})
			.sort((left, right) => left - right)
		const today = new Date()
		today.setHours(0, 0, 0, 0)
		const days = new Map()
		for (const card of cards) {
			const date = new Date(card.created)
			if (!Number.isFinite(date.getTime())) continue
			date.setHours(0, 0, 0, 0)
			const key = dayKey(date)
			const entry = days.get(key) ?? { count: 0, words: 0 }
			entry.count += 1
			entry.words += characterCount(card.body)
			days.set(key, entry)
		}
		const activity = []
		for (let offset = 364; offset >= 0; offset -= 1) {
			const date = new Date(today)
			date.setDate(date.getDate() - offset)
			const key = dayKey(date)
			activity.push({ date: key, count: days.get(key)?.count ?? 0 })
		}
		const summarize = (entries) => {
			const words = entries.reduce((sum, entry) => sum + (days.get(entry.date)?.words ?? 0), 0)
			return {
				days: entries.length,
				notes: entries.reduce((sum, entry) => sum + entry.count, 0),
				words,
				maxNotes: entries.reduce((max, entry) => Math.max(max, entry.count), 0),
				maxWords: entries.reduce((max, entry) => Math.max(max, days.get(entry.date)?.words ?? 0), 0),
				activeDays: entries.filter((entry) => entry.count > 0).length,
			}
		}
		const first = createdDays[0]
		const span = first === undefined ? 0 : Math.max(1, Math.floor((today - first) / 86_400_000) + 1)
		const active = cards.filter((card) => !card.tags.some((tag) => tag.endsWith('/归档')))
		const tags = new Set(active.flatMap((card) => card.tags)).size
		const words = active.reduce((sum, card) => sum + characterCount(card.body), 0)
		return {
			cards: cards.length,
			tags,
			days: span,
			words,
			activity,
			year: summarize(activity),
		}
	}

	const cardsApi = {
		async status() {
			const store = cardStoreRef.current
			return { ...store.status(), cardMaxChars: settings.get().cardMaxChars }
		},
		setCardMaxChars(value) {
			const store = cardStoreRef.current
			if (store !== undefined) store.cardMaxChars = value
		},
		async overview() {
			const store = cardStoreRef.current
			const base = await evolver.overview()
			const status = store.status()
			const descriptions = await store.tagDescriptions()
			const text = cardPrompt(store, undefined, descriptions)
			const all = store.all()
			const stats = overviewStats(all)
			return {
				...base,
				stats: { cards: stats.cards, tags: stats.tags, days: stats.days, words: stats.words },
				year: stats.year,
				activity: stats.activity,
				tree: store.tagTree(),
				projection: {
					entries: status.cards,
					bytes: Buffer.byteLength(text, 'utf8'),
					budget: DEFAULT_PROMPT_BUDGET,
					dropped: 0,
				},
				cards: {
					...status,
					total: status.cards,
					cardMaxChars: settings.get().cardMaxChars,
				},
				suggestions: [],
			}
		},
		async injection() {
			const store = cardStoreRef.current
			const base = await evolver.injectionPreview()
			const status = store.status()
			const descriptions = await store.tagDescriptions()
			const text = cardPrompt(store, undefined, descriptions)
			return {
				...base,
				cards: {
					entries: status.cards,
					bytes: Buffer.byteLength(text, 'utf8'),
					budget: DEFAULT_PROMPT_BUDGET,
					dropped: 0,
					text,
				},
			}
		},
		async list(payload = {}) {
			const store = cardStoreRef.current
			const limit = Number(payload.limit ?? 100)
			const tags = Array.isArray(payload.tags) ? payload.tags : []
			const anyTags = Array.isArray(payload.anyTags) ? payload.anyTags : []
			const includeArchived = payload.includeArchived === true
			const archivedOnly = payload.archivedOnly === true
			const query = String(payload.query ?? '').trim()
			const cards = query === ''
				? store.list({ tags, anyTags, limit, includeArchived, archivedOnly })
				: await store.query({ text: query, tags, anyTags, limit, includeArchived, archivedOnly })
			return { cards, tree: store.tagTree(), status: store.status(), cardMaxChars: settings.get().cardMaxChars }
		},
		async read(payload = {}) {
			const store = cardStoreRef.current
			const card = await store.read(String(payload.id ?? ''))
			if (card === undefined) return { card: null, links: [], backlinks: [] }
			const describe = (id) => {
				const found = store.get(id)
				return found === undefined
					? { id, label: '(missing)', tags: [] }
					: { id, label: found.label, tags: found.tags }
			}
			const incoming = store.backlinks()[card.id] ?? []
			return {
				card,
				links: (card.links ?? []).map(describe),
				backlinks: incoming.map(describe),
			}
		},
		async write(payload = {}) {
			const store = cardStoreRef.current
			return store.put(payload.card ?? {})
		},
		async promote(payload = {}) {
			const store = cardStoreRef.current
			return store.promote(String(payload.id ?? ''), payload)
		},
		async archive(payload = {}) {
			const store = cardStoreRef.current
			return store.archive(String(payload.id ?? ''))
		},
		async remove(payload = {}) {
			const store = cardStoreRef.current
			return { removed: await store.remove(String(payload.id ?? '')) }
		},
		async attach(payload = {}) {
			const store = cardStoreRef.current
			const id = String(payload.id ?? '')
			const name = String(payload.name ?? '')
			const encoded = String(payload.data ?? '')
			if (encoded === '') throw new Error('附件内容为空。')
			const data = Buffer.from(encoded, 'base64')
			if (data.length === 0) throw new Error('附件内容为空。')
			if (data.length > 10 * 1024 * 1024) throw new Error('附件超过 10 MB 上限。')
			return store.attach(id, name, data)
		},
		tags() {
			const store = cardStoreRef.current
			return store.tagTree()
		},
		/**
		 * The tag descriptions and the branches still missing one.
		 *
		 * The gap list is the point of this view: a branch grows as soon as a
		 * card uses a new path, but its meaning stays unwritten until somebody
		 * documents it here.
		 *
		 * @returns {Promise<object>} Descriptions, undocumented branches and the file path.
		 */
		async tagDescriptionsView() {
			const store = cardStoreRef.current
			const descriptions = await store.tagDescriptions()
			const missing = []
			const walk = (nodes) => {
				for (const node of nodes ?? []) {
					if (node.path.endsWith('/归档')) continue
					if (descriptions[node.path] === undefined) {
						missing.push({ path: node.path, count: node.count })
					}
					walk(node.children)
				}
			}
			walk(store.tagTree())
			return {
				path: store.tagDescriptionsPath(),
				descriptions,
				missing,
			}
		},
		/**
		 * Save the tag descriptions.
		 *
		 * @param {object} descriptions - Tag path to description.
		 * @returns {Promise<object>} The saved descriptions.
		 */
		async saveTagDescriptions(descriptions) {
			const store = cardStoreRef.current
			const saved = await store.saveTagDescriptions(descriptions)
			// The injected block renders synchronously, so it picks the new
			// descriptions up from the cache on the next request.
			tagDescriptionsRef.current = saved
			return { path: store.tagDescriptionsPath(), descriptions: saved }
		},
	}

	// The ledger lives inside the data folder, which may move. Every call
	// opens the current location instead of holding a path captured at boot.
	const ledger = () => new SessionLedger({ dataDir: evolver.root })
	const sessions = {
		async digest(args = {}) {
			const query = ctx.get('sessionQuery')
			if (query === undefined) return { success: false, message: '这个宿主没有提供会话读取能力（sessionQuery）。' }
			return digestSessions({
				query,
				ledger: ledger(),
				sinceDays: args.sinceDays,
				limit: args.limit,
				commit: args.commit === true,
			})
		},
	}
	const ingestLedger = {
		load: () => ledger().load(),
		commit: (...args) => ledger().commit(...args),
		snapshot: () => ledger().snapshot(),
	}
	const ingest = createIngestController({
		settings,
		query: ctx.get('sessionQuery'),
		ledger: ingestLedger,
		save: (item) => cardAgent.saveFleeting(item),
		llm: ctx.get('llm'),
		modelSelection: ctx.get('agentDefaultModel'),
		logger: ctx.logger,
	})

	const backup = new BackupService({
		settings,
		root: () => evolver.root,
		logger: ctx.logger,
		flush: () => cardStoreRef.current?.flush(),
	})
	const rootState = { source: resolved.source, warning: resolved.warning }

	const workspace = {
		/**
		 * The current folder, for the settings page.
		 *
		 * @returns {object} The state.
		 */
		state() {
			return {
				root: evolver.root,
				source: rootState.source,
				warning: rootState.warning,
				defaultRoot,
				settingsPath: settings.path,
				backupRunning: backup.running,
			}
		},

		/**
		 * Copy the data folder to a new place and continue there.
		 *
		 * @param {unknown} dir - The new folder.
		 * @param {{force?: boolean}} [options] - Overwrite behaviour.
		 * @returns {Promise<object>} What happened.
		 */
		async migrate(dir, { force = false } = {}) {
			// The requested spelling is what the user sees and what the settings
			// store; the canonical path is only used for the safety checks, so
			// two spellings of the same folder cannot slip past them.
			const requested = requestPath(dir)
			const target = await canonicalPath(requested)
			const current = await canonicalPath(evolver.root)
			if (target === current) {
				throw new Error('这就是当前数据目录，不需要迁移；请选择另一个目录。')
			}
			assertSeparate(current, target, '新数据目录')
			if (await isDirectory(requested)) {
				const entries = await countEntries(requested)
				if (entries > 0 && !force) throw new Error(`目标目录不是空的（${entries} 项）；确认覆盖后重试。`)
			} else if (!(await isDirectory(dirname(requested)))) {
				throw new Error(`目标目录的上级不存在：${dirname(requested)}`)
			}
			// Flush first: the copy has to see the newest card writes.
			await cardStoreRef.current?.close().catch(() => {})
			let copied
			try {
				copied = await copyTree(evolver.root, requested, { force })
			} catch (error) {
				// The old folder is untouched; reopen it so the plugin keeps
				// answering with the data it had before the attempt.
				await openCards(evolver.root).catch(() => {})
				throw error
			}
			// Persist the new location *before* switching: if the switch fails,
			// the next start still lands on the folder that already holds the
			// copy, instead of silently drifting back to the old one.
			await settings.update({ dataDir: requested })
			await evolver.switchRoot(requested)
			await openCards(requested)
			rootState.source = 'settings'
			rootState.warning = ''
			ctx.logger.info(`dsh-evolver: data folder moved to ${requested}`)
			return { root: requested, ...copied }
		},

		/**
		 * Copy the data folder out, leaving the current one in use.
		 *
		 * @param {unknown} dir - The destination.
		 * @param {{force?: boolean}} [options] - Overwrite behaviour.
		 * @returns {Promise<object>} What happened.
		 */
		async exportTo({ file = '', dir = '', name = '', force = false } = {}) {
			let target
			const explicit = String(file ?? '').trim()
			if (explicit !== '') {
				target = requestPath(explicit)
			} else {
				// The panel offers a folder picker plus a name field; the two
				// are joined here so the client never has to know the separator.
				const folder = requestPath(dir)
				if (!(await isDirectory(folder))) throw new Error(`导出目录不存在：${folder}`)
				let fileName = String(name ?? '').trim()
				if (fileName === '' || fileName.length > 128 || /[\\/\u0000\r\n]/.test(fileName) || /^\.+$/.test(fileName)) {
					throw new Error(`文件名不合法：${fileName === '' ? '（空）' : fileName}`)
				}
				// Always end with an archive suffix, otherwise the import
				// browser would not find the file it just wrote.
				if (!/\.(tar\.gz|tgz|tar)$/i.test(fileName)) fileName += '.tar.gz'
				target = join(folder, fileName)
			}
			const current = await canonicalPath(evolver.root)
			if (isInsidePath(current, await canonicalPath(target))) {
				throw new Error('导出文件不能放在数据目录里面。')
			}
			const existing = await lstat(target).catch(() => undefined)
			if (existing !== undefined) {
				if (!existing.isFile()) throw new Error(`导出目标必须是文件：${target}`)
				if (!force) throw new Error(`文件已存在：${target}；确认覆盖后重试。`)
			} else if (!(await isDirectory(dirname(target)))) {
				throw new Error(`导出目录的上级不存在：${dirname(target)}`)
			}
			// Flush first so the archive contains the newest card writes. The
			// store is reopened afterwards: an export must not leave the plugin
			// without its read path.
			await cardStoreRef.current?.close().catch(() => {})
			try {
				// Weights are part of the data folder now; the archive streams,
				// so a 570 MB model does not have to fit in memory.
				const packed = await writeArchiveFile(evolver.root, target)
				return { file: target, bytes: packed.bytes, files: packed.files }
			} finally {
				await openCards(evolver.root).catch(() => {})
			}
		},

		/**
		 * List the archives in one folder.
		 *
		 * The client has a folder picker but no file picker, so the flow is
		 * "pick a folder, choose one of its archives"; this is that second
		 * step. Only our three archive suffixes are returned.
		 *
		 * @param {unknown} dir - The folder.
		 * @returns {Promise<object>} The folder and its archives, newest first.
		 */
		async listArchives(dir) {
			const folder = requestPath(dir)
			if (!(await isDirectory(folder))) throw new Error(`目录不存在：${folder}`)
			const names = await readdir(folder).catch(() => [])
			const files = []
			for (const name of names) {
				if (!/\.(tar\.gz|tgz|tar)$/i.test(name)) continue
				const path = join(folder, name)
				const info = await lstat(path).catch(() => undefined)
				if (info === undefined || !info.isFile()) continue
				files.push({ name, path, size: info.size, updatedAt: info.mtime.toISOString() })
			}
			files.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.name.localeCompare(right.name))
			return { dir: folder, files: files.slice(0, 200) }
		},

		async importFrom(file, { force = false } = {}) {
			const source = requestPath(file)
			const info = await lstat(source).catch(() => undefined)
			if (info === undefined || !info.isFile()) throw new Error(`导入文件不存在：${source}`)
			if (info.size > MAX_IMPORT_BYTES) {
				throw new Error(`压缩包超过 ${MAX_IMPORT_BYTES / 1024 / 1024 / 1024} GB，拒绝导入。`)
			}
			const current = await canonicalPath(evolver.root)
			if (isInsidePath(current, await canonicalPath(source))) {
				throw new Error('导入文件不能是数据目录里的文件。')
			}
			await cardStoreRef.current?.close().catch(() => {})
			let restored
			try {
				restored = await extractArchiveFile(source, evolver.root, { force })
			} catch (error) {
				// A half-finished import must not leave the in-memory store out
				// of sync with the files that did land.
				await openCards(evolver.root).catch(() => {})
				const message = error instanceof Error ? error.message : String(error)
				throw new Error(message.includes('压缩包') ? message : `不能读取压缩包：${message}`)
			}
			try {
				await evolver.switchRoot(evolver.root)
			} catch (error) {
				await openCards(evolver.root).catch(() => {})
				throw error
			}
			await openCards(evolver.root)
			return restored
		},
	}

	/**
	 * The data operation currently holding the folder, if any.
	 *
	 * @type {string | undefined}
	 */
	let dataOperation

	/**
	 * Run one data-folder operation while no other one is in flight.
	 *
	 * @param {string} label - What the operation is, for the refusal message.
	 * @param {() => Promise<unknown>} action - The operation.
	 * @returns {Promise<unknown>} Its result.
	 */
	async function exclusive(label, action) {
		if (dataOperation !== undefined) {
			throw new Error(`${dataOperation}正在进行，请稍后再试。`)
		}
		dataOperation = label
		try {
			return await action()
		} finally {
			dataOperation = undefined
		}
	}

	// Moving, exporting and importing all copy the folder and reopen the
	// memory store. Two at once could leave the store pointing at a folder the
	// evolver no longer uses, so they share one gate.
	const exclusiveOperations = { migrate: '迁移', exportTo: '导出', importFrom: '导入' }
	for (const [method, label] of Object.entries(exclusiveOperations)) {
		const original = workspace[method]
		workspace[method] = function (...args) {
			return exclusive(label, () => original.apply(workspace, args))
		}
	}

	/**
	 * A signature of the fields that require a new embedder instance.
	 *
	 * @param {object} embedding - The settings block.
	 * @returns {string} The signature.
	 */
	function embeddingSignature(embedding) {
		return [embedding.provider, embedding.model, embedding.runtimePath, embedding.baseURL, embedding.apiKey].join('\u0000')
	}

	const downloader = new ModelDownloader({
		logger: ctx.logger,
		onDone: async ({ model }) => {
			const current = settings.get().embedding
			// Only pick the weights up when they are the ones the user selected.
			if (current.provider !== 'model' || current.model !== model) return
			await reopenEmbedding()
		},
	})

	/**
	 * The status the panel's embedding settings are built from.
	 *
	 * @returns {Promise<object>} The status.
	 */
	async function embeddingStatus() {
		const raw = settings.get().embedding
		const locations = embeddingLocations(raw, { dataDir: evolver.root, dshHome })
		const present = {}
		for (const model of EMBEDDING_MODELS) present[model.id] = await modelPresent(model, locations.modelsDir)
		return {
			embedding: settings.publicView(workspace.state()).embedding,
			resolved: { modelsDir: locations.modelsDir, runtimePath: locations.runtimePath },
			runtime: runtimeState(locations.runtimePath),
			catalog: EMBEDDING_MODELS.map((model) => ({
				id: model.id,
				label: model.label,
				languages: model.languages,
				dimensions: model.dimensions,
				bytes: model.bytes,
				note: model.note,
			})),
			present,
			download: downloader.state(),
			store: cardStoreRef.current.status(),
		}
	}

	const embedding = {
		status: embeddingStatus,
		async save(patch) {
			const before = embeddingSignature(settings.get().embedding)
			await settings.update({ embedding: patch })
			if (embeddingSignature(settings.get().embedding) !== before) await reopenEmbedding()
			return embeddingStatus()
		},
		async download(model) {
			const raw = settings.get().embedding
			const locations = embeddingLocations(raw, { dataDir: evolver.root, dshHome })
			await downloader.start({ model, mirror: raw.mirror, modelsDir: locations.modelsDir })
			return embeddingStatus()
		},
		cancel() {
			downloader.cancel()
			return embeddingStatus()
		},
		async test() {
			return probeEmbedding(currentEmbeddingConfig())
		},
	}

	/** Everything that has to be undone, in registration order. */
	const disposers = []

	ctx.effect(() => () => {
		downloader.cancel()
		for (const dispose of disposers) {
			try {
				dispose()
			} catch {
				// A failing disposer must not stop the others.
			}
		}
		// Writing out the debounced saves is part of shutting down.
		return cardStoreRef.current?.close().catch(() => {})
	}, 'dsh-evolver: resources')

	// Any session activity postpones the idle run; the scheduled ingest run
	// itself counts as activity, so two runs cannot overlap by accident.
	for (const event of ['session/event', 'agent/status', 'api-session/activity']) {
		try {
			disposers.push(ctx.on(event, () => ingest.noteActivity()))
		} catch {
			// An event this Host does not publish is not a reason to fail.
		}
	}
	disposers.push(ingest.start())

	ctx.effect(() => {
		backup.start()
		return () => backup.stop()
	}, 'dsh-evolver: backup scheduler')

	for (const tool of createTools({ cards: cardAgent, sessions })) {
		disposers.push(ctx.tools.register(tool))
	}

	// The two injected blocks. Their text is served from a cache so the
	// assembled prompt stays byte-stable between changes.
	await evolver.refresh()
	disposers.push(ctx.systemPrompt.section({
		name: 'dsh-evolver:cards',
		order: 900,
		interpolate: false,
		text: () => (cardStoreRef.current === undefined ? '' : cardPrompt(cardStoreRef.current, DEFAULT_PROMPT_BUDGET, tagDescriptionsRef.current)),
	}))
	disposers.push(ctx.systemPrompt.section({
		name: 'dsh-evolver:soul',
		order: 910,
		interpolate: false,
		text: () => evolver.cache.soul,
	}))
	// The data is already injected; this tells the model when to act on it
	// without being asked. Kept small: it rides on every request.
	disposers.push(ctx.systemPrompt.section({
		name: 'dsh-evolver:proactive',
		order: 920,
		interpolate: false,
		text: () => PROACTIVE_PROTOCOL,
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

	const view = () => settings.publicView(workspace.state())
	const ingestApi = {
		status: () => ingest.status(),
		save: (patch) => ingest.save(patch),
		run: () => ingest.run(),
	}
	const handler = createEvolverHandler({ evolver, settings, backup, workspace, view, embedding, ingest: ingestApi, cards: cardsApi })
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

	ctx.logger.info(`dsh-evolver: serving ${evolver.root} on ${API_PREFIX}`)
}
