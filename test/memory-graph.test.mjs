/**
 * The card graph walk: adjacency, spreading scores and the subgraph that comes
 * back with a search.
 *
 * The properties that matter are behavioural: walking is undirected (a
 * backlink counts as much as a forward link), a direct neighbour always beats
 * a second-hand one, several seeds pointing at the same node reinforce it, and
 * the returned edges never reference a node outside the returned set.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildGraph, combine, degrees, spread, subgraph } from '../src/memory/graph.js'

/**
 * A card view with just the fields the graph reads.
 *
 * @param {string} id - The card id.
 * @param {string[]} [links] - Outgoing links.
 * @returns {object} The card.
 */
function card(id, links = []) {
	return { id, body: id, tags: ['践行/经验'], links }
}

test('建图：链接是无向的，死链和自链接被丢掉', () => {
	const graph = buildGraph([card('a', ['b', 'missing', 'a']), card('b', []), card('c', ['a'])])
	assert.deepEqual([...graph.adjacency.get('a')].sort(), ['b', 'c'])
	assert.deepEqual([...graph.adjacency.get('b')], ['a'])
	assert.deepEqual([...graph.adjacency.get('c')], ['a'])
	assert.equal(graph.adjacency.has('missing'), false)
	assert.deepEqual(degrees(graph), new Map([['a', 2], ['b', 1], ['c', 1]]))
})

test('扩散：种子得 1，一跳衰减过半，两跳更少，三跳走不到', () => {
	const graph = buildGraph([card('a', ['b']), card('b', ['c']), card('c', ['d']), card('d', [])])
	const scores = spread({ graph, seeds: [{ id: 'a', weight: 1 }], hops: 2 })
	assert.equal(scores.get('a'), 1)
	assert.ok(scores.get('b') > 0 && scores.get('b') < 1)
	assert.ok(scores.get('c') > 0 && scores.get('c') < scores.get('b'))
	assert.equal(scores.has('d'), false)
})

test('多个种子指向同一个节点时，该节点被加强', () => {
	const graph = buildGraph([card('s1', ['hub']), card('s2', ['hub']), card('hub', []), card('far', [])])
	const scores = spread({
		graph,
		seeds: [{ id: 's1', weight: 1 }, { id: 's2', weight: 1 }],
		hops: 1,
	})
	assert.ok(scores.get('hub') > scores.get('s1'), '两个种子共同指向的节点应高于种子本身')
	// 归一化后最大值是 hub，分数都在 (0,1]。
	assert.equal(scores.get('hub'), 1)
	for (const value of scores.values()) assert.ok(value > 0 && value <= 1)
})

test('枢纽加成：同样距离，度高的节点分数更高', () => {
	const graph = buildGraph([
		card('seed', ['low', 'hub']),
		card('low', []),
		card('hub', ['x1', 'x2', 'x3']),
		card('x1', []), card('x2', []), card('x3', []),
	])
	const scores = spread({ graph, seeds: [{ id: 'seed', weight: 1 }], hops: 1 })
	assert.ok(scores.get('hub') > scores.get('low'))
})

test('合并：词面命中优先，关系命中只补空缺与加权', () => {
	const merged = combine(new Map([['a', 1]]), new Map([['b', 1]]), 0.7)
	assert.equal(merged.get('a'), 1)
	assert.equal(merged.get('b'), 0.7)
	const both = combine(new Map([['a', 0.5]]), new Map([['a', 1]]), 0.7)
	assert.equal(both.get('a'), 1, '同一节点封顶 1')
})

test('子图：只返回两端都在集合内的边，节点顺序就是传入顺序', () => {
	const graph = buildGraph([card('a', ['b']), card('b', ['c']), card('c', [])])
	const slice = subgraph({ graph, ids: ['b', 'a'], limit: 10 })
	assert.deepEqual(slice.nodes, ['b', 'a'])
	assert.deepEqual(slice.edges, [{ from: 'a', to: 'b' }])
	// c 不在集合里，b-c 的边不能出现。
	assert.equal(slice.edges.some((edge) => edge.to === 'c' || edge.from === 'c'), false)
})

test('空图与空种子不抛错', () => {
	const graph = buildGraph([])
	assert.equal(spread({ graph, seeds: [{ id: 'a', weight: 1 }] }).size, 0)
	assert.deepEqual(subgraph({ graph, ids: ['a'] }).nodes, [])
	assert.equal(combine(new Map(), new Map()).size, 0)
})
