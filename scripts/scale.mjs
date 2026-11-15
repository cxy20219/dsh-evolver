#!/usr/bin/env node
/**
 * The scale lab: build a synthetic library at 10k / 100k / 1M and measure the
 * read paths that decide whether the store still feels instant.
 *
 * The library's shape is the one the store actually writes: one folder per
 * file under `files/`, a `meta.json` sidecar (the source of truth) and the
 * payload next to it, plus the SQLite index at `system/ziyan.db`. Nothing here
 * goes through `create()` — a hundred thousand atomic writes would take
 * minutes of fsync-shaped overhead, and the generator's job is to produce the
 * *state* the read paths see, not to re-test the write path. It writes the
 * sidecars directly (through `meta.js`, so they are the same JSON the store
 * writes) and then builds the index from the same planned rows, which also
 * makes `--reset` reproducible.
 *
 * Tiers:
 *
 *   10k / 100k   real filesystem library: sidecars + payloads + index
 *   1m           index-only synthesis by default: the same rows are inserted
 *                straight into SQLite, without a million folders. A million
 *                NTFS directories is minutes of metadata writes and ~3M files;
 *                the read-path queries do not care where the bytes live, so
 *                the DB is the honest way to test the query planner at 1M.
 *                It measures every read path but *not* `scan()` / `rebuild()`
 *                / cold open — those are filesystem walks and are reported
 *                from the 10k/100k measurements instead. Use `--mode fs
 *                --force-fs` to actually build the million folders.
 *
 * Usage:
 *
 *   node scripts/scale.mjs --tier 10k --reset          # build + benchmark
 *   node scripts/scale.mjs --tier 100k                 # reuse previous build
 *   node scripts/scale.mjs --tier 1m --reset           # DB-level 1M baseline
 *   node scripts/scale.mjs --tier 10k --json           # machine-readable
 *   node scripts/scale.mjs --tier 10k --purge          # delete the tier data
 *
 * Data lives in `.scratch/scale-data/<tier>/` only; the script refuses a data
 * root outside `.scratch/scale-data` and never opens the real library.
 *
 * Measurements are single-process, warm-JIT (one warmup run is discarded) and
 * report p50/p95 plus ops/s. RSS is sampled after every measured operation, so
 * `peakRss` includes the largest transient the query allocated. The script
 * does not force-collect between samples: a GC pause is part of what a real
 * caller pays.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { INDEX_SCHEMA, IndexDatabase } from '../src/db.js'
import { ShortIdIndex, fileId } from '../src/ids.js'
import { META_FILE, buildMeta, serializeMeta } from '../src/meta.js'
import { mimeOf } from '../src/names.js'
import { createZiyanHandler } from '../src/remote.js'
import { FileStore } from '../src/store.js'

/** The repo root (this file lives in `<root>/scripts`). */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The only place generated data may live. */
const DEFAULT_DATA_ROOT = join(ROOT, '.scratch', 'scale-data')

/** The synthetic library format; bump when the plan or layout changes. */
const FORMAT = 3

/** The default PRNG seed; `--seed` changes the library, not the code paths. */
const DEFAULT_SEED = 20261114

/** How many days of writing history a generated library covers. */
const DEFAULT_DAYS = 210

/** Tier name -> file count. */
const TIERS = { '10k': 10_000, '100k': 100_000, '1m': 1_000_000 }

/** The marker tag every generated file carries, for `--purge`/inspection. */
const MARK = '测试/规模'

/** A syntactically valid id that no generated file has, for dangling links. */
const DANGLING_ID = `file-${'0'.repeat(26)}`

/** File types by weight: documents dominate, binaries stay rare. */
const EXTENSIONS = [
	['md', 34], ['txt', 11], ['js', 13], ['py', 10], ['sh', 5],
	['json', 6], ['csv', 5], ['png', 4], ['jpg', 3], ['pdf', 3],
	['zip', 3], ['docx', 3],
]

/** A type tag per extension. */
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

/** Topics that become a file-name slug, a description phrase and a query. */
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

/** Binary payload headers, so the sniffed type matches the extension. */
const HEADERS = {
	png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
	pdf: Buffer.from('%PDF-1.7\n', 'utf8'),
	zip: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
	docx: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
}

/** Keywords guaranteed to appear in generated descriptions (one per topic). */
const QUERIES = ['缓存命中', '迁移脚本', '性能基准', '报表导出', '接口契约']

// ---------------------------------------------------------------------------
// command line
// ---------------------------------------------------------------------------

/**
 * Parse the command line.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {object} The options.
 */
function parseArgs(argv) {
	const options = {
		tier: '10k',
		mode: 'auto',
		reset: false,
		purge: false,
		reuse: false,
		json: false,
		lite: false,
		forceFs: false,
		seed: DEFAULT_SEED,
		days: DEFAULT_DAYS,
		dataRoot: DEFAULT_DATA_ROOT,
		concurrency: 96,
		reps: 1,
		files: 0,
	}
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		const take = () => argv[index += 1]
		if (arg === '--tier') options.tier = String(take())
		else if (arg === '--mode') options.mode = String(take())
		else if (arg === '--seed') options.seed = Number(take())
		else if (arg === '--days') options.days = Number(take())
		else if (arg === '--data-root') options.dataRoot = String(take())
		else if (arg === '--concurrency') options.concurrency = Number(take())
		else if (arg === '--reps') options.reps = Number(take())
		else if (arg === '--files') options.files = Number(take())
		else if (arg === '--reset') options.reset = true
		else if (arg === '--purge') options.purge = true
		else if (arg === '--reuse') options.reuse = true
		else if (arg === '--json') options.json = true
		else if (arg === '--lite') options.lite = true
		else if (arg === '--force-fs') options.forceFs = true
		else if (arg === '--help' || arg === '-h') {
			console.log([
				'用法：node scripts/scale.mjs [options]',
				'',
				'  --tier 10k|100k|1m   数据档位（默认 10k）',
				'  --reset              删除已有数据并重新生成',
				'  --reuse              只复用已有生成数据；数据缺失或版本不匹配时报错，不重新生成',
				'  --purge              只删除本档数据，不生成不测试',
				'  --mode fs|db|auto    生成方式（默认：1m 用 db，其余 fs）',
				'  --force-fs           允许 1m 也生成真实文件系统库（很慢）',
				'  --json               只输出 JSON（进度走 stderr）',
				'  --lite               跳过内存最重的几项（1m 内存不够时用）',
				'  --reps N             所有基准的重复次数乘以 N（默认 1）',
				'  --data-root DIR      数据根目录（必须以 scale-data 结尾）',
				'  --seed N             生成器随机种子（默认 20261114）',
				'  --days N             写作历史跨度（默认 210 天）',
				'  --concurrency N      生成时并发写入数（默认 96）',
				'  --files N            调试用：覆盖档位文件数（默认取档位）',
				'',
				'示例：node scripts/scale.mjs --tier 10k --reset',
			].join('\n'))
			process.exit(0)
		} else {
			throw new Error(`未知参数：${arg}（--help 看用法）`)
		}
	}
	if (!(options.tier in TIERS)) throw new Error(`未知档位：${options.tier}（可选：${Object.keys(TIERS).join(' / ')}）`)
	if (!['auto', 'fs', 'db'].includes(options.mode)) throw new Error('--mode 只能是 auto / fs / db。')
	if (!Number.isFinite(options.seed)) throw new Error('--seed 必须是数字。')
	if (!Number.isFinite(options.days) || options.days < 1) throw new Error('--days 必须是正整数。')
	if (!Number.isFinite(options.reps) || options.reps <= 0) throw new Error('--reps 必须是正数。')
	options.total = TIERS[options.tier]
	if (options.files !== 0) {
		if (!Number.isFinite(options.files) || options.files < 10) throw new Error('--files 必须是 ≥10 的整数。')
		options.total = Math.round(options.files)
	}
	if (options.mode === 'auto') options.mode = options.total >= 1_000_000 ? 'db' : 'fs'
	if (options.mode === 'fs' && options.total >= 1_000_000 && !options.forceFs) {
		throw new Error('1m 真实文件系统档默认拒绝：一百万个目录约 3M 文件、写入以十分钟计。要用 --mode fs --force-fs 明确开启。')
	}
	return options
}

