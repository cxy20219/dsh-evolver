> 在执行任何操作前，必须先根据下方文件索引查阅获取足够上下文，确认信息充分后再行动；`harness/harness.md` 是必须查阅的项目总览。
# 文档索引，按需查阅

- [Harness 开发指南](harness/harness.md)：插件仓库总览：两边代码、数据目录、测试与重启约束
- [插件改动后的验证顺序](harness/workflow/verify-after-change.md)：改完插件的标准验证顺序：语法单测→重启或刷新→真实界面→接口字段核对
- [索引里的标签与顺序按路径收编，改名要先改写索引](harness/experience/index-harvest-by-path.md)：改目录名必须先改写根 AGENTS.md 再重建索引，否则标签与用途全部退化成占位符
- [校验器不许有副作用](harness/experience/validators-have-no-side-effects.md)：校验器只能读：py_compile 会写 __pycache__，改用内存 compile 并排除构建产物
- [探针不能挂在请求路径上](harness/experience/probes-off-the-request-path.md)：状态接口现场探针 410ms；改成缓存 60 秒 + 后台刷新后 6.7ms
- [布局是双份契约：插件改了，技能必须跟着改](harness/experience/layout-is-a-two-sided-contract.md)：harness 布局是插件与技能共有的契约，改一边必须同步改另一边并用两套校验器互验
- [会变的东西不进系统段：标签树迁到运行时上下文](harness/experience/cache-volatile-content-goes-to-context.md)：标签树迁到 runtime context：新增枝干只追加 1.2KB 快照，实测未缓存输入从 29 万降到 651
