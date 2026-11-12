/**
 * Graph search: the relation half of retrieval.
 *
 * The flat search answers "which cards say the words". `queryGraph` adds the
 * second half — the lexical seeds are spread along the links and the answer
 * carries the neighbourhood as a subgraph — plus `within`, the second pass
 * that digs into a subgraph instead of the whole library. These cases pin the
 * payload shape, the lexical-over-relational ordering, the walk's distance
 * limit and the fact that the flat mode still returns the array it always did.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { accessStats } from '../src/cards/access.js'
import { createCardAgent } from '../src/cards/agent.js'
import { CardStore } from '../src/cards/store.js'
import { createTools } from '../src/tools.js'

/**
 * A card store on a temporary folder.
 *
 * @returns {Promise<{dir: string, store: CardStore}>} The fixture.
 */
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), 'evr-graph-'))
	const store = new CardStore({ dataDir: dir })
	await store.init()
	return { dir, store }
}

/**
 * Close the store and remove its folder.
 *
 * @param {string} dir - The folder.
 * @param {CardStore} store - The store.
 * @returns {Promise<void>} Resolves when gone.
 */
async function cleanup(dir, store) {
	await store.close()
	await rm(dir, { recursive: true, force: true })
}

/**
 * The ids of a list of cards.
 *
 * @param {object[]} cards - The cards.
 * @returns {string[]} Their ids.
 */
function ids(cards) {
	return cards.map((card) => card.id)
}

/**
 * An edge as an unordered pair, so the ULID tie-break cannot make the test
 * depend on which end sorted first.
 *
 * @param {{from: string, to: string}} edge - The edge.
 * @returns {string[]} The two ends, sorted.
 */
function ends(edge) {
	return [edge.from, edge.to].sort()
}

test('queryGraph：返回命中卡 + related + 子图，卡片与节点各带自己的 degree', async () => {
	const { dir, store } = await fixture()
	try {
		const seed = await store.put({
			body: '# 部署方式\n\n部署走 SSH，不要用 HTTPS。',
			tags: ['践行/经验'],
			description: '本机部署的步骤和禁忌',
		})
		const neighbour = await store.put({
			body: '# 回滚脚本\n\n回滚前先备份。',
			tags: ['践行/工作流'],
			links: [seed.id],
		})
		const far = await store.put({
			body: '# 测试清单\n\n发布前跑测试。',
			tags: ['践行/验证方法'],
			links: [neighbour.id],
		})
		await store.put({ body: '# 无关卡片\n\n和这件事没关系。', tags: ['见闻/事实'] })

		const result = await store.queryGraph({ text: '部署', limit: 1, hops: 1 })
		assert.deepEqual(Object.keys(result).sort(), ['cards', 'graph', 'related'])

		// 词面命中排在关系命中前面：邻居可以进列表，但不能挤掉真正匹配的卡。
		assert.equal(result.cards.length, 1)
		assert.equal(result.cards[0].id, seed.id)
		assert.equal(result.cards[0].description, '本机部署的步骤和禁忌')
		assert.deepEqual(result.cards[0].degree, { in: 1, out: 0 }, '卡片 degree 仍是全库入/出链数')

		// 一跳邻居在 related 里；二跳的 far 不在（hops=1），无关卡也进不来。
		assert.deepEqual(ids(result.related), [neighbour.id])
		const related = result.related[0]
		assert.deepEqual(Object.keys(related).sort(), ['degree', 'description', 'id', 'label', 'score', 'tags'])
		assert.equal(related.label, '回滚脚本')
		assert.equal(related.description, '')
		assert.deepEqual(related.tags, ['践行/工作流'])
		assert.deepEqual(related.degree, { in: 1, out: 1 })
		assert.ok(related.score > 0 && related.score <= 1)

		// 子图节点按 rank 顺序排列；节点 degree 是候选库内的邻居数，不是入/出链。
		assert.deepEqual(ids(result.graph.nodes), [seed.id, neighbour.id])
		for (const node of result.graph.nodes) {
			assert.deepEqual(Object.keys(node).sort(), ['degree', 'description', 'id', 'label'])
		}
		assert.equal(result.graph.nodes[0].label, '部署方式')
		assert.deepEqual(result.graph.nodes.map((node) => node.degree), [1, 2])
		assert.deepEqual(result.graph.edges.map(ends), [[seed.id, neighbour.id].sort()])
		assert.equal(ids(result.graph.nodes).includes(far.id), false)
	} finally {
		await cleanup(dir, store)
	}
});

