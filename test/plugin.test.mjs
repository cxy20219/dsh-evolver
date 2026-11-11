import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { readFile as readText } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { API_PREFIX, apply } from '../index.js'
import { ENDPOINTS } from '../src/remote.js'
import { createTar, readTar } from '../src/backup/tar.js'
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
			assert.deepEqual(sections.map((section) => section.name), ['dsh-evolver:cards', 'dsh-evolver:soul', 'dsh-evolver:proactive'])
			assert.equal(routes.size, ENDPOINTS.length)
			assert.match(sections[0].text(), /\[卡片\]/)
			assert.match(sections[2].text(), /\[主动性\]/)

			const overview = await (await post(routes, 'overview', {})).json()
			assert.ok(overview.projection.entries >= 2)
			assert.ok(overview.stats.cards >= 2)
			assert.equal(Array.isArray(overview.activity), true)
			assert.equal(overview.activity.length, 365)
			assert.ok(overview.year.notes >= 2)
			assert.ok(overview.stats.words > 0)
			assert.equal(Array.isArray(overview.tree), true)
			const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
			assert.equal(overview.version, pkg.version)

			const saved = await (await post(routes, 'card-write', {
				card: { body: '来自接口\n\n正文', tags: ['践行/测试'] },
			})).json()
			// The prompt injects only the tag tree, never the card itself.
			assert.match(sections[0].text(), /#践行/)
			assert.equal(sections[0].text().includes('来自接口'), false)
			assert.equal(sections[0].text().includes(saved.id), false)

			const read = await (await post(routes, 'card-read', { id: saved.id })).json()
			assert.equal(read.card.label, '来自接口')

			const query = await (await post(routes, 'card-list', { query: '来自接口' })).json()
			assert.equal(query.cards.length, 1)

			const filtered = await (await post(routes, 'card-list', { query: '来自接口', limit: -3 })).json()
			assert.equal(filtered.cards.length, 1)

			const temporary = await (await post(routes, 'card-write', {
				card: { body: '待整理为践行卡', tags: ['即兴'] },
			})).json()
			const promoteTool = tools.find((tool) => tool.name === 'card_promote')
			assert.equal(promoteTool !== undefined, true)
			const promoted = await promoteTool.execute({ id: temporary.id, tags: ['践行/经验'] })
			assert.ok(promoted.tags.includes('践行/经验'))
			assert.equal(promoted.tags.includes('即兴'), false)
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
			const archive = join(home, 'evolver-backup.tar.gz')
			const exported = await (await post(routes, 'data-export', { dir: home, name: 'evolver-backup.tar.gz' })).json()
			assert.equal(exported.file, archive)
			assert.ok(exported.bytes > 0)
			assert.ok(exported.files >= 2)
			assert.equal((await stat(archive)).isFile(), true)
			assert.deepEqual([...(await readFile(archive)).subarray(0, 2)], [0x1f, 0x8b])

			// 导出文件不能放在数据目录里面，也不能是根目录
			const nested = await post(routes, 'data-export', { file: join(root, 'nested.tar.gz') })
			assert.equal(nested.status, 400)
			const rootDir = await post(routes, 'data-export', { file: '/' })
			assert.equal(rootDir.status, 400)

			// 导出的压缩包可以再导入：删一张卡，再从包里恢复（含附件）
			const restorable = await (await post(routes, 'card-write', {
				card: { body: '会被恢复\n\nb', tags: ['践行/测试'] },
			})).json()
			await post(routes, 'card-attach', {
				id: restorable.id,
				name: 'restored.md',
				data: Buffer.from('会被恢复的附件').toString('base64'),
			})
			const second = join(home, 'second.tar.gz')
			await post(routes, 'data-export', { file: second, force: true })
			await post(routes, 'card-remove', { id: restorable.id })
			const gone = await (await post(routes, 'card-list', { query: '会被恢复' })).json()
			assert.equal(gone.cards.length, 0)
			const imported = await (await post(routes, 'data-import', { file: second, force: true })).json()
			assert.equal(imported.root, root)
			assert.ok(imported.files >= 1)
			// Cards and their resources travel with the archive too.
			const restoredCards = await (await post(routes, 'card-list', { query: '会被恢复' })).json()
			assert.ok(restoredCards.cards.length >= 1)
			const restoredCard = await (await post(routes, 'card-read', { id: restoredCards.cards[0].id })).json()
			assert.equal(restoredCard.card.label, '会被恢复')
			assert.match(restoredCard.card.resourceContents[0].text, /会被恢复的附件/)

			// 浏览压缩包：只列支持的三种后缀，并带上路径与大小
			await writeFile(join(home, 'notes.txt'), 'x', 'utf8')
			const listing = await (await post(routes, 'data-archives', { dir: home })).json()
			assert.equal(listing.dir, home)
			const names = listing.files.map((item) => item.name)
			assert.ok(names.includes('evolver-backup.tar.gz'))
			assert.ok(names.includes('second.tar.gz'))
			assert.equal(names.includes('notes.txt'), false)
			assert.ok(listing.files.every((item) => typeof item.path === 'string' && item.path.startsWith(home)))
			assert.ok(listing.files.every((item) => item.size > 0))

			// 文件名里带路径分隔符或纯点号会被拒绝
			const badName = await post(routes, 'data-export', { dir: home, name: '../evil.tar.gz' })
			assert.equal(badName.status, 400)

			// 中文文件名可用；没有后缀时自动补 .tar.gz
			const chinese = await (await post(routes, 'data-export', { dir: home, name: '备份' })).json()
			assert.equal(chinese.file, join(home, '备份.tar.gz'))
			assert.ok(chinese.bytes > 0)

			// 不是压缩包的内容给出明确错误
			const junk = join(home, 'junk.tar.gz')
			await writeFile(junk, 'not an archive', 'utf8')
			const bad = await post(routes, 'data-import', { file: junk })
			assert.equal(bad.status, 400)
			assert.match((await bad.json()).error.message, /不能读取压缩包/)

			// 包内路径穿越在读取阶段被拒绝
			const evil = join(home, 'evil.tar')
			await writeFile(evil, createTar([{ path: '../evil.md', content: 'x' }]))
			const evilResult = await post(routes, 'data-import', { file: evil })
			assert.equal(evilResult.status, 400)
			await assert.rejects(() => readFile(join(home, 'evil.md'), 'utf8'))

			// 同一个目录换个符号链接的写法也不能迁移
			const alias = join(home, 'current-alias')
			await symlink(root, alias)
			const viaAlias = await post(routes, 'data-migrate', { dir: alias })
			assert.equal(viaAlias.status, 400)
			assert.match((await viaAlias.json()).error.message, /这就是当前数据目录/)

			// 目标非空且没勾选覆盖时不迁移
			const busy = join(home, 'busy')
			await mkdir(busy, { recursive: true })
			await writeFile(join(busy, 'keep.txt'), 'x', 'utf8')
			const refused = await post(routes, 'data-migrate', { dir: busy })
			assert.equal(refused.status, 400)

			const movedTo = join(home, 'moved')
			const moved = await (await post(routes, 'data-migrate', { dir: movedTo })).json()
			assert.equal(moved.root, movedTo)

			// 迁到当前目录本身：给出明确的“不需要迁移”，而不是笼统的路径冲突
			const same = await post(routes, 'data-migrate', { dir: movedTo })
			assert.equal(same.status, 400)
			assert.match((await same.json()).error.message, /这就是当前数据目录/)
			assert.equal(moved.settings.dataDir, movedTo)
			await readFile(join(movedTo, 'knowledge', 'cards', 'cards.jsonl'), 'utf8')

			// 全局偏好链接跟着数据目录走
			const link = await readlink(join(home, 'AGENTS.md'))
			assert.equal(link, join(movedTo, 'preferences', 'AGENTS.md'))
			assert.equal((await lstat(join(home, 'AGENTS.md'))).isSymbolicLink(), true)

			// 之后的写入落进新目录，旧目录不动
			await post(routes, 'card-write', {
				card: { body: '迁移之后', tags: ['即兴'] },
			})
			const after = await (await post(routes, 'card-list', { query: '迁移之后' })).json()
			assert.equal(after.cards.length, 1)
			const oldLog = await readFile(join(root, 'knowledge', 'cards', 'cards.jsonl'), 'utf8')
			assert.equal(oldLog.includes('迁移之后'), false)
			assert.equal((await (await post(routes, 'overview', {})).json()).version.length > 0, true)
		} finally {
			await disposeEffects(effects)
		}
	})
})

