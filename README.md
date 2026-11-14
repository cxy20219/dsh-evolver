# 自衍中枢 · dsh-ziyan

> 全面改名：包名 `dsh-ziyan`、客户端 id `dsh-ziyan`、API `/api/ziyan`、数据目录 `~/.dsh/ziyan`、指针 `~/.dsh/ziyan.home.json`。旧目录 `~/.dsh/yuanshi` 只作为备份保留，不再读取。

一个「一切皆文件」的知识库插件：每个文件有唯一 id、一句话描述、自由层级标签，文件之间可以互相链接；插件只维护描述索引与关系，正文由 agent 自己读、解析、执行。

## 状态

- **Host 半边已实现**：数据目录、文件存储、SQLite 索引、描述检索、图遍历、12 个工具（8 个 `file_*` + 4 个 `project_harness_*`）、一段静态注入、设置、日志、26 个面板接口、会话外整理引擎与自动调度。**运行时不再注入文件索引**：agent 需要文件时用 `file_query` 自己搜。
- **面板（浏览器半边）已实现**：侧边栏「自衍中枢」，概览 / 图谱 / 文件 / 注入 / 自衍 / 设置 / 日志七个页签；可搜索、编辑、上传、新建、归档、删除、看图；自衍页可选整理模型与思考强度、开关自动整理、看作业结果。
- 数据目录默认 `~/.dsh/ziyan`，一个根目录下分两棵子树：`files/` 只放文件本体，`system/` 放索引与系统数据。

```
~/.dsh/ziyan/
  files/<file-id>/<name>       文件本体
  files/<file-id>/meta.json    边车元数据（事实来源）
  system/ziyan.db            SQLite 索引（可删、可重建）
  system/settings.json         设置
  system/organize-jobs.json    整理作业记录（含自动调度）
  system/organize-ledger.json  自动整理台账（哪些会话已整理到哪个版本）
  system/logs/plugin.log       插件日志
  system/trash/<时间戳>-<id>/  删除回收站
```

## 规则

- 每个文件：`id` + `description` + 至少一个 `tags`；`tags` 是自由层级路径，例如 `工作/项目/自衍中枢`、`类型/脚本`。
- 搜索只命中 name / description / tags，不索引正文，也没有 snippet。
- `links` 是出边，目标可以是任何类型的文件；反链实时计算；死链/自链写时丢弃并进 `warnings`。
- 脚本按扩展名/shebang 设 `0700`，`file_read` 返回 `path` + `executable`；插件不执行脚本。
- **项目 harness 与库的分工**：每个项目要有 `harness/` 资源系统（workflow / experience / tool / resources 四层 + 项目 `AGENTS.md` 里的受管索引块），项目本地知识用 `project_harness_*` 写进 harness；跨项目可复用的资源用 `project_harness_promote` 落进自衍中枢库检索。工具用 `project_` 前缀是为了与仍可能安装的旧 evolver（`harness_*`）并存。

## 工具与面板

Agent 工具：`file_query`、`file_read`、`file_write`、`file_import`、`file_link`、`file_index`、`file_archive`、`file_remove`，以及项目 harness 的 `project_harness_catalog`、`project_harness_write`、`project_harness_validate`、`project_harness_promote`。

面板通过 `/api/ziyan/*` 的 26 个接口工作：文件 7 个、概览/图谱/设置读写/日志 5 个、注入 2 个（`injection`、`tools`）、偏好 2 个（`preferences`、`preferences-save`）、自衍与整理 6 个（`digest` + `organize-*` 5 个）、数据 4 个。浏览器只发 id，不发文件路径；上传、预览和归档都有大小上限。

### 面板

顶层页签固定为 **概览 / 图谱 / 文件 / 注入 / 自衍 / 设置 / 日志**。

- **概览**：记录热力图、文件/标签/天数三项统计，以及按文件后缀区分的类型面积矩阵。整页按视口高度铺满：热力图与统计保持自然高度，矩阵吃掉剩下的空间（容器变化时重算 treemap，不会拉伸变形）。点矩阵里任意一块，跳到「文件」页并把「类型」下拉切到那个后缀。标签统计的是**不同标签路径数**。
- **图谱**：三个子标签。「星球图」把全部文件铺在可旋转的球面上，按标签根聚团；「关系图」是同一批节点的力导向网状布局，可平移、Shift + 拖拽旋转、缩放；「标签图」是标签层级，点标签按它筛选文件。前两个是 canvas：节点按链接度数定大小与质量，**占位碰撞保证同一处不叠两个点**，小节点被大节点吸引、无关节点互相排斥，簇由链接自然形成；连线是绿色的、在圆点边缘截断；悬停某个节点时它的边点亮并画出方向箭头，节点环和名字也变绿；点节点打开文件。
- **文件**：搜索描述/名字/标签、标签前缀、类型、显示归档。「类型」下拉就是库里的后缀清单（`.md · 740` 这种带计数），选它即筛选，与关键词、标签可叠加。列表占满整页不滚动，每页条数按列表高度算，底部翻页；点一行从右侧滑出详情抽屉（改描述/标签/出链/正文，保存、归档、删除），Esc 或「关闭」收起；上传、新建也在这一页。
- **注入**：三个子标签。「提示词」只展示插件注入的**一段静态系统纪律**（文件纪律 + 主动性协议 + `[项目 harness]`，字节固定、每轮都带），并说明运行时不再注入文件索引——需要文件时用 `file_query` 按描述/标签/links 自己搜；项目依赖与约定由项目 harness 管理。没有运行时索引、快照与注入预算。「工具」列出插件向 DSH 注册的 12 个工具（8 个 `file_*` + 4 个 `project_harness_*`）：分类（只读/写入/危险）、一句话功能、参数（可展开）；数据来自工具定义本身，不会与工具面漂移。「偏好」编辑写进 DSH 全局 `~/.dsh/AGENTS.md` 的那一段，由 AGENTS.md 加载器在每次会话开始时注入；插件只维护自己那对标记之间的内容，文件里其他规则原样保留，`AGENTS.md` 若是软链则写穿到目标、链接本身不动。
- **自衍**：整理台，形态与旧 evolver 的整理页一致——三张卡：整理模型（服务商 / 模型 / 思考强度，默认跟随聊天）、会话整理（自动开关 + 空闲分钟数 + 立即整理）、文件整理（自动开关 + 每天几点 + 立即整理），下面是最多 5 条最近作业（状态、结果计数、失败原因、运行中可取消，日志折叠）。整理作业**在会话外**由宿主用选定模型跑工具循环，自动开关默认关；打开后宿主按空闲/每日自动触发，台账在 `system/organize-ledger.json`。页面上**没有**重建索引、重建快照、重新读取、演练模式等手动维护按钮：索引需要时自动重建，整理交给 agent 作业。
- **设置**：描述上限、单文件上限、读取上限；保存后立即生效。
- **日志**：`system/logs/plugin.log` 尾部。

