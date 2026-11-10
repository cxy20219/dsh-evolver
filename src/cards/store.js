/**
 * The unified card store.
 *
 * Cards live in one append-only log (`knowledge/cards/cards.jsonl`) and
 * reuse the memory layer's BM25/vector/lifecycle machinery: the card record
 * is a superset of a memory record, so search, recall and re-embedding keep
 * working while the record gains type/shape/status/tags/links/resources.
 *
 * The two projections are derived from the same records:
 *   - `projection()` builds the small permanent-only routing table injected
 *     into the prompt;
 *   - `query()` searches every card (fleeting included) on demand.
 *
 * No title is required: `label` is derived from the first line, and permanent
 * cards keep a one-line `summary` for routing. Long content lives in the
 * resource store, not in the card body.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { MemoryStore } from '../memory/store.js'
import { hybridRetrieve } from '../memory/hybrid.js'
import { ENTRY_KINDS } from '../memory/kinds.js'
import { cardId, isCardId } from './ids.js'
import { ResourceStore, safeResourceName } from './resources.js'
import { buildTagTree, isUnder, normalizeTag, normalizeTags } from './tags.js'

/** The two card lives. */
export const CARD_TYPES = ['fleeting', 'permanent']

/** The content shapes. */
export const CARD_SHAPES = ['memo', 'note', 'doc', 'tool', 'resource']

/** The status axis. */
export const CARD_STATUSES = ['inbox', 'verified', 'archived']

/** The semantic categories inherited from memory. */
export const CARD_CATEGORIES = ENTRY_KINDS

/** The default body budget, in Unicode code points. */
export const DEFAULT_CARD_MAX_CHARS = 1000

/** The injected routing table budget, in bytes. */
export const DEFAULT_PROJECTION_BYTES = 2048

/** The order permanent shapes appear in the routing table. */
const SHAPE_ORDER = { note: 0, doc: 1, tool: 2, resource: 3, memo: 4 }

/**
 * Derive a card label from its body.
 *
 * @param {unknown} body - The body text.
 * @returns {string} A single-line label.
 */
