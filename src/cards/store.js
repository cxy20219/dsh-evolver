/**
 * The unified card store.
 *
 * A card is one append-only log record plus optional resource files. Its
 * classification lives entirely in hierarchical tags:
 *
 *   #践行 / #见闻 / #即兴 / #复盘 / #觉察 / #试错
 *
 * There is no separate type/shape/status/category field. The search engine
 * (BM25) and the tag tree are the retrieval surface; the prompt injects the
 * card index and a one-paragraph structure summary, never card bodies.
 */

import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { writeJsonAtomic } from '../atomic.js'
import { MemoryStore } from '../memory/store.js'
import { buildGraph, combine, degrees, spread, subgraph } from '../memory/graph.js'
import { hybridRetrieve } from '../memory/hybrid.js'
import { cardCreatedAt, cardId, isCardId } from './ids.js'
import { ResourceStore, resourceRelativePath, safeResourceName } from './resources.js'
import { findSecret } from '../secrets.js'
import {
	archiveTags,
	buildTagTree,
	coerceCardTags,
	isArchived,
	isUnder,
	normalizeCardTags,
	normalizeTags,
	rootOf,
	MAX_TAG_DESCRIPTION_CHARS,
	MAX_TAGS,
	sanitizeTagDescription,
	settleTags,
	TAG_DESCRIPTIONS,
	TOP_TAGS,
} from './tags.js'

/** The default body budget, in Unicode code points. */
const DEFAULT_CARD_MAX_CHARS = 1000

/** The longest a card description may be. */
const MAX_DESCRIPTION_CHARS = 200

/**
 * The default cap on a card description.
 *
 * A description is a one-sentence index of the card, and it is the only thing
 * the injected index shows next to an id — so it is short by definition. 80 is
 * what the index renders; the store refuses anything longer instead of
 * silently trimming it, because a trimmed sentence is what made the old index
 * unreadable.
 */
const DEFAULT_DESCRIPTION_MAX_CHARS = 80

/** A description shorter than this says nothing. */
const MIN_DESCRIPTION_CHARS = 4

/**
 * Values that look like a description but are not one.
 *
 * The rule is "a card carries a real description"; a field filled with 暂无 or
 * TODO satisfies the schema and leaves the index blank, which is exactly the
 * state this is meant to prevent.
 */
const PLACEHOLDER_DESCRIPTION = /^(描述|说明|摘要|简述|简介|占位|占位符|待补|待定|待写|补充|暂无|没有|无|略|同上|待|todo|tbd|n\/a|na|none|null|undefined|na\.|示例|样例|测试|test)[\s。.!?，,、~～-]*$/i

/** How many neighbours a graph search lists beyond the cards it returns. */
const MAX_RELATED = 8

/** How much resource text one card read may return before it degrades to metadata. */
const MAX_TOTAL_TEXT_BYTES = 256 * 1024


/** File extension to MIME type: the panel needs it to pick a renderer. */
const MIME_BY_EXTENSION = {
	md: 'text/markdown',
	markdown: 'text/markdown',
	txt: 'text/plain',
	log: 'text/plain',
	json: 'application/json',
	yaml: 'text/yaml',
	yml: 'text/yaml',
	toml: 'text/plain',
	csv: 'text/csv',
	tsv: 'text/csv',
	html: 'text/html',
	css: 'text/css',
	js: 'text/javascript',
	mjs: 'text/javascript',
	cjs: 'text/javascript',
	ts: 'text/typescript',
	py: 'text/x-python',
	sh: 'text/x-shellscript',
	bash: 'text/x-shellscript',
	zsh: 'text/x-shellscript',
	rb: 'text/x-ruby',
	go: 'text/x-go',
	rs: 'text/x-rust',
	java: 'text/x-java',
	c: 'text/x-c',
	h: 'text/x-c',
	cpp: 'text/x-c',
	sql: 'text/plain',
	xml: 'text/xml',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	bmp: 'image/bmp',
	pdf: 'application/pdf',
}

/**
 * The MIME type of one attachment, by extension.
 *
 * @param {string} name - The file name.
 * @returns {string} A MIME type, or `application/octet-stream` when unknown.
 */
function mimeOf(name) {
	const match = /\.([0-9a-z]+)$/i.exec(name)
	const ext = match === null ? '' : match[1].toLowerCase()
	return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
}

/**
 * Count the visible characters of a string.
 *
 * @param {unknown} value - The value.
 * @returns {number} The code point count.
 */
function charCount(value) {
	return [...String(value ?? '')].length
}

/**
 * Whether two tag lists are the same, in order.
 *
 * @param {unknown[]} left - One list.
 * @param {unknown[]} right - The other.
 * @returns {boolean} True when every entry matches positionally.
 */
function sameTagList(left, right) {
	return Array.isArray(left)
		&& Array.isArray(right)
		&& left.length === right.length
		&& left.every((tag, index) => String(tag) === String(right[index]))
}


/** The longest verbatim quote a card may carry. */
const MAX_SOURCE_QUOTE_CHARS = 160

/**
 * Normalise a one-line card description.
 *
 * The description is the card's identity: search results and the injected
 * index show it next to the id, so it must stay on one line — a newline would
 * break the rendered list and let a paragraph sneak into the prompt.
 *
 * @param {unknown} value - The proposed description.
 * @returns {string} The clean description, `''` when unusable.
 */
function normalizeDescription(value) {
	const clean = String(value ?? '')
		.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	if (clean === '') return ''
	return [...clean].slice(0, MAX_DESCRIPTION_CHARS).join('')
}

/**
 * Clamp a description budget.
 *
 * @param {unknown} value - The configured cap.
 * @returns {number} The cap, inside 20–200.
 */
export function normalizeDescriptionMaxChars(value) {
	const size = Math.round(Number(value))
	if (!Number.isFinite(size)) return DEFAULT_DESCRIPTION_MAX_CHARS
	return Math.min(MAX_DESCRIPTION_CHARS, Math.max(20, size))
}

/**
 * Cut a sentence down to a description, on a boundary and with an ellipsis.
 *
 * Used where the text already exists and a description has to be derived from
 * it (an ingested memory is one sentence; that sentence is also the index
 * entry for the card). Cutting mid-phrase is what made the old index read as
 * broken text.
 *
 * @param {unknown} value - The text.
 * @param {number} [maxChars] - The configured cap.
 * @returns {string} A description no longer than the cap.
 */
