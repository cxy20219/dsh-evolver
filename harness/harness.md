# 自衍中枢（dsh-ziyan）项目总览

DSH 插件：**一切皆文件**的知识库。每个文件是一等实体（唯一 id + 一句话描述 + 自由层级标签 + 链接），元数据落在边车 `meta.json`，SQLite 只维护「描述索引 + 关系」，正文由 agent 自己读。

仓库根就是包根（`package.json` = `dsh-ziyan`）。旧插件 `dsh-evolver` 1.0.0 已归档在 `archive/v1.0.0` 分支并从本仓库移除；`master` 只维护自衍中枢。注意：本机 desktop profile 里仍可能装着旧 evolver，它与 ziyan 并存（工具名前缀因此要区分）。

## 先读什么

| 想知道 | 读 |
|---|---|
| 插件是什么、怎么用、数据目录长什么样 | `README.md` |
| 为什么这样设计、每条契约的取舍、分阶段落地记录与待定决策 | `DESIGN.md` |

## 布局

| 路径 | 内容 |
|---|---|
| `index.js` | 宿主装配：store、**4 个工具**（`file_search`/`file_read`/`file_write`/`file_edit`，一套动词同时服务文件库与项目 harness）、一段静态注入（无运行时索引）、27 个面板接口、整理引擎与自动调度 |
| `client.js` | 浏览器半边，单文件 `window.__ModuleLoader__.load` 工厂，无构建；七个页签 + 图谱 canvas 引擎 |
| `src/harness/` | 项目 harness 资源系统（库与校验底座，不再有独立工具）：`sidecar.js`（资源描述边车）、`store.js`（四层目录 + 描述边车 + AGENTS.md 全量索引生成 + 目录收编）、`write.js`（内容+边车+索引+校验+回滚 一体化写入）、`validate.js`（结构/索引一致/引用与文档契约/Python 语法） |
| `src/remote/` | 面板接口：`index.js` 的 `HANDLERS` 表 → `ENDPOINTS` 派生 + dispatch；`files.js`/`panel.js`/`organize.js`/`data.js` 四个域模块；`src/remote.js` 是薄 re-export（保持旧 import 路径） |
| `src/organize/` | 会话外整理引擎：`index.js` 组装 `createOrganizer`，`budget.js`（预算/记账）、`prompts.js`、`loop.js`（工具循环）、`jobs-store.js`（作业落盘/台账）、`scheduler.js`（自动调度）、`executor.js`（作业执行/状态）；`src/organize-jobs.js` 是薄 re-export |
| `src/json.js` | `render`/`OBJECT_OUTPUT`/`sanitize`/`summaryOf`，四个工具共用 |
| `src/` | `store.js`（边车 + 索引）、`db.js`（SQLite schema 3 + FTS rowid/部分索引）、`ids.js`（增量短 id）、`day.js`、`preferences.js`、`tools.js`、`prompt.js`、`sessions.js`、`organize.js`（模型选择/目录）、`archive.js`、`data-jobs.js`、`home.js` 等 |
| `test/` | `node --test`（全量，213 条） |
| `scripts/` | `bench.mjs` / `seed-demo.mjs`（合成测试库）/ `scale.mjs`（10k/100k 真实 FS + 1M 合成规模基准）/ `stress.mjs`（并发/崩溃/泄漏压测） |
| `harness/` | 本项目的长期记忆：流程、经验、脚本、资料；项目根的 `AGENTS.md` 是它生成的索引（见下） |

## 命令

```bash
npm test                                # 全部测试（213 条）
node harness/tool/verify-repo.mjs       # 自检闸门：语法 + harness 结构/索引 + 全量测试
node --check client.js                  # 浏览器半边单文件语法
node scripts/bench.mjs 500              # 500 文件基准
node scripts/seed-demo.mjs --count 2200 # 造合成测试库（全部带 测试/批量，--reset 清掉）
node scripts/scale.mjs --tier 10k --reset   # 10k 真实 FS 规模基准（约 3 分钟）
node scripts/scale.mjs --tier 100k --reset  # 100k 真实 FS（约 8 分钟）
node scripts/scale.mjs --tier 1m --reset    # 1M DB 级合成（约 12 分钟）
node scripts/stress.mjs --tier 100k         # 100k 并发/崩溃/泄漏压测
```

