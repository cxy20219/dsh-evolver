/**
 * Absorbing another evolver's export.
 *
 * Import restores a folder and can replace what is here; absorb is the
 * additive counterpart. What is pinned here is the merge policy: local cards
 * win, exact duplicates do not multiply, legacy tags are settled instead of
 * refused, links are re-pointed after every card exists, attachments follow
 * their card, and device state (preferences, ledgers) is not knowledge.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { absorbArchive } from '../src/absorb.js'
import { writeArchiveFile } from '../src/backup/archive.js'
import { cardId } from '../src/cards/ids.js'
import { CardStore } from '../src/cards/store.js'
import { createTar } from './support/tar-fixture.mjs'

/**
 * A card store on a temporary folder.
 *
 * @returns {Promise<{dir: string, store: CardStore}>} The fixture.
 */
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), 'evr-absorb-'))
	const store = new CardStore({ dataDir: dir })
	await store.init()
	return { dir, store }
}

/**
 * Build one exported archive from a source store.
 *
 * @param {(source: {dir: string, store: CardStore}) => Promise<void>} build - Fills the source.
 * @returns {Promise<{archive: string, sourceDir: string, outDir: string}>} The archive.
 */
async function exportOf(build) {
	const sourceDir = await mkdtemp(join(tmpdir(), 'evr-absorb-src-'))
	const store = new CardStore({ dataDir: sourceDir })
	await store.init()
	try {
		await build({ dir: sourceDir, store })
		await store.close()
		const outDir = await mkdtemp(join(tmpdir(), 'evr-absorb-out-'))
		const archive = join(outDir, 'export.tar.gz')
		await writeArchiveFile(sourceDir, archive)
		return { archive, sourceDir, outDir }
	} finally {
		await store.close().catch(() => {})
	}
}

test('吸收新增卡：正文/描述/标签/链接/附件/枝干说明一起过来', async () => {
	const sourceDir = await mkdtemp(join(tmpdir(), 'evr-absorb-src-'))
	const outDir = await mkdtemp(join(tmpdir(), 'evr-absorb-out-'))
	const { dir, store } = await fixture()
	try {
		const source = new CardStore({ dataDir: sourceDir })
		await source.init()
		const first = await source.put({
			body: '第一条要吸收的卡片正文',
			description: '来自另一台设备的第一条',
			tags: ['见闻/异地'],
		})
		const second = await source.put({
			body: '第二条卡片，引用第一条',
			description: '指向第一条的卡片',
			tags: ['见闻/事实'],
			links: [first.id],
		})
		await source.attach(first.id, 'note.md', Buffer.from('# 附件\n\n来自别的设备。'))
		await source.saveTagDescriptions({ '见闻/异地': '另一台设备上的事实枝干' })
		await source.close()

		const archive = join(outDir, 'export.tar.gz')
		await writeArchiveFile(sourceDir, archive)
		const summary = await absorbArchive(store, archive)
		assert.equal(summary.incoming, 2)
		assert.equal(summary.added, 2)
		assert.equal(summary.files, 1)
		assert.equal(summary.branches, 1)

		const absorbed = store.get(first.id)
		assert.equal(absorbed.description, '来自另一台设备的第一条')
		assert.deepEqual(absorbed.tags, ['见闻/异地'])
		assert.deepEqual(store.get(second.id).links, [first.id], '链接在第二遍写回')
		const files = await store.attachments(first.id)
		assert.deepEqual(files.map((file) => file.name), ['note.md'])
		const descriptions = await store.tagDescriptions()
		assert.equal(descriptions['见闻/异地'], '另一台设备上的事实枝干')
		// The injected snapshot is rebased so the prompt sees the merge.
		assert.match(await readFile(join(dir, 'knowledge', 'index.json'), 'utf8'), new RegExp(first.id))
		const audit = await readFile(join(dir, 'knowledge', 'absorb.jsonl'), 'utf8')
		assert.equal(audit.trim().split('\n').length, 1)
		assert.equal(JSON.parse(audit.trim()).added, 2)
	} finally {
		await store.close()
		await rm(sourceDir, { recursive: true, force: true })
		await rm(outDir, { recursive: true, force: true })
		await rm(dir, { recursive: true, force: true })
	}
})

test('同 id 已存在：保留本地，不覆盖也不重复', async () => {
	const id = cardId()
	const { archive, sourceDir, outDir } = await exportOf(async ({ store }) => {
		await store.put({ id, body: '源设备上的版本', description: '源版本', tags: ['践行/工具'] })
	})
	const { dir, store } = await fixture()
	try {
		await store.put({ id, body: '本地已经改过的版本', description: '本地版本', tags: ['践行/工具'] })
		const summary = await absorbArchive(store, archive)
		assert.equal(summary.existing, 1)
		assert.equal(summary.added, 0)
		assert.equal(store.get(id).body, '本地已经改过的版本')
		assert.equal(store.all().length, 1)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
		await rm(sourceDir, { recursive: true, force: true })
		await rm(outDir, { recursive: true, force: true })
	}
})

