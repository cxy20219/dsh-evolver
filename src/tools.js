/**
 * The tools the agent gets from 自衍中枢.
 *
 * Four verbs, one tool each: search, read, write, edit. They serve the file
 * library and ordinary project files; a project-owned folder such as
 * `harness/` gets no special treatment — no sidecar, no generated index, no
 * validation — because the library's job is to store files and make them
 * findable, not to own a project's own notes.
 *
 * The descriptions are the place for the library contract (description, tags,
 * links), because they ride on every request anyway; the system section only
 * says what no tool says.
 *
 * Results are JSON. A write returns a compact summary without the payload;
 * `file_read` is the only tool that returns text, and it caps it.
 */

import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { isWithin } from './project.js'
import { isFileId } from './ids.js'
import { OBJECT_OUTPUT, sanitize, summaryOf } from './json.js'
import { descriptionAdvice } from './meta.js'
import { isTextMime, isTextual } from './names.js'
import { estimateTokens } from './tokens.js'

/** The most a project file read returns inline. */
const PROJECT_READ_BYTES = 256 * 1024

/** The markdown layers: their resources are documents with a `.md` name. */

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
 * A relative path is taken from the session cwd, and may climb up to the
 * project root — a session opened in `src/` and writing `../harness/x.md`
 * means the project folder, not a refusal. Anything outside the project root
 * is refused before any I/O: the verbs reach whatever the project holds, and
 * the project is the boundary.
 *
 * There is no folder with a special contract any more. A `harness/` tree is
 * an ordinary folder that some projects keep; a write into it is a write into
 * a project file like any other.
 *
 * @param {{cwd: string, root: string}} location - The session location.
 * @param {unknown} target - The caller's path.
 * @returns {{absolute: string}} The resolved target.
 */
