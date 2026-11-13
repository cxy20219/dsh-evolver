/**
 * The daily snapshot behind the injected card index.
 *
 * The index is an index, and an index has to be built somewhere. Doing that
 * inside the prompt would rank the whole library and write a file on the
 * request path — the text function is synchronous and runs before every
 * request, so it cannot rank, and a write there would be a side effect nobody
 * asked for. The snapshot is therefore built once a day by the organiser and
 * read back by the prompt.
 *
 * Its two products are the cards the model should start from (ranked by the
 * same undirected link degree the search walk uses) and one paragraph on the
 * library's shape. Both change when the library changes, which is exactly why
 * they live in the runtime context and not in the system section.
 *
 * Reading is synchronous on purpose: `prompt.js` renders the block from a
 * `text: () => ...` callback that cannot await, and the file is a few KB of
 * already-computed data. The alternative — an async reader plus a ref updated
 * out of band — would be a cache to keep coherent for no measurable gain.
 *
 * A missing, malformed, or yesterday's snapshot is not an error: the prompt
 * then falls back to a live ranking. The organiser failing once must never
 * break prompt assembly.
 */

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { accessStats } from './access.js'
import { buildGraph, degrees } from '../memory/graph.js'
import { shortIds } from './ids.js'
import { isArchived, rootOf, TOP_TAGS } from './tags.js'

/** The snapshot format. Bumped when the shape changes; unknown versions are ignored. */
/** @internal exported for tests */
export const INDEX_VERSION = 4


/** How many cards the injected index names. */
export const MAX_TOP_CARDS = 12

/**
 * How many of those slots go to the most recently written cards.
 *
 * An index made only of hubs answers "what is this library about" but never
 * "what am I working on now": a note written today has no links yet and stays
 * invisible until it collects some. Two slots keep the fresh end represented
 * without touching the part that points at the structure.
 */
export const RECENT_SLOTS = 2

/** The longest library summary paragraph. */
/** @internal exported for tests */
export const MAX_SUMMARY_CHARS = 320

/**
 * The longest description one injected card line carries.
 *
 * A card has no title. Its first line is prose, and cutting prose to stand in
 * for a title is how the index ended up with long lines that stopped mid-word.
 * What a card actually carries is its id and its description, and that is what
 * the line shows.
 */
const MAX_TOP_DESC_CHARS = 80

/**
 * The cap in use: the store's configured limit, or the default.
 *
 * The setting exists so the description budget is one number, not two: what the
 * store accepts and what the index renders must not drift apart.
 *
 * @param {object} [store] - The card store, or an options object carrying it.
 * @returns {number} The cap in characters.
 */
function descriptionCapOf(store) {
	const value = Number(store?.descriptionMaxChars)
	return Number.isFinite(value) && value > 0 ? value : MAX_TOP_DESC_CHARS
}

/** Where a clipped field is allowed to end: never mid-phrase. */
const FIELD_BREAK = /[，。；：、！？,;]/

/**
 * Clip one index field to its cap, ending on a boundary and saying so.
 *
 * The caps exist so one pathological card cannot make a line heavy — not to
 * save bytes, since the block sits at half its budget. A hard `slice` was the
 * worst of both worlds: it spent the bytes and conveyed nothing ("…；动插") and
 * the reader could not tell the text continued. This cuts at the last
 * punctuation inside the cap and marks the cut with an ellipsis; without a
 * punctuation to land on it still cuts hard, but still marks it.
 *
 * @param {unknown} text - The field.
 * @param {number} cap - The longest the field may be, ellipsis included.
 * @returns {string} The field, clipped and marked when it had to be.
 */
function clipField(text, cap) {
	const chars = [...String(text ?? '').replace(/\s+/g, ' ').trim()]
	if (chars.length <= cap) return chars.join('')
	const head = chars.slice(0, cap - 1)
	// Do not cut so early that only a stub survives.
	for (let index = head.length - 1; index >= Math.floor(cap * 0.4); index -= 1) {
		if (FIELD_BREAK.test(head[index])) return head.slice(0, index + 1).join('') + '…'
	}
	return head.join('') + '…'
}

/** The file name inside `<dataDir>/knowledge/`. */
/** @internal exported for tests */
export const INDEX_FILE = 'index.json'

/**
 * The local day key, used to tell a fresh snapshot from yesterday's.
 *
 * Local, not UTC: "today" is the day the user is living in, and the daily run
 * uses the same convention for its own once-a-day check.
 *
 * @param {number} stamp - Milliseconds.
 * @returns {string} `YYYY-MM-DD` in local time.
 */
