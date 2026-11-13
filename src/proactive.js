/**
 * The proactivity protocol, appended to the static system section.
 *
 * The card index says what exists; this block says when to act on it without
 * being asked. It rides in the same section as the card discipline — both are
 * constants — and it is deliberately short: it is injected on every request,
 * so every line has to change behavior.
 */
export const PROACTIVE_PROTOCOL = [
	'[主动性] 用演化器提前一步，不等指令：',
	'- 开工前先搜：任务名词原样丢给 card_query（插件/面板/验证/部署/工具名）；漏掉写过的坑就得重走一遍。',
	'- 每轮答复前：跨项目、库里没有的判断 → card_write（先查重）；本仓库的约定/命令/流程 → 仓库已有 harness/ 或 AGENTS.md 就更新（harness_write 或就地 edit），没有就写卡，不新建 harness。全局 AGENTS.md 只读。',
	'- 收尾给一条具体可执行的下一步（命令/文件/验证方式），不要只问“还需要什么”。',
	'- 同一流程第二次出现，提议 card_promote 把 #即兴 落定，或写成脚本。',
	'- 盘点用 evolve_review；结构问题挑时机提醒，不打断当前任务。',
	'- 不确定时先做可逆部分，只就改变结果的决策提问。',
	'- 每次主动都要有依据（卡片/当前任务），不编造、不刷存在感。',
].join('\n')
