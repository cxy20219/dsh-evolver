/**
 * The `harness/` resource system: a project-scoped memory that travels with
 * the repository.
 *
 * The file library answers "what did I learn that holds anywhere"; this
 * answers "what is true about *this* repository" — its build commands, its
 * architecture constraints, the traps its own tooling sets. It lives in
 * `harness/` next to the code, is indexed by the project's `AGENTS.md`, and is
 * therefore in the model's context through the host's own instruction loading
 * rather than through anything 自衍中枢 injects.
 *
 * The layout is fixed:
 *
 *   harness/harness.md          the project overview
 *   harness/workflow/           stable, executable procedures
 *   harness/experience/         reusable judgements
 *   harness/tool/               anything runnable: a script, a binary, a CLI
 *   harness/resources/          everything it reads: specs, templates, fixtures
 *
 * Four layers, not five: `references/` and `assets/` were the same question —
 * "what does the tooling read" — answered twice, and `scripts/` was too narrow
 * for a folder that also holds compiled helpers.
 *
 * Ported from dsh-evolver 1.0.0. The one host dependency it no longer has is
 * `src/workspace.js`: the containment check a write needs before touching a
 * symlinked target lives here now, because this module is the one that knows
 * what a project root is.
 */

import { realpathSync } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'

import { writeFileAtomic } from '../atomic.js'
import { isSidecarName, readSidecar, sidecarPath, writeSidecar } from './sidecar.js'

/** The four resource layers, in the order the index lists them. */
export const LAYERS = ['workflow', 'experience', 'tool', 'resources']

/** The layer that holds anything runnable. */
export const TOOL_LAYER = 'tool'

/** The layer that holds everything a tool reads. */
export const RESOURCE_LAYER = 'resources'

/** The layers whose entries must be referenced by a document. */
export const REFERENCED_LAYERS = [TOOL_LAYER, RESOURCE_LAYER]

/** Where each retired layer lived, for migration. */
const RETIRED_LAYERS = { scripts: TOOL_LAYER, references: RESOURCE_LAYER, assets: RESOURCE_LAYER }

/**
 * The extensions a catalog will read at all.
 *
 * A `harness/resources/` folder is allowed to hold anything — a dataset, a
 * video, a compiled helper — and the index only needs the name of a file like
 * that. Reading every file as UTF-8 made a 32MB binary cost two full reads and
 * tens of megabytes of heap per write (stability audit P2-6), so only text that
 * could carry a title/summary frontmatter is opened, and only its head.
 */
const DOCUMENT_EXTENSIONS = new Set([
	'.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc',
	'.json', '.jsonc', '.yml', '.yaml', '.toml', '.ini', '.csv',
	'.html', '.htm', '.xml', '.py', '.sh',
])

/**
 * How much one catalog scan may read.
 *
 * These are DoS bounds, not tuning knobs: a resource folder with thousands of
 * files or a huge document must not turn one `file_write` into a
 * multi-second, hundreds-of-megabytes operation. A scan that hits `maxFiles`
 * reports itself as `limited` and callers must not rebuild the index from a
 * partial listing; the other two limits only cost summaries (the entry stays
 * in the listing), which is why they are safe to degrade silently in the index.
 */
export const CATALOG_LIMITS = Object.freeze({
	maxFiles: 1000,
	maxDocBytes: 64 * 1024,
	maxBytes: 8 * 1024 * 1024,
})


/** The overview file every harness folder carries. */
export const OVERVIEW = 'harness.md'

/** The three lines the index must carry, whatever else it says. */
export const REQUIRED_INDEX_TEXT = [
	'> 在执行任何操作前，必须先根据下方文件索引查阅获取足够上下文，确认信息充分后再行动；`harness/harness.md` 是必须查阅的项目总览。',
	'# 文档索引，按需查阅',
	'harness/harness.md',
]

/**
 * The markers of the managed block inside `AGENTS.md`.
 *
 * A project's `AGENTS.md` is the harness index and nothing else: it is written
 * by the plugin from the folder, so it can be rebuilt at any time and can
 * never disagree with `harness/`. Hand-written project rules belong in
 * `harness/harness.md`, which the index points at.
 */
export const OVERVIEW_TITLE = 'Harness 开发指南'

/** The description the overview carries until somebody writes a better one. */
export const OVERVIEW_DESCRIPTION = '项目总览、关键约束、常用入口和注意事项；开始任何任务前先读它'

const OVERVIEW_TEMPLATE = `# Harness 项目资源总览

## 项目总览

记录项目长期稳定的总览、关键约束、常用入口和注意事项。

## 资源分层

- workflow：稳定可执行流程。
- experience：可复用判断经验。
- tool：可重复执行的东西——脚本、可执行文件、CLI 都算。
- resources：工具要读的东西——外部规范、长背景、模板、示例输入、静态资源。

## 写法

每条资源旁边有一个同名边车 \`<文件名>.meta.json\`，里面写清两件事：它是什么（做法/结论），以及以后哪些场景、任务、问题会用到它；项目根的 AGENTS.md 就是按这些边车生成的索引。跨项目可复用的，再用 file_write({from:"harness/...", meta:{description,tags}}) 落进自衍文件库。
`

