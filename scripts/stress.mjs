#!/usr/bin/env node
/**
 * The stress lab: correctness under concurrency, crashes, corruption and long
 * runs, on top of the same real libraries the scale lab builds.
 *
 * `scale.mjs` answers "how fast is a query"; this script answers "does the
 * store stay correct when callers, the file system and the process misbehave".
 * Every test either asserts an invariant (the sidecars, the index and
 * `stats()` agree; nothing throws; a rebuild restores exact agreement) or
 * reports the number it measured, and a failing assertion makes the process
 * exit non-zero.
 *
 * Tests:
 *
 *   a   concurrency   8 workers x 300 mixed panel-handler calls (list, search,
 *                     paging, read, graph, overview, organize report). Zero
 *                     throws, every response validated, p50/p95 and response
 *                     bytes per call kind.
 *   b   read/write    one writer (create/update/archive/delete, 200 ops) while
 *                     four readers loop list/search/read. After: sidecar count
 *                     vs index total vs stats reconcile three ways; then
 *                     reopen (must not rebuild) and rebuild (must stay exact).
 *   c   crash         a child process writes files and is SIGKILLed. Reopen:
 *                     integrity check, every reported file readable, no index
 *                     row without a sidecar, sidecar/index content agreement,
 *                     then rebuild reaches exact agreement.
 *   d   corruption    a 100k work copy's index is overwritten with garbage.
 *                     `store.open()` must quarantine it, rebuild from
 *                     sidecars, and the rebuilt library must answer normally.
 *   e1  leak         5000 search/page/read iterations on one open store, RSS
 *                     and heap sampled every 500; growth is the assertion.
 *   e2  big-query    200 mixed queries on the real 1M tier (warm), p50/p95 per
 *                     kind plus an RSS peak.
 *   f   cold open    destructive: delete the index of a real filesystem tier
 *                     and time the scan+rebuild `open()` performs; then verify
 *                     the rebuilt index answers correctly. Only for `--mode fs`
 *                     tiers, only when explicitly selected.
 *   i   inventory    count the tier's entity folders, sample payload/sidecar
 *                     sizes, estimate the file-tree footprint and report the
 *                     index size and free space.
 *
 * Data:
 *
 *   read-only source  `.scratch/scale-data/<tier>/`   (built by scale.mjs)
 *   working copies    `.scratch/stress-data/<tier>/`  (built from the source;
 *                      kept for reuse, `--fresh` recopies, `--purge` deletes)
 *
 * The script refuses any data root outside `.scratch/scale-data` /
 * `.scratch/stress-data`, refuses to touch `~/.dsh/ziyan`, and never writes to
 * the source tier. Mutating tests (b, c, d) run on copies only; `f` is the one
 * destructive test and it deletes only a rebuildable derived index.
 *
 * Usage:
 *
 *   node scripts/stress.mjs --tier 100k                 # a,b,c,d,e1
 *   node scripts/stress.mjs --tier 100k --json > out.json
 *   node scripts/stress.mjs --tier 100k --only a,e1     # subset
 *   node scripts/stress.mjs --tier 100k --fresh         # recopy the work copy
 *   node scripts/stress.mjs --tier 100k --keep          # keep crash sandboxes
 *   node scripts/stress.mjs --tier 100k --purge         # delete the work root
 *   node scripts/stress.mjs --tier 100k --only i        # file-tree inventory
 *   node scripts/stress.mjs --tier 1m --only e2         # 200 mixed queries
 *   node scripts/stress.mjs --tier 1m --only f          # destructive cold open
 */

import { spawn } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { INDEX_SCHEMA } from '../src/db.js'
import { createZiyanHandler } from '../src/remote.js'
import { FileStore } from '../src/store.js'

/** The repo root (this file lives in `<root>/scripts`). */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The only place the scale lab may have written data. */
const DEFAULT_SCALE_ROOT = join(ROOT, '.scratch', 'scale-data')

/** Where this script keeps its working copies and crash sandboxes. */
const DEFAULT_WORK_ROOT = join(ROOT, '.scratch', 'stress-data')

/** Supported tiers, named exactly like scale.mjs. */
const TIERS = { '100k': 100_000, '1m': 1_000_000 }

/** The keyword every generated library is guaranteed to contain. */
const KEYWORD = '缓存命中'

/** A tag root every generated library carries. */
const TAG_ROOT = '工作/项目'

/** Tests that may be selected with `--only`. */
const TEST_NAMES = ['a', 'b', 'c', 'd', 'e1', 'e2', 'f', 'i']

/** Per-tier default test set: the 1M tier is too big for the copy-based tests. */
const DEFAULT_ONLY = {
	'100k': ['a', 'b', 'c', 'd', 'e1'],
	'1m': ['e2'],
}

/** Nothing may collide with the live library. */
const REAL_DATA_DIR = resolve(join(homedir(), '.dsh', 'ziyan'))

