import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { fileId } from '../src/ids.js'
import { FileStore } from '../src/store.js'
import { createTools } from '../src/tools.js'
import { tempDir } from './helpers.mjs'

/**
 * A store with the real tools registered in a map.
 *
 * @returns {Promise<{store: FileStore, tools: Map<string, object>, dir: string, cleanup: Function}>} The fixture.
 */
async function fixture() {
	const dir = await tempDir()
	const store = new FileStore({ dataDir: dir })
	await store.open()
	const tools = new Map(createTools({ store }).map((tool) => [tool.name, tool]))
	return {
		store,
		tools,
		dir,
		async cleanup() {
			store.close()
			await rm(dir, { recursive: true, force: true })
		},
	}
}

test('file_write 建文件，file_query 按描述/标签检索，file_read 给 path 和正文', async () => {
	const { tools, cleanup } = await fixture()
	try {
		const created = await tools.get('file_write').execute({
			name: 'design.md',
			description: '元始设计：文件实体与链接',
			content: '# 元始\n\n正文交给 agent 读。',
			tags: ['工作/项目', '类型/文档'],
		})
		assert.match(created.id, /^file-/)
		assert.equal(created.text, undefined, '写入结果不带正文')
		assert.equal(created.tags.length, 2)

		const byDescription = await tools.get('file_query').execute({ query: '元始设计' })
		assert.equal(byDescription.total, 1)
		assert.equal(byDescription.files[0].id, created.id)
		assert.ok(byDescription.files[0].short.length >= 5)

		const byTag = await tools.get('file_query').execute({ tags: ['工作/项目', '类型'] })
		assert.equal(byTag.total, 1)

		const read = await tools.get('file_read').execute({ id: created.short })
		assert.equal(read.id, created.id)
		assert.match(read.text, /正文交给 agent/)
		assert.equal(read.executable, false)
		assert.match(read.path, /design\.md$/)
	} finally {
		await cleanup()
	}
})

test('file_import 导入脚本：可执行位、正文、链接；file_link 可加删', async () => {
	const { tools, dir, cleanup } = await fixture()
	const sourceDir = await tempDir()
	try {
		const scriptPath = join(sourceDir, 'deploy.sh')
		await writeFile(scriptPath, '#!/bin/sh\necho ok\n')
		const doc = await tools.get('file_write').execute({
			name: 'runbook.md',
			description: '发布手册：调用部署脚本',
			content: '先看脚本。',
			tags: ['工作/发布'],
		})
		const script = await tools.get('file_import').execute({
			path: scriptPath,
			description: '部署脚本：输出 ok',
			tags: ['类型/脚本'],
			links: [doc.id],
		})
		assert.equal(script.executable, true)
		assert.match(script.path, /deploy\.sh$/)

		const read = await tools.get('file_read').execute({ id: script.short })
		assert.match(read.text, /^#!\/bin\/sh/)
		assert.equal(read.neighbors.out[0].id, doc.id)
		assert.equal(read.neighbors.out[0].description, '发布手册：调用部署脚本')

		await tools.get('file_link').execute({ from: doc.short, to: script.short })
		const linked = await tools.get('file_read').execute({ id: doc.id })
		assert.equal(linked.neighbors.out[0].id, script.id)

		await tools.get('file_link').execute({ from: doc.id, to: script.id, action: 'remove' })
		const unlinked = await tools.get('file_read').execute({ id: doc.id })
		assert.deepEqual(unlinked.neighbors.out, [])
	} finally {
		await cleanup()
		await rm(sourceDir, { recursive: true, force: true })
	}
})

test('写入死链进 warnings，不阻断其它字段', async () => {
	const { tools, cleanup } = await fixture()
	try {
		const created = await tools.get('file_write').execute({
			name: 'a.md',
			description: '带死链的文件',
			content: 'x',
			tags: ['测试/链接'],
			links: [fileId(0)],
		})
		assert.deepEqual(created.links, [])
		assert.equal(created.warnings.length, 1)
		assert.match(created.warnings[0], /不存在或不唯一/)
	} finally {
		await cleanup()
	}
})

test('file_query 图模式返回两跳子图；file_index 给规模与标签', async () => {
	const { tools, cleanup } = await fixture()
	try {
		const script = await tools.get('file_write').execute({
			name: 'export.sh',
			description: '导出脚本',
			content: '#!/bin/sh\necho export\n',
			tags: ['项目/报表', '类型/脚本'],
		})
		const notes = await tools.get('file_write').execute({
			name: 'notes.md',
			description: '导出流程说明',
			content: '说明',
			tags: ['项目/报表', '类型/文档'],
			links: [script.id],
		})
		const word = await tools.get('file_write').execute({
			name: 'spec.docx',
			description: '需求规格：报表导出',
			content: 'fake docx',
			tags: ['项目/报表', '类型/文档'],
			links: [notes.id],
		})
		const result = await tools.get('file_query').execute({ query: '报表', graph: true, hops: 2 })
		assert.ok(result.files.some((file) => file.id === word.id))
		assert.ok(result.graph.nodes.some((node) => node.id === script.id))
		assert.ok(result.graph.edges.some((edge) => edge.from === word.id && edge.to === notes.id))
		assert.ok(result.graph.edges.some((edge) => edge.from === notes.id && edge.to === script.id))

		const index = await tools.get('file_index').execute({})
		assert.equal(index.stats.files, 3)
		assert.ok(index.tags.some((row) => row.tag === '项目/报表' && row.count === 3))
	} finally {
		await cleanup()
	}
})

test('archive / remove：归档默认不出现，remove 后读不到', async () => {
	const { tools, cleanup } = await fixture()
	try {
		const file = await tools.get('file_write').execute({
			name: 'old.md',
			description: '会被归档再删除的文件',
			content: 'x',
			tags: ['测试/生命周期'],
		})
		const archived = await tools.get('file_archive').execute({ id: file.short })
		assert.equal(archived.archived, true)
		const live = await tools.get('file_query').execute({ query: '归档再删除' })
		assert.equal(live.total, 0)
		const all = await tools.get('file_query').execute({ query: '归档再删除', archived: true })
		assert.equal(all.total, 1)

		const removed = await tools.get('file_remove').execute({ id: file.id })
		assert.equal(removed.trashed, true)
		const read = await tools.get('file_read').execute({ id: file.id })
		assert.equal(read.found, false)
	} finally {
		await cleanup()
	}
})