test('两个数据操作不能同时进行', async () => {
	await withHome(async (home) => {
		const { ctx, routes, effects } = fakeContext()
		const root = join(home, 'evolver')
		await apply(ctx, { dataDir: root })
		try {
			const [first, second] = await Promise.all([
				post(routes, 'data-export', { dir: home, name: 'one.tar.gz' }),
				post(routes, 'data-export', { dir: home, name: 'two.tar.gz' }),
			])
			assert.deepEqual([first.status, second.status].sort(), [200, 400])
			const rejected = first.status === 400 ? first : second
			assert.match((await rejected.json()).error.message, /正在进行/)
			const written = first.status === 200 ? 'one.tar.gz' : 'two.tar.gz'
			assert.equal((await stat(join(home, written))).isFile(), true)
		} finally {
			await disposeEffects(effects)
		}
	})
})

test('卡片接口：列表、写入、读取、提升、附件、标签、归档与删除', async () => {
	await withHome(async (home) => {
		const { ctx, routes, effects } = fakeContext()
		await apply(ctx, { dataDir: join(home, 'evolver') })
		try {
			const list = await (await post(routes, 'card-list', {})).json()
			assert.ok(list.cards.length >= 2)
			assert.equal(typeof list.cardMaxChars, 'number')
			assert.ok(Array.isArray(list.tree))

			const created = await (await post(routes, 'card-write', {
				card: { body: '一条即兴卡片', tags: ['即兴'] },
			})).json()
			assert.equal(created.type, undefined)
			assert.equal(created.label, '一条即兴卡片')
			assert.deepEqual(created.tags, ['即兴'])

			const read = await (await post(routes, 'card-read', { id: created.id })).json()
			assert.equal(read.card.id, created.id)
			const promoted = await (await post(routes, 'card-promote', { id: created.id, tags: ['践行/经验'] })).json()
			assert.ok(promoted.tags.includes('践行/经验'))

			const attached = await (await post(routes, 'card-attach', {
				id: created.id,
				name: 'notes.md',
				data: Buffer.from('hello resource').toString('base64'),
			})).json()
			assert.equal(attached.resources.length, 1)
			assert.match(attached.body, new RegExp(`knowledge/resources/${created.id}/notes\\.md`))
			const withResource = await (await post(routes, 'card-read', { id: created.id })).json()
			assert.equal(withResource.card.resourceContents[0].text, 'hello resource')

			const tags = await (await post(routes, 'card-tags', {})).json()
			assert.ok(Array.isArray(tags))
			const archived = await (await post(routes, 'card-archive', { id: created.id })).json()
			assert.ok(archived.tags.some((tag) => tag.endsWith('/归档')))
			const removed = await (await post(routes, 'card-remove', { id: created.id })).json()
			assert.equal(removed.removed, true)
		} finally {
			await disposeEffects(effects)
		}
	})
})

