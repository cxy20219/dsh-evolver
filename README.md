# dsh-evolver

自我演化控制台：一个插件、一个侧边栏入口、一套统一的卡片知识库。
**只有三样东西进入 Agent 的每次上下文**：永久卡片的 2 KB 路由投影（含沉淀纪律）、灵魂、主动性协议。

```
~/.dsh/evolver/                  ← 唯一数据目录（迁移 / 云备份的单位）
  knowledge/
    cards/cards.jsonl            ← 卡片日志：追加写，最后一条同 id 记录生效
    resources/<card-id>/         ← 卡片附件：长文、脚本、模板
    migration.json               ← 一次性迁移标记
  sight/
    soul.md                      ← 灵魂（注入）
    sessions.json                ← 闲时整理的会话游标
  preferences/AGENTS.md          ← 全局偏好（链到 ~/.dsh/AGENTS.md）
  models/<模型>/                 ← 本地 embedding 权重（随备份/导出）
  practice/                      ← 旧实践目录（只读迁移源，不再写入）
  sight/memory/                  ← 旧记忆目录（只读迁移源，不再写入）
```

## 卡片模型

一张卡片就是一行 JSON，没有标题：

- **id**：ULID（`card-` + 48 位毫秒时间戳 + 80 位随机数），按创建时间可排序，同一毫秒也不撞号。
- **type**：`fleeting`（临时，先收进来）或 `permanent`（永久，值得进入注入投影）。
- **shape**：`memo` / `note` / `doc` / `tool` / `resource`；`category`：`fact` / `preference` /
  `convention` / `correction` / `failure` / `tool-quirk`。形状回答“这是什么”，分类回答“为什么留下”。
- **label**：从正文首行派生，用于列表和投影；永久卡另有 `summary` 一句话路由。
- **tags**：层级标签（`验证/浏览器`）。一张卡可以同时属于多个父标签；点击父标签会包含所有子标签。
- **links**：卡片 id 数组；反链由卡片日志实时计算，二者都不会出现只存一边的情况。
- **body**：卡片正文，受设置里的「卡片正文上限」约束（默认 1000 字，200–4000 可调）。
  超长内容写成资源附件，卡片只留摘要。
- **status**：`inbox` → `verified` → `archived`；只有 `permanent + verified` 进入注入。

两个投影来自同一份数据：

| 消费者 | 内容 |
| --- | --- |
| 每次请求的 system prompt | 2 KB 预算：沉淀纪律 + 按标签分组的永久卡 `label — summary (id)` 路由表；超出预算的卡不注入 |
| Agent 的 `practice_query` / `memory_recall` | 全部卡片（BM25 + 向量 + 生命周期）；临时卡只在这里出现 |

写卡片的顺序建议：先用 `memory_save` 收成临时卡 → 查重、验证 → `card_promote` 提升为永久卡。
面板里的「提升为永久」走同一条路径。

## 注入的三个来源

| 部分 | 内容 | 载体 | 预算 |
| --- | --- | --- | --- |
| 卡片 | 纪律 + 永久卡路由投影 | `systemPrompt.section`（order 900） | 2 KB |
| 灵魂 | `sight/soul.md` | `systemPrompt.section`（order 910） | 1 KB |
| 主动性 | 何时召回、何时沉淀、收尾给下一步 | `systemPrompt.section`（order 920） | 744 B |
| 偏好 | `preferences/AGENTS.md` | DSH 的 `dsh-agent-instructions` | 用户自控 |

临时卡**不自动注入**：需要时由 `memory_recall` 或面板按需取。写入超限不会悄悄变大：
灵魂 16 KB、偏好 64 KB、单条记忆 4000 字、卡片正文按设置上限。

## 工具

| 工具 | 作用 |
| --- | --- |
| `practice_query` | 在永久卡里检索（Host 侧执行，不受会话权限预设影响） |
| `practice_read` | 读一张永久卡，含正文/主附件、链接和附件列表 |
| `practice_write` | 写入永久卡；doc/tool/resource 的正文自动进资源附件 |
| `practice_index` | 全部永久卡 + 完整注入投影 |
| `card_promote` | 把临时卡提升为永久卡（可补 summary / tags） |
| `evolve_review` | 一次拿到卡片库状态、临时卡代表条目与可执行提示 |
| `session_digest` | 读取没整理过的会话摘录（手动整理用） |
| `memory_recall` / `memory_save` / `memory_list` / `memory_forget` / `memory_stats` | 临时卡的按需记忆 |

