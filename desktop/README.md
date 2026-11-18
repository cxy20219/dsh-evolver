# 自衍中枢 · 独立桌面版

同一套库、同一套面板，不依赖 DSH 运行。

## 两条启动方式

```bash
npm run desktop              # Electron 窗口
npm run serve                # 纯本地服务，浏览器访问
```

带参数：

```bash
npm run desktop -- --data-dir /path/to/library
node desktop/server.js --data-dir /path/to/library --port 3198
```

不传 `--data-dir` 时用 `~/.ziyan`。想继续用 DSH 里那份库，指向它即可：

```bash
npm run desktop -- --data-dir ~/.dsh/ziyan
```

## 它复用的是什么

没有重写任何逻辑，三条都是现成的：

| 层 | 文件 | 说明 |
|---|---|---|
| 存储 | `src/store.js` + `src/db.js` | 只吃一个 `dataDir`，与宿主无关 |
| API | `src/remote/index.js` | `createZiyanHandler` 是纯函数 `(endpoint, payload) => Promise` |
| 界面 | `client.js` | 通过 `desktop/renderer/shim.js` 提供它要的四个宿主服务 |

`desktop/server.js` 只做 DSH 以前做的那件装配事：开库、接卫星、用 HTTP 同时伺服 JSON API 和浏览器半边。

`desktop/renderer/shim.js` 提供 `__ModuleLoader__`、`slots`、`locale`、`connection` 四个宿主服务。**它决定组件渲染在哪，不决定数据是什么**——数据仍走 `/api/ziyan/<endpoint>`。

## 内置的整理引擎

`自衍` 页签跑的是同一个 organize 循环，模型路由由「设置 → 模型」配置：

| 字段 | 说明 |
|---|---|
| 接口地址 | 任何 OpenAI 兼容的 `/chat/completions`，默认 `https://api.openai.com/v1` |
| 密钥 | 只写不读——面板只报「已配置/未配置」，保存时留空表示不修改 |
| 模型名 | 端点不提供 `/models` 时，这就是唯一可选的模型 |

保存后立即生效（适配器每次调用都重读配置，不靠重启）。「测试连接」会把「密钥错」和「模型名错」分开告诉你。

**没有密钥也能用**：库照常打开、面板照常工作，只有发起整理时会明确报出原因。

本地模型（llama.cpp / Ollama / LM Studio）填各自的地址即可，密钥留空。

## 还没有接的

- **会话整理**：独立版没有 DSH 的会话存储，`sessions` 模式扫到的是空目录，真正生效的是 `files` 模式（给文件补描述、打标签、建链接）。
- **工具注册**：这个进程不是 agent，不向任何模型注册工具；需要工具的是 MCP 客户端。

## 库目录

```
<dataDir>/
├─ files/<id>/
│  ├─ meta.json      ← 元数据（事实）
│  └─ note.md        ← 正文（事实）
└─ system/           ← 不要用同步盘同步
   ├─ ziyan.db       ← SQLite 索引，可删可重建
   ├─ library.json   ← 数据目录指针
   └─ logs/
```

**`system/` 必须排除在任何同步之外**：SQLite 放在同步盘或网络卷上，多设备同时打开会损坏数据库。索引随时可重建（165 个文件约 25 ms），所以每台设备各建各的。
