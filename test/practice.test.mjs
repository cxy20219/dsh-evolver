import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
	buildProjection,
	parseFrontmatter,
	regenerate,
	readPracticeEntry,
	safeRelativePath,
	scanPractice,
	searchPractice,
	splitEntry,
	validatePractice,
} from '../src/practice.js'

/**
 * Build a practice tree for one test.
 *
 * @param {Record<string, string>} files - Paths relative to the practice root.
 * @returns {Promise<string>} The absolute practice root.
 */
async function tree(files) {
	const root = await mkdtemp(join(tmpdir(), 'evr-practice-'))
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path)
		await mkdir(join(full, '..'), { recursive: true })
		await writeFile(full, content, 'utf8')
	}
	return root
}

const ENTRY = `---
title: 如何确认插件改动生效
purpose: 用 cordis_inspect_query 确认槽注册
kind: doc
topic: 验证方法
verified: 2026-11-10
links: [build-index]
---

正文：先看槽，再看接口。
`

test('parseFrontmatter 读取标量、内联数组与块数组', () => {
	const data = parseFrontmatter([
		'title: 一个标题',
		'kind: doc',
		'links: [a, b]',
		'tags:',
		'  - x',
		'  - y',
		'# 注释行',
	].join('\n'))
	assert.equal(data.title, '一个标题')
	assert.equal(data.kind, 'doc')
	assert.deepEqual(data.links, ['a', 'b'])
	assert.deepEqual(data.tags, ['x', 'y'])
})

test('splitEntry 把前言和正文分开', () => {
	const { data, body } = splitEntry(ENTRY)
	assert.equal(data.title, '如何确认插件改动生效')
	assert.match(body, /^正文：先看槽/)
})

