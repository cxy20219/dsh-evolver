/**
 * The project harness: a memory that lives next to the code.
 *
 * The rules are the ones the skill enforced with a Python script; what is
 * pinned here is that the index is *derived* from the folder, so "every
 * resource is indexed" stops being a hope and becomes a property.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
	catalog,
	ensureIndex,
	firstHeading,
	indexRefs,
	initHarness,
	migrateLayout,
	isBareIndex,
	parseIndexEntries,
	projectRootOf,
	renderIndex,
	splitFrontmatter,
	documentOf,
	withFrontmatter,
} from '../src/harness/store.js'
import { createHarnessTools } from '../src/harness/tools.js'
import { validate } from '../src/harness/validate.js'
import { slugOf, writeResource } from '../src/harness/write.js'

/**
 * A project folder with a git marker and a harness skeleton.
 *
 * @returns {Promise<string>} The project root.
 */
async function project() {
	const root = await mkdtemp(join(tmpdir(), 'harness-proj-'))
	await mkdir(join(root, '.git'), { recursive: true })
	await initHarness(root)
	// The state a project is in after `harness_catalog({ init: true })`: the
	// skeleton exists and the index already describes it.
	await ensureIndex(root)
	return root
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

test('索引即文件：整篇由目录生成，不靠标记', () => {
	const document = documentOf('> 抬头\n# 文档索引，按需查阅\n\n- [甲](harness/workflow/a.md)：用途')
	assert.equal(document.endsWith('\n'), true)
	assert.equal(document.includes('<!--'), false, '不再有托管标记')
})

test('首次迁移只接管纯索引；有别的正文就拒绝，不悄悄覆盖', async () => {
	const bare = '> 抬头\n# 文档索引，按需查阅\n\n- [甲](harness/workflow/a.md)：用途'
	assert.equal(isBareIndex(bare), true)
	// Comments left by the marker design are not "someone's prose".
	assert.equal(isBareIndex(`<!-- x:start -->\n${bare}\n<!-- x:end -->`), true)

	const mixed = `# 项目说明\n\n人写的一段话。\n\n${bare}`
	assert.equal(isBareIndex(mixed), false)

	const root = await project()
	try {
		await writeFile(join(root, 'AGENTS.md'), mixed)
		await assert.rejects(() => ensureIndex(root), /不是索引的内容/)
		assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), mixed, '被拒绝时不改动原文件')
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
		assert.equal((await validate(root)).ok, true)
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
			/只能更新/,
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
		assert.ok(report.errors.some((error) => error.includes('does not index existing resource: harness/workflow/orphan.md')))

		await ensureIndex(root)
		report = await validate(root)
		assert.equal(report.ok, true, report.errors.join(' / '))

		// A tool with no workflow entry pointing at it is a resource island.
		await writeFile(join(root, 'harness/tool', 'helper.py'), 'print(1)\n')
		await ensureIndex(root)
		report = await validate(root)
		assert.ok(report.errors.some((error) => error.includes('harness/tool/helper.py is not documented')))

		await rm(join(root, 'harness/workflow'), { recursive: true, force: true })
		report = await validate(root)
		assert.ok(report.errors.some((error) => error.includes('missing harness/workflow/')))
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
		assert.equal(await projectRootOf(deep), undefined, '没有标记就没有根')
		await mkdir(join(root, '.git'))
		assert.equal(await projectRootOf(deep), root)
		// A file inside the project resolves through its folder.
		await writeFile(join(deep, 'note.md'), 'x')
		assert.equal(await projectRootOf(join(deep, 'note.md')), root)
		assert.equal(await projectRootOf('relative/path'), undefined, '相对路径不猜')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('写入工具要求先看过目录，校验工具直接可用', async () => {
	const root = await project()
	const tools = Object.fromEntries(
		createHarnessTools({ resolveProject: async () => root }).map((tool) => [tool.name, tool]),
	)
	const exec = { agent: { id: 'session-a' } }
	try {
		await assert.rejects(
			() => tools.harness_write.execute({ layer: 'experience', slug: 'x', summary: 's', body: '# x\n\nb' }, exec),
			/先调用 harness_catalog/,
		)
		const listed = await tools.harness_catalog.execute({}, exec)
		assert.equal(listed.index.notIndexed.length, 0)
		const written = await tools.harness_write.execute(
			{ layer: 'experience', slug: 'first', title: '第一条', summary: '一句话', body: '# 第一条\n\n正文。' },
			exec,
		)
		assert.equal(written.created, true)
		assert.equal((await tools.harness_validate.execute({}, exec)).ok, true)
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
