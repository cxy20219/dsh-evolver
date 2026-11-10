/**
 * The card operations the agent's tools are made of.
 *
 * Classification is tag-only: `#践行`, `#见闻`, `#即兴`, `#复盘`, `#觉察`, `#试错`.
 * There is no type/shape/status/category field and no legacy wrapper.
 */

import { textOverlap } from '../memory/hybrid.js'
import { classifyNoise } from '../memory/noise.js'
import { findSecret } from '../secrets.js'
import { isCardId } from './ids.js'
import { cardPrompt } from './prompt.js'
import {
	descriptionOf,
	isArchived,
	isSettled,
	normalizeCardTags,
	normalizeTags,
} from './tags.js'

/** A fleeting card is one statement, not a document. */
const MAX_MEMORY_CHARS = 4000

/** Two fleeting cards this alike are the same note. */
const MERGE_THRESHOLD = 0.85

/** Map extracted memory kinds to semantic tags. */
const KIND_TAGS = {
	fact: '见闻/事实',
	preference: '觉察/偏好',
	convention: '践行/约定',
	correction: '复盘/纠正',
	failure: '复盘/踩坑',
	'tool-quirk': '见闻/工具怪癖',
}

/**
 * The card operations.
 *
 * @param {object} cards - The card store.
 * @returns {object} The operations.
 */