// ---------------------------------------------------------------------------
// paths and safety
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the data directory.
 *
 * @param {object} args - The parsed options.
 * @returns {{dataRoot: string, tierDir: string}} The resolved paths.
 */
function resolvePaths(args) {
	const dataRoot = resolve(args.dataRoot)
	if (basename(dataRoot) !== 'scale-data') {
		throw new Error(`--data-root 必须以 scale-data 结尾，避免误删别的目录：${dataRoot}`)
	}
	const tierDir = resolve(dataRoot, args.tier)
	const real = resolve(join(homedir(), '.dsh', 'ziyan'))
	const clash = (left, right) => left === right || left.startsWith(right + sep) || right.startsWith(left + sep)
	if (clash(tierDir, real)) {
		throw new Error(`拒绝操作真实数据目录：${tierDir} 与 ${real} 重叠。`)
	}
	const home = resolve(homedir())
	const tooWide = (dir) => tierDir === dir || dir.startsWith(tierDir + sep)
	if (tooWide(ROOT) || tooWide(home)) {
		throw new Error(`拒绝操作过宽的数据目录：${tierDir}（不能是仓库根或用户目录的祖先）`)
	}
	return { dataRoot, tierDir }
}

/** The paths inside one tier directory. */
function tierPaths(tierDir) {
	return {
		dir: tierDir,
		filesDir: join(tierDir, 'files'),
		systemDir: join(tierDir, 'system'),
		dbPath: join(tierDir, 'system', 'ziyan.db'),
		markerPath: join(tierDir, '.scale-marker.json'),
	}
}

// ---------------------------------------------------------------------------
// deterministic generation (pure functions of the file ordinal)
// ---------------------------------------------------------------------------

/**
 * Mix one 32-bit integer (the finalizer of splitmix/xorshift, cheap and good
 * enough for synthetic data: the shapes matter, not cryptographic quality).
 *
 * @param {number} value - Input.
 * @returns {number} Mixed 32-bit unsigned.
 */
function mix32(value) {
	let x = value >>> 0
	x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
	x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
	return (x ^ (x >>> 16)) >>> 0
}

/**
 * A stable 32-bit hash of `(index, salt)` under the run seed.
 *
 * @param {number} index - The file ordinal.
 * @param {number} salt - A discriminator.
 * @param {number} seed - The run seed.
 * @returns {number} The hash.
 */
function hashAt(index, salt, seed) {
	return mix32((seed ^ Math.imul(index + 1, 0x9e3779b9) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0)
}

/** One uniform number in [0, 1) derived from `(index, salt)`. */
function unitAt(index, salt, seed) {
	return hashAt(index, salt, seed) / 4294967296
}

/** A mulberry32 stream seeded per file ordinal, so one plan cannot affect another. */
function streamAt(index, seed) {
	let state = (seed ^ Math.imul(index + 1, 0x9e3779b9) ^ 0xa5a5a5a5) >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let value = Math.imul(state ^ (state >>> 15), 1 | state)
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296
	}
}

/** Pick one weighted entry. */
function weighted(next, table) {
	const total = table.reduce((sum, [, weight]) => sum + weight, 0)
	let cursor = next() * total
	for (const [value, weight] of table) {
		cursor -= weight
		if (cursor <= 0) return value
	}
	return table[table.length - 1][0]
}

/** Pick one list member. */
const pick = (next, list) => list[Math.floor(next() * list.length)]

/** An integer in [min, max]. */
const between = (next, min, max) => min + Math.floor(next() * (max - min + 1))

/** Remove duplicates, keeping caller order. */
const unique = (list) => [...new Set(list)]

/**
 * The creation timestamp encoded by an ordinal.
 *
 * One `now` per generation run is stored in the marker, so a reused build
 * reproduces the same ids without the clock moving underneath it.
 *
 * @param {number} index - The file ordinal.
 * @param {object} ctx - `{now, days, seed}`.
 * @returns {number} Milliseconds.
 */
function createdMsAt(index, ctx) {
	const spread = Math.floor(Math.pow(unitAt(index, 1, ctx.seed), 1.6) * ctx.days)
	const intraday = Math.floor(unitAt(index, 2, ctx.seed) * 86_400_000)
	return ctx.now - spread * 86_400_000 - intraday
}

/**
 * The deterministic 10-byte random half of one id.
 *
 * The low 32 bits carry the ordinal, so two ids can never collide however the
 * hash lands; the rest is hash material. This is why a regenerated library is
 * byte-identical in the index (given the same `now` and seed).
 *
 * @param {number} index - The file ordinal.
 * @param {number} seed - The run seed.
 * @returns {Buffer} Ten random bytes.
 */
function idRandom(index, seed) {
	const buffer = Buffer.allocUnsafe(10)
	buffer.writeUInt32BE(hashAt(index, 11, seed), 0)
	buffer.writeUInt32BE(index >>> 0, 4)
	buffer.writeUInt16BE(hashAt(index, 13, seed) & 0xffff, 8)
	return buffer
}

/**
 * The full id of one file.
 *
 * @param {number} index - The file ordinal.
 * @param {object} ctx - `{now, days, seed}`.
 * @returns {string} A valid `file-…` ULID.
 */
function idAt(index, ctx) {
	return fileId(createdMsAt(index, ctx), () => idRandom(index, ctx.seed))
}

/**
 * Plan one file: everything except the payload bytes.
 *
 * @param {number} index - The file ordinal.
 * @param {object} ctx - `{now, total, days, seed}`.
 * @returns {object} The plan.
 */
function planAt(index, ctx) {
	const next = streamAt(index, ctx.seed)
	const [phrase, slug] = pick(next, TOPICS)
	const ext = weighted(next, EXTENSIONS)
	const roll = next()
	let bytes
	if (roll < 0.012) bytes = between(next, 6_000, 16_000)
	else if (roll < 0.10) bytes = between(next, 1_000, 4_000)
	else bytes = between(next, 40, 700)
	const description = `${phrase}：${pick(next, VERBS)}${pick(next, OBJECTS)}。`
	const tags = unique([
		MARK,
		TYPE_TAGS[ext],
		pick(next, DOMAIN_TAGS),
		...(next() < 0.03 ? [`${MARK}/单例/${index}`] : []),
		...(next() < 0.30 ? [pick(next, DOMAIN_TAGS)] : []),
	])
	const createdMs = createdMsAt(index, ctx)
	const age = Math.max(1, ctx.now - createdMs)
	const updatedMs = createdMs + Math.floor(next() * Math.min(age, 60 * 86_400_000))
	const archived = next() < 0.03
	const linkCount = next() < 0.16 ? 0 : next() < 0.25 ? 2 : 1
	const links = []
	for (let count = 0; count < linkCount; count += 1) {
		if (next() < 0.002) {
			links.push(DANGLING_ID)
			continue
		}
		let target = Math.floor(next() * ctx.total)
		if (target === index) target = (target + 1) % ctx.total
		links.push(idAt(target, ctx))
	}
	return {
		id: idAt(index, ctx),
		name: `${slug}-${String(index).padStart(7, '0')}.${ext}`,
		ext,
		description,
		tags,
		links: unique(links),
		created: new Date(createdMs).toISOString(),
		updated: new Date(updatedMs).toISOString(),
		archived,
		bytes,
	}
}

/**
 * The payload bytes for one plan.
 *
 * Text stays valid UTF-8 down to `bytes`; binary extensions keep a real magic
 * header so `isTextMime`/preview take the same branch they would in a real
 * library. The final size is what the sidecar records.
 *
 * @param {object} plan - A plan.
 * @returns {Buffer} The payload.
 */