test('queryGraph：hops 控制扩散距离，两跳邻居只在 hops=2 出现', async () => {
	const { dir, store } = await fixture()
	try {
		const seed = await store.put({ body: '# 部署方式\n\n部署走 SSH。', tags: ['即兴'] })
		const mid = await store.put({ body: '# 中间卡\n\n链接到起点。', tags: ['即兴'], links: [seed.id] })
		const far = await store.put({ body: '# 远处卡\n\n指向中间卡。', tags: ['即兴'], links: [mid.id] })

		const oneHop = await store.queryGraph({ text: '部署', limit: 1, hops: 1 })
		assert.deepEqual(ids(oneHop.related), [mid.id])
		assert.equal(ids(oneHop.related).includes(far.id), false)
		assert.deepEqual(ids(oneHop.graph.nodes), [seed.id, mid.id])

		const twoHops = await store.queryGraph({ text: '部署', limit: 1, hops: 2 })
		assert.deepEqual(ids(twoHops.related), [mid.id, far.id], '两跳时更远的邻居也出现，且按关系分排序')
		assert.deepEqual(ids(twoHops.graph.nodes), [seed.id, mid.id, far.id])
		assert.equal(twoHops.graph.edges.length, 2)
		assert.deepEqual(
			new Set(twoHops.graph.edges.map((edge) => ends(edge).join('|'))),
			new Set([
				[seed.id, mid.id].sort().join('|'),
				[mid.id, far.id].sort().join('|'),
			]),
		)
	} finally {
		await cleanup(dir, store)
	}
});

test('queryGraph：within 做二次搜索，候选集与子图都被限定在给定 id 内', async () => {
	const { dir, store } = await fixture()
	try {
		const seed = await store.put({ body: '# 部署方式\n\n部署走 SSH。', tags: ['践行/经验'] })
		const left = await store.put({ body: '# 左侧邻居\n\n链接到起点卡。', tags: ['践行/经验'] })
		const right = await store.put({ body: '# 右侧邻居\n\n也链接到起点卡。', tags: ['践行/经验'] })
		await store.put({ body: '# 另外的一张\n\n不参与这次搜索。', tags: ['践行/经验'] })
		// 先把链接补上（写入时目标必须已存在）。
		await store.put({ ...seed, links: [left.id, right.id] })

		const whole = await store.queryGraph({ text: '部署', limit: 1, hops: 1 })
		assert.deepEqual(new Set(ids(whole.related)), new Set([left.id, right.id]))

		// 只在 seed + left 的子图里搜：right 即使在原图里是一跳邻居也不能进来。
		const scoped = await store.queryGraph({ text: '部署', limit: 1, within: [seed.id, left.id] })
		assert.deepEqual(ids(scoped.cards), [seed.id])
		assert.deepEqual(ids(scoped.related), [left.id])
		assert.deepEqual(ids(scoped.graph.nodes), [seed.id, left.id])
		assert.deepEqual(scoped.graph.edges.map(ends), [[seed.id, left.id].sort()])

		// 没有文本时 within 也是列表范围：返回给定子集，related 为空。
		const listed = await store.queryGraph({ within: [left.id, right.id] })
		assert.deepEqual(new Set(ids(listed.cards)), new Set([left.id, right.id]))
		assert.deepEqual(listed.related, [])
		assert.deepEqual(new Set(ids(listed.graph.nodes)), new Set([left.id, right.id]))
	} finally {
		await cleanup(dir, store)
	}
});

