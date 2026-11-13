/**
 * The card operations the agent's tools are made of.
 *
 * Classification is tag-only: `#践行`, `#见闻`, `#即兴`, `#复盘`, `#觉察`, `#试错`.
 * There is no type/shape/status/category field and no legacy wrapper.
 */

import { textOverlap } from '../memory/hybrid.js'
import { classifyNoise } from '../memory/noise.js'
import { findSecret } from '../secrets.js'
import { createAccessLog } from './access.js'
import { cardIndexText } from './prompt.js'
import { flattenTagTree, renderTagBranch, renderTagIndex, resolveTag } from './tag-index.js'
import { assertRealDescription, clipDescription } from './store.js'
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

/** The longest verbatim quote a card may carry (same cap as the store). */
const MAX_QUOTE_CHARS = 160

/** How many linked cards `card_read` returns per direction. */
const MAX_NEIGHBORS = 10

/** How many hubs the review names. */
const MAX_HUBS = 5

/**
 * The card operations.
 *
 * @param {object} cards - The card store.
 * @returns {object} The operations.
 */
export function createCardAgent(cards) {
	// Reads are the only evidence of which cards are actually useful; the log
	// lives beside the store so it travels with the data folder.
	const access = createAccessLog({ dataDir: cards?.dataDir })

	/**
	 * Resolve an id or an unambiguous abbreviation to the full card id.
	 *
	 * The injected index shows suffixes, so every tool that takes an id accepts
	 * one: a model that copied what it saw should not need a lookup round-trip.
	 *
	 * @param {unknown} token - The id the caller sent.
	 * @returns {string} The full id.
	 */
	function resolve(token) {
		const id = cards.resolveId(token)
		if (id === undefined) throw new Error(`卡片不存在：${String(token ?? '')}`)
		return id
	}

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
		// A card is an id plus a description; nothing may write one without it.
		const description = assertRealDescription(input.description, cards.descriptionMaxChars)
		if (body === '') throw new Error('卡片正文不能为空。')
		assertNoSecret(body)
		const tags = normalizeCardTags(input.tags)
		const settled = isSettled(tags)
		if (!settled && classifyNoise(body).noise === true) {
			throw new Error('这段内容像流水账或噪声，没有保存；请写可复用的结论。')
		}
		// Links may arrive as the abbreviations the injected index shows; store
		// the full id so the graph and the backlink map stay unambiguous.
		const links = Array.isArray(input.links) ? [...new Set(input.links.map(String))] : []
		const resolvedLinks = []
		const warnings = []
		for (const link of links) {
			const target = cards.resolveId(link)
			// A stale link is a smaller loss than the card: keep the knowledge,
			// drop the edge, and say so in the result instead of failing the write.
			if (target === undefined) {
				warnings.push(`链接目标不存在，已跳过：${link}`)
				continue
			}
			resolvedLinks.push(target)
		}
		const quote = typeof input.quote === 'string' ? input.quote.trim() : ''
		if (quote !== '') {
			if ([...quote].length > MAX_QUOTE_CHARS) throw new Error(`quote 最多 ${MAX_QUOTE_CHARS} 字：它是一句原文，不是摘要。`)
			const leaked = findSecret(quote)
			if (leaked !== undefined) throw new Error(`quote 里像是${leaked}：出处不保存密钥。`)
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
		const updated = typeof input.id === 'string' && input.id !== ''
		const beforeNames = updated
			? new Set((await cards.attachments(resolve(input.id))).map((item) => item.name))
			: new Set()
		const saved = await cards.put({
			...(updated ? { id: resolve(input.id) } : {}),
			body,
			...(description === '' ? {} : { description }),
			tags,
			links: resolvedLinks,
			...(quote === '' ? {} : { source: { quote } }),
		}, {
			...(resourceName === '' ? {} : { resourceInputs: [{ name: resourceName, data: resourceContent }] }),
			// An update that regenerates an attachment in place may replace the
			// exact same file name; the store keeps the old bytes in the trash.
			...(updated ? { replaceResources: true } : {}),
		})
		if (updated) {
			const afterNames = new Set((await cards.attachments(saved.id)).map((item) => item.name))
			for (const name of beforeNames) {
				if (!afterNames.has(name)) warnings.push(`正文不再引用旧附件，已移入回收站：${name}`)
			}
		}
		return warnings.length === 0 ? saved : { ...saved, warnings }
	}

	/**
	 * Save one extracted memory as a fleeting card, merging near-duplicates.
	 *
	 * @param {{kind?: string, content: string, tags?: string[]}} input - The memory.
	 * @returns {Promise<{success: boolean, id?: string, message?: string}>} The result.
	 */
	async function saveFleeting({ kind = 'fact', content, tags, source } = {}) {
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
			// The description describes the body; a merge replaces the body, so
			// the index entry is regenerated instead of keeping the old one.
			const saved = await cards.put({
				...twin,
				body: text,
				description: clipDescription(text, cards.descriptionMaxChars),
				tags: cardTags,
				...(source === undefined ? {} : { source }),
			})
			return { success: true, id: saved.id, message: '已更新 #即兴 卡。' }
		}
		// Ingested memories are one sentence already: the same sentence, cut to
		// the description budget, is the index entry for the card.
		const saved = await cards.put({
			body: text,
			description: clipDescription(text, cards.descriptionMaxChars),
			tags: cardTags,
			...(source === undefined ? {} : { source }),
		})
		return { success: true, id: saved.id, message: '已保存 #即兴 卡。' }
	}

	/**
	 * Search cards by keyword and tags.
	 *
	 * Every hit carries its degree (`in`/`out` link counts) so the model can
	 * tell a hub from a leaf before deciding what to open.
	 *
	 * With `graph` — or a non-empty `within` — the answer becomes the relation
	 * view instead: the lexical hits, the neighbours the link walk reached and
	 * the subgraph joining them. `within` also scopes the search to a set of
	 * card ids, which is how a second pass digs into a subgraph the caller has
	 * already seen instead of searching the whole library again.
	 *
	 * @param {{text?: string, tags?: string[], limit?: number, includeArchived?: boolean, graph?: boolean, hops?: number, within?: string[]}} [input] - The query.
	 * @returns {Promise<object[] | {cards: object[], related: object[], graph: {nodes: object[], edges: Array<{from: string, to: string}>}}>} The cards in flat mode, the relation view in graph mode.
	 */
	async function query({ text = '', tags = [], limit = 8, includeArchived = false, graph = false, hops = 1, within = [] } = {}) {
		const scope = Array.isArray(within) ? within : []
		if (graph === true || scope.some((id) => String(id ?? '').trim() !== '')) {
			const result = await cards.queryGraph({
				text: String(text ?? ''),
				tags: normalizeTags(tags),
				limit: Number(limit) || 8,
				includeArchived: includeArchived === true,
				hops,
				// Second-search scopes come from what the model was shown, which
				// is the short form; resolve before handing them to the store.
				within: scope.filter((token) => String(token ?? '').trim() !== '').map((token) => resolve(token)),
			})
			// A neighbour the model was shown counts as read for the same reason
			// a hit does: the ledger is evidence of what the library surfaced,
			// and related cards are part of the answer.
			await access.recordAccess([...result.cards, ...result.related].map((card) => card.id))
			return result
		}
		const results = await cards.query({
			text: String(text ?? ''),
			tags: normalizeTags(tags),
			limit: Number(limit) || 8,
			includeArchived: includeArchived === true,
		})
		await access.recordAccess(results.map((card) => card.id))
		const backlinks = cards.backlinks()
		// Attachment names ride along with the hit: without them the model has
		// to `card_read` a card just to learn it carries a script.
		const attachments = new Map()
		for (const card of results) attachments.set(card.id, await cards.attachments(card.id))
		return results.map((card) => {
			const files = attachments.get(card.id) ?? []
			return {
				...card,
				degree: {
					in: (backlinks[card.id] ?? []).length,
					out: (card.links ?? []).length,
				},
				...(files.length === 0 ? {} : { resources: files.map((file) => ({ name: file.name, executable: file.executable })) }),
			}
		})
	}

	/**
	 * Read one card with its resources.
	 *
	 * With `neighbors` the result also carries the cards this one points at and
	 * the cards pointing back, so following a link is one call instead of a
	 * scan of the whole library.
	 *
	 * @param {string} id - The card id.
	 * @param {{neighbors?: boolean}} [options] - Ask for the link neighbourhood.
	 * @returns {Promise<object>} The card, its resources and optional neighbors.
	 */
	async function read(id, { neighbors = false } = {}) {
		const card = await cards.read(resolve(id))
		if (card === undefined) throw new Error(`卡片不存在：${String(id ?? '')}`)
		await access.recordAccess([card.id])
		if (neighbors !== true) return card
		const backlinks = cards.backlinks()
		return {
			...card,
			neighbors: {
				out: neighborList(cards, card.links ?? []),
				in: neighborList(cards, backlinks[card.id] ?? []),
			},
		}
	}

	/**
	 * Move an #即兴 card into one of the settled branches.
	 *
	 * @param {string} id - The card id.
	 * @param {{tags?: string[]}} [patch] - The target branch tags.
	 * @returns {Promise<object>} The settled card.
	 */
	async function promote(id, { tags } = {}) {
		return cards.promote(resolve(id), Array.isArray(tags) ? { tags } : {})
	}

	/**
	 * Archive one card.
	 *
	 * @param {string} id - The card id.
	 * @returns {Promise<object>} The archived card.
	 */
	async function archive(id) {
		return cards.archive(resolve(id))
	}

	/**
	 * Remove one card and its resources.
	 *
	 * @param {string} id - The card id.
	 * @returns {Promise<{removed: boolean}>} Whether a card was removed.
	 */
	async function remove(id) {
		return { removed: await cards.remove(resolve(id)) }
	}

	/**
	 * The tag directory: a budgeted, one-line-per-tag map, drillable by tag.
	 *
	 * Archived branches are not filing targets: `<branch>/归档` is a state, and
	 * offering it here is how a model talks itself into writing it. The
	 * rendering and the budget ladder live in `tag-index.js`; this operation
	 * only wires the store to them.
	 *
	 * @param {{tag?: string, depth?: number}} [options] - Drill target and depth.
	 * @returns {Promise<{text: string, truncated: boolean}>} The directory.
	 */
	async function index({ tag, depth } = {}) {
		const descriptions = await cards.tagDescriptions()
		const tree = cards.tagTree()
		const token = typeof tag === 'string' ? tag.trim() : ''
		if (token === '') return renderTagIndex(tree, descriptions, { depth })
		const found = resolveTag(tree, token)
		if (found.node !== undefined) return renderTagBranch(found.node, descriptions, { depth })
		const near = found.suggestions.length > 0
			? `相近的有：${found.suggestions.join(' / ')}`
			: `可用枝干：${tree.map((node) => node.path).join(' / ')}`
		throw new Error(`没有标签「${token}」。${near}`)
	}

	/**
	 * The tail of the consolidation audit, newest last.
	 *
	 * The ledger says when the job ran; this file says what it did. It is the
	 * only way to tell whether a prompt change moved anything, so the review
	 * reads it back instead of trusting a count in memory.
	 *
	 * @param {number} [limit] - How many lines to keep.
	 * @returns {Promise<object[]>} The audit entries, best effort.
	 */
	async function auditTail(limit = 40) {
		return cards.consolidationAudit(limit)
	}

	/**
	 * What the most recent consolidation run actually changed.
	 *
	 * @returns {Promise<object | null>} The summary, or null when the job has never logged an action.
	 */
	async function lastConsolidation() {
		const entries = await auditTail()
		if (entries.length === 0) return null
		const run = entries[entries.length - 1].run
		const same = entries.filter((entry) => entry.run === run)
		return {
			at: run,
			actions: same.length,
			retagged: same.filter((entry) => entry.op === 'retag').length,
			tagMerges: same.filter((entry) => entry.op === 'tag-merge').length,
			reasons: same.slice(0, 5).map((entry) => `${entry.op}${entry.from === undefined ? '' : ` ${entry.from} → ${entry.to}`}${entry.reason === undefined || entry.reason === '' ? '' : `：${entry.reason}`}`),
		}
	}

	/**
	 * A bounded review of the card store.
	 *
	 * @param {number} [now] - The clock, for stale checks.
	 * @returns {Promise<object>} Lifecycle counts, link-graph metrics, recent cards and hints.
	 */
	async function review(now = Date.now()) {
		const all = cards.all()
		const active = all.filter((card) => !isArchived(card.tags))
		const status = cards.status()
		// Navigation is only as good as the graph: a library of islands makes
		// "顺着链接走" a slogan, so the review measures it instead of assuming it.
		const graph = graphMetrics(active)
		const recent = active
			.slice()
			.sort((left, right) => String(right.updated).localeCompare(String(left.updated)))
			.slice(0, 5)
			.map((card) => ({ id: card.id, description: card.description, tags: card.tags, updated: card.updated }))
		// Freshness lives in the review ledger, not on the card: one place to
		// update, and no card can disagree with the record of when it was read.
		const reviewed = (await cards.consolidationLedger()).cards
		const cutoff = now - 180 * 86_400_000
		const stale = active.filter((card) => {
			const at = Date.parse(reviewed[card.id] ?? '')
			if (Number.isFinite(at)) return at < cutoff
			const written = Date.parse(card.updated)
			return !Number.isFinite(written) || written < cutoff
		})
		// Tag hygiene, not just tag count: a branch nobody can describe, a
		// branch that only ever held one card, and the inbox that never
		// empties are the three ways a tree stops being a map.
		const descriptions = await cards.tagDescriptions()
		const branches = flattenTagTree(cards.tagTree())
		const fleeting = active.filter((card) => (card.tags ?? []).includes('即兴'))
		const tags = {
			branches: branches.length,
			leaves: branches.filter((node) => node.path.includes('/')).length,
			singleCard: branches.filter((node) => node.path.includes('/') && node.count === 1).length,
			undescribed: branches.filter((node) => descriptionOf(node.path, descriptions) === '').length,
			fleeting: fleeting.length,
			unsettled: active.filter((card) => !isSettled(card.tags)).length,
		}
		// How much of the context the injected card index costs. An index that
		// grows like the notes it indexes stops pointing and becomes a copy.
		const indexBytes = Buffer.byteLength(cardIndexText(cards), 'utf8')
		const cardBytes = active.reduce((sum, card) => sum + Buffer.byteLength(String(card.body ?? ''), 'utf8'), 0)
		const index = {
			indexBytes,
			cardBytes,
			ratio: cardBytes === 0 ? 0 : indexBytes / cardBytes,
		}
		const lastRun = await lastConsolidation()
		const hints = []
		if (lastRun !== null && lastRun.retagged + lastRun.tagMerges > 0) {
			hints.push(`上次整理动了 ${lastRun.retagged + lastRun.tagMerges} 次标签，详情见 knowledge/consolidation.jsonl。`)
		}
		if (tags.unsettled > 0) hints.push(`${tags.unsettled} 张卡还没落定枝干：选定 #践行/#见闻/#复盘/#觉察/#试错 后用 card_promote。`)
		else if (tags.fleeting > 0) hints.push(`${tags.fleeting} 张卡已经落定、但仍挂着 #即兴；下次整理会摘掉。`)
		if (tags.undescribed > 0) hints.push(`${tags.undescribed} 个枝干没有一句说明：面板「标签描述」里补上，注入的结构摘要才不只是计数。`)
		if (tags.singleCard > 0) hints.push(`${tags.singleCard} 个枝干只挂着一张卡：先确认它是不是一次性分类，是就并回父枝干。`)
		if (index.ratio > 0.1) hints.push(`注入的卡片索引已经占正文的 ${(index.ratio * 100).toFixed(0)}%：索引大过内容，先把单卡枝干并回去。`)
		if (graph.orphanRatio > 0.3) hints.push(`孤岛率 ${Math.round(graph.orphanRatio * 100)}%：先补链，跳转才成立`)
		if (stale.length > 0) hints.push(`${stale.length} 张卡片超过半年没复查过。`)
		if (hints.length === 0) hints.push('卡片库是健康的；没有高信号时不用为了主动而主动。')
		return { status, graph, tags, index, lastRun, recent, stale: stale.length, hints }
	}

	/**
	 * Write out any buffered access counts.
	 *
	 * The read path records in memory and flushes on a timer; shutdown is the
	 * one moment the buffer has nowhere else to go.
	 *
	 * @returns {Promise<void>} Resolves when the file is on disk.
	 */
	async function flushAccess() {
		await access.flushAccess({ force: true }).catch(() => {})
	}

	return { write, saveFleeting, query, read, promote, archive, remove, index, review, flushAccess }
}

