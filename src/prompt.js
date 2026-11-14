/**
 * What the model sees on every request.
 *
 * One static block in the system prompt, and nothing else: the library is not
 * injected, because an agent that needs a file searches for it with
 * `file_query`. A write therefore never changes the prompt prefix, and there
 * is no snapshot to rebuild on a schedule.
 *
 * The text is deliberately shorter than the tool descriptions: anything a tool
 * already says next to its own call is not repeated here. What stays is what
 * no tool says: that there is no index to read, where project-scoped knowledge
 * goes, and how to act without being asked.
 */

/** The fixed discipline. */
const FILE_DISCIPLINE = [
	'[文件] 不注入文件索引：需要什么用 file_query 按描述/标签/links 搜；描述是检索面，标签是分类面，正文和脚本先 file_read 拿 path。',
	'- 写文件细则见 file_write / file_import 的工具描述。这里只说它没说的：相关文件必须写进 links（否则是孤岛）；标签用自由层级，至少一个。',
	'- 搜索只命中 name/description/tags；一份资料能不能被搜到，取决于写的时候描述有没有写清。',
].join('\n')

/** The proactivity protocol. */
const PROACTIVE_PROTOCOL = [
	'[主动性] 用自衍中枢提前一步，不等指令：',
	'- 开工前先搜：任务名词原样丢给 file_query，先看描述和邻居，再决定读哪个。',
	'- 每轮答复前：跨项目、库里没有的判断 → file_write（先查重，description + 标签 + links）；只在这个仓库成立的约定 → 写进项目 harness（见下方 [项目 harness]）。',
	'- 收尾给一条具体可执行的下一步（命令/文件/验证方式），不要只问“还需要什么”。',
	'- 同一流程第二次出现，提议把它写成脚本文件，并用 links 关联到说明文件。',
	'- 不确定时先做可逆部分，只就改变结果的决策提问；每次主动都要有依据。',
].join('\n')

/**
 * Where project-scoped knowledge goes, and where it does not.
 *
 * This is the one thing no `project_harness_*` tool description can say: the
 * split between the two stores. The tool descriptions carry the write contract;
 * this says which store a given sentence belongs to.
 */
const PROJECT_HARNESS = [
	'[项目 harness] 项目依赖、约定、命令、流程交给项目自己的 harness/ 资源系统：harness/harness.md 总览 + workflow 流程 / experience 经验 / tool 可执行物 / resources 工具读的东西四层，AGENTS.md 里由工具维护的受管块是它的索引（块外内容不动）。',
	'- 只在本仓库成立的判断、约定、命令、流程写 harness，不写进全局库：先用 project_harness_catalog 看现状，没有 harness 就传 init:true 建骨架，再 project_harness_write。',
	'- 跨项目可复用的资源才 project_harness_promote 落进自衍中枢库（或 file_import），标签加 来源/harness，并用 links 关联库内相关文件。',
	'- harness 写完可 project_harness_validate 自检；缺 Python 解释器时语法校验标 skipped，不算失败。',
].join('\n')

/**
 * The static system section — the plugin's only injection.
 *
 * @returns {string} The discipline plus the proactive protocol plus the
 *   harness split.
 */
export function staticSection() {
	return `${FILE_DISCIPLINE}\n\n${PROACTIVE_PROTOCOL}\n\n${PROJECT_HARNESS}`
}
