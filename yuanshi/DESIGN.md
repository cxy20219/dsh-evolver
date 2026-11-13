# 元始 · 设计稿

> 一句话：**一切皆文件**。每个文件是一等实体（唯一 id + 一句话描述 + 自由层级标签 + 链接），内容可以是任意类型；元数据落在边车，SQLite 只维护「描述索引 + 关系」，正文由 agent 自己去读、去解析、去执行。

状态：研究原型（worktree `research-data-model`）。旧插件 `dsh-evolver` 1.0.0 已归档在 `v1.0.0`，本包是并存的新包，验证后再决定替换根包还是独立发布。

## 1. 原则

1. **文件是唯一实体**，没有卡片/附件/页的层级。文本、脚本、图片、Word、PDF、压缩包都是同一种东西。
2. **描述是唯一的检索面**。插件不索引正文；搜索命中描述（以及名字、标签），然后 agent 读文件、理解内容、决定下一步。二进制文件没有正文可读，描述就是它全部的可检索信息。
3. **标签是必填的分类面**。每个文件至少一个标签；标签是自由层级的路径（`工作/项目/元始`、`类型/脚本`），没有固定根、没有固定深度，可以任意组合多个。标签用于过滤、摘要和检索，不承担主结构。
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
  "tags": ["工作/项目/元始", "类型/文档"],
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

- 存储的是完整路径（`工作/项目/元始`），不展开祖先；过滤时 `工作` 会命中 `工作/项目/元始`，因为前缀匹配。
- 一个文件可以带多个不同根的标签，例如 `工作/项目/元始` + `类型/脚本` + `来源/会话`。
- 查询支持 `tag`（单路径）与 `tags`（数组，AND：必须同时命中每一条或其子路径）。
- 空标签、空数组、只有空段的标签都拒绝写入；标签是文件的必填分类面。

**链接**：

- 方向：A 的 `links` 里写 B，意思是 A 引用 B；B 不需要写反向字段，`file_read(B).neighbors.in` 会实时给出 A。
- 目标类型不限：图片、脚本、PDF、数据文件都能互相引用。
- 自链丢弃；写入时目标不存在或不唯一则丢弃该边，并在结果的 `warnings` 里点名（不阻断整次写入）；目标删除后边保留，查询标 `missing`。
- 图遍历同时走出的边和反链，方向保留；`graph(ids, {hops})` 用于“文档 → 说明 → 脚本”这类多跳导航。

## 3. 磁盘布局

```
~/.dsh/yuanshi/                 ← 数据根目录（备份/迁移的单位）
  files/                        ← 只放文件本体与边车
    file-01M.../
      design.md                 ← 原始字节，永不改写元数据
      meta.json                 ← 唯一事实来源
  system/                       ← 索引与系统数据，不和文件混放
    yuanshi.db                  ← SQLite 索引（可删、可重建）
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

- 文件页：搜索、按类型/标签过滤、上传（必须填描述）、列表（名字 + 描述 + 类型 + 大小 + 度数 + 更新时间）。
- 详情：按类型预览（md/文本/代码、图片、PDF；Word/Office 交给系统程序）；编辑描述/标签/链接；看反链；显示 path / executable；归档/删除。
- 图谱：节点=文件，边=链接，可拖拽；按类型或标签着色。
- 概览：文件数、类型分布、链接数、孤儿、最近写入、注入预览。

## 10. 迁移（老库 → 元始）

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
| P2（本包，已完成 host） | index.js、8 个工具、注入快照、prompt、设置、日志、插件测试 | 46 条全绿；工具可用；注入 ≤4 KB；所有数据在一个目录 |
| P3 | 面板：文件列表/详情/上传/图谱 + HTTP 接口 | 真实数据目录可浏览、可编辑 |
| P4 | 迁移脚本 + trash/归档/重建 + 备份 | 135 张老卡无损迁入 |
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

1. **包布局**：现在 `yuanshi/` 子包并行；验证后是替换根包，还是独立仓库/包？
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

- `index.js`：Host 装配；默认数据目录 `~/.dsh/yuanshi`，也接受组合配置里的绝对 `dataDir`；没有第二个配置文件。
- `src/tools.js`：8 个工具（query/read/write/import/link/index/archive/remove），短 id 解析，写入结果不带正文，死链进 `warnings`。
- `src/injection.js`：12 个文件快照（10 枢纽 + 2 最近）+ 摘要；快照无构建时间戳，同样内容重写为零字节；跨日心跳刷新；预算内先丢描述再减行。
- `src/settings.js`、`src/logs.js`、`src/atomic.js`：设置、日志轮转、原子写在 `system/` 内；`files/` 只放文件本体。
- 重建对“边车名与大小都对得上”的健康文件只做 `stat`，不读正文；只有名/大小不一致时才读文件修复。
- `test/settings.test.mjs`、`test/injection.test.mjs`、`test/tools.test.mjs`、`test/plugin.test.mjs`：46 条测试全绿；插件测试断言“根目录只有 files/ 与 system/，数据目录外没有插件数据”。
- `scripts/compare.mjs`：复制老库、迁移、分场景对比，产出 `COMPARISON.md` / `COMPARISON.json`。

未做：面板/HTTP 接口（P3）、迁移（P4）、会话沉淀与每日整理（P5）；插件还没装进任何 profile。

## 17. 与 evolver 1.0.0 的量化对比（2026-11-13）

脚本：`node scripts/compare.mjs`；老库复制自 `~/.dsh/evolver`，新库在临时目录迁移后测量。样本 135 卡 / 10 附件，Node 26。

| 指标 | evolver 1.0.0 | 元始 | 解读 |
|---|---|---|---|
| 注入（静态 + 12 候选） | 3450 B | 3041 B | 元始小 409 B；静态段更短，索引略小 |
| 查询返回体（平均） | 5311 B | 2890 B | 老查询带正文；元始只回描述/元数据 |
| 描述基线 top5 重合 | — | 19/32 | 差额含排序策略与附件进 top5 |
| 老库额外正文命中 | +8 / 40 | — | 正文索引的额外召回，描述没写就没有 |
| 标签 复盘 | 28 | 31 | 附件继承卡片标签 |
| 图（审计，2 跳） | 13 节点 / 20 边 | 37 节点 / 50 边 | 附件成为节点并补了 card↔附件 links |
| 写 100 次 | 12.6 ms | 70.7 ms | 元始每次写字节+边车+DB 三处 |
| 重开（有索引） | 7.3 ms | 0.5 ms | 元始只开 SQLite |
| 全量重建 | — | 23.9 ms | 扫边车 + 灌表 |
| 存储 | 361 KB / 18 文件 | 683 KB / 292 文件 | 每实体两文件 + DB；换取可重建/可查询 |

结论：元始在注入、返回体、重开、附件成图、脚本可执行上更优；evolver 在写入吞吐、存储占用、正文召回上更优。选择元始意味着把“正文理解”交给 agent，把检索预算压在描述质量上。
