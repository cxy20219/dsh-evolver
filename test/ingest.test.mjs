import test from 'node:test'
import assert from 'node:assert/strict'

import { createIngestController, parseMemories, quoteFromDigest } from '../src/ingest.js'

const NOW = Date.parse('2026-11-10T12:00:00Z')
test('提取的记忆带一句逐字原文；查不到原文就只存记忆，不存出处', () => {
	const parsed = parseMemories(JSON.stringify({
		memories: [{ text: '部署走 SSH，不用 HTTPS。', kind: 'convention', quote: '部署用 SSH，不要用 HTTPS。' }],
	}))
	assert.equal(parsed.memories[0].quote, '部署用 SSH，不要用 HTTPS。')

	const digest = { sessions: [{ id: 's-42', messages: [{ role: 'user', text: '部署用 SSH，不要用 HTTPS。' }] }] }
	assert.deepEqual(quoteFromDigest('部署用 SSH，不要用 HTTPS。', digest), {
		quote: '部署用 SSH，不要用 HTTPS。',
		session: 's-42',
	})
	// 模型自己编的句子不能变成"出处"：那会让整理器拿一句没人说过的话来核对。
	assert.equal(quoteFromDigest('部署应该用 SSH。', digest), undefined)
	assert.equal(quoteFromDigest('', digest), undefined)
})


/**
 * A query and ledger with one fresh session.
 *
 * @returns {object} The services and captured commits.
 */
function fakeSession() {
	const commits = []
	const events = [
		{ type: 'user/message', seq: 1, time: NOW - 60_000, data: { role: 'user', content: [{ type: 'text', text: '部署用 SSH，不要用 HTTPS。' }] } },
		{ type: 'assistant/message', seq: 2, time: NOW - 30_000, data: { message: { content: [{ type: 'text', text: '记住了。' }] } } },
	]
	return {
		commits,
		query: {
			async listSessions() {
				return [{ header: { id: 's1', createdAt: NOW - 3_600_000, cwd: '/repo' } }]
			},
			async listEvents() {
				return events.map((event) => ({ seq: event.seq, type: event.type, time: event.time }))
			},
			async readSession() {
				return { events }
			},
			async readTitle() {
				return { title: '部署记录' }
			},
		},
		ledger: {
			async load() {
				return { sessions: {}, lastCommitAt: '' }
			},
			async commit(entries, at) {
				commits.push({ entries, at })
			},
			async snapshot() {
				return { processed: commits.length === 0 ? 0 : 1, lastCommitAt: commits.at(-1)?.at ?? '' }
			},
		},
	}
}

/**
 * A model that returns one fixed JSON payload.
 *
 * @param {object} payload - The extraction result.
 * @returns {object} The fake llm service.
 */
function fakeLlm(payload) {
	const calls = []
	return {
		calls,
		async *stream(options) {
			calls.push(options)
			yield { type: 'text-delta', text: '```json\n' + JSON.stringify(payload) + '\n```' }
			yield { type: 'finish', reason: { kind: 'stop' } }
		},
	}
}

/**
 * A minimal settings store.
 *
 * @param {object} initial - The initial ingest block.
 * @returns {object} The store.
 */
function fakeSettings(initial) {
	const state = { ingest: { ...initial } }
	return {
		get: () => state,
		async update(patch) {
			if (patch.ingest !== undefined) state.ingest = { ...state.ingest, ...patch.ingest }
			return state
		},
		state,
	}
}

/**
 * Memory actions that record saves.
 *
 * @returns {object} The actions and the captured saves.
 */
function fakeMemory() {
	const saves = []
	return {
		saves,
		async save(request) {
			saves.push(request)
			return { success: true, id: `mem-${saves.length}` }
		},
	}
}

/**
 * A model selection service.
 *
 * @returns {object} The service.
 */
function fakeSelection() {
	return { currentSelection: () => ({ provider: 'test', model: 'extractor' }) }
}