export function labelOf(body) {
	const line = String(body ?? '').split('\n').map((part) => part.trim()).find((part) => part !== '') ?? ''
	return line
		.replace(/^#{1,6}\s+/, '')
		.replace(/^[-*+>]\s+/, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80)
}

/**
 * Count the visible characters of a string.
 *
 * @param {unknown} value - The value.
 * @returns {number} The code point count.
 */
export function charCount(value) {
	return [...String(value ?? '')].length
}

/**
 * One line, safe for the injected routing table.
 *
 * @param {unknown} value - The text.
 * @param {number} max - Maximum code points.
 * @returns {string} The sanitised line.
 */
function oneLine(value, max) {
	return [...String(value ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('')
}

/**
 * The unified card store.
 */
export class CardStore {
	/**
	 * @param {{dataDir: string, embedding?: object, logger?: object, cardMaxChars?: number}} deps - Dependencies.
	 */
	constructor({ dataDir, embedding, logger, cardMaxChars = DEFAULT_CARD_MAX_CHARS }) {
		this.dataDir = dataDir
		this.logger = logger
		this.cardMaxChars = Math.max(1, Math.min(4000, Math.round(Number(cardMaxChars) || DEFAULT_CARD_MAX_CHARS)))
		this.cards = new MemoryStore({
			dataDir,
			folder: 'knowledge/cards',
			logName: 'cards.jsonl',
			embedding,
			logger,
		})
		this.resources = new ResourceStore({ root: dataDir })
	}

	/**
	 * Open the store and prepare the resource folder.
	 *
	 * @returns {Promise<void>} Resolves when records are loaded.
	 */
	async init() {
		await mkdir(join(this.dataDir, 'knowledge', 'resources'), { recursive: true, mode: 0o700 })
		await this.cards.init()
	}

	/**
	 * Close the store.
	 *
	 * @returns {Promise<void>} Resolves when flushed.
	 */
	async close() {
		await this.cards.close()
	}

	/**
	 * Flush pending writes.
	 *
	 * @returns {Promise<void>} Resolves when flushed.
	 */
	async flush() {
		await this.cards.flush()
	}

	/**
	 * The store counters.
	 *
	 * @returns {object} Counters.
	 */
	status() {
		const cards = this.all()
		const byType = {}
		const byStatus = {}
		const byShape = {}
		for (const card of cards) {
			byType[card.type] = (byType[card.type] ?? 0) + 1
			byStatus[card.status] = (byStatus[card.status] ?? 0) + 1
			byShape[card.shape] = (byShape[card.shape] ?? 0) + 1
		}
		return {
			cards: cards.length,
			byType,
			byStatus,
			byShape,
			embedder: this.cards.status().embedder,
			vectorsReady: this.cards.vectorsReady(),
		}
	}

	/**
	 * Public view of one record.
	 *
	 * @param {object} record - The raw record.
	 * @returns {object} The card.
	 */
	cardOf(record) {
		return {
			id: record.id,
			slug: record.slug ?? '',
			type: record.type ?? 'fleeting',
			shape: record.shape ?? 'memo',
			category: record.category ?? record.kind ?? '',
			status: record.status ?? 'inbox',
			label: record.label ?? labelOf(record.body ?? record.text),
			summary: record.summary ?? '',
			body: record.body ?? record.text ?? '',
			topic: record.topic ?? '',
			tags: record.tags ?? [],
			links: record.links ?? [],
			resources: record.resources ?? [],
			scope: record.scope ?? 'global',
			source: record.source ?? 'manual',
			sourceId: record.sourceId ?? '',
			created: record.created ?? record.createdAt ?? '',
			updated: record.updated ?? record.updatedAt ?? '',
			verified: record.verified ?? '',
			pinned: record.pinned === true,
			importance: record.importance ?? 0.5,
			tier: record.tier ?? 'working',
			accessCount: record.accessCount ?? 0,
			lastAccessedAt: record.lastAccessedAt ?? '',
			overCap: record.overCap === true,
		}
	}

	/**
	 * Every card, newest first.
	 *
	 * @returns {object[]} The cards.
	 */
	all() {
		return this.cards.all().map((record) => this.cardOf(record))
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
	 * Resolve a card reference: id, slug, legacy sourceId or a path suffix.
	 *
	 * @param {unknown} ref - The reference.
	 * @returns {object | undefined} The card.
	 */
	resolve(ref) {
		const value = String(ref ?? '').trim().replace(/^\.\//, '')
		if (value === '') return undefined
		if (isCardId(value)) return this.get(value)
		const cards = this.all()
		return cards.find((card) => card.slug === value)
			?? cards.find((card) => card.sourceId === value)
			?? cards.find((card) => card.sourceId.endsWith(`/${value}`))
			?? cards.find((card) => card.sourceId.endsWith(`:${value}`))
	}

	/**
	 * Validate and store one card.
	 *
	 * @param {object} input - The card fields.
	 * @param {{resourceInputs?: Array<{name: string, data: string | Buffer}>}} [options] - Files to attach.
	 * @returns {Promise<object>} The stored card.
	 */
	async put(input = {}, { resourceInputs = [] } = {}) {
		const id = input.id === undefined ? cardId() : input.id
		if (!isCardId(id)) throw new Error('卡片 id 不合法。')
		const existing = this.cards.getEntry(id)
		const previous = existing === undefined ? undefined : this.cardOf(existing)
		const type = input.type ?? previous?.type ?? 'fleeting'
		if (!CARD_TYPES.includes(type)) throw new Error(`未知卡片类型：${String(type)}`)
		const shape = input.shape ?? previous?.shape ?? (type === 'permanent' ? 'note' : 'memo')
		if (!CARD_SHAPES.includes(shape)) throw new Error(`未知卡片形状：${String(shape)}`)
		const status = input.status ?? previous?.status ?? (type === 'permanent' ? 'verified' : 'inbox')
		if (!CARD_STATUSES.includes(status)) throw new Error(`未知卡片状态：${String(status)}`)
		if (type === 'fleeting' && (shape !== 'memo' || (status !== 'inbox' && status !== 'archived'))) {
			throw new Error('临时卡片只能是 memo，状态为 inbox 或 archived。')
		}
		if (type === 'permanent' && (shape === 'memo' || (status !== 'verified' && status !== 'archived'))) {
			throw new Error('永久卡片只能是 note/doc/tool/resource，状态为 verified 或 archived。')
		}
		const body = String(input.body ?? previous?.body ?? '')
		const overCap = input.overCap === true || previous?.overCap === true
		if (!overCap && charCount(body) > this.cardMaxChars) {
			throw new Error(`卡片正文超过 ${this.cardMaxChars} 字上限；请拆成多张卡，或把长内容放入资源附件。`)
		}
		const category = input.category ?? previous?.category ?? 'fact'
		if (category !== '' && !CARD_CATEGORIES.includes(category)) throw new Error(`未知卡片分类：${String(category)}`)
		const now = new Date().toISOString()
		const label = oneLine(input.label ?? previous?.label ?? labelOf(body), 80)
		const summary = oneLine(input.summary ?? previous?.summary ?? (type === 'permanent' ? label : ''), 200)
		const topic = normalizeTag(input.topic ?? previous?.topic ?? '')
		const tags = normalizeTags(input.tags ?? previous?.tags ?? [])
		const links = Array.isArray(input.links) ? [...new Set(input.links.map(String))] : (previous?.links ?? [])
		for (const link of links) {
			if (!isCardId(link)) throw new Error(`链接目标不是卡片 id：${link}`)
		}
		const resources = []
		if (Array.isArray(input.resources)) {
			for (const item of input.resources) {
				const name = safeResourceName(item?.name)
				if (name === '') continue
				resources.push({ name, bytes: Number(item.bytes) || 0, sha256: typeof item.sha256 === 'string' ? item.sha256 : '' })
			}
		} else if (previous !== undefined) {
			resources.push(...(previous.resources ?? []))
		}
		for (const resource of resourceInputs) {
			const metadata = await this.resources.put(id, resource.name, resource.data)
			const index = resources.findIndex((item) => item.name === metadata.name)
			if (index >= 0) resources[index] = metadata
			else resources.push(metadata)
		}
		const verified = input.verified ?? previous?.verified ?? (type === 'permanent' && status === 'verified' ? now.slice(0, 10) : '')
		const record = {
			id,
			slug: input.slug ?? previous?.slug ?? '',
			type,
			shape,
			category,
			status,
			label,
			summary,
			body,
			topic,
			tags,
			links,
			resources,
			scope: input.scope ?? previous?.scope ?? 'global',
			source: input.source ?? previous?.source ?? 'manual',
			sourceId: input.sourceId ?? previous?.sourceId ?? '',
			created: previous?.created ?? input.created ?? now,
			updated: now,
			verified,
			pinned: input.pinned === undefined ? previous?.pinned === true : input.pinned === true,
			overCap,
			importance: Number.isFinite(Number(input.importance)) ? Number(input.importance) : (previous?.importance ?? 0.5),
			tier: input.tier ?? previous?.tier ?? 'working',
			accessCount: previous?.accessCount ?? 0,
			lastAccessedAt: previous?.lastAccessedAt ?? '',
			// Memory-compatible fields: BM25, vectors and lifecycle reuse them.
			kind: category === '' ? 'fact' : category,
			text: body,
			content: body,
			l0Abstract: label,
			l1Overview: summary,
			createdAt: previous?.created ?? input.created ?? now,
			updatedAt: now,
			metadata: { source: 'cards' },
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
		const metadata = await this.resources.put(id, name, data)
		const resources = (card.resources ?? []).filter((item) => item.name !== metadata.name)
		resources.push(metadata)
		return this.put({ ...card, id, resources })
	}

	/**
	 * Read a card and its text resources.
	 *
	 * @param {string} id - Card id.
	 * @returns {Promise<object | undefined>} The card plus resource contents.
	 */
	async read(id) {
		const card = this.get(id)
		if (card === undefined) return undefined
		const listed = await this.resources.list(id)
		const contents = []
		for (const item of listed) {
			try {
				contents.push(await this.resources.read(id, item.name))
			} catch (error) {
				contents.push({ name: item.name, bytes: item.bytes, error: error instanceof Error ? error.message : String(error) })
			}
		}
		return { ...card, resourceContents: contents }
	}

	/**
	 * Filter cards without a text query.
	 *
	 * @param {{type?: string, status?: string, tags?: string[], limit?: number, includeArchived?: boolean}} [options] - Filters.
	 * @returns {object[]} The cards.
	 */
	list({ type, status, tags = [], limit = 50, includeArchived = false } = {}) {
		const filters = normalizeTags(tags)
		const cards = this.all().filter((card) => {
			if (type !== undefined && card.type !== type) return false
			if (status !== undefined && card.status !== status) return false
			if (status === undefined && card.status === 'archived' && !includeArchived) return false
			if (filters.length > 0) {
				const cardTags = card.tags ?? []
				if (!filters.every((filter) => cardTags.some((tag) => isUnder(tag, filter)))) return false
			}
			return true
		})
		cards.sort((left, right) => (right.pinned ? 1 : 0) - (left.pinned ? 1 : 0) || String(right.updated).localeCompare(String(left.updated)))
		return cards.slice(0, Math.max(1, Math.min(200, Math.round(Number(limit) || 50))))
	}

	/**
	 * Search cards with the memory layer's hybrid retrieval.
	 *
	 * @param {{text?: string, type?: string, status?: string, tags?: string[], limit?: number}} [request] - The query.
	 * @returns {Promise<object[]>} Matching cards.
	 */
	async query({ text = '', type, status, tags = [], limit = 8 } = {}) {
		const filters = normalizeTags(tags)
		const keep = (card) => {
			if (type !== undefined && card.type !== type) return false
			if (status !== undefined && card.status !== status) return false
			if (status === undefined && card.status === 'archived') return false
			if (filters.length > 0 && !filters.every((filter) => (card.tags ?? []).some((tag) => isUnder(tag, filter)))) return false
			return true
		}
		const queryText = String(text ?? '').trim()
		if (queryText === '') return this.list({ type, status, tags, limit }).filter(keep)
		let queryVector
		if (this.cards.vectorsReady()) {
			try {
				const embed = this.cards.embedder.embedQuery ?? this.cards.embedder.embed
				queryVector = await embed.call(this.cards.embedder, queryText)
			} catch {
				queryVector = undefined
			}
		}
		const results = await hybridRetrieve({
			db: this.cards.db,
			query: queryText,
			queryVector,
			limit: Math.max(limit * 4, 20),
			floor: queryVector === undefined ? undefined : this.cards.embedder.relevanceFloor,
		})
		return results
			.map((result) => this.cardOf(result.memory))
			.filter(keep)
			.slice(0, Math.max(1, Math.min(50, Math.round(Number(limit) || 8))))
	}

	/**
	 * The injected routing table: permanent, verified cards only.
	 *
	 * @param {{budget?: number}} [options] - The byte budget.
	 * @returns {string} The projection.
	 */
	projection({ budget = DEFAULT_PROJECTION_BYTES } = {}) {
		const permanent = this.all()
			.filter((card) => card.type === 'permanent' && card.status === 'verified')
			.sort((left, right) => (right.pinned ? 1 : 0) - (left.pinned ? 1 : 0)
				|| (SHAPE_ORDER[left.shape] ?? 9) - (SHAPE_ORDER[right.shape] ?? 9)
				|| String(left.topic).localeCompare(String(right.topic))
				|| String(right.verified).localeCompare(String(left.verified))
				|| String(left.label).localeCompare(String(right.label)))
		if (permanent.length === 0) return '[实践] 暂无永久卡片；用 card_write 或卡片面板写入。'
		const groups = new Map()
		for (const card of permanent) {
			const group = card.topic || card.tags[0]?.split('/')[0] || '未分类'
			if (!groups.has(group)) groups.set(group, [])
			groups.get(group).push(card)
		}
		const lines = ['[实践] 永久卡片路由（按标签分组）：']
		let bytes = Buffer.byteLength(lines[0], 'utf8') + 1
		let included = 0
		for (const [group, cards] of groups) {
			const header = `#${group} (${cards.length})`
			if (bytes + Buffer.byteLength(header, 'utf8') + 1 > budget) break
			lines.push(header)
			bytes += Buffer.byteLength(header, 'utf8') + 1
			for (const card of cards) {
				const line = `- ${oneLine(card.label || '(未命名)', 60)} — ${oneLine(card.summary || card.label, 80)} (${card.id})`
				const size = Buffer.byteLength(line, 'utf8') + 1
				if (bytes + size > budget) break
				lines.push(line)
				bytes += size
				included += 1
			}
		}
		const dropped = permanent.length - included
		if (dropped > 0) {
			const tail = `（另有 ${dropped} 条未展示，用 card_query 按标签或关键词查询）`
			if (bytes + Buffer.byteLength(tail, 'utf8') + 1 <= budget) lines.push(tail)
		}
		return lines.join('\n')
	}

	/**
	 * The tag forest with counts.
	 *
	 * @returns {Array<object>} Root nodes.
	 */
	tagTree() {
		return buildTagTree(this.all().filter((card) => card.status !== 'archived'))
	}

	/**
	 * Incoming links per card.
	 *
	 * @returns {Record<string, string[]>} Target id to source ids.
	 */
	backlinks() {
		const map = new Map()
		for (const card of this.all()) {
			for (const link of card.links ?? []) {
				if (!map.has(link)) map.set(link, [])
				map.get(link).push(card.id)
			}
		}
		return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)))
	}

	/**
	 * Promote a fleeting card to a permanent note.
	 *
	 * @param {string} id - Card id.
	 * @param {{summary?: string, tags?: string[], verified?: string}} [options] - Promotion fields.
	 * @returns {Promise<object>} The promoted card.
	 */
	async promote(id, { summary, tags, verified } = {}) {
		const card = this.get(id)
		if (card === undefined) throw new Error(`找不到卡片：${id}`)
		if (card.type === 'permanent') return card
		return this.put({
			...card,
			id,
			type: 'permanent',
			shape: 'note',
			status: 'verified',
			summary: summary ?? card.label,
			tags: tags ?? card.tags,
			verified: verified ?? new Date().toISOString().slice(0, 10),
		})
	}

	/**
	 * Archive one card.
	 *
	 * @param {string} id - Card id.
	 * @returns {Promise<object>} The archived card.
	 */
	async archive(id) {
		const card = this.get(id)
		if (card === undefined) throw new Error(`找不到卡片：${id}`)
		return this.put({ ...card, id, status: 'archived' })
	}

	/**
	 * Remove one card and its resources.
	 *
	 * @param {string} id - Card id.
	 * @returns {Promise<boolean>} Whether it existed.
	 */
	async remove(id) {
		const existed = await this.cards.deleteMemory(id)
		await this.resources.removeCard(id)
		return existed
	}
}
