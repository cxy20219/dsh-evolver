import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { MemoryDatabase, tokenize } from '../src/memory/db.js'
import { createMemoryActions } from '../src/memory-actions.js'
import { hybridRetrieve, textOverlap } from '../src/memory/hybrid.js'
import { MemoryStore } from '../src/memory/store.js'

/**
 * Build an empty database on a temporary folder.
 *
 * @returns {Promise<{dir: string, db: MemoryDatabase}>} The fixture.
 */
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), 'evr-mem-'))
	const db = new MemoryDatabase({ dataDir: dir })
	await db.init()
	return { dir, db }
}

const STAMP = '2026-11-10T00:00:00.000Z'

test('并发 flush 不再撞同一个临时文件', async () => {
	const { dir, db } = await fixture()
	try {
		for (let index = 0; index < 200; index += 1) {
			await db.put({ id: `m${index}`, text: `记忆 ${index}`, kind: 'fact', updatedAt: STAMP })
		}
		await Promise.all(Array.from({ length: 20 }, () => db.flush()))
		const raw = await readFile(join(dir, 'memory', 'memories.jsonl'), 'utf8')
		assert.equal(raw.trim().split('\n').length, 200)
		await db.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('向量按 base64 落盘，旧数组格式仍能读回', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-vec-'))
	try {
		const db = new MemoryDatabase({ dataDir: dir, embedder: { id: 'local' } })
		await db.init()
		await db.put({ id: 'm1', text: 'hello', kind: 'fact', updatedAt: STAMP })
		await db.setVector('m1', new Float32Array([0.6, 0.8]))
		await db.close()

		const raw = JSON.parse(await readFile(join(dir, 'memory', 'vectors.json'), 'utf8'))
		assert.equal(raw.encoding, 'f32-base64')
		assert.equal(typeof raw.vectors.m1, 'string')

		const reopened = new MemoryDatabase({ dataDir: dir })
		await reopened.init()
		const vector = reopened.vector('m1')
		assert.equal(vector.length, 2)
		assert.ok(Math.abs(vector[0] - 0.6) < 1e-6)
		assert.ok(Math.abs(vector[1] - 0.8) < 1e-6)
		await reopened.close()

		// A store written by the previous version keeps loading.
		await writeFile(join(dir, 'memory', 'vectors.json'), JSON.stringify({ vectors: { m1: [0.1, 0.2] } }), 'utf8')
		const legacy = new MemoryDatabase({ dataDir: dir })
		await legacy.init()
		assert.ok(Math.abs(legacy.vector('m1')[0] - 0.1) < 1e-6)
		await legacy.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('bm25 用索引期的文档长度，并按相关度排序', async () => {
	const { dir, db } = await fixture()
	try {
		await db.put({ id: 'a', text: '插件 注册 验证', kind: 'fact', updatedAt: STAMP })
		await db.put({ id: 'b', text: '插件 注册', kind: 'fact', updatedAt: STAMP })
		await db.put({ id: 'c', text: '数据库 迁移', kind: 'fact', updatedAt: STAMP })
		assert.equal(db.docLengths.get('a'), tokenize('插件 注册 验证').length)
		const hits = db.bm25('插件 注册 验证')
		assert.deepEqual(hits.map((hit) => hit.id), ['a', 'b'])
		assert.deepEqual(
			[...db.tokenSet('b')].sort(),
			[...new Set(tokenize('插件 注册'))].sort(),
		)
		await db.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('改动一条记忆后文档长度与平均长度跟着走', async () => {
	const { dir, db } = await fixture()
	try {
		await db.put({ id: 'a', text: '很长的记忆 '.repeat(20), kind: 'fact', updatedAt: STAMP })
		const before = db.averageLength
		await db.put({ id: 'a', text: '短', kind: 'fact', updatedAt: STAMP })
		assert.ok(db.averageLength < before)
		assert.equal(db.docLengths.get('a'), tokenize('短').length)
		await db.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('textOverlap 对中文按词元比较', () => {
	assert.ok(textOverlap('插件 注册 验证', '插件注册验证失败') > 0.9)
	assert.equal(textOverlap('插件', '数据库'), 0)
})

test('hybridRetrieve 去掉中文近重复结果', async () => {
	const { dir, db } = await fixture()
	try {
		const text = '插件改动是否生效要用槽查询确认'
		await db.put({ id: 'a', text, kind: 'fact', updatedAt: STAMP })
		await db.put({ id: 'b', text, kind: 'fact', updatedAt: STAMP })
		const results = await hybridRetrieve({ db, query: '插件 槽 查询', queryVector: undefined, limit: 8 })
		assert.equal(results.length, 1)
		assert.equal(results[0].id, 'a')
		await db.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('重建向量时初始化不被阻塞，重建完成前检索只用关键词', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-store-'))
	let release
	const gate = new Promise((resolve) => { release = resolve })
	try {
		// 先写一条旧后端的记忆与向量，模拟一次后端替换。
		const old = new MemoryDatabase({ dataDir: dir, embedder: { id: 'old' } })
		await old.init()
		await old.put({ id: 'a', text: '插件注册验证', kind: 'fact', updatedAt: STAMP })
		await old.setVector('a', new Float32Array([1, 0]))
		await old.close()

		const store = new MemoryStore({
			dataDir: dir,
			embedding: {
				id: 'new',
				embedBatch: async (texts) => {
					await gate
					return texts.map(() => new Float32Array([0, 1]))
				},
			},
		})
		await store.init()
		// init 已经返回，但重建还卡在 gate 上：仍然可以读，只是不走向量。
		assert.equal(store.vectorsReady(), false)
		const early = await store.retrieve({ query: '插件 注册', limit: 5 })
		assert.ok(early.length >= 1)

		release()
		await store.ready
		assert.equal(store.vectorsReady(), true)
		await store.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('写入过程中新保存的记忆不会被丢到下一次重启', async () => {
	const { dir, db } = await fixture()
	try {
		await db.put({ id: 'a', text: '第一条', kind: 'fact', updatedAt: STAMP })
		// 强制下一次写走整库重写，并在重写完成时插入一条新记忆。
		db.logRewrite = true
		const original = db.writeLines.bind(db)
		db.writeLines = async function (name, records) {
			await original(name, records)
			await db.put({ id: 'b', text: '写入期间的新记忆', kind: 'fact', updatedAt: STAMP })
		}
		await db.flush()
		await db.close()

		const reopened = new MemoryDatabase({ dataDir: dir })
		await reopened.init()
		assert.equal(reopened.get('b')?.text, '写入期间的新记忆')
		await reopened.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('记忆日志是追加的：新增、更新、删除都是写一行', async () => {
	const { dir, db } = await fixture()
	try {
		await db.put({ id: 'm1', text: '第一版', kind: 'fact', updatedAt: STAMP })
		await db.close()
		const file = join(dir, 'memory', 'memories.jsonl')
		assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 1)

		await db.put({ id: 'm1', text: '第二版', kind: 'fact', updatedAt: STAMP })
		await db.put({ id: 'm2', text: '另一条', kind: 'fact', updatedAt: STAMP })
		await db.close()
		assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 3)

		const reopened = new MemoryDatabase({ dataDir: dir })
		await reopened.init()
		assert.equal(reopened.get('m1').text, '第二版')
		assert.equal(reopened.memories.size, 2)

		await reopened.remove('m2')
		await reopened.close()
		const afterDelete = new MemoryDatabase({ dataDir: dir })
		await afterDelete.init()
		assert.equal(afterDelete.memories.has('m2'), false)
		assert.equal(afterDelete.memories.size, 1)
		await afterDelete.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('日志膨胀后会自动压实，旧版本不再留在文件里', async () => {
	const { dir, db } = await fixture()
	try {
		for (let index = 0; index < 80; index += 1) {
			await db.put({ id: 'same', text: `第 ${index} 版`, kind: 'fact', updatedAt: STAMP })
			await db.flush()
		}
		await db.close()
		const raw = await readFile(join(dir, 'memory', 'memories.jsonl'), 'utf8')
		const lines = raw.trim().split('\n')
		// 压实把旧版本丢掉，日志长度回到上限以内，也远小于写入次数。
		assert.ok(!raw.includes('第 0 版'), '旧版本应当被压实掉')
		assert.ok(lines.length <= 64, `压实后仍有 ${lines.length} 行`)
		const record = JSON.parse(lines[lines.length - 1])
		assert.equal(record.text, '第 79 版')
		const reopened = new MemoryDatabase({ dataDir: dir })
		await reopened.init()
		assert.equal(reopened.get('same').text, '第 79 版')
		await reopened.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('重建向量时只要有一批失败就整体不落盘', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-partial-'))
	let calls = 0
	try {
		const old = new MemoryDatabase({ dataDir: dir, embedder: { id: 'old' } })
		await old.init()
		for (let index = 0; index < 40; index += 1) {
			await old.put({ id: `m${index}`, text: `记忆 ${index}`, kind: 'fact', updatedAt: STAMP })
			await old.setVector(`m${index}`, new Float32Array([1, 0]))
		}
		await old.close()

		const store = new MemoryStore({
			dataDir: dir,
			embedding: {
				id: 'new',
				embedBatch: async (texts) => {
					calls += 1
					if (calls === 2) throw new Error('endpoint down')
					return texts.map(() => new Float32Array([0, 1]))
				},
			},
		})
		await store.init()
		await store.ready
		assert.equal(store.vectorsReady(), false)
		// 旧向量原样保留：重新打开仍然属于旧后端。
		const reopened = new MemoryDatabase({ dataDir: dir })
		await reopened.init()
		assert.equal(reopened.vectorBackend, 'old')
		assert.ok(Math.abs(reopened.vector('m0')[0] - 1) < 1e-6)
		await reopened.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('未对齐时保存不会把整库向量标成新后端', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-mixed-'))
	try {
		const old = new MemoryDatabase({ dataDir: dir, embedder: { id: 'old', modelName: 'a' } })
		await old.init()
		await old.put({ id: 'a', text: '旧记忆', kind: 'fact', updatedAt: STAMP })
		await old.setVector('a', new Float32Array([1, 0]))
		await old.close()

		const next = new MemoryDatabase({ dataDir: dir, embedder: { id: 'new', modelName: 'b' } })
		await next.init()
		await next.put({ id: 'b', text: '新记忆', kind: 'fact', updatedAt: STAMP })
		await next.setVector('b', new Float32Array([0, 1]))
		await next.close()

		// 只保存一条新记忆不能把整库标成新后端；重启后仍会触发重建，
		// 而不是把两个向量空间混在一起比较。
		const reopened = new MemoryDatabase({ dataDir: dir })
		await reopened.init()
		assert.equal(reopened.vectorBackend, 'old')
		assert.equal(reopened.vectorModel, 'a')
		assert.equal(reopened.vectors.size, 2)
		await reopened.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('关闭记忆库会等后台重建落盘', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-close-'))
	try {
		const old = new MemoryDatabase({ dataDir: dir, embedder: { id: 'old' } })
		await old.init()
		await old.put({ id: 'a', text: '插件注册验证', kind: 'fact', updatedAt: STAMP })
		await old.setVector('a', new Float32Array([1, 0]))
		await old.close()

		const store = new MemoryStore({
			dataDir: dir,
			embedding: {
				id: 'new',
				embedBatch: async (texts) => {
					await new Promise((resolve) => setTimeout(resolve, 40))
					return texts.map(() => new Float32Array([0, 1]))
				},
			},
		})
		await store.init()
		// 直接关闭：必须等重建完成，否则导出的只是半套向量。
		await store.close()

		const reopened = new MemoryDatabase({ dataDir: dir })
		await reopened.init()
		assert.equal(reopened.vectorBackend, 'new')
		await reopened.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('记忆列表的 total 是过滤后的总数，不是当前页条数', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-list-'))
	try {
		const store = new MemoryStore({ dataDir: dir, embedding: { id: 'none' } })
		await store.init()
		await store.ready
		const memory = createMemoryActions(store)
		await memory.save({ content: '第一条记忆', kind: 'fact' })
		await memory.save({ content: '第二条记忆', kind: 'fact' })
		await memory.save({ content: '第三条记忆', kind: 'fact' })
		const page = memory.list({ limit: 1 })
		assert.equal(page.total, 3)
		assert.equal(page.results.length, 1)
		await store.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('记忆不保存密钥', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-secret-'))
	try {
		const store = new MemoryStore({ dataDir: dir, embedding: { id: 'none' } })
		await store.init()
		await store.ready
		const memory = createMemoryActions(store)
		const result = await memory.save({ content: 'API key 是 sk-abcdefghijklmnopqrstuvwx', kind: 'fact' })
		assert.equal(result.success, false)
		assert.match(result.message, /密钥/)
		assert.equal(store.entries().length, 0)
		await store.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('小记忆库的语义命中不会被统计门槛全部滤掉', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-small-'))
	try {
		const store = new MemoryStore({
			dataDir: dir,
			embedding: {
				id: 'fake',
				dimensions: 2,
				embedDocument: async (text) => (text.includes('甲') ? new Float32Array([1, 0]) : new Float32Array([0, 1])),
				embedQuery: async () => new Float32Array([1, 0]),
			},
		})
		await store.init()
		await store.ready
		const memory = createMemoryActions(store)
		await memory.save({ content: '甲：向量召回测试', kind: 'fact' })
		await memory.save({ content: '乙：另一条无关记忆', kind: 'fact' })
		assert.equal(store.vectorsReady(), true)
		// 查询词与两条记忆都没有词面重叠；只有向量能命中“甲”。
		const results = await store.retrieve({ query: '完全不同的说法', limit: 5 })
		assert.ok(results.some((item) => item.memory.text.includes('甲')), '小库的语义命中被过滤了')
		await store.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('相同内容在不同作用域各自成条，同作用域才合并', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-scope-'))
	try {
		const store = new MemoryStore({ dataDir: dir, embedding: { id: 'none' } })
		await store.init()
		await store.ready
		const memory = createMemoryActions(store)
		const text = '插件改动是否生效要用槽查询确认'
		const first = await memory.save({ content: text, kind: 'fact', scope: 'project', projectKey: '/work/a' })
		const second = await memory.save({ content: text, kind: 'fact', scope: 'project', projectKey: '/work/b' })
		assert.equal(first.success, true)
		assert.equal(second.success, true)
		assert.notEqual(first.id, second.id)
		assert.equal(store.entries().length, 2)
		const again = await memory.save({ content: text, kind: 'fact', scope: 'project', projectKey: '/work/a' })
		assert.equal(again.merged, true)
		assert.equal(again.id, first.id)
		assert.equal(store.entries().length, 2)
		await store.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