function payloadAt(plan) {
	const header = HEADERS[plan.ext]
	if (header !== undefined) {
		return Buffer.concat([header, Buffer.alloc(Math.max(0, plan.bytes - header.length), 0x0a)])
	}
	if (plan.bytes <= 0) return Buffer.alloc(0)
	const head = `# ${plan.description}\n\n`
	const line = `第 {n} 行：${plan.description}\n`
	const parts = [head]
	let size = Buffer.byteLength(head, 'utf8')
	let number = 1
	while (size < plan.bytes) {
		const text = line.replace('{n}', String(number))
		parts.push(text)
		size += Buffer.byteLength(text, 'utf8')
		number += 1
	}
	return Buffer.from(parts.join(''), 'utf8')
}

/**
 * The four views of one file used by both the filesystem generator and the
 * index builder.
 *
 * @param {number} index - The file ordinal.
 * @param {object} ctx - The run context.
 * @returns {{plan: object, payload: Buffer, meta: object, sidecar: string}} The views.
 */
function entityAt(index, ctx) {
	const plan = planAt(index, ctx)
	const payload = payloadAt(plan)
	const meta = buildMeta({
		id: plan.id,
		name: plan.name,
		description: plan.description,
		tags: plan.tags,
		links: plan.links,
		created: plan.created,
		updated: plan.updated,
		mime: mimeOf(plan.name),
		bytes: payload.length,
		sha256: createHash('sha256').update(payload).digest('hex'),
		archived: plan.archived,
	})
	return { plan, payload, meta, sidecar: serializeMeta(meta) }
}

/** A deterministic 64-hex digest for index-only rows (no payload to hash). */
function fakeDigest(index, seed) {
	const left = hashAt(index, 21, seed).toString(16).padStart(8, '0')
	const right = hashAt(index, 22, seed).toString(16).padStart(8, '0')
	return `${left}${right}`.repeat(4)
}

/**
 * One row for the index-only mode: same fields as a sidecar, no payload.
 *
 * @param {number} index - The file ordinal.
 * @param {object} ctx - The run context.
 * @returns {object} The metadata row `IndexDatabase.upsertRow` expects.
 */
