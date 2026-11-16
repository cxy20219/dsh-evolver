/**
 * The MCP endpoint: protocol shape, token gate, and the library verbs it hands
 * to another agent.
 *
 * These cases speak the protocol the way a client does — one JSON-RPC message
 * per POST, a JSON reply — against a real listener on a free port, so a change
 * that only satisfies unit-level dispatch but breaks the wire is caught here.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { tmpdir } from 'node:os'

import { createMcpService, endpointUrl, mintToken, negotiateVersion } from '../src/mcp/server.js'
import { FileStore } from '../src/store.js'
import { createTools } from '../src/tools.js'

/**
 * POST one JSON-RPC message.
 *
 * @param {number} port - The listening port.
 * @param {object} message - The message.
 * @param {{token?: string, header?: boolean, path?: string}} [options] - Auth and path overrides.
 * @returns {Promise<{status: number, body: object | null, headers: object}>} What came back.
 */
function post(port, message, options = {}) {
	const token = options.token ?? ''
	const path = options.path ?? '/mcp'
	const query = options.header === true ? '' : (token === '' ? '' : `?token=${encodeURIComponent(token)}`)
	const body = JSON.stringify(message)
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			host: '127.0.0.1',
			port,
			path: `${path}${query}`,
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'content-length': Buffer.byteLength(body),
				...(options.header === true && token !== '' ? { authorization: `Bearer ${token}` } : {}),
			},
		}, (res) => {
			const chunks = []
			res.on('data', (chunk) => chunks.push(chunk))
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8')
				let parsed = null
				try {
					parsed = text === '' ? null : JSON.parse(text)
				} catch {
					parsed = null
				}
				resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers })
			})
		})
		req.on('error', reject)
		req.end(body)
	})
}

/**
 * A store, the four tools over it, and a running MCP service.
 *
 * @returns {Promise<object>} The fixture, plus `close`.
 */
async function fixture() {
	const dataDir = await mkdtemp(join(tmpdir(), 'ziyan-mcp-'))
	const store = new FileStore({ dataDir })
	await store.open()
	const tools = createTools({ store, paths: async () => ({}) })
	const token = mintToken()
	const service = createMcpService({ tools, serverInfo: { name: 'ziyan', version: '0.2.0' } })
	const started = await service.start({ port: 0, token })
	return {
		store,
		tools,
		service,
		token,
		port: started.port,
		async close() {
			await service.stop()
			store.close()
			await rm(dataDir, { recursive: true, force: true })
		},
	}
}

test('MCP：握手 → 列工具 → 真调一次写入与检索', async () => {
	const box = await fixture()
	try {
		const init = await post(box.port, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
		}, { token: box.token })
		assert.equal(init.status, 200)
		assert.equal(init.body.result.protocolVersion, '2025-06-18', '回显客户端提议的版本')
		assert.equal(init.body.result.serverInfo.name, 'ziyan')
		assert.equal(init.body.result.capabilities.tools.listChanged, false)
		assert.match(init.body.result.instructions, /file_search/, 'instructions 说明怎么用')

		// initialized 是通知：没有 id，不能有响应体。
		const notified = await post(box.port, { jsonrpc: '2.0', method: 'notifications/initialized' }, { token: box.token })
		assert.equal(notified.status, 202)
		assert.equal(notified.body, null)

		const list = await post(box.port, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { token: box.token })
		const names = list.body.result.tools.map((tool) => tool.name).sort()
		assert.deepEqual(names, ['file_edit', 'file_read', 'file_search', 'file_write'])
		const write = list.body.result.tools.find((tool) => tool.name === 'file_write')
		assert.equal(write.inputSchema.type, 'object', 'schema 原样透出')
		assert.match(write.description, /file_edit 的 old\+new/, '远端读到的是同一份能力矩阵')
		assert.equal(list.body.result.tools.find((tool) => tool.name === 'file_search').annotations.readOnlyHint, true)
		assert.equal(write.annotations.readOnlyHint, false)

		// 写一篇，再用检索读回来——这是整个端点的存在理由。
		const created = await post(box.port, {
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: {
				name: 'file_write',
				arguments: { content: '# 远端写入\n\n正文。\n', meta: { name: 'remote.md', description: '远端 agent 通过 MCP 写入的文件：验证跨 agent 沉淀可用', tags: ['来源/mcp'] } },
			},
		}, { token: box.token })
		assert.equal(created.body.result.isError, undefined, JSON.stringify(created.body.result).slice(0, 200))
		const written = JSON.parse(created.body.result.content[0].text)
		assert.equal(written.name, 'remote.md')

		const found = await post(box.port, {
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: { name: 'file_search', arguments: { query: '远端' } },
		}, { token: box.token })
		const hits = JSON.parse(found.body.result.content[0].text)
		assert.equal(hits.total, 1)
		assert.equal(hits.files[0].name, 'remote.md')
	} finally {
		await box.close()
	}
})

