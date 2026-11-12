> 在执行任何操作前，必须先根据下方文件索引查阅获取足够上下文，确认信息充分后再行动；`harness/harness.md` 是必须查阅的项目总览。
# 文档索引，按需查阅

- [Harness 开发指南](harness/harness.md)：插件仓库总览：两边代码、数据目录、测试与重启约束
- [插件改动后的验证顺序](harness/workflow/verify-after-change.md)：改完插件的标准验证顺序：语法单测→重启或刷新→真实界面→接口字段核对
- [索引里的标签与顺序按路径收编，改名要先改写索引](harness/experience/index-harvest-by-path.md)：改目录名必须先改写根 AGENTS.md 再重建索引，否则标签与用途全部退化成占位符
- [校验器不许有副作用](harness/experience/validators-have-no-side-effects.md)：校验器只能读：py_compile 会写 __pycache__，改用内存 compile 并排除构建产物
- [探针不能挂在请求路径上](harness/experience/probes-off-the-request-path.md)：状态接口现场探针 410ms；改成缓存 60 秒 + 后台刷新后 6.7ms
- [布局是双份契约：插件改了，技能必须跟着改](harness/experience/layout-is-a-two-sided-contract.md)：harness 布局是插件与技能共有的契约，改一边必须同步改另一边并用两套校验器互验
- [会变的东西不进系统段：静态纪律 + 运行时候选](harness/experience/cache-volatile-content-goes-to-context.md)：注入拆两半：静态纪律+主动性协议进系统段、会变的卡片索引进运行时上下文；只读每日快照（实测 1366 B），快照缺失时回退记忆化
- [link-layout-metrics.mjs](harness/tool/link-layout-metrics.mjs)：从 client.js 抽出 computeLinkLayout 跑真实卡片库，输出重叠/按度数半径/枝干凝聚度/耗时；`--graph` 直接跑 graph 载荷并预览弱边与区域名
- [链接关系图的布局与视觉层级：六大枝干社区](harness/experience/link-graph-force-layout.md)：关系图从核心-外围改为枝干社区布局：锚点+云团播种、四种力、弱关系虚线、区域名、按需箭头与防重叠标签；记录去掉外围控件的原因与确定性/规模实测
- [标签治理：动作、纪律、护栏三件套](harness/experience/tag-governance.md)：每日整理的标签治理：retag/tag-merge 动作、十四条纪律、四条代码护栏与审计，以及为什么「没动作入口的规则等于没有」
- [记忆分层：会话、卡片、注入与图检索](harness/experience/memory-layers.md)：当前记忆分层：会话→卡片→注入（卡片索引+结构摘要）+ 双链图检索；页层已移除，写卡不再改注入
- [混合检索：BM25 召回 + 双链扩散补全](harness/experience/hybrid-graph-search.md)：卡片检索升级为 BM25 召回 + 双链扩散补全：扩散权重、子图返回、within 二次搜索与为什么不用 embedding/GraphRAG
