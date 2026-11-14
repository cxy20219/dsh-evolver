/**
 * Seed a large synthetic library.
 *
 * The panel, the search paths and the graph all behave differently at scale
 * than they do with ten files, so tests need a library big enough to page and
 * to crowd the tag tree.
 *
 * Everything written here carries the `测试/批量` tag, so `--reset` removes
 * exactly the synthetic files and nothing else. Deterministic by default:
 * the same `--seed` produces the same names, tags, links and dates, which is
 * what makes a "before/after" measurement comparable.
 *
 *   node scripts/seed-demo.mjs                          # 2200 files into ~/.dsh/ziyan
 *   node scripts/seed-demo.mjs --count 200 --data-dir /tmp/ziyan-seed
 *   node scripts/seed-demo.mjs --reset                   # drop the previous batch
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { FileStore } from '../src/store.js'

/** The tag every synthetic file carries, and the marker `--reset` looks for. */
const MARK = '测试/批量'

/** File types by frequency: documents dominate, binaries stay rare. */
const EXTENSIONS = [
	['md', 34], ['txt', 11], ['js', 13], ['py', 10], ['sh', 5],
	['json', 6], ['csv', 5], ['png', 4], ['jpg', 3], ['pdf', 3],
	['zip', 3], ['docx', 3],
]

/** A human-facing type tag per extension. */
const TYPE_TAGS = {
	md: '类型/文档', txt: '类型/笔记', js: '类型/脚本', py: '类型/脚本', sh: '类型/脚本',
	json: '类型/数据', csv: '类型/表格', png: '类型/图片', jpg: '类型/图片',
	pdf: '类型/文档', zip: '类型/归档', docx: '类型/文档',
}

/** Domain tags: two roots most of the time, so the tag tree has depth. */
const DOMAIN_TAGS = [
	'工作/项目/自衍中枢', '工作/项目/检索', '工作/项目/界面', '工作/流程/发布', '工作/流程/复盘',
	'学习/语言/中文', '学习/语言/英文', '学习/方法',
	'运维/部署/本机', '运维/备份', '运维/日志',
	'生活/记录', '生活/计划',
	'来源/会话', '来源/文档',
]

/** Topics that become both a file-name slug and a description phrase. */
const TOPICS = [
	['报表导出', 'report-export'], ['缓存命中', 'cache-hit'], ['插件装配', 'plugin-mount'],
	['索引重建', 'index-rebuild'], ['检索排序', 'search-rank'], ['迁移脚本', 'migrate-script'],
	['图谱布局', 'graph-layout'], ['注入预算', 'injection-budget'], ['标签治理', 'tag-governance'],
	['会话沉淀', 'session-settle'], ['定时任务', 'scheduled-job'], ['备份导出', 'backup-export'],
	['目录指针', 'data-pointer'], ['权限位', 'file-mode'], ['压缩包', 'archive-bundle'],
	['数据校验', 'data-check'], ['错误处理', 'error-path'], ['性能基准', 'benchmark'],
	['接口契约', 'api-contract'], ['面板交互', 'panel-interaction'],
]

/** Verbs and objects composed into one-line descriptions. */
const VERBS = ['记录', '对比', '验证', '整理', '复现', '统计', '排查', '汇总']
const OBJECTS = [
	'两版实现的差异', '最近一周的失败', '接口字段的实际取值', '三个来源的口径',
	'Q3 的明细数据', '缓存命中率的变化', '标签的使用分布', '一次真实的迁移过程',
	'构建与重启的耗时', '用户反馈里的高频问题',
]

/**
 * Parse the command line.
 *
 * @param {string[]} argv - The arguments after the script name.
 * @returns {object} The options.
 */
function parseArgs(argv) {
	const options = {
		count: 2200,
		dataDir: join(homedir(), '.dsh', 'ziyan'),
		days: 210,
		seed: 20261114,
		reset: false,
		quiet: false,
	}
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--count') options.count = Number(argv[index += 1])
		else if (arg === '--data-dir') options.dataDir = argv[index += 1]
		else if (arg === '--days') options.days = Number(argv[index += 1])
		else if (arg === '--seed') options.seed = Number(argv[index += 1])
		else if (arg === '--reset') options.reset = true
		else if (arg === '--quiet') options.quiet = true
		else if (arg === '--help' || arg === '-h') {
			console.log('用法：node scripts/seed-demo.mjs [--count N] [--data-dir DIR] [--days N] [--seed N] [--reset] [--quiet]')
			process.exit(0)
		} else throw new Error(`未知参数：${arg}`)
	}
	if (!Number.isFinite(options.count) || options.count < 1) throw new Error('--count 必须是正整数。')
	return options
}

