import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, API_PREFIX } from '../index.js'

/**
 * A Host context with a fake Connection service.
 *
 * @returns {object} The context and what it registered.
 */
function fakeContext() {
	const routes = new Map()
	const tools = []
	const sections = []
	const contexts = []
	const effects = []
	const connection = {
		fetch: {
			register(route) {
				routes.set(route.path, route)
				return () => {}
			},
		},
	}
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		tools: {
			register(tool) {
				tools.push(tool)
				return () => {}
			},
		},
		systemPrompt: {
			section(section) {
				sections.push(section)
				return () => {}
			},
			context(entry) {
				contexts.push(entry)
				return () => {}
			},
		},
		get(name) {
			return name === 'connection' ? connection : undefined
		},
		effect(effect) {
			effects.push(effect)
			return () => {}
		},
	}
	return { ctx, routes, tools, sections, contexts, effects }
}

/**
 * POST one endpoint the way the browser would.
 *
 * @param {Map<string, object>} routes - Registered routes.
 * @param {string} endpoint - Endpoint name.
 * @param {object} payload - JSON payload.
 * @returns {Promise<object>} The parsed value.
 */
async function post(routes, endpoint, payload = {}) {
	const path = `${API_PREFIX}/${endpoint}`
	const route = routes.get(path)
	assert.ok(route !== undefined, `接口没有注册：${path}`)
	const response = await route.fetch(new Request(`http://127.0.0.1${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	}))
	const value = await response.json()
	if (response.ok !== true) throw new Error(value?.error?.message ?? `HTTP ${response.status}`)
	return value
}

test('面板接口：16 个端点，一次完整读写/上传/预览/图/设置/日志/删除', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ys-remote-'))
	const { ctx, routes, effects } = fakeContext()
	try {
		await apply(ctx, { dataDir: dir })
		assert.equal(routes.size, 16)

		const empty = await post(routes, 'overview')
		assert.equal(empty.stats.files, 0)
		assert.match(empty.injection, /库是空的/)

		const data = await post(routes, 'data-status')
		assert.equal(data.current, dir)
		assert.equal(data.files, 0)

		const created = await post(routes, 'file-write', {
			name: 'api.md',
			description: '面板接口测试文件：描述与标签',
			content: '正文由 agent 读。',
			tags: ['测试/面板'],
			links: [],
		})
		assert.match(created.id, /^file-/)

		const listed = await post(routes, 'file-list', { query: '面板接口' })
		assert.equal(listed.total, 1)
		assert.equal(listed.files[0].id, created.id)

		const read = await post(routes, 'file-read', { id: created.id })
		assert.match(read.text, /正文由 agent 读/)
		const preview = await post(routes, 'file-preview', { id: created.id })
		assert.equal(preview.kind, 'text')
		assert.match(preview.text, /正文由 agent 读/)

		const updated = await post(routes, 'file-write', { id: created.id, description: '面板接口测试文件（已改）' })
		assert.equal(updated.description, '面板接口测试文件（已改）')

		const uploaded = await post(routes, 'file-upload', {
			name: 'run.sh',
			description: '上传的可执行脚本',
			tags: ['测试/面板', '类型/脚本'],
			data: Buffer.from('#!/bin/sh\necho ok\n').toString('base64'),
		})
		assert.equal(uploaded.executable, true)
		assert.match(uploaded.path, /run\.sh$/)

		const graph = await post(routes, 'graph')
		assert.ok(graph.nodes.length >= 2)
		assert.ok(graph.edges.length >= 0)

		const saved = await post(routes, 'settings-save', { descriptionMaxChars: 200 })
		assert.equal(saved.descriptionMaxChars, 200)

		const exported = await post(routes, 'data-export')
		assert.ok(exported.base64.length > 0)
		assert.equal(exported.files, 2)

		const logs = await post(routes, 'logs', { limit: 20 })
		assert.ok(Array.isArray(logs.lines))
		assert.match(logs.path, /system\/logs\/plugin\.log$/)

		const archived = await post(routes, 'file-archive', { id: uploaded.id, archived: true })
		assert.equal(archived.archived, true)
		const live = await post(routes, 'file-list', { query: '上传的可执行脚本' })
		assert.equal(live.total, 0)
		const all = await post(routes, 'file-list', { query: '上传的可执行脚本', archived: true })
		assert.equal(all.total, 1)

		const removed = await post(routes, 'file-remove', { id: uploaded.id })
		assert.equal(removed.trashed, true)
		const gone = await post(routes, 'file-read', { id: uploaded.id })
		assert.equal(gone.found, false)

		const missing = await post(routes, 'file-read', { id: 'file-01M7ZZZZZZZZZZZZZZZZZZZZZZ' })
		assert.equal(missing.found, false)

		const disposer = await effects[0]()
		await disposer()
		await assert.rejects(post(routes, 'overview'))
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
