/**
 * The tools the agent gets from 自衍中枢.
 *
 * Four verbs, one tool each: search, read, write, edit. The library is one
 * kind of file store and a project's `harness/` is another, so the same verb
 * serves both — where a write or edit lands decides which contract applies,
 * and the tool name says only what is being done.
 *
 * The descriptions are the place for the write contract (description, tags,
 * links, what a harness write validates), because they ride on every request
 * anyway; the system section only says what no tool says.
 *
 * Results are JSON. A write returns a compact summary without the payload;
 * `file_read` is the only tool that returns text, and it caps it.
 */

import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { writeFileAtomic } from './atomic.js'
import {
	LAYERS,
	catalog,
	initHarness,
	inspectIndex,
	isReallyInside,
	isWithin,
	projectRootOf,
	renderIndex,
	splitFrontmatter,
	writeAgentsIndex,
} from './harness/store.js'
import { validate } from './harness/validate.js'
import { slugOf, writeResource } from './harness/write.js'
import { isFileId } from './ids.js'
import { OBJECT_OUTPUT, sanitize, summaryOf } from './json.js'
import { descriptionAdvice } from './meta.js'
import { isTextMime, isTextual } from './names.js'
import { estimateTokens } from './tokens.js'

/** The markdown layers: their resources carry a title/summary frontmatter. */
const DOCUMENT_LAYERS = ['workflow', 'experience']

/** The most a project file read returns inline. */
const PROJECT_READ_BYTES = 256 * 1024

/**
 * Resolve a full id or a unique short id to a full id.
 *
 * A full id is passed through even when the index has not seen it yet (a
 * sidecar-only file can still be read); a short id must resolve against the
 * library, because there is nothing else to expand it against.
 *
 * @param {object} store - The file store.
 * @param {unknown} value - The id or suffix.
 * @returns {string} The full id, or an empty string.
 */
function resolveInput(store, value) {
	const raw = String(value ?? '').trim()
	if (raw === '') return ''
	const resolved = store.resolveId(raw)
	if (resolved !== undefined) return resolved
	return isFileId(raw) ? raw : ''
}

/**
 * Add a non-blocking advice when a write's description would be hard to find.
 *
 * The write is valid either way; the warning is the one place the model sees
 * the "describe the future scenario" rule right after it wrote.
 *
 * @param {object} file - A `store.create()` / `store.update()` result.
 * @returns {object} The file, plus `warnings` when advice applies.
 */
function withDescriptionAdvice(file) {
	if (file === null || typeof file !== 'object') return file
	const advice = descriptionAdvice(file.description)
	if (advice === '') return file
	const warnings = Array.isArray(file.warnings) ? file.warnings.concat(advice) : [advice]
	return { ...file, warnings }
}

/**
 * Normalise the `meta` argument.
 *
 * @param {unknown} value - The raw argument.
 * @returns {Record<string, unknown>} The object, or an empty one.
 */
function metaOf(value) {
	if (value === undefined || value === null) return {}
	if (typeof value !== 'object' || Array.isArray(value)) throw new Error('meta 必须是对象：{name?,description?,tags?,links?,title?,summary?,layer?}。')
	return value
}

/**
 * The search page size, clamped to the declared bounds.
 *
 * @param {unknown} value - The requested limit.
 * @returns {number} 1..100, defaulting to 20.
 */
function pageSize(value) {
	return Math.min(100, Math.max(1, Math.round(Number(value) || 20)))
}

/**
 * Trimmed string argument.
 *
 * @param {unknown} value - The argument.
 * @returns {string} The trimmed text, or `''`.
 */
function textOf(value) {
	return String(value ?? '').trim()
}

/**
 * The sentinel that asks for the project harness listing instead of a file.
 *
 * @param {string} target - The read target.
 * @returns {boolean} True for `harness` / `harness/` (any slash flavour).
 */
function isHarnessListing(target) {
	return target === 'harness' || target === 'harness/' || target === 'harness\\'
}

/**
 * The project-relative POSIX spelling of an absolute path.
 *
 * @param {string} root - The project root.
 * @param {string} path - An absolute path.
 * @returns {string | undefined} The relative path, or undefined when outside.
 */
function relativeTo(root, path) {
	const rel = relative(resolve(root), resolve(path))
	if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
	return rel.split(sep).join('/')
}

/**
 * Ask the injected resolver where the current session is.
 *
 * `paths` is optional: an organize job runs without a session, and the library
 * verbs must keep working there. A location without a cwd simply means the
 * project-path verbs have to refuse with a readable error.
 *
 * @param {((exec: object) => Promise<{cwd?: string, root?: string}>)} [paths] - The injected resolver.
 * @param {object} exec - The tool run context.
 * @returns {Promise<{cwd?: string, root?: string}>} The location.
 */
