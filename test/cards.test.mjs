import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { cardCreatedAt, cardId, isCardId } from '../src/cards/ids.js'
import { normalizeCardTags, normalizeTag, normalizeTags, buildTagTree } from '../src/cards/tags.js'
import { safeResourceName } from '../src/cards/resources.js'
import { cardPrompt } from '../src/cards/prompt.js'
import { CardStore, labelOf } from '../src/cards/store.js'
import { hasResourceReference } from '../src/cards/store.js'
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
	assert.deepEqual(normalizeCardTags([]), ['即兴'])
	assert.deepEqual(normalizeCardTags(['#践行/工作流']), ['践行/工作流'])
	assert.throws(() => normalizeCardTags(['验证方法']), /顶层标签只能是/)
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

test('资源引用链接的 label 可派生，引用格式可校验', () => {
	assert.equal(labelOf('[run.sh](knowledge/resources/card-x/run.sh)：用途：跑测试'), 'run.sh')
	assert.equal(hasResourceReference('[run.sh](knowledge/resources/card-x/run.sh)：用途：跑测试', 'knowledge/resources/card-x/run.sh'), true)
	assert.equal(hasResourceReference('[run.sh](knowledge/resources/card-x/run.sh)', 'knowledge/resources/card-x/run.sh'), false)
})

test('资源文件名被压成一个安全段，路径无法逃出卡片目录', () => {
	assert.equal(safeResourceName('../../etc/passwd'), 'passwd')
	assert.equal(safeResourceName('run.sh'), 'run.sh')
	assert.equal(safeResourceName('a/b/c.md'), 'c.md')
	assert.equal(safeResourceName('..'), '')
	assert.equal(safeResourceName(''), '')
})

