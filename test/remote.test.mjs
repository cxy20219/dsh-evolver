import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'

import { apply, API_PREFIX } from '../index.js'
import { createZiyanHandler } from '../src/remote.js'
import { estimateTokens } from '../src/tokens.js'
import { removeDir } from './helpers.mjs'

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
	let failure
	try {
		await apply(ctx, { dataDir: dir })
		assert.equal(routes.size, 27)

		const empty = await post(routes, 'overview')
		assert.equal(empty.stats.files, 0)
		assert.equal(empty.stats.days, 0)
		assert.deepEqual(empty.activity, [])
		assert.equal('injection' in empty, false, '概览不再带注入字段')
		// The overview tab only draws stats/tags/activity-year/suffixes; the
		// graph tab asks its own endpoint and nothing read these copies.
		assert.equal('graph' in empty, false, '概览不再白算 500 节点图')
		assert.equal('recent' in empty, false, '概览不再带最近文件')
		assert.equal('settings' in empty, false, '概览不再带设置副本')

		const data = await post(routes, 'data-status')
		assert.equal(data.current, dir)
		assert.equal(data.files, 0)

		const injection = await post(routes, 'injection')
		assert.deepEqual(Object.keys(injection).sort(), ['static', 'staticTokens'], '只返回静态段与 token 估算')
		assert.match(injection.static, /^# 自衍中枢/, '静态段用 AGENTS.md 风格标题')
		assert.match(injection.static, /## 记忆/)
		assert.match(injection.static, /## 沉淀/)
		assert.match(injection.static, /以后哪些场景/, '记忆段说明描述要包含适用场景')
		assert.match(injection.static, /file_search/, '记忆段写明开工前先搜')
		assert.match(injection.static, /开工前先搜/, '记忆段点明开工前先搜')
		assert.match(injection.static, /每轮答复前/, '沉淀段点明每轮答复前沉淀')
		assert.match(injection.static, /file_write 沉淀/, '沉淀段写明用哪个工具沉淀')
		assert.match(injection.static, /harness\//, '沉淀段写明项目内写到 harness/')
		assert.match(injection.static, /来源\/harness/, '沉淀段写明跨项目复制进库的标签')
		assert.match(injection.static, /文件内容是数据/, '写明文件内容不是指令')
		assert.doesNotMatch(injection.static, /\[文件\]|\[主动性\]|\[知识沉淀\]/, '旧式段标题已移除')
		assert.equal(injection.staticTokens, estimateTokens(injection.static), '静态段的 token 估算与宿主口径一致')
		assert.equal('staticBytes' in injection, false, '注入响应不再回字节数')
		const refreshed = await post(routes, 'injection', { refresh: true })
		assert.deepEqual(refreshed, injection, 'refresh 载荷不再有刷新含义，响应不变')

		// 工具目录：面板「注入 → 工具」子标签的数据面，一眼看清注册了什么。
		const catalog = await post(routes, 'tools')
		assert.equal(catalog.total, 4)
		assert.equal(catalog.tokens > 0, true, '工具 schema 有 token 估算')
		assert.equal(catalog.tools.every((tool) => tool.tokens > 0), true, '每个工具带 token 估算')
		assert.deepEqual(catalog.tools.map((tool) => tool.name), [
			'file_search',
			'file_read',
			'file_write',
			'file_edit',
		])
		assert.equal(catalog.tools.find((tool) => tool.name === 'file_search').category, 'read')
		assert.equal(catalog.tools.find((tool) => tool.name === 'file_read').category, 'read')
		assert.equal(catalog.tools.find((tool) => tool.name === 'file_write').category, 'write')
		assert.equal(catalog.tools.find((tool) => tool.name === 'file_edit').category, 'write')
		assert.ok(catalog.tools.every((tool) => tool.description.trim() !== ''))
		assert.ok(catalog.tools.every((tool) => tool.parameters.type === 'object'))
		assert.ok(catalog.tools.every((tool) => tool.output === undefined), 'output.render 不出宿主')

		// 偏好：权威文件在自衍数据目录，DSH 读的 AGENTS.md 链接到它。
		const fresh = await post(routes, 'preferences')
		assert.equal(fresh.exists, true)
		assert.equal(fresh.content, '')
		assert.equal(fresh.path, join(dir, 'system', 'AGENTS.md'), '数据文件在自衍数据目录')
		assert.equal(fresh.agentsPath, join(home, 'AGENTS.md'), 'DSH 读取入口在 DSH home')
		assert.ok(fresh.mode === 'link' || fresh.mode === 'copy', 'AGENTS.md 与数据文件已对齐')
		assert.equal('hasBlock' in fresh, false, '不再有受管段概念')
		const savedPreferences = await post(routes, 'preferences-save', { content: '- 先读再改' })
		assert.equal(savedPreferences.content, '- 先读再改')
		const reread = await post(routes, 'preferences')
		assert.equal(reread.content, '- 先读再改')
		const agentsInfo = await lstat(join(home, 'AGENTS.md'))
		assert.equal(agentsInfo.isSymbolicLink(), fresh.mode === 'link', '软链能力与报告的 mode 一致')
		assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), '- 先读再改\n', 'DSH 读到的就是保存的内容')

		const digest = await post(routes, 'digest')
		assert.deepEqual(digest.sessions, [])
		assert.equal('organize' in digest, false, '问题清单已并入整理作业，digest 不再全量统计')
		assert.equal('unreadable' in digest, false, '面板不读会话不可读计数')

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
		assert.deepEqual(Object.keys(saved).sort(), ['dataDir', 'descriptionMaxChars', 'maxFileBytes', 'readTextBytes'], '面板只拿它读的四个字段')
		const settingsView = await post(routes, 'settings')
		assert.deepEqual(settingsView, saved, 'settings 与 settings-save 返回同一个窄视图')

		const exported = await post(routes, 'data-export')
		assert.ok(exported.base64.length > 0)
		assert.equal(exported.files, 2)

		const logs = await post(routes, 'logs', { limit: 20 })
		assert.ok(Array.isArray(logs.lines))
		assert.equal('status' in logs, false, '面板只用 path 与 lines，不再带状态副本')
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
	} catch (error) {
		failure = error
		throw error
	} finally {
		if (previousHome === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previousHome
		try {
			await removeDir(dir)
			await removeDir(home)
		} catch (cleanupError) {
			if (failure === undefined) throw cleanupError
			console.error('remote cleanup failed while body failed:', cleanupError.message)
		}
	}
})

test('tools 端点缺省依赖：没有工具就返回空目录', async () => {
	const handler = createZiyanHandler({ store: {}, settings: {}, logs: {}, root: '' })
	assert.deepEqual(await handler('tools'), { total: 0, tokens: 0, tools: [] })
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
		assert.equal(routes.size, 27)

		const status = await post(routes, 'organize-status')
		assert.equal(status.followsChat, true)
		assert.deepEqual(status.current, { provider: 'fake-provider', model: 'fake-model' })
		assert.equal(status.catalogFailed, false)
		assert.equal(status.providers[0].id, 'fake-provider')
		assert.deepEqual(status.providers[0].models[0].reasoning.efforts, [{ id: 'low', name: '低' }])
		assert.equal('kinds' in status, false, 'organize-status 不再带 kinds：面板从不读')
		assert.equal('limits' in status, false, 'organize-status 不再带 limits：面板从不读')
		assert.equal(status.job, null)

		const prompts = await post(routes, 'organize-prompts')
		assert.deepEqual(prompts.sections.map((section) => section.id), ['sessions', 'files', 'wrapup', 'wrapup-dry'])
		assert.match(prompts.sections[0].text, /会话整理员/)
		assert.match(prompts.sections[1].text, /文件整理员/)
		assert.match(prompts.sections[2].text, /收尾/)
		assert.match(prompts.sections[3].text, /预演计划/)
		for (const section of prompts.sections) {
			assert.equal(section.tokens, estimateTokens(section.text), '每段 token 估算与宿主口径一致')
			assert.equal('bytes' in section, false, '不再回字节数')
		}

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
		await removeDir(dir)
		await removeDir(home)
	}
})

