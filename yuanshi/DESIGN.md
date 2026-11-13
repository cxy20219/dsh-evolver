# 元始 · 设计稿

> 一句话：**一切皆文件**。每个文件是一等实体（唯一 id + 一句话描述 + 链接），内容可以是任意类型；元数据落在边车，SQLite 负责索引、检索与关系。

状态：研究原型（worktree `research-data-model`）。旧插件 `dsh-evolver` 1.0.0 已归档在 `v1.0.0`，本包是并存的新包，验证后再决定替换根包还是独立发布。

## 1. 原则

1. **文件是唯一实体**，没有卡片/附件/页的层级。文本、脚本、图片、PDF、压缩包都是同一种东西。
2. **描述是必填的语义入口**。模型和面板先看 `描述`，再决定读不读；二进制文件没有正文可索引，描述就是它唯一的检索面。
3. **id 稳定，名字可变**。链接只指向 id；文件名只用于显示和磁盘可读性，改名不断链。
4. **边车是事实，数据库是索引**。`meta.json` + 文件字节是真相；SQLite 可随时删掉重建。这条沿用老库“索引必须生成”的结论。
5. **链接可以悬空**。删除一个文件不批量改写别人的边车；查询时把悬空目标标成 `missing`，整理时再清。导入、前向引用都靠这条。
6. **注入只给索引，不给正文**。12 个文件（枢纽 + 最近）+ 一段结构摘要，每日快照；写文件不改变注入文本。

## 2. 实体

```json
{
  "schema": 1,
  "id": "file-01M7...",
  "name": "design.md",
  "description": "一句话说明这个文件回答什么问题",
  "tags": ["工作流", "演化器"],
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
- `description`：必填，≤200 字，单行；空/占位词（暂无、TODO、待补）拒绝。
- `tags`：可选、自由层级（不再强制六枝干）；只做过滤与摘要，不承担主结构。
- `links`：出边，存完整 file id；反链实时算；悬空允许。
- `source`：可选出处；保留给以后的会话沉淀。
- `mime` / `bytes` / `sha256`：写入时算；类型由扩展名 + 内容嗅探决定。
- `archived`：生命周期是元数据，不占一个标签。

## 3. 磁盘布局

```
~/.dsh/yuanshi/                 ← 数据目录（备份/迁移的单位）
  files/
    file-01M.../
      design.md                 ← 原始字节，永不改写元数据
      meta.json                 ← 唯一事实来源
  yuanshi.db                    ← SQLite 索引（可删、可重建）
  index.json                    ← 注入快照（每日）
  trash/<时间戳>-<id>/          ← 删除先移动到这里
  logs/plugin.log
```

- 一个实体一个目录：以后要加版本、抽取文本、缩略图，都有地方放。
- `meta.json` 原子写（临时名 + rename）；文件字节同样原子写。
- 写序：字节 → 边车 → DB。DB 失败不影响事实，下次打开/重建恢复。

## 4. 数据库（SQLite，`node:sqlite`，零依赖）

运行时已验证：桌面端 Electron 44.7 / Node 24.21 自带 `node:sqlite`，FTS5 可用。

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
  id UNINDEXED, name, description, body, tokenize='unicode61'
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- schema_version, built_at
```

- 没有外键：`links` 要允许悬空；删除只删本体。
- `files_fts` 存**预分词**文本（拉丁词 + 中文 bigram），不存原文；原文在磁盘。
- 索引重建：扫 `files/*/meta.json` + 可读文本，重灌四张表。

## 5. 检索

1. 查询分词：拉丁词小写 + 中文连续串切成 bigram（同老库 `tokenize`）。
2. FTS：`"词1" OR "词2" ...`，`bm25(files_fts, 0, 6, 10, 1)`（name 6、description 10、body 1）。
3. 候选 50 条，按 `归一化 bm25 × 0.8 + 新近度 × 0.15 + 度数 × 0.05` 重排。
4. 片段：**从磁盘原文**按查询词找第一处命中，截 ±80 字。FTS 里的预分词文本不能直接当 snippet（会显示成“接口 口约 约定”）。
5. 正文索引上限 512K 字符（约 1.5 MB 中文；超长文件只索引头部，文件仍可经 path 读）；`file_read` 文本返回上限 256 KB。
6. 二进制文件只索引 name + description。

为什么不用 trigram：实测 FTS5 trigram 对 2 字中文查询 0 命中（“插件”“接口”都查不到），中文必须 bigram。为什么不用向量：老库在真实数据上实测 embedding 只改排序不改召回，代价 592 MB；这里沿用。

## 6. 链接与图

- 出边在实体 `links`；反链 `SELECT from_id FROM links WHERE to_id = ?`。
- 度数 = 入 + 出；注入与图排序用它。
- `file_read` 返回 `neighbors`：目标存在给 `{id, name, description}`，不存在给 `{id, missing: true}`。
- 图只画显式链接；没有标签派生边（标签可选，派生边以后按需）。孤儿文件靠面板/整理提示。
- 未来可选：类型化边（`uses`/`derived_from`）、内联 `[[file-id]]` 自动同步到 links。

## 7. 注入

| 部分 | 载体 | 内容 |
|---|---|---|
| 静态纪律 + 主动性协议 | `systemPrompt.section` | 文件纪律、工具指针、什么时候写文件 |
| 运行时候选 | `systemPrompt.context` | 12 个文件（10 枢纽 + 2 最近，短 id｜描述）+ 结构摘要 |

