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

## 还没有接的

- **整理引擎**（`自衍` 页签）：需要 LLM，宿主装配里还没有。调用会得到明确的「整理引擎不可用」。
- **注入段字段**：面板「注入」页仍显示静态纪律文本，但没有宿主去注入它——这段文字现在只是展示。
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
