import test from 'node:test'
import assert from 'node:assert/strict'

import { createTools } from '../src/tools.js'
import { PROACTIVE_PROTOCOL } from '../src/proactive.js'

test('主动性协议覆盖卡片触发点且保持精简', () => {
	for (const token of ['card_query', 'card_write', 'card_promote', 'evolve_review', '下一步', '依据']) {
		assert.match(PROACTIVE_PROTOCOL, new RegExp(token))
	}
	// Injected on every request, so it has to stay around a kilobyte: the
	// trigger needs its examples to be actionable, nothing else earns a line.
	assert.ok(Buffer.byteLength(PROACTIVE_PROTOCOL, 'utf8') < 1024, '主动性协议会注入每次请求，不能吃掉太多上下文')
	// The two landing spots were not enough: with only "card or harness" named,
	// the obvious third place — the instruction file — looked allowed. The
	// boundary has to be written down or it gets re-invented.
	assert.match(PROACTIVE_PROTOCOL, /全局 AGENTS\.md 只读/)
	// 项目级沉淀的落点必须说清楚：已有项目文档就更新，没有就写卡，不
	// 自作主张新建 harness；否则「写 harness_write」在无 harness 的仓库里
	// 只会被跳过，或者被误读成必须初始化一套骨架。
	assert.match(PROACTIVE_PROTOCOL, /harness\/ 或 AGENTS\.md/)
	assert.match(PROACTIVE_PROTOCOL, /不新建 harness/)
	// Observed failure: three finished deliverables in a row, no card written,
	// until the user asked. The trigger has to sit at the end of every reply,
	// not at the end of a task — a turn that ends by asking the user to test
	// something never feels like a task ending.
	assert.match(PROACTIVE_PROTOCOL, /每轮答复前/)
})

test('工具集只有卡片与诊断工具，没有旧的 practice/memory 名称', () => {
	const tools = createTools({ cards: {} })
	assert.deepEqual(tools.map((tool) => tool.name), [
		'card_query',
		'card_read',
		'card_write',
		'card_index',
		'card_promote',
		'card_archive',
		'card_remove',
		'cache_report',
		'evolve_review',
		'session_digest',
	])
	assert.equal(tools.some((tool) => /^(practice|memory)_/.test(tool.name)), false)
})

test('evolve_review 直接返回卡片盘点的结果', async () => {
	const review = {
		status: { cards: 4 },
		permanent: 3,
		fleeting: 1,
		hints: ['有 1 张 #即兴 卡待整理'],
	}
	const tool = createTools({ cards: { review: async () => review } }).find((entry) => entry.name === 'evolve_review')
	const result = await tool.execute({})
	assert.equal(result.permanent, 3)
	assert.equal(result.status.cards, 4)
	assert.deepEqual(result.hints, review.hints)
})

test('session_digest 把参数交给会话读取层，缺失时明确报错', async () => {
	const calls = []
	const tools = createTools({
		cards: {},
		sessions: {
			async digest(args) {
				calls.push(args)
				return { success: true, sessions: [] }
			},
		},
	})
	const tool = tools.find((entry) => entry.name === 'session_digest')
	assert.ok(tool)
	const result = await tool.execute({ sinceDays: 2, limit: 3 })
	assert.equal(result.success, true)
	// 只读：游标归自动整理独占，工具层不再把 commit 透传下去。
	assert.deepEqual(calls[0], { sinceDays: 2, limit: 3 })

	const missing = createTools({ cards: {} }).find((entry) => entry.name === 'session_digest')
	const empty = await missing.execute({})
	assert.equal(empty.success, false)
	assert.match(empty.message, /会话读取/)
})
