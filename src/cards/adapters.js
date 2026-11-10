/**
 * Compatibility adapters: the agent's practice/memory tools over cards.
 *
 * The tools and the injected prompt keep their familiar names while the
 * underlying store is the unified card log. Practice calls become permanent
 * card operations; memory calls become fleeting card operations. Long
 * practice bodies are stored as resources and `practice_read` returns the
 * primary resource text, so existing muscle memory still works.
 */

import { classifyNoise } from '../memory/noise.js'
import { textSimilarity } from '../importance.js'
import { findSecret } from '../secrets.js'
import { cardPrompt } from './prompt.js'
import { normalizeTags } from './tags.js'
import { safeResourceName } from './resources.js'

/** Practice kinds and their shapes. */
const PRACTICE_SHAPES = ['doc', 'tool', 'resource']

/** One memory is a statement, not a document. */
const MAX_MEMORY_CHARS = 4000

/** Two memories this alike say the same thing. */
const MERGE_THRESHOLD = 0.85

/**
 * The practice-compatible view of one card.
 *
 * @param {object} card - The card.
 * @returns {object} The old practice entry shape.
 */
function asPractice(card) {
	return {
		kind: card.shape,
		kindTitle: card.shape,
		topic: card.topic || '',
		name: card.slug || card.id,
		slug: card.slug || card.id,
		relPath: card.id,
		absPath: '',
		title: card.label,
		purpose: card.summary || card.label,
		verified: card.verified,
		links: card.links,
		tags: card.tags,
		bytes: Buffer.byteLength(card.body, 'utf8'),
		updatedAt: card.updated,
		bodyPreview: card.body.slice(0, 400),
	}
}

/**
 * Strip the resource text out of a card read.
 *
 * @param {object} card - The card with resourceContents.
 * @returns {string} The text the old `practice_read` returned as content.
 */
function primaryContent(card) {
	const primary = (card.resourceContents ?? []).find((item) => typeof item.text === 'string')
	return primary?.text ?? card.body
}

/**
 * Resolve one card from a tool reference.
 *
 * @param {object} cards - The card store.
 * @param {unknown} ref - Id, slug or legacy path.
 * @returns {object | undefined} The card.
 */
function resolve(cards, ref) {
	return cards.resolve(ref)
}

/**
 * The practice tools over cards.
 *
 * @param {object} cards - The card store.
 * @returns {object} The adapter.
 */