export function clipDescription(value, maxChars = DEFAULT_DESCRIPTION_MAX_CHARS) {
	const clean = normalizeDescription(value)
	const limit = normalizeDescriptionMaxChars(maxChars)
	const chars = [...clean]
	if (chars.length <= limit) return clean
	const head = chars.slice(0, limit - 1)
	const breakAt = /[，。；：、！？,;]/
	for (let index = head.length - 1; index >= Math.floor(limit * 0.4); index -= 1) {
		if (breakAt.test(head[index])) return head.slice(0, index + 1).join('') + '…'
	}
	return head.join('') + '…'
}

/**
 * Validate the description a caller is writing.
 *
 * A card is an id plus a description — the injected index shows nothing else
 * per card — so an empty or placeholder description turns the index back into
 * a list of opaque ids. The check lives here so the tool, the panel and the
 * HTTP path all get the same rule and the same message.
 *
 * @param {unknown} value - The raw description.
 * @param {number} [maxChars] - The configured cap.
 * @returns {string} The normalised description.
 */
export function assertRealDescription(value, maxChars = DEFAULT_DESCRIPTION_MAX_CHARS) {
	const clean = normalizeDescription(value)
	if (clean === '') {
		throw new Error('卡片必须写 description：一句话说清这张卡回答什么问题，索引里只放它。')
	}
	// Placeholder first: "暂无" is short too, and "that is a placeholder" is the
	// useful thing to say about it.
	if (PLACEHOLDER_DESCRIPTION.test(clean)) {
		throw new Error('描述不能是占位词（「暂无」「TODO」之类）：索引里显示的就是这段文本。')
	}
	if ([...clean].length < MIN_DESCRIPTION_CHARS) {
		throw new Error(`描述至少 ${MIN_DESCRIPTION_CHARS} 字：一句话说清这张卡回答什么问题。`)
	}
	const limit = normalizeDescriptionMaxChars(maxChars)
	if ([...clean].length > limit) {
		throw new Error(`描述最多 ${limit} 字：它是一句话索引，不是摘要。`)
	}
	return clean
}

/**
 * Normalise a card's provenance.
 *
 * Only the verbatim quote is kept: it is the part the review can check the note
 * against, and it is bounded so one card cannot smuggle a transcript into the
 * prompt.
 *
 * @param {unknown} value - The proposed source.
 * @returns {{quote: string} | undefined} The stored source, when valid.
 */
function normalizeSource(value) {
	if (value === null || typeof value !== 'object') return undefined
	const quote = String(value.quote ?? '').replace(/\s+/g, ' ').trim()
	if (quote === '' || charCount(quote) > MAX_SOURCE_QUOTE_CHARS) return undefined
	if (findSecret(quote) !== undefined) return undefined
	// The session id is what lets the reviewer pull the surrounding words out
	// of the transcript instead of trusting the card's own summary of events.
	const session = String(value.session ?? '').trim()
	const cleanSession = /^[A-Za-z0-9_-]{4,120}$/.test(session) ? session : ''
	return cleanSession === '' ? { quote } : { quote, session: cleanSession }
}

/**
 * Build the tag and archive predicate shared by flat and graph search.
 *
 * The flat search needs it to keep a lexical hit, the graph search needs the
 * very same filter to define the candidate library the walk may traverse.
 * Sharing one predicate is what stops the two modes from disagreeing about
 * which cards exist: a card the flat search hides must not arrive through a
 * backlink.
 *
 * @param {{tags?: string[], anyTags?: string[], includeArchived?: boolean, archivedOnly?: boolean}} [filters] - The tag filters.
 * @returns {(card: object) => boolean} Whether a card passes.
 */
function cardFilter({ tags = [], anyTags = [], includeArchived = false, archivedOnly = false } = {}) {
	const filters = normalizeTags(tags)
	const any = normalizeTags(anyTags)
	const archivedFilter = filters.some((tag) => tag.split('/').pop() === '归档')
	return (card) => {
		if (archivedOnly && !isArchived(card.tags)) return false
		if (!includeArchived && !archivedFilter && !archivedOnly && isArchived(card.tags)) return false
		if (filters.length > 0 && !filters.every((filter) => (card.tags ?? []).some((tag) => isUnder(tag, filter)))) return false
		if (any.length > 0 && !any.some((filter) => (card.tags ?? []).some((tag) => isUnder(tag, filter)))) return false
		return true
	}
}

/**
 * Normalise the ids of a secondary-search scope.
 *
 * An empty set means "the whole candidate library": an empty `within` is a
 * request to search without a scope, not a scope that contains nothing.
 *
 * @param {unknown} value - The proposed card ids.
 * @returns {Set<string>} The non-empty ids.
 */
function scopedIds(value) {
	const ids = new Set()
	if (!Array.isArray(value)) return ids
	for (const raw of value) {
		const id = String(raw ?? '').trim()
		if (id !== '') ids.add(id)
	}
	return ids
}

/**
 * Render the subgraph around a ranked id list.
 *
 * Node degree is the number of neighbours inside the candidate library, not
 * the in/out count a card view carries: this is the number a layout needs and
 * the answer to "what is one hop from here". `subgraph` already drops edges
 * with only one end kept, so the payload never implies a node it does not
 * include.
 *
 * @param {{nodes: Map<string, object>, adjacency: Map<string, Set<string>>}} graph - The candidate graph.
 * @param {Map<string, number>} degree - Neighbour count per node.
 * @param {string[]} ids - Preferred node ids, in rank order.
 * @returns {{nodes: object[], edges: Array<{from: string, to: string}>}} The subgraph view.
 */
function subgraphView(graph, degree, ids) {
	const slice = subgraph({ graph, ids })
	return {
		nodes: slice.nodes.map((id) => {
			const card = graph.nodes.get(id)
			return {
				id,
				description: card.description ?? '',
				degree: degree.get(id) ?? 0,
			}
		}),
		edges: slice.edges,
	}
}

/**
 * Escape a string for a regular expression.
 *
 * @param {string} value - The literal.
 * @returns {string} The escaped literal.
 */
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether a body already references one resource in the required form.
 *
 * @param {string} body - The card body.
 * @param {string} relativePath - Data-dir-relative resource path.
 * @returns {boolean} True when the reference is present with a description.
 */
/** @internal exported for tests */
export function hasResourceReference(body, relativePath) {
	const pattern = new RegExp(`\\[[^\\]]+\\]\\(\\s*${escapeRegExp(relativePath)}\\s*\\)\\s*[：:]\\s*\\S`)
	return pattern.test(String(body ?? ''))
}

/**
 * Require one body reference per attachment.
 *
 * @param {string} body - The card body.
 * @param {string} cardId - The card id.
 * @param {string[]} names - The resource names.
 * @returns {void}
 */
function assertResourceReferences(body, cardId, names) {
	for (const name of names) {
		const relativePath = resourceRelativePath(cardId, name)
		if (!hasResourceReference(body, relativePath)) {
			throw new Error(
				`正文必须引用附件 ${name}，格式：\`[标题](${relativePath})：用途、入口命令、输入输出、关联流程\``,
			)
		}
	}
}

