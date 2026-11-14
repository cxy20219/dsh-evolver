/**
 * A small benchmark for the file store.
 *
 * Run with a count: `node scripts/bench.mjs 1000`. The point is not a
 * micro-benchmark of SQLite; it is to catch the shape of a change — a per-read
 * O(N) scan, a search that reads every payload, or a rebuild that grows
 * quadratically — before the library does.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileStore } from '../src/store.js'

const count = Math.max(10, Math.round(Number(process.argv[2]) || 1000))
const dir = await mkdtemp(join(tmpdir(), 'yuanshi-bench-'))
const store = new FileStore({ dataDir: dir })
await store.open()

const now = () => performance.now()
const ms = (value) => `${value.toFixed(1)} ms`

const texts = [
	['design.md', 'text/markdown', '自衍中枢设计：文件是唯一实体，边车是事实，索引可重建。'],
	['notes.md', 'text/markdown', '插件接口约定：写入先落边车，再更新索引；读大文件用 path。'],
	['proxy.md', 'text/markdown', '反向代理：改写 Host 与 Origin，WebSocket 自己接管 upgrade。'],
	['audit.md', 'text/markdown', '审计台账：守卫测试与性能实测，删除先写 trash。'],
	['search.md', 'text/markdown', '检索：中文 bigram，FTS5 bm25，片段从原文读。'],
]
const ids = []
const start = now()
for (let index = 0; index < count; index += 1) {
	const [name, , body] = texts[index % texts.length]
	const binary = index % 10 === 9
	const file = await store.create({
		name: binary ? `shot-${index}.png` : `${index}-${name}`,
		description: binary ? `第 ${index} 张面板截图，展示文件列表` : `第 ${index} 份笔记：${body.slice(0, 18)}`,
		content: binary ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, index & 0xff]) : `${body}\n\n编号 ${index}。第 ${index} 份文件。`,
		tags: index % 3 === 0 ? ['工作流', '演化器'] : ['基准'],
		links: index > 0 && index % 10 === 0 ? [ids[index - 1]] : [],
	})
	ids.push(file.id)
}
const createMs = now() - start

const queries = ['文件', '接口', '代理', '截图', '审计', '笔记']
const searchStart = now()
let hits = 0
for (let round = 0; round < 20; round += 1) {
	const result = await store.list({ query: queries[round % queries.length], limit: 10 })
	hits += result.total
}
const searchMs = (now() - searchStart) / 20

const listStart = now()
await store.list({ limit: 50 })
const listMs = now() - listStart

const rebuildStart = now()
const report = await store.rebuild()
const rebuildMs = now() - rebuildStart

const stats = store.stats()
console.log(JSON.stringify({
	files: count,
	create: ms(createMs),
	createPerFile: ms(createMs / count),
	searchAvg: ms(searchMs),
	searchHits: hits,
	list: ms(listMs),
	rebuild: ms(rebuildMs),
	rebuildFiles: report.files,
	problems: report.problems.length,
	stats,
}, null, 2))

store.close()
await rm(dir, { recursive: true, force: true })