export function createPracticeAdapter(cards) {
	return {
		/**
		 * The practice snapshot used by practice_index.
		 *
		 * @returns {Promise<object>} Entries, problems and the projection.
		 */
		async practice() {
			const entries = cards.list({ type: 'permanent', includeArchived: true, limit: 200 }).map(asPractice)
			return {
				entries,
				problems: [],
				projection: { text: cardPrompt(cards), dropped: [] },
			}
		},

		/**
		 * Search permanent cards.
		 *
		 * @param {string} query - The query.
		 * @param {{kind?: string, limit?: number}} [options] - Filters.
		 * @returns {Promise<object[]>} Matches.
		 */
		async practiceSearch(query, { kind = '', limit = 8 } = {}) {
			const cardsFound = await cards.query({ text: query, type: 'permanent', limit: Math.max(limit * 2, 10) })
			return cardsFound
				.filter((card) => kind === '' || card.shape === kind)
				.slice(0, Math.max(1, Math.min(50, Math.round(Number(limit) || 8))))
				.map((card) => ({
					kind: card.shape,
					title: card.label,
					path: card.id,
					purpose: card.summary || card.label,
					snippet: card.body.slice(0, 200),
				}))
		},

		/**
		 * Read one permanent card in the old entry shape.
		 *
		 * @param {string} ref - Id, slug or legacy path.
		 * @returns {Promise<object>} The entry.
		 */
		async practiceRead(ref) {
			const card = resolve(cards, ref)
			if (card === undefined || card.type !== 'permanent') throw new Error(`条目不存在：${String(ref)}`)
			const read = await cards.read(card.id)
			return {
				path: card.id,
				title: card.label,
				purpose: card.summary || card.label,
				kind: card.shape,
				topic: card.topic,
				verified: card.verified,
				links: card.links,
				tags: card.tags,
				content: primaryContent(read ?? card),
				resources: (read?.resourceContents ?? []).map((item) => ({ name: item.name, bytes: item.bytes, binary: item.binary === true })),
			}
		},

		/**
		 * Write a permanent card from the practice tool's fields.
		 *
		 * @param {object} input - The tool input.
		 * @returns {Promise<object>} The old write result.
		 */
		async practiceWrite(input = {}) {
			if (!PRACTICE_SHAPES.includes(input.kind)) throw new Error(`未知类型：${String(input.kind)}`)
			const title = String(input.title ?? '').trim()
			const purpose = String(input.purpose ?? '').trim()
			const name = String(input.name ?? '').trim()
			if (title === '') throw new Error('标题不能为空。')
			if (purpose === '') throw new Error('用途不能为空。')
			if (name === '') throw new Error('文件名不能为空。')
			const body = String(input.body ?? '').replace(/^\n+/, '')
			const secret = findSecret(`${title}\n${purpose}\n${body}`)
			if (secret !== undefined) throw new Error(`正文里像是${secret}：实践层不保存密钥，请删掉后重写。`)
			const topicSlug = input.topic === undefined ? '' : slugify(String(input.topic))
			const sourceId = `practice:${input.kind === 'doc' ? 'docs' : `${input.kind}s`}/${topicSlug === '' ? '' : `${topicSlug}/`}${name}`
			const existing = cards.all().find((card) => card.sourceId === sourceId)
			const links = []
			const problems = []
			for (const link of Array.isArray(input.links) ? input.links : []) {
				const target = resolve(cards, String(link))
				if (target === undefined) {
					problems.push({ level: 'warning', code: 'entry/broken-link', path: existing?.id ?? '', message: `链接 ${link} 找不到对应条目。` })
				} else if (target.id !== existing?.id) {
					links.push(target.id)
				}
			}
			const resourceName = safeResourceName(name) || safeResourceName(`${slugify(title)}.md`) || 'body.md'
			const card = {
				id: existing?.id,
				slug: name.replace(/\.[^.]+$/, ''),
				type: 'permanent',
				shape: input.kind,
				status: 'verified',
				category: '',
				label: title,
				summary: purpose,
				// The card body is the purpose; the full document is the resource.
				body: purpose,
				topic: input.topic === undefined ? '' : String(input.topic),
				tags: normalizeTags([input.topic, ...(Array.isArray(input.tags) ? input.tags : [])]),
				links: [...new Set([...(existing?.links ?? []), ...links])],
				verified: String(input.verified ?? new Date().toISOString().slice(0, 10)),
				source: existing?.source ?? 'agent',
				sourceId,
			}
			const saved = await cards.put(card, { resourceInputs: body === '' ? [] : [{ name: resourceName, data: body }] })
			return {
				path: saved.id,
				title,
				purpose,
				kind: input.kind,
				topic: card.topic,
				bytes: Buffer.byteLength(body, 'utf8'),
				entries: cards.list({ type: 'permanent', includeArchived: true, limit: 200 }).length,
				problems,
				injectedBytes: Buffer.byteLength(cardPrompt(cards), 'utf8'),
				dropped: 0,
			}
		},

		/**
		 * Promote one fleeting card to a permanent card.
		 *
		 * @param {string} id - The card id.
		 * @param {{summary?: string, tags?: string[]}} [patch] - Optional summary and tags.
		 * @returns {Promise<object>} The permanent card.
		 */
		async promote(id, { summary, tags } = {}) {
			const card = cards.get(String(id))
			if (card === undefined) throw new Error(`卡片不存在：${String(id)}`)
			return cards.promote(card.id, {
				...(typeof summary === 'string' && summary !== '' ? { summary } : {}),
				...(Array.isArray(tags) ? { tags } : {}),
			})
		},

		/**
		 * A compact practice overview for evolve_review.
		 *
		 * @returns {Promise<object>} The overview.
		 */
		async overview() {
			const entries = cards.list({ type: 'permanent', includeArchived: true, limit: 200 })
			const injected = cardPrompt(cards)
			return {
				practice: {
					entries: entries.length,
					bytes: entries.reduce((sum, card) => sum + Buffer.byteLength(card.body, 'utf8'), 0),
					byKind: PRACTICE_SHAPES.map((shape) => ({ id: shape, title: shape, count: entries.filter((card) => card.shape === shape).length, bytes: 0 })),
					problems: [],
					injectedBytes: Buffer.byteLength(injected, 'utf8'),
					injectedBudget: 2048,
					dropped: 0,
				},
				suggestions: [],
			}
		},
	}
}

/**
 * Resolve the scope string a save asks for.
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
 * The memory tools over cards.
 *
 * @param {object} cards - The card store.
 * @returns {object} The adapter.
 */
