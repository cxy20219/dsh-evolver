/**
 * The tools that maintain a project's `harness/` resources.
 *
 * They exist because the rules they enforce cannot be enforced by a prompt:
 * scan before writing, rebuild the index from the folder, refuse to report a
 * write that left the folder inconsistent. A model can skip an instruction; it
 * cannot skip a tool that returns an error.
 *
 * The `project_harness_` prefix is not decoration: the old evolver is installed
 * beside 自衍中枢 and already owns `harness_catalog` / `harness_write` /
 * `harness_validate`, and tool names are global to the host.
 *
 * `project_harness_promote` is the addition this branch makes. The rule it
 * carries is a split: what is only true about this repository stays in
 * `harness/`; what turned out to hold across projects is imported into the
 * file library, where retrieval is description-first and not repository-bound.
 */

import { catalog, ensureIndex, initHarness, migrateLayout, renderIndex } from './store.js'
import { validate } from './validate.js'
import { resolveResourcePath, writeResource } from './write.js'

/**
 * Render one tool result as text.
 *
 * @param {unknown} _args - The call arguments.
 * @param {unknown} value - The canonical value.
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
 * A compact view of one library file: everything except the payload text.
 *
 * @param {object} file - A file as the store returns it.
 * @returns {object} The summary.
 */
function summaryOf(file) {
	if (file === null || typeof file !== 'object') return file
	const { text, ...rest } = file
	void text
	return sanitize(rest)
}

/**
 * A compact copy of a catalog, small enough to read in one look.
 *
 * @param {object} state - The catalog `catalog()` returns.
 * @returns {object} The summary.
 */
function summarize(state) {
	return {
		project: state.root,
		harness: state.present,
		agents: state.agents,
		overview: state.overview,
		layers: Object.fromEntries(Object.entries(state.layers).map(([layer, files]) => [layer, files.length])),
		resources: state.resources.map((item) => ({
			path: item.path,
			title: item.title,
			...(item.summary === '' ? { summary: '(missing)' } : {}),
		})),
		unexpected: state.unexpected,
		missing: state.missing,
		// A static prompt line can be missed in a long session. The catalog is
		// called exactly when the model is deciding where knowledge goes, so the
		// empty state carries the next action instead of only harness:false.
		...(state.present ? {} : {
			needsInit: true,
			next: '项目没有 harness/。本轮若有只在本仓库成立的判断/约定/命令/流程，先再次调用 project_harness_catalog({init:true}) 建骨架，再 project_harness_write 写进去；跨项目可复用的才 project_harness_promote 落进自衍中枢库。',
		}),
		index: {
			entries: state.index.refs.length,
			mode: state.index.mode,
			// The block is managed by the tool, so a project with hand-written
			// AGENTS.md is not an error: the first write appends it.
			...((state.index.mode === 'absent' || state.index.mode === 'legacy') ? {
				next: state.index.mode === 'legacy'
					? 'AGENTS.md 是旧式裸索引（没有受管块）；下一次写入会自动包进受管块。'
					: 'AGENTS.md 还没有受管索引块；init:true 建骨架或写入资源时会自动追加，块外内容不动。',
			} : {}),
			notIndexed: state.index.missing,
			pointingNowhere: state.index.stale,
		},
	}
}

/**
 * The harness tool set.
 *
 * @param {{resolveProject: (exec: object) => Promise<string | undefined>, store?: object}} deps - How to find the project, and the library promote writes into.
 * @returns {object[]} The tool definitions.
 */