function indexRowAt(index, ctx) {
	const plan = planAt(index, ctx)
	return {
		id: plan.id,
		name: plan.name,
		description: plan.description,
		tags: plan.tags,
		links: plan.links,
		created: plan.created,
		updated: plan.updated,
		mime: mimeOf(plan.name),
		bytes: plan.bytes,
		sha256: fakeDigest(index, ctx.seed),
		archived: plan.archived,
	}
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

/** Write message to stderr (progress must not pollute `--json` stdout). */
function note(message) {
	process.stderr.write(`${message}\n`)
}

/**
 * Run `worker(0..total-1)` with bounded concurrency.
 *
 * @param {number} total - Work items.
 * @param {number} concurrency - In-flight cap.
 * @param {(index: number) => Promise<void>} worker - The work.
 * @param {(done: number) => void} [progress] - Called after each item.
 * @returns {Promise<void>} Resolves when the pool drains.
 */
async function runPool(total, concurrency, worker, progress) {
	let cursor = 0
	let done = 0
	const lanes = Math.min(Math.max(1, concurrency), Math.max(1, total))
	const runners = Array.from({ length: lanes }, async () => {
		for (;;) {
			const index = cursor
			cursor += 1
			if (index >= total) return
			await worker(index)
			done += 1
			progress?.(done)
		}
	})
	await Promise.all(runners)
}

/**
 * Generate a real filesystem library and build its index.
 *
 * @param {object} args - Options.
 * @param {object} paths - Resolved paths.
 * @param {object} ctx - The run context (`now`, `total`, `days`, `seed`).
 * @returns {Promise<object>} Generation metrics for the marker.
 */
async function generateFilesystem(args, paths, ctx) {
	const { filesDir, systemDir, dbPath } = paths
	await mkdir(filesDir, { recursive: true })
	await mkdir(systemDir, { recursive: true })
	await rm(dbPath, { force: true })
	await rm(`${dbPath}-wal`, { force: true })
	await rm(`${dbPath}-shm`, { force: true })

	let payloadBytes = 0
	let sidecarBytes = 0
	const started = performance.now()
	const report = Math.max(500, Math.floor(args.total / 20))
	await runPool(args.total, args.concurrency, async (index) => {
		const { meta, payload, sidecar } = entityAt(index, ctx)
		const dir = join(filesDir, meta.id)
		await mkdir(dir)
		await Promise.all([
			writeFile(join(dir, meta.name), payload),
			writeFile(join(dir, META_FILE), sidecar),
		])
		payloadBytes += payload.length
		sidecarBytes += Buffer.byteLength(sidecar, 'utf8')
	}, (done) => {
		if (done % report === 0) note(`  写入 ${done}/${args.total}（${Math.round(performance.now() - started)} ms）`)
	})
	const writeMs = performance.now() - started

	note('  构建索引（bulk 线性路径，见 buildIndexFast 注释）…')
	const tally = createTally()
	const indexMs = buildIndexFast(dbPath, args.total, (index) => entityAt(index, ctx).meta, tally)
	const dbBytes = await fileBytes(dbPath)
	const walBytes = await fileBytes(`${dbPath}-wal`)
	return {
		writeMs,
		indexMs,
		bytes: { payload: payloadBytes, sidecars: sidecarBytes, index: dbBytes, wal: walBytes },
		counts: tally.counts(args.total),
	}
}

/**
 * Generate an index-only library at the same row shape.
 *
 * @param {object} args - Options.
 * @param {object} paths - Resolved paths.
 * @param {object} ctx - The run context.
 * @returns {Promise<object>} Generation metrics for the marker.
 */
async function generateIndexOnly(args, paths, ctx) {
	await mkdir(paths.systemDir, { recursive: true })
	await rm(paths.dbPath, { force: true })
	await rm(`${paths.dbPath}-wal`, { force: true })
	await rm(`${paths.dbPath}-shm`, { force: true })
	note('  构建 1M 行索引（bulk 线性路径）…')
	const started = performance.now()
	const tally = createTally()
	const indexMs = buildIndexFast(paths.dbPath, args.total, (index) => indexRowAt(index, ctx), tally, (done) => {
		note(`  索引 ${done}/${args.total}（${Math.round(performance.now() - started)} ms）`)
	})
	const dbBytes = await fileBytes(paths.dbPath)
	const walBytes = await fileBytes(`${paths.dbPath}-wal`)
	return { writeMs: 0, indexMs, bytes: { payload: 0, sidecars: 0, index: dbBytes, wal: walBytes }, counts: tally.counts(args.total) }
}

/**
 * Count what the planned rows will put in the index without querying it.
 *
 * The counts have to exist before the benchmarks (`page.total` is asserted
 * against them) and they are known from the plan, so they are accumulated as
 * the rows are produced. This also keeps the 1M generation from paying a slow
 * `COUNT(DISTINCT tag)` join just to write a marker.
 *
 * @returns {{add: (meta: object) => void, counts: (total: number) => object}} The tally.
 */
function createTally() {
	const tags = new Set()
	let archived = 0
	let links = 0
	let tagAssignments = 0
	return {
		add(meta) {
			if (meta.archived === true) archived += 1
			links += (meta.links ?? []).length
			tagAssignments += (meta.tags ?? []).length
			for (const tag of meta.tags ?? []) tags.add(tag)
		},
		counts(total) {
			return {
				totalFiles: total,
				files: total - archived,
				archived,
				links,
				tags: tags.size,
				tagAssignments,
			}
		},
	}
}

/**
 * Insert every planned row at bulk speed, for generation only.
 *
 * This is deliberately not `IndexDatabase.upsertRow()`: that method maintains
 * the derived tables (FTS row per row, link bookkeeping) the way a real write
 * does, and generation starts from an empty index, so the invariant tables are
 * built in bulk once at the end. That split is also what makes 1M possible:
 * `rebuildFts()` builds the whole FTS table with one `INSERT ... SELECT` (the
 * tokenizer is a SQL function), and `rebuildLinkedIds()` derives the
 * "files with at least one link" set with one query.
 *
 * The real write path is measured separately by `write.upsertRow(1)`, the
 * FTS rebuild by `db.rebuildFts()`, and the full rebuild by `store.rebuild()`.
 *
 * @param {string} dbPath - The database file.
 * @param {number} total - Row count.
 * @param {(index: number) => object} rowAt - Row producer.
 * @param {{add: (meta: object) => void}} [tally] - Count sink.
 * @param {(done: number) => void} [progress] - Progress sink.
 * @returns {number} Elapsed milliseconds.
 */
function buildIndexFast(dbPath, total, rowAt, tally, progress) {
	const chunk = total >= 1_000_000 ? 20_000 : 10_000
	const db = new IndexDatabase({ path: dbPath })
	db.open()
	const insertFile = db.db.prepare(`INSERT INTO files(id, name, description, mime, bytes, sha256, created, updated, archived, source, suffix, created_day)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`)
	const insertLink = db.db.prepare('INSERT OR IGNORE INTO links(from_id, to_id) VALUES (?, ?)')
	const insertTag = db.db.prepare('INSERT OR IGNORE INTO tags(file_id, tag, archived) VALUES (?, ?, ?)')
	const extensionOf = (name) => {
		const dot = name.lastIndexOf('.')
		return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase()
	}
	const dayKey = (iso) => {
		const date = new Date(iso)
		return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
	}
	const started = performance.now()
	try {
		for (let start = 0; start < total; start += chunk) {
			const end = Math.min(total, start + chunk)
			db.transaction(() => {
				for (let index = start; index < end; index += 1) {
					const meta = rowAt(index)
					tally?.add(meta)
					const archived = meta.archived === true ? 1 : 0
					insertFile.run(
						meta.id,
						meta.name,
						meta.description,
						meta.mime,
						meta.bytes,
						meta.sha256,
						meta.created,
						meta.updated,
						archived,
						extensionOf(meta.name),
						dayKey(meta.created),
					)
					for (const target of meta.links ?? []) insertLink.run(meta.id, target)
					for (const tag of meta.tags ?? []) insertTag.run(meta.id, tag, archived)
				}
			})
			progress?.(end)
		}
		db.transaction(() => {
			db.rebuildFts()
			db.rebuildLinkedIds()
		})
	} finally {
		db.close()
	}
	return performance.now() - started
}

/** The byte size of a file, 0 when absent. */
async function fileBytes(path) {
	return stat(path).then((info) => Number(info.size), () => 0)
}

// ---------------------------------------------------------------------------
// marker (what a previous run built)
// ---------------------------------------------------------------------------

/**
 * Load the marker of one tier.
 *
 * @param {string} markerPath - The marker path.
 * @returns {Promise<object | undefined>} The marker, or undefined.
 */
async function readMarker(markerPath) {
	const text = await readFile(markerPath, 'utf8').catch(() => undefined)
	if (text === undefined) return undefined
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

/**
 * Decide whether an existing tier directory can be reused.
 *
 * @param {object | undefined} marker - The marker.
 * @param {object} args - Options.
 * @returns {boolean} True when the data matches the requested shape.
 */
function markerMatches(marker, args) {
	return marker !== undefined
		&& marker.formatVersion === FORMAT
		&& marker.indexSchema === INDEX_SCHEMA
		&& marker.tier === args.tier
		&& marker.mode === args.mode
		&& marker.total === args.total
		&& marker.seed === args.seed
		&& marker.days === args.days
}

/**
 * Build the generator context, from the marker on reuse and from the clock on
 * a fresh run.
 *
 * @param {object} args - Options.
 * @param {object | undefined} marker - A reusable marker, if any.
 * @returns {object} The context.
 */
function contextFor(args, marker) {
	return {
		now: marker === undefined ? Date.now() : marker.baseNow,
		total: args.total,
		days: args.days,
		seed: args.seed,
	}
}

/**
 * Load or build the requested tier.
 *
 * @param {object} args - Options.
 * @param {object} paths - Resolved paths.
 * @returns {Promise<{marker: object, reused: boolean}>} The marker and reuse flag.
 */
async function prepare(args, paths) {
	const loaded = await readMarker(paths.markerPath)
	const existing = markerMatches(loaded, args) ? loaded : undefined
	if (existing !== undefined && !args.reset) {
		note(`复用已有数据：${paths.dir}（${existing.total} 文件，${existing.mode} 模式）`)
		return { marker: existing, reused: true }
	}
	if (args.reuse && !args.reset) {
		throw new Error(`--reuse 指定的数据不可用（${paths.dir}）：marker 缺失或格式/档位/索引版本不匹配。先跑一次 --reset 生成。`)
	}
	note(`生成数据：tier=${args.tier} mode=${args.mode} dir=${paths.dir}`)
	await rm(paths.dir, { recursive: true, force: true })
	await mkdir(paths.dir, { recursive: true })
	const ctx = contextFor(args, undefined)
	const started = performance.now()
	const generated = args.mode === 'fs'
		? await generateFilesystem(args, paths, ctx)
		: await generateIndexOnly(args, paths, ctx)
	const totalMs = performance.now() - started
	const marker = {
		formatVersion: FORMAT,
		indexSchema: INDEX_SCHEMA,
		tool: 'scale-lab',
		tier: args.tier,
		mode: args.mode,
		total: args.total,
		seed: args.seed,
		days: args.days,
		baseNow: ctx.now,
		generatedAt: new Date().toISOString(),
		timings: { writeMs: generated.writeMs, indexMs: generated.indexMs, indexMethod: 'bulk', totalMs },
		bytes: generated.bytes,
		counts: generated.counts,
	}
	await writeFile(paths.markerPath, `${JSON.stringify(marker, null, '\t')}\n`)
	note(`生成完成：${args.total} 文件，写入 ${Math.round(generated.writeMs)} ms，索引 ${Math.round(generated.indexMs)} ms，总 ${Math.round(totalMs)} ms`)
	return { marker, reused: false }
}

// ---------------------------------------------------------------------------
// benchmark harness
// ---------------------------------------------------------------------------

/** Results, in execution order. */
const results = []

/** Bench failures, so the exit code stops lying. */
const failures = []

/** Memory snapshots at group boundaries. */
const memorySnapshots = []

/** Highest RSS observed while sampling. */
let peakRss = 0

/** The current group, for alternating table headers. */
let currentGroup = ''

/** Human-readable rows, collected for the final screen. */
function samplePeak() {
	const usage = process.memoryUsage()
	if (usage.rss > peakRss) peakRss = usage.rss
}

/** One percentile over sorted samples (nearest-rank). */
function percentile(sorted, fraction) {
	if (sorted.length === 0) return 0
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
	return sorted[index]
}

/** Round to `digits` decimals without trailing float noise. */
const round = (value, digits = 3) => Number(Number(value).toFixed(digits))

/**
 * Run one measured operation.
 *
 * @param {string} name - Row name.
 * @param {string} group - Table group.
 * @param {(iteration: number) => any} fn - The measured work (may be async).
 * @param {{reps?: number, warmup?: number, validate?: (value: any) => string | undefined}} [options] - Repetitions, discarded warmups and a correctness check run on the last value.
 * @returns {Promise<any>} The last value.
 */
async function bench(name, group, fn, options = {}) {
	const reps = Math.max(1, Math.round((options.reps ?? 10) * args.reps))
	const warmup = Math.max(0, Math.round(options.warmup ?? (reps >= 4 ? 2 : reps >= 2 ? 1 : 0)))
	const samples = []
	let last
	let noteText = ''
	let error
	try {
		for (let index = 0; index < warmup; index += 1) last = await fn(index)
		for (let index = 0; index < reps; index += 1) {
			const started = performance.now()
			last = await fn(index)
			samples.push(performance.now() - started)
			samplePeak()
		}
		if (options.validate !== undefined) noteText = options.validate(last) ?? ''
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught)
	}
	const sorted = [...samples].sort((left, right) => left - right)
	const line = {
		name,
		group,
		reps: samples.length,
		warmup,
		p50Ms: round(percentile(sorted, 0.5)),
		p95Ms: round(percentile(sorted, 0.95)),
		minMs: round(sorted[0] ?? 0),
		maxMs: round(sorted[sorted.length - 1] ?? 0),
		meanMs: round(samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length)),
		opsPerSec: round(sorted.length === 0 ? 0 : 1000 / Math.max(0.000001, percentile(sorted, 0.5)), 1),
		note: noteText,
		...(error === undefined ? {} : { error }),
	}
	results.push(line)
	if (error !== undefined) failures.push({ name, error })
	printRow(line)
	return last
}

