---
title: 索引里的标签与顺序按路径收编，改名要先改写索引
summary: 改目录名必须先改写根 AGENTS.md 再重建索引，否则标签与用途全部退化成占位符
---
# 索引里的标签与顺序按路径收编，改名要先改写索引

## 现象

把 `harness/scripts/` 改名成 `harness/tool/` 之后重建索引，8 个工具的标题全变成
`analyze_backtest.py`，用途全变成「待补充 summary」——原本写好的
「冻结归档工具：pack/verify、MANIFEST+SHA256SUMS…」全部丢失。

## 根因

`catalog()` 在收编旧索引时按 **path 精确匹配**：

```js
const known = harvested.get(resource.path)
```

路径一改，`harness/<旧层>/x.py` 与 `harness/<新层>/x.py` 就对不上，收编落空，
`renderIndex` 便退回「文件名 + 待补充 summary」。

新目录名不是错，错在**改写顺序**：先动目录、后重建索引，中间那一步路径已经变了
但索引还是旧的。

## 做法

`migrateLayout` 在重建索引之前，先把项目根 `AGENTS.md` 里的旧路径改写掉：

```js
const agentsPath = join(root, 'AGENTS.md')
const agents = await readFile(agentsPath, 'utf8').catch(() => undefined)
if (agents !== undefined) {
  const next = rewritePaths(agents)
  if (next !== agents) await writeFile(agentsPath, next, { mode: 0o600 })
}
```

**`AGENTS.md` 在项目根，不在 `harness/` 下**——只遍历 `harness/` 的改写循环扫不到它，
这是第一次实现漏掉它的直接原因。

## 边界

- 只对"纯索引"的 AGENTS.md 生效。文件里有不是索引行的内容时，重建会拒绝而不是覆盖。
- 收编只在条目还没有 frontmatter `summary:` 时生效；写过 frontmatter 的文件以文件为准，
  不会被索引里的旧文字覆盖。

## 验证

给 `migrateLayout` 的回归测试写一个夹具：旧布局 + 一段提到旧路径的文档 + 一份带
标签的旧索引，迁移后断言索引里仍是 `- [检查器](harness/<新层>/check.py)：查语法`。
这条断言红了，就说明改写顺序又被改坏了。