`practice_*` / `memory_*` 是工具名兼容层，底层已经是同一套卡片；旧 slug 仍可作为
`practice_read` 的引用，迁移不会打断已有链接。旧的 HTTP 接口（`practice-*`、`memory-*`）
已在 1.1 移除，面板和 Agent 都只走卡片接口。

## 沉淀纪律（已内化）

- **触发**：完成多步工具调用（≥3 步）后，出现了已验证且可复用的判断、流程、验证方法或工具。
- **边界**：只写能减少未来误判、重复劳动或验证成本的内容；不写流水账、一次性命令、猜测、
  废弃方案、密钥、令牌、完整日志和对话转录。密钥在写入前会被识别并拒绝。
- **查重**：写前 `practice_query` + `practice_read`，能更新已有卡片就不新建。
- **脚本优先**：稳定流程、重复转换、结构化输出解析、需要可重复验证时，用 `practice_write`
  的 `kind=tool` 写成可运行脚本，而不是只写文档。
- **闭环**：写完读返回的 `problems`（必填字段、链接闭环、verified 过期），未清零不宣称完成。

纪律文本自己也算在 2 KB 预算里（约 430 字节），细节留在种子卡里，需要时 `practice_read`。

## 主动性

注入的 `[主动性]` 段落规定触发点，不靠临场发挥：

- 任务前有明确相关词，先 `practice_query` / `memory_recall`；
- 任务后可复用的写 `practice_write`（先查重），偏好/纠正写 `memory_save`；
- 收尾给一条具体、可执行的下一步（命令 / 文件 / 验证方式）；
- 同一流程第二次出现，提议沉淀或脚本化；
- 盘点用 `evolve_review`，有结构问题或久未验证时用一句话提醒；
- 不确定时先做可逆部分，只问那个会改变结果的决策。

`evolve_review` 返回有界摘要：永久卡数量/预算、临时卡代表条目、建议动作和 `hints`；
没有高信号时会明说“不用为了主动而主动”。

## 会话整理（闲时自动）

默认开启：宿主连续 15 分钟没有会话活动、且存在没整理过的会话时，插件直接调用当前默认
模型做一次受限提取，把值得留下的偏好/纠正/结论写成临时卡。

- **不创建会话、不给工具**：纯文本模型调用，Agent 不会在后台读文件、跑命令或写卡片。
- **只读用户与助手的文本**：工具输出、系统提示、推理内容都不进摘录；单条/单会话/整批都有
  长度上限。摘录里的常见密钥会被抹掉，保存前还会再查一次。
- **游标**：`sight/sessions.json` 记录每个会话处理到的 seq；只读新增部分，最多一次处理
  10 个会话、保存 6 条记忆。全部保存成功后才推进游标，失败 6 小时后重试。
- **成本**：每次闲时触发一次模型调用，输出上限 2500 token；没有待整理会话时不会调用。
- 面板「卡片」页显示待整理/已处理数量、上次完成时间；「立即整理」立刻跑一次。
- 只在 App 运行期间触发；模型未选择或宿主不提供会话读取时显示不可用。

## 面板

概览（注入预览、预算、字节数、插件版本）/ **卡片**（层级标签树、全部/收件箱/永久/归档、
搜索、无标题编辑、提升、归档、删除、附件、双链与反链）/ **灵魂** / 偏好 / 建议 / 设置。

卡片页顶部的「闲时自动整理」可以开关、调空闲分钟数、立即运行。

## 设置页

「设置」页分四个子标签：**数据目录**、**导入 / 导出**、**云端备份**、**向量模型**。

### 数据目录

- 默认 `~/.dsh/evolver`；设置里指定的目录优先于组合配置里的 `dataDir`。
- **卡片正文上限**：200–4000 字，默认 1000；改完立即作用于新写入的卡片和注入投影。
- 数据目录和导出目录都能用「浏览…」调起系统文件夹选择，也可以手动粘贴绝对路径。
- 迁移 = 先把当前目录完整复制到新路径，复制成功、设置写盘之后才切换；旧目录原样保留，
  可回滚；目标目录非空时必须显式勾选覆盖。
- 设置里记录的目录如果不存在（例如外置盘没挂载），本次启动退回默认目录并在设置页给出警告。
- 导入 / 导出用 `.tar.gz`：导出目录 + 文件名（默认 `dsh-evolver-<时间戳>.tar.gz`）；
  导入可直接选 `.tar.gz` / `.tgz` / `.tar`。包内只允许写入 `knowledge/`、`practice/`、
  `sight/`、`preferences/`、`models/`，路径穿越条目会被拒绝。

### 云端备份（阿里云 OSS）

