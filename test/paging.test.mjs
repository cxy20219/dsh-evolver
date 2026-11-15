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
 * @param {object} [overrides] - Fields to replace (tags, description, archived, name).
 * @returns {object} The metadata.
 */
function row(index, base, overrides = {}) {
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
		...overrides,
	}
}

/**
 * A description long enough to carry a strong BM25 length penalty.
 *
 * @returns {string} The filler.
 */
function filler() {
	return `缓存命中：${'与查询无关的填充内容。'.repeat(20)}`
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

test('全库图：不按页截断，只保留两端都在节点集里的边', async () => {
	await withStore(async (store) => {
		const base = Date.parse('2026-01-01T00:00:00.000Z')
		// The index is what the graph reads, so rows go straight in: 620 files
		// would take minutes through create(), and the graph does not care where
		// the payloads are.
		for (let index = 0; index < 620; index += 1) {
			store.db.upsert({ ...row(index, base), links: index === 0 ? [] : [`file-seed-${String(index - 1).padStart(4, '0')}`] })
		}

		const graph = store.libraryGraph()
		assert.equal(graph.nodes.length, 620, '一页装不下，图必须给全')
		assert.equal(graph.edges.length, 619)
		assert.equal(graph.nodes[0].degree.out + graph.nodes[0].degree.in >= 0, true)

		const capped = store.libraryGraph({ limit: 100 })
		assert.equal(capped.nodes.length, 100)
		const ids = new Set(capped.nodes.map((node) => node.id))
		assert.ok(capped.edges.length < 619, '上限外的边要丢掉，而不是留成悬空')
		assert.ok(capped.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)))
	})
})

