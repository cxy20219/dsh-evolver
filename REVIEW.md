> 历史审查记录（0.9.0）。旧的 practice/memory 写入路径与旧 HTTP 接口已在 1.1 移除；下文的文件路径只用于追溯。

# 代码审查报告（2026-11-10）

审查对象：`dsh-evolver` 0.9.0（`index.js`、`src/**`、`client.js`、`test/**`）。
执行方式：逐文件通读 + 针对可疑点写复现测试 + 修复后跑全量测试；浏览器端改动不在本次范围（本轮未改 UI），UI 行为由既有 render 测试覆盖。

## 一、问题清单总表

| # | 严重级别 | 维度 | 位置 | 问题 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | P1 | 稳定性 | `src/backup/service.js:125` | `running` 在设置写入之前置位且写在 try 外；设置写入失败会永久卡住"备份进行中" | 已修复 |
| 2 | P1 | 稳定性/正确性 | `src/memory/db.js:500` | 单条保存会改写整库向量空间元数据，重启后误判"已对齐"，混合两个向量空间 | 已修复 |
| 3 | P1 | 稳定性/数据 | `src/memory/db.js:682` | 日志追加期间新保存的记忆会被清空 `pendingAppends` 丢掉，重启后丢失 | 已修复 |
| 4 | P2 | 稳定性 | `src/memory/store.js:186` | `close()` 不等后台重建结束，导出/迁移可能拷到半套向量 | 已修复 |
| 5 | P2 | 稳定性 | `src/evolver.js:689,739` | 灵魂/偏好读取无上限，外部改成超大文件会整份读入内存并注入 | 已修复 |
| 6 | P2 | 并发 | `index.js` workspace | 迁移/导出/导入可并发执行，可能让记忆库指向已不使用的目录 | 已修复 |
| 7 | P2 | 稳定性 | `src/backup/service.js:137` | 清理旧备份失败被当作整体失败，`lastBackupAt` 不更新，随后每 5 分钟重复上传 | 已修复 |
| 8 | P2 | 稳定性 | `src/settings.js:279` | 临时文件名只含毫秒，同毫秒两次保存会冲突 | 已修复 |
| 9 | P3 | 一致性 | `src/settings.js:298` | `suggestedArchive` 与 dir/name 来自两次取时，可能不一致 | 已修复 |
| 10 | P3 | 安全/输入 | `src/settings.js:150` | bucket 未校验，含 `/`、空格会拼出错误 URL | 已修复 |
| 11 | P3 | 稳定性 | `src/backup/tar.js:154` | GNU/pax 扩展头被静默跳过，导入长路径时会解析成截断文件名 | 已修复（明确拒绝） |
| 12 | P3 | 正确性 | `src/practice.js:145` | 任意字段的 `[...]` 都按数组解析，标题 `[草稿] 结论` 会丢失 | 已修复 |
| 13 | P3 | 正确性 | `src/evolver.js:942` | 没有 `verified` 的条目同时出现在结构问题和"久未验证"，日期为空 | 已修复 |
| 14 | P3 | 稳定性 | `src/evolver.js` 多处 | 条目/灵魂/偏好写入非原子，崩溃可能留下半个文件 | 已修复 |
| 15 | P3 | 稳定性 | 多处原子写 | rename 失败会留下 `.tmp` 垃圾 | 已修复 |
| 16 | P3 | 正确性 | `src/practice.js:368,465` | 崩溃残留的 `*.tmp` 会被当成实践条目扫描 | 已修复 |
| 17 | P3 | 接口一致性 | `src/memory-actions.js:204` | 记忆列表 `total` 是当前页条数而不是命中总数 | 已修复 |
| 18 | P3 | 可观测性 | `src/evolver.js:869` | 注入预览把灵魂预算写死成 1024 | 已修复 |
| 19 | P3 | 结构 | `index.js:107,326` | 重复悬挂 JSDoc；路径校验报"请填写目录路径"但文件路径也用 | 已修复 |
| 20 | P3 | 结构 | `src/practice.js:741` | 主题删空后旧的 `<topic>/INDEX.md` 不会清理 | 未修复（见下） |
| 21 | P3 | 性能 | `src/evolver.js:848` | overview/injection/practice 各扫一次树，面板首屏扫 4 次 | 未修复（见下） |
| 22 | P3 | 性能 | `src/memory-actions.js:99` | 保存时的近似去重要遍历全部记忆做相似度 | 未修复（见下） |
| 23 | P3 | 性能 | `src/memory/hybrid.js:103` | 每次召回对全部向量算余弦 | 未修复（见下） |
| 24 | P3 | 性能 | `src/backup/archive.js:89` | `gzipSync` 在事件循环上压缩，最大 64 MB | 未修复（见下） |
| 25 | P3 | 安全 | `src/backup/archive.js:170` | 导入保留归档里的文件权限（可写入 0777） | 未修复（见下） |
| 26 | P3 | 安全 | `src/practice.js:862` | `practice_read` 可读 INDEX.md/ARCHIVE.md | 未修复（见下） |
| 27 | P2 | 稳定性 | `index.js` migrate/import | 切换目录后 `openMemory` 失败时记忆代理仍指旧库 | 未修复（见下） |
| 28 | P3 | 结构 | `src/evolver.js` / `src/practice.js` / `src/backup/archive.js` | `readHead` 与 `readUpTo`、`isTransient` 重复 | 未修复（见下） |