function resolveProjectPath(location, target) {
	const raw = textOf(target)
	if (raw === '') throw new Error('需要 target：项目内路径。')
	const normalized = raw.split('\\').join('/')
	const root = location.root ?? location.cwd
	const absolute = resolve(location.cwd, normalized)
	if (!isWithin(root, absolute)) {
		throw new Error(`路径越界：${raw} 不在项目根内（${root}）。`)
	}
	return { absolute }
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
			description: '读：target 是库文件 id/唯一短 id → 元数据 + 正文（上限 256KB，超限标 truncated 并给 path）+ 邻居；否则按当前会话 cwd 解析项目内路径（可上溯到项目根，越出项目根拒绝），二进制/超限只给大小与 path。看目录用 glob，不要用本工具。',
			parameters: {
				type: 'object',
				properties: {
					target: { type: 'string', description: '库文件 id/唯一短 id，或项目内路径（相对会话 cwd，可上溯到项目根）' },
				},
				required: ['target'],
			},
			output: OBJECT_OUTPUT,
			async execute(args, exec) {
				const input = args ?? {}
				const target = textOf(input.target)
				if (target === '') throw new Error('file_read 需要 target：库文件 id/短 id 或项目内路径。')
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
			description: '写：无 target → 新建库文件（content + meta.description + meta.tags）；target 是库文件 id/短 id → 更新正文或元数据；from 非空 → 把宿主文件导入库（相对路径按会话 cwd，越界拒绝）；target 是项目内路径 → 写项目文件（普通文件，不加元数据、不建索引）；要改正文用 file_edit 的 old+new，不必重写整篇。meta: {name,description,tags,links}；描述写「以后什么时候会用到它」。',
			parameters: {
				type: 'object',
				properties: {
					target: { type: 'string', description: '库文件 id/短 id（更新）、项目内路径（写项目文件）；新建库文件时留空' },
					content: { type: 'string', description: '文本正文；新建库文件与项目文件必填，更新库文件时给了就替换正文' },
					meta: {
						type: 'object',
						additionalProperties: true,
						// The declared fields are the ones a model gets wrong when
						// it has to guess. `tags` in particular: left undeclared,
						// some routes emit their own list encoding
						// (`{"item": ["来源/harness"]}`) and every write fails the
						// array check. Declaring the type is what makes that shape
						// never appear; unwrapping it at runtime would be a
						// compatibility layer for a mistake nobody has to make.
						// Descriptions stay at one clause: the outer description
						// already carries the contract, and this rides every request.
						properties: {
							name: { type: 'string' },
							description: { type: 'string', description: '写「以后什么时候会用到它」；正文已能搜到「是什么」' },
							tags: { type: 'array', items: { type: 'string' }, description: '字符串数组，如 ["来源/harness","践行/约定"]；不是 {"item": [...]}；库文件必填' },
							links: { type: 'array', items: { type: 'string' }, description: '关联文件 id 的字符串数组' },
						},
						description: '元数据对象：{name?,description?,tags?,links?}；新建或导入需要 description + tags。描述是检索的第一排序面，写「以后什么场景、任务或问题会用到它」；正文参与兜底检索但权重低于描述',
					},
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
				return writeProjectFile(location, target, resolved.absolute, input)
			},
		},
		{
			name: 'file_edit',
			description: '改：old+new 精确替换正文一处（0 次或多次都报错），库文件与项目文件都适用——改一段不必重写整篇。meta 改元数据：库文件用 description/tags/links/archived；项目文件只做正文替换。meta.remove:true 是归档后的物理删除（文件夹移入回收站，优先用 meta.archived 归档）。',
			parameters: {
				type: 'object',
				properties: {
					target: { type: 'string', description: '库文件 id/短 id，或项目内路径（相对会话 cwd，可上溯到项目根）' },
					old: { type: 'string', description: '要替换的原文；必须恰好命中一处' },
					new: { type: 'string', description: '替换后的文本；old 给定时必填' },
					meta: { type: 'object', additionalProperties: true, description: '元数据：{description?,tags?,links?,archived?,remove?}；remove:true 是库文件归档后的物理删除，项目文件拒绝删除' },
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
				// title/summary 不再存在，但仍列入白名单：让它们走到下面那句明确的
				// 「文件库没有 title/summary」，而不是笼统的「没有可执行的操作」。
				const hasMeta = ['description', 'tags', 'links', 'archived', 'remove', 'title', 'summary']
					.some((field) => meta[field] !== undefined)
				if (!hasPatch && !hasMeta) {
					throw new Error(`file_edit 没有可执行的操作：${patchAdvice(input)}给 old+new（正文精确替换）或 meta 的 description/tags/links/archived/remove 之一。`)
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
 * Why a `file_edit` call arrived with nothing to do.
 *
 * The neighbouring built-in tool is `edit`, whose fields are `old_string` and
 * `new_string`; this one's are `old` and `new`. A model that mixes them up
 * gets the generic "nothing to do" error and retries the same call forever: it
 * has no way to tell which of the four fields was the problem. Naming the
 * field it actually sent turns a dead end into a one-line correction.
 *
 * @param {Record<string, unknown>} input - The call arguments.
 * @returns {string} A sentence naming the mistake, or an empty string.
 */
function patchAdvice(input) {
	const sent = [
		typeof input.old_string === 'string' ? 'old_string' : '',
		typeof input.new_string === 'string' ? 'new_string' : '',
	].filter((name) => name !== '')
	if (sent.length > 0) {
		return `这次收到的是 ${sent.join(' 和 ')}——那是内置 edit 的字段名；file_edit 用 old 和 new。`
	}
	const hasOld = typeof input.old === 'string'
	const hasNew = typeof input.new === 'string'
	if (hasOld && !hasNew) return '这次给了 old 但缺少 new：正文替换需要 old 与 new 两个字段。'
	if (hasNew && !hasOld) return '这次给了 new 但缺少 old：正文替换需要 old 与 new 两个字段。'
	return ''
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
		throw new Error('文件库用 meta.description，没有 title/summary。')
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
async function writeProjectFile(location, target, absolute, input) {
	if (typeof input.content !== 'string') throw new Error('写项目文件需要 content。')
	const previous = await lstat(absolute).catch(() => undefined)
	if (previous !== undefined && previous.isDirectory()) throw new Error(`目标是目录，不能写文件：${target}`)
	await mkdir(dirname(absolute), { recursive: true })
	await writeFile(absolute, input.content, 'utf8')
	return { target, path: absolute, bytes: Buffer.byteLength(input.content, 'utf8'), created: previous === undefined }
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
		throw new Error('文件库用 meta.description，没有 title/summary。')
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
 * Edit one project file: exact text replacement, nothing else.
 *
 * A project file has no metadata of its own — description, tags and links
 * belong to library files — so an edit that only changes metadata is refused
 * instead of silently doing nothing. `meta.remove` is refused too: the library
 * archives then trashes, while a project file would simply vanish.
 *
 * @param {{cwd: string, root: string}} location - The session location.
 * @param {string} target - The original argument.
 * @param {{absolute: string}} resolved - The resolved target.
 * @param {object} input - The call arguments.
 * @param {Record<string, unknown>} meta - The metadata.
 * @param {boolean} hasPatch - Whether old+new were both given.
 * @returns {Promise<object>} What happened.
 */
async function editProjectFile(location, target, resolved, input, meta, hasPatch) {
	const info = await stat(resolved.absolute).catch(() => undefined)
	if (info === undefined || !info.isFile()) throw new Error(`项目内没有这个文件：${target}（解析为 ${resolved.absolute}）。`)
	void location
	if (meta.remove === true) throw new Error('file_edit 不能删除项目文件；项目文件只做正文替换（meta.remove 只用于库文件）。')
	const forLibrary = ['tags', 'links', 'archived'].filter((field) => meta[field] !== undefined)
	if (forLibrary.length > 0) {
		throw new Error(`项目文件不支持 ${forLibrary.map((field) => `meta.${field}`).join('/')}；那是库文件的字段。`)
	}
	if (meta.description !== undefined || meta.title !== undefined || meta.summary !== undefined) {
		throw new Error('meta.description/meta.title/meta.summary 只用于库文件；普通项目文件只做 old+new 正文替换。')
	}
	if (!hasPatch) throw new Error('项目文件只支持 old+new 正文替换。')
	const current = await readFile(resolved.absolute, 'utf8')
	const next = replaceOnce(current, input.old, input.new)
	await writeFile(resolved.absolute, next, 'utf8')
	return { target, path: resolved.absolute, bytes: Buffer.byteLength(next, 'utf8'), changed: true }
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