async function locate(paths, exec) {
	if (typeof paths !== 'function') return {}
	const value = await paths(exec ?? {})
	if (value === null || typeof value !== 'object') return {}
	const cwd = typeof value.cwd === 'string' && isAbsolute(value.cwd) ? resolve(value.cwd) : undefined
	const given = typeof value.root === 'string' && isAbsolute(value.root) ? resolve(value.root) : undefined
	if (given !== undefined) return { cwd, root: given }
	const root = cwd === undefined ? undefined : (await projectRootOf(cwd)) ?? cwd
	return { cwd, root }
}

/**
 * The location a project-path call needs, or a readable refusal.
 *
 * @param {((exec: object) => Promise<{cwd?: string, root?: string}>)} [paths] - The injected resolver.
 * @param {object} exec - The tool run context.
 * @returns {Promise<{cwd: string, root: string}>} The location.
 */
async function requireLocation(paths, exec) {
	const located = await locate(paths, exec)
	if (located.cwd === undefined) {
		throw new Error('无法确定当前会话工作目录：项目路径操作需要会话 cwd；文件库操作不受影响。请在带会话上下文的调用里使用（或让宿主挂载 sessionQuery）。')
	}
	return { cwd: located.cwd, root: located.root ?? located.cwd }
}

/**
 * Resolve one project path argument.
 *
 * A `harness/...` target is anchored at the project root, because that is
 * where the project harness lives even when the session was opened in a
 * subdirectory. Everything else is relative to the session cwd. The harness
 * contract follows the destination, not the spelling: an absolute path (or
 * `./harness/...`) that lands under `<root>/harness` is a harness path too.
 * Anything else is contained to the cwd and refused before any I/O when it
 * climbs out.
 *
 * @param {{cwd: string, root: string}} location - The session location.
 * @param {unknown} target - The caller's path.
 * @returns {{absolute: string, harness: boolean, relative: string | undefined}} The resolved target.
 */
function resolveProjectPath(location, target) {
	const raw = textOf(target)
	if (raw === '') throw new Error('需要 target：项目内路径。')
	const normalized = raw.split('\\').join('/')
	const spelling = normalized === 'harness' || normalized.startsWith('harness/')
	const harnessDir = join(location.root, 'harness')
	const anchor = spelling ? location.root : location.cwd
	const base = spelling ? harnessDir : location.cwd
	const absolute = resolve(anchor, normalized)
	const harness = spelling || isWithin(harnessDir, absolute)
	if (!isWithin(spelling || harness ? harnessDir : base, absolute)) {
		throw new Error(`路径越界：${raw} 不在允许的目录内（${spelling || harness ? harnessDir : base}）。`)
	}
	return { absolute, harness, relative: harness ? relativeTo(location.root, absolute) : undefined }
}

/**
 * The harness layer a project-relative path belongs to.
 *
 * @param {string | undefined} relativePath - `harness/...` spelling.
 * @returns {'overview' | 'workflow' | 'experience' | 'tool' | 'resources' | undefined} The layer.
 */
function layerOf(relativePath) {
	if (typeof relativePath !== 'string') return undefined
	const parts = relativePath.split('/')
	if (parts[0] !== 'harness') return undefined
	if (parts.length === 2 && parts[1] === 'harness.md') return 'overview'
	if (!LAYERS.includes(parts[1])) return undefined
	return parts[1]
}

/**
 * A compact copy of a harness catalog, small enough to read in one look.
 *
 * @param {object} state - The catalog `catalog()` returns.
 * @returns {object} The summary.
 */
function summarizeCatalog(state) {
	const summary = {
		root: state.root,
		present: state.present,
		agents: state.agents,
		overview: state.overview,
		layers: Object.fromEntries(Object.entries(state.layers).map(([layer, files]) => [layer, files.length])),
		resources: state.resources.map((item) => ({
			path: item.path,
			title: item.title,
			...(item.summary === '' ? { summary: '(missing)' } : {}),
		})),
		index: {
			entries: state.index.refs.length,
			mode: state.index.mode,
			notIndexed: state.index.missing,
			pointingNowhere: state.index.stale,
			...((state.index.mode === 'absent' || state.index.mode === 'legacy') ? {
				next: state.index.mode === 'legacy'
					? 'AGENTS.md 是旧式裸索引（没有受管块）；下一次写入会自动包进受管块。'
					: 'AGENTS.md 还没有受管索引块；写入 harness 资源时会自动追加，块外内容不动。',
			} : {}),
		},
		missing: state.missing,
		unexpected: state.unexpected,
	}
	if (!state.present) {
		summary.needsInit = true
		summary.next = '项目没有 harness/。写入一个 harness/ 路径（如 harness/experience/x.md）会自动建骨架并重建 AGENTS.md 索引。'
	}
	return summary
}

