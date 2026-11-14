# 自衍中枢 · 设计稿

> 全面改名：包名 `dsh-ziyan`、客户端 id `dsh-ziyan`、接口 `/api/ziyan`、数据目录 `~/.dsh/ziyan`、指针 `~/.dsh/ziyan.home.json`。旧目录 `~/.dsh/yuanshi` 只保留为备份。

> 一句话：**一切皆文件**。每个文件是一等实体（唯一 id + 一句话描述 + 自由层级标签 + 链接），内容可以是任意类型；元数据落在边车，SQLite 只维护「描述索引 + 关系」，正文由 agent 自己去读、去解析、去执行。

状态：研究原型（worktree `research-data-model`）。旧插件 `dsh-evolver` 1.0.0 已归档在 `v1.0.0`，本包是并存的新包，验证后再决定替换根包还是独立发布。

## 1. 原则

1. **文件是唯一实体**，没有卡片/附件/页的层级。文本、脚本、图片、Word、PDF、压缩包都是同一种东西。
2. **描述是唯一的检索面**。插件不索引正文；搜索命中描述（以及名字、标签），然后 agent 读文件、理解内容、决定下一步。二进制文件没有正文可读，描述就是它全部的可检索信息。
3. **标签是必填的分类面**。每个文件至少一个标签；标签是自由层级的路径（`工作/项目/自衍中枢`、`类型/脚本`），没有固定根、没有固定深度，可以任意组合多个。标签用于过滤、摘要和检索，不承担主结构。
4. **id 稳定，名字可变**。链接只指向 id；文件名只用于显示和磁盘可读性，改名不断链。
5. **边车是事实，数据库是索引**。`meta.json` + 文件字节是真相；SQLite 可随时删掉重建。这条沿用老库“索引必须生成”的结论。
6. **链接可以悬空**。删除一个文件不批量改写别人的边车；查询时把悬空目标标成 `missing`，整理时再清。导入、前向引用都靠这条。
7. **任何文件都可以链接任何文件，也可以被任何文件链接**。出边存在文件自己的 `links` 里，反链实时计算；不存重复的反链字段。
8. **注入只给索引，不给正文**。12 个文件（枢纽 + 最近）+ 一段结构摘要，每日快照；写文件不改变注入文本。
9. **插件不替 agent 理解内容**。Word/PDF 的正文、代码在做什么、文档之间语义是否相关，都由 agent 读文件后判断；插件只负责“这个文件是什么、和谁有关、能不能直接跑”。

## 2. 实体

```json
{
  "schema": 1,
  "id": "file-01M7...",
  "name": "design.md",
  "description": "一句话说明这个文件回答什么问题",
  "tags": ["工作/项目/自衍中枢", "类型/文档"],
  "links": ["file-01M7..."],
  "source": { "quote": "≤160 字原话", "session": "session-..." },
  "created": "2026-11-13T14:00:00.000Z",
  "updated": "2026-11-13T14:00:00.000Z",
  "mime": "text/markdown",
  "bytes": 1234,
  "sha256": "…",
  "archived": false
}
```

- `id`：`file-` + ULID；创建时间从前 10 位派生，不单独存。
- `name`：净化后的单段文件名；允许同 id 目录内改名，不全局唯一。
- `description`：必填，≤200 字，单行；空/占位词（暂无、TODO、待补）拒绝。**它是检索的全部依据**，写不好就等于这个文件不存在。
- `tags`：**必填，至少一个**；自由层级路径，任意深度、任意组合；没有固定根。`#` 前缀可写，空段（`a//b`）会折叠，空格在段内转成 `-`。父标签过滤自动包含子标签。
- `links`：出边，存完整 file id；目标可以是任何类型的文件（文本/脚本/图片/PDF/二进制）；反链实时算；删除后悬空允许；自链和写时不存在的目标会被丢弃。
- `source`：可选出处；保留给以后的会话沉淀。
- `mime` / `bytes` / `sha256`：写入时算；类型由扩展名 + 内容嗅探决定。
- `archived`：生命周期是元数据，不占一个标签。
- `executable`：不落边车，由文件 mode 派生（脚本 0700，其他 0600）；`file_read` 返回真实值。

### 标签与链接契约

**标签**：

