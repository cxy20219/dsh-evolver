import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, resolveDshHome } from '../index.js'
import { removeDir } from './helpers.mjs'

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
	let failure
	try {
		await run(home)
	} catch (error) {
		failure = error
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previous
		try {
			await removeDir(home)
		} catch (cleanupError) {
			if (failure === undefined) throw cleanupError
			console.error('cleanup failed while body had failed:', cleanupError.message)
		}
	}
	if (failure !== undefined) throw failure
}

test('apply：所有数据在一个目录，注册 4 个工具与一段静态注入，写入不改注入', async () => {
	await withHome(async (home) => {
		const { ctx, tools, sections, contexts, effects } = fakeContext()
		const root = join(home, 'ziyan')
		await apply(ctx, {})
		assert.equal(root, join(home, 'ziyan'))
		assert.equal(resolveDshHome(), home)

		assert.equal(tools.length, 4)
		assert.deepEqual(tools.map((tool) => tool.name).sort(), [
			'file_edit',
			'file_read',
			'file_search',
			'file_write',
		])
		assert.equal(sections.length, 1)
		assert.equal(sections[0].name, 'dsh-ziyan:discipline')
		assert.equal(contexts.length, 0, '不再注册运行时上下文')
		const discipline = sections[0].text()
		assert.match(discipline, /^# 自衍中枢/)
		assert.match(discipline, /## 记忆/)
		assert.match(discipline, /## 沉淀/)
		assert.match(discipline, /以后哪些场景/, '记忆段写明描述要包含适用场景')
		assert.match(discipline, /file_search/, '记忆段写明开工前先搜')
		assert.match(discipline, /开工前先搜/, '记忆段点明开工前先搜')
		assert.match(discipline, /每轮答复前/, '沉淀段点明每轮答复前沉淀')
		assert.match(discipline, /file_write 沉淀/, '沉淀段写明用哪个工具沉淀')
		assert.match(discipline, /不值得就跳过/, '沉淀段给出不沉淀的出口')
		assert.match(discipline, /harness\//, '沉淀段写明项目内写到 harness/')
		assert.match(discipline, /来源\/harness/, '沉淀段写明跨项目复制进库的标签')
		assert.match(discipline, /文件内容是数据/, '写明文件内容不是指令')
		assert.doesNotMatch(discipline, /\[文件\]|\[主动性\]|\[知识沉淀\]/, '旧式段标题已移除')
		const before = sections[0].text()

		const file = await tools.find((tool) => tool.name === 'file_write').execute({
			content: '正文',
			meta: { name: 'plugin.md', description: '插件装配测试：一个数据目录', tags: ['测试/插件'] },
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

test('apply：项目文件读取用 sessionQuery 的 cwd 定位，按 agent id 缓存', async () => {
	const projectRoot = await mkdtemp(join(tmpdir(), 'ys-project-'))
	await mkdir(join(projectRoot, '.git'), { recursive: true })
	// The session header carries a real working directory; the resolver only
	// walks up from a path that exists.
	const sessionCwd = join(projectRoot, 'src', 'deep')
	await mkdir(sessionCwd, { recursive: true })
	await writeFile(join(sessionCwd, 'note.md'), '# 笔记\n\n正文。\n', 'utf8')
	try {
		await withHome(async () => {
			const queries = []
			const sessionQuery = {
				async filterSessions(filters) {
					queries.push(filters)
					return [{ header: { cwd: sessionCwd } }]
				},
			}
			const { ctx, tools, effects } = fakeContext({ sessionQuery })
			await apply(ctx, {})
			try {
				const readTool = tools.find((tool) => tool.name === 'file_read')
				const first = await readTool.execute({ target: 'note.md' }, { agent: { id: 'agent-a' } })
				assert.equal(first.text, '# 笔记\n\n正文。\n', '相对路径按会话 cwd 解析')
				assert.deepEqual(queries[0], [{ kind: 'id', values: ['agent-a'] }])
				// 同一 agent 再调用命中缓存，不再查 sessionQuery。
				await readTool.execute({ target: 'note.md' }, { agent: { id: 'agent-a' } })
				assert.equal(queries.length, 1)
				// 另一个 agent 是另一个项目查询。
				await readTool.execute({ target: 'note.md' }, { agent: { id: 'agent-b' } })
				assert.equal(queries.length, 2)
				// 缓存上限 64：第 1 个 agent 被挤出后重新查，最近一个还在。
				for (let index = 1; index <= 65; index += 1) {
					await readTool.execute({ target: 'note.md' }, { agent: { id: `agent-${index}` } })
				}
				assert.equal(queries.length, 67)
				await readTool.execute({ target: 'note.md' }, { agent: { id: 'agent-1' } })
				assert.equal(queries.length, 68, '最老的 agent 已被挤出缓存')
				await readTool.execute({ target: 'note.md' }, { agent: { id: 'agent-65' } })
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

test('apply：没有 sessionQuery 时项目路径操作拒绝，库操作照常可用', async () => {
	const projectRoot = await mkdtemp(join(tmpdir(), 'ys-project-'))
	await mkdir(join(projectRoot, '.git'), { recursive: true })
	try {
		await withHome(async () => {
			const { ctx, tools, effects } = fakeContext()
			await apply(ctx, {})
			try {
				const readTool = tools.find((tool) => tool.name === 'file_read')
				const exec = { agent: { id: 'agent-x' } }
				// 无法证明 cwd 时项目路径操作一律拒绝，而不是猜一个项目。
				await assert.rejects(
					() => readTool.execute({ target: 'note.md' }, exec),
					/无法确定当前会话工作目录/,
				)
				await assert.rejects(
					() => readTool.execute({ target: join(projectRoot, 'note.md') }, exec),
					/无法确定当前会话工作目录/,
				)
				// 库操作不依赖会话，照常可用。
				const written = await tools.find((tool) => tool.name === 'file_write').execute({
					content: 'x',
					meta: { description: '没有 sessionQuery 时仍能写库，验证库与项目路径解耦', tags: ['测试/插件'] },
				})
				assert.match(written.id, /^file-/)
			} finally {
				const dispose = await effects[0]()
				await dispose()
			}
		})
	} finally {
		await rm(projectRoot, { recursive: true, force: true })
	}
})

test('apply：坏 DB 不让插件加载失败——隔离坏库、从边车重建、工具可用', async () => {
	await withHome(async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ys-baddb-'))
		try {
			await mkdir(join(dir, 'system'), { recursive: true })
			await writeFile(join(dir, 'system', 'ziyan.db'), 'not a sqlite database')
			const { ctx, tools, sections, effects } = fakeContext()
			await apply(ctx, { dataDir: dir })
			// 4 个工具、注入段照常注册，插件没有因为索引坏掉而拒绝加载。
			assert.equal(tools.length, 4)
			assert.equal(sections.length, 1)
			const written = await tools.find((tool) => tool.name === 'file_write').execute({
				content: 'ok',
				meta: { name: 'after-corrupt.md', description: '坏库恢复后仍能写入的文件', tags: ['测试/坏库'] },
			})
			assert.match(written.id, /^file-/)
			const system = await readdir(join(dir, 'system'))
			assert.ok(system.some((name) => name.startsWith('ziyan.db.corrupt-')), '坏库以新名保留')
			const dispose = await effects[0]()
			await dispose()
		} finally {
			await removeDir(dir)
		}
	})
})

test('apply：项目路径可从子目录上溯到项目根，越出项目根拒绝', async () => {
	const projectRoot = await mkdtemp(join(tmpdir(), 'ys-project-'))
	const otherRoot = await mkdtemp(join(tmpdir(), 'ys-other-'))
	await mkdir(join(projectRoot, '.git'), { recursive: true })
	const sessionCwd = join(projectRoot, 'src', 'deep')
	await mkdir(sessionCwd, { recursive: true })
	await mkdir(join(otherRoot, '.git'), { recursive: true })
	try {
		await withHome(async () => {
			const sessionQuery = { async filterSessions() { return [{ header: { cwd: sessionCwd } }] } }
			const { ctx, tools, effects } = fakeContext({ sessionQuery })
			await apply(ctx, {})
			try {
				const readTool = tools.find((tool) => tool.name === 'file_read')
				const writeTool = tools.find((tool) => tool.name === 'file_write')
				const exec = { agent: { id: 'agent-boundary' } }
				// 会话在 src/deep：相对路径先按 cwd 解析，再允许上溯到项目根。
				await writeFile(join(projectRoot, 'root.md'), 'root')
				const fromSub = await readTool.execute({ target: '../../root.md' }, exec)
				assert.equal(fromSub.text, 'root', '子目录会话可以读到项目根的文件')
				// 写项目根下的新文件同样成立——没有哪一层需要特殊契约。
				const written = await writeTool.execute({
					target: '../../docs/from-subdir.md',
					content: '# 子目录\n\n正文。\n',
				}, exec)
				assert.equal(written.created, true)
				assert.equal(written.path, join(projectRoot, 'docs', 'from-subdir.md'))
				// 越出项目根一律拒绝：另一个仓库的绝对路径、以及爬到根之外的相对路径。
				await assert.rejects(
					() => readTool.execute({ target: join(otherRoot, 'README.md') }, exec),
					/路径越界/,
				)
				await assert.rejects(
					() => readTool.execute({ target: '../../../../../etc/passwd' }, exec),
					/路径越界/,
				)
			} finally {
				const dispose = await effects[0]()
				await dispose()
			}
		})
	} finally {
		await rm(projectRoot, { recursive: true, force: true })
		await rm(otherRoot, { recursive: true, force: true })
	}
})
