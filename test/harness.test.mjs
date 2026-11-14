/**
 * The project harness: a memory that lives next to the code.
 *
 * The rules are the ones the old evolver skill enforced with a Python script;
 * what is pinned here is that the index is *derived* from the folder, so "every
 * resource is indexed" stops being a hope and becomes a property.
 *
 * The extra rules of this branch: only the managed block inside `AGENTS.md` is
 * written (prose around it is never touched, which is what lets a hand-written
 * `AGENTS.md` project adopt a harness), and a resource that holds across
 * projects can be promoted into the file library (`project_harness_promote`).
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
	BLOCK_BEGIN,
	BLOCK_END,
	catalog,
	ensureIndex,
	firstHeading,
	indexRefs,
	initHarness,
	inspectIndex,
	isBareIndex,
	migrateLayout,
	parseIndexEntries,
	projectRootOf,
	REQUIRED_INDEX_TEXT,
	renderIndex,
	splitFrontmatter,
	withFrontmatter,
	withIndexBlock,
} from '../src/harness/store.js'
import { createHarnessTools } from '../src/harness/tools.js'
import { validate } from '../src/harness/validate.js'
import { slugOf, writeResource } from '../src/harness/write.js'
import { fileId } from '../src/ids.js'
import { FileStore } from '../src/store.js'
import { tempDir } from './helpers.mjs'

/**
 * A project folder with a git marker and a harness skeleton.
 *
 * @returns {Promise<string>} The project root.
 */
async function project() {
	const root = await mkdtemp(join(tmpdir(), 'harness-proj-'))
	await mkdir(join(root, '.git'), { recursive: true })
	await initHarness(root)
	// The state a project is in after `project_harness_catalog({ init: true })`:
	// the skeleton exists and the index already describes it.
	await ensureIndex(root)
	return root
}

/**
 * The four tools, keyed by name, with a fixed resolver.
 *
 * @param {(exec: object) => Promise<string | undefined>} resolveProject - How the tools find the project.
 * @param {object} [store] - The file library `promote` writes into.
 * @returns {Record<string, object>} The tools.
 */
function harnessTools(resolveProject, store) {
	return Object.fromEntries(createHarnessTools({ resolveProject, store }).map((tool) => [tool.name, tool]))
}

test('frontmatter 读回来和写进去一致', () => {
	const document = withFrontmatter({ title: '标题', summary: '一句话用途' }, '# 标题\n\n正文')
	const { meta, body } = splitFrontmatter(document)
	assert.equal(meta.title, '标题')
	assert.equal(meta.summary, '一句话用途')
	assert.equal(body, '# 标题\n\n正文')
	// A document without frontmatter is all body, untouched.
	assert.deepEqual(splitFrontmatter('# 只有正文'), { meta: {}, body: '# 只有正文', fenced: false })
	assert.equal(withFrontmatter({}, '正文'), '正文')
})

test('索引既能读回用途与顺序，也能认出带扩展名的脚本路径', () => {
	const text = [
		'- [Harness 开发指南](harness/harness.md)：总览',
		'- [甲](harness/tool/check.py)：查语法',
		'- [乙](harness/experience/002-x.md)：一个坑；见 [甲](harness/tool/check.py)',
	].join('\n')
	assert.deepEqual(indexRefs(text), [
		'harness/harness.md',
		'harness/tool/check.py',
		'harness/experience/002-x.md',
	])
	const entries = parseIndexEntries(text)
	assert.equal(entries.get('harness/tool/check.py').label, '甲')
	assert.equal(entries.get('harness/tool/check.py').summary, '查语法')
	assert.equal(entries.get('harness/tool/check.py').order, 1)
})

test('索引只写在受管块里：块由目录生成，块外不碰', () => {
	const text = '> 抬头\n# 文档索引，按需查阅\n\n- [甲](harness/workflow/a.md)：用途'
	const document = withIndexBlock('', text)
	assert.ok(document.startsWith(BLOCK_BEGIN))
	assert.ok(document.trimEnd().endsWith(BLOCK_END))
	assert.equal(document.endsWith('\n'), true)
	assert.ok(document.includes(text), '索引内容在块里')
	// 只有标题/引用的旧式裸索引按整篇兼容解析；混了手写正文就不算索引。
	assert.equal(inspectIndex(document).mode, 'block')
	assert.equal(inspectIndex('').mode, 'absent')
	assert.equal(inspectIndex('人写的一段话。').mode, 'absent')
})

test('手写正文逐字节保留：块追加在末尾，空行分隔', () => {
	const prose = '# 项目说明\n\n人写的一段话。\n\n- 一个列表项\n'
	const document = withIndexBlock(prose, '# 文档索引，按需查阅\n\n- [甲](harness/workflow/a.md)：用途')
	assert.ok(document.startsWith(prose), '原文一个字节不动')
	assert.ok(document.includes(`${prose}\n${BLOCK_BEGIN}`), '空行分隔后追加')
	assert.equal(document.endsWith(`${BLOCK_END}\n`), true)
	// 没有尾随换行的原文也不被改写，直接补换行再追加。
	const tight = withIndexBlock('没有结尾换行', '索引')
	assert.equal(tight.startsWith('没有结尾换行\n\n'), true)
})

