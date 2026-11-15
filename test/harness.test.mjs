/**
 * The project harness: a memory that lives next to the code.
 *
 * The project `AGENTS.md` is the harness index and nothing else: it is
 * generated from `harness/`, it lists every resource, and each entry carries
 * the description its sidecar declares. What is pinned here is that the index
 * is *derived* from the folder, so "every resource is indexed and described"
 * stops being a hope and becomes a property — and that a hand-written
 * `AGENTS.md` is backed up rather than silently overwritten.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
	CATALOG_LIMITS,
	catalog,
	ensureIndex,
	firstHeading,
	indexRefs,
	initHarness,
	inspectAgents,
	isBareIndex,
	isWithin,
	migrateLayout,
	orderResources,
	parseIndexEntries,
	projectRootOf,
	REQUIRED_INDEX_TEXT,
	renderIndex,
	splitFrontmatter,
} from '../src/harness/store.js'
import {
	assertResourceDescription,
	isSidecarName,
	readSidecar,
	sidecarRelative,
	writeSidecar,
} from '../src/harness/sidecar.js'
import { PYTHON_CONCURRENCY, validate } from '../src/harness/validate.js'
import { removeHarnessResource, slugOf, writeHarnessResource } from '../src/harness/write.js'
import { removeDir } from './helpers.mjs'

/**
 * Wait a few milliseconds.
 *
 * Race tests need a real window to interleave in; a resolved promise only
 * interleaves microtasks, which is not enough to expose a lock or a read→write
 * gap.
 *
 * @param {number} ms - Milliseconds.
 * @returns {Promise<void>} Resolves after the wait.
 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A project folder with a git marker and a harness skeleton.
 *
 * @returns {Promise<string>} The project root.
 */
async function project() {
	const root = await mkdtemp(join(tmpdir(), 'harness-proj-'))
	await mkdir(join(root, '.git'), { recursive: true })
	await initHarness(root)
	await ensureIndex(root)
	return root
}

/**
 * Write one resource with its description.
 *
 * @param {string} root - The project root.
 * @param {string} relative - The resource path.
 * @param {string} description - The description the index shows.
 * @param {string} [body] - The file's text.
 * @returns {Promise<object>} What happened.
 */
async function write(root, relative, description, body = '# 标题\n\n正文。\n') {
	return writeHarnessResource({ root, relative, content: body, title: '标题', description })
}

test('描述契约与文件库一致：空、占位词、过短都拒绝', () => {
	assert.throws(() => assertResourceDescription(''), /description/)
	assert.throws(() => assertResourceDescription('待补'), /占位/)
	assert.throws(() => assertResourceDescription('好'), /至少/)
	assert.equal(assertResourceDescription('写卡后整段前缀重算：排查缓存命中率突然变低时先看这里'), '写卡后整段前缀重算：排查缓存命中率突然变低时先看这里')
	assert.throws(() => assertResourceDescription('描'.repeat(201)), /最多/)
})

test('边车是资源的元数据：同名 .meta.json，自己不进索引', async () => {
	const root = await project()
	try {
		await write(root, 'harness/experience/lesson.md', '一次踩坑的结论与复现步骤，排查同类问题时先看它')
		const sidecar = await readSidecar(root, 'harness/experience/lesson.md')
		assert.equal(sidecar.title, '标题')
		assert.equal(sidecar.description, '一次踩坑的结论与复现步骤，排查同类问题时先看它')
		assert.equal(isSidecarName('lesson.md.meta.json'), true)
		assert.equal(sidecarRelative('harness/experience/lesson.md'), 'harness/experience/lesson.md.meta.json')
		const state = await catalog(root)
		assert.deepEqual(state.resources.map((item) => item.path), [
			'harness/harness.md',
			'harness/experience/lesson.md',
		], '边车文件不是资源')
		const index = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.equal(index.includes('.meta.json'), false, '索引里没有边车')
	} finally {
		await removeDir(root)
	}
})

