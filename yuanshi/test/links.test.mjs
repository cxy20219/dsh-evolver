import assert from 'node:assert/strict'
import test from 'node:test'

import { fileId } from '../src/ids.js'
import { withStore } from './helpers.mjs'

test('链接、反链与度数', async () => {
	await withStore(async (store) => {
		const a = await store.create({ name: 'a.md', description: '来源文件，链接到 b', content: 'a' })
		const b = await store.create({ name: 'b.md', description: '目标文件，被 a 链接', content: 'b' })
		await store.link(a.id, b.id)

		const readA = await store.read(a.id)
		assert.equal(readA.neighbors.out[0].id, b.id)
		const readB = await store.read(b.id)
		assert.equal(readB.neighbors.in[0].id, a.id)

		const listed = await store.list()
		const rowA = listed.files.find((file) => file.id === a.id)
		const rowB = listed.files.find((file) => file.id === b.id)
		assert.deepEqual(rowA.degree, { in: 0, out: 1 })
		assert.deepEqual(rowB.degree, { in: 1, out: 0 })
	})
})

test('短后缀可以当链接目标，自链与未知目标被丢弃', async () => {
	await withStore(async (store) => {
		const a = await store.create({ name: 'a.md', description: '来源文件，测试链接解析', content: 'a' })
		const b = await store.create({ name: 'b.md', description: '目标文件，测试后缀解析', content: 'b' })
		await store.link(a.id, b.id.slice(-6))
		assert.equal((await store.read(a.id)).links[0], b.id)

		await assert.rejects(() => store.link(a.id, a.id), /链接目标/)
		const missing = fileId(0)
		const updated = await store.update(a.id, { links: [b.id, missing] })
		assert.deepEqual(updated.links, [b.id])
	})
})

test('删除目标后链接悬空，但来源文件仍可读', async () => {
	await withStore(async (store) => {
		const a = await store.create({ name: 'a.md', description: '来源文件，目标会被删', content: 'a' })
		const b = await store.create({ name: 'b.md', description: '目标文件，随后删除', content: 'b' })
		await store.link(a.id, b.id)
		await store.remove(b.id)
		const read = await store.read(a.id)
		assert.equal(read.neighbors.out[0].id, b.id)
		assert.equal(read.neighbors.out[0].missing, true)
	})
})

test('取消链接', async () => {
	await withStore(async (store) => {
		const a = await store.create({ name: 'a.md', description: '来源文件，之后取消链接', content: 'a' })
		const b = await store.create({ name: 'b.md', description: '目标文件，之后被取消', content: 'b' })
		await store.link(a.id, b.id)
		await store.unlink(a.id, b.id)
		assert.deepEqual((await store.read(a.id)).links, [])
		assert.deepEqual((await store.read(b.id)).neighbors.in, [])
	})
})

test('链接目标不存在时整次写入不失败，只在结果里消失', async () => {
	await withStore(async (store) => {
		const missing = fileId(0)
		const a = await store.create({
			name: 'a.md',
			description: '带一个死链的文件',
			content: 'a',
			links: [missing],
		})
		assert.deepEqual(a.links, [])
	})
})
