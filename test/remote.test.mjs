import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'

import { apply, API_PREFIX } from '../index.js'
import { createZiyanHandler } from '../src/remote.js'

/**
 * A Host context with a fake Connection service.
 *
 * @param {Record<string, object>} [services] - Extra Cordis services (`llm`, `agentDefaultModel`).
 * @returns {object} The context and what it registered.
 */
function fakeContext(services = {}) {
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
			if (name === 'connection') return connection
			return services[name]
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

test('面板接口：27 个端点，一次完整读写/上传/预览/图/注入/工具/偏好/自衍/设置/日志/删除', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ys-remote-'))
	const home = await mkdtemp(join(tmpdir(), 'ys-home-'))
	const previousHome = process.env.DSH_HOME
	process.env.DSH_HOME = home
	const { ctx, routes, effects } = fakeContext()
	try {
		await apply(ctx, { dataDir: dir })
		assert.equal(routes.size, 26)

		const empty = await post(routes, 'overview')
		assert.equal(empty.stats.files, 0)
		assert.equal(empty.stats.days, 0)
		assert.deepEqual(empty.activity, [])
		assert.equal('injection' in empty, false, '概览不再带注入字段')

		const data = await post(routes, 'data-status')
		assert.equal(data.current, dir)
		assert.equal(data.files, 0)

		const injection = await post(routes, 'injection')
		assert.deepEqual(Object.keys(injection).sort(), ['static', 'staticBytes'], '只返回静态段与字节数')
		assert.match(injection.static, /\[文件\]/)
		assert.match(injection.static, /\[项目 harness\]/)
		assert.equal(injection.staticBytes, Buffer.byteLength(injection.static, 'utf8'))
		const refreshed = await post(routes, 'injection', { refresh: true })
		assert.deepEqual(refreshed, injection, 'refresh 载荷不再有刷新含义，响应不变')

		// 工具目录：面板「注入 → 工具」子标签的数据面，一眼看清注册了什么。
		const catalog = await post(routes, 'tools')
		assert.equal(catalog.total, 12)
		assert.deepEqual(catalog.tools.map((tool) => tool.name), [
			'file_query',
			'file_read',
			'file_write',
			'file_import',
			'file_link',
			'file_index',
			'file_archive',
			'file_remove',
			'project_harness_catalog',
			'project_harness_write',
			'project_harness_validate',
			'project_harness_promote',
		])
		assert.equal(catalog.tools.find((tool) => tool.name === 'file_query').category, 'read')
		assert.equal(catalog.tools.find((tool) => tool.name === 'file_remove').category, 'destructive')
		assert.equal(catalog.tools.find((tool) => tool.name === 'project_harness_catalog').category, 'read')
		assert.equal(catalog.tools.find((tool) => tool.name === 'project_harness_promote').category, 'write')
		assert.ok(catalog.tools.every((tool) => tool.description.trim() !== ''))
		assert.ok(catalog.tools.every((tool) => tool.parameters.type === 'object'))
		assert.ok(catalog.tools.every((tool) => tool.output === undefined), 'output.render 不出宿主')

		// 偏好：写进 DSH home 的 AGENTS.md，读回来能看到那一段。
		const fresh = await post(routes, 'preferences')
		assert.equal(fresh.exists, false)
		assert.equal(fresh.hasBlock, false)
		assert.equal(fresh.content, '')
		const savedPreferences = await post(routes, 'preferences-save', { content: '- 先读再改' })
		assert.equal(savedPreferences.hasBlock, true)
		assert.equal(savedPreferences.content, '- 先读再改')
		const reread = await post(routes, 'preferences')
		assert.equal(reread.content, '- 先读再改')
		assert.ok(reread.path.startsWith(home), '偏好文件在 DSH home 下')

		const digest = await post(routes, 'digest')
		assert.deepEqual(digest.sessions, [])
		assert.equal(digest.organize.files.files, 0)
		assert.ok(Array.isArray(digest.organize.orphans.sample))
		assert.ok(Array.isArray(digest.organize.singleTags.sample))

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

		const saved = await post(routes, 'settings-save', { descriptionMaxChars: 200, injectionBudget: 99_999 })
		assert.equal(saved.descriptionMaxChars, 200)
		assert.equal('injectionBudget' in saved, false, 'settings-save 白名单不再含注入预算')

		const exported = await post(routes, 'data-export')
		assert.ok(exported.base64.length > 0)
		assert.equal(exported.files, 2)

		const logs = await post(routes, 'logs', { limit: 20 })
		assert.ok(Array.isArray(logs.lines))
		// The host reports a native path; normalise the separator before matching.
		assert.match(logs.path.replaceAll('\\', '/'), /system\/logs\/plugin\.log$/)

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
		if (previousHome === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previousHome
		await rm(dir, { recursive: true, force: true })
		await rm(home, { recursive: true, force: true })
	}
})

test('tools 端点缺省依赖：没有工具就返回空目录', async () => {
	const handler = createZiyanHandler({ store: {}, settings: {}, logs: {}, root: '' })
	assert.deepEqual(await handler('tools'), { total: 0, tools: [] })
})

test('整理接口：状态/保存/会话作业/轮询/取消五个端点走通', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ys-organize-'))
	const home = await mkdtemp(join(tmpdir(), 'ys-home-'))
	const previousHome = process.env.DSH_HOME
	process.env.DSH_HOME = home
	const llm = fakeOrganizeLlm()
	const { ctx, routes, effects } = fakeContext({
		llm,
		agentDefaultModel: { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) },
	})
	try {
		await apply(ctx, { dataDir: dir })
		assert.equal(routes.size, 26)

		const status = await post(routes, 'organize-status')
		assert.equal(status.followsChat, true)
		assert.deepEqual(status.current, { provider: 'fake-provider', model: 'fake-model' })
		assert.equal(status.catalogFailed, false)
		assert.equal(status.providers[0].id, 'fake-provider')
		assert.deepEqual(status.providers[0].models[0].reasoning.efforts, [{ id: 'low', name: '低' }])
		assert.deepEqual(status.kinds, ['sessions', 'files', 'all'])
		assert.equal(status.job, null)
		assert.equal(status.limits.maxSessions, 5)

		const saved = await post(routes, 'organize-save', {
			model: { provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'low' },
		})
		assert.equal(saved.followsChat, false)
		assert.deepEqual(saved.model, { provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'low' })

		const empty = await post(routes, 'organize-jobs')
		assert.deepEqual(empty.jobs, [])
		assert.equal(empty.total, 0)
		assert.equal(empty.running, '')

		// A real session log under the host's sessions folder, addressed by the
		// directory name the digest endpoint hands the panel.
		const sessionId = 'session-remote-1'
		const folder = join(home, 'sessions', '--E-AI-work-demo--', sessionId)
		await mkdir(folder, { recursive: true })
		const entries = [
			{ type: 'session', id: sessionId, createdAt: Date.parse('2026-11-12T08:00:00Z'), isSeeded: false, delegationDepth: 0 },
			{ type: 'session/title', data: { title: '远程整理' } },
			{
				type: 'user/message',
				seq: 1,
				time: Date.parse('2026-11-12T08:01:00Z'),
				data: { content: [{ type: 'text', text: '把接口接线的结论记下来' }], source: { kind: 'user' } },
			},
		]
		await writeFile(
			join(folder, 'session.v4.jsonl.zstd'),
			Buffer.concat(entries.map((entry) => zstdCompressSync(Buffer.from(`${JSON.stringify(entry)}\n`)))),
		)

		const started = await post(routes, 'organize-start', { kind: 'sessions', sessionIds: [sessionId] })
		assert.equal(started.job.kind, 'sessions')
		assert.ok(started.job.status === 'queued' || started.job.status === 'running')

		let job = started.job
		const deadline = Date.now() + 5_000
		while (job.status !== 'done' && job.status !== 'failed' && job.status !== 'cancelled' && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10))
			const listing = await post(routes, 'organize-jobs', { limit: 5 })
			job = listing.jobs[0]
		}
		assert.equal(job.status, 'done')
		assert.equal(job.phase, '完成')
		assert.equal(job.result.created, 1)
		assert.equal(job.changes[0].op, 'create')

		const written = await post(routes, 'file-list', { query: '接口整理' })
		assert.equal(written.total, 1)
		const listing = await post(routes, 'organize-jobs')
		assert.equal(listing.total, 1)
		assert.equal(listing.running, '')
		assert.equal(listing.jobs[0].selection.reasoningEffort, 'low')

		assert.deepEqual(await post(routes, 'organize-cancel', {}), { cancelled: false, job: null })
		await assert.rejects(post(routes, 'organize-start', { kind: 'bogus' }), /整理类型/)
	} finally {
		if (effects[0] !== undefined) {
			const disposer = await effects[0]()
			await disposer()
		}
		if (previousHome === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previousHome
		await rm(dir, { recursive: true, force: true })
		await rm(home, { recursive: true, force: true })
	}
})

