import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, resolveDshHome } from '../index.js'

/**
 * A Host context with just enough of the real services.
 *
 * @param {Record<string, object>} [services] - Extra Cordis services (`sessionQuery`, `llm`).
 * @returns {object} The fake context and what was registered on it.
 */
function fakeContext(services = {}) {
	const tools = []
	const sections = []
	const contexts = []
	const effects = []
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
			return services[name]
		},
		effect(effect) {
			effects.push(effect)
			return () => {}
		},
	}
	return { ctx, tools, sections, contexts, effects }
}

/**
 * Run one test with a temporary DSH home.
 *
 * @param {(home: string) => Promise<void>} run - The test body.
 * @returns {Promise<void>} Resolves when the body and cleanup finished.
 */
async function withHome(run) {
	const home = await mkdtemp(join(tmpdir(), 'ys-plugin-'))
	const previous = process.env.DSH_HOME
	process.env.DSH_HOME = home
	try {
		await run(home)
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previous
		await rm(home, { recursive: true, force: true })
	}
}

test('apply：所有数据在一个目录，注册 12 个工具与一段静态注入，写入不改注入', async () => {
	await withHome(async (home) => {
		const { ctx, tools, sections, contexts, effects } = fakeContext()
		const root = join(home, 'ziyan')
		await apply(ctx, {})
		assert.equal(root, join(home, 'ziyan'))
		assert.equal(resolveDshHome(), home)

		assert.equal(tools.length, 12)
		assert.deepEqual(tools.map((tool) => tool.name).sort(), [
			'file_archive',
			'file_import',
			'file_index',
			'file_link',
			'file_query',
			'file_read',
			'file_remove',
			'file_write',
			'project_harness_catalog',
			'project_harness_promote',
			'project_harness_validate',
			'project_harness_write',
		])
		assert.equal(sections.length, 1)
		assert.equal(sections[0].name, 'dsh-ziyan:discipline')
		assert.equal(contexts.length, 0, '不再注册运行时上下文')
		assert.match(sections[0].text(), /\[文件\]/)
		assert.match(sections[0].text(), /\[项目 harness\]/)
		const before = sections[0].text()

		const file = await tools.find((tool) => tool.name === 'file_write').execute({
			name: 'plugin.md',
			description: '插件装配测试：一个数据目录',
			content: '正文',
			tags: ['测试/插件'],
		})
		assert.match(file.id, /^file-/)
		assert.equal(sections[0].text(), before, '写文件不改变系统段文本')

		await assert.rejects(
			() => readFile(join(root, 'system', 'index.json'), 'utf8'),
			{ code: 'ENOENT' },
			'不再写注入快照',
		)

		const rootListing = await readdir(root)
		assert.deepEqual(rootListing.sort(), ['files', 'system'], '根目录只分文件与系统数据两棵树')
		const systemListing = await readdir(join(root, 'system'))
		for (const name of ['trash', 'logs', 'ziyan.db', 'settings.json']) {
			assert.ok(systemListing.includes(name), `系统数据缺少 ${name}`)
		}
		assert.deepEqual(await readdir(home), ['ziyan'], '数据目录外不应有插件数据')

		const disposer = await effects[0]()
		await disposer()
		const log = await readFile(join(root, 'system', 'logs', 'plugin.log'), 'utf8')
		assert.match(log, /数据目录/)
	})
})

test('apply 拒绝相对路径的 dataDir', async () => {
	await withHome(async () => {
		const { ctx } = fakeContext()
		await assert.rejects(() => apply(ctx, { dataDir: 'relative/ziyan' }), /绝对路径/)
	})
})

test('apply：harness 工具用 sessionQuery 的 cwd 推断项目根，按 agent id 缓存', async () => {
	const projectRoot = await mkdtemp(join(tmpdir(), 'ys-project-'))
	await mkdir(join(projectRoot, '.git'), { recursive: true })
	try {
		await withHome(async () => {
			const queries = []
			const sessionQuery = {
				async filterSessions(filters) {
					queries.push(filters)
					return [{ header: { cwd: join(projectRoot, 'src', 'deep') } }]
				},
			}
			const { ctx, tools, effects } = fakeContext({ sessionQuery })
			await apply(ctx, {})
			try {
				const catalogTool = tools.find((tool) => tool.name === 'project_harness_catalog')
				const listed = await catalogTool.execute({ init: true }, { agent: { id: 'agent-a' } })
				assert.equal(listed.project, projectRoot, '项目根由会话 header.cwd 向上推断')
				assert.deepEqual(queries[0], [{ kind: 'id', values: ['agent-a'] }])
				// 同一 agent 再调用命中缓存，不再查 sessionQuery。
				await catalogTool.execute({}, { agent: { id: 'agent-a' } })
				assert.equal(queries.length, 1)
				// 另一个 agent 是另一个项目查询。
				await catalogTool.execute({}, { agent: { id: 'agent-b' } })
				assert.equal(queries.length, 2)
				// 缓存上限 64：第 1 个 agent 被挤出后重新查，最近一个还在。
				for (let index = 1; index <= 65; index += 1) {
					await catalogTool.execute({}, { agent: { id: `agent-${index}` } })
				}
				assert.equal(queries.length, 67)
				await catalogTool.execute({}, { agent: { id: 'agent-1' } })
				assert.equal(queries.length, 68, '最老的 agent 已被挤出缓存')
				await catalogTool.execute({}, { agent: { id: 'agent-65' } })
				assert.equal(queries.length, 68, '最近的 agent 仍在缓存里')
			} finally {
				const dispose = await effects[0]()
				await dispose()
			}
		})
	} finally {
		await rm(projectRoot, { recursive: true, force: true })
	}
})

test('apply：没有 sessionQuery 时 harness 工具要求显式 project', async () => {
	const projectRoot = await mkdtemp(join(tmpdir(), 'ys-project-'))
	await mkdir(join(projectRoot, '.git'), { recursive: true })
	try {
		await withHome(async () => {
			const { ctx, tools, effects } = fakeContext()
			await apply(ctx, {})
			try {
				const catalogTool = tools.find((tool) => tool.name === 'project_harness_catalog')
				await assert.rejects(
					() => catalogTool.execute({}, { agent: { id: 'agent-x' } }),
					/无法推断项目目录/,
				)
				const listed = await catalogTool.execute({ project: projectRoot }, { agent: { id: 'agent-x' } })
				assert.equal(listed.project, projectRoot)
			} finally {
				const dispose = await effects[0]()
				await dispose()
			}
		})
	} finally {
		await rm(projectRoot, { recursive: true, force: true })
	}
})
