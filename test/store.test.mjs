import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import { FileStore, readPayloadSource } from '../src/store.js'
import { IndexDatabase } from '../src/db.js'
import { isReservedName } from '../src/names.js'
import { tempDir, withStore } from './helpers.mjs'

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

test('整理报告：孤立、悬空、未更新与单例标签各自独立计数', async () => {
	await withStore(async (store) => {
		const lonely = await store.create({ name: 'lonely.md', description: '没有任何链接的孤立文件', content: 'x', tags: ['测试/整理'] })
		const doc = await store.create({ name: 'doc.md', description: '会链接别人也被链接的文件', content: 'x', tags: ['测试/整理', '测试/整理/唯一'] })
		const target = await store.create({ name: 'target.md', description: '被删掉的目标文件', content: 'x', tags: ['测试/整理'] })
		await store.update(doc.id, { links: [target.id] })
		await store.remove(target.id)

		// Two days later, so the staleness cut-off has something to catch.
		const later = Date.now() + 2 * 86_400_000
		const report = store.organizeReport({ staleDays: 1, now: later })

		assert.equal(report.orphans.total, 1)
		assert.equal(report.orphans.sample[0].id, lonely.id)
		assert.equal(report.dangling.total, 1)
		assert.equal(report.dangling.sample[0].from, doc.id)
		assert.equal(report.stale.total, 2, '两个活跃文件都已过陈旧线')
		assert.equal(report.singleTags.total, 1, '「测试/整理/唯一」只用过一次')
		assert.equal(report.singleTags.sample[0].tag, '测试/整理/唯一')
	})
})

test('按后缀筛选：扩展名与「无后缀」是两个不同的桶', async () => {
	await withStore(async (store) => {
		await store.create({ name: 'a.md', description: '后缀用例：Markdown 文件', content: 'x', tags: ['测试/后缀筛选'] })
		await store.create({ name: 'b.MD', description: '后缀用例：大写扩展名', content: 'x', tags: ['测试/后缀筛选'] })
		await store.create({ name: 'README', description: '后缀用例：没有扩展名', content: 'x', tags: ['测试/后缀筛选'] })
		await store.create({ name: 'c.tar.gz', description: '后缀用例：多段扩展名', content: 'x', tags: ['测试/后缀筛选'] })

		assert.equal((await store.list({ suffix: 'md', limit: 10 })).total, 2, '大小写不敏感')
		assert.equal((await store.list({ suffix: '', limit: 10 })).total, 1, '空串只选没有扩展名的')
		assert.equal((await store.list({ suffix: 'gz', limit: 10 })).total, 1)
		assert.equal((await store.list({ suffix: 'tar', limit: 10 })).total, 0, '只比最后一段')
		assert.equal((await store.list({ limit: 10 })).total, 4, '不传后缀就是不过滤')

		// 搜索路径也要认后缀：候选先按 FTS 命中，再用同一套后缀规则过滤。
		assert.equal((await store.list({ query: '后缀用例', suffix: 'md', limit: 10 })).total, 2)
	})
})