function dayKeyOf(stamp) {
	const date = new Date(stamp)
	const pad = (value) => String(value).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Read a clock or timestamp as milliseconds.
 *
 * @param {Date | number | string | undefined} value - The clock.
 * @returns {number} Milliseconds since the epoch; now when unusable.
 */
function stampOf(value) {
	if (value instanceof Date) {
		const time = value.getTime()
		return Number.isFinite(time) ? time : Date.now()
	}
	if (typeof value === 'number' && Number.isFinite(value)) return value
	const parsed = Date.parse(String(value ?? ''))
	return Number.isFinite(parsed) ? parsed : Date.now()
}

/**
 * Where the snapshot lives for one store.
 *
 * @param {object} store - The card store.
 * @returns {string | null} The absolute path, or null for a store without a data folder.
 */
/** @internal exported for tests */
export function cardIndexPath(store) {
	const dataDir = typeof store?.dataDir === 'string' ? store.dataDir : ''
	return dataDir === '' ? null : join(dataDir, 'knowledge', INDEX_FILE)
}

/**
 * Write one JSON document without ever leaving a half-written file.
 *
 * The same contract as the store's own atomic writes: the reader must see the
 * old snapshot or the new one, never a truncated file. A truncated read is
 * caught and treated as "no snapshot", so a crash here would silently drop the
 * index until the next day — the one failure this ordering prevents.
 *
 * @param {string} path - Destination.
 * @param {object} value - The value to serialise.
 * @returns {Promise<void>} Resolves once the file is in place.
 */
async function writeIndexAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	const temp = `${path}.${process.pid}.tmp`
	await writeFile(temp, `${JSON.stringify(value, null, '\t')}\n`, { mode: 0o600 })
	await rename(temp, path)
}

/**
 * Read the snapshot file as-is, without the freshness rules.
 *
 * @param {string} path - The snapshot path.
 * @returns {Promise<object | null>} The parsed document, or null.
 */
async function readRawIndex(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'))
		return parsed !== null && typeof parsed === 'object' ? parsed : null
	} catch {
		return null
	}
}

/**
 * Whether two snapshots describe the same library state.
 *
 * @param {object} left - The stored snapshot.
 * @param {object} right - The freshly computed one.
 * @returns {boolean} True when only the timestamp could differ.
 */
function sameIndexBody(left, right) {
	const strip = (value) => ({ ...value, at: '' })
	return JSON.stringify(strip(left)) === JSON.stringify(strip(right))
}

/**
 * Pick which cards one index block names.
 *
 * Two kinds of slot, because the index answers two questions. Most point at
 * the hubs — the cards a search would also reach. The last two go to the most
 * recently written cards, so a fresh note is visible before it has collected
 * any links: an index made only of old hubs stops pointing at what is actually
 * being worked on.
 *
 * Degree is the primary order because it is the structure. Read count breaks
 * ties: a hub nobody opens is still a hub, but between two equals the one that
 * is actually consulted wins. `updated` and then the id finish the order, so
 * two runs on the same library always produce the same list.
 *
 * @param {Array<{id: string, updated: string, degree: number}>} cards - The candidates.
 * @param {{limit?: number, access?: Record<string, {count: number}>}} [options] - Knobs.
 * @returns {string[]} The chosen ids, hubs first, then the fresh ones.
 */
/** @internal exported for tests */
export function pickIndexCards(cards, options = {}) {
	const size = Math.max(1, Math.min(MAX_TOP_CARDS, Math.round(Number(options.limit) || MAX_TOP_CARDS)))
	const access = options.access ?? {}
	const readCount = (id) => {
		const entry = access[id]
		return typeof entry?.count === 'number' && Number.isFinite(entry.count) ? entry.count : 0
	}
	const compareText = (left, right) => (left === right ? 0 : (left < right ? -1 : 1))
	const ranked = [...(cards ?? [])].sort((left, right) => {
		const byDegree = right.degree - left.degree
		if (byDegree !== 0) return byDegree
		const byReads = readCount(right.id) - readCount(left.id)
		if (byReads !== 0) return byReads
		const byUpdated = compareText(String(right.updated ?? ''), String(left.updated ?? ''))
		if (byUpdated !== 0) return byUpdated
		return compareText(left.id, right.id)
	})
	// Never spend every slot on freshness: one hub is the floor.
	const recentSlots = size <= 1 ? 0 : Math.min(RECENT_SLOTS, size - 1)
	const hubs = ranked.slice(0, size - recentSlots)
	const chosen = new Set(hubs.map((card) => card.id))
	const fresh = ranked
		.filter((card) => !chosen.has(card.id))
		.sort((left, right) => compareText(String(right.updated ?? ''), String(left.updated ?? ''))
			|| compareText(left.id, right.id))
		.slice(0, recentSlots)
	return hubs.concat(fresh).map((card) => card.id)
}

