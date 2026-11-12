---
summary: 插件仓库总览：两边代码、数据目录、测试与重启约束
---
# dsh-evolver 项目总览

## 这是什么

DSH 的「演化器」插件：一个追加式卡片库 + 分层标签 + 双向链接 + 资源附件，
把 Agent 的经验沉淀成可检索的卡片。同时维护项目级 `harness/` 资源。

代码分两半，**改动的生效方式不同**：

| 半边 | 文件 | 生效方式 |
|---|---|---|
| 宿主（Node ≥22 ESM） | `index.js`（752 行，装配与接口编排）+ `src/**` | **必须重启 DSH** |
| 浏览器 | `client.js`（单文件，无构建） | 刷新面板即可 |

宿主侧的数据目录操作（迁移 / 导入 / 导出 / 修复链接）单独在 `src/workspace-jobs.js`（300 行），
`index.js` 只做装配与接口编排。

## 关键约束

- **没有构建步骤**：`package.json` 只有 `"test": "node --test \"test/*.test.mjs\""`。
- **新接口必须三处登记**：`src/remote.js` 的 `ENDPOINTS` 数组、`createEvolverHandler` 的 switch、
  以及 `client.js` 里的 `call('<name>')`。少一处就是 404 或 `unknown-endpoint`；`test/contract.test.mjs`
  从源码静态抽取这三处并断言同集合（纯静态、零依赖）。
- **注入块进前缀缓存**：任何每次请求都会变的内容（计数、时间戳）都会作废整段缓存，写一张卡的成本从 0 变成全价。会随数据变化的那一半（卡片索引）必须走 `systemPrompt.context`，只有不会变的（纪律 + 工具指针 + 主动性协议）留在 `systemPrompt.section`。
- **两级注入快照**：
  - `knowledge/index.json`（卡片索引 + 结构摘要）**每日整理写**；另外每次打开数据目录（首次启动、迁移、导入、切换）都会先建一次，避免新库把全库排序带上请求路径。请求路径只读，写卡当天注入不变。
  - `knowledge/access.json`（访问账）由访问账自己 flush 写（30 秒间隔 / 20 次变化 / 关闭时），每日整理只读它做批次降权，不写。
  - 注入走 `cardIndexText`，读快照；快照缺失/过期时回退实时排序，并按 store 版本记忆化（2000 卡无快照从 43.8 ms 降到 3.3–4.3 ms，命中缓存 0.04 ms）。标签树不再注入，标签目录用 `card_index` 取（2 KB 预算，超了按 tag 钻取）。
- **检索有两段**：BM25 词法命中 + 沿双链扩散（`src/memory/graph.js`，带衰减的个性化游走 + 枢纽加成）；`card_query` 的 `graph:true` 返回相关子图，`within` 做二次搜索。
- 数据目录默认 `~/.dsh/evolver`，`cards.jsonl` 是追加日志，同 id 后写覆盖前写。

## 常用入口

```bash
npm test                          # 277 个用例
node --check src/xxx.js           # 单文件语法
node harness/tool/link-layout-metrics.mjs --data-dir ~/.dsh/evolver   # 关系图布局实测
```

## 容易猜错的地方

- `client.js` 不是模块，是 `window.__ModuleLoader__.load({id, factory})` 的工厂函数。
- 卡片工具和 harness 工具是两个落点：**换项目也成立的写卡片，只在这个仓库成立的写 harness**。
- 浏览器半边与宿主没有 import 关系：接口清单与响应字段靠 `test/contract.test.mjs` 对齐，改 `client.js` 的接口调用会让它红。
- 关系图数据在宿主 `src/cards/graph.js`（派生弱关系、按显式度数排序，`POST /api/evolver/graph`）；`client.js` 的 `createLinkSimulation` 是实时力模拟（可拖节点、rAF 冷却），`computeLinkLayout` 是同一引擎的无头结算版，保留给 `harness/tool/link-layout-metrics.mjs` 做布局回归。面板只画图谱本身，不加搜索/图例/活动等外围控件（用户决策）。