/** The child program the crash test runs and kills (written into the work root). */
const CHILD_SOURCE = `
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dataDir = process.argv[2]
const repoRoot = process.argv[3]
const progressPath = process.argv[4]
const report = (line) => {
	try { appendFileSync(progressPath, line + '\\n') } catch {}
}

try {
	const { FileStore } = await import(pathToFileURL(join(repoRoot, 'src', 'store.js')).href)
	report('BOOT')
	const store = new FileStore({ dataDir })
	await store.open()
	report('OPENED')
	for (let index = 0; index < 1000000; index += 1) {
		const file = await store.create({
			name: 'crash-' + String(index).padStart(4, '0') + '.txt',
			description: '崩溃恢复压测：写入第 ' + index + ' 个文件时进程被 SIGKILL。',
			tags: ['测试/压测'],
			content: 'crash payload ' + index + '\\n',
		})
		report('DONE ' + index + ' ' + file.id)
	}
} catch (error) {
	report('FAIL ' + (error instanceof Error ? error.message : String(error)))
}
`

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
		tier: '100k',
		scaleRoot: DEFAULT_SCALE_ROOT,
		workRoot: DEFAULT_WORK_ROOT,
		only: null,
		json: false,
		keep: false,
		fresh: false,
		purge: false,
		rounds: 3,
		targetWrites: 25,
		workers: 8,
		calls: 300,
		writes: 200,
		readers: 4,
		leakIterations: 5000,
		bigQueries: 200,
	}
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		const take = () => argv[index += 1]
		if (arg === '--tier') options.tier = String(take())
		else if (arg === '--scale-root') options.scaleRoot = String(take())
		else if (arg === '--work-root') options.workRoot = String(take())
		else if (arg === '--only') options.only = String(take()).split(',').map((name) => name.trim()).filter((name) => name !== '')
		else if (arg === '--rounds') options.rounds = Number(take())
		else if (arg === '--target-writes') options.targetWrites = Number(take())
		else if (arg === '--workers') options.workers = Number(take())
		else if (arg === '--calls') options.calls = Number(take())
		else if (arg === '--writes') options.writes = Number(take())
		else if (arg === '--readers') options.readers = Number(take())
		else if (arg === '--leak-iterations') options.leakIterations = Number(take())
		else if (arg === '--big-queries') options.bigQueries = Number(take())
		else if (arg === '--json') options.json = true
		else if (arg === '--keep') options.keep = true
		else if (arg === '--fresh') options.fresh = true
		else if (arg === '--purge') options.purge = true
		else if (arg === '--help' || arg === '-h') {
			console.log([
				'用法：node scripts/stress.mjs [options]',
				'',
				'  --tier 100k|1m        源数据档位（默认 100k；需先由 scale.mjs 生成）',
				'  --only a,b,c,d,e1,e2,f,i  只跑指定项（默认：100k→a,b,c,d,e1；1m→e2）',
				'  --json                只输出 JSON（进度走 stderr）',
				'  --fresh               重建工作副本（b/c/d 用的 100k 拷贝）',
				'  --keep                保留崩溃沙箱目录（默认跑完删除）',
				'  --purge               只删除本工具的工作数据，不跑测试',
				'  --rounds N            崩溃测试轮数（默认 3）',
				'  --target-writes N     崩溃前要求子进程写完的文件数（默认 25）',
				'  --workers N           a 的并发 worker 数（默认 8）',
				'  --calls N             每个 worker 的调用数（默认 300）',
				'  --writes N            b 的写者操作数（默认 200）',
				'  --readers N           b 的读者数（默认 4）',
				'  --leak-iterations N   e1 的循环数（默认 5000）',
				'  --big-queries N       e2 的混合查询数（默认 200）',
				'',
				'说明：b/c/d 只做 100k 档（要复制一份 100k 真库）；f 会删掉 --tier 档的索引',
				'（可从边车重建），只建在 --mode fs 的真实文件系统库上用。',
				'',
				'示例：node scripts/stress.mjs --tier 100k --json > .scratch/stress-100k.json',
			].join('\n'))
			process.exit(0)
		} else {
			throw new Error(`未知参数：${arg}（--help 看用法）`)
		}
	}
	if (!(options.tier in TIERS)) throw new Error(`未知档位：${options.tier}（可选：${Object.keys(TIERS).join(' / ')}）`)
	if (options.only === null) options.only = DEFAULT_ONLY[options.tier]
	for (const name of options.only) {
		if (!TEST_NAMES.includes(name)) throw new Error(`未知测试项：${name}（可选：${TEST_NAMES.join(' ')}）`)
	}
	for (const [name, value] of [['rounds', options.rounds], ['targetWrites', options.targetWrites], ['workers', options.workers], ['calls', options.calls], ['writes', options.writes], ['readers', options.readers], ['leakIterations', options.leakIterations], ['bigQueries', options.bigQueries]]) {
		if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} 必须是正数。`)
	}
	options.rounds = Math.max(1, Math.round(options.rounds))
	options.targetWrites = Math.max(3, Math.round(options.targetWrites))
	options.workers = Math.max(1, Math.round(options.workers))
	options.calls = Math.max(1, Math.round(options.calls))
	options.writes = Math.max(8, Math.round(options.writes))
	options.readers = Math.max(1, Math.round(options.readers))
	options.leakIterations = Math.max(10, Math.round(options.leakIterations))
	options.bigQueries = Math.max(7, Math.round(options.bigQueries))
	return options
}

/**
 * Resolve and validate every path this script touches.
 *
 * @param {object} args - The parsed options.
 * @returns {{scaleRoot: string, workRoot: string, sourceDir: string, workDir: string}} The paths.
 */
function resolvePaths(args) {
	const scaleRoot = resolve(args.scaleRoot)
	if (basename(scaleRoot) !== 'scale-data') throw new Error(`--scale-root 必须以 scale-data 结尾：${scaleRoot}`)
	const workRoot = resolve(args.workRoot)
	if (basename(workRoot) !== 'stress-data') throw new Error(`--work-root 必须以 stress-data 结尾：${workRoot}`)
	const sourceDir = resolve(scaleRoot, args.tier)
	const workDir = resolve(workRoot, args.tier)
	const clash = (left, right) => left === right || left.startsWith(right + sep) || right.startsWith(left + sep)
	const home = resolve(homedir())
	for (const dir of [sourceDir, workDir]) {
		if (clash(dir, REAL_DATA_DIR)) throw new Error(`拒绝操作真实数据目录：${dir} 与 ${REAL_DATA_DIR} 重叠。`)
		const tooWide = dir === ROOT || dir === home || ROOT.startsWith(dir + sep) || home.startsWith(dir + sep)
		if (tooWide) throw new Error(`拒绝操作过宽的数据目录：${dir}`)
	}
	return { scaleRoot, workRoot, sourceDir, workDir }
}

/** The parsed options, assigned by `main` before any test runs. */
let args

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Progress goes to stderr so `--json` keeps stdout parseable. */
function note(message) {
	process.stderr.write(`${message}\n`)
}

/** The highest RSS observed while sampling. */
let peakRss = 0

/** Sample RSS and remember the peak. */
function samplePeak() {
	const rss = process.memoryUsage().rss
	if (rss > peakRss) peakRss = rss
	return round(rss / 1048576, 1)
}

/** Round to `digits` decimals without float noise. */
const round = (value, digits = 3) => Number(Number(value).toFixed(digits))

/** A number with a thousand separator, for progress lines. */
const num = (value) => Number(value).toLocaleString('en-US')

/** One percentile over sorted samples (nearest-rank, same as scale.mjs). */
function percentile(sorted, fraction) {
	if (sorted.length === 0) return 0
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
	return sorted[index]
}

/** The JSON byte size of one handler result: the panel really pays this. */
function payloadBytes(value) {
	return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
}

/** Let the event loop turn: readers and writers interleave on awaits anyway. */
const yieldLoop = () => new Promise((resolveTurn) => setImmediate(resolveTurn))

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/**
 * Run `worker(0..total-1)` with bounded concurrency.
 *
 * @param {number} total - Work items.
 * @param {number} concurrency - In-flight cap.
 * @param {(index: number) => Promise<void>} worker - The work.
 * @returns {Promise<void>} Resolves when the pool drains.
 */
async function runPool(total, concurrency, worker) {
	let cursor = 0
	const lanes = Math.min(Math.max(1, concurrency), Math.max(1, total))
	const runners = Array.from({ length: lanes }, async () => {
		for (;;) {
			const index = cursor
			cursor += 1
			if (index >= total) return
			await worker(index)
		}
	})
	await Promise.all(runners)
}

/** Read JSON, undefined when absent or unparsable. */
async function readJson(path) {
	const text = await readFile(path, 'utf8').catch(() => undefined)
	if (text === undefined) return undefined
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

/** Byte size of one file, 0 when absent. */
async function fileBytes(path) {
	return stat(path).then((info) => Number(info.size), () => 0)
}

/** The stub dependencies a mounted panel handler needs, matching scale.mjs. */
function handlerDeps(store, dataDir) {
	return {
		store,
		settings: { publicView: () => ({ descriptionMaxChars: 160, maxFileBytes: 25 * 1024 * 1024, readTextBytes: 256 * 1024 }) },
		logs: { info() {}, warn() {}, error() {} },
		root: dataDir,
		version: 'stress-lab',
		data: { status: () => ({}) },
		tools: [],
		organize: { status: () => ({ report: { available: true }, running: false }) },
	}
}

// ---------------------------------------------------------------------------
// source facts (the immutable tier description)
// ---------------------------------------------------------------------------

/**
 * Read the tier marker and check it was built by the current index schema.
 *
 * @param {string} dir - The tier directory.
 * @returns {Promise<object>} The marker.
 */
async function readMarker(dir) {
	const marker = await readJson(join(dir, '.scale-marker.json'))
	if (marker === undefined) {
		throw new Error(`源数据缺少 .scale-marker.json：${dir}（先用 scale.mjs --tier <tier> 生成）`)
	}
	if (marker.indexSchema !== undefined && marker.indexSchema !== INDEX_SCHEMA) {
		throw new Error(`源数据索引版本 ${marker.indexSchema} ≠ 当前 ${INDEX_SCHEMA}：先重新生成 ${dir}`)
	}
	return marker
}

/**
 * The expected counts of one tier.
 *
 * @param {object} marker - The tier marker.
 * @returns {{total: number, live: number, archived: number, mode: string}} The facts.
 */
function factsOf(marker) {
	const counts = marker.counts ?? {}
	if (!Number.isFinite(Number(counts.totalFiles))) throw new Error('marker.counts.totalFiles 缺失：数据不完整。')
	return {
		total: Number(counts.totalFiles),
		live: Number(counts.files ?? counts.totalFiles),
		archived: Number(counts.archived ?? 0),
		mode: String(marker.mode ?? 'fs'),
	}
}

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------

/** Every check the run made, so the report can show what passed and failed. */
const assertions = []

/**
 * Record one assertion.
 *
 * @param {string} name - Stable assertion id (kept in the JSON).
 * @param {boolean} condition - Whether it passed.
 * @param {string} [detail] - Human detail (measured value, expected value).
 * @returns {boolean} The condition.
 */
function expect(name, condition, detail = '') {
	const ok = Boolean(condition)
	assertions.push({ name, ok, detail: String(detail) })
	if (!ok) note(`  ✗ 断言失败：${name}${detail === '' ? '' : `（${detail}）`}`)
	return ok
}

// ---------------------------------------------------------------------------
// a) concurrent panel handler calls
// ---------------------------------------------------------------------------

/**
 * The mixed handler workload the panel really causes: page, search, deep page,
 * read, graph, overview, organize report and tag filtering.
 *
 * @param {object} seeds - `{ids, live, total}`.
 * @returns {Array<object>} Call definitions.
 */
function callMix(seeds) {
	const page = () => ({ endpoint: 'file-list', kind: 'page', payload: () => ({ limit: 50 }) })
	const search = () => ({ endpoint: 'file-list', kind: 'search', payload: () => ({ query: KEYWORD, limit: 50 }) })
	const tag = () => ({ endpoint: 'file-list', kind: 'tag', payload: () => ({ tags: [TAG_ROOT], limit: 50 }) })
	const deep = () => ({ endpoint: 'file-list', kind: 'page-deep', payload: (index) => ({ limit: 50, offset: (index * 911) % Math.max(1, seeds.live - 50) }) })
	const read = () => ({ endpoint: 'file-read', kind: 'read', payload: (index) => ({ id: seeds.ids[index % seeds.ids.length] }) })
	const graph = () => ({ endpoint: 'graph', kind: 'graph', payload: () => ({}) })
	const overview = () => ({ endpoint: 'overview', kind: 'overview', payload: () => ({}) })
	return [page(), search(), read(), graph(), overview(), tag(), deep(), page(), search(), read(), { endpoint: '', kind: 'organize-report' }, page()]
}

/**
 * Validate one handler result; throw with a readable reason when it lies.
 *
 * @param {string} kind - The call kind.
 * @param {any} value - The result.
 * @param {object} seeds - `{ids, live, total}`.
 * @returns {void}
 */
function validateCall(kind, value, seeds) {
	if (value === undefined || value === null) throw new Error('返回 undefined/null')
	if (kind === 'page' || kind === 'page-deep' || kind === 'tag') {
		if (Number(value.total) <= 0) throw new Error(`total=${value.total}`)
		if (kind !== 'tag' && Number(value.total) !== seeds.live) throw new Error(`total=${value.total} 期望 ${seeds.live}`)
		if (!Array.isArray(value.files) || value.files.length === 0) throw new Error('files 为空')
		return
	}
	if (kind === 'search') {
		if (!Array.isArray(value.files) || value.files.length === 0) throw new Error('搜索零命中')
		return
	}
	if (kind === 'read') {
		if (value.missing === true) throw new Error('payload 缺失')
		if (typeof value.id !== 'string' || value.id === '') throw new Error('read 没有 id')
		if (value.neighbors === undefined) throw new Error('read 没有 neighbors')
		return
	}
	if (kind === 'graph') {
		if (!Array.isArray(value.nodes) || value.nodes.length === 0) throw new Error('graph 没有节点')
		return
	}
	if (kind === 'overview') {
		if (Number(value.stats?.files) !== seeds.live) throw new Error(`overview.stats.files=${value.stats?.files} 期望 ${seeds.live}`)
		if (!Array.isArray(value.tags) || value.tags.length === 0) throw new Error('overview.tags 为空')
		return
	}
	if (kind === 'organize-report') {
		if (Number(value.files?.files) !== seeds.live) throw new Error(`organizeReport.files=${value.files?.files} 期望 ${seeds.live}`)
	}
}

/**
 * a) 8 workers x 300 mixed handler calls: zero throws, validated payloads.
 *
 * @param {object} env - The resolved environment.
 * @param {object} facts - The tier facts.
 * @returns {Promise<object>} The test result.
 */
async function testConcurrency(env, facts) {
	note('a) 并发接口：打开 100k 源数据（只读）…')
	const store = new FileStore({ dataDir: env.sourceDir })
	const opened = performance.now()
	await store.open()
	const openMs = round(performance.now() - opened, 1)
	const total = store.db.total()
	const live = store.stats().files
	const seeds = { ids: store.db.page({ limit: 10 }).rows.map((row) => row.id), live, total }
	const handler = createZiyanHandler(handlerDeps(store, env.sourceDir))
	const mix = callMix(seeds)
	const byKind = new Map()
	for (const item of mix) {
		if (!byKind.has(item.kind)) byKind.set(item.kind, { kind: item.kind, endpoint: item.endpoint, count: 0, errors: [], latencies: [], bytes: [] })
	}
	const errors = []
	const validationFailures = []
	const started = performance.now()
	const worker = async (workerIndex) => {
		for (let step = 0; step < args.calls; step += 1) {
			const slot = (workerIndex * 3 + step) % mix.length
			const item = mix[slot]
			const bucket = byKind.get(item.kind)
			const payload = item.payload === undefined ? {} : item.payload(step)
			const began = performance.now()
			try {
				const value = item.endpoint === ''
					? await store.organizeReport({ staleDays: 90, sample: 5 })
					: await handler(item.endpoint, payload)
				const elapsed = performance.now() - began
				bucket.count += 1
				bucket.latencies.push(elapsed)
				bucket.bytes.push(payloadBytes(value))
				validateCall(item.kind, value, seeds)
			} catch (caught) {
				const elapsed = performance.now() - began
				bucket.count += 1
				bucket.latencies.push(elapsed)
				const message = caught instanceof Error ? caught.message : String(caught)
				bucket.errors.push(message)
				if (errors.length < 20) errors.push({ worker: workerIndex, step, kind: item.kind, message })
				if (message.startsWith('返回') || message.includes('期望') || message.includes('为空') || message.includes('零命中') || message.includes('没有') || message.includes('缺失')) {
					if (validationFailures.length < 20) validationFailures.push({ kind: item.kind, message })
				}
			}
			if (step % 50 === 0) samplePeak()
		}
	}
	await Promise.all(Array.from({ length: args.workers }, (_, workerIndex) => worker(workerIndex)))
	const elapsedMs = round(performance.now() - started, 1)
	store.close()
	const calls = args.workers * args.calls
	const rows = [...byKind.values()].map((bucket) => {
		const sorted = [...bucket.latencies].sort((left, right) => left - right)
		const bytes = [...bucket.bytes].sort((left, right) => left - right)
		return {
			endpoint: bucket.endpoint === '' ? 'store.organizeReport' : bucket.endpoint,
			kind: bucket.kind,
			count: bucket.count,
			errors: bucket.errors.length,
			p50Ms: round(percentile(sorted, 0.5)),
			p95Ms: round(percentile(sorted, 0.95)),
			maxMs: round(sorted[sorted.length - 1] ?? 0),
			opsPerSec: round(sorted.length === 0 ? 0 : 1000 / Math.max(0.000001, percentile(sorted, 0.5)), 1),
			bytes: {
				min: bytes[0] ?? 0,
				median: bytes.length === 0 ? 0 : bytes[Math.floor(bytes.length / 2)],
				p95: percentile(bytes, 0.95),
				max: bytes[bytes.length - 1] ?? 0,
			},
		}
	})
	const result = {
		openMs,
		workers: args.workers,
		callsPerWorker: args.calls,
		totalCalls: calls,
		elapsedMs,
		callsPerSec: round(calls / Math.max(0.001, elapsedMs / 1000), 1),
		errorCount: errors.length,
		errors,
		validationFailures,
		byKind: rows,
		expected: { live, total },
		peakRssMB: round(peakRss / 1048576, 1),
	}
	expect('a: 8×300 次混合调用全部完成', rows.reduce((sum, row) => sum + row.count, 0) === calls, `calls=${calls}`)
	expect('a: 0 次抛错', errors.length === 0, `errors=${errors.length}`)
	expect('a: 所有返回通过数据校验', validationFailures.length === 0, `failures=${validationFailures.length}`)
	expect('a: 每种调用都执行过', rows.every((row) => row.count > 0), `kinds=${rows.length}`)
	expect('a: 响应大小均 > 0', rows.every((row) => row.bytes.median > 0), '')
	return result
}

// ---------------------------------------------------------------------------
// working copy of the 100k library (b and d share it)
// ---------------------------------------------------------------------------

/**
 * Build or reuse the writable copy of the source tier.
 *
 * Only the entity tree is copied: the index is rebuilt by `store.open()` on
 * first use, which also proves the sidecars alone are a complete library.
 *
 * @param {object} env - The resolved environment.
 * @param {object} marker - The source tier marker.
 * @returns {Promise<object>} `{copyDir, reused, copyMs, files}`.
 */
async function prepareCopy(env, marker) {
	const copyDir = join(env.workDir, 'rw')
	const metaPath = join(copyDir, '.stress-copy.json')
	const expectedTotal = Number(marker.counts.totalFiles)
	const existing = await readJson(metaPath)
	const hasFiles = await stat(join(copyDir, 'files')).then((info) => info.isDirectory(), () => false)
	if (!args.fresh && hasFiles && existing?.format === 1
		&& existing.expectedTotal === expectedTotal
		&& existing.sourceMarker?.generatedAt === marker.generatedAt) {
		note(`复用工作副本：${copyDir}`)
		return { copyDir, reused: true, copyMs: 0, files: Number(existing.files ?? 0) }
	}
	note(`复制 100k 真库到工作副本（只读源不动，共 ${num(expectedTotal)} 个实体目录）…`)
	const startedCopy = performance.now()
	await rm(copyDir, { recursive: true, force: true })
	await mkdir(join(copyDir, 'files'), { recursive: true })
	const sourceFiles = join(env.sourceDir, 'files')
	const names = (await readdir(sourceFiles, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
	let files = 0
	let done = 0
	const report = Math.max(2000, Math.floor(names.length / 10))
	await runPool(names.length, 64, async (index) => {
		const id = names[index]
		const from = join(sourceFiles, id)
		const to = join(copyDir, 'files', id)
		await mkdir(to)
		const entries = await readdir(from)
		for (const name of entries) await copyFile(join(from, name), join(to, name))
		files += entries.length
		done += 1
		if (done % report === 0) note(`  复制 ${done}/${names.length}（${Math.round(performance.now() - startedCopy)} ms）`)
	})
	const copyMs = round(performance.now() - startedCopy, 1)
	await writeFile(metaPath, `${JSON.stringify({
		format: 1,
		copiedAt: new Date().toISOString(),
		sourceMarker: { tier: marker.tier, generatedAt: marker.generatedAt, indexSchema: marker.indexSchema },
		expectedTotal,
		files,
		copyMs,
	}, null, '\t')}\n`)
	note(`工作副本就绪：${num(files)} 个文件，${copyMs} ms`)
	return { copyDir, reused: false, copyMs, files }
}

// ---------------------------------------------------------------------------
// b) read/write concurrency + three-way reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile the four views of one library: entity folders on disk, scan
 * entries (validated sidecars), index rows and `stats()`.
 *
 * @param {FileStore} store - An open store.
 * @param {string} label - Where in the test this ran.
 * @returns {Promise<object>} The reconciliation, including the id sets.
 */
async function reconcile(store, label) {
	const started = performance.now()
	const scan = await store.scan()
	const scanMs = round(performance.now() - started, 1)
	const rawDirs = (await readdir(store.filesDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length
	const indexIds = store.db.ids()
	const indexTotal = store.db.total()
	const stats = store.stats()
	const scanSet = new Set(scan.entries.map((entry) => entry.meta.id))
	const indexSet = new Set(indexIds)
	let missingInIndex = 0
	for (const entry of scan.entries) if (!indexSet.has(entry.meta.id)) missingInIndex += 1
	let missingInScan = 0
	for (const id of indexIds) if (!scanSet.has(id)) missingInScan += 1
	return {
		label,
		scanMs,
		rawDirs,
		scanEntries: scan.entries.length,
		scanProblems: scan.problems.length,
		problemSample: scan.problems.slice(0, 5),
		indexTotal,
		statsFiles: stats.files,
		statsArchived: stats.archived,
		statsSum: stats.files + stats.archived,
		missingInIndex,
		missingInScan,
		scanSet,
		indexSet,
	}
}

/** Strip the id sets before the reconciliation goes into the JSON report. */
function summarizeReconcile(entry) {
	const { scanSet, indexSet, ...summary } = entry
	return summary
}

/**
 * b) one writer + four readers, then a three-way reconciliation.
 *
 * The writer performs 200 mixed operations; update/archive/delete target only
 * the files it created (so the copy ends at its original 100k rows), while ten
 * of the update/archive slots touch pre-existing files and are restored
 * afterwards, so they exercise maintenance of already-indexed rows too.
 *
 * @param {object} env - The resolved environment.
 * @param {object} marker - The source tier marker.
 * @param {object} facts - The tier facts.
 * @returns {Promise<object>} The test result.
 */
async function testReadWrite(env, marker, facts) {
	const copy = await prepareCopy(env, marker)
	note('b) 读写并发：打开工作副本…')
	const store = new FileStore({ dataDir: copy.copyDir })
	const opened = performance.now()
	await store.open()
	const openMs = round(performance.now() - opened, 1)
	if (store.db.total() !== facts.total) {
		note(`  副本索引 ${store.db.total()} ≠ ${facts.total}，先从边车重建…`)
		await store.rebuild()
	}
	const expectedLive = store.stats().files
	const preexisting = store.db.page({ limit: 500 }).rows.filter((row) => row.archived === false).slice(0, 10).map((row) => row.id)
	const originals = preexisting.map((id) => {
		const meta = store.db.get(id)
		return { id, description: meta.description, archived: meta.archived === true }
	})
	const readerIds = store.db.page({ limit: 200 }).rows.filter((row) => row.archived === false).slice(0, 120).map((row) => row.id)
	if (readerIds.length === 0) throw new Error('b: 找不到可读的种子文件。')

	const writer = { ops: 0, errors: [], byKind: { create: 0, update: 0, archive: 0, delete: 0 }, latencies: [] }
	const readers = { loops: [], errors: [], ops: 0 }
	let stopReaders = false

	const readerLoop = async () => {
		const loop = { ops: 0, errors: [], byKind: { list: 0, search: 0, read: 0 } }
		while (!stopReaders) {
			const slot = loop.ops % 3
			const began = performance.now()
			try {
				if (slot === 0) {
					await store.list({ limit: 50, offset: (loop.ops * 37) % 5000 })
					loop.byKind.list += 1
				} else if (slot === 1) {
					await store.list({ query: KEYWORD, limit: 50 })
					loop.byKind.search += 1
				} else {
					const file = await store.read(readerIds[loop.ops % readerIds.length], { text: false, neighbors: true })
					if (file === undefined) throw new Error('读者读到的文件消失')
					loop.byKind.read += 1
				}
				loop.ops += 1
				readers.ops += 1
			} catch (caught) {
				const message = caught instanceof Error ? caught.message : String(caught)
				loop.errors.push(message)
				if (readers.errors.length < 20) readers.errors.push(message)
				if (loop.errors.length > 5) break
			}
			if (loop.ops % 40 === 0) samplePeak()
			await yieldLoop()
		}
		readers.loops.push(loop)
	}

	const created = []
	const liveCreated = []
	const deleted = []
	const presetUpdate = new Set([5, 13, 21, 29, 37])
	const presetArchive = new Set([6, 14, 22, 30, 38])
	const writerStarted = performance.now()
	const readerPromises = Array.from({ length: args.readers }, () => readerLoop())
	try {
		for (let step = 0; step < args.writes; step += 1) {
			const kind = ['create', 'update', 'archive', 'delete'][step % 4]
			const began = performance.now()
			try {
				if (kind === 'create') {
					const file = await store.create({
						name: `stress-${String(step).padStart(3, '0')}.txt`,
						description: `并发读写压测临时文件 ${step}：写者创建、读者同时读库。`,
						tags: ['测试/压测'],
						content: `stress payload ${step}\n`,
					})
					created.push(file.id)
					liveCreated.push(file.id)
				} else if (kind === 'update') {
					if (presetUpdate.has(step)) {
						const target = preexisting[step % preexisting.length]
						await store.update(target, { description: `并发压测改写：第 ${step} 次写者操作（结束会还原）。` })
					} else {
						const target = liveCreated[step % liveCreated.length]
						await store.update(target, { description: `并发读写压测临时文件 ${step}（已更新）。`, tags: ['测试/压测', '类型/文档'] })
					}
				} else if (kind === 'archive') {
					if (presetArchive.has(step)) {
						await store.archive(preexisting[step % preexisting.length], true)
					} else {
						const target = liveCreated[(step + 1) % liveCreated.length]
						await store.archive(target, step % 8 === 2)
					}
				} else {
					const target = liveCreated.shift()
					if (target === undefined) throw new Error('删除时没有可删的临时文件')
					await store.remove(target)
					deleted.push(target)
				}
				writer.ops += 1
				writer.byKind[kind] += 1
				writer.latencies.push(performance.now() - began)
			} catch (caught) {
				const message = caught instanceof Error ? caught.message : String(caught)
				if (writer.errors.length < 20) writer.errors.push(`${kind}#${step}: ${message}`)
			}
			await yieldLoop()
		}
	} finally {
		stopReaders = true
		await Promise.all(readerPromises)
	}
	const writerMs = round(performance.now() - writerStarted, 1)

	// Restore the ten pre-existing files touched above: the copy can then be
	// reused by the next run without hidden drift.
	for (const original of originals) {
		try {
			await store.update(original.id, { description: original.description })
			// Always write the archived flag back: the writer archived five of
			// these files, and an update() without the field would keep the
			// archived state instead of restoring it.
			await store.archive(original.id, original.archived === true)
		} catch (caught) {
			writer.errors.push(`restore ${original.id}: ${caught instanceof Error ? caught.message : String(caught)}`)
		}
	}

	const before = await reconcile(store, 'b:after-writer')
	const writerSorted = [...writer.latencies].sort((left, right) => left - right)
	store.close()

	note('b) 重开工作副本（不应触发重建）…')
	const reopenedStore = new FileStore({ dataDir: copy.copyDir })
	const reopenStarted = performance.now()
	await reopenedStore.open()
	const reopenMs = round(performance.now() - reopenStarted, 1)
	const reopened = await reconcile(reopenedStore, 'b:reopened')
	note('b) 显式 rebuild 后再对账…')
	const rebuildStarted = performance.now()
	const rebuild = await reopenedStore.rebuild()
	const rebuildMs = round(performance.now() - rebuildStarted, 1)
	const rebuilt = await reconcile(reopenedStore, 'b:rebuilt')
	const searchAfter = await reopenedStore.list({ query: KEYWORD, limit: 10 })
	const pageAfter = await reopenedStore.list({ limit: 50 })
	reopenedStore.close()

	const result = {
		copy: { reused: copy.reused, copyMs: copy.copyMs, files: copy.files, dir: copy.copyDir },
		openMs,
		expected: { total: facts.total, live: expectedLive },
		writer: {
			ops: writer.ops,
			expectedOps: args.writes,
			errors: writer.errors,
			byKind: writer.byKind,
			created: created.length,
			deleted: deleted.length,
			elapsedMs: writerMs,
			p50Ms: round(percentile(writerSorted, 0.5)),
			p95Ms: round(percentile(writerSorted, 0.95)),
		},
		readers: {
			count: args.readers,
			ops: readers.ops,
			errors: readers.errors,
			loops: readers.loops.map((loop) => ({ ops: loop.ops, byKind: loop.byKind, errors: loop.errors.length })),
		},
		reconcile: {
			afterWriter: summarizeReconcile(before),
			reopened: summarizeReconcile(reopened),
			rebuilt: summarizeReconcile(rebuilt),
		},
		reopenMs,
		rebuild: { ms: rebuildMs, files: rebuild.files, links: rebuild.links, tags: rebuild.tags, problems: rebuild.problems.length },
		afterRebuildSearchHits: searchAfter.files.length,
		afterRebuildPageTotal: pageAfter.total,
	}
	const expectedLiveAfter = expectedLive
	expect('b: 写者完成全部操作且 0 抛错', writer.ops === args.writes && writer.errors.length === 0, `ops=${writer.ops}/${args.writes} errors=${writer.errors.length}`)
	expect('b: 四个读者都在循环且 0 抛错', readers.loops.length === args.readers && readers.errors.length === 0 && readers.ops > 0, `loops=${readers.loops.length} ops=${readers.ops} errors=${readers.errors.length}`)
	for (const [label, entry] of [['写后', before], ['重开', reopened], ['rebuild 后', rebuilt]]) {
		expect(`b: ${label} 磁盘目录数 = ${facts.total}`, entry.rawDirs === facts.total, `${entry.rawDirs}`)
		expect(`b: ${label} 边车扫描数 = ${facts.total}`, entry.scanEntries === facts.total, `${entry.scanEntries}`)
		expect(`b: ${label} 索引总数 = ${facts.total}`, entry.indexTotal === facts.total, `${entry.indexTotal}`)
		expect(`b: ${label} stats 合计 = ${facts.total}`, entry.statsSum === facts.total, `${entry.statsFiles}+${entry.statsArchived}=${entry.statsSum}`)
		expect(`b: ${label} 边车全部入索引`, entry.missingInIndex === 0, `${entry.missingInIndex}`)
		expect(`b: ${label} 索引没有无主行`, entry.missingInScan === 0, `${entry.missingInScan}`)
		expect(`b: ${label} 扫描无坏记录`, entry.scanProblems === 0, `${entry.scanProblems}`)
	}
	expect('b: 重开没有触发全量 rebuild（open < 5s）', reopenMs < 5000, `${reopenMs} ms`)
	expect('b: 删除的临时文件不在磁盘也不在索引', deleted.every((id) => !before.scanSet.has(id) && !before.indexSet.has(id)), `${deleted.length} 个`)
	expect('b: rebuild 后活跃数不变', rebuilt.statsSum === facts.total && rebuilt.statsFiles === expectedLiveAfter, `${rebuilt.statsFiles}/${facts.total}`)
	expect('b: rebuild 后搜索正常', searchAfter.files.length > 0, `hits=${searchAfter.files.length}`)
	expect('b: rebuild 后分页总数正确', pageAfter.total === expectedLiveAfter, `${pageAfter.total} 期望 ${expectedLiveAfter}`)
	expect('b: rebuild 报告无问题文件', rebuild.problems.length === 0, `${rebuild.problems.length}`)
	return result
}