test('后台整理直接调模型提取，校验后保存并推进游标', async () => {
	const { query, ledger, commits } = fakeSession()
	const memory = fakeMemory()
	const llm = fakeLlm({
		memories: [
			{ text: '部署走 SSH，不要用 HTTPS。', kind: 'fact', quote: '部署用 SSH，不要用 HTTPS。' },
			{ text: '别把密钥写进记忆。', kind: 'convention' },
		],
	})
	const settings = fakeSettings({ enabled: true, idleMinutes: 15 })
	const controller = createIngestController({ settings, query, ledger, save: memory.save, llm, modelSelection: fakeSelection(), now: () => NOW })
	const result = await controller.run()
	assert.equal(result.success, true)
	assert.equal(result.sessions, 1)
	assert.equal(result.saved, 2)
	// 只有抄得回原文的那条带出处；另一条不编造。
	assert.equal(result.quoted, 1)
	assert.equal(memory.saves[0].source.quote, '部署用 SSH，不要用 HTTPS。')
	assert.equal(memory.saves[1].source, undefined)
	assert.equal(memory.saves.length, 2)
	assert.equal(memory.saves[0].kind, 'fact')
	assert.equal(memory.saves[0].scope, undefined)
	assert.equal(commits.length, 1)
	assert.equal(commits[0].entries[0].id, 's1')
	assert.equal(llm.calls[0].provider, 'test')
	assert.equal(llm.calls[0].model, 'extractor')
	assert.match(llm.calls[0].messages[0].content[0].text, /部署用 SSH/)
})

test('闲时触发一次，冷却期内不重复，关闭后不跑', async () => {
	let clock = NOW
	const { query, ledger } = fakeSession()
	const memory = fakeMemory()
	const llm = fakeLlm({ memories: [] })
	const settings = fakeSettings({ enabled: true, idleMinutes: 15 })
	const controller = createIngestController({ settings, query, ledger, save: memory.save, llm, modelSelection: fakeSelection(), now: () => clock })
	clock += 5 * 60_000
	assert.equal(await controller.check(), null)
	clock += 11 * 60_000
	const first = await controller.check()
	assert.equal(first.success, true)
	assert.equal(first.saved, 0)
	clock += 60 * 60_000
	assert.equal(await controller.check(), null)

	await controller.save({ enabled: false })
	clock += 24 * 60 * 60_000
	assert.equal(await controller.check(), null)
	assert.equal((await controller.status()).enabled, false)
})

test('模型返回坏 JSON 时不推进游标', async () => {
	const { query, ledger, commits } = fakeSession()
	const memory = fakeMemory()
	const llm = {
		async *stream() {
			yield { type: 'text-delta', text: '这不是 JSON' }
			yield { type: 'finish', reason: { kind: 'stop' } }
		},
	}
	const settings = fakeSettings({ enabled: true, idleMinutes: 15 })
	const controller = createIngestController({ settings, query, ledger, save: memory.save, llm, modelSelection: fakeSelection(), now: () => NOW })
	await assert.rejects(() => controller.run(), /JSON/)
	assert.equal(commits.length, 0)
})

test('输出被 max-tokens 截断时说清楚是截断，不是「模型没返回 JSON」', async () => {
	const { query, ledger, commits } = fakeSession()
	const memory = fakeMemory()
	const llm = {
		async *stream() {
			// 思考强度高时预算可能全烧在推理上：正文一个字都没有就到顶了。
			yield { type: 'finish', reason: { kind: 'max-tokens' } }
		},
	}
	const settings = fakeSettings({ enabled: true, idleMinutes: 15 })
	const controller = createIngestController({ settings, query, ledger, save: memory.save, llm, modelSelection: fakeSelection(), now: () => NOW })
	await assert.rejects(() => controller.run(), /截断/)
	assert.equal(commits.length, 0, '截断的一轮不能推进游标')
})

