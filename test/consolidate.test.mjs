/**
 * The daily card consolidation: which cards it picks, what it applies and
 * what it refuses to apply.
 *
 * The model is stubbed out, so these tests pin the part that actually owns
 * the safety: every action is re-validated against the batch, a rewritten
 * body still has to pass the store's own rules, and anything removed is
 * copied to the trash log before it goes.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CardStore } from '../src/cards/store.js'
import { createConsolidationController, consolidationPrompt, parseActions } from '../src/consolidate.js'
import { defaultConsolidate, defaultSettings, normalizeConsolidate } from '../src/settings.js'

/**
 * A card store plus a settings stub on a temporary folder.
 *
 * @param {object} [consolidate] - The consolidation settings.
 * @returns {Promise<object>} The fixture.
 */
async function fixture(consolidate = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'evr-consolidate-'))
	const store = new CardStore({ dataDir: dir })
	await store.init()
	const state = { ...defaultSettings(), consolidate: { ...defaultConsolidate(), ...consolidate } }
	const settings = {
		get: () => state,
		update: async (patch) => {
			if (patch.consolidate !== undefined) {
				state.consolidate = normalizeConsolidate({ ...state.consolidate, ...patch.consolidate })
			}
			return state
		},
	}
	return { dir, store, settings }
}

/**
 * A model stub that answers with one fixed text.
 *
 * @param {string} text - The reply.
 * @returns {object} The `llm` service.
 */
function modelReturning(text) {
	return {
		async *stream() {
			yield { type: 'text-delta', text }
			yield { type: 'finish', reason: { kind: 'stop' } }
		},
	}
}

const modelSelection = { currentSelection: () => ({ provider: 'p', model: 'm' }) }

test('整理动作只认结构：批外 id、空正文、超长正文都被挡在解析阶段', () => {
	const valid = 'card-01HF7YAT00S37S1ZGTH35DPPXW'
	const other = 'card-01HF7YAT00S37S1ZGTH35DPPX2'
	const actions = parseActions(JSON.stringify({
		actions: [
			{ op: 'delete', id: valid, reason: '没用' },
			{ op: 'delete', id: 'not-a-card', reason: '无效 id' },
			{ op: 'update', id: valid, body: '改写', tags: ['践行/经验'], links: [other], reason: '精简' },
			{ op: 'update', id: valid, body: '', reason: '空正文' },
			{ op: 'update', id: valid, body: 'x'.repeat(2000), reason: '太长' },
			{ op: 'merge', ids: [valid], body: '只有一个 id', reason: '不成立' },
			{ op: 'merge', ids: [valid, other], body: '合并后的正文', reason: '重复' },
			{ op: 'rewrite', id: valid, body: '未知动作' },
		],
	}))
	assert.deepEqual(actions.map((action) => action.op), ['delete', 'update', 'merge'])
	assert.equal(actions[2].ids.length, 2)
	// Fenced JSON is tolerated, garbage is not.
	assert.throws(() => parseActions('这不是 JSON'), /没有返回 JSON/)
	assert.throws(() => parseActions('{坏掉的'), /括号没有闭合|没有返回 JSON/)

	// A reasoning model narrates before answering, and its narration contains
	// braces. The reply must still be found.
	const narrated = [
		'我先看一下这批卡片。{切分点} 第 2 张和第 4 张讲的是同一件事。',
		JSON.stringify({ actions: [{ op: 'delete', id: valid, reason: '重复' }] }),
		'以上是我的判断。',
	].join('\n')
	assert.deepEqual(parseActions(narrated).map((action) => action.op), ['delete'])

	// Several balanced objects, only one of them the answer.
	const competing = `{"note":"草稿"}\n${JSON.stringify({ actions: [{ op: 'delete', id: valid, reason: '重复' }] })}`
	assert.equal(parseActions(competing).actions, undefined)
	assert.equal(parseActions(competing).length, 1, '取带 actions 的那一段')

	// Truncated output says so instead of blaming the JSON.
	assert.throws(() => parseActions('{"actions":[{"op":"delete","id":"' + valid), /截断|括号没有闭合/)
})