/**
 * The cards the injected index names.
 *
 * "Most connected" is measured on the same undirected link graph the search
 * walk uses, so the index points at the cards a search would also reach. Ties
 * go to the more recently updated card: an old hub is still a hub, but a fresh
 * one is more likely to be what the person is thinking about.
 *
 * @param {object[]} cards - The card views.
 * @param {{limit?: number, access?: Record<string, {count: number}>}} [options] - Slots and read counts.
 * @returns {Array<{id: string, short: string, description: string}>} The cards.
 */
export function topCardsOf(cards, options = {}) {
	const active = (cards ?? []).filter((card) => card !== null && typeof card === 'object' && !isArchived(card.tags ?? []))
	// Short ids are computed over the whole library, archived cards included:
	// an abbreviation has to be unambiguous for every card a lookup may hit.
	const short = shortIds((cards ?? []).filter((card) => card !== null && typeof card === 'object').map((card) => card.id))
	const graph = buildGraph(active)
	const degree = degrees(graph)
	const entries = [...graph.nodes.values()].map((card) => ({
		id: card.id,
		updated: String(card.updated ?? ''),
		degree: degree.get(card.id) ?? 0,
	}))
	return pickIndexCards(entries, options).map((id) => {
		const card = graph.nodes.get(id) ?? {}
		return {
			id,
			short: short.get(id) ?? id,
			description: clipField(card.description, descriptionCapOf(options)),
		}
	})
}

/**
 * The injected-card ranking computed from raw log records.
 *
 * Same output as `topCardsOf`, but without mapping every record to a card
 * view first: on a 2000-card library that mapping was the bulk of the
 * snapshot-less prompt fallback. Used by `prompt.js`; `topCardsOf` stays the
 * readable version for the daily snapshot writer.
 *
 * @param {object[]} records - The raw card records.
 * @param {{limit?: number, access?: Record<string, {count: number}>}} [options] - Slots and read counts.
 * @returns {Array<{id: string, short: string, description: string}>} The cards.
 */
export function topCardsOfRecords(records, options = {}) {
	const byId = new Map()
	for (const record of records ?? []) {
		if (record !== null && typeof record === 'object' && typeof record.id === 'string') byId.set(record.id, record)
	}
	const tagsOfRecord = (record) => (Array.isArray(record.tags) ? record.tags : [])
	const active = [...byId.values()].filter((record) => !isArchived(tagsOfRecord(record)))
	const short = shortIds([...byId.keys()])
	// Undirected degree: out-links plus the back-links not already counted.
	const out = new Map()
	for (const record of active) {
		const links = new Set()
		for (const link of Array.isArray(record.links) ? record.links : []) {
			if (link !== record.id && byId.has(link)) links.add(link)
		}
		out.set(record.id, links)
	}
	const degree = new Map(active.map((record) => [record.id, out.get(record.id).size]))
	for (const record of active) {
		for (const link of out.get(record.id)) {
			if (out.has(link) && !out.get(link).has(record.id)) degree.set(link, (degree.get(link) ?? 0) + 1)
		}
	}
	const entries = active.map((record) => ({
		id: record.id,
		updated: String(record.updated ?? ''),
		degree: degree.get(record.id) ?? 0,
	}))
	return pickIndexCards(entries, options).map((id) => {
		const record = byId.get(id) ?? {}
		return {
			id,
			short: short.get(id) ?? id,
			description: clipField(record.description, descriptionCapOf(options)),
		}
	})
}

/**
 * One paragraph describing how the library is organised.
 *
 * This is the part of the injection that replaces the tag tree: the model does
 * not need every path, it needs to know what the branches are about and which
 * are growing. The model may overwrite it once a day with a better summary;
 * this is the deterministic floor.
 *
 * @param {object[]} cards - The card views.
 * @returns {string} The paragraph.
 */
