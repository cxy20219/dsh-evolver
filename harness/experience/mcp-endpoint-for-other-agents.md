# 给别的 agent 开 MCP 端点：协议子集与两个坑

## 适用场景

要让**另一个 agent**（另一个 DSH 实例、Claude Code、桌面客户端）用上本插件的能力，而不是让本插件的模型用。自衍中枢的做法：`src/mcp/server.js` 手写 Streamable HTTP 服务端，暴露既有的四个库动词，设置 → 服务里开关。

## 协议子集（够用即可）

`POST /mcp`，一条 JSON-RPC 2.0 一条 JSON 回复，无状态、不发 `Mcp-Session-Id`：

| 方法 | 回复 |
|---|---|
| `initialize` | `{protocolVersion, capabilities:{tools:{listChanged:false}}, serverInfo, instructions}` |
| `notifications/initialized` | **202 无响应体**（通知没有 id，回复会破坏握手） |
| `tools/list` | `{tools:[{name, description, inputSchema, annotations:{readOnlyHint}}]}` |
| `tools/call` | `{content:[{type:'text', text}], isError?}` |
| `ping` | `{}` |
| `GET /mcp` | 405（不提供服务端推送流，规范允许） |
| `DELETE /mcp` | 204 |

**回显客户端的 `protocolVersion`**，不要钉死常量：客户端的 SDK 会进步到比你的文件更新的版本，回显它提议的版本比拒绝更能兼容。

**工具报错走 `isError: true` 的内容，不要走 JSON-RPC error**：远端模型要读到你的具体原因（「需要会话工作目录」「路径越界」）才能自纠；包成传输错误就把原因藏起来了。

## 两个坑

### 一、面板的 `error` 是保留字

`callHost` 的判定是 `value.error !== undefined` 即抛错。业务响应里放一个 `error: ''` 会让**每次读取都走失败分支**，而 HTTP 明明是 200——面板永远显示默认值，排查时极易误判成「端点没返回数据」。

字段改名（`problem` / `failure` / `reason`）即可。**新增端点时检查返回对象的键名，`error` 不能用。**

### 二、监听端口 0 ≠ 上报端口 0

`server.listen(0)` 让系统分配端口，但 `status()` 若回报调用方传入的 `0`，客户端就连不上。`created.address().port` 才是实际端口；测试里用 0 时尤其要注意。

## 安全默认

- **只绑 `127.0.0.1`**，不提供绑公网的选项。
- **强制令牌**：首次启动生成，`Authorization: Bearer` 与 `?token=` 都认（有些客户端设不了 header）。用常数时间比较，避免时序泄漏。
- **能力最小化**：MCP 调用没有会话就没有工作目录，项目路径一律拒绝，只给库能力；不要替远端猜 cwd，否则它会写进「它以为的」那个目录。

## 验证方式

起真实监听端口、按客户端方式说话走一遍，比只测 dispatch 有用：握手 → 列工具 → 真调一次写入与检索 → 关掉后端口真的拒绝连接（`ECONNREFUSED`）。

## 关联

- 工具描述必须露出能力矩阵：`harness/experience/tool-contract-visibility.md`。
- 载荷要能被对方解析：`harness/experience/payload-must-stay-parseable.md`。
- 设计与取舍全文见仓库 `DESIGN.md` 第 32 节。
