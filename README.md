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
  sight/                        ← 见闻：Agent 自己的记忆
    soul.md                     ← 灵魂（注入）
    memory/                     ← 记忆存储（JSONL + 向量）
  preferences/
    AGENTS.md                   ← 全局偏好（链到 ~/.dsh/AGENTS.md）
  models/<模型>/                ← 本地 embedding 权重（可选，随备份/导出）
```

## 注入的四个来源

| 部分 | 内容 | 载体 | 预算 |
| --- | --- | --- | --- |
| 实践 | 纪律 + `practice/INDEX.md` 的预算内投影 | `systemPrompt.section`（order 900） | 2 KB |
| 见闻 | `sight/soul.md` | `systemPrompt.section`（order 910） | 1 KB |
| 主动性 | 固定的触发协议：何时召回、何时沉淀、收尾给下一步 | `systemPrompt.section`（order 920） | 744 B |
| 偏好 | `preferences/AGENTS.md` | DSH 的 `dsh-agent-instructions` | 用户自控 |

记忆**不自动注入**：Agent 需要时用 `memory_recall` 自己取。

注入块有硬上限，写超了会报错而不是悄悄变大：

| 内容 | 上限 |
| --- | --- |
| 灵魂 `sight/soul.md` | 16 KB |
| 全局偏好 `preferences/AGENTS.md` | 64 KB |
| 一条实践的正文 | 256 KB |
| 一条记忆 | 4000 字 |

## 工具

| 工具 | 作用 |
| --- | --- |
| `practice_query` | 在实践里检索（Host 侧执行，不受会话权限预设影响） |
| `practice_read` | 读一条实践全文 |
| `practice_write` | 沉淀一条实践，重建索引并返回 `problems` |
| `practice_index` | 完整索引 + 校验问题 |
| `evolve_review` | 一次拿到实践/记忆状态、结构问题、久未验证与可执行的提示 |
| `memory_recall` / `memory_save` / `memory_list` / `memory_forget` / `memory_stats` | 见闻的按需记忆 |

## 沉淀纪律（已内化）

原来 `harness-evolver` 技能负责「什么时候沉淀、写什么、写到哪、怎么验证」。
现在这些规则住在插件里，不再需要额外 skill：

- **触发**：完成多步工具调用（≥3 步）的任务后，出现了已验证且可复用的判断、流程、验证方法或工具。
- **边界**：只写能减少未来误判、重复劳动或验证成本的内容；不写流水账、一次性命令、猜测、废弃方案、密钥、令牌、完整日志和对话转录。
- **查重**：写前 `practice_query` + `practice_read`，能更新已有条目就不新建。
- **脚本优先**：满足任一条件必须写成 `kind=tool` 的可运行脚本，而不是只写文档 —— 稳定流程需要两个以上固定命令、同类任务会重复做转换、人工解析结构化输出容易出错、需要一致结果或可重复验证。
- **闭环**：写完读返回的 `problems`（必填字段、kind 一致、链接闭环、verified 过期），未清零不宣称完成。

纪律文本自己也算在 2 KB 预算里（约 680 字节，其余留给路由表），所以它保持精简；
细节留在种子文档里，需要时 `practice_read`。

规则全文作为种子文档写在 `practice/docs/evolver/sinking.md`，首次启动自动生成。

## 主动性

数据在不在上下文里是一回事，Agent 会不会主动用是另一回事。注入的 `[主动性]` 段落
规定触发点，不靠临场发挥：

- 任务前有明确相关词，先 `practice_query` / `memory_recall`；
- 任务后可复用的写 `practice_write`（先查重），偏好/纠正写 `memory_save`；
- 收尾给一条具体、可执行的下一步（命令 / 文件 / 验证方式），不只问“还需要什么”；
- 同一流程第二次出现，提议沉淀或脚本化；
- 盘点用 `evolve_review`，有结构问题或久未验证时用一句话提醒，不打断当前任务；
- 不确定时先做可逆部分，只问那个会改变结果的决策。

`evolve_review` 返回有界的摘要：实践条目数/预算/结构问题、记忆数量与代表条目、
建议动作，以及 `hints`。没有高信号时 `hints` 会明说“不用为了主动而主动”，
避免 Agent 为了表现主动而硬找事。

想让它定期自我检查，可以挂一个定时任务（用 DSH 的 `schedule` 工具创建，插件不替你建）：

> 每天 21:00：调用 `evolve_review`，从 `hints` 里挑一条最值得做的，执行并给出结论；
> 没有高信号就明确说“今天没有需要沉淀的”。

## 面板

概览（注入预览 + 字节数 + 健康度 + 插件版本）/ 实践 / 见闻 / 偏好 / 建议 / 设置。

## 设置页：数据目录与云端备份

「设置」页管三件事，对应 `/api/evolver` 的 `settings*`、`data-*`、`backup-*` 接口。

### 数据目录

- 默认 `~/.dsh/evolver`；设置里指定的目录优先于组合配置里的 `dataDir`。
- 数据目录和导出目录都能用「浏览…」直接调起系统文件夹选择，也可以手动粘贴绝对路径。
- 设置页分四个子标签：**数据目录**、**导入 / 导出**、**云端备份**、**向量模型**，不再挤在一页里。
- 迁移、导出、导入、备份的结果以面板底部的提示条显示：成功时自动收起，失败时保留到手动关闭。
- 迁移 = 先把当前目录完整复制到新路径，复制成功、设置写盘之后才切换。旧目录原样保留，
  可以回滚；目标目录非空时必须显式勾选覆盖。
- 设置里记录的目录如果不存在（例如外置盘没挂载），本次启动会退回默认目录并在设置页给出
  警告，不会悄悄新建一个空目录。
- 导入 / 导出用一个 **`.tar.gz` 压缩包**：选一个导出目录、填文件名（默认 `dsh-evolver-<时间戳>.tar.gz`，
  没有后缀会自动补上）即可打包；导入点「浏览…」选目录后，面板会列出其中的
  `.tar.gz` / `.tgz` / `.tar` 供点选（也可以直接粘贴绝对路径）。
  导入默认只补缺失文件，勾选「覆盖同名文件」才替换；包内只允许写入 `practice/`、
  `sight/`、`preferences/`，路径穿越的条目会被拒绝。

### 云端备份（阿里云 OSS）

- 整个数据目录打成一个 **tar**（标准 ustar，`tar -xf` 直接可解）上传，
  对象名 `‹prefix›/backup-‹YYYYMMDDTHHmmssSSSZ›.tar`，按时间可排序；文件权限随 tar 保留。
- 「云端保留份数」1–60：每次备份后按对象名排序，删掉最旧的超额部分。
- 「备份间隔」5–10080 分钟：宿主每分钟检查一次，到点才备份；重启后会补一次。
- 密钥只写进本机 `~/.dsh/evolver.config.json`（0600），不回传浏览器、不写日志，
  也不会被打进备份（备份只包含数据目录）。
- 使用 OSS V1 签名：`endpoint` 填 `oss-cn-hangzhou.aliyuncs.com` 这类主机名走虚拟主机
  风格，填 `http(s)://` 开头的完整地址走路径风格（自建网关 / MinIO）。需要 V4 签名的
  账号不支持。