/**
 * Put one file back only while it still holds what this write put there.
 *
 * @param {string} path - The file.
 * @param {string} written - The exact text this write put there.
 * @param {string | undefined} previous - The text before the write.
 * @returns {Promise<boolean>} True when the file was restored.
 */
async function restoreIfUnchanged(path, written, previous) {
	const current = await readFile(path, 'utf8').catch(() => undefined)
	if (current !== written) return false
	if (previous === undefined) await rm(path, { force: true }).catch(() => {})
	else await writeFileAtomic(path, previous).catch(() => {})
	return true
}

/**
 * Put the managed index back to the snapshot a failed write merged into.
 *
 * @param {string} agentsPath - The document.
 * @param {{changed: boolean, text: string, previous: string | undefined}} applied - What the index write produced.
 * @returns {Promise<boolean>} True when it was restored.
 */
async function restoreAgents(agentsPath, applied) {
	if (applied?.changed !== true) return false
	const current = await readFile(agentsPath, 'utf8').catch(() => undefined)
	if (current !== applied.text) return false
	if (applied.previous === undefined) await rm(agentsPath, { force: true }).catch(() => {})
	else await writeFileAtomic(agentsPath, applied.previous).catch(() => {})
	return true
}

/**
 * Write one harness file verbatim, rebuild the index, validate, and roll back
 * the whole cycle when any step fails.
 *
 * This is the same strategy `writeResource` uses for documents (stability
 * audit P2-5): the raw target and `AGENTS.md` are only restored while they
 * still hold what this write left there, so an edit made in the window wins.
 *
 * @param {object} options - The write.
 * @param {string} options.root - The project root.
 * @param {string} options.absolute - The destination file.
 * @param {string} options.relativePath - Its `harness/...` spelling.
 * @param {string} options.layer - The layer it lives in.
 * @param {unknown} options.target - The caller's original target.
 * @param {string} options.content - The bytes as text.
 * @param {boolean} options.created - Whether the file did not exist before.
 * @returns {Promise<object>} What happened.
 */
async function writeHarnessRaw({ root, absolute, relativePath, layer, target, content, created }) {
	const agentsPath = join(root, 'AGENTS.md')
	const previous = await readFile(absolute, 'utf8').catch(() => undefined)
	const agentsPrevious = await readFile(agentsPath, 'utf8').catch(() => undefined)
	if (agentsPrevious !== undefined && inspectIndex(agentsPrevious).mode === 'broken') {
		throw new Error('AGENTS.md 的 harness 受管块标记不完整（缺 begin 或 end），没有写入；请手工补全或删掉残留标记后重试。')
	}
	if (!(await isReallyInside(join(root, 'harness'), absolute))) {
		throw new Error(`路径越界（真实路径不在 harness/ 内）：${relativePath}`)
	}
	const written = content.endsWith('\n') ? content : `${content}\n`
	await writeFileAtomic(absolute, written)
	let state
	let applied
	try {
		// Rebuild equivalent to ensureIndex, but keep the snapshot so a failed
		// validation can put AGENTS.md back.
		state = await catalog(root)
		if (state.limited === true) {
			throw new Error('harness/ 的文件数超过单次扫描上限，catalog 清单不完整，拒绝写入并重建索引；请先精简 harness/。')
		}
		applied = await writeAgentsIndex(root, renderIndex(state))
	} catch (error) {
		await restoreIfUnchanged(absolute, written, previous)
		throw error
	}
	const report = await validate(root)
	if (!report.ok) {
		await restoreIfUnchanged(absolute, written, previous)
		await restoreAgents(agentsPath, applied)
		throw new Error(`校验未通过，已回滚：${report.errors.slice(0, 3).join('；')}`)
	}
	return harnessResult({
		target,
		path: relativePath,
		layer,
		created,
		indexed: state.resources.length,
		errors: report.errors,
		warnings: report.warnings,
		skipped: report.skipped,
	})
}

/**
 * Shape one harness write result.
 *
 * @param {{target: unknown, path: string, layer: string, created: boolean, indexed: number, errors?: string[], warnings?: string[], skipped?: object[]}} value - The parts.
 * @returns {object} The result.
 */
function harnessResult({ target, path, layer, created, indexed, errors = [], warnings = [], skipped = [] }) {
	return {
		target,
		path,
		layer,
		created,
		warnings,
		indexed,
		validation: { ok: errors.length === 0, errors, warnings, skipped },
	}
}

/**
 * The text a `file_read` target names, if it is a project file.
 *
 * @param {string} target - The original argument.
 * @param {string} absolute - The resolved file.
 * @returns {Promise<object>} The read result.
 */
