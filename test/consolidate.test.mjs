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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { cardId } from '../src/cards/ids.js'
import { CardStore } from '../src/cards/store.js'
import { createConsolidationController, consolidationPrompt, parseReply } from '../src/consolidate.js'
import { createOrganizeSettings } from '../src/organize.js'
import { defaultConsolidate, defaultOrganize, defaultSettings, normalizeConsolidate, normalizeOrganize } from '../src/settings.js'

/**
 * A card store plus a settings stub on a temporary folder.
 *
 * @param {object} [consolidate] - The consolidation settings.
 * @returns {Promise<object>} The fixture.
 */
async function fixture(consolidate = {}, organize = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'evr-consolidate-'))
	const store = new CardStore({ dataDir: dir })
	await store.init()
	const state = {
		...defaultSettings(),
		consolidate: { ...defaultConsolidate(), ...consolidate },
		organize: { ...defaultOrganize(), ...organize },
	}
	const settings = {
		get: () => state,
		update: async (patch) => {
			if (patch.consolidate !== undefined) {
				state.consolidate = normalizeConsolidate({ ...state.consolidate, ...patch.consolidate })
			}
			if (patch.organize !== undefined) {
				state.organize = normalizeOrganize({ ...state.organize, ...patch.organize })
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

/**
 * The actions of one reply, for the tests that only care about the list.
 *
 * @param {string} text - The raw model output.
 * @returns {object[]} The parsed actions.
 */
function parseActions(text) {
	return parseReply(text).actions
}

test('标签树很大时整理提示按预算降级，六个根一个不少', () => {
	const roots = ['践行', '见闻', '即兴', '复盘', '觉察', '试错']
	const tree = roots.map((root) => ({
		path: root,
		count: 40,
		children: Array.from({ length: 40 }, (_, index) => ({
			path: `${root}/主题${index}`,
			count: 1,
			children: [],
		})),
	}))
	const descriptions = {}
	for (const root of roots) descriptions[root] = `${root} 的说明，大约二十个字用来占位测试`
	const prompt = consolidationPrompt([], [], tree, descriptions)
	assert.ok(Buffer.byteLength(prompt, 'utf8') < 8000, '预算内')
	for (const root of roots) assert.match(prompt, new RegExp(`#${root} \\(40\\)`), `丢了顶层分支：${root}`)
	assert.match(prompt, /card_index 看树/)
})

test('整理会把来源会话的摘录附在卡上，供模型对照原文', async () => {
	const { dir, store, settings } = await fixture()
	try {
		await store.put({
			body: '部署走 HTTPS。',
			tags: ['践行/约定'],
			source: { quote: '部署用 SSH，不要用 HTTPS。', session: 'sess-1' },
		})
		const calls = []
		const llm = {
			async *stream(options) {
				calls.push(options)
				yield { type: 'text-delta', text: '{"actions":[]}' }
				yield { type: 'finish', reason: { kind: 'stop' } }
			},
		}
		const asked = []
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm,
			modelSelection,
			excerpt: async (id, quote) => {
				asked.push({ id, quote })
				return 'user: 部署用 SSH，不要用 HTTPS。'
			},
		})
		const result = await controller.run()
		assert.equal(result.success, true)
		assert.deepEqual(asked, [{ id: 'sess-1', quote: '部署用 SSH，不要用 HTTPS。' }])
		const prompt = calls[0].messages[0].content[0].text
		assert.match(prompt, /原文: 「部署用 SSH，不要用 HTTPS。」/)
		assert.match(prompt, /出处摘录: 「user: 部署用 SSH，不要用 HTTPS。」/)
		assert.match(calls[0].system, /出处摘录是会话原文的片段/)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('整理提示带上原文出处，模型才能核对卡片有没有说反', () => {
	const card = {
		id: 'card-01HF7YAT00S37S1ZGTH35DPPXW',
		body: '部署走 HTTPS。',
		tags: ['即兴'],
		links: [],
		created: '2026-11-01T00:00:00.000Z',
		source: { quote: '部署用 SSH，不要用 HTTPS。' },
	}
	const prompt = consolidationPrompt([card], [], [], {})
	assert.match(prompt, /原文: 「部署用 SSH，不要用 HTTPS。」/)
	// 没有出处时不能凭空造一行空的「原文:」。
	const bare = consolidationPrompt([{ ...card, source: undefined }], [], [], {})
	assert.equal(bare.includes('原文:'), false)
})

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
		[{ id: 'card-01HF7YAT00S37S1ZGTH35DPPX2', tags: ['践行/经验'], description: '另一张卡讲的事' }],
		[{ path: '践行', name: '践行', count: 1, children: [] }],
		{ 践行: '落地与持续行动' },
	)
	assert.match(prompt, /#践行 \(1\) — 落地与持续行动/)
	assert.match(prompt, /card-01HF7YAT00S37S1ZGTH35DPPX2 \| 践行\/经验 \| 另一张卡讲的事/)
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
		// Only the cards that still exist are stamped: the deleted one and the
		// one merged away are gone, not "reviewed".
		const ledger = JSON.parse(await readFile(join(dir, 'knowledge', 'consolidation.json'), 'utf8'))
		assert.equal(Object.keys(ledger.cards).length, 2)
		assert.notEqual(ledger.cards[keep.id], undefined)
		assert.notEqual(ledger.cards[related.id], undefined)
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

test('到了设定的小时才开始；一天的配额跟着入库量放大，分批跑完就停', async () => {
	const { dir, store, settings } = await fixture({ enabled: true, dailyCards: 2, hour: 3 })
	try {
		for (let index = 0; index < 6; index += 1) {
			await store.put({ body: `第 ${index} 张待整理的卡片`, tags: ['践行/经验'] })
		}
		let clock = new Date(2026, 10, 11, 2, 30, 0).getTime()
		let calls = 0
		const llm = {
			async *stream() {
				calls += 1
				yield { type: 'text-delta', text: '{"actions":[]}' }
				yield { type: 'finish', reason: { kind: 'stop' } }
			},
		}
		const controller = createConsolidationController({ settings, store: () => store, llm, modelSelection, now: () => clock })
		assert.equal(await controller.check(), null, '没到点不跑')
		clock = new Date(2026, 10, 11, 3, 5, 0).getTime()
		// 六张新卡、每批两张：当天的配额是六张，所以分三批跑完，而不是一批就收工。
		for (let index = 0; index < 3; index += 1) {
			const result = await controller.check()
			assert.equal(result.batch, 2, `第 ${index + 1} 批两张`)
		}
		assert.equal(calls, 3)
		assert.equal(await controller.check(), null, '配额用完当天就停')
		const ledger = JSON.parse(await readFile(join(dir, 'knowledge', 'consolidation.json'), 'utf8'))
		assert.deepEqual(ledger.progress, { day: '2026-11-11', reviewed: 6, batches: 3 })
		assert.equal(Object.keys(ledger.cards).length, 6, '六张都记账了，明天不再重复')
		const status = await controller.status()
		assert.equal(status.total, 6)
		assert.equal(status.due, 0)
		assert.equal(status.lastBatch, 2)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('一天最多跑四批：入库再猛也不会无限调用模型', async () => {
	const { dir, store, settings } = await fixture({ enabled: true, dailyCards: 1, hour: 3 })
	try {
		for (let index = 0; index < 10; index += 1) {
			await store.put({ body: `第 ${index} 张待整理的卡片`, tags: ['践行/经验'] })
		}
		let calls = 0
		const llm = {
			async *stream() {
				calls += 1
				yield { type: 'text-delta', text: '{"actions":[]}' }
				yield { type: 'finish', reason: { kind: 'stop' } }
			},
		}
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm,
			modelSelection,
			now: () => new Date(2026, 10, 11, 4, 0, 0).getTime(),
		})
		for (let index = 0; index < 4; index += 1) {
			assert.notEqual(await controller.check(), null, `第 ${index + 1} 批还在配额里`)
		}
		assert.equal(await controller.check(), null, '四批之后就停手')
		assert.equal(calls, 4, '当天的上限是四批，不是十批')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('看过但没落定的老卡不记账：下一轮还会被挑到', async () => {
	const { dir, store, settings } = await fixture({ enabled: true, dailyCards: 2, hour: 3 })
	try {
		// 2023 年的 ULID：两张都超过 14 天，只有一张有落定枝干。
		const unfiled = await store.put({ id: 'card-01HF7YAT00S37S1ZGTH35DPPXW', body: '很久以前的一条想法', tags: ['即兴'] })
		const settled = await store.put({ id: 'card-01HF7YAT00S37S1ZGTH35DPPXX', body: '很久以前就已落定的一条', tags: ['践行/经验'] })
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning('{"actions":[]}'),
			modelSelection,
			now: () => new Date(2026, 10, 11, 4, 0, 0).getTime(),
		})
		await controller.run()
		const ledger = JSON.parse(await readFile(join(dir, 'knowledge', 'consolidation.json'), 'utf8'))
		assert.notEqual(ledger.cards[settled.id], undefined, '已落定的卡照常记账')
		assert.equal(ledger.cards[unfiled.id], undefined, '没落定的卡不记账')
		assert.equal(ledger.progress.reviewed, 2, '但两张都花了当天的配额')

		// 第二天：没落定的那张还在队列里，已落定的那张不会重复。
		const tomorrow = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning('{"actions":[]}'),
			modelSelection,
			now: () => new Date(2026, 10, 12, 4, 0, 0).getTime(),
		})
		const result = await tomorrow.run()
		assert.equal(result.batch, 1, '只有没落定的那张回来了')
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

test('整理设置被夹在合理范围，默认关闭、每批 15 张', () => {
	assert.deepEqual(defaultConsolidate(), { enabled: false, dailyCards: 15, hour: 3 })
	assert.equal(normalizeConsolidate({ dailyCards: 0 }).dailyCards, 1)
	assert.equal(normalizeConsolidate({ dailyCards: 9999 }).dailyCards, 100)
	assert.equal(normalizeConsolidate({ hour: -5 }).hour, 0)
	assert.equal(normalizeConsolidate({ hour: 99 }).hour, 23)
	assert.equal(normalizeConsolidate({ enabled: 'yes' }).enabled, false)
	assert.equal(normalizeConsolidate({ enabled: true, dailyCards: '7' }).dailyCards, 7)
})

test('整理模型是独立设置：缺省和 null 都是跟随聊天，残掉的値退回跟随', () => {
	assert.deepEqual(defaultOrganize(), { model: null })
	assert.equal(normalizeOrganize({}).model, null)
	assert.equal(normalizeOrganize({ model: null }).model, null)
	assert.deepEqual(normalizeOrganize({ model: { provider: 'p', model: 'm' } }).model, { provider: 'p', model: 'm' })
	assert.deepEqual(
		normalizeOrganize({ model: { provider: 'p', model: 'm', reasoningEffort: 'high' } }).model,
		{ provider: 'p', model: 'm', reasoningEffort: 'high' },
	)
	// 半个模型不能留在设置里：那会让「跟随聊天」变成「跟随一个空选择」。
	assert.equal(normalizeOrganize({ model: { provider: 'p' } }).model, null)
	assert.equal(normalizeOrganize({ model: 'p::m' }).model, null)
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

test('合并删掉目标卡后，引用的链接一起清掉', async () => {
	const { dir, store, settings } = await fixture({ enabled: true, dailyCards: 5, hour: 3 })
	try {
		const keep = await store.put({ body: '保留的卡片', tags: ['践行/经验'] })
		const drop = await store.put({ body: '将被合并的卡片', tags: ['践行/经验'] })
		// `keep` already points at `drop`; the merge then removes `drop`.
		await store.put({ id: keep.id, body: '保留的卡片', tags: ['践行/经验'], links: [drop.id] })
		const llm = modelReturning(JSON.stringify({
			actions: [{ op: 'merge', ids: [keep.id, drop.id], body: '合并后的正文', tags: ['践行/经验'], reason: '同义' }],
		}))
		const controller = createConsolidationController({ settings, store: () => store, llm, modelSelection, now: () => new Date(2026, 10, 11, 4, 0, 0).getTime() })
		await controller.run()
		assert.equal(store.get(drop.id), undefined, '被合并的卡已删除')
		const survivor = store.get(keep.id)
		assert.deepEqual(survivor.links ?? [], [], '不能留下指向已删卡的链接')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('整理回复可以带枝干说明，非法路径被过滤', () => {
	const valid = 'card-01HF7YAT00S37S1ZGTH35DPPXW'
	const reply = parseReply(JSON.stringify({
		actions: [
			{ op: 'retag', id: valid, tags: ['践行/工具'], reason: '#即兴 → #践行/工具' },
			{ op: 'retag', id: valid, tags: [], reason: '没有标签' },
			{ op: 'tag-merge', from: '践行/缓存实验分支', to: '践行/经验', reason: '同一件事' },
			{ op: 'tag-merge', from: '', to: '践行/经验', reason: '缺来源' },
		],
		descriptions: {
			'践行/工具': '可复用的脚本与 CLI 用法',
			'见闻/git/rebase': '三层也收',
			'胡说/分支': '顶层不合法',
			'践行/工具/日志/太深': '第四层不收',
		},
	}))
	assert.deepEqual(reply.actions.map((action) => action.op), ['retag', 'tag-merge'])
	assert.deepEqual(Object.keys(reply.descriptions), ['践行/工具', '见闻/git/rebase'])
	assert.equal(reply.descriptions['践行/工具'], '可复用的脚本与 CLI 用法')
	// parseActions keeps the old shape.
	assert.deepEqual(parseActions(JSON.stringify({ actions: [{ op: 'retag', id: valid, tags: ['即兴'], reason: 'x' }] })).map((action) => action.op), ['retag'])
})

test('整理可以用 retag 只换标签，正文一个字不动，并留审计', async () => {
	const { dir, store, settings } = await fixture()
	try {
		const card = await store.put({ body: '一条还留在收件箱里的卡片', tags: ['即兴'] })
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning(JSON.stringify({
				actions: [{ op: 'retag', id: card.id, tags: ['践行/经验'], reason: '#即兴 → #践行/经验' }],
			})),
			modelSelection,
		})
		const result = await controller.run()
		assert.equal(result.retagged, 1)
		assert.equal(result.updated, 0)
		assert.equal(store.get(card.id).body, '一条还留在收件箱里的卡片', '只改标签不该重写正文')
		assert.deepEqual(store.get(card.id).tags, ['践行/经验'])

		const audit = (await readFile(join(dir, 'knowledge', 'consolidation.jsonl'), 'utf8'))
			.trim().split('\n').map((line) => JSON.parse(line))
		assert.equal(audit.length, 1)
		assert.equal(audit[0].op, 'retag')
		assert.deepEqual(audit[0].before, ['即兴'])
		assert.deepEqual(audit[0].after, ['践行/经验'])
		assert.equal(audit[0].reason, '#即兴 → #践行/经验')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('新枝干没有说明会被整条丢弃，卡片停在原枝干', async () => {
	const { dir, store, settings } = await fixture()
	try {
		const card = await store.put({ body: '给某个临时实验留的卡片', tags: ['即兴'] })
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning(JSON.stringify({
				actions: [{ op: 'retag', id: card.id, tags: ['践行/缓存实验分支'], reason: '#即兴 → #践行/缓存实验分支' }],
			})),
			modelSelection,
		})
		const result = await controller.run()
		assert.equal(result.retagged, 0)
		assert.ok(result.skipped >= 1)
		assert.deepEqual(store.get(card.id).tags, ['即兴'])
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('新枝干带说明就落库，并把说明写进标签描述', async () => {
	const { dir, store, settings } = await fixture()
	try {
		const card = await store.put({ body: '用 CLI 拉取日志的一条经验', tags: ['即兴'] })
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning(JSON.stringify({
				actions: [{ op: 'retag', id: card.id, tags: ['践行/工具'], reason: '#即兴 → #践行/工具' }],
				descriptions: { '践行/工具': '用来跑日志和检索的命令行工具' },
			})),
			modelSelection,
		})
		const result = await controller.run()
		assert.equal(result.retagged, 1)
		assert.deepEqual(store.get(card.id).tags, ['践行/工具'])
		const descriptions = JSON.parse(await readFile(join(dir, 'knowledge', 'tags.json'), 'utf8'))
		assert.equal(descriptions['践行/工具'], '用来跑日志和检索的命令行工具')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('归档标签、第四层新枝干、第二个新枝干都被挡下', async () => {
	const { dir, store, settings } = await fixture()
	try {
		const archive = await store.put({ body: '想被悄悄归档的卡片', tags: ['即兴'] })
		const deep = await store.put({ body: '想建第四层的卡片', tags: ['即兴'] })
		const first = await store.put({ body: '第一个新枝干', tags: ['即兴'] })
		const second = await store.put({ body: '第二个新枝干', tags: ['即兴'] })
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning(JSON.stringify({
				actions: [
					{ op: 'retag', id: archive.id, tags: ['践行/归档'], reason: '归档' },
					{ op: 'retag', id: deep.id, tags: ['践行/经验/深层/更深'], reason: '第四层' },
					{ op: 'retag', id: first.id, tags: ['见闻/新枝干'], reason: '新建' },
					{ op: 'retag', id: second.id, tags: ['觉察/另一个'], reason: '再建一个' },
				],
				descriptions: { '见闻/新枝干': '新的外部输入分类', '觉察/另一个': '另一个内省分类', '践行/经验/深层/更深': '太深了' },
			})),
			modelSelection,
		})
		const result = await controller.run()
		assert.equal(result.retagged, 1, '只允许第一个新枝干')
		assert.deepEqual(store.get(archive.id).tags, ['即兴'], '整理不许写归档')
		assert.deepEqual(store.get(deep.id).tags, ['即兴'], '枝干最多三层')
		assert.deepEqual(store.get(first.id).tags, ['见闻/新枝干'])
		assert.deepEqual(store.get(second.id).tags, ['即兴'], '一次运行只能新建一个枝干')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('坏标签只丢标签，不丢正文改写', async () => {
	const { dir, store, settings } = await fixture()
	try {
		const card = await store.put({ body: '一长段需要改写的正文', tags: ['践行/经验'] })
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning(JSON.stringify({
				actions: [{
					op: 'update',
					id: card.id,
					body: '改写后的正文',
					tags: ['胡说/分类'],
					reason: '精简',
				}],
			})),
			modelSelection,
		})
		const result = await controller.run()
		assert.equal(result.updated, 1)
		assert.equal(store.get(card.id).body, '改写后的正文')
		assert.deepEqual(store.get(card.id).tags, ['践行/经验'], '非法标签被丢掉，原标签保留')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('超过 14 天的卡不能留在 #即兴', async () => {
	const { dir, store, settings } = await fixture()
	try {
		// A ULID from 2023: the card is old, so the inbox is no longer a home.
		const card = await store.put({ id: 'card-01HF7YAT00S37S1ZGTH35DPPXW', body: '很久以前的一条想法', tags: ['即兴'] })
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning(JSON.stringify({
				actions: [{ op: 'retag', id: card.id, tags: ['即兴/想法'], reason: '#即兴 → #即兴/想法' }],
				descriptions: { '即兴/想法': '还没落定的想法' },
			})),
			modelSelection,
		})
		const result = await controller.run()
		assert.equal(result.retagged, 0)
		assert.deepEqual(store.get(card.id).tags, ['即兴'])
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('tag-merge 改全库（含批外卡片），并搬走枝干说明', async () => {
	const { dir, store, settings } = await fixture({ dailyCards: 1 })
	try {
		const outside = await store.put({ body: '批外的缓存实验卡片', tags: ['践行/缓存实验分支'] })
		const inside = await store.put({ body: '批内的缓存实验卡片', tags: ['践行/缓存实验分支'] })
		const anchor = await store.put({ body: '一张普通的践行卡片', tags: ['践行/经验'] })
		await store.saveTagDescriptions({ '践行/缓存实验分支': '一次性实验用的临时枝干' })
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning(JSON.stringify({
				actions: [{ op: 'tag-merge', from: '践行/缓存实验分支', to: '践行/经验', reason: '一次性分支并回经验' }],
			})),
			modelSelection,
		})
		const result = await controller.run()
		assert.equal(result.batch, 1, '只整理一张卡')
		assert.equal(result.tagMerges, 1)
		assert.deepEqual(store.get(outside.id).tags, ['践行/经验'], '批外卡片也被改掉')
		assert.deepEqual(store.get(inside.id).tags, ['践行/经验'])
		assert.deepEqual(store.get(anchor.id).tags, ['践行/经验'])
		const descriptions = JSON.parse(await readFile(join(dir, 'knowledge', 'tags.json'), 'utf8'))
		assert.equal(descriptions['践行/经验'], '一次性实验用的临时枝干', '说明跟着搬过去')
		assert.equal(descriptions['践行/缓存实验分支'], undefined, '旧枝干的说明不留')

		const audit = (await readFile(join(dir, 'knowledge', 'consolidation.jsonl'), 'utf8'))
			.trim().split('\n').map((line) => JSON.parse(line))
		assert.equal(audit.filter((entry) => entry.op === 'tag-merge').length, 2)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('整理状态带上次运行的标签动作摘要，重启后仍然可查', async () => {
	const { dir, store, settings } = await fixture()
	try {
		const card = await store.put({ body: '一条还停在收件箱的卡片', tags: ['即兴'] })
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning(JSON.stringify({
				actions: [{ op: 'retag', id: card.id, tags: ['践行/经验'], reason: '#即兴 → #践行/经验' }],
			})),
			modelSelection,
		})
		assert.equal((await controller.status()).lastRun, null, '还没跑过就没有摘要')
		await controller.run()
		const status = await controller.status()
		assert.equal(status.lastRun.retagged, 1)
		assert.equal(status.lastRun.tagMerges, 0)
		assert.equal(status.lastRun.actions, 1)
		assert.match(status.lastRun.at, /^\d{4}-\d{2}-\d{2}T/)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})


test('回收站写不进去时删除不生效：卡片和磁盘都还在', async () => {
	const { dir, store, settings } = await fixture()
	try {
		const card = await store.put({ body: '一张以后用不上的卡片', tags: ['即兴'] })
		// 让 appendTrash 必然失败：目标文件被占成目录。
		await mkdir(join(dir, 'knowledge', 'trash.jsonl'), { recursive: true })
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning(JSON.stringify({ actions: [{ op: 'delete', id: card.id, reason: '以后用不上' }] })),
			modelSelection,
		})
		const result = await controller.run()
		assert.ok(result.skipped >= 1, '写不成副本的那条动作被跳过')
		await store.flush()
		assert.notEqual(store.get(card.id), undefined, '没写成副本就不能删')
		const reopened = new CardStore({ dataDir: dir })
		await reopened.init()
		assert.notEqual(reopened.get(card.id), undefined, '磁盘上也要还在')
		await reopened.close()
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('同一条回复里 tag-merge 后 update 不会把旧枝干写回来', async () => {
	const { dir, store, settings } = await fixture()
	try {
		const merged = await store.put({ body: '缓存实验的旧卡', tags: ['践行/缓存实验分支', '践行/经验'] })
		const other = await store.put({ body: '另一张待更新的卡', tags: ['践行/经验'] })
		const reply = JSON.stringify({
			actions: [
				{ op: 'tag-merge', from: '践行/缓存实验分支', to: '践行/经验', reason: '同一件事' },
				{ op: 'update', id: merged.id, body: '缓存实验的旧卡（改写后）', links: [other.id], reason: '改写' },
			],
		})
		const controller = createConsolidationController({ settings, store: () => store, llm: modelReturning(reply), modelSelection })
		const result = await controller.run()
		assert.equal(result.tagMerges, 1)
		assert.equal(result.updated, 1)
		assert.deepEqual(store.get(merged.id).tags, ['践行/经验'], '旧枝干不能复活')
		assert.equal(store.get(merged.id).body, '缓存实验的旧卡（改写后）')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('空批次不消耗当天的尝试次数：晚上写的卡当天仍会被整理', async () => {
	const { dir, store, settings } = await fixture({ enabled: true, hour: 3 })
		try {
	let clock = new Date(2026, 10, 12, 3, 5, 0).getTime()
	let calls = 0
	const llm = {
		async *stream() {
			calls += 1
			yield { type: 'text-delta', text: '{"actions":[]}' }
			yield { type: 'finish', reason: { kind: 'stop' } }
		},
	}
	const controller = createConsolidationController({ settings, store: () => store, llm, modelSelection, now: () => clock })
	assert.equal(await controller.check(), null, '第一次：空库')
	clock += 10 * 60_000
	assert.equal(await controller.check(), null, '第二次：还是空库')
	await store.put({ body: '3:20 才写的新卡', tags: ['践行/经验'] })
	clock += 10 * 60_000
	const third = await controller.check()
	assert.notEqual(third, null, '空批次不该把当天关掉')
	assert.equal(calls, 1, '只有第三次（真有卡）才调模型')
	const ledger = JSON.parse(await readFile(join(dir, 'knowledge', 'consolidation.json'), 'utf8'))
	assert.equal(ledger.dayKey, '2026-11-12')
} finally {
	await store.close()
	await rm(dir, { recursive: true, force: true })
}
})

test('模型调用期间数据目录被换掉：整轮放弃，不写旧库也不写新库', async () => {
	const { dir, store, settings } = await fixture()
	const dirTwo = await mkdtemp(join(tmpdir(), 'evr-consolidate-two-'))
	const second = new CardStore({ dataDir: dirTwo })
	await second.init()
	try {
		const card = await store.put({ body: '一条待整理的卡片', tags: ['即兴'] })
		let active = store
		const llm = {
			async *stream() {
				// 模型还在生成时数据目录就迁走了：store 指向新库。
				active = second
				yield { type: 'text-delta', text: JSON.stringify({ actions: [{ op: 'retag', id: card.id, tags: ['践行/经验'], reason: '归枝' }] }) }
				yield { type: 'finish', reason: { kind: 'stop' } }
			},
		}
		const controller = createConsolidationController({
			settings,
			store: () => active,
			llm,
			modelSelection,
		})
		await assert.rejects(() => controller.run(), /数据目录/)
		assert.deepEqual(store.get(card.id).tags, ['即兴'], '旧库不该被改')
		assert.equal(second.all().length, 0, '新库不该被写')
	} finally {
		await second.close()
		await store.close()
		await rm(dir, { recursive: true, force: true })
		await rm(dirTwo, { recursive: true, force: true })
	}
})

test('tag-merge 单卡写不进去时跳过该卡、其余照常，且审计如实', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-consolidate-legacy-'))
	try {
		await mkdir(join(dir, 'knowledge', 'cards'), { recursive: true })
		const now = '2026-11-01T00:00:00.000Z'
		const records = [
			{ id: 'card-01M72KRG4WC4VQD3KSRSTFJ8D7', body: '一张正常卡', tags: ['践行/缓存实验分支', '践行/经验'], updated: now },
			// 导入的旧卡：正文超过 cardMaxChars，put 会拒绝
			{ id: 'card-01M72KRG4Y8W6HS8K3F1MEX9FJ', body: '长'.repeat(1200), tags: ['践行/缓存实验分支'], updated: now },
		]
		await writeFile(join(dir, 'knowledge', 'cards', 'cards.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
		const store = new CardStore({ dataDir: dir, logger: { warn() {} } })
		await store.init()
		const settings = { get: () => ({ ...defaultSettings(), consolidate: { ...defaultConsolidate(), enabled: true, dailyCards: 10 } }), update: async () => {} }
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning(JSON.stringify({ actions: [{ op: 'tag-merge', from: '践行/缓存实验分支', to: '践行/经验', reason: '同一件事' }] })),
			modelSelection,
		})
		const result = await controller.run()
		assert.equal(result.success, true)
		assert.equal(result.tagMerges, 1)
		assert.deepEqual(store.get('card-01M72KRG4WC4VQD3KSRSTFJ8D7').tags, ['践行/经验'], '正常卡照常合并')
		assert.deepEqual(store.get('card-01M72KRG4Y8W6HS8K3F1MEX9FJ').tags, ['践行/缓存实验分支'], '超长卡保留原状')
		assert.ok(result.skipped >= 1)
		await store.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('整理运行前数据目录忙：直接跳过，不写台账也不烧模型', async () => {
	const { dir, store, settings } = await fixture({ hour: 3 })
	try {
		await store.put({ body: '一张待整理的卡片', tags: ['即兴'] })
		let calls = 0
		const llm = { async *stream() { calls += 1; yield { type: 'text-delta', text: '{"actions":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
		const controller = createConsolidationController({
			settings, store: () => store, llm, modelSelection,
			now: () => new Date(2026, 10, 12, 4, 0, 0).getTime(),
			isBusy: () => true,
		})
		await assert.rejects(() => controller.run(), /数据目录操作/)
		assert.equal(await controller.check(), null)
		assert.equal(calls, 0)
		assert.equal(await readFile(join(dir, 'knowledge', 'consolidation.json'), 'utf8').then(() => true, () => false), false)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('模型调用期间卡片被人工编辑：该卡的动作被跳过，不覆盖新正文', async () => {
	const { dir, store, settings } = await fixture({ enabled: true, dailyCards: 5 })
	try {
		const card = await store.put({ body: '原始正文', tags: ['即兴'] })
		const llm = {
			async *stream() {
				// 模型生成期间，人把这张卡改了：updated 变化，动作必须作废。
				await new Promise((resolve) => setTimeout(resolve, 10))
				await store.put({ id: card.id, body: '人工刚改的新正文', tags: ['即兴'] })
				yield {
					type: 'text-delta',
					text: JSON.stringify({
						actions: [
							{ op: 'update', id: card.id, body: '模型想写回的新正文', tags: ['践行/经验'], reason: '改写' },
							{ op: 'retag', id: card.id, tags: ['践行/经验'], reason: '归枝' },
						],
					}),
				}
				yield { type: 'finish', reason: { kind: 'stop' } }
			},
		}
		const controller = createConsolidationController({ settings, store: () => store, llm, modelSelection })
		const result = await controller.run()
		const after = store.get(card.id)
		assert.equal(after.body, '人工刚改的新正文', '不能覆盖人工编辑的正文')
		assert.deepEqual(after.tags, ['即兴'], '同一张卡的后续动作也一并跳过')
		assert.equal(result.updated, 0)
		assert.equal(result.retagged, 0)
		assert.ok(result.skipped >= 2, '两条动作都记为跳过')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('配了整理模型就按配置调用并带上思考强度；没配就跟随聊天默认', async () => {
	const { dir, store, settings } = await fixture({}, { model: { provider: 'cfg', model: 'cfg-model', reasoningEffort: 'high' } })
	try {
		await store.put({ body: '一张待整理的卡片', tags: ['践行/经验'] })
		const seen = []
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: {
				async *stream(request) {
					seen.push(request)
					yield { type: 'text-delta', text: '{"actions":[]}' }
					yield { type: 'finish', reason: { kind: 'stop' } }
				},
			},
			modelSelection: { currentSelection: () => ({ provider: 'sess', model: 'sess-model' }) },
		})
		await controller.run()
		assert.equal(seen[0].provider, 'cfg')
		assert.equal(seen[0].model, 'cfg-model')
		assert.equal(seen[0].reasoningEffort, 'high')

		// 清掉配置，下一次运行跟着聊天走，且不带任何强度。
		settings.get().organize.model = null
		await store.put({ body: '第二张待整理的卡片', tags: ['践行/经验'] })
		await createConsolidationController({
			settings,
			store: () => store,
			llm: {
				async *stream(request) {
					seen.push(request)
					yield { type: 'text-delta', text: '{"actions":[]}' }
					yield { type: 'finish', reason: { kind: 'stop' } }
				},
			},
			modelSelection: { currentSelection: () => ({ provider: 'sess', model: 'sess-model' }) },
		}).run()
		assert.equal(seen[1].provider, 'sess')
		assert.equal(seen[1].model, 'sess-model')
		assert.equal('reasoningEffort' in seen[1], false)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('整理模型设置：目录带出思考强度，坏路由只跳过自己，保存后立刻反映', async () => {
	const { dir, store, settings } = await fixture()
	try {
		let providerCalls = 0
		const llm = {
			async listProviders() {
				providerCalls += 1
				return [{ id: 'p1', name: 'Provider One' }, { id: 'bad', name: 'Broken' }]
			},
			async listModels(provider) {
				if (provider === 'bad') throw new Error('route down')
				return [{ id: 'm1', name: 'Model One' }]
			},
			async resolveModelInfo() {
				return { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }
			},
		}
		const controller = createOrganizeSettings({ settings, llm, modelSelection })
		const status = await controller.status()
		assert.equal(status.model, null, '默认跟随聊天')
		assert.deepEqual(status.current, { provider: 'p', model: 'm' }, '生效的是聊天里的模型')
		assert.deepEqual(status.providers.map((provider) => provider.id), ['p1', 'bad'])
		assert.deepEqual(status.providers[0].models[0].reasoning.efforts.map((effort) => effort.id), ['low', 'high'])
		assert.deepEqual(status.providers[1].models, [], '坏路由留空，不连坐整张表')

		await controller.status()
		assert.equal(providerCalls, 1, '第二次读走缓存，不再打适配器')

		const saved = await controller.save({ model: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } })
		assert.deepEqual(saved.model, { provider: 'p1', model: 'm1', reasoningEffort: 'high' })
		assert.deepEqual(saved.current, { provider: 'p1', model: 'm1', reasoningEffort: 'high' }, '保存后生效的就是它')
		assert.deepEqual(settings.get().organize.model, { provider: 'p1', model: 'm1', reasoningEffort: 'high' })

		// 换回「跟随聊天」：存 null，不残留上一个模型。
		const cleared = await controller.save({ model: null })
		assert.equal(cleared.model, null)
		assert.deepEqual(cleared.current, { provider: 'p', model: 'm' })
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('整理回复被 max-tokens 截断时说清楚是截断', async () => {
	const { dir, store, settings } = await fixture()
	try {
		await store.put({ body: '一张待整理的卡片', tags: ['践行/经验'] })
		const llm = {
			async *stream() {
				yield { type: 'finish', reason: { kind: 'max-tokens' } }
			},
		}
		const controller = createConsolidationController({ settings, store: () => store, llm, modelSelection })
		await assert.rejects(() => controller.run(), /截断/)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('merge 的 ids 重复时整条动作被拒绝：不能写完再删同一张卡', () => {
	const id = 'card-01M77VFJBBEYXXMKGK9120ED0X'
	assert.deepEqual(parseActions(JSON.stringify({ actions: [{ op: 'merge', ids: [id, id], body: '合并正文', reason: 'x' }] })), [])
	const once = parseReply(JSON.stringify({ actions: [{ op: 'merge', ids: [id, 'card-01M77VFJBBEYXXMKGK9120ED0Z'], body: '合并正文', reason: 'x' }] }))
	assert.equal(once.actions.length, 1)
})

test('回复里先有一段空 actions 再给真动作时，选带动作的那段', () => {
	const id = 'card-01M77VFJBBEYXXMKGK9120ED0X'
	const text = `先说明一下：{"actions":[]}\n真正的答案：{"actions":[{"op":"delete","id":"${id}","reason":"重复"}]}`
	const reply = parseReply(text)
	assert.equal(reply.actions.length, 1)
	assert.equal(reply.actions[0].op, 'delete')
})

test('模型给的摘要与枝干说明也过密钥筛查，不把密钥带进每次请求', () => {
	const reply = parseReply(JSON.stringify({
		actions: [],
		descriptions: { '践行/工具': '这里放 API key sk-abcdefghijklmnopqrstuvwx' },
		summary: '库摘要：token sk-abcdefghijklmnopqrstuvwx',
	}))
	assert.deepEqual(reply.descriptions, {})
	assert.equal(reply.summary, '')
})

test('超过落定期限的 #即兴 卡，只改正文不给标签时跳过而不是反复重写', async () => {
	const { dir, store, settings } = await fixture()
	try {
		// 卡片的创建时间来自 ULID 前缀，所以要用一张“三十天前的 id”。
		const old = await store.put({
			id: cardId(Date.now() - 30 * 86_400_000),
			body: '一条很旧的随手记',
			description: '超过十四天还在即兴的卡',
			tags: ['即兴/事实'],
		})
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: modelReturning(JSON.stringify({
				actions: [{ op: 'update', id: old.id, body: '改过的正文', reason: '润色' }],
			})),
			modelSelection,
		})
		const result = await controller.run()
		assert.equal(result.updated, 0)
		assert.equal(result.skipped, 1)
		assert.equal(store.get(old.id).body, '一条很旧的随手记', '正文不能被改')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('整理结果先落盘再写台账：模拟 flush 失败时台账不前进', async () => {
	const { dir, store, settings } = await fixture()
	try {
		const card = await store.put({ body: '待整理正文', description: '一条待整理的卡', tags: ['即兴/事实'] })
		let flushed = 0
		const flaky = Object.create(store)
		flaky.flush = async () => {
			flushed += 1
			if (flushed === 1) throw new Error('disk full')
			return store.flush()
		}
		const controller = createConsolidationController({
			settings,
			store: () => flaky,
			llm: modelReturning(JSON.stringify({ actions: [{ op: 'update', id: card.id, body: '改过的正文', tags: ['践行/工具'], reason: '落定' }] })),
			modelSelection,
		})
		await assert.rejects(() => controller.run(), /disk full/)
		const ledger = await store.consolidationLedger()
		assert.equal(ledger.cards[card.id], undefined, 'flush 失败时这张卡不能被记成已复查')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})