- 存储的是完整路径（`工作/项目/自衍中枢`），不展开祖先；过滤时 `工作` 会命中 `工作/项目/自衍中枢`，因为前缀匹配。
- 一个文件可以带多个不同根的标签，例如 `工作/项目/自衍中枢` + `类型/脚本` + `来源/会话`。
- 查询支持 `tag`（单路径）与 `tags`（数组，AND：必须同时命中每一条或其子路径）。
- 空标签、空数组、只有空段的标签都拒绝写入；标签是文件的必填分类面。

**链接**：

- 方向：A 的 `links` 里写 B，意思是 A 引用 B；B 不需要写反向字段，`file_read(B).neighbors.in` 会实时给出 A。
- 目标类型不限：图片、脚本、PDF、数据文件都能互相引用。
- 自链丢弃；写入时目标不存在或不唯一则丢弃该边，并在结果的 `warnings` 里点名（不阻断整次写入）；目标删除后边保留，查询标 `missing`。
- 图遍历同时走出的边和反链，方向保留；`graph(ids, {hops})` 用于“文档 → 说明 → 脚本”这类多跳导航。

## 3. 磁盘布局

```
~/.dsh/ziyan/                 ← 数据根目录（备份/迁移的单位）
  files/                        ← 只放文件本体与边车
    file-01M.../
      design.md                 ← 原始字节，永不改写元数据
      meta.json                 ← 唯一事实来源
  system/                       ← 索引与系统数据，不和文件混放
    ziyan.db                  ← SQLite 索引（可删、可重建）
    index.json                  ← 注入快照（每日）
    settings.json               ← 设置
    logs/plugin.log
    trash/<时间戳>-<id>/        ← 删除先移动到这里
```

**一个根目录、两棵子树**：`files/` 只放内容，`system/` 放 DB、快照、设置、日志、回收站；没有第二个配置文件。备份/迁移时整根目录一起走。

- 一个实体一个目录：以后要加版本、缩略图、抽取文本，都有地方放。
- `meta.json` 原子写（临时名 + rename）；文件字节同样原子写。
- 写序：字节 → 边车 → DB。DB 失败不影响事实，下次打开/重建恢复。

## 4. 数据库（SQLite，`node:sqlite`，零依赖）