export function createCardAgent(cards) {
	/**
	 * Refuse a secret in any card body.
	 *
	 * @param {string} text - The text to inspect.
	 * @returns {void}
	 */
	function assertNoSecret(text) {
		const secret = findSecret(text)
		if (secret !== undefined) throw new Error(`正文里像是${secret}：卡片库不保存密钥，请删掉后重写。`)
	}

	/**
	 * Write or update one card.
	 *
	 * @param {object} input - The card fields.
	 * @returns {Promise<object>} The saved card.
	 */
	async function write(input = {}) {
		const body = String(input.body ?? '').trim()
		if (body === '') throw new Error('卡片正文不能为空。')
		assertNoSecret(body)
		const tags = normalizeCardTags(input.tags)
		const settled = isSettled(tags)
		if (!settled && classifyNoise(body).noise === true) {
			throw new Error('这段内容像流水账或噪声，没有保存；请写可复用的结论。')
		}
		const links = Array.isArray(input.links) ? [...new Set(input.links.map(String))] : []
		for (const link of links) {
			if (!isCardId(link)) throw new Error(`链接目标不是卡片 id：${link}`)
		}
		const resourceName = input.resourceName === undefined ? '' : String(input.resourceName)
		const resourceContent = input.resourceContent === undefined ? '' : String(input.resourceContent)
		if (resourceName !== '' && resourceContent === '') {
			throw new Error('提供 resourceName 时必须同时提供 resourceContent（附件的完整文件内容）。')
		}
		if (resourceName === '' && resourceContent !== '') {
			throw new Error('提供 resourceContent 时必须同时提供 resourceName。')
		}
		if (resourceContent !== '') assertNoSecret(resourceContent)
		return cards.put({
			...(typeof input.id === 'string' && input.id !== '' ? { id: input.id } : {}),
			body,
			tags,
			links,
			...(input.verified === undefined || input.verified === '' ? {} : { verified: String(input.verified) }),
		}, resourceName === '' ? {} : { resourceInputs: [{ name: resourceName, data: resourceContent }] })
	}

	/**
	 * Save one extracted memory as a fleeting card, merging near-duplicates.
	 *
	 * @param {{kind?: string, content: string, tags?: string[]}} input - The memory.
	 * @returns {Promise<{success: boolean, id?: string, message?: string}>} The result.
	 */
	async function saveFleeting({ kind = 'fact', content, tags } = {}) {
		const text = String(content ?? '').trim()
		if (text === '') return { success: false, message: 'content 不能为空。' }
		if ([...text].length > MAX_MEMORY_CHARS) return { success: false, message: `一条 #即兴 卡最多 ${MAX_MEMORY_CHARS} 字，写长请拆成多张。` }
		const noise = classifyNoise(text)
		if (noise.noise) return { success: false, message: `这条内容像噪声（${noise.category}），没有保存。` }
		const secret = findSecret(text)
		if (secret !== undefined) return { success: false, message: `这条内容包含${secret}，没有保存；密钥不要写进卡片。` }
		const semantic = KIND_TAGS[kind] ?? ''
		const cardTags = normalizeCardTags(['即兴', semantic, ...(Array.isArray(tags) ? tags : [])])
		const twin = cards.list({ tags: ['即兴'], limit: 200 }).find((card) => textOverlap(card.body, text) >= MERGE_THRESHOLD)
		if (twin !== undefined) {
			const saved = await cards.put({ ...twin, body: text, tags: cardTags })
			return { success: true, id: saved.id, message: '已更新 #即兴 卡。' }
		}
		const saved = await cards.put({
			body: text,
			tags: cardTags,
		})
		return { success: true, id: saved.id, message: '已保存 #即兴 卡。' }
	}

	/**
	 * Search cards by keyword and tags.
	 *
	 * @param {{text?: string, tags?: string[], limit?: number, includeArchived?: boolean}} [input] - The query.
	 * @returns {Promise<object[]>} The cards.
	 */
	function query({ text = '', tags = [], limit = 8, includeArchived = false } = {}) {
		return cards.query({
			text: String(text ?? ''),
			tags: normalizeTags(tags),
			limit: Number(limit) || 8,
			includeArchived: includeArchived === true,
		})
	}

	/**
	 * Read one card with its resources.
	 *
	 * @param {string} id - The card id.
	 * @returns {Promise<object>} The card and resources.
	 */
	async function read(id) {
		const card = await cards.read(String(id ?? ''))
		if (card === undefined) throw new Error(`卡片不存在：${String(id ?? '')}`)
		return card
	}

	/**
	 * Move an #即兴 card into one of the settled branches.
	 *
	 * @param {string} id - The card id.
	 * @param {{tags?: string[]}} [patch] - The target branch tags.
	 * @returns {Promise<object>} The settled card.
	 */
	async function promote(id, { tags } = {}) {
		const card = cards.get(String(id ?? ''))
		if (card === undefined) throw new Error(`卡片不存在：${String(id ?? '')}`)
		return cards.promote(card.id, Array.isArray(tags) ? { tags } : {})
	}

	/**
	 * Archive one card.
	 *
	 * @param {string} id - The card id.
	 * @returns {Promise<object>} The archived card.
	 */
	async function archive(id) {
		const card = cards.get(String(id ?? ''))
		if (card === undefined) throw new Error(`卡片不存在：${String(id ?? '')}`)
		return cards.archive(card.id)
	}

	/**
	 * Remove one card and its resources.
	 *
	 * @param {string} id - The card id.
	 * @returns {Promise<{removed: boolean}>} Whether a card was removed.
	 */
	async function remove(id) {
		return { removed: await cards.remove(String(id ?? '')) }
	}

	/**
	 * The injected tag map: tree plus documented branches.
	 *
	 * @returns {Promise<object>} The map.
	 */
	async function index() {
		const tree = cards.tagTree({ includeArchived: true })
		const descriptions = {}
		for (const node of flatten(tree)) {
			const description = descriptionOf(node.path)
			if (description !== '') descriptions[node.path] = description
		}
		return { injected: cardPrompt(cards), tree, descriptions }
	}

	/**
	 * A bounded review of the card store.
	 *
	 * @param {number} [now] - The clock, for stale checks.
	 * @returns {Promise<object>} Lifecycle counts, recent cards and hints.
	 */
	async function review(now = Date.now()) {
		const all = cards.all()
		const active = all.filter((card) => !isArchived(card.tags))
		const status = cards.status()
		const recent = active
			.slice()
			.sort((left, right) => String(right.updated).localeCompare(String(left.updated)))
			.slice(0, 5)
			.map((card) => ({ id: card.id, label: card.label, tags: card.tags, updated: card.updated }))
		const stale = active.filter((card) => {
			if (card.verified === '') return false
			const parsed = Date.parse(card.verified)
			return !Number.isFinite(parsed) || now - parsed > 180 * 86_400_000
		})
		const hints = []
		if (status.roots.即兴 > 0) hints.push(`有 ${status.roots.即兴} 张 #即兴 卡待整理：选定 #践行/#见闻/#复盘/#觉察/#试错 后用 card_promote。`)
		if (stale.length > 0) hints.push(`${stale.length} 张带 verified 的卡超过半年未复查。`)
		if (hints.length === 0) hints.push('卡片库是健康的；没有高信号时不用为了主动而主动。')
		return { status, recent, stale: stale.length, hints }
	}

	return { write, saveFleeting, query, read, promote, archive, remove, index, review }
}

/**
 * Flatten a tag forest.
 *
 * @param {object[]} nodes - Root nodes.
 * @returns {object[]} Every node.
 */
function flatten(nodes) {
	const result = []
	for (const node of nodes) {
		result.push(node)
		result.push(...flatten(node.children ?? []))
	}
	return result
}