/**
 * Whether a directory entry is build output rather than a resource.
 *
 * `__pycache__` and friends appear the moment a project script is run; they
 * are not resources and must never reach the index.
 *
 * @param {string} entry - The relative entry.
 * @returns {boolean} True when it should be skipped.
 */
function isNoise(entry) {
	const parts = entry.split(/[\\/]/)
	return parts.some((part) => part.startsWith('.') || part === '__pycache__' || part === 'node_modules')
}

/**
 * The files under one folder, as relative POSIX paths with their size.
 *
 * `readdir(..., { recursive: true })` also returns the directories it walks
 * through. Treating those as resources put folder links in the index, and a
 * migration that renamed the folder first then failed on the files inside it.
 * Only files are returned, sorted, so every caller sees the same order.
 *
 * The size is carried along so a catalog can decide whether a document is
 * worth opening without a second `stat`, and so an oversized one can be marked
 * truncated rather than guessed at.
 *
 * `limit` bounds the per-file work a scan may do: beyond it entries are counted
 * as omitted instead of being `stat`ed, which is what keeps a resource folder
 * with tens of thousands of files from turning one catalog into a stall. The
 * omitted count is a lower bound (the remaining names are not classified).
 *
 * @param {string} dir - The folder.
 * @param {number} [limit] - The most files to describe.
 * @returns {Promise<{files: {name: string, size: number}[], omitted: number}>} The files, and how many entries were not described.
 */
async function listFiles(dir, limit = Number.POSITIVE_INFINITY) {
	const entries = await readdir(dir, { recursive: true }).catch(() => [])
	const files = []
	let omitted = 0
	for (const entry of entries) {
		const name = String(entry).split('\\').join('/')
		if (isNoise(name)) continue
		if (files.length >= limit) {
			omitted += 1
			continue
		}
		const info = await lstat(join(dir, name)).catch(() => undefined)
		if (info === undefined || info.isDirectory()) continue
		files.push({ name, size: info.size })
	}
	return { files: files.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0), omitted }
}

/**
 * A destination that does not collide with a planned move or a file already
 * on disk.
 *
 * The first file keeps the plain name; a later one is suffixed with the folder
 * it came from, so `references/x.md` and `assets/x.md` both survive the move
 * and the path says which is which. Silently overwriting one of them is the
 * one outcome a migration must never produce.
 *
 * @param {string} candidate - The preferred absolute path.
 * @param {string} origin - The retired layer the file came from.
 * @param {Set<string>} claimed - Destinations already planned.
 * @returns {Promise<string>} A free absolute path.
 */
async function freeDestination(candidate, origin, claimed) {
	const taken = async (path) => claimed.has(path) || (await lstat(path).catch(() => undefined)) !== undefined
	if (!(await taken(candidate))) return candidate
	const extension = extname(candidate)
	const stem = candidate.slice(0, candidate.length - extension.length)
	for (let index = 1; index <= 100; index += 1) {
		const suffix = index === 1 ? `from-${origin}` : `from-${origin}-${index}`
		const next = `${stem}.${suffix}${extension}`
		if (!(await taken(next))) return next
	}
	throw new Error(`无法为 ${candidate} 找到不冲突的迁移目标。`)
}

/**
 * Whether a path exists.
 *
 * @param {string} path - The path.
 * @returns {Promise<boolean>} True when it does.
 */
async function exists(path) {
	return (await lstat(path).catch(() => undefined)) !== undefined
}

/**
 * Resolve a path to the directory it physically names.
 *
 * Two spellings of the same folder (a symlinked parent, for example) must be
 * recognised as the same folder before anything is written; a missing target
 * falls back to its parent's real path plus the requested name.
 *
 * @param {string} path - The absolute path.
 * @returns {Promise<string>} The canonical path.
 */
async function canonicalPath(path) {
	try {
		return await realpath(path)
	} catch {
		const parent = await realpath(dirname(path)).catch(() => undefined)
		return parent === undefined ? path : join(parent, basename(path))
	}
}

/**
 * Whether a path resolves to something inside `root`, following every link.
 *
 * A lexical prefix check cannot see a symlinked folder: `harness/tmp` pointing
 * outside would let a write through it reach the project's siblings, so the
 * check is made against the real path.
 *
 * @param {string} root - The folder that must contain the target.
 * @param {string} target - The path to test.
 * @returns {Promise<boolean>} True when the target really stays inside.
 */
export async function isReallyInside(root, target) {
	const base = await realpath(root).catch(() => undefined)
	if (base === undefined) return false
	const probe = await canonicalPath(target)
	return probe === base || probe.startsWith(base + sep)
}

/**
 * The physical path a spelling names, resolving links and junctions.
 *
 * A lexical check cannot see a junction inside the session cwd that points at
 * another repository: `C:\work\repo\linked` is a descendant by spelling and a
 * foreign folder in fact (security audit H-6). Resolving the existing prefix to
 * its real path and re-appending the missing tail makes both sides comparable
 * without requiring the target itself to exist (a file about to be written, or
 * a session cwd whose last segment was removed).
 *
 * @param {string} path - An absolute path.
 * @returns {string | undefined} The physical spelling, or undefined when not even an ancestor resolves.
 */