- 整个数据目录打成一个 **tar**（标准 ustar，`tar -xf` 直接可解）上传；对象名
  `‹prefix›/backup-‹YYYYMMDDTHHmmssSSSZ›.tar`，按时间可排序；文件权限随 tar 保留。
- 「云端保留份数」1–60；「备份间隔」5–10080 分钟；重启后补一次。
- 密钥只写进本机 `~/.dsh/evolver.config.json`（0600），不回传浏览器、不写日志，
  也不会被打进备份（备份只包含数据目录）。
- 使用 OSS V1 签名；endpoint 主机名走虚拟主机风格，`http(s)://` 完整地址走路径风格
  （自建网关 / MinIO）。V4 签名账号不支持。
- 恢复：下载 `backup-*.tar`，在设置页「从压缩包导入」直接选；也可 `tar -xf` 手动查看，
  或停掉宿主后替换数据目录。

### 向量模型（embedding）

卡片与临时卡默认用**本地哈希**向量：零配置、离线，但只比较词面。设置页「向量模型」
可以换成本地 ONNX 模型或任意 OpenAI 兼容 HTTP 服务；切换后在后台重建全部向量，期间
召回自动退回关键词。

| 模型 | 语言 | 维度 | 量化权重 | 说明 |
| --- | --- | --- | --- | --- |
| `multilingual-e5-small` | 中文 + 英文 + 多语 | 384 | ~135 MB | 默认推荐，中英均衡 |
| `bge-small-zh-v1.5` | 中文为主 | 512 | ~25 MB | 体积最小，中文优先 |
| `bge-m3` | 中英 + 多语 | 1024 | ~587 MB | 质量最高，加载慢 |

- 权重在数据目录的 `models/<模型>/`，随备份、导入、导出一起走；旧版
  `~/.dsh/evolver-models` 会在启动时自动迁入，新目录已有同名模型时旧目录保留并可在
  设置页一键清理。
- 下载源默认 `https://hf-mirror.com`，可改成 `https://huggingface.co`。
- 本地模型需要运行时（transformers.js + ONNX runtime），插件不打包它：
  `npm install --prefix "$HOME/.dsh/embedding-runtime" @huggingface/transformers`
  （约 300 MB）。运行时缺失时自动退回本地哈希，不会阻断启动。
- HTTP 模式填 OpenAI 兼容 `/v1/embeddings` 地址，例如 Ollama：
  `http://127.0.0.1:11434/v1` + 模型 `bge-m3` / `nomic-embed-text`；API Key 只写不读。
- 「测试后端」会真的嵌入两段中英文样本，返回实际后端、维度与耗时；配置不可用时明确提示
  已退回哈希。换后端/模型会分批重算全部向量，全部成功才整体替换；失败保留旧向量。

### 设置文件

`~/.dsh/evolver.config.json`（0600）保存数据目录、卡片正文上限、备份配置、向量配置、
密钥和上次备份状态。它不在数据目录里：移动数据目录不会丢设置，云备份也不会带上密钥。

## 迁移与兼容

首次启动、以及导入旧数据包后，插件会把 `practice/` 和 `sight/memory/` 里的条目导入
卡片库：

- 实践条目 → `permanent + verified` 卡片；长文/脚本进资源附件，卡片保留 title/purpose；
- 旧记忆 → `fleeting` 临时卡；
- 旧 slug 链接会在第二遍映射到新卡片 id；无法解析的链接只留在问题里，不阻塞迁移；
- `sourceId`（`practice:<path>` / `memory:<id>`）+ `knowledge/migration.json` 保证幂等：
  中途失败可重试，重复启动不会产生重复卡片。

旧目录只作为迁移源保留，便于人工回滚或重新导入；插件不再写入旧目录，也不再提供旧 HTTP 接口。

## 文件与链接的边界

- 卡片附件写在 `knowledge/resources/<card-id>/`，文件名压成单段，拒绝符号链接；
  单文件 10 MB 上限，读取超过 512 KB 的文本只返回截断内容。
- 旧实践目录里的符号链接不会被迁移读取；迁移也不会写到数据目录之外。
- `~/.dsh/AGENTS.md` 只在「不存在」或「是普通文件」时自动接管（原文件先备份为
  `preferences/AGENTS.md.imported`）；已被别的工具链接时不抢，面板里点「接管」才替换。
- `dataDir` 必须是绝对路径。

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

首次启动会创建 `~/.dsh/evolver/` 骨架、迁移旧库，并把 `~/.dsh/AGENTS.md` 链到
`preferences/AGENTS.md`（原本是真实文件时先备份为 `AGENTS.md.imported`）。

## 维护

```bash
npm test                              # 单元与集成测试（卡片、迁移、记忆、设置、备份）
```
