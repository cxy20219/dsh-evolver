/**
 * The dreaming pass: access-aware batching and the repair round.
 *
 * These tests pin the parts the model must never be in charge of — which
 * cards are worth a review today, and the rot that needs no judgement at all
 * (a link to a card that no longer exists). The access ledger is written by
 * hand so the ranking is reproducible.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readCardIndex } from '../src/cards/injection-index.js'
import { CardStore } from '../src/cards/store.js'
import { createConsolidationController, refreshRepairs } from '../src/consolidate.js'
import { defaultConsolidate, defaultSettings } from '../src/settings.js'

/** One day, in milliseconds. */
const DAY_MS = 86_400_000

/** A fixed clock: the batch order must not depend on when the test runs. */
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0)

/** How many cards a fixture puts in one branch. */
const BRANCH_CARDS = 5

const modelSelection = { currentSelection: () => ({ provider: 'p', model: 'm' }) }

/**
 * Put a dead link back into a card's record, the way an imported or hand-edited
 * log can carry one. Deletion prunes links now, so the repair path needs a
 * record that never went through `remove`.
 *
 * @param {object} store - The card store.
 * @param {object} card - The card to point at a missing id.
 * @param {string} targetId - The id that no longer exists.
 * @returns {Promise<void>} Resolves once written.
 */
async function injectDanglingLink(store, card, targetId) {
	const record = store.records().find((item) => item.id === card.id)
	await store.cards.putMemory({
		...record,
		id: card.id,
		body: card.body,
		tags: card.tags,
		links: [targetId],
		updated: new Date(Date.now() + 1).toISOString(),
	})
}

/**
 * A card store plus a settings stub on a temporary folder.
 *
 * @param {object} [consolidate] - The consolidation settings.
 * @returns {Promise<{dir: string, store: CardStore, settings: object}>} The fixture.
 */
async function fixture(consolidate = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'evr-dreaming-'))
	const store = new CardStore({ dataDir: dir })
	await store.init()
	const state = { ...defaultSettings(), consolidate: { ...defaultConsolidate(), ...consolidate } }
	const settings = {
		get: () => state,
		update: async (patch) => {
			if (patch.consolidate !== undefined) state.consolidate = { ...state.consolidate, ...patch.consolidate }
			return state
		},
	}
	return { dir, store, settings }
}

/**
 * How a review ledger stamps a card last reviewed `days` ago.
 *
 * @param {number} days - Days before NOW.
 * @returns {string} The ISO timestamp.
 */
function reviewedDaysAgo(days) {
	return new Date(NOW - days * DAY_MS).toISOString()
}

/**
 * Write a fixed access ledger.
 *
 * @param {string} dir - The data folder.
 * @param {Record<string, {count: number, lastAt: string}>} ids - The counters.
 * @returns {Promise<void>} Resolves once written.
 */
async function writeAccess(dir, ids) {
	await mkdir(join(dir, 'knowledge'), { recursive: true })
	await writeFile(join(dir, 'knowledge', 'access.json'), JSON.stringify({ version: 1, ids }), 'utf8')
}

/**
 * A model stub that records the prompt and answers with one fixed text.
 *
 * @param {string} text - The reply.
 * @param {(prompt: string) => void} [onPrompt] - Called with the review input.
 * @returns {object} The `llm` service.
 */
function modelReturning(text, onPrompt) {
	return {
		async *stream(request) {
			onPrompt?.(request.messages?.[0]?.content?.[0]?.text ?? '')
			yield { type: 'text-delta', text }
			yield { type: 'finish', reason: { kind: 'stop' } }
		},
	}
}

/**
 * The card ids the prompt puts in today's batch, in order.
 *
 * @param {string} prompt - The review input.
 * @returns {string[]} The ids.
 */
function batchIds(prompt) {
	const section = String(prompt ?? '').split('今天要整理的卡片：')[1] ?? ''
	return [...section.matchAll(/^id: (card-[A-Z0-9]+)$/gm)].map((match) => match[1])
}

/**
 * Seed two cards reviewed at the same time, one of them hot.
 *
 * @param {object} fixtureState - The fixture from `fixture`.
 * @param {{hotReviewedDays?: number, coldReviewedDays?: number, hotLastAt?: string}} [options] - Seed overrides.
 * @returns {Promise<object>} The cards and settings.
 */