function physicalPath(path) {
	const resolved = resolve(path)
	const tail = []
	let current = resolved
	for (;;) {
		try {
			const real = realpathSync.native(current)
			return tail.length === 0 ? real : join(real, ...tail.reverse())
		} catch {
			const parent = dirname(current)
			// Nothing on this path resolves (a nonexistent drive, a UNC root
			// the process cannot see): the lexical spelling is all we have.
			if (parent === current) return undefined
			tail.push(basename(current))
			current = parent
		}
	}
}

/**
 * Whether one absolute path is the same as, or below, another.
 *
 * Containment is decided on the *physical* path whenever both sides resolve:
 * a junction or symlink is followed, so a folder that only looks like a
 * descendant is not treated as one, and two spellings of the same folder
 * (case on Windows, a linked parent) are recognised as the same folder. When
 * resolution fails even for the existing prefix, the lexical spelling is the
 * only evidence there is and is used as a fallback; a caller that must not be
 * fooled refuses in that case itself.
 *
 * @param {string} parent - The candidate container.
 * @param {string} child - The candidate contained path.
 * @returns {boolean} True when `child` is `parent` or below it.
 */
export function isWithin(parent, child) {
	if (typeof parent !== 'string' || typeof child !== 'string') return false
	if (!isAbsolute(parent) || !isAbsolute(child)) return false
	const fold = (value) => {
		const resolved = resolve(value)
		const trimmed = resolved !== sep && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved
		return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
	}
	const contains = (base, probe) => probe === base || probe.startsWith(base + sep)
	const physicalParent = physicalPath(parent)
	const physicalChild = physicalPath(child)
	if (physicalParent !== undefined && physicalChild !== undefined) {
		return contains(fold(physicalParent), fold(physicalChild))
	}
	return contains(fold(parent), fold(child))
}

/**
 * Find the project root that owns a directory.
 *
 * A repository is identified the way the host identifies one — a `.git` — with
 * a `harness/` folder and an `AGENTS.md` accepted as equally good evidence,
 * because a harness can be set up before the repository is.
 *
 * The start has to exist. Walking up from a path that is gone would eventually
 * find an unrelated marker (a home directory that happens to be a repository)
 * and point a write there; a path that names nothing is not evidence of any
 * project, so the caller gets `undefined` and has to ask for an explicit one.
 *
 * @param {string} start - A directory inside the project.
 * @returns {Promise<string | undefined>} The absolute root, or undefined.
 */
export async function projectRootOf(start) {
	if (typeof start !== 'string' || start === '' || !isAbsolute(start)) return undefined
	const resolved = resolve(start)
	const info = await lstat(resolved).catch(() => undefined)
	if (info === undefined) return undefined
	let current = info.isDirectory() ? resolved : dirname(resolved)
	for (;;) {
		for (const marker of ['.git', 'harness', 'AGENTS.md']) {
			if (await exists(join(current, marker))) return current
		}
		const parent = dirname(current)
		if (parent === current) return undefined
		current = parent
	}
}

/**
 * Read one text file in full, tolerating a missing or unreadable one.
 *
 * Only `AGENTS.md` uses this: its managed block can sit anywhere in a
 * hand-written document, so the markers have to be found in the whole file.
 * Resource documents go through `readHeadText` instead, which never loads more
 * than a bounded head (stability audit P2-6).
 *
 * @param {string} path - The file.
 * @returns {Promise<string>} The text, or an empty string.
 */
async function readText(path) {
	return readFile(path, 'utf8').catch(() => '')
}

/**
 * Read at most `maxBytes` from the head of a file.
 *
 * A resource file is indexed by its title and one-line purpose, which live in
 * the frontmatter or the first heading; the rest of the document is never
 * needed. Reading only the head is what keeps a 32MB `resources/dataset.bin`
 * from being turned into a 32MB string on every catalog (stability audit P2-6).
 *
 * @param {string} path - The file.
 * @param {number} maxBytes - The most bytes to read.
 * @returns {Promise<{text: string, bytes: number}>} The head, and how much was read.
 */
async function readHeadText(path, maxBytes) {
	let handle
	try {
		handle = await open(path, 'r')
		const buffer = Buffer.allocUnsafe(maxBytes)
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
		return { text: buffer.subarray(0, bytesRead).toString('utf8'), bytes: bytesRead }
	} catch {
		// Missing, unreadable, or larger than the OS can hand back: the entry
		// still exists in the listing, it just does not gain a summary.
		return { text: '', bytes: 0 }
	} finally {
		if (handle !== undefined) await handle.close().catch(() => {})
	}
}

/**
 * Fill one catalog entry with the title and description it declares.
 *
 * The sidecar is the source of truth: `harness/tool/x.mjs.meta.json` says what
 * `x.mjs` is for, and the index shows that sentence. A resource without a
 * sidecar keeps its place in the listing — the folder is the truth — but has
 * no description yet, which the caller reports as a warning rather than
 * dropping the entry.
 *
 * A document's own first heading is used as the title when no sidecar exists,
 * because the title is a label and the file itself is the next best evidence.
 *
 * @param {string} root - The project root.
 * @param {object} resource - The entry being described.
 * @param {{name: string, size: number}} entry - Its folder entry.
 * @param {object} caps - The scan limits.
 * @param {object} totals - Mutable scan counters.
 * @returns {Promise<void>} Resolves once described.
 */