test('scanPractice 按类型与主题收集条目', async () => {
	const root = await tree({
		'docs/verify/plugin.md': ENTRY,
		'tools/build-index.mjs': '---\ntitle: 索引生成器\npurpose: 重新生成索引\nkind: tool\n---\nconsole.log(1)\n',
		'resources/tpl.json': '{"a":1}',
	})
	try {
		const { entries, problems } = await scanPractice(root)
		assert.equal(entries.length, 3)
		assert.equal(entries[0].kind, 'doc')
		assert.equal(entries[0].topicSlug, 'verify')
		assert.equal(entries[0].relPath, 'docs/verify/plugin.md')
		assert.equal(entries[0].title, '如何确认插件改动生效')
		assert.equal(entries[1].kind, 'tool')
		assert.equal(entries[2].kind, 'resource')
		assert.equal(problems.length, 0)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('scanPractice 报告过深的路径，类型目录下的散落文件照常进入索引', async () => {
	const root = await tree({
		'docs/a/b/c.md': '---\ntitle: 太深\npurpose: x\n---\n',
		'docs/ok.md': '---\ntitle: 散落\npurpose: x\n---\n',
	})
	try {
		const { entries, problems } = await scanPractice(root)
		const codes = problems.map((problem) => problem.code)
		assert.ok(codes.includes('entry/too-deep'))
		assert.equal(entries.length, 1)
		assert.equal(entries[0].topic, '通用')
		assert.equal(entries[0].relPath, 'docs/ok.md')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('buildProjection 在预算内给出路由表，超出时给出归档提示', () => {
	const entries = [
		{ kind: 'doc', kindTitle: '文档', topic: '验证方法', title: 'A', purpose: '第一', relPath: 'docs/a.md' },
		{ kind: 'doc', kindTitle: '文档', topic: '验证方法', title: 'B', purpose: '第二', relPath: 'docs/b.md' },
	]
	const full = buildProjection(entries, { budget: 4096 })
	assert.equal(full.dropped.length, 0)
	assert.match(full.text, /\[实践\]/)
	assert.match(full.text, /\[纪律\]/)
	assert.match(full.text, /docs\/a\.md/)

	const tight = buildProjection(entries, { budget: 120 })
	assert.ok(tight.dropped.length > 0)
	assert.match(tight.text, /另有 \d+ 条未展示/)
	assert.match(tight.text, /practice\/ARCHIVE\.md/)
})

test('buildProjection 对同一批条目产生同样的字节', () => {
	const entries = [
		{ kind: 'doc', kindTitle: '文档', topic: 'A', title: '一', purpose: 'p1', relPath: 'docs/1.md' },
		{ kind: 'tool', kindTitle: '工具', topic: 'B', title: '二', purpose: 'p2', relPath: 'tools/2' },
	]
	const first = buildProjection(entries, { budget: 2048 }).text
	const second = buildProjection([...entries].reverse(), { budget: 2048 }).text
	assert.equal(first, second)
})

test('validatePractice 检查必填字段、kind、链接与验证日期', async () => {
	const root = await tree({
		'docs/verify/ok.md': ENTRY,
		'docs/verify/bad.md': '---\ntitle: 缺字段\nkind: tool\nlinks: [nothing]\n---\n',
		'tools/build-index.md': '---\ntitle: 索引生成器\npurpose: 重新生成索引\nkind: tool\nverified: 2026-11-10\n---\n',
	})
	try {
		const { entries } = await scanPractice(root)
		const problems = validatePractice(entries, [])
		const codes = problems.map((problem) => problem.code)
		assert.ok(codes.includes('entry/missing-field'))
		assert.ok(codes.includes('entry/wrong-kind'))
		assert.ok(codes.includes('entry/broken-link'))
		assert.ok(codes.includes('entry/not-verified'))
		const verified = problems.filter((problem) => problem.path === 'docs/verify/ok.md')
		assert.equal(verified.length, 0)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('regenerate 写出顶层索引、主题索引与归档', async () => {
	const root = await tree({
		'docs/verify/plugin.md': ENTRY,
		'tools/build-index.mjs': '---\ntitle: 索引生成器\npurpose: 重新生成索引\nkind: tool\n---\n',
	})
	try {
		const result = await regenerate(root)
		assert.equal(result.entries.length, 2)
		const index = await readFile(join(root, 'INDEX.md'), 'utf8')
		assert.match(index, /如何确认插件改动生效/)
		assert.match(index, /docs\/verify\/plugin\.md/)
		const topic = await readFile(join(root, 'docs/verify/INDEX.md'), 'utf8')
		assert.match(topic, /如何确认插件改动生效/)
		await readFile(join(root, 'ARCHIVE.md'), 'utf8')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('searchPractice 按标题、用途与正文命中，并支持类型过滤', async () => {
	const root = await tree({
		'docs/verify/plugin.md': ENTRY,
		'tools/build-index.mjs': '---\ntitle: 索引生成器\npurpose: 重新生成索引\nkind: tool\n---\n代码正文。\n',
	})
	try {
		const { entries } = await scanPractice(root)
		const byTitle = await searchPractice(root, entries, '确认插件')
		assert.equal(byTitle.length, 1)
		assert.equal(byTitle[0].path, 'docs/verify/plugin.md')

		const byBody = await searchPractice(root, entries, '代码正文')
		assert.equal(byBody.length, 1)
		assert.equal(byBody[0].kind, 'tool')

		const filtered = await searchPractice(root, entries, '', { kind: 'doc' })
		assert.equal(filtered.length, 1)
		assert.equal(filtered[0].kind, 'doc')

		const none = await searchPractice(root, entries, '不存在的词')
		assert.equal(none.length, 0)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('readPracticeEntry 读取条目并挡住路径穿越', async () => {
	const root = await tree({ 'docs/verify/plugin.md': ENTRY })
	try {
		const entry = await readPracticeEntry(root, 'docs/verify/plugin.md')
		assert.equal(entry.title, '如何确认插件改动生效')
		assert.match(entry.content, /^正文：先看槽/)
		await assert.rejects(() => readPracticeEntry(root, '../secrets.md'))
		await assert.rejects(() => readPracticeEntry(root, 'docs/missing.md'))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('CRLF 保存的条目前言照常解析', () => {
	const entry = '---\r\ntitle: 行尾是回车\r\npurpose: 来自 Windows\r\nkind: doc\r\nverified: 2026-11-10\r\n---\r\n\r\n正文\r\n'
	const { data, body } = splitEntry(entry)
	assert.equal(data.title, '行尾是回车')
	assert.equal(data.purpose, '来自 Windows')
	assert.equal(data.kind, 'doc')
	assert.equal(data.verified, '2026-11-10')
	assert.equal(body, '正文\n')
})

test('scanPractice 读得懂 CRLF 条目，索引行不再是空的', async () => {
	const root = await tree({
		'docs/win/entry.md': '---\r\ntitle: 来自 Windows\r\npurpose: 也要能索引\r\nkind: doc\r\nverified: 2026-11-10\r\n---\r\n\r\n正文。\r\n',
	})
	try {
		const { entries, problems } = await scanPractice(root)
		assert.equal(entries.length, 1)
		assert.equal(entries[0].title, '来自 Windows')
		assert.equal(problems.length, 0)
		const projection = buildProjection(entries)
		assert.match(projection.text, /来自 Windows/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('scanPractice 不索引符号链接，readPracticeEntry 也拒绝读取', async () => {
	const root = await tree({ 'docs/ok.md': '---\ntitle: 正常条目\npurpose: x\n---\n' })
	try {
		await writeFile(join(root, 'secret.txt'), 'TOP-SECRET\n', 'utf8')
		await symlink(join(root, 'secret.txt'), join(root, 'docs', 'leak.md'))
		const { entries, problems } = await scanPractice(root)
		assert.deepEqual(entries.map((entry) => entry.relPath), ['docs/ok.md'])
		assert.ok(problems.some((problem) => problem.code === 'entry/symlink'))
		await assert.rejects(() => readPracticeEntry(root, 'docs/leak.md'))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('safeRelativePath 按路径段校验，合法名字里的点不算穿越', () => {
	assert.equal(safeRelativePath('docs/verify/a..b.md'), 'docs/verify/a..b.md')
	for (const bad of ['', '/etc/passwd', '../x', 'docs/../../x', 'docs/./x', 'docs//x', 'C:/x', 'docs/a\u0000b']) {
		assert.throws(() => safeRelativePath(bad), `应拒绝 ${JSON.stringify(bad)}`)
	}
})

test('大文件条目只读头部，预览仍是一小段', async () => {
	const big = `---\ntitle: 大文件\npurpose: 只取头部\nkind: resource\nverified: 2026-11-10\n---\n\n${'x'.repeat(1024 * 1024)}`
	const root = await tree({ 'resources/big/dataset.bin': big })
	try {
		const { entries } = await scanPractice(root)
		assert.equal(entries.length, 1)
		assert.equal(entries[0].title, '大文件')
		assert.equal(entries[0].bodyPreview.length, 400)
		assert.ok(entries[0].bytes > 1024 * 1024)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('buildProjection 溢出时不动已计入的条目，也不重复归档', () => {
	const make = (title, purpose) => ({ kind: 'doc', kindTitle: '文档', topic: 'T', title, purpose, relPath: `docs/${title}.md` })
	const entries = [make('A', 'a'.repeat(100)), make('B', 'b'.repeat(400)), make('C', 'c')]
	const base = Buffer.byteLength(buildProjection([], { budget: 100_000 }).text, 'utf8')
	for (const budget of [base + 80, base + 300, base + 700, 2048]) {
		const projection = buildProjection(entries, { budget })
		const included = new Set(projection.included.map((entry) => entry.relPath))
		const dropped = new Set(projection.dropped.map((entry) => entry.relPath))
		assert.equal(dropped.size, projection.dropped.length, `归档里有重复：budget ${budget}`)
		for (const path of included) assert.equal(dropped.has(path), false, `同一条既进索引又进归档：${path}`)
		assert.equal(included.size + dropped.size, entries.length)
		assert.ok(Buffer.byteLength(projection.text, 'utf8') <= budget, `budget ${budget} 仍然超了`)
	}
})
