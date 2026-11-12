/**
 * dsh-evolver — the Host half.
 *
 * The plugin owns four things:
 *
 *   1. **the data** — one folder (`~/.dsh/evolver` by default) with the card
 *      log and resources and the global preferences;
 *   2. **the injection** — the 2 KB tag tree and the proactive protocol;
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
import { Evolver, resolveDshHome } from './src/evolver.js'
import { createConsolidationController } from './src/consolidate.js'
import { createHealthJob, dayKeyOf } from './src/health.js'
import { assistantEvents, cacheForDay, summarizeUsage } from './src/cache.js'
import { createHarnessTools } from './src/harness/tools.js'
import { projectRootOf } from './src/harness/store.js'
import { createIngestController } from './src/ingest.js'
import { SessionLedger, digestSessions } from './src/sessions.js'
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
	 * Build (and initialise) the card store of one data folder.
	 *
	 * @param {string} root - The data folder.
	 * @returns {Promise<object>} The opened store.
	 */
	async function createCards(root) {
		const store = new CardStore({
			dataDir: root,
			logger: ctx.logger,
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
	/**
	 * Run one tool-side write, refusing while the data folder is moving.
	 *
	 * The store is closed and reopened across a migrate; a write that lands in
	 * that window goes to the folder being left behind.
	 *
	 * @param {Function} work - The write.
	 * @returns {Promise<object>} The result.
	 */
	function guardedWrite(work) {
		if (dataOperation !== undefined) {
			return Promise.reject(new Error(`${dataOperation}正在进行，请稍后再试。`))
		}
		return work()
	}

	const cardAgent = {
		write: (...args) => guardedWrite(() => cardAgentRef.current.write(...args)),
		saveFleeting: (...args) => guardedWrite(() => cardAgentRef.current.saveFleeting(...args)),
		query: (...args) => cardAgentRef.current.query(...args),
		read: (...args) => cardAgentRef.current.read(...args),
		promote: (...args) => guardedWrite(() => cardAgentRef.current.promote(...args)),
		archive: (...args) => guardedWrite(() => cardAgentRef.current.archive(...args)),
		remove: (...args) => guardedWrite(() => cardAgentRef.current.remove(...args)),
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
	 * Build overview statistics: totals and a 365-day heatmap.
	 *
	 * @param {object[]} cards - The card views.
	 * @returns {object} Totals, year metrics and daily activity.
	 */
	function overviewStats(cards) {
		const today = new Date()
		today.setHours(0, 0, 0, 0)
		const days = new Map()
		let first = Infinity
		let words = 0
		let archived = 0
		const tags = new Set()
		for (const card of cards) {
			// One pass and one character count per card: the day histogram, the
			// total, the tag set and the earliest card all come from the same
			// scan. Counting the body twice used to double the cost of the
			// most expensive part of the overview.
			let chars = 0
			for (const character of String(card.body ?? '')) {
				if (!/\s/u.test(character)) chars += 1
			}
			const date = new Date(card.created)
			if (Number.isFinite(date.getTime())) {
				date.setHours(0, 0, 0, 0)
				if (date.getTime() < first) first = date.getTime()
				const key = dayKey(date)
				const entry = days.get(key) ?? { count: 0, words: 0 }
				entry.count += 1
				entry.words += chars
				days.set(key, entry)
			}
			const isArchived = card.tags.some((tag) => tag.endsWith('/归档'))
			if (isArchived) {
				archived += 1
				continue
			}
			words += chars
			for (const tag of card.tags) tags.add(tag)
		}
		const activity = []
		for (let offset = 364; offset >= 0; offset -= 1) {
			const date = new Date(today)
			date.setDate(date.getDate() - offset)
			const key = dayKey(date)
			activity.push({ date: key, count: days.get(key)?.count ?? 0 })
		}
		const summarize = (entries) => {
			const total = entries.reduce((sum, entry) => sum + (days.get(entry.date)?.words ?? 0), 0)
			return {
				days: entries.length,
				notes: entries.reduce((sum, entry) => sum + entry.count, 0),
				words: total,
				maxNotes: entries.reduce((max, entry) => Math.max(max, entry.count), 0),
				maxWords: entries.reduce((max, entry) => Math.max(max, days.get(entry.date)?.words ?? 0), 0),
				activeDays: entries.filter((entry) => entry.count > 0).length,
			}
		}
		const span = first === Infinity ? 0 : Math.max(1, Math.floor((today.getTime() - first) / 86_400_000) + 1)
		return {
			cards: cards.length,
			tags: tags.size,
			days: span,
			words,
			activity,
			year: summarize(activity),
		}
	}

	/**
	 * Run one edit and do not answer before it is on disk.
	 *
	 * The store batches its writes behind a debounce, which is right for the
	 * agent (it saves several cards in a row) but wrong for the panel: the user
	 * is told "已保存" while the change is still only in memory, and a crash
	 * within the window loses it. A panel edit pays one write.
	 *
	 * @param {(store: object) => Promise<object>} work - The edit.
	 * @returns {Promise<object>} The edit's result.
	 */
	async function committed(work) {
		// A folder move closes the store and reopens it somewhere else; a write
		// that slipped through that window landed in the folder being left
		// behind and still answered success.
		if (dataOperation !== undefined) {
			throw new Error(`${dataOperation}正在进行，请稍后再试。`)
		}
		const store = cardStoreRef.current
		const result = await work(store)
		await store.flush()
		return result
	}

	const cardsApi = {
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
			const page = query === ''
				? store.listPage({ tags, anyTags, limit, includeArchived, archivedOnly })
				: { cards: await store.query({ text: query, tags, anyTags, limit, includeArchived, archivedOnly }), total: 0 }
			return {
				cards: page.cards,
				// How many cards the filter matches in total: the panel gets a
				// page, and without this number a truncated list looks complete.
				total: page.total === 0 ? page.cards.length : page.total,
				tree: store.tagTree(),
				status: store.status(),
				cardMaxChars: settings.get().cardMaxChars,
			}
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
		write(payload = {}) {
			return committed((store) => store.put(payload.card ?? {}))
		},
		promote(payload = {}) {
			return committed((store) => store.promote(String(payload.id ?? ''), payload))
		},
		archive(payload = {}) {
			return committed((store) => store.archive(String(payload.id ?? '')))
		},
		async remove(payload = {}) {
			return { removed: await committed((store) => store.remove(String(payload.id ?? ''))) }
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
		/**
		 * Cache numbers for one session.
		 *
		 * Read on demand rather than continuously: the snapshot carries the
		 * whole event log, which is the expensive part of the question.
		 *
		 * @param {string} id - The session id.
		 * @returns {Promise<object>} The report.
		 */
		async cache(id) {
			const query = ctx.get('sessionQuery')
			if (query === undefined) throw new Error('这个宿主没有提供会话读取能力（sessionQuery）。')
			const snapshot = await query.readSession(id)
			if (snapshot === undefined || snapshot === null) throw new Error(`读不到会话：${id}`)
			const events = assistantEvents(snapshot)
			return { session: String(id), ...summarizeUsage(events) }
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

	const consolidate = createConsolidationController({
		settings,
		store: () => cardStoreRef.current,
		llm: ctx.get('llm'),
		modelSelection: ctx.get('agentDefaultModel'),
		logger: ctx.logger,
	})

	const health = createHealthJob({
		store: () => cardStoreRef.current,
		logger: ctx.logger,
		// The daily row also records how the prompt cache behaved, which only
		// the session service can answer.
		cache: (day) => cacheForDay({ query: ctx.get('sessionQuery'), day, dayKeyOf }),
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
		async exportTo({ dir = '', name = '', force = false } = {}) {
			// A folder and a name, never a whole path: the panel only ever sends
			// these two, and accepting a free path would let one request write
			// the archive bytes over any file the process can reach.
			let target
			{
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
	disposers.push(consolidate.start())
	disposers.push(health.start())

	ctx.effect(() => {
		backup.start()
		return () => backup.stop()
	}, 'dsh-evolver: backup scheduler')

	/**
	 * Find the project a tool call belongs to.
	 *
	 * Tools do not receive a working directory — the run context carries only
	 * the agent id — so it is read back from the session header, which the host
	 * records when the session starts.
	 *
	 * @param {{project?: string, agent?: {id?: string}}} exec - The call context.
	 * @returns {Promise<string | undefined>} The project root.
	 */
	const projectCache = new Map()
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
		projectCache.set(id, resolved)
		return resolved
	}

	for (const tool of createTools({ cards: cardAgent, sessions })) {
		disposers.push(ctx.tools.register(tool))
	}
	for (const tool of createHarnessTools({ resolveProject })) {
		disposers.push(ctx.tools.register(tool))
	}

	// The two injected blocks. Their text is served from a cache so the
	// assembled prompt stays byte-stable between changes.
	disposers.push(ctx.systemPrompt.section({
		name: 'dsh-evolver:cards',
		order: 900,
		interpolate: false,
		text: () => (cardStoreRef.current === undefined ? '' : cardPrompt(cardStoreRef.current, DEFAULT_PROMPT_BUDGET, tagDescriptionsRef.current)),
	}))
	// The data is already injected; this tells the model when to act on it
	// without being asked. Kept small: it rides on every request.
	disposers.push(ctx.systemPrompt.section({
		name: 'dsh-evolver:proactive',
		order: 920,
		interpolate: false,
		text: () => PROACTIVE_PROTOCOL,
	}))

	const view = () => settings.publicView(workspace.state())
	const ingestApi = {
		status: () => ingest.status(),
		save: (patch) => ingest.save(patch),
		run: () => ingest.run(),
	}
	const consolidateApi = {
		status: () => consolidate.status(),
		save: (patch) => consolidate.save(patch),
		run: () => consolidate.run(),
	}
	const handler = createEvolverHandler({ evolver, settings, backup, workspace, view, ingest: ingestApi, consolidate: consolidateApi, cards: cardsApi })
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
