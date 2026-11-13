import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { readFile as readText } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { API_PREFIX, apply } from '../index.js'
import { ENDPOINTS } from '../src/remote.js'
import { createTar, readTar } from './support/tar-fixture.mjs'
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
	const contexts = []
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
			// The tag tree rides here, not in a section: it changes with the
			// data, and a section change rewrites the whole prompt prefix.
			context(entry) {
				contexts.push(entry)
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
	return { ctx, routes, tools, sections, contexts, effects }
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

test('apply 注册工具、注入与接口，注入读每日快照', async () => {
	await withHome(async (home) => {
		const { ctx, routes, tools, sections, contexts, effects } = fakeContext()
		await apply(ctx, { dataDir: join(home, 'evolver') })
		try {
			// Nine card tools, three that maintain a project's harness/, and one
			// that reports what the prompt cache is doing.
			assert.equal(tools.length, 13)
			assert.deepEqual(
				tools.map((tool) => tool.name).filter((name) => name.startsWith('harness_')),
				['harness_catalog', 'harness_write', 'harness_validate'],
			)
			// One static section: discipline and the proactive protocol share it.
			assert.deepEqual(sections.map((section) => section.name), ['dsh-evolver:cards'])
			assert.deepEqual(contexts.map((entry) => entry.name), ['dsh-evolver:cards'])
			assert.equal(routes.size, ENDPOINTS.length)
			assert.match(sections[0].text(), /\[卡片\]/)
			// The card index is dynamic: it must not live in the static section.
			assert.equal(sections[0].text().includes('[卡片索引]'), false)
			assert.match(contexts[0].text(), /\[卡片索引\]/)
			assert.match(contexts[0].text(), /\[知识结构\]/)
			assert.match(sections[0].text(), /card_index/)
			// 标签树不再注入：结构压缩成一段话，全树靠 card_index 工具取。
			assert.equal(contexts[0].text().includes('[标签树]'), false)
			assert.match(sections[0].text(), /\[主动性\]/)

			// 新装后立刻有注入快照：首屏请求不必现场给全库排序。
			const snapshotPath = join(home, 'evolver', 'knowledge', 'index.json')
			JSON.parse(await readFile(snapshotPath, 'utf8'))
			const overview = await (await post(routes, 'overview', {})).json()
			assert.equal('projection' in overview, false, '恒为 0 的 projection 已删')
			assert.equal('suggestions' in overview, false, '恒空的 suggestions 已删')
			assert.match(overview.injection.index, /\[卡片索引\]/)
			// 静态块已合并：纪律与主动性协议同属一个 section，API 上不再有第三块。
			assert.match(overview.injection.section, /\[卡片\]/)
			assert.match(overview.injection.section, /\[主动性\]/)
			assert.equal('proactive' in overview.injection, false, '静态段已合并，不再单独返回 proactive 字段')
			assert.ok(overview.stats.cards >= 2)
			assert.equal(Array.isArray(overview.activity), true)
			assert.equal(overview.activity.length, 365)
			assert.ok(overview.year.notes >= 2)
			assert.ok(overview.stats.words > 0)
			assert.equal(Array.isArray(overview.tree), true)
			const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
			assert.equal(overview.version, pkg.version)

			const saved = await (await post(routes, 'card-write', {
				card: { body: '来自接口\n\n正文里独一无二的一句话', description: '接口写入的一条测试卡', tags: ['践行/测试'] },
			})).json()
			// The injected block is the card index: ids (and descriptions), never bodies.
			// 写卡不改注入：快照每天重建一次，写完之后读到的还是同一份快照。
			assert.match(contexts[0].text(), /\[卡片索引\]/)
			assert.match(contexts[0].text(), /\[知识结构\]/)
			// 索引里是短 id；完整 id 只在卡片视图/查询结果里出现。
			assert.equal(contexts[0].text().includes(saved.id), false, '注入不再带完整 id')
			assert.equal(contexts[0].text().includes('来自接口'), false, '写卡不改注入：等下一天快照')
			// 快照缺失时退回实时排序，新卡立刻出现（审计 H1 的 fallback 路径）。
			await unlink(snapshotPath)
			assert.equal(contexts[0].text().includes(saved.id.slice(-5)), true, '无快照时索引里能看到短 id')
			// 卡片没有标题：正文首行不进索引，只有 id 和描述。
			assert.equal(contexts[0].text().includes('来自接口'), false, '正文首行不进索引')
			assert.equal(contexts[0].text().includes('正文里独一无二的一句话'), false, '正文不进索引')
			assert.equal(sections[0].text().includes(saved.id), false)
			// The static section points at the tools instead of injecting content.
			assert.match(sections[0].text(), /card_index/)

			const read = await (await post(routes, 'card-read', { id: saved.id })).json()
			assert.equal(read.card.description, '接口写入的一条测试卡')

			const query = await (await post(routes, 'card-list', { query: '来自接口' })).json()
			assert.equal(query.cards.length, 1)

			const filtered = await (await post(routes, 'card-list', { query: '来自接口', limit: -3 })).json()
			assert.equal(filtered.cards.length, 1)

			const temporary = await (await post(routes, 'card-write', {
				card: { body: '待整理为践行卡', description: '还没归枝的收件箱卡', tags: ['即兴'] },
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
			const allowed = await post(routes, 'preferences', {}, { 'content-length': String(15 * 1024 * 1024) })
			assert.equal(allowed.status, 200, '16MB 是声明上限')
			const response = await post(routes, 'preferences', {}, { 'content-length': String(17 * 1024 * 1024) })
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

			// 导出只收「目录 + 文件名」：任意绝对路径这个入口已经关掉
			const nested = await post(routes, 'data-export', { dir: root, name: 'nested.tar.gz' })
			assert.equal(nested.status, 400, '不能导出到数据目录里面')
			const rootDir = await post(routes, 'data-export', { dir: '/', name: 'x.tar.gz' })
			assert.equal(rootDir.status, 400, '不能把根目录当目标')
			const freePath = await post(routes, 'data-export', { file: join(home, 'free.tar.gz') })
			assert.equal(freePath.status, 400, '不再接受整条路径')

			// 导出的压缩包可以再导入：删一张卡，再从包里恢复（含附件）
			const restorable = await (await post(routes, 'card-write', {
				card: { body: '会被恢复\n\nb', description: '备份恢复用的测试卡', tags: ['践行/测试'] },
			})).json()
			await post(routes, 'card-attach', {
				id: restorable.id,
				name: 'restored.md',
				data: Buffer.from('会被恢复的附件').toString('base64'),
			})
			const second = join(home, 'second.tar.gz')
			await post(routes, 'data-export', { dir: home, name: 'second.tar.gz', force: true })
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
			assert.equal(restoredCard.card.description, '备份恢复用的测试卡')
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
				card: { body: '迁移之后', description: '迁移后仍在的卡', tags: ['即兴'] },
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
				card: { body: '一条即兴卡片', description: '接口创建的即兴卡', tags: ['即兴'] },
			})).json()
			assert.equal(created.type, undefined)
			assert.equal(created.description, '接口创建的即兴卡')
			assert.deepEqual(created.tags, ['即兴'])

			const read = await (await post(routes, 'card-read', { id: created.id })).json()
			assert.equal(read.card.id, created.id)
			const promoted = await (await post(routes, 'card-promote', { id: created.id, tags: ['践行/经验'] })).json()
			assert.ok(promoted.tags.includes('践行/经验'))

			const attachments = await (await post(routes, 'resources-list', {})).json()
			assert.equal(Array.isArray(attachments), true, '资源列表是数组')
			// 一行一个文件：文件名在前，卡片是它的上下文。
			for (const row of attachments) {
				assert.equal(typeof row.name, 'string', '每行是一个文件')
				assert.equal(typeof row.bytes, 'number')
				assert.equal(typeof row.card?.id, 'string', '文件带着所属卡片')
			}

			const attached = await (await post(routes, 'card-attach', {
				id: created.id,
				name: 'notes.md',
				data: Buffer.from('hello resource').toString('base64'),
			})).json()
			assert.equal(attached.resources.length, 1)
			assert.match(attached.body, new RegExp(`knowledge/resources/${created.id}/notes\\.md`))
			// 附件也要等卡片日志落盘后才回「已保存」：否则崩溃窗口里资源在、
			// 引用不在，卡片会因为「磁盘上有未引用资源」变只读。
			const cardLog = await readFile(join(home, 'evolver', 'knowledge', 'cards', 'cards.jsonl'), 'utf8')
			assert.match(cardLog, new RegExp(`knowledge/resources/${created.id}/notes\\.md`), '附件引用要立刻落盘')
			const withResource = await (await post(routes, 'card-read', { id: created.id })).json()
			assert.equal(withResource.card.resourceContents[0].text, 'hello resource')

			// The tree travels with the list; there is no separate endpoint.
			const listed = await (await post(routes, 'card-list', {})).json()
			assert.ok(Array.isArray(listed.tree))
			const beforeArchive = (await (await post(routes, 'overview', {})).json()).stats.cards
			const archived = await (await post(routes, 'card-archive', { id: created.id })).json()
			assert.ok(archived.tags.some((tag) => tag.endsWith('/归档')))
			// 归档卡不算进「笔记」：字数与标签早就不算它，总数也不该算。
			const afterArchive = (await (await post(routes, 'overview', {})).json()).stats.cards
			assert.equal(afterArchive, beforeArchive - 1)
			const removed = await (await post(routes, 'card-remove', { id: created.id })).json()
			assert.equal(removed.removed, true)
		} finally {
			await disposeEffects(effects)
		}
	})
})

test('关系图接口：返回节点、边与总数，limit 越界被夹取', async () => {
	await withHome(async (home) => {
		const { ctx, routes, effects } = fakeContext()
		await apply(ctx, { dataDir: join(home, 'evolver') })
		try {
			const first = await (await post(routes, 'card-write', {
				card: { body: '图一', description: '关系图的起点卡', tags: ['践行/工作流'] },
			})).json()
			const second = await (await post(routes, 'card-write', {
				card: { body: '图二', description: '链到图一的第二张', tags: ['践行/工作流'], links: [first.id] },
			})).json()

			const graph = await (await post(routes, 'graph', { limit: 10 })).json()
			assert.ok(Array.isArray(graph.nodes))
			assert.ok(Array.isArray(graph.edges))
			assert.deepEqual(
				Object.keys(graph.totals).sort(),
				['cards', 'edges', 'hiddenCards', 'limit', 'links', 'nodes', 'weak'],
			)
			assert.equal(graph.totals.nodes, graph.nodes.length)
			assert.equal(graph.totals.edges, graph.edges.length)
			assert.equal(graph.totals.links + graph.totals.weak, graph.edges.length)
			assert.equal(graph.totals.nodes + graph.totals.hiddenCards, graph.totals.cards)
			assert.equal(graph.totals.limit, 50, '低于 50 的 limit 被夹到 50')
			assert.equal((await (await post(routes, 'graph', { limit: 10_000 })).json()).totals.limit, 500, '高于 500 的 limit 被夹到 500')
			assert.equal((await (await post(routes, 'graph', { limit: 'abc' })).json()).totals.limit, 300, '非法 limit 用默认 300')
			assert.equal((await (await post(routes, 'graph', {})).json()).totals.limit, 300, '未给 limit 用默认 300')

			// 新写的卡在图上，节点形状是面板要的那一份。
			const node = graph.nodes.find((item) => item.id === second.id)
			assert.ok(node !== undefined, '新写的卡必须入图')
			assert.equal(node.description, '链到图一的第二张')
			assert.equal(node.branch, '践行')
			assert.equal(node.degree, 1)
			assert.equal(Array.isArray(node.tags), true)
			assert.equal(typeof node.updated, 'string')

			// 单向链接只出一条无向 link 边，mutual 为假。
			const link = graph.edges.find((edge) => edge.kind === 'link')
			assert.ok(link !== undefined)
			assert.deepEqual([link.source, link.target].sort(), [first.id, second.id].sort())
			assert.equal(link.weight, 1)
			assert.equal(link.mutual, false)

			// 归档是状态不是分类：归档后立即从图中消失，总数也不含它。
			const beforeArchive = graph.totals.cards
			await post(routes, 'card-archive', { id: second.id })
			const afterArchive = await (await post(routes, 'graph', {})).json()
			assert.equal(afterArchive.nodes.some((item) => item.id === second.id), false, '归档卡不进图')
			assert.equal(afterArchive.totals.cards, beforeArchive - 1, '归档卡不计入 totals.cards')
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

test('密钥筛查覆盖阿里云/Bearer/AWS secret 等常见形状', async () => {
	await withHome(async (home) => {
		const { ctx, routes, effects } = fakeContext()
		await apply(ctx, { dataDir: join(home, 'evolver') })
		try {
			const samples = [
				'LTAI5tDk2Qm3Xv8Np7RtAbCd',
				'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
				'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
				'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
			]
			for (const sample of samples) {
				const response = await post(routes, 'card-write', { card: { body: `密钥：${sample}`, description: '正文里带凭据的卡', tags: ['即兴'] } })
				assert.equal(response.status, 400, `应当拒绝：${sample.slice(0, 12)}`)
				assert.match((await response.json()).error.message, /密钥/)
			}
			// 描述是必填项：空、占位词、超上限都被拒绝，且不会落库。
			for (const description of [undefined, '', '暂无', 'TODO', '长'.repeat(81)]) {
				const response = await post(routes, 'card-write', {
					card: { body: '没有合格描述的卡', ...(description === undefined ? {} : { description }), tags: ['即兴'] },
				})
				assert.equal(response.status, 400, `应当拒绝描述：${String(description).slice(0, 8)}`)
				assert.match((await response.json()).error.message, /description|占位|最多 \d+ 字/)
			}

			// 普通正文不能被误伤
			const clean = await post(routes, 'card-write', { card: { body: '普通笔记：这段正文没有凭据', description: '正文里没有凭据的卡', tags: ['即兴'] } })
			assert.equal(clean.status, 200)
		} finally {
			await disposeEffects(effects)
		}
	})
})

test('设置文件损坏时回到默认目录，并把原因写进面板 warning', async () => {
	await withHome(async (home) => {
		await writeFile(join(home, 'evolver.config.json'), '{ broken', 'utf8')
		const { ctx, routes, effects } = fakeContext()
		await apply(ctx, {})
		try {
			const view = await (await post(routes, 'settings', {})).json()
			assert.equal(view.dataDir, join(home, 'evolver'), '损坏后回到默认目录')
			assert.match(view.dataDirWarning, /无法解析/, 'warning 非空，面板才能解释原因')
			await readFile(join(home, 'evolver.config.json.broken'), 'utf8')
		} finally {
			await disposeEffects(effects)
		}
	})
})