// ---------------------------------------------------------------------------
// c) SIGKILL crash recovery
// ---------------------------------------------------------------------------

/**
 * c) A child process writes files and is SIGKILLed; the reopened store must
 * expose every acknowledged file, keep the index rows and sidecars in
 * agreement (or at most one acknowledged-but-unindexed row, which the design
 * documents as "costs a rebuild, not a file"), and reach exact agreement after
 * an explicit rebuild.
 *
 * @param {object} env - The resolved environment.
 * @returns {Promise<object>} The test result.
 */
async function testCrash(env) {
	const sandboxRoot = join(env.workDir, 'crash')
	await mkdir(sandboxRoot, { recursive: true })
	const childPath = join(sandboxRoot, 'crash-child.mjs')
	await writeFile(childPath, `${CHILD_SOURCE.trimStart()}\n`)
	const rounds = []
	for (let roundIndex = 0; roundIndex < args.rounds; roundIndex += 1) {
		const dataDir = join(sandboxRoot, `round-${roundIndex}`)
		const progressPath = join(sandboxRoot, `round-${roundIndex}.progress.log`)
		await rm(dataDir, { recursive: true, force: true })
		await rm(progressPath, { force: true })
		await mkdir(dataDir, { recursive: true })
		note(`c) 崩溃恢复第 ${roundIndex + 1}/${args.rounds} 轮：子进程写 ${args.targetWrites} 个文件后 SIGKILL…`)
		const child = spawn(process.execPath, [childPath, dataDir, ROOT, progressPath], { stdio: 'ignore', windowsHide: true })
		const started = performance.now()
		let killed = false
		let exited = null
		const exitPromise = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })))
		for (;;) {
			const text = await readFile(progressPath, 'utf8').catch(() => '')
			const lines = text.split('\n').filter((line) => line.trim() !== '')
			const done = lines.filter((line) => line.startsWith('DONE ')).length
			if (lines.some((line) => line.startsWith('FAIL '))) break
			if (done >= args.targetWrites) {
				child.kill('SIGKILL')
				killed = true
				break
			}
			if (child.exitCode !== null) break
			if (performance.now() - started > 30_000) {
				child.kill('SIGKILL')
				killed = true
				break
			}
			await sleep(5)
		}
		const killMs = round(performance.now() - started, 1)
		exited = await Promise.race([exitPromise, sleep(5000).then(() => ({ timeout: true }))])
		const progressText = await readFile(progressPath, 'utf8').catch(() => '')
		const progressLines = progressText.split('\n').filter((line) => line.trim() !== '')
		const reported = progressLines.filter((line) => line.startsWith('DONE ')).map((line) => line.split(' ')[2])
		const failed = progressLines.filter((line) => line.startsWith('FAIL '))
		note(`  已确认写入 ${reported.length} 个文件，kill=${killed}，退出=${JSON.stringify(exited)}，${killMs} ms`)

		const store = new FileStore({ dataDir })
		const reopenStarted = performance.now()
		let openError = ''
		try {
			await store.open()
		} catch (caught) {
			openError = caught instanceof Error ? caught.message : String(caught)
		}
		const openMs = round(performance.now() - reopenStarted, 1)
		const roundResult = {
			round: roundIndex,
			requestedWrites: args.targetWrites,
			reportedWrites: reported.length,
			killed,
			exit: exited,
			openError,
			openMs,
			integrity: '',
			dbTotal: 0,
			scanEntries: 0,
			scanProblems: [],
			readableReported: 0,
			missingInIndex: 0,
			missingInScan: 0,
			contentMismatches: 0,
			rebuild: null,
			afterRebuild: null,
		}
		try {
			roundResult.integrity = String(store.db.db.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown')
			const scan = await store.scan()
			const indexIds = store.db.ids()
			const indexSet = new Set(indexIds)
			const scanSet = new Set(scan.entries.map((entry) => entry.meta.id))
			roundResult.dbTotal = store.db.total()
			roundResult.scanEntries = scan.entries.length
			roundResult.scanProblems = scan.problems
			roundResult.missingInIndex = scan.entries.reduce((count, entry) => count + (indexSet.has(entry.meta.id) ? 0 : 1), 0)
			roundResult.missingInScan = indexIds.reduce((count, id) => count + (scanSet.has(id) ? 0 : 1), 0)
			for (const id of reported) {
				const file = await store.read(id, { text: true, neighbors: true })
				if (file !== undefined && file.missing !== true) roundResult.readableReported += 1
			}
			for (const entry of scan.entries) {
				const row = store.db.get(entry.meta.id)
				if (row === undefined) continue
				const sameTags = [...row.tags].sort().join('\u001f') === [...entry.meta.tags].sort().join('\u001f')
				if (row.name !== entry.meta.name || row.description !== entry.meta.description || !sameTags) roundResult.contentMismatches += 1
			}
			const rebuildStarted = performance.now()
			const report = await store.rebuild()
			const rebuildMs = round(performance.now() - rebuildStarted, 1)
			const afterScan = await store.scan()
			const afterIds = new Set(store.db.ids())
			const afterMissing = afterScan.entries.reduce((count, entry) => count + (afterIds.has(entry.meta.id) ? 0 : 1), 0)
			roundResult.rebuild = { ms: rebuildMs, files: report.files, links: report.links, problems: report.problems.length }
			roundResult.afterRebuild = { dbTotal: store.db.total(), scanEntries: afterScan.entries.length, missingInIndex: afterMissing, scanProblems: afterScan.problems.length }
			roundResult.rebuild.files = report.files
			expect(`c${roundIndex}: 重开成功且无未捕获异常`, openError === '' && store.db.total() > 0, openError)
			expect(`c${roundIndex}: SQLite integrity_check = ok`, roundResult.integrity === 'ok', roundResult.integrity)
			expect(`c${roundIndex}: 崩溃前确认写入的文件全部可读`, roundResult.readableReported === reported.length, `${roundResult.readableReported}/${reported.length}`)
			expect(`c${roundIndex}: 索引没有无主行`, roundResult.missingInScan === 0, `${roundResult.missingInScan}`)
			expect(`c${roundIndex}: 边车全部入索引（崩溃窗口最多 1 条待重建）`, roundResult.missingInIndex <= 1, `${roundResult.missingInIndex}`)
			expect(`c${roundIndex}: 索引行与边车内容一致`, roundResult.contentMismatches === 0, `${roundResult.contentMismatches}`)
			expect(`c${roundIndex}: 坏记录只有可能出现的 payload-only 孤儿（≤1）`, roundResult.scanProblems.length <= 1 && roundResult.scanProblems.every((problem) => String(problem.reason).includes('meta.json')), JSON.stringify(roundResult.scanProblems))
			expect(`c${roundIndex}: rebuild 后边车与索引完全一致`, roundResult.afterRebuild.missingInIndex === 0 && roundResult.afterRebuild.dbTotal === roundResult.afterRebuild.scanEntries, `${roundResult.afterRebuild.dbTotal}/${roundResult.afterRebuild.scanEntries}`)
			expect(`c${roundIndex}: 没有 FAIL 输出`, failed.length === 0, failed.join(';'))
		} catch (caught) {
			expect(`c${roundIndex}: 崩溃恢复检查没有抛错`, false, caught instanceof Error ? caught.message : String(caught))
		} finally {
			try { store.close() } catch {}
		}
		rounds.push(roundResult)
	}
	const result = { rounds: args.rounds, sandbox: sandboxRoot, keep: args.keep, results: rounds }
	return result
}

