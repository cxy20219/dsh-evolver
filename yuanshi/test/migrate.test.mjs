import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { migrateEvolver, readEvolverLibrary } from '../src/migrate.js'
import { FileStore } from '../src/store.js'

/**
 * Build a tiny evolver 1.0 library on disk.
 *
 * @returns {Promise<{root: string, old: string, fresh: string}>} Paths.
 */
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'yuanshi-migrate-'))
	const old = join(root, 'old')
	const fresh = join(root, 'new')
	await mkdir(join(old, 'knowledge', 'cards'), { recursive: true })
	await mkdir(join(old, 'knowledge', 'resources', 'card-A'), { recursive: true })
	await mkdir(join(old, 'knowledge', 'resources', 'card-ORPHAN'), { recursive: true })
	await writeFile(join(old, 'knowledge', 'resources', 'card-A', 'doc.txt'), 'doc text\n')
	await writeFile(join(old, 'knowledge', 'resources', 'card-ORPHAN', 'extra.txt'), 'extra\n')
	const a = {
		id: 'card-A',
		body: '[说明](knowledge/resources/card-A/doc.txt)：用途：迁移附件说明',
		description: '来源卡片 A',
		tags: ['工作/测试'],
		links: ['card-B', 'card-MISSING'],
		updated: '2026-01-01T00:00:00.000Z',
	}
	const b = {
		id: 'card-B',
		body: 'B body',
		description: '',
		tags: ['工作/测试', '见闻/事实'],
		links: [],
		updated: '2026-01-02T00:00:00.000Z',
	}
	const c = {
		id: 'card-C',
		body: 'C body',
		description: '归档卡片',
		tags: ['工作/归档', '工作/测试'],
		links: [],
		updated: '2026-01-03T00:00:00.000Z',
	}
	const lines = [
		JSON.stringify({ ...a, description: '旧版本 A' }),
		JSON.stringify({ id: 'card-D', deleted: true }),
		JSON.stringify(a),
		JSON.stringify(b),
		JSON.stringify(c),
		'{ broken json',
	]
	await writeFile(join(old, 'knowledge', 'cards', 'cards.jsonl'), `${lines.join('\n')}\n`)
	return { root, old, fresh }
}

test('读取老库：最后一条覆盖、删除墓碑、归档标记、孤立附件', async () => {
	const { root, old } = await fixture()
	try {
		const library = await readEvolverLibrary(old)
		assert.equal(library.stats.lines, 6)
		assert.equal(library.stats.unique, 4)
		assert.equal(library.stats.deleted, 1)
		assert.equal(library.stats.active, 2)
		assert.equal(library.stats.archived, 1)
		assert.equal(library.stats.duplicates, 1)
		assert.equal(library.stats.invalidLines, 1)
		assert.equal(library.cards.find((card) => card.legacyId === 'card-A').description, '来源卡片 A')
		assert.deepEqual(library.cards.find((card) => card.legacyId === 'card-C').tags, ['工作/测试'])
		assert.equal(library.cards.find((card) => card.legacyId === 'card-C').archived, true)
		assert.deepEqual(library.orphans, ['card-ORPHAN/extra.txt'])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('预演不写盘；真实迁移保留 legacy id、附件、链接与归档', async () => {
	const { root, old, fresh } = await fixture()
	try {
		const dry = await migrateEvolver({ from: old, to: fresh, apply: false })
		assert.equal(dry.mode, 'dry-run')
		assert.equal(dry.cards.created, 3)
		assert.equal(dry.attachments.created, 1)
		assert.equal(dry.links.resolved, 1)
		assert.equal(dry.links.dropped, 1)
		assert.equal(dry.bodiesRewritten, 1)
		await assert.rejects(stat(join(fresh, 'files')), /ENOENT/)

		const result = await migrateEvolver({ from: old, to: fresh, apply: true })
		assert.equal(result.cards.created, 3)
		assert.equal(result.cards.skippedExisting, 0)
		assert.equal(result.attachments.created, 1)
		assert.equal(result.bodiesRewritten, 1)
		assert.ok(result.warnings.some((warning) => warning.includes('card-MISSING')))
		assert.ok(result.warnings.some((warning) => warning.includes('card-ORPHAN/extra.txt')))

		const store = new FileStore({ dataDir: fresh })
		await store.open()
		try {
			const active = await store.list({ limit: 100 })
			assert.equal(active.total, 3)
			const archived = await store.list({ limit: 100, archived: true })
			assert.equal(archived.total, 1)
			assert.equal(archived.files[0].legacyId, 'card-C')
			assert.equal(archived.files[0].archived, true)

			const a = active.files.find((file) => file.legacyId === 'card-A')
			assert.ok(a)
			const read = await store.read(a.id)
			assert.match(read.description, /来源卡片 A/)
			assert.match(read.text, /files\/file-[^/]+\/doc\.txt/)
			assert.equal(read.links.length, 2)
			assert.equal(read.degree.out, 2)
			assert.equal(read.neighbors.out.length, 2)

			const attachment = active.files.find((file) => file.legacyId === 'card-A/doc.txt')
			assert.ok(attachment)
			assert.match(attachment.description, /用途/)
			const attachmentRead = await store.read(attachment.id)
			assert.equal(attachmentRead.text, 'doc text\n')
			assert.deepEqual(attachmentRead.links, [a.id])

			const b = active.files.find((file) => file.legacyId === 'card-B')
			assert.match(b.description, /B body/)
			assert.equal((await store.read(b.id)).neighbors.in.length, 1)
			assert.equal(await store.read('card-D'), undefined)
		} finally {
			store.close()
		}

		const again = await migrateEvolver({ from: old, to: fresh, apply: true })
		assert.equal(again.cards.created, 0)
		assert.equal(again.cards.skippedExisting, 3)
		assert.equal(again.attachments.created, 0)
		assert.equal(again.attachments.skippedExisting, 1)
		assert.equal(again.cardsUpdated, 0)

		const reopened = new FileStore({ dataDir: fresh })
		await reopened.open()
		try {
			assert.equal((await reopened.list({ limit: 100 })).total, 3)
			assert.equal((await reopened.list({ limit: 100, archived: true })).total, 1)
		} finally {
			reopened.close()
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
