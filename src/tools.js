/**
 * The card tools the agent gets from the evolver.
 *
 * One record type, one id space, tag-only classification: lifecycle and
 * topic live in hierarchical tags, not in separate fields.
 */

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
			description: '按关键词和层级标签检索卡片。标签：收集箱/临时/永久笔记/实践/经验/工作流 等；父标签自动包含子标签。提示词里只有标签树，具体内容必须在这里取。',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: '检索关键词或问题；留空则按标签列出' },
					tags: { type: 'array', items: { type: 'string' }, description: '标签前缀，例如 ["永久笔记/web开发","实践/经验"]' },
					limit: { type: 'integer', description: '返回条数，默认 8' },
					includeArchived: { type: 'boolean', description: '是否包含 #归档 卡片，默认 false' },
				},
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				const results = await cards.query({
					text: input.query,
					tags: input.tags,
					limit: input.limit,
					includeArchived: input.includeArchived === true,
				})
				return sanitize({ total: results.length, results })
			},
		},
		{
			name: 'card_read',
			description: '读一张卡片的完整记录：正文、摘要、层级标签、双链和资源附件。id 必须是 card_ 开头的 ULID。',
			parameters: {
				type: 'object',
				properties: { id: { type: 'string', description: '卡片 id' } },
				required: ['id'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				return sanitize(await cards.read(String(args?.id ?? '')))
			},
		},
		{
			name: 'card_write',
			description: '写入或更新一张卡。分类只由 tags 表达：默认 #收集箱；未验证的笔记用 #临时；长期笔记用 #永久笔记/领域/主题；已验证的实践用 #实践/经验、#实践/工作流、#实践/工具。body 超过正文上限时用 resourceName 把全文放进附件，卡片只留 label/summary。写前先 card_query 查重；不写流水账、一次性命令、猜测、密钥。links 只能是卡片 id。',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '更新已有卡片时传入 id；新卡留空' },
					body: { type: 'string', description: '正文；提供 resourceName 时存成附件' },
					label: { type: 'string', description: '列表里的一行标题；留空从正文首行派生' },
					summary: { type: 'string', description: '永久卡/实践卡的一句话摘要' },
					tags: { type: 'array', items: { type: 'string' }, description: '层级标签，例如 ["永久笔记/web开发","实践/工作流"]' },
					links: { type: 'array', items: { type: 'string' }, description: '关联卡片 id' },
					verified: { type: 'string', description: '最后验证日期 YYYY-MM-DD' },
					resourceName: { type: 'string', description: '附件文件名；提供时 body 写入附件' },
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
			description: '拿到注入用的标签树全文和每个已知标签的说明。卡片正文、label、id 都不会出现在这里；要找具体卡片用 card_query。',
			parameters: { type: 'object', properties: {} },
			output: OBJECT_OUTPUT,
			async execute() {
				return sanitize(await cards.index())
			},
		},
		{
			name: 'card_promote',
			description: '把 #收集箱/#临时 卡片提升为永久卡：去掉临时标签，加入 #永久笔记；已有 #实践 分支的卡保持实践类型。可补 summary 和标签。',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '卡片 id' },
					summary: { type: 'string', description: '一句话摘要（可选）' },
					tags: { type: 'array', items: { type: 'string' }, description: '补充/替换层级标签（可选）' },
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
			description: '给卡片加 #归档 标签：从默认检索和标签树里移出，但保留记录和资源。',
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
			description: '永久删除一张卡片及其资源附件。不可恢复；只在确认是噪声、重复或错误时使用。',
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
			description: '盘点卡片库：收集箱/临时/永久/归档数量、最近卡片、久未验证的永久卡和可执行 hints。',
			parameters: { type: 'object', properties: {} },
			output: OBJECT_OUTPUT,
			async execute() {
				return sanitize(await cards.review())
			},
		},
		{
			name: 'session_digest',
			description: '读取还没整理过的会话：只抽用户与助手的文本（不含工具输出和系统提示），按会话给出摘录。想手动整理时用；commit:true 会在保存后标记已处理。空闲时的自动整理不经过这个工具。',
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