// ---------------------------------------------------------------------------
// d) corrupt-index recovery end to end
// ---------------------------------------------------------------------------

/**
 * d) Overwrite the 100k copy's index with garbage; `open()` must quarantine it
 * and rebuild from the sidecars.
 *
 * @param {object} env - The resolved environment.
 * @param {object} marker - The source tier marker.
 * @param {object} facts - The tier facts.
 * @returns {Promise<object>} The test result.
 */
async function testCorruption(env, marker, facts) {
	const copy = await prepareCopy(env, marker)
	const dbPath = join(copy.copyDir, 'system', 'ziyan.db')
	// The copy may never have been opened: open it once to get a valid index to
	// corrupt (and to prove the sidecars rebuild it).
	if (await fileBytes(dbPath) === 0) {
		note('d) 首次打开工作副本，先由边车建好索引…')
		const store = new FileStore({ dataDir: copy.copyDir })
		await store.open()
		store.close()
	}
	const healthyBytes = await fileBytes(dbPath)
	note(`d) 把工作副本索引（${healthyBytes} B）覆盖成垃圾字节…`)
	const garbage = Buffer.concat([Buffer.from('THIS IS NOT A SQLITE DATABASE\n', 'utf8'), Buffer.alloc(64 * 1024, 0x47)])
	await writeFile(dbPath, garbage)
	const quarantinedBefore = (await readdir(join(copy.copyDir, 'system'))).filter((name) => name.startsWith('ziyan.db.corrupt-'))
	const store = new FileStore({ dataDir: copy.copyDir })
	const started = performance.now()
	let openError = ''
	try {
		await store.open()
	} catch (caught) {
		openError = caught instanceof Error ? caught.message : String(caught)
	}
	const openMs = round(performance.now() - started, 1)
	const quarantinedAfter = (await readdir(join(copy.copyDir, 'system'))).filter((name) => name.startsWith('ziyan.db.corrupt-'))
	const result = {
		openMs,
		openError,
		healthyIndexBytes: healthyBytes,
		quarantinedBefore: quarantinedBefore.length,
		quarantinedAfter: quarantinedAfter.length,
		quarantinedNames: quarantinedAfter,
		dbTotal: 0,
		stats: null,
		page: null,
		searchHits: 0,
		readOk: false,
		scan: null,
		previewOk: false,
	}
	try {
		result.dbTotal = store.db.total()
		result.stats = store.stats()
		const page = await store.list({ limit: 50 })
		result.page = { total: page.total, files: page.files.length }
		const search = await store.list({ query: KEYWORD, limit: 50 })
		result.searchHits = search.files.length
		const seed = page.files[0]
		if (seed !== undefined) {
			const file = await store.read(seed.id, { text: true, neighbors: true })
			result.readOk = file !== undefined && file.missing !== true
			const handler = createZiyanHandler(handlerDeps(store, copy.copyDir))
			const preview = await handler('file-preview', { id: seed.id })
			result.previewOk = ['text', 'binary', 'image', 'pdf'].includes(String(preview.kind))
		}
		const scan = await store.scan()
		result.scan = { entries: scan.entries.length, problems: scan.problems.length }
		expect('d: 损坏索引后 open 不抛错', openError === '', openError)
		expect('d: 损坏的索引被隔离（.corrupt-*）', result.quarantinedAfter === result.quarantinedBefore + 1, `${result.quarantinedBefore}→${result.quarantinedAfter}`)
		expect('d: 从边车重建后索引总数正确', result.dbTotal === facts.total, `${result.dbTotal} 期望 ${facts.total}`)
		expect('d: 重建后 stats 与总数一致', result.stats.files + result.stats.archived === facts.total, `${result.stats.files}+${result.stats.archived}`)
		expect('d: 重建后分页总数与活跃数一致', result.page?.total === result.stats.files, `${result.page?.total} vs ${result.stats.files}`)
		expect('d: 重建后搜索有命中', result.searchHits > 0, `hits=${result.searchHits}`)
		expect('d: 重建后可读文件并取到邻居/预览', result.readOk && result.previewOk, `read=${result.readOk} preview=${result.previewOk}`)
		expect('d: 重建后扫描无坏记录', result.scan?.problems === 0, `${result.scan?.problems}`)
		expect('d: 重建耗时告警阈值（100k < 300s）', openMs < 300_000, `${openMs} ms`)
	} catch (caught) {
		expect('d: 损坏恢复检查没有抛错', false, caught instanceof Error ? caught.message : String(caught))
	} finally {
		try { store.close() } catch {}
	}
	return result
}

