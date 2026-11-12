import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCardGraph } from '../src/cards/graph.js'

/**
 * One card view, shaped like `store.all()` returns.
 *
 * @param {string} id - The card id.
 * @param {{label?: string, description?: string, tags?: string[], links?: string[], updated?: string}} [fields] - The rest.
 * @returns {object} The card.
 */
function card(id, fields = {}) {
	return {
		id,
		label: fields.label ?? id,
		description: fields.description ?? '',
		tags: fields.tags ?? [],
		links: fields.links ?? [],
		updated: fields.updated ?? '',
	}
}

/**
 * The node with one id.
 *
 * @param {object} graph - The payload.
 * @param {string} id - The card id.
 * @returns {object | undefined} The node.
 */
function nodeOf(graph, id) {
	return graph.nodes.find((node) => node.id === id)
}

/**
 * Every edge between two cards, whichever way it was emitted.
 *
 * @param {object} graph - The payload.
 * @param {string} left - One card id.
 * @param {string} right - The other.
 * @returns {object[]} The edges.
 */
function pairEdges(graph, left, right) {
	return graph.edges.filter((edge) => (edge.source === left && edge.target === right)
		|| (edge.source === right && edge.target === left))
}

/**
 * The wire shape both halves rely on.
 *
 * @param {object} graph - The payload.
 * @returns {void}
 */
function assertShape(graph) {
	assert.deepEqual(Object.keys(graph).sort(), ['edges', 'nodes', 'totals'])
	assert.deepEqual(
		Object.keys(graph.totals).sort(),
		['cards', 'edges', 'hiddenCards', 'limit', 'links', 'nodes', 'weak'],
	)
	for (const node of graph.nodes) {
		assert.deepEqual(
			Object.keys(node).sort(),
			['branch', 'degree', 'description', 'id', 'label', 'lastReadAt', 'readCount', 'tags', 'updated'],
		)
		assert.equal(typeof node.branch, 'string')
		assert.equal(Number.isInteger(node.degree), true)
		assert.equal(Number.isFinite(node.readCount), true)
		assert.equal(typeof node.lastReadAt, 'string')
	}
	for (const edge of graph.edges) {
		assert.deepEqual(Object.keys(edge).sort(), ['kind', 'mutual', 'source', 'target', 'weight'])
		assert.ok(['link', 'tag', 'branch'].includes(edge.kind), `未知边类型：${edge.kind}`)
		// Every edge is undirected on the wire: the smaller id is always source,
		// so one pair never depends on insertion or input order.
		assert.ok(edge.source < edge.target, `source 必须小于 target：${edge.source}/${edge.target}`)
		assert.equal(typeof edge.weight, 'number')
		assert.equal(typeof edge.mutual, 'boolean')
	}
	assert.equal(graph.totals.nodes, graph.nodes.length)
	assert.equal(graph.totals.edges, graph.edges.length)
	assert.equal(graph.totals.links + graph.totals.weak, graph.edges.length)
	assert.equal(graph.totals.nodes + graph.totals.hiddenCards, graph.totals.cards)
	assert.ok(graph.totals.limit >= 50 && graph.totals.limit <= 500)
}

/**
 * Assert one branch became one chain in rank order.
 *
 * @param {object} graph - The payload.
 * @param {string} branch - The expected branch.
 * @param {string[]} ids - The expected chain members, rank order.
 * @returns {void}
 */
function assertBranchChain(graph, branch, ids) {
	const chain = graph.edges.filter((edge) => ids.includes(edge.source) || ids.includes(edge.target))
	assert.equal(chain.length, ids.length - 1, `branch ${branch || "''"} 应成 ${ids.length - 1} 条链`)
	for (const edge of chain) {
		assert.equal(graph.nodes.find((node) => node.id === edge.source)?.branch ?? '', branch)
		assert.equal(graph.nodes.find((node) => node.id === edge.target)?.branch ?? '', branch)
	}
}

