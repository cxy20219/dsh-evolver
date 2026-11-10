/**
 * The practice layer: the frontmatter contract, the two-level index and the
 * validator.
 *
 * Everything the agent is expected to reuse lives here, and the agent only
 * ever sees a routing table — the index — while the bodies stay on disk. The
 * index is *generated* from the entries' frontmatter, so it cannot rot as the
 * tree grows: adding a file is enough to make it routable.
 *
 * Layout (two levels, so the injected index stays the same size no matter how
 * much content accumulates):
 *
 *   practice/
 *     INDEX.md                 the full routing table, on disk
 *     ARCHIVE.md               the entries the injected projection left out
 *     docs/<topic>/<slug>.md   documents: experience, workflows, verification
 *     tools/<topic>/<slug>     tools: scripts and CLIs
 *     resources/<topic>/<slug> resources: templates, examples, static files
 *
 * Every entry starts with the same frontmatter:
 *
 *   ---
 *   title: 一次标题
 *   purpose: 一句话用途（会出现在索引里）
 *   kind: doc
 *   topic: 验证方法
 *   verified: 2026-11-10
 *   links: [build-index]
 *   ---
 *
 * The module is dependency-free on purpose: it is the part of the plugin that
 * must keep working when everything else moves.
 */

import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'

/** The kinds of practice, in the order the index lists them. */
export const KINDS = [
	{ id: 'doc', dir: 'docs', title: '文档' },
	{ id: 'tool', dir: 'tools', title: '工具' },
	{ id: 'resource', dir: 'resources', title: '资源' },
]

/** The frontmatter fields every entry must carry. */
export const REQUIRED_FIELDS = ['title', 'purpose']

/** The frontmatter fields an entry may carry. */
export const OPTIONAL_FIELDS = ['kind', 'topic', 'verified', 'links', 'tags']

/** The default byte budget of the injected index. */
export const DEFAULT_INDEX_BYTES = 2048

/**
 * The sinking discipline.
 *
 * These rules used to live in a separate skill (`harness-evolver`): when to
 * sink, what qualifies, what never belongs in the practice layer, and how to
 * write it. Keeping them here means the plugin is the single place that owns
 * the loop — there is no second copy of the rules that can drift.
 *
 * The text is fixed on purpose: the injected prefix must stay byte-stable.
 */
export const PRACTICE_DISCIPLINE = [
	'[纪律] 多步任务（≥3 步）后若有已验证、可复用的判断/流程/工具，先 practice_query 查重、practice_read 读相关条目，再 practice_write 落一条；能脚本化的写成 kind=tool（要真能跑）。',
	'只写能减少未来误判、重复劳动或验证成本的内容；不写流水账、一次性命令、猜测、废弃方案、密钥、日志和对话转录。没有高信号就跳过。',
	'写完读返回的 problems，链接要闭环。用户说「沉淀经验」「复盘流程」时同样适用。',
].join('\n')

/** Patterns that must never reach the practice layer. */
const SECRET_PATTERNS = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub 令牌'],
	[/\bAKIA[0-9A-Z]{16}\b/, 'AWS 访问密钥'],
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack 令牌'],
	[/\bsk-[A-Za-z0-9_-]{20,}\b/, 'API 密钥'],
]

/**
 * Detect a credential in what is about to be written.
 *
 * The check is deliberately narrow: it recognizes the common token shapes and
 * leaves ordinary prose alone. A false negative is possible; the discipline
 * text still says not to write secrets.
 *
 * @param {string} text - The title, purpose and body being written.
 * @returns {string | undefined} What the credential looks like, if any.
 */
export function findSecret(text) {
	const source = String(text ?? '')
	for (const [pattern, label] of SECRET_PATTERNS) {
		if (pattern.test(source)) return label
	}
	return undefined
}

/** How much of an entry is read just to describe it. */
const ENTRY_HEAD_BYTES = 8 * 1024

/** The largest entry `practice_read` returns in full. */
const MAX_ENTRY_READ_BYTES = 2 * 1024 * 1024