## 数据目录与备份

默认数据目录 `~/.dsh/ziyan`。设置页分「常规 / 数据」两个子标签；「数据」子页可以：

- **复制当前库到新目录**：只复制 `files/` 与 `system/settings.json`，DB、索引、日志、回收站由下次启动重建；目标目录必须不存在。
- **使用已有自衍中枢库**：目标必须已经有 `files/`，不复制、不覆盖。
- **导入 `.tar.gz`**：解压到新目录，校验后切换；旧库保留。旧包名时期导出的归档也兼容。
- **导出 `.tar.gz`**：包含 `files/` 与设置，不包含 DB、索引、日志、回收站；浏览器直接下载。

目录切换都写一个指针 `~/.dsh/ziyan.home.json`，**重启后生效**；当前会话继续读旧库。指针是唯一放在数据目录外的文件，内容只有一个绝对路径；删掉它即可回到组合配置/默认目录。

导出包限制：归档 ≤32 MB、解压 ≤256 MB、单文件 ≤64 MB；导入会拒绝绝对路径、`..`、反斜杠、符号链接和非普通 tar 条目。

## 从 evolver 1.0 迁移

```bash
node scripts/migrate-from-evolver.mjs                 # 预演，不写盘
node scripts/migrate-from-evolver.mjs --apply         # 正式写入 ~/.dsh/ziyan
node scripts/migrate-from-evolver.mjs --from ~/.dsh/evolver --to ~/.dsh/ziyan --apply
```

- 默认 dry-run；`--apply` 才写。源目录只读，不会改动老库。
- 读 `cards.jsonl` 的最后一条记录，跳过删除墓碑；旧 `card-` id 存进 `legacy_id`，重复执行不会重复建卡。
- 附件变成独立文件实体，双向链接到卡片；卡片正文里的 `knowledge/resources/...` 改写成新的 `files/<id>/<name>`。
- 旧归档标签（`…/归档`）转成 `archived` 标志；删除标记不迁入。
- 本次真实库结果：**136 卡（135 活跃 + 1 归档）+ 10 附件**，145 个活跃文件、128 条链接；预演/正式写入/重复执行都验证过。

## 与 evolver 1.0.0 的量化对比

```bash
node scripts/compare.mjs       # 复制老库、迁移、分场景对比
```

结果写到 [COMPARISON.md](COMPARISON.md) 和 `COMPARISON.json`。老库路径可用 `OLD_EVOLVER_ROOT` / `OLD_EVOLVER_DATA` 覆盖。最近一次（135 卡 / 10 附件，Node 26）：

| 指标 | evolver 1.0.0 | 自衍中枢 |
| --- | --- | --- |
| 注入（静态 + 12 个候选） | 3450 B | **3041 B** |
| 查询返回体（平均，带正文/不带正文） | 5311 B | **2890 B** |
| 重开（索引已存在） | 7.3 ms | **0.5 ms** |
| 写 100 次 | **12.6 ms** | 70.7 ms |
| 存储 | **361 KB / 18 文件** | 683 KB / 292 文件 |
| 描述基线 top5 重合 | — | 19/32（差额含排序与正文召回） |

取舍很清楚：自衍中枢注入更小、返回更省、重开更快、附件成为图节点；写更慢、存储更大、正文词召回更少。分析见 [COMPARISON.md](COMPARISON.md)。

## 开发

```bash
npm test                       # 166 条
node scripts/bench.mjs 500     # 500 文件基准
node scripts/compare.mjs       # 与 evolver 1.0.0 分场景对比
node scripts/migrate-from-evolver.mjs  # 老库迁移，默认预演
```

安装到目标 profile（先不要动 desktop profile）：

```bash
dsh plugin --profile <profile> add /path/to/dsh-ziyan
```

装完重启 DSH；左侧边栏会出现「自衍中枢」。

设计稿与决策记录见 [DESIGN.md](DESIGN.md)。
