# 元始 · dsh-yuanshi

一个「一切皆文件」的知识库插件：每个文件有唯一 id、一句话描述、自由层级标签，文件之间可以互相链接；插件只维护描述索引与关系，正文由 agent 自己读、解析、执行。

## 状态

- **Host 半边已实现**：数据目录、文件存储、SQLite 索引、描述检索、图遍历、8 个工具、两段注入、设置、日志。
- **面板（浏览器半边）未实现**：当前可以直接用工具和注入，没有侧边栏。
- 数据目录默认 `~/.dsh/yuanshi`，所有数据都在里面：

```
~/.dsh/yuanshi/
  files/<file-id>/<name>   文件本体
  files/<file-id>/meta.json 边车元数据（事实来源）
  yuanshi.db               SQLite 索引（可删、可重建）
  index.json               注入快照（每日）
  settings.json            设置（在数据目录内）
  logs/plugin.log          插件日志
  trash/<时间戳>-<id>/     删除回收站
```

## 规则

- 每个文件：`id` + `description` + 至少一个 `tags`；`tags` 是自由层级路径，例如 `工作/项目/元始`、`类型/脚本`。
- 搜索只命中 name / description / tags，不索引正文，也没有 snippet。
- `links` 是出边，目标可以是任何类型的文件；反链实时计算；死链/自链写时丢弃并进 `warnings`。
- 脚本按扩展名/shebang 设 `0700`，`file_read` 返回 `path` + `executable`；插件不执行脚本。

## 工具

`file_query`、`file_read`、`file_write`、`file_import`、`file_link`、`file_index`、`file_archive`、`file_remove`。

## 开发

```bash
npm test                       # 46 条
node scripts/bench.mjs 500     # 500 文件基准
```

安装到研究 profile（不要动 desktop profile）：

```bash
dsh plugin --profile research add /path/to/dsh-evolver/yuanshi
```

设计稿与决策记录见 [DESIGN.md](DESIGN.md)。
