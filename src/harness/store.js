/**
 * The `harness/` resource system: a project-scoped memory that travels with
 * the repository.
 *
 * The card library answers "what did I learn that holds anywhere"; this
 * answers "what is true about *this* repository" — its build commands, its
 * architecture constraints, the traps its own tools set. It lives in
 * `harness/` next to the code, is indexed by the project's `AGENTS.md`, and is
 * therefore in the model's context through the host's own instruction loading
 * rather than through anything this plugin injects.
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
 */

import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

import { writeFileAtomic } from '../atomic.js'

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

/** The overview file every harness folder carries. */
export const OVERVIEW = 'harness.md'

/** The three lines the index must carry, whatever else it says. */
export const REQUIRED_INDEX_TEXT = [
	'> 在执行任何操作前，必须先根据下方文件索引查阅获取足够上下文，确认信息充分后再行动；`harness/harness.md` 是必须查阅的项目总览。',
	'# 文档索引，按需查阅',
	'harness/harness.md',
]

const OVERVIEW_TEMPLATE = `# Harness 项目资源总览

## 项目总览

记录项目长期稳定的总览、关键约束、常用入口和注意事项。

## 资源分层

- workflow：稳定可执行流程。
- experience：可复用判断经验。
- tool：可重复执行的东西——脚本、可执行文件、CLI 都算。
- resources：工具要读的东西——外部规范、长背景、模板、示例输入、静态资源。
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
 * The files under one folder, as relative POSIX paths.
 *
 * `readdir(..., { recursive: true })` also returns the directories it walks
 * through. Treating those as resources put folder links in the index, and a
 * migration that renamed the folder first then failed on the files inside it.
 * Only files are returned, sorted, so every caller sees the same order.
 *
 * @param {string} dir - The folder.
 * @returns {Promise<string[]>} The relative file paths.
 */
async function listFiles(dir) {
	const entries = await readdir(dir, { recursive: true }).catch(() => [])
	const files = []
	for (const entry of entries) {
		const name = String(entry).split('\\').join('/')
		if (isNoise(name)) continue
		const info = await lstat(join(dir, name)).catch(() => undefined)
		if (info === undefined || info.isDirectory()) continue
		files.push(name)
	}
	return files.sort()
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
 * Find the project root that owns a directory.
 *
 * A repository is identified the way the host identifies one — a `.git` — with
 * a `harness/` folder and an `AGENTS.md` accepted as equally good evidence,
 * because a harness can be set up before the repository is.
 *
 * @param {string} start - A directory inside the project.
 * @returns {Promise<string | undefined>} The absolute root, or undefined.
 */
export async function projectRootOf(start) {
	if (typeof start !== 'string' || start === '' || !isAbsolute(start)) return undefined
	let current = resolve(start)
	const info = await lstat(current).catch(() => undefined)
	if (info !== undefined && info.isFile()) current = dirname(current)
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
 * Read one resource file, tolerating a missing or unreadable one.
 *
 * @param {string} path - The file.
 * @returns {Promise<string>} The text, or an empty string.
 */
async function readText(path) {
	return readFile(path, 'utf8').catch(() => '')
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
 * Collapse a field to the single line frontmatter can carry.
 *
 * A newline in a title or a summary does not fail loudly: it ends the
 * frontmatter field early, leaves the rest of the text as body, and makes the
 * index show half a sentence. The field is a label, so whitespace becomes one
 * space before anything is written.
 *
 * @param {unknown} value - The field.
 * @returns {string} The single-line text.
 */
function singleLine(value) {
	return String(value ?? '').replace(/[\r\n\u0000]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Render a document with frontmatter.
 *
 * @param {Record<string, string>} meta - The fields to write.
 * @param {string} body - The document body.
 * @returns {string} The document.
 */
export function withFrontmatter(meta, body) {
	const lines = Object.entries(meta)
		.map(([key, value]) => [key, singleLine(value)])
		.filter(([, value]) => value !== '')
		.map(([key, value]) => `${key}: ${value}`)
	if (lines.length === 0) return String(body ?? '')
	return `---\n${lines.join('\n')}\n---\n${String(body ?? '')}`
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
 * @param {string} root - The project root.
 * @returns {Promise<object>} The catalog.
 */
export async function catalog(root) {
	const harnessDir = join(root, 'harness')
	const agentsPath = join(root, 'AGENTS.md')
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
		index: { present: false, refs: [], stale: [], missing: [] },
	}

	if (!state.present) {
		state.missing = [OVERVIEW, ...LAYERS]
		return state
	}

	const top = await readdir(harnessDir).catch(() => [])
	for (const name of top.sort()) {
		if (name !== OVERVIEW && !LAYERS.includes(name)) state.unexpected.push(name)
	}
	state.overview = await exists(join(harnessDir, OVERVIEW))
	if (!state.overview) state.missing.push(OVERVIEW)
	else {
		const { meta, body } = splitFrontmatter(await readText(join(harnessDir, OVERVIEW)))
		state.resources.push({
			path: `harness/${OVERVIEW}`,
			layer: 'overview',
			title: meta.title ?? firstHeading(body) ?? OVERVIEW,
			summary: meta.summary ?? '',
		})
	}

	for (const layer of LAYERS) {
		const dir = join(harnessDir, layer)
		const info = await lstat(dir).catch(() => undefined)
		if (info === undefined || !info.isDirectory()) {
			state.missing.push(layer)
			state.layers[layer] = []
			continue
		}
		const files = (await listFiles(dir)).map((entry) => `harness/${layer}/${entry}`)
		state.layers[layer] = files
		for (const path of files) {
			const { meta, body } = splitFrontmatter(await readText(join(root, path)))
			state.resources.push({
				path,
				layer,
				title: meta.title ?? firstHeading(body) ?? basename(path),
				summary: meta.summary ?? '',
			})
		}
	}

	const agentsText = await readText(agentsPath)
	// An index written before this plugin owned it already carries the
	// one-line purposes; harvest them so migrating loses nothing. Frontmatter
	// wins once a file has it, so the harvest fades out as files are touched.
	const harvested = parseIndexEntries(agentsText)
	for (const resource of state.resources) {
		const known = harvested.get(resource.path)
		if (known === undefined) continue
		// The label and the position are the author's, not ours: an index is
		// curated by hand, and regenerating it must not reorder it or rename
		// entries that were fine.
		resource.label = known.label
		resource.order = known.order
		if (resource.summary === '') {
			resource.summary = known.summary
			resource.harvested = true
		}
	}
	state.index.present = agentsText !== ''
	state.index.refs = indexRefs(agentsText)
	const existing = new Set(state.resources.map((item) => item.path))
	state.index.stale = state.index.refs.filter((ref) => ref !== 'harness/harness.md' && !existing.has(ref))
	state.index.missing = state.resources.map((item) => item.path).filter((path) => !state.index.refs.includes(path))
	if (state.overview && !state.index.refs.includes('harness/harness.md')) state.index.stale.push('harness/harness.md')
	return state
}

/**
 * Read `- [title](path)：summary` lines into a path → summary map.
 *
 * @param {string} text - The index document.
 * @returns {Map<string, string>} The purposes it states.
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
 * Build the index block from a catalog.
 *
 * Deterministic on purpose: the same folder produces the same bytes, so a
 * diff only ever shows what actually changed.
 *
 * @param {object} state - The catalog.
 * @returns {string} The block, without the markers.
 */
export function renderIndex(state) {
	const lines = [REQUIRED_INDEX_TEXT[0], REQUIRED_INDEX_TEXT[1], '']
	const link = (resource) => {
		const label = resource.label || resource.title || basename(resource.path)
		const summary = resource.summary || '待补充 summary'
		return `- [${label}](${resource.path})：${summary}`
	}
	const overview = state.resources.find((resource) => resource.path === `harness/${OVERVIEW}`)
	lines.push(
		`- [Harness 开发指南](harness/harness.md)：${overview?.summary || '项目总览、关键约束、常用入口和注意事项'}`,
	)
	const layerIndex = (resource) => LAYERS.indexOf(resource.layer)
	const ordered = state.resources
		.filter((resource) => resource.path !== 'harness/harness.md')
		.sort((left, right) => {
			// Known entries keep the position the author gave them; new ones
			// land at the end of their own layer, in path order.
			const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER
			const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER
			if (leftOrder !== rightOrder) return leftOrder - rightOrder
			if (layerIndex(left) !== layerIndex(right)) return layerIndex(left) - layerIndex(right)
			return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
		})
	for (const resource of ordered) lines.push(link(resource))
	return lines.join('\n')
}

/**
 * Build the whole AGENTS.md.
 *
 * The index *is* the file: every AGENTS.md in this user's projects is generated
 * and none of them carries hand-written content, so there is nothing to protect
 * with markers and nothing to merge. The previous text is only read to keep the
 * order and the wording that are already there.
 *
 * @param {string} block - The rendered index.
 * @returns {string} The document.
 */
export function documentOf(block) {
	return `${String(block ?? '').trimEnd()}\n`
}

/**
 * Whether a document is nothing but a harness index.
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
 * Rebuild the index block of one project.
 *
 * The only way the block changes is by running this: it is derived from the
 * folder, so it cannot disagree with it.
 *
 * @param {string} root - The project root.
 * @returns {Promise<{entries: number, changed: boolean}>} What was written.
 */
export async function ensureIndex(root) {
	const state = await catalog(root)
	const agentsPath = join(root, 'AGENTS.md')
	const current = await readFile(agentsPath, 'utf8').catch(() => '')
	if (current.trim() !== '' && !isBareIndex(current)) {
		throw new Error(
			'AGENTS.md 里有不是索引的内容，拒绝整篇覆盖；先手动清掉那些内容，或把它挪到 harness/harness.md。',
		)
	}
	const next = documentOf(renderIndex(state))
	if (next !== current) await writeFileAtomic(agentsPath, next)
	return { entries: state.resources.length, changed: next !== current }
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
 * @param {string} root - The project root.
 * @param {{dryRun?: boolean}} [options] - Whether to only report.
 * @returns {Promise<{moved: string[], rewritten: number, renamed: string[]}>} What changed.
 */
export async function migrateLayout(root, { dryRun = false } = {}) {
	const harnessDir = join(root, 'harness')
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
		const items = await listFiles(source)
		moved.push(`${from}/ → ${to}/ (${items.length})`)
		for (const entry of items) {
			const destination = await freeDestination(join(target, entry), from, claimed)
			claimed.add(destination)
			if (destination !== join(target, entry)) {
				renamed.push(`${from}/${entry} → ${to}/${destination.slice(target.length + 1)}`)
			}
			moves.push({ source: join(source, entry), destination })
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
	// they are looked up by path, and the path just changed.
	const agentsPath = join(root, 'AGENTS.md')
	const agents = await readFile(agentsPath, 'utf8').catch(() => undefined)
	if (agents !== undefined) {
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
	return created
}
