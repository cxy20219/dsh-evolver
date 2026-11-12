---
title: 会变的东西不进系统段：标签树迁到运行时上下文
summary: 标签树迁到 runtime context：新增枝干只追加 1.2KB 快照，实测未缓存输入从 29 万降到 651
---
# 会变的东西不进系统段：标签树迁到运行时上下文

## 现象

一天 631M prompt token、1909 条助手消息，命中率 **97.54%**。
23 次缓存全丢，代价 8.31M，占 **1.32%**：

```
system-section  15 次  6.05M   ← 标签树的计数每次写卡都变
resume           7 次  1.75M   ← 重启，会话恢复的固有成本
model-switch     1 次  0.22M   ← 提供方回退
```

## 根因

系统提示段一变，宿主**重写第 0 号节点**，整条对话前缀作废，下一次请求
把几十万 token 重读一遍。

演 化器的标签树挂在 `systemPrompt.section`(order 900)，而它随数据变：

- 带计数时，**每写一张卡**都变（v1，已修）
- 不带计数时，**新增/删除一个枝干**就变（v2，本文要修的）

两者是同一个错误的两种表现：**把会变的内容放进了只该放不变内容的通道**。

## 做法

宿主有两个通道，选对了就不用为变化付全价：

| 通道 | 语义 | 变化时 |
|---|---|---|
| `systemPrompt.section` | 系统提示词，稳定 | 重写第 0 号节点，**前缀全丢** |
| `systemPrompt.context` | 运行时快照，追加 | 发一条新快照，旧的声明失效，**前缀保住** |

所以拆成两半：

- **section(900)**：纪律、六枝干类型图例、一句指针「标签树在运行时上下文快照里」。全是常量。
- **context(900)**：`[标签树]` 本体，写卡就随数据变。

宿主**只在内容变化时**才发快照——实测 91 个轮次只有 21 条 `runtime-context`，
所以放在这里不会被每轮重复注入。

`PromptContext.order` 是普通数字，不必走 `getContextOrder`（那是宿主自己命名槽位用的）。

## 验证

验收标准只有一条：**新增枝干后，`system/message` 数量不变**。

```
写入前   system/message 30   runtime-context 22
写新枝干  system/message 30   runtime-context 23   ✅
删除后   system/message 30   runtime-context 24   ✅
```

最关键的是紧接着那三步的用量：

```
cacheRead 288,896 / input   651
cacheRead 289,536 / input 1,740
cacheRead 291,200 / input   936
```

**新枝干只花了 651 个未缓存 token**；改造前同样的动作要重读约 29 万。

`cache_report` 的 `byCause` 里 `system-section` 停在 15（全是计数时代的旧账），
之后不再增长。

## 边界

- 运行时上下文是 `user` 角色，指令优先级低于系统段。所以只有**数据**（标签树）进去，
  纪律与协议留在 section——那些是"要模型遵守"的，不能降级。
- 快照每次变化约 1.2KB。一天新增 1–2 个枝干，代价可忽略；但**不能**把每步都变的东西放进去。
- `systemPrompt.context` 在宿主里默认 `supportsMidConvoSystemMessages` 为 false 的路由
  也能用——它走的是 user 消息，与模型适配器无关。
