/**
 * The daily health card: the two numbers that tell whether the library is
 * getting easier to use or harder.
 *
 * The counts are pure, so they are pinned directly; the job is pinned on the
 * things that used to go wrong with jobs like this — writing the same day
 * twice, and letting the card grow without bound.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CardStore } from '../src/cards/store.js'
import { MAX_ROWS, REPORT_TITLE, healthMetrics, renderReport } from '../src/cards/health.js'
import { createHealthJob } from '../src/health.js'

/**
 * A card store on a temporary folder.
 *
 * @returns {Promise<object>} The store and its folder.
 */
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), 'evr-health-'))
	const store = new CardStore({ dataDir: dir })
	await store.init()
	return { dir, store }
}

test('健康度只数活卡：即兴积压、出链、入链和孤岛', () => {
	const cards = [
		// Filed nowhere: only the fleeting branch.
		{ id: 'a', tags: ['即兴'], links: [] },
		// Filed, but the fleeting tag is still there — counts as backlog, not as unfiled.
		{ id: 'b', tags: ['即兴', '复盘/踩坑'], links: ['a'] },
		{ id: 'c', tags: ['践行/经验'], links: [] },
		// Archived: out of the way, so it neither dilutes the tree nor needs links.
		{ id: 'd', tags: ['践行/经验', '践行/归档'], links: [] },
		// A link to a card that is not there is not a connection.
		{ id: 'e', tags: ['见闻/事实'], links: ['card-01M72KRG4VQEQQ25BM3DTHB97X'] },
	]
	const metrics = healthMetrics(cards, { a: ['b'] })
	assert.deepEqual(metrics, { cards: 4, fleeting: 2, unfiled: 1, outbound: 1, inbound: 1, islands: 2 })
})

test('日报正文保留两周，且标题恒定', () => {
	const rows = Array.from({ length: MAX_ROWS + 3 }, (_, index) => ({
		date: `2026-11-${String(index + 1).padStart(2, '0')}`,
		cards: 10,
		fleeting: index,
		unfiled: 0,
		outbound: 2,
		inbound: 1,
		islands: 5,
	}))
	const body = renderReport(rows.slice(-MAX_ROWS))
	assert.match(body, new RegExp(REPORT_TITLE))
	assert.equal(body.split('\n').filter((line) => /^\d\d-\d\d/.test(line)).length, MAX_ROWS)
	assert.match(body, /即兴 = ?|\u5373\u5174/)
})

test('每天只写一行，卡片是同一张', async () => {
	const { dir, store } = await fixture()
	let clock = new Date(2026, 10, 11, 10, 0, 0).getTime()
	const job = createHealthJob({ store: () => store, now: () => clock })
	try {
		await store.put({ body: '一张即兴卡', tags: ['即兴'] })
		await store.put({ body: '一张归好枝干的卡', tags: ['践行/经验'] })
		const first = await job.runNow()
		assert.equal(first.cards, 2, '第一次运行时还没有日报卡')
		assert.equal(first.fleeting, 1)
		assert.equal(first.unfiled, 1)
		// A second run on the same day replaces the row instead of adding one.
		await store.put({ body: '又一张卡', tags: ['即兴', '见闻/事实'] })
		clock += 60 * 60 * 1000
		await job.runNow()
		const ledger = JSON.parse(await readFile(join(dir, 'knowledge', 'health.json'), 'utf8'))
		assert.equal(ledger.rows.length, 1, '同一天只有一行')
		assert.equal(ledger.rows[0].cards, 3, '日报卡自己不算进去')
		const card = store.get(ledger.cardId)
		assert.match(card.body, new RegExp(REPORT_TITLE))
		assert.equal(store.all().filter((item) => item.label.startsWith(REPORT_TITLE)).length, 1, '只有一张日报卡')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('日报只在设定时间之后写，且不并发', async () => {
	const { dir, store } = await fixture()
	try {
		await store.put({ body: '一张卡', tags: ['践行/经验'] })
		const early = createHealthJob({ store: () => store, now: () => new Date(2026, 10, 11, 7, 0, 0).getTime() })
		assert.equal(await early.check(), null, '早于 REPORT_HOUR 不写')
		const late = createHealthJob({ store: () => store, now: () => new Date(2026, 10, 11, 10, 0, 0).getTime() })
		const [one, two] = await Promise.allSettled([late.runNow(), late.runNow()])
		const results = [one, two].filter((entry) => entry.status === 'fulfilled')
		assert.equal(results.length, 1, '同时只跑一个')
		assert.equal(await late.check(), null, '当天已经写过')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('当天接了缓存数据就把命中与重建写进表格', async () => {
	const { dir, store } = await fixture()
	let clock = new Date(2026, 10, 14, 10, 0, 0).getTime()
	const job = createHealthJob({
		store: () => store,
		now: () => clock,
		cache: async (day) => ({ sessions: 2, hit: 97.42, misses: 0, day }),
	})
	try {
		await store.put({ body: '一张卡', tags: ['践行/经验'] })
		await job.runNow()
		clock += 24 * 60 * 60 * 1000
		await job.runNow()
		const ledger = JSON.parse(await readFile(join(dir, 'knowledge', 'health.json'), 'utf8'))
		assert.equal(ledger.rows.length, 2)
		assert.equal(ledger.rows[0].cacheMisses, 0)
		assert.equal(Math.round(ledger.rows[0].cacheHit), 97)
		const body = store.get(ledger.cardId).body
		assert.match(body, /提示词缓存 97%，重建 0 次/)
		assert.match(body, /命中  重建/)
		// Two rows keep their positions; the newest is last.
		assert.match(body, /11-14.*97%/)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('拿不到缓存数据时这两列留空，不写 0 冒充', async () => {
	const { dir, store } = await fixture()
	try {
		await store.put({ body: '一张卡', tags: ['践行/经验'] })
		const job = createHealthJob({ store: () => store, now: () => new Date(2026, 10, 14, 10).getTime() })
		await job.runNow()
		const ledger = JSON.parse(await readFile(join(dir, 'knowledge', 'health.json'), 'utf8'))
		assert.equal(ledger.rows[0].cacheHit, undefined)
		const body = store.get(ledger.cardId).body
		// The footer always explains the columns; what must be absent is the
		// summary sentence that would claim a number we do not have.
		assert.equal(/提示词缓存 \d+%/.test(body), false)
		assert.match(body, /—/) // 表格里的空列
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})