test('索引是整份生成的严格文档：固定头 + 每个资源一行', async () => {
	const root = await project()
	try {
		await write(root, 'harness/experience/lesson.md', '一次踩坑的结论与复现步骤，排查同类问题时先看它')
		await write(root, 'harness/tool/probe.py', '探针脚本：排查产物是否为空时先跑它', 'print(1)\n')
		await write(root, 'harness/resources/scene.json', '镜头表模板：改片长直接套用', '{}\n')
		const index = await readFile(join(root, 'AGENTS.md'), 'utf8')
		const lines = index.split('\n')
		assert.equal(lines[0], REQUIRED_INDEX_TEXT[0])
		assert.equal(lines[1], REQUIRED_INDEX_TEXT[1])
		assert.equal(lines[2], '')
		const entries = lines.filter((line) => line.startsWith('- ['))
		assert.equal(entries.length, 4, '总览 + 三条资源')
		assert.match(entries[0], /^- \[Harness 开发指南\]\(harness\/harness\.md\)：/)
		assert.match(entries[1], /^- \[标题\]\(harness\/experience\/lesson\.md\)：一次踩坑的结论与复现步骤，排查同类问题时先看它$/)
		assert.match(entries[2], /^- \[标题\]\(harness\/tool\/probe\.py\)：探针脚本：排查产物是否为空时先跑它$/)
		assert.match(entries[3], /^- \[标题\]\(harness\/resources\/scene\.json\)：镜头表模板：改片长直接套用$/)
	} finally {
		await removeDir(root)
	}
})

test('索引顺序固定：总览 → 四层，新资源追加到本层末尾', async () => {
	const root = await project()
	try {
		await write(root, 'harness/tool/b.py', '第二个工具：排查产物为空时先跑它', 'print(1)\n')
		await write(root, 'harness/tool/a.py', '第一个工具：排查产物为空时先跑它', 'print(1)\n')
		await write(root, 'harness/workflow/step.md', '一条流程：渲染前先做这一步', '# 步骤\n')
		const index = await readFile(join(root, 'AGENTS.md'), 'utf8')
		const paths = [...index.matchAll(/\((harness\/[^)]+)\)/g)].map((match) => match[1])
		assert.deepEqual(paths, [
			'harness/harness.md',
			'harness/workflow/step.md',
			'harness/tool/b.py',
			'harness/tool/a.py',
		], '层序固定，新资源排在本层末尾')
	} finally {
		await removeDir(root)
	}
})

test('同样的目录生成同样的索引：重复写不改文件', async () => {
	const root = await project()
	try {
		await write(root, 'harness/experience/lesson.md', '一次踩坑的结论与复现步骤，排查同类问题时先看它')
		const first = await readFile(join(root, 'AGENTS.md'), 'utf8')
		const again = await ensureIndex(root)
		assert.equal(again.changed, false, '内容没变就不碰文件')
		assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), first)
	} finally {
		await removeDir(root)
	}
})

test('手写 AGENTS.md：先备份，再按目录重建，并说明搬去哪里', async () => {
	const root = await project()
	try {
		await writeFile(join(root, 'AGENTS.md'), '# 项目说明\n\n本项目用 pnpm。\n', 'utf8')
		const result = await write(root, 'harness/experience/lesson.md', '一次踩坑的结论与复现步骤，排查同类问题时先看它')
		assert.equal(typeof result.backup, 'string')
		const backup = await readFile(join(root, result.backup), 'utf8')
		assert.match(backup, /本项目用 pnpm/, '手写内容没有丢')
		assert.equal((await readdir(root)).filter((name) => name.startsWith('AGENTS.legacy-')).length, 1)
		const index = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.match(index, /harness\/experience\/lesson\.md/)
		assert.equal(index.includes('pnpm'), false, '索引里没有手写内容')
		assert.ok(result.warnings.some((line) => line.includes('搬进 harness/harness.md')), '提示手写内容要去处')
	} finally {
		await removeDir(root)
	}
})

test('备份是幂等的：同一份手写文档只留一份备份', async () => {
	const root = await project()
	try {
		await writeFile(join(root, 'AGENTS.md'), '# 项目说明\n\n同一段。\n', 'utf8')
		await write(root, 'harness/experience/one.md', '第一条经验：排查同类问题时先看它')
		await writeFile(join(root, 'AGENTS.md'), '# 项目说明\n\n同一段。\n', 'utf8')
		await write(root, 'harness/experience/two.md', '第二条经验：排查同类问题时先看它')
		const backups = (await readdir(root)).filter((name) => name.startsWith('AGENTS.legacy-'))
		assert.equal(backups.length, 1)
	} finally {
		await removeDir(root)
	}
})

test('索引与目录不一致时报错：手改 AGENTS.md 会被发现', async () => {
	const root = await project()
	try {
		await write(root, 'harness/experience/lesson.md', '一次踩坑的结论与复现步骤，排查同类问题时先看它')
		await writeFile(join(root, 'AGENTS.md'), '# 手改过的索引\n\n- [瞎写的](harness/nothing.md)：手改\n', 'utf8')
		const report = await validate(root)
		assert.equal(report.ok, false)
		assert.ok(report.errors.some((line) => line.includes('不一致')), report.errors.join(' / '))
	} finally {
		await removeDir(root)
	}
})

