/**
 * What the model sees on every request.
 *
 * One static block in the system prompt, and nothing else: the library is not
 * injected, because an agent that needs a file searches for it with
 * `file_search`. A write therefore never changes the prompt prefix, and there
 * is no snapshot to rebuild on a schedule.
 *
 * The text is deliberately shorter than the tool descriptions: anything a tool
 * already says next to its own call is not repeated here. What stays is what
 * no tool says: that there is no index to read, where two kinds of knowledge
 * go while working, and how to act without being asked.
 */

/** The fixed discipline. */
const FILE_DISCIPLINE = [
	'[文件] 不注入文件索引：找用 file_search（按描述/标签/links），读用 file_read（库文件 id/短 id、项目内路径、或 "harness/" 清单）；库文件、项目文件、项目 harness 资源的写改用 file_write（新建/更新/导入/写路径）和 file_edit（正文精确替换、元数据、归档）。描述是检索面，标签是分类面。',
	'- 相关文件必须写进 links（否则是孤岛）；标签用自由层级，至少一个。',
	'- **描述要写清两件事**：这个文件是什么（做法/结论），以及以后哪些场景、任务、问题会用到它；以后搜索时输入的话，最好就出现在描述里。',
].join('\n')

/**
 * The proactivity protocol, including how knowledge is sunk while working.
 *
 * The two-layer rule lives here rather than in its own section: sinking a
 * lesson is part of acting without being asked, and the prompt is a protocol
 * list, not a table of contents. Tool descriptions carry the write contract;
 * this says which store a sentence belongs to and what a description must
 * contain.
 */
const PROACTIVE_PROTOCOL = [
	'[主动性] 用自衍中枢提前一步，不等指令：',
	'- 开工前先搜：任务名词原样丢给 file_search，先看描述和邻居，再决定读哪个。',
	'- 干活时顺手沉淀，分两层：只在本仓库成立的判断、约定、命令、流程 → file_write 到 `harness/` 路径（宿主自动建骨架、重建 AGENTS.md 索引并校验）；以后别的项目或任务能复用的踩坑经验、流程、脚本 → file_write({from:"harness/...", meta:{description,tags}}) 落库（标签加 来源/harness，links 关联相关文件）。',
	'- 描述是检索面：harness 的 summary 与库文件的 description 都写清「是什么」+「以后哪些场景、任务、问题会用到它」（写成以后会搜的关键词），不要写“某次会话记录/临时用/待补”。',
	'- 跨项目、库里没有的判断 → file_write（先查重，description 写清适用场景 + 标签 + links）。',
	'- 同一流程第二次出现，把它写成脚本文件，并用 links 关联到相关文件。',
].join('\n')

/**
 * The static system section — the plugin's only injection.
 *
 * @returns {string} The discipline plus the proactive protocol.
 */
export function staticSection() {
	return `${FILE_DISCIPLINE}\n\n${PROACTIVE_PROTOCOL}`
}
