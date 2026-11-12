---
title: 插件改动后的验证顺序
summary: 改完插件的标准验证顺序：语法单测→重启或刷新→真实界面→接口字段核对
---
# 插件改动后的验证顺序

## 适用场景

改了本插件的宿主代码（`index.js`、`src/`）或浏览器代码（`client.js`）之后。

## 为什么不能省

两边生效方式不同，顺序错了会拿旧进程的结论当新代码的证据：

| 改了哪半边 | 生效方式 |
|---|---|
| 宿主 `index.js` / `src/**` | **必须重启 DSH**，否则跑的还是旧进程 |
| 浏览器 `client.js` | 刷新面板即可 |

## 步骤

1. 语法与单测（每个改动的文件都过一遍）：

```bash
node --check index.js
node --test test/harness.test.mjs
node --test test/contract.test.mjs   # 改过接口清单/调用时先跑这条：三方同集合
npm test
```

2. 改过宿主就重启；改过客户端就刷新面板。

3. 在**真实界面**里走一遍受影响的操作。接口层用 curl 直接打，确认返回的是新字段：

```bash
curl -s -X POST -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:<端口>/api/evolver/overview
```

4. 新增接口时确认三处都登记了：`src/remote.js` 的 `ENDPOINTS`、`createEvolverHandler` 的 switch、`client.js` 里的 `call('<name>')`。少一处就是 404 或面板永远不调用；`test/contract.test.mjs` 会静态断言三处同集合。

## 验证

成功信号：`npm test` 全绿，且重启后接口返回里能看到新加的字段。
失败信号：接口 404 / `unknown-endpoint`（漏登记），或界面行为与旧版一致（宿主没重启）。
