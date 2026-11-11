---
title: 布局是双份契约：插件改了，技能必须跟着改
summary: harness 布局是插件与技能共有的契约，改一边必须同步改另一边并用两套校验器互验
---
# 布局是双份契约：插件改了，技能必须跟着改

## 现象

把 `harness/` 从五层（`scripts/` + `references/` + `assets/`）改成四层
（`tool/` + `resources/`）之后，插件自己校验全绿，但用技能自带的校验器跑同一个仓库：

```
unexpected harness top-level entry: harness/resources
unexpected harness top-level entry: harness/tool
missing harness/scripts/
missing harness/references/
missing harness/assets/
```

7 条错误。也就是说：**别的 agent 用技能去读这个插件刚写的项目，会直接判为结构违规。**

## 根因

`harness/` 的布局不是插件私有约定，是**两份实现共同遵守的契约**：

| 实现 | 在哪 | 给谁用 |
|---|---|---|
| 插件工具 | `src/harness/*.js` | 跑着这个插件的会话 |
| 技能 | `~/.agents/skills/harness/harness-evolver/` | 任何装了这个技能的 agent |

两边各有一份层定义和一份校验器。只改一边，另一边就不认——而 `harness/` 的设计目标
恰恰是"没有插件的 agent 也能用"，所以技能必须跟着改，不能只改插件。

## 做法

改布局时同时改四处：

1. 插件：`store.js` 的 `LAYERS` / `REFERENCED_LAYERS`、`validate.js`、`write.js`、`tools.js` 的 enum
2. 技能 `SKILL.md`：四层枚举、"每个 `harness/tool/` 脚本必须…"等硬性约束
3. 技能 `references/command-source.md`：落点规则与 AGENTS.md 模板
4. 技能 `scripts/harness_resource_tool.py`：`LAYERS`、`DOC_LAYERS`、`REFERENCED_LAYERS`、路径正则、`layer == "tool"` 分支

改完用**两边分别校验同一个项目**，都通过才算完成：

```bash
python3 <skill>/scripts/harness_resource_tool.py validate --project-root <项目>
```

## 边界

- 技能里的 `scripts/harness_resource_tool.py` 是**技能自己的**工具目录，不跟着改名
  ——批量替换时要按 `harness/scripts/` 精确匹配，别把 `scripts/` 裸替换了。
- 改布局会让所有**存量五层项目**验不过。它们必须迁移（插件里有 `migrateLayout`，
  会搬目录并改写文档与根索引）。

## 验证

同一份项目，两套校验器：

- 插件：`harness_validate` 返回 `ok: true`
- 技能：`validate` 退出码 0

任一边报错就说明两份契约还没对齐。
