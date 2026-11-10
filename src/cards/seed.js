/**
 * The three starter cards a brand-new data folder receives.
 *
 * They are card-native on purpose: no old practice tree, no frontmatter
 * parser, no migration path. Long documents live in the resource attachment;
 * the card itself keeps the one-line route.
 */

/** The starter documents. */
const STARTER_CARDS = [
  {
    "slug": "plugin-effective",
    "label": "确认插件改动是否生效",
    "summary": "装完插件后用槽查询确认它真的注册上了",
    "topic": "验证方法",
    "verified": "2026-11-10",
    "body": "## 现象\n\n插件装上之后，页面里看不到入口，或者接口报 404。\n\n## 做法\n\n1. 确认插件行状态：用插件管理列出该行，看 fiberPhase 是 active。\n2. 确认槽注册：查询客户端槽，看 sidebar 面板列表和主面板里都有没有自己的 id。\n3. 确认产物是最新的：看服务下发的浏览器产物版本号是否随文件改动变化。\n\n## 边界\n\n槽注册成功只说明\"挂上了\"，不代表\"用户看到的样子是对的\"，后者需要真的打开页面看。\n",
    "resource": "plugin-effective.md"
  },
  {
    "slug": "sinking",
    "label": "沉淀纪律与脚本优先",
    "summary": "判断什么该沉淀、写到哪里、怎么验证（原 harness-evolver 技能的内化版）",
    "topic": "演化器",
    "verified": "2026-11-10",
    "body": "## 什么时候沉淀\n\n完成多步工具调用（≥3 步）的任务后，如果出现已验证且可复用的判断、稳定流程、验证方法或工具，就沉淀；\n没有高信号内容时安静跳过，不要为了\"有产出\"硬凑。\n\n## 不写什么\n\n流水账、一次性命令、临时猜测、废弃方案、密钥与令牌、完整日志、完整对话转录。\n\n## 写到哪里\n\n- `doc`：经验、流程、验证方法、外部规则与版本差异。\n- `tool`：能重复运行的脚本或 CLI。先按下面的脚本优先协议判断。\n- `resource`：模板、示例输入、静态资源。\n\n## 脚本优先协议\n\n满足任一条件时必须写成 `tool`，不能只写文档：\n\n- 稳定流程需要两个及以上固定命令；\n- 同类任务会重复做参数、文件或数据转换；\n- 人工解析结构化输出容易出错；\n- 需要产出一致结果，或需要能重复运行的验证。\n\n脚本契约：\n\n- 实现本次要复用的真实动作，禁止空壳、伪代码或只打印说明的模板；\n- 可复用 CLI 提供 `--help`，明确输入、输出和非零失败退出码；\n- 写操作显式指定目标，能安全预览时提供 `--dry-run`；\n- 文档里写清适用条件、依赖、代表性调用、成功信号和常见失败信号。\n\n## 闭环\n\n1. 写前用 `card_query` 查重、`card_read` 读相关卡片；能更新已有卡片就不新建。\n2. 写后确认 links 都是卡片 id、永久卡有 verified；结构问题未清零时，不要宣称沉淀完成。\n3. 在最终答复里说明仍存在的结构问题。\n",
    "resource": "sinking.md"
  },
  {
    "slug": "index-drift",
    "label": "索引会随内容腐化",
    "summary": "手写的索引一定会和文件对不上，所以索引必须生成",
    "topic": "验证方法",
    "verified": "2026-11-10",
    "body": "## 现象\n\n条目改了标题或删了文件，索引里还留着旧的路由。\n\n## 做法\n\n索引由条目前言生成，不手写；改完条目重新生成一次，并让校验器检查链接闭环。\n\n## 边界\n\n生成式索引保证\"有条目就有路由\"，但保证不了\"条目的内容是对的\"——那要靠 verified 字段和人工复查。\n",
    "resource": "index-drift.md"
  }
]

/**
 * Seed the starter cards when the store is still empty.
 *
 * @param {object} store - The card store.
 * @returns {Promise<number>} How many cards were written.
 */
export async function seedStarterCards(store) {
	if (store.all().length > 0) return 0
	let count = 0
	for (const entry of STARTER_CARDS) {
		try {
			await store.put({
				type: 'permanent',
				shape: 'doc',
				status: 'verified',
				category: '',
				label: entry.label,
				summary: entry.summary,
				body: entry.summary,
				topic: entry.topic,
				tags: [entry.topic],
				verified: entry.verified,
				source: 'seed',
			}, { resourceInputs: [{ name: entry.resource, data: entry.body }] })
			count += 1
		} catch {
			// A seed that fails to write must not block activation; the card
			// can still be created from the panel.
		}
	}
	return count
}
