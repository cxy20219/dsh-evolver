/**
 * The card graph the panel draws.
 *
 * The library's own edges are the explicit `links` between cards, and there
 * are never enough of them: a young library is mostly disconnected cards, and
 * a force layout of a few points tells nobody anything. The panel therefore
 * also gets two kinds of derived edges — cards that share a deep tag, and
 * cards that share a branch and would otherwise float free — marked with a
 * smaller weight so the drawing can tell a stated relation from an inferred
 * one.
 *
 * Everything here is pure and deterministic: no clock, no randomness, and the
 * same cards always produce the same order. The browser compares two payloads
 * to decide whether to relayout, and the tests call this twice and compare.
 *
 * Archived cards are a state, not a branch: they stay out of the picture and
 * out of `totals.cards` (the overview graph never included them either), and a
 * link pointing at one behaves like a link to a missing card.
 *
 * The node limit bounds the client's layout cost (a force simulation is not
 * cheap), not the derivation cost here: ranking and the explicit graph scan
 * the whole live library, and node selection happens afterwards.
 */

import { buildGraph, degrees } from '../memory/graph.js'
import { isArchived, rootOf } from './tags.js'

/** The node count the panel asks for by default. */
const DEFAULT_LIMIT = 300

/** The smallest and largest node counts a caller may ask for. */
const MIN_LIMIT = 50
const MAX_LIMIT = 500

/** How heavy each kind of edge is drawn. Only an explicit link is stated data. */
const LINK_WEIGHT = 1
const TAG_WEIGHT_DENSE = 0.5
const TAG_WEIGHT_SPARSE = 0.25
const BRANCH_WEIGHT = 0.15

/** A tag group up to this size is connected completely; larger ones become a window. */
const TAG_GROUP_FULL = 8

/** How far a card reaches inside a large tag group: two neighbours to the right. */
const TAG_GROUP_WINDOW = 2

/** The order edges are emitted in: stated relations first, inferred ones after. */
const KIND_ORDER = { link: 0, tag: 1, branch: 2 }

/**
 * Clamp a caller's node limit.
 *
 * The endpoint passes `Number(payload.limit)`, which is NaN for a missing or
 * non-numeric field; that falls back to the default rather than to the minimum
 * so an old panel that never sends the field keeps the full graph.
 *
 * @param {unknown} value - The requested limit.
 * @returns {number} A limit in [MIN_LIMIT, MAX_LIMIT].
 */
function normalizeLimit(value) {
	if (value === undefined || value === null || value === '') return DEFAULT_LIMIT
	const number = Math.trunc(Number(value))
	if (!Number.isFinite(number)) return DEFAULT_LIMIT
	return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, number))
}

/**
 * Compare two strings by code unit, so the order does not depend on the locale.
 *
 * @param {string} left - One string.
 * @param {string} right - The other.
 * @returns {number} Negative, zero or positive, like any comparator.
 */
function compareText(left, right) {
	if (left === right) return 0
	return left < right ? -1 : 1
}

/**
 * The key of the undirected pair two cards form.
 *
 * Card ids cannot contain the separator (they are ULIDs), so the key is
 * unambiguous and cheap to compare.
 *
 * @param {string} left - One card id.
 * @param {string} right - The other.
 * @returns {string} The pair key.
 */
