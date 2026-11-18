# 插件的返回值是 effect，不是数据

## 现象

改完插件后重启 DSH，面板还能加载、页签也是新版，但每个请求都返回 **HTTP 404**。

插件日志看起来完全正常：

```
MCP 服务已启动 http://127.0.0.1:3199/mcp（4 个工具）
面板接口 26 个，前缀 /api/ziyan
自衍中枢 0.2.0：数据目录 /Users/…/.dsh/ziyan
MCP 服务已停止          ← 同一毫秒
```

**最后一行是线索**：apply 刚跑完就 dispose 了，所以注册过的 26 条路由立刻被注销，之后的请求自然 404。但「注册成功」的日志已经打完了，看日志会误以为一切正常。

## 根因

cordis 把插件函数的返回值当作 **effect** 处理（`fiber.ts` 的 `_execute`）。合法形状只有四种：

| 返回值 | 处理 |
|---|---|
| 函数 | 当作 cleanup 收集 |
| `null` / `undefined` | 忽略 |
| thenable | 等它 resolve，再对**结果**做同样的判断 |
| 迭代器（同步/异步） | 逐个收集 |

**其他任何值——包括普通对象——直接抛 `TypeError('Invalid effect')`**，插件加载失败并整体回滚。

```js
export async function apply(ctx, config) {
  …
  return { root, store, settings }   // ✗ Promise resolve 成对象 → Invalid effect
}
```

注意 async 函数也躲不掉：它返回的是 Promise（合法），但 Promise **resolve 出来的值**还要再过一次判断。

## 为什么隐蔽

- 错误发生在插件装配的最后一刻，此时所有 `ctx.effect` / `connection.fetch.register` 都已执行，日志已打印。
- 回滚是「正确行为」：路由被干净地注销，所以外部只看到 404，看不到错误。
- DSH 把这个错误记在宿主 logger 里，不写进插件自己的日志 sink。

## 修法

插件函数不返回任何东西。需要把装配产物交给测试或别的调用方时，走别的通道：

- 测试自己开一份同一目录的 `store`（顺带证明磁盘就那一份）；
- 或者把状态挂到 service / 另一个可注入对象上。

**不要**为了让测试方便给 `apply` 加返回值——代价是整个面板的 26 条路由。

## 边界

- 返回**函数**是唯一安全的"有返回值"形态，它会被当作 cleanup，适合 `const dispose = await apply()` 这类用法。
- 这个规则与业务框架无关，是 cordis 的 effect 协议；同样适用于 `ctx.plugin()` 加载的任何插件。
- 排查「插件日志正常但功能全 404」时，先看日志最后有没有异常的 dispose 记录，再看插件函数是否返回了非函数值。

## 关联

- 独立宿主的装配：`desktop/README.md`
- 在宿主里跑 Electron 的其它环境坑：`harness/experience/electron-inside-a-host.md`