/**
 * A scripted `llm` for the organize endpoints: one file_write tool call, then
 * a closing answer.
 *
 * @returns {object} The fake service with a `calls` log.
 */
function fakeOrganizeLlm() {
	const writeArguments = JSON.stringify({
		name: '接口整理.md',
		description: '通过面板接口启动的会话整理写下的文件，验证宿主接线。',
		tags: ['测试/接口'],
		content: '结论：整理接口接线通了。',
	})
	const turns = [
		[
			{ type: 'block-start', index: 0, blockType: 'tool-call' },
			{ type: 'tool-call-delta', index: 0, id: 'call-1', name: 'file_write', argumentsDelta: writeArguments },
			{ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'file_write', arguments: writeArguments } },
			{ type: 'finish', reason: { kind: 'tool-calls' } },
		],
		[
			{ type: 'block-start', index: 0, blockType: 'text' },
			{ type: 'text-delta', index: 0, text: '已写入 1 个文件。' },
			{ type: 'block-end', index: 0, block: { type: 'text', text: '已写入 1 个文件。' } },
			{ type: 'finish', reason: { kind: 'stop' } },
		],
	]
	const calls = []
	let index = 0
	return {
		calls,
		listProviders: async () => [{ id: 'fake-provider', name: 'Fake 提供者' }],
		listModels: async () => [{ provider: 'fake-provider', id: 'fake-model', name: 'Fake 模型' }],
		resolveModelInfo: async () => ({
			provider: 'fake-provider',
			id: 'fake-model',
			name: 'Fake 模型',
			reasoning: { efforts: [{ id: 'low', name: '低' }], defaultEffort: 'low' },
		}),
		stream(options) {
			calls.push(options)
			const turn = turns[Math.min(index, turns.length - 1)]
			index += 1
			return (async function* chunks() {
				for (const chunk of turn) yield chunk
			})()
		},
	}
}
