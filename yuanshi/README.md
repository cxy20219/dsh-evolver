# 元始 · dsh-yuanshi

一个「一切皆文件」的知识库插件：每个文件有唯一 id、一句话描述、自由层级标签，文件之间可以互相链接；插件只维护描述索引与关系，正文由 agent 自己读、解析、执行。

## 状态

- **Host 半边已实现**：数据目录、文件存储、SQLite 索引、描述检索、图遍历、8 个工具、两段注入、设置、日志、12 个面板接口。
- **面板（浏览器半边）已实现**：侧边栏「元始」，概览 / 文件 / 图谱 / 设置 / 日志五个页签；可搜索、编辑、上传、新建、归档、删除、看图。
- 数据目录默认 `~/.dsh/yuanshi`，一个根目录下分两棵子树：`files/` 只放文件本体，`system/` 放索引与系统数据。

```
~/.dsh/yuanshi/
  files/<file-id>/<name>       文件本体
  files/<file-id>/meta.json    边车元数据（事实来源）
  system/yuanshi.db            SQLite 索引（可删、可重建）
  system/index.json            注入快照（每日）
  system/settings.json         设置
  system/logs/plugin.log       插件日志
  system/trash/<时间戳>-<id>/  删除回收站
```

## 规则

- 每个文件：`id` + `description` + 至少一个 `tags`；`tags` 是自由层级路径，例如 `工作/项目/元始`、`类型/脚本`。
- 搜索只命中 name / description / tags，不索引正文，也没有 snippet。
- `links` 是出边，目标可以是任何类型的文件；反链实时计算；死链/自链写时丢弃并进 `warnings`。
- 脚本按扩展名/shebang 设 `0700`，`file_read` 返回 `path` + `executable`；插件不执行脚本。

## 工具与面板

Agent 工具：`file_query`、`file_read`、`file_write`、`file_import`、`file_link`、`file_index`、`file_archive`、`file_remove`。

面板通过 `/api/yuanshi/*` 的 12 个接口工作（`overview`、`file-list`、`file-read`、`file-write`、`file-upload`、`file-preview`、`file-archive`、`file-remove`、`graph`、`settings`、`settings-save`、`logs`），浏览器只发 id，不发路径；上传和预览都有大小上限。

### 面板

- **概览**：文件 / 链接 / 标签 / 孤儿 / 归档统计，类型分布、常用标签、最近更新、注入快照预览。
- **文件**：搜索描述/名字/标签、标签前缀、类型、显示归档；列表分页；详情改描述/标签/出链/正文，上传、新建、归档、删除。
- **图谱**：显式链接图，点节点打开文件；节点按类型着色，附件与脚本也是节点。
- **设置**：描述上限、单文件上限、读取上限、注入预算；保存后立即生效。
- **日志**：`system/logs/plugin.log` 尾部。

## 与 evolver 1.0.0 的量化对比

```bash
node scripts/compare.mjs       # 复制老库、迁移、分场景对比
```

结果写到 [COMPARISON.md](COMPARISON.md) 和 `COMPARISON.json`。老库路径可用 `OLD_EVOLVER_ROOT` / `OLD_EVOLVER_DATA` 覆盖。最近一次（135 卡 / 10 附件，Node 26）：

| 指标 | evolver 1.0.0 | 元始 |
| --- | --- | --- |
| 注入（静态 + 12 个候选） | 3450 B | **3041 B** |
| 查询返回体（平均，带正文/不带正文） | 5311 B | **2890 B** |
| 重开（索引已存在） | 7.3 ms | **0.5 ms** |
| 写 100 次 | **12.6 ms** | 70.7 ms |
| 存储 | **361 KB / 18 文件** | 683 KB / 292 文件 |
| 描述基线 top5 重合 | — | 19/32（差额含排序与正文召回） |

取舍很清楚：元始注入更小、返回更省、重开更快、附件成为图节点；写更慢、存储更大、正文词召回更少。分析见 [COMPARISON.md](COMPARISON.md)。

## 开发

```bash
npm test                       # 50 条
node scripts/bench.mjs 500     # 500 文件基准
node scripts/compare.mjs       # 与 evolver 1.0.0 分场景对比
```

安装到研究 profile（不要动 desktop profile）：

```bash
dsh plugin --profile research add /path/to/dsh-evolver/yuanshi
```

设计稿与决策记录见 [DESIGN.md](DESIGN.md)。