- 摘要：`共 N 个文件（md 80 · py 10 · pdf 5…），M 条链接`；每日快照，写文件不改注入。
- 二进制/长文不注入正文；描述就是索引。
- 快照缺失/过期回退实时排序并按 store 版本记忆化（沿用老库结论）。

## 8. 工具面（拟）

| 工具 | 作用 |
|---|---|
| `file_query` | 关键词/标签/类型/图检索；返回 id、名字、描述、类型、大小、度数、片段 |
| `file_read` | 元数据 + 文本（上限 256 KB，超出给 path）+ 邻居；悬空标 `missing` |
| `file_write` | 新建/更新文本文件；带 description、tags、links；写前查重 |
| `file_import` | 从宿主机路径导入任意文件（二进制/文本），复制字节入库 |
| `file_link` | 加/删链接，不重写正文 |
| `file_index` | 类型/标签/规模总览（对应老 `card_index`） |
| `file_archive` / `file_remove` | 归档 / 先移 trash 再删 |

工具名待定：`file_*` 直观，但要确认 DSH 工具命名空间没有冲突；备选 `ys_*`。

## 9. 面板

顶层页签：**概览 / 文件 / 图谱 / 设置 / 日志**（不再有“卡片/资源”两分）。

- 文件页：搜索、按类型/标签过滤、上传（必须填描述）、列表（名字 + 描述 + 类型 + 大小 + 度数 + 更新时间）。
- 详情：按类型预览（md/文本/代码、图片、PDF；其余只给元数据 + 系统打开）；编辑描述/标签/链接；看反链；归档/删除。
- 图谱：节点=文件，边=链接，可拖拽；按类型或标签着色。
- 概览：文件数、类型分布、链接数、孤儿、最近写入、注入预览。

## 10. 迁移（老库 → 元始）

1. `cards.jsonl` 每张活卡 → 一个 `.md` 文件（正文做内容），description/tags/links/source 照搬；id 重新生成，`legacy_id` 保留原 `card-` id。
2. 每个附件 → 独立文件实体；描述取卡正文引用行里的“用途…”，链接到卡文件；正文里的资源路径改写成 `file:<新id>`。
3. 链接两遍走：先建全部实体，再落 links（允许前向引用）。
4. 脚本：`scripts/migrate-from-evolver.mjs <旧数据目录> <新数据目录>`，默认 dry-run，输出计数与冲突。

## 11. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1（本包，已完成） | 核心：ids/names/meta/DB/store/search + 测试 | `npm test` 全绿（27 条）；中文/英文检索、悬空链接、删库重建均过 |
| P2 | 插件装配：index.js、工具、注入快照、prompt、契约测试 | 在临时 profile 里工具可用，注入 ≤4 KB |
| P3 | 面板：文件列表/详情/上传/图谱 | 真实数据目录可浏览、可编辑 |
| P4 | 迁移脚本 + trash/归档/重建 + 备份 | 135 张老卡无损迁入 |
| P5 | 会话沉淀/每日整理/健康度（老库 dreaming 的对应物） | 能自动整理而不是只存 |

## 12. 待定决策

1. **包布局**：现在 `yuanshi/` 子包并行；验证后是替换根包，还是独立仓库/包？
2. **标签**：保留为可选自由标签（本文默认），还是彻底去掉、只用链接？
3. **工具前缀**：`file_*` 还是 `ys_*`（避免与其它插件/内置工具重名）？
4. **数据库地位**：边车为准 + DB 索引（本文默认），还是 DB 为准 + 定期导出？
5. **旧数据**：迁移后保留 `legacy_id` 多久；旧插件是否继续作为日常驱动直到 P4 验收？

## 13. P1 落地记录（2026-11-13）

已实现并验证：

- `src/ids.js`、`src/names.js`、`src/meta.js`、`src/text.js`、`src/db.js`、`src/store.js`；
- 27 条测试：CRUD、二进制、改名、删除进 trash、归档、悬空链接、短后缀解析、中文两字检索、描述/正文权重、片段来自原文、删库重建、边车手工修改、改名修复、缺边车/缺本体报告、符号链接拒绝；
- 真实运行时验证：Electron 44.7 / Node 24.21 自带 `node:sqlite` 与 FTS5，`ELECTRON_RUN_AS_NODE=1` 跑通基准；
- 性能（Node 26，500 文件）：建 669 ms（1.3 ms/文件）、检索 3.3 ms、列表 3.6 ms、全量重建 237 ms；
  桌面运行时（Node 24，200 文件）：建 509 ms（2.5 ms/文件）、检索 2.5 ms、列表 2.2 ms、重建 104 ms。
- 安全：文件名净化到单段、路径由 id 推导、实体目录内符号链接拒绝、描述/标签去控制字符、单文件 25 MB 上限。

尚未做（P2 起）：插件装配与工具面、注入快照、面板、迁移脚本、密钥筛查、备份/归档、会话沉淀与每日整理。

## 14. 下一步建议

1. 先确认第 12 节的五个决策（尤其是标签去留、工具前缀、包布局）。
2. P2 顺序：`index.js` 装配 → `src/tools.js` 工具 → `src/prompt.js` 注入 → 契约测试 → 临时 profile 里真实调用。
3. 工具面先做 5 个（query/read/write/import/link），`file_index` 与 archive/remove 随后；每加一个工具都按老库的口径算一次请求 token。