async function readProjectFile(target, absolute) {
	const info = await stat(absolute).catch(() => undefined)
	if (info === undefined) throw new Error(`项目内没有这个文件：${target}（解析为 ${absolute}）。`)
	if (!info.isFile()) return { target, path: absolute, bytes: info.size, directory: true }
	if (info.size > PROJECT_READ_BYTES) return { target, path: absolute, bytes: info.size, truncated: true }
	const buffer = await readFile(absolute)
	if (!isTextual(buffer)) return { target, path: absolute, bytes: info.size, binary: true }
	return { target, path: absolute, bytes: info.size, text: buffer.toString('utf8') }
}

/**
 * Replace exactly one occurrence of `old` in `text`.
 *
 * A replace that cannot name one spot is refused rather than guessed: zero
 * matches means the caller read a different version, several means the edit
 * would silently hit the wrong one.
 *
 * @param {string} text - The current body.
 * @param {unknown} old - The exact snippet.
 * @param {unknown} replacement - The new snippet.
 * @returns {string} The patched text.
 */
function replaceOnce(text, old, replacement) {
	const needle = String(old ?? '')
	if (needle === '') throw new Error('old 不能为空：给一段唯一能定位的原文。')
	const first = text.indexOf(needle)
	if (first === -1) throw new Error('未找到 old：正文里没有这段原文，未做修改。')
	const second = text.indexOf(needle, first + needle.length)
	if (second !== -1) {
		const count = text.split(needle).length - 1
		throw new Error(`old 命中 ${count} 次，需更长的 old 精确匹配一处。`)
	}
	return text.slice(0, first) + String(replacement ?? '') + text.slice(first + needle.length)
}

/**
 * The links argument of a library write.
 *
 * @param {Record<string, unknown>} meta - The meta argument.
 * @returns {unknown[] | undefined} The links, when the caller gave any.
 */
function linksOf(meta) {
	if (meta.links === undefined) return undefined
	if (!Array.isArray(meta.links)) throw new Error('meta.links 必须是数组：写关联文件 id。')
	return meta.links
}

/**
 * The write contract every library create shares.
 *
 * @param {Record<string, unknown>} meta - The meta argument.
 * @returns {{description: string, tags: unknown[]}} The validated fields.
 */
function libraryFields(meta) {
	const description = typeof meta.description === 'string' ? meta.description : ''
	const tags = meta.tags === undefined ? [] : meta.tags
	if (!Array.isArray(tags)) throw new Error('meta.tags 必须是数组：至少一个自由层级标签。')
	if (description.trim() === '') {
		throw new Error('库文件必须写 meta.description：一句话说清它是什么、以后哪些场景/任务会用到它（描述是唯一检索面）。')
	}
	if (tags.length === 0) throw new Error('库文件必须写 meta.tags：至少一个自由层级标签。')
	return { description, tags }
}

/**
 * Create the four tools.
 *
 * @param {{store: object, paths?: (exec: object) => Promise<{cwd?: string, root?: string}>}} deps - The library, and how a call finds its session location.
 * @returns {object[]} The tools.
 */