async function describeResource(root, resource, entry, caps, totals) {
	const fallback = basename(resource.path)
	resource.title = fallback
	resource.description = ''
	const sidecar = await readSidecar(root, resource.path)
	if (sidecar !== undefined) {
		resource.sidecar = true
		resource.title = sidecar.title !== '' ? sidecar.title : fallback
		resource.description = sidecar.description
		return
	}
	if (!DOCUMENT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
		resource.binary = true
		totals.skipped += 1
		return
	}
	if (entry.size === 0) return
	const take = Math.min(entry.size, caps.maxDocBytes)
	if (totals.bytes + take > caps.maxBytes) {
		resource.skipped = true
		totals.skipped += 1
		return
	}
	if (entry.size > caps.maxDocBytes) {
		resource.truncated = true
		totals.truncated += 1
	}
	const { text } = await readHeadText(join(root, resource.path), take)
	totals.bytes += take
	const { body } = splitFrontmatter(text)
	resource.title = firstHeading(body) || fallback
}

/**
 * Split a document into its frontmatter and its body.
 *
 * Only the shape this plugin writes is handled: a leading `---` fence holding
 * `key: value` lines. A document without one is all body.
 *
 * @param {string} text - The document.
 * @returns {{meta: Record<string, string>, body: string, fenced: boolean}} The parts.
 * @internal exported for tests
 */
