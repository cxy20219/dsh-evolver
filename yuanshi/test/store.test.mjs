import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { withStore } from './helpers.mjs'

test('新建文本文件：边车、正文、MIME 都正确', async () => {
	await withStore(async (store, dir) => {
		const file = await store.create({
			name: 'design.md',
			description: '元始设计稿：一切皆文件的知识库',
			content: '# 元始\n\n每个文件有唯一 id 和描述。',
			tags: ['工作流', '#演化器'],
			source: { quote: '一切皆文件', session: 'session-1' },
		})
		assert.match(file.id, /^file-[0-9A-HJKMNP-TV-Z]{26}$/)
		assert.equal(file.name, 'design.md')
		assert.equal(file.mime, 'text/markdown')
		assert.equal(file.tags.length, 2)
		assert.equal(file.source.quote, '一切皆文件')
		assert.equal(file.missing, false)
		assert.match(file.text, /每个文件有唯一/)
		assert.ok(file.short.length >= 5)

		const sidecar = JSON.parse(await readFile(join(dir, 'files', file.id, 'meta.json'), 'utf8'))
		assert.equal(sidecar.id, file.id)
		assert.equal(sidecar.description, '元始设计稿：一切皆文件的知识库')
		assert.equal(sidecar.links.length, 0)
		assert.equal(sidecar.schema, 1)

		const listed = await store.list()
		assert.equal(listed.total, 1)
		assert.equal(listed.files[0].id, file.id)
	})
})

test('描述是必填语义：空、占位词、太短、太长都拒绝', async () => {
	await withStore(async (store) => {
		for (const description of ['', '   ', '暂无', 'TODO', 'abc', 'x'.repeat(161)]) {
			await assert.rejects(
				() => store.create({ name: 'a.md', description, content: '内容' }),
				/描述|description/,
				`应拒绝：${JSON.stringify(description)}`,
			)
		}
	})
})

test('文件名净化：路径、空格、超长、非法名', async () => {
	await withStore(async (store) => {
		const escaped = await store.create({ name: '../etc/passwd', description: '逃逸测试文件', content: 'x' })
		assert.equal(escaped.name, 'passwd')
		const spaced = await store.create({ name: 'a b.md', description: '空格测试文件', content: 'x' })
		assert.equal(spaced.name, 'a-b.md')
		const long = await store.create({ name: `${'长'.repeat(100)}.md`, description: '超长名字测试', content: 'x' })
		assert.ok(Buffer.byteLength(long.name, 'utf8') <= 88)
		await assert.rejects(() => store.create({ name: '..', description: '非法名字测试', content: 'x' }), /文件名/)
	})
})

test('同名文件可以共存：id 才是身份', async () => {
	await withStore(async (store) => {
		const first = await store.create({ name: 'notes.md', description: '第一份笔记，讲A', content: 'A' })
		const second = await store.create({ name: 'notes.md', description: '第二份笔记，讲B', content: 'B' })
		assert.notEqual(first.id, second.id)
		assert.equal((await store.read(first.id)).text, 'A')
		assert.equal((await store.read(second.id)).text, 'B')
	})
})

test('二进制文件：只读元数据与路径，不返回正文', async () => {
	await withStore(async (store) => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02])
		const file = await store.create({ name: 'shot.png', description: '元始面板的登录页截图', content: png })
		assert.equal(file.mime, 'image/png')
		assert.equal(file.text, undefined)
		assert.equal(file.bytes, png.length)
		assert.equal((await stat(file.path)).size, png.length)
		const hits = await store.list({ query: '登录页' })
		assert.equal(hits.total, 1)
		assert.equal(hits.files[0].id, file.id)
		assert.equal(hits.files[0].snippet, undefined)
	})
})

test('更新正文与改名：旧字节被替换，链接 id 不变', async () => {
	await withStore(async (store) => {
		const target = await store.create({ name: 'target.md', description: '被链接的目标文件', content: '目标' })
		const file = await store.create({ name: 'notes.md', description: '一份会改名的笔记', content: '旧内容', links: [target.id] })
		const before = file.updated
		const updated = await store.update(file.id, {
			name: 'notes.txt',
			description: '改名后的笔记描述',
			content: '新内容',
			tags: ['新标签'],
		})
		assert.equal(updated.id, file.id)
		assert.equal(updated.name, 'notes.txt')
		assert.equal(updated.mime, 'text/plain')
		assert.equal(updated.text, '新内容')
		assert.equal(updated.tags[0], '新标签')
		assert.equal(updated.links[0], target.id)
		assert.notEqual(updated.sha256, file.sha256)
		assert.ok(updated.updated >= before)
		const files = await readdir(join(store.entityDir(file.id)))
		assert.deepEqual(files.filter((name) => name !== 'meta.json'), ['notes.txt'])
	})
})

test('删除：先移进 trash，再删索引；悬空链接保留', async () => {
	await withStore(async (store, dir) => {
		const target = await store.create({ name: 'target.md', description: '会被删除的目标文件', content: 'x' })
		const source = await store.create({ name: 'source.md', description: '引用目标的来源文件', content: 'y', links: [target.id] })
		const result = await store.remove(target.id)
		assert.equal(result.trashed, true)
		assert.equal(await store.read(target.id), undefined)
		const trash = await readdir(join(dir, 'trash'))
		assert.equal(trash.length, 1)
		assert.ok(trash[0].endsWith(target.id))
		const read = await store.read(source.id)
		assert.equal(read.neighbors.out[0].missing, true)
		assert.equal((await store.list()).total, 1)
	})
})

test('归档：默认列表不出现，archived 列表出现', async () => {
	await withStore(async (store) => {
		const file = await store.create({ name: 'old.md', description: '一份要归档的旧文件', content: 'x' })
		await store.archive(file.id, true)
		assert.equal((await store.list()).total, 0)
		assert.equal((await store.list({ archived: true })).total, 1)
		const stats = store.stats()
		assert.equal(stats.archived, 1)
	})
})

test('大小上限：超过即拒绝，不落盘', async () => {
	await withStore(async (store, dir) => {
		await assert.rejects(
			() => store.create({ name: 'big.bin', description: '一份过大的二进制文件', content: Buffer.alloc(64) }),
			/上限/,
		)
		const folders = await readdir(join(dir, 'files'))
		assert.equal(folders.length, 0)
	}, { maxBytes: 16 })
})