export function librarySummary(cards) {
	const active = (cards ?? []).filter((card) => card !== null && typeof card === 'object' && !isArchived(card.tags ?? []))
	const counts = new Map()
	for (const card of active) {
		// One card may carry several tags under the same root; it is still one
		// card, and counting each tag would inflate the summary.
		const roots = new Set((card.tags ?? []).map((tag) => rootOf(tag)))
		for (const root of roots) counts.set(root, (counts.get(root) ?? 0) + 1)
	}
	const parts = []
	for (const root of TOP_TAGS) {
		const count = counts.get(root) ?? 0
		if (count === 0) continue
		// No branch descriptions here: the six roots are plain Chinese words the
		// model already understands, and `card_index` carries each branch's own
		// description for the one call that needs it. Six parentheticals cost
		// about 70 characters on every request for nothing.
		parts.push(`${root} ${count}`)
	}
	const total = active.length
	if (parts.length === 0) return `库里还没有卡片。`
	const paragraph = `共 ${total} 张卡，按枝干：${parts.join(' · ')}。`
	return [...paragraph].slice(0, MAX_SUMMARY_CHARS).join('')
}

export async function refreshCardIndex(store, now = Date.now(), { summary } = {}) {
	const path = cardIndexPath(store)
	if (path === null) throw new Error('卡片库还没有数据目录，无法刷新重要度索引。')
	if (typeof store?.all !== 'function') throw new Error('卡片库不可读，无法刷新重要度索引。')
	const stamp = stampOf(now)
	const cards = store.all()
	// Read counts break degree ties: a hub nobody opens is still a hub, but
	// between two equal ones the card that is actually consulted wins. The
	// ledger is a derived cache — a missing file simply means "no reads yet".
	const access = await accessStats(store.dataDir).catch(() => ({ ids: {} }))
	// The organiser may have written a better one-paragraph summary than the
	// deterministic one; fall back to the floor whenever it did not.
	const proposed = typeof summary === 'string' ? summary.replace(/\s+/g, ' ').trim() : ''
	const cleanSummary = [...proposed].slice(0, MAX_SUMMARY_CHARS).join('')
	const index = {
		version: INDEX_VERSION,
		day: dayKeyOf(stamp),
		at: new Date(stamp).toISOString(),
		topCards: topCardsOf(cards, { access: access.ids ?? {}, descriptionMaxChars: descriptionCapOf(store) }),
		summary: cleanSummary === '' ? librarySummary(cards) : cleanSummary,
	}
	// The empty-batch tick runs every few minutes and the ranking rarely moves;
	// rewriting byte-identical content would churn the file for nothing. The
	// timestamp is the only field that always differs, so compare without it.
	const previous = await readRawIndex(path)
	if (previous !== null && sameIndexBody(previous, index)) return previous
	await writeIndexAtomic(path, index)
	return index
}

/**
 * Validate and normalise one parsed snapshot.
 *
 * A bad entry is dropped, a bad document is rejected whole: a snapshot that
 * names yesterday or carries another version is not partially trustworthy.
 *
 * @param {unknown} value - The parsed JSON.
 * @param {number} stamp - The clock in milliseconds.
 * @returns {object | null} The snapshot, or null when unusable.
 */
function normalizeIndex(value, stamp) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
	if (value.version !== INDEX_VERSION) return null
	if (typeof value.day !== 'string' || value.day !== dayKeyOf(stamp)) return null
	if (!Array.isArray(value.topCards)) return null
	const topCards = []
	const seenCards = new Set()
	for (const entry of value.topCards) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
		const id = String(entry.id ?? '')
		if (id === '' || seenCards.has(id)) continue
		seenCards.add(id)
		const short = String(entry.short ?? '').trim()
		topCards.push({
			id,
			short: /^[0-9A-Za-z-]{3,40}$/.test(short) ? short : '',
			description: String(entry.description ?? ''),
		})
	}
	return {
		version: INDEX_VERSION,
		day: value.day,
		at: typeof value.at === 'string' ? value.at : '',
		topCards: topCards.slice(0, MAX_TOP_CARDS),
		summary: String(value.summary ?? '').slice(0, MAX_SUMMARY_CHARS),
	}
}

/**
 * Read today's snapshot, if there is a usable one.
 *
 * Fault tolerant by contract: a missing file, invalid JSON, a foreign shape,
 * or a snapshot from another day all return null, which tells the prompt to
 * use its plain ladder. Nothing here throws, because this runs during prompt
 * assembly.
 *
 * @param {object} store - The card store (or any object with `dataDir`).
 * @param {Date | number | string} [now] - Clock; defaults to now.
 * @returns {object | null} The snapshot, or null when there is no fresh one.
 */
export function readCardIndex(store, now = new Date()) {
	const path = cardIndexPath(store)
	if (path === null) return null
	let parsed
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'))
	} catch {
		return null
	}
	return normalizeIndex(parsed, stampOf(now))
}