export function createTools({ store, paths } = {}) {
	return [
		{
			name: 'file_search',
			description: '按描述/名字/标签检索文件，不搜正文；先搜再读。无 query/tags 时返回最近文件 + 规模统计（文件数、链接、标签计数）。tags 数组是 AND，支持层级前缀；graph:true 时返回命中文件沿 links 的子图（nodes+edges），用于「文档 → 说明 → 脚本」这类多跳导航。',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: '检索词；与 tags 都不给时列最近文件并给规模统计' },
					tags: { type: 'array', items: { type: 'string' }, description: '标签数组，AND；支持层级前缀，例如 来源/harness 会命中它的子标签' },
					limit: { type: 'integer', description: '返回条数，默认 20，最多 100' },
					graph: { type: 'boolean', description: '返回命中文件的 links 子图（nodes+edges）' },
				},
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				const query = typeof input.query === 'string' ? input.query.trim() : ''
				const tags = (Array.isArray(input.tags) ? input.tags : [])
					.filter((value) => typeof value === 'string' && value.trim() !== '')
				const limit = pageSize(input.limit)
				const listing = query === '' && tags.length === 0
					? await store.list({ limit })
					: await store.list({ query, tags: tags.length === 0 ? undefined : tags, limit })
				const payload = {
					total: listing.total,
					files: listing.files.map((file) => summaryOf(file)),
				}
				if (query === '' && tags.length === 0) {
					payload.stats = store.stats()
					payload.tags = store.tagCounts(100)
				}
				if (input.graph === true) {
					const seeds = listing.files.map((file) => file.id)
					payload.graph = seeds.length === 0
						? { nodes: [], edges: [] }
						: store.graph(seeds, { hops: 1 })
				}
				return sanitize(payload)
			},
		},
		{
			name: 'file_read',
			description: '读：target 是库文件 id/唯一短 id → 元数据 + 正文（上限 256KB，超限标 truncated 并给 path）+ 邻居；target 是 "harness/" → 项目 harness 清单（分层、索引差集、是否已初始化）；否则按当前会话工作目录解析项目内路径（harness/... 按项目根），越界拒绝，二进制/超限只给大小与 path。',
			parameters: {
				type: 'object',
				properties: {
					target: { type: 'string', description: '库文件 id/唯一短 id、项目内路径（相对会话 cwd；harness/... 相对项目根），或 "harness/"（项目 harness 清单）' },
				},
				required: ['target'],
			},
			output: OBJECT_OUTPUT,
			async execute(args, exec) {
				const input = args ?? {}
				const target = textOf(input.target)
				if (target === '') throw new Error('file_read 需要 target：库文件 id/短 id、项目内路径，或 "harness/"。')
				if (isHarnessListing(target)) {
					const location = await requireLocation(paths, exec)
					const state = await catalog(location.root)
					return sanitize(summarizeCatalog(state))
				}
				const id = resolveInput(store, target)
				if (id !== '') {
					const file = await store.read(id, { text: true, neighbors: true })
					return file === undefined ? { found: false, id } : sanitize(file)
				}
				const location = await requireLocation(paths, exec)
				const resolved = resolveProjectPath(location, target)
				return sanitize(await readProjectFile(target, resolved.absolute))
			},
		},
		{
			name: 'file_write',
			description: '写：无 target → 新建库文件（content + meta.description + meta.tags）；target 是库文件 id/短 id → 更新正文或元数据；from 非空 → 把宿主文件导入库（相对路径按会话 cwd，越界拒绝）；target 是项目内路径 → 写项目文件；target 在项目 harness/ 下 → 写 harness 资源（缺骨架自动建、重建 AGENTS.md 索引并校验，校验不过回滚）。meta: {name,description,tags,links,title,summary,layer}；描述写清「是什么 + 以后哪些场景/任务会用到它」。',
			parameters: {
				type: 'object',
				properties: {
					target: { type: 'string', description: '库文件 id/短 id（更新）、项目内路径（写项目文件或 harness 资源）；新建库文件时留空' },
					content: { type: 'string', description: '文本正文；新建库文件与项目文件必填，更新库文件时给了就替换正文' },
					meta: { type: 'object', additionalProperties: true, description: '元数据对象：{name?,description?,tags?,links?,title?,summary?,layer?}；库文件新建/导入需要 description + tags；workflow/experience 需要 summary；layer 可覆盖但必须与路径层一致' },
					from: { type: 'string', description: '导入源：宿主绝对路径，或相对会话 cwd 的项目内路径（越界拒绝）；给了 from 就不看 target' },
				},
			},
			output: OBJECT_OUTPUT,
			async execute(args, exec) {
				const input = args ?? {}
				const meta = metaOf(input.meta)
				const from = textOf(input.from)
				const target = textOf(input.target)
				if (from !== '') return importFile(store, paths, exec, from, meta)
				if (target === '') return createLibraryFile(store, input, meta)
				const id = resolveInput(store, target)
				if (id !== '') return updateLibraryFile(store, id, input, meta)
				const location = await requireLocation(paths, exec)
				const resolved = resolveProjectPath(location, target)
				if (resolved.harness) return writeHarnessFile(location, target, resolved, input, meta)
				return writeProjectFile(target, resolved.absolute, input)
			},
		},
		{
			name: 'file_edit',
			description: '改：库文件给 old+new 精确替换正文一处（0 次或多次都报错），meta 改 description/tags/links/archived；meta.remove:true 是归档后的物理删除（文件夹移入回收站，优先用 meta.archived 归档）。项目文件只做 old+new 文本替换（meta.remove 拒绝）；harness 的 workflow/experience markdown 还能用 meta.title/summary 改 frontmatter，改完自动重建 AGENTS.md 索引并校验，失败回滚。',
			parameters: {
				type: 'object',
				properties: {
					target: { type: 'string', description: '库文件 id/短 id，或项目内路径（harness/... 按项目根）' },
					old: { type: 'string', description: '要替换的原文；必须恰好命中一处' },
					new: { type: 'string', description: '替换后的文本；old 给定时必填' },
					meta: { type: 'object', additionalProperties: true, description: '元数据：{description?,tags?,links?,archived?,remove?,title?,summary?}；remove:true 是归档后的物理删除，项目文件拒绝删除' },
				},
				required: ['target'],
			},
			output: OBJECT_OUTPUT,
			async execute(args, exec) {
				const input = args ?? {}
				const target = textOf(input.target)
				if (target === '') throw new Error('file_edit 需要 target：库文件 id/短 id 或项目内路径。')
				const meta = metaOf(input.meta)
				const hasPatch = typeof input.old === 'string' && typeof input.new === 'string'
				const hasMeta = ['description', 'tags', 'links', 'archived', 'remove', 'title', 'summary']
					.some((field) => meta[field] !== undefined)
				if (!hasPatch && !hasMeta) {
					throw new Error('file_edit 没有可执行的操作：给 old+new（正文精确替换）或 meta 的 description/tags/links/archived/remove（库文件）/ title/summary（harness 文档）之一。')
				}
				const id = resolveInput(store, target)
				if (id !== '') return sanitize(await editLibraryFile(store, id, input, meta, hasPatch))
				const location = await requireLocation(paths, exec)
				const resolved = resolveProjectPath(location, target)
				return sanitize(await editProjectFile(location, target, resolved, input, meta, hasPatch))
			},
		},
	]
}