test('被截断但 JSON 仍然完整时照常保存，不白扔一次调用', async () => {
	const { query, ledger, commits } = fakeSession()
	const memory = fakeMemory()
	const llm = {
		async *stream() {
			yield { type: 'text-delta', text: JSON.stringify({ memories: [{ text: '提交前先跑 npm test。', kind: 'convention' }] }) }
			yield { type: 'finish', reason: { kind: 'max-tokens' } }
		},
	}
	const settings = fakeSettings({ enabled: true, idleMinutes: 15 })
	const controller = createIngestController({ settings, query, ledger, save: memory.save, llm, modelSelection: fakeSelection(), now: () => NOW })
	const result = await controller.run()
	assert.equal(result.saved, 1)
	assert.equal(commits.length, 1, '解析成功就该推进游标')
})

test('提取结果里的密钥和被丢弃，空数组也会推进游标', async () => {
	const { query, ledger, commits } = fakeSession()
	const memory = fakeMemory()
	const llm = fakeLlm({
		memories: [
			{ text: 'API key 是 sk-abcdefghijklmnopqrstuvwx', kind: 'fact' },
			{ text: '提交前先跑 npm test。', kind: 'convention' },
		],
	})
	const settings = fakeSettings({ enabled: true, idleMinutes: 15 })
	const controller = createIngestController({ settings, query, ledger, save: memory.save, llm, modelSelection: fakeSelection(), now: () => NOW })
	const result = await controller.run()
	assert.equal(result.saved, 1)
	assert.equal(result.skipped, 1)
	assert.equal(memory.saves[0].content, '提交前先跑 npm test。')
	assert.equal(commits.length, 1)
})

test('只有合成消息的会话不花钱调模型，直接标记已处理', async () => {
	const commits = []
	const events = [
		{
			type: 'user/message',
			seq: 1,
			time: NOW,
			data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }] },
		},
		{ type: 'assistant/message', seq: 2, time: NOW, data: { message: { content: [{ type: 'text', text: '收到。' }] } } },
	]
	const query = {
		async listSessions() {
			return [{ header: { id: 's1', createdAt: NOW - 60_000 } }]
		},
		async listEvents() {
			return events.map((event) => ({ seq: event.seq, type: event.type, time: event.time }))
		},
		async readSession() {
			return { events }
		},
		async readTitle() {
			return { title: '' }
		},
	}
	const ledger = {
		async load() {
			return { sessions: {}, lastCommitAt: '' }
		},
		async commit(entries, at) {
			commits.push({ entries, at })
		},
		async snapshot() {
			return { processed: 1, lastCommitAt: '' }
		},
	}
	const memory = fakeMemory()
	const llm = fakeLlm({ memories: [] })
	const settings = fakeSettings({ enabled: true, idleMinutes: 15 })
	const controller = createIngestController({ settings, query, ledger, save: memory.save, llm, modelSelection: fakeSelection(), now: () => NOW })
	const result = await controller.run()
	assert.equal(result.sessions, 0)
	assert.equal(result.cleared, 1)
	assert.equal(llm.calls.length, 0)
	assert.equal(memory.saves.length, 0)
	assert.equal(commits[0].entries[0].id, 's1')
})


test('数据目录操作进行中时，会话整理直接跳过：不探测、不调模型、不推进游标', async () => {
	const { query, ledger, commits } = fakeSession()
	const memory = fakeMemory()
	const llm = fakeLlm({ memories: [] })
	const settings = fakeSettings({ enabled: true, idleMinutes: 15 })
	let clock = NOW + 60 * 60_000
	const controller = createIngestController({
		settings, query, ledger, save: memory.save, llm, modelSelection: fakeSelection(),
		now: () => clock, isBusy: () => true,
	})
	await assert.rejects(() => controller.run(), /数据目录操作/)
	assert.equal(await controller.check(), null)
	assert.equal(llm.calls.length, 0)
	assert.equal(commits.length, 0)
})