运行时已验证：桌面端 Electron 44.7 / Node 24.21 自带 `node:sqlite`，FTS5 可用。索引 schema 版本 2（没有 body 列）。

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE files (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
  mime TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  created TEXT NOT NULL, updated TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  legacy_id TEXT
);
CREATE TABLE links (from_id TEXT NOT NULL, to_id TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
CREATE INDEX links_to ON links(to_id);
CREATE TABLE tags  (file_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (file_id, tag));
CREATE INDEX tags_tag ON tags(tag);
CREATE VIRTUAL TABLE files_fts USING fts5(
  id UNINDEXED, name, description, tokenize='unicode61'
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- schema_version, built_at
```

- 没有外键：`links` 要允许悬空；删除只删本体。
- `files_fts` 只存 name + description（+ 折叠进去的 tags）的**预分词**文本，不存正文；正文在磁盘，由 agent 读。
- 索引重建：扫 `files/*/meta.json`，重灌四张表；不读正文，所以重建与库大小基本无关。

## 5. 检索

1. 查询分词：拉丁词小写 + 中文连续串切成 bigram（同老库 `tokenize`）。
2. FTS：`"词1" OR "词2" ...`，`bm25(files_fts, 0, 6, 10)`（name 6、description 10）。
3. 候选 50 条，按 `归一化 bm25 × 0.8 + 新近度 × 0.15 + 度数 × 0.05` 重排。
4. 返回 `id、short、name、description、mime、bytes、degree、score`。**没有 snippet**：不索引正文，片段也就没有来源；命中后由 agent `file_read` 看内容。
5. 二进制文件与文本文件走同一条路：只能按 name/description 命中。

为什么不用 trigram：实测 FTS5 trigram 对 2 字中文查询 0 命中（“插件”“接口”都查不到），中文必须 bigram。为什么不做正文索引/向量：用户决策——描述就是索引，其余交给 agent；这也让检索成本与文件大小脱钩，Word/PDF 不需要抽取管线。

**边界**：如果 Word 的正文里有“青鸟”，而描述里没有，搜索不会命中它。这是有意的取舍；召回预算等于描述质量。整理器（P5）要把“描述是否还准确”当成主要工作。

## 6. 链接与图

- 出边在实体 `links`；反链 `SELECT from_id FROM links WHERE to_id = ?`。
- 度数 = 入 + 出；注入与图排序用它。
- `file_read` 返回 `neighbors`：目标存在给 `{id, name, description, mime}`，不存在给 `{id, missing: true}`。
- `graph(ids, {hops:1-3, limit})`：从命中文件做有界 BFS，返回 `{nodes, edges}`，边走双向、方向保留。场景“搜索 → Word → markdown → 脚本”用 `hops:2` 一次拿到。
- 图只画显式链接；没有语义推断。关系必须由 agent/面板写进 `links`，整理器可以提示“这张文档提到脚本但没链接”。
- 未来可选：类型化边（`uses`/`derived_from`）、内联 `[[file-id]]` 自动同步到 links。
- **可执行**：脚本扩展名或 shebang → 写入时 `chmod 0700`；`file_read` 返回 `executable: true` 与绝对 `path`，agent 用 bash 直接跑。原生二进制不加执行位；面板只 reveal，不点击执行。

## 7. 注入

| 部分 | 载体 | 内容 |
|---|---|---|
| 静态纪律 + 主动性协议 | `systemPrompt.section` | 文件纪律、工具指针、什么时候写文件 |
| 运行时候选 | `systemPrompt.context` | 12 个文件（10 枢纽 + 2 最近，短 id｜描述）+ 结构摘要 |

- 摘要：`共 N 个文件（md 80 · py 10 · pdf 5…），M 条链接`；每日快照，写文件不改注入。
- 二进制/长文不注入正文；描述就是索引。
- 快照缺失/过期回退实时排序并按 store 版本记忆化（沿用老库结论）。

## 8. 工具面（已实现）

| 工具 | 作用 |
|---|---|
| `file_query` | 关键词/标签（单条或数组 AND）/类型/图检索；返回 id、名字、描述、标签、类型、大小、度数、分数；`graph:true` + `hops` 返回子图 |
| `file_read` | 元数据 + 文本（上限 256 KB，超出给 path）+ 绝对 path + executable + 邻居；悬空标 `missing` |
| `file_write` | 新建/更新文本文件；description + **至少一个 tags** + links；写前查重；被丢弃的链接进 warnings |
| `file_import` | 从宿主机路径导入任意文件（二进制/文本/Word/PDF），复制字节入库；带 description、**至少一个 tags**、links；死链进 warnings |
| `file_link` | 加/删链接，不重写正文 |
| `file_index` | 类型/标签/规模总览（对应老 `card_index`） |
| `file_archive` / `file_remove` | 归档 / 先移 trash 再删 |

工具名已用 `file_*`：8 个工具都接在 `index.js` 里；若以后确认与内置/其它插件重名，再统一换成 `ys_*`。

## 9. 面板

顶层页签：**概览 / 文件 / 图谱 / 设置 / 日志**（不再有“卡片/资源”两分）。

概览的标签卡片统计**不同标签路径数**（活跃文件去重），`tagAssignments` 保留标签指派总数；单标签引用次数仍由「常用标签」展示。

设置页分「常规 / 数据」两个子标签（复用主标签样式；两个子页都保持挂载，只切换 display，避免丢表单/文件选择）。「数据」子页：当前目录、下次启动目录、复制/attach 模式、导出 `.tar.gz`、导入为新库并切换。目录切换只写 `~/.dsh/ziyan.home.json` 指针，重启生效；导入/导出只操作 `files/` 与设置，DB/索引/日志/回收站不进归档。

- 文件页：搜索、按类型/标签过滤、显示归档、上传（必须填描述）、新建文本文件；列表显示名字 + 描述 + 类型 + 大小 + 度数 + 更新时间，100 条一页，可“加载更多”。
- 详情：按类型预览（md/文本/代码、图片、PDF；Word/Office 只显示路径，交给外部程序）；编辑描述/标签/出链/正文；看反链与已解析出链；显示 path / executable；保存/归档/删除在详情顶部，不用滚到底。
- 图谱：节点=文件，边=链接；SVG 力导向、按类型着色、点节点打开文件。MVP 是结算布局，不做拖拽。
- 设置：描述上限、单文件上限、单次读取上限、注入预算；保存后 `store.setLimits` 立即生效。
- 日志：`system/logs/plugin.log` 尾部。
- 安全边界：浏览器只发 id；上传/预览有字节上限；正文超过读取上限时禁用编辑，避免把截断文本写回文件。

## 10. 迁移（老库 → 自衍中枢）

1. `cards.jsonl` 每张活卡 → 一个 `.md` 文件（正文做内容），description/tags/links/source 照搬；id 重新生成，`legacy_id` 保留原 `card-` id。
2. 每个附件 → 独立文件实体；描述取卡正文引用行里的“用途…”，标签继承卡片的标签（再加一个 `类型/附件`），链接到卡文件；正文里的资源路径改写成 `file:<新id>`。
3. 链接两遍走：先建全部实体，再落 links（允许前向引用）。
4. 脚本：`scripts/migrate-from-evolver.mjs <旧数据目录> <新数据目录>`，默认 dry-run，输出计数与冲突。
5. 迁移后正文不进索引；老库的卡片描述本来就承担索引作用，正好对得上。

## 11. 场景验证

**A. 搜索 → 文档 → 脚本 → 直接使用**

1. `file_query("报表导出")` 命中 `spec.docx`（描述里有“报表导出”）。
2. `file_read(spec)` 返回描述、path、邻居 `export-notes.md`；agent 想看 Word 正文就自己用 `textutil`/`pandoc` 读 path。
3. `file_read(export-notes.md)` 返回邻居 `export.sh`。
4. `file_read(export.sh)` 返回 `executable: true` + 绝对 path；agent 用 bash 跑。

一次拿全链路用 `file_query graph:true, hops:2`：节点里直接有 `spec → notes → export.sh` 的边。

**B. 搜索 → Word → markdown → 脚本**

与 A 相同，只是 Word 的正文不由插件解析；搜索靠 Word 的描述。只要 Word 的描述写清“这是什么、和哪条流程有关”，链路成立。

**C. 类似需求**

- 搜报错关键词 → 描述里带这个报错的修复脚本 → 读 → 跑。
- 搜规则 → 描述命中的 markdown → 邻居里的实现脚本 / 数据文件 → 用。
- 搜主题 → 一组同标签文件 → `file_query` 按标签过滤 → 逐个读。

**不成立的场景（有意为之）**

- 搜 Word 正文里的一个词，而描述没写：不会命中。
- 两个文件内容语义相关但没写 `links`：图里不会自动出现边。
- 插件自动执行脚本：不会；它只给 path + executable，执行由 agent 决定。

## 12. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1（本包，已完成） | 核心：ids/names/meta/DB/store/search/graph + 测试 | 核心测试 32 条全绿；描述检索、标签必填/层级/组合过滤、任意类型互链、两跳场景、删库重建均过 |
| P2（已完成 host） | index.js、8 个工具、注入快照、prompt、设置、日志、插件测试 | 46 条全绿；工具可用；注入 ≤4 KB；所有数据在一个目录 |
| P3（已完成） | 面板：5 页签 + 12 个 HTTP 接口 + 真实浏览器验证 | 50 条全绿；列表/详情/上传/图谱/设置/日志可用 |
| P4（已完成迁移） | 迁移脚本 + trash/归档/重建 + 备份 | 136 卡 + 10 附件迁入，重复执行幂等；备份/增量同步未做 |
| P5 | 会话沉淀/每日整理/健康度（老库 dreaming 的对应物） | 能自动整理而不是只存 |

## 13. P1 落地记录（2026-11-13）

已实现并验证：

- `src/ids.js`、`src/names.js`、`src/meta.js`、`src/text.js`、`src/db.js`、`src/store.js`；
- 46 条测试：CRUD、二进制、改名、删除进 trash、归档、悬空链接、短后缀解析、中文两字描述检索、正文不参与检索、名字/标签检索、标签必填、自由层级/去空段/父标签过滤/多标签 AND、任意类型文件互链与反链、删库重建、边车手工修改、改名修复、缺边车/缺本体报告、符号链接拒绝、脚本可执行位、两跳场景（Word 描述 → markdown → 脚本）、设置、注入快照、8 个工具、插件装配；
- 真实运行时验证：Electron 44.7 / Node 24.21 自带 `node:sqlite` 与 FTS5，`ELECTRON_RUN_AS_NODE=1` 跑通基准；
- 性能（Node 26，500 文件）：建 456 ms（0.9 ms/文件）、检索 1.5 ms、列表 1.9 ms、全量重建 101 ms；
  桌面运行时（Node 24，200 文件）：建 214 ms（1.1 ms/文件）、检索 1.1 ms、列表 1.1 ms、重建 52 ms。
- 安全：文件名净化到单段、路径由 id 推导、实体目录内符号链接拒绝、描述/标签去控制字符、单文件 25 MB 上限。

尚未做（P2 起）：插件装配与工具面、注入快照、面板、迁移脚本、密钥筛查、备份/归档、会话沉淀与每日整理。

## 14. 待定决策

1. **包布局**：现在 `ziyan/` 子包并行；验证后是替换根包，还是独立仓库/包？
2. **标签层级深度**：当前不限深度、总长 64 字、最多 32 个；如果实际会出现超长路径，再决定是截断还是拒绝。
3. **工具前缀**：已用 `file_*`；如果实际装进 desktop 后发现重名，再统一改 `ys_*`。
4. **数据库地位**：边车为准 + DB 索引（本文默认），还是 DB 为准 + 定期导出？
5. **旧数据**：迁移后保留 `legacy_id` 多久；旧插件是否继续作为日常驱动直到 P4 验收？

## 15. 下一步建议

1. 先确认第 14 节的五个决策（尤其是标签去留、工具前缀、包布局）。
2. P2 顺序：`index.js` 装配 → `src/tools.js` 工具 → `src/prompt.js` 注入 → 契约测试 → 临时 profile 里真实调用。
3. 工具面先做 5 个（query/read/write/import/link），`file_index` 与 archive/remove 随后；每加一个工具都按老库的口径算一次请求 token。

## 16. P2 落地记录（2026-11-13）

已实现：

- `index.js`：Host 装配；默认数据目录 `~/.dsh/ziyan`，也接受组合配置里的绝对 `dataDir`；没有第二个配置文件。
- `src/tools.js`：8 个工具（query/read/write/import/link/index/archive/remove），短 id 解析，写入结果不带正文，死链进 `warnings`。
- `src/injection.js`：12 个文件快照（10 枢纽 + 2 最近）+ 摘要；快照无构建时间戳，同样内容重写为零字节；跨日心跳刷新；预算内先丢描述再减行。
- `src/settings.js`、`src/logs.js`、`src/atomic.js`：设置、日志轮转、原子写在 `system/` 内；`files/` 只放文件本体。
- 重建对“边车名与大小都对得上”的健康文件只做 `stat`，不读正文；只有名/大小不一致时才读文件修复。
- `test/settings.test.mjs`、`test/injection.test.mjs`、`test/tools.test.mjs`、`test/plugin.test.mjs`：46 条测试全绿；插件测试断言“根目录只有 files/ 与 system/，数据目录外没有插件数据”。
- `scripts/compare.mjs`：复制老库、迁移、分场景对比，产出 `COMPARISON.md` / `COMPARISON.json`。

未做：面板/HTTP 接口（P3）、迁移（P4）、会话沉淀与每日整理（P5）；插件还没装进任何 profile。

## 17. 与 evolver 1.0.0 的量化对比（2026-11-13）

脚本：`node scripts/compare.mjs`；老库复制自 `~/.dsh/evolver`，新库在临时目录迁移后测量。样本 135 卡 / 10 附件，Node 26。

| 指标 | evolver 1.0.0 | 自衍中枢 | 解读 |
|---|---|---|---|
| 注入（静态 + 12 候选） | 3450 B | 3041 B | 自衍中枢小 409 B；静态段更短，索引略小 |
| 查询返回体（平均） | 5311 B | 2890 B | 老查询带正文；自衍中枢只回描述/元数据 |
| 描述基线 top5 重合 | — | 19/32 | 差额含排序策略与附件进 top5 |
| 老库额外正文命中 | +8 / 40 | — | 正文索引的额外召回，描述没写就没有 |
| 标签 复盘 | 28 | 31 | 附件继承卡片标签 |
| 图（审计，2 跳） | 13 节点 / 20 边 | 37 节点 / 50 边 | 附件成为节点并补了 card↔附件 links |
| 写 100 次 | 12.6 ms | 70.7 ms | 自衍中枢每次写字节+边车+DB 三处 |
| 重开（有索引） | 7.3 ms | 0.5 ms | 自衍中枢只开 SQLite |
| 全量重建 | — | 23.9 ms | 扫边车 + 灌表 |
| 存储 | 361 KB / 18 文件 | 683 KB / 292 文件 | 每实体两文件 + DB；换取可重建/可查询 |

结论：自衍中枢在注入、返回体、重开、附件成图、脚本可执行上更优；evolver 在写入吞吐、存储占用、正文召回上更优。选择自衍中枢意味着把“正文理解”交给 agent，把检索预算压在描述质量上。

## 18. P3 落地记录（2026-11-13）

已实现：

- `src/remote.js`：12 个接口（overview / file-list / file-read / file-write / file-upload / file-preview / file-archive / file-remove / graph / settings / settings-save / logs）；浏览器只传 id，路径由 store 解析。
- `index.js`：每个接口经 `connection.fetch.register` 注册，`methods: ['POST']`、`requestBody: 'buffered'`；`connection` 缺失时只告警，工具与注入仍可用。
- `client.js`：`window.__ModuleLoader__.load` 单文件客户端；侧边栏 id 与 main key 都是 `ziyan`；概览/文件/图谱/设置/日志；文件列表分页；详情编辑描述/标签/出链/正文；上传、新建、归档、删除；图片/PDF 预览；深色/浅色主题都走 DSW token。
- `test/remote.test.mjs`：真实 `apply` + fake Connection，走完读/写/上传/预览/图/设置/日志/归档/删除；`test/client.test.mjs` 只做加载与注册冒烟；`test/contract.test.mjs` 静态断言 ENDPOINTS / switch / `call()` 三处同集合。50 条全绿。
- 真实界面验证：临时 profile `ystest` + 独立 Web 端口；侧边栏出现「自衍中枢」；新建/编辑/保存、上传、归档、分页（100→103）、图谱（2 节点 1 边，点节点打开详情）、设置保存、日志都走通；浅色与深色截图各一张。

验证中发现并修掉的问题：

- `apply` 返回 `{root,store,settings}` 被 Cordis 当 effect 收集，报 `Invalid effect`；改为不返回对象。
- `read()` 不带 `degree`，详情显示 0/0；补 `degree` 并加测试。
- 图谱 SVG 按宽度等比放大导致画布过高；改为 `height:min(62vh,560px)`。
- 图谱图例 `text/` 渲染成空标签；改成显式 `md/img/pdf/script`。
- 详情两个“出链”标签重复；拆成“出链 id”和“已解析出链”。
- 超长文本保存会把截断正文写回；`detail.truncated` 时禁用正文编辑、保存不带 content。
- 文件列表 100 条后没有入口；增加“加载更多”。
- 列表与详情共用页面滚动，长列表点下方行时详情在视口上方；列表改为独立滚动（`max-height: calc(100vh - 260px)`）。
- 主按钮沿用业务蓝时白字对比度不足；改用 DSH 的 button-primary-fill / label-primary-inverted，并给 hover 单独规则，避免 hover 把主按钮洗成白底白字。
- 保存时死链被静默丢弃；读取 `warnings`，有丢弃时用错误色 toast 列出。
- 没有未保存保护；详情标题显示“未保存”，切换文件前 `confirm`。
- 上传先读 DataURL 后在服务端才拒绝；客户端先按 20 MB 硬上限预检，设置页标注上传上限与单文件上限独立。
- 加载失败后页面永远停在“加载中”；加全局错误横幅与“重试”。
- 补基础可访问性：列表行/图谱节点可 Tab + Enter，上传改按钮触发，弹窗 Esc/role=dialog，toast 加 role=status。

未做：迁移面板（P4）、系统打开/文件管理器 reveal、图谱拖拽与大库聚合、完整键盘焦点管理。

## 19. P4 迁移落地记录（2026-11-14）

已实现：

- `src/migrate.js`：直接读老库 `cards.jsonl` 与 `knowledge/resources/`，不经过老 store，不写老库。
- `scripts/migrate-from-evolver.mjs`：默认 dry-run；`--apply` 落盘；`--from` / `--to` / `--json`。
- 语义：JSONL 最后一条覆盖前一条；`deleted:true` 墓碑跳过；旧 `card-` id 写进 `legacy_id`；归档标签转 `archived`；附件独立成文件并双向链接；正文的旧资源路径改写成 `files/<新id>/<name>`；死链进 warnings。
- 幂等：已存在 `legacy_id` 跳过；重复 `--apply` 结果为 0 新建、0 更新；只有“已有卡片 + 新附件”这种半迁移状态会补链接。
- 验证：`test/migrate.test.mjs` 覆盖最后一条覆盖、删除、归档、孤立附件、预演不写盘、真实迁移、重复执行；全量 52 条测试。

真实库结果（`~/.dsh/evolver` → `~/.dsh/ziyan`）：

- 源：340 行 / 151 唯一 / 15 删除 / 135 活跃 + 1 归档；
- 新库：136 卡 + 10 附件 = 146 文件（145 活跃 + 1 归档）；128 条链接；224 个标签；注入 2061 B；
- 正文旧路径残留 0；附件描述保留“用途/入口/输入/输出/关联流程”；
- 面板实测：概览 145 / 128 / 224 / 1，文件分页 100 → 145，搜索“反向代理”命中 1 张，归档筛选 1 张，图谱 145 节点 / 128 边。

迁移期间发现并修掉一个图谱 bug：当所有文件都作为种子且数量超过 `graph()` 默认上限 100 时，边收集被整体跳过，表现为 145 个节点、0 条边。现在先按上限收种子，再收集种子之间的边；面板接口显式传 `limit: 500`，并加测试。

未做：面板内的迁移按钮、老库持续变化后的增量同步（当前重复执行只跳过、不更新已迁移卡的正文/标签）、备份/导出。

## 20. 明确不做：标签描述层（2026-11-14）

用户决策：**自衍中枢不建立独立的标签描述层。** 标签名本身就是语义描述，文件描述再承担实例语义，两层已经够用。

依据：

- 迁移后的库只有 **18 个不同标签**（224 次使用，平均 1.53 个/文件），Top 10 覆盖 85%，没有单次使用标签；词表小且稳定，不需要第二套本体。
- 老 evolver 的 29 条默认标签说明能覆盖 17/18 个标签、214/224 次使用、146/146 个文件；但 live 数据里 `knowledge/tags.json` 从未存在，说明“可编辑的标签说明”没有真实使用。
- 标签说明若进入注入会挤占文件候选预算，改名/改说明还会让提示词前缀失效；若进入 FTS 会污染描述检索。
- 给标签建独立文件/图谱节点会把“词汇表”混进“文件关系”，得不偿失。

因此：

- 不新增 `system/tags.json`、标签管理页、`file_index({tag})` 说明字段或标签实体；
- 不在注入/FTS 中加入标签说明；
- 老库的默认标签说明不迁入自衍中枢；
- 以后若出现真实的标签歧义或重复，只考虑 **alias/merge** 这类治理动作，不重新引入 prose 描述层。

## 21. 数据目录与导入导出（2026-11-14）

用户决策：**导入作为新库并切换；目录操作重启生效。**

已实现：

- `src/home.js`：`~/.dsh/ziyan.home.json` 指针，绝对路径、0600 原子写；启动时指针优先于组合配置 `dataDir`，指针指向缺失库时明确报错。
- `src/data-jobs.js`：复制当前库到新目录（只复制 `files/` + settings，目标必须不存在）、attach 已有库、导出、导入为新库；当前 store 不热切换，所有切换返回 `restartRequired`。
- `src/archive.js` + `src/tar.js`：无依赖 tar+gzip；导出带 `ziyan-export.json` 清单；导入只允许清单、`system/settings.json` 和 `files/`，拒绝绝对路径、`..`、反斜杠、符号链接、非普通条目，限制 32 MB 归档 / 256 MB 解压 / 64 MB 单文件。
- 面板设置页「数据」区：当前/下次启动目录、复制/attach、导出下载、选择 `.tar.gz` 导入；导入目标可留空自动新建。
- 接口从 12 个增至 16 个：`data-status`、`data-dir-save`、`data-export`、`data-import`。
- 安全：复制先写 staging 再 rename；导入先解压到新目录并校验 `files/<id>/meta.json`、id/name/字节数，再写指针；指针写失败不覆盖旧指针。
- 验证：`test/home.test.mjs`、`test/data-jobs.test.mjs`、`test/archive.test.mjs`，61 条全绿；隔离 profile 实测复制、指针重启生效、导出下载、上传导入、指针切换。

边界：

- 复制时当前实例仍在服务；若同时有写操作，复制不是严格事务快照。UI 提示“重启后生效”，但没有锁；大批量写入时建议先停写。
- 导出通过 base64 下载，受 32 MB 归档上限约束；更大的库后续应改成流式下载/导出到目录。
- 导入只做“新库 + 切换”，不做合并/覆盖；旧库始终保留。
- 指针在数据目录外，是“目录可迁移”的必要例外；备份时要一起记路径，但不要复制指针到新机器（路径会变）。