宿主改动不进桌面实例：桌面 GUI 跑的是启动时加载的宿主代码，`client.js` 刷新面板即可，`index.js`/`src/**` 要重启才生效。验证宿主与面板的完整链路时，用临时 profile + 覆盖层起一个隔离实例（数据目录指向复制出来的库）：

```bash
dsh --profile ziyan --patch .scratch/verify-patch.yml --no-open --port 0   # stdout 打印带 token 的 URL
```

（`.scratch/verify-patch.yml` 是本地验证用的覆盖层，已 gitignore；不要把它复制进发布的包。）

## 关键约束（动手前先看）

- **没有构建步骤**：`package.json` 只有 `test` 一个脚本。
- **宿主改了要重启 DSH**（`index.js` + `src/**`）；`client.js` 是浏览器半边，刷新面板即可。
- **边车是事实，数据库是索引**：`files/<id>/meta.json` 为准，`system/ziyan.db` 随时可删、可重建；写序是 字节 → 边车 → DB，DB 失败不影响事实。
- **新增面板接口要两处一致**：`src/remote/index.js` 的 `HANDLERS` 表（`ENDPOINTS` 由它派生）与 `client.js` 的 `call()`；`test/contract.test.mjs` 静态守这一条（当前 27 个端点）。`src/remote.js`/`src/organize-jobs.js` 只是薄 re-export，不要把实现搬回去。
- **列表分页在 SQL 里算**：`IndexDatabase.page()` 用同一条 WHERE 既做 `COUNT(*)` 又做 `LIMIT/OFFSET`，且是两段式（先 id 再批量取行）；部分索引 `files_live_updated`/`files_archived_updated` 是分页热路径，删了或退回「取固定窗口再内存过滤」都会让深翻页退化到秒级（`test/paging.test.mjs` 守）。
- **FTS 必须用 rowid**：`files_fts.id` 是 UNINDEXED，按 id 删除会全表扫描（单写 O(N)、rebuild O(N²)，1M 冷建曾外推 ~60h）。写/删按 `rowid`（= files.rowid），rebuild 走一条 `INSERT ... SELECT`；`test/store.test.mjs` 守 rowid 一致。
- **派生冗余列由写路径维护**：`tags.archived`、`files.suffix/created_day`、`linked_ids` 是为 100k/1M 聚合准备的覆盖索引数据，写文件时必须同步更新；schema 版本（`INDEX_SCHEMA`）变更 = 不匹配的旧库会被隔离并从边车重建，不需要写迁移代码。
- **不注入运行时索引**：宿主只注册一段静止的 `systemPrompt.section`（`dsh-ziyan:discipline`），**没有** `systemPrompt.context`、没有每日文件索引快照、没有 `system/index.json`、没有注入预算。agent 需要文件时自己 `file_search` 按描述/标签/links 搜；项目依赖/约定/命令/流程进项目 harness，跨项目知识才落自衍中枢库。不要再引入 context/快照/预算机制。
- **注入规模按 token 估算显示**：`src/tokens.js` 的口径是 CJK/全角约 1 字 1 tok、其余约 4 字符 1 tok（`client.js` 内有同口径 `estimateTokens` 给偏好草稿实时估算）。静态段、整理提示词、工具 schema、偏好草稿都显示 token 估算，不再回字节数；`injection` 端点返回 `staticTokens`，`organize-prompts` 每段返回 `tokens`，`describeTools` 每个工具带 `tokens`。这是预算展示，不是计费数字，不要把它当真 tokenizer。
- **静态注入按全局 AGENTS.md 的风格写**：`src/prompt.js` 只有一段 `# 自衍中枢`，下分 `## 记忆` / `## 沉淀`，短 bullet、一条一个规则；不重复工具描述里的参数，也不重复全局 AGENTS.md 的通用原则（思考/执行/交付）。两个动作要写成**带工具名的可执行指令**：`## 记忆` 的「开工前先搜」（`file_search` → `file_read`）、`## 沉淀` 的「每轮答复前问一句…值得就用 `file_write` 沉淀」（项目内写 `harness/`、跨项目复制进库、不值得就跳过）。改静态段要同步 `test/plugin.test.mjs` 与 `test/remote.test.mjs` 的断言和 README/DESIGN 的段名引用。
- **派生缓存要带 SQLite data_version**：`FileStore.stats()` / `tagCounts()` 的缓存 key 是 `db.version + db.dataVersion()`。`db.version` 只统计本连接写入；外部维护脚本、第二实例写同一个数据目录时，靠 `PRAGMA data_version`（别的连接提交时递增）失效。新增缓存不要只 key 在 `db.version` 上。
- **全局偏好统一存数据目录**：`~/.dsh/AGENTS.md` 只是 DSH 的注入入口，权威文件是 `<dataDir>/system/AGENTS.md`；`readPreferences`/`writePreferences` 负责把入口软链到权威文件（无建链权限时退化为两边双写，**双写时入口必须与权威文件同内容**——入口就是 DSH 真正注入的那份）。首次接管迁移现有全文、只删旧 ziyan 段标记行、旧目标不删；面板编辑的是**整份 AGENTS.md**，不再有受管段概念。读失败必须标 `readable:false` 并禁用保存，不能把空串写回。
- **工具面只有四个**：`file_search` / `file_read` / `file_write` / `file_edit`，一套动词同时服务文件库与项目 harness。不要再加回分业务工具（`file_import`、`file_link`、`file_index`、`file_archive`、`file_remove`、`project_harness_*` 已并入四个动词）；新能力优先扩展现有 `target`/`meta` 语义，而不是新增工具或顶层参数。工具名保留 `file_` 前缀：DSH 内置已有 `read`/`write`/`edit`/`search`，旧 evolver 还占着 `harness_*`，DSH 工具名同层唯一。
- **工具描述是模型唯一的能力面**：能力写进实现还不够，必须在工具描述里写出「目标 × 能力」矩阵（例如 old+new 对库文件、项目文件、harness 资源都适用）；描述没露出的能力等于不存在，模型会退回整篇重写或绕道 bash/python。报错文案要给下一步动作，不要只陈述限制——只说限制的那句会把模型推去自创旁路，而旁路必然破坏边车与索引契约。
- **安全边界（审计后新增）**：项目路径操作只允许会话 cwd 内（`harness/...` 锚定项目根，`isWithin` realpath 判定），越界拒绝；`file_write({from})` 绝对路径导入允许读宿主文件但先 stat/realpath/isFile/大小预检，拒绝目录/设备/管道/越界符号链接（H-2 OOM 防护）；`meta.json` 保留名必须拒绝（`isReservedName`）；导入归档的 settings 只采纳 limits，`organize.auto` 强制关、`organize.model` 用本机；harness 写 AGENTS.md 走路径锁 + 快照冲突重读，回滚只在文件仍是本次写入内容时执行。
- **清理纪律**：不为旧 evolver 兼容保留代码（迁移/对比工具已删，`legacy_id` 已删）；删死代码前用 grep/测试证据，不删 `scan`/`rebuild`（DB 可重建是核心契约）。
- **描述是唯一检索面**：不索引正文，所以写入要查重；描述的内容要求见下方「两层知识沉淀」。
- **标签必填、链接可悬空**：至少一个标签才能写入；删除不批量改写别人的边车，查询时把悬空目标标 `missing`。
- **两层知识沉淀**：先完成项目/任务，再沉淀——只在本仓库成立的结论用 `file_write` 写到 `harness/` 路径（宿主自动建骨架、写描述边车、重建 AGENTS.md 索引并校验）；跨项目可复用的踩坑经验、工作流、脚本用 `file_write({from:"harness/...", meta:{description,tags}})` 复制进自衍文件库。**描述是检索面**：harness 资源的 `meta.description` 与库文件的 `description` 都必须写清「它是什么」+「以后哪些场景、任务、问题会用到它」；短且无场景词的描述会收到非阻断 advice。
- **项目 harness 的分工**：每个项目都要有 `harness/`（`harness.md` 总览 + workflow/experience/tool/resources 四层）。只在本仓库成立的判断/约定/命令/流程用 `file_write` 写进 harness；跨项目可复用的资源才用 `file_write({from:...})` 复制进自衍中枢库（meta.description/tags 必填，标签建议 `来源/harness`，links 关联库内相关文件）。
- **项目 AGENTS.md 就是 harness 索引，不许手写**：它整份由插件按 `harness/` 生成——固定两行头 + 每个资源一条（`- [标题](harness/…路径)：描述`），**全量收录**（含脚本、模板等非文档资源），顺序为总览 → workflow → experience → tool → resources，老索引里的顺序保留、新资源追加到本层末尾。手写内容不能进 AGENTS.md：插件识别出它是手写文档时，先备份成 `AGENTS.legacy-<hash>.md`，再按目录重建并提示把内容搬进 `harness/harness.md`；直接 `file_write`/`file_edit` 项目根 AGENTS.md 会被拒绝。
- **harness 资源的描述在边车里**：每个资源旁边有同名 `<文件>.meta.json`（`{schema,title,description}`），边车是事实、索引是派生物；写 `harness/...` 时 `meta.description` 必填（与库同一套契约：非占位词、默认 ≤160 字），`meta.title` 可选。边车文件本身不进索引。旧项目的裸索引在首次写入时被接管，标题与描述搬进边车；旧目录（`scripts/`、`references/`、`assets/`）自动迁到 `tool/`、`resources/` 并重写文档里的路径。
- **harness 校验的分工**：结构（目录/索引与目录一致/索引与边车）、引用完整性（文档提到的 harness 路径必须存在）、Python 语法是**错误**（写入回滚）；描述缺失、描述质量、以及「工具/资源没有被 workflow|experience 文档覆盖」是**警告**（不阻断，因为描述已经进了索引）。
- **整理作业只在会话外跑，默认不花钱**：自动整理开关默认关；开启后由宿主 60 秒心跳按「会话空闲 N 分钟 / 每天 H 点」触发，台账落 `system/organize-ledger.json`。自动作业固定 `dryRun:false`、`allowRemove:false`；同一时刻只允许一个作业；测试一律注入假 `llm`，不得真实调用外部模型。结果计数由宿主 Proxy 拦截 store 写方法得到，不信模型自报。
- **面板没有手动维护入口**：`rebuild` 端点已删除，注入页不再有「重建快照」，自衍页不再有「重建索引/重新读取/演练模式/会话勾选/问题网格」。数据库需要时自建、整理交给 agent 作业——不要把这些按钮加回来。
- **Windows 平台差异**：`chmod` 只切只读位，`executable` 退化为按扩展名判断；POSIX 权限位（`0o700/0o600`）的断言必须加平台守卫，否则测试会在 Windows 上误红。
- **改源码只用 read/write/edit 工具，或写 `.mjs` 用 node 跑**：PowerShell 的 `Get-Content`/`Set-Content` 往返在 GBK 控制台会静默损坏 UTF-8 中文（历史上毁过 `client.js` 140 行）。PowerShell 只用来跑命令、看路径、起进程。