// ---------------------------------------------------------------------------
// e1) RSS leak over 5000 iterations
// ---------------------------------------------------------------------------

/**
 * e1) 5000 search/page/read iterations on one open store; RSS and heap are
 * sampled every 500 and the growth after warm-up is the assertion.
 *
 * @param {object} env - The resolved environment.
 * @param {object} facts - The tier facts.
 * @returns {Promise<object>} The test result.
 */
async function testLeak(env, facts) {
	note('e1) 长跑泄漏：打开源数据（只读）…')
	const store = new FileStore({ dataDir: env.sourceDir })
	await store.open()
	const total = store.db.total()
	const live = store.stats().files
	const ids = store.db.page({ limit: 200 }).rows.filter((row) => row.archived === false).slice(0, 100).map((row) => row.id)
	if (ids.length === 0) throw new Error('e1: 找不到可读种子。')
	const samples = []
	const usage = () => {
		samplePeak()
		const value = process.memoryUsage()
		return {
			rssMB: round(value.rss / 1048576, 1),
			heapUsedMB: round(value.heapUsed / 1048576, 1),
			externalMB: round(value.external / 1048576, 1),
		}
	}
	samples.push({ iteration: 0, ...usage() })
	const counts = { page: 0, search: 0, read: 0 }
	const started = performance.now()
	for (let iteration = 0; iteration < args.leakIterations; iteration += 1) {
		const slot = iteration % 3
		if (slot === 0) {
			await store.list({ limit: 50, offset: (iteration * 37) % Math.max(1, live - 50) })
			counts.page += 1
		} else if (slot === 1) {
			await store.list({ query: iteration % 2 === 0 ? KEYWORD : '索引重建', limit: 50 })
			counts.search += 1
		} else {
			await store.read(ids[iteration % ids.length], { text: false, neighbors: true })
			counts.read += 1
		}
		if (iteration % 500 === 499 || iteration === args.leakIterations - 1) samples.push({ iteration: iteration + 1, ...usage() })
	}
	const elapsedMs = round(performance.now() - started, 1)
	store.close()
	const baseline = samples.find((sample) => sample.iteration >= Math.min(500, args.leakIterations)) ?? samples[samples.length - 1]
	const end = samples[samples.length - 1]
	const growthRssMB = round(end.rssMB - baseline.rssMB, 1)
	const growthHeapMB = round(end.heapUsedMB - baseline.heapUsedMB, 1)
	const peak = Math.max(...samples.map((sample) => sample.rssMB))
	const result = {
		iterations: args.leakIterations,
		elapsedMs,
		opsPerSec: round(args.leakIterations / Math.max(0.001, elapsedMs / 1000), 1),
		counts,
		expected: { live, total },
		baseline,
		end,
		growthRssMB,
		growthHeapMB,
		peakRssMB: round(peak, 1),
		samples,
	}
	expect('e1: 5000 次循环 0 抛错', true, '循环内任一异常会直接中断测试')
	expect('e1: RSS 增长 < 100 MB', growthRssMB < 100, `${growthRssMB} MB（${baseline.rssMB}→${end.rssMB}）`)
	expect('e1: heapUsed 增长 < 40 MB', growthHeapMB < 40, `${growthHeapMB} MB（${baseline.heapUsedMB}→${end.heapUsedMB}）`)
	return result
}

