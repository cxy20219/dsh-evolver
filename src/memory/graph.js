/**
 * Walking the card graph.
 *
 * Lexical search finds the cards that say the query words; it cannot find the
 * card that is about the same thing without saying it. Cards already carry
 * links, so retrieval has a second half: start from the lexical seeds, let the
 * score spread along the edges (a discounted personalised walk), and hand back
 * the neighbourhood as a graph so the caller sees what came with the hit
 * instead of a flat list.
 *
 * No embeddings: on this library an embedding model moved ranking but not
 * recall (see hybrid.js), while the link graph is data the library already
 * maintains — the daily review adds the links, and the walk is the payoff.
 */

/** How far a score may travel from the seed set by default. */
const DEFAULT_HOPS = 2

/** The most nodes a returned subgraph may carry. */
const MAX_GRAPH_NODES = 40

/** How much of a seed's score reaches a one-hop neighbour. */
const ALPHA = 0.55

/** How much being a hub helps a node that the walk reaches. */
const HUB_BONUS = 0.35

/**
 * Build the undirected link graph of a card library.
 *
 * Links are stored one way (`card.links`), but for walking they are
 * undirected: the card that points at a hub is just as relevant to the hub's
 * neighbours as the other way round. Links to missing cards are dropped here,
 * so a stale reference cannot drag a phantom node into the graph.
 *
 * @param {object[]} cards - The card views.
 * @returns {{nodes: Map<string, object>, adjacency: Map<string, Set<string>>}} The graph.
 */
export function buildGraph(cards) {
	const nodes = new Map()
	for (const card of cards ?? []) {
		if (card !== null && typeof card === 'object' && typeof card.id === 'string') nodes.set(card.id, card)
	}
	const adjacency = new Map()
	const touch = (id) => {
		if (!adjacency.has(id)) adjacency.set(id, new Set())
		return adjacency.get(id)
	}
	for (const id of nodes.keys()) touch(id)
	for (const card of nodes.values()) {
		for (const link of card.links ?? []) {
			if (link === card.id || !nodes.has(link)) continue
			touch(card.id).add(link)
			touch(link).add(card.id)
		}
	}
	return { nodes, adjacency }
}

/**
 * The number of distinct neighbours per node.
 *
 * @param {{adjacency: Map<string, Set<string>>}} graph - The graph.
 * @returns {Map<string, number>} Node id to degree.
 */
export function degrees(graph) {
	const map = new Map()
	for (const [id, neighbours] of graph.adjacency) map.set(id, neighbours.size)
	return map
}

/**
 * Spread seed scores across the graph.
 *
 * The walk is bounded by `hops` and discounted by ALPHA per step, so a direct
 * neighbour always outranks a second-hand one. A node reached by several seeds
 * accumulates each of them, and hub-ness adds a small prior on top: a
 * well-connected card is a better "related" result than a dead end.
 *
 * @param {object} options - Walk parameters.
 * @param {{adjacency: Map<string, Set<string>>}} options.graph - The graph.
 * @param {Array<{id: string, weight: number}>} options.seeds - Lexical hits with normalised weights.
 * @param {number} [options.hops] - How far to travel.
 * @returns {Map<string, number>} Node id to a score in (0, 1].
 */
export function spread({ graph, seeds, hops = DEFAULT_HOPS }) {
	const reach = Math.max(1, Math.min(3, Math.round(Number(hops) || DEFAULT_HOPS)))
	const scores = new Map()
	const degree = degrees(graph)
	/**
	 * Add one seed's contribution.
	 *
	 * @param {{id: string, weight: number}} seed - The seed.
	 * @returns {void}
	 */
	function walk(seed) {
		const start = String(seed.id ?? '')
		if (start === '' || !graph.adjacency.has(start)) return
		const weight = Number(seed.weight)
		const base = Number.isFinite(weight) && weight > 0 ? weight : 1
		const best = new Map([[start, 0]])
		const queue = [{ id: start, depth: 0, score: base }]
		while (queue.length > 0) {
			const current = queue.shift()
			const previous = best.get(current.id)
			if (previous !== undefined && previous >= current.score) continue
			best.set(current.id, current.score)
			scores.set(current.id, (scores.get(current.id) ?? 0) + current.score)
			if (current.depth >= reach) continue
			for (const next of graph.adjacency.get(current.id) ?? []) {
				queue.push({ id: next, depth: current.depth + 1, score: current.score * ALPHA })
			}
		}
	}
	for (const seed of seeds ?? []) walk(seed)
	let max = 0
	for (const [id, score] of scores) {
		const hub = 1 + HUB_BONUS * Math.log(1 + (degree.get(id) ?? 0))
		const value = score * hub
		scores.set(id, value)
		if (value > max) max = value
	}
	if (max > 0) for (const [id, score] of scores) scores.set(id, score / max)
	return scores
}

/**
 * Combine the lexical ranking with the walk's ranking.
 *
 * Lexical match stays the strongest signal — a card that says the words is a
 * better answer than a card two links away — and the walk only reorders ties
 * and contributes neighbours that the words missed.
 *
 * @param {Map<string, number>} lexical - Normalised lexical scores.
 * @param {Map<string, number>} related - Normalised walk scores.
 * @param {number} [weight] - How much the walk is worth.
 * @returns {Map<string, number>} Combined scores in (0, 1].
 */
export function combine(lexical, related, weight = 0.7) {
	const combined = new Map()
	for (const [id, score] of lexical) combined.set(id, score)
	for (const [id, score] of related) {
		const kept = combined.get(id) ?? 0
		combined.set(id, Math.min(1, kept + score * weight))
	}
	return combined
}

/**
 * The subgraph around a set of cards.
 *
 * Only edges whose two ends are both kept are returned: a graph with dangling
 * edges is a lie about what the caller can reach in one hop.
 *
 * @param {object} options - Subgraph parameters.
 * @param {{adjacency: Map<string, Set<string>>}} options.graph - The graph.
 * @param {string[]} options.ids - Preferred node ids, in rank order.
 * @param {number} [options.limit] - Maximum nodes.
 * @returns {{nodes: string[], edges: Array<{from: string, to: string}>}} The subgraph.
 */
export function subgraph({ graph, ids, limit = MAX_GRAPH_NODES }) {
	const size = Math.max(1, Math.min(MAX_GRAPH_NODES, Math.round(Number(limit) || MAX_GRAPH_NODES)))
	const kept = []
	const seen = new Set()
	for (const id of ids ?? []) {
		if (kept.length >= size) break
		if (typeof id !== 'string' || !graph.adjacency.has(id) || seen.has(id)) continue
		seen.add(id)
		kept.push(id)
	}
	const edges = []
	for (const from of kept) {
		for (const to of graph.adjacency.get(from) ?? []) {
			if (!seen.has(to) || to <= from) continue
			edges.push({ from, to })
		}
	}
	edges.sort((left, right) => (left.from === right.from ? left.to.localeCompare(right.to) : left.from.localeCompare(right.from)))
	return { nodes: kept, edges }
}