## 资源分层

- **workflow**：稳定可执行的流程（做什么、适用条件、怎么验证）。
- **experience**：可复用的判断经验（现象、根因、做法、边界）。
- **tool**：可重复执行的东西——脚本、可执行文件、CLI 都算。
- **resources**：工具要读的东西——外部规范、长背景、模板、示例输入、静态资源。

每条资源旁边有一个同名边车 `<文件名>.meta.json`，里面写清两件事：它是什么（做法/结论），以及以后哪些场景、任务、问题会用到它。项目根的 `AGENTS.md` 就是按这些边车生成的索引，不许手写。跨项目可复用的，再用 `file_write({from:..., meta:{description,tags}})` 落进自衍文件库。

本项目已有的资源：

- `harness/workflow/harness-resource-write.md`：往 harness 写资源并验证索引的完整规程与陷阱。
- `harness/experience/parallel-sessions-one-repo.md`：同一仓库并行会话的认知分叉与隔离做法。
- `harness/experience/contract-change-by-options.md`：契约与提示词改动先给选项再动手的协作规矩。
- `harness/experience/preferences-copy-mode.md`：偏好的双写模式——入口与权威文件必须同内容，含修法与测试缝。
- `harness/tool/verify-repo.mjs`：一条命令跑完语法、harness 结构与索引一致性、全量测试的自检闸门。
