/**
 * Navigation: following links, and the access ledger behind it.
 *
 * The card model only stores outgoing links; "这张卡被谁引用" is computed at
 * read time. These cases pin the two additions that make that model usable —
 * `neighbors` on one read and `degree` on a query — plus the graph numbers the
 * review reports, so a library of islands cannot look healthy.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { accessPath, accessStats, createAccessLog, topAccessed } from '../src/cards/access.js'
import { createCardAgent } from '../src/cards/agent.js'
import { CardStore } from '../src/cards/store.js'
import { createTools } from '../src/tools.js'

/**
 * A card store on a temporary folder.
 *
 * @returns {Promise<{dir: string, store: CardStore}>} The fixture.
 */
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), 'evr-nav-'))
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

test('访问记账：第一次读立刻落盘，之后按 30 秒 / 20 次节流', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-access-'))
	const clock = { value: Date.parse('2026-11-12T00:00:00.000Z') }
	const log = createAccessLog({ dataDir: dir, now: () => clock.value })
	try {
		assert.deepEqual(await accessStats(dir), { version: 1, ids: {} }, '没有访问时是空账')

		// The first access of a process is written immediately: a session that
		// reads one card and ends still leaves a trace.
		await log.recordAccess(['card-a'])
		let stats = await accessStats(dir)
		assert.deepEqual(stats.ids['card-a'], { count: 1, lastAt: '2026-11-12T00:00:00.000Z' })

		// Inside the window the next read only accumulates in memory.
		await log.recordAccess(['card-a'])
		assert.equal(await log.flushAccess(), false, '30 秒内不落盘')
		stats = await accessStats(dir)
		assert.equal(stats.ids['card-a'].count, 1)

		// Thirty seconds later the next read writes the pending access too.
		clock.value += 30_000
		await log.recordAccess(['card-a'])
		stats = await accessStats(dir)
		assert.equal(stats.ids['card-a'].count, 3)
		assert.equal(stats.ids['card-a'].lastAt, '2026-11-12T00:00:30.000Z')

		// Twenty pending accesses force a write without waiting for the clock.
		const batch = Array.from({ length: 20 }, (_, index) => `card-batch-${index}`)
		for (const id of batch) await log.recordAccess([id])
		stats = await accessStats(dir)
		assert.equal(batch.every((id) => stats.ids[id]?.count === 1), true, '20 次变更直接触发落盘')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('访问记账：force 落盘合并磁盘上已有的计数，坏文件当空账', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-access-'))
	try {
		await mkdir(join(dir, 'knowledge'), { recursive: true })
		await writeFile(accessPath(dir), JSON.stringify({
			version: 1,
			ids: { 'card-old': { count: 4, lastAt: '2026-11-01T00:00:00.000Z' } },
		}))
		const log = createAccessLog({ dataDir: dir })
		await log.recordAccess(['card-old'])
		await log.recordAccess(['card-old'])
		assert.equal(await log.flushAccess({ force: true }), true)
		const stats = await accessStats(dir)
		assert.equal(stats.ids['card-old'].count, 6, '旧计数保留，新访问累加')

		// A corrupt ledger is "no access recorded", never an error.
		await writeFile(accessPath(dir), '{ 这不是 JSON')
		assert.deepEqual(await accessStats(dir), { version: 1, ids: {} })
		assert.deepEqual(await topAccessed(dir), [])
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('访问记账：topAccessed 按次数、最近访问、id 稳定排序并过滤坏条目', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-access-'))
	try {
		await mkdir(join(dir, 'knowledge'), { recursive: true })
		await writeFile(accessPath(dir), JSON.stringify({
			version: 1,
			ids: {
				'card-a': { count: 2, lastAt: '2026-11-10T00:00:00.000Z' },
				'card-b': { count: 5, lastAt: '2026-11-10T00:00:00.000Z' },
				'card-c': { count: 5, lastAt: '2026-11-11T00:00:00.000Z' },
				'card-bad': null,
				'card-neg': { count: -3, lastAt: '' },
				'card-text': { count: '很多', lastAt: '' },
			},
		}))
		const stats = await accessStats(dir)
		assert.deepEqual(Object.keys(stats.ids).sort(), ['card-a', 'card-b', 'card-c'])
		assert.deepEqual((await topAccessed(dir, 2)).map((entry) => entry.id), ['card-c', 'card-b'])
		assert.deepEqual((await topAccessed(dir, 10)).map((entry) => entry.id), ['card-c', 'card-b', 'card-a'])
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('card_read：neighbors 给出出链与入链，缺失目标标 (missing)，按描述排序并截断', async () => {
	const { dir, store } = await fixture()
	try {
		const agent = createCardAgent(store)
		const targets = []
		for (let index = 1; index <= 12; index += 1) {
			const number = String(index).padStart(2, '0')
			targets.push(await store.put({
				body: `# 目标 ${number}\n\n正文`,
				description: `目标 ${number}`,
				tags: ['见闻/事实'],
			}))
		}
		const hub = await store.put({
			body: '# 枢纽\n\n链接所有目标',
			description: '链接了所有目标卡的枢纽',
			tags: ['见闻/事实'],
			links: targets.map((card) => card.id),
		})
		await store.put({ body: '# 来源 A\n\n指向枢纽', description: '来源 A', tags: ['见闻/事实'], links: [hub.id] })
		await store.put({ body: '# 来源 B\n\n指向枢纽', description: '来源 B', tags: ['见闻/事实'], links: [hub.id] })

		const read = await agent.read(hub.id, { neighbors: true })
		assert.equal(read.neighbors.out.length, 10, '出链最多 10 条')
		assert.deepEqual(read.neighbors.out.map((card) => card.description), [
			'目标 01', '目标 02', '目标 03', '目标 04', '目标 05',
			'目标 06', '目标 07', '目标 08', '目标 09', '目标 10',
		], '按描述排序后再截断')
		assert.deepEqual(read.neighbors.in.map((card) => card.description), ['来源 A', '来源 B'])
		assert.deepEqual(Object.keys(read.neighbors.out[0]).sort(), ['description', 'id', 'tags'])

		// Without the flag the neighbourhood is not computed, let alone paid for.
		const plain = await agent.read(hub.id)
		assert.equal(Object.hasOwn(plain, 'neighbors'), false)

		// A link whose target was deleted since it was written stays visible:
		// the trail ends, and a silently shorter list would read as "nothing".
		const doomed = await store.put({ body: '# 会被删掉', tags: ['见闻/事实'] })
		const pointer = await store.put({ body: '# 指向死链', tags: ['见闻/事实'], links: [doomed.id] })
		await store.remove(doomed.id)
		const dangling = await agent.read(pointer.id, { neighbors: true })
		assert.deepEqual(dangling.neighbors.out, [{ id: doomed.id, description: '', tags: [] }])
	} finally {
		await cleanup(dir, store)
	}
})

test('card_query：每张卡带 degree（入链 / 出链数）', async () => {
	const { dir, store } = await fixture()
	try {
		const agent = createCardAgent(store)
		const leaf = await store.put({ body: '# 叶子', tags: ['见闻/事实'] })
		const middle = await store.put({ body: '# 中间', tags: ['见闻/事实'], links: [leaf.id] })
		const top = await store.put({ body: '# 顶部', tags: ['见闻/事实'], links: [middle.id, leaf.id] })

		const found = await agent.query({ tags: ['见闻/事实'] })
		const degree = new Map(found.map((card) => [card.id, card.degree]))
		assert.deepEqual(degree.get(leaf.id), { in: 2, out: 0 })
		assert.deepEqual(degree.get(middle.id), { in: 1, out: 1 })
		assert.deepEqual(degree.get(top.id), { in: 0, out: 2 })
	} finally {
		await cleanup(dir, store)
	}
})

test('evolve_review：链接图只算活跃卡之间的边，孤岛率超过三成时提示补链', async () => {
	const { dir, store } = await fixture()
	try {
		const b = await store.put({ body: '# B', description: 'B', tags: ['见闻/事实'] })
		const c = await store.put({ body: '# C', description: 'C', tags: ['见闻/事实'] })
		await store.put({ body: '# A', tags: ['见闻/事实'], links: [b.id, c.id] })
		await store.put({ body: '# E', tags: ['见闻/事实'], links: [c.id] })
		const d = await store.put({ body: '# D', tags: ['见闻/事实'] })

		const review = await createCardAgent(store).review()
		assert.equal(review.graph.cards, 5)
		assert.equal(review.graph.links, 3)
		assert.equal(review.graph.density, 3 / (5 * 4))
		assert.equal(review.graph.orphans, 1)
		assert.equal(review.graph.orphanRatio, 1 / 5)
		assert.deepEqual(review.graph.hubs.map((hub) => [hub.description, hub.in]), [['C', 2], ['B', 1]])
		assert.equal(review.hints.some((hint) => hint.includes('孤岛率')), false, '孤岛率不高时不说')

		// Archived cards are out of the graph: their links no longer count.
		await store.archive(d.id)
		const archived = await createCardAgent(store).review()
		assert.equal(archived.graph.cards, 4)
		assert.equal(archived.graph.orphans, 0)
		assert.equal(archived.graph.orphanRatio, 0)
		assert.equal(archived.graph.density, 3 / (4 * 3))

		// The metrics are recomputed on every review, so cards written after
		// the first call are counted instead of answering from a cache.
		const pair = await store.put({ body: '# 有链接的卡', tags: ['见闻/事实'] })
		await store.put({ body: '# 指向它', tags: ['见闻/事实'], links: [pair.id] })
		await store.put({ body: '# 孤岛', tags: ['见闻/事实'] })
		const islandy = await createCardAgent(store).review()
		assert.equal(islandy.graph.cards, 7)
		assert.equal(islandy.graph.orphans, 1)
		assert.equal(islandy.graph.orphanRatio, 1 / 7)
	} finally {
		await cleanup(dir, store)
	}
})

test('evolve_review：孤岛率超过三成时 hint 说先补链', async () => {
	const { dir, store } = await fixture()
	try {
		const linked = await store.put({ body: '# 有链接的卡', tags: ['见闻/事实'] })
		await store.put({ body: '# 指向它', tags: ['见闻/事实'], links: [linked.id] })
		await store.put({ body: '# 孤岛', tags: ['见闻/事实'] })
		const review = await createCardAgent(store).review()
		assert.equal(review.graph.orphans, 1)
		assert.equal(review.graph.orphanRatio, 1 / 3)
		assert.match(review.hints.join('\n'), /孤岛率 33%：先补链，跳转才成立/)
	} finally {
		await cleanup(dir, store)
	}
})

test('工具层：card_read 透出 neighbors，card_query 透出 degree', async () => {
	const { dir, store } = await fixture()
	try {
		const target = await store.put({ body: '# 目标卡', description: '目标卡', tags: ['见闻/事实'] })
		const source = await store.put({ body: '# 源卡', tags: ['见闻/事实'], links: [target.id] })
		const tools = createTools({ cards: createCardAgent(store) })
		const readTool = tools.find((tool) => tool.name === 'card_read')
		assert.equal(readTool.parameters.properties.neighbors.type, 'boolean')

		const plain = await readTool.execute({ id: source.id })
		assert.equal(Object.hasOwn(plain, 'neighbors'), false, '默认不附带邻居')
		const withNeighbors = await readTool.execute({ id: source.id, neighbors: true })
		assert.deepEqual(withNeighbors.neighbors.out, [{ id: target.id, description: '目标卡', tags: ['见闻/事实'] }])

		const queryTool = tools.find((tool) => tool.name === 'card_query')
		const queried = await queryTool.execute({ tags: ['见闻/事实'] })
		assert.equal(queried.results.length, 2)
		assert.equal(queried.results.every((card) => card.degree !== undefined), true)
	} finally {
		await cleanup(dir, store)
	}
})

test('agent 的 read / query 会把命中的卡片记进访问账', async () => {
	const { dir, store } = await fixture()
	try {
		const agent = createCardAgent(store)
		const first = await store.put({ body: '# 第一张', tags: ['见闻/事实'] })
		const second = await store.put({ body: '# 第二张', tags: ['见闻/事实'] })

		await agent.query({ tags: ['见闻/事实'] })
		let stats = await accessStats(dir)
		assert.equal(stats.ids[first.id]?.count, 1)
		assert.equal(stats.ids[second.id]?.count, 1)

		// The ledger is the documented JSON shape, not an internal map.
		const raw = JSON.parse(await readFile(accessPath(dir), 'utf8'))
		assert.deepEqual(Object.keys(raw).sort(), ['ids', 'version'])
		assert.equal(raw.version, 1)

		// A second read inside the throttle window is counted in memory but not
		// written again; the read itself must not fail or wait on a disk write.
		await agent.read(first.id)
		stats = await accessStats(dir)
		assert.equal(stats.ids[first.id].count, 1)

		const ranking = await topAccessed(dir, 2)
		assert.deepEqual(ranking.map((entry) => entry.id).sort(), [first.id, second.id].sort())
	} finally {
		await cleanup(dir, store)
	}
})
