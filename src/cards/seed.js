/**
 * The three starter cards a brand-new data folder receives.
 *
 * The content is the same knowledge the old practice seed carried; it now
 * lands directly in the card store, so a new install never creates a legacy
 * practice tree just to migrate it back.
 */

import { splitLegacyEntry } from '../legacy/practice.js'

/** The starter documents, kept in the old markdown shape for easy editing. */
const STARTER_ENTRIES = [
	{
		path: 'practice/docs/verify/plugin-effective.md',
		content: `---
title: 确认插件改动是否生效
purpose: 装完插件后用槽查询确认它真的注册上了
kind: doc
topic: 验证方法
verified: ${new Date().toISOString().slice(0, 10)}
---

## 现象

插件装上之后，页面里看不到入口，或者接口报 404。

## 做法

1. 确认插件行状态：用插件管理列出该行，看 fiberPhase 是 active。
2. 确认槽注册：查询客户端槽，看 sidebar 面板列表和主面板里都有没有自己的 id。
3. 确认产物是最新的：看服务下发的浏览器产物版本号是否随文件改动变化。

## 边界

槽注册成功只说明"挂上了"，不代表"用户看到的样子是对的"，后者需要真的打开页面看。
`,
	},
	{
		path: 'practice/docs/evolver/sinking.md',
		content: `---
title: 沉淀纪律与脚本优先
purpose: 判断什么该沉淀、写到哪里、怎么验证（原 harness-evolver 技能的内化版）
kind: doc
topic: 演化器
verified: ${new Date().toISOString().slice(0, 10)}
---

## 什么时候沉淀

完成多步工具调用（≥3 步）的任务后，如果出现已验证且可复用的判断、稳定流程、验证方法或工具，就沉淀；
没有高信号内容时安静跳过，不要为了"有产出"硬凑。

## 不写什么

流水账、一次性命令、临时猜测、废弃方案、密钥与令牌、完整日志、完整对话转录。

## 写到哪里

- \`doc\`：经验、流程、验证方法、外部规则与版本差异。
- \`tool\`：能重复运行的脚本或 CLI。先按下面的脚本优先协议判断。
- \`resource\`：模板、示例输入、静态资源。

## 脚本优先协议

满足任一条件时必须写成 \`tool\`，不能只写文档：

- 稳定流程需要两个及以上固定命令；
- 同类任务会重复做参数、文件或数据转换；
- 人工解析结构化输出容易出错；
- 需要产出一致结果，或需要能重复运行的验证。

脚本契约：

- 实现本次要复用的真实动作，禁止空壳、伪代码或只打印说明的模板；
- 可复用 CLI 提供 \`--help\`，明确输入、输出和非零失败退出码；
- 写操作显式指定目标，能安全预览时提供 \`--dry-run\`；
- 文档里写清适用条件、依赖、代表性调用、成功信号和常见失败信号。

## 闭环

1. 写前用 \`practice_query\` 查重、\`practice_read\` 读相关条目；能更新已有条目就不新建。
2. 写后读返回的 \`problems\`：必填字段、kind 一致、链接闭环、verified 过期。
3. 结构问题未清零时，不要宣称沉淀完成；在最终答复里说明剩余问题。
`,
	},
	{
		path: 'practice/docs/verify/index-drift.md',
		content: `---
title: 索引会随内容腐化
purpose: 手写的索引一定会和文件对不上，所以索引必须生成
kind: doc
topic: 验证方法
verified: ${new Date().toISOString().slice(0, 10)}
---

## 现象

条目改了标题或删了文件，索引里还留着旧的路由。

## 做法

索引由条目前言生成，不手写；改完条目重新生成一次，并让校验器检查链接闭环。

## 边界

生成式索引保证"有条目就有路由"，但保证不了"条目的内容是对的"——那要靠 verified 字段和人工复查。
`,
	},
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
	for (const entry of STARTER_ENTRIES) {
		const { data, body } = splitLegacyEntry(entry.content)
		const relPath = entry.path.replace(/^practice\//, '')
		const name = relPath.split('/').pop() ?? 'starter.md'
		const kind = ['doc', 'tool', 'resource'].includes(String(data.kind)) ? String(data.kind) : 'doc'
		const topic = typeof data.topic === 'string' ? data.topic : ''
		const title = typeof data.title === 'string' ? data.title : name
		const purpose = typeof data.purpose === 'string' ? data.purpose : title
		const verified = typeof data.verified === 'string' ? data.verified : new Date().toISOString().slice(0, 10)
		try {
			await store.put({
				type: 'permanent',
				shape: kind,
				status: 'verified',
				category: '',
				label: title,
				summary: purpose,
				body: purpose,
				topic,
				tags: [topic],
				slug: name.replace(/\.[^.]+$/, ''),
				verified,
				source: 'seed',
				sourceId: `practice:${relPath}`,
			}, { resourceInputs: body === '' ? [] : [{ name, data: body }] })
			count += 1
		} catch {
			// A seed that fails to write must not block activation; the card
			// can still be created from the panel.
		}
	}
	return count
}
