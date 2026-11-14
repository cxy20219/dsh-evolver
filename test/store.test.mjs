import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { withStore } from './helpers.mjs'

test('新建文本文件：边车、正文、MIME 都正确', async () => {
	await withStore(async (store, dir) => {
		const file = await store.create({
			name: 'design.md',
			description: '自衍中枢设计稿：一切皆文件的知识库',
			content: '# 自衍中枢\n\n每个文件有唯一 id 和描述。',
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
		assert.equal(sidecar.description, '自衍中枢设计稿：一切皆文件的知识库')
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
				() => store.create({ tags: ['测试'], name: 'a.md', description, content: '内容' }),
				/描述|description/,
				`应拒绝：${JSON.stringify(description)}`,
			)
		}
	})
})

test('文件名净化：路径、空格、超长、非法名', async () => {
	await withStore(async (store) => {
		const escaped = await store.create({ tags: ['测试'], name: '../etc/passwd', description: '逃逸测试文件', content: 'x' })
		assert.equal(escaped.name, 'passwd')
		const spaced = await store.create({ tags: ['测试'], name: 'a b.md', description: '空格测试文件', content: 'x' })
		assert.equal(spaced.name, 'a-b.md')
		const long = await store.create({ tags: ['测试'], name: `${'长'.repeat(100)}.md`, description: '超长名字测试', content: 'x' })
		assert.ok(Buffer.byteLength(long.name, 'utf8') <= 88)
		await assert.rejects(() => store.create({ tags: ['测试'], name: '..', description: '非法名字测试', content: 'x' }), /文件名/)
	})
})

test('同名文件可以共存：id 才是身份', async () => {
	await withStore(async (store) => {
		const first = await store.create({ tags: ['测试'], name: 'notes.md', description: '第一份笔记，讲A', content: 'A' })
		const second = await store.create({ tags: ['测试'], name: 'notes.md', description: '第二份笔记，讲B', content: 'B' })
		assert.notEqual(first.id, second.id)
		assert.equal((await store.read(first.id)).text, 'A')
		assert.equal((await store.read(second.id)).text, 'B')
	})
})

test('二进制文件：只读元数据与路径，不返回正文', async () => {
	await withStore(async (store) => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02])
		const file = await store.create({ tags: ['测试'], name: 'shot.png', description: '自衍中枢面板的登录页截图', content: png })
		assert.equal(file.mime, 'image/png')
		assert.equal(file.text, undefined)
		assert.equal(file.bytes, png.length)
		assert.equal((await stat(file.path)).size, png.length)
		const hits = await store.list({ query: '登录页' })
		assert.equal(hits.total, 1)
		assert.equal(hits.files[0].id, file.id)
	})
})

test('更新正文与改名：旧字节被替换，链接 id 不变', async () => {
	await withStore(async (store) => {
		const target = await store.create({ tags: ['测试'], name: 'target.md', description: '被链接的目标文件', content: '目标' })
		const file = await store.create({ tags: ['测试'], name: 'notes.md', description: '一份会改名的笔记', content: '旧内容', links: [target.id] })
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
		const target = await store.create({ tags: ['测试'], name: 'target.md', description: '会被删除的目标文件', content: 'x' })
		const source = await store.create({ tags: ['测试'], name: 'source.md', description: '引用目标的来源文件', content: 'y', links: [target.id] })
		const result = await store.remove(target.id)
		assert.equal(result.trashed, true)
		assert.equal(await store.read(target.id), undefined)
		const trash = await readdir(join(dir, 'system', 'trash'))
		assert.equal(trash.length, 1)
		assert.ok(trash[0].endsWith(target.id))
		const read = await store.read(source.id)
		assert.equal(read.neighbors.out[0].missing, true)
		assert.equal((await store.list()).total, 1)
	})
})

test('归档：默认列表不出现，archived 列表出现', async () => {
	await withStore(async (store) => {
		const file = await store.create({ tags: ['测试'], name: 'old.md', description: '一份要归档的旧文件', content: 'x' })
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
			() => store.create({ tags: ['测试'], name: 'big.bin', description: '一份过大的二进制文件', content: Buffer.alloc(64) }),
			/上限/,
		)
		const folders = await readdir(join(dir, 'files'))
		assert.equal(folders.length, 0)
	}, { maxBytes: 16 })
})

