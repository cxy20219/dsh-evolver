# dsh-evolver

自我演化控制台：一个插件、一个侧边栏入口、一套统一的卡片知识库。

每次请求只注入两样东西：**标签树**（纪律 + 每个枝干的说明）、**主动性协议**。
具体卡片一律不注入，由 `card_query` 按需检索。

```
~/.dsh/evolver/                  ← 唯一数据目录（迁移 / 云备份的单位）
  knowledge/
    cards/cards.jsonl            ← 卡片日志：追加写，最后一条同 id 记录生效
    resources/<card-id>/         ← 卡片附件
    tags.json                    ← 标签描述（可选，覆盖内置默认）
    consolidation.json           ← 卡片复查台账（谁在什么时候看过哪张卡）
    trash.jsonl                  ← 卡片整理删掉的内容
  sight/sessions.json           ← 会话整理游标
  preferences/AGENTS.md         ← 全局偏好（链到 ~/.dsh/AGENTS.md）
```

## 卡片模型

一张卡是一行 JSON，**没有分类字段，也没有标题**；分类全由层级标签表达：

```json
{
  "id": "card-01M72KRG4VQEQQ25BM3DTHB97X",
  "body": "正文",
  "tags": ["践行/工作流"],
  "links": ["card-01..."],
  "updated": "2026-11-10T13:40:16.269Z"
}
```

- **id** ULID；`created` 从前 10 位派生，不存。
- **body** 正文；`label` 从首行派生，不存。
- **tags** 唯一的分类入口。**顶层只允许六个枝干**：`#践行` `#见闻` `#即兴` `#复盘` `#觉察` `#试错`。
  父标签自动包含子标签，`#践行` 能搜到 `#践行/工作流`；归档写 `<枝干>/归档`，不要造第七个顶层。
- **links** 卡片 id 数组，空则不写；反链实时计算。孤立的卡等于埋在库里。
- 没有 `type`/`status`/`category`/`summary`/`source`/`resources` 之类字段。

### 附件

文件放在 `knowledge/resources/<card-id>/`，正文必须写引用行，缺引用会被拒绝写入：

```text
[标题](knowledge/resources/<card-id>/<文件名>)：用途：...；入口命令：...；输入：...；输出：...；关联流程：...
```

- 路径相对**数据目录**。写卡时可用 `{{resource}}` 占位，落盘替换成最终路径。
- `card_read` 同时返回绝对 `path` 和 `executable`，执行时用绝对路径。
- 脚本与原生可执行文件自动 `0700`，普通文档 `0600`。

## 注入与检索

| 部分 | 载体 | 预算 |
| --- | --- | --- |
| 标签树（纪律 + 枝干说明） | `systemPrompt.section` order 900 | 4 KB |
| 主动性（何时召回、何时沉淀、收尾给下一步） | `systemPrompt.section` order 920 | 796 B |
| 全局偏好 `preferences/AGENTS.md` | DSH 的 `dsh-agent-instructions` | 64 KB |

超限不会悄悄变大：超了直接拒绝写入。任何卡片都不自动注入——需要时用 `card_query` 取。

## 工具

| 工具 | 作用 |
| --- | --- |
| `card_query` | 按关键词/层级标签检索（BM25 + 标签过滤 + 生命周期加权）；`archivedOnly` 只看归档 |
| `card_read` | 读一张卡：正文、链接、附件 |
| `card_write` | 写入/更新；分类由 tags 表达 |
| `card_index` | 完整标签树与说明（不含卡片正文） |
| `card_promote` | 把 `#即兴` 移入六大枝干之一 |
| `card_archive` | 加 `<枝干>/归档`，保留记录和资源 |
| `card_remove` | 永久删除卡片及资源 |
| `evolve_review` | 一次拿到库盘点与可执行 hints |
| `session_digest` | 读取没整理过的会话摘录 |

## 两个后台整理器

都在「整理」页里开关，各干各的（这个页签在设置左边）：

- **会话整理**：宿主 15 分钟无会话活动、且有没整理过的会话时，直接调用当前默认模型做一次
  受限提取，把偏好/纠正/结论写成 `#即兴` 卡。不创建会话、不给工具，所以不会在后台读文件或跑命令。
  游标在 `sight/sessions.json`，一次最多 10 个会话、6 张卡。
- **卡片整理**：每天固定时刻复查一批卡片（默认 15 张），只做四件事——删掉没用的、合并重复的、
  补双向链接、把标签收敛到正确的枝干。模型只返回 JSON 动作，插件逐条校验；删掉的内容先整条写进
  `knowledge/trash.jsonl` 再删，不是不可逆的。

会话整理默认开、卡片整理默认关（它会改卡片库）。两者共用一个判据：**三个月后还成立吗**——
所以记录的是规则和判据，不是「界面现在长什么样」。

## 设置

「设置」页三个子标签：数据目录、导入 / 导出、云端备份。整理器不在这里，它是设置左边的独立页签。

- **数据目录**默认 `~/.dsh/evolver`；迁移是先完整复制再切换，旧目录原样保留可回滚。
- **导入 / 导出**用 `.tar.gz`，包内只允许写 `knowledge/`、`sight/`、`preferences/`。
- **云端备份**把整个数据目录打成一个标准 tar 传 OSS（V1 签名；`http(s)://` 完整地址走路径风格，兼容 MinIO）。
  密钥只写本机 `~/.dsh/evolver.config.json`（0600），不回传浏览器，也不会被打进备份。

设置文件 `~/.dsh/evolver.config.json` 不在数据目录里：移动数据目录不丢设置，云备份也不带密钥。

## 边界

- `dataDir` 必须是绝对路径。
- 附件单文件 10 MB；读取超过 512 KB 的文本只返回截断内容。
- `~/.dsh/AGENTS.md` 只在「不存在」或「是普通文件」时自动接管（原文件先备份为
  `preferences/AGENTS.md.imported`）；已被别的工具链接时不抢，面板里点「接管」才替换。

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-evolver
dsh plugin --profile web why dsh-evolver     # 确认行状态
```

详见 [INSTALL.md](INSTALL.md)。首次启动创建数据目录、种下三张种子卡，并把 `~/.dsh/AGENTS.md`
链到 `preferences/AGENTS.md`。

## 测试

```bash
npm test
```
