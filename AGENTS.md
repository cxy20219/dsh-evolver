> 改动前先按下面「先读什么」查上下文；`README.md` 是用法总览，`DESIGN.md` 是设计终稿。
# dsh-ziyan · 自衍中枢

DSH 插件：**一切皆文件**的知识库。每个文件是一等实体（唯一 id + 一句话描述 + 自由层级标签 + 链接），元数据落在边车 `meta.json`，SQLite 只维护「描述索引 + 关系」，正文由 agent 自己读。

仓库根就是包根（`package.json` = `dsh-ziyan`）。旧插件 `dsh-evolver` 1.0.0 已归档在 `v1.0.0` 分支并从本仓库移除；本分支只维护自衍中枢。注意：本机 desktop profile 里仍可能装着旧 evolver，它与 ziyan 并存（工具名前缀因此要区分）。

## 先读什么

| 想知道 | 读 |
|---|---|
| 插件是什么、怎么用、数据目录长什么样、怎么迁移老库 | [README.md](README.md) |
| 为什么这样设计、每条契约的取舍、分阶段落地记录与待定决策 | [DESIGN.md](DESIGN.md) |
| 与旧 evolver 1.0.0 的量化对比和取舍 | [COMPARISON.md](COMPARISON.md) |

## 布局

| 路径 | 内容 |
|---|---|
| `index.js` | 宿主装配：store、12 个工具（8 个 `file_*` + 4 个 `project_harness_*`）、一段静态注入（无运行时索引）、26 个面板接口、整理引擎与自动调度 |
| `client.js` | 浏览器半边，单文件 `window.__ModuleLoader__.load` 工厂，无构建；七个页签 + 图谱 canvas 引擎 |
| `src/harness/` | 项目 harness 资源系统：`store.js`（四层目录 + AGENTS.md 受管索引块 + 目录收编）、`write.js`（原子写 + 自动重建索引 + 校验回滚）、`validate.js`（结构/索引/脚本文档契约/Python 语法）、`tools.js`（`project_harness_*` 四个工具） |
| `src/` | `store.js`（边车 + 索引）、`db.js`（SQLite）、`day.js`（本地日期）、`preferences.js`（全局偏好的标记段落）、`tools.js`（文件工具 + `describeTools` 目录 + 分类表）、`prompt.js`（静态纪律 + 主动性 + 项目 harness 分工）、`remote.js`、`sessions.js`（会话摘要 + 整理用全文读取）、`organize.js`（整理模型选择/目录）、`organize-jobs.js`（会话外整理作业 + 自动调度）、`archive.js`、`data-jobs.js`、`migrate.js`、`home.js` 等 |
| `test/` | `node --test`，166 条 |
| `scripts/` | `bench.mjs` / `compare.mjs` / `migrate-from-evolver.mjs` / `seed-demo.mjs`（合成测试库） |

## 命令

```bash
npm test                                # 166 条
node --check client.js                  # 浏览器半边单文件语法
node --check src/harness/store.js       # 单文件语法
node scripts/bench.mjs 500              # 500 文件基准
node scripts/migrate-from-evolver.mjs   # 老库迁移，默认 dry-run
node scripts/seed-demo.mjs --count 2200 # 造合成测试库（全部带 测试/批量，--reset 清掉）
```

宿主改动不进桌面实例：桌面 GUI 跑的是启动时加载的宿主代码，`client.js` 刷新面板即可，`index.js`/`src/**` 要重启才生效。验证宿主与面板的完整链路时，用临时 profile + 覆盖层起一个隔离实例（数据目录指向复制出来的库）：

```bash
dsh --profile ziyan --patch .scratch/verify-patch.yml --no-open --port 0   # stdout 打印带 token 的 URL
```

（`.scratch/verify-patch.yml` 是本地验证用的覆盖层，已 gitignore；不要把它复制进发布的包。）

## 约束（动手前先看）

- **没有构建步骤**：`package.json` 只有 `test` 一个脚本。
- **宿主改了要重启 DSH**（`index.js` + `src/**`）；`client.js` 是浏览器半边，刷新面板即可。
- **边车是事实，数据库是索引**：`files/<id>/meta.json` 为准，`system/ziyan.db` 随时可删、可重建；写序是 字节 → 边车 → DB，DB 失败不影响事实。
- **新增面板接口要三处一致**：`src/remote.js` 的 `ENDPOINTS`、`createZiyanHandler` 的 switch、`client.js` 的 `call()`；`test/contract.test.mjs` 静态守这一条（当前 26 个端点）。
- **列表分页在 SQL 里算**：`IndexDatabase.page()` 用同一条 WHERE 既做 `COUNT(*)` 又做 `LIMIT/OFFSET`。别退回「取固定窗口再内存过滤」——那会把窗口大小伪装成库的总数，翻页到窗口末尾就断（`test/paging.test.mjs` 守）。
- **描述是唯一检索面**：不索引正文，所以写入要查重，描述必须说清"这个文件回答什么问题"。
- **标签必填、链接可悬空**：至少一个标签才能写入；删除不批量改写别人的边车，查询时把悬空目标标 `missing`。
- **项目 harness 的分工**：每个项目都要有 `harness/`（`harness.md` 总览 + workflow/experience/tool/resources 四层）。只在本仓库成立的判断/约定/命令/流程用 `project_harness_*` 写进 harness；跨项目可复用的资源才 `project_harness_promote` 落进自衍中枢库（description/tags 必填，标签建议 `来源/harness`，links 关联库内相关文件）。项目 `AGENTS.md` 里由工具维护一对 `<!-- ziyan:harness:begin/end -->` 受管块，**块外一个字节都不动**；手写 AGENTS.md 的项目可以直接 `catalog({init:true})`，追加块而不是覆盖。工具名必须保留 `project_` 前缀：旧 evolver 仍可能安装并占用 `harness_*`，DSH 工具名在同一层唯一。
- **整理作业只在会话外跑，默认不花钱**：自动整理开关默认关；开启后由宿主 60 秒心跳按「会话空闲 N 分钟 / 每天 H 点」触发，台账落 `system/organize-ledger.json`。自动作业固定 `dryRun:false`、`allowRemove:false`；同一时刻只允许一个作业；测试一律注入假 `llm`，不得真实调用外部模型。结果计数由宿主 Proxy 拦截 store 写方法得到，不信模型自报。
- **不注入运行时索引**：宿主只注册一段静止的 `systemPrompt.section`（`dsh-ziyan:discipline`），**没有** `systemPrompt.context`、没有每日文件索引快照、没有 `system/index.json`、没有注入预算。agent 需要文件时自己 `file_query` 按描述/标签/links 搜；项目依赖/约定/命令/流程进项目 harness，跨项目知识才落自衍中枢库。不要再引入 context/快照/预算机制。
- **面板没有手动维护入口**：`rebuild` 端点已删除，注入页不再有「重建快照」，自衍页不再有「重建索引/重新读取/演练模式/会话勾选/问题网格」。数据库需要时自建、整理交给 agent 作业——不要把这些按钮加回来。
- **Windows 平台差异**：`chmod` 只切只读位，`executable` 退化为按扩展名判断；POSIX 权限位（`0o700/0o600`）的断言必须加平台守卫，否则测试会在 Windows 上误红。
- **改源码只用 read/write/edit 工具，或写 `.mjs` 用 node 跑**：PowerShell 的 `Get-Content`/`Set-Content` 往返在 GBK 控制台会静默损坏 UTF-8 中文（历史上毁过 `client.js` 140 行）。PowerShell 只用来跑命令、看路径、起进程。