/** Print the current group header once. */
function beginGroup(group) {
	if (group === currentGroup) return
	currentGroup = group
	if (args.json) return
	console.log(`\n-- ${group} --`)
	console.log(
		`${'name'.padEnd(30)} ${'reps'.padStart(4)} ${'p50 ms'.padStart(9)} ${'p95 ms'.padStart(9)} ${'ops/s'.padStart(9)}  note`,
	)
}

/** Print one result row in the human format. */
function printRow(line) {
	if (args.json) return
	beginGroup(line.group)
	const ops = line.opsPerSec >= 1000 ? line.opsPerSec.toFixed(0) : line.opsPerSec.toFixed(1)
	const failed = line.error === undefined ? '' : `  FAILED: ${line.error}`
	console.log(
		`${line.name.padEnd(30)} ${String(line.reps).padStart(4)} ${line.p50Ms.toFixed(2).padStart(9)} ${line.p95Ms.toFixed(2).padStart(9)} ${ops.padStart(9)}  ${line.note}${failed}`,
	)
}

/** Record memory at a group boundary. */
function snapshotMemory(label) {
	const usage = process.memoryUsage()
	samplePeak()
	memorySnapshots.push({
		label,
		rssMB: round(usage.rss / 1048576, 1),
		heapUsedMB: round(usage.heapUsed / 1048576, 1),
		heapTotalMB: round(usage.heapTotal / 1048576, 1),
		externalMB: round(usage.external / 1048576, 1),
		arrayBuffersMB: round(usage.arrayBuffers / 1048576, 1),
	})
}

/** Build the stub dependencies the panel handler needs but this lab does not test. */
function handlerDeps(store, tierDir) {
	return {
		store,
		settings: { publicView: () => ({ descriptionMaxChars: 160, maxFileBytes: 25 * 1024 * 1024, readTextBytes: 256 * 1024 }) },
		logs: { info() {}, warn() {}, error() {} },
		root: tierDir,
		version: 'scale-lab',
		data: { status: () => ({}) },
		tools: [],
		organize: { status: () => ({}) },
	}
}

/** JSON byte size of a handler result (the panel really pays this). */
function payloadBytes(value) {
	return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
}

/** A number with a thousand separator, for notes. */
const num = (value) => Number(value).toLocaleString('en-US')

/** `n` filler for a skipped benchmark (the row still shows why). */
function skipped(name, group, reason) {
	results.push({ name, group, reps: 0, warmup: 0, p50Ms: 0, p95Ms: 0, minMs: 0, maxMs: 0, meanMs: 0, opsPerSec: 0, note: `skipped: ${reason}` })
	printRow(results[results.length - 1])
}

// ---------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------

/**
 * Find a text file ordinal and a backlink target for seed benchmarks.
 *
 * @param {object} ctx - The run context.
 * @returns {{text: number, target: string}} A text ordinal and an id that
 *   another file links to (so `backlinks` has a non-empty case).
 */
function findSeeds(ctx) {
	let text = -1
	let target = ''
	for (let index = 0; index < Math.min(ctx.total, 500); index += 1) {
		const plan = planAt(index, ctx)
		if (text < 0 && plan.ext !== 'png' && plan.ext !== 'jpg' && plan.ext !== 'pdf' && plan.ext !== 'zip' && plan.ext !== 'docx') {
			text = index
		}
		if (target === '' && plan.links.length > 0 && plan.links[0] !== DANGLING_ID) target = plan.links[0]
		if (text >= 0 && target !== '') break
	}
	if (text < 0) throw new Error('数据里没有文本文件，基准种子找不到。')
	return { text, target }
}

/**
 * The whole measurement suite.
 *
 * @param {object} args - Options.
 * @param {object} paths - Resolved paths.
 * @param {{marker: object, reused: boolean}} prepared - The prepared tier.
 * @returns {Promise<object>} The report body.
 */