export function splitFrontmatter(text) {
	const source = String(text ?? '')
	if (!source.startsWith('---\n')) return { meta: {}, body: source, fenced: false }
	const end = source.indexOf('\n---\n', 4)
	if (end === -1) return { meta: {}, body: source, fenced: false }
	const meta = {}
	for (const line of source.slice(4, end).split('\n')) {
		const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim())
		if (match !== null) meta[match[1]] = match[2].replace(/^["']|["']$/g, '').trim()
	}
	return { meta, body: source.slice(end + 5), fenced: true }
}

/**
 * The first heading of a document, used when it declares no summary.
 *
 * @param {string} body - The document body.
 * @returns {string} The heading text, or an empty string.
 * @internal exported for tests
 */
export function firstHeading(body) {
	const match = /^#{1,6}\s+(.+)$/m.exec(String(body ?? ''))
	return match === null ? '' : match[1].replace(/[*`]/g, '').trim()
}

/**
 * Scan one harness folder.
 *
 * The scan is bounded on purpose (stability audit P2-6): at most
 * `CATALOG_LIMITS.maxFiles` entries, and at most `maxDocBytes` read from each
 * document with `maxBytes` read in total. A binary resource or an oversized
 * one is listed without being read; `skipped`/`truncated`/`omitted` on the
 * result say so. `limited` means the listing itself was cut short, in which
 * case nothing may rebuild the index from it (a partial listing would drop
 * entries), and callers refuse instead.
 *
 * @param {string} root - The project root.
 * @param {{limits?: {maxFiles?: number, maxDocBytes?: number, maxBytes?: number}}} [options] - Override scan bounds (tests).
 * @returns {Promise<object>} The catalog.
 */
export async function catalog(root, { limits } = {}) {
	const caps = { ...CATALOG_LIMITS, ...(limits ?? {}) }
	const harnessDir = join(root, 'harness')
	const agentsPath = join(root, 'AGENTS.md')
	const totals = { files: 0, bytes: 0, skipped: 0, truncated: 0, omitted: 0 }
	const state = {
		root,
		harnessDir,
		present: await exists(harnessDir),
		agents: await exists(agentsPath),
		overview: false,
		layers: {},
		resources: [],
		unexpected: [],
		missing: [],
		index: { mode: 'absent', present: false, refs: [], stale: [], missing: [] },
		skipped: 0,
		truncated: 0,
		limited: false,
		omitted: 0,
	}

	if (!state.present) {
		state.missing = [OVERVIEW, ...LAYERS]
		return state
	}

	const top = await readdir(harnessDir).catch(() => [])
	for (const name of top.sort()) {
		if (isSidecarName(name)) continue
		// `.DS_Store` and friends are not resources: opening the folder in
		// Finder is enough to create one, and treating it as a stray entry made
		// every harness write fail its validation and roll back on macOS. The
		// same rule already applied inside the layers; it belongs here too.
		if (isNoise(name)) continue
		if (name !== OVERVIEW && !LAYERS.includes(name)) state.unexpected.push(name)
	}
	state.overview = await exists(join(harnessDir, OVERVIEW))
	if (!state.overview) state.missing.push(OVERVIEW)
	else {
		const info = await lstat(join(harnessDir, OVERVIEW)).catch(() => undefined)
		const resource = { path: `harness/${OVERVIEW}`, layer: 'overview', title: OVERVIEW, description: '' }
		state.resources.push(resource)
		totals.files += 1
		await describeResource(root, resource, { name: OVERVIEW, size: info?.size ?? 0 }, caps, totals)
	}

	for (const layer of LAYERS) {
		const dir = join(harnessDir, layer)
		const info = await lstat(dir).catch(() => undefined)
		if (info === undefined || !info.isDirectory()) {
			state.missing.push(layer)
			state.layers[layer] = []
			continue
		}
		const room = Math.max(0, caps.maxFiles - totals.files)
		const listed = await listFiles(dir, room)
		const accepted = listed.files.filter((entry) => !isSidecarName(entry.name))
		state.layers[layer] = accepted.map((entry) => `harness/${layer}/${entry.name}`)
		if (listed.omitted > 0) {
			state.limited = true
			totals.omitted += listed.omitted
		}
		totals.files += accepted.length
		for (const entry of accepted) {
			const resource = { path: `harness/${layer}/${entry.name}`, layer, title: baseOf(entry.name), description: '' }
			state.resources.push(resource)
			await describeResource(root, resource, entry, caps, totals)
		}
	}

	const agentsText = await readText(agentsPath)
	const inspected = inspectAgents(agentsText)
	// An index written before this plugin owned it already carries the
	// one-line purposes; harvest them so adopting a project loses nothing.
	// The sidecar wins once a resource has one, so the harvest only fills the
	// gaps and fades out as resources are touched.
	const harvested = inspected.mode === 'index' ? parseIndexEntries(agentsText) : new Map()
	for (const resource of state.resources) {
		const known = harvested.get(resource.path)
		if (known === undefined) continue
		// The label and the position are the author's, not ours: an index is
		// curated by hand, and regenerating it must not reorder it or rename
		// entries that were fine.
		resource.label = known.label
		resource.order = known.order
		if (resource.description === '' && known.summary !== '') {
			resource.description = known.summary
			resource.harvested = true
		}
	}
	state.index.mode = inspected.mode
	state.index.present = inspected.mode === 'index'
	state.index.refs = indexRefs(inspected.mode === 'index' ? agentsText : '')
	const existing = new Set(state.resources.map((item) => item.path))
	state.index.stale = state.index.refs.filter((ref) => ref !== 'harness/harness.md' && !existing.has(ref))
	state.index.missing = state.resources.map((item) => item.path).filter((path) => !state.index.refs.includes(path))
	if (state.overview && !state.index.refs.includes('harness/harness.md')) state.index.stale.push('harness/harness.md')
	state.skipped = totals.skipped
	state.truncated = totals.truncated
	state.omitted = totals.omitted
	return state
}

/**
 * The file name part of a POSIX resource path.
 *
 * @param {string} path - A `/`-separated path.
 * @returns {string} The last segment.
 */
function baseOf(path) {
	const parts = String(path).split('/')
	return parts[parts.length - 1]
}

/**
 * Read `- [title](path)：summary` lines into a path → summary map.
 *
 * @param {string} text - The index document.
 * @returns {Map<string, {label: string, summary: string, order: number}>} The purposes it states.
 * @internal exported for tests
 */
export function parseIndexEntries(text) {
	const map = new Map()
	const pattern = /^- \[([^\]]+)\]\((harness\/[^)]+)\)\s*[：:]\s*(.+)$/gm
	let order = 0
	for (const match of String(text ?? '').matchAll(pattern)) {
		const path = match[2].trim()
		if (map.has(path)) continue
		map.set(path, { label: match[1].trim(), summary: match[3].trim(), order: order++ })
	}
	return map
}

/**
 * Every `harness/...` path an index document refers to.
 *
 * @param {string} text - The document.
 * @returns {string[]} The paths, in order of appearance.
 */
export function indexRefs(text) {
	const pattern = /harness\/(?:harness\.md|(?:workflow|experience|tool|resources)\/[^\s`)\]}，。；：、,;:"'|]+)/g
	return [...new Set(
		(String(text ?? '').match(pattern) ?? []).map((ref) => ref.replace(/[.,;:]+$/, '')),
	)]
}

/**
 * The order the index lists resources in.
 *
 * The overview comes first, then the four layers in their fixed order. Inside
 * a layer the entries an older index had keep the position its author gave
 * them; a resource that was added later lands at the end of its own layer, in
 * path order. The result is deterministic: the same folder always produces the
 * same index, so a diff only ever shows what actually changed.
 *
 * @param {object[]} resources - The catalog resources.
 * @returns {object[]} The resources, ordered.
 */
export function orderResources(resources) {
	const overview = resources.filter((resource) => resource.layer === 'overview')
	const ordered = []
	for (const layer of LAYERS) {
		const inLayer = resources.filter((resource) => resource.layer === layer)
		const known = inLayer.filter((resource) => resource.order !== undefined)
			.sort((left, right) => left.order - right.order)
		const fresh = inLayer.filter((resource) => resource.order === undefined)
			.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
		ordered.push(...known, ...fresh)
	}
	return [...overview, ...ordered]
}

/**
 * Build the index from a catalog.
 *
 * The index is the whole `AGENTS.md`: a fixed header, then one line per
 * resource — every file under `harness/`, with the description its sidecar
 * declares. Nothing is left out, because an index that skips a file is an
 * index that hides it.
 *
 * @param {object} state - The catalog.
 * @returns {string} The index document.
 */
