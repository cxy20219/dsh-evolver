/**
 * The card operations the agent's tools are made of.
 *
 * This is the only write path used by the tools and the idle ingest. It is
 * deliberately card-native: one record type, one id space, no legacy
 * practice/memory wrappers.
 */

import { textOverlap } from '../memory/hybrid.js'
import { classifyNoise } from '../memory/noise.js'
import { findSecret } from '../secrets.js'
import { isCardId } from './ids.js'
import { cardPrompt } from './prompt.js'
import { safeResourceName } from './resources.js'
import { labelOf } from './store.js'
import { normalizeTags } from './tags.js'

/** The shape a fleeting card always has. */
const FLEETING_SHAPE = 'memo'

/** Permanent cards may take one of these shapes. */
const PERMANENT_SHAPES = ['note', 'doc', 'tool', 'resource']

/** One fleeting card is a statement, not a document. */
const MAX_MEMORY_CHARS = 4000

/** Two fleeting cards this alike are the same note. */
const MERGE_THRESHOLD = 0.85

/**
 * Resolve the scope string a write asks for.
 *
 * @param {string | undefined} scope - The requested scope.
 * @param {string | undefined} projectKey - The project.
 * @returns {string} The scope string.
 */
function resolveScope(scope, projectKey) {
	if (typeof scope === 'string' && scope.includes(':')) return scope
	if (scope === 'failure') return 'failure'
	if (scope === 'project') return projectKey === undefined ? 'project' : `project:${projectKey}`
	if (scope === 'user') return 'user'
	return 'global'
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
		const type = input.type === 'permanent' ? 'permanent' : 'fleeting'
		const body = String(input.body ?? '').trim()
		if (body === '') throw new Error('卡片正文不能为空。')
		assertNoSecret(body)
		if (type === 'fleeting' && classifyNoise(body).noise === true) {
			throw new Error('这段内容像流水账或噪声，没有保存；请写可复用的结论。')
		}
		const shape = type === 'fleeting'
			? FLEETING_SHAPE
			: (PERMANENT_SHAPES.includes(input.shape) ? input.shape : 'note')
		const status = input.status === 'archived'
			? 'archived'
			: (type === 'permanent' ? 'verified' : 'inbox')
		const links = Array.isArray(input.links) ? [...new Set(input.links.map(String))] : []
		for (const link of links) {
			if (!isCardId(link)) throw new Error(`链接目标不是卡片 id：${link}`)
		}
		const category = typeof input.category === 'string' && input.category !== '' ? input.category : 'fact'
		const label = typeof input.label === 'string' && input.label !== '' ? input.label : labelOf(body)
		const summary = type === 'permanent' ? String(input.summary ?? label) : ''
		const document = type === 'permanent' && ['doc', 'tool', 'resource'].includes(shape)
		const resourceName = safeResourceName(input.resourceName)
			|| safeResourceName(`${label.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 48) || 'body'}.md`)
			|| 'body.md'
		return cards.put({
			...(typeof input.id === 'string' && input.id !== '' ? { id: input.id } : {}),
			type,
			shape,
			status,
			category,
			label,
			summary,
			body: document ? summary : body,
			topic: input.topic,
			tags: normalizeTags(input.tags),
			links,
			scope: resolveScope(input.scope, input.projectKey),
			verified: type === 'permanent' ? String(input.verified ?? new Date().toISOString().slice(0, 10)) : '',
			source: 'agent',
		}, document ? { resourceInputs: [{ name: resourceName, data: body }] } : {})
	}

	/**
	 * Save one extracted memory as a fleeting card, merging near-duplicates.
	 *
	 * @param {{kind?: string, content: string, scope?: string, projectKey?: string, tags?: string[]}} input - The memory.
	 * @returns {Promise<{success: boolean, id?: string, message?: string}>} The result.
	 */
	async function saveFleeting({ kind = 'fact', content, scope, projectKey, tags } = {}) {
		const text = String(content ?? '').trim()
		if (text === '') return { success: false, message: 'content 不能为空。' }
		if ([...text].length > MAX_MEMORY_CHARS) return { success: false, message: `一条临时卡最多 ${MAX_MEMORY_CHARS} 字，写长请拆成多张或用永久卡。` }
		const noise = classifyNoise(text)
		if (noise.noise) return { success: false, message: `这条内容像噪声（${noise.category}），没有保存。` }
		const secret = findSecret(text)
		if (secret !== undefined) return { success: false, message: `这条内容包含${secret}，没有保存；密钥不要写进卡片。` }
		const entryScope = resolveScope(scope, projectKey)
		const twin = cards.list({ type: 'fleeting', limit: 200 }).find((card) =>
			card.category === kind
			&& card.scope === entryScope
			&& textOverlap(card.body, text) >= MERGE_THRESHOLD)
		if (twin !== undefined) {
			const saved = await cards.put({ ...twin, body: text, label: labelOf(text), tags: normalizeTags(tags) })
			return { success: true, id: saved.id, message: '已更新临时卡。' }
		}
		const saved = await cards.put({
			type: 'fleeting',
			shape: FLEETING_SHAPE,
			status: 'inbox',
			category: kind,
			body: text,
			scope: entryScope,
			tags: normalizeTags(tags),
			source: 'ingest',
		})
		return { success: true, id: saved.id, message: '已保存临时卡。' }
	}

	/**
	 * Query cards, including archived ones only when explicitly asked.
	 *
	 * @param {{text?: string, type?: string, status?: string, tags?: string[], limit?: number}} [input] - The filter.
	 * @returns {Promise<object[]>} The cards.
	 */
	function query({ text = '', type, status, tags = [], limit = 8 } = {}) {
		const queryText = String(text ?? '').trim()
		const options = {
			type: typeof type === 'string' && type !== '' ? type : undefined,
			status: typeof status === 'string' && status !== '' ? status : undefined,
			tags: normalizeTags(tags),
			limit: Number(limit) || 8,
		}
		return queryText === '' ? Promise.resolve(cards.list(options)) : cards.query({ ...options, text: queryText })
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
	 * Promote a fleeting card.
	 *
	 * @param {string} id - The card id.
	 * @param {{summary?: string, tags?: string[]}} [patch] - The optional summary and tags.
	 * @returns {Promise<object>} The permanent card.
	 */
	async function promote(id, { summary, tags } = {}) {
		const card = cards.get(String(id ?? ''))
		if (card === undefined) throw new Error(`卡片不存在：${String(id ?? '')}`)
		return cards.promote(card.id, {
			...(typeof summary === 'string' && summary !== '' ? { summary } : {}),
			...(Array.isArray(tags) ? { tags: normalizeTags(tags) } : {}),
		})
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
	 * The permanent-card index.
	 *
	 * @returns {Promise<object>} Entries and the injected projection.
	 */
	async function index() {
		const entries = cards.list({ type: 'permanent', includeArchived: true, limit: 500 })
		return {
			total: entries.length,
			injected: cardPrompt(cards),
			entries: entries.map((card) => ({
				id: card.id,
				label: card.label,
				summary: card.summary,
				shape: card.shape,
				topic: card.topic,
				tags: card.tags,
				verified: card.verified,
				status: card.status,
			})),
		}
	}

	/**
	 * A bounded review of the card store.
	 *
	 * @param {number} [now] - The clock, for stale checks.
	 * @returns {Promise<object>} Counts, recent cards and hints.
	 */
	async function review(now = Date.now()) {
		const all = cards.all()
		const permanent = all.filter((card) => card.type === 'permanent' && card.status !== 'archived')
		const fleeting = all.filter((card) => card.type === 'fleeting' && card.status !== 'archived')
		const recent = fleeting
			.slice()
			.sort((left, right) => String(right.updated).localeCompare(String(left.updated)))
			.slice(0, 5)
			.map((card) => ({ id: card.id, label: card.label, category: card.category, updated: card.updated }))
		const stale = permanent.filter((card) => {
			const parsed = Date.parse(card.verified)
			return !Number.isFinite(parsed) || now - parsed > 180 * 86_400_000
		})
		const hints = []
		if (permanent.length === 0) hints.push('还没有永久卡；把验证过的结论用 card_write 写成 type=permanent。')
		if (fleeting.length > 0) hints.push(`有 ${fleeting.length} 张临时卡待判断：可提升的用 card_promote，过期的用 card_remove。`)
		if (stale.length > 0) hints.push(`${stale.length} 张永久卡超过半年未验证，优先复查最近用到的。`)
		if (hints.length === 0) hints.push('卡片库是健康的；没有高信号时不用为了主动而主动。')
		return {
			status: cards.status(),
			permanent: permanent.length,
			fleeting: fleeting.length,
			recent,
			stale: stale.length,
			hints,
		}
	}

	return { write, saveFleeting, query, read, promote, archive, remove, index, review }
}
