import assert from 'node:assert/strict'
import test from 'node:test'

import { withStore } from './helpers.mjs'

test('检索只认描述：中文两字查询能命中', async () => {
	await withStore(async (store) => {
		const a = await store.create({ tags: ['测试'],
			name: 'design.md',
			description: '插件接口约定：每个文件有唯一 id',
			content: '正文写什么不影响索引。',
		})
		assert.equal((await store.list({ query: '插件' })).total, 1)
		assert.equal((await store.list({ query: '接口' })).files[0].id, a.id)
	})
})

test('正文不参与检索：只有正文里出现的词搜不到', async () => {
	await withStore(async (store) => {
		await store.create({ tags: ['测试'],
			name: 'a.md',
			description: '普通说明文件，描述里没有那个词',
			content: '青鸟协议只写在正文里，索引不应看到它。',
		})
		assert.equal((await store.list({ query: '青鸟' })).total, 0)
	})
})

test('名字与标签可以检索', async () => {
	await withStore(async (store) => {
		const script = await store.create({
			name: 'deploy.sh',
			description: '发布流程的脚本',
			content: '#!/bin/sh\necho ok\n',
			tags: ['运维/发布'],
		})
		assert.equal((await store.list({ query: 'deploy' })).total, 1)
		assert.equal((await store.list({ query: '运维' })).total, 1)
		assert.equal((await store.list({ query: '运维' })).files[0].id, script.id)
	})
})

test('英文描述检索', async () => {
	await withStore(async (store) => {
		const a = await store.create({ tags: ['测试'],
			name: 'proxy.md',
			description: 'reverse proxy rewrites Host and Origin',
			content: '不参与索引的正文。',
		})
		const hits = await store.list({ query: 'reverse proxy' })
		assert.equal(hits.total, 1)
		assert.equal(hits.files[0].id, a.id)
	})
})

test('改描述后旧词从索引消失，新词可搜', async () => {
	await withStore(async (store) => {
		// 旧词与新词不能共享 bigram，否则「旧标记 → 新标记」里的「标记」会
		// 让旧查询继续命中；这条测试要测的是索引替换，不是分词重叠。
		const file = await store.create({ tags: ['测试'], name: 'a.md', description: '旧词在文件里', content: '正文' })
		assert.equal((await store.list({ query: '旧词' })).total, 1)
		await store.update(file.id, { description: '新语在文件里' })
		assert.equal((await store.list({ query: '旧词' })).total, 0)
		assert.equal((await store.list({ query: '新语' })).total, 1)
	})
})

test('二进制文件按描述检索', async () => {
	await withStore(async (store) => {
		const file = await store.create({ tags: ['测试'],
			name: 'login-shot.png',
			description: '登录页截图：表单与错误提示',
			content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
		})
		assert.equal((await store.list({ query: '登录页' })).total, 1)
		assert.equal((await store.list({ query: '表单' })).files[0].id, file.id)
	})
})

test('归档文件默认不参与检索，显式包含时可搜', async () => {
	await withStore(async (store) => {
		const file = await store.create({ tags: ['测试'], name: 'old.md', description: '归档专用词：旧接口', content: 'x' })
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