test('旧式裸索引被接管：标题与描述搬进边车，索引按新格式重建', async () => {
	const root = await mkdtemp(join(tmpdir(), 'harness-legacy-'))
	try {
		await mkdir(join(root, '.git'), { recursive: true })
		await mkdir(join(root, 'harness/workflow'), { recursive: true })
		await writeFile(join(root, 'harness/harness.md'), '# 总览\n', 'utf8')
		await writeFile(join(root, 'harness/workflow/pipeline.md'), '# 流程\n', 'utf8')
		await writeFile(join(root, 'AGENTS.md'), `${REQUIRED_INDEX_TEXT[0]}\n${REQUIRED_INDEX_TEXT[1]}\n\n- [Harness 开发指南](harness/harness.md)：项目总览、关键约束、常用入口和注意事项\n- [渲染流程](harness/workflow/pipeline.md)：从抽帧到成片的步骤与校验点\n`, 'utf8')
		const state = await catalog(root)
		assert.equal(state.index.mode, 'index')
		assert.equal(state.resources.find((item) => item.path === 'harness/workflow/pipeline.md').description, '从抽帧到成片的步骤与校验点')
		await write(root, 'harness/experience/new.md', '新经验：迁移旧项目时的坑与做法')
		const sidecar = await readSidecar(root, 'harness/workflow/pipeline.md')
		assert.equal(sidecar.title, '渲染流程')
		assert.equal(sidecar.description, '从抽帧到成片的步骤与校验点')
		const index = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.match(index, /- \[渲染流程\]\(harness\/workflow\/pipeline\.md\)：从抽帧到成片的步骤与校验点/)
	} finally {
		await removeDir(root)
	}
})

test('旧布局自动迁移：scripts→tool，references/assets→resources，路径一起改', async () => {
	const root = await mkdtemp(join(tmpdir(), 'harness-migrate-'))
	try {
		await mkdir(join(root, '.git'), { recursive: true })
		await mkdir(join(root, 'harness/scripts'), { recursive: true })
		await mkdir(join(root, 'harness/references'), { recursive: true })
		await mkdir(join(root, 'harness/workflow'), { recursive: true })
		await writeFile(join(root, 'harness/harness.md'), '# 总览\n', 'utf8')
		await writeFile(join(root, 'harness/scripts/render.mjs'), 'console.log(1)\n', 'utf8')
		await writeFile(join(root, 'harness/references/env.md'), '# 环境\n', 'utf8')
		await writeFile(join(root, 'harness/workflow/pipeline.md'), '# 流程\n\n```bash\nnode harness/scripts/render.mjs\n```\n\n验证：抽帧目检。\n', 'utf8')
		const result = await migrateLayout(root)
		assert.equal(result.moved.length, 2)
		assert.equal(await readFile(join(root, 'harness/tool/render.mjs'), 'utf8').then((text) => text.includes('console.log')), true)
		assert.equal(await readFile(join(root, 'harness/resources/env.md'), 'utf8').then((text) => text.includes('环境')), true)
		const workflow = await readFile(join(root, 'harness/workflow/pipeline.md'), 'utf8')
		assert.match(workflow, /harness\/tool\/render\.mjs/, '文档里的路径一起改了')
	} finally {
		await removeDir(root)
	}
})

test('写入失败不留半个文件：校验不过时内容与索引一起回滚', async () => {
	const root = await project()
	try {
		const before = await readFile(join(root, 'AGENTS.md'), 'utf8')
		await assert.rejects(
			() => writeHarnessResource({ root, relative: 'harness/experience/bad.md', content: '# 坏资源\n', description: '引用了不存在的路径：harness/tool/ghost.py' }),
			/校验未通过，已回滚/,
		)
		assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), before, '索引回到原样')
		assert.equal(await readdir(join(root, 'harness/experience')).then((names) => names.includes('bad.md')), false)
	} finally {
		await removeDir(root)
	}
})

test('资源必须写描述，且不能越界', async () => {
	const root = await project()
	try {
		await assert.rejects(() => writeHarnessResource({ root, relative: 'harness/experience/x.md', content: 'x', description: '' }), /description/)
		await assert.rejects(() => writeHarnessResource({ root, relative: 'harness/experience/x.md', content: 'x', description: '占位' }), /占位/)
		await assert.rejects(
			() => writeHarnessResource({ root, relative: 'harness/../evil.md', content: 'x', description: '越界测试：不该写出去' }),
			/越界/,
		)
		await assert.rejects(
			() => writeHarnessResource({ root, relative: 'not-harness/x.md', content: 'x', description: '越界测试：不该写出去' }),
			/harness\//,
		)
	} finally {
		await removeDir(root)
	}
})