/**
 * The unified card store.
 */
export class CardStore {
	/**
	 * @param {{dataDir: string, logger?: object, cardMaxChars?: number}} deps - Dependencies.
	 */
	constructor({ dataDir, logger, cardMaxChars = DEFAULT_CARD_MAX_CHARS, descriptionMaxChars = DEFAULT_DESCRIPTION_MAX_CHARS }) {
		this.descriptionMaxChars = normalizeDescriptionMaxChars(descriptionMaxChars)
		this.dataDir = dataDir
		this.logger = logger
		this.cardMaxChars = Math.max(1, Math.min(4000, Math.round(Number(cardMaxChars) || DEFAULT_CARD_MAX_CHARS)))
		this.cards = new MemoryStore({
			dataDir,
			folder: 'knowledge/cards',
			logName: 'cards.jsonl',
			logger,
		})
		/** The card views of the current store version, rebuilt on change. */
		this.allCache = null
		this.allVersion = -1
		/** Derived views that are cheap to keep until the store changes. */
		this.backlinksCache = null
		this.backlinksVersion = -1
		this.idCache = null
		this.idVersion = -1
		this.resources = new ResourceStore({ root: dataDir })
		// Attachment metadata per card, filled on demand and dropped when a card
		// is rewritten: list and query paths ask for it repeatedly.
		this.attachmentCache = new Map()
		// The resource page asks the same question on every refresh; the answer
		// only changes when the library does.
		this.resourcesIndexCache = null
		// A closed store still answers from memory, but it must not take writes:
		// its log file belongs to the folder a migration/import is replacing.
		this.closed = false
	}

	/**
	 * Open the store and prepare the resource folder.
	 *
	 * @returns {Promise<void>} Resolves when records are loaded.
	 */
	async init() {
		await mkdir(join(this.dataDir, 'knowledge', 'resources'), { recursive: true, mode: 0o700 })
		await this.cards.init()
		this.closed = false
	}

	/**
	 * Close the store.
	 *
	 * @returns {Promise<void>} Resolves when flushed.
	 */
	async close() {
		await this.cards.close()
		this.closed = true
	}

	/**
	 * Flush the debounced log.
	 *
	 * @returns {Promise<void>} Resolves when flushed.
	 */
	async flush() {
		await this.cards.flush()
	}

	/**
	 * The path of the tag description file.
	 *
	 * The descriptions are data, not code: a branch created today can be
	 * documented without touching the source or redeploying.
	 *
	 * @returns {string} The absolute file path.
	 */
	tagDescriptionsPath() {
		return join(this.dataDir, 'knowledge', 'tags.json')
	}