export function createHarnessTools({ resolveProject, store }) {
	// Which session has looked at which project in this process. The write tool
	// refuses without it: "scan before you write" used to be a sentence in a
	// skill, which is exactly the kind of rule that gets skipped.
	const scanned = new Map()

	/**
	 * Resolve the project a call belongs to.
	 *
	 * @param {object} exec - The tool run context.
	 * @param {unknown} explicit - An explicit `project` argument.
	 * @returns {Promise<string>} The absolute project root.
	 */
	async function rootFor(exec, explicit) {
		if (typeof explicit === 'string' && explicit.trim() !== '') {
			const resolved = await resolveProject({ project: explicit.trim() })
			if (resolved === undefined) throw new Error(`找不到这个项目：${explicit}`)
			return resolved
		}
		const resolved = await resolveProject(exec ?? {})
		if (resolved === undefined) {
			throw new Error('无法推断项目目录；请显式传 project（项目根绝对路径）。')
		}
		return resolved
	}

	return [
		{
			name: 'project_harness_catalog',
			description:
				'扫描项目 harness/ 资源系统的现状：分层文件、标题与一句话用途、AGENTS.md 索引差集、缺失与多余项。AGENTS.md 里由工具维护一个受管块（<!-- ziyan:harness:begin/end -->），块外内容不要动。写 project_harness_write 前必须先调用它；项目没有 harness 时传 init:true 建骨架。',
			parameters: {
				type: 'object',
				properties: {
					project: { type: 'string', description: '项目根绝对路径；留空则用当前会话的工作目录推断' },
					init: { type: 'boolean', description: '缺骨架时建立；旧布局迁到 tool/resources；重算 AGENTS.md。默认 false' },
				},
			},
			output: OBJECT_OUTPUT,
			async execute(args, exec) {
				const input = args ?? {}
				const root = await rootFor(exec, input.project)
				if (input.init === true) {
					await initHarness(root)
					await migrateLayout(root)
					// Migration for a folder indexed by an older tool: the first
					// init replaces the hand-written index with the managed one.
					await ensureIndex(root)
				}
				const state = await catalog(root)
				scanned.set(String(exec?.agent?.id ?? 'anonymous'), root)
				return sanitize(summarize(state))
			},
		},
		{
			name: 'project_harness_write',
			description:
				'写入或更新一条项目 harness 资源，并自动重建 AGENTS.md 索引、自动校验；校验不过会回滚并报错。AGENTS.md 里由工具维护一个受管块，块外内容不要动（工具也不会动）。必须先在本会话调用过 project_harness_catalog；项目没有 harness 时先传 init:true 建骨架。summary 是索引里的一句话用途，必填。只写只在本仓库成立的判断/约定/命令/流程；跨项目可复用的资源用 project_harness_promote 落进自衍中枢库。',
			parameters: {
				type: 'object',
				properties: {
					layer: { type: 'string', enum: ['workflow', 'experience', 'tool', 'resources'], description: '资源层级：workflow 流程 / experience 经验 / tool 可执行的东西 / resources 工具要读的东西' },
					slug: { type: 'string', description: '文件名，小写英文与连字符；workflow/experience 自动补 .md，tool/resources 按你给的名字原样用' },
					title: { type: 'string', description: '文档标题' },
					summary: { type: 'string', description: '一句话用途，写进 AGENTS.md 索引，必填' },
					body: { type: 'string', description: '完整正文（markdown；脚本层放脚本正文）' },
					path: { type: 'string', description: '更新已有资源时给相对路径，例如 harness/experience/003-xxx.md' },
					project: { type: 'string', description: '项目根绝对路径；留空则用当前会话的工作目录推断' },
				},
				required: ['body', 'summary'],
			},
			output: OBJECT_OUTPUT,
			async execute(args, exec) {
				const input = args ?? {}
				const root = await rootFor(exec, input.project)
				const session = String(exec?.agent?.id ?? 'anonymous')
				if (scanned.get(session) !== root) {
					throw new Error('先调用 project_harness_catalog 看现有资源；项目没有 harness 时传 init:true 建骨架，确认没有合适落点再写。')
				}
				const result = await writeResource({
					root,
					layer: input.layer,
					slug: input.slug,
					title: input.title,
					summary: input.summary,
					body: input.body,
					path: input.path,
				})
				return sanitize({ ...result, index: renderIndex(await catalog(root)).split('\n').length })
			},
		},
		{
			name: 'project_harness_validate',
			description:
				'校验项目 harness/ 的结构、AGENTS.md 索引完整性、脚本文档契约（命令块与验证标记）以及 Python 语法；找不到 Python 解释器时跳过语法校验并在结果里标明 skipped。写完可直接调用。',
			parameters: {
				type: 'object',
				properties: {
					project: { type: 'string', description: '项目根绝对路径；留空则用当前会话的工作目录推断' },
				},
			},
			output: OBJECT_OUTPUT,
			async execute(args, exec) {
				const root = await rootFor(exec, args?.project)
				return sanitize(await validate(root))
			},
		},
		{
			name: 'project_harness_promote',
			description:
				'把一条项目 harness 资源按路径导入自衍中枢文件库：读文件字节 → store.create({sourcePath, description, tags, links})，返回新文件摘要与 warnings。只有跨项目可复用的资源才 promote；项目本地约定留在 harness。description 与 tags 必填，tags 建议带 来源/harness，links 写库内相关文件 id（可先用 file_query 找）。',
			parameters: {
				type: 'object',
				properties: {
					project: { type: 'string', description: '项目根绝对路径；留空则用当前会话的工作目录推断' },
					path: { type: 'string', description: '项目内 harness 资源的相对路径（也可给绝对路径，但必须在本项目内）' },
					description: { type: 'string', description: '必填：一句话说清这个资源是什么、回答什么问题、为什么跨项目可复用' },
					tags: { type: 'array', items: { type: 'string' }, description: '至少一个自由层级标签；建议带 来源/harness' },
					links: { type: 'array', items: { type: 'string' }, description: '库内相关文件 id（可写唯一短 id）' },
					name: { type: 'string', description: '库内文件名；默认用源文件名' },
				},
				required: ['path', 'description', 'tags'],
			},
			output: OBJECT_OUTPUT,
			async execute(args, exec) {
				const input = args ?? {}
				const root = await rootFor(exec, input.project)
				const source = await resolveResourcePath(root, input.path)
				const description = typeof input.description === 'string' ? input.description.trim() : ''
				if (description === '') {
					throw new Error('project_harness_promote 需要 description：一句话说清这个资源是什么、跨项目为什么可复用。只有跨项目可复用的资源才 promote；项目本地约定留在 harness。')
				}
				const tags = Array.isArray(input.tags) ? input.tags : []
				if (tags.length === 0) {
					throw new Error('project_harness_promote 需要至少一个 tags（建议第一个写 来源/harness）：标签是跨项目检索的分类面。')
				}
				if (store === undefined) throw new Error('自衍中枢文件库不可用，无法 promote；请用 file_import 手工导入。')
				const name = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : undefined
				const file = await store.create({
					sourcePath: source.absolute,
					name,
					description,
					tags,
					links: input.links,
				})
				return { ...summaryOf(file), promotedFrom: source.relative }
			},
		},
	]
}
