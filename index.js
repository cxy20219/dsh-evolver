/**
 * dsh-evolver — the Host half.
 *
 * The plugin owns four things:
 *
 *   1. **the data** — one folder (`~/.dsh/evolver` by default) with the card
 *      log and resources and the global preferences;
 *   2. **the injection** — two blocks split by volatility: one static system
 *      section (card discipline plus the proactive protocol) and one runtime
 *      snapshot (the card index);
 *   3. **the tools** — card-native query/read/write/index/promote/archive/
 *      remove, plus `evolve_review` and `session_digest`;
 *   4. **the settings** — where the data folder lives, its card budget, and
 *      how its whole content is backed up to OSS.
 *
 * Nothing is imported from the Harness installation: the storage engine only
 * uses Node's own file system, and the API the browser calls is registered on
 * the Connection service the Host already provides.
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'

import { BackupService } from './src/backup/service.js'
import { Evolver, resolveDshHome } from './src/evolver.js'
import { createConsolidationController } from './src/consolidate.js'
import { createLogSink } from './src/logs.js'
import { createOrganizeSettings } from './src/organize.js'
import { createHealthJob, dayKeyOf } from './src/health.js'
import { assistantEvents, cacheForDay, summarizeUsage } from './src/cache.js'
import { createHarnessTools } from './src/harness/tools.js'
import { projectRootOf } from './src/harness/store.js'
import { createIngestController } from './src/ingest.js'
import { SessionLedger, digestSessions, readSessionExcerpt } from './src/sessions.js'
import { createEvolverHandler, ENDPOINTS } from './src/remote.js'
import { SettingsStore } from './src/settings.js'
import { createTools } from './src/tools.js'
import { PROACTIVE_PROTOCOL } from './src/proactive.js'
import { createCardAgent } from './src/cards/agent.js'
import { buildCardGraph } from './src/cards/graph.js'
import { readCardIndex, refreshCardIndex } from './src/cards/injection-index.js'
import { seedStarterCards } from './src/cards/seed.js'
import { cardIndexText, cardPrompt, cardSection, DEFAULT_PROMPT_BUDGET } from './src/cards/prompt.js'
import { MAX_RESOURCE_BYTES } from './src/cards/resources.js'
import { assertRealDescription, CardStore, normalizeDescriptionMaxChars } from './src/cards/store.js'
import { isDirectory } from './src/workspace.js'
import { createWorkspaceJobs } from './src/workspace-jobs.js'

/** The plugin's row name. */
export const name = 'dsh-evolver'

/** The API prefix the browser calls. */
export const API_PREFIX = '/api/evolver'

/**
 * The largest request body the panel API goes on to parse.
 *
 * This is a *declared* limit, not a memory bound: the Host's API bridge reads
 * a `requestBody: 'buffered'` route into memory before this handler runs (its
 * own cap is 300 MB). 16 MB leaves room for a base64 attachment while keeping
 * the panel's JSON small; see `MAX_RESOURCE_BYTES` for the decoded limit.
 * It is checked against `content-length`, so a chunked body without that
 * header is not stopped here — the Host's buffer is the real bound.
 */
const MAX_REQUEST_BYTES = 16 * 1024 * 1024

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
 * The static half of the injection: the card discipline and the proactive
 * protocol, as one system-prompt section.
 *
 * Both halves are constants, so a second section would only add a block
 * boundary and an `order` slot without ever changing on its own. `"\n\n"` is
 * the separator the prompt assembler puts between sections, so the merged
 * text is byte-identical to what two sections produced.
 *
 * One cost: this section now owns order 900, where the proactive protocol
 * used to be at 920. A future section whose order falls between the two
 * would sort after the protocol instead of before it.
 *
 * @returns {string} One system-prompt section.
 */
function staticSection() {
	return `${cardSection()}\n\n${PROACTIVE_PROTOCOL}`
}

/**
 * Extensions that are documents first.
 *
 * Handing everything to the system opener turned one click into "execute the
 * attachment": on macOS `.command`/`.jar`, on Windows `.bat`/`.exe`. The
 * allowlist is what the panel can actually show and what a person expects to
 * open; anything else is revealed in the file manager instead, so the user
 * still finds it without this plugin launching it.
 */
const OPENABLE_EXTENSIONS = new Set([
	'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'pages', 'numbers', 'rtf',
	'txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'png', 'jpg', 'jpeg', 'gif',
	'webp', 'bmp', 'tif', 'tiff', 'svg',
])