	/**
	 * The effective description of every documented branch.
	 *
	 * The file wins over the built-in defaults; without a file the built-in
	 * defaults are used.
	 *
	 * @returns {Promise<Record<string, string>>} The description map.
	 */
	async tagDescriptions() {
		try {
			const raw = await readFile(this.tagDescriptionsPath(), 'utf8')
			const parsed = JSON.parse(raw)
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return { ...TAG_DESCRIPTIONS }
			}
			const map = {}
			for (const [tag, description] of Object.entries(parsed)) {
				if (typeof description !== 'string') continue
				const clean = sanitizeTagDescription(description)
				if (clean !== '') map[tag] = clean
			}
			return map
		} catch {
			return { ...TAG_DESCRIPTIONS }
		}
	}

	/**
	 * Write the tag descriptions.
	 *
	 * @param {Record<string, string>} descriptions - The description map.
	 * @returns {Promise<Record<string, string>>} The saved map.
	 */
	async saveTagDescriptions(descriptions) {
		if (descriptions === null || typeof descriptions !== 'object' || Array.isArray(descriptions)) {
			throw new Error('标签描述必须是一个对象。')
		}
		const map = {}
		for (const [tag, description] of Object.entries(descriptions)) {
			if (typeof description !== 'string') throw new Error(`标签 ${tag} 的说明必须是文字。`)
			const clean = description.trim()
			if (clean === '') continue
			// The description is appended to a line of the injected tag map, so
			// a newline in it would add a line of its own to the system prompt.
			if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(clean)) {
				throw new Error(`标签 ${tag} 的说明只能是单行。`)
			}
			if (clean.length > MAX_TAG_DESCRIPTION_CHARS) {
				throw new Error(`标签 ${tag} 的说明超过 ${MAX_TAG_DESCRIPTION_CHARS} 字。`)
			}
			const segments = tag.split('/')
			if (!TOP_TAGS.includes(segments[0])) {
				throw new Error(`标签 ${tag} 不在六大枝干里。`)
			}
			if (segments.some((segment) => segment === '')) throw new Error(`标签 ${tag} 路径不合法。`)
			map[tag] = clean
		}
		await writeJsonAtomic(this.tagDescriptionsPath(), map)
		return map
	}

	/**
	 * The tail of the consolidation audit log.
	 *
	 * The ledger says when the job ran; this file says what it did. It is the
	 * only way to answer "did the tag rules actually change anything?", so
	 * both the panel and `evolve_review` read it back through here.
	 *
	 * @param {number} [limit] - How many entries to keep, newest last.
	 * @returns {Promise<object[]>} The audit entries, best effort.
	 */
	async consolidationAudit(limit = 100) {
		const path = join(this.dataDir, 'knowledge', 'consolidation.jsonl')
		try {
			const raw = await readFile(path, 'utf8')
			const lines = raw.trim().split('\n').filter(Boolean).slice(-limit)
			return lines.map((line) => {
				try {
					return JSON.parse(line)
				} catch {
					return null
				}
			}).filter((entry) => entry !== null)
		} catch {
			return []
		}
	}

	/**
	 * Where the card review ledger lives.
	 *
	 * @returns {string} Absolute path.
	 */
	consolidationPath() {
		return join(this.dataDir, 'knowledge', 'consolidation.json')
	}

	/**
	 * Read the review ledger: when each card was last looked at.
	 *
	 * This is the only place freshness is tracked. A card with no entry has
	 * never been reviewed, so there is no per-card date to keep up to date by
	 * hand and no way for the two to disagree.
	 *
	 * @returns {Promise<{lastRunAt: string, dayKey: string, cards: Record<string, string>, attempts: {day: string, count: number}, progress: {day: string, reviewed: number, batches: number}}>} The ledger.
	 */
	async consolidationLedger() {
		const empty = {
			lastRunAt: '',
			dayKey: '',
			cards: {},
			attempts: { day: '', count: 0 },
			progress: { day: '', reviewed: 0, batches: 0 },
		}
		let raw
		try {
			raw = await readFile(this.consolidationPath(), 'utf8')
		} catch {
			return empty
		}
		let parsed
		try {
			parsed = JSON.parse(raw)
		} catch {
			return empty
		}
		if (parsed === null || typeof parsed !== 'object') return empty
		const cards = parsed.cards !== null && typeof parsed.cards === 'object' && !Array.isArray(parsed.cards) ? parsed.cards : {}
		const attempts = parsed.attempts !== null && typeof parsed.attempts === 'object'
			? { day: String(parsed.attempts.day ?? ''), count: Number(parsed.attempts.count) || 0 }
			: { day: '', count: 0 }
		// How much of today's quota is already spent. Derived on every run, so a
		// missing or hand-edited field means "nothing spent yet" rather than an
		// error that would stop the review.
		const progress = parsed.progress !== null && typeof parsed.progress === 'object'
			? {
				day: String(parsed.progress.day ?? ''),
				reviewed: Math.max(0, Math.round(Number(parsed.progress.reviewed)) || 0),
				batches: Math.max(0, Math.round(Number(parsed.progress.batches)) || 0),
			}
			: { day: '', reviewed: 0, batches: 0 }
		return {
			lastRunAt: typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : '',
			dayKey: typeof parsed.dayKey === 'string' ? parsed.dayKey : '',
			cards,
			attempts,
			progress,
		}
	}

	/**
	 * Persist the review ledger.
	 *
	 * @param {object} ledger - The ledger to write.
	 * @returns {Promise<void>} Resolves when written.
	 */
	async saveConsolidationLedger(ledger) {
		await writeJsonAtomic(this.consolidationPath(), ledger)
	}

	/**
	 * Lifecycle counters.
	 *
	 * @returns {object} Counters.
	 */
	status() {
		const cards = this.all()
		const roots = Object.fromEntries(TOP_TAGS.map((tag) => [tag, 0]))
		let archived = 0
		for (const card of cards) {
			if (isArchived(card.tags)) {
				archived += 1
				continue
			}
			for (const root of new Set(card.tags.map((tag) => rootOf(tag)))) {
				if (roots[root] !== undefined) roots[root] += 1
			}
		}
		return {
			cards: cards.length,
			roots,
			archived,
			// A failed background write is retried, but the panel should be able
			// to say why a card it just saved is not on disk yet.
			writeError: this.cards.db.lastWriteError,
		}
	}

	/**
	 * Public view of one record.
	 *
	 * @param {object} record - The raw record.
	 * @returns {object} The card.
	 */
	cardOf(record) {
		// The log can arrive by import and be hand-edited. Reading tells us the
		// record is JSON, not that every field kept its shape, and one wrong
		// shape (links as a number) used to throw from `backlinks()` on every
		// query. Drop the bad field, keep the card.
		const links = Array.isArray(record.links) ? record.links.filter((id) => typeof id === 'string') : []
		return {
			id: record.id,
			description: normalizeDescription(record.description),
			body: typeof record.body === 'string' ? record.body : '',
			tags: Array.isArray(record.tags) ? record.tags.filter((tag) => typeof tag === 'string') : [],
			links,
			...(record.source !== null && typeof record.source === 'object' ? { source: record.source } : {}),
			created: cardCreatedAt(record.id),
			updated: typeof record.updated === 'string' ? record.updated : '',
		}
	}

	/**
	 * Every card.
	 *
	 * @returns {object[]} The cards.
	 */
	all() {
		const version = this.cards.version
		if (this.allCache !== null && this.allVersion === version) return [...this.allCache]
		const cards = this.cards.all().map((record) => this.cardOf(record))
		this.allCache = cards
		this.allVersion = version
		// A copy, because callers sort and filter the result in place.
		return [...cards]
	}

	/**
	 * The raw records, for derived views that do not need card objects.
	 *
	 * @returns {object[]} The records, insertion order.
	 */
	records() {
		return this.cards.records()
	}

	/**
	 * One card.
	 *
	 * @param {string} id - Card id.
	 * @returns {object | undefined} The card.
	 */
	get(id) {
		const record = this.cards.getEntry(id)
		return record === undefined ? undefined : this.cardOf(record)
	}

	/**
	 * Decide the tag list one write stores.
	 *
	 * An explicit list is the caller's promise and is validated strictly — the
	 * `card_write` contract says only the six branches exist. A list inherited
	 * from the record on disk is different: it may come from an imported older
	 * library whose roots this store no longer knows. Instead of making such a
	 * card unwritable (body edits, archives and the nightly repair all pass
	 * through here), inherited tags are settled deterministically by
	 * `coerceCardTags` and the degradation is logged once per write.
	 *
	 * @param {unknown} proposed - The tags the caller passed, when any.
	 * @param {object | undefined} previous - The current card view.
	 * @param {number} limit - Maximum tags to keep.
	 * @returns {string[]} The tags to store.
	 */
	resolveTags(proposed, previous, limit = MAX_TAGS) {
		// `limit` may carry the extra slots a promote/archive call needs; the
		// ceiling keeps a caller from growing the tag list without bound.
		const cap = Math.max(1, Math.min(MAX_TAGS + 2, Math.round(Number(limit) || MAX_TAGS)))
		// The panel sends the whole card back; unchanged inherited tags are not a
		// new proposal, so they take the lenient path too.
		if (previous !== undefined && Array.isArray(proposed) && sameTagList(proposed, previous.tags ?? [])) {
			return coerceCardTags(previous.tags, {
				limit: cap,
				onDegrade: (from, to) => this.logger?.warn?.(`dsh-evolver: 旧标签 #${from} 已降级为 #${to}（继承写入）`),
			})
		}
		if (proposed === undefined && previous !== undefined) {
			return coerceCardTags(previous.tags, {
				limit: cap,
				onDegrade: (from, to) => this.logger?.warn?.(`dsh-evolver: 旧标签 #${from} 已降级为 #${to}（继承写入）`),
			})
		}
		return normalizeCardTags(proposed, { limit: cap })
	}

	/**
	 * Validate and store one card.
	 *
	 * @param {object} input - The card fields.
	 * @param {{resourceInputs?: Array<{name: string, data: string | Buffer}>, tagsLimit?: number}} [options] - Files to attach and the tag cap (archive/promote need one extra slot).
	 * @returns {Promise<object>} The stored card.
	 */
	async put(input = {}, { resourceInputs = [], tagsLimit = MAX_TAGS } = {}) {
		const id = input.id === undefined ? cardId() : input.id
		if (!isCardId(id)) throw new Error('卡片 id 不合法。')
		const existing = this.cards.getEntry(id)
		const previous = existing === undefined ? undefined : this.cardOf(existing)
		let body = String(input.body ?? previous?.body ?? '')
		// The tool path checks this before calling; the panel and the HTTP API
		// reach `put` directly, so the check belongs at the one write entrance
		// rather than at one of its callers.
		if (body.trim() === '') throw new Error('卡片正文不能为空。')
		const secret = findSecret(body)
		if (secret !== undefined) throw new Error(`正文里像是${secret}：卡片库不保存密钥，请删掉后重写。`)
		const tags = this.resolveTags(input.tags, previous, tagsLimit)
		const now = new Date().toISOString()
		// An explicit list is the caller's promise and is validated strictly. A
		// list inherited from the record on disk may name a card that was
		// removed since: keeping it would make this card permanently
		// unwritable, so the dead reference is dropped with a warning instead.
		const explicitLinks = Array.isArray(input.links)
		const proposedLinks = explicitLinks ? [...new Set(input.links.map(String))] : (previous?.links ?? [])
		const links = []
		for (const link of proposedLinks) {
			if (!isCardId(link)) {
				if (explicitLinks) throw new Error(`链接目标不是卡片 id：${link}`)
				continue
			}
			if (link === id) {
				if (explicitLinks) throw new Error('卡片不能链接自己。')
				continue
			}
			// A link to a card that is not there renders as "(missing)" for
			// ever and leaves a ghost key in the backlink map.
			if (this.cards.getEntry(link) === undefined) {
				if (explicitLinks) throw new Error(`链接目标不存在：${link}`)
				this.logger?.warn?.(`dsh-evolver: dropped a dead link on ${id}: ${link}`)
				continue
			}
			links.push(link)
		}
		// Verbatim provenance travels with the card: the daily review uses it to
		// check the note against what was actually said, which is the one thing
		// a card cannot tell about itself.
		const source = input.source === undefined ? previous?.source : normalizeSource(input.source)
		// A description inherited from disk is not a new proposal. The store
		// used to hold it to the current limits, so lowering the limit in the
		// panel made every existing longer card uneditable; the index clips what
		// it renders, so only a new proposal has to fit.
		const explicitDescription = input.description !== undefined
		let description = explicitDescription
			? normalizeDescription(input.description)
			: (previous?.description ?? '')
		// The description is injected next to the card in the index, so it goes
		// through the same secret screen as the body. A missing description is
		// not an error (it is optional), a line that looks like a credential is.
		if (description !== '') {
			const leaked = findSecret(description)
			if (leaked !== undefined) {
				if (explicitDescription) throw new Error(`描述里像是${leaked}：卡片库不保存密钥，请删掉后重写。`)
				// An imported record may carry one. Keeping it would put the
				// secret into every prompt; refusing the edit would brick the
				// card. Drop it and say so.
				this.logger?.warn?.(`dsh-evolver: dropped a description that looks like ${leaked} on ${id}`)
				description = ''
			}
			if (explicitDescription && charCount(description) > this.descriptionMaxChars) {
				throw new Error(`描述超过 ${this.descriptionMaxChars} 字上限；它是一句话索引，不是摘要。`)
			}
		}
		const resourceNames = new Set((await this.resources.list(id)).map((item) => item.name))
		// macOS and Windows file systems are case-insensitive: `A.md` and
		// `a.md` are one file there. The sanitised name can also collide with an
		// existing one (`a b.md` and `a-b.md` both become `a-b.md`). Either way
		// the later write would silently replace the earlier file, so a taken
		// name is a refusal, not an overwrite.
		const takenNames = new Set([...resourceNames].map((name) => name.toLowerCase()))
		const inputNames = []
		for (const resource of resourceInputs) {
			const name = safeResourceName(resource.name)
			if (name === '') throw new Error(`资源文件名不合法：${String(resource.name)}`)
			if (takenNames.has(name.toLowerCase())) {
				throw new Error(`同名附件已存在：${name}；请换个名字，避免覆盖已有文件。`)
			}
			takenNames.add(name.toLowerCase())
			inputNames.push(name)
			resourceNames.add(name)
		}
		for (const name of inputNames) {
			const relativePath = resourceRelativePath(id, name)
			body = body.replaceAll(`{{resource:${name}}}`, relativePath)
		}
		if (inputNames.length === 1) body = body.replaceAll('{{resource}}', resourceRelativePath(id, inputNames[0]))
		if (body.includes('{{resource')) throw new Error('正文里有未解析的附件占位符；请用 {{resource}} 或 {{resource:文件名}}。')
		assertResourceReferences(body, id, [...resourceNames])
		if (charCount(body) > this.cardMaxChars) {
			throw new Error(`卡片正文超过 ${this.cardMaxChars} 字上限；请拆成多张卡，或把长内容放入资源附件。`)
		}
		for (const resource of resourceInputs) {
			await this.resources.put(id, resource.name, resource.data)
			this.attachmentCache.delete(id)
		}
		const record = {
			id,
			body,
			tags,
			...(description === '' ? {} : { description }),
			...(links.length > 0 ? { links } : {}),
			...(source === undefined ? {} : { source }),
			updated: now,
		}
		await this.cards.putMemory(record)
		return this.cardOf(record)
	}

	/**
	 * Attach one resource to an existing card.
	 *
	 * @param {string} id - Card id.
	 * @param {string} name - The file name.
	 * @param {Buffer | string} data - The content.
	 * @returns {Promise<object>} The updated card.
	 */
	async attach(id, name, data) {
		const card = this.get(id)
		if (card === undefined) throw new Error(`找不到卡片：${id}`)
		const safe = safeResourceName(name)
		if (safe === '') throw new Error(`资源文件名不合法：${String(name)}`)
		const relativePath = resourceRelativePath(id, safe)
		// The reference line is built *before* the file is written and put back
		// through `put`, which validates the length first. Writing the file
		// first left a card whose body no longer fits, and because `put` also
		// demands that every file on disk is referenced, that card could never
		// be saved again — one failed upload turned it read-only.
		const body = hasResourceReference(card.body, relativePath)
			? card.body
			: `${String(card.body ?? '').trim()}\n\n[${safe}]({{resource}})：用途：附件资源；入口：按文件说明；输入、输出和关联流程：待补充。`.trim()
		await this.put({ ...card, id, body }, { resourceInputs: [{ name: safe, data }] })
		return this.read(id)
	}

	/**
	 * Resolve one attachment to its absolute path, refusing anything outside
	 * the card's own folder.
	 *
	 * The panel and the "open with the system app" action both need a path,
	 * and neither may be trusted to build one: the client sends a card id and
	 * a file name, this turns them into the only path that could be meant.
	 *
	 * @param {string} id - The card id.
	 * @param {string} name - The file name.
	 * @returns {Promise<string>} The absolute path.
	 */
	async resourcePath(id, name) {
		await this.resources.read(id, name)
		return join(this.dataDir, 'knowledge', 'resources', id, safeResourceName(name))
	}

	/**
	 * Read one attachment for the preview pane.
	 *
	 * Three answers, because resources are not all text: a text file comes
	 * back as text (capped — a 400 KB log is not a preview), an image comes
	 * back as base64 the panel can drop into an `<img>`, and everything else
	 * says "binary" so the panel offers the system app instead of rendering.
	 *
	 * @param {string} id - The card id.
	 * @param {string} name - The file name.
	 * @returns {Promise<object>} `{kind, mime, bytes, name, text?, base64?, truncated?}`.
	 */
	async resourcePreview(id, name, { textLimit = 200 * 1024, binaryLimit = 4 * 1024 * 1024 } = {}) {
		const safe = safeResourceName(name)
		if (safe === '') throw new Error('资源文件名不合法。')
		const read = await this.resources.read(id, safe)
		const mime = mimeOf(safe)
		const base = { name: read.name, bytes: read.bytes, mime, executable: read.executable === true }
		// An image is always sent as bytes. SVG is also valid text, so the text
		// branch used to answer `kind: 'image'` with no base64 and the panel
		// rendered `data:image/svg+xml;base64,undefined`.
		if (mime.startsWith('image/')) {
			if (read.bytes > binaryLimit) return { ...base, kind: 'binary' }
			const buffer = await readFile(read.path)
			return { ...base, kind: 'image', base64: buffer.toString('base64') }
		}
		if (typeof read.text === 'string') {
			const chars = [...read.text]
			const truncated = chars.length > textLimit
			return { ...base, kind: 'text', text: truncated ? chars.slice(0, textLimit).join('') : read.text, truncated }
		}
		// Binary: only formats the browser can actually display come back whole.
		if (mime === 'application/pdf' && read.bytes <= binaryLimit) {
			const buffer = await readFile(read.path)
			return { ...base, kind: 'pdf', base64: buffer.toString('base64') }
		}
		return { ...base, kind: 'binary' }
	}

	/**
	 * What files one card carries, without reading them.
	 *
	 * Cached because the answer is asked on list/query paths that touch many
	 * cards: a `readdir` per card per query is how a cheap call becomes an
	 * expensive one. The cache is dropped whenever a card's attachments are
	 * rewritten.
	 *
	 * @param {string} id - The card id.
	 * @returns {Promise<Array<{name: string, bytes: number, executable: boolean}>>} The metadata.
	 */
	async attachments(id) {
		const cached = this.attachmentCache.get(id)
		if (cached !== undefined) return cached
		const listed = await this.resources.list(id).catch(() => [])
		const summary = listed.map((item) => ({ name: item.name, bytes: item.bytes, executable: item.executable === true }))
		this.attachmentCache.set(id, summary)
		return summary
	}

	/**
	 * Every card that carries at least one file.
	 *
	 * Reads the resources directory once and then each card folder that
	 * exists, instead of statting every card in the library.
	 *
	 * @returns {Promise<Array<{id: string, files: object[]}>>} The cards with files.
	 */
	async resourcesIndex() {
		const version = this.cards.version
		if (this.resourcesIndexCache !== null && this.resourcesIndexCache.version === version) {
			return this.resourcesIndexCache.value
		}
		const root = join(this.dataDir, 'knowledge', 'resources')
		const names = await readdir(root).catch(() => [])
		// One pass over the bodies, then a substring test per file: "which cards
		// reference this file" is a literal question and the answer is already
		// in the text.
		const bodies = this.all().map((card) => ({ id: card.id, body: String(card.body ?? '') }))
		const out = []
		for (const name of names) {
			if (!isCardId(name)) continue
			const files = await this.attachments(name)
			if (files.length === 0) continue
			out.push({
				id: name,
				files: files.map((file) => {
					const path = resourceRelativePath(name, file.name)
					return { ...file, path, referencing: bodies.filter((card) => card.body.includes(path)).map((card) => card.id) }
				}),
			})
		}
		this.resourcesIndexCache = { version, value: out }
		return out
	}

	/**
	 * Read a card and its text resources.
	 *
	 * @param {string} id - Card id.
	 * @param {{text?: boolean}} [options] - `text: false` skips attachment
	 *   contents for callers (the panel) that only show metadata.
	 * @returns {Promise<object | undefined>} The card plus resource contents.
	 */
	async read(id, { text = true } = {}) {
		const card = this.get(id)
		if (card === undefined) return undefined
		const listed = await this.resources.list(id)
		if (text !== true) return { ...card, resources: listed, resourceContents: [] }
		const contents = []
		let textBudget = MAX_TOTAL_TEXT_BYTES
		for (const item of listed) {
			try {
				const resource = await this.resources.read(id, item.name)
				if (typeof resource.text === 'string') {
					// One card can carry several large documents; returning all of
					// them put megabytes into one tool result (and the model's
					// context). Keep the metadata, drop the overflow text.
					// The budget is in bytes: `length` counts UTF-16 units, so a
					// Chinese document passed a 256 KB budget at ~768 KB.
					const textBytes = Buffer.byteLength(resource.text, 'utf8')
					if (textBytes > textBudget) {
						contents.push({
							name: resource.name,
							bytes: resource.bytes,
							sha256: resource.sha256,
							path: resource.path,
							omitted: true,
							note: '文本超过单卡读取预算，请用 path 单独读取。',
						})
						continue
					}
					textBudget -= textBytes
				}
				contents.push(resource)
			} catch (error) {
				contents.push({ name: item.name, bytes: item.bytes, error: error instanceof Error ? error.message : String(error) })
			}
		}
		return { ...card, resources: listed, resourceContents: contents, ...(textBudget < MAX_TOTAL_TEXT_BYTES ? { textBudget } : {}) }
	}

	/**
	 * Filter cards without a text query.
	 *
	 * @param {{tags?: string[], anyTags?: string[], limit?: number, includeArchived?: boolean}} [options] - Filters.
	 * @returns {object[]} The cards.
	 */
	list({ tags = [], anyTags = [], limit = 50, includeArchived = false, archivedOnly = false, resourcePath = '' } = {}) {
		return this.listPage({ tags, anyTags, limit, includeArchived, archivedOnly, resourcePath }).cards
	}

	/**
	 * One page of cards, with the size of the whole match.
	 *
	 * The panel shows a page; without the total a truncated list looks
	 * complete.
	 *
	 * @param {object} options - The same filters as `list`.
	 * @returns {{cards: object[], total: number}} The page and the match size.
	 */
	listPage({ tags = [], anyTags = [], limit = 50, includeArchived = false, archivedOnly = false, resourcePath = '' } = {}) {
		const filters = normalizeTags(tags)
		const any = normalizeTags(anyTags)
		// A resource path is a literal needle, not a search word: "which cards
		// reference this file" is an exact question and BM25 would answer a
		// different one.
		const needle = String(resourcePath ?? '').trim()
		const archivedFilter = filters.some((tag) => tag.split('/').pop() === '归档')
		const cards = this.all().filter((card) => {
			if (archivedOnly && !isArchived(card.tags)) return false
			if (!includeArchived && !archivedFilter && !archivedOnly && isArchived(card.tags)) return false
			if (filters.length > 0) {
				const cardTags = card.tags ?? []
				if (!filters.every((filter) => cardTags.some((tag) => isUnder(tag, filter)))) return false
			}
			if (any.length > 0) {
				const cardTags = card.tags ?? []
				if (!any.some((filter) => cardTags.some((tag) => isUnder(tag, filter)))) return false
			}
			if (needle !== '' && !String(card.body ?? '').includes(needle)) return false
			return true
		})
		cards.sort((left, right) => String(right.updated).localeCompare(String(left.updated)))
		const size = Math.max(1, Math.min(200, Math.round(Number(limit) || 50)))
		return { cards: cards.slice(0, size), total: cards.length }
	}

	/**
	 * Search cards with the memory layer's hybrid retrieval.
	 *
	 * @param {{text?: string, tags?: string[], anyTags?: string[], limit?: number, includeArchived?: boolean}} [request] - The query.
	 * @returns {Promise<object[]>} Matching cards.
	 */
	async query({ text = '', tags = [], anyTags = [], limit = 8, includeArchived = false, archivedOnly = false, resourcePath = '' } = {}) {
		return (await this.queryPage({ text, tags, anyTags, limit, includeArchived, archivedOnly, resourcePath })).cards
	}

	/**
	 * Search with the match count, for the panel.
	 *
	 * The tag filter is part of the retrieval, not a pass over its result: on a
	 * noisy library the matching card used to sit below the top-50 cut, so a
	 * narrowed search answered "nothing" while the card was there.
	 *
	 * @param {object} [request] - The same fields as `query`.
	 * @returns {Promise<{cards: object[], total: number}>} A page and how many cards match.
	 */
	async queryPage({ text = '', tags = [], anyTags = [], limit = 8, includeArchived = false, archivedOnly = false, resourcePath = '' } = {}) {
		const queryText = String(text ?? '').trim()
		const size = Math.max(1, Math.min(100, Math.round(Number(limit) || 8)))
		if (queryText === '') return this.listPage({ tags, anyTags, limit: size, includeArchived, archivedOnly, resourcePath })
		const keep = cardFilter({ tags, anyTags, includeArchived, archivedOnly })
		const needle = String(resourcePath ?? '').trim()
		let total = 0
		const results = await hybridRetrieve({
			db: this.cards.db,
			query: queryText,
			limit: size,
			accept: (id) => {
				const card = this.get(id)
				return card !== undefined && keep(card) && (needle === '' || String(card.body ?? '').includes(needle))
			},
			onTotal: (count) => { total = count },
		})
		return { cards: results.map((result) => this.cardOf(result.memory)), total: total === 0 ? results.length : total }
	}

	/**
	 * Search cards and walk the link graph around the hits.
	 *
	 * The flat `query` answers "which cards say the words". This one also
	 * answers "what came with them": the lexical hits become seeds, the
	 * score spreads along the links (see ../memory/graph.js), and the result
	 * carries the neighbourhood as a subgraph. Lexical match is still the
	 * stronger signal — the walk can add a neighbour to the list, but it
	 * cannot outrank the card that actually matched.
	 *
	 * `within` is the second-pass scoping: the candidate library is
	 * intersected with the given ids before the graph is built, so a caller
	 * can dig into a subgraph it already saw instead of searching the whole
	 * library again. An empty `within` means "no scope".
	 *
	 * @param {{text?: string, tags?: string[], anyTags?: string[], limit?: number, includeArchived?: boolean, hops?: number, within?: string[]}} [request] - The query.
	 * @returns {Promise<{cards: object[], related: object[], graph: {nodes: object[], edges: Array<{from: string, to: string}>}}>} The hits, their neighbours and the subgraph.
	 */
	async queryGraph({ text = '', tags = [], anyTags = [], limit = 8, includeArchived = false, hops = 1, within = [] } = {}) {
		const keep = cardFilter({ tags, anyTags, includeArchived })
		const scope = scopedIds(within)
		const scoped = (card) => scope.size === 0 || scope.has(card.id)
		// The graph is built over exactly the cards the flat search would be
		// allowed to return. An edge to an archived or filtered card is not a
		// route the caller can take, so keeping it would only add dead ends.
		const candidates = this.all().filter((card) => keep(card) && scoped(card))
		const graph = buildGraph(candidates)
		const degree = degrees(graph)
		const backlinks = this.backlinks()
		const queryText = String(text ?? '').trim()
		const size = Math.max(1, Math.min(50, Math.round(Number(limit) || 8)))
		// The card view keeps the degree the flat search already reports, so a
		// caller can compare hub-ness across both modes without branching.
		const cardView = (card) => ({
			...card,
			degree: { in: (backlinks[card.id] ?? []).length, out: (card.links ?? []).length },
		})
		if (queryText === '') {
			// No words to score: the answer is the filtered list itself, newest
			// first (the same order `list` returns), with an empty relation half.
			const cards = [...candidates]
				.sort((left, right) => String(right.updated).localeCompare(String(left.updated)))
				.slice(0, size)
			return {
				cards: cards.map(cardView),
				related: [],
				graph: subgraphView(graph, degree, cards.map((card) => card.id)),
			}
		}
		const results = await hybridRetrieve({
			db: this.cards.db,
			query: queryText,
			limit: Math.max(size * 4, 20),
			// Filter the candidate set, not its truncated tail: the same fix as
			// `queryPage`, applied to the graph view.
			accept: (id) => {
				const card = this.get(id)
				return card !== undefined && keep(card) && scoped(card)
			},
		})
		const hits = results.map((result) => ({ card: this.cardOf(result.memory), score: result.score }))
		// BM25 scores are only comparable within one query (see hybrid.js), so
		// the seed weights are scaled against the best surviving hit: the walk
		// wants relative weight, not absolute keyword numbers.
		const best = hits.reduce((max, hit) => Math.max(max, hit.score), 0)
		const lexical = new Map()
		const seeds = []
		for (const hit of hits) {
			const weight = best > 0 ? hit.score / best : 0
			if (weight <= 0) continue
			lexical.set(hit.card.id, weight)
			seeds.push({ id: hit.card.id, weight })
		}
		const relatedScores = spread({ graph, seeds, hops })
		const combined = combine(lexical, relatedScores)
		const ranked = [...combined.entries()]
			.filter(([id]) => graph.nodes.has(id))
			.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		const cardIds = ranked.slice(0, size).map(([id]) => id)
		const cardSet = new Set(cardIds)
		const relatedIds = ranked
			.filter(([id]) => !cardSet.has(id))
			.slice(0, MAX_RELATED)
			.map(([id]) => id)
		return {
			cards: cardIds.map((id) => cardView(graph.nodes.get(id))),
			related: relatedIds.map((id) => {
				const card = graph.nodes.get(id)
				return {
					id,
					description: card.description ?? '',
					tags: card.tags ?? [],
					degree: { in: (backlinks[id] ?? []).length, out: (card.links ?? []).length },
					score: Number((combined.get(id) ?? 0).toFixed(4)),
				}
			}),
			graph: subgraphView(graph, degree, [...cardIds, ...relatedIds]),
		}
	}

	/**
	 * The active tag forest with counts.
	 *
	 * @param {{includeArchived?: boolean}} [options] - Include archived cards.
	 * @returns {Array<object>} Root nodes.
	 */
	tagTree({ includeArchived = false } = {}) {
		const tree = buildTagTree(this.all().filter((card) => includeArchived || !isArchived(card.tags)))
		return tree.sort((left, right) => TOP_TAGS.indexOf(left.path) - TOP_TAGS.indexOf(right.path))
	}

	/**
	 * Resolve a full id, a prefixed id, or an unambiguous short id.
	 *
	 * The injected index shows suffixes (see `ids.shortIds`); models and people
	 * type what they see, so every entry point that takes an id accepts one.
	 * A suffix that matches more than one card is an error rather than a guess:
	 * reading the wrong card silently is worse than asking for the full id.
	 *
	 * @param {unknown} token - The id or abbreviation.
	 * @returns {string | undefined} The full id, or undefined when nothing matches.
	 */
	resolveId(token) {
		const raw = String(token ?? '').trim()
		if (raw === '') return undefined
		const ids = this.resolvedIds()
		if (ids.includes(raw)) return raw
		const prefixed = raw.startsWith('card-') ? raw : `card-${raw}`
		if (ids.includes(prefixed)) return prefixed
		const body = prefixed.slice(5)
		if (body.length < 3) return undefined
		const matches = ids.filter((id) => id.slice(5).endsWith(body))
		if (matches.length === 1) return matches[0]
		if (matches.length === 0) return undefined
		const sample = matches.slice(0, 3).map((id) => id.slice(-8)).join('、')
		throw new Error(`缩写「${raw}」不唯一：匹配 ${matches.length} 张卡（${sample}…），请用完整 id 或更长的缩写。`)
	}

	/**
	 * The id list of the current store version.
	 *
	 * @returns {string[]} Every card id.
	 */
	resolvedIds() {
		const version = this.cards.version
		if (this.idCache !== null && this.idVersion === version) return this.idCache
		this.idCache = this.cards.all().map((record) => record.id)
		this.idVersion = version
		return this.idCache
	}

	/**
	 * Incoming links per card.
	 *
	 * @returns {Record<string, string[]>} Target id to source ids.
	 */
	backlinks() {
		const version = this.cards.version
		if (this.backlinksCache !== null && this.backlinksVersion === version) return this.backlinksCache
		const map = new Map()
		for (const card of this.all()) {
			for (const link of card.links ?? []) {
				if (!map.has(link)) map.set(link, [])
				map.get(link).push(card.id)
			}
		}
		this.backlinksCache = Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)))
		this.backlinksVersion = version
		return this.backlinksCache
	}

	/**
	 * Move a card out of #即兴 into one or more settled branches.
	 *
	 * @param {string} id - Card id.
	 * @param {{tags?: string[]}} [options] - Promotion fields.
	 * @returns {Promise<object>} The promoted card.
	 */
	async promote(id, { tags } = {}) {
		const card = this.get(id)
		if (card === undefined) throw new Error(`找不到卡片：${id}`)
		const targets = Array.isArray(tags) ? tags : []
		return this.put({
			...card,
			id,
			tags: settleTags(card.tags, targets),
		}, { tagsLimit: MAX_TAGS + Math.min(2, targets.length) })
	}

	/**
	 * Archive one card by adding `归档`.
	 *
	 * @param {string} id - Card id.
	 * @returns {Promise<object>} The archived card.
	 */
	async archive(id) {
		const card = this.get(id)
		if (card === undefined) throw new Error(`找不到卡片：${id}`)
		return this.put({ ...card, id, tags: archiveTags(card.tags) }, { tagsLimit: MAX_TAGS + 1 })
	}

	/**
	 * Remove one card and its resources.
	 *
	 * @param {string} id - Card id.
	 * @returns {Promise<boolean>} Whether it existed.
	 */
	async remove(id, { archiveResources = false } = {}) {
		const existed = await this.cards.deleteMemory(id)
		// Write the tombstone before touching the files it refers to. The other
		// order leaves a window where a crash brings the card back with empty
		// attachments — the body survives, the script it pointed at does not.
		await this.cards.flush()
		// Links pointing here are pruned now, not at the next nightly repair:
		// `put` refuses a link whose target is gone, so a card that linked the
		// removed one would otherwise be uneditable until the next review.
		await this.pruneLinkTarget(id)
		if (archiveResources) {
			// The organiser promises that nothing leaves without a copy; a card's
			// attachments are part of the card.
			await this.resources.archiveCard(id, join(this.dataDir, 'knowledge', 'trash-resources')).catch(() => {})
		} else {
			await this.resources.removeCard(id)
			this.attachmentCache.delete(id)
		}
		return existed
	}

	/**
	 * Drop every link that points at one removed card.
	 *
	 * Only the `links` field is written per card: the body and the tags are
	 * re-read inside `put`, so a concurrent edit is not overwritten with this
	 * scan's snapshot.
	 *
	 * @param {string} id - The removed card id.
	 * @returns {Promise<void>} Resolves when the references are gone.
	 */
	async pruneLinkTarget(id) {
		for (const card of this.all()) {
			const links = card.links ?? []
			if (!links.includes(id)) continue
			try {
				await this.put({ id: card.id, links: links.filter((link) => link !== id) })
			} catch (error) {
				// A card the store refuses must not stop the removal that is
				// already committed; the next repair pass tries again.
				this.logger?.warn?.(`dsh-evolver: could not prune the link to ${id} on ${card.id}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
	}
}
