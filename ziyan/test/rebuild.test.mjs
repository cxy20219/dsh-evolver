import assert from 'node:assert/strict'
import { readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { FileStore } from '../src/store.js'
import { tempDir } from './helpers.mjs'

/**
 * Open a store, run the body, close it and clean up.
 *
 * @param {(store: FileStore, dir: string) => Promise<any>} body - The test.
 * @returns {Promise<any>} Whatever the body returned.
 */
async function withFreshStore(body) {
	const dir = await tempDir()
	const store = new FileStore({ dataDir: dir })
	await store.open()
	try {
		return await body(store, dir)
	} finally {
		store.close()
		await rm(dir, { recursive: true, force: true })
	}
}

test('删掉数据库后重开：从边车重建文件、链接与检索', async () => {
	const dir = await tempDir()
	let store = new FileStore({ dataDir: dir })
	await store.open()
	const a = await store.create({ name: 'design.md', description: '甲虫设计说明，讲文件与链接', content: '自衍中枢 文件 链接', tags: ['工作流'] })
	const b = await store.create({ tags: ['测试'], name: 'audit.md', description: '蝴蝶审计说明', content: '审计 守卫' })
	await store.link(a.id, b.id)
	store.close()

	for (const name of await readdir(join(dir, 'system'))) {
		if (name.startsWith('ziyan.db')) await rm(join(dir, 'system', name), { force: true })
	}

	store = new FileStore({ dataDir: dir })
	await store.open()
	const stats = store.stats()
	assert.equal(stats.files, 2)
	assert.equal(stats.links, 1)
	assert.equal(stats.tags, 2)
	assert.equal((await store.list({ query: '甲虫' })).total, 1)
	const read = await store.read(a.id)
	assert.equal(read.links[0], b.id)
	store.close()
	await rm(dir, { recursive: true, force: true })
})

test('重建读取边车的修改：手工改描述后重建就生效', async () => {
	const dir = await tempDir()
	let store = new FileStore({ dataDir: dir })
	await store.open()
	const file = await store.create({ tags: ['测试'], name: 'a.md', description: '甲虫记录', content: '正文' })
	store.close()

	const metaPath = join(dir, 'files', file.id, 'meta.json')
	const meta = JSON.parse(await readFile(metaPath, 'utf8'))
	meta.description = '蝴蝶记录'
	await writeFile(metaPath, `${JSON.stringify(meta, null, '\t')}\n`)

	store = new FileStore({ dataDir: dir })
	await store.open()
	assert.equal((await store.list({ query: '蝴蝶' })).total, 0)
	const report = await store.rebuild()
	assert.equal(report.files, 1)
	assert.equal((await store.list({ query: '蝴蝶' })).total, 1)
	assert.equal((await store.list({ query: '甲虫' })).total, 0)
	store.close()
	await rm(dir, { recursive: true, force: true })
})

test('手工把文件改名后重建：边车跟着改名并报告', async () => {
	const dir = await tempDir()
	let store = new FileStore({ dataDir: dir })
	await store.open()
	const file = await store.create({ tags: ['测试'], name: 'old.md', description: '一个会被手工改名的文件', content: '正文' })
	store.close()

	await rename(join(dir, 'files', file.id, 'old.md'), join(dir, 'files', file.id, 'renamed.md'))

	store = new FileStore({ dataDir: dir })
	await store.open()
	const report = await store.rebuild()
	assert.equal(report.problems.length, 1)
	assert.equal(report.problems[0].id, file.id)
	const read = await store.read(file.id)
	assert.equal(read.name, 'renamed.md')
	assert.equal(read.missing, false)
	store.close()
	await rm(dir, { recursive: true, force: true })
})

test('缺边车、缺本体的文件夹在重建时被报告而不是静默吞掉', async () => {
	await withFreshStore(async (store, dir) => {
		const noMeta = await store.create({ tags: ['测试'], name: 'a.md', description: '缺少边车的文件', content: 'a' })
		const noPayload = await store.create({ tags: ['测试'], name: 'b.md', description: '缺少本体的文件', content: 'b' })
		store.close()
		await rm(join(dir, 'files', noMeta.id, 'meta.json'), { force: true })
		await rm(join(dir, 'files', noPayload.id, 'b.md'), { force: true })
		const reopened = new FileStore({ dataDir: dir })
		await reopened.open()
		const report = await reopened.rebuild()
		assert.equal(report.files, 0)
		const reasons = report.problems.map((item) => item.reason).join('|')
		assert.match(reasons, /缺少 meta\.json/)
		assert.match(reasons, /没有文件本体/)
		reopened.close()
	})
})

test('符号链接不被跟随：读取标 unsafe，重建报告问题', async () => {
	await withFreshStore(async (store, dir) => {
		const file = await store.create({ tags: ['测试'], name: 'a.md', description: '本体将被替换成符号链接', content: '真实内容' })
		const outside = join(dir, 'outside.txt')
		await writeFile(outside, '库外内容')
		await rm(file.path, { force: true })
		await symlink(outside, file.path)
		const read = await store.read(file.id)
		assert.equal(read.unsafe, 'symlink')
		assert.equal(read.missing, true)
		assert.equal(read.text, undefined)
		const report = await store.rebuild()
		assert.equal(report.files, 0)
		assert.match(report.problems[0].reason, /符号链接/)
	})
})