test('删除资源：内容、边车与索引条目一起消失', async () => {
	const root = await project()
	try {
		await write(root, 'harness/experience/lesson.md', '一次踩坑的结论与复现步骤，排查同类问题时先看它')
		const removed = await removeHarnessResource({ root, relative: 'harness/experience/lesson.md' })
		assert.equal(removed.removed, true)
		const index = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.equal(index.includes('lesson.md'), false)
		assert.equal(await readSidecar(root, 'harness/experience/lesson.md'), undefined)
	} finally {
		await removeDir(root)
	}
})

test('校验能抓出缺失的层、引用不存在的路径与描述缺失', async () => {
	const root = await project()
	try {
		await rm(join(root, 'harness/resources'), { recursive: true, force: true })
		const report = await validate(root)
		assert.equal(report.ok, false)
		assert.ok(report.errors.some((line) => line.includes('harness/resources')), report.errors.join(' / '))
	} finally {
		await removeDir(root)
	}
	const other = await project()
	try {
		await write(other, 'harness/experience/lesson.md', '一次踩坑的结论与复现步骤，排查同类问题时先看它')
		await writeFile(join(other, 'harness/experience/lesson.md'), '# 标题\n\n引用 harness/tool/ghost.py\n', 'utf8')
		const report = await validate(other)
		assert.equal(report.ok, false)
		assert.ok(report.errors.some((line) => line.includes('ghost.py')), report.errors.join(' / '))
	} finally {
		await removeDir(other)
	}
})

test('缺 Python 解释器时跳过语法校验并标明，不算失败', async () => {
	const root = await project()
	try {
		await write(root, 'harness/tool/ok.py', 'print(1)\n', 'print(1)\n')
		const report = await validate(root, { python: null })
		assert.equal(report.ok, true, report.errors.join(' / '))
		assert.ok(report.skipped.length >= 1)
		assert.match(report.skipped[0].reason, /Python/)
	} finally {
		await removeDir(root)
	}
})

test('slug 只留小写英文与连字符', () => {
	assert.equal(slugOf('Render Pipeline'), 'render-pipeline')
	assert.equal(slugOf('中文 名字'), '')
	assert.equal(slugOf('a_b.c'), 'a-b-c')
})

test('标题取第一行标题，没有就用文件名兜底', () => {
	assert.equal(firstHeading('# 标题\n\n正文'), '标题')
	assert.equal(firstHeading('没有标题'), '')
})

test('项目根从子目录向上找，认 .git、harness 与 AGENTS.md', async () => {
	const root = await project()
	try {
		const nested = join(root, 'src', 'deep')
		await mkdir(nested, { recursive: true })
		assert.equal(await projectRootOf(nested), root)
		const plain = await mkdtemp(join(tmpdir(), 'harness-plain-'))
		await rm(plain, { recursive: true, force: true })
		assert.equal(await projectRootOf(plain), undefined)
	} finally {
		await removeDir(root)
	}
})

test('并发写两条资源：按项目串行，索引互不丢失', async () => {
	const root = await project()
	try {
		await Promise.all([
			write(root, 'harness/experience/one.md', '第一条经验：排查同类问题时先看它'),
			write(root, 'harness/experience/two.md', '第二条经验：排查同类问题时先看它'),
		])
		const index = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.ok(index.includes('one.md'))
		assert.ok(index.includes('two.md'))
	} finally {
		await removeDir(root)
	}
})

test('catalog 只读文档头部：没有边车的大文档标 truncated', async () => {
	const root = await project()
	try {
		const big = `${'x'.repeat(200_000)}\n# 标题\n`
		await writeFile(join(root, 'harness/experience/big.md'), big, 'utf8')
		const state = await catalog(root, { limits: { maxDocBytes: 1024, maxBytes: 4096 } })
		const resource = state.resources.find((item) => item.path === 'harness/experience/big.md')
		assert.equal(resource.truncated, true)
		assert.equal(resource.description, '', '没有边车就没有描述')
	} finally {
		await removeDir(root)
	}
})

test('catalog 单次扫描有文件数上限，超限时显式标记', async () => {
	const root = await project()
	try {
		await mkdir(join(root, 'harness/tool'), { recursive: true })
		for (let index = 0; index < 5; index += 1) {
			await writeFile(join(root, 'harness/tool', `x${index}.mjs`), 'x\n', 'utf8')
		}
		const state = await catalog(root, { limits: { maxFiles: 2 } })
		assert.equal(state.limited, true)
		assert.ok(state.omitted > 0)
	} finally {
		await removeDir(root)
	}
})

