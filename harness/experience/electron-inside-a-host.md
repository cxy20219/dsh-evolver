# 在宿主应用里启动 Electron：两个环境变数与一个模块系统陷阱

## 现象

`npm run desktop` 起的 Electron 窗口，代码明明正确，却依次踩到三个失败：

1. `SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'`
2. `TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')`
3. `Failed to create SingletonLock: Operation not permitted` + `sandbox initialization failed`

## 根因

### 1. `ELECTRON_RUN_AS_NODE=1`

从 DSH 这类 Electron 宿主里启动子进程时，环境里带着这个变量。它让 Electron **作为纯 Node 运行**：不注入 `electron` 内置模块，`--version` 输出的是 Node 版本（v24.18.1 而不是 v43.3.0）。

判断方法：`env | grep ELECTRON_RUN_AS_NODE`；或看 `--version` 输出的是 Node 版本还是 Electron 版本。

修法：`env -u ELECTRON_RUN_AS_NODE <electron> ...`。**这不是最终用户的问题**——普通终端里没有这个变量，只有被宿主拉起的进程才有。

### 2. Electron 的 ESM 具名导入不成立

项目是 `"type": "module"`，主进程写成 ESM 后：

```js
import { app, BrowserWindow } from 'electron'   // ✗ 具名导出解析不到
import electron from 'electron'                  // ✗ 拿到的是 npm 包的路径字符串
```

npm 的 `electron` 包导出一个**路径字符串**（指向 dist 里的二进制），Electron 运行时才把它劫持成内置模块——而劫持发生在 CJS 的 `require` 上，ESM 的具名导出检测看不到。

修法：**主进程用 CommonJS**（`main.cjs`），ESM 的业务模块用动态 `import()`：

```js
const { app, BrowserWindow } = require('electron')
async function boot() {
  const { startService } = await import('./server.js')   // ESM 照样能用
}
```

### 3. Chromium 沙箱与宿主文件沙箱冲突

`SingletonLock` 写不进 `~/Library/Application Support/Chromium`，且 `sandbox initialization failed`——宿主已经在一个文件沙箱里跑了内部进程，Chromium 自己的沙箱无法初始化。

修法（仅限这种受限环境）：

```bash
Electron main.cjs --no-sandbox --user-data-dir=/tmp/....

```

**发布给终端的应用不要带 `--no-sandbox`**，那会真的降低安全性。它只是「在沙箱里再开一个沙箱」时的临时开关。

### 4. 沙箱里 `npm install electron` 装不上

`@electron/get` 会把下载的 zip 写进 `~/Library/Caches/electron/<hash>/`。在文件沙箱里这一步是 `EPERM`，表现是 `Electron failed to install correctly`，而 `npm install` 本身**返回成功**——依赖树装好了，二进制没有。

修法（仅限自己验证时）：把已缓存版本的 zip 手动解压到 `node_modules/electron/dist/`，并写入 `path.txt`：

```bash
mkdir -p node_modules/electron/dist
unzip -q -o ~/Library/Caches/electron/<hash>/electron-v43.3.0-darwin-arm64.zip -d node_modules/electron/dist
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
```

验证只看一件事：`Electron --version` 必须输出 Electron 版本（`v43.3.0`），输出 Node 版本说明它退化成了纯 Node（见第 1 条）。

版本要选**缓存里已有的**：改 `package.json` 的 `electron` 到那个版本，比重新下载 100 MB 快得多。

## 边界

- 三个坑都只在「Electron 被另一个 Electron/沙箱拉起」时出现。终端里 `npm run desktop` 是干净的。
- `ELECTRON_RUN_AS_NODE` 是**继承来的**，不会被覆盖；必须显式 `env -u` 或 `delete process.env`。
- 判断 Electron 是否真的在跑，只看 `--version` 不够（Node 也能输出），要看它是否返回 `v43.3.0` 这类 Electron 版本号。

## 关联

- 独立宿主的装配方式：`desktop/README.md`
- 核心与宿主的边界：`harness/experience/library-scope-decoupled-from-projects.md`