/** How many parsed entries the scan cache keeps. */
const MAX_CACHED_ENTRIES = 4096

/** Counts the temporary files the atomic writer creates. */
let writeSequence = 0

const KEY_LINE = /^([A-Za-z0-9_.-]+)[ \t]*:(.*)$/
const LIST_ITEM = /^[ \t]*-[ \t]+(.*)$/

/** The fields whose value may be an inline array. */
const LIST_FIELDS = new Set(['links', 'tags'])

/**
 * Parse the small YAML subset the frontmatter actually uses.
 *
 * Supported: scalars, inline arrays and block arrays. Anything else is
 * skipped instead of throwing, so one malformed entry never breaks the index.
 *
 * @param {string} text - The frontmatter text.
 * @returns {Record<string, unknown>} The parsed fields.
 */
export function parseFrontmatter(text) {
	const source = typeof text === 'string' ? text : ''
	const data = {}
	let currentKey = undefined
	for (const line of source.split(/\r?\n/)) {
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue
		const item = LIST_ITEM.exec(line)
		if (item !== null && currentKey !== undefined) {
			const value = stripQuotes(item[1].trim())
			const list = Array.isArray(data[currentKey]) ? data[currentKey] : []
			list.push(value)
			data[currentKey] = list
			continue
		}
		const match = KEY_LINE.exec(line)
		if (match === null) continue
		const key = match[1].trim()
		const rest = match[2].trim()
		currentKey = undefined
		if (rest === '') {
			currentKey = key
			data[key] = []
			continue
		}
		// Only the list fields are parsed as arrays: a title such as
		// `[草稿] 结论` is a scalar, and turning it into an array used to make
		// the title disappear after a write/read round trip.
		if (LIST_FIELDS.has(key) && rest.startsWith('[') && rest.endsWith(']')) {
			data[key] = rest
				.slice(1, -1)
				.split(',')
				.map((item) => stripQuotes(item.trim()))
				.filter((item) => item !== '')
			continue
		}
		data[key] = stripQuotes(rest)
	}
	return data
}

/**
 * Remove one layer of quotes from a scalar.
 *
 * @param {string} value - The raw scalar.
 * @returns {string} The unquoted scalar.
 */
function stripQuotes(value) {
	if (value.length >= 2) {
		const first = value[0]
		const last = value[value.length - 1]
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
	}
	return value
}

/**
 * Split an entry file into its frontmatter and its body.
 *
 * @param {string} text - The file content.
 * @returns {{data: Record<string, unknown>, body: string}} The parsed entry.
 */
export function splitEntry(text) {
	// Entries written on Windows (or saved by an editor that keeps CRLF) end
	// every line with a carriage return. The frontmatter parser anchors on
	// `$`, which a trailing `\r` defeats, so one such file used to lose its
	// entire frontmatter. Normalise once, here, for every reader.
	const source = (typeof text === 'string' ? text : '').replace(/\r\n?/g, '\n')
	const firstLineEnd = source.indexOf('\n')
	if (firstLineEnd < 0) return { data: {}, body: source }
	if (source.slice(0, firstLineEnd).trim() !== '---') return { data: {}, body: source }
	const closing = source.indexOf('\n---', firstLineEnd)
	if (closing < 0) return { data: {}, body: source }
	const head = source.slice(firstLineEnd + 1, closing)
	const bodyStart = source.indexOf('\n', closing + 1)
	const body = bodyStart < 0 ? '' : source.slice(bodyStart + 1)
	return { data: parseFrontmatter(head), body: body.replace(/^\n+/, '') }
}

/**
 * Whether a file name is a plausible entry name.
 *
 * @param {string} name - The file name.
 * @returns {boolean} True when the name may be used.
 */
export function isEntryName(name) {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
}

/**
 * Normalise a practice-relative path and refuse anything that could leave the
 * tree.
 *
 * The check is on path *segments*, not on the raw string: `a..b.md` is a
 * perfectly good file name, while `.`, `..`, an absolute path and an empty
 * segment are not.
 *
 * @param {unknown} relPath - The path the caller asked for.
 * @returns {string} The normalised path.
 */
