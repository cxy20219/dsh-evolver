# dsh-evolver

自我演化控制台：一个插件、一个左侧边栏入口、五个页签。
**只有三样东西进入 Agent 的上下文**：实践的顶层索引（含沉淀纪律）、见闻的灵魂、全局偏好。

```
~/.dsh/evolver/                 ← 唯一数据目录（迁移 / 云备份的单位）
  practice/                     ← 实践：经过验证、可复用的知识与工具
    INDEX.md                    ← 自动生成的顶层索引（注入的是它的投影）
    ARCHIVE.md                  ← 注入放不下的条目
    docs/<topic>/<slug>.md      ← 文档：经验、流程、验证方法
    tools/<topic>/<slug>        ← 工具：能重复运行的脚本与 CLI
    resources/<topic>/<slug>    ← 资源：模板、示例、静态资源
    agents/<topic>/<slug>.md    ← 子智能体定义
  sight/                        ← 见闻：Agent 自己的记忆
    soul.md                     ← 灵魂（注入）
    memory/                     ← 记忆存储（JSONL + 向量）
  preferences/
    AGENTS.md                   ← 全局偏好（链到 ~/.dsh/AGENTS.md）
```

## 注入的三个来源

| 部分 | 内容 | 载体 | 预算 |
| --- | --- | --- | --- |
| 实践 | 纪律 + `practice/INDEX.md` 的预算内投影 | `systemPrompt.section`（order 900） | 2 KB |
| 见闻 | `sight/soul.md` | `systemPrompt.section`（order 910） | 1 KB |
| 偏好 | `preferences/AGENTS.md` | DSH 的 `dsh-agent-instructions` | 用户自控 |

记忆**不自动注入**：Agent 需要时用 `memory_recall` 自己取。

## 工具

| 工具 | 作用 |
| --- | --- |
| `practice_query` | 在实践里检索（Host 侧执行，不受会话权限预设影响） |
| `practice_read` | 读一条实践全文 |
| `practice_write` | 沉淀一条实践，重建索引并返回 `problems` |
| `practice_index` | 完整索引 + 校验问题 |
| `memory_recall` / `memory_save` / `memory_list` / `memory_forget` / `memory_stats` | 见闻的按需记忆 |

## 沉淀纪律（已内化）

原来 `harness-evolver` 技能负责「什么时候沉淀、写什么、写到哪、怎么验证」。
现在这些规则住在插件里，不再需要额外 skill：

- **触发**：完成多步工具调用（≥3 步）的任务后，出现了已验证且可复用的判断、流程、验证方法或工具。
- **边界**：只写能减少未来误判、重复劳动或验证成本的内容；不写流水账、一次性命令、猜测、废弃方案、密钥、令牌、完整日志和对话转录。
- **查重**：写前 `practice_query` + `practice_read`，能更新已有条目就不新建。
- **脚本优先**：满足任一条件必须写成 `kind=tool` 的可运行脚本，而不是只写文档 —— 稳定流程需要两个以上固定命令、同类任务会重复做转换、人工解析结构化输出容易出错、需要一致结果或可重复验证。
- **闭环**：写完读返回的 `problems`（必填字段、kind 一致、链接闭环、verified 过期），未清零不宣称完成。

规则全文作为种子文档写在 `practice/docs/evolver/sinking.md`，首次启动自动生成。

## 面板

概览（注入预览 + 字节数 + 健康度）/ 实践 / 见闻 / 偏好 / 建议。

## 安装

详细步骤（含迁移与卸载）见 [INSTALL.md](INSTALL.md)。

```bash
# 从目录安装（git clone 后，或解压压缩包后）
dsh plugin --profile web add /path/to/dsh-evolver

# 确认行状态
dsh plugin --profile web why dsh-evolver
```

插件自带 `cordis.patch.yml`：插入自己的行，并把 web 组合默认关闭的
`agent-instructions` 打开，让全局偏好真正进入 Agent 的上下文。

首次启动会创建 `~/.dsh/evolver/` 骨架，并把 `~/.dsh/AGENTS.md` 链到
`preferences/AGENTS.md`（原本是真实文件时先备份为 `AGENTS.md.imported`）。

## 维护

```bash
npm test                              # 索引生成器与数据层的单元测试
node scripts/build-index.mjs           # 重建索引
node scripts/build-index.mjs --check   # 只校验，结构有问题时退出码 1
```

## 与 dsh-panel 的边界

dsh-panel 只保留 skills / MCP / 设置 / 备份；记忆与个人偏好都已整体移除。
数据从 `~/.dsh/panel/memory` 与 `~/.dsh/panel/agent.md` 迁移到本插件，
源文件保留未删，可回滚。