async function seedPair({ dir, store, settings }, { hotReviewedDays = 72, coldReviewedDays = 72, hotLastAt } = {}) {
	const hot = await store.put({ body: '经常被打开的热卡', tags: ['践行/经验'] })
	const cold = await store.put({ body: '没人打开的冷卡', tags: ['践行/经验'] })
	await store.saveConsolidationLedger({
		lastRunAt: '',
		dayKey: '',
		cards: {
			[hot.id]: reviewedDaysAgo(hotReviewedDays),
			[cold.id]: reviewedDaysAgo(coldReviewedDays),
		},
		attempts: { day: '', count: 0 },
	})
	if (hotLastAt !== undefined) await writeAccess(dir, { [hot.id]: { count: 9, lastAt: hotLastAt } })
	return { hot, cold, settings }
}

/**
 * Run one batch of `dailyCards` and report the picked ids.
 *
 * @param {object} deps - Store, settings and clock.
 * @param {object} deps.store - The card store.
 * @param {object} deps.settings - The settings stub.
 * @returns {Promise<string[]>} The batch ids, in order.
 */
async function picked({ store, settings }) {
	let prompt = ''
	const controller = createConsolidationController({
		settings,
		store: () => store,
		llm: modelReturning('{"actions":[]}', (text) => { prompt = text }),
		modelSelection,
		now: () => NOW,
	})
	await controller.run()
	return batchIds(prompt)
}