/**
 * Import a host file into the library.
 *
 * @param {object} store - The file store.
 * @param {((exec: object) => Promise<{cwd?: string}>) | undefined} paths - The location resolver.
 * @param {object} exec - The tool run context.
 * @param {string} from - The source path.
 * @param {Record<string, unknown>} meta - The metadata.
 * @returns {Promise<object>} The summary.
 */
async function importFile(store, paths, exec, from, meta) {
	let sourcePath = from
	if (!isAbsolute(from)) {
		const location = await requireLocation(paths, exec)
		sourcePath = resolve(location.cwd, from)
		if (!isWithin(location.cwd, sourcePath)) {
			throw new Error(`导入路径越界：${from} 不在当前会话工作区内（${location.cwd}）。`)
		}
	}
	const { description, tags } = libraryFields(meta)
	const file = await store.create({
		sourcePath,
		name: typeof meta.name === 'string' && meta.name.trim() !== '' ? meta.name.trim() : undefined,
		description,
		tags,
		links: linksOf(meta),
	})
	return withDescriptionAdvice(summaryOf(file))
}

/**
 * Create one library file from inline content.
 *
 * @param {object} store - The file store.
 * @param {object} input - The call arguments.
 * @param {Record<string, unknown>} meta - The metadata.
 * @returns {Promise<object>} The summary.
 */
async function createLibraryFile(store, input, meta) {
	if (typeof input.content !== 'string') {
		throw new Error('新建库文件需要 content；导入现有文件给 from。')
	}
	const { description, tags } = libraryFields(meta)
	const file = await store.create({
		name: typeof meta.name === 'string' && meta.name.trim() !== '' ? meta.name.trim() : 'note.md',
		description,
		tags,
		links: linksOf(meta),
		content: input.content,
	})
	return withDescriptionAdvice(summaryOf(file))
}

/**
 * Update one library file.
 *
 * @param {object} store - The file store.
 * @param {string} id - The file id.
 * @param {object} input - The call arguments.
 * @param {Record<string, unknown>} meta - The metadata.
 * @returns {Promise<object>} The summary.
 */
async function updateLibraryFile(store, id, input, meta) {
	const fields = {}
	if (typeof input.content === 'string') fields.content = input.content
	if (typeof meta.name === 'string' && meta.name.trim() !== '') fields.name = meta.name.trim()
	if (meta.description !== undefined) fields.description = meta.description
	if (meta.tags !== undefined) {
		if (!Array.isArray(meta.tags)) throw new Error('meta.tags 必须是数组。')
		fields.tags = meta.tags
	}
	if (meta.links !== undefined) fields.links = linksOf(meta)
	if (meta.title !== undefined || meta.summary !== undefined) {
		throw new Error('title/summary 只用于项目 harness 资源；文件库用 description。')
	}
	if (Object.keys(fields).length === 0) {
		throw new Error('更新库文件需要 content，或 meta 的 name/description/tags/links 之一。')
	}
	const file = await store.update(id, fields)
	return withDescriptionAdvice(summaryOf(file))
}

/**
 * Write one plain file inside the project.
 *
 * @param {string} target - The original argument.
 * @param {string} absolute - The resolved destination.
 * @param {object} input - The call arguments.
 * @returns {Promise<object>} What happened.
 */
async function writeProjectFile(target, absolute, input) {
	if (typeof input.content !== 'string') throw new Error('写项目文件需要 content。')
	const previous = await lstat(absolute).catch(() => undefined)
	if (previous !== undefined && previous.isDirectory()) throw new Error(`目标是目录，不能写文件：${target}`)
	await mkdir(dirname(absolute), { recursive: true })
	await writeFile(absolute, input.content, 'utf8')
	return { target, path: absolute, bytes: Buffer.byteLength(input.content, 'utf8'), created: previous === undefined }
}

/**
 * Write one project harness resource.
 *
 * @param {{cwd: string, root: string}} location - The session location.
 * @param {string} target - The original argument.
 * @param {{absolute: string, harness: boolean, relative: string | undefined}} resolved - The resolved target.
 * @param {object} input - The call arguments.
 * @param {Record<string, unknown>} meta - The metadata.
 * @returns {Promise<object>} What happened.
 */
