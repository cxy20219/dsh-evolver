# 写 harness 资源并验证索引

## 适用场景

往项目的 `harness/` 里加东西：一条稳定流程（workflow）、一条可复用经验（experience）、一个可执行脚本（tool）、一份工具要读的资料或模板（resources）；以及改了 `harness/` 里已有资源之后。

## 前置条件

- 会话工作目录在本项目内（`harness/...` 锚定**项目根**，不是会话 cwd；项目根是第一个含 `.git` / `harness` / `AGENTS.md` 的目录）。
- 宿主进程跑的是当前分支的代码：宿主侧改动（`index.js`、`src/**`）要重启 DSH 才生效，`client.js` 刷新面板即可。

## 参数与命名

用 `file_write`，`target` 指向 `harness/` 下的资源路径：

| 约定 | 说明 |
|---|---|
| `meta.description` | 必填。写清「它是什么」+「以后哪些场景、任务、问题会用到它」，≤160 字，不能是占位词 |
| `meta.title` | 可选，索引里显示的标题 |
| `meta.tags` / `meta.links` | **不能传**——那是文件库的字段，harness 资源用 description + title |
| 文件名 | workflow / experience 层只能直接放在层目录下，不支持多级目录；文件名只允许小写英文、数字、`.` `_` `-`，以 `.md` 结尾 |
| `.meta.json` | 边车由插件维护，不要手写 |

## 插件自动做的四步

一次写入是一个整体，插件在同一个项目锁里依次做完：

1. **建骨架** —— 缺 `harness/harness.md` 或四层目录就补上（幂等）；
2. **写资源 + 写边车** —— 正文落盘，旁边生成 `<文件>.meta.json`（`{schema,title,description}`）；
3. **重建索引** —— 扫 `harness/` 目录，按目录状态渲染整份 `AGENTS.md`（固定两行头 + 每个资源一条），原子写入；
4. **校验** —— 结构、索引与目录是否一致、引用完整性、Python 语法。**校验不过 → 资源文件、边车、AGENTS.md 一起回滚**，报错并说明失败项。

## 四个陷阱

1. **手写的 AGENTS.md 会被备份而不是合并**：插件认出它是手写文档时，先备份成 `AGENTS.legacy-<hash>.md`，再按目录重建为索引。**手写内容就此离开注入**——必须先把它搬进 `harness/harness.md`，否则下一个会话读不到那些约束。
2. **文档里写的 `harness/...` 路径必须真实存在**，否则整轮回滚（引用完整性是错误，不是警告）。所以**先写被引用的文件，再写引用它的文件**。
3. **索引必须与目录一致**：`AGENTS.md` 逐字节等于按目录渲染的结果。手改 AGENTS.md 或在插件外增删资源，都会让校验报「AGENTS.md 与 harness/ 不一致」；再写一次 harness 资源即可重建。
4. **tool / resources 层的每个文件要有描述**，否则给出警告（它仍然进索引，但读者无从检索）；最好再被一篇 workflow / experience 文档覆盖——文档里要出现该路径、围栏代码块里要有代表性命令、并带「验证」标记，否则也是警告。

## 验证

改完 harness 资源或宿主代码后跑这个闸门，它一次做完语法检查、harness 结构与索引一致性校验、全量测试：

```bash
node harness/tool/verify-repo.mjs
```

判读：出现 `自检通过：语法、harness 结构、测试都绿。` 且退出码 0 才算过；`harness 校验失败：…` 是错误（会回滚），`警告：…` 不阻断但要读。

也可以随时看当前 harness 清单与索引状态：

```text
file_read({target: "harness/"})
```

`index.mode` 为 `index` 表示 AGENTS.md 是生成的索引；`handwritten` 表示它还是手写文档（插件会在下次写入时备份并重建）；`notIndexed` / `pointingNowhere` 是索引与目录的差集。

## 失败回退

- 写入报「校验未通过，已回滚：…」→ 目标资源、边车、AGENTS.md 都已还原；按报错的第一条错误改内容后重写。
- 报「引用了不存在的资源」→ 先把被引用的文件写出来，再重写这篇。
- 报「文件名不合法」→ workflow / experience 的文件名必须是 slug。

## 最近验证

2026-11-15：本流程在自衍中枢仓库首次落地时按此顺序写入 1 个 tool、2 个 experience、1 个 workflow、1 个 overview，逐次校验通过，索引最终 5 条。