export function safeRelativePath(relPath) {
	const clean = String(relPath ?? '').trim().split('\\').join('/')
	if (clean === '') throw new Error('路径不能为空。')
	if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) throw new Error(`路径不合法：${clean}`)
	const segments = clean.split('/')
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		throw new Error(`路径不合法：${clean}`)
	}
	if (clean.includes('\u0000')) throw new Error(`路径不合法：${clean}`)
	return clean
}

/**
 * Whether a path resolves to something inside `root`.
 *
 * Symbolic links are followed before the comparison, so a link that points
 * outside the practice folder is caught even when its name looks innocent.
 * The target may be missing (a write); its parent directory is what decides.
 *
 * @param {string} root - The folder that must contain the target.
 * @param {string} target - The path to test.
 * @returns {Promise<boolean>} True when the target stays inside.
 */
export async function isInside(root, target) {
	const base = await realpath(root).catch(() => undefined)
	if (base === undefined) return false
	const probe = await realpath(target).catch(async () => {
		const parent = await realpath(dirname(target)).catch(() => undefined)
		if (parent === undefined) return undefined
		return join(parent, basename(target))
	})
	if (probe === undefined) return false
	return probe === base || probe.startsWith(base + sep)
}

/**
 * Read a file's metadata without following a symbolic link.
 *
 * @param {string} path - Absolute path.
 * @returns {Promise<import('node:fs').Stats | undefined>} The metadata, or undefined.
 */
async function lstatOrUndefined(path) {
	try {
		return await lstat(path)
	} catch {
		return undefined
	}
}

/**
 * Read at most `bytes` from the start of a file.
 *
 * @param {string} path - Absolute path.
 * @param {number} bytes - The byte budget.
 * @returns {Promise<string>} The decoded head.
 */
async function readUpTo(path, bytes) {
	const handle = await open(path, 'r')
	try {
		const buffer = Buffer.alloc(bytes)
		const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
		return buffer.subarray(0, bytesRead).toString('utf8')
	} finally {
		await handle.close()
	}
}

/**
 * Read the part of an entry file that describes it.
 *
 * Entries are read to build the index, and the index only ever uses the
 * frontmatter plus 400 characters of body. Reading a multi-megabyte resource
 * in full to throw it away was the single most expensive part of a scan, so
 * large files contribute only their head.
 *
 * @param {string} path - Absolute path.
 * @param {number} size - The file size in bytes.
 * @returns {Promise<string>} The text to parse.
 */
async function readEntryText(path, size) {
	if (size <= ENTRY_HEAD_BYTES) return readFile(path, 'utf8')
	return readUpTo(path, ENTRY_HEAD_BYTES)
}

/**
 * The parsed entries, keyed by absolute path and validated by mtime + size.
 *
 * Scanning is done on every refresh, on every panel request and after every
 * write; parsing only the files that actually changed is what keeps that
 * cheap. The cache is approximate LRU, so a long-lived Host does not grow it
 * without bound.
 *
 * @type {Map<string, {mtimeMs: number, size: number, entry: object}>}
 */
const entryCache = new Map()

/**
 * Remember one parsed entry, evicting the least recently used one.
 *
 * @param {string} path - Absolute path.
 * @param {import('node:fs').Stats} info - The metadata the entry was built from.
 * @param {object} entry - The parsed entry.
 */
function rememberEntry(path, info, entry) {
	entryCache.delete(path)
	entryCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, entry })
	if (entryCache.size <= MAX_CACHED_ENTRIES) return
	const oldest = entryCache.keys().next()
	if (!oldest.done) entryCache.delete(oldest.value)
}

/**
 * Every kind descriptor, in index order.
 *
 * @returns {object[]} The kind descriptors.
 */
export function kindList() {
	return KINDS.map((kind) => ({ ...kind }))
}

/**
 * The kind descriptor for one directory name.
 *
 * @param {string} dir - Directory name.
 * @returns {object | undefined} The descriptor, or undefined.
 */
export function kindByDir(dir) {
	return KINDS.find((kind) => kind.dir === dir)
}