export function renderIndex(state) {
	const lines = [REQUIRED_INDEX_TEXT[0], REQUIRED_INDEX_TEXT[1], '']
	for (const resource of orderResources(state.resources)) {
		const label = resource.sidecar === true
			? resource.title
			: (resource.label || resource.title || basename(resource.path))
		const description = String(resource.description ?? '').trim()
		lines.push(description === ''
			? `- [${label}](${resource.path})`
			: `- [${label}](${resource.path})：${description}`)
	}
	return lines.join('\n')
}

/**
 * Whether a document is nothing but an index.
 *
 * This is the shape the index has always had: a header, then one link line
 * per resource. A file that looks like this is an index — an old one or a
 * current one — and its entries can be harvested. A file with prose in it is
 * a hand-written document, and the plugin does not touch it without a backup.
 *
 * @param {string} text - The trimmed document.
 * @returns {boolean} True when every line belongs to an index.
 */
export function isBareIndex(text) {
	for (const line of String(text ?? '').split('\n')) {
		const trimmed = line.trim()
		if (trimmed === '') continue
		if (trimmed.startsWith('- [')) continue
		if (trimmed.startsWith('#')) continue
		if (trimmed.startsWith('>')) continue
		if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) continue
		return false
	}
	return true
}

/**
 * What shape the project's `AGENTS.md` has.
 *
 * - `absent`: there is no file (or it is empty);
 * - `index`: the file is an index — the current one or an old one, both of
 *   which can be harvested and rebuilt;
 * - `handwritten`: the file holds prose. It is not an index, so the plugin
 *   will not silently replace it: it backs it up first.
 *
 * @param {string} text - The AGENTS.md text.
 * @returns {{mode: 'absent' | 'index' | 'handwritten'}} What it is.
 * @internal exported for tests
 */
export function inspectAgents(text) {
	const source = String(text ?? '')
	if (source.trim() === '') return { mode: 'absent' }
	// An index always has entries; a file with only headings is a document
	// that happens to look like one, and replacing it without a backup would
	// lose whatever the author wrote there.
	if (isBareIndex(source) && /^- \[/m.test(source)) return { mode: 'index' }
	return { mode: 'handwritten' }
}

/** How many times an index write re-reads `AGENTS.md` after an external edit. */
const INDEX_WRITE_RETRIES = 2

const pathLocks = new Map()

/**
 * The read-modify-write locks this process holds, keyed by physical path.
 *
 * Tools run concurrently inside one host process. Two `file_write`
 * calls interleaving would each rebuild the index from their own catalog
 * snapshot, and whichever wrote last would drop the other's entry
 * (stability audit P2-5). The lock is keyed by the *physical* path, so two
 * spellings of the same project serialize against each other. It is
 * deliberately per-process: another DSH instance or a human editor is handled
 * by the snapshot/retry in `writeAgentsIndex`, because no in-process lock can
 * fence them out.
 *
 * @param {string} path - The file whose read-modify-write cycle must serialize.
 * @param {() => Promise<unknown>} task - The cycle.
 * @returns {Promise<unknown>} Whatever the task returns.
 */
export async function withPathLock(path, task) {
	const key = await canonicalPath(path)
	const previous = pathLocks.get(key) ?? Promise.resolve()
	let release
	const current = new Promise((resolve) => { release = resolve })
	const queued = previous.then(() => current)
	pathLocks.set(key, queued)
	await previous
	try {
		return await task()
	} finally {
		release()
		if (pathLocks.get(key) === queued) pathLocks.delete(key)
	}
}

/**
 * A file's text together with the stat signature it was read at.
 *
 * @param {string} path - The file.
 * @returns {Promise<{text: string | undefined, mtimeMs: number | undefined, size: number | undefined}>} The snapshot.
 */
async function fileSnapshot(path) {
	const text = await readFile(path, 'utf8').catch(() => undefined)
	if (text === undefined) return { text: undefined, mtimeMs: undefined, size: undefined }
	const info = await stat(path).catch(() => undefined)
	return { text, mtimeMs: info?.mtimeMs, size: info?.size }
}

/**
 * Whether two snapshots are the same file state.
 *
 * Text equality is the real check (mtime can stay the same across a fast
 * rewrite); `mtimeMs`/`size` are carried so a caller can report *that* the file
 * moved, and so the comparison stays cheap to explain.
 *
 * @param {object} left - The earlier snapshot.
 * @param {object} right - The later snapshot.
 * @returns {boolean} True when the file is unchanged.
 */
function sameSnapshot(left, right) {
	return left.text === right.text && left.size === right.size && left.mtimeMs === right.mtimeMs
}

/**
 * Merge the managed index block into `AGENTS.md` without losing edits made
 * after it was read.
 *
 * The managed block is derived, but the document around it is not: a user (or
 * another agent, or another DSH instance) may write `AGENTS.md` while this
 * write is in flight. The write therefore snapshots the file, re-reads it right
 * before renaming, and re-merges on a mismatch, so an edit outside the block
 * survives and a concurrent write is either merged with or reported as a
 * conflict — never silently overwritten (stability audit P2-5).
 *
 * @param {string} root - The project root.
 * @param {string} indexText - The rendered index.
 * @param {{hooks?: {beforeIndexWrite?: (event: {attempt: number, path: string}) => Promise<void> | void}}} [options] - Test seam for the read→write window.
 * @returns {Promise<{changed: boolean, text: string, mode: string, previous: string | undefined}>} What is on disk, and the snapshot it was merged from.
 */
export async function writeAgentsIndex(root, indexText, { hooks } = {}) {
	const agentsPath = join(root, 'AGENTS.md')
	const next = `${String(indexText ?? '').trimEnd()}\n`
	for (let attempt = 0; attempt <= INDEX_WRITE_RETRIES; attempt += 1) {
		const before = await fileSnapshot(agentsPath)
		if (next === (before.text ?? '')) return { changed: false, text: next, previous: before.text }
		// The only way to inject an external edit into the window in a test;
		// production callers pass no hooks and this is a no-op.
		if (hooks?.beforeIndexWrite !== undefined) await hooks.beforeIndexWrite({ attempt, path: agentsPath })
		const now = await fileSnapshot(agentsPath)
		if (!sameSnapshot(before, now)) continue
		await writeFileAtomic(agentsPath, next)
		return { changed: true, text: next, previous: before.text }
	}
	throw new Error('AGENTS.md 在读取后被其他写入改动（重试 2 次仍未稳定），索引写入冲突；没有覆盖对方的改动，请稍后重试。')
}

/**
 * Keep a hand-written `AGENTS.md` before the index replaces it.
 *
 * The project's `AGENTS.md` is the harness index, so a file that holds prose
 * there has to go somewhere. It is copied to `AGENTS.legacy-<hash>.md` first:
 * the name is derived from the content, so backing the same document up twice
 * does not litter the project, and the copy is never indexed.
 *
 * @param {string} root - The project root.
 * @param {string} text - The hand-written document.
 * @returns {Promise<string>} The project-relative path of the backup.
 */
export async function backupAgents(root, text) {
	const digest = createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 8)
	const name = `AGENTS.legacy-${digest}.md`
	await writeFileAtomic(join(root, name), String(text ?? ''))
	return name
}

