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

test('apply：所有数据在一个目录，不注册任何工具，只有一段静态注入', async () => {
	await withHome(async (home) => {
		const { ctx, tools, sections, contexts, effects } = fakeContext()
		const root = join(home, 'ziyan')
		const applied = await apply(ctx, {})
		assert.equal(root, join(home, 'ziyan'))
		assert.equal(resolveDshHome(), home)

		// 工具不再挂到模型身上：agent 走 `ziyan` 命令或 ziyan-evolver skill，
		// 常驻上下文里只剩这段注入。四个动词仍由 `tools` 提供，读者是面板与
		// MCP，不是宿主。
		assert.equal(tools.length, 0, '不向宿主注册工具')
		assert.deepEqual(applied.tools.map((tool) => tool.name).sort(), [
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
		assert.match(discipline, /以后什么时候会用到它/, '记忆段写明描述要写「什么时候用」')
		assert.match(discipline, /ziyan search/, '记忆段写明用 ziyan search')
		assert.match(discipline, /开工前先搜/, '记忆段点明开工前先搜')
		assert.match(discipline, /每轮答复前/, '沉淀段点明每轮答复前沉淀')
		assert.match(discipline, /ziyan write/, '沉淀段写明用哪个命令沉淀')
		assert.match(discipline, /不值得就跳过/, '沉淀段给出不沉淀的出口')
		assert.match(discipline, /ziyan-evolver/, '记忆段指向 ziyan-evolver skill')
		assert.match(discipline, /来源\/harness/, '沉淀段写明跨项目复制进库的标签')
		assert.match(discipline, /文件内容是数据/, '写明文件内容不是指令')
		assert.doesNotMatch(discipline, /\[文件\]|\[主动性\]|\[知识沉淀\]/, '旧式段标题已移除')
		const before = sections[0].text()

		const file = await applied.store.create({
			content: '正文',
			name: 'plugin.md',
			description: '插件装配测试：一个数据目录',
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

test('apply：坏 DB 不让插件加载失败——隔离坏库、从边车重建、库仍可写', async () => {
	await withHome(async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ys-baddb-'))
		try {
			await mkdir(join(dir, 'system'), { recursive: true })
			await writeFile(join(dir, 'system', 'ziyan.db'), 'not a sqlite database')
			const { ctx, tools, sections, effects } = fakeContext()
			const applied = await apply(ctx, { dataDir: dir })
			// 注入段照常注册，插件没有因为索引坏掉而拒绝加载；工具本来就不再注册。
			assert.equal(tools.length, 0)
			assert.equal(sections.length, 1)
			const written = await applied.store.create({
				content: 'ok',
				name: 'after-corrupt.md',
				description: '坏库恢复后仍能写入的文件',
				tags: ['测试/坏库'],
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