- 恢复：下载对应的 `backup-*.tar`，在设置页「从压缩包导入」直接选它即可（无需解包）；
  也可以 `tar -xf` 手动查看内容，或停掉宿主后直接替换数据目录。

### 见闻向量模型（embedding）

「见闻」记忆的语义召回默认用**本地哈希**向量：零配置、离线、不占内存，但只比较词面。
设置页「向量模型」子标签可以换成本地 ONNX 模型或任意 OpenAI 兼容的 HTTP 服务；
切换后在后台重建全部向量，期间召回自动退回关键词。

| 模型 | 语言 | 维度 | 量化权重 | 说明 |
| --- | --- | --- | --- | --- |
| `multilingual-e5-small` | 中文 + 英文 + 多语 | 384 | ~135 MB | 默认推荐，中英均衡 |
| `bge-small-zh-v1.5` | 中文为主，英文可用 | 512 | ~25 MB | 体积最小，中文记忆优先 |
| `bge-m3` | 中英 + 多语 | 1024 | ~587 MB | 质量最高，加载慢 |

- 权重由面板下载到数据目录的 `models/<模型>/`，和记忆一起统一管理：备份、导入、导出
  都会带上它，换机器不用重新下载。代价是归档会变大（bge-m3 约 587 MB，bge-small-zh
  约 25 MB），导出/备份会相应变慢；归档是流式读写的，不会整包进内存。
- 下载源默认 `https://hf-mirror.com`，可改成 `https://huggingface.co`。
- 本地模型需要运行时（transformers.js + ONNX runtime），插件不打包它：
  `npm install --prefix "$HOME/.dsh/embedding-runtime" @huggingface/transformers`
  （约 300 MB；界面会显示运行时是否可用，并给出当前路径对应的命令）。
  运行时缺失时自动退回本地哈希，不会阻断启动。
- HTTP 模式填 OpenAI 兼容的 `/v1/embeddings` 地址即可，例如 Ollama：
  `http://127.0.0.1:11434/v1` + 模型 `bge-m3` / `nomic-embed-text`；API Key 只写不读。
- 「测试后端」会真的嵌入两段中英文样本，返回实际后端、维度与耗时；配置的模型不可用时
  会明确提示已退回哈希。
- 换后端/模型会触发后台重建：分批重算全部向量，全部成功才整体替换；失败则保留旧向量，
  检索继续只用关键词。

### 设置文件

`~/.dsh/evolver.config.json`（0600）保存数据目录、备份配置、向量配置、密钥和上次备份状态。
它不在数据目录里：移动数据目录不会丢设置，云备份也不会带上密钥。

## 文件与链接的边界

- 实践条目必须是普通文件：`practice/` 下的符号链接不会被索引，`practice_read` 会拒绝读取，
  `practice_write` 也不会跟随目录链接写到数据目录之外。
- `~/.dsh/AGENTS.md` 只在「不存在」或「是普通文件」时被自动接管（原文件先备份为
  `preferences/AGENTS.md.imported`）。如果它已经被别的工具链接到别处，插件不会抢；
  面板「偏好」会显示「被其他来源占用」，点「接管这个链接」才会替换（同样先备份）。
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

首次启动会创建 `~/.dsh/evolver/` 骨架，并把 `~/.dsh/AGENTS.md` 链到
`preferences/AGENTS.md`（原本是真实文件时先备份为 `AGENTS.md.imported`）。

## 维护

```bash
npm test                              # 单元与集成测试（索引、记忆、设置、备份）
node scripts/build-index.mjs           # 重建索引
node scripts/build-index.mjs --check   # 只校验，结构有问题时退出码 1
```
