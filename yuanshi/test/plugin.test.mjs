import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, resolveDshHome } from '../index.js'

/**
 * A Host context with just enough of the real services.
 *
 * @returns {object} The fake context and what was registered on it.
 */
function fakeContext() {
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
		get() {
			return undefined
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

test('apply：所有数据在一个目录，注册 8 个工具与两段注入，写入不改注入', async () => {
	await withHome(async (home) => {
		const { ctx, tools, sections, contexts, effects } = fakeContext()
		const result = await apply(ctx, {})
		assert.equal(result.root, join(home, 'yuanshi'))
		assert.equal(resolveDshHome(), home)

		assert.equal(tools.length, 8)
		assert.deepEqual(tools.map((tool) => tool.name).sort(), [
			'file_archive',
			'file_import',
			'file_index',
			'file_link',
			'file_query',
			'file_read',
			'file_remove',
			'file_write',
		])
		assert.equal(sections.length, 1)
		assert.equal(contexts.length, 1)
		assert.match(sections[0].text(), /\[文件\]/)
		const before = contexts[0].text()
		assert.match(before, /库是空的/)

		const file = await tools.find((tool) => tool.name === 'file_write').execute({
			name: 'plugin.md',
			description: '插件装配测试：一个数据目录',
			content: '正文',
			tags: ['测试/插件'],
		})
		assert.match(file.id, /^file-/)
		assert.equal(contexts[0].text(), before, '写文件不改变当天的注入文本')

		const snapshot = JSON.parse(await readFile(join(result.root, 'index.json'), 'utf8'))
		assert.equal(snapshot.summary.files, 0, '快照仍是打开时那一版')

		const listing = await readdir(result.root)
		for (const name of ['files', 'trash', 'logs', 'yuanshi.db', 'index.json', 'settings.json']) {
			assert.ok(listing.includes(name), `数据目录缺少 ${name}`)
		}
		assert.deepEqual(await readdir(home), ['yuanshi'], '数据目录外不应有插件数据')

		const disposer = await effects[0]()
		await disposer()
		assert.equal(result.store.db.db, null, 'dispose 应该关闭索引')
		const log = await readFile(join(result.root, 'logs', 'plugin.log'), 'utf8')
		assert.match(log, /数据目录/)
	})
})

test('apply 拒绝相对路径的 dataDir', async () => {
	await withHome(async () => {
		const { ctx } = fakeContext()
		await assert.rejects(() => apply(ctx, { dataDir: 'relative/yuanshi' }), /绝对路径/)
	})
})
