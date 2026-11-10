/**
 * The tools the agent gets from the evolver.
 *
 * Two families:
 *
 *   - `practice_*` reach the curated, verified layer. The injected index is a
 *     routing table; these tools are how the agent goes deeper on its own.
 *   - `memory_*` reach the sight layer: what the agent remembers, recalled on
 *     demand rather than pushed into every prompt.
 *
 * The definitions are plain JSON Schema on purpose: the plugin registers
 * itself without borrowing a Harness package, so it keeps working when the
 * installation moves.
 */

import { ENTRY_KINDS, SCOPES } from './memory/kinds.js'

/** The three legacy practice shapes the write tool accepts. */
const PRACTICE_KINDS = ['doc', 'tool', 'resource']

/**
 * Render one tool result as text.
 *
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
 * The evolver's tool set.
 *
 * @param {{practice: object, memory: object}} deps - The evolver and the memory actions.
 * @returns {object[]} The tool definitions.
 */
export function createTools({ practice, memory, sessions }) {
	return [
		{
			name: 'practice_query',
			description: '在永久卡片里检索可复用的经验、流程、验证方法、脚本与资源。永久卡是已经验证过的高信号内容：动手前先查它，沉淀前也先用它查重。返回卡片 id、label、用途和命中片段；用 practice_read 读全文。',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: '检索关键词或问题' },
					kind: { type: 'string', enum: PRACTICE_KINDS, description: '限定类型：doc 文档 / tool 工具 / resource 资源' },
					limit: { type: 'integer', description: '返回条数，默认 8' },
				},
				required: ['query'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				const results = await practice.practiceSearch(String(input.query ?? ''), {
					kind: typeof input.kind === 'string' ? input.kind : '',
					limit: Number(input.limit ?? 8),
				})
				return sanitize({ total: results.length, results })
			},
		},
		{
			name: 'practice_read',
			description: '读一张永久卡的全文（含附件）。path 可以是卡片 id（推荐），也可以是旧 slug；返回 label、summary、正文或主附件文本、链接和附件列表。',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '条目路径，相对 practice 根目录' },
				},
				required: ['path'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				return sanitize(await practice.practiceRead(String(args?.path ?? '')))
			},
		},
		{
			name: 'practice_write',
			description: '写入一张永久卡：经验、稳定的流程、验证方法、脚本用法或容易误判的长期信息。写前先 practice_query 查重、practice_read 读相关卡片，能更新已有卡片就不要新建。title 是卡片 label，purpose 是注入投影里的一句话摘要；kind 决定形状（doc/tool/resource），正文会自动存进资源附件，卡片只留摘要；topic 和附加参数 tags 组成层级标签。能脚本化的流程用 kind=tool 写可运行脚本。只写能减少未来误判、重复劳动或验证成本的内容，不写流水账、一次性命令、猜测、废弃方案、密钥和日志。links 用卡片 id 或 slug，写完返回 problems。',
			parameters: {
				type: 'object',
				properties: {
					kind: { type: 'string', enum: PRACTICE_KINDS, description: 'doc 文档 / tool 工具 / resource 资源' },
					name: { type: 'string', description: '文件名，例如 my-check.md' },
					title: { type: 'string', description: '标题，一句话说清是什么' },
					purpose: { type: 'string', description: '一句话用途：什么时候该用它' },
					topic: { type: 'string', description: '主题（会作为主题目录名与索引分组）' },
					body: { type: 'string', description: '正文，Markdown' },
					verified: { type: 'string', description: '最后验证日期，YYYY-MM-DD' },
					links: { type: 'array', items: { type: 'string' }, description: '关联条目的 slug' },
				},
				required: ['kind', 'name', 'title', 'purpose'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				return sanitize(await practice.practiceWrite({
					kind: input.kind,
					name: input.name,
					title: input.title,
					purpose: input.purpose,
					topic: input.topic,
					body: input.body,
					verified: input.verified,
					links: input.links,
				}))
			},
		},
		{
			name: 'practice_index',
			description: '拿到全部永久卡和 2KB 注入投影的完整文本。想确认某类资源都有什么、或想知道投影里哪些卡没进索引时用它。',
			parameters: { type: 'object', properties: {} },
			output: OBJECT_OUTPUT,
			async execute() {
				const state = await practice.practice()
				return sanitize({
					total: state.entries.length,
					injected: state.projection.text,
					entries: state.entries.map((entry) => ({
						kind: entry.kind,
						topic: entry.topic,
						title: entry.title,
						purpose: entry.purpose,
						path: entry.relPath,
						verified: entry.verified,
					})),
					problems: state.problems,
				})
			},
		},
		{
			name: 'card_promote',
			description: '把一张临时卡提升为永久卡，让它进入 2KB 注入投影。提升前用 practice_query 查重；summary 是投影里的一句话路由，留空用原 label。',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '临时卡 id' },
					summary: { type: 'string', description: '一句话摘要（可选）' },
					tags: { type: 'array', items: { type: 'string' }, description: '补充层级标签（可选）' },
				},
				required: ['id'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				return sanitize(await practice.promote(String(input.id ?? ''), {
					summary: input.summary,
					tags: input.tags,
				}))
			},
		},
		{
			name: 'evolve_review',
			description: '一次拿到卡片库的状态与可执行的改进提示：永久卡条目数/注入预算、临时卡数量与代表条目、建议动作。返回的 hints 是想让你主动做的事；没有高信号时也会说明。',
			parameters: { type: 'object', properties: {} },
			output: OBJECT_OUTPUT,
			async execute() {
				const overview = await practice.overview()
				const stats = memory.stats()
				const listed = memory.list({ limit: 5 })
				const problems = overview.practice?.problems ?? []
				const suggestions = overview.suggestions ?? []
				const hints = []
				if (problems.length > 0) {
					hints.push(`实践有 ${problems.length} 个结构问题；先用 practice_index 看路径，再修正。`)
				}
				const stale = suggestions.filter((item) => item.kind === 'stale').length
				if (stale > 0) hints.push(`${stale} 条实践超过半年未验证；优先复查最近用到的。`)
				if ((stats.entries ?? 0) === 0) {
					hints.push('记忆库为空；本次任务结束写一条确认过的判断或用户偏好。')
				} else if (hints.length === 0) {
					hints.push('没有结构问题；按需召回即可，不用为了主动而主动。')
				}
				return sanitize({
					practice: {
						entries: overview.practice?.entries ?? 0,
						injectedBytes: overview.practice?.injectedBytes ?? 0,
						injectedBudget: overview.practice?.injectedBudget ?? 0,
						dropped: overview.practice?.dropped ?? 0,
						problems: problems.slice(0, 8),
					},
					memory: {
						entries: stats.entries ?? 0,
						byKind: stats.entriesByKind ?? {},
						top: (listed.results ?? []).map((entry) => ({
							id: entry.id,
							kind: entry.kind,
							scope: entry.scope,
							text: String(entry.text ?? '').slice(0, 160),
						})),
					},
					suggestions: suggestions.slice(0, 8),
					hints,
				})
			},
		},
		{
			name: 'session_digest',
			description: '读取还没整理过的会话：只抽用户与助手的文本（不含工具输出和系统提示），按会话给出摘录。想手动整理时用；commit:true 会把返回的会话标记为已处理，只在保存完记忆后调用。空闲时的自动整理不经过这个工具。',
			parameters: {
				type: 'object',
				properties: {
					sinceDays: { type: 'integer', description: '只看最近 N 天有活动的会话；0 表示所有未整理的，默认 0' },
					limit: { type: 'integer', description: '返回的会话数，默认 5，最多 10' },
					commit: { type: 'boolean', description: '是否把返回的会话标记为已处理；默认 false' },
				},
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				if (sessions === undefined) {
					return sanitize({ success: false, message: '这个宿主没有提供会话读取能力。' })
				}
				const result = await sessions.digest({
					sinceDays: input.sinceDays,
					limit: input.limit,
					commit: input.commit === true,
				})
				return sanitize({
					...result,
					empty: Array.isArray(result.empty) ? result.empty.length : 0,
				})
			},
		},
		{
			name: 'memory_recall',
			description: '召回「见闻」里与问题相关的记忆：过往经历、踩过的坑、确认过的判断。记忆不会被自动塞进上下文，需要你自己来取；召回为空时说明没有相关记忆，不要编造。',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: '检索关键词或问题' },
					kinds: { type: 'array', items: { type: 'string' }, description: '限定类型，如 ["failure","convention"]' },
					scopes: { type: 'array', items: { type: 'string' }, description: '限定作用域' },
					projectKey: { type: 'string', description: '限定项目目录' },
					limit: { type: 'integer', description: '返回条数，默认 8' },
				},
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				return sanitize(await memory.recall(args ?? {}))
			},
		},
		{
			name: 'memory_save',
			description: '记下一条值得留住的记忆：这次任务里确认过的判断、踩到的坑、外部工具的稳定行为。内容几乎相同会更新那一条而不是重复保存。值得长期复用的结论请另外用 practice_write 沉淀到「实践」。',
			parameters: {
				type: 'object',
				properties: {
					content: { type: 'string', description: '记忆正文，一句话，越具体越好' },
					kind: { type: 'string', enum: ENTRY_KINDS, description: '记忆类型' },
					scope: { type: 'string', enum: SCOPES, description: '作用域，默认 global' },
					tags: { type: 'array', items: { type: 'string' }, description: '可选标签，用于召回匹配' },
					projectKey: { type: 'string', description: 'project 作用域使用的目录路径' },
				},
				required: ['content'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				return sanitize(await memory.save(args ?? {}))
			},
		},
		{
			name: 'memory_list',
			description: '列出已保存的记忆（按类型或作用域过滤）。',
			parameters: {
				type: 'object',
				properties: {
					kind: { type: 'string', enum: ENTRY_KINDS, description: '按类型过滤' },
					scope: { type: 'string', enum: SCOPES, description: '按作用域过滤' },
					limit: { type: 'integer', description: '返回条数，默认 20' },
				},
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				return sanitize(memory.list(args ?? {}))
			},
		},
		{
			name: 'memory_forget',
			description: '删除一条记忆（过时了、记错了、不再需要）。',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '要删除的记忆 id' },
				},
				required: ['id'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				return sanitize(await memory.forget(args ?? {}))
			},
		},
		{
			name: 'memory_stats',
			description: '记忆库统计：条目数、类型分布、作用域分布。',
			parameters: { type: 'object', properties: {} },
			output: OBJECT_OUTPUT,
			async execute() {
				return sanitize(memory.stats())
			},
		},
	]
}