test('queryGraph：没有文本时按 list 的顺序返回过滤后的卡，related 为空', async () => {
	const { dir, store } = await fixture()
	try {
		const first = await store.put({ body: '# 第一张\n\n正文。', tags: ['践行/经验'] })
		const second = await store.put({ body: '# 第二张\n\n正文。', tags: ['践行/经验'] })
		await store.put({ body: '# 第三张\n\n正文。', tags: ['践行/经验'] })
		await store.put({ body: '# 别的枝干\n\n不该出现。', tags: ['见闻/事实'] })
		await store.put({ ...second, links: [first.id] })

		const result = await store.queryGraph({ tags: ['践行/经验'], limit: 10 })
		const listed = store.list({ tags: ['践行/经验'], limit: 10 })
		assert.deepEqual(ids(result.cards), ids(listed), '无文本时就是按标签列出的过滤结果，顺序一致')
		assert.equal(result.cards.length, 3)
		assert.equal(result.cards.every((card) => card.degree !== undefined), true)
		assert.deepEqual(result.related, [])
		assert.deepEqual(ids(result.graph.nodes), ids(result.cards))
		// 图里只保留两端都在结果内的边。
		assert.equal(result.graph.edges.length, 1)
		assert.deepEqual(result.graph.edges.map(ends), [[first.id, second.id].sort()])
	} finally {
		await cleanup(dir, store)
	}
});

test('queryGraph：标签与归档过滤同样作用于候选集，双链带不进范围外的卡', async () => {
	const { dir, store } = await fixture()
	try {
		const seed = await store.put({ body: '# 部署方式\n\n部署走 SSH。', tags: ['践行/经验'] })
		const archived = await store.put({ body: '# 已归档的邻居\n\n指向起点卡。', tags: ['践行/经验'], links: [seed.id] })
		const otherTag = await store.put({ body: '# 见闻邻居\n\n也指向起点卡。', tags: ['见闻/事实'], links: [seed.id] })
		await store.archive(archived.id)

		const filtered = await store.queryGraph({ text: '部署', limit: 1, tags: ['践行/经验'] })
		assert.deepEqual(ids(filtered.cards), [seed.id])
		assert.deepEqual(filtered.related, [], '归档卡和标签外的卡都不能通过双链进来')
		assert.deepEqual(ids(filtered.graph.nodes), [seed.id])
		assert.deepEqual(filtered.graph.edges, [])

		// includeArchived 才把归档卡放回候选集，此时它作为一跳邻居出现。
		const withArchived = await store.queryGraph({ text: '部署', limit: 1, tags: ['践行/经验'], includeArchived: true })
		assert.deepEqual(new Set(ids(withArchived.related)), new Set([archived.id]))
		assert.equal(ids(withArchived.related).includes(otherTag.id), false, '标签过滤不因 includeArchived 而放宽')
	} finally {
		await cleanup(dir, store)
	}
});

test('queryGraph：related 最多 8 张，图里只出现 cards + related 的并集', async () => {
	const { dir, store } = await fixture()
	try {
		const seed = await store.put({ body: '# 部署方式\n\n部署走 SSH。', tags: ['见闻/事实'] })
		const neighbours = []
		for (let index = 1; index <= 10; index += 1) {
			neighbours.push(await store.put({
				body: `# 邻居 ${index}\n\n指向起点卡。`,
				tags: ['见闻/事实'],
				links: [seed.id],
			}))
		}
		const result = await store.queryGraph({ text: '部署', limit: 1, hops: 1 })
		assert.deepEqual(ids(result.cards), [seed.id])
		assert.equal(result.related.length, 8)
		const returned = new Set([...ids(result.cards), ...ids(result.related)])
		assert.deepEqual(new Set(ids(result.graph.nodes)), returned)
		assert.equal(result.graph.edges.length, 8)
		assert.equal(neighbours.some((card) => ids(result.graph.nodes).includes(card.id)), true)
	} finally {
		await cleanup(dir, store)
	}
});

