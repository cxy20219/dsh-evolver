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
 *     agents/<topic>/<slug>.md agent definitions
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

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

/** The kinds of practice, in the order the index lists them. */
export const KINDS = [
	{ id: 'doc', dir: 'docs', title: '文档' },
	{ id: 'tool', dir: 'tools', title: '工具' },
	{ id: 'resource', dir: 'resources', title: '资源' },
	{ id: 'agent', dir: 'agents', title: 'Agents' },
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
	'[纪律] 完成多步工具调用（≥3 步）的任务后，如果出现已验证且可复用的判断、稳定流程、验证方法或工具，先 practice_query 查重、practice_read 读相关条目，再 practice_write 落一条；能脚本化的流程写成 kind=tool（脚本要真能跑），不要只写文档。',
	'只写能减少未来误判、重复劳动或验证成本的内容：不写流水账、一次性命令、临时猜测、废弃方案、密钥、令牌、完整日志和对话转录。没有高信号内容就安静跳过，不要硬凑。',
	'写完看返回的 problems，链接要闭环；用户说「沉淀经验」「复盘流程」「记录项目经验」时按同样规则执行。',
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

/** The deepest path an entry may live at: `<kind>/<topic>/<file>`. */
const MAX_DEPTH = 2

const KEY_LINE = /^([A-Za-z0-9_.-]+)[ \t]*:(.*)$/
const LIST_ITEM = /^[ \t]*-[ \t]+(.*)$/

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
	for (const line of source.split('\n')) {
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
		if (rest.startsWith('[') && rest.endsWith(']')) {
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
	const source = typeof text === 'string' ? text : ''
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
			if (name.startsWith('.')) continue
			const path = join(kindDir, name)
			const info = await statOrUndefined(path)
			if (info === undefined) continue
			if (info.isDirectory()) {
				const collected = await collectTopic(practiceRoot, kind, name, path, problems)
				entries.push(...collected)
				continue
			}
			if (!info.isFile()) continue
			if (name === 'INDEX.md') continue
			const entry = await readEntry(practiceRoot, kind, '', name, path)
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
async function readEntry(practiceRoot, kind, topicSlug, name, path) {
	if (!isEntryName(name)) return undefined
	const info = await statOrUndefined(path)
	if (info === undefined || !info.isFile()) return undefined
	const text = await readFile(path, 'utf8')
	const { data, body } = splitEntry(text)
	const relPath = relative(practiceRoot, path).split('\\').join('/')
	return {
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
		bytes: info.size,
		updatedAt: info.mtime.toISOString(),
		bodyPreview: body.slice(0, 400),
	}
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
		if (name.startsWith('.')) continue
		const path = join(topicDir, name)
		const info = await statOrUndefined(path)
		if (info === undefined) continue
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
		const entry = await readEntry(practiceRoot, kind, topicSlug, name, path)
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
 * Read a file's metadata, tolerating a missing file.
 *
 * @param {string} path - Absolute file path.
 * @returns {Promise<object | undefined>} The metadata, or undefined.
 */
async function statOrUndefined(path) {
	try {
		return await stat(path)
	} catch {
		return undefined
	}
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
	const included = []
	const dropped = []
	let used = Buffer.byteLength(header, 'utf8') + 1
	// The discipline is part of the injected block, so it counts against the
	// budget: the agent always sees the rules and the routing table together.
	used += Buffer.byteLength(PRACTICE_DISCIPLINE, 'utf8') + 1
	for (const entry of ordered) {
		const line = entryLine(entry)
		const cost = Buffer.byteLength(line, 'utf8') + 1
		if (used + cost <= budget) {
			included.push(entry)
			used += cost
			continue
		}
		dropped.push(entry)
	}
	if (dropped.length === 0) {
		return { text: [header, PRACTICE_DISCIPLINE, ...ordered.map((entry) => entryLine(entry))].join('\n'), included, dropped }
	}
	const tail = `（另有 ${dropped.length} 条未展示，见 practice/ARCHIVE.md）`
	const usedWithTail = used + Buffer.byteLength(tail, 'utf8') + 1
	if (usedWithTail > budget && included.length > 0) {
		included.pop()
		dropped.push(ordered[included.length])
	}
	return {
		text: [header, PRACTICE_DISCIPLINE, ...included.map((entry) => entryLine(entry)), tail].join('\n'),
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
	const bySlug = new Map()
	for (const entry of entries) {
		const key = `${entry.kind}/${entry.topicSlug}/${entry.slug}`
		bySlug.set(key, entry)
		bySlug.set(entry.slug, entry)
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
			const target = bySlug.get(link) ?? bySlug.get(link.replace(/\.md$/, ''))
			if (target === undefined) {
				problems.push({
					level: 'warning',
					code: 'entry/broken-link',
					path: entry.relPath,
					message: `链接 ${link} 找不到对应条目。`,
				})
			}
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
	const indexPath = join(practiceRoot, 'INDEX.md')
	await writeFile(indexPath, buildFullIndex(entries), 'utf8')
	written.push(indexPath)

	for (const kind of KINDS) {
		const kindEntries = entries.filter((entry) => entry.kind === kind.id)
		const rootEntries = kindEntries.filter((entry) => entry.topicSlug === '')
		if (rootEntries.length > 0) {
			const rootPath = join(practiceRoot, kind.dir, 'INDEX.md')
			await writeFile(rootPath, buildTopicIndex(rootEntries, kind, ''), 'utf8')
			written.push(rootPath)
		}
		const topics = groupByTopic(kindEntries.filter((entry) => entry.topicSlug !== ''))
		for (const topic of topics) {
			const topicPath = join(practiceRoot, kind.dir, topic.slug, 'INDEX.md')
			await writeFile(topicPath, buildTopicIndex(topic.entries, kind, topic.slug), 'utf8')
			written.push(topicPath)
		}
	}

	const archivePath = join(practiceRoot, 'ARCHIVE.md')
	if (dropped.length > 0) {
		await writeFile(archivePath, buildArchive(dropped), 'utf8')
		written.push(archivePath)
	} else {
		await writeFile(archivePath, buildArchive([]), 'utf8')
		written.push(archivePath)
	}
	return written
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
	const pool = kind === '' ? entries : entries.filter((entry) => entry.kind === kind)
	const toResult = (entry, snippet) => ({
		kind: entry.kind,
		title: entry.title,
		path: entry.relPath,
		purpose: entry.purpose,
		snippet,
	})
	if (needle === '') {
		return pool.slice(0, limit).map((entry) => toResult(entry, entry.purpose))
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
	return scored.slice(0, limit).map((item) => toResult(item.entry, item.snippet))
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
	const clean = String(relPath ?? '').trim().split('\\').join('/')
	if (clean === '' || clean.includes('..') || clean.startsWith('/')) {
		throw new Error(`路径不合法：${relPath}`)
	}
	const path = join(practiceRoot, clean)
	const info = await statOrUndefined(path)
	if (info === undefined || !info.isFile()) throw new Error(`条目不存在：${clean}`)
	const text = await readFile(path, 'utf8')
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
		updatedAt: info.mtime.toISOString(),
	}
}