/**
 * Walk the practice tree and collect every entry.
 *
 * @param {string} practiceRoot - Absolute path of the practice folder.
 * @returns {Promise<{entries: object[], problems: object[]}>} The scan result.
 */
export async function scanPractice(practiceRoot) {
	const entries = []
	const problems = []
	for (const kind of KINDS) {
		const kindDir = join(practiceRoot, kind.dir)
		let names = []
		try {
			names = await readdir(kindDir)
		} catch {
			continue
		}
		for (const name of names.sort()) {
			if (name.startsWith('.') || name.endsWith('.tmp')) continue
			const path = join(kindDir, name)
			const info = await lstatOrUndefined(path)
			if (info === undefined) continue
			if (info.isSymbolicLink()) {
				problems.push({
					level: 'warning',
					code: 'entry/symlink',
					path: relative(practiceRoot, path),
					message: '实践条目必须是普通文件，符号链接不会被索引。',
				})
				continue
			}
			if (info.isDirectory()) {
				const collected = await collectTopic(practiceRoot, kind, name, path, problems)
				entries.push(...collected)
				continue
			}
			if (!info.isFile()) continue
			if (name === 'INDEX.md') continue
			const entry = await readEntry(practiceRoot, kind, '', name, path, info)
			if (entry === undefined) continue
			entries.push(entry)
		}
	}
	entries.sort(compareEntries)
	return { entries, problems }
}

/**
 * Read one entry file into the entry record.
 *
 * @param {string} practiceRoot - Absolute path of the practice folder.
 * @param {object} kind - The kind descriptor.
 * @param {string} topicSlug - The topic directory name, empty for a kind root file.
 * @param {string} name - The file name.
 * @param {string} path - Absolute path of the file.
 * @returns {Promise<object | undefined>} The entry, or undefined when the name is invalid.
 */
async function readEntry(practiceRoot, kind, topicSlug, name, path, info) {
	if (!isEntryName(name)) return undefined
	const meta = info ?? (await lstatOrUndefined(path))
	if (meta === undefined || !meta.isFile()) return undefined
	const cached = entryCache.get(path)
	if (cached !== undefined && cached.mtimeMs === meta.mtimeMs && cached.size === meta.size) {
		// Re-insert so the eviction order tracks usage, not age.
		entryCache.delete(path)
		entryCache.set(path, cached)
		return cached.entry
	}
	const text = await readEntryText(path, meta.size)
	const { data, body } = splitEntry(text)
	const relPath = relative(practiceRoot, path).split('\\').join('/')
	const entry = {
		kind: kind.id,
		kindTitle: kind.title,
		topicSlug,
		topic: typeof data.topic === 'string' && data.topic !== ''
			? data.topic
			: (topicSlug === '' ? '通用' : topicSlug),
		name,
		slug: name.replace(/\.[^.]+$/, ''),
		relPath,
		absPath: path,
		title: typeof data.title === 'string' ? data.title : '',
		purpose: typeof data.purpose === 'string' ? data.purpose : '',
		verified: typeof data.verified === 'string' ? data.verified : '',
		links: Array.isArray(data.links) ? data.links.map((item) => String(item)) : [],
		tags: Array.isArray(data.tags) ? data.tags.map((item) => String(item)) : [],
		declaredKind: typeof data.kind === 'string' ? data.kind : '',
		bytes: meta.size,
		updatedAt: meta.mtime.toISOString(),
		bodyPreview: body.slice(0, 400),
	}
	rememberEntry(path, meta, entry)
	return entry
}

/**
 * Collect the entries of one topic directory.
 *
 * @param {string} practiceRoot - Absolute path of the practice folder.
 * @param {object} kind - The kind descriptor.
 * @param {string} topicSlug - The topic directory name.
 * @param {string} topicDir - Absolute path of the topic directory.
 * @param {object[]} problems - Collected problems.
 * @returns {Promise<object[]>} The topic's entries.
 */