test('链接边按无向对去重，双向链接标 mutual，度数按全库算', () => {
	const cards = [
		card('a', { links: ['b', 'c', 'b', 'missing'] }),
		card('b', { links: ['a'] }),
		card('c'),
		card('d'),
	]
	const graph = buildCardGraph(cards)
	assertShape(graph)

	const ab = pairEdges(graph, 'a', 'b')
	assert.equal(ab.length, 1, '两个方向只出一条无向边')
	assert.equal(ab[0].kind, 'link')
	assert.equal(ab[0].weight, 1)
	assert.equal(ab[0].mutual, true, 'a→b 与 b→a 都在，mutual 为真')

	const ac = pairEdges(graph, 'a', 'c')
	assert.equal(ac.length, 1)
	assert.equal(ac[0].mutual, false, '只有 a→c，mutual 为假')
	assert.equal(pairEdges(graph, 'c', 'missing').length, 0, '指向不存在卡片的链接不成边')

	// 重复 links 和悬空链接都不计入度数。
	assert.equal(nodeOf(graph, 'a').degree, 2)
	assert.equal(nodeOf(graph, 'b').degree, 1)
	assert.equal(nodeOf(graph, 'c').degree, 1)
	assert.equal(nodeOf(graph, 'd').degree, 0)
	// 度数高的先入图；同分按 id 稳定排序。
	assert.deepEqual(graph.nodes.map((node) => node.id), ['a', 'b', 'c', 'd'])
	assert.equal(graph.totals.links, 2)
	assert.equal(graph.totals.weak, 0)
})

test('tag 小组全连接，大组只连相邻 window 2', () => {
	const small = ['s1', 's2', 's3'].map((id) => card(id, { tags: ['践行/工作流'] }))
	const big = Array.from({ length: 10 }, (_, index) => card(`g${String(index + 1).padStart(2, '0')}`, { tags: ['见闻/大组'] }))
	const graph = buildCardGraph([...small, ...big])
	assertShape(graph)

	const smallEdges = pairEdges(graph, 's1', 's2').concat(pairEdges(graph, 's1', 's3'), pairEdges(graph, 's2', 's3'))
	assert.equal(smallEdges.length, 3, '3 张卡的小组全连接')
	for (const edge of smallEdges) {
		assert.equal(edge.kind, 'tag')
		assert.equal(edge.weight, 0.5)
		assert.equal(edge.mutual, false)
	}
	assert.ok(nodeOf(graph, 's1').branch === '践行')
	assert.deepEqual(nodeOf(graph, 's1').tags, ['践行/工作流'])

	// 10 张卡的大组：只连 i→i+1 与 i→i+2，共 2*8+1 = 17 条，而不是 45 条全连接。
	const bigEdges = graph.edges.filter((edge) => edge.kind === 'tag' && edge.source.startsWith('g') && edge.target.startsWith('g'))
	assert.equal(bigEdges.length, 17)
	assert.equal(pairEdges(graph, 'g01', 'g03').length, 1, 'window 2 内的第二条能连上')
	assert.equal(pairEdges(graph, 'g01', 'g04').length, 0, 'window 2 之外不连')
	for (const edge of bigEdges) {
		assert.equal(edge.kind, 'tag')
		assert.equal(edge.weight, 0.25)
	}
	assert.equal(graph.totals.links, 0)
	assert.equal(graph.totals.weak, 20)
	assert.equal(graph.totals.edges, 20)
})

test('link 与 tag 冲突时保留 link，跨标签同一对只留较大权重', () => {
	const cards = [
		// 同一个 tag 小组里 x1→x2 已显式链接：tag 边让位给 link 边。
		card('x1', { links: ['x2'], tags: ['复盘/踩坑'] }),
		card('x2', { tags: ['复盘/踩坑'] }),
		card('x3', { tags: ['复盘/踩坑'] }),
		// p1/p2 同属一个小 tag 组（0.5）和一个大 tag 组（0.25）：只留 0.5。
		card('p1', { tags: ['践行/工作流', '见闻/大组'] }),
		card('p2', { tags: ['践行/工作流', '见闻/大组'] }),
		card('p3', { tags: ['践行/工作流'] }),
		...Array.from({ length: 7 }, (_, index) => card(`g${index + 1}`, { tags: ['见闻/大组'] })),
	]
	const graph = buildCardGraph(cards)
	assertShape(graph)

	const conflict = pairEdges(graph, 'x1', 'x2')
	assert.equal(conflict.length, 1, '同一对不能既是一条 link 又是一条 tag')
	assert.equal(conflict[0].kind, 'link')
	assert.equal(conflict[0].weight, 1)
	assert.equal(pairEdges(graph, 'x1', 'x3').length, 1, '组内其余对仍按 tag 连接')
	assert.equal(pairEdges(graph, 'x2', 'x3').length, 1)

	const overlapped = pairEdges(graph, 'p1', 'p2')
	assert.equal(overlapped.length, 1, '跨两个 tag 组的同一对只出一条边')
	assert.equal(overlapped[0].kind, 'tag')
	assert.equal(overlapped[0].weight, 0.5, '取较大的权重 0.5，而不是 0.25')
	assert.equal(pairEdges(graph, 'p1', 'p3').length, 1)
	assert.ok(graph.edges.some((edge) => edge.kind === 'tag' && (edge.source === 'p1' || edge.target === 'p1') && /^g/.test(edge.source === 'p1' ? edge.target : edge.source)), '大组窗口仍把 p1 连进同组')
})