已核实为非问题：无 SQL/命令/模板注入面；无 `eval`/`innerHTML`；无第三方依赖（无依赖漏洞）；API 认证由 Host Connection 服务负责（此前实测未认证 401、异源 403）；密钥 0600、不回传、不进备份、不进日志；路径穿越在词法、realpath、归档解包三层校验；请求体 8 MB 上限；OSS 错误信息不含凭据。

## 二、逐项修复记录

### 1. P1 备份"进行中"卡死（`src/backup/service.js`）

- 改了什么：把 `lastAttemptAt` 的状态写入移进 `try`，`running` 的置位与释放都在 `try/finally` 内。
- 为什么：原实现 `running = true` 后、`try` 之前就 `await settings.updateStatus(...)`；磁盘满/只读时该调用抛错，`finally` 不执行，之后所有备份（手动和定时）都报"备份正在进行中"直到重启。
- 验证：新增 `设置写入失败不会让“备份进行中”卡死`，让 `updateStatus` 第一次抛错，断言第二次 `runNow` 能成功且 `running === false`。

### 2. P1 向量空间元数据被单条保存改写（`src/memory/db.js`、`src/memory/store.js`）

- 改了什么：`setVector` 只在三种情况更新 `backend/model/dimensions`：显式 `adopt`（整库重建应用阶段）、库中还没有向量、元数据本来就是当前后端。整库重建应用时传 `{ adopt: true }`。
- 为什么：保存一条新记忆会走 `setVector` 并把整库元数据改成当前 embedder；若此前重建失败（旧向量仍是旧空间），重启后元数据匹配、`vectorsAligned` 被误判为 true，检索就用两个不同空间的向量排序，结果静默变错。
- 验证：新增 `未对齐时保存不会把整库向量标成新后端`：旧后端写入 → 新后端打开并再存一条 → 重新打开断言 `vectorBackend/model` 仍是旧值、两条向量都在。

### 3. P1 日志追加期间丢记忆（`src/memory/db.js`）

- 改了什么：`writeMemories` 捕获写入前的条数 `written`；追加/压缩结束后只清掉这 `written` 条，期间新推入的记录留在 `pendingAppends`；失败时恢复整个数组（不再重复拼接自己）。
- 为什么：旧代码在 `await appendFile/writeLines` 之后无条件 `this.pendingAppends = []`；并发 `put` 推入同一条数组的记录被清掉，而 dirty 位已在上一次 `writeAll` 快照后设置，下一次 flush 没有 append 可写，该记忆直到下次压缩才可能落盘，重启即丢。
- 验证：新增 `写入过程中新保存的记忆不会被丢到下一次重启`：压缩写入过程中 `put` 一条新记忆，关闭后重开，断言新记忆存在。

### 4. P2 `close()` 不等后台重建（`src/memory/store.js`）

- 改了什么：`close()` 先 `await this.ready?.catch(() => {})` 再 flush。
- 为什么：`init()` 把重建放到后台；导出/迁移立即 `close()` 时重建可能还在应用向量，拷贝/打包会得到半套旧空间、半套新空间的库。
- 验证：新增 `关闭记忆库会等后台重建落盘`：embedBatch 延迟 40 ms，`init()` 后立刻 `close()`，重开断言后端已是新值。

### 5. P2 灵魂/偏好读取无上限（`src/evolver.js`）

- 改了什么：`soulRead`/`preferencesRead` 先 `lstat`，超过 `MAX_SOUL_BYTES`/`MAX_PREFERENCES_BYTES` 时只读头部，返回新增字段 `truncated`、`fullBytes`（加法扩展，旧字段不变）。
- 为什么：写入路径有上限，但任何人都可以手工把文件改大；原实现整份读入并注入（灵魂每请求都进上下文）。
- 验证：新增 `外部改写的大文件读取时会被截断，不整份进内存`。

### 6. P2 数据操作互斥（`index.js`）

- 改了什么：在 workspace 上包一层 `exclusive()` 闸门，`migrate`/`exportTo`/`importFrom` 共用；第二个操作立即返回"X正在进行，请稍后再试"。
- 为什么：三个操作都会关闭记忆库、复制目录、重开库；两个面板会话并发时可能让库指向已不使用的目录。
- 验证：新增 `两个数据操作不能同时进行`：并发两次导出，断言一个 200、一个 400 且提示"正在进行"，成功的那个文件存在。

### 7. P2 清理失败导致重复上传（`src/backup/service.js`）

