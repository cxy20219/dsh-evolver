import assert from 'node:assert/strict'
import test from 'node:test'

import { fileId } from '../src/ids.js'
import { withStore } from './helpers.mjs'

test('链接、反链与度数', async () => {
	await withStore(async (store) => {
		const a = await store.create({ tags: ['测试'], name: 'a.md', description: '来源文件，链接到 b', content: 'a' })
		const b = await store.create({ tags: ['测试'], name: 'b.md', description: '目标文件，被 a 链接', content: 'b' })
		await store.link(a.id, b.id)

		const readA = await store.read(a.id)
		assert.equal(readA.neighbors.out[0].id, b.id)
		assert.deepEqual(readA.degree, { in: 0, out: 1 })
		const readB = await store.read(b.id)
		assert.equal(readB.neighbors.in[0].id, a.id)
		assert.deepEqual(readB.degree, { in: 1, out: 0 })

		const seeded = store.graph([a.id, b.id], { hops: 1, limit: 2 })
		assert.equal(seeded.edges.length, 1, '种子已占满上限时仍然收集种子之间的边')

		const listed = await store.list()
		const rowA = listed.files.find((file) => file.id === a.id)
		const rowB = listed.files.find((file) => file.id === b.id)
		assert.deepEqual(rowA.degree, { in: 0, out: 1 })
		assert.deepEqual(rowB.degree, { in: 1, out: 0 })
	})
})

test('短后缀可以当链接目标，自链与未知目标被丢弃', async () => {
	await withStore(async (store) => {
		const a = await store.create({ tags: ['测试'], name: 'a.md', description: '来源文件，测试链接解析', content: 'a' })
		const b = await store.create({ tags: ['测试'], name: 'b.md', description: '目标文件，测试后缀解析', content: 'b' })
		await store.link(a.id, b.id.slice(-6))
		assert.equal((await store.read(a.id)).links[0], b.id)

		await assert.rejects(() => store.link(a.id, a.id), /自己/)
		const missing = fileId(0)
		const updated = await store.update(a.id, { links: [b.id, missing] })
		assert.deepEqual(updated.links, [b.id])
		assert.equal(updated.warnings.length, 1)
		assert.match(updated.warnings[0], /不存在或不唯一/)
	})
})

test('删除目标后链接悬空，但来源文件仍可读', async () => {
	await withStore(async (store) => {
		const a = await store.create({ tags: ['测试'], name: 'a.md', description: '来源文件，目标会被删', content: 'a' })
		const b = await store.create({ tags: ['测试'], name: 'b.md', description: '目标文件，随后删除', content: 'b' })
		await store.link(a.id, b.id)
		await store.remove(b.id)
		const read = await store.read(a.id)
		assert.equal(read.neighbors.out[0].id, b.id)
		assert.equal(read.neighbors.out[0].missing, true)
	})
})

test('取消链接', async () => {
	await withStore(async (store) => {
		const a = await store.create({ tags: ['测试'], name: 'a.md', description: '来源文件，之后取消链接', content: 'a' })
		const b = await store.create({ tags: ['测试'], name: 'b.md', description: '目标文件，之后被取消', content: 'b' })
		await store.link(a.id, b.id)
		await store.unlink(a.id, b.id)
		assert.deepEqual((await store.read(a.id)).links, [])
		assert.deepEqual((await store.read(b.id)).neighbors.in, [])
	})
})

test('链接目标不存在时整次写入不失败，只在结果里消失', async () => {
	await withStore(async (store) => {
		const missing = fileId(0)
		const a = await store.create({ tags: ['测试'],
			name: 'a.md',
			description: '带一个死链的文件',
			content: 'a',
			links: [missing],
		})
		assert.deepEqual(a.links, [])
		assert.equal(a.warnings.length, 1)
		assert.match(a.warnings[0], /不存在或不唯一/)
	})
})

test('场景：搜索到文档，沿两跳关系找到脚本并可直接使用', async () => {
	await withStore(async (store) => {
		const script = await store.create({ tags: ['测试'],
			name: 'export.sh',
			description: '导出报表脚本：读取数据源生成 report.md',
			content: '#!/bin/sh\necho export\n',
		})
		const data = await store.create({ tags: ['测试'],
			name: 'data.csv',
			description: '报表数据源：2026 Q3 销售明细',
			content: 'region,amount\nEast,10\n',
		})
		const notes = await store.create({ tags: ['测试'],
			name: 'export-notes.md',
			description: '导出流程说明：先看数据源，再跑脚本',
			content: '流程说明正文，不参与索引。',
			links: [data.id, script.id],
		})
		const spec = await store.create({ tags: ['测试'],
			name: 'spec.docx',
			description: '需求规格：Q3 报表导出，配套说明与脚本',
			content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
		})
		await store.update(spec.id, { links: [notes.id] })

		const hits = await store.list({ query: '报表导出' })
		assert.ok(hits.files.some((file) => file.id === spec.id), '描述命中 Word 文件')

		const one = store.graph([spec.id], { hops: 1 })
		assert.ok(one.nodes.some((node) => node.id === notes.id))
		assert.ok(!one.nodes.some((node) => node.id === script.id), '一跳不应到脚本')

		const two = store.graph([spec.id], { hops: 2 })
		assert.ok(two.nodes.some((node) => node.id === notes.id))
		assert.ok(two.nodes.some((node) => node.id === script.id), '两跳到脚本')
		assert.ok(two.edges.some((edge) => edge.from === spec.id && edge.to === notes.id))
		assert.ok(two.edges.some((edge) => edge.from === notes.id && edge.to === script.id))

		const runnable = await store.read(script.id)
		assert.equal(runnable.executable, true)
		assert.match(runnable.path, /export\.sh$/)
		assert.match(runnable.text, /^#!\/bin\/sh/)
	})
})

test('任何类型的文件都可以互相链接并产生反链', async () => {
	await withStore(async (store) => {
		const png = await store.create({
			name: 'shot.png',
			description: '界面截图',
			content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]),
			tags: ['素材/截图'],
		})
		const script = await store.create({
			name: 'build.sh',
			description: '构建脚本',
			content: '#!/bin/sh\necho build\n',
			tags: ['类型/脚本'],
		})
		await store.link(png.id, script.id)
		assert.equal((await store.read(png.id)).neighbors.out[0].id, script.id)
		assert.equal((await store.read(script.id)).neighbors.in[0].id, png.id)
		assert.equal((await store.read(script.id)).neighbors.in[0].mime, 'image/png')
	})
})
