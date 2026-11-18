> 在执行任何操作前，必须先根据下方文件索引查阅获取足够上下文，确认信息充分后再行动；`harness/harness.md` 是必须查阅的项目总览。
# 文档索引，按需查阅

> 本索引由项目自己维护：自衍中枢不再生成它，也不再拒绝手写。改 `harness/` 时记得同步这里。

- [自衍中枢 · 项目总览](harness/harness.md)：自衍中枢插件的项目总览：插件是什么、README 与 DESIGN 的分工、源码布局、常用命令与关键约束；改这个仓库的代码或要了解它的设计取舍前先读它。
- [ziyan 命令行与 skill：agent 的接入面](skill/ziyan-evolver/SKILL.md)：四个动词怎么调、描述怎么写、与 harness-evolver 的范围分工（跨项目 vs 项目内）。插件已不向 DSH 注册工具，agent 走 `ziyan` 命令或这个 skill；改接入方式、排查「agent 不知道有这个库」时先看。
- [独立桌面版：复用而非重写](desktop/README.md)：把库从 DSH 插件变成可独立启动的桌面应用：`desktop/server.js` 顶替装配层、`shim.js` 让 `client.js` 零改动、`main.cjs` 只是窗口。启动方式、还没接的整理引擎、以及 `system/` 绝不进同步盘的原因。
- [在宿主应用里启动 Electron 的三个坑](harness/experience/electron-inside-a-host.md)：`ELECTRON_RUN_AS_NODE=1` 让 Electron 退化成纯 Node、ESM 具名导入拿不到 `app`（必须 CJS 主进程 + 动态 import）、Chromium 沙箱与宿主文件沙箱冲突。排查「Electron 明明启动了但内置模块是 undefined」时先看。
- [为什么把项目 harness 解耦出去](harness/experience/library-scope-decoupled-from-projects.md)：自衍中枢只管库（存文件、找得到、直接可用），项目 harness 归项目自己；解耦删掉了什么、留下什么、失去的三条保证，以及「以后别再把托管加回来」的判断边界。想重新引入边车/索引/校验前先读。
- [同一仓库并行会话的认知分叉](harness/experience/parallel-sessions-one-repo.md)：同一仓库开两个会话做同一条工作线时的踩坑与对策：会话上下文是时点快照而非共享状态、开工前必须用 git log/status 对齐事实、并行要用 git worktree 物理隔离、收尾必须提交或列清未提交改动的归属；以后遇到多会话并行改同一仓库、接手别人留下的工作区、判断某段改动是谁做的时看这篇。
- [契约与提示词改动：先给选项，再动手](harness/experience/contract-change-by-options.md)：改提示词、静态注入段、工具契约这类影响模型行为的文案时的协作规矩：先给现状诊断、两到四个完整可替换候选和字节/token 对比表让用户拍板，再一次改到位并同步测试与文档；以后要改注入文案、整理提示词或工具描述时照这个流程走。
- [偏好的双写模式：入口与权威文件必须同内容](harness/experience/preferences-copy-mode.md)：偏好双写模式的硬要求与修法：入口 ~/.dsh/AGENTS.md 就是 DSH 注入的那份文件，没有软链权限时它必须与权威文件逐字节一致；含曾经的迁移不同步缺陷、修法、allowLink 测试缝，以及「某台机器才有的路径必须给不依赖该机器的测试入口」这条教训。
- [工具描述是能力的第一现场](harness/experience/tool-contract-visibility.md)：工具能力已实现但描述没露出目标×能力矩阵时，模型会退回整篇重写或用 bash/python 绕道。改工具描述、补报错文案的下一步动作、或排查 agent 为何选错动词、读会话工具调用链复盘时先看。
- [载荷要能被对方解析：截断与类型声明](harness/experience/payload-must-stay-parseable.md)：载荷必须能被对方解析：字符截断会把 JSON 砍成半截，schema 不声明类型模型就自己发明格式。排查「整理器空转 0 写入」「工具调用反复失败不自纠」「要不要加兼容层/解包」时看。
- [给别的 agent 开 MCP 端点：协议子集与两个坑](harness/experience/mcp-endpoint-for-other-agents.md)：给别的 agent 开 MCP 端点的协议子集与两个真坑：JSON-RPC 五方法、GET 405、回显 protocolVersion、isError 承载业务错误；面板里 error 是信封保留字、listen(0) 要回报实际端口。实现或排查 MCP 服务端时看。
- [仓库自检闸门脚本](harness/tool/verify-repo.mjs)：仓库自检闸门脚本：一条命令跑完全量语法检查与全量测试并汇总通过/失败/跳过；改完宿主代码后跑它。测试输出固定按 TAP 解析，测试文件退出码非零一律算失败，不会出现测试红了闸门却报通过。