/**
 * How one attachment may be opened: by its app, or by the file manager.
 *
 * @param {string} path - The validated absolute path.
 * @returns {'opened' | 'revealed'} The mode.
 */
/** @internal exported for tests */
export function openModeOf(path) {
	const extension = extname(path).slice(1).toLowerCase()
	return OPENABLE_EXTENSIONS.has(extension) ? 'opened' : 'revealed'
}

/**
 * Hand one file to the desktop.
 *
 * The panel can render text and images, but not a PDF viewer or Word: what it
 * can do is ask the system to open the file the way the user would from Finder.
 * Detached and unref'd, so a slow viewer never holds the plugin's event loop.
 *
 * @param {string} path - An absolute path already validated by the store.
 * @param {'opened' | 'revealed'} [mode] - Open the file or reveal it.
 * @returns {Promise<void>} Resolves once the opener was spawned.
 */
function openWithSystem(path, mode = 'opened') {
	const reveal = mode === 'revealed'
	let command
	let args
	if (process.platform === 'darwin') {
		command = 'open'
		args = reveal ? ['-R', path] : [path]
	} else if (process.platform === 'win32') {
		command = 'explorer'
		args = reveal ? [`/select,${path}`] : [path]
	} else {
		command = 'xdg-open'
		args = reveal ? [dirname(path)] : [path]
	}
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { detached: true, stdio: 'ignore' })
		child.once('error', reject)
		child.once('spawn', () => {
			child.unref()
			resolvePromise()
		})
	})
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
	// A settings file that could not be read also sends the data folder back
	// to the default; both reasons ride the one warning channel the panel shows.
	const startupWarning = resolved.warning !== '' ? resolved.warning : settings.warning
	if (startupWarning !== '') ctx.logger.warn(`dsh-evolver: ${startupWarning}`)

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

	/**
	 * The plugin's own log file.
	 *
	 * Registered before any job: the reason to keep a log at all is the run
	 * that failed while nobody was watching, and the host's stdout is gone on
	 * restart. The folder is read lazily because moving it replaces the store.
	 */
	const logs = createLogSink({
		dataDir: () => cardStoreRef.current?.dataDir ?? evolver.root,
		forward: ctx.logger,
	})

	/**
	 * Build (and initialise) the card store of one data folder.
	 *
	 * @param {string} root - The data folder.
	 * @returns {Promise<object>} The opened store.
	 */
	async function createCards(root) {
		const store = new CardStore({
			dataDir: root,
			logger: logs,
			cardMaxChars: settings.get().cardMaxChars,
			descriptionMaxChars: settings.get().cardDescriptionMaxChars,
		})
		await store.init()
		try {
			const seeded = await seedStarterCards(store)
			if (seeded > 0) ctx.logger.info(`dsh-evolver: seeded ${seeded} starter card(s)`)
		} catch (error) {
			ctx.logger.warn(`dsh-evolver: seeding cards failed: ${error instanceof Error ? error.message : String(error)}`)
		}
		// The injected card index reads a daily snapshot. A fresh install, a
		// moved data folder and an imported archive have none, and the fallback
		// ranks the whole library: doing that once here keeps it off the request
		// path until the daily run rewrites the snapshot.
		try {
			await refreshCardIndex(store)
		} catch (error) {
			ctx.logger.warn(`dsh-evolver: building the card index snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
		}
		return store
	}

	/**
	 * Make one card store the one the tools use.
	 *
	 * @param {object} store - The opened store.
	 * @returns {void}
	 */
	function useCards(store) {
		cardStoreRef.current = store
		cardAgentRef.current = createCardAgent(store)
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

	// Assigned further down; the workspace jobs only read it from `state()`.
	let backup
	const rootState = { source: resolved.source, warning: startupWarning }
	// Moving, exporting and importing all close and reopen the card store. The
	// gate lives in the jobs module so the timer jobs can ask the same question.
	const workspace = createWorkspaceJobs({
		evolver,
		settings,
		rootState,
		defaultRoot,
		logger: logs,
		currentStore: () => cardStoreRef.current,
		openCards,
		backupRunning: () => backup?.running === true,
	})

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
		const blocked = workspace.blockedMessage()
		if (blocked !== undefined) return Promise.reject(new Error(blocked))
		if (cardStoreRef.current?.closed === true) {
			return Promise.reject(new Error('数据目录操作正在进行，请稍后再试。'))
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
			// scan. One regex pass over the body (a per-character test was ~4x
			// the cost) and this is the most expensive part of the overview.
			const chars = [...String(card.body ?? '').replace(/\s/gu, '')].length
			const date = new Date(card.created)
			if (Number.isFinite(date.getTime())) {
				date.setHours(0, 0, 0, 0)
				if (date.getTime() < first) first = date.getTime()
				const key = dayKeyOf(date)
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
			const key = dayKeyOf(date)
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
			// Archived cards stay on the heatmap (they were written that day)
			// but are not part of the live library: the words and tag counts
			// already leave them out, so the total has to as well.
			cards: cards.length - archived,
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
		const blocked = workspace.blockedMessage()
		if (blocked !== undefined) throw new Error(blocked)
		// A close during a folder move leaves the ref on the old store: writing
		// through it would land in the folder being left behind.
		if (cardStoreRef.current?.closed === true) throw new Error('数据目录操作正在进行，请稍后再试。')
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
		setCardDescriptionMaxChars(value) {
			const store = cardStoreRef.current
			if (store !== undefined) store.descriptionMaxChars = normalizeDescriptionMaxChars(value)
		},
		async overview() {
			const store = cardStoreRef.current
			const base = await evolver.overview()
			const status = store.status()
			const all = store.all()
			const stats = overviewStats(all)
			// Rendered once for the injection preview below, so the same block is
			// not ranked twice per overview call.
			const index = cardIndexText(store, DEFAULT_PROMPT_BUDGET)
			return {
				...base,
				stats: {
					cards: stats.cards,
					tags: stats.tags,
					days: stats.days,
					words: stats.words,
				},
				year: stats.year,
				activity: stats.activity,
				tree: store.tagTree(),
				cards: {
					...status,
					total: status.cards,
					cardMaxChars: settings.get().cardMaxChars,
				},
				// What rides on every request, block by block: the panel's 信息
				// page shows exactly this so the injected text can be read
				// without opening a request.
				injection: {
					section: staticSection(),
					index,
					// What the index above actually is: today's snapshot, or the live
					// fallback when there is none. Without this the panel cannot tell
					// "stale on purpose" from "broken and never updating".
					snapshot: (() => {
						const fresh = readCardIndex(store)
						return fresh === null ? null : { at: fresh.at, day: fresh.day }
					})(),
				},
			}
		},
		async injection() {
			const store = cardStoreRef.current
			const base = await evolver.injectionPreview()
			const status = store.status()
			const text = cardPrompt(store, DEFAULT_PROMPT_BUDGET)
			return {
				...base,
				cards: {
					entries: status.cards,
					bytes: Buffer.byteLength(text, 'utf8'),
					budget: DEFAULT_PROMPT_BUDGET,
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
			const resourcePath = String(payload.resourcePath ?? '').trim()
			const page = query === ''
				? store.listPage({ tags, anyTags, limit, includeArchived, archivedOnly, resourcePath })
				: await store.queryPage({ text: query, tags, anyTags, limit, includeArchived, archivedOnly, resourcePath })
			return {
				cards: page.cards,
				// How many cards the filter matches in total: the panel gets a
				// page, and without this number a truncated list looks complete.
				total: page.total,
				tree: store.tagTree(),
				status: store.status(),
				cardMaxChars: settings.get().cardMaxChars,
			}
		},
		/**
		 * One attachment, prepared for the preview pane.
		 *
		 * @param {object} payload - `{id, name}`.
		 * @returns {Promise<object>} Kind, MIME and (for renderable kinds) content.
		 */
		async resourcePreview(payload = {}) {
			const store = cardStoreRef.current
			return store.resourcePreview(String(payload.id ?? ''), String(payload.name ?? ''))
		},
		/**
		 * Open one attachment with the system's own application.
		 *
		 * PDFs, Word files, spreadsheets and binaries have no useful in-panel
		 * renderer, and writing one would be a worse version of the program the
		 * user already has. The path is resolved here from the card id and file
		 * name — the client never sends a path.
		 *
		 * @param {object} payload - `{id, name}`.
		 * @returns {Promise<{path: string, mode: 'opened' | 'revealed'}>} The file that was opened.
		 */
		async resourceOpen(payload = {}) {
			const store = cardStoreRef.current
			const path = await store.resourcePath(String(payload.id ?? ''), String(payload.name ?? ''))
			const mode = openModeOf(path)
			await openWithSystem(path, mode)
			return { path, mode }
		},
		/**
		 * Every attachment in the library, with the card that carries it.
		 *
		 * Read-only: this is the view the panel needs to show what exists
		 * without opening eight cards one by one.
		 *
		 * @returns {Promise<object[]>} One row per file.
		 */
		async resources() {
			const store = cardStoreRef.current
			const index = await store.resourcesIndex()
			const backlinks = store.backlinks()
			// The page is called "资源", so the file is the row and the card is
			// its context: one card can carry several files and each gets its own
			// line, sorted by name.
			const files = []
			for (const entry of index) {
				const card = store.get(entry.id)
				const owner = {
					id: entry.id,
					description: card?.description ?? '',
					tags: card?.tags ?? [],
					links: (backlinks[entry.id] ?? []).length,
				}
				for (const file of entry.files) {
					files.push({
						name: file.name,
						bytes: file.bytes,
						executable: file.executable,
						path: file.path,
						// The cards whose body mentions this file — the owner always
						// is one of them, because the body has to reference it.
						referenced: file.referencing,
						card: owner,
					})
				}
			}
			files.sort((left, right) => left.name.localeCompare(right.name) || left.card.id.localeCompare(right.card.id))
			return files
		},
		async read(payload = {}) {
			const store = cardStoreRef.current
			// The panel shows attachment metadata only; the tool keeps the
			// contents. Without this flag a card with a large attachment sent
			// up to 256 KB of text over HTTP just to be dropped by the client.
			const card = await store.read(String(payload.id ?? ''), { text: payload.metadataOnly !== true })
			if (card === undefined) return { card: null, links: [], backlinks: [] }
			// A card has no title: what identifies it in the panel is its id and
			// its description, so that is what the link lists carry.
			const describe = (id) => {
				const found = store.get(id)
				return found === undefined
					? { id, description: '', tags: [] }
					: { id, description: found.description, tags: found.tags }
			}
			const incoming = store.backlinks()[card.id] ?? []
			return {
				card,
				links: (card.links ?? []).map(describe),
				backlinks: incoming.map(describe),
			}
		},
		/**
		 * The panel's card graph.
		 *
		 * @param {{limit?: number}} [payload] - How many nodes to keep.
		 * @returns {Promise<object>} Nodes, edges and totals.
		 */
		graph(payload = {}) {
			const store = cardStoreRef.current
			return buildCardGraph(store.all(), { limit: Number(payload?.limit) })
		},
		write(payload = {}) {
			// A card is an id plus a description: the panel writes through here
			// too, so the rule is enforced at the one entrance they share.
			return committed((store) => store.put({
				...(payload.card ?? {}),
				description: assertRealDescription(payload.card?.description, store.descriptionMaxChars),
			}))
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
		attach(payload = {}) {
			const id = String(payload.id ?? '')
			const name = String(payload.name ?? '')
			const encoded = String(payload.data ?? '')
			if (encoded === '') throw new Error('附件内容为空。')
			const data = Buffer.from(encoded, 'base64')
			if (data.length === 0) throw new Error('附件内容为空。')
			if (data.length > MAX_RESOURCE_BYTES) {
				throw new Error(`附件超过 ${MAX_RESOURCE_BYTES / 1024 / 1024} MB 上限。`)
			}
			// A panel edit pays one write: the card log must be on disk before
			// the panel is told "已保存", or a crash between the resource file
			// and the log leaves a card that cannot be edited again.
			return committed((store) => store.attach(id, name, data))
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
			const events = snapshot.events ?? []
			// The messages decide the numbers; the whole timeline decides why.
			return { session: String(id), ...summarizeUsage(assistantEvents(snapshot), events) }
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
		logger: logs,
		// A data-folder move closes the store; a job that writes during that
		// window lands in the folder being left behind.
		isBusy: () => workspace.busy(),
		// The extracted cards are debounced; the cursor must not move first.
		flush: () => cardStoreRef.current?.flush(),
	})

	const consolidate = createConsolidationController({
		settings,
		store: () => cardStoreRef.current,
		llm: ctx.get('llm'),
		modelSelection: ctx.get('agentDefaultModel'),
		logger: logs,
		// A card that carries its source session can be checked against the
		// words around the quote instead of being polished on trust.
		excerpt: (id, quote) => readSessionExcerpt({ query: ctx.get('sessionQuery'), id, quote }),
		isBusy: () => workspace.busy(),
	})

	const health = createHealthJob({
		store: () => cardStoreRef.current,
		logger: logs,
		// The daily row also records how the prompt cache behaved, which only
		// the session service can answer.
		cache: (day) => cacheForDay({ query: ctx.get('sessionQuery'), day, dayKeyOf }),
		isBusy: () => workspace.busy(),
		// Keep the injected snapshot on today's date even when the organiser
		// is switched off: otherwise the fallback re-ranks on every write.
		maintainIndex: async () => {
			const current = cardStoreRef.current
			if (current === undefined || current.closed === true) return
			if (readCardIndex(current) !== null) return
			await refreshCardIndex(current)
		},
	})

	backup = new BackupService({
		settings,
		root: () => evolver.root,
		logger: logs,
		flush: () => cardStoreRef.current?.flush(),
		// A data-folder operation owns the folder; a snapshot taken across it
		// would be neither the old library nor the new one.
		isBusy: () => workspace.busy(),
	})

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
		// Writing out the debounced saves is part of shutting down; so is the
		// access ledger, whose last few reads still live in memory.
		const flushAccess = cardAgentRef.current?.flushAccess?.() ?? Promise.resolve()
		return Promise.resolve(flushAccess)
			.catch(() => {})
			// The last lines of a log explain the shutdown that produced them.
			.then(() => logs.flush())
			.then(() => cardStoreRef.current?.close().catch(() => {}))
			.catch(() => {})
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

	for (const tool of createTools({ cards: cardAgent, sessions })) {
		disposers.push(ctx.tools.register(tool))
	}
	for (const tool of createHarnessTools({ resolveProject })) {
		disposers.push(ctx.tools.register(tool))
	}

	// The two injected blocks. Their text is served from a cache so the
	// assembled prompt stays byte-stable between changes.
	//
	// Only the half that cannot change goes into the system prompt. The tag
	// tree moves with the data, so it rides along as runtime context: a branch
	// appearing mid-session then appends a snapshot instead of rewriting the
	// system prompt, and the conversation prefix stays cached. The section
	// keeps the discipline, the pointer to the tree and the proactive protocol,
	// all of it static — one section, because two would only cost a boundary.
	disposers.push(ctx.systemPrompt.section({
		name: 'dsh-evolver:cards',
		order: 900,
		interpolate: false,
		text: () => staticSection(),
	}))
	disposers.push(ctx.systemPrompt.context({
		name: 'dsh-evolver:cards',
		order: 900,
		interpolate: false,
		text: () => (cardStoreRef.current === undefined ? '' : cardIndexText(cardStoreRef.current, DEFAULT_PROMPT_BUDGET)),
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

	const organize = createOrganizeSettings({
		settings,
		llm: ctx.get('llm'),
		modelSelection: ctx.get('agentDefaultModel'),
	})

	const organizeApi = {
		status: () => organize.status(),
		save: (patch) => organize.save(patch),
	}

	const logsApi = {
		/**
		 * The newest log entries plus the ring's shape.
		 *
		 * @param {object} payload - `limit`.
		 * @returns {Promise<object>} `{entries, status}`.
		 */
		async read(payload) {
			const entries = await logs.tail(payload?.limit)
			return { entries, status: await logs.status() }
		},
	}
	const healthApi = {
		status: () => health.status(),
		run: async () => {
			await health.runNow()
			return health.status()
		},
	}
	const handler = createEvolverHandler({ evolver, settings, backup, workspace, view, ingest: ingestApi, consolidate: consolidateApi, organize: organizeApi, logs: logsApi, health: healthApi, cards: cardsApi })
	for (const endpoint of ENDPOINTS) {
		disposers.push(connection.fetch.register({
			path: `${API_PREFIX}/${endpoint}`,
			methods: ['POST'],
			// Buffered on purpose: the panel sends small JSON. The Host's bridge
			// caps every buffered body at 300 MB *before* this handler runs, so
			// the check below is a declared API limit, not a memory bound — the
			// exact Fetch routes are owner-only (a browser session must have
			// authenticated first), so the amplified-memory case is self-inflicted.
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