export function createMemoryAdapter(cards) {
	/**
	 * Map one card to the memory result shape.
	 *
	 * @param {object} card - The card.
	 * @param {number} [score] - Optional score.
	 * @returns {object} The memory view.
	 */
	function asMemory(card, score) {
		return {
			id: card.id,
			text: card.body,
			kind: card.category || 'fact',
			scope: card.scope,
			tier: card.tier,
			...(score === undefined ? {} : { score }),
		}
	}

	return {
		async save({ kind = 'fact', content, scope, tags, projectKey, replaceOf } = {}) {
			const text = String(content ?? '').trim()
			if (text === '') return { success: false, message: 'content 不能为空。' }
			if ([...text].length > MAX_MEMORY_CHARS) return { success: false, message: `一条记忆最多 ${MAX_MEMORY_CHARS} 字，写长请拆成多条或用 practice_write。` }
			const noise = classifyNoise(text)
			if (noise.noise) return { success: false, message: `这条内容像噪声（${noise.category}），没有保存。` }
			const secret = findSecret(text)
			if (secret !== undefined) return { success: false, message: `这条内容包含${secret}，没有保存；密钥不要写进记忆。` }
			const entryScope = resolveScope(scope, projectKey)
			const category = typeof kind === 'string' ? kind : 'fact'
			if (replaceOf !== undefined && replaceOf !== null && replaceOf !== '') {
				const existing = cards.get(String(replaceOf))
				if (existing === undefined) return { success: false, message: `找不到要替换的记忆：${replaceOf}` }
				await cards.put({ ...existing, body: text, scope: entryScope, category, tags: normalizeTags(tags) })
				return { success: true, id: existing.id, kind: category, scope: entryScope, message: '已更新记忆。' }
			}
			const twin = cards.list({ type: 'fleeting', includeArchived: false, limit: 200 }).find((card) =>
				card.category === category
				&& card.scope === entryScope
				&& textSimilarity(card.body, text) >= MERGE_THRESHOLD)
			if (twin !== undefined) {
				await cards.put({ ...twin, body: text, tags: normalizeTags(tags), updated: new Date().toISOString() })
				return { success: true, id: twin.id, kind: category, scope: entryScope, message: '已保存记忆。' }
			}
			const saved = await cards.put({
				type: 'fleeting',
				shape: 'memo',
				status: 'inbox',
				category,
				body: text,
				scope: entryScope,
				tags: normalizeTags(tags),
				source: 'explicit',
			})
			return { success: true, id: saved.id, kind: category, scope: entryScope, message: '已保存记忆。' }
		},

		async recall({ query, kinds, scopes, projectKey, limit } = {}) {
			const found = await cards.query({ text: String(query ?? ''), type: 'fleeting', limit: Math.max((Number(limit) || 8) * 3, 20) })
			const filtered = found.filter((card) => {
				if (Array.isArray(kinds) && kinds.length > 0 && !kinds.includes(card.category)) return false
				if (Array.isArray(scopes) && scopes.length > 0) {
					const own = String(card.scope ?? 'global')
					const base = own.includes(':') ? own.slice(0, own.indexOf(':')) : own
					if (!scopes.includes(base) && !scopes.includes(own)) return false
				}
				if (projectKey !== undefined && card.scope.startsWith('project:') && card.scope !== `project:${projectKey}`) return false
				return true
			})
			const results = filtered.slice(0, Math.max(1, Math.min(40, Math.round(Number(limit) || 8))))
			return { success: true, total: results.length, results: results.map((card, index) => asMemory(card, Number((1 - index * 0.01).toFixed(2)))) }
		},

		list({ kind, scope, limit } = {}) {
			const found = cards.list({ type: 'fleeting', limit: Math.max((Number(limit) || 20) * 3, 60) })
				.filter((card) => kind === undefined || card.category === kind)
				.filter((card) => scope === undefined || card.scope === scope || String(card.scope).startsWith(`${scope}:`))
			const results = found.slice(0, Math.max(1, Math.min(200, Math.round(Number(limit) || 20))))
			return { success: true, total: found.length, results: results.map((card) => asMemory(card)) }
		},

		async forget({ id } = {}) {
			if (!id) return { success: false, message: '缺少 id。' }
			const card = cards.get(String(id))
			if (card === undefined) return { success: false, id, message: '找不到这条记忆。' }
			await cards.remove(card.id)
			return { success: true, id, message: '已删除。' }
		},

		stats() {
			const found = cards.list({ type: 'fleeting', limit: 200 })
			const entriesByKind = {}
			const entriesByScope = {}
			for (const card of found) {
				entriesByKind[card.category] = (entriesByKind[card.category] ?? 0) + 1
				const scope = String(card.scope ?? 'global')
				const base = scope.includes(':') ? scope.slice(0, scope.indexOf(':')) : scope
				entriesByScope[base] = (entriesByScope[base] ?? 0) + 1
			}
			return { success: true, entries: found.length, entriesByKind, entriesByScope }
		},
	}
}

/**
 * Turn a topic title into the old practice directory slug.
 *
 * Kept here so compatibility writes keep matching migrated `sourceId`s
 * without pulling in the document layer.
 *
 * @param {string} value - The topic title.
 * @returns {string} The slug, or the original when it is already usable.
 */
function slugify(value) {
	const trimmed = String(value ?? '').trim()
	if (trimmed === '') return ''
	if (/^[a-z0-9][a-z0-9._-]*$/.test(trimmed)) return trimmed
	if (/[^\x00-\x7F]/.test(trimmed)) {
		return trimmed
			.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-')
			.replace(/^\.+/, '')
			.slice(0, 64)
			.replace(/[. ]+$/, '')
	}
	return trimmed
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