- 改了什么：上传成功先记录 `lastBackupAt` 等状态，再做保留清理；清理单独 try/catch，失败写 `lastError = 快照已上传，但清理旧备份失败：…`，返回值加 `cleanupError`，不抛错。
- 为什么：旧实现把清理失败当作整次备份失败，`lastBackupAt` 不更新，5 分钟退避后心跳会再上传一份，旧对象又删不掉，快照持续堆积。
- 验证：新增 `清理旧备份失败不判本次备份失败，也不会立刻重复上传`（断言 `removed=0`、`lastBackupAt` 已更新、下一次 `tick` 不再上传）。

### 8. P2 设置保存临时名冲突（`src/settings.js`）

- 改了什么：实例加 `writeSequence`，临时名改为 `路径.pid.毫秒.序号.tmp`；写入/rename 失败清理临时文件。
- 为什么：同一毫秒内两次保存（备份状态 + 面板保存）会撞同一临时名。
- 验证：既有设置测试全过；改名不影响行为，属确定性改进。

### 9–11. P3 一致性/输入/归档

- `publicView`：目录与文件名由同一个时间戳生成，测试断言 `suggestedArchive === join(dir, name)`。
- bucket：必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$`，否则归一化为空；测试 `a/b c` 被清空。
- tar：读到 `L/K/x/g` 类型头直接抛"GNU/pax 扩展头无法安全解析"；测试手工把类型改成 `L` 并重算校验和，断言报错。

### 12–19. P3 正确性/健壮性

- 前言解析只为 `links`/`tags` 解析内联数组；`title: [草稿] 结论` 保持字符串。
- 建议：没有 `verified` 不再重复列"久未验证"；无法解析的日期给出专门提示。
- 条目/灵魂/偏好写入改为临时文件 + rename（`Evolver.writeDocument`），rename 失败清理临时文件。
- 实践扫描跳过 `*.tmp`，崩溃残留不会被当成条目。
- 记忆列表 `total` 改为过滤后的命中总数。
- 注入预览灵魂预算改用 `MAX_SOUL_BYTES`。
- 删除 `index.js` 重复 JSDoc；空路径提示改为"请填写路径"。

## 三、未修复项及原因

| # | 位置 | 原因 |
| --- | --- | --- |
| 20 | `src/practice.js` writeIndexes | 清理旧主题 `INDEX.md` 需要遍历并删除文件；误删用户文件的代价高于"磁盘上多几个过期索引"，当前扫描会忽略它们，不影响功能 |
| 21 | `src/evolver.js` overview/injection/practice | 加 TTL 扫描缓存能减少 readdir/lstat，但会让"外部改文件后立刻刷新"看到旧值，需同时设计失效点；当前条目规模下解析已缓存，开销可接受 |
| 22 | `src/memory-actions.js` save | 近似去重需要全量相似度；建索引要新增持久化状态，收益随条目数增长，当前规模不值得 |
| 23 | `src/memory/hybrid.js` | 向量召回是全量余弦；ANN 索引会引入依赖/状态，当前规模（千级）可接受 |
| 24 | `src/backup/archive.js` | `gzipSync` 阻塞事件循环；改异步 zlib 会让导出接口异步化（已经是异步）但增加并发窗口，当前导出是手动低频操作 |
| 25 | `src/backup/archive.js` restoreEntries | 保留归档权限是"自己的备份原样恢复"的预期；数据目录本身 0700，世界权限位无实际暴露面 |
| 26 | `src/practice.js` readPracticeEntry | INDEX.md/ARCHIVE.md 在实践根目录内，读取不越界、不泄露目录外内容；限制会破坏"用 practice_read 看索引"的用法 |
| 27 | `index.js` migrate/import | `openMemory` 失败只可能是本地磁盘致命错误；回滚需要同时回滚 root、settings、store 三者，失败窗口极窄，当前保留"切根成功、库打开失败"的原样报错 |
| 28 | 多处 | `readHead`/`readUpTo` 实现重复但分属不同模块；合并会让 `evolver.js` 依赖 `practice.js` 的内部工具或反之，重复比新增依赖方向更可控 |

## 四、回归验证清单

```bash
# 1. 全量测试（预期 92 通过 / 0 失败）
npm test

# 2. 语法检查入口文件
node --check index.js && node --check client.js

# 3. 数据目录实践树校验（预期 0 errors）
node scripts/build-index.mjs --check

# 4. 浏览器侧面板渲染（已含在 npm test 中）
#    点击导出/导入并断言可见 toast 的两条 render 测试
#    test/client.test.mjs
```

手动验证（可选，需重启宿主后）：

1. 设置 → 云端备份：填错误 AK 点"立即备份"，应看到失败提示；再改正确 AK，点"立即备份"应成功，且 5 分钟内不会重复上传。
2. 设置 → 导入/导出：连续点两次导出（两个面板标签页）应有一个提示"导出正在进行"。
3. 实践 → 编辑一条 `verified` 写成 `2026-13-01` 的条目，建议页应提示"不是可识别的日期"。
4. 手工把 `sight/soul.md` 改成 100 KB，打开面板概览：不应卡顿，灵魂内容被截断（`fullBytes` 可查）。
