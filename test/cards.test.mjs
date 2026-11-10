import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { cardId, isCardId } from '../src/cards/ids.js'
import { normalizeTag, normalizeTags, buildTagTree } from '../src/cards/tags.js'
import { safeResourceName } from '../src/cards/resources.js'
import { CardStore, labelOf } from '../src/cards/store.js'
import { migrateToCards } from '../src/cards/migrate.js'

/**
 * A card store on a temporary folder.
 *
 * @param {{cardMaxChars?: number}} [options] - Store options.
 * @returns {Promise<{dir: string, store: CardStore}>} The fixture.
 */
async function fixture(options = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'evr-cards-'))
	const store = new CardStore({
		dataDir: dir,
		embedding: { id: 'none' },
		cardMaxChars: options.cardMaxChars,
	})
	await store.init()
	return { dir, store }
}

test('卡片 id 是时间有序的 ULID 且同毫秒不重复', () => {
	const ids = new Set()
	for (let index = 0; index < 500; index += 1) ids.add(cardId(1_700_000_000_000))
	assert.equal(ids.size, 500)
	const first = cardId(1_700_000_000_000)
	const later = cardId(1_700_000_001_000)
	assert.ok(first < later)
	assert.equal(isCardId(first), true)
	assert.equal(isCardId(`${first}x`), false)
})

test('层级标签归一化、白名单和多父树计数', () => {
	assert.equal(normalizeTag('#验证/浏览器 UI'), '验证/浏览器-ui')
	assert.equal(normalizeTag(' A / B / C '), 'a/b/c')
	assert.equal(normalizeTag('..'), '')
	assert.deepEqual(normalizeTags(['#验证/浏览器', '验证/浏览器', '中文 标签', '']), ['验证/浏览器', '中文-标签'])
	const tree = buildTagTree([
		{ id: '1', tags: ['验证/浏览器'] },
		{ id: '2', tags: ['验证/索引'] },
		{ id: '3', tags: ['验证/浏览器', '项目/x'] },
	])
	const verify = tree.find((node) => node.path === '验证')
	assert.equal(verify.count, 3)
	assert.equal(verify.children.length, 2)
	assert.equal(tree.find((node) => node.path === '项目')?.children[0].count, 1)
})

test('资源文件名被压成一个安全段，路径无法逃出卡片目录', () => {
	assert.equal(safeResourceName('../../etc/passwd'), 'passwd')
	assert.equal(safeResourceName('run.sh'), 'run.sh')
	assert.equal(safeResourceName('a/b/c.md'), 'c.md')
	assert.equal(safeResourceName('..'), '')
	assert.equal(safeResourceName(''), '')
})

