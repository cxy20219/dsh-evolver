import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { API_PREFIX, apply } from '../index.js'
import { readTar } from '../src/backup/tar.js'
import { fakeOss } from './support/fake-oss.mjs'

/**
 * A Host context with just enough of the real services.
 *
 * @returns {object} The fake context and what was registered on it.
 */
function fakeContext() {
	const routes = new Map()
	const tools = []
	const sections = []
	const effects = []
	const ctx = {
		logger: { info() {}, warn() {} },
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
		},
		get(name) {
			if (name !== 'connection') return undefined
			return {
				fetch: {
					register(route) {
						routes.set(route.path, route)
						return () => {}
					},
				},
			}
		},
		effect(effect, label) {
			effects.push({ effect, label })
			return () => {}
		},
	}
	return { ctx, routes, tools, sections, effects }
}

/**
 * Call one registered endpoint the way the browser would.
 *
 * @param {Map<string, object>} routes - The registered routes.
 * @param {string} endpoint - The endpoint name.
 * @param {object} payload - The request payload.
 * @param {Record<string, string>} [headers] - Extra headers.
 * @returns {Promise<Response>} The response.
 */
function post(routes, endpoint, payload, headers = {}) {
	const path = `${API_PREFIX}/${endpoint}`
	const route = routes.get(path)
	assert.ok(route !== undefined, `接口没有注册：${path}`)
	return route.fetch(new Request(`http://127.0.0.1${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(payload),
	}))
}

/**
 * Run one test with a temporary DSH home.
 *
 * @param {(home: string) => Promise<void>} run - The test body.
 * @returns {Promise<void>} Resolves when the body and cleanup finished.
 */
async function withHome(run) {
	const home = await mkdtemp(join(tmpdir(), 'evr-plugin-'))
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


/**
 * Tear down the registered effects, calling the disposer they return.
 *
 * @param {object[]} effects - The collected effects.
 * @returns {Promise<void>} Resolves when everything is torn down.
 */
async function disposeEffects(effects) {
	for (const { effect } of effects) {
		const disposer = await effect()
		if (typeof disposer === 'function') await disposer()
	}
}

test('apply 注册工具、注入与接口，写操作后注入立刻更新', async () => {
	await withHome(async (home) => {
		const { ctx, routes, tools, sections, effects } = fakeContext()
		await apply(ctx, { dataDir: join(home, 'evolver') })
		try {
			assert.equal(tools.length, 9)
			assert.deepEqual(sections.map((section) => section.name), ['dsh-evolver:practice', 'dsh-evolver:soul'])
			assert.equal(routes.size, 25)
			assert.match(sections[0].text(), /\[实践\]/)

			const overview = await (await post(routes, 'overview', {})).json()
			assert.ok(overview.practice.entries >= 2)
			const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
			assert.equal(overview.version, pkg.version)

			const saved = await (await post(routes, 'practice-write', {
				kind: 'doc',
				name: 'api.md',
				title: '来自接口',
				purpose: '接口写入的条目',
				topic: 'T',
				body: '正文',
			})).json()
			assert.equal(saved.path, 'docs/t/api.md')
			// The prompt section reads the same cache, so it must see the write.
			assert.match(sections[0].text(), /来自接口/)

			const read = await (await post(routes, 'practice-read', { path: 'docs/t/api.md' })).json()
			assert.equal(read.title, '来自接口')

			const query = await (await post(routes, 'practice-query', { query: '来自接口', limit: 'many' })).json()
			assert.equal(query.total, 1)

			const filtered = await (await post(routes, 'practice-query', { query: '来自接口', limit: -3 })).json()
			assert.equal(filtered.total, 1)
		} finally {
			await disposeEffects(effects)
		}
	})
})

test('接口拒绝超大请求体', async () => {
	await withHome(async (home) => {
		const { ctx, routes, effects } = fakeContext()
		await apply(ctx, { dataDir: join(home, 'evolver') })
		try {
			const response = await post(routes, 'soul', {}, { 'content-length': String(9 * 1024 * 1024) })
			assert.equal(response.status, 413)
			const payload = await response.json()
			assert.match(payload.error.message, /超过/)
		} finally {
			await disposeEffects(effects)
		}
	})
})

test('dataDir 必须是绝对路径', async () => {
	await withHome(async () => {
		const { ctx } = fakeContext()
		await assert.rejects(() => apply(ctx, { dataDir: 'relative/evolver' }), /绝对路径/)
	})
})

test('设置接口不回传密钥，密钥只落在 0600 的本地文件里', async () => {
	await withHome(async (home) => {
		const { ctx, routes, effects } = fakeContext()
		await apply(ctx, { dataDir: join(home, 'evolver') })
		try {
			const view = await (await post(routes, 'settings', {})).json()
			assert.equal(view.dataDir, join(home, 'evolver'))
			assert.equal(view.backup.hasAccessKeySecret, false)
			assert.equal(Object.hasOwn(view.backup, 'accessKeySecret'), false)

			const saved = await (await post(routes, 'settings-save', {
				backup: {
					enabled: true,
					endpoint: 'https://oss.example.com',
					bucket: 'bucket',
					accessKeyId: 'AKID',
					accessKeySecret: 'SEKRET',
					prefix: 'evolver',
					keep: 3,
					intervalMinutes: 30,
				},
			})).json()
			assert.equal(saved.backup.hasAccessKeySecret, true)
			assert.equal(JSON.stringify(saved).includes('SEKRET'), false)
			assert.equal(saved.backup.keep, 3)

			const settingsPath = join(home, 'evolver.config.json')
			assert.equal((await stat(settingsPath)).mode & 0o777, 0o600)
			assert.match(await readFile(settingsPath, 'utf8'), /SEKRET/)

			const cleared = await (await post(routes, 'settings-save', { backup: { clearAccessKeySecret: true } })).json()
			assert.equal(cleared.backup.hasAccessKeySecret, false)
		} finally {
			await disposeEffects(effects)
		}
	})
})

test('导出、导入与迁移数据目录', async () => {
	await withHome(async (home) => {
		const { ctx, routes, effects } = fakeContext()
		const root = join(home, 'evolver')
		await apply(ctx, { dataDir: root })
		try {
			const exportDir = join(home, 'exported')
			const exported = await (await post(routes, 'data-export', { dir: exportDir })).json()
			assert.ok(exported.files >= 2)
			await readFile(join(exportDir, 'practice', 'INDEX.md'), 'utf8')

			// 导出目录在数据目录里面会被拒绝
			const nested = await post(routes, 'data-export', { dir: join(root, 'nested') })
			assert.equal(nested.status, 400)
			const rootDir = await post(routes, 'data-export', { dir: '/' })
			assert.equal(rootDir.status, 400)

			const imported = await (await post(routes, 'data-import', { dir: exportDir })).json()
			assert.equal(imported.root, root)

			// 目标非空且没勾选覆盖时不迁移
			const busy = join(home, 'busy')
			await mkdir(busy, { recursive: true })
			await writeFile(join(busy, 'keep.txt'), 'x', 'utf8')
			const refused = await post(routes, 'data-migrate', { dir: busy })
			assert.equal(refused.status, 400)

			const movedTo = join(home, 'moved')
			const moved = await (await post(routes, 'data-migrate', { dir: movedTo })).json()
			assert.equal(moved.root, movedTo)
			assert.equal(moved.settings.dataDir, movedTo)
			await readFile(join(movedTo, 'practice', 'INDEX.md'), 'utf8')

			// 全局偏好链接跟着数据目录走
			const link = await readlink(join(home, 'AGENTS.md'))
			assert.equal(link, join(movedTo, 'preferences', 'AGENTS.md'))
			assert.equal((await lstat(join(home, 'AGENTS.md'))).isSymbolicLink(), true)

			// 之后的写入落进新目录，旧目录不动
			await post(routes, 'practice-write', {
				kind: 'doc', name: 'after.md', title: '迁移之后', purpose: 'p', topic: 'T', body: 'b',
			})
			await readFile(join(movedTo, 'practice', 'docs', 't', 'after.md'), 'utf8')
			await assert.rejects(() => readFile(join(root, 'practice', 'docs', 't', 'after.md'), 'utf8'))
			assert.equal((await (await post(routes, 'overview', {})).json()).version.length > 0, true)
		} finally {
			await disposeEffects(effects)
		}
	})
})

test('立即备份走完整链路：上传 tar、按保留份数清理、记录状态', async () => {
	const oss = await fakeOss()
	try {
	await withHome(async (home) => {
		const { ctx, routes, effects } = fakeContext()
		await apply(ctx, { dataDir: join(home, 'evolver') })
		try {
			const saved = await (await post(routes, 'settings-save', {
				backup: {
					enabled: true,
					endpoint: oss.url,
					bucket: 'test',
					accessKeyId: 'testid',
					accessKeySecret: 'secret',
					prefix: 'evolver',
					keep: 1,
					intervalMinutes: 60,
				},
			})).json()
			assert.equal(saved.backup.hasAccessKeySecret, true)

			const first = await (await post(routes, 'backup-now', {})).json()
			assert.match(first.key, /^evolver\/backup-.+\.tar$/)
			assert.ok(first.bytes > 0)
			assert.equal(oss.objects.size, 1)
			const restored = readTar(oss.objects.get(first.key))
			assert.ok(restored.some((file) => file.path === 'practice/INDEX.md'))

			// 密钥到了服务端：请求带 OSS 签名头
			const put = oss.requests.find((request) => request.method === 'PUT')
			assert.match(put.headers.authorization, /^OSS testid:/)

			// 对象名带毫秒，同一秒内的两次备份也不会互相覆盖
			const second = await (await post(routes, 'backup-now', {})).json()
			assert.notEqual(second.key, first.key)
			assert.equal(oss.objects.size, 1)
			assert.equal(oss.objects.has(first.key), false)

			const view = await (await post(routes, 'settings', {})).json()
			assert.ok(view.status.lastBackupAt !== '')
			assert.equal(view.status.lastError, '')
			assert.equal(view.status.lastFiles > 0, true)
		} finally {
			await disposeEffects(effects)
		}
	})
	} finally {
		await oss.close()
	}
})
