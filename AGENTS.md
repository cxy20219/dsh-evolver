> 改动前先按下面「先读什么」查上下文；`README.md` 是用法总览，`DESIGN.md` 是设计终稿。
# dsh-ziyan · 自衍中枢

DSH 插件：**一切皆文件**的知识库。每个文件是一等实体（唯一 id + 一句话描述 + 自由层级标签 + 链接），元数据落在边车 `meta.json`，SQLite 只维护「描述索引 + 关系」，正文由 agent 自己读。

仓库根就是包根（`package.json` = `dsh-ziyan`）。旧插件 `dsh-evolver` 1.0.0 已归档在 `v1.0.0` 分支并从本仓库移除；本分支只维护自衍中枢。

## 先读什么

| 想知道 | 读 |
|---|---|
| 插件是什么、怎么用、数据目录长什么样、怎么迁移老库 | [README.md](README.md) |
| 为什么这样设计、每条契约的取舍、分阶段落地记录与待定决策 | [DESIGN.md](DESIGN.md) |
| 与旧 evolver 1.0.0 的量化对比和取舍 | [COMPARISON.md](COMPARISON.md) |

## 布局

| 路径 | 内容 |
|---|---|
| `index.js` | 宿主装配：store、8 个 `file_*` 工具、两段注入、16 个面板接口、每日快照心跳 |
| `client.js` | 浏览器半边，单文件 `window.__ModuleLoader__.load` 工厂，无构建 |
| `src/` | `store.js`（边车 + 索引）、`db.js`（SQLite）、`injection.js`、`tools.js`、`prompt.js`、`remote.js`、`archive.js`、`data-jobs.js`、`migrate.js`、`home.js` 等 |
| `test/` | `node --test`，63 条 |
| `scripts/` | `bench.mjs` / `compare.mjs` / `migrate-from-evolver.mjs` |

## 命令

```bash
npm test                                # 63 条
node --check src/store.js               # 单文件语法
node scripts/bench.mjs 500              # 500 文件基准
node scripts/migrate-from-evolver.mjs   # 老库迁移，默认 dry-run
```

## 约束（动手前先看）

- **没有构建步骤**：`package.json` 只有 `test` 一个脚本。
- **宿主改了要重启 DSH**（`index.js` + `src/**`）；`client.js` 是浏览器半边，刷新面板即可。
- **边车是事实，数据库是索引**：`files/<id>/meta.json` 为准，`system/ziyan.db` 随时可删、可重建；写序是 字节 → 边车 → DB，DB 失败不影响事实。
- **新增面板接口要三处一致**：`src/remote.js` 的 `ENDPOINTS`、`createZiyanHandler` 的 switch、`client.js` 的 `call()`；`test/contract.test.mjs` 静态守这一条。
- **描述是唯一检索面**：不索引正文，所以写入要查重，描述必须说清"这个文件回答什么问题"。
- **标签必填、链接可悬空**：至少一个标签才能写入；删除不批量改写别人的边车，查询时把悬空目标标 `missing`。
- **Windows 平台差异**：`chmod` 只切只读位，`executable` 退化为按扩展名判断；POSIX 权限位（`0o700/0o600`）的断言必须加平台守卫，否则测试会在 Windows 上误红。