test('图快照：边只从节点集里取，不在集合里的边根本不出 SQL', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ziyan-snapshot-'))
	const db = new IndexDatabase({ path: join(dir, 'ziyan.db') })
	db.open()
	try {
		const base = Date.parse('2026-01-01T00:00:00.000Z')
		db.upsert(row(0, base, { links: ['file-seed-0001', 'file-not-exist'] }))
		db.upsert(row(1, base, { links: ['file-seed-0002'] }))
		db.upsert(row(2, base))

		const all = db.snapshot({ limit: 3 })
		assert.equal(all.rows.length, 3)
		assert.deepEqual(all.edges, [
			{ from: 'file-seed-0000', to: 'file-seed-0001' },
			{ from: 'file-seed-0001', to: 'file-seed-0002' },
		], '悬空目标和集合外的边都不返回')

		const capped = db.snapshot({ limit: 2 })
		assert.equal(capped.rows.length, 2)
		assert.deepEqual(capped.edges, [{ from: 'file-seed-0001', to: 'file-seed-0002' }], '源不在节点集里的边被裁掉')
		assert.deepEqual(db.snapshot({ limit: 1 }).edges, [], '只有一个节点时没有两端都在集合里的边')
	} finally {
		db.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('搜索 + 标签：标签约束进 SQL，长文档不会被挤出候选窗口', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ziyan-search-tag-'))
	const db = new IndexDatabase({ path: join(dir, 'ziyan.db') })
	db.open()
	try {
		const base = Date.parse('2026-01-01T00:00:00.000Z')
		// 150 short untagged files outrank 150 long tagged files under BM25; the
		// old path took the bm25 top 200 first (all short files plus 50 long
		// ones) and only then filtered by tag, so a page of 200 candidates kept
		// 50 tagged hits. Pushing the tag filter into SQL must return all 150.
		for (let index = 0; index < 300; index += 1) {
			const tagged = index >= 150
			db.upsert(row(index, base, {
				description: tagged ? filler() : '缓存命中：短描述',
				tags: tagged ? ['工作/检索'] : ['生活/记录'],
			}))
		}
		assert.equal(db.search('缓存命中', { limit: 200 }).length, 200, '无标签时仍是 200 个候选')
		const taggedHits = db.search('缓存命中', { limit: 200, tags: ['工作'] })
		assert.equal(taggedHits.length, 150, '标签过滤要在 bm25 窗口之前生效')
		assert.equal(db.search('缓存命中', { limit: 200, tags: ['工作', '类型'] }).length, 0, '多个标签仍是 AND')
	} finally {
		db.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('搜索：多词先 AND，不够一页时回退 OR 补齐', async () => {
	await withStore(async (store) => {
		const base = Date.parse('2026-01-01T00:00:00.000Z')
		store.db.upsert(row(0, base, { description: 'reverse proxy rewrites the Host header', tags: ['测试/检索'] }))
		store.db.upsert(row(1, base, { description: 'proxy tuning notes', tags: ['测试/检索'] }))
		store.db.upsert(row(2, base, { description: 'unrelated benchmark', tags: ['测试/检索'] }))

		const all = await store.list({ query: 'reverse proxy rewrites host', limit: 50 })
		assert.equal(all.total, 2, 'AND 命中不足一页时回退 OR，但只多召回含词元的文件')
		const ids = all.files.map((file) => file.id)
		assert.ok(ids.includes('file-seed-0000'))
		assert.ok(ids.includes('file-seed-0001'))
		assert.ok(!ids.includes('file-seed-0002'))

		const exact = await store.list({ query: 'reverse proxy', limit: 50 })
		assert.equal(exact.files[0].id, 'file-seed-0000', '两个词都命中的文档排第一')
	})
})

test('后缀过滤：SQL 用同一套大小写不敏感规则，深翻页与标签一起用也对', async () => {
	await withStore(async (store) => {
		await store.create({ name: 'a.md', description: '后缀用例：Markdown', content: 'x', tags: ['测试/后缀'] })
		await store.create({ name: 'b.MD', description: '后缀用例：大写扩展名', content: 'x', tags: ['测试/后缀'] })
		await store.create({ name: 'README', description: '后缀用例：没有扩展名', content: 'x', tags: ['测试/后缀'] })
		await store.create({ name: 'c.tar.gz', description: '后缀用例：多段扩展名', content: 'x', tags: ['测试/后缀'] })
		assert.equal((await store.list({ suffix: 'md', limit: 10 })).total, 2)
		assert.equal((await store.list({ suffix: 'MD', limit: 10 })).total, 2, '大小写不敏感')
		assert.equal((await store.list({ suffix: '', limit: 10 })).total, 1, '空串只选没有扩展名的')
		assert.equal((await store.list({ suffix: 'gz', limit: 10 })).total, 1)

		// A tag page past the first page must keep its filters: the total is the
		// real total and the offset slices the same ordered set.
		const base = Date.parse('2026-01-01T00:00:00.000Z')
		await withStore(async (inner) => {
			for (let index = 0; index < 120; index += 1) {
				inner.db.upsert(row(index, base, { tags: ['测试/深翻页'], links: [] }))
			}
			const first = inner.db.page({ limit: 50, tags: ['测试/深翻页'] })
			const deep = inner.db.page({ limit: 50, offset: 100, tags: ['测试/深翻页'] })
			assert.equal(first.total, 120)
			assert.equal(deep.total, 120)
			assert.equal(deep.rows.length, 20)
			const all = inner.db.page({ limit: 500, tags: ['测试/深翻页'] }).rows.map((meta) => meta.id)
			assert.deepEqual(deep.rows.map((meta) => meta.id), all.slice(100), '深翻页与整页是同一个顺序')
		})
	})
})

test('聚合：标签计数与统计不把归档文件算进来，但仍然算作标签挂载', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ziyan-aggregates-'))
	const db = new IndexDatabase({ path: join(dir, 'ziyan.db') })
	db.open()
	try {
		const base = Date.parse('2026-01-01T00:00:00.000Z')
		db.upsert(row(0, base, { tags: ['测试/统计', '测试/统计/甲'] }))
		db.upsert(row(1, base, { tags: ['测试/统计'] }))
		db.upsert(row(2, base, { tags: ['测试/统计/乙'], archived: true }))
		const counts = Object.fromEntries(db.tagCounts(1000).map((entry) => [entry.tag, entry.count]))
		assert.equal(counts['测试/统计'], 2)
		assert.equal(counts['测试/统计/甲'], 1)
		assert.equal(counts['测试/统计/乙'], undefined, '归档文件不进标签树')
		const stats = db.stats()
		assert.equal(stats.files, 2)
		assert.equal(stats.archived, 1)
		assert.equal(stats.tags, 2, '活跃文件上的不同标签数')
		assert.equal(stats.tagAssignments, 4, '挂载数含归档行')

		// Archived tag filtering goes through the same index: the archived page
		// sees only the archived file, the live page only the live ones.
		assert.equal(db.page({ limit: 10, archived: true, tags: ['测试/统计'] }).total, 1)
		assert.equal(db.page({ limit: 10, tags: ['测试/统计'] }).total, 2)
	} finally {
		db.close()
		await rm(dir, { recursive: true, force: true })
	}
})