test('MCP：项目路径被拒并带上插件自己的原因', async () => {
	const box = await fixture()
	try {
		const result = await post(box.port, {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'file_write', arguments: { target: 'harness/experience/x.md', content: '# x\n', meta: { description: '经 MCP 写 harness 应当被拒绝' } } },
		}, { token: box.token })
		assert.equal(result.body.result.isError, true, '项目路径不静默成功')
		assert.match(result.body.result.content[0].text, /工作目录|会话/, '错误文案说明为什么不行')
	} finally {
		await box.close()
	}
})

test('MCP：令牌是关键，缺了只给 401', async () => {
	const box = await fixture()
	try {
		const missing = await post(box.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: '' })
		assert.equal(missing.status, 401)
		assert.equal(missing.body.error.code, -32600)

		const wrong = await post(box.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: 'not-the-token' })
		assert.equal(wrong.status, 401)

		// 查询参数与 Authorization 头都认。
		const viaQuery = await post(box.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: box.token })
		assert.equal(viaQuery.status, 200)
		const viaHeader = await post(box.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: box.token, header: true })
		assert.equal(viaHeader.status, 200)
	} finally {
		await box.close()
	}
})

test('MCP：GET 405、未知路径 404、坏 JSON 400、未知方法 -32601', async () => {
	const box = await fixture()
	try {
		const get = await new Promise((resolve, reject) => {
			const req = httpRequest({ host: '127.0.0.1', port: box.port, path: `/mcp?token=${encodeURIComponent(box.token)}`, method: 'GET' }, (res) => {
				res.resume()
				res.on('end', () => resolve(res.statusCode))
			})
			req.on('error', reject)
			req.end()
		})
		assert.equal(get, 405, '不提供服务端推送流')

		const wrongPath = await post(box.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: box.token, path: '/nope' })
		assert.equal(wrongPath.status, 404)

		const unknown = await post(box.port, { jsonrpc: '2.0', id: 9, method: 'resources/list' }, { token: box.token })
		assert.equal(unknown.body.error.code, -32601)
		assert.equal(unknown.body.id, 9, '错误仍回显 id')

		const ping = await post(box.port, { jsonrpc: '2.0', id: 10, method: 'ping' }, { token: box.token })
		assert.deepEqual(ping.body.result, {})
	} finally {
		await box.close()
	}
})

test('MCP：关掉开关就真的不再监听', async () => {
	const box = await fixture()
	try {
		assert.equal(box.service.status().running, true)
		await box.service.stop()
		assert.equal(box.service.status().running, false)
		await assert.rejects(
			() => post(box.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: box.token }),
			/ECONNREFUSED/,
			'端口已经放开',
		)
	} finally {
		await box.close()
	}
})

test('MCP：版本协商与端点 URL', () => {
	assert.equal(negotiateVersion('2026-07-28'), '2026-07-28', '回显客户端版本，客户端更新也能连')
	assert.equal(negotiateVersion(''), '2025-06-18', '没给版本时用本实现最新的')
	assert.equal(negotiateVersion(undefined), '2025-06-18')
	assert.equal(endpointUrl(3199, 'abc'), 'http://127.0.0.1:3199/mcp?token=abc')
	assert.equal(endpointUrl(3199, ''), 'http://127.0.0.1:3199/mcp')
})