async function collectTopic(practiceRoot, kind, topicSlug, topicDir, problems) {
	const entries = []
	let names = []
	try {
		names = await readdir(topicDir)
	} catch {
		return entries
	}
	for (const name of names.sort()) {
		// `.tmp` is the atomic writer's suffix; a crash can leave one behind and
		// it must not be parsed as an entry.
		if (name.startsWith('.') || name.endsWith('.tmp')) continue
		const path = join(topicDir, name)
		const info = await lstatOrUndefined(path)
		if (info === undefined) continue
		if (info.isSymbolicLink()) {
			problems.push({
				level: 'warning',
				code: 'entry/symlink',
				path: relative(practiceRoot, path),
				message: '实践条目必须是普通文件，符号链接不会被索引。',
			})
			continue
		}
		if (info.isDirectory()) {
			problems.push({
				level: 'error',
				code: 'entry/too-deep',
				path: relative(practiceRoot, path),
				message: '实践最多两级：类型/主题/条目。',
			})
			continue
		}
		if (!info.isFile()) continue
		if (name === 'INDEX.md') continue
		if (!isEntryName(name)) {
			problems.push({
				level: 'error',
				code: 'entry/bad-name',
				path: relative(practiceRoot, path),
				message: '文件名只能用字母、数字、点、下划线和连字符。',
			})
			continue
		}
		const entry = await readEntry(practiceRoot, kind, topicSlug, name, path, info)
		if (entry === undefined) continue
		entries.push(entry)
	}
	return entries
}

/**
 * The deterministic order of the index: kind, then topic, then name.
 *
 * @param {object} left - One entry.
 * @param {object} right - One entry.
 * @returns {number} The comparison result.
 */
function compareEntries(left, right) {
	const leftKind = KINDS.findIndex((kind) => kind.id === left.kind)
	const rightKind = KINDS.findIndex((kind) => kind.id === right.kind)
	if (leftKind !== rightKind) return leftKind - rightKind
	if (left.topicSlug !== right.topicSlug) return left.topicSlug < right.topicSlug ? -1 : 1
	if (left.name !== right.name) return left.name < right.name ? -1 : 1
	return 0
}

/**
 * One index line for one entry.
 *
 * @param {object} entry - The entry.
 * @returns {string} The line.
 */
export function entryLine(entry) {
	const topic = entry.topic === '' ? '通用' : entry.topic
	return `- ${entry.kindTitle} · ${topic}：${entry.title}（${entry.relPath}）— ${entry.purpose}`
}

/**
 * The injected routing table.
 *
 * The text is deterministic — same tree, same bytes — so the prompt prefix
 * stays cacheable. When the full table does not fit the budget, the tail is
 * dropped and the remaining entries are named in `practice/ARCHIVE.md`.
 *
 * @param {object[]} entries - The scanned entries.
 * @param {{budget?: number}} options - The byte budget.
 * @returns {{text: string, included: object[], dropped: object[]}} The projection.
 */
export function buildProjection(entries, { budget = DEFAULT_INDEX_BYTES } = {}) {
	const header = '[实践] 下面是可复用实践的索引，只列路由。需要细节时用 practice_read / practice_query 自己去查，不要凭猜测。'
	const ordered = [...entries].sort(compareEntries)
	const lines = ordered.map((entry) => entryLine(entry))
	const costs = lines.map((line) => Buffer.byteLength(line, 'utf8') + 1)
	const fixedBytes = Buffer.byteLength(header, 'utf8') + 1
		+ Buffer.byteLength(PRACTICE_DISCIPLINE, 'utf8') + 1
	const tailFor = (count) => `（另有 ${count} 条未展示，见 practice/ARCHIVE.md）`
	// Why a reserve instead of a correction step: the tail line changes length
	// with the number of dropped entries, so a projection that fits first and
	// is corrected afterwards can drop an entry that had already been counted
	// twice. Reserving the widest tail up front keeps `included` and `dropped`
	// disjoint and the total inside the budget.
	const fit = (reserve) => {
		const included = []
		const dropped = []
		let used = fixedBytes + reserve
		for (let index = 0; index < ordered.length; index += 1) {
			if (used + costs[index] <= budget) {
				included.push(index)
				used += costs[index]
				continue
			}
			dropped.push(index)
		}
		return { included, dropped }
	}
	const full = fit(0)
	if (full.dropped.length === 0) {
		return { text: [header, PRACTICE_DISCIPLINE, ...lines].join('\n'), included: ordered, dropped: [] }
	}
	const reserve = Buffer.byteLength(tailFor(ordered.length), 'utf8') + 1
	const fitted = fit(reserve)
	const included = fitted.included.map((index) => ordered[index])
	const dropped = fitted.dropped.map((index) => ordered[index])
	const tail = tailFor(dropped.length)
	return {
		text: [header, PRACTICE_DISCIPLINE, ...fitted.included.map((index) => lines[index]), tail].join('\n'),
		included,
		dropped,
	}
}

