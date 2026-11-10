/**
 * The card tools the agent gets from the evolver.
 *
 * One record type, one id space: the same `card_query` / `card_write` path
 * serves permanent and fleeting cards. No practice/memory compatibility
 * names survive here.
 */

import { CARD_CATEGORIES, CARD_SHAPES, CARD_STATUSES, CARD_TYPES } from './cards/store.js'

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
 * @param {{cards: object, sessions?: object}} deps - The card operations and sessions.
 * @returns {object[]} The tool definitions.
 */
export function createTools({ cards, sessions }) {
	return [
		{
			name: 'card_query',
			description: '按关键词、类型、状态或层级标签检索卡片。永久卡是已验证、可复用的结论/流程/工具；临时卡是还没判断的见闻。动身前先查重，别凭印象。返回卡片 id、label、正文和标签；需要全文或附件时用 card_read。',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: '检索关键词或问题；留空则按条件列出' },
					type: { type: 'string', enum: CARD_TYPES, description: '限定临时卡或永久卡' },
					status: { type: 'string', enum: CARD_STATUSES, description: '限定状态' },
					tags: { type: 'array', items: { type: 'string' }, description: '层级标签前缀，例如 "验证/浏览器"' },
					limit: { type: 'integer', description: '返回条数，默认 8' },
				},
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				const results = await cards.query({
					text: input.query,
					type: input.type,
					status: input.status,
					tags: input.tags,
					limit: input.limit,
				})
				return sanitize({ total: results.length, results })
			},
		},
		{
			name: 'card_read',
			description: '读一张卡片的完整记录，包括正文、一句话摘要、标签、双链和资源附件。id 必须是 card_ 开头的 ULID；旧路径/旧 slug 不再支持。',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '卡片 id' },
				},
				required: ['id'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				return sanitize(await cards.read(String(args?.id ?? '')))
			},
		},
		{
			name: 'card_write',
			description: '写入或更新一张卡。临时卡（fleeting）用一句话记录还没判断的结论；永久卡（permanent）用 label + summary 做路由，doc/tool/resource 的正文会自动进资源附件、卡片只留摘要。写前先 card_query 查重；不写流水账、一次性命令、猜测、密钥。links 只能是卡片 id。',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '更新已有卡片时传入 id；新卡留空' },
					type: { type: 'string', enum: CARD_TYPES, description: '临时卡或永久卡，默认临时卡' },
					shape: { type: 'string', enum: CARD_SHAPES, description: '永久卡形状：note/doc/tool/resource；临时卡固定 memo' },
					body: { type: 'string', description: '正文；doc/tool/resource 会自动存成附件' },
					label: { type: 'string', description: '列表里的一行标题；留空从正文首行派生' },
					summary: { type: 'string', description: '永久卡的一句话路由，会进 2 KB 投影' },
					category: { type: 'string', enum: CARD_CATEGORIES, description: '卡片分类，默认 fact' },
					tags: { type: 'array', items: { type: 'string' }, description: '层级标签，例如 "验证/浏览器"' },
					topic: { type: 'string', description: '主题标签' },
					links: { type: 'array', items: { type: 'string' }, description: '关联卡片 id' },
					verified: { type: 'string', description: '最后验证日期 YYYY-MM-DD' },
					resourceName: { type: 'string', description: 'doc/tool/resource 附件文件名，留空自动生成' },
				},
				required: ['body'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				return sanitize(await cards.write(args ?? {}))
			},
		},
		{
			name: 'card_index',
			description: '拿到全部永久卡和 2 KB 注入投影的完整文本。想确认某类资源都有什么、或想知道投影里哪些卡没进索引时用它。',
			parameters: { type: 'object', properties: {} },
			output: OBJECT_OUTPUT,
			async execute() {
				return sanitize(await cards.index())
			},
		},
		{
			name: 'card_promote',
			description: '把一张临时卡提升为永久卡，让它进入 2 KB 注入投影。提升前用 card_query 查重；summary 是投影里的一句话路由，留空用原 label。',
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
				return sanitize(await cards.promote(String(input.id ?? ''), { summary: input.summary, tags: input.tags }))
			},
		},
		{
			name: 'card_archive',
			description: '归档一张卡片：从默认列表和注入投影里移出，但保留记录和资源。适合过时但仍需追溯的结论。',
			parameters: {
				type: 'object',
				properties: { id: { type: 'string', description: '卡片 id' } },
				required: ['id'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				return sanitize(await cards.archive(String(args?.id ?? '')))
			},
		},
		{
			name: 'card_remove',
			description: '永久删除一张卡片及其资源附件。不可恢复；只在确认这张卡是噪声、重复或错误时使用。',
			parameters: {
				type: 'object',
				properties: { id: { type: 'string', description: '卡片 id' } },
				required: ['id'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				return sanitize(await cards.remove(String(args?.id ?? '')))
			},
		},
		{
			name: 'evolve_review',
			description: '盘点卡片库：永久卡/临时卡数量、最近临时卡、久未验证的永久卡和可执行的 hints。没有高信号时它会明确说不用为了主动而主动。',
			parameters: { type: 'object', properties: {} },
			output: OBJECT_OUTPUT,
			async execute() {
				return sanitize(await cards.review())
			},
		},
		{
			name: 'session_digest',
			description: '读取还没整理过的会话：只抽用户与助手的文本（不含工具输出和系统提示），按会话给出摘录。想手动整理时用；commit:true 会把返回的会话标记为已处理，只在保存完卡片后调用。空闲时的自动整理不经过这个工具。',
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
	]
}