function pairKey(left, right) {
	return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`
}

/**
 * The endpoints of the undirected edge two cards form, in a stable order.
 *
 * Every edge the panel receives is undirected; `source` is the smaller id so a
 * pair never depends on which card happened to be visited first. Explicit
 * bi-directional links are marked by `mutual`, not by a second edge.
 *
 * @param {string} left - One card id.
 * @param {string} right - The other.
 * @returns {[string, string]} The endpoints.
 */
function endpoints(left, right) {
	return left < right ? [left, right] : [right, left]
}

/**
 * The string items of a dirty field.
 *
 * The store already cleans `tags` and `links` on read; this only keeps a
 * hand-built call (and an imported older record) from throwing. Anything that
 * is not a non-empty string is skipped.
 *
 * @param {unknown} value - The raw field.
 * @returns {string[]} The usable items.
 */
function strings(value) {
	if (!Array.isArray(value)) return []
	const list = []
	for (const item of value) {
		if (typeof item === 'string' && item !== '') list.push(item)
	}
	return list
}

/**
 * Project the store's card views onto the fields the graph needs.
 *
 * Duplicate ids keep the first entry: one card is one node however the log was
 * imported. Archived cards are dropped here, before any edge is derived, so
 * they neither rank nor form tag groups nor pull a live neighbour into a link.
 *
 * @param {unknown} cards - The store's card views (archived ones included).
 * @returns {object[]} The normalised live views.
 */
function normalizeCards(cards) {
	const seen = new Set()
	const views = []
	for (const card of Array.isArray(cards) ? cards : []) {
		if (card === null || typeof card !== 'object') continue
		if (typeof card.id !== 'string' || card.id === '' || seen.has(card.id)) continue
		const tags = strings(card.tags)
		if (isArchived(tags)) continue
		seen.add(card.id)
		views.push({
			id: card.id,
			label: typeof card.label === 'string' ? card.label : '',
			description: typeof card.description === 'string' ? card.description : '',
			tags,
			links: strings(card.links),
			updated: typeof card.updated === 'string' ? card.updated : '',
		})
	}
	return views
}

/**
 * The branch a card's first tag belongs to, or '' for an untagged card.
 *
 * @param {object} card - The normalised card view.
 * @returns {string} The root of the first tag.
 */
function branchOf(card) {
	return card.tags.length === 0 ? '' : rootOf(card.tags[0])
}

/**
 * Read the access ledger's entry for one card, defensively.
 *
 * @param {object} access - The ledger (`id` to `{count, lastAt}`).
 * @param {string} id - The card id.
 * @returns {{readCount: number, lastReadAt: string}} The activity fields.
 */
function activityOf(access, id) {
	const entry = Object.hasOwn(access, id) ? access[id] : undefined
	const record = entry !== null && typeof entry === 'object' ? entry : undefined
	const count = record === undefined ? NaN : Number(record.count)
	return {
		readCount: Number.isFinite(count) && count > 0 ? count : 0,
		lastReadAt: typeof record?.lastAt === 'string' ? record.lastAt : '',
	}
}

/**
 * Rank one card for selection, with everything the node needs besides the graph.
 *
 * @param {object} card - The normalised card view.
 * @param {number} degree - The card's degree in the whole library's link graph.
 * @param {object} access - The access ledger.
 * @returns {{card: object, degree: number, readCount: number, lastReadAt: string}} The ranked entry.
 */
function rankEntry(card, degree, access) {
	return { card, degree, ...activityOf(access, card.id) }
}

/**
 * Build one node of the panel graph.
 *
 * @param {{card: object, degree: number, readCount: number, lastReadAt: string}} entry - The ranked entry.
 * @returns {object} The node.
 */
function nodeOf(entry) {
	const card = entry.card
	return {
		id: card.id,
		label: card.label,
		description: card.description,
		tags: [...card.tags],
		branch: branchOf(card),
		degree: entry.degree,
		updated: card.updated,
		readCount: entry.readCount,
		lastReadAt: entry.lastReadAt,
	}
}

/**
 * Rank two entries for selection.
 *
 * A stated relation outweighs a stale card, a fresh card outweighs a read one,
 * and the id is the final tie-break so the same library always selects the same
 * nodes. The clock is never read: `updated` is data, not "now".
 *
 * @param {object} left - One entry.
 * @param {object} right - The other.
 * @returns {number} Negative, zero or positive, like any comparator.
 */
function compareRank(left, right) {
	return right.degree - left.degree
		|| compareText(right.card.updated, left.card.updated)
		|| right.readCount - left.readCount
		|| compareText(left.card.id, right.card.id)
}

/**
 * The pairs to connect inside one tag group.
 *
 * A small group is a clique because it is readable as one; a large group is
 * only a chain with a two-card reach, because a clique there is quadratic and
 * turns the layout into a hairball.
 *
 * @param {object[]} members - The group members in rank order.
 * @param {boolean} dense - Whether the group is small enough for a clique.
 * @yields {[object, object]} One unordered pair.
 */
function* tagPairs(members, dense) {
	if (dense) {
		for (let left = 0; left < members.length; left += 1) {
			for (let right = left + 1; right < members.length; right += 1) {
				yield [members[left], members[right]]
			}
		}
		return
	}
	const window = TAG_GROUP_WINDOW
	for (let left = 0; left < members.length; left += 1) {
		for (let right = left + 1; right < members.length && right <= left + window; right += 1) {
			yield [members[left], members[right]]
		}
	}
}

/**
 * Derive the edges of the panel graph from the selected nodes.
 *
 * Order matters: explicit links are derived first and win every conflict, then
 * tag groups, then branch chains for whatever is still isolated. The result is
 * sorted by kind and then by card id, not by insertion order, so two calls see
 * the same payload.
 *
 * @param {object[]} entries - The selected entries in rank order.
 * @returns {object[]} The edges.
 */
function deriveEdges(entries) {
	const selected = new Set(entries.map((entry) => entry.card.id))
	const edges = []
	const linkPairs = new Set()

	// Every direction a link states, so `mutual` can be answered on the pair.
	const directed = new Set()
	for (const entry of entries) {
		for (const target of entry.card.links) directed.add(`${entry.card.id}\u0000${target}`)
	}

	// 1. Explicit links between selected cards. One undirected pair gets one
	// edge; the second direction only flips `mutual`.
	for (const entry of entries) {
		const id = entry.card.id
		for (const target of entry.card.links) {
			if (target === id || !selected.has(target)) continue
			const key = pairKey(id, target)
			if (linkPairs.has(key)) continue
			linkPairs.add(key)
			const [source, destination] = endpoints(id, target)
			edges.push({
				source,
				target: destination,
				kind: 'link',
				weight: LINK_WEIGHT,
				mutual: directed.has(`${id}\u0000${target}`) && directed.has(`${target}\u0000${id}`),
			})
		}
	}

	/** Tag and branch edges share one slot per pair: tag groups overlap. */
	const weak = new Map()

	// 2. Non-root tags group cards. A pair linked explicitly keeps the stated
	// edge; the same pair reached through two tags keeps the heavier one.
	const groups = new Map()
	for (const entry of entries) {
		for (const tag of entry.card.tags) {
			if (!tag.includes('/')) continue
			if (!groups.has(tag)) groups.set(tag, [])
			groups.get(tag).push(entry)
		}
	}
	for (const tag of [...groups.keys()].sort(compareText)) {
		const members = groups.get(tag)
		if (members.length < 2) continue
		const dense = members.length <= TAG_GROUP_FULL
		const weight = dense ? TAG_WEIGHT_DENSE : TAG_WEIGHT_SPARSE
		for (const [left, right] of tagPairs(members, dense)) {
			const key = pairKey(left.card.id, right.card.id)
			if (linkPairs.has(key)) continue
			const previous = weak.get(key)
			if (previous !== undefined && previous.weight >= weight) continue
			const [source, target] = endpoints(left.card.id, right.card.id)
			weak.set(key, { source, target, kind: 'tag', weight, mutual: false })
		}
	}

	// 3. What the two passes left with no edge at all is chained along its
	// branch, so the layout has somewhere to pull it instead of leaving it in
	// the void. Cards without any tag share the '' branch.
	const degree = new Map()
	for (const edge of [...edges, ...weak.values()]) {
		degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
		degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
	}
	const branches = new Map()
	for (const entry of entries) {
		const id = entry.card.id
		if ((degree.get(id) ?? 0) > 0) continue
		const branch = branchOf(entry.card)
		if (!branches.has(branch)) branches.set(branch, [])
		branches.get(branch).push(entry)
	}
	for (const branch of [...branches.keys()].sort(compareText)) {
		const members = branches.get(branch)
		for (let index = 0; index + 1 < members.length; index += 1) {
			const [source, target] = endpoints(members[index].card.id, members[index + 1].card.id)
			const key = pairKey(source, target)
			if (linkPairs.has(key) || weak.has(key)) continue
			weak.set(key, { source, target, kind: 'branch', weight: BRANCH_WEIGHT, mutual: false })
		}
	}

	edges.push(...weak.values())
	edges.sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
		|| compareText(left.source, right.source)
		|| compareText(left.target, right.target))
	return edges
}

/**
 * Build the panel's card graph.
 *
 * @param {unknown} cards - The store's card views (`store.all()`); archived cards are filtered out.
 * @param {{access?: Record<string, {count: number, lastAt: string}>, limit?: number}} [options] - Access ledger and node limit.
 * @returns {{nodes: object[], edges: object[], totals: object}} The graph payload.
 */
export function buildCardGraph(cards, options = {}) {
	const limit = normalizeLimit(options?.limit)
	const access = options?.access !== null && typeof options?.access === 'object' && !Array.isArray(options?.access)
		? options.access
		: {}
	const views = normalizeCards(cards)
	// The degree ranks nodes and is shown, so it is the whole library's degree:
	// selecting first would make a hub look quiet when its neighbours are the
	// cards that fell off the end.
	const degree = degrees(buildGraph(views))
	const entries = views
		.map((card) => rankEntry(card, degree.get(card.id) ?? 0, access))
		.sort(compareRank)
		.slice(0, limit)
	const nodes = entries.map(nodeOf)
	const edges = deriveEdges(entries)
	const links = edges.filter((edge) => edge.kind === 'link').length
	return {
		nodes,
		edges,
		totals: {
			cards: views.length,
			nodes: nodes.length,
			edges: edges.length,
			links,
			weak: edges.length - links,
			hiddenCards: Math.max(0, views.length - nodes.length),
			limit,
		},
	}
}
