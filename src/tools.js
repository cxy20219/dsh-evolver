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
			description: '按关键词和层级标签检索卡片。顶层只有 践行/见闻/即兴/复盘/觉察/试错；父标签自动包含子标签。提示词里只有卡片索引与结构摘要，具体内容必须在这里取；分类用 card_index。默认返回命中卡（每张带 degree 入/出链数），先看枢纽再决定读哪张；graph:true 进入关系图模式，返回命中卡 + related 一跳邻居 + graph 子图，沿双链扩散（hops 1-3 控制范围）；within 传卡片 id 数组则只在给定子图里做二次搜索（自动进入图模式）。用法：先普通搜定位，再 graph 搜看关联，最后 within 深挖。',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: '检索关键词或问题；留空则按标签列出' },
					tags: { type: 'array', items: { type: 'string' }, description: '标签前缀，例如 ["践行/工作流","见闻/网络"]' },
					limit: { type: 'integer', description: '返回条数，默认 8' },
					includeArchived: { type: 'boolean', description: '是否包含 #归档 卡片，默认 false；归档卡正文通常很长，只在找旧记录时打开' },
					graph: { type: 'boolean', description: '关系图模式：返回命中卡 + related 邻居 + 子图，默认 false 只返回普通命中列表' },
					hops: { type: 'integer', description: '图模式下沿双链扩散的跳数，1-3，默认 1；2 才看得到邻居的邻居' },
					within: { type: 'array', items: { type: 'string' }, description: '卡片 id 或唯一缩写：只在这些卡片的子图里做二次搜索，会自动进入图模式；留空表示不限' },
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
					graph: input.graph === true,
					hops: input.hops,
					within: Array.isArray(input.within) ? input.within : [],
				})
				// The flat mode keeps its historical `{total, results}` shape; the
				// graph mode adds the relation half under the same total.
				if (Array.isArray(results)) return sanitize({ total: results.length, results })
				return sanitize({ total: results.cards.length, ...results })
			},
		},
		{
			name: 'card_read',
			description: '读一张卡片的完整记录：正文、摘要、层级标签、双链和资源附件。resourceContents 里有附件的绝对 path 和 executable，入口命令优先用该绝对路径。id 传完整 ULID，或卡片索引里显示的缩写（唯一即解析）。neighbors:true 时附带出链/入链（各最多 10 条，{id,label,tags}），可以顺着链接继续读。',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '卡片 id：完整 ULID 或唯一缩写（如 Q928RY）' },
					neighbors: { type: 'boolean', description: '是否附带出链/入链（各最多 10 条），默认 false；顺着链接跳转时打开' },
				},
				required: ['id'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				return sanitize(await cards.read(String(input.id ?? ''), { neighbors: input.neighbors === true }))
			},
		},
		{
			name: 'card_write',
			description: '写入或更新一张卡。顶层标签只允许 #践行 #见闻 #即兴 #复盘 #觉察 #试错；新卡默认 #即兴，落定后摘掉 #即兴。标签先复用树里已有的路径，确实没有再新建子标签；最多三层（枝干/主题/子题），名字用中文名词/动宾短语，不带标点空格。带附件时必须同时给 resourceName 和 resourceContent；body 必须包含 `[标题]({{resource}})：用途、入口命令、输入输出、关联流程`，写入时 {{resource}} 替换为相对数据目录的 knowledge/resources/<card-id>/<文件名>，缺少引用会被拒绝。脚本附件会自动设为可执行。写前先 card_query 查重；不写流水账、一次性命令、猜测、密钥。links 只能是卡片 id。',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '更新已有卡片时传入 id（完整或唯一缩写）；新卡留空' },
					body: { type: 'string', description: '卡片正文；首行会派生 label。有附件时必须包含 [标题]({{resource}})：用途、入口命令、输入输出、关联流程' },
					description: { type: 'string', description: '可选：一句话说明这张卡讲什么、什么时候值得读（≤120 字，单行）。会进检索与注入索引，写卡时顺手写' },
					tags: { type: 'array', items: { type: 'string' }, description: '层级标签，顶层必须是六大枝干之一，例如 ["践行/工作流","见闻/网络"]' },
					links: { type: 'array', items: { type: 'string' }, description: '关联卡片 id（完整或唯一缩写，必须是已有卡片），双向关系只需写一次' },
					quote: { type: 'string', description: '可选：这条笔记的逐字出处（用户原话、文件原句，≤160 字）。抄不到就别填——编造的出处比没有更糟；整理时会拿它核对正文' },
					resourceName: { type: 'string', description: '附件文件名；必须与 resourceContent 同时提供' },
					resourceContent: { type: 'string', description: '附件的完整文件内容；脚本/文档原文放这里，不要放进 body' },
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
			description: '标签目录：默认 2 KB 预算内给整棵树（一行一个标签：路径、卡片数、说明），超预算先省说明再少层并用 tag 钻取；不含卡片正文，找卡用 card_query。',
			parameters: {
				type: 'object',
				properties: {
					tag: { type: 'string', description: '钻取单个标签：返回其说明与子标签；可传完整路径或唯一后缀（如 工作流）' },
					depth: { type: 'integer', description: '展开层数：整棵树 1-3（1=顶层枝干，默认全部）；钻取时 1=该标签+直接子标签（默认）' },
				},
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				return sanitize(await cards.index(args ?? {}))
			},
		},
		{
			name: 'card_promote',
			description: '把 #即兴 卡片整理进六大枝干：从 #践行/#见闻/#复盘/#觉察/#试错 中选择目标标签。',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: '卡片 id' },
					tags: { type: 'array', items: { type: 'string' }, description: '替换层级标签（可选）' },
				},
				required: ['id'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				const input = args ?? {}
				return sanitize(await cards.promote(String(input.id ?? ''), { tags: input.tags }))
			},
		},
		{
			name: 'card_archive',
			description: '给卡片加 <枝干>/归档 叶子（例如 #践行/归档）：从默认检索和标签树里移出，但保留记录和资源。',
			parameters: {
				type: 'object',
				properties: { id: { type: 'string', description: '卡片 id：完整 ULID 或唯一缩写' } },
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
				properties: { id: { type: 'string', description: '卡片 id：完整 ULID 或唯一缩写' } },
				required: ['id'],
			},
			output: OBJECT_OUTPUT,
			async execute(args) {
				return sanitize(await cards.remove(String(args?.id ?? '')))
			},
		},
		{
			name: 'cache_report',
			description: '看当前会话的提示词缓存命中情况：每步的输入/缓存读/缓存写、总命中率，以及哪些步是缓存全丢（前缀被重建）。用于判断注入块是否稳定。',
			parameters: {
				type: 'object',
				properties: {
					session: { type: 'string', description: '会话 id；留空用当前会话' },
				},
			},
			output: OBJECT_OUTPUT,
			async execute(args, exec) {
				if (sessions?.cache === undefined) {
					return { available: false, message: '这个宿主没有提供会话读取能力。' }
				}
				const id = String(args?.session ?? exec?.agent?.id ?? '')
				if (id === '') throw new Error('拿不到会话 id；请显式传 session。')
				const report = await sessions.cache(id)
				// The tail is what a person reads; the head is the shape.
				return {
					...report,
					steps: report.messages,
					largest: report.largest === null ? null : {
						turn: report.largest.turn,
						step: report.largest.step,
						prompt: report.largest.prompt,
					},
				}
			},
		},
		{
			name: 'evolve_review',
			description: '盘点卡片库：六大枝干数量、#即兴 待整理项、归档数量、标签卫生（枝干数/一次性枝干/无说明枝干/未落定卡）、链接图（卡片数/链接数/密度/孤岛率/枢纽）、最近卡片、久未复查的卡和可执行 hints。',
			parameters: { type: 'object', properties: {} },
			output: OBJECT_OUTPUT,
			async execute() {
				return sanitize(await cards.review())
			},
		},
		{
			name: 'session_digest',
			description: '读取还没整理过的会话：只抽用户与助手的文本（不含工具输出和系统提示），按会话给出摘录。只读，不推进游标——游标归空闲时的自动整理独占；手动读完想沉淀的内容用 card_write 写卡。',
			parameters: {
				type: 'object',
				properties: {
					sinceDays: { type: 'integer', description: '只看最近 N 天有活动的会话；0 表示所有未整理的，默认 0' },
					limit: { type: 'integer', description: '返回的会话数，默认 5，最多 10' },
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
				})
				return sanitize({
					...result,
					empty: Array.isArray(result.empty) ? result.empty.length : 0,
				})
			},
		},
	]
}
