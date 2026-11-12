/**
 * The daily snapshot behind the injected card index.
 *
 * The index is a cache with one writer (the daily run) and one reader (the
 * synchronous prompt callback), so what it has to pin is: the file is written
 * once per day and not rewritten when nothing moved, a missing/stale/broken
 * file degrades to a live ranking instead of failing, and the model's summary
 * outranks the deterministic floor without ever exceeding its budget.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
	cardIndexPath,
	INDEX_FILE,
	INDEX_VERSION,
	MAX_SUMMARY_CHARS,
	MAX_TOP_CARDS,
	readCardIndex,
	refreshCardIndex,
} from '../src/cards/injection-index.js'
import { cardIndexText } from '../src/cards/prompt.js'
import { CardStore } from '../src/cards/store.js'

/** Milliseconds in one day. */
const DAY_MS = 24 * 60 * 60 * 1000

/** A fixed clock: noon UTC, so every time zone is on the same calendar day. */
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0)

/** A temporary card store. */
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), 'evr-index-'))
	const store = new CardStore({ dataDir: dir })
	await store.init()
	return { dir, store }
}

/**
 * Add a card with a link to the previous one.
 *
 * @param {CardStore} store - The store.
 * @param {number} index - Position, used for the body.
 * @param {string[]} [links] - Outgoing links.
 * @returns {Promise<object>} The card.
 */
async function card(store, index, links = []) {
	return store.put({
		body: `第 ${index} 张卡，讲一件和检索有关的事`,
		description: `第 ${index} 张卡的一句话说明`,
		tags: ['践行/经验'],
		links,
	})
}

test('快照写进 knowledge/index.json：卡片按关系数排序，摘要是一段话', async () => {
	const { dir, store } = await fixture()
	try {
		const first = await card(store, 0)
		const hub = await card(store, 1, [first.id])
		const leaf = await card(store, 2, [hub.id])
		await refreshCardIndex(store, NOW)
		const path = cardIndexPath(store)
		assert.equal(path, join(dir, 'knowledge', INDEX_FILE))
		const parsed = JSON.parse(await readFile(path, 'utf8'))
		assert.equal(parsed.version, INDEX_VERSION)
		assert.equal(parsed.topCards.length, 3)
		// hub is linked from both sides, so it is the card the index names first.
		assert.equal(parsed.topCards[0].id, hub.id)
		assert.equal(parsed.topCards[0].degree, 2)
		// 注入用短 id（唯一后缀），工具接受它。
		assert.equal(parsed.topCards[0].short, hub.id.slice(-5))
		assert.match(parsed.summary, /共 3 张卡/)
		// The injected block is the snapshot, not a live ranking.
		const text = cardIndexText(store)
		assert.equal(text.includes(hub.id), false, '注入不带完整 id')
		assert.equal(text.includes(hub.id.slice(-5)), true, '注入带唯一短 id')
		assert.match(text, /\[知识结构\]/)
		assert.equal(text.includes(leaf.id.slice(-5)), true)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('正文没变时重写不落盘：凌晨重跑不会给缓存制造无谓失效', async () => {
	const { dir, store } = await fixture()
	try {
		await card(store, 0)
		await card(store, 1, [])
		await refreshCardIndex(store, NOW)
		const path = cardIndexPath(store)
		const first = await readFile(path, 'utf8')
		// A second tick on the same day would only differ in `at`.
		await refreshCardIndex(store, NOW + 60_000)
		assert.equal(await readFile(path, 'utf8'), first)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('过期、损坏与外来形状都读成 null，注入因此能回退', async () => {
	const { dir, store } = await fixture()
	try {
		await card(store, 0)
		await card(store, 1)
		const path = cardIndexPath(store)
		const write = async (value) => {
			await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
			return readCardIndex(store, NOW)
		}
		assert.equal(await write('{ 不是 json'), null)
		assert.equal(await write({ version: INDEX_VERSION - 1, day: 'x' }), null)
		// A snapshot from another day is not trusted: "today" is the point.
		const today = await refreshCardIndex(store, NOW)
		assert.notEqual(today, null)
		const parsed = JSON.parse(await readFile(path, 'utf8'))
		assert.equal(readCardIndex(store, NOW + DAY_MS), null)
		assert.equal(readCardIndex(store, NOW)?.day, parsed.day)

		// Broken or missing, the prompt still renders from the live library.
		await write('{')
		const text = cardIndexText(store)
		assert.match(text, /\[卡片索引\]/)
		assert.match(text, /\[知识结构\]/)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('索引最多点名 12 张卡；模型写的一整段摘要覆盖确定性摘要', async () => {
	const { dir, store } = await fixture()
	try {
		for (let index = 0; index < 20; index += 1) await card(store, index)
		await refreshCardIndex(store, NOW, { summary: '这张库主要讲检索与注入，最近在长践行经验。' })
		const index = readCardIndex(store, NOW)
		assert.equal(index.topCards.length, MAX_TOP_CARDS)
		assert.equal(index.summary, '这张库主要讲检索与注入，最近在长践行经验。')
		const text = cardIndexText(store)
		assert.match(text, /这张库主要讲检索与注入/)
		// Over-long summaries are cut, never propagated into the prompt whole.
		await refreshCardIndex(store, NOW, { summary: '长'.repeat(MAX_SUMMARY_CHARS + 200) })
		assert.equal(readCardIndex(store, NOW).summary.length, MAX_SUMMARY_CHARS)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('没有快照时用实时排序；注入路径从不写盘', async () => {
	const { dir, store } = await fixture()
	try {
		await card(store, 0)
		await card(store, 1, [])
		const path = cardIndexPath(store)
		await assert.rejects(() => stat(path))
		const text = cardIndexText(store)
		assert.equal(text.includes('卡片索引'), true)
		assert.equal(text.includes('[知识结构]'), true)
		// Reading the prompt must never create the snapshot: it is written by
		// the daily run and by nothing else.
		await assert.rejects(() => stat(path))
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})