test('有块时只换块内：前后手写内容都保留', () => {
	const before = '# 手写抬头\n\n前面的话。\n\n'
	const after = '\n\n## 手写尾巴\n\n后面的话。\n'
	const old = `${before}${BLOCK_BEGIN}\n旧索引\n${BLOCK_END}${after}`
	const next = withIndexBlock(old, '# 新索引')
	assert.ok(next.startsWith(before), '块前内容不动')
	assert.ok(next.endsWith(after), '块后内容不动')
	assert.ok(next.includes(`${BLOCK_BEGIN}\n# 新索引\n${BLOCK_END}`))
	assert.equal(next.includes('旧索引'), false, '块内被替换')
	// 幂等：同一份索引再写一次，字节不变。
	assert.equal(withIndexBlock(next, '# 新索引'), next)
})

test('catalog 继承旧索引里的用途与顺序，frontmatter 优先', async () => {
	const root = await project()
	try {
		await writeFile(join(root, 'harness/experience/a.md'), '---\ntitle: 甲\nsummary: 新用途甲\n---\n# 甲\n')
		await writeFile(join(root, 'harness/experience/b.md'), '# 乙\n')
		await writeFile(
			join(root, 'AGENTS.md'),
			'> 抬头\n# 文档索引，按需查阅\n\n- [乙](harness/experience/b.md)：旧用途乙\n- [甲](harness/experience/a.md)：旧用途甲\n',
		)
		const state = await catalog(root)
		const a = state.resources.find((resource) => resource.path === 'harness/experience/a.md')
		const b = state.resources.find((resource) => resource.path === 'harness/experience/b.md')
		assert.equal(a.summary, '新用途甲', 'frontmatter 胜过旧索引')
		assert.equal(a.order, 1)
		assert.equal(b.summary, '旧用途乙')
		assert.equal(b.label, '乙')
		assert.equal(b.harvested, true)
		assert.equal(b.order, 0)
		assert.deepEqual(state.index.refs, ['harness/experience/b.md', 'harness/experience/a.md'])
		assert.deepEqual(state.index.missing, ['harness/harness.md'])
		// 旧顺序被保留：迁移一次不会把人工整理的索引重排。
		const rendered = renderIndex(state)
		assert.ok(rendered.indexOf('harness/experience/b.md') < rendered.indexOf('harness/experience/a.md'))
		assert.match(rendered, /- \[乙\]\(harness\/experience\/b\.md\)：旧用途乙/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('首次接管：旧式裸索引包进受管块，手写正文只在末尾追加块', async () => {
	const bare = '> 抬头\n# 文档索引，按需查阅\n\n- [甲](harness/workflow/a.md)：用途'
	assert.equal(isBareIndex(bare), true)
	// Comments left by the marker design are not "someone's prose".
	assert.equal(isBareIndex(`<!-- x:start -->\n${bare}\n<!-- x:end -->`), true)
	assert.equal(inspectIndex(bare).mode, 'legacy')

	const mixed = `# 项目说明\n\n人写的一段话。\n\n${bare}`
	assert.equal(isBareIndex(mixed), false)
	assert.equal(inspectIndex(mixed).mode, 'absent')

	const root = await project()
	try {
		// 旧式裸索引（整篇就是索引）被接管成受管块：旧条目的 label 与用途经
		// catalog harvest 保留，第二遍起幂等。
		await writeFile(join(root, 'AGENTS.md'), bare)
		const first = await ensureIndex(root)
		assert.equal(first.changed, true)
		assert.equal(first.mode, 'block')
		const wrapped = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.ok(wrapped.startsWith(`${BLOCK_BEGIN}\n`))
		assert.ok(wrapped.trimEnd().endsWith(BLOCK_END))
		const second = await ensureIndex(root)
		assert.equal(second.changed, false, '接管后重复 ensureIndex 幂等')
		assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), wrapped)

		// 手写正文：原字节保留，块追加在末尾。
		await writeFile(join(root, 'AGENTS.md'), mixed)
		const appended = await ensureIndex(root)
		assert.equal(appended.changed, true)
		const patched = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.ok(patched.startsWith(mixed), '手写正文一个字节不动')
		assert.ok(patched.includes(`${mixed}\n\n${BLOCK_BEGIN}`), '空行后追加块')
		assert.equal(inspectIndex(patched).mode, 'block')
		await ensureIndex(root)
		assert.equal((await readFile(join(root, 'AGENTS.md'), 'utf8')).startsWith(mixed), true, '重复写入不再碰手写正文')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('写入一条资源后，索引立刻包含它且校验通过', async () => {
	const root = await project()
	try {
		const result = await writeResource({
			root,
			layer: 'experience',
			slug: 'cache-prefix',
			title: '写卡会作废前缀缓存',
			summary: '注入块一变，整段前缀重算',
			body: '# 写卡会作废前缀缓存\n\n现象、根因、做法。',
		})
		assert.equal(result.created, true)
		assert.equal(result.path, 'harness/experience/cache-prefix.md')
		const written = await readFile(join(root, result.path), 'utf8')
		assert.match(written, /^---\ntitle: 写卡会作废前缀缓存\nsummary: 注入块一变/)
		const agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.ok(agents.includes(`(${result.path})`), '索引里有这一条')
		const report = await validate(root)
		assert.equal(report.ok, true, report.errors.join(' / '))
		assert.ok(Array.isArray(report.skipped), '报告里始终有 skipped 字段')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('写入拒绝非法落点，也不会留下半个文件', async () => {
	const root = await project()
	try {
		await assert.rejects(() => writeResource({ root, layer: 'nope', slug: 'x', summary: 's', body: 'b' }), /layer/)
		await assert.rejects(() => writeResource({ root, layer: 'experience', slug: '中文 名字', summary: 's', body: 'b' }), /文件名/)
		await assert.rejects(() => writeResource({ root, layer: 'experience', slug: 'x', summary: 's', body: '   ' }), /正文/)
		await assert.rejects(
			() => writeResource({ root, layer: 'experience', slug: 'x', path: '../outside.md', summary: 's', body: 'b' }),
			/路径不合法|只能操作/,
		)
		await assert.rejects(
			() => writeResource({ root, layer: 'experience', slug: 'x', path: join(root, '..', 'outside.md'), summary: 's', body: 'b' }),
			/路径不合法/,
		)
		await assert.rejects(
			() => writeResource({ root, layer: 'experience', slug: 'x', path: 'AGENTS.md', summary: 's', body: 'b' }),
			/只能操作 harness\//,
		)
		await assert.rejects(
			() => writeResource({ root, layer: 'experience', slug: 'x', path: 'harness/experience/none.md', summary: 's', body: 'b' }),
			/没有这个资源/,
		)
		const state = await catalog(root)
		// The overview counts as a resource (it is indexed like any other), so
		// "nothing was written" means no layered file.
		assert.equal(state.resources.filter((item) => item.layer !== 'overview').length, 0, '失败的写入不留资源')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('更新已有资源时保持文件名，并且不产生第二条索引', async () => {
	const root = await project()
	try {
		const first = await writeResource({
			root, layer: 'workflow', slug: 'release', title: '发布前检查', summary: '四步验证', body: '# 发布前检查\n\n一、二。',
		})
		const second = await writeResource({
			root, path: first.path, summary: '发版前必跑的四步', body: '# 发布前检查\n\n一、二、三、四。',
		})
		assert.equal(second.path, first.path)
		assert.equal(second.created, false)
		const agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.equal(agents.split(first.path).length, 2, '索引里只有一条')
		assert.match(agents, /发版前必跑的四步/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('校验能抓出缺失的层、未索引的资源、以及没有文档的脚本', async () => {
	const root = await project()
	try {
		await writeResource({
			root, layer: 'experience', slug: 'a', title: '甲', summary: '用途', body: '# 甲\n\n正文。',
		})
		// A resource written straight onto disk is invisible to the index.
		await writeFile(join(root, 'harness/workflow', 'orphan.md'), '# 孤儿\n\n没人索引我。\n')
		let report = await validate(root)
		assert.equal(report.ok, false)
		assert.ok(report.errors.some((error) => error.includes('AGENTS.md 没有索引已有资源：harness/workflow/orphan.md')))

		await ensureIndex(root)
		report = await validate(root)
		assert.equal(report.ok, true, report.errors.join(' / '))

		// A tool with no workflow entry pointing at it is a resource island.
		await writeFile(join(root, 'harness/tool', 'helper.py'), 'print(1)\n')
		await ensureIndex(root)
		report = await validate(root, { python: null })
		assert.ok(report.errors.some((error) => error.includes('harness/tool/helper.py 没有被任何')))

		await rm(join(root, 'harness/workflow'), { recursive: true, force: true })
		report = await validate(root, { python: null })
		assert.ok(report.errors.some((error) => error.includes('缺少 harness/workflow/')))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('脚本与资源不会把构建产物当成资源', async () => {
	const root = await project()
	try {
		await mkdir(join(root, 'harness/tool/__pycache__'), { recursive: true })
		await writeFile(join(root, 'harness/tool/__pycache__/x.cpython-314.pyc'), 'bin')
		await writeFile(join(root, 'harness/tool/.hidden'), 'x')
		const state = await catalog(root)
		assert.equal(state.resources.some((item) => item.path.includes('__pycache__')), false)
		assert.equal(state.resources.some((item) => item.path.includes('.hidden')), false)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('项目根从子目录向上找，认 .git、harness 与 AGENTS.md', async () => {
	const root = await mkdtemp(join(tmpdir(), 'harness-root-'))
	try {
		const deep = join(root, 'a', 'b', 'c')
		await mkdir(deep, { recursive: true })
		// 相对路径不猜：工具拿到的 cwd 也必须是绝对路径。
		assert.equal(await projectRootOf('relative/path'), undefined, '相对路径不猜')
		// 本机用户主目录本身可能是 git 仓库，所以「没有标记」只能从相对路径这一侧断言；
		// 这里测的是标记命中与向上查找本身。
		await mkdir(join(root, '.git'))
		assert.equal(await projectRootOf(deep), root)
		// A file inside the project resolves through its folder.
		await writeFile(join(deep, 'note.md'), 'x')
		assert.equal(await projectRootOf(join(deep, 'note.md')), root)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('项目根也认 harness/ 与 AGENTS.md，先建资源系统再建仓库也成立', async () => {
	const withHarness = await mkdtemp(join(tmpdir(), 'harness-marker-'))
	const withAgents = await mkdtemp(join(tmpdir(), 'harness-marker-'))
	try {
		await mkdir(join(withHarness, 'src', 'deep'), { recursive: true })
		await initHarness(withHarness)
		assert.equal(await projectRootOf(join(withHarness, 'src', 'deep')), withHarness)

		await mkdir(join(withAgents, 'src'), { recursive: true })
		await writeFile(join(withAgents, 'AGENTS.md'), '# 手写索引\n')
		assert.equal(await projectRootOf(join(withAgents, 'src')), withAgents)
	} finally {
		await rm(withHarness, { recursive: true, force: true })
		await rm(withAgents, { recursive: true, force: true })
	}
})

test('项目没有 harness 时，catalog 直接给出初始化动作', async () => {
	const root = await mkdtemp(join(tmpdir(), 'harness-empty-'))
	await mkdir(join(root, '.git'), { recursive: true })
	try {
		const tools = harnessTools(async () => root)
		const listed = await tools.project_harness_catalog.execute({}, { agent: { id: 'session-empty' } })
		assert.equal(listed.harness, false)
		assert.equal(listed.needsInit, true)
		assert.match(listed.next, /init:true/)
		assert.match(listed.next, /自衍中枢/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('project_harness_catalog({init:true}) 建骨架，随后写入并通过校验', async () => {
	const root = await mkdtemp(join(tmpdir(), 'harness-init-'))
	await mkdir(join(root, '.git'), { recursive: true })
	const exec = { agent: { id: 'session-init' } }
	try {
		const tools = harnessTools(async () => root)
		const listed = await tools.project_harness_catalog.execute({ init: true }, exec)
		assert.equal(listed.harness, true)
		assert.equal(listed.agents, true)
		assert.equal(listed.overview, true)
		assert.deepEqual(listed.missing, [])
		assert.deepEqual(listed.index.notIndexed, [])
		for (const layer of ['workflow', 'experience', 'tool', 'resources']) {
			assert.equal(listed.layers[layer], 0, `${layer} 层已建好`)
		}
		const written = await tools.project_harness_write.execute({
			layer: 'experience', slug: 'first', title: '第一条', summary: '一句话', body: '# 第一条\n\n正文。',
		}, exec)
		assert.equal(written.created, true)
		assert.equal((await tools.project_harness_validate.execute({}, exec)).ok, true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('写入工具要求先看过目录，校验工具直接可用', async () => {
	const root = await project()
	const tools = harnessTools(async () => root)
	const exec = { agent: { id: 'session-a' } }
	try {
		await assert.rejects(
			() => tools.project_harness_write.execute({ layer: 'experience', slug: 'x', summary: 's', body: '# x\n\nb' }, exec),
			/先调用 project_harness_catalog/,
		)
		const listed = await tools.project_harness_catalog.execute({}, exec)
		assert.equal(listed.index.notIndexed.length, 0)
		const written = await tools.project_harness_write.execute(
			{ layer: 'experience', slug: 'first', title: '第一条', summary: '一句话', body: '# 第一条\n\n正文。' },
			exec,
		)
		assert.equal(written.created, true)
		assert.equal((await tools.project_harness_validate.execute({}, exec)).ok, true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('工具显式 project 有效；推断不出项目时给出可读错误', async () => {
	const root = await project()
	const exec = { agent: { id: 'session-noproject' } }
	try {
		// 会话里拿不到 cwd 时，显式 project 仍然可用。
		const explicit = harnessTools(async (call) => {
			const value = String(call?.project ?? '').trim()
			return value === '' ? undefined : projectRootOf(value)
		})
		const listed = await explicit.project_harness_catalog.execute({ project: root }, exec)
		assert.equal(listed.project, root)
		await assert.rejects(
			() => explicit.project_harness_catalog.execute({}, exec),
			/无法推断项目目录/,
		)
		await assert.rejects(
			() => explicit.project_harness_catalog.execute({ project: 'relative/nope' }, exec),
			/找不到这个项目/,
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('promote：项目 harness 资源落进文件库，description/tags 必填', async () => {
	const root = await project()
	const lib = await tempDir()
	const store = new FileStore({ dataDir: lib })
	await store.open()
	const exec = { agent: { id: 'session-promote' } }
	try {
		await writeResource({
			root,
			layer: 'experience',
			slug: 'cache-prefix',
			title: '写卡会作废前缀缓存',
			summary: '注入块一变，整段前缀重算',
			body: '# 写卡会作废前缀缓存\n\n现象、根因、做法。',
		})
		const tools = harnessTools(async () => root, store)

		const promoted = await tools.project_harness_promote.execute({
			path: 'harness/experience/cache-prefix.md',
			description: '前缀缓存作废规律：写卡后整段前缀重算',
			tags: ['来源/harness', '自衍中枢/注入'],
		}, exec)
		assert.match(promoted.id, /^file-/)
		assert.equal(promoted.name, 'cache-prefix.md', '默认用源文件名')
		assert.equal(promoted.text, undefined, '返回摘要，不带正文')
		assert.equal(promoted.description, '前缀缓存作废规律：写卡后整段前缀重算')
		assert.deepEqual(promoted.tags, ['来源/harness', '自衍中枢/注入'])
		assert.equal(promoted.promotedFrom, 'harness/experience/cache-prefix.md')
		const source = await readFile(join(root, 'harness/experience/cache-prefix.md'), 'utf8')
		const stored = await store.read(promoted.id)
		assert.equal(stored.text, source, '字节原样进库')

		// 绝对路径也行，只要在本项目内；死链进 warnings 不阻断。
		const absolute = await tools.project_harness_promote.execute({
			path: join(root, 'harness/experience/cache-prefix.md'),
			description: '同一资源的第二份：验证绝对路径导入',
			tags: ['来源/harness', '测试/promote'],
			name: 'cache-prefix-copy.md',
			links: [fileId(0)],
		}, exec)
		assert.equal(absolute.name, 'cache-prefix-copy.md')
		assert.equal(absolute.warnings.length, 1)
		assert.match(absolute.warnings[0], /不存在或不唯一/)
		assert.equal((await store.list({})).total, 2)

		await assert.rejects(
			() => tools.project_harness_promote.execute({ path: 'harness/experience/cache-prefix.md', tags: ['来源/harness'] }, exec),
			/需要 description/,
		)
		await assert.rejects(
			() => tools.project_harness_promote.execute({ path: 'harness/experience/cache-prefix.md', description: '一句话描述这个资源' }, exec),
			/至少一个 tags/,
		)
		await assert.rejects(
			() => tools.project_harness_promote.execute({ path: '../outside.md', description: '越界路径', tags: ['来源/harness'] }, exec),
			/路径不合法/,
		)
		await assert.rejects(
			() => tools.project_harness_promote.execute({ path: 'AGENTS.md', description: '不是 harness 资源', tags: ['来源/harness'] }, exec),
			/只能操作 harness\//,
		)
		await assert.rejects(
			() => tools.project_harness_promote.execute({ path: 'harness/experience/none.md', description: '不存在的资源', tags: ['来源/harness'] }, exec),
			/没有这个资源/,
		)

		// 没有文件库时给明确错误，而不是崩在 store 上。
		const libraryless = harnessTools(async () => root)
		await assert.rejects(
			() => libraryless.project_harness_promote.execute({
				path: 'harness/experience/cache-prefix.md',
				description: '一句话描述这个资源', tags: ['来源/harness'],
			}, exec),
			/文件库不可用/,
		)
	} finally {
		store.close()
		await rm(root, { recursive: true, force: true })
		await rm(lib, { recursive: true, force: true })
	}
})

test('缺 Python 解释器时跳过语法校验并标明，不算失败', async () => {
	const root = await project()
	try {
		await writeFile(join(root, 'harness/tool/check.py'), 'print(1)\n')
		await writeFile(
			join(root, 'harness/workflow/run-check.md'),
			'---\nsummary: 跑检查\n---\n# 跑检查\n\n```\npython3 harness/tool/check.py\n```\n\n## 验证\n\nexit 0\n',
		)
		await ensureIndex(root)

		const forced = await validate(root, { python: null })
		assert.equal(forced.ok, true, forced.errors.join(' / '))
		assert.deepEqual(forced.skipped, [{
			path: 'harness/tool/check.py',
			reason: '找不到可用的 Python 解释器（python3/python/py），已跳过语法校验。',
		}])

		const auto = await validate(root)
		assert.equal(auto.ok, true, auto.errors.join(' / '))
		assert.ok(Array.isArray(auto.skipped))
		// 真有解释器时才验证“能抓出语法错误”；没有就只走 skip 分支。
		if (auto.skipped.length === 0) {
			await writeFile(join(root, 'harness/tool/broken.py'), 'def x(:\n')
			await writeFile(
				join(root, 'harness/workflow/run-broken.md'),
				'---\nsummary: 跑坏的\n---\n# 跑坏的\n\n```\npython3 harness/tool/broken.py\n```\n\n## 验证\n\nexit 1\n',
			)
			await ensureIndex(root)
			const broken = await validate(root)
			assert.equal(broken.ok, false)
			assert.ok(broken.errors.some((error) => error.includes('harness/tool/broken.py 的 Python 语法不通过')))
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('slug 只留小写英文与连字符', () => {
	assert.equal(slugOf('Cache Prefix Busting'), 'cache-prefix-busting')
	assert.equal(slugOf('缓存 前缀'), '')
	assert.equal(slugOf('../../etc/passwd'), 'etc-passwd')
	assert.equal(slugOf('a'.repeat(200)).length <= 60, true)
})

test('标题取第一行标题，没有就用文件名兜底', () => {
	assert.equal(firstHeading('前言\n\n## 真正的标题\n'), '真正的标题')
	assert.equal(firstHeading('没有标题'), '')
})

test('旧布局迁到四层：scripts→tool，references/assets→resources', async () => {
	const root = await mkdtemp(join(tmpdir(), 'harness-migrate-'))
	try {
		await mkdir(join(root, '.git'), { recursive: true })
		await mkdir(join(root, 'harness/scripts'), { recursive: true })
		await mkdir(join(root, 'harness/references'), { recursive: true })
		await mkdir(join(root, 'harness/assets'), { recursive: true })
		await mkdir(join(root, 'harness/workflow'), { recursive: true })
		await mkdir(join(root, 'harness/experience'), { recursive: true })
		await writeFile(join(root, 'harness/harness.md'), '# 总览\n')
		await writeFile(join(root, 'harness/scripts/check.py'), 'print(1)\n')
		await writeFile(join(root, 'harness/references/spec.md'), '# 规范\n')
		await writeFile(join(root, 'harness/assets/tpl.json'), '{}\n')
		// A document that names the old path, in both of the shapes it is written.
		await writeFile(
			join(root, 'harness/workflow/run.md'),
			'# 跑一下\n\n```\npython3 harness/scripts/check.py\n```\n\n见 [check](../scripts/check.py) 与 `references/spec.md`。\n',
		)
		await writeFile(
			join(root, 'AGENTS.md'),
			'> 抬头\n# 文档索引，按需查阅\n\n- [跑一下](harness/workflow/run.md)：怎么跑\n- [检查器](harness/scripts/check.py)：查语法\n',
		)

		const result = await migrateLayout(root)
		assert.deepEqual(result.moved.sort(), ['assets/ → resources/ (1)', 'references/ → resources/ (1)', 'scripts/ → tool/ (1)'])

		const workflow = await readFile(join(root, 'harness/workflow/run.md'), 'utf8')
		assert.match(workflow, /python3 harness\/tool\/check\.py/)
		assert.match(workflow, /\.\.\/tool\/check\.py/)
		assert.equal(workflow.includes('scripts/'), false)

		// The project index is rewritten before it is rebuilt, so the entry
		// keeps its label and its purpose instead of becoming a placeholder.
		const agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.match(agents, /- \[检查器\]\(harness\/tool\/check\.py\)：查语法/)

		const state = await catalog(root)
		assert.deepEqual(Object.keys(state.layers).sort(), ['experience', 'resources', 'tool', 'workflow'])
		assert.equal(state.layers.tool.length, 1)
		assert.equal(state.layers.resources.length, 2, 'references 与 assets 都进了 resources')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('文档里写了不存在的 harness 路径要报错', async () => {
	const root = await project()
	try {
		// The write tool refuses to create one: a workflow that names a script
		// that is not there is worse than no workflow, so it rolls back.
		await assert.rejects(
			() => writeResource({
				root, layer: 'workflow', slug: 'run', title: '跑一下', summary: '怎么跑',
				body: '# 跑一下\n\n```\npython3 harness/tool/ghost.py\n```\n',
			}),
			/引用了不存在的资源：harness\/tool\/ghost\.py/,
		)

		// A document that arrives by another route is caught by the validator.
		await writeFile(
			join(root, 'harness/workflow/hand-written.md'),
			'---\nsummary: 手写的\n---\n# 手写的\n\n```\npython3 harness/tool/ghost.py\n```\n',
		)
		await ensureIndex(root)
		const report = await validate(root, { python: null })
		assert.equal(report.ok, false)
		assert.ok(report.errors.some((error) => error.includes('引用了不存在的资源：harness/tool/ghost.py')))

		// A placeholder is not a path, so it is not a dangling reference.
		const ok = await writeResource({
			root, path: 'harness/workflow/hand-written.md', summary: '手写的',
			body: '# 手写的\n\n```\npython3 harness/<层>/ghost.py\n```\n',
		})
		assert.equal(ok.path, 'harness/workflow/hand-written.md')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('迁移同一目录里的同名文件：两份都留下，后来的带来源后缀', async () => {
	const root = await mkdtemp(join(tmpdir(), 'harness-collide-'))
	try {
		await mkdir(join(root, '.git'), { recursive: true })
		await mkdir(join(root, 'harness/references'), { recursive: true })
		await mkdir(join(root, 'harness/assets'), { recursive: true })
		await mkdir(join(root, 'harness/workflow'), { recursive: true })
		await mkdir(join(root, 'harness/experience'), { recursive: true })
		await writeFile(join(root, 'harness/harness.md'), '# 总览\n')
		await writeFile(join(root, 'harness/references/x.md'), 'FROM REFERENCES\n')
		await writeFile(join(root, 'harness/assets/x.md'), 'FROM ASSETS\n')

		const result = await migrateLayout(root)
		const state = await catalog(root)
		assert.equal(state.layers.resources.length, 2, '两份同名文件都要留下来')
		const texts = []
		for (const path of state.layers.resources) texts.push(await readFile(join(root, path), 'utf8'))
		assert.deepEqual(texts.sort(), ['FROM ASSETS\n', 'FROM REFERENCES\n'])
		assert.equal(result.renamed.length, 1)
		assert.match(result.renamed[0], /^assets\/x\.md → resources\/x\.from-assets\.md$/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('迁移不把目录当文件：嵌套目录整棵搬走，不半途 ENOENT', async () => {
	const root = await mkdtemp(join(tmpdir(), 'harness-nested-'))
	try {
		await mkdir(join(root, '.git'), { recursive: true })
		await mkdir(join(root, 'harness/references/sub'), { recursive: true })
		await mkdir(join(root, 'harness/workflow'), { recursive: true })
		await mkdir(join(root, 'harness/experience'), { recursive: true })
		await writeFile(join(root, 'harness/harness.md'), '# 总览\n')
		await writeFile(join(root, 'harness/references/sub/x.md'), '# 嵌套\n')

		const result = await migrateLayout(root)
		assert.deepEqual(result.moved, ['references/ → resources/ (1)'])
		const state = await catalog(root)
		assert.deepEqual(state.layers.resources, ['harness/resources/sub/x.md'])
		assert.equal(state.resources.some((resource) => resource.path.endsWith('/sub')), false, '目录不能进索引')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('目录本身不会出现在目录清单里', async () => {
	const root = await project()
	try {
		await mkdir(join(root, 'harness/resources/sub'), { recursive: true })
		await writeFile(join(root, 'harness/resources/sub/x.md'), '# x\n')
		const state = await catalog(root)
		assert.deepEqual(state.layers.resources, ['harness/resources/sub/x.md'])
		assert.equal(state.resources.filter((resource) => resource.layer === 'resources').length, 1)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('写资源时手写 AGENTS.md 原样保留，块追加在末尾', async () => {
	const root = await project()
	const prose = '# 手写项目说明\n\n人写的一段话。\n\n- 一个列表项\n'
	try {
		await writeFile(join(root, 'AGENTS.md'), prose)
		const result = await writeResource({
			root, layer: 'experience', slug: 'new-note', title: '新条目', summary: '一句话用途', body: '# 新条目\n\n正文。',
		})
		assert.equal(result.created, true)
		const agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.ok(agents.startsWith(prose), '手写正文逐字节保留')
		assert.ok(agents.includes(`${prose}\n${BLOCK_BEGIN}`), '空行后追加块')
		assert.ok(agents.includes('(harness/experience/new-note.md)'))
		assert.equal(inspectIndex(agents).mode, 'block')
		assert.equal((await validate(root)).ok, true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('受管块标记不完整时拒绝写入，不猜测覆盖', async () => {
	const root = await project()
	try {
		const broken = `# 手写\n\n${BLOCK_BEGIN}\n# 文档索引，按需查阅\n`
		await writeFile(join(root, 'AGENTS.md'), broken)
		assert.equal((await catalog(root)).index.mode, 'broken')
		await assert.rejects(() => ensureIndex(root), /受管块标记不完整/)
		await assert.rejects(
			() => writeResource({ root, layer: 'experience', slug: 'x', title: 'x', summary: '用途', body: '# x\n\n正文。' }),
			/受管块标记不完整/,
		)
		assert.equal((await catalog(root)).layers.experience.length, 0, '拒绝后不能留下未索引的文件')
		assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), broken, '标记不完整时原文件不动')

		// migrateLayout 也不在半途改目录：先查索引，再动文件。
		await mkdir(join(root, 'harness/scripts'), { recursive: true })
		await writeFile(join(root, 'harness/scripts/x.py'), 'print(1)\n')
		await assert.rejects(() => migrateLayout(root), /受管块标记不完整/)
		assert.equal(await readFile(join(root, 'harness/scripts/x.py'), 'utf8'), 'print(1)\n', '没有被半途迁移')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('块内条目随目录增删，块外手写内容不动', async () => {
	const root = await project()
	const prose = '# 手写说明\n\n不要动我。\n'
	try {
		await writeFile(join(root, 'AGENTS.md'), prose)
		await writeResource({
			root, layer: 'experience', slug: 'alpha', title: '甲', summary: '第一条用途', body: '# 甲\n\n正文。',
		})
		let agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.ok(agents.startsWith(prose))
		assert.ok(agents.includes('(harness/experience/alpha.md)'), '块内新增条目')
		await rm(join(root, 'harness/experience/alpha.md'), { force: true })
		await ensureIndex(root)
		agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.ok(agents.startsWith(prose), '块外正文不动')
		assert.equal(agents.includes('(harness/experience/alpha.md)'), false, '删掉资源后条目也删掉')
		assert.ok(agents.includes('(harness/harness.md)'))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('validate 对缺失/旧式索引分别给出可读提示', async () => {
	const root = await project()
	try {
		// 手写正文、无受管块：absent 是可修的错，不是静默通过。
		await writeFile(join(root, 'AGENTS.md'), '# 手写项目说明\n\n人写的话。\n')
		let report = await validate(root)
		assert.equal(report.ok, false)
		assert.ok(report.errors.some((error) => error.includes('还没有受管索引块')))

		// 旧式裸索引：还能用，给 warning 提示下次写入会改造成受管块。
		const legacy = `${REQUIRED_INDEX_TEXT[0]}\n${REQUIRED_INDEX_TEXT[1]}\n\n- [Harness 开发指南](harness/harness.md)：总览\n`
		await writeFile(join(root, 'AGENTS.md'), legacy)
		report = await validate(root)
		assert.equal(report.ok, true, report.errors.join(' / '))
		assert.ok(report.warnings.some((hint) => hint.includes('旧式裸索引')))

		// 标记不完整：报错且不猜。
		await writeFile(join(root, 'AGENTS.md'), `${BLOCK_BEGIN}\n没有结尾\n`)
		report = await validate(root)
		assert.equal(report.ok, false)
		assert.ok(report.errors.some((error) => error.includes('受管块标记不完整')))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('手写 AGENTS.md + 无 harness：catalog(init:true) 安全建骨架，正文保留', async () => {
	const root = await mkdtemp(join(tmpdir(), 'harness-handwritten-'))
	await mkdir(join(root, '.git'), { recursive: true })
	const prose = '# 我的项目\n\n手写说明第一行。\n\n```bash\nnpm test\n```\n'
	await writeFile(join(root, 'AGENTS.md'), prose)
	try {
		const tools = harnessTools(async () => root)
		const exec = { agent: { id: 'session-handwritten' } }
		const listed = await tools.project_harness_catalog.execute({ init: true }, exec)
		assert.equal(listed.harness, true)
		assert.equal(listed.index.mode, 'block')
		const agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.ok(agents.startsWith(prose), '手写正文逐字节保留')
		assert.ok(agents.includes('(harness/harness.md)'), '块内有总览条目')

		const written = await tools.project_harness_write.execute({
			layer: 'experience', slug: 'first', title: '第一条', summary: '一句话用途', body: '# 第一条\n\n正文。',
		}, exec)
		assert.equal(written.created, true)
		const afterWrite = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.ok(afterWrite.startsWith(prose), '写入后手写正文仍逐字节保留')
		assert.equal((await tools.project_harness_validate.execute({}, exec)).ok, true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('migrateLayout 只改受管块里的路径，块外手写内容不动', async () => {
	const root = await mkdtemp(join(tmpdir(), 'harness-migrate-block-'))
	try {
		await mkdir(join(root, '.git'), { recursive: true })
		await mkdir(join(root, 'harness/scripts'), { recursive: true })
		await mkdir(join(root, 'harness/workflow'), { recursive: true })
		await mkdir(join(root, 'harness/experience'), { recursive: true })
		await writeFile(join(root, 'harness/harness.md'), '# 总览\n')
		await writeFile(join(root, 'harness/scripts/check.py'), 'print(1)\n')
		await writeFile(join(root, 'harness/workflow/run.md'), '# 跑\n\n```\npython3 harness/scripts/check.py\n```\n')
		const prose = '# 手写说明\n\n- [检查器](harness/scripts/check.py)：手写里也提到旧路径，不能改。\n'
		const agents = `${prose}\n${BLOCK_BEGIN}\n> 抬头\n# 文档索引，按需查阅\n\n- [跑](harness/workflow/run.md)：怎么跑\n- [检查器](harness/scripts/check.py)：查语法\n${BLOCK_END}\n\n## 结尾手写\n\n别动。\n`
		await writeFile(join(root, 'AGENTS.md'), agents)

		await migrateLayout(root)
		const next = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.ok(next.startsWith(prose), '块前手写内容逐字节不动')
		assert.ok(next.endsWith('## 结尾手写\n\n别动。\n'), '块后手写内容逐字节不动')
		const inner = inspectIndex(next).inner
		assert.match(inner, /harness\/tool\/check\.py/, '块内路径被改写')
		assert.equal(inner.includes('harness/scripts/'), false)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('title/summary 里的换行被折成一行，不会破坏 frontmatter', async () => {
	const root = await project()
	try {
		await writeResource({
			root,
			layer: 'experience',
			slug: 'one-line',
			title: '第一行\n# 伪造的第二行',
			summary: '摘要第一行\n- [伪造](harness/evil.md)：注入',
			body: '# 正文\n\ntext',
		})
		const text = await readFile(join(root, 'harness/experience/one-line.md'), 'utf8')
		const { meta } = splitFrontmatter(text)
		assert.equal(meta.summary, '摘要第一行 - [伪造](harness/evil.md)：注入')
		assert.equal(text.includes('\n# 伪造的第二行'), false)
		const agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
		// 摘要里的 Markdown 只作为同一行的文字：不能再多出一条伪造的索引行。
		const injected = agents.split('\n').filter((line) => line.includes('伪造'))
		assert.equal(injected.length, 1)
		assert.match(injected[0], /^- \[/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