/**
 * The full on-disk routing table.
 *
 * @param {object[]} entries - The scanned entries.
 * @returns {string} The Markdown document.
 */
export function buildFullIndex(entries) {
	const lines = ['# 实践索引', '', '> 本文件由 dsh-evolver 自动生成，不要手改；改条目或改前言后重新生成。', '']
	for (const kind of KINDS) {
		const kindEntries = entries.filter((entry) => entry.kind === kind.id)
		if (kindEntries.length === 0) continue
		lines.push(`## ${kind.title}`, '')
		const topics = groupByTopic(kindEntries)
		for (const topic of topics) {
			lines.push(`### ${topic.title}（${topic.entries.length}）`, '')
			for (const entry of topic.entries) {
				lines.push(`- ${entry.title}（${entry.relPath}）— ${entry.purpose}`)
			}
			lines.push('')
		}
	}
	return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * The on-disk index of one topic.
 *
 * @param {object[]} entries - The topic's entries.
 * @param {object} kind - The kind descriptor.
 * @param {string} topicSlug - The topic directory name.
 * @returns {string} The Markdown document.
 */
export function buildTopicIndex(entries, kind, topicSlug) {
	const lines = [
		`# ${kind.title} · ${topicSlug}`,
		'',
		'> 本文件由 dsh-evolver 自动生成，不要手改。',
		'',
	]
	for (const entry of entries) {
		lines.push(`- ${entry.title}（${entry.relPath}）— ${entry.purpose}`)
	}
	return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * The archive of the entries the injected projection left out.
 *
 * @param {object[]} dropped - The dropped entries.
 * @returns {string} The Markdown document.
 */
export function buildArchive(dropped) {
	const lines = [
		'# 实践归档',
		'',
		'> 注入索引放不下的条目在这里；用 practice_read 按路径读取。',
		'',
	]
	for (const entry of dropped) {
		lines.push(`- ${entry.title}（${entry.relPath}）— ${entry.purpose}`)
	}
	return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * Group entries by their topic, in the deterministic order.
 *
 * @param {object[]} entries - The entries of one kind.
 * @returns {object[]} The topic groups.
 */
function groupByTopic(entries) {
	const groups = new Map()
	for (const entry of entries) {
		const key = entry.topicSlug
		if (!groups.has(key)) groups.set(key, { slug: key, title: entry.topic, entries: [] })
		groups.get(key).entries.push(entry)
	}
	return Array.from(groups.values()).sort((left, right) => (left.slug < right.slug ? -1 : 1))
}

/**
 * Check the practice tree against the contract.
 *
 * @param {object[]} entries - The scanned entries.
 * @param {object[]} scanProblems - The problems found while scanning.
 * @returns {object[]} The problems, scan problems included.
 */
export function validatePractice(entries, scanProblems = []) {
	const problems = [...scanProblems]
	// A link resolves when the slug exists anywhere. Keeping a set (instead of
	// a slug → entry map) means two topics may reuse a slug without the second
	// silently shadowing the first.
	const known = new Set()
	for (const entry of entries) {
		known.add(`${entry.kind}/${entry.topicSlug}/${entry.slug}`)
		known.add(entry.slug)
	}
	const titles = new Map()
	for (const entry of entries) {
		for (const field of REQUIRED_FIELDS) {
			if (entry[field] === undefined || entry[field] === '') {
				problems.push({
					level: 'error',
					code: 'entry/missing-field',
					path: entry.relPath,
					message: `前言缺少 ${field}。`,
				})
			}
		}
		if (entry.declaredKind !== '' && entry.declaredKind !== entry.kind) {
			problems.push({
				level: 'error',
				code: 'entry/wrong-kind',
				path: entry.relPath,
				message: `前言的 kind 是 ${entry.declaredKind}，但它放在 ${entry.kind} 目录下。`,
			})
		}
		if (entry.verified === '') {
			problems.push({
				level: 'warning',
				code: 'entry/not-verified',
				path: entry.relPath,
				message: '没有写 verified：这条内容什么时候被验证过？',
			})
		}
		for (const link of entry.links) {
			const target = link.replace(/\.md$/, '')
			if (known.has(link) || known.has(target)) continue
			problems.push({
				level: 'warning',
				code: 'entry/broken-link',
				path: entry.relPath,
				message: `链接 ${link} 找不到对应条目。`,
			})
		}
		const titleKey = `${entry.kind}/${entry.title}`
		if (titles.has(titleKey)) {
			problems.push({
				level: 'warning',
				code: 'entry/duplicate-title',
				path: entry.relPath,
				message: `同类型下已经有同名条目：${titles.get(titleKey)}。`,
			})
		} else {
			titles.set(titleKey, entry.relPath)
		}
	}
	return problems
}

/**
 * Write the generated index files.
 *
 * @param {string} practiceRoot - Absolute path of the practice folder.
 * @param {object[]} entries - The scanned entries.
 * @param {object[]} dropped - The entries the projection left out.
 * @returns {Promise<string[]>} The paths that were written.
 */
export async function writeIndexes(practiceRoot, entries, dropped = []) {
	const written = []
	// Only files whose content actually changed are replaced: a write used to
	// bump the mtime of every topic index even when the entry was unrelated.
	const write = async (path, text) => {
		const previous = await readFile(path, 'utf8').catch(() => undefined)
		if (previous === text) return
		await writeTextAtomic(path, text)
		written.push(path)
	}

	await write(join(practiceRoot, 'INDEX.md'), buildFullIndex(entries))

	for (const kind of KINDS) {
		const kindEntries = entries.filter((entry) => entry.kind === kind.id)
		const rootEntries = kindEntries.filter((entry) => entry.topicSlug === '')
		if (rootEntries.length > 0) {
			await write(join(practiceRoot, kind.dir, 'INDEX.md'), buildTopicIndex(rootEntries, kind, ''))
		}
		const topics = groupByTopic(kindEntries.filter((entry) => entry.topicSlug !== ''))
		for (const topic of topics) {
			await write(join(practiceRoot, kind.dir, topic.slug, 'INDEX.md'), buildTopicIndex(topic.entries, kind, topic.slug))
		}
	}

	await write(join(practiceRoot, 'ARCHIVE.md'), buildArchive(dropped))
	return written
}

/**
 * Write a text file through a uniquely named temporary file.
 *
 * @param {string} path - Absolute target path.
 * @param {string} text - File content.
 * @returns {Promise<void>} Resolves once the rename is committed.
 */
async function writeTextAtomic(path, text) {
	writeSequence += 1
	const temp = `${path}.${process.pid}.${writeSequence}.tmp`
	try {
		await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
		await rename(temp, path)
	} catch (error) {
		// A failed rename must not leave a stray `.tmp` next to the entries.
		await rm(temp, { force: true }).catch(() => {})
		throw error
	}
}

/**
 * Regenerate the index files and report what happened.
 *
 * @param {string} practiceRoot - Absolute path of the practice folder.
 * @param {{budget?: number}} options - The byte budget of the projection.
 * @returns {Promise<{entries: object[], problems: object[], projection: object, written: string[]}>} The result.
 */
export async function regenerate(practiceRoot, { budget = DEFAULT_INDEX_BYTES } = {}) {
	await mkdir(practiceRoot, { recursive: true })
	const scan = await scanPractice(practiceRoot)
	const problems = validatePractice(scan.entries, scan.problems)
	const projection = buildProjection(scan.entries, { budget })
	const written = await writeIndexes(practiceRoot, scan.entries, projection.dropped)
	return { entries: scan.entries, problems, projection, written }
}

/**
 * Search the practice tree for one query.
 *
 * The search runs on the Host, so it reads the files no matter which
 * permission preset the session runs under.
 *
 * @param {string} practiceRoot - Absolute path of the practice folder.
 * @param {object[]} entries - The scanned entries.
 * @param {string} query - The search text.
 * @param {{kind?: string, limit?: number}} options - The filter.
 * @returns {Promise<object[]>} The matches, best first.
 */
export async function searchPractice(practiceRoot, entries, query, { kind = '', limit = 8 } = {}) {
	const needle = String(query ?? '').trim().toLowerCase()
	const size = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 50) : 8
	const pool = kind === '' ? entries : entries.filter((entry) => entry.kind === kind)
	const toResult = (entry, snippet) => ({
		kind: entry.kind,
		title: entry.title,
		path: entry.relPath,
		purpose: entry.purpose,
		snippet,
	})
	if (needle === '') {
		return pool.slice(0, size).map((entry) => toResult(entry, entry.purpose))
	}
	const scored = []
	for (const entry of pool) {
		const haystack = `${entry.title}\n${entry.purpose}\n${entry.topic}\n${entry.tags.join(' ')}\n${entry.bodyPreview}`.toLowerCase()
		const titleHit = entry.title.toLowerCase().includes(needle) ? 3 : 0
		const purposeHit = entry.purpose.toLowerCase().includes(needle) ? 2 : 0
		const bodyHit = haystack.includes(needle) ? 1 : 0
		const score = titleHit + purposeHit + bodyHit
		if (score === 0) continue
		scored.push({ entry, score, snippet: snippetOf(entry, needle) })
	}
	scored.sort((left, right) => right.score - left.score || compareEntries(left.entry, right.entry))
	return scored.slice(0, size).map((item) => toResult(item.entry, item.snippet))
}

/**
 * One matching line of an entry, for the search result.
 *
 * @param {object} entry - The entry.
 * @param {string} needle - The lower-cased query.
 * @returns {string} The snippet.
 */
function snippetOf(entry, needle) {
	const lines = entry.bodyPreview.split('\n')
	for (const line of lines) {
		if (line.toLowerCase().includes(needle)) return line.trim().slice(0, 160)
	}
	return entry.purpose
}

/**
 * Read one entry by its path, relative to the practice root.
 *
 * @param {string} practiceRoot - Absolute path of the practice folder.
 * @param {string} relPath - The entry path.
 * @returns {Promise<object>} The entry's content and metadata.
 */
export async function readPracticeEntry(practiceRoot, relPath) {
	const clean = safeRelativePath(relPath)
	const path = join(practiceRoot, clean)
	const info = await lstatOrUndefined(path)
	// `lstat` refuses a link where the entry should be, and `isInside` catches
	// a link further up the tree, so a practice folder can no longer be used
	// as a window onto files the plugin was never given.
	if (info === undefined || !info.isFile()) throw new Error(`条目不存在：${clean}`)
	if (!(await isInside(practiceRoot, path))) throw new Error(`路径逃出了实践目录：${clean}`)
	const truncated = info.size > MAX_ENTRY_READ_BYTES
	const text = truncated ? await readUpTo(path, MAX_ENTRY_READ_BYTES) : await readFile(path, 'utf8')
	const { data, body } = splitEntry(text)
	return {
		path: clean,
		title: typeof data.title === 'string' ? data.title : basename(clean),
		purpose: typeof data.purpose === 'string' ? data.purpose : '',
		kind: typeof data.kind === 'string' ? data.kind : '',
		topic: typeof data.topic === 'string' ? data.topic : '',
		verified: typeof data.verified === 'string' ? data.verified : '',
		links: Array.isArray(data.links) ? data.links : [],
		content: body,
		bytes: info.size,
		truncated: truncated || undefined,
		updatedAt: info.mtime.toISOString(),
	}
}