test('脚本自动带可执行位，普通文件不带；改名后权限跟着变', async () => {
	await withStore(async (store) => {
		// Windows cannot represent POSIX permission bits, so the raw mode is
		// asserted only where the platform has it; `executable` is the contract
		// both platforms share.
		const posix = process.platform !== 'win32'
		const script = await store.create({ tags: ['测试'],
			name: 'deploy.sh',
			description: '部署脚本：输出 ok，演示脚本文件可直接执行',
			content: '#!/bin/sh\necho ok\n',
		})
		if (posix) assert.equal((await stat(script.path)).mode & 0o777, 0o700)
		assert.equal(script.executable, true)
		const note = await store.create({ tags: ['测试'], name: 'note.md', description: '普通说明文件，不应带执行位', content: 'x' })
		if (posix) assert.equal((await stat(note.path)).mode & 0o777, 0o600)
		assert.equal(note.executable, false)
		const renamed = await store.update(script.id, { name: 'deploy.txt' })
		if (posix) assert.equal((await stat(renamed.path)).mode & 0o777, 0o600)
		assert.equal(renamed.executable, false)
	})
})

test('标签必填：缺失、空数组、空路径都拒绝', async () => {
	await withStore(async (store) => {
		await assert.rejects(
			() => store.create({ name: 'a.md', description: '没有标签的文件', content: 'x' }),
			/标签/,
		)
		await assert.rejects(
			() => store.create({ name: 'a.md', description: '标签为空数组的文件', content: 'x', tags: [] }),
			/标签/,
		)
		await assert.rejects(
			() => store.create({ name: 'a.md', description: '标签只有空段的文件', content: 'x', tags: [' / ', '#'] }),
			/标签/,
		)
	})
})

test('标签是自由层级组合：任意深度、去空段、父标签过滤、多标签 AND', async () => {
	await withStore(async (store) => {
		const file = await store.create({
			name: 'a.md',
			description: '自由层级标签的测试文件',
			content: 'x',
			tags: ['工作/项目/自衍中枢', '类型/脚本', '#来源/会话', '工作//重复/'],
		})
		assert.deepEqual(file.tags, ['工作/项目/自衍中枢', '类型/脚本', '来源/会话', '工作/重复'])
		assert.equal((await store.list({ tag: '工作' })).total, 1)
		assert.equal((await store.list({ tag: '工作/项目' })).total, 1)
		assert.equal((await store.list({ tag: '类型' })).total, 1)
		assert.equal((await store.list({ tags: ['工作/项目', '类型'] })).total, 1)
		assert.equal((await store.list({ tags: ['工作/项目', '类型/文档'] })).total, 0)
		assert.equal((await store.list({ tag: '不存在' })).total, 0)
	})
})

test('描述上限跟着设置走：默认 160 拒绝，200 放行', async () => {
	const long = '长'.repeat(180)
	await withStore(async (store) => {
		await assert.rejects(
			() => store.create({ name: 'a.md', description: long, content: 'x', tags: ['测试/描述'] }),
			/描述/,
		)
	})
	await withStore(async (store) => {
		const file = await store.create({ name: 'a.md', description: long, content: 'x', tags: ['测试/描述'] })
		assert.equal([...file.description].length, 180)
	}, { descriptionMaxChars: 200 })
})

test('活动统计：新建文件计入当天，天数从首个文件算起', async () => {
	await withStore(async (store) => {
		await store.create({ name: 'today.md', description: '今天写入的活动统计文件', content: 'x', tags: ['测试/活动'] })
		const now = new Date()
		const activity = store.activity({ now: now })
		assert.equal(activity.days, 1)
		assert.equal(activity.activeDays, 1)
		assert.equal(activity.notes, 1)
		assert.equal(activity.activity.length, 365)
		assert.equal(activity.activity.at(-1).count, 1)
	})
})

test('文件后缀统计：按最后一个点分组，归档文件不计入', async () => {
	await withStore(async (store) => {
		await store.create({ name: 'a.md', description: '后缀统计的 Markdown 文件', content: 'x', tags: ['测试/后缀'] })
		await store.create({ name: 'b.sh', description: '后缀统计的脚本文件', content: 'x', tags: ['测试/后缀'] })
		await store.create({ name: 'README', description: '没有后缀的说明文件', content: 'x', tags: ['测试/后缀'] })
		await store.create({ name: 'archive.tar.gz', description: '多后缀的压缩包文件', content: 'x', tags: ['测试/后缀'] })
		const archived = await store.create({ name: 'old.png', description: '已归档的图片文件', content: 'x', tags: ['测试/后缀'] })
		await store.archive(archived.id, true)
		const rows = store.suffixCounts()
		const counts = Object.fromEntries(rows.map((row) => [row.suffix, row.count]))
		assert.deepEqual(counts, { '': 1, md: 1, sh: 1, gz: 1 })
		assert.equal(rows.reduce((sum, row) => sum + row.count, 0), 4)
	})
})
