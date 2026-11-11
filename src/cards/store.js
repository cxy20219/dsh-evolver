/**
 * The unified card store.
 *
 * A card is one append-only log record plus optional resource files. Its
 * classification lives entirely in hierarchical tags:
 *
 *   #践行 / #见闻 / #即兴 / #复盘 / #觉察 / #试错
 *
 * There is no separate type/shape/status/category field. The search engine
 * (BM25) and the tag tree are the retrieval surface;
 * the prompt injects only the tag tree, never card bodies.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MemoryStore } from '../memory/store.js'
import { hybridRetrieve } from '../memory/hybrid.js'
import { cardCreatedAt, cardId, isCardId } from './ids.js'
import { ResourceStore, resourceRelativePath, safeResourceName } from './resources.js'
import {
	archiveTags,
	buildTagTree,
	descriptionOf,
	isArchived,
	isUnder,
	normalizeCardTags,
	normalizeTags,
	rootOf,
	settleTags,
	TAG_DESCRIPTIONS,
	TOP_TAGS,
} from './tags.js'

/** The default body budget, in Unicode code points. */
export const DEFAULT_CARD_MAX_CHARS = 1000

/**
 * Derive a card label from its body.
 *
 * @param {unknown} body - The body text.
 * @returns {string} A single-line label.
 */
export function labelOf(body) {
	const line = String(body ?? '').split('\n').map((part) => part.trim()).find((part) => part !== '') ?? ''
	const clean = line.replace(/^#{1,6}\s+/, '').replace(/^[-*+>]\s+/, '')
	const link = clean.match(/^\[([^\]]+)\]\([^)]*\)/)
	if (link !== null) return link[1].replace(/\s+/g, ' ').trim().slice(0, 80)
	return clean.replace(/\s+/g, ' ').trim().slice(0, 80)
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
 * One line, scrubbed for storage.
 *
 * @param {unknown} value - The text.
 * @param {number} max - Maximum code points.
 * @returns {string} The sanitised line.
 */
