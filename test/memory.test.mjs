import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { MemoryDatabase, tokenize } from '../src/memory/db.js'
import { createCardAgent } from '../src/cards/agent.js'
import { hybridRetrieve, textOverlap } from '../src/memory/hybrid.js'
import { MemoryStore } from '../src/memory/store.js'
import { CardStore } from '../src/cards/store.js'

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

test('卡片记忆可以按限制列出，总数仍在店里', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-list-'))
	try {
		const store = new CardStore({ dataDir: dir })
		await store.init()
		const agent = createCardAgent(store)
		await agent.saveFleeting({ content: '第一条记忆', kind: 'fact' })
		await agent.saveFleeting({ content: '第二条记忆', kind: 'fact' })
		await agent.saveFleeting({ content: '第三条记忆', kind: 'fact' })
		assert.equal(store.list({ tags: ['即兴'], limit: 200 }).length, 3)
		assert.equal(store.list({ tags: ['即兴'], limit: 1 }).length, 1)
		await store.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('卡片记忆不保存密钥', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-secret-'))
	try {
		const store = new CardStore({ dataDir: dir })
		await store.init()
		const agent = createCardAgent(store)
		const result = await agent.saveFleeting({ content: 'API key 是 sk-abcdefghijklmnopqrstuvwx', kind: 'fact' })
		assert.equal(result.success, false)
		assert.match(result.message, /密钥/)
		assert.equal(store.all().length, 0)
		await store.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('相同内容会合并到同一张 #即兴 卡，不同内容各自成卡', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-merge-'))
	try {
		const store = new CardStore({ dataDir: dir })
		await store.init()
		const agent = createCardAgent(store)
		const text = '插件改动是否生效要用槽查询确认'
		const first = await agent.saveFleeting({ content: text, kind: 'failure' })
		const second = await agent.saveFleeting({ content: text, kind: 'failure' })
		assert.equal(first.success, true)
		assert.equal(second.id, first.id)
		assert.equal(store.all().length, 1)
		assert.ok(store.get(first.id).tags.includes('复盘/踩坑'))
		const other = await agent.saveFleeting({ content: '另一条不同的判断', kind: 'preference' })
		assert.notEqual(other.id, first.id)
		assert.ok(store.get(other.id).tags.includes('觉察/偏好'))
		assert.equal(store.all().length, 2)
		await store.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('关键词排第一的卡不会被重叠阈值滤掉', async () => {
	const { dir, db } = await fixture()
	try {
		await db.put({ id: 'a', text: '插件登记两处', kind: 'fact', updatedAt: STAMP })
		await db.put({ id: 'b', text: '导出必须是单个压缩包', kind: 'fact', updatedAt: STAMP })
		// A paraphrase shares almost none of the card's words; BM25 ranked it
		// first, so the overlap gate must not throw it away.
		const results = await hybridRetrieve({ db, query: '改完以后为什么界面上看不到变化插件', limit: 5 })
		assert.ok(results.length > 0, '关键词命中不能被重叠阈值清空')
		assert.equal(results[0].id, 'a', 'BM25 排第一的卡就是答案')
		await db.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
