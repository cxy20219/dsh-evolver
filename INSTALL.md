# 安装 dsh-evolver

## 前置

- DeepSeek Harness（`dsh`）已安装并可运行；Node.js ≥ 22。
- `pnpm` 在 PATH 上（`dsh plugin` 用它管理 profile 依赖）。
- 一个可用的 profile（默认 `web`）。

## 从压缩包安装

```bash
# 1. 解压到一个长期保留的位置（不要放 /tmp；本地安装是 link，删了源码插件就坏）
unzip dsh-evolver-5.2.0.zip -d ~/.dsh/plugins

# 2. 装进 profile：会写依赖，并把 bundle patch 注册进 profile
dsh plugin --profile web add ~/.dsh/plugins/dsh-evolver

# 3. 重启 DSH Web，Host 插件在启动时加载
#    先停掉当前的 dsh web（Ctrl-C），再：
dsh web
```

确认：

```bash
dsh plugin --profile web why dsh-evolver
```

浏览器里左侧边栏应出现「演化器」入口，点开是五个页签。

## 从 Git 安装

```bash
dsh plugin --profile web add https://github.com/cxy20219/dsh-evolver.git
```

## 首次启动会发生什么

1. 创建数据目录 `~/.dsh/evolver/`（`knowledge/`、`sight/`、`preferences/`）：
   写入灵魂与偏好种子，并在空卡片库中种下三张 #践行/#复盘 种子卡（长文进资源附件）。只创建
   卡片目录，不再有旧的 `practice/` 或 `sight/memory/`。
2. 把 `~/.dsh/AGENTS.md` 链接到 `~/.dsh/evolver/preferences/AGENTS.md`。
   如果原来是真实文件，内容会先备份为 `preferences/AGENTS.md.imported`。
   **如果它已经被别的工具链接到别处，插件不会自动接管**：面板「偏好」会显示
   「被其他来源占用」，确认后点「接管这个链接」（同样先备份再替换）。
   不想让插件管全局偏好时，点「移除全局链接」即可，偏好文件本身不会被删。
3. 5.2 不做旧版本兼容：不会导入 `practice/`、`sight/memory/`，旧 HTTP 接口、旧工具名、
   旧 slug、旧向量格式和旧权重目录迁移都已移除。升级前请用旧版本导出数据，或确认卡片库
   已经存在。

> 在组合里配置 `dataDir` 时必须是绝对路径；相对路径会在启动时报错，而不是悄悄
> 落到 Host 的工作目录。

## 设置与备份

数据目录、卡片正文上限、OSS 备份配置和密钥保存在 `~/.dsh/evolver.config.json`（0600），
不在数据目录里。设置页里改过的数据目录优先于组合配置里的 `dataDir`；
迁移、导入/导出与云端备份的细节见 [README](README.md#设置页数据目录与云端备份)。

## 迁移到另一台机器

整个 `~/.dsh/evolver/` 就是迁移单位：复制过去即可，卡片、偏好、灵魂都在里面。
`~/.dsh/AGENTS.md` 是符号链接，目标机器上让插件重新建立即可（首次启动会自动做）。

## 卸载

```bash
dsh plugin --profile web remove dsh-evolver
```

数据目录不会删除；要彻底清理再手动删 `~/.dsh/evolver/` 并恢复 `~/.dsh/AGENTS.md`。