/**
 * A small deterministic PRNG (mulberry32).
 *
 * @param {number} seed - The seed.
 * @returns {() => number} Uniform numbers in [0, 1).
 */
function random(seed) {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let value = Math.imul(state ^ (state >>> 15), 1 | state)
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296
	}
}

/**
 * Pick one entry from a weighted list.
 *
 * @param {() => number} next - The PRNG.
 * @param {Array<[unknown, number]>} table - Values with integer weights.
 * @returns {unknown} The picked value.
 */
function weighted(next, table) {
	const total = table.reduce((sum, [, weight]) => sum + weight, 0)
	let cursor = next() * total
	for (const [value, weight] of table) {
		cursor -= weight
		if (cursor <= 0) return value
	}
	return table[table.length - 1][0]
}

/**
 * Pick one member of a plain list.
 *
 * @param {() => number} next - The PRNG.
 * @param {unknown[]} list - The list.
 * @returns {unknown} The picked member.
 */
const pick = (next, list) => list[Math.floor(next() * list.length)]

/**
 * An integer in `[min, max]`.
 *
 * @param {() => number} next - The PRNG.
 * @param {number} min - Inclusive lower bound.
 * @param {number} max - Inclusive upper bound.
 * @returns {number} The integer.
 */
const between = (next, min, max) => min + Math.floor(next() * (max - min + 1))

/** Binary headers, so the sniffed type matches the extension. */
const HEADERS = {
	png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
	pdf: Buffer.from('%PDF-1.7\n', 'utf8'),
	zip: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
	docx: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
}

/**
 * One payload of the requested size.
 *
 * @param {string} ext - The extension.
 * @param {number} bytes - The target size.
 * @param {string} topic - The topic phrase, so bodies are not identical.
 * @param {() => number} next - The PRNG.
 * @returns {Buffer} The bytes.
 */
function payloadOf(ext, bytes, topic, next) {
	const header = HEADERS[ext]
	if (header !== undefined) {
		const body = Buffer.alloc(Math.max(0, bytes - header.length))
		// Tile one PRNG-made block instead of drawing every byte: a 1 MB payload
		// would otherwise cost a million calls, and its bytes are not interesting.
		const block = Buffer.allocUnsafe(1024)
		for (let index = 0; index < block.length; index += 1) block[index] = Math.floor(next() * 256)
		for (let offset = 0; offset < body.length; offset += block.length) {
			block.copy(body, offset, 0, Math.min(block.length, body.length - offset))
		}
		return Buffer.concat([header, body])
	}
	const line = `- ${topic}：第 {n} 行，用来撑出真实体积。\n`
	const lines = []
	let size = 0
	let index = 1
	while (size < bytes) {
		const text = line.replace('{n}', String(index))
		lines.push(text)
		size += Buffer.byteLength(text, 'utf8')
		index += 1
	}
	return Buffer.from(`# ${topic}\n\n${lines.join('')}`, 'utf8')
}

/**
 * Plan one file: name, description, tags, size class, backdated creation.
 *
 * @param {() => number} next - The PRNG.
 * @param {number} index - The ordinal, used to make names unique.
 * @param {object} options - The CLI options.
 * @returns {object} The plan.
 */
function plan(next, index, options) {
	const [phrase, slug] = pick(next, TOPICS)
	const ext = weighted(next, EXTENSIONS)
	const roll = next()
	let bytes
	if (roll < 0.008) bytes = between(next, 1_000_000, 1_400_000)
	else if (roll < 0.03) bytes = between(next, 150_000, 320_000)
	else if (roll < 0.16) bytes = between(next, 20_000, 120_000)
	else bytes = between(next, 300, 8_000)

	// Recent days carry more records (x^1.6 biases towards 0), so the activity
	// heatmap has contrast instead of a flat band.
	const createdDays = Math.floor(Math.pow(next(), 1.6) * options.days)
	const description = `${phrase}：${pick(next, VERBS)}${pick(next, OBJECTS)}。`
	const tags = [MARK, TYPE_TAGS[ext], pick(next, DOMAIN_TAGS)]
	// A few single-use tags, so tag governance has noise to work on.
	if (next() < 0.04) tags.push(`${MARK}/单例/${index}`)
	if (next() < 0.25) tags.push(pick(next, DOMAIN_TAGS))

	return {
		name: `${slug}-${String(index).padStart(4, '0')}.${ext}`,
		description,
		tags: [...new Set(tags)],
		content: payloadOf(ext, bytes, phrase, next),
		created: new Date(Date.now() - createdDays * 86_400_000).toISOString(),
		archived: next() < 0.04,
	}
}

