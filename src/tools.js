/**
 * The tools the agent gets from 自衍中枢.
 *
 * One entity type, one id space, description-first retrieval. The tool
 * descriptions are the place for the write contract (tags, links, content),
 * because they ride on every request anyway; the system section only says what
 * no tool says.
 *
 * Results are JSON. A write returns a compact summary without the payload;
 * only `file_read` returns text, and it caps it.
 */

import { isFileId } from './ids.js'

/**
 * Render one tool result as text.
 *
 * @param {unknown} _args - The call arguments (unused).
 * @param {unknown} value - The result.
 * @returns {object[]} The content blocks.
 */
function render(_args, value) {
	return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** The shared output declaration: a JSON object the model can read. */
const OBJECT_OUTPUT = { schema: { type: 'object', additionalProperties: true }, render }

/**
 * Drop members that are `undefined`, so the result stays JSON.
 *
 * @param {unknown} value - The value.
 * @returns {unknown} The sanitized value.
 */
function sanitize(value) {
	return JSON.parse(JSON.stringify(value ?? {}))
}

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
 * A compact view of one file: everything except the payload text.
 *
 * @param {object} file - A file as `read()` returns it.
 * @returns {object} The summary.
 */
function summaryOf(file) {
	if (file === null || typeof file !== 'object') return file
	const { text, ...rest } = file
	void text
	return sanitize(rest)
}

/**
 * Create the tool set.
 *
 * @param {{store: object}} deps - The file store.
 * @returns {object[]} The tools.
 */
export function createTools({ store }) {
	return [
		{
			name: 'file_query',
			description: '按描述/名字/标签检索文件，不搜正文。返回 id、短 id、名字、描述、标签、类型、字节、度数、分数。tags 数组是 AND（每个都要命中该路径或其子路径）；tag 是单路径。graph:true 时沿 links 双向走 hops 跳，返回 nodes+edges，用于「文档 → 说明 → 脚本」这类多跳导航。先查再读。',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: '检索词；留空则按更新时间列最近文件' },
					tags: { type: 'array', items: { type: 'string' }, description: '标签数组，AND；支持层级前缀：工作 会命中 工作/项目' },
					tag: { type: 'string', description: '单个标签路径，等价于 tags 里只有它' },
					mime: { type: 'string', description: '类型过滤，例如 text/markdown、image/、application/pdf' },
					archived: { type: 'boolean', description: '是否包含归档文件，默认 false' },
					limit: { type: 'integer', description: '返回条数，默认 20，最多 100' },
					graph: { type: 'boolean', description: '返回命中文件的子图，默认 false' },
					hops: { type: 'integer', description: '图模式跳数 1-3，默认 1' },
				},
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				const result = await store.list({
					query: typeof input.query === 'string' ? input.query : '',
					tags: Array.isArray(input.tags) ? input.tags : undefined,
					tag: typeof input.tag === 'string' ? input.tag : '',
					mime: typeof input.mime === 'string' ? input.mime : '',
					archived: input.archived === true,
					limit: Math.min(100, Math.max(1, Math.round(Number(input.limit) || 20))),
				})
				const payload = { total: result.total, files: result.files.map((file) => summaryOf(file)) }
				if (input.graph === true) {
					const seeds = result.files.map((file) => file.id)
					payload.graph = seeds.length === 0
						? { nodes: [], edges: [] }
						: store.graph(seeds, { hops: input.hops })
				}
				return sanitize(payload)
			},
		},
		{
			name: 'file_read',
			description: '读一个文件的元数据、描述、标签、links、反链邻居、绝对 path 和 executable；文本文件返回最多 256KB 正文（超出只给 path），二进制只给 path。executable:true 的脚本由 agent 自己用 bash 跑，插件不执行。',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '文件 id 或唯一短 id' },
					text: { type: 'boolean', description: '是否返回文本正文，默认 true' },
					neighbors: { type: 'boolean', description: '是否返回入/出邻居，默认 true' },
				},
				required: ['id'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				const id = resolveInput(store, input.id)
				if (id === '') return { found: false, id: String(input.id ?? '') }
				const file = await store.read(id, {
					text: input.text !== false,
					neighbors: input.neighbors !== false,
				})
				return file === undefined
					? { found: false, id }
					: sanitize(file)
			},
		},
		{
			name: 'file_write',
			description: '新建或更新一个文本文件。新建需要 name、description、至少一个 tags、content；更新传 id + 要改的字段。tags 是自由层级路径（工作/项目/自衍中枢），至少一个；links 写关联文件 id，自链/死链不阻断但会进 warnings。写前先 file_query 查重；长文/二进制/Word 用 file_import。',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '更新已有文件时传 id；新建留空' },
					name: { type: 'string', description: '文件名（含扩展名）；新建时必填，更新时不传则保持原名' },
					description: { type: 'string', description: '必填：一句话说清这个文件是什么、回答什么问题' },
					tags: { type: 'array', items: { type: 'string' }, description: '至少一个自由层级标签' },
					links: { type: 'array', items: { type: 'string' }, description: '关联文件 id；双向关系写一次或两边都写' },
					content: { type: 'string', description: '文本正文；新建必填，更新时不传则只改元数据' },
				},
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				const rawId = typeof input.id === 'string' ? input.id.trim() : ''
				const id = rawId === '' ? '' : resolveInput(store, rawId)
				if (rawId !== '' && id === '') throw new Error(`文件不存在：${rawId}`)
				const fields = {}
				for (const key of ['name', 'description', 'content']) {
					if (input[key] !== undefined) fields[key] = input[key]
				}
				if (input.tags !== undefined) fields.tags = input.tags
				if (input.links !== undefined) fields.links = input.links
				if (id !== '') {
					return summaryOf(await store.update(id, fields))
				}
				if (typeof input.content !== 'string') {
					throw new Error('新建文本文件需要 content；导入现有文件用 file_import。')
				}
				return summaryOf(await store.create({
					name: input.name,
					description: input.description,
					tags: input.tags,
					links: input.links,
					content: input.content,
				}))
			},
		},
		{
			name: 'file_import',
			description: '把宿主机上的任意文件（Word/PDF/图片/脚本/数据）复制进库，成为独立实体；必须给 description 和至少一个 tags，可给 links。脚本会按扩展名/shebang 标成可执行。源文件保持不动。',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '宿主机上的绝对路径或可解析路径' },
					name: { type: 'string', description: '库内文件名；默认取源文件名' },
					description: { type: 'string', description: '必填：一句话说清这个文件是什么' },
					tags: { type: 'array', items: { type: 'string' }, description: '至少一个自由层级标签' },
					links: { type: 'array', items: { type: 'string' }, description: '关联文件 id' },
				},
				required: ['path', 'description', 'tags'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				if (typeof input.path !== 'string' || input.path.trim() === '') {
					throw new Error('file_import 需要 path。')
				}
				return summaryOf(await store.create({
					sourcePath: input.path,
					name: input.name,
					description: input.description,
					tags: input.tags,
					links: input.links,
				}))
			},
		},
		{
			name: 'file_link',
			description: '给两个文件加/删一条引用关系（action: add/remove）。链接只存出边，反链由 file_read 实时计算；目标可以是任何类型的文件。',
			parameters: {
				type: 'object',
				properties: {
					from: { type: 'string', description: '来源文件 id 或唯一短 id' },
					to: { type: 'string', description: '目标文件 id 或唯一短 id' },
					action: { type: 'string', enum: ['add', 'remove'], description: '默认 add' },
				},
				required: ['from', 'to'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				const from = resolveInput(store, input.from)
				const to = resolveInput(store, input.to)
				if (from === '') throw new Error(`来源文件不存在：${String(input.from ?? '')}`)
				if (to === '') throw new Error(`目标文件不存在：${String(input.to ?? '')}`)
				const file = input.action === 'remove'
					? await store.unlink(from, to)
					: await store.link(from, to)
				return summaryOf(file)
			},
		},
		{
			name: 'file_index',
			description: '库的规模、类型分布、标签计数，用于决定往哪找；不含文件正文。',
			parameters: { type: 'object', properties: {} },
			output: OBJECT_OUTPUT,
			async execute() {
				return sanitize({ stats: store.stats(), tags: store.tagCounts(100) })
			},
		},
		{
			name: 'file_archive',
			description: '归档/取消归档一个文件；归档后默认不出现在检索和列表，但链接仍在。',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '文件 id 或唯一短 id' },
					archived: { type: 'boolean', description: 'true 归档，false 取消归档；默认 true' },
				},
				required: ['id'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				const id = resolveInput(store, input.id)
				if (id === '') throw new Error(`文件不存在：${String(input.id ?? '')}`)
				return summaryOf(await store.archive(id, input.archived !== false))
			},
		},
		{
			name: 'file_remove',
			description: '永久删除一个文件（先移进 trash，再删索引）；不可恢复，优先用 file_archive。',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '文件 id 或唯一短 id' },
				},
				required: ['id'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				const id = resolveInput(store, input.id)
				if (id === '') throw new Error(`文件不存在：${String(input.id ?? '')}`)
				return sanitize(await store.remove(id))
			},
		},
	]
}
