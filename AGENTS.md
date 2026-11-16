> 在执行任何操作前，必须先根据下方文件索引查阅获取足够上下文，确认信息充分后再行动；`harness/harness.md` 是必须查阅的项目总览。
# 文档索引，按需查阅

- [自衍中枢 · 项目总览](harness/harness.md)：自衍中枢插件的项目总览：插件是什么、README 与 DESIGN 的分工、源码布局、常用命令与关键约束，以及本项目 harness 资源的四层分工与写入方式；改这个仓库的代码或要了解它的设计取舍前先读它。
- [写 harness 资源并验证索引](harness/workflow/harness-resource-write.md)：往项目 harness 写资源（流程、经验、脚本、模板）的完整操作规程：参数与命名约定、插件自动做的建骨架写边车重建索引校验回滚四步、手写 AGENTS.md 被备份等四个陷阱，以及跑 node harness/tool/verify-repo.mjs 做语法加结构加测试三重验证的判读方法。
- [同一仓库并行会话的认知分叉](harness/experience/parallel-sessions-one-repo.md)：同一仓库开两个会话做同一条工作线时的踩坑与对策：会话上下文是时点快照而非共享状态、开工前必须用 git log/status 对齐事实、并行要用 git worktree 物理隔离、收尾必须提交或列清未提交改动的归属；以后遇到多会话并行改同一仓库、接手别人留下的工作区、判断某段改动是谁做的时看这篇。
- [契约与提示词改动：先给选项，再动手](harness/experience/contract-change-by-options.md)：改提示词、静态注入段、工具契约这类影响模型行为的文案时的协作规矩：先给现状诊断、两到四个完整可替换候选和字节/token 对比表让用户拍板，再一次改到位并同步测试与文档；以后要改注入文案、整理提示词或工具描述时照这个流程走。
- [偏好的双写模式：入口与权威文件必须同内容](harness/experience/preferences-copy-mode.md)：偏好双写模式的硬要求与修法：入口 ~/.dsh/AGENTS.md 就是 DSH 注入的那份文件，没有软链权限时它必须与权威文件逐字节一致；含曾经的迁移不同步缺陷、修法、allowLink 测试缝，以及「某台机器才有的路径必须给不依赖该机器的测试入口」这条教训。
- [仓库自检闸门脚本](harness/tool/verify-repo.mjs)：一条命令跑完本仓库的自检闸门：node --check 全量语法、harness 结构与 AGENTS.md 索引一致性校验、逐文件跑全量测试并汇总通过/失败/跳过；改完宿主代码或写了 harness 资源后跑它，就能确认语法、索引与测试都没坏。
