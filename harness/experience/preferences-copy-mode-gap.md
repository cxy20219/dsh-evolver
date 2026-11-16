# 偏好迁移在无软链权限下不同步入口文件

## 现象

Windows 未开开发者模式、或宿主限制创建符号链接时，`fs.symlink` 报 `EPERM`。此时插件的偏好迁移退化为 **copy 模式**：权威文件 `<dataDir>/system/AGENTS.md` 与入口 `~/.dsh/AGENTS.md` 双写。

在这个模式下，**迁移只写了权威文件，没有把入口文件改成迁移后的内容**——入口仍留着旧的受管段标记行（`<!-- ziyan:preferences:begin/end -->`）。结果是：面板显示的是迁移后的全文，DSH 实际读到的还是旧文件，两者不一致。

## 定位

`src/preferences.js` 的 `prepare()`：迁移分支只 `writeFileAtomic(dataPath, content)`；copy 模式真正写入口的动作只发生在 `writePreferences()`（保存时），**读取路径不写入口文件**。

## 影响面

- 表现为 `test/preferences.test.mjs` 的「偏好：迁移现有 AGENTS.md 全文，只删旧受管段标记、内容保留」失败。
- 本机自检闸门把这一条和 rebuild 的符号链接用例归为「环境失败」：没有软链权限时它们必失败，但不是代码回归。
- 真实机器上 `~/.dsh/AGENTS.md` 目前**是**软链（指向 `~/.dsh/ziyan/system/AGENTS.md`），所以线上没踩到；只有退化到 copy 模式的宿主才会。

## 建议（已定位，本轮未修）

1. copy 模式下，`prepare()` 也应把迁移后的内容写进 `copyDestination(agentsPath)`，让入口与权威文件始终一致。
2. 该断言要加平台守卫（与「POSIX 权限位断言必须加平台守卫」同一条约定）：无软链权限的宿主上，应断言「权威文件已迁移」，而不是「入口文件已同步」。