test('会话整理：宿主能力缺失时状态如实报告', async () => {
	await withHome(async (home) => {
		const { ctx, routes, effects } = fakeContext()
		await apply(ctx, { dataDir: join(home, 'evolver') })
		try {
			const status = await (await post(routes, 'ingest-status', {})).json()
			assert.equal(status.enabled, true)
			assert.equal(status.idleMinutes, 15)
			assert.equal(status.available, false)
			assert.equal(status.pending, null)
			assert.equal(status.ledger.processed, 0)
		} finally {
			await disposeEffects(effects)
		}
	})
})

test('见闻向量模型：状态、切换后端与密钥不回传', async () => {
	await withHome(async (home) => {
		const { ctx, routes, effects } = fakeContext()
		await apply(ctx, { dataDir: join(home, 'evolver') })
		try {
			const status = await (await post(routes, 'embedding-status', {})).json()
			assert.ok(Array.isArray(status.catalog))
			assert.ok(status.catalog.some((model) => model.id === 'multilingual-e5-small'))
			assert.equal(status.embedding.provider, 'local')
			assert.equal(status.store.embedder, 'local')
			assert.equal(typeof status.runtime.hint, 'string')
			assert.equal(Object.hasOwn(status.embedding, 'apiKey'), false)

			const probed = await (await post(routes, 'embedding-test', {})).json()
			assert.equal(probed.backend, 'local')
			assert.equal(probed.dimensions, 256)

			// 切到无向量后端：记忆库必须换实例并报告新后端
			const switched = await (await post(routes, 'embedding-save', { embedding: { provider: 'none' } })).json()
			assert.equal(switched.embedding.provider, 'none')
			assert.equal(switched.store.embedder, 'none')

			// HTTP 的密钥只写不读
			const saved = await (await post(routes, 'embedding-save', {
				embedding: { provider: 'none', baseURL: 'http://127.0.0.1:9/v1', model: 'test-model', apiKey: 'EMB-SEKRET' },
			})).json()
			assert.equal(saved.embedding.hasApiKey, true)
			assert.equal(JSON.stringify(saved).includes('EMB-SEKRET'), false)
			const settingsPath = join(home, 'evolver.config.json')
			assert.match(await readFile(settingsPath, 'utf8'), /EMB-SEKRET/)

			const cleared = await (await post(routes, 'embedding-save', { embedding: { clearApiKey: true } })).json()
			assert.equal(cleared.embedding.hasApiKey, false)

			const missing = await post(routes, 'embedding-download', { model: 'no-such-model' })
			assert.equal(missing.status, 400)
			assert.match((await missing.json()).error.message, /未知模型/)
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
			assert.ok(restored.some((file) => file.path === 'knowledge/cards/cards.jsonl'))

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

test('每个客户端接口都既注册了路由、也真的被处理', async () => {
	await withHome(async (home) => {
		const { ctx, routes, effects } = fakeContext()
		await apply(ctx, { dataDir: join(home, 'evolver') })
		try {
			// Registered: the browser would otherwise get a 404 before the
			// handler is ever consulted.
			assert.equal(routes.size, ENDPOINTS.length, '注册的路由数必须等于接口清单')
			for (const endpoint of ENDPOINTS) {
				assert.ok(routes.has(`${API_PREFIX}/${endpoint}`), `接口没有注册路由：${endpoint}`)
			}

			// Handled: a registered name that the switch forgot answers with
			// evolver/unknown-endpoint, which looks exactly like a stale Host.
			for (const endpoint of ENDPOINTS) {
				const response = await post(routes, endpoint, {})
				assert.notEqual(response.status, 404, `接口没有注册：${endpoint}`)
				if (response.status === 400) {
					const body = await response.json()
					assert.notEqual(body?.error?.code, 'evolver/unknown-endpoint', `接口没有处理分支：${endpoint}`)
				}
			}
		} finally {
			await disposeEffects(effects)
		}
	})
})

test('接口清单和分支一处都不能漏：两边必须是同一个集合', async () => {
	// The two live apart (a route list and a switch), so the only way to keep
	// them in step is to assert it: a missing entry shows up as a silent 404
	// in the panel, never as a failing build.
	const source = await readText(new URL('../src/remote.js', import.meta.url), 'utf8')
	const cases = new Set([...source.matchAll(/case '([a-z0-9-]+)':/g)].map((match) => match[1]))
	const listed = new Set(ENDPOINTS)
	assert.deepEqual([...listed].sort(), [...cases].sort(),
		'ENDPOINTS 与 switch 的 case 必须一一对应')
	assert.equal(listed.size, cases.size, '接口清单里不能有重复项')
})