test('agent.query：图模式返回对象并把 related 记进访问账，非图模式仍是数组', async () => {
	const { dir, store } = await fixture()
	try {
		const seed = await store.put({
			body: '# 部署方式\n\n部署走 SSH。',
			tags: ['践行/经验'],
			description: '部署步骤',
		})
		const neighbour = await store.put({ body: '# 回滚脚本\n\n回滚前备份。', tags: ['践行/工作流'], links: [seed.id] })
		const agent = createCardAgent(store)

		// 图模式先跑：访问账的第一次写入是立即落盘的，正好能验证 related 也被记账。
		const graph = await agent.query({ text: '部署', limit: 1, graph: true })
		assert.equal(Array.isArray(graph), false)
		assert.deepEqual(Object.keys(graph).sort(), ['cards', 'graph', 'related'])
		assert.equal(graph.cards[0].id, seed.id)
		assert.equal(Object.hasOwn(graph.cards[0], 'description'), true)
		assert.equal(Object.hasOwn(graph.related[0], 'description'), true)
		const stats = await accessStats(dir)
		assert.ok(stats.ids[seed.id], '命中卡记了访问')
		assert.ok(stats.ids[neighbour.id], 'related 邻居同样记了访问')

		// within 非空也自动走图模式，不需要再传 graph。
		const scoped = await agent.query({ text: '部署', within: [seed.id, neighbour.id] })
		assert.equal(Array.isArray(scoped), false)
		assert.equal(scoped.cards.length, 2)

		// 普通搜索保持数组返回值：现有调用方（面板、工具）依赖这个形状。
		const flat = await agent.query({ text: '部署' })
		assert.equal(Array.isArray(flat), true)
		assert.deepEqual(flat[0].degree, { in: 1, out: 0 })
	} finally {
		await cleanup(dir, store)
	}
});

test('card_query 工具：graph/hops/within 参数透传，普通模式保持 {total, results}', async () => {
	const { dir, store } = await fixture()
	try {
		const seed = await store.put({ body: '# 部署方式\n\n部署走 SSH。', tags: ['践行/经验'] })
		const neighbour = await store.put({ body: '# 回滚脚本\n\n回滚前备份。', tags: ['践行/工作流'], links: [seed.id] })
		const tools = createTools({ cards: createCardAgent(store) })
		const tool = tools.find((entry) => entry.name === 'card_query')
		assert.equal(tool.parameters.properties.graph.type, 'boolean')
		assert.equal(tool.parameters.properties.hops.type, 'integer')
		assert.equal(tool.parameters.properties.within.type, 'array')
		assert.match(tool.description, /先普通搜/)
		assert.match(tool.description, /within/)

		const flat = await tool.execute({ query: '部署' })
		assert.deepEqual(Object.keys(flat).sort(), ['results', 'total'])
		assert.equal(Array.isArray(flat.results), true)
		assert.equal(flat.results[0].degree !== undefined, true)

		const listed = await tool.execute({ tags: ['践行/经验'] })
		assert.equal(Array.isArray(listed.results), true, '不带 query 时仍是普通列表')

		const graph = await tool.execute({ query: '部署', limit: 1, graph: true })
		assert.deepEqual(Object.keys(graph).sort(), ['cards', 'graph', 'related', 'total'])
		assert.equal(graph.total, 1)
		assert.equal(graph.cards[0].id, seed.id)
		assert.deepEqual(ids(graph.related), [neighbour.id])
		assert.equal(graph.graph.nodes.length, 2)

		const scoped = await tool.execute({ query: '部署', within: [seed.id] })
		assert.deepEqual(Object.keys(scoped).sort(), ['cards', 'graph', 'related', 'total'])
		assert.equal(scoped.related.length, 0, 'within 只剩一张卡时没有可扩散的邻居')
	} finally {
		await cleanup(dir, store)
	}
});