test('热卡让冷卡先被整理：两周内被读过的卡排到冷队列后面', async () => {
	const { dir, store, settings } = await fixture({ dailyCards: 1 })
	try {
		const { hot, cold } = await seedPair({ dir, store, settings }, {
			hotLastAt: new Date(NOW - 3_600_000).toISOString(),
		})
		assert.deepEqual(await picked({ store, settings }), [cold.id], '冷卡先整理')
		assert.notEqual(hot.id, cold.id)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('访问已经超过两周的卡不算热卡，排序回到原样', async () => {
	const { dir, store, settings } = await fixture({ dailyCards: 1 })
	try {
		const { hot } = await seedPair({ dir, store, settings }, {
			hotLastAt: new Date(NOW - 15 * DAY_MS).toISOString(),
		})
		assert.deepEqual(await picked({ store, settings }), [hot.id], '两周前读过就不降权')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('访问账损坏时按没有热卡处理，整理照常跑', async () => {
	const { dir, store, settings } = await fixture({ dailyCards: 1 })
	try {
		const { hot } = await seedPair({ dir, store, settings })
		await writeFile(join(dir, 'knowledge', 'access.json'), '这不是 JSON', 'utf8')
		assert.deepEqual(await picked({ store, settings }), [hot.id], '坏账本不让排序或运行失败')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('降权有上限：热卡已经比冷队列早 30 天以上时仍然正常优先', async () => {
	const { dir, store, settings } = await fixture({ dailyCards: 1 })
	try {
		// 120 天没复查的热卡被推迟 30 天后，仍比 61 天没复查的冷卡更欠整理。
		const { hot } = await seedPair({ dir, store, settings }, {
			hotReviewedDays: 120,
			coldReviewedDays: 61,
			hotLastAt: new Date(NOW - 3_600_000).toISOString(),
		})
		assert.deepEqual(await picked({ store, settings }), [hot.id], '热卡不会被无限推迟')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('修复轮清掉历史死链，正文和标签一个字不动', async () => {
	const { dir, store } = await fixture()
	try {
		const target = await store.put({ body: '将被删掉的目标卡', tags: ['践行/经验'] })
		const holder = await store.put({ body: '还指着幽灵卡的一条笔记', tags: ['践行/经验'], links: [target.id] })
		const clean = await store.put({ body: '没有链接的干净卡片', tags: ['践行/经验'] })
		await store.remove(target.id)
		// 删除会剪掉链接；这里模拟一份导入/手改过的历史日志，死链还在。
		await injectDanglingLink(store, holder, target.id)
		assert.deepEqual(store.get(holder.id).links, [target.id], '历史数据里死链还在')

		assert.deepEqual(await refreshRepairs(store), { repaired: 1, skipped: 0 })
		const repaired = store.get(holder.id)
		assert.deepEqual(repaired.links, [], '死链没了')
		assert.equal(repaired.body, '还指着幽灵卡的一条笔记', '修复不是改写')
		assert.deepEqual(repaired.tags, ['践行/经验'])
		assert.deepEqual(store.get(clean.id).links, [])
		// 干净之后再跑一遍是空操作。
		assert.deepEqual(await refreshRepairs(store), { repaired: 0, skipped: 0 })
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('同一轮多张卡可以落进同一个新建枝干，第二个新枝干仍被挡下', async () => {
	const { dir, store, settings } = await fixture({ dailyCards: 15 })
	try {
		const inbox = []
		for (let index = 0; index < BRANCH_CARDS; index += 1) {
			inbox.push(await store.put({ body: `收件箱里的卡片 ${index}`, tags: ['即兴'] }))
		}
		const extra = await store.put({ body: '想再建第二个枝干的卡片', tags: ['即兴'] })
		const actions = [
			...inbox.map((card) => ({ op: 'retag', id: card.id, tags: ['践行/新枝干'], reason: '#即兴 → #践行/新枝干' })),
			{ op: 'retag', id: extra.id, tags: ['见闻/另一个枝干'], reason: '#即兴 → #见闻/另一个枝干' },
		]
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning(JSON.stringify({
				actions,
				descriptions: { '践行/新枝干': '一次整理新建的枝干', '见闻/另一个枝干': '第二个新枝干' },
			})),
			modelSelection,
			now: () => NOW,
		})
		const result = await controller.run()
		assert.equal(result.retagged, BRANCH_CARDS, '同一个新枝干的卡片全部落库')
		for (const card of inbox) assert.deepEqual(store.get(card.id).tags, ['践行/新枝干'])
		assert.deepEqual(store.get(extra.id).tags, ['即兴'], '一次运行仍只新建一个枝干')
		assert.deepEqual(result.repairs, { repaired: 0, skipped: 0 })
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('整理在一次运行里跑完动作和修复轮', async () => {
	const { dir, store, settings } = await fixture({ dailyCards: 1 })
	try {
		const target = await store.put({ body: '将要被删掉的目标卡', tags: ['见闻/事实'] })
		const holder = await store.put({ body: '指着幽灵卡的笔记', tags: ['见闻/事实'], links: [target.id] })
		await store.remove(target.id)
		await injectDanglingLink(store, holder, target.id)
		// 让持卡人成为今天唯一要整理的卡片。
		await store.saveConsolidationLedger({
			lastRunAt: '',
			dayKey: '',
			cards: { [holder.id]: reviewedDaysAgo(61) },
			attempts: { day: '', count: 0 },
		})
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning('{"actions":[]}'),
			modelSelection,
			now: () => NOW,
		})
		const result = await controller.run()
		assert.equal(result.batch, 1)
		assert.equal(result.repairs.repaired, 1, '整理末尾的修复轮清了死链')
		assert.deepEqual(store.get(holder.id).links, [])
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('整理末尾刷新注入索引快照：关系最多的卡与摘要都在', async () => {
	const { dir, store, settings } = await fixture({ dailyCards: 1 })
	try {
		const notes = []
		for (let index = 0; index < BRANCH_CARDS; index += 1) {
			notes.push(await store.put({ body: `枝干里的卡片 ${index}`, tags: ['践行/经验'] }))
		}
		// 只留第一张在队列里，其余都在 60 天免检期内。
		await store.saveConsolidationLedger({
			lastRunAt: '',
			dayKey: '',
			cards: Object.fromEntries(notes.slice(1).map((card) => [card.id, reviewedDaysAgo(10)])),
			attempts: { day: '', count: 0 },
		})
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning('{"actions":[]}'),
			modelSelection,
			now: () => NOW,
		})
		const result = await controller.run()
		assert.equal(result.batch, 1)
		const index = readCardIndex(store, NOW)
		assert.notEqual(index, null, '整理结束时留下今天可用的快照')
		assert.ok(index.topCards.length > 0, '关系最多的卡片在快照里')
		assert.equal(index.topCards.some((card) => notes.some((note) => note.id === card.id)), true)
		assert.match(index.summary, /践行/)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})
