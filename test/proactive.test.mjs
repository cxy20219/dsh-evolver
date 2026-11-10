import test from 'node:test'
import assert from 'node:assert/strict'

import { createTools } from '../src/tools.js'
import { PROACTIVE_PROTOCOL } from '../src/proactive.js'

test('主动性协议覆盖卡片触发点且保持精简', () => {
	for (const token of ['card_query', 'card_write', 'card_promote', 'evolve_review', '下一步', '依据']) {
		assert.match(PROACTIVE_PROTOCOL, new RegExp(token))
	}
	assert.ok(Buffer.byteLength(PROACTIVE_PROTOCOL, 'utf8') < 900, '主动性协议会注入每次请求，不能吃掉太多上下文')
})

test('工具集只有卡片工具，没有旧的 practice/memory 名称', () => {
	const tools = createTools({ cards: {} })
	assert.deepEqual(tools.map((tool) => tool.name), [
		'card_query',
		'card_read',
		'card_write',
		'card_index',
		'card_promote',
		'card_archive',
		'card_remove',
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
		hints: ['有 1 张临时卡待判断'],
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
	const result = await tool.execute({ sinceDays: 2, limit: 3, commit: true })
	assert.equal(result.success, true)
	assert.deepEqual(calls[0], { sinceDays: 2, limit: 3, commit: true })

	const missing = createTools({ cards: {} }).find((entry) => entry.name === 'session_digest')
	const empty = await missing.execute({})
	assert.equal(empty.success, false)
	assert.match(empty.message, /会话读取/)
})