test('正文完全相同的卡不重复吸收（不同 id 也只留一份）', async () => {
	const { archive, sourceDir, outDir } = await exportOf(async ({ store }) => {
		await store.put({ body: '同一条知识在另一台设备上也写了一遍', description: '异地版本', tags: ['见闻/事实'] })
	})
	const { dir, store } = await fixture()
	try {
		await store.put({ body: '同一条知识在另一台设备上也写了一遍', description: '本地版本', tags: ['见闻/事实'] })
		const summary = await absorbArchive(store, archive)
		assert.equal(summary.duplicate, 1)
		assert.equal(summary.added, 0)
		assert.equal(store.all().length, 1)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
		await rm(sourceDir, { recursive: true, force: true })
		await rm(outDir, { recursive: true, force: true })
	}
})

test('旧卡没有描述、顶层标签已经废弃：补描述并把标签落定到六大枝干', async () => {
	const oldId = cardId()
	const { archive, sourceDir, outDir } = await exportOf(async ({ store }) => {
		// A record as an older export can carry it: no description, an old root.
		await store.cards.putMemory({
			id: oldId,
			body: '旧版本导出的卡片，没有 description 字段',
			tags: ['实践/经验'],
			updated: new Date().toISOString(),
		})
	})
	const { dir, store } = await fixture()
	try {
		const summary = await absorbArchive(store, archive)
		assert.equal(summary.added, 1)
		const card = store.get(oldId)
		assert.ok(card.description.length > 0, '缺少描述时从正文生成')
		assert.deepEqual(card.tags, ['即兴/经验'], '非法顶层确定性降级到 #即兴')
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
		await rm(sourceDir, { recursive: true, force: true })
		await rm(outDir, { recursive: true, force: true })
	}
})

test('超长正文与密钥正文被跳过，且有原因', async () => {
	const long = cardId()
	const secret = cardId()
	const { archive, sourceDir, outDir } = await exportOf(async ({ store }) => {
		await store.cards.putMemory({ id: long, body: '长'.repeat(1200), tags: ['践行/工具'], updated: new Date().toISOString() })
		await store.cards.putMemory({
			id: secret,
			body: '这条里有一个 sk-abcdefghijklmnopqrstuvwx 密钥',
			tags: ['践行/工具'],
			updated: new Date().toISOString(),
		})
	})
	const { dir, store } = await fixture()
	try {
		const summary = await absorbArchive(store, archive)
		assert.equal(summary.added, 0)
		assert.equal(summary.skipped, 2)
		assert.equal(summary.problems.length, 2)
		assert.equal(store.get(long), undefined)
		assert.equal(store.get(secret), undefined)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
		await rm(sourceDir, { recursive: true, force: true })
		await rm(outDir, { recursive: true, force: true })
	}
})

test('没有卡片的归档与坏包都明确报错', async () => {
	const { dir, store } = await fixture()
	const outDir = await mkdtemp(join(tmpdir(), 'evr-absorb-bad-'))
	try {
		const empty = join(outDir, 'empty.tar')
		await writeFile(empty, createTar([{ path: 'preferences/AGENTS.md', content: '# 偏好\n' }]))
		await assert.rejects(() => absorbArchive(store, empty), /没有卡片/)

		const broken = join(outDir, 'broken.tar.gz')
		await writeFile(broken, 'not an archive')
		await assert.rejects(() => absorbArchive(store, broken))
		assert.equal(store.all().length, 0)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
		await rm(outDir, { recursive: true, force: true })
	}
})

test('本地已删除的卡片不会被另一台设备的旧归档复活', async () => {
	const id = cardId()
	const { archive, sourceDir, outDir } = await exportOf(async ({ store }) => {
		await store.put({ id, body: '这台设备上还留着的卡片', description: '旧归档里的卡', tags: ['践行/工具'] })
	})
	const { dir, store } = await fixture()
	try {
		await store.put({ id, body: '这台设备上还留着的卡片', description: '旧归档里的卡', tags: ['践行/工具'] })
		await store.remove(id)
		const summary = await absorbArchive(store, archive)
		assert.equal(summary.existing, 1)
		assert.equal(summary.added, 0)
		assert.equal(store.get(id), undefined, '删除是本地决定，旧归档不能撤销它')
		assert.ok(summary.problems.some((item) => /已删除/.test(item.reason)))
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
		await rm(sourceDir, { recursive: true, force: true })
		await rm(outDir, { recursive: true, force: true })
	}
})

test('带归档叶的卡（八个标签 + 归档）完整吸收，不丢标签', async () => {
	const archived = cardId()
	const tags = ['践行/工具', '见闻/事实', '复盘/经验', '觉察/事实', '试错/事实', '即兴/事实', '践行/工作流', '见闻/网络', '践行/归档']
	const { archive, sourceDir, outDir } = await exportOf(async ({ store }) => {
		await store.cards.putMemory({
			id: archived,
			body: '一张已经归档的旧卡',
			description: '归档卡也要完整过来',
			tags,
			updated: new Date().toISOString(),
		})
	})
	const { dir, store } = await fixture()
	try {
		const summary = await absorbArchive(store, archive)
		assert.equal(summary.added, 1)
		const card = store.get(archived)
		assert.deepEqual(card.tags, tags)
		assert.equal(card.tags.some((tag) => tag.endsWith('/归档')), true)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
		await rm(sourceDir, { recursive: true, force: true })
		await rm(outDir, { recursive: true, force: true })
	}
})