/**
 * Rebuild the index of one project.
 *
 * The index is derived from the folder, so it cannot disagree with it. A
 * hand-written `AGENTS.md` is backed up before it is replaced.
 *
 * @param {string} root - The project root.
 * @returns {Promise<{entries: number, changed: boolean, backup?: string}>} What was written.
 */
export async function ensureIndex(root) {
	const agentsPath = join(root, 'AGENTS.md')
	return withPathLock(agentsPath, async () => {
		const state = await catalog(root)
		if (state.limited) {
			throw new Error(`harness/ 的文件数超过单次扫描上限（${CATALOG_LIMITS.maxFiles}），catalog 清单不完整，拒绝用它重建 AGENTS.md 索引；请先精简 harness/。`)
		}
		const current = await readText(agentsPath)
		let backup
		if (current !== '' && inspectAgents(current).mode === 'handwritten') {
			backup = await backupAgents(root, current)
		}
		const applied = await writeAgentsIndex(root, renderIndex(state))
		return { entries: state.resources.length, changed: applied.changed, ...(backup === undefined ? {} : { backup }) }
	})
}

/**
 * Move a folder laid out the old way into the current four layers.
 *
 * `scripts/` becomes `tool/`, and `references/` and `assets/` both become
 * `resources/`. Every path written inside the folder is rewritten too — a
 * workflow that says `python3 harness/scripts/x.py` would be a dead command
 * after the rename, which is exactly the kind of rot this system exists to
 * prevent.
 *
 * Runs under the same lock as a resource write: a migration moving files while
 * a write rebuilds the index would otherwise read a half-migrated folder.
 *
 * @param {string} root - The project root.
 * @param {{dryRun?: boolean}} [options] - Whether to only report.
 * @returns {Promise<{moved: string[], rewritten: number, renamed: string[]}>} What changed.
 */
export async function migrateLayout(root, { dryRun = false } = {}) {
	return withPathLock(join(root, 'AGENTS.md'), () => migrateLayoutLocked(root, { dryRun }))
}

/**
 * The migration body, already under the project lock.
 *
 * @param {string} root - The project root.
 * @param {{dryRun: boolean}} options - Whether to only report.
 * @returns {Promise<{moved: string[], rewritten: number, renamed: string[]}>} What changed.
 */