test('孤立卡按 branch 接成链，无标签卡进空枝干链', () => {
	const cards = [
		card('i1', { tags: ['即兴'] }),
		card('i2', { tags: ['即兴'] }),
		card('i3', { tags: ['即兴'] }),
		card('n1'),
		card('n2'),
		card('a1', { tags: ['践行'] }),
		card('a2', { tags: ['践行'] }),
	]
	const graph = buildCardGraph(cards)
	assertShape(graph)

	assert.equal(graph.totals.links, 0)
	assert.equal(graph.totals.weak, 4)
	assert.equal(graph.edges.every((edge) => edge.kind === 'branch' && edge.weight === 0.15), true)
	assertBranchChain(graph, '即兴', ['i1', 'i2', 'i3'])
	assertBranchChain(graph, '', ['n1', 'n2'])
	assertBranchChain(graph, '践行', ['a1', 'a2'])
	assert.equal(nodeOf(graph, 'n1').tags.length, 0)
	assert.equal(nodeOf(graph, 'n1').branch, '')
	assert.equal(nodeOf(graph, 'i1').branch, '即兴')


})

test('归档卡不入图：不进 nodes、不计 totals.cards、指向它的 link 按不存在跳过', () => {
	const cards = [
		// 普通卡显式指向一张已归档的卡：目标不存在，边与度数都不该出现。
		card('live', { tags: ['践行/工作流'], links: ['probe'] }),
		// 与 live 共享标签，但归档状态优先：它不参与 tag 分组。
		card('probe', { tags: ['践行/工作流', '践行/归档'] }),
		card('gone', { tags: ['即兴', '即兴/归档'] }),
	]
	const graph = buildCardGraph(cards)
	assertShape(graph)
	assert.deepEqual(graph.nodes.map((node) => node.id), ['live'])
	assert.equal(nodeOf(graph, 'probe'), undefined, '归档卡不能出现在 nodes')
	assert.equal(graph.totals.cards, 1, '归档卡不计入 totals.cards')
	assert.equal(graph.totals.nodes, 1)
	assert.equal(graph.totals.hiddenCards, 0)
	assert.equal(graph.totals.links, 0, '指向归档卡的 link 按目标不存在处理')
	assert.equal(graph.totals.weak, 0, '归档卡不参与共享标签分组')
	assert.equal(graph.edges.length, 0)
	assert.equal(nodeOf(graph, 'live').degree, 0)
})

test('limit 夹取 50–500，按 rank 截断并报告 hiddenCards', () => {
	const cards = Array.from({ length: 60 }, (_, index) => card(`c${String(index + 1).padStart(2, '0')}`))
	// 最后两张凭一条显式链接排到最前，证明截断按 rank 而不是输入顺序。
	cards[59].links = ['c59']

	const low = buildCardGraph(cards, { limit: 10 })
	assertShape(low)
	assert.equal(low.totals.limit, 50, '小于 50 的 limit 被抬到 50')
	assert.equal(low.nodes.length, 50)
	assert.equal(low.totals.hiddenCards, 10)
	assert.deepEqual(low.nodes.slice(0, 2).map((node) => node.id), ['c59', 'c60'])
	assert.equal(low.nodes.some((node) => node.id === 'c58'), false, 'rank 之外的不入图')

	const high = buildCardGraph(cards, { limit: 10_000 })
	assert.equal(high.totals.limit, 500, '大于 500 的 limit 被压到 500')
	assert.equal(high.nodes.length, 60)
	assert.equal(high.totals.hiddenCards, 0)

	assert.equal(buildCardGraph(cards).totals.limit, 300, '未给 limit 用默认 300')
	assert.equal(buildCardGraph(cards, { limit: 'abc' }).totals.limit, 300, '非法 limit 用默认 300')
	assert.equal(buildCardGraph(cards, { limit: 0 }).totals.limit, 50)
	assert.equal(buildCardGraph(cards, { limit: 500 }).totals.limit, 500, '边界值原样保留')
	assert.equal(buildCardGraph(cards, { limit: 50 }).totals.limit, 50)
})

