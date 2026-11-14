/**
 * What the model sees on every request.
 *
 * Two blocks, split by volatility: the discipline is a constant and lives in
 * the system section; the file index changes with the library and lives in the
 * runtime context, read from the daily snapshot. A write therefore does not
 * rewrite the system prompt prefix.
 *
 * The text is deliberately shorter than the tool descriptions: anything a tool
 * already says next to its own call is not repeated here. What stays is what
 * no tool says: what the index is for, the anti-orphan rule, and how to act
 * without being asked.
 */

/** The fixed discipline. */
const FILE_DISCIPLINE = [
	'[文件] 只注入文件索引与结构摘要，没有正文；描述是检索面，标签是分类面。',
	'- 写文件细则见 file_write / file_import 的工具描述。这里只说它没说的：相关文件必须写进 links（否则是孤岛）；标签用自由层级，至少一个。',
	'- 搜索只命中 name/description/tags；要看正文或执行脚本，先 file_read 拿 path。',
].join('\n')

/** The proactivity protocol. */
const PROACTIVE_PROTOCOL = [
	'[主动性] 用自衍中枢提前一步，不等指令：',
	'- 开工前先搜：任务名词原样丢给 file_query，先看描述和邻居，再决定读哪个。',
	'- 每轮答复前：跨项目、库里没有的判断 → file_write（先查重，description + 标签 + links）；只在这个仓库成立的约定 → 写进项目自己的 harness/文档。',
	'- 收尾给一条具体可执行的下一步（命令/文件/验证方式），不要只问“还需要什么”。',
	'- 同一流程第二次出现，提议把它写成脚本文件，并用 links 关联到说明文件。',
	'- 不确定时先做可逆部分，只就改变结果的决策提问；每次主动都要有依据。',
].join('\n')

/**
 * The static system section.
 *
 * @returns {string} The discipline plus the proactive protocol.
 */
export function staticSection() {
	return `${FILE_DISCIPLINE}\n\n${PROACTIVE_PROTOCOL}`
}