test('卡片写入：label 派生、标签、上限、提升、归档、双链和投影', async () => {
	const { dir, store } = await fixture()
	try {
		const memo = await store.put({
			type: 'fleeting',
			shape: 'memo',
			body: '# 部署方式\n\n本机部署走 SSH，不要用 HTTPS。',
			tags: ['验证/浏览器', '项目/dsh-evolver'],
		})
		assert.equal(memo.label, '部署方式')
		assert.equal(memo.status, 'inbox')
		assert.deepEqual(memo.tags, ['验证/浏览器', '项目/dsh-evolver'])

		const edited = await store.put({ id: memo.id, type: 'fleeting', shape: 'memo', body: '换了一行\n正文也变了' })
		assert.equal(edited.label, '换了一行')

		const promoted = await store.promote(memo.id, { summary: '部署方式' })
		assert.equal(promoted.type, 'permanent')
		assert.equal(promoted.status, 'verified')
		assert.equal(promoted.shape, 'note')

		const doc = await store.put({ type: 'permanent', shape: 'note', body: '第二条永久卡', tags: ['验证/索引'], summary: '索引说明' })
		const linked = await store.put({ type: 'fleeting', shape: 'memo', body: '指向第一张卡', links: [memo.id] })

		const backlinks = store.backlinks()
		assert.deepEqual(backlinks[memo.id], [linked.id])
		const tree = store.tagTree()
		assert.equal(tree.find((node) => node.path === '验证')?.count, 2)

		const projection = store.projection()
		assert.match(projection, /\[实践\]/)
		assert.match(projection, /#验证/)
		assert.match(projection, /部署方式/)
		assert.match(projection, /第二条永久卡/)
		assert.equal(projection.includes(linked.id), false)

		const archived = await store.archive(linked.id)
		assert.equal(archived.status, 'archived')
		assert.equal(store.list({ type: 'fleeting' }).some((card) => card.id === linked.id), false)
		assert.equal(store.list({ type: 'fleeting', includeArchived: true }).some((card) => card.id === linked.id), true)

		const query = await store.query({ text: '部署' })
		assert.equal(query[0]?.id, memo.id)
		assert.equal(store.get(doc.id)?.summary, '索引说明')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('卡片上限拒绝超长正文，迁移留下的超限卡可保留', async () => {
	const { dir, store } = await fixture({ cardMaxChars: 10 })
	try {
		await assert.rejects(() => store.put({ type: 'fleeting', body: '这是一段超过十个字的卡片正文' }), /上限/)
		const legacy = await store.put({ type: 'fleeting', body: '这是一段超过十个字的卡片正文', overCap: true })
		assert.equal(legacy.overCap, true)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('迁移实践和记忆：长文进资源、链接映射、重复运行跳过', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-migrate-'))
	const store = new CardStore({ dataDir: dir, embedding: { id: 'none' } })
	try {
		await store.init()
		await mkdir(join(dir, 'practice', 'docs', '验证'), { recursive: true })
		await mkdir(join(dir, 'practice', 'tools', '验证'), { recursive: true })
		await writeFile(join(dir, 'practice', 'docs', '验证', 'a.md'), [
			'---',
			'title: 甲文档',
			'purpose: 用来测试迁移',
			'kind: doc',
			'topic: 验证',
			'verified: 2026-11-10',
			'links: [b]',
			'tags: [示例]',
			'---',
			'',
			'#### 甲正文',
			'这里是很长的正文内容。',
		].join('\n'))
		await writeFile(join(dir, 'practice', 'docs', '验证', 'b.md'), [
			'---',
			'title: 乙文档',
			'purpose: 链接目标',
			'kind: doc',
			'topic: 验证',
			'verified: 2026-11-10',
			'---',
			'',
			'乙正文',
		].join('\n'))
		await writeFile(join(dir, 'practice', 'tools', '验证', 'run.sh'), [
			'---',
			'title: 运行脚本',
			'purpose: 跑一下',
			'kind: tool',
			'topic: 验证',
			'verified: 2026-11-10',
			'---',
			'',
			'#!/bin/sh',
			'echo hi',
		].join('\n'))
		await mkdir(join(dir, 'sight', 'memory'), { recursive: true })
		await writeFile(join(dir, 'sight', 'memory', 'memories.jsonl'), `${JSON.stringify({
			id: 'mem-1',
			kind: 'fact',
			text: '旧记忆：部署走 SSH。',
			scope: 'global',
			tags: ['部署'],
			createdAt: '2026-11-01T00:00:00.000Z',
			updatedAt: '2026-11-01T00:00:00.000Z',
		})}\n`)

		const result = await migrateToCards({ dataDir: dir, store })
		assert.equal(result.practice, 3)
		assert.equal(result.memory, 1)

		const cards = store.all()
		const a = cards.find((card) => card.sourceId === 'practice:docs/验证/a.md')
		const b = cards.find((card) => card.sourceId === 'practice:docs/验证/b.md')
		const mem = cards.find((card) => card.sourceId === 'memory:mem-1')
		assert.ok(a && b && mem)
		assert.equal(a.shape, 'doc')
		assert.equal(a.label, '甲文档')
		assert.equal(a.summary, '用来测试迁移')
		assert.deepEqual(a.tags, ['验证', '示例'])
		assert.deepEqual(a.links, [b.id])
		const read = await store.read(a.id)
		assert.match(read.resourceContents[0].text, /很长的正文/)
		assert.equal(mem.type, 'fleeting')
		assert.equal(mem.category, 'fact')
		assert.match(mem.body, /旧记忆/)

		const marker = JSON.parse(await readFile(join(dir, 'knowledge', 'migration.json'), 'utf8'))
		assert.equal(marker.practice, 3)
		const second = await migrateToCards({ dataDir: dir, store })
		assert.equal(second.skipped, true)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})
