/**
 * The OpenAI-compatible adapter, driven by a fake SSE server.
 *
 * The organizer only cares that `stream()` yields its chunk vocabulary, so the
 * test feeds real wire-format bytes through the parser instead of mocking the
 * generator: fragment handling, tool-call assembly and finish reasons are the
 * parts most likely to drift from what a server actually sends.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createOpenAiLlm, probeOpenAi, toWireMessages } from '../src/llm/openai.js'

/**
 * A fetch stand-in that answers with a canned SSE body.
 *
 * @param {string} body - The SSE text.
 * @param {{status?: number, capture?: (init: object) => void}} [options] - Response options.
 * @returns {typeof fetch} The fake.
 */
function fakeFetch(body, { status = 200, capture } = {}) {
	return async (_url, init) => {
		capture?.(init)
		return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
	}
}

/**
 * Turn SSE data lines into a body string.
 *
 * @param {object[]} events - JSON payloads.
 * @returns {string} The wire body.
 */
function sse(events) {
	return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
}

/**
 * Collect every chunk a stream yields.
 *
 * @param {AsyncGenerator<object>} stream - The stream.
 * @returns {Promise<object[]>} The chunks.
 */
async function collect(stream) {
	const out = []
	for await (const chunk of stream) out.push(chunk)
	return out
}

/** A config source that always answers the same block. */
const config = (block) => () => block

test('openai：文本增量与结束原因', async () => {
	const llm = createOpenAiLlm({
		config: config({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' }),
		fetchImpl: fakeFetch(sse([
			{ choices: [{ delta: { content: '你好' } }] },
			{ choices: [{ delta: { content: '，世界' }, finish_reason: 'stop' }] },
		])),
	})
	const chunks = await collect(llm.stream({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
	assert.deepEqual(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text), ['你好', '，世界'])
	const block = chunks.find((c) => c.type === 'block-end')
	assert.deepEqual(block.block, { type: 'text', text: '你好，世界' })
	assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('openai：工具调用分片要拼成完整的 id/name/arguments', async () => {
	const llm = createOpenAiLlm({
		config: config({ baseUrl: 'http://x/v1', model: 'm' }),
		fetchImpl: fakeFetch(sse([
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'file_', arguments: '{"que' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search', arguments: 'ry":"x"}' } }] } }] },
			{ choices: [{ finish_reason: 'tool_calls' }] },
		])),
	})
	const chunks = await collect(llm.stream({ messages: [] }))
	const call = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
	assert.equal(call.block.name, 'file_search', '名字由两个分片拼成')
	assert.equal(call.block.id, 'call_1')
	assert.equal(call.block.arguments, '{"query":"x"}', '参数 JSON 由两个分片拼成')
})

test('openai：finish_reason=length 报成 max-tokens', async () => {
	const llm = createOpenAiLlm({
		config: config({ baseUrl: 'http://x/v1', model: 'm' }),
		fetchImpl: fakeFetch(sse([{ choices: [{ delta: { content: 'a' }, finish_reason: 'length' }] }])),
	})
	const chunks = await collect(llm.stream({ messages: [] }))
	assert.equal(chunks.at(-1).reason.kind, 'max-tokens')
})

test('openai：HTTP 错误变成带状态码的失败，不抛异常', async () => {
	const llm = createOpenAiLlm({
		config: config({ baseUrl: 'http://x/v1', model: 'm' }),
		fetchImpl: fakeFetch('bad key', { status: 401 }),
	})
	const chunks = await collect(llm.stream({ messages: [] }))
	assert.equal(chunks.at(-1).reason.kind, 'error')
	assert.match(chunks.at(-1).reason.failure.message, /401/)
})

test('openai：没有模型名时给出可读错误', async () => {
	const llm = createOpenAiLlm({ config: config({ baseUrl: 'http://x/v1', model: '' }), fetchImpl: fakeFetch('') })
	await assert.rejects(() => collect(llm.stream({ messages: [] })), /模型名/)
})

test('openai：listModels 读 /models，失败时回落到配置的模型', async () => {
	let url = ''
	const llm = createOpenAiLlm({
		config: config({ baseUrl: 'http://x/v1', model: 'qwen2.5:7b' }),
		fetchImpl: async (target) => {
			url = String(target)
			return new Response(JSON.stringify({ data: [{ id: 'a-model' }, { id: 'b-model' }] }), { status: 200 })
		},
	})
	assert.equal(url, '', '还没有调用')
	assert.deepEqual((await llm.listModels()).map((m) => m.id), ['a-model', 'b-model'])
	assert.equal(url, 'http://x/v1/models')

	const offline = createOpenAiLlm({
		config: config({ baseUrl: 'http://x/v1', model: 'qwen2.5:7b' }),
		fetchImpl: async () => { throw new Error('offline') },
	})
	assert.deepEqual((await offline.listModels()).map((m) => m.id), ['qwen2.5:7b'], '没 /models 时用配置名兜底')
})

test('openai：每次调用都重读配置，保存后立即生效', async () => {
	let block = { baseUrl: 'http://x/v1', model: 'first' }
	const seen = []
	const llm = createOpenAiLlm({
		config: () => block,
		fetchImpl: async (_url, init) => {
			seen.push(JSON.parse(init.body).model)
			return new Response(sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]), { status: 200 })
		},
	})
	await collect(llm.stream({ messages: [] }))
	block = { baseUrl: 'http://x/v1', model: 'second' }
	await collect(llm.stream({ messages: [] }))
	assert.deepEqual(seen, ['first', 'second'])
})

test('toWireMessages：assistant 的 text+tool-call 拆成 content 与 tool_calls', () => {
	const wire = toWireMessages([
		{ role: 'user', content: [{ type: 'text', text: 'hi' }] },
		{
			role: 'assistant',
			content: [
				{ type: 'text', text: '让我查一下' },
				{ type: 'tool-call', id: 'c1', name: 'file_search', arguments: '{"q":"x"}' },
			],
		},
		{ role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '{"total":1}' }] },
	])
	assert.deepEqual(wire[0], { role: 'user', content: 'hi' })
	assert.equal(wire[1].content, '让我查一下')
	assert.deepEqual(wire[1].tool_calls, [{ id: 'c1', type: 'function', function: { name: 'file_search', arguments: '{"q":"x"}' } }])
	assert.deepEqual(wire[2], { role: 'tool', tool_call_id: 'c1', content: '{"total":1}' })
})

test('probeOpenAi：成功与失败都给出可读结论', async () => {
	const ok = await probeOpenAi({
		baseUrl: 'http://x/v1',
		model: 'm',
		fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
	})
	assert.equal(ok.ok, true)

	const bad = await probeOpenAi({
		baseUrl: 'http://x/v1',
		model: 'm',
		fetchImpl: async () => new Response('nope', { status: 404 }),
	})
	assert.equal(bad.ok, false)
	assert.match(bad.message, /404/)
})