// ---------------------------------------------------------------------------
// e2) 200 mixed queries on the 1M tier
// ---------------------------------------------------------------------------

/**
 * e2) 200 mixed queries against the warm 1M tier (page head/tail, search,
 * read, library graph, overview endpoint, stats).
 *
 * @param {object} env - The resolved environment.
 * @param {object} marker - The tier marker.
 * @param {object} facts - The tier facts.
 * @returns {Promise<object>} The test result.
 */
async function testBigQueries(env, marker, facts) {
	note(`e2) 1M 混合查询：打开 ${env.sourceDir}…`)
	const store = new FileStore({ dataDir: env.sourceDir })
	const opened = performance.now()
	await store.open()
	const openMs = round(performance.now() - opened, 1)
	const handler = createZiyanHandler(handlerDeps(store, env.sourceDir))
	const stats = store.stats()
	const total = store.db.total()
	const live = stats.files
	const seed = store.db.page({ limit: 1 }).rows[0]?.id
	const kinds = [
		{ kind: 'page(first)', run: () => store.list({ limit: 50 }) },
		{ kind: 'page(tail)', run: () => store.list({ limit: 50, offset: Math.max(0, live - 50) }) },
		{ kind: 'search(keyword)', run: () => store.list({ query: KEYWORD, limit: 50 }) },
		{ kind: 'read', run: () => store.read(seed, { text: true, neighbors: true }) },
		{ kind: 'library-graph', run: () => store.libraryGraph({ limit: 3000 }) },
		{ kind: 'overview', run: () => handler('overview', {}) },
		{ kind: 'stats', run: () => store.stats() },
	]
	const buckets = new Map(kinds.map((item) => [item.kind, { kind: item.kind, count: 0, latencies: [], bytes: [], errors: [] }]))
	for (let index = 0; index < args.bigQueries; index += 1) {
		const item = kinds[index % kinds.length]
		const bucket = buckets.get(item.kind)
		const began = performance.now()
		try {
			const value = await item.run()
			bucket.count += 1
			bucket.latencies.push(performance.now() - began)
			bucket.bytes.push(payloadBytes(value))
		} catch (caught) {
			bucket.count += 1
			bucket.latencies.push(performance.now() - began)
			bucket.errors.push(caught instanceof Error ? caught.message : String(caught))
		}
		if (index % 20 === 0) samplePeak()
	}
	const rows = [...buckets.values()].map((bucket) => {
		const sorted = [...bucket.latencies].sort((left, right) => left - right)
		const bytes = [...bucket.bytes].sort((left, right) => left - right)
		return {
			kind: bucket.kind,
			count: bucket.count,
			errors: bucket.errors.length,
			p50Ms: round(percentile(sorted, 0.5)),
			p95Ms: round(percentile(sorted, 0.95)),
			maxMs: round(sorted[sorted.length - 1] ?? 0),
			bytesMedian: bytes.length === 0 ? 0 : bytes[Math.floor(bytes.length / 2)],
		}
	})
	const errorCount = rows.reduce((sum, row) => sum + row.errors, 0)
	const pageFirst = await store.list({ limit: 50 })
	const search = await store.list({ query: KEYWORD, limit: 50 })
	const readFile = await store.read(seed, { text: false, neighbors: true })
	const graph = store.libraryGraph({ limit: 3000 })
	const overview = await handler('overview', {})
	store.close()
	const result = {
		openMs,
		queries: args.bigQueries,
		tier: marker.tier,
		mode: facts.mode,
		expected: { total: facts.total, live },
		measured: { total, live, pageTotal: pageFirst.total, searchHits: search.files.length, graphNodes: graph.nodes.length, overviewFiles: overview.stats.files, readOk: readFile !== undefined && readFile.missing !== true },
		errorCount,
		byKind: rows,
		peakRssMB: round(peakRss / 1048576, 1),
	}
	expect('e2: 200 次混合查询 0 抛错', errorCount === 0, `errors=${errorCount}`)
	expect('e2: 索引总数与 marker 一致', total === facts.total, `${total} 期望 ${facts.total}`)
	expect('e2: 活跃数与 overview 一致', live === facts.live && overview.stats.files === live, `${live}/${facts.live} vs ${overview.stats.files}`)
	expect('e2: 首页总数正确', pageFirst.total === live, `${pageFirst.total}`)
	expect('e2: 搜索有命中', search.files.length > 0, `hits=${search.files.length}`)
	expect('e2: 图谱有节点', graph.nodes.length > 0, `nodes=${graph.nodes.length}`)
	expect('e2: read 命中且无 missing', readFile !== undefined && readFile.missing !== true, '')
	return result
}

