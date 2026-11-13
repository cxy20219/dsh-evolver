---
title: 项目级知识必须进项目 harness，不能退化成全局卡
summary: 项目级知识必须进项目 harness：新提示词生效后 manager 仍只写卡不初始化，catalog 空状态补 needsInit/next；不代补，留给新会话观察自主建 harness。
---
# 项目级知识必须进项目 harness，不能退化成全局卡

## 结论

只看 `harness_write` 次数会低估沉淀，但**不能因此把项目级知识塞进全局卡**。项目级 harness 存在的意义就是承载“只在本仓库成立”的约定、命令、流程和判断；没有 harness 时正确动作是**初始化一套**，不是把知识降级到全局卡。

2026-11-13 第一版提示词写成了“没有 harness 就写卡，不新建 harness”，用户指出这正是项目级 harness 要解决的问题，已撤回。

## 证据：20:39 会话仍然没落 harness

`session-843fbd67`（管理器搜索集成，2,065 个事件、256 次 bash、9 次 `card_write`）是在新提示词生效后结束的：

- 会话日志里新提示词出现 7 次，说明不是提示词没下发；
- 它调用过 `harness_catalog` 一次，返回 `harness:false`、`agents:false`；
- 之后只把“37 渠道”更新写进全局卡 `72RWX`，**没有初始化，也没有 `harness_write`**；
- 项目 README 在 20:23 更新了 37 渠道、智能路由、安全搜索等，但项目 harness 仍为空。

结论：**静态提示词不会在长会话里稳定触发项目级动作**。catalog 是模型正在决定“知识放哪”的时刻，应该在这里给动作，而不是只在系统段写一句规则。

## 已做的修正

1. **提示词落点**：跨项目判断 → `card_write`；只在本仓库成立的判断/约定/命令/流程 → 写进本仓库 harness（没有就先 `harness_catalog({init:true})` 建骨架，再 `harness_write`，不要塞进全局卡）。
2. **工具级护栏**：`harness_catalog` 在 `harness:false` 时返回
   - `needsInit: true`
   - `next: '项目没有 harness/。本轮若有只在本仓库成立的判断/约定/命令/流程，先再次调用 harness_catalog({init:true}) 建骨架，再 harness_write；不要写进全局卡。'`

   这条提示出现在模型已经调用 catalog、正在做决定的时刻，比系统段更靠近动作。

## 没有代补：留给新会话观察

我起初给 dsh-manager 补建了 3 条 harness 资源，用户明确要求**不要代补**，要观察新会话能否自己建立。已回滚：

- 删除 `AGENTS.md`、`harness/` 以及初始化留下的空目录；
- dsh-manager 基线回到“没有项目 harness”；搜索代码提交 `d4287cb` 和 README 修正 `616b3cf` 保留，本地 **ahead 2、未推送**；
- 使用本插件的 catalog 时需要重启宿主，才能看到新增的 `needsInit`。

### 观察实验

1. 重启 DSH（加载 `needsInit`）；
2. 在 dsh-manager 新开一个会话，做一次会产生项目级知识的任务；
3. 期望顺序：`harness_catalog` → `needsInit:true` → `harness_catalog({init:true})` → `harness_write`；
4. 成功判据：项目出现 `AGENTS.md` + `harness/`，且项目级知识没有被写进全局卡；
5. 失败判据：只写全局卡、或 catalog 后没有初始化；若连续失败，下一步改 `harness_write` 自动初始化，而不是继续加提示词。

## 当天实际落点（用户会话，不含 subagent）

| 项目 | 实质会话 | 成功写卡 | 项目级落点 | 判断 |
| --- | --- | --- | --- | --- |
| dsh-evolver | 3 | 17 | 3 次 harness_write + 总览编辑 | ✅ |
| dsh-manager | 2 | 8 | README 3 次编辑；无 harness | ❌（观察中） |
| jubao | 1 | 6 | 13 次直接编辑 harness | ✅（绕过工具） |
| quant | 1 | 2 | 1 个 research README；harness 未改 | ⚠️ |
| temp | 1 | 3 | 无 | 草稿项目，另说 |

## 体积与守卫

- 主动性协议 844 → **951 B**（354→425 字）；静态段 1276 → **1383 B**（+107 B，约 +26 token/请求；静态段进前缀缓存，只在发版时失效一次）。
- `test/proactive.test.mjs` 断言 `harness_catalog({init:true})` 与“不要塞进全局卡”。
- `test/harness.test.mjs` 新增“没有 harness 时 catalog 直接给出初始化动作”，断言 `needsInit` 与 `next`。