test('access 注入 readCount/lastReadAt，并在 updated 之后参与排序', () => {
	const cards = [card('r1'), card('r2'), card('r3')]
	const graph = buildCardGraph(cards, {
		access: {
			r1: { count: 4, lastAt: '2026-11-01T00:00:00.000Z' },
			r2: { count: 9, lastAt: '2026-11-10T00:00:00.000Z' },
			r3: { count: 'nope', lastAt: 42 },
		},
	})

	assert.equal(nodeOf(graph, 'r1').readCount, 4)
	assert.equal(nodeOf(graph, 'r1').lastReadAt, '2026-11-01T00:00:00.000Z')
	assert.equal(nodeOf(graph, 'r2').readCount, 9)
	assert.equal(nodeOf(graph, 'r3').readCount, 0, '坏计数按未读处理')
	assert.equal(nodeOf(graph, 'r3').lastReadAt, '', '坏时间按空串处理')
	// 全部零度、updated 相同时，读得多的先入图。
	assert.deepEqual(graph.nodes.map((node) => node.id), ['r2', 'r1', 'r3'])

	const plain = buildCardGraph(cards)
	assert.equal(nodeOf(plain, 'r1').readCount, 0)
	assert.equal(nodeOf(plain, 'r1').lastReadAt, '')
})

test('确定性：同一输入两次一致，打乱输入顺序结果不变', () => {
	const cards = [
		card('d1', { links: ['d2', 'd3'], tags: ['践行/工作流'], updated: '2026-03-01T00:00:00.000Z' }),
		card('d2', { links: ['d1'], tags: ['践行/工作流', '见闻/大组'] }),
		card('d3', { tags: ['见闻/大组'] }),
		card('d4', { tags: ['即兴'] }),
		card('d5'),
		card('d6'),
		...Array.from({ length: 9 }, (_, index) => card(`e${index + 1}`, { tags: ['见闻/大组'] })),
	]
	const options = { limit: 50, access: { d1: { count: 2, lastAt: '2026-03-02T00:00:00.000Z' } } }
	const first = buildCardGraph(cards, options)
	const second = buildCardGraph(cards, options)
	assert.deepEqual(second, first)
	assert.deepEqual(buildCardGraph([...cards].reverse(), options), first, '输入顺序不影响结果')
	assert.equal(JSON.stringify(first), JSON.stringify(second), '逐字节一致，浏览器可以直接比较')
})

test('脏数据与缺省参数不抛错', () => {
	assert.deepEqual(buildCardGraph(undefined), {
		nodes: [],
		edges: [],
		totals: { cards: 0, nodes: 0, edges: 0, links: 0, weak: 0, hiddenCards: 0, limit: 300 },
	})
	assert.deepEqual(buildCardGraph('not cards'), { nodes: [], edges: [], totals: { cards: 0, nodes: 0, edges: 0, links: 0, weak: 0, hiddenCards: 0, limit: 300 } })

	const dirty = buildCardGraph(
		[
			null,
			42,
			{ id: '' },
			{ id: 'ok', label: 7, description: null, tags: 'bad', links: 5, updated: 3 },
			{ id: 'ok2', tags: ['即兴', 3, ''], links: ['ok', null], updated: '' },
		],
		null,
	)
	assertShape(dirty)
	assert.equal(dirty.totals.cards, 2)
	assert.deepEqual(dirty.nodes.find((node) => node.id === 'ok'), {
		id: 'ok',
		label: '',
		description: '',
		tags: [],
		branch: '',
		degree: 1,
		updated: '',
		readCount: 0,
		lastReadAt: '',
	})
	assert.deepEqual(dirty.nodes.find((node) => node.id === 'ok2').tags, ['即兴'])
	// 重复 id 只算一张卡。
	assert.equal(buildCardGraph([card('x'), card('x')]).totals.cards, 1)
})