function oneLine(value, max) {
	return [...String(value ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('')
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
	constructor({ dataDir, logger, cardMaxChars = DEFAULT_CARD_MAX_CHARS }) {
		this.dataDir = dataDir
		this.logger = logger
		this.cardMaxChars = Math.max(1, Math.min(4000, Math.round(Number(cardMaxChars) || DEFAULT_CARD_MAX_CHARS)))
		this.cards = new MemoryStore({
			dataDir,
			folder: 'knowledge/cards',
			logName: 'cards.jsonl',
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
				map[tag] = description.trim()
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
			const segments = tag.split('/')
			if (!TOP_TAGS.includes(segments[0])) {
				throw new Error(`标签 ${tag} 不在六大枝干里。`)
			}
			if (segments.some((segment) => segment === '')) throw new Error(`标签 ${tag} 路径不合法。`)
			map[tag] = clean
		}
		await mkdir(join(this.dataDir, 'knowledge'), { recursive: true, mode: 0o700 })
		await writeFile(this.tagDescriptionsPath(), `${JSON.stringify(map, null, '\t')}\n`, { mode: 0o600 })
		return map
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
	 * @returns {Promise<{lastRunAt: string, dayKey: string, cards: Record<string, string>, attempts: {day: string, count: number}}>} The ledger.
	 */
	async consolidationLedger() {
		const empty = { lastRunAt: '', dayKey: '', cards: {}, attempts: { day: '', count: 0 } }
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
		return {
			lastRunAt: typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : '',
			dayKey: typeof parsed.dayKey === 'string' ? parsed.dayKey : '',
			cards,
			attempts,
		}
	}

	/**
	 * Persist the review ledger.
	 *
	 * @param {object} ledger - The ledger to write.
	 * @returns {Promise<void>} Resolves when written.
	 */
	async saveConsolidationLedger(ledger) {
		await mkdir(join(this.dataDir, 'knowledge'), { recursive: true, mode: 0o700 })
		await writeFile(this.consolidationPath(), `${JSON.stringify(ledger, null, '\t')}\n`, { mode: 0o600 })
	}

	/**
	 * The description of one branch.
	 *
	 * @param {string} tag - The tag path.
	 * @param {Record<string, string>} descriptions - The effective map.
	 * @returns {string} The description, or an empty string.
	 */
	tagDescription(tag, descriptions) {
		return descriptionOf(tag, descriptions)
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
			label: labelOf(record.body),
			body: record.body ?? '',
			tags: record.tags ?? [],
			links: record.links ?? [],
			created: cardCreatedAt(record.id),
			updated: record.updated ?? '',
		}
	}

	/**
	 * Every card.
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
		let body = String(input.body ?? previous?.body ?? '')
		const tags = normalizeCardTags(input.tags ?? previous?.tags ?? [])
		const now = new Date().toISOString()
		const links = Array.isArray(input.links) ? [...new Set(input.links.map(String))] : (previous?.links ?? [])
		for (const link of links) {
			if (!isCardId(link)) throw new Error(`链接目标不是卡片 id：${link}`)
		}
		const resourceNames = new Set((await this.resources.list(id)).map((item) => item.name))
		const inputNames = []
		for (const resource of resourceInputs) {
			const name = safeResourceName(resource.name)
			if (name === '') throw new Error(`资源文件名不合法：${String(resource.name)}`)
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
		}
		const record = {
			id,
			body,
			tags,
			...(links.length > 0 ? { links } : {}),
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
		const metadata = await this.resources.put(id, name, data)
		const relativePath = resourceRelativePath(id, metadata.name)
		const body = hasResourceReference(card.body, relativePath)
			? card.body
			: `${card.body.trim()}\n\n[${metadata.name}](${relativePath})：用途：附件资源；入口：按文件说明；输入、输出和关联流程：待补充。`.trim()
		await this.put({ ...card, id, body })
		return this.read(id)
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
		return { ...card, resources: listed, resourceContents: contents }
	}

	/**
	 * Filter cards without a text query.
	 *
	 * @param {{tags?: string[], anyTags?: string[], limit?: number, includeArchived?: boolean}} [options] - Filters.
	 * @returns {object[]} The cards.
	 */
	list({ tags = [], anyTags = [], limit = 50, includeArchived = false, archivedOnly = false } = {}) {
		const filters = normalizeTags(tags)
		const any = normalizeTags(anyTags)
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
			return true
		})
		cards.sort((left, right) => String(right.updated).localeCompare(String(left.updated)))
		return cards.slice(0, Math.max(1, Math.min(200, Math.round(Number(limit) || 50))))
	}

	/**
	 * Search cards with the memory layer's hybrid retrieval.
	 *
	 * @param {{text?: string, tags?: string[], anyTags?: string[], limit?: number, includeArchived?: boolean}} [request] - The query.
	 * @returns {Promise<object[]>} Matching cards.
	 */
	async query({ text = '', tags = [], anyTags = [], limit = 8, includeArchived = false, archivedOnly = false } = {}) {
		const filters = normalizeTags(tags)
		const any = normalizeTags(anyTags)
		const archivedFilter = filters.some((tag) => tag.split('/').pop() === '归档')
		const keep = (card) => {
			if (archivedOnly && !isArchived(card.tags)) return false
			if (!includeArchived && !archivedFilter && !archivedOnly && isArchived(card.tags)) return false
			if (filters.length > 0 && !filters.every((filter) => (card.tags ?? []).some((tag) => isUnder(tag, filter)))) return false
			if (any.length > 0 && !any.some((filter) => (card.tags ?? []).some((tag) => isUnder(tag, filter)))) return false
			return true
		}
		const queryText = String(text ?? '').trim()
		const size = Math.max(1, Math.min(50, Math.round(Number(limit) || 8)))
		if (queryText === '') return this.list({ tags, anyTags, limit: size, includeArchived, archivedOnly })
		const results = await hybridRetrieve({
			db: this.cards.db,
			query: queryText,
			limit: Math.max(size * 4, 20),
		})
		return results
			.map((result) => this.cardOf(result.memory))
			.filter(keep)
			.slice(0, size)
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
	 * Move a card out of #即兴 into one or more settled branches.
	 *
	 * @param {string} id - Card id.
	 * @param {{tags?: string[]}} [options] - Promotion fields.
	 * @returns {Promise<object>} The promoted card.
	 */
	async promote(id, { tags } = {}) {
		const card = this.get(id)
		if (card === undefined) throw new Error(`找不到卡片：${id}`)
		return this.put({
			...card,
			id,
			tags: settleTags(card.tags, Array.isArray(tags) ? tags : []),
		})
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
		return this.put({ ...card, id, tags: archiveTags(card.tags) })
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
