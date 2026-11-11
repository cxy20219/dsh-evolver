/**
 * The tools that maintain a project's `harness/` resources.
 *
 * They exist because the rules they enforce cannot be enforced by a prompt:
 * scan before writing, rebuild the index from the folder, refuse to report a
 * write that left the folder inconsistent. A model can skip an instruction; it
 * cannot skip a tool that returns an error.
 */

import { catalog, ensureIndex, initHarness, migrateLayout, renderIndex } from './store.js'
import { validate } from './validate.js'
import { writeResource } from './write.js'

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

/** A compact copy of a catalog, small enough to read in one look. */
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
		index: {
			entries: state.index.refs.length,
			notIndexed: state.index.missing,
			pointingNowhere: state.index.stale,
		},
	}
}

/**
 * The harness tool set.
 *
 * @param {{resolveProject: (exec: object) => Promise<string | undefined>}} deps - How to find the project.
 * @returns {object[]} The tool definitions.
 */
export function createHarnessTools({ resolveProject }) {
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
			throw new Error('无法从当前会话推断项目目录；请显式传 project（项目根绝对路径）。')
		}
		return resolved
	}

	return [
		{
			name: 'harness_catalog',
			description:
				'扫描项目 harness/ 资源系统的现状：分层文件、标题与一句话用途、AGENTS.md 索引差集、缺失与多余项。写 harness 资源前必须先调用它。',
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
					// init replaces the hand-written index with the managed block.
					await ensureIndex(root)
				}
				const state = await catalog(root)
				scanned.set(String(exec?.agent?.id ?? 'anonymous'), root)
				return summarize(state)
			},
		},
		{
			name: 'harness_write',
			description:
				'写入或更新一条项目 harness 资源，并自动重建 AGENTS.md 索引、自动校验；校验不过会回滚并报错。必须先在本会话调用过 harness_catalog。summary 是索引里的一句话用途，必填。',
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
					throw new Error('先调用 harness_catalog 看现有资源，确认没有合适落点再写。')
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
				return { ...result, index: renderIndex(await catalog(root)).split('\n').length }
			},
		},
		{
			name: 'harness_validate',
			description:
				'校验项目 harness/ 的结构、AGENTS.md 索引完整性、脚本文档契约（命令块与验证标记）以及 Python 语法。写完后可直接调用。',
			parameters: {
				type: 'object',
				properties: {
					project: { type: 'string', description: '项目根绝对路径；留空则用当前会话的工作目录推断' },
				},
			},
			output: OBJECT_OUTPUT,
			async execute(args, exec) {
				const root = await rootFor(exec, args?.project)
				return validate(root)
			},
		},
	]
}
