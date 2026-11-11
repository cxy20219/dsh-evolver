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
 *   harness/scripts/            runnable tools
 *   harness/references/         long background
 *   harness/assets/             templates and fixtures
 */

import { lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** The five resource layers, in the order the index lists them. */
export const LAYERS = ['workflow', 'experience', 'scripts', 'references', 'assets']

/** The layers whose entries are prose documents. */
export const DOC_LAYERS = ['workflow', 'experience', 'references']

/** The layers whose entries must be referenced by a document. */
export const REFERENCED_LAYERS = ['scripts', 'assets']

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
- scripts：可重复执行、检查、迁移、生成、验证的动作。
- references：长背景、外部规范、版本差异、原理说明。
- assets：模板、示例输入、静态资源。
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
 * Render a document with frontmatter.
 *
 * @param {Record<string, string>} meta - The fields to write.
 * @param {string} body - The document body.
 * @returns {string} The document.
 */
export function withFrontmatter(meta, body) {
	const lines = Object.entries(meta)
		.filter(([, value]) => typeof value === 'string' && value.trim() !== '')
		.map(([key, value]) => `${key}: ${value.trim()}`)
	if (lines.length === 0) return String(body ?? '')
	return `---\n${lines.join('\n')}\n---\n${String(body ?? '')}`
}

/**
 * The first heading of a document, used when it declares no summary.
 *
 * @param {string} body - The document body.
 * @returns {string} The heading text, or an empty string.
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
		const entries = await readdir(dir, { recursive: true }).catch(() => [])
		const files = entries
			.filter((entry) => !isNoise(String(entry)))
			.map((entry) => `harness/${layer}/${String(entry).split('\\').join('/')}`)
			.sort()
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
	const pattern = /harness\/(?:harness\.md|(?:workflow|experience|references|scripts|assets)\/[^\s`)\]}，。；：、,;:"'|]+)/g
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
	if (next !== current) {
		const temp = `${agentsPath}.${process.pid}.${Date.now()}.tmp`
		await writeFile(temp, next, { mode: 0o600 })
		await rename(temp, agentsPath)
	}
	return { entries: state.resources.length, changed: next !== current }
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