async function writeHarnessFile(location, target, resolved, input, meta) {
	const relativePath = resolved.relative
	const layer = layerOf(relativePath)
	if (relativePath === undefined || layer === undefined) {
		throw new Error(`harness/ 下只能写 harness/harness.md 或 ${LAYERS.map((item) => `harness/${item}/...`).join(' / ')}：${target}`)
	}
	if (layer !== 'overview' && relativePath.split('/').length === 2) {
		throw new Error(`harness/${layer}/ 是目录，target 需要具体文件名：${target}`)
	}
	if (meta.layer !== undefined) {
		const declared = String(meta.layer)
		if (!LAYERS.includes(declared)) throw new Error(`meta.layer 必须是 ${LAYERS.join(' / ')} 之一。`)
		if (declared !== layer) throw new Error(`meta.layer=${declared} 与路径层 ${layer} 不一致：文件落在哪一层就属于哪一层。`)
	}
	if (typeof input.content !== 'string') throw new Error('写 harness 资源需要 content（文本正文/脚本正文）。')
	const existed = (await lstat(resolved.absolute).catch(() => undefined)) !== undefined
	await initHarness(location.root)
	if (layer === 'overview') return writeHarnessRaw({
		root: location.root,
		absolute: resolved.absolute,
		relativePath,
		layer,
		target,
		content: input.content,
		created: !existed,
	})
	if (!DOCUMENT_LAYERS.includes(layer)) {
		if (meta.title !== undefined || meta.summary !== undefined) {
			throw new Error('tool/resources 与 harness.md 按原始文件写入，不写 frontmatter；title/summary 只用于 workflow/experience。')
		}
		return writeHarnessRaw({
			root: location.root,
			absolute: resolved.absolute,
			relativePath,
			layer,
			target,
			content: input.content,
			created: !existed,
		})
	}
	const summary = typeof meta.summary === 'string' ? meta.summary.trim() : ''
	if (summary === '') {
		throw new Error(`写 ${layer} 资源需要 meta.summary：一句话说清它是什么 + 以后哪些场景/任务会用到它（会进 AGENTS.md 索引）。`)
	}
	// `writeResource` edits an existing file by path, but a new document needs
	// a layer + slug; a document layer has no subdirectories of its own.
	if (!existed && relativePath.split('/').length > 3) {
		throw new Error(`${layer} 资源只能直接放在 harness/${layer}/ 下，不支持多级目录：${target}`)
	}
	const stem = basename(relativePath).replace(/\.md$/i, '')
	if (!existed && slugOf(stem) !== stem) {
		throw new Error(`文件名不合法：${basename(relativePath)}（workflow/experience 只能用小写英文、数字、. _ -，并以 .md 结尾）。`)
	}
	const result = existed
		? await writeResource({ root: location.root, path: relativePath, title: meta.title, summary, body: input.content })
		: await writeResource({
			root: location.root,
			layer,
			slug: stem,
			title: meta.title,
			summary,
			body: input.content,
		})
	return harnessResult({
		target,
		path: result.path,
		layer,
		created: result.created,
		indexed: result.indexed,
		errors: result.errors,
		warnings: result.warnings,
		skipped: result.skipped,
	})
}

/**
 * Edit one library file.
 *
 * @param {object} store - The file store.
 * @param {string} id - The file id.
 * @param {object} input - The call arguments.
 * @param {Record<string, unknown>} meta - The metadata.
 * @param {boolean} hasPatch - Whether old+new were both given.
 * @returns {Promise<object>} The summary.
 */
async function editLibraryFile(store, id, input, meta, hasPatch) {
	if (meta.title !== undefined || meta.summary !== undefined) {
		throw new Error('title/summary 只用于项目 harness 的 workflow/experience 文档；文件库用 description。')
	}
	const current = await store.read(id, { text: false, neighbors: false })
	if (current === undefined) throw new Error(`文件不存在：${id}`)
	const patch = {}
	if (hasPatch) {
		if (!isTextMime(current.mime)) throw new Error('正文不是文本，不能用 old/new 替换。')
		const text = await readFile(current.path, 'utf8').catch(() => undefined)
		if (text === undefined) throw new Error(`文件本体缺失，无法替换正文：${id}`)
		patch.content = replaceOnce(text, input.old, input.new)
	}
	if (meta.description !== undefined) patch.description = meta.description
	if (meta.tags !== undefined) {
		if (!Array.isArray(meta.tags)) throw new Error('meta.tags 必须是数组。')
		patch.tags = meta.tags
	}
	if (meta.links !== undefined) {
		if (!Array.isArray(meta.links)) throw new Error('meta.links 必须是数组。')
		patch.links = meta.links
	}
	if (meta.archived !== undefined) patch.archived = meta.archived === true
	const edited = Object.keys(patch).length === 0 ? undefined : await store.update(id, patch)
	if (meta.remove === true) {
		const removed = await store.remove(id)
		return { ...(edited === undefined ? {} : summaryOf(edited)), id, removed: true, trashed: removed.trashed }
	}
	if (edited === undefined) throw new Error('没有可执行的修改。')
	return withDescriptionAdvice(summaryOf(edited))
}

