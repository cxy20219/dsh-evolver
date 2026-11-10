import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { cardId, isCardId } from '../src/cards/ids.js'
import { normalizeTag, normalizeTags, buildTagTree } from '../src/cards/tags.js'
import { safeResourceName } from '../src/cards/resources.js'
import { CardStore, labelOf } from '../src/cards/store.js'
import { seedStarterCards } from '../src/cards/seed.js'
import { createCardAgent } from '../src/cards/agent.js'

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

test('卡片上限拒绝超长正文', async () => {
	const { dir, store } = await fixture({ cardMaxChars: 10 })
	try {
		await assert.rejects(() => store.put({ type: 'fleeting', body: '这是一段超过十个字的卡片正文' }), /上限/)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('卡片 agent：doc 正文进附件，查询/提升/归档/删除闭环', async () => {
	const { dir, store } = await fixture()
	try {
		const agent = createCardAgent(store)
		const doc = await agent.write({
			type: 'permanent',
			shape: 'doc',
			label: '部署文档',
			summary: '部署步骤',
			body: '## 步骤\n1. 先跑测试',
			tags: ['部署'],
		})
		assert.equal(doc.body, '部署步骤')
		const read = await agent.read(doc.id)
		assert.match(read.resourceContents[0].text, /先跑测试/)

		const memo = await agent.write({ body: '部署走 SSH。', tags: ['部署'] })
		assert.equal(memo.type, 'fleeting')
		const found = await agent.query({ text: '部署', type: 'fleeting' })
		assert.ok(found.some((card) => card.id === memo.id))
		const promoted = await agent.promote(memo.id, { summary: '部署方式' })
		assert.equal(promoted.type, 'permanent')
		const archived = await agent.archive(doc.id)
		assert.equal(archived.status, 'archived')
		const removed = await agent.remove(memo.id)
		assert.equal(removed.removed, true)
		assert.equal(store.get(memo.id), undefined)
		await assert.rejects(() => agent.write({ body: 'API key 是 sk-abcdefghijklmnopqrstuvwx' }), /密钥/)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('新数据目录直接种下三张种子卡', async () => {
	const { dir, store } = await fixture()
	try {
		const seeded = await seedStarterCards(store)
		assert.equal(seeded, 3)
		const cards = store.all()
		assert.equal(cards.length, 3)
		assert.equal(cards.every((card) => card.type === 'permanent' && card.status === 'verified'), true)
		const effective = cards.find((card) => card.label === '确认插件改动是否生效')
		assert.ok(effective)
		const read = await store.read(effective.id)
		assert.match(read.resourceContents[0].text, /## 现象/)
		assert.equal(await seedStarterCards(store), 0)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})
