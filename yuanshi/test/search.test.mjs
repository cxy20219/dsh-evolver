import assert from 'node:assert/strict'
import test from 'node:test'

import { withStore } from './helpers.mjs'

test('中文两字查询能命中（FTS5 trigram 的回归点）', async () => {
	await withStore(async (store) => {
		const a = await store.create({
			name: 'design.md',
			description: '插件接口约定：每个文件有唯一 id',
			content: '写入先落边车，再更新索引。',
		})
		const hits = await store.list({ query: '插件' })
		assert.equal(hits.total, 1)
		assert.equal(hits.files[0].id, a.id)
		const two = await store.list({ query: '接口' })
		assert.equal(two.total, 1)
	})
})

test('英文词与正文检索', async () => {
	await withStore(async (store) => {
		const a = await store.create({
			name: 'proxy.md',
			description: '反向代理的 Host 与 Origin 改写',
			content: 'The reverse proxy rewrites Host and Origin. WebSocket upgrade is handled separately.',
		})
		const hits = await store.list({ query: 'reverse proxy' })
		assert.equal(hits.total, 1)
		assert.equal(hits.files[0].id, a.id)
		assert.match(hits.files[0].snippet, /reverse proxy/i)
	})
})

test('片段来自原文，不是预分词文本', async () => {
	await withStore(async (store) => {
		await store.create({
			name: 'note.md',
			description: '一段关于接口约定的笔记',
			content: '这里讨论接口约定：写入先落边车，索引随后更新。',
		})
		const hits = await store.list({ query: '接口' })
		assert.equal(hits.total, 1)
		const snippet = hits.files[0].snippet
		assert.match(snippet, /接口约定/)
		assert.ok(!snippet.includes('接口 口约'), `片段不应是预分词文本：${snippet}`)
	})
})

test('描述词比正文词权重高', async () => {
	await withStore(async (store) => {
		const inDescription = await store.create({
			name: 'a.md',
			description: '青鸟协议的唯一入口',
			content: '正文没有那个词。',
		})
		await store.create({
			name: 'b.md',
			description: '普通说明文件',
			content: '正文里提到一次青鸟。',
		})
		const hits = await store.list({ query: '青鸟' })
		assert.equal(hits.total, 2)
		assert.equal(hits.files[0].id, inDescription.id)
	})
})

test('改描述后旧词从索引消失，新词可搜', async () => {
	await withStore(async (store) => {
		// 旧词与新词不能共享 bigram，否则「旧标记 → 新标记」里的「标记」会
		// 让旧查询继续命中；这条测试要测的是索引替换，不是分词重叠。
		const file = await store.create({ name: 'a.md', description: '旧词在文件里', content: '正文' })
		assert.equal((await store.list({ query: '旧词' })).total, 1)
		await store.update(file.id, { description: '新语在文件里' })
		assert.equal((await store.list({ query: '旧词' })).total, 0)
		assert.equal((await store.list({ query: '新语' })).total, 1)
	})
})

test('二进制文件只能按描述/名字检索', async () => {
	await withStore(async (store) => {
		await store.create({
			name: 'login-shot.png',
			description: '登录页截图：表单与错误提示',
			content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
		})
		assert.equal((await store.list({ query: '登录页' })).total, 1)
		assert.equal((await store.list({ query: '表单' })).total, 1)
		assert.equal((await store.list({ query: 'PNG' })).total, 1)
	})
})

test('归档文件默认不参与检索，显式包含时可搜', async () => {
	await withStore(async (store) => {
		const file = await store.create({ name: 'old.md', description: '归档专用词：旧接口', content: 'x' })
		await store.archive(file.id, true)
		assert.equal((await store.list({ query: '归档专用词' })).total, 0)
		assert.equal((await store.list({ query: '归档专用词', archived: true })).total, 1)
	})
})

test('空查询按更新时间列出，标签前缀过滤', async () => {
	await withStore(async (store) => {
		const a = await store.create({ name: 'a.md', description: '总结了工作流的文件', content: 'x', tags: ['践行/工作流'] })
		await store.create({ name: 'b.md', description: '另一个见闻文件', content: 'y', tags: ['见闻/事实'] })
		const all = await store.list()
		assert.equal(all.total, 2)
		const tagged = await store.list({ tag: '践行' })
		assert.equal(tagged.total, 1)
		assert.equal(tagged.files[0].id, a.id)
	})
})
