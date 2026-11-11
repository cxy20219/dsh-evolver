---
title: 探针不能挂在请求路径上
summary: 状态接口现场探针 410ms；改成缓存 60 秒 + 后台刷新后 6.7ms
---
# 探针不能挂在请求路径上

## 现象

面板每次加载要等 `ingest-status`。实测 **410 ms**，而同一屏的 `overview`、
`card-list` 都是 7–10 ms。慢 40 倍的接口，把整页 spinner 拖住了。

## 根因

`status()` 每次被调用都现场探针：

```js
const probe = await probeSessions({ query, ledger, ... })   // 列出全部会话 + 逐个 listEvents
pending = probe.pending
```

这是「读一次实时状态」的实现，而面板需要的是「一个不太旧的数字」。
两件事被写成了同一个动作。

## 做法

缓存 + 后台刷新，面板永远不等待：

```js
const PROBE_TTL_MS = 60_000
let cachedProbe = { at: 0, pending: null }
let probing = null

// status():
const stale = now() - cachedProbe.at > PROBE_TTL_MS
if (stale && cachedProbe.pending === null) pending = await probePending()  // 首次没有缓存，只能等
else {
  pending = cachedProbe.pending
  if (stale) void probePending()                                          // 其余情况后台刷
}
```

改造后 `ingest-status` 从 **410 ms 降到 6.7 ms**，和别的接口对齐。

## 边界

- 首次调用没有缓存，仍会等一次；介意的场景可以在插件启动时预热。
- 数字最多旧 60 秒。对「有多少会话待整理」这种量级的判断，秒级陈旧不影响决策；
  如果哪天要精确到实时，应该改成推送而不是拉取。
- 探针本身要防并发（`probing !== null` 时复用同一个 promise），否则定时器和面板会各跑一份。

## 验证

同一台机器、同一份数据，比较接口耗时：

```bash
curl -s -o /dev/null -w '%{time_total}\n' -b <cookie> \
  -X POST -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:<端口>/api/evolver/ingest-status
```

成功信号：耗时和 `overview` 同量级（个位数毫秒）。失败信号：仍然几十倍于其它接口。