test('整理提示带着标签树、候选链接和要整理的卡片', () => {
	const prompt = consolidationPrompt(
		[{ id: 'card-01HF7YAT00S37S1ZGTH35DPPXW', tags: ['践行/经验'], links: [], body: '一条正文' }],
		[{ id: 'card-01HF7YAT00S37S1ZGTH35DPPX2', tags: ['践行/经验'], label: '另一张' }],
		[{ path: '践行', name: '践行', count: 1, children: [] }],
		{ 践行: '落地与持续行动' },
	)
	assert.match(prompt, /#践行 \(1\) — 落地与持续行动/)
	assert.match(prompt, /card-01HF7YAT00S37S1ZGTH35DPPX2 \| 践行\/经验 \| 另一张/)
	assert.match(prompt, /一条正文/)
})

test('整理把模型动作落到卡片：改写、加链接、合并、删除，删掉的进回收站', async () => {
	const { dir, store, settings } = await fixture()
	try {
		const keep = await store.put({ body: '第一条要合并的内容', tags: ['践行/经验'] })
		const drop = await store.put({ body: '第二条重复的内容', tags: ['践行/经验'] })
		const stale = await store.put({ body: '一张以后用不上的卡片', tags: ['即兴'] })
		const related = await store.put({ body: '一张相关的卡片', tags: ['见闻/事实'] })
		const reply = JSON.stringify({
			actions: [
				{ op: 'update', id: related.id, body: '改写后的相关卡片', tags: ['见闻/事实'], links: [keep.id], reason: '补链接' },
				{ op: 'merge', ids: [keep.id, drop.id], body: '合并：两条内容其实是一件事', tags: ['践行/经验'], reason: '重复' },
				{ op: 'delete', id: stale.id, reason: '以后用不上' },
			],
		})
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning(reply),
			modelSelection,
		})
		const result = await controller.run()
		assert.equal(result.success, true)
		assert.equal(result.batch, 4)
		assert.equal(result.updated, 1)
		assert.equal(result.merged, 1)
		assert.equal(result.deleted, 1)

		assert.equal(store.get(keep.id).body, '合并：两条内容其实是一件事')
		assert.equal(store.get(drop.id), undefined, '被合并的卡片没了')
		assert.equal(store.get(stale.id), undefined, '被删的卡片没了')
		assert.deepEqual(store.get(related.id).links, [keep.id])

		// Nothing disappears without a copy.
		const trash = (await readFile(join(dir, 'knowledge', 'trash.jsonl'), 'utf8'))
			.trim().split('\n').map((line) => JSON.parse(line))
		assert.equal(trash.length, 2)
		assert.deepEqual(trash.map((entry) => entry.op).sort(), ['delete', 'merge'])
		assert.equal(trash.find((entry) => entry.op === 'delete').card.body, '一张以后用不上的卡片')
		assert.equal(trash.find((entry) => entry.op === 'merge').into, keep.id)

		// The ledger records the review, so the batch is not repeated tomorrow.
		const ledger = JSON.parse(await readFile(join(dir, 'knowledge', 'consolidation.json'), 'utf8'))
		assert.equal(Object.keys(ledger.cards).length, 4)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('整理不会碰批外的卡片，也不会写进密钥', async () => {
	const { dir, store, settings } = await fixture()
	try {
		const inside = await store.put({ body: '批内的一张卡片', tags: ['践行/经验'] })
		const outside = await store.put({ body: '批外的一张卡片', tags: ['见闻/事实'] })
		const reply = JSON.stringify({
			actions: [
				{ op: 'delete', id: outside.id, reason: '越权删除' },
				{ op: 'update', id: inside.id, body: 'api key 是 sk-abcdefghijklmnopqrstuvwx', reason: '写密钥' },
				{ op: 'update', id: inside.id, body: '改写成功的一句话', reason: '精简' },
			],
		})
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning(reply),
			modelSelection,
		})
		// Only the first card is in the batch.
		const original = store.all.bind(store)
		store.all = () => original().filter((card) => card.id === inside.id)
		const result = await controller.run()
		assert.equal(result.deleted, 0)
		assert.equal(result.updated, 1)
		assert.ok(result.skipped >= 1)
		assert.notEqual(store.get(outside.id), undefined, '批外卡片还在')
		assert.equal(store.get(inside.id).body, '改写成功的一句话')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('每天只跑一次，且到了设定的小时才开始', async () => {
	const { dir, store, settings } = await fixture({ enabled: true, dailyCards: 2, hour: 3 })
	try {
		await store.put({ body: '第一张待整理的卡片', tags: ['践行/经验'] })
		await store.put({ body: '第二张待整理的卡片', tags: ['见闻/事实'] })
		let clock = new Date(2026, 10, 11, 2, 30, 0).getTime()
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning('{"actions":[]}'),
			modelSelection,
			now: () => clock,
		})
		assert.equal(await controller.check(), null, '没到点不跑')
		clock = new Date(2026, 10, 11, 3, 5, 0).getTime()
		const first = await controller.check()
		assert.equal(first.success, true)
		assert.equal(first.batch, 2)
		assert.equal(await controller.check(), null, '同一天不重复跑')
		clock = new Date(2026, 10, 12, 3, 5, 0).getTime()
		// Both cards were just reviewed, so nothing is due yet.
		assert.equal(await controller.check(), null)
		const status = await controller.status()
		assert.equal(status.total, 2)
		assert.equal(status.due, 0)
		assert.equal(status.lastBatch, 2)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('模型一直答不出 JSON 时，一天最多试两次，不会每十分钟烧一次调用', async () => {
	const { dir, store, settings } = await fixture({ enabled: true, dailyCards: 2, hour: 3 })
	try {
		await store.put({ body: '第一张待整理的卡片', tags: ['践行/经验'] })
		await store.put({ body: '第二张待整理的卡片', tags: ['见闻/事实'] })
		let calls = 0
		const clock = new Date(2026, 10, 11, 4, 0, 0).getTime()
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: {
				async *stream() {
					calls += 1
					yield { type: 'text-delta', text: '我拒绝输出 JSON。' }
					yield { type: 'finish', reason: { kind: 'stop' } }
				},
			},
			modelSelection,
			now: () => clock,
		})
		assert.equal(await controller.check(), null, '第一次失败')
		assert.equal(calls, 1)
		assert.equal(await controller.check(), null, '第二次失败')
		assert.equal(calls, 2)
		// The cap is what keeps a broken reply from buying a request every tick.
		assert.equal(await controller.check(), null)
		assert.equal(calls, 2, '一天两次之后就停手')
		assert.match((await controller.status()).lastError, /没有返回 JSON/)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('整理设置被夹在合理范围，默认关闭且每天 15 张', () => {
	assert.deepEqual(defaultConsolidate(), { enabled: false, dailyCards: 15, hour: 3 })
	assert.equal(normalizeConsolidate({ dailyCards: 0 }).dailyCards, 1)
	assert.equal(normalizeConsolidate({ dailyCards: 9999 }).dailyCards, 100)
	assert.equal(normalizeConsolidate({ hour: -5 }).hour, 0)
	assert.equal(normalizeConsolidate({ hour: 99 }).hour, 23)
	assert.equal(normalizeConsolidate({ enabled: 'yes' }).enabled, false)
	assert.equal(normalizeConsolidate({ enabled: true, dailyCards: '7' }).dailyCards, 7)
})

test('整理任务不会并发跑两次', async () => {
	const { dir, store, settings } = await fixture({ enabled: true, dailyCards: 2, hour: 3 })
	try {
		await store.put({ body: '第一张待整理的卡片', tags: ['践行/经验'] })
		await store.put({ body: '第二张待整理的卡片', tags: ['见闻/事实'] })
		let release
		const gate = new Promise((resolve) => { release = resolve })
		let calls = 0
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: {
				async *stream() {
					calls += 1
					await gate
					yield { type: 'text-delta', text: '{"actions":[]}' }
					yield { type: 'finish', reason: { kind: 'stop' } }
				},
			},
			modelSelection,
			now: () => new Date(2026, 10, 11, 4, 0, 0).getTime(),
		})
		const first = controller.run()
		await assert.rejects(() => controller.run(), /正在进行/)
		release()
		await first
		assert.equal(calls, 1, '只调一次模型')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})