// ---------------------------------------------------------------------------
// f) cold open of a real filesystem tier (destructive: rebuilds the index)
// ---------------------------------------------------------------------------

/**
 * f) Delete the tier's index and time the scan+rebuild `open()` performs.
 * Destructive but rebuildable: the sidecars are the truth.
 *
 * @param {object} env - The resolved environment.
 * @param {object} marker - The tier marker.
 * @param {object} facts - The tier facts.
 * @returns {Promise<object>} The test result.
 */
async function testColdOpen(env, marker, facts) {
	if (facts.mode !== 'fs') throw new Error('f: 只适用于 mode=fs 的真实文件系统库（db 模式没有边车，无法重建）。')
	const dbPath = join(env.sourceDir, 'system', 'ziyan.db')
	const deletedBytes = await fileBytes(dbPath)
	for (const suffix of ['', '-wal', '-shm']) await rm(`${dbPath}${suffix}`, { force: true })
	note(`f) 已删除索引（${deletedBytes} B），开始冷启动 scan+rebuild…`)
	const startedOpen = performance.now()
	const store = new FileStore({ dataDir: env.sourceDir })
	await store.open()
	const openMs = round(performance.now() - startedOpen, 1)
	note(`f) 冷启动完成：${openMs} ms`)
	const handler = createZiyanHandler(handlerDeps(store, env.sourceDir))
	const stats = store.stats()
	const total = store.db.total()
	const live = stats.files
	const phases = []
	const measure = async (name, run) => {
		const began = performance.now()
		const value = await run()
		const elapsed = round(performance.now() - began, 1)
		phases.push({ name, ms: elapsed, rssMB: samplePeak() })
		return value
	}
	const first = await measure('page(first)', () => store.list({ limit: 50 }))
	const tail = await measure('page(tail)', () => store.list({ limit: 50, offset: Math.max(0, live - 50) }))
	const search = await measure('search', () => store.list({ query: KEYWORD, limit: 50 }))
	const searchSeed = search.files[0]
	const read = await measure('read', () => searchSeed === undefined ? undefined : store.read(searchSeed.id, { text: true, neighbors: true }))
	const graph = await measure('library-graph', () => store.libraryGraph({ limit: 3000 }))
	const overview = await measure('overview', () => handler('overview', {}))
	const statsValue = await measure('stats', () => store.stats())
	const idCount = await measure('ids()', () => store.db.ids().length)
	const indexBytes = await fileBytes(dbPath)
	const walBytes = await fileBytes(`${dbPath}-wal`)
	store.close()
	const result = {
		mode: facts.mode,
		deletedIndexBytes: deletedBytes,
		openMs,
		rebuiltIndexBytes: indexBytes,
		walBytes,
		expected: { total: facts.total, live: facts.live },
		measured: {
			total,
			live,
			pageFirstTotal: first.total,
			pageTailRows: tail.files.length,
			searchHits: search.files.length,
			readOk: read !== undefined && read.missing !== true,
			graphNodes: graph.nodes.length,
			overviewFiles: overview.stats.files,
			statsSum: statsValue.files + statsValue.archived,
			ids: idCount,
		},
		phases,
		peakRssMB: round(peakRss / 1048576, 1),
	}
	expect('f: 冷启动后索引总数与 marker 一致', total === facts.total, `${total} 期望 ${facts.total}`)
	expect('f: 冷启动后 stats 合计正确', result.measured.statsSum === facts.total, `${result.measured.statsSum}`)
	expect('f: 冷启动后首页总数正确', first.total === facts.live, `${first.total} 期望 ${facts.live}`)
	expect('f: 冷启动后尾页可取', tail.files.length > 0, `${tail.files.length}`)
	expect('f: 冷启动后搜索有命中', search.files.length > 0, `hits=${search.files.length}`)
	expect('f: 冷启动后 read 正常', result.measured.readOk, '')
	expect('f: 冷启动后图谱正常', graph.nodes.length > 0, `nodes=${graph.nodes.length}`)
	expect('f: 冷启动后 overview 正确', overview.stats.files === facts.live, `${overview.stats.files}`)
	expect('f: ids() 数量正确', idCount === facts.total, `${idCount}`)
	expect('f: 冷启动耗时在 60 分钟以内（1M 真库）', openMs < 3_600_000, `${openMs} ms`)
	return result
}

// ---------------------------------------------------------------------------
// i) file-tree inventory
// ---------------------------------------------------------------------------

/**
 * i) Count entity folders, sample payload/sidecar sizes, estimate the tree's
 * footprint, and report index size plus free space.
 *
 * @param {object} env - The resolved environment.
 * @param {object} marker - The tier marker.
 * @param {object} facts - The tier facts.
 * @returns {Promise<object>} The test result.
 */
