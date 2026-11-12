/**
 * The proactivity protocol injected right after the tag tree.
 *
 * The tag map says what exists; this block says when to act on it
 * without being asked. It is deliberately short: it is injected on every
 * request, so every line has to change behavior.
 */
export const PROACTIVE_PROTOCOL = [
	'[主动性] 用演化器提前一步，不等指令：',
	'- 开工前先搜：把任务的名词原样丢给 card_query（插件 / 面板 / 验证 / 部署 / 工具名）。一次调用而已，漏掉自己写过的坑要重走一遍。',
	'- 有可复用的判断就分两个落点，被纠正后也算：换项目也成立的写 card_write（先查重），只在本仓库成立的写 harness_write（先 harness_catalog）。全局 AGENTS.md 只读，别提议改。',
	'- 收尾给一条具体、可执行的下一步（命令/文件/验证方式），不要只问“还需要什么”。',
	'- 同一流程第二次出现，主动提议从 #即兴 整理进 #践行/#见闻/#复盘/#觉察/#试错（card_promote），或写成脚本。',
	'- 盘点用 evolve_review；久未验证或结构问题，在合适时机提醒一句，不打断当前任务。',
	'- 不确定时先完成可逆部分，只就那个会改变结果的决策提问。',
	'- 每次主动都要有依据（卡片/当前任务），不编造、不刷存在感。',
].join('\n')