/**
 * Remove every file carrying the marker tag.
 *
 * @param {FileStore} store - The store.
 * @param {boolean} quiet - Suppress progress output.
 * @returns {Promise<number>} How many were removed.
 */
async function clearSeed(store, quiet) {
	let removed = 0
	for (;;) {
		const page = await store.list({ limit: 500 })
		const batch = page.files.filter((file) => (file.tags ?? []).includes(MARK))
		if (page.files.length === 0) break
		if (batch.length === 0) {
			// Nothing marked in this page: stop rather than loop over user data.
			break
		}
		for (const file of batch) {
			await store.remove(file.id)
			removed += 1
		}
		if (!quiet) process.stdout.write(`\r清理已有合成文件：${removed}`)
	}
	if (!quiet && removed > 0) process.stdout.write('\n')
	return removed
}

const options = parseArgs(process.argv.slice(2))
const next = random(options.seed)
const store = new FileStore({ dataDir: options.dataDir })
await store.open()

if (options.reset) {
	const removed = await clearSeed(store, options.quiet)
	if (!options.quiet) console.log(`已移除 ${removed} 个合成文件。`)
}

const began = performance.now()
const created = []
for (let index = 0; index < options.count; index += 1) {
	const planOfFile = plan(next, index, options)
	const file = await store.create({ ...planOfFile, text: false })
	created.push(file)
	if (!options.quiet && (index + 1) % 500 === 0) {
		process.stdout.write(`\r写入：${index + 1}/${options.count}`)
	}
}
if (!options.quiet) process.stdout.write('\n')

// Links are planned as indices and resolved in a second pass: a forward
// reference to a file that does not exist yet would be dropped on write.
const edges = []
const hubs = new Set(Array.from({ length: 8 }, () => between(next, 0, created.length - 1)))
for (let index = 0; index < created.length; index += 1) {
	const roll = next()
	if (roll < 0.12) continue // orphans: no outgoing links
	edges.push([index, (index + 1) % created.length])
	if (roll > 0.55) edges.push([index, between(next, 0, created.length - 1)])
	if (hubs.has(index)) {
		for (let fan = 0; fan < 12; fan += 1) edges.push([index, between(next, 0, created.length - 1)])
	}
}

// Dangling links: point at files that are removed afterwards, so the query
// layer has missing targets to render.
const temporary = []
for (let index = 0; index < 12; index += 1) {
	const file = await store.create({
		name: `临时-${index}.md`,
		description: `临时占位：用于制造悬空链接，随后会被删除。`,
		tags: [MARK, '类型/文档'],
		content: '# 临时\n',
		text: false,
	})
	temporary.push(file.id)
}
for (let index = 0; index < 12; index += 1) edges.push([index * 37 % created.length, -1 - index])

const bySource = new Map()
for (const [from, to] of edges) {
	if (!bySource.has(from)) bySource.set(from, new Set())
	const target = to < 0 ? temporary[-1 - to] : created[to].id
	if (target !== created[from].id) bySource.get(from).add(target)
}
for (const [from, targets] of bySource) {
	await store.update(created[from].id, { links: [...targets] })
}
for (const id of temporary) await store.remove(id)

const stats = store.stats()
const elapsed = Math.round(performance.now() - began)

console.log(`数据目录：${store.dataDir}`)
console.log(`用时：${elapsed} ms（${(elapsed / options.count).toFixed(2)} ms/文件）`)
console.log(`文件：${stats.files}（归档 ${stats.archived}）  链接：${stats.links}  标签：${stats.tags} 种 / ${stats.tagAssignments} 次`)
console.log(`类型：${stats.mimes.map((entry) => `${entry.mime.replace('text/', '.')}×${entry.count}`).join('  ')}`)

for (const query of ['缓存', '迁移', '报表导出', '图纸']) {
	const page = await store.list({ query, limit: 5 })
	console.log(`搜索「${query}」：${page.total} 条，前 ${page.files.length} 条：${page.files.map((file) => file.name).join(', ') || '—'}`)
}
store.close()