/**
 * Describe the cards a card links to, or that link back to it.
 *
 * A target deleted since the link was written is reported as `(missing)`
 * instead of being dropped: the model has to see that the trail ends, and a
 * silently shorter list reads as "there was nothing there".
 *
 * @param {object} cards - The card store.
 * @param {string[]} ids - The linked ids.
 * @returns {Array<{id: string, description: string, tags: string[]}>} Neighbours, by description, at most `MAX_NEIGHBORS`.
 */
function neighborList(cards, ids) {
	const seen = new Set()
	const list = []
	for (const id of ids ?? []) {
		if (seen.has(id)) continue
		seen.add(id)
		const card = cards.get(id)
		// `missing` is explicit: an empty description alone reads like a card
		// that has none, and the model would try to open a card that is gone.
		list.push(card === undefined
			? { id, description: '', tags: [], missing: true }
			: { id: card.id, description: card.description, tags: card.tags })
	}
	// Neighbours are named by description now: sort by that, then by id so the
	// list is stable when two cards say the same thing.
	list.sort((left, right) => left.description.localeCompare(right.description) || left.id.localeCompare(right.id))
	return list.slice(0, MAX_NEIGHBORS)
}

/**
 * Link-graph metrics over the active cards.
 *
 * Only edges between two active cards count: a link to an archived or deleted
 * card is not a route the agent can take. Density is directed edges over all
 * ordered pairs; a card is an island when nothing points at it and it points
 * at nothing. Hubs are the cards with the most incoming edges, which are the
 * ones worth naming in an index.
 *
 * @param {object[]} cards - The active cards (archived already excluded).
 * @returns {{cards: number, links: number, density: number, orphans: number, orphanRatio: number, hubs: Array<{id: string, description: string, in: number}>}} The metrics.
 */
function graphMetrics(cards) {
	const ids = new Set(cards.map((card) => card.id))
	const inbound = new Map()
	let links = 0
	for (const card of cards) {
		const targets = new Set((card.links ?? []).filter((id) => ids.has(id)))
		links += targets.size
		for (const target of targets) inbound.set(target, (inbound.get(target) ?? 0) + 1)
	}
	const count = cards.length
	const orphans = cards.filter((card) => {
		const out = (card.links ?? []).some((id) => ids.has(id))
		return !out && (inbound.get(card.id) ?? 0) === 0
	}).length
	const possible = count * (count - 1)
	const hubs = cards
		.map((card) => ({ id: card.id, description: card.description, in: inbound.get(card.id) ?? 0 }))
		.filter((hub) => hub.in > 0)
		.sort((left, right) => right.in - left.in
			|| left.description.localeCompare(right.description)
			|| left.id.localeCompare(right.id))
		.slice(0, MAX_HUBS)
	return {
		cards: count,
		links,
		density: possible === 0 ? 0 : links / possible,
		orphans,
		orphanRatio: count === 0 ? 0 : orphans / count,
		hubs,
	}
}