async function migrateLayoutLocked(root, { dryRun = false } = {}) {
	const harnessDir = join(root, 'harness')
	const agentsPath = join(root, 'AGENTS.md')
	const moved = []
	const renamed = []
	const present = await readdir(harnessDir).catch(() => [])
	const plan = [
		['scripts', TOOL_LAYER],
		['references', RESOURCE_LAYER],
		['assets', RESOURCE_LAYER],
	]
	// Plan every move before touching the disk. `scripts/` can only collide
	// with itself, but `references/` and `assets/` merge into one folder: two
	// files named the same used to overwrite each other silently, and the
	// source folder was then deleted.
	const moves = []
	const claimed = new Set()
	for (const [from, to] of plan) {
		if (!present.includes(from)) continue
		const source = join(harnessDir, from)
		const target = join(harnessDir, to)
		const items = (await listFiles(source)).files
		moved.push(`${from}/ → ${to}/ (${items.length})`)
		for (const entry of items) {
			const destination = await freeDestination(join(target, entry.name), from, claimed)
			claimed.add(destination)
			if (destination !== join(target, entry.name)) {
				renamed.push(`${from}/${entry.name} → ${to}/${destination.slice(target.length + 1)}`)
			}
			moves.push({ source: join(source, entry.name), destination })
		}
	}
	if (dryRun) {
		return {
			moved,
			rewritten: 0,
			renamed,
		}
	}
	for (const move of moves) {
		await mkdir(dirname(move.destination), { recursive: true, mode: 0o700 })
		await rename(move.source, move.destination)
	}
	// Only the now-empty source folders are left; removing them keeps the
	// layer list clean without touching a file that was skipped as noise.
	for (const [from] of plan) {
		if (!present.includes(from)) continue
		await rm(join(harnessDir, from), { recursive: true, force: true })
	}
	// A layer that never held anything still has to exist: the structure is
	// half the contract, and an empty folder is cheaper than a special case.
	for (const layer of LAYERS) {
		await mkdir(join(harnessDir, layer), { recursive: true, mode: 0o700 })
	}
	const files = await readdir(harnessDir, { recursive: true }).catch(() => [])
	for (const entry of files) {
		const path = join(harnessDir, String(entry))
		const info = await lstat(path).catch(() => undefined)
		if (info === undefined || info.isDirectory()) continue
		if (!/\.(md|txt|ya?ml|json)$/i.test(path)) continue
		const text = await readFile(path, 'utf8').catch(() => undefined)
		if (text === undefined) continue
		const next = rewritePaths(text)
		if (next !== text) await writeFile(path, next, { mode: 0o600 })
	}
	// The index lives at the project root, not under harness/. Rewriting it
	// here is what lets the migration keep each entry's label and purpose:
	// they are looked up by path, and the path just changed. Only an index is
	// rewritten — a hand-written `AGENTS.md` is left alone, and the write that
	// triggered the migration backs it up before replacing it.
	const agents = await readFile(agentsPath, 'utf8').catch(() => undefined)
	if (agents !== undefined && inspectAgents(agents).mode === 'index') {
		const next = rewritePaths(agents)
		if (next !== agents) await writeFile(agentsPath, next, { mode: 0o600 })
	}

	return {
		moved,
		rewritten: dryRun ? 0 : await countRewrites(harnessDir),
		renamed,
	}
}

/**
 * Point every mention of a retired layer at its new home.
 *
 * @param {string} text - The document.
 * @returns {string} The document with current paths.
 */
function rewritePaths(text) {
	return String(text ?? '').replace(
		/(harness\/|\.\.\/|\(|`|\s)(scripts|references|assets)\//g,
		(_match, prefix, layer) => `${prefix}${RETIRED_LAYERS[layer]}/`,
	)
}

/**
 * How many documents still mention a retired layer.
 *
 * @param {string} harnessDir - The harness folder.
 * @returns {Promise<number>} The count.
 */
async function countRewrites(harnessDir) {
	const files = await readdir(harnessDir, { recursive: true }).catch(() => [])
	let count = 0
	for (const entry of files) {
		const path = join(harnessDir, String(entry))
		if (!path.endsWith('.md')) continue
		const text = await readFile(path, 'utf8').catch(() => '')
		if (/(?:scripts|references|assets)\//.test(text)) count += 1
	}
	return count
}

/**
 * Create the folder skeleton when it is missing.
 *
 * The overview gets a sidecar of its own, so the index has something to say
 * about it before anybody writes the project overview. A project still laid
 * out the old way is migrated first: the four layers are the structure the
 * index describes, and a retired folder would only be noise in it.
 *
 * @param {string} root - The project root.
 * @param {{dryRun?: boolean}} [options] - Whether to only report.
 * @returns {Promise<string[]>} What was created.
 */
export async function initHarness(root, { dryRun = false } = {}) {
	const created = []
	const harnessDir = join(root, 'harness')
	const plan = [join(harnessDir, OVERVIEW), ...LAYERS.map((layer) => join(harnessDir, layer))]
	for (const target of plan) {
		if (await exists(target)) continue
		created.push(target.slice(root.length + 1))
		if (!dryRun) {
			if (target.endsWith(OVERVIEW)) {
				await mkdir(harnessDir, { recursive: true, mode: 0o700 })
				await writeFile(target, OVERVIEW_TEMPLATE, { mode: 0o600 })
			} else {
				await mkdir(target, { recursive: true, mode: 0o700 })
			}
		}
	}
	if (!dryRun) {
		const overview = `harness/${OVERVIEW}`
		if (!(await exists(sidecarPath(root, overview)))) {
			await writeSidecar(root, overview, { title: OVERVIEW_TITLE, description: OVERVIEW_DESCRIPTION })
		}
		const retired = []
		for (const name of Object.keys(RETIRED_LAYERS)) {
			if (await exists(join(harnessDir, name))) retired.push(name)
		}
		if (retired.length > 0) await migrateLayout(root)
	}
	return created
}