test('坏 DB：open 隔离为 ziyan.db.corrupt-*，从边车重建并可继续写入', async () => {
	const dir = await tempDir()
	try {
		const store = new FileStore({ dataDir: dir })
		await store.open()
		const keep = await store.create({ tags: ['测试/恢复'], name: 'keep.md', description: '坏库重建后仍应可见的文件', content: '正文' })
		store.close()
		// 模拟磁盘损坏：主库字节不再是 SQLite 文件（先清掉 WAL 卫星文件，
		// 让场景就是单纯的主库损坏）。
		for (const name of await readdir(join(dir, 'system'))) {
			if (name.startsWith('ziyan.db-')) await rm(join(dir, 'system', name), { force: true })
		}
		await writeFile(join(dir, 'system', 'ziyan.db'), 'this is not a sqlite database')

		const reopened = new FileStore({ dataDir: dir })
		try {
			await reopened.open()
			assert.equal(reopened.stats().files, 1, '索引从边车重建')
			const read = await reopened.read(keep.id)
			assert.equal(read.missing, false)
			assert.equal(read.text, '正文')
			const quarantined = (await readdir(join(dir, 'system'))).filter((name) => name.startsWith('ziyan.db.corrupt-'))
			assert.equal(quarantined.length, 1, '坏库以新名保留而不是被删掉')
			assert.equal(
				await readFile(join(dir, 'system', quarantined[0]), 'utf8'),
				'this is not a sqlite database',
				'坏库原字节保留，便于诊断',
			)
			const created = await reopened.create({ tags: ['测试/恢复'], name: 'new.md', description: '重建后的索引可以继续写入', content: 'new' })
			assert.match(created.id, /^file-/)
			assert.equal((await reopened.list()).total, 2)
		} finally {
			reopened.close()
		}
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('schema 版本不匹配：同样隔离并从边车重建，而不是让整库加载失败', async () => {
	const dir = await tempDir()
	try {
		const store = new FileStore({ dataDir: dir })
		await store.open()
		const keep = await store.create({ tags: ['测试/恢复'], name: 'keep.md', description: '版本不匹配时仍应重建回来的文件', content: '正文' })
		store.close()
		const raw = new DatabaseSync(join(dir, 'system', 'ziyan.db'))
		raw.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run()
		raw.close()

		const reopened = new FileStore({ dataDir: dir })
		try {
			await reopened.open()
			assert.equal(reopened.stats().files, 1)
			assert.equal((await reopened.read(keep.id)).text, '正文')
			assert.ok((await readdir(join(dir, 'system'))).some((name) => name.startsWith('ziyan.db.corrupt-')))
		} finally {
			reopened.close()
		}
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('坏 DB 打开失败前关闭句柄：文件可立即改名/删除（Windows 也不锁）', async () => {
	const dir = await tempDir()
	try {
		const path = join(dir, 'ziyan.db')
		await writeFile(path, 'garbage bytes')
		const db = new IndexDatabase({ path })
		assert.throws(() => db.open())
		// 句柄没关时 Windows 上这里会 EBUSY；能删掉即证明 close 已执行。
		await rm(path)
		db.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('重建窗口内并发新建的文件不会永久丢索引（scan 快照后的写入保留）', async () => {
	const dir = await tempDir()
	const store = new FileStore({ dataDir: dir })
	try {
		await store.open()
		const older = await store.create({ tags: ['测试/重建'], name: 'old.md', description: '重建窗口之前就存在的文件', content: 'old' })
		let concurrent
		const realScan = store.scan.bind(store)
		store.scan = async () => {
			const snapshot = await realScan()
			// scan 快照之后、重建事务之前插入一次真实写入：旧实现会先清表再
			// 只重插快照，这个文件从此永久不在索引里（重启也不会再重建）。
			concurrent = await store.create({ tags: ['测试/重建'], name: 'new.md', description: '重建窗口内并发新建的文件', content: 'new' })
			return snapshot
		}
		const report = await store.rebuild()
		assert.equal(report.files, 1, '扫描快照只看到旧文件')
		const ids = (await store.list({ limit: 10 })).files.map((file) => file.id).sort()
		assert.deepEqual(ids, [older.id, concurrent.id].sort(), '并发新建的文件仍在索引里')
		assert.equal((await store.read(concurrent.id)).missing, false)
		store.close()

		// 模拟重启：DB 非空不会再触发重建，可见性就是最终结果。
		const reopened = new FileStore({ dataDir: dir })
		try {
			await reopened.open()
			assert.equal((await reopened.list()).total, 2, '重启后并发写入的文件仍可见')
		} finally {
			reopened.close()
		}
	} finally {
		store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('重建删除扫描未见且早于扫描时间的行：手工删掉的文件从索引消失', async () => {
	await withStore(async (store, dir) => {
		const doomed = await store.create({ tags: ['测试/重建'], name: 'gone.md', description: '手工删掉目录的旧文件', content: 'x' })
		const kept = await store.create({ tags: ['测试/重建'], name: 'kept.md', description: '仍然存在的文件', content: 'y' })
		await rm(join(dir, 'files', doomed.id), { recursive: true, force: true })
		const report = await store.rebuild()
		assert.equal(report.files, 1)
		const ids = (await store.list({ limit: 10 })).files.map((file) => file.id)
		assert.deepEqual(ids, [kept.id])
		assert.equal((await store.read(doomed.id)), undefined)
	})
})

test('meta.json 保留名：create/update 拒绝，已有坏边车在重建报告里', async () => {
	assert.equal(isReservedName('meta.json'), true)
	for (const name of ['META.JSON', 'meta.json.', 'meta.json ', 'Meta.Json']) {
		assert.equal(isReservedName(name), true, `应识别为保留名：${JSON.stringify(name)}`)
	}
	for (const name of ['meta-note.json', 'meta.jsonx', 'notes.md', '.env']) {
		assert.equal(isReservedName(name), false, `不应识别为保留名：${JSON.stringify(name)}`)
	}

	const dir = await tempDir()
	try {
		const store = new FileStore({ dataDir: dir })
		await store.open()
		const keep = await store.create({ name: 'keep.md', description: '改名撞保留名时保持原样的文件', content: 'KEEP', tags: ['测试/保留名'] })
		for (const name of ['meta.json', 'META.JSON', 'meta.json.']) {
			await assert.rejects(
				() => store.create({ name, description: '保留名写入必须被拒绝的测试', content: 'x', tags: ['测试/保留名'] }),
				/保留名/,
				`create 应拒绝：${JSON.stringify(name)}`,
			)
		}
		await assert.rejects(() => store.update(keep.id, { name: 'meta.json' }), /保留名/)
		await assert.rejects(() => store.update(keep.id, { name: 'META.JSON.', content: 'x' }), /保留名/)
		const kept = await store.read(keep.id)
		assert.equal(kept.name, 'keep.md', '被拒绝的改名没有落盘')
		assert.equal(kept.text, 'KEEP', '正文没有被边车覆盖')
		store.close()

		// 旧版本留下的坏实体：边车自己声称 payload 名是 meta.json。
		const metaPath = join(dir, 'files', keep.id, 'meta.json')
		const meta = JSON.parse(await readFile(metaPath, 'utf8'))
		meta.name = 'meta.json'
		await writeFile(metaPath, `${JSON.stringify(meta, null, '\t')}\n`)

		const reopened = new FileStore({ dataDir: dir })
		try {
			await reopened.open()
			const report = await reopened.rebuild()
			assert.equal(report.files, 0)
			assert.match(report.problems.map((item) => item.reason).join('|'), /保留名/)
			assert.equal((await reopened.list()).total, 0, '坏实体不会进入索引')
		} finally {
			reopened.close()
		}
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('sourcePath 预检：目录、不存在、Windows 设备/管道路径都在读取前拒绝', async () => {
	const dir = await tempDir()
	try {
		await mkdir(join(dir, 'folder'))
		const calls = []
		const spy = async (path) => {
			calls.push(path)
			return Buffer.from('x')
		}
		await assert.rejects(
			() => readPayloadSource(join(dir, 'folder'), 1024, { readBytes: spy }),
			/不是普通文件/,
		)
		await assert.rejects(
			() => readPayloadSource(join(dir, 'missing.bin'), 1024, { readBytes: spy }),
			/不存在或不可读/,
		)
		assert.deepEqual(calls, [], '被预检拒绝的 sourcePath 一个字节都不读')
		if (process.platform === 'win32') {
			for (const device of ['CON', 'NUL', 'C:\\Windows\\System32\\CON', '\\\\.\\pipe\\ziyan-test']) {
				await assert.rejects(
					() => readPayloadSource(device, 1024, { readBytes: spy }),
					/设备\/管道/,
					`应拒绝设备路径：${device}`,
				)
			}
			assert.deepEqual(calls, [], '设备/管道路径没有碰读取函数')
		}
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('sourcePath 大文件：stat 预检按大小拒绝，不读正文（导入不 OOM）', async () => {
	const dir = await tempDir()
	try {
		const big = join(dir, 'big.bin')
		await writeFile(big, '')
		// 稀疏文件：占位 256 MiB 但几乎不写盘，正好模拟“大文件被整读”的路径。
		await truncate(big, 256 * 1024 * 1024)
		assert.equal((await stat(big)).size, 256 * 1024 * 1024)
		const calls = []
		await assert.rejects(
			() => readPayloadSource(big, 1024, {
				readBytes: async (path) => {
					calls.push(path)
					return Buffer.alloc(256 * 1024 * 1024)
				},
			}),
			/上限/,
		)
		assert.deepEqual(calls, [], '超过上限的正文没有被读进内存')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('file_import 等价路径：store.create({sourcePath}) 对大文件与目录先拒绝、不落库', async () => {
	const dir = await tempDir()
	try {
		const big = join(dir, 'big.log')
		await writeFile(big, '')
		await truncate(big, 2 * 1024 * 1024)
		await mkdir(join(dir, 'folder'))
		await withStore(async (store, dataDir) => {
			await assert.rejects(
				() => store.create({ sourcePath: big, name: 'big.log', description: '过大的导入文件被预检拒绝', tags: ['测试/导入'] }),
				/上限/,
			)
			await assert.rejects(
				() => store.create({ sourcePath: join(dir, 'folder'), name: 'x.md', description: '目录不能被当作文件导入', tags: ['测试/导入'] }),
				/不是普通文件/,
			)
			assert.equal((await readdir(join(dataDir, 'files'))).length, 0, '预检拒绝不产生实体')
		}, { maxBytes: 1024 })
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('sourcePath 符号链接：指向普通文件可导入，指向目录按类型拒绝', async () => {
	const dir = await tempDir()
	try {
		const target = join(dir, 'target.txt')
		await writeFile(target, '真实内容')
		const link = join(dir, 'link.txt')
		const dirLink = join(dir, 'dir-link')
		await mkdir(join(dir, 'folder'))
		try {
			await symlink(target, link)
			await symlink(join(dir, 'folder'), dirLink, 'dir')
		} catch {
			return // Windows 未开开发者模式时建不了软链；平台允许才测。
		}
		const buffer = await readPayloadSource(link, 1024)
		assert.equal(buffer.toString('utf8'), '真实内容', 'realpath 后按真实文件读取')
		await assert.rejects(() => readPayloadSource(dirLink, 1024), /不是普通文件/)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('改名嗅探 MIME 只读头部：超长 UTF-8 文本在 8KB 截断处不被误判为二进制', async () => {
	await withStore(async (store) => {
		// 12000 字节中文：8192 的头部正好切在一个字符中间。
		const content = '中'.repeat(4000)
		const file = await store.create({ name: 'note.md', description: '超长中文文本，用于改名嗅探测试', content, tags: ['测试/嗅探'] })
		const original = FileStore.prototype.readHead
		let sniffed = 0
		FileStore.prototype.readHead = async function (path) {
			const head = await original.call(this, path)
			sniffed = head.length
			return head
		}
		try {
			const renamed = await store.update(file.id, { name: 'note.unknownext' })
			assert.equal(renamed.mime, 'text/plain', '头部截断处的半个字符不能把文本判成二进制')
			assert.equal(renamed.text, content)
			assert.ok(sniffed > 0 && sniffed <= 8192, `嗅探只读头部（实际 ${sniffed} 字节）`)
		} finally {
			FileStore.prototype.readHead = original
		}
	})
})

/**
 * Count one scalar with raw SQL against the store's index.
 *
 * @param {import('../src/store.js').FileStore} store - The store.
 * @param {string} sql - A SELECT returning one `c` column.
 * @returns {number} The count.
 */
function scalar(store, sql) {
	return Number(store.db.db.prepare(sql).get().c)
}

test('FTS 行与 files 行按 rowid 对齐：改描述、删除后索引与行数始终一致', async () => {
	await withStore(async (store) => {
		const first = await store.create({ tags: ['测试/索引'], name: 'a.md', description: '第一条：旧词在文件里', content: 'x' })
		const second = await store.create({ tags: ['测试/索引'], name: 'b.md', description: '第二条：另一个文件', content: 'y' })
		const aligned = () => assert.equal(
			scalar(store, 'SELECT COUNT(*) AS c FROM files_fts f LEFT JOIN files x ON x.rowid = f.rowid WHERE x.id IS NULL'),
			0,
			'每条 FTS 行的 rowid 必须指向一条 files 行',
		)
		assert.equal(scalar(store, 'SELECT COUNT(*) AS c FROM files_fts'), 2)
		aligned()

		await store.update(first.id, { description: '第一条：换成新语' })
		assert.equal((await store.list({ query: '旧词' })).total, 0, '旧 FTS 行按 rowid 删掉了')
		assert.equal((await store.list({ query: '新语' })).total, 1)
		assert.equal(scalar(store, 'SELECT COUNT(*) AS c FROM files_fts'), 2, '更新不留下重复 FTS 行')
		aligned()

		await store.remove(second.id)
		assert.equal(scalar(store, 'SELECT COUNT(*) AS c FROM files_fts'), 1)
		aligned()
	})
})

test('rebuild 之后 FTS 仍按 rowid 对齐，搜索与短 id 都能用', async () => {
	await withStore(async (store) => {
		const file = await store.create({ tags: ['测试/重建'], name: 'kb.md', description: '重建之后仍然可以检索：青鸟协议', content: 'x' })
		await store.rebuild()
		assert.equal(scalar(store, 'SELECT COUNT(*) AS c FROM files_fts'), 1)
		assert.equal(
			scalar(store, 'SELECT COUNT(*) AS c FROM files_fts f LEFT JOIN files x ON x.rowid = f.rowid WHERE x.id IS NULL'),
			0,
		)
		assert.equal((await store.list({ query: '青鸟' })).total, 1)
		assert.equal(store.resolveId(file.short), file.id, '重建后短 id 索引照常解析')
		const created = await store.create({ tags: ['测试/重建'], name: 'kb2.md', description: '重建之后新增文件也能被搜到', content: 'y' })
		assert.equal((await store.list({ query: '新增文件' })).files[0].id, created.id)
	})
})

test('索引不再有 legacy_id 列，边车也不写 legacyId', async () => {
	await withStore(async (store, dir) => {
		const file = await store.create({ tags: ['测试/迁移'], name: 'legacy.md', description: '老迁移字段已经删除的验证文件', content: 'x' })
		const columns = store.db.db.prepare('PRAGMA table_info(files)').all().map((column) => String(column.name))
		assert.ok(!columns.includes('legacy_id'), `files 表不应再有 legacy_id：${columns.join(',')}`)
		const sidecar = JSON.parse(await readFile(join(dir, 'files', file.id, 'meta.json'), 'utf8'))
		assert.equal(sidecar.legacyId, undefined)
		assert.equal(sidecar.id, file.id)
	})
})

test('孤立计数：链接/删除后增量维护，stats 与整理报告一致', async () => {
	await withStore(async (store) => {
		const lonely = await store.create({ tags: ['测试/孤立'], name: 'lonely.md', description: '没有任何链接的孤立文件', content: 'x' })
		const from = await store.create({ tags: ['测试/孤立'], name: 'from.md', description: '指向别人的文件', content: 'x' })
		const to = await store.create({ tags: ['测试/孤立'], name: 'to.md', description: '被别人指向的文件', content: 'x' })
		assert.equal(store.stats().orphans, 3)
		assert.equal(store.organizeReport({ staleDays: 3650 }).orphans.total, 3)

		await store.link(from.id, to.id)
		assert.equal(store.stats().orphans, 1, '链接两端都不再是孤立文件')
		assert.equal(store.organizeReport({ staleDays: 3650 }).orphans.total, 1)

		await store.unlink(from.id, to.id)
		assert.equal(store.stats().orphans, 3)

		await store.link(from.id, to.id)
		await store.remove(to.id)
		assert.equal(store.stats().orphans, 1, '悬空出边仍算「有边」，只有 lonely 是孤立文件')
		assert.equal(store.organizeReport({ staleDays: 3650 }).orphans.total, 1)
		assert.equal(store.organizeReport({ staleDays: 3650 }).dangling.total, 1, '被删目标的入边留成悬空')

		await store.remove(from.id)
		assert.equal(store.stats().orphans, 1)
		assert.equal(store.organizeReport({ staleDays: 3650 }).orphans.total, 1)
		assert.ok(lonely.id)
	})
})

test('归档切换：标签聚合与标签过滤立即跟随，反归档后恢复', async () => {
	await withStore(async (store) => {
		const keeper = await store.create({ tags: ['测试/归档聚合', '测试/归档聚合/保留'], name: 'keep.md', description: '保持活跃的归档聚合用例文件', content: 'x' })
		const gone = await store.create({ tags: ['测试/归档聚合/独有'], name: 'gone.md', description: '即将被归档的独有标签文件', content: 'y' })
		const tagCount = (tag) => store.tagCounts(1000).find((entry) => entry.tag === tag)?.count
		assert.equal(tagCount('测试/归档聚合/独有'), 1)
		assert.equal((await store.list({ tag: '测试/归档聚合' })).total, 2)

		await store.archive(gone.id, true)
		assert.equal(tagCount('测试/归档聚合/独有'), undefined, '归档文件的标签不进活跃标签树')
		assert.equal(tagCount('测试/归档聚合'), 1)
		assert.equal((await store.list({ tag: '测试/归档聚合' })).total, 1)
		assert.equal((await store.list({ archived: true, tag: '测试/归档聚合' })).total, 1, '归档页仍能按标签过滤')
		assert.equal(store.stats().tags, 2, 'stats 的标签数只算活跃文件')

		await store.archive(gone.id, false)
		assert.equal(tagCount('测试/归档聚合/独有'), 1)
		assert.equal((await store.list({ tag: '测试/归档聚合' })).total, 2)
		assert.ok(keeper.id)
	})
})

test('短 id：撞车的五位后缀拒绝解析，更长后缀唯一；写入/删除即时生效', async () => {
	await withStore(async (store) => {
		const stamp = new Date().toISOString()
		const meta = (id, name) => ({
			schema: 1, id, name, description: `短 id 用例：${name}`, tags: ['测试/短id'], links: [],
			created: stamp, updated: stamp, mime: 'text/markdown', bytes: 1, sha256: 'a'.repeat(64), archived: false,
		})
		const left = `file-${'A'.repeat(21)}XY3AB`
		const right = `file-${'B'.repeat(21)}XY3AB`
		store.db.upsert(meta(left, 'left.md'))
		store.db.upsert(meta(right, 'right.md'))
		assert.equal(store.resolveId('XY3AB'), undefined, '五位后缀撞车时不能猜')
		assert.equal(store.resolveId('AXY3AB'), left)
		assert.equal(store.resolveId('BXY3AB'), right)

		const created = await store.create({ tags: ['测试/短id'], name: 'live.md', description: '写入后即可用短 id 读取', content: 'z' })
		assert.equal(store.resolveId(created.short), created.id)
		const read = await store.read(store.resolveId(created.short))
		assert.equal(read?.id, created.id)

		store.db.remove(right)
		assert.equal(store.resolveId('XY3AB'), left, '撞车项删除后五位后缀重新唯一')
	})
})