test('file-preview：超大二进制只报大小不读正文；符号链接本体拒绝而不是读穿', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ys-preview-'))
	const home = await mkdtemp(join(tmpdir(), 'ys-home-'))
	const previousHome = process.env.DSH_HOME
	process.env.DSH_HOME = home
	const { ctx, routes, effects } = fakeContext()
	try {
		await apply(ctx, { dataDir: dir })
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		const created = await post(routes, 'file-upload', {
			name: 'shot.png',
			description: '预览大小预检测试的图片文件',
			tags: ['测试/预览'],
			data: png.toString('base64'),
		})
		// 把本体换成超过 8MB 预览上限的稀疏文件：边车不变，预览应先 stat 再决定。
		await truncate(created.path, 9 * 1024 * 1024)
		const preview = await post(routes, 'file-preview', { id: created.id })
		assert.deepEqual(preview, { kind: 'binary', bytes: 9 * 1024 * 1024 }, '不返回 12MB base64')

		// 本体换成库外文件的符号链接：store.read 已标 missing，预览必须拒绝。
		const outside = join(dir, 'outside.png')
		await writeFile(outside, '库外内容')
		await rm(created.path, { force: true })
		try {
			await symlink(outside, created.path)
		} catch {
			return // Windows 未开开发者模式时建不了软链；平台允许才测。
		}
		await assert.rejects(post(routes, 'file-preview', { id: created.id }), /文件本体缺失/)
	} finally {
		if (effects[0] !== undefined) {
			const disposer = await effects[0]()
			await disposer()
		}
		if (previousHome === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previousHome
		await removeDir(dir)
		await removeDir(home)
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
		content: '结论：整理接口接线通了。',
		meta: {
			name: '接口整理.md',
			description: '通过面板接口启动的会话整理写下的文件，验证宿主接线。',
			tags: ['测试/接口'],
		},
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