async function runSuite(args, paths, prepared) {
	const { marker } = prepared
	const ctx = contextFor(args, marker)
	const counts = marker.counts
	const lite = args.lite
	const seeds = findSeeds(ctx)
	const textId = idAt(seeds.text, ctx)
	const hubId = seeds.target
	const seedIds = [idAt(0, ctx), idAt(1, ctx), idAt(2, ctx)]
	const live = counts.files
	const archived = counts.archived
	const depths = { shallow: 2, deep: 10, heavy: 6, light: 20, tiny: 40 }
	// Expensive operations need fewer samples at scale, not more: the p50 of a
	// 2 s call is stable enough, and a hundred of them is a minute of waiting.
	if (args.total > 10_000) Object.assign(depths, { shallow: 2, deep: 3, heavy: 2, light: 5, tiny: 8 })
	if (args.total > 100_000) Object.assign(depths, { shallow: 1, deep: 1, heavy: 1, light: 2, tiny: 3 })

	snapshotMemory('start')

	// -- open / rebuild ------------------------------------------------------
	beginGroup('open / rebuild')
	await bench('open.warm', 'open / rebuild', async () => {
		const store = new FileStore({ dataDir: paths.dir })
		await store.open()
		const total = store.db.total()
		store.close()
		return total
	}, {
		reps: args.mode === 'db' ? depths.shallow : depths.deep,
		validate: (total) => {
			if (total !== counts.totalFiles) throw new Error(`期望索引 ${counts.totalFiles} 行，实际 ${total} 行`)
			return `rows=${num(total)}`
		},
	})
	snapshotMemory('open.warm')

	if (args.mode === 'fs' && args.total <= 100_000) {
		await bench('open.cold (no index)', 'open / rebuild', async () => {
			await rm(paths.dbPath, { force: true })
			await rm(`${paths.dbPath}-wal`, { force: true })
			await rm(`${paths.dbPath}-shm`, { force: true })
			const store = new FileStore({ dataDir: paths.dir })
			await store.open()
			const total = store.db.total()
			store.close()
			return total
		}, {
			reps: args.total > 10_000 ? 1 : 2,
			warmup: 0,
			validate: (total) => {
				if (total !== counts.totalFiles) throw new Error(`冷启动重建后索引 ${total} 行，期望 ${counts.totalFiles}`)
				return `scan+rebuild rows=${num(total)}`
			},
		})
	} else if (args.mode === 'fs') {
		skipped('open.cold (no index)', 'open / rebuild', '只在 10k/100k 实测；1m 真实目录库不在本脚本的默认范围')
	} else {
		skipped('open.cold (no index)', 'open / rebuild', 'db 模式没有边车，冷启动扫描无意义')
	}
	snapshotMemory('open.cold')

	// One store for every read benchmark; reopening per call would measure
	// open(), not the query.
	const store = new FileStore({ dataDir: paths.dir })
	await store.open()
	const handler = createZiyanHandler(handlerDeps(store, paths.dir))
	const textFile = await store.read(textId, { text: false, neighbors: false })
	const textIdForPreview = textFile === undefined ? textId : textFile.id
	// One full metadata row, re-upserted in place: this measures exactly the
	// DB half of a `create()`/`update()` (the sidecar and payload writes around
	// it are file I/O and do not grow with N).
	const sampleMeta = store.db.get(textId)
	// The ids of one result page, for the degree batch benchmark: the read paths
	// fetch degrees for exactly the rows they show.
	const pageIds = store.db.page({ limit: 50 }).rows.map((meta) => meta.id)

	try {
		// -- index components: where the time actually goes ------------------
		beginGroup('index components')
		const hit = store.db.search(QUERIES[0], { limit: 50 })[0]
		if (hit === undefined) throw new Error(`搜索「${QUERIES[0]}」没有命中，数据生成有问题。`)
		const hitId = hit.id
		await bench('db.search(50)', 'index components', () => store.db.search(QUERIES[1], { limit: 50 }), {
			reps: depths.light,
			validate: (rows) => {
				if (rows.length === 0) throw new Error('期望有命中')
				return `hits=${rows.length}`
			},
		})
		await bench('db.search(200)', 'index components', () => store.db.search(QUERIES[2], { limit: 200 }), {
			reps: depths.deep,
			validate: (rows) => `hits=${rows.length}`,
		})
		await bench('db.get(hit)', 'index components', () => store.db.get(hitId), {
			reps: depths.light,
			validate: (meta) => {
				if (meta === undefined || meta.id !== hitId) throw new Error('按 id 取不到行')
				return `tags=${meta.tags.length}`
			},
		})
		await bench('db.backlinks(hub)', 'index components', () => store.db.backlinks(hubId), {
			reps: depths.light,
			validate: (ids) => `in=${ids.length}`,
		})
		await bench('db.degreesFor(50)', 'index components', () => store.db.degreesFor(pageIds), {
			reps: depths.heavy,
			validate: (map) => {
				if (map.size !== pageIds.length) throw new Error(`degree 覆盖 ${map.size} 行，期望 ${pageIds.length}`)
				let linked = 0
				for (const entry of map.values()) if (entry.in + entry.out > 0) linked += 1
				return `${map.size} rows (${linked} linked)`
			},
		})
		await bench('db.ids()', 'index components', () => store.db.ids(), {
			reps: depths.deep,
			validate: (ids) => {
				if (ids.length !== counts.totalFiles) throw new Error(`ids ${ids.length} ≠ ${counts.totalFiles}`)
				return `${num(ids.length)} ids`
			},
		})
		if (lite) {
			skipped('shortIds cold build', 'index components', '--lite')
		} else {
			await bench('shortIds cold build', 'index components', () => new ShortIdIndex(store.db.ids()), {
				reps: depths.heavy,
				validate: (index) => {
					if (index.count !== counts.totalFiles) throw new Error(`shortIds ${index.count} ≠ ${counts.totalFiles}`)
					return `${num(index.count)} short ids`
				},
			})
		}
		await bench('db.page(first)', 'index components', () => store.db.page({ limit: 50 }), {
			reps: depths.deep,
			validate: (page) => {
				if (page.total !== live) throw new Error(`page.total ${page.total} ≠ ${live}`)
				return `total=${num(page.total)}`
			},
		})
		await bench('db.page(tag 工作/项目)', 'index components', () => store.db.page({ limit: 50, tags: ['工作/项目'] }), {
			reps: depths.deep,
			validate: (page) => {
				if (page.total <= 0) throw new Error('标签过滤没有命中')
				return `total=${num(page.total)}`
			},
		})
		await bench('db.snapshot(3000)', 'index components', () => store.db.snapshot({ limit: 3000 }), {
			reps: lite ? 1 : depths.deep,
			validate: (snapshot) => {
				if (snapshot.rows.length > 3000) throw new Error('超过节点上限')
				return `nodes=${num(snapshot.rows.length)} edges=${num(snapshot.edges.length)}`
			},
		})
		await bench('db.tagCounts(1000)', 'index components', () => store.db.tagCounts(1000), {
			reps: depths.deep,
			validate: (rows) => `tags=${rows.length}`,
		})
		await bench('db.suffixCounts()', 'index components', () => store.db.suffixCounts(), {
			reps: depths.deep,
			validate: (rows) => {
				const sum = rows.reduce((total, row) => total + row.count, 0)
				if (sum !== live) throw new Error(`后缀合计 ${sum} ≠ ${live}`)
				return `suffixes=${rows.length}`
			},
		})
		await bench('db.activityDays()', 'index components', () => store.db.activityDays(), {
			reps: depths.deep,
			validate: (rows) => `${num(rows.length)} days`,
		})
		await bench('db.stats()', 'index components', () => store.db.stats(), {
			reps: depths.heavy,
			validate: (stats) => {
				if (stats.files !== live) throw new Error(`stats.files ${stats.files} ≠ ${live}`)
				return `files=${num(stats.files)} tags=${num(stats.tags)}`
			},
		})
		snapshotMemory('index components')

		// -- write path: one upsert, the cost every create() pays ------------
		beginGroup('write path')
		await bench('write.upsertRow(1)', 'write path', () => store.db.transaction(() => store.db.upsertRow(sampleMeta)), {
			reps: depths.heavy,
			warmup: 0,
			validate: () => 'FTS by rowid + derived-table maintenance, one write',
		})
		snapshotMemory('write path')

		// -- store.list: page and filter -------------------------------------
		beginGroup('store.list / page')
		const tailOffset = Math.max(0, live - 50)
		const midOffset = Math.max(0, Math.floor(live / 2))
		const deepOffset = Math.max(0, Math.floor(live * 0.9))
		await bench('list.page(first)', 'store.list / page', () => store.list({ limit: 50 }), {
			reps: depths.deep,
			validate: (page) => {
				if (page.total !== live) throw new Error(`total ${page.total} ≠ ${live}`)
				if (page.files.length !== Math.min(50, live)) throw new Error('首页条数不对')
				return `total=${num(page.total)}`
			},
		})
		await bench('list.page(mid)', 'store.list / page', () => store.list({ limit: 50, offset: midOffset }), {
			reps: depths.heavy,
			validate: (page) => `offset=${num(midOffset)} rows=${page.files.length}`,
		})
		await bench('list.page(tail)', 'store.list / page', () => store.list({ limit: 50, offset: tailOffset }), {
			reps: depths.heavy,
			validate: (page) => {
				if (page.files.length !== live - tailOffset) throw new Error(`尾页条数 ${page.files.length} 不对`)
				return `offset=${num(tailOffset)}`
			},
		})
		await bench('list.page(deep 90%)', 'store.list / page', () => store.list({ limit: 50, offset: deepOffset }), {
			reps: depths.heavy,
			validate: (page) => `offset=${num(deepOffset)} rows=${page.files.length}`,
		})
		await bench('list.filter(mime=text/)', 'store.list / page', () => store.list({ limit: 50, mime: 'text/' }), {
			reps: depths.deep,
			validate: (page) => {
				if (page.total <= 0) throw new Error('mime 过滤没有命中')
				return `total=${num(page.total)}`
			},
		})
		await bench('list.filter(suffix=md)', 'store.list / page', () => store.list({ limit: 50, suffix: 'md' }), {
			reps: depths.deep,
			validate: (page) => {
				if (page.total <= 0) throw new Error('后缀过滤没有命中')
				return `total=${num(page.total)}`
			},
		})
		await bench('list.filter(tag=工作/项目)', 'store.list / page', () => store.list({ limit: 50, tag: '工作/项目' }), {
			reps: depths.deep,
			validate: (page) => {
				if (page.total <= 0) throw new Error('标签过滤没有命中')
				return `total=${num(page.total)}`
			},
		})
		await bench('list.filter(tags=工作+类型)', 'store.list / page', () => store.list({ limit: 50, tags: ['工作', '类型'] }), {
			reps: depths.deep,
			validate: (page) => {
				if (page.total <= 0) throw new Error('双标签 AND 没有命中')
				return `total=${num(page.total)}`
			},
		})
		await bench('list.filter(archived)', 'store.list / page', () => store.list({ limit: 50, archived: true }), {
			reps: depths.heavy,
			validate: (page) => {
				if (page.total !== archived) throw new Error(`归档 total ${page.total} ≠ ${archived}`)
				return `total=${num(page.total)}`
			},
		})
		snapshotMemory('store.list / page')

		// -- search ----------------------------------------------------------
		beginGroup('search')
		await bench('list.search(keyword)', 'search', (iteration) => store.list({ query: QUERIES[iteration % QUERIES.length], limit: 50 }), {
			reps: depths.light,
			validate: (page) => {
				if (page.files.length === 0) throw new Error('关键词没有命中')
				return `hits=${page.files.length}`
			},
		})
		await bench('list.search(miss)', 'search', () => store.list({ query: 'zzqqxx', limit: 50 }), {
			reps: depths.deep,
			validate: (page) => {
				if (page.files.length !== 0) throw new Error('空查询居然有结果')
				return 'hits=0'
			},
		})
		await bench('list.search(query+tag)', 'search', () => store.list({ query: QUERIES[0], tag: '工作', limit: 50 }), {
			reps: depths.heavy,
			validate: (page) => {
				// The 1M tier used to return zero hits here: the tag filter ran
				// after the bm25 window and every tagged document fell out of it.
				if (page.files.length === 0) throw new Error('关键词+标签没有命中（标签过滤应在 SQL 里生效）')
				return `hits=${page.files.length}`
			},
		})
		await bench('list.search(limit 200)', 'search', () => store.list({ query: QUERIES[3], limit: 200 }), {
			reps: depths.heavy,
			validate: (page) => `rows=${page.files.length}`,
		})
		snapshotMemory('search')

		// -- graph -----------------------------------------------------------
		beginGroup('graph')
		await bench('graph.hops1', 'graph', () => store.graph([textId], { hops: 1, limit: 100 }), {
			reps: depths.deep,
			validate: (graph) => {
				if (graph.nodes.length === 0) throw new Error('图没有节点')
				return `nodes=${graph.nodes.length} edges=${graph.edges.length}`
			},
		})
		await bench('graph.hops2', 'graph', () => store.graph(seedIds, { hops: 2, limit: 200 }), {
			reps: depths.heavy,
			validate: (graph) => `nodes=${graph.nodes.length} edges=${graph.edges.length}`,
		})
		await bench('graph.library(3000)', 'graph', () => store.libraryGraph({ limit: 3000 }), {
			reps: depths.heavy,
			validate: (graph) => {
				if (graph.nodes.length > 3000) throw new Error('超过节点上限')
				return `nodes=${num(graph.nodes.length)} edges=${num(graph.edges.length)}`
			},
		})
		if (lite) {
			skipped('graph.library(5000)', 'graph', '--lite')
		} else {
			await bench('graph.library(5000)', 'graph', () => store.libraryGraph({ limit: 5000 }), {
				reps: depths.heavy,
				validate: (graph) => `nodes=${num(graph.nodes.length)} edges=${num(graph.edges.length)}`,
			})
		}
		snapshotMemory('graph')

		// -- overview aggregates --------------------------------------------
		beginGroup('overview aggregates')
		await bench('store.tagCounts(1000)', 'overview aggregates', () => store.tagCounts(1000), {
			reps: depths.light,
			validate: (rows) => `tags=${rows.length}`,
		})
		await bench('store.suffixCounts()', 'overview aggregates', () => store.suffixCounts(), {
			reps: depths.deep,
			validate: (rows) => {
				const sum = rows.reduce((total, row) => total + row.count, 0)
				if (sum !== live) throw new Error(`后缀合计 ${sum} ≠ ${live}`)
				return `suffixes=${rows.length}`
			},
		})
		await bench('store.activity()', 'overview aggregates', () => store.activity(), {
			reps: depths.deep,
			validate: (activity) => `days=${activity.days} notes=${num(activity.notes)}`,
		})
		await bench('store.stats()', 'overview aggregates', () => store.stats(), {
			reps: depths.heavy,
			validate: (stats) => {
				if (stats.files !== live) throw new Error(`stats.files ${stats.files} ≠ ${live}`)
				return `files=${num(stats.files)} orphans=${num(stats.orphans)}`
			},
		})
		await bench('store.organizeReport()', 'overview aggregates', () => store.organizeReport({ staleDays: 90, sample: 5 }), {
			reps: depths.heavy,
			validate: (report) => {
				if (report.files.files !== live) throw new Error('organizeReport 的 files 数不对')
				return `orphans=${num(report.orphans.total)} stale=${num(report.stale.total)} singleTags=${num(report.singleTags.total)}`
			},
		})
		snapshotMemory('overview aggregates')

		// -- panel handler endpoints ----------------------------------------
		beginGroup('remote handler')
		await bench('endpoint overview', 'remote handler', () => handler('overview', {}), {
			reps: depths.shallow,
			validate: (value) => {
				if (value.stats.files !== live) throw new Error('overview.stats 不对')
				if (value.tags.length === 0) throw new Error('overview.tags 为空')
				return `bytes=${num(payloadBytes(value))} tags=${num(value.tags.length)} suffixes=${num(value.suffixes.length)}`
			},
		})
		await bench('endpoint file-list(first)', 'remote handler', () => handler('file-list', { limit: 50 }), {
			reps: depths.deep,
			validate: (value) => {
				if (value.total !== live) throw new Error('file-list.total 不对')
				return `bytes=${num(payloadBytes(value))} total=${num(value.total)}`
			},
		})
		await bench('endpoint file-list(query)', 'remote handler', () => handler('file-list', { query: QUERIES[2], limit: 50 }), {
			reps: depths.heavy,
			validate: (value) => `bytes=${num(payloadBytes(value))} hits=${value.files.length}`,
		})
		await bench('endpoint file-list(tag)', 'remote handler', () => handler('file-list', { tags: ['工作/项目'], limit: 50 }), {
			reps: depths.deep,
			validate: (value) => `bytes=${num(payloadBytes(value))} total=${num(value.total)}`,
		})
		await bench('endpoint file-read(text)', 'remote handler', () => handler('file-read', { id: textId }), {
			reps: depths.deep,
			validate: (value) => {
				if (value.id !== textId) throw new Error('read 的 id 不对')
				return `bytes=${num(payloadBytes(value))} missing=${value.missing === true}`
			},
		})
		if (args.mode === 'fs') {
			await bench('endpoint file-preview', 'remote handler', () => handler('file-preview', { id: textIdForPreview }), {
				reps: depths.deep,
				validate: (value) => `bytes=${num(payloadBytes(value))} kind=${value.kind}`,
			})
		} else {
			skipped('endpoint file-preview', 'remote handler', 'db 模式没有载荷文件，端点按设计拒绝（文件本体缺失）')
		}
		await bench('endpoint graph', 'remote handler', () => handler('graph', {}), {
			reps: depths.shallow,
			validate: (value) => `bytes=${num(payloadBytes(value))} nodes=${num(value.nodes.length)} hidden=${num(value.totals.hidden)}`,
		})
		await bench('endpoint injection', 'remote handler', () => handler('injection', {}), {
			reps: depths.tiny,
			validate: (value) => {
				if (!(value.staticBytes > 0)) throw new Error('静态注入为空')
				return `bytes=${value.staticBytes}`
			},
		})
		await bench('endpoint tools', 'remote handler', () => handler('tools', {}), {
			reps: depths.tiny,
			validate: (value) => `tools=${value.total}`,
		})
		await bench('endpoint logs', 'remote handler', () => handler('logs', { limit: 100 }), {
			reps: depths.tiny,
			validate: (value) => `lines=${value.lines.length}`,
		})
		snapshotMemory('remote handler')

		// -- rebuild (filesystem only) --------------------------------------
		beginGroup('rebuild')
		if (args.mode === 'fs' && args.total <= 10_000) {
			await bench('store.rebuild()', 'rebuild', () => store.rebuild(), {
				reps: 2,
				warmup: 0,
				validate: (report) => {
					if (report.files !== counts.totalFiles) throw new Error(`rebuild 扫到 ${report.files}，期望 ${counts.totalFiles}`)
					if (report.problems.length !== 0) throw new Error(`rebuild 报告 ${report.problems.length} 个问题文件`)
					return `files=${num(report.files)} links=${num(report.links)}`
				},
			})
		} else if (args.mode === 'fs') {
			skipped('store.rebuild()', 'rebuild', '100k 档用 open.cold 覆盖同一 scan+rebuild 路径（省一次全库扫描）')
		} else {
			skipped('store.rebuild()', 'rebuild', 'db 模式没有边车；下面两项测量索引侧的批量重建')
		}
		// The index build itself, isolated from the file-system walk: this is the
		// number the "1M index construction" target is about.
		await bench('db.rebuildFts()', 'rebuild', () => store.db.rebuildFts(), {
			reps: 1,
			warmup: 0,
			validate: (rows) => {
				if (rows !== counts.totalFiles) throw new Error(`FTS 重建 ${rows} 行 ≠ ${counts.totalFiles}`)
				return `fts rows=${num(rows)}`
			},
		})
		await bench('db.rebuildLinkedIds()', 'rebuild', () => store.db.rebuildLinkedIds(), {
			reps: 1,
			warmup: 0,
			validate: (rows) => `linked files=${num(rows)}`,
		})
		snapshotMemory('rebuild')
	} finally {
		store.close()
	}

	const dbBytes = await fileBytes(paths.dbPath)
	const walBytes = await fileBytes(`${paths.dbPath}-wal`)
	const shmBytes = await fileBytes(`${paths.dbPath}-shm`)
	snapshotMemory('end')
	const accounting = {
		mode: args.mode,
		modeNote: args.mode === 'db'
			? 'DB 级合成：只灌索引（files/links/tags/fts），没有 files/ 边车与载荷；open/rebuild/scan 未测量，file-read/preview 只测索引+邻居（payload 缺失）。'
			: '真实文件系统库：files/<id>/{meta.json,载荷} + system/ziyan.db，open/rebuild/scan 均测量。',
		dbBytes,
		walBytes,
		shmBytes,
		filesystemBytes: marker.bytes.payload + marker.bytes.sidecars,
		indexBuildBytes: marker.bytes.index,
		counts,
	}
	const notes = buildNotes(args, marker, paths, dbBytes + walBytes)
	const writeRow = results.find((line) => line.name === 'write.upsertRow(1)' && line.error === undefined)
	if (writeRow !== undefined && writeRow.p50Ms > 0) {
		notes.push(`单次写（DB 部分）实测 ${writeRow.p50Ms} ms：FTS 按 rowid 主键删除/插入，写成本与库大小无关；1M 行写一次不再随 N 线性变慢。`)
	}
	const ftsRow = results.find((line) => line.name === 'db.rebuildFts()' && line.error === undefined)
	if (ftsRow !== undefined && ftsRow.p50Ms > 0) {
		notes.push(`FTS 批量重建（1M 行的「索引构建」口径）实测 ${(ftsRow.p50Ms / 1000).toFixed(1)} s：一条 INSERT ... SELECT，tokenizer 是 SQL 函数。`)
	}
	if (args.mode === 'fs' && args.total > 10_000) {
		notes.push('本档不实测 store.rebuild()：open.cold 已覆盖同一 scan+rebuild 路径（10k 档另有显式 rebuild 数据）。')
	}
	return {
		tool: 'scale-lab',
		formatVersion: FORMAT,
		generatedAt: new Date().toISOString(),
		tier: args.tier,
		total: args.total,
		mode: args.mode,
		dataDir: paths.dir,
		seed: args.seed,
		days: args.days,
		reused: prepared.reused,
		node: process.version,
		platform: `${process.platform} ${process.arch}`,
		generation: {
			writeMs: round(marker.timings.writeMs, 1),
			indexMs: round(marker.timings.indexMs, 1),
			totalMs: round(marker.timings.totalMs, 1),
			indexMethod: marker.timings.indexMethod,
			perFileMs: round((marker.timings.writeMs + marker.timings.indexMs) / args.total, 4),
		},
		accounting,
		memory: {
			peakRssMB: round(peakRss / 1048576, 1),
			snapshots: memorySnapshots,
		},
		results,
		failures,
		notes,
	}
}