test('卡片写入：六大枝干、label、上限、整理、归档、双链和标签树', async () => {
	const { dir, store } = await fixture()
	try {
		const memo = await store.put({
			body: '# 部署方式\n\n本机部署走 SSH，不要用 HTTPS。',
			tags: ['践行/验证/浏览器', '见闻/项目/dsh-evolver'],
		})
		assert.equal(memo.label, '部署方式')
		assert.deepEqual(memo.tags, ['践行/验证/浏览器', '见闻/项目/dsh-evolver'])
		assert.equal(memo.type, undefined)
		assert.equal(memo.status, undefined)

		const edited = await store.put({ id: memo.id, body: '换了一行\n正文也变了' })
		assert.equal(edited.label, '换了一行')
		assert.ok(edited.tags.includes('践行/验证/浏览器'), '不带标签的更新保留原枝干')

		assert.deepEqual(Object.keys(store.cards.db.get(memo.id)).sort(), ['body', 'id', 'tags', 'updated'])
		const promoted = await store.promote(memo.id, { tags: ['践行/经验'] })
		assert.ok(promoted.tags.includes('践行/经验'))
		assert.deepEqual(Object.keys(store.cards.db.get(memo.id)).sort(), ['body', 'id', 'tags', 'updated', 'verified'])
		assert.equal(promoted.verified.length > 0, true)

		const practice = await store.put({
			body: '第二条践行卡',
			tags: ['践行/工作流', '践行/验证/索引'],
		})
		assert.ok(practice.tags.includes('践行/工作流'))
		const linked = await store.put({ body: '指向第一张卡', tags: ['即兴'], links: [memo.id] })
		assert.deepEqual(Object.keys(store.cards.db.get(linked.id)).sort(), ['body', 'id', 'links', 'tags', 'updated'])
		assert.equal(memo.created, cardCreatedAt(memo.id))

		const backlinks = store.backlinks()
		assert.deepEqual(backlinks[memo.id], [linked.id])
		const tree = store.tagTree()
		assert.equal(tree.find((node) => node.path === '践行')?.count, 2)
		assert.equal(tree.find((node) => node.path === '见闻')?.count, 1)
		assert.equal(tree.find((node) => node.path === '即兴')?.count, 1)

		const prompt = cardPrompt(store)
		assert.match(prompt, /\[卡片\]/)
		assert.match(prompt, /#践行/)
		assert.match(prompt, /#见闻/)
		assert.match(prompt, /#即兴/)
		assert.match(prompt, /#践行\/工作流/)
		assert.match(prompt, /可重复执行的工作流/)
		assert.equal(prompt.includes(memo.label), false, '注入不出现具体卡片')
		assert.equal(prompt.includes(memo.id), false)
		await assert.rejects(() => store.put({ body: '非法顶层', tags: ['验证方法'] }), /顶层标签只能是/)

		const archived = await store.archive(linked.id)
		assert.ok(archived.tags.includes('即兴/归档'))
		assert.equal(store.list().some((card) => card.id === linked.id), false)
		assert.equal(store.list({ includeArchived: true }).some((card) => card.id === linked.id), true)
		assert.equal(store.list({ archivedOnly: true }).some((card) => card.id === linked.id), true)
		assert.equal(store.list({ anyTags: ['践行', '见闻'] }).length, 2)

		const query = await store.query({ text: '换了一行' })
		assert.equal(query[0]?.id, memo.id)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('卡片上限拒绝超长正文', async () => {
	const { dir, store } = await fixture({ cardMaxChars: 10 })
	try {
		await assert.rejects(() => store.put({ body: '这是一段超过十个字的卡片正文' }), /上限/)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('卡片 agent：资源正文、标签查询、提升/归档/删除闭环', async () => {
	const { dir, store } = await fixture()
	try {
		const agent = createCardAgent(store)
		const doc = await agent.write({
			body: '[部署文档]({{resource}})：用途：说明部署步骤；入口：阅读附件；输入：无；输出：部署步骤；关联流程：#践行/工作流。',
			tags: ['践行/工作流'],
			resourceName: 'deploy.md',
			resourceContent: '## 步骤\n1. 先跑测试',
		})
		assert.match(doc.body, new RegExp(`knowledge/resources/${doc.id}/deploy\\.md`))
		assert.ok(doc.tags.includes('践行/工作流'))
		const read = await agent.read(doc.id)
		assert.match(read.resourceContents[0].text, /先跑测试/)
		assert.match(read.resourceContents[0].path, /knowledge\/resources\//)

		const script = await agent.write({
			body: '[run.sh]({{resource}})：用途：跑测试；入口：bash {{resource}}；输入：无；输出：测试结果；关联流程：#践行/工具。',
			tags: ['践行/工具'],
			resourceName: 'run.sh',
			resourceContent: '#!/bin/sh\necho ok\n',
		})
		const scriptRead = await agent.read(script.id)
		assert.equal(scriptRead.resourceContents[0].executable, true)
		await assert.rejects(
			() => agent.write({ body: '没有引用', resourceName: 'bad.sh', resourceContent: '#!/bin/sh\n' }),
			/正文必须引用附件/,
		)
		await assert.rejects(
			() => agent.write({ body: '没有附件内容', resourceName: 'bad.sh' }),
			/resourceContent/,
		)

		const memo = await agent.write({ body: '部署走 SSH。', tags: ['即兴'] })
		assert.ok(memo.tags.includes('即兴'))
		const found = await agent.query({ text: '部署', tags: ['即兴'] })
		assert.ok(found.some((card) => card.id === memo.id))
		const promoted = await agent.promote(memo.id, { tags: ['践行/经验'] })
		assert.ok(promoted.tags.includes('践行/经验'))
		assert.equal(promoted.tags.includes('即兴'), false)
		const archived = await agent.archive(doc.id)
		assert.ok(archived.tags.some((tag) => tag.endsWith('/归档')))
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
		assert.equal(cards.every((card) => ['践行', '见闻', '即兴', '复盘', '觉察', '试错'].includes(card.tags[0].split('/')[0])), true)
		assert.equal(store.status().roots.践行 + store.status().roots.复盘, 3)
		const effective = cards.find((card) => card.label === '确认插件改动是否生效')
		assert.ok(effective)
		assert.match(effective.body, /knowledge\/resources\/.*\/plugin-effective\.md/)
		const read = await store.read(effective.id)
		assert.match(read.resourceContents[0].text, /## 现象/)
		assert.equal(await seedStarterCards(store), 0)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})
