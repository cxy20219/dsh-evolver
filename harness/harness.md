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
| 宿主（Node ≥22 ESM） | `index.js` + `src/**` | **必须重启 DSH** |
| 浏览器 | `client.js`（单文件，无构建） | 刷新面板即可 |

## 关键约束

- **没有构建步骤**：`package.json` 只有 `"test": "node --test \"test/*.test.mjs\""`。
- **新接口必须两处登记**：`src/remote.js` 的 `ENDPOINTS` 数组 **和** `createEvolverHandler` 的 switch。少一处就是 404 或 `unknown-endpoint`。
- **注入块进前缀缓存**：任何每次请求都会变的内容（计数、时间戳）都会作废整段缓存，写一张卡的成本从 0 变成全价。
- 数据目录默认 `~/.dsh/evolver`，`cards.jsonl` 是追加日志，同 id 后写覆盖前写。

## 常用入口

```bash
npm test                          # 130 个用例
node --check src/xxx.js           # 单文件语法
```

## 容易猜错的地方

- `client.js` 不是模块，是 `window.__ModuleLoader__.load({id, factory})` 的工厂函数。
- 卡片工具和 harness 工具是两个落点：**换项目也成立的写卡片，只在这个仓库成立的写 harness**。