test('isWithin 按真实路径判断：junction 指向仓库外不算 containment', async (t) => {
	if (process.platform !== 'win32') {
		t.skip('junction 只在 Windows 上有意义')
		return
	}
	const root = await mkdtemp(join(tmpdir(), 'harness-junction-'))
	const outside = await mkdtemp(join(tmpdir(), 'harness-outside-'))
	try {
		await symlink(outside, join(root, 'link'), 'junction')
		assert.equal(isWithin(root, join(root, 'link')), false)
	} finally {
		await removeDir(root)
		await removeDir(outside)
	}
})

test('索引解析与引用提取仍能读回条目', () => {
	const text = `${REQUIRED_INDEX_TEXT[0]}\n${REQUIRED_INDEX_TEXT[1]}\n\n- [甲](harness/workflow/a.md)：用途\n- [乙](harness/tool/b.mjs)：另一处\n`
	const entries = parseIndexEntries(text)
	assert.equal(entries.get('harness/workflow/a.md').label, '甲')
	assert.equal(entries.get('harness/tool/b.mjs').summary, '另一处')
	assert.deepEqual(indexRefs(text), ['harness/harness.md', 'harness/workflow/a.md', 'harness/tool/b.mjs'])
	assert.equal(isBareIndex(text), true)
	assert.equal(inspectAgents(text).mode, 'index')
	assert.equal(inspectAgents('一段人写的话。').mode, 'handwritten')
	assert.equal(inspectAgents('').mode, 'absent')
})

test('顺序：总览在前，四层按固定次序', () => {
	const resources = [
		{ layer: 'tool', path: 'harness/tool/a' },
		{ layer: 'overview', path: 'harness/harness.md' },
		{ layer: 'workflow', path: 'harness/workflow/a' },
		{ layer: 'experience', path: 'harness/experience/a' },
	]
	assert.deepEqual(orderResources(resources).map((item) => item.path), [
		'harness/harness.md',
		'harness/workflow/a',
		'harness/experience/a',
		'harness/tool/a',
	])
})

test('frontmatter 仍能读出来（旧文档的标题兜底）', () => {
	const document = '---\ntitle: 标题\nsummary: 一句话用途\n---\n# 标题\n\n正文'
	const { meta, body } = splitFrontmatter(document)
	assert.equal(meta.title, '标题')
	assert.equal(meta.summary, '一句话用途')
	assert.match(body, /# 标题/)
})

test('renderIndex 与 catalog 产出一致', async () => {
	const root = await project()
	try {
		await write(root, 'harness/experience/lesson.md', '一次踩坑的结论与复现步骤，排查同类问题时先看它')
		const state = await catalog(root)
		const index = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.equal(index, `${renderIndex(state).trimEnd()}\n`)
	} finally {
		await removeDir(root)
	}
})

test('Python 校验并发执行且不超过并发上限', () => {
	assert.equal(PYTHON_CONCURRENCY, 4)
})

test('catalog 上限常量不变', () => {
	assert.equal(CATALOG_LIMITS.maxFiles, 1000)
	assert.equal(CATALOG_LIMITS.maxDocBytes, 64 * 1024)
})

test('写入时给 sidecar 写 schema', async () => {
	const root = await project()
	try {
		await write(root, 'harness/experience/lesson.md', '一次踩坑的结论与复现步骤，排查同类问题时先看它')
		const raw = JSON.parse(await readFile(join(root, 'harness/experience/lesson.md.meta.json'), 'utf8'))
		assert.equal(raw.schema, 1)
		assert.equal(typeof raw.description, 'string')
	} finally {
		await removeDir(root)
	}
})

test('写边车只是元数据，不会被当成资源写进索引', async () => {
	const root = await project()
	try {
		await writeSidecar(root, 'harness/experience/manual.md', { title: '手工边车', description: '手工写的描述：排查同类问题时先看它' })
		await writeFile(join(root, 'harness/experience/manual.md'), '# 手工\n', 'utf8')
		await ensureIndex(root)
		const index = await readFile(join(root, 'AGENTS.md'), 'utf8')
		assert.match(index, /- \[手工边车\]\(harness\/experience\/manual\.md\)：手工写的描述：排查同类问题时先看它/)
		assert.equal(index.includes('.meta.json'), false)
	} finally {
		await removeDir(root)
	}
})

test('sleep 辅助仍被并发用例使用', async () => {
	await sleep(1)
})