/**
 * The honest boundaries of this measurement.
 *
 * @param {object} args - Options.
 * @param {object} marker - The tier marker.
 * @param {object} paths - Resolved paths.
 * @param {number} indexBytes - Current index size in bytes.
 * @returns {string[]} Note lines.
 */
function buildNotes(args, marker, paths, indexBytes) {
	const notes = [
		'单进程、warm-JIT（丢弃 1–2 次预热）、同一台机器；p50/p95 反映单次调用的真实等待，ops/s = 1000/p50。',
		'RSS 在每个测量样本后采样，peakRss 包含查询的最大临时分配；不强制 GC，GC 停顿计入耗时。',
		`数据目录：${paths.dir}（清理：删除 .scratch/scale-data 或加 --purge）。`,
	]
	if (args.mode === 'db') {
		notes.push('db 模式验证：1M 行下 search/page/graph/overview/聚合与远端 handler 的 SQL 计划、复杂度与内存放大。')
		notes.push('db 模式不验证：scan()/rebuild()/冷启动（真实文件系统遍历）、目录数量与磁盘元数据成本、载荷读取——这些由 10k/100k 真实库测量，并按每文件成本线性外推。')
	}
	if (args.total >= 1_000_000 && args.mode === 'db') {
		notes.push(`索引体积 ${(indexBytes / 1048576).toFixed(0)} MB（files+links+tags+fts 合计），即 1M 行的真实磁盘下限。`)
		notes.push('若要跑真实 1M 目录库：约 1M 目录 + 2M 文件，NTFS 元数据与 Defender 扫描会让生成/重建进入十分钟到小时级；本脚本默认拒绝，需 --mode fs --force-fs。')
	}
	notes.push('sidecar 是事实、索引是派生：本脚本直接写边车再建索引（等价于首次 rebuild），不经过 create() 的原子写路径，写路径成本不在本报告内。')
	return notes
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

/**
 * Print the human report.
 *
 * @param {object} report - The report body.
 */
function printReport(report) {
	console.log('\n== scale lab ==')
	console.log(`tier=${report.tier} mode=${report.mode} files=${num(report.total)} data=${report.dataDir}`)
	console.log(`node ${report.node} / ${report.platform} / seed=${report.seed} / reused=${report.reused}`)
	console.log(`生成：写入 ${report.generation.writeMs} ms，索引 ${report.generation.indexMs} ms，合计 ${report.generation.totalMs} ms（${report.generation.perFileMs} ms/文件）`)
	console.log(`索引体积：db ${(report.accounting.dbBytes / 1048576).toFixed(1)} MB + wal ${(report.accounting.walBytes / 1048576).toFixed(1)} MB`)
	if (report.mode === 'fs') {
		const fsBytes = report.accounting.filesystemBytes
		console.log(`文件树体积：载荷+边车 ${(fsBytes / 1048576).toFixed(1)} MB，平均 ${(fsBytes / report.total).toFixed(0)} B/文件`)
	}
	const counts = report.accounting.counts
	console.log(`索引行数：files=${num(counts.totalFiles)}（活跃 ${num(counts.files)} / 归档 ${num(counts.archived)}） links=${num(counts.links)} tags=${num(counts.tags)}（${num(counts.tagAssignments)} 次挂载）`)
	console.log('')
	console.log('内存快照（MB，RSS / heapUsed / heapTotal）：')
	for (const snapshot of report.memory.snapshots) {
		console.log(`  ${snapshot.label.padEnd(20)} ${String(snapshot.rssMB).padStart(8)} / ${String(snapshot.heapUsedMB).padStart(7)} / ${String(snapshot.heapTotalMB).padStart(7)}`)
	}
	console.log(`  ${'peakRss'.padEnd(20)} ${String(report.memory.peakRssMB).padStart(8)}`)
	if (report.failures.length > 0) {
		console.log('\n失败项：')
		for (const failure of report.failures) console.log(`  - ${failure.name}: ${failure.error}`)
	} else {
		console.log('\n所有基准通过校验（行数/命中数/上限均有断言）。')
	}
	console.log('\n说明：')
	for (const line of report.notes) console.log(`  - ${line}`)
}

/** The parsed options, assigned by `main` before any benchmark runs. */
let args

/**
 * Entry point.
 *
 * @returns {Promise<void>} Resolves when the run is done.
 */
async function main() {
	args = parseArgs(process.argv.slice(2))
	const resolved = resolvePaths(args)
	const paths = { ...resolved, ...tierPaths(resolved.tierDir) }
	if (args.purge) {
		await rm(paths.dir, { recursive: true, force: true })
		note(`已删除：${paths.dir}`)
		return
	}
	const prepared = await prepare(args, paths)
	const report = await runSuite(args, paths, prepared)
	report.workerArgs = {
		tier: args.tier,
		mode: args.mode,
		reset: args.reset,
		reuse: args.reuse,
		lite: args.lite,
		dataRoot: paths.dataRoot,
	}
	if (!args.json) printReport(report)
	else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
	process.exitCode = report.failures.length === 0 ? 0 : 1
}

await main()
