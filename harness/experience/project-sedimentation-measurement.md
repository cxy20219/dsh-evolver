---
title: 项目级知识必须进项目 harness，不能退化成全局卡
summary: 项目级知识必须进项目 harness：manager/quant 当天未落 harness 是真缺口，jubao 13 次直接编辑算落点但绕过工具；提示词改为无 harness 先初始化、不要塞进全局卡。
---
# 项目级知识必须进项目 harness，不能退化成全局卡

## 结论（第一版写错，已纠正）

只看 `harness_write` 次数会低估沉淀，但**不能因此把项目级知识塞进全局卡**。项目级 harness 存在的意义就是承载“只在本仓库成立”的约定、命令、流程和判断；没有 harness 时正确动作是**初始化一套**，不是把知识降级到全局卡。

2026-11-13 第一版提示词写成了“没有 harness 就写卡，不新建 harness”，用户当场指出：这正是项目级 harness 要解决的问题。该版本已撤回。

## 当天实际落点（用户会话，不含 subagent）

| 项目 | 实质会话 | 成功写卡 | 项目级落点 | 判断 |
| --- | --- | --- | --- | --- |
| dsh-evolver | 3 | 17 | 3 次 harness_write + `harness.md` 编辑 | ✅ 项目 harness |
| dsh-manager | 2 | 8 | README 3 次编辑；**没有 harness，也没有初始化** | ❌ 项目级缺口 |
| jubao | 1 | 6 | **13 次直接编辑 harness/** | ✅ 有落点（但绕过工具） |
| quant | 1 | 2 | 1 个 research README；harness 当天未改 | ⚠️ 未落到 harness |
| temp | 1 | 3 | 无 | 草稿项目，另说 |

- 8/8 实质会话都写了卡，但其中 manager 的搜索架构、quant 的研究约定属于项目级知识；卡是全局索引，不能替代项目 harness。
- manager 没有 `harness/` 或 `AGENTS.md`，`harness_write` 不是“没有落点”，而是**应该先 `harness_catalog({init:true})` 建骨架**。它最终把 10 个工具写进了 README，项目 harness 仍为空。
- jubao 有完整 harness，`harness_catalog` 也调了，却用 13 次 `edit` 直接改 `harness/harness.md`、`experience/`、`workflow/`。这算项目级沉淀，但不会自动重建 AGENTS.md 索引，属于工具形态问题，不能反过来证明“卡就够了”。

## 现在的规则

> 每轮答复前：跨项目、库里没有的判断 → card_write（先查重）；只在本仓库成立的判断/约定/命令/流程 → 写进本仓库 harness（没有 harness 就先 harness_catalog({init:true}) 建骨架，再 harness_write，不要塞进全局卡）。全局 AGENTS.md 只读。

- **全局卡**：跨项目可复用、换一个仓库仍成立的判断。
- **项目 harness**：只在本仓库成立的判断、约定、命令、流程；有骨架就更新，没有骨架就初始化。
- 项目级知识写进全局卡会让其他项目误读，也丢掉了项目内的索引、校验和生命周期。
- 已有 harness 的项目可以就地 `edit`，但优先 `harness_write`（自动重建 AGENTS.md 索引、自动校验）。

## 体积与守卫

- 主动性协议 844 B → **951 B**（354→425 字）；静态段 1276 B → **1383 B**（+107 B，约 +26 token/请求；静态段进前缀缓存，只在发版时失效一次）。
- `test/proactive.test.mjs` 断言 `/harness_catalog\(\{init:true\}\)/` 与 `/不要塞进全局卡/`，并保持总字节 <1024。

## 后续怎么量

对每个「实质会话（≥10 次编辑）」统计：

1. 是否产生只在本仓库成立的知识；
2. 有则是否落到项目 harness（`harness_write`、就地编辑、或新建骨架都算）；
3. 项目级知识被写进全局卡的次数，目标 **0**；
4. 无项目知识时是否仍新建 harness，目标 **0**（避免草稿仓库被乱初始化）。

如果第 2 项持续为 0，先修 `harness_write` 的局部更新能力（目前全量重写），不要靠继续加提示词压力。
