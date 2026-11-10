import test from 'node:test'
import assert from 'node:assert/strict'

import { createTools } from '../src/tools.js'
import { PROACTIVE_PROTOCOL } from '../src/proactive.js'

test('主动性协议覆盖触发点且保持精简', () => {
	for (const token of ['practice_query', 'memory_recall', 'practice_write', 'memory_save', 'evolve_review', '下一步', '依据']) {
		assert.match(PROACTIVE_PROTOCOL, new RegExp(token))
	}
	assert.ok(Buffer.byteLength(PROACTIVE_PROTOCOL, 'utf8') < 900, '主动性协议会注入每次请求，不能吃掉太多上下文')
})

test('evolve_review 汇总实践、记忆与可执行的提示', async () => {
	const practice = {
		async overview() {
			return {
				practice: {
					entries: 3,
					injectedBytes: 700,
					injectedBudget: 2048,
					dropped: 0,
					problems: [{ level: 'warning', path: 'practice/docs/a.md', message: '缺 verified' }],
				},
				suggestions: [
					{ kind: 'problem', level: 'warning', path: 'practice/docs/a.md', message: '缺 verified' },
					{ kind: 'stale', level: 'warning', path: 'practice/docs/b.md', message: '超过半年' },
				],
			}
		},
	}
	const memory = {
		stats() {
			return { success: true, entries: 2, entriesByKind: { fact: 2 }, entriesByScope: { global: 2 } }
		},
		list({ limit }) {
			assert.equal(limit, 5)
			return { success: true, total: 2, results: [{ id: 'mem-1', kind: 'fact', scope: 'global', text: '记住的结论' }] }
		},
	}
	const tools = createTools({ practice, memory })
	assert.equal(tools.length, 10)
	const review = tools.find((tool) => tool.name === 'evolve_review')
	const result = await review.execute({})
	assert.equal(result.practice.entries, 3)
	assert.equal(result.memory.top[0].text, '记住的结论')
	assert.equal(result.suggestions.length, 2)
	assert.match(result.hints.join(' '), /结构问题/)
	assert.match(result.hints.join(' '), /未验证/)
})

test('evolve_review 在空记忆和无问题时给出不同提示', async () => {
	const clean = {
		async overview() {
			return { practice: { entries: 0, injectedBytes: 0, injectedBudget: 2048, dropped: 0, problems: [] }, suggestions: [] }
		},
	}
	const empty = createTools({
		practice: clean,
		memory: { stats: () => ({ entries: 0, entriesByKind: {} }), list: () => ({ results: [] }) },
	}).find((tool) => tool.name === 'evolve_review')
	const emptyResult = await empty.execute({})
	assert.match(emptyResult.hints.join(' '), /记忆库为空/)

	const quiet = createTools({
		practice: clean,
		memory: { stats: () => ({ entries: 2, entriesByKind: { fact: 2 } }), list: () => ({ results: [] }) },
	}).find((tool) => tool.name === 'evolve_review')
	const quietResult = await quiet.execute({})
	assert.match(quietResult.hints.join(' '), /不用为了主动而主动/)
})