/**
 * Edit one project file, with the harness contract when it lives in `harness/`.
 *
 * @param {{cwd: string, root: string}} location - The session location.
 * @param {string} target - The original argument.
 * @param {{absolute: string, harness: boolean, relative: string | undefined}} resolved - The resolved target.
 * @param {object} input - The call arguments.
 * @param {Record<string, unknown>} meta - The metadata.
 * @param {boolean} hasPatch - Whether old+new were both given.
 * @returns {Promise<object>} What happened.
 */
async function editProjectFile(location, target, resolved, input, meta, hasPatch) {
	const info = await stat(resolved.absolute).catch(() => undefined)
	if (info === undefined || !info.isFile()) throw new Error(`项目内没有这个文件：${target}（解析为 ${resolved.absolute}）。`)
	if (meta.remove === true) throw new Error('file_edit 不能删除项目文件；项目文件只做正文替换（meta.remove 只用于库文件）。')
	const forLibrary = ['description', 'tags', 'links', 'archived'].filter((field) => meta[field] !== undefined)
	if (forLibrary.length > 0) {
		throw new Error(`项目文件不支持 ${forLibrary.map((field) => `meta.${field}`).join('/')}；那是库文件的字段。`)
	}
	if (!resolved.harness) {
		if (!hasPatch) throw new Error('项目文件只支持 old+new 正文替换。')
		const current = await readFile(resolved.absolute, 'utf8')
		const next = replaceOnce(current, input.old, input.new)
		await writeFile(resolved.absolute, next, 'utf8')
		return { target, path: resolved.absolute, bytes: Buffer.byteLength(next, 'utf8'), changed: true }
	}
	const relativePath = resolved.relative
	const layer = layerOf(relativePath)
	if (relativePath === undefined || layer === undefined) {
		throw new Error(`harness/ 下只能改 harness/harness.md 或四层内的资源：${target}`)
	}
	const current = await readFile(resolved.absolute, 'utf8')
	const nextText = hasPatch ? replaceOnce(current, input.old, input.new) : current
	if (!DOCUMENT_LAYERS.includes(layer)) {
		if (meta.title !== undefined || meta.summary !== undefined) {
			throw new Error('title/summary 只能改 workflow/experience 的 frontmatter；tool/resources 与 harness.md 是原始文件。')
		}
		return writeHarnessRaw({
			root: location.root,
			absolute: resolved.absolute,
			relativePath,
			layer,
			target,
			content: nextText,
			created: false,
		})
	}
	const parsed = splitFrontmatter(nextText)
	const title = meta.title === undefined ? parsed.meta.title : String(meta.title)
	const summary = meta.summary === undefined ? parsed.meta.summary : String(meta.summary)
	const result = await writeResource({ root: location.root, path: relativePath, title, summary, body: parsed.body })
	return harnessResult({
		target,
		path: result.path,
		layer,
		created: false,
		indexed: result.indexed,
		errors: result.errors,
		warnings: result.warnings,
		skipped: result.skipped,
	})
}

/**
 * What each tool does to the library, for the panel's tool catalog.
 *
 * The panel groups by this instead of parsing descriptions. An unknown tool
 * defaults to `write`: a tool nobody classified more likely changes something
 * than only reads it, and showing a read-only tool as `write` is a harmless
 * conservative error while showing a mutating tool as `read` invites careless
 * use. `file_edit` is a write: its `meta.remove` is the archive-then-delete
 * action, so the only `destructive` classification is gone.
 */
const TOOL_CATEGORIES = {
	file_search: 'read',
	file_read: 'read',
	file_write: 'write',
	file_edit: 'write',
}

/**
 * Describe the tools as a JSON-serializable catalog.
 *
 * The live definitions carry `output.render`, a function that cannot cross the
 * panel API; only `name`, `description`, `parameters` and `category` go out.
 * `tokens` estimates the model-visible schema share (name + description +
 * parameters, the fields a request serializes), so the panel can show what the
 * tool face costs per request.
 * `parameters` is cloned so a panel that edits its copy cannot mutate the
 * registered tools.
 *
 * @param {object[]} [tools] - The registered tools.
 * @returns {{name: string, description: string, parameters: object, category: string, tokens: number}[]} The catalog, in tool order.
 */
export function describeTools(tools = []) {
	return tools.map((tool) => {
		const parameters = sanitize(tool.parameters ?? { type: 'object', properties: {} })
		return {
			name: tool.name,
			description: tool.description,
			parameters,
			category: TOOL_CATEGORIES[tool.name] ?? 'write',
			tokens: estimateTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters })),
		}
	})
}
