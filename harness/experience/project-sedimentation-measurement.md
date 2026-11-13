---
title: 项目级知识必须进项目 harness，不能退化成全局卡
summary: 项目级知识必须进项目 harness：新提示词生效后 manager 仍只写卡不初始化，catalog 空状态补 needsInit/next；manager 已补 3 条 harness，验证 183/183。
---
# 项目级知识必须进项目 harness，不能退化成全局卡

## 结论

只看 `harness_write` 次数会低估沉淀，但**不能因此把项目级知识塞进全局卡**。项目级 harness 存在的意义就是承载“只在本仓库成立”的约定、命令、流程和判断；没有 harness 时正确动作是**初始化一套**，不是把知识降级到全局卡。

2026-11-13 第一版提示词写成了“没有 harness 就写卡，不新建 harness”，用户指出这正是项目级 harness 要解决的问题，已撤回。

## 新证据：20:39 会话仍然没落 harness

`session-843fbd67`（管理器搜索集成，2,065 个事件、256 次 bash、9 次 `card_write`）是在新提示词生效后结束的：

- 会话日志里新提示词出现 7 次，说明不是提示词没下发；
- 它调用过 `harness_catalog` 一次，返回 `harness:false`、`agents:false`；
- 之后只把“37 渠道”更新写进全局卡 `72RWX`，**没有初始化，也没有 `harness_write`**；
- 项目 README 在 20:23 更新了 37 渠道、智能路由、安全搜索等，但项目 harness 仍为空。

结论：**静态提示词不会在长会话里稳定触发项目级动作**。catalog 是模型正在决定“知识放哪”的时刻，应该在这里给动作，而不是只在系统段写一句规则。

## 当天实际落点（用户会话，不含 subagent）

| 项目 | 实质会话 | 成功写卡 | 项目级落点 | 判断 |
| --- | --- | --- | --- | --- |
| dsh-evolver | 3 | 17 | 3 次 harness_write + 总览编辑 | ✅ |
| dsh-manager | 2 | 8 | README 3 次编辑；无 harness | ❌（现已补 harness） |
| jubao | 1 | 6 | 13 次直接编辑 harness | ✅（绕过工具） |
| quant | 1 | 2 | 1 个 research README；harness 未改 | ⚠️ |
| temp | 1 | 3 | 无 | 草稿项目，另说 |

## 已做的两层修正

1. **提示词落点**：跨项目判断 → `card_write`；只在本仓库成立的判断/约定/命令/流程 → 写进本仓库 harness（没有就先 `harness_catalog({init:true})` 建骨架，再 `harness_write`，不要塞进全局卡）。
2. **工具级护栏**：`harness_catalog` 在 `harness:false` 时返回
   - `needsInit: true`
   - `next: '项目没有 harness/。本轮若有只在本仓库成立的判断/约定/命令/流程，先再次调用 harness_catalog({init:true}) 建骨架，再 harness_write；不要写进全局卡。'`

   这条提示出现在模型已经调用 catalog、正在做决定的时刻，比系统段更靠近动作。

## dsh-manager 的补建结果

用本插件初始化并写入 3 条资源：

- 项目总览：结构、测试与设置位置、热重载方式；
- 搜索集成流程：定位、四层同步、验证顺序、提交前检查；
- 搜索集成踩坑：timeRange 丢失、research schema 漂移、surrogate 截断、渠道报错、预算/抓取链、宿主热重载。

`harness_validate` 通过（3 个资源，索引齐全）；管理器 `npm test` 183/183 通过。这几个文件目前是 untracked，尚未提交到 dsh-manager 仓库。

## 体积与守卫

- 主动性协议 844 → **951 B**（354→425 字）；静态段 1276 → **1383 B**（+107 B，约 +26 token/请求；静态段进前缀缓存，只在发版时失效一次）。
- `test/proactive.test.mjs` 断言 `harness_catalog({init:true})` 与“不要塞进全局卡”。
- `test/harness.test.mjs` 新增“没有 harness 时 catalog 直接给出初始化动作”，断言 `needsInit` 与 `next`。

## 后续怎么量

对每个「实质会话（≥10 次编辑）」统计：

1. 是否产生只在本仓库成立的知识；
2. 有则是否落到项目 harness（`harness_write`、就地编辑、或新建骨架都算）；
3. 项目级知识被写进全局卡的次数，目标 **0**；
4. 无项目知识时是否仍新建 harness，目标 **0**。

如果 catalog 已经返回 `needsInit` 但仍持续不初始化，下一步不是再加提示词，而是让 `harness_write` 在无骨架时自动初始化（或让 `card_write` 对项目级内容给出警告），把“知道”变成“做不到也得做”。
