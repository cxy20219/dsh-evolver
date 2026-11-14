/**
 * Paging and filtering at library scale.
 *
 * The index used to answer a filtered list by fetching a fixed window and
 * filtering it in memory, so a library of thousands of files reported that
 * window as its total and never returned anything past it. These tests pin the
 * two properties that fix has to hold: the total is the real total, and every
 * offset inside it returns rows.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { IndexDatabase } from '../src/db.js'
import { withStore } from './helpers.mjs'

/**
 * One metadata row, as the index stores it.
 *
 * @param {number} index - The ordinal; also drives the filters.
 * @param {number} base - The epoch the timestamps start from.
 * @returns {object} The metadata.
 */
function row(index, base) {
	const stamp = new Date(base + index * 60_000).toISOString()
	return {
		schema: 1,
		id: `file-seed-${String(index).padStart(4, '0')}`,
		name: `file-${index}.${index % 3 === 0 ? 'png' : 'md'}`,
		description: `第 ${index} 个文件：分页用例`,
		tags: index % 2 === 0 ? ['工作/项目/自研'] : ['生活/记录'],
		links: [],
		created: stamp,
		updated: stamp,
		mime: index % 3 === 0 ? 'image/png' : 'text/markdown',
		bytes: 10,
		sha256: `sha-${index}`,
		archived: false,
	}
}

test('索引分页：600 行也有真实总数，offset 能翻到末尾', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ziyan-page-'))
	const db = new IndexDatabase({ path: join(dir, 'ziyan.db') })
	db.open()
	try {
		const base = Date.parse('2026-01-01T00:00:00.000Z')
		for (let index = 0; index < 600; index += 1) db.upsert(row(index, base))

		const first = db.page({ limit: 100 })
		assert.equal(first.total, 600)
		assert.equal(first.rows.length, 100)
		assert.equal(first.rows[0].id, 'file-seed-0599', '最新的一行在最前')

		// The old window stopped at 500: this offset returned nothing.
		const deep = db.page({ limit: 100, offset: 500 })
		assert.equal(deep.total, 600)
		assert.equal(deep.rows.length, 100)

		assert.equal(db.page({ limit: 100, offset: 600 }).rows.length, 0)
		assert.equal(db.page({ limit: 100, offset: 999 }).rows.length, 0)

		// A parent tag selects its descendants, and two tags are AND-ed.
		assert.equal(db.page({ limit: 10, tags: ['工作'] }).total, 300)
		assert.equal(db.page({ limit: 10, tags: ['工作/项目'] }).total, 300)
		assert.equal(db.page({ limit: 10, tags: ['工作', '生活'] }).total, 0)
		assert.equal(db.page({ limit: 10, tags: ['生活/记录'] }).rows.length, 10)

		// A trailing slash means "this MIME family".
		assert.equal(db.page({ limit: 10, mime: 'image/' }).total, 200)
		assert.equal(db.page({ limit: 10, mime: 'text/markdown' }).total, 400)
		assert.equal(db.page({ limit: 10, mime: 'image/', tags: ['生活'] }).total, 100)

		// LIKE wildcards inside a literal tag must not widen the match.
		db.upsert({ ...row(600, base), id: 'file-seed-wild', tags: ['工作_项目'] })
		assert.equal(db.page({ limit: 10, tags: ['工作_项目'] }).total, 1)
	} finally {
		db.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('store.list 分页：总数是真的，过滤在 SQL 里算', async () => {
	await withStore(async (store) => {
		for (let index = 0; index < 12; index += 1) {
			await store.create({
				name: `page-${String(index).padStart(2, '0')}.md`,
				description: `分页用例：第 ${index} 个文件`,
				tags: index % 2 === 0 ? ['测试/分页', '工作/自研'] : ['测试/分页', '生活/记录'],
				content: `# ${index}\n`,
				text: false,
			})
		}

		const first = await store.list({ limit: 5 })
		assert.equal(first.total, 12)
		assert.equal(first.files.length, 5)

		const tail = await store.list({ limit: 5, offset: 10 })
		assert.equal(tail.total, 12)
		assert.equal(tail.files.length, 2)

		assert.equal((await store.list({ tag: '测试', limit: 5 })).total, 12)
		assert.equal((await store.list({ tag: '工作', limit: 5 })).total, 6)
		assert.equal((await store.list({ tags: ['工作', '生活'], limit: 5 })).total, 0)
		assert.equal((await store.list({ mime: 'text/', limit: 5 })).total, 12)

		await store.archive(first.files[0].id, true)
		assert.equal((await store.list({ limit: 5 })).total, 11)
		assert.equal((await store.list({ archived: true, limit: 5 })).total, 1)
	})
})
