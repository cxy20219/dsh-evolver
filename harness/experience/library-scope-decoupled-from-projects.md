# 为什么把项目 harness 从自衍中枢里解耦出去

## 现象

自衍中枢原本托管项目的 `harness/`：写入时自动建骨架、写同名边车 `<文件>.meta.json`、按目录重建项目根 `AGENTS.md` 索引、校验结构与引用完整性，失败整体回滚。

跑了三天，暴露出四件事：

1. **外部工具会绕道**。opencode 按 skill 直接改 `harness/` 里的正文，不写边车、不重建索引——改完描述就与正文脱节了。
2. **插件会接管不该插手的目录**。`/Volumes/lvcheng/简历` 原本被约定为只读素材目录，但在那里开一次会话，插件就自动建了 `AGENTS.md`、`harness/` 四层和边车。
3. **契约成了摩擦**。11-17 的 8 次工具失败里有 4 次是「没写 `meta.description`」「顶层平铺了 description」「给 harness 资源传了 tags」——全是让外部工具懂插件契约的成本。
4. **真正的价值只有一条**：`AGENTS.md` 索引与目录始终一致。其余（边车、四层目录、校验回滚）都在为一个不属于插件的问题付代价。

## 判断

插件的职责应该收敛成一句话：**存有价值的文件、需要时找得出、agent 读出来就能直接用**。项目内的知识不属于「存文件」这件事——它是项目自己的资产，用什么结构、由谁维护，应该由项目和它的 skill 决定。托管它，等于让一个存储插件去裁决别人项目的知识组织方式。

## 做法（解耦后的边界）

| 谁 | 负责 |
|---|---|
| **项目的 skill / 任何 agent / 编辑器** | 写 `harness/**/*.md` 正文。用什么目录结构（四层、单文件、别的）都行 |
| **项目自己** | 维护项目根的 `AGENTS.md`（它仍是 DSH 注入的入口，但插件不再生成也不拒绝手写） |
| **自衍中枢** | 库文件的存储、检索（描述/标签/links）、读出来即用；`file_write({from})` 把项目文件复制进库 |

**删掉的**：`src/harness/`（write/validate/sidecar/store 共 1835 行）、`file_read("harness/")` 清单哨兵、`meta.title`/`meta.layer`、写 `harness/` 时的边车与索引重建、`AGENTS.md` 手写拒绝、项目根 `AGENTS.md` 的备份与重建。

**留下的**：`src/project.js` 里的 `projectRootOf` 与 `isWithin`——项目路径仍要锚定一个稳定的根，仍然不许写出项目根之外。

## 失去的东西（明确记下，避免以后重新发明）

- **索引一致性保证**：`AGENTS.md` 与目录不再自动对齐，需要项目自己维护。
- **引用完整性校验**：文档里写 `harness/tool/ghost.py` 不会再被拦下。
- **写入即检索**：项目文件不再有描述，`file_search` 搜不到项目内知识（它本来也搜不到，只是以前有索引兜底）。

这三条都是项目自己的责任了。**如果哪天觉得「项目知识也得能搜」，正确做法是项目把值得跨项目复用的部分写进库，而不是把 harness 托管重新加回来。**

## 边界

- 解耦的是**写入与所有权**，不是「项目不该有 harness」——四层结构仍然是本项目在用的好结构，只是不再由插件代劳。
- 库里仍建议 `来源/harness` 标签，那是**来源标记**，不表示插件还在管 harness。
- 给别人用 MCP 时同理：只暴露库能力，项目路径需要会话工作目录，远端一律拒绝。

## 关联

- 工具描述要露出能力矩阵：`harness/experience/tool-contract-visibility.md`
- 载荷要能被对方解析：`harness/experience/payload-must-stay-parseable.md`
- 给别的 agent 开 MCP：`harness/experience/mcp-endpoint-for-other-agents.md`
