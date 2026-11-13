---
title: 项目级沉淀怎么量：先看项目文档，再谈 harness_write
summary: 项目级沉淀别只数 harness_write：当天 8/8 会话写卡、4/5 项目更新文档，jubao 13 次直接编辑 harness；无 harness 写卡不新建骨架，提示词只改落点措辞。
---
# 项目级沉淀怎么量：先看项目文档，再谈 harness_write

## 为什么量这个

2026-11-13 用户问「项目级沉淀的主动性是不是不高」。如果只看 `harness_write` 次数，会得出「几乎为零」的结论；把当天所有用户会话拆开后，结论相反：**卡片沉淀 8/8，项目文档 4/5，低的是工具使用率，不是沉淀意愿。**

## 当天口径（用户会话，不含 subagent）

| 项目 | 实质会话 | 成功卡片 | 项目文档动作 | harness_write |
| --- | --- | --- | --- | --- |
| dsh-evolver | 3 | 17 | 3 次 harness_write + `harness.md` 编辑 | 3 |
| dsh-manager | 2 | 8 | README 3 次编辑（18:55 已记录 10 个工具） | 0（无 harness/AGENTS.md） |
| jubao | 1 | 6 | **13 次直接编辑 harness/**（0 次 harness_write，2 次 catalog） | 0 |
| quant | 1 | 2 | 1 个 research README；harness 当天未改 | 0 |
| temp | 1 | 3 | 无（草稿项目） | 0 |

- 8 个实质会话全部至少写入 1 张卡；非插件项目的成功卡片共 17 张。
- 5 个项目里 4 个当天动过项目级文档；唯一没动 harness 的 quant 是研究整理任务，产物是 research README。
- 两个项目根本没有 `harness/` 或 `AGENTS.md`（dsh-manager、temp）；`harness_write` 对它们不是「没被使用」，而是没有落点。
- jubao 有完整 harness，catalog 也调了，却用 13 次 `edit` 更新 harness 文件而不是 `harness_write`。这是工具形态问题：全量重写 + 先 catalog 对「在长文档里补一段」并不顺手。

## 结论与提示词改动

- 不要把 `harness_write` 次数当成项目级沉淀的 KPI；先问项目有没有 harness，再看文档有没有被更新（工具或就地编辑都算）。
- 无 harness 的项目不应该为了「沉淀」自动初始化一套骨架；写带项目名的卡片即可，全局检索和注入会覆盖。
- 原主动性协议写「只在本仓库成立的写 harness_write」：在无 harness 的项目里会被跳过，在有 harness 的项目里又没有说明可以就地编辑。2026-11-13 改成：

  > 每轮答复前：跨项目、库里没有的判断 → card_write（先查重）；本仓库的约定/命令/流程 → 仓库已有 harness/ 或 AGENTS.md 就更新（harness_write 或就地 edit），没有就写卡，不新建 harness。全局 AGENTS.md 只读。

- 体积：主动性协议 844 B → **916 B**（354→404 字），静态段 1276 B → **1348 B**（+72 B，约 +18 token/请求；静态段进前缀缓存，只在发版时失效一次）。
- 守卫：`test/proactive.test.mjs` 断言 `harness/ 或 AGENTS.md` 与 `不新建 harness`，总字节仍 <1024。

## 后续怎么量

下一个观察窗口按「实质会话（≥10 次编辑）」统计三件事，而不是单看 harness_write：

1. 项目文档是否被更新（`harness_write` 或 `edit`/`write` 到 `harness/`、`AGENTS.md`、README 均可）；
2. 有没有在无 harness 的仓库里擅自初始化（目标 0）；
3. 项目约定/命令/流程是否至少落到一处（项目文档或带项目名的卡片）。

只有第 1、3 项长期为 0 且用户明确要求项目沉淀时，才值得继续加重提示词；否则加压力只会制造重复文档。