async function testInventory(env, marker, facts) {
	if (facts.mode !== 'fs') throw new Error('i: 只适用于真实文件系统库。')
	const filesDir = join(env.sourceDir, 'files')
	const started = performance.now()
	const listing = await readdir(filesDir, { withFileTypes: true })
	const dirs = listing.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
	const readdirMs = round(performance.now() - started, 1)
	const sampleSize = Math.min(2000, dirs.length)
	const stride = Math.max(1, Math.floor(dirs.length / sampleSize))
	const sampled = []
	for (let index = 0; index < dirs.length; index += stride) {
		if (sampled.length >= sampleSize) break
		sampled.push(dirs[index])
	}
	let sampledFiles = 0
	let sampledBytes = 0
	let sampledAllocated = 0
	let sampledMissingMeta = 0
	await runPool(sampled.length, 16, async (index) => {
		const dir = join(filesDir, sampled[index])
		const names = await readdir(dir)
		sampledFiles += names.length
		if (!names.includes('meta.json')) sampledMissingMeta += 1
		for (const name of names) {
			const info = await stat(join(dir, name))
			sampledBytes += info.size
			sampledAllocated += Math.ceil(info.size / 4096) * 4096
		}
	})
	const perDir = sampled.length === 0 ? 0 : sampledFiles / sampled.length
	const perFileBytes = sampledFiles === 0 ? 0 : sampledBytes / sampledFiles
	const perFileAllocated = sampledFiles === 0 ? 0 : sampledAllocated / sampledFiles
	const estimate = {
		entityDirs: dirs.length,
		files: Math.round(dirs.length * perDir),
		payloadSidecarBytes: Math.round(dirs.length * perDir * perFileBytes),
		allocatedBytes: Math.round(dirs.length * perDir * perFileAllocated),
	}
	const indexBytes = await fileBytes(join(env.sourceDir, 'system', 'ziyan.db'))
	const walBytes = await fileBytes(join(env.sourceDir, 'system', 'ziyan.db-wal'))
	let freeBytes = 0
	let totalBytes = 0
	try {
		const disk = await statfs(env.sourceDir)
		freeBytes = Number(disk.bfree) * Number(disk.bsize)
		totalBytes = Number(disk.blocks) * Number(disk.bsize)
	} catch {
		freeBytes = 0
	}
	const result = {
		mode: facts.mode,
		readdirMs,
		entityDirs: estimate.entityDirs,
		expectedDirs: facts.total,
		sample: {
			dirs: sampled.length,
			files: sampledFiles,
			bytes: sampledBytes,
			allocatedBytes: sampledAllocated,
			missingMeta: sampledMissingMeta,
			avgFilesPerDir: round(perDir, 3),
			avgBytesPerFile: round(perFileBytes, 1),
			avgAllocatedPerFile: round(perFileAllocated, 1),
		},
		estimate: {
			files: estimate.files,
			payloadSidecarBytes: estimate.payloadSidecarBytes,
			payloadSidecarGB: round(estimate.payloadSidecarBytes / 1073741824, 2),
			allocatedBytes: estimate.allocatedBytes,
			allocatedGB: round(estimate.allocatedBytes / 1073741824, 2),
		},
		markerLogical: {
			payloadBytes: marker.bytes?.payload ?? 0,
			sidecarBytes: marker.bytes?.sidecars ?? 0,
			generationIndexBytes: marker.bytes?.index ?? 0,
		},
		index: { dbBytes: indexBytes, walBytes, dbGB: round(indexBytes / 1073741824, 2) },
		disk: { freeGB: round(freeBytes / 1073741824, 2), totalGB: round(totalBytes / 1073741824, 2) },
	}
	expect('i: 实体目录数与 marker 一致', estimate.entityDirs === facts.total, `${estimate.entityDirs} 期望 ${facts.total}`)
	expect('i: 每个实体目录都有 meta.json', sampledMissingMeta === 0, `${sampledMissingMeta}/${sampled.length}`)
	expect('i: 抽样每目录 2 个文件（载荷+边车）', round(perDir, 3) === 2, `${round(perDir, 3)}`)
	expect('i: 抽样文件总数外推合理', Math.abs(estimate.files - facts.total * 2) <= facts.total * 0.002, `${estimate.files} vs ${facts.total * 2}`)
	return result
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

/**
 * Build the JSON report body.
 *
 * @param {object} env - The resolved environment.
 * @param {object} marker - The tier marker.
 * @param {object} facts - The tier facts.
 * @param {Record<string, any>} tests - Test results keyed by test name.
 * @returns {object} The report.
 */
function buildReport(env, marker, facts, tests) {
	return {
		tool: 'stress-lab',
		formatVersion: 1,
		generatedAt: new Date().toISOString(),
		node: process.version,
		platform: `${process.platform} ${process.arch}`,
		tier: env.tier,
		sourceDir: env.sourceDir,
		workDir: env.workDir,
		source: {
			marker: {
				tier: marker.tier,
				mode: facts.mode,
				totalFiles: facts.total,
				files: facts.live,
				archived: facts.archived,
				indexSchema: marker.indexSchema,
				generatedAt: marker.generatedAt,
			},
		},
		options: {
			only: args.only,
			workers: args.workers,
			calls: args.calls,
			writes: args.writes,
			readers: args.readers,
			rounds: args.rounds,
			targetWrites: args.targetWrites,
			leakIterations: args.leakIterations,
			bigQueries: args.bigQueries,
		},
		loadNote: process.env.DSH_STRESS_LOAD_NOTE ?? '',
		tests,
		assertions,
		failures: assertions.filter((entry) => !entry.ok),
		peakRssMB: round(peakRss / 1048576, 1),
	}
}

/**
 * Print the human-readable report.
 *
 * @param {object} report - The report body.
 */
function printReport(report) {
	console.log('\n== stress lab ==')
	console.log(`tier=${report.tier} mode=${report.source.marker.mode} files=${report.source.marker.totalFiles} source=${report.sourceDir}`)
	console.log(`node ${report.node} / ${report.platform} / tests=${Object.keys(report.tests).join(',')}`)
	if (report.loadNote !== '') console.log(`注意：${report.loadNote}`)
	for (const [name, value] of Object.entries(report.tests)) {
		console.log(`\n-- ${name} --`)
		if (name === 'a') {
			console.log(`  调用 ${value.totalCalls}（${value.workers}×${value.callsPerWorker}），${value.elapsedMs} ms，${value.callsPerSec} calls/s，错误 ${value.errorCount}`)
			for (const row of value.byKind) console.log(`  ${row.kind.padEnd(20)} n=${String(row.count).padStart(4)} p50=${String(row.p50Ms).padStart(8)} p95=${String(row.p95Ms).padStart(8)} bytes(median/p95)=${row.bytes.median}/${row.bytes.p95}`)
		} else if (name === 'b') {
			console.log(`  副本 copy=${value.copy.copyMs} ms，写 ${value.writer.ops}/${value.writer.expectedOps}（p50 ${value.writer.p50Ms}ms，错误 ${value.writer.errors.length}），读者 ${value.readers.ops} 次（错误 ${value.readers.errors.length}）`)
			for (const [label, entry] of Object.entries(value.reconcile)) console.log(`  ${label.padEnd(12)} dirs=${entry.rawDirs} scan=${entry.scanEntries} index=${entry.indexTotal} stats=${entry.statsSum} missingIdx=${entry.missingInIndex} missingScan=${entry.missingInScan} problems=${entry.scanProblems} scanMs=${entry.scanMs}`)
			console.log(`  重开 ${value.reopenMs} ms；rebuild ${value.rebuild.ms} ms（files=${value.rebuild.files} problems=${value.rebuild.problems}）`)
		} else if (name === 'c') {
			for (const round of value.results) console.log(`  round ${round.round}: writes=${round.reportedWrites} killed=${round.killed} open=${round.openMs}ms integrity=${round.integrity} db=${round.dbTotal} scan=${round.scanEntries} missingIdx=${round.missingInIndex} problems=${round.scanProblems.length} readable=${round.readableReported}/${round.reportedWrites} rebuild=${round.rebuild?.ms}ms`)
		} else if (name === 'd') {
			console.log(`  损坏 ${value.healthyIndexBytes} B → open ${value.openMs} ms，隔离 ${value.quarantinedAfter} 个，db=${value.dbTotal} stats=${value.stats.files}+${value.stats.archived} hits=${value.searchHits} problems=${value.scan.problems}`)
		} else if (name === 'e1') {
			console.log(`  ${value.iterations} 次循环 ${value.elapsedMs} ms（${value.opsPerSec} ops/s），RSS ${value.baseline.rssMB}→${value.end.rssMB} MB（+${value.growthRssMB}），heap +${value.growthHeapMB} MB，峰值 ${value.peakRssMB} MB`)
		} else if (name === 'e2') {
			console.log(`  ${value.queries} 次查询，错误 ${value.errorCount}，db=${value.measured.total} live=${value.measured.live} 峰值 RSS ${value.peakRssMB} MB`)
			for (const row of value.byKind) console.log(`  ${row.kind.padEnd(20)} n=${String(row.count).padStart(3)} p50=${String(row.p50Ms).padStart(9)} p95=${String(row.p95Ms).padStart(9)} bytes=${row.bytesMedian}`)
		} else if (name === 'f') {
			console.log(`  删除索引 ${value.deletedIndexBytes} B → 冷启动 ${value.openMs} ms，重建索引 ${value.rebuiltIndexBytes} B，db=${value.measured.total} live=${value.measured.live} 峰值 RSS ${value.peakRssMB} MB`)
			for (const phase of value.phases) console.log(`  ${phase.name.padEnd(16)} ${String(phase.ms).padStart(10)} ms  rss=${phase.rssMB} MB`)
		} else if (name === 'i') {
			console.log(`  目录 ${value.entityDirs}（期望 ${value.expectedDirs}），readdir ${value.readdirMs} ms，抽样 ${value.sample.dirs} 目录：${value.sample.avgFilesPerDir} 文件/目录，${value.sample.avgBytesPerFile} B/文件`)
			console.log(`  估算文件树：${value.estimate.files} 文件，逻辑 ${value.estimate.payloadSidecarGB} GB，分配约 ${value.estimate.allocatedGB} GB；索引 ${value.index.dbGB} GB；磁盘剩余 ${value.disk.freeGB} GB / ${value.disk.totalGB} GB`)
		}
	}
	console.log(`\n断言：${report.assertions.length - report.failures.length}/${report.assertions.length} 通过`)
	if (report.failures.length > 0) {
		console.log('失败项：')
		for (const failure of report.failures) console.log(`  - ${failure.name}${failure.detail === '' ? '' : `：${failure.detail}`}`)
	} else {
		console.log('全部断言通过。')
	}
	console.log(`峰值 RSS：${report.peakRssMB} MB`)
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/** Run one test by name, recording its result. */
async function runTest(name, env, marker, facts, tests) {
	const started = performance.now()
	if (name === 'a') tests.a = await testConcurrency(env, facts)
	else if (name === 'b') tests.b = await testReadWrite(env, marker, facts)
	else if (name === 'c') tests.c = await testCrash(env)
	else if (name === 'd') tests.d = await testCorruption(env, marker, facts)
	else if (name === 'e1') tests.e1 = await testLeak(env, facts)
	else if (name === 'e2') tests.e2 = await testBigQueries(env, marker, facts)
	else if (name === 'i') tests.i = await testInventory(env, marker, facts)
	else if (name === 'f') tests.f = await testColdOpen(env, marker, facts)
	tests[name].wallMs = round(performance.now() - started, 1)
	note(`  ${name} 完成：${tests[name].wallMs} ms`)
}

/**
 * Entry point.
 *
 * @returns {Promise<void>} Resolves when the run is done.
 */
async function main() {
	args = parseArgs(process.argv.slice(2))
	const env = resolvePaths(args)
	env.tier = args.tier
	if (args.purge) {
		await rm(env.workDir, { recursive: true, force: true })
		note(`已删除工作数据：${env.workDir}`)
		return
	}
	note(`stress lab：tier=${env.tier} source=${env.sourceDir} work=${env.workDir}`)
	note(`测试项：${args.only.join(',')}`)
	const marker = await readMarker(env.sourceDir)
	const facts = factsOf(marker)
	if (facts.mode === 'fs') {
		const entryCount = await stat(join(env.sourceDir, 'files')).then((info) => info.isDirectory(), () => false)
		if (!entryCount) throw new Error(`源数据不是真实文件系统库（缺 files/）：${env.sourceDir}`)
	}
	const copyTests = ['b', 'c', 'd'].filter((name) => args.only.includes(name))
	if (copyTests.length > 0 && env.tier !== '100k') throw new Error(`b/c/d 只支持 --tier 100k（要复制 100k 真库），当前 ${env.tier}。`)
	if (args.only.includes('f') && facts.mode !== 'fs') throw new Error('f 只适用于 mode=fs 的真实文件系统库。')
	if ((args.only.includes('b') || args.only.includes('d')) && !args.only.includes('f')) await mkdir(env.workDir, { recursive: true })
	const tests = {}
	for (const name of args.only) await runTest(name, env, marker, facts, tests)
	if (args.only.includes('c') && !args.keep) {
		const sandbox = join(env.workDir, 'crash')
		await rm(sandbox, { recursive: true, force: true }).catch(() => {})
		note('已清理崩溃沙箱（--keep 可保留）')
	}
	const report = buildReport(env, marker, facts, tests)
	if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
	else printReport(report)
	process.exitCode = report.failures.length === 0 ? 0 : 1
}

await main()
