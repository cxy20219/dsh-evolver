/*
 * dsh-evolver — browser half.
 *
 * One sidebar entry opens one panel with five tabs:
 * 概览 / 卡片 / 灵魂 / 偏好 / 设置.
 *
 * The panel shows the same three things the agent gets: the card projection,
 * the soul and the global preferences — plus the health of the folder.
 */
window.__ModuleLoader__.load({
	id: 'dsh-evolver',
	factory: function (require) {
		var react = require('react');

		var h = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;
		var useCallback = react.useCallback;
		var useMemo = react.useMemo;
		var useRef = react.useRef;

		/** One colour per top-level branch, shared by both graphs. */
		var LINK_BRANCH_COLORS = {
			'践行': '#4f8a6e',
			'见闻': '#657ea6',
			'即兴': '#a77b55',
			'复盘': '#87679a',
			'觉察': '#4f8794',
			'试错': '#9b6b6b',
		};

		var NS = 'dsh-evolver';
		var PANEL_ID = 'evolver';
		var PANEL_ORDER = 30;
		var API_PREFIX = '/api/evolver';

		//#region locale

		var zh = {
			'panel': '演化器',
			'tab.overview': '概览',
			'tab.cards': '卡片',
			'tab.soul': '灵魂',
			'cards.new': '新建卡片',
			'cards.search': '搜索卡片…',
			'cards.searchAction': '搜索',
			'cards.filter.all': '全部',
			'cards.filter.execution': '践行',
			'cards.filter.input': '见闻',
			'cards.filter.improvise': '即兴',
			'cards.filter.review': '复盘',
			'cards.filter.awareness': '觉察',
			'cards.filter.experiment': '试错',
			'cards.filter.archived': '归档',
			'cards.empty': '还没有卡片。',
			'cards.tags': '标签',
			'cards.tagReset': '全部标签',
			'cards.editor.new': '新建卡片',
			'cards.editor.edit': '编辑卡片',
			'cards.field.body': '正文',
			'cards.field.tags': '标签（逗号分隔）',
			'cards.field.links': '链接（卡片 id，逗号分隔）',
			'cards.field.tagsHint': '践行/工作流, 见闻/网络, 复盘/经验',
			'cards.charCount': '字',
			'cards.save': '保存',
			'cards.cancel': '取消',
			'cards.edit': '编辑',
			'cards.promote': '整理',
			'cards.archive': '归档',
			'cards.delete': '删除',
			'cards.deleteConfirm': '确定删除这张卡片？',
			'cards.attach': '添加附件',
			'cards.attachments': '附件',
			'cards.noAttachments': '暂无附件',
			'cards.links': '链接到',
			'cards.backlinks': '被引用',
			'cards.saved': '已保存',
			'cards.removed': '已删除',
			'cards.attachFailed': '附件读取失败',
			'settings.cardCap': '卡片正文上限',
			'settings.cardCapHint': '200–4000 字；超长内容请放资源附件。',
			'sight.ingest.auto': '闲时自动整理',
			'sight.ingest.on': '开',
			'sight.ingest.off': '关',
			'sight.ingest.enable': '启用',
			'sight.ingest.idleUnit': '分钟无活动后',
			'sight.ingest.pending': '待整理',
			'sight.ingest.processed': '已处理',
			'sight.ingest.unavailable': '宿主没有提供会话读取或模型调用能力。',
			'sight.ingest.run': '立即整理',
			'sight.ingest.done': '整理完成',
			'sight.ingest.sessionsUnit': '个会话',
			'sight.ingest.memoriesUnit': '条记忆',
			'tab.preferences': '偏好',
			'tab.settings': '设置',
			'state.migrated': '已迁移到新目录',
			'state.exported': '已导出',
			'state.imported': '已导入',
			'state.backed': '备份完成',
			'state.working': '处理中…',
			'state.skipped': '跳过',
			'action.refresh': '刷新',
			'action.save': '保存',
			'action.cancel': '撤销',
			'action.close': '关闭',
			'action.unlink': '移除全局链接',
			'state.loading': '读取中…',
			'state.error': '读取失败',
			'state.saved': '已保存',
			'state.linked': '已建立全局链接',
			'overview.stats': '数据概览',
			'overview.notes': '笔记',
			'overview.tags': '标签',
			'overview.days': '天',
			'overview.notesHint': '全部卡片',
			'overview.tagsHint': '唯一标签',
			'overview.daysHint': '自首张卡',
			'overview.yearHeatmap.hint': '记录 {notes} 条笔记 · {days} 天有记录。',
			'overview.heatmap.section': '记录热力',
			'overview.heatmap.empty': '还没有卡片活动。',
			'overview.heatmap.unit': '张',
			'overview.heatmap.less': '少',
			'overview.heatmap.more': '多',
			'overview.graph': '标签关系图',
			'overview.linkGraph': '链接关系图',
			'overview.linkGraph.hint': '卡片之间的双向链接，像 Obsidian 的关系图；悬停节点看卡片名。',
			'overview.linkGraph.label': '卡片链接关系图',
			'overview.linkGraph.empty': '还没有卡片之间的链接。',
			'overview.linkGraph.links': '条链接',
			'overview.tree.graphLabel': '标签关系图',
			'overview.tree.hint': '整棵树一次画完，标签沿射线排布。',
			'overview.tree.zoomHint': '滚轮缩放、拖动平移；点节点放大那一枝，点空白回到全貌。',
			'overview.graph.center': '标签',
			'overview.tree.empty': '还没有标签。',
			'overview.descriptions': '标签描述',
			'overview.descriptions.hint': '这些说明就写进 Agent 每次拿到的标签树；新分支出现后在这里补一句，注入立刻生效。',
			'overview.descriptions.placeholder': '这个分支收什么',
			'overview.descriptions.complete': '全部已描述',
			'overview.descriptions.saved': '标签描述已保存，注入已更新。',
			'overview.descriptions.missing': '{n} 个分支还没有描述',
			'overview.descriptions.warn': '留空的分支会以「只有计数、没有说明」的形式注入。',
			'overview.preview.readonly': '只读预览：Agent 每次请求都会收到这一段内容。',
			'overview.preview.empty': '这一段现在是空的。',
			'overview.bytes': '大小',
			'overview.entries': '条目',
			'overview.truncated': '已截断',
			'overview.link': '链接',
			'overview.cards': '标签树',
			'overview.soul': '灵魂',
			'overview.preferences': '偏好',
			'overview.budget': '预算',
			'overview.dropped': '未进索引',
			'overview.projection': '注入的标签树',
			'soul.hint': '灵魂是 Agent 的人格与边界，每个会话都会被读到；一次性的经历属于见闻。',
			'soul.content': '灵魂（Markdown）',
			'prefs.hint': '这里是全局偏好。保存后由 DSH 的 AGENTS.md 加载器注入给每个会话。',
			'prefs.content': '全局偏好（Markdown）',
			'prefs.global': '全局加载',
			'prefs.link.linked': '已链接',
			'prefs.link.foreign': '被其他来源占用',
			'prefs.link.missing': '未链接',
			'time.justNow': '刚刚',
			'time.minutes': '{n} 分钟前',
			'time.hours': '{n} 小时前',
			'time.days': '{n} 天前',
			'settings.hint': '数据目录决定卡片、灵魂与偏好放在哪里；云端备份把整个目录打包上传。',
			'settings.data': '数据目录',
			'settings.data.current': '当前目录',
			'settings.data.new': '新目录（绝对路径）',
			'settings.data.moveHint': '会先把现有数据复制过去，成功后再切换；旧目录保持原样，可回滚。',
			'settings.data.force': '目标目录非空时也继续（覆盖同名文件）',
			'settings.data.same': '这就是当前数据目录，选另一个目录再迁移。',
			'settings.data.source.settings': '来自本页设置',
			'settings.data.source.config': '来自组合配置',
			'settings.data.source.default': '默认目录',
			'settings.action.migrate': '迁移并切换',
			'settings.action.pick': '浏览…',
			'settings.pick.unavailable': '系统目录选择不可用，请手动输入绝对路径。',
			'settings.needDir': '先选一个导出目录。',
			'settings.needName': '给导出的压缩包起个文件名。',
			'settings.needArchive': '先选择或填写压缩包路径。',
			'settings.needDataDir': '先选择或填写新的数据目录。',
			'settings.transfer': '导入 / 导出',
			'settings.transfer.hint': '导出会生成一个 .tar.gz 压缩包（整份数据目录）；导入支持 .tar.gz / .tgz / .tar，默认不覆盖同名文件。',
			'settings.transfer.exportPath': '导出目录',
			'settings.transfer.exportName': '文件名',
			'settings.transfer.archives': '这个目录里的压缩包',
			'settings.transfer.noArchives': '这个目录里没有 .tar.gz / .tgz / .tar 文件。',
			'settings.transfer.importPath': '从压缩包导入（.tar.gz / .tgz / .tar）',
			'settings.transfer.force': '覆盖同名文件',
			'settings.action.export': '导出',
			'settings.action.import': '导入',
			'settings.backup': '云端备份（OSS）',
			'settings.backup.hint': '整个数据目录打成一个 tar 上传。密钥只存在本机设置文件（0600）里，不回传浏览器，也不会进备份。',
			'settings.backup.enabled': '启用自动备份',
			'settings.backup.endpoint': 'Endpoint',
			'settings.backup.endpointHint': '例如 oss-cn-hangzhou.aliyuncs.com；填 http(s):// 开头的完整地址则按路径风格访问网关。',
			'settings.backup.bucket': 'Bucket',
			'settings.backup.keyId': 'AccessKey ID',
			'settings.backup.keySecret': 'AccessKey Secret',
			'settings.backup.keySecret.saved': '已保存；留空表示不修改',
			'settings.backup.prefix': '对象前缀',
			'settings.backup.keep': '云端保留份数',
			'settings.backup.interval': '备份间隔（分钟）',
			'settings.backup.intervalHint': '5–10080（最长 7 天）',
			'settings.action.save': '保存备份设置',
			'settings.action.backupNow': '立即备份',
			'settings.action.test': '测试连接',
			'settings.action.clearSecret': '清除密钥',
			'settings.section.organize': '整理',
			'settings.organize.hint': '两个整理器做的是不同的事：会话整理读聊天记录、写出新卡片；卡片整理改的是已有的卡片库。',
			'settings.organize.ingestHint': '闲时读 DSH 会话，把值得留下的判断、偏好、踩坑和工具怪癖写成 #即兴 卡。',
			'settings.consolidate.title': '每天整理卡片',
			'settings.consolidate.hint': '每天挑一批卡片复查：用自己的话重写、找关联做双向链接、合并重复、删掉以后用不上的，并让标签树有序生长。被删掉的内容会先写进回收站日志。',
			'settings.consolidate.cards': '每天整理张数',
			'settings.consolidate.at': '执行时间',
			'settings.consolidate.hourUnit': '点（本机时区）',
			'settings.consolidate.run': '立即整理',
			'settings.consolidate.due': '待复查',
			'settings.consolidate.lastRun': '上次整理',
			'settings.consolidate.never': '还没整理过',
			'settings.consolidate.done': '整理完成 · 复查 {batch} 张 · 改动 {applied} 处',
			'settings.consolidate.trashHint': '回收站：数据目录的 knowledge/trash.jsonl；整理记录：knowledge/consolidation.json',
			'settings.section.backup': '云端备份',
			'settings.section.embedding': '向量模型',
			'settings.embedding.title': '见闻向量模型',
			'settings.embedding.hint': '决定「见闻」记忆用什么向量做语义召回。本地哈希零配置；本地模型需要先下载权重并安装运行时；HTTP 服务可接 Ollama、LM Studio、llama.cpp 等。切换后在后台重建全部向量，期间召回自动只用关键词。',
			'settings.embedding.status': '当前状态',
			'settings.embedding.backend': '后端',
			'settings.embedding.dimensions': '维度',
			'settings.embedding.aligned': '向量已对齐',
			'settings.embedding.rebuilding': '向量重建中',
			'settings.embedding.entries': '卡片条数',
			'settings.embedding.provider': '后端类型',
			'settings.embedding.providerLocal': '本地哈希（零配置）',
			'settings.embedding.providerModel': '本地 ONNX 模型',
			'settings.embedding.providerHttp': 'HTTP 服务',
			'settings.embedding.localHint': '哈希向量只用词面相似度，不联网、不占内存；语义相近但用词不同的记忆可能召回不到。',
			'settings.embedding.catalog': '可选模型',
			'settings.embedding.download': '下载权重',
			'settings.embedding.cancel': '取消下载',
			'settings.embedding.downloaded': '已下载',
			'settings.embedding.notDownloaded': '未下载',
			'settings.embedding.downloading': '正在下载',
			'settings.embedding.downloadDone': '权重已下载完成',
			'settings.embedding.runtime': '运行时目录',
			'settings.embedding.runtimeReady': '运行时可用',
			'settings.embedding.runtimeMissing': '运行时未安装（本地模型需要 transformers.js）',
			'settings.embedding.runtimeHint': '在终端执行下面的命令安装（约 300 MB），装完保存或测试即可生效：',
			'settings.embedding.runtimeFieldHint': '留空用默认位置（数据目录之外）',
			'settings.embedding.storage': '权重保存在数据目录的 models/ 下，随备份、导入、导出一起走；大模型会明显增大备份与导出体积。',
			'settings.embedding.mirror': '下载源',
			'settings.embedding.mirrorHint': '默认 hf-mirror.com；在国外可改成 https://huggingface.co',
			'settings.embedding.baseURL': '服务地址',
			'settings.embedding.baseURLHint': 'OpenAI 兼容的 /v1/embeddings，例如 http://127.0.0.1:11434/v1（Ollama）',
			'settings.embedding.modelName': '模型名称',
			'settings.embedding.apiKey': 'API Key（可选）',
			'settings.embedding.hasKey': '已保存；留空表示不修改',
			'settings.embedding.save': '保存向量设置',
			'settings.embedding.test': '测试后端',
			'settings.embedding.testOk': '后端可用',
			'settings.embedding.fellBack': '配置的后端不可用，已退回本地哈希',
			'settings.backup.status': '备份状态',
			'settings.backup.lastBackup': '上次成功',
			'settings.backup.lastAttempt': '上次尝试',
			'settings.backup.size': '大小',
			'settings.backup.files': '文件数',
			'settings.backup.removed': '清理旧份数',
			'settings.backup.object': '最近对象',
			'settings.backup.never': '还没有备份',
			'settings.backup.running': '正在备份…',
			'settings.backup.error': '错误',
			'settings.backup.settingsPath': '设置文件',
			'settings.backup.testOk': '连接成功',
		};

		var en = {
			'panel': 'Evolver',
			'tab.overview': 'Overview',
			'tab.cards': 'Cards',
			'tab.soul': 'Soul',
			'cards.new': 'New card',
			'cards.search': 'Search cards…',
			'cards.searchAction': 'Search',
			'cards.filter.all': 'All',
			'cards.filter.execution': 'Practice',
			'cards.filter.input': 'Input',
			'cards.filter.improvise': 'Improvise',
			'cards.filter.review': 'Review',
			'cards.filter.awareness': 'Awareness',
			'cards.filter.experiment': 'Experiment',
			'cards.filter.archived': 'Archived',
			'cards.empty': 'No cards yet.',
			'cards.tags': 'Tags',
			'cards.tagReset': 'All tags',
			'cards.editor.new': 'New card',
			'cards.editor.edit': 'Edit card',
			'cards.field.body': 'Body',
			'cards.field.tags': 'Tags (comma separated)',
			'cards.field.links': 'Links (card ids, comma separated)',
			'cards.field.tagsHint': 'practice/workflow, input/network, review/experience',
			'cards.charCount': 'chars',
			'cards.save': 'Save',
			'cards.cancel': 'Cancel',
			'cards.edit': 'Edit',
			'cards.promote': 'Settle',
			'cards.archive': 'Archive',
			'cards.delete': 'Delete',
			'cards.deleteConfirm': 'Delete this card?',
			'cards.attach': 'Add attachment',
			'cards.attachments': 'Attachments',
			'cards.noAttachments': 'No attachments',
			'cards.links': 'Links to',
			'cards.backlinks': 'Linked from',
			'cards.saved': 'Saved',
			'cards.removed': 'Removed',
			'cards.attachFailed': 'Could not read the attachment',
			'settings.cardCap': 'Card body limit',
			'settings.cardCapHint': '200–4000 characters; long content should be an attachment.',
			'sight.ingest.auto': 'Automatic on idle',
			'sight.ingest.on': 'On',
			'sight.ingest.off': 'Off',
			'sight.ingest.enable': 'Enable',
			'sight.ingest.idleUnit': 'minutes without activity',
			'sight.ingest.pending': 'Pending',
			'sight.ingest.processed': 'Processed',
			'sight.ingest.unavailable': 'This host does not expose session reading or model calls.',
			'sight.ingest.run': 'Run now',
			'sight.ingest.done': 'Ingest finished',
			'sight.ingest.sessionsUnit': 'sessions',
			'sight.ingest.memoriesUnit': 'memories',
			'tab.preferences': 'Preferences',
			'tab.settings': 'Settings',
			'state.migrated': 'Moved to the new folder',
			'state.exported': 'Exported',
			'state.imported': 'Imported',
			'state.backed': 'Backup complete',
			'state.working': 'Working…',
			'state.skipped': 'skipped',
			'action.refresh': 'Refresh',
			'action.save': 'Save',
			'action.cancel': 'Revert',
			'action.close': 'Close',
			'action.unlink': 'Remove the global link',
			'state.loading': 'Loading…',
			'state.error': 'Failed to read',
			'state.saved': 'Saved',
			'state.linked': 'The global link is in place',
			'overview.stats': 'Overview',
			'overview.notes': 'Notes',
			'overview.tags': 'Tags',
			'overview.days': 'Days',
			'overview.notesHint': 'All cards',
			'overview.tagsHint': 'Unique tags',
			'overview.daysHint': 'Since the first card',
			'overview.yearHeatmap.hint': '{notes} notes · {days} active days.',
			'overview.heatmap.section': 'Activity',
			'overview.heatmap.empty': 'No card activity yet.',
			'overview.heatmap.unit': 'cards',
			'overview.heatmap.less': 'Less',
			'overview.heatmap.more': 'More',
			'overview.graph': 'Tag graph',
			'overview.linkGraph': 'Link graph',
			'overview.linkGraph.hint': 'The links between cards, like the graph in Obsidian; hover a node for its name.',
			'overview.linkGraph.label': 'Card link graph',
			'overview.linkGraph.empty': 'No links between cards yet.',
			'overview.linkGraph.links': 'links',
			'overview.tree.graphLabel': 'Tag relationship graph',
			'overview.tree.hint': 'The whole tree, drawn once; labels follow their spoke.',
			'overview.tree.zoomHint': 'Scroll to zoom, drag to pan; click a node to frame its branch, click the empty space to fit the tree.',
			'overview.graph.center': 'Tags',
			'overview.tree.empty': 'No tags yet.',
			'overview.descriptions': 'Tag descriptions',
			'overview.descriptions.hint': 'These notes are what the injected tag tree says; a new branch can be described here and the prompt picks it up immediately.',
			'overview.descriptions.placeholder': 'What belongs in this branch',
			'overview.descriptions.complete': 'All described',
			'overview.descriptions.saved': 'Tag descriptions saved; the injection is updated.',
			'overview.descriptions.missing': '{n} branches without a description',
			'overview.descriptions.warn': 'A blank branch is injected as a count with no meaning.',
			'overview.preview.readonly': 'Read-only preview: the agent receives this block on every request.',
			'overview.preview.empty': 'This block is empty.',
			'overview.bytes': 'Size',
			'overview.entries': 'Entries',
			'overview.truncated': 'Truncated',
			'overview.link': 'Link',
			'overview.cards': 'Tag tree',
			'overview.soul': 'Soul',
			'overview.preferences': 'Preferences',
			'overview.budget': 'Budget',
			'overview.dropped': 'Left out of the index',
			'overview.projection': 'Injected tag tree',
			'soul.hint': 'The soul is the agent’s persona and boundaries; it is read in every session.',
			'soul.content': 'Soul (Markdown)',
			'prefs.hint': 'Global preferences. DSH injects this file through its AGENTS.md loader.',
			'prefs.content': 'Global preferences (Markdown)',
			'prefs.global': 'Global load',
			'prefs.link.linked': 'linked',
			'prefs.link.foreign': 'linked elsewhere',
			'prefs.link.missing': 'not linked',
			'time.justNow': 'just now',
			'time.minutes': '{n} min ago',
			'time.hours': '{n} h ago',
			'time.days': '{n} d ago',
			'settings.hint': 'The data folder holds the cards, the soul and the preferences; a cloud backup uploads the whole folder.',
			'settings.data': 'Data folder',
			'settings.data.current': 'Current folder',
			'settings.data.new': 'New folder (absolute path)',
			'settings.data.moveHint': 'The data is copied first and the switch happens only after the copy; the old folder stays as it was.',
			'settings.data.force': 'Continue even when the target folder is not empty (overwrite files)',
			'settings.data.same': 'That is the current data folder; pick another one to move.',
			'settings.data.source.settings': 'from this page',
			'settings.data.source.config': 'from the composition config',
			'settings.data.source.default': 'default folder',
			'settings.action.migrate': 'Move and switch',
			'settings.action.pick': 'Browse…',
			'settings.pick.unavailable': 'The system folder picker is unavailable; type an absolute path.',
			'settings.needDir': 'Choose an export folder first.',
			'settings.needName': 'Give the archive a file name.',
			'settings.needArchive': 'Choose or type an archive path first.',
			'settings.needDataDir': 'Choose or type the new data folder first.',
			'settings.transfer': 'Import / export',
			'settings.transfer.hint': 'Export writes one .tar.gz archive of the whole data folder; import accepts .tar.gz / .tgz / .tar and does not overwrite by default.',
			'settings.transfer.exportPath': 'Export folder',
			'settings.transfer.exportName': 'File name',
			'settings.transfer.archives': 'Archives in that folder',
			'settings.transfer.noArchives': 'No .tar.gz / .tgz / .tar files in that folder.',
			'settings.transfer.importPath': 'Import from an archive (.tar.gz / .tgz / .tar)',
			'settings.transfer.force': 'Overwrite existing files',
			'settings.action.export': 'Export',
			'settings.action.import': 'Import',
			'settings.backup': 'Cloud backup (OSS)',
			'settings.backup.hint': 'The whole data folder becomes one tar upload. The secret lives in the local settings file (0600), never returns to the browser and never enters a backup.',
			'settings.backup.enabled': 'Automatic backup',
			'settings.backup.endpoint': 'Endpoint',
			'settings.backup.endpointHint': 'e.g. oss-cn-hangzhou.aliyuncs.com; a full http(s):// URL uses path-style access.',
			'settings.backup.bucket': 'Bucket',
			'settings.backup.keyId': 'AccessKey ID',
			'settings.backup.keySecret': 'AccessKey Secret',
			'settings.backup.keySecret.saved': 'saved; leave empty to keep it',
			'settings.backup.prefix': 'Object prefix',
			'settings.backup.keep': 'Copies to keep',
			'settings.backup.interval': 'Interval (minutes)',
			'settings.backup.intervalHint': '5–10080 (up to 7 days)',
			'settings.action.save': 'Save backup settings',
			'settings.action.backupNow': 'Back up now',
			'settings.action.test': 'Test connection',
			'settings.action.clearSecret': 'Clear the secret',
			'settings.section.organize': 'Organise',
			'settings.organize.hint': 'Two different jobs: the session ingest reads conversations and writes new cards; the card consolidation edits the library that already exists.',
			'settings.organize.ingestHint': 'Reads DSH sessions when idle and turns durable judgements, preferences, failures and tool quirks into #即兴 cards.',
			'settings.consolidate.title': 'Daily card consolidation',
			'settings.consolidate.hint': 'Reviews a batch of cards every day: rewrite in your own words, link related cards both ways, merge duplicates, delete what has no future use, and keep the tag tree growing in order. Removed content lands in a trash log first.',
			'settings.consolidate.cards': 'Cards per day',
			'settings.consolidate.at': 'Runs at',
			'settings.consolidate.hourUnit': ':00 local time',
			'settings.consolidate.run': 'Consolidate now',
			'settings.consolidate.due': 'Due for review',
			'settings.consolidate.lastRun': 'Last run',
			'settings.consolidate.never': 'never',
			'settings.consolidate.done': 'Done · reviewed {batch} · applied {applied}',
			'settings.consolidate.trashHint': 'Trash: knowledge/trash.jsonl in the data folder; review ledger: knowledge/consolidation.json',
			'settings.section.backup': 'Cloud backup',
			'settings.section.embedding': 'Embeddings',
			'settings.embedding.title': 'Memory embeddings',
			'settings.embedding.hint': 'Choose how memories are vectorised. Hashing needs no setup; a local model needs downloaded weights plus the ONNX runtime; an HTTP service can point at Ollama, LM Studio or llama.cpp. Changing this rebuilds every vector in the background — recall falls back to keywords meanwhile.',
			'settings.embedding.status': 'Current state',
			'settings.embedding.backend': 'Backend',
			'settings.embedding.dimensions': 'Dimensions',
			'settings.embedding.aligned': 'Vectors aligned',
			'settings.embedding.rebuilding': 'Rebuilding vectors',
			'settings.embedding.entries': 'Cards',
			'settings.embedding.provider': 'Backend type',
			'settings.embedding.providerLocal': 'Local hashing (no setup)',
			'settings.embedding.providerModel': 'Local ONNX model',
			'settings.embedding.providerHttp': 'HTTP service',
			'settings.embedding.localHint': 'Hashing only compares word overlap: offline and cheap, but a memory phrased differently may be missed.',
			'settings.embedding.catalog': 'Available models',
			'settings.embedding.download': 'Download',
			'settings.embedding.cancel': 'Cancel download',
			'settings.embedding.downloaded': 'Downloaded',
			'settings.embedding.notDownloaded': 'Not downloaded',
			'settings.embedding.downloading': 'Downloading',
			'settings.embedding.downloadDone': 'Weights downloaded',
			'settings.embedding.runtime': 'Runtime folder',
			'settings.embedding.runtimeReady': 'Runtime available',
			'settings.embedding.runtimeMissing': 'Runtime missing (the local model needs transformers.js)',
			'settings.embedding.runtimeHint': 'Install it once in a terminal (about 300 MB), then save or test:',
			'settings.embedding.runtimeFieldHint': 'Empty uses the default (outside the data folder)',
			'settings.embedding.storage': 'Weights live in data/models and travel with backups, imports and exports; a large model makes both noticeably bigger.',
			'settings.embedding.mirror': 'Download source',
			'settings.embedding.mirrorHint': 'Defaults to hf-mirror.com; use https://huggingface.co elsewhere',
			'settings.embedding.baseURL': 'Service URL',
			'settings.embedding.baseURLHint': 'OpenAI-compatible /v1/embeddings, e.g. http://127.0.0.1:11434/v1 (Ollama)',
			'settings.embedding.modelName': 'Model name',
			'settings.embedding.apiKey': 'API key (optional)',
			'settings.embedding.hasKey': 'Stored; leave empty to keep it',
			'settings.embedding.save': 'Save embedding settings',
			'settings.embedding.test': 'Test backend',
			'settings.embedding.testOk': 'Backend works',
			'settings.embedding.fellBack': 'Configured backend unavailable; fell back to hashing',
			'settings.backup.status': 'Backup status',
			'settings.backup.lastBackup': 'Last success',
			'settings.backup.lastAttempt': 'Last attempt',
			'settings.backup.size': 'Size',
			'settings.backup.files': 'Files',
			'settings.backup.removed': 'Old copies removed',
			'settings.backup.object': 'Latest object',
			'settings.backup.never': 'no backup yet',
			'settings.backup.running': 'backing up…',
			'settings.backup.error': 'Error',
			'settings.backup.settingsPath': 'Settings file',
			'settings.backup.testOk': 'Connection OK',
		};

		//#endregion

		//#region vocabulary

		/** The tabs in the order the panel shows them. */
		var TABS = [
			{ id: 'overview', label: 'tab.overview' },
			{ id: 'cards', label: 'tab.cards' },
			{ id: 'soul', label: 'tab.soul' },
			{ id: 'preferences', label: 'tab.preferences' },
			{ id: 'settings', label: 'tab.settings' },
		];

		//#endregion

		//#region styles

		var css = [
			'.evrRoot{position:relative;height:100%;display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}',
			'.evrHead{display:flex;align-items:flex-start;gap:16px;padding:22px 28px 0;flex:none}',
			'.evrHeadMain{flex:1;min-width:0}',
			'.evrTitle{margin:0;font-size:18px;font-weight:600;line-height:26px;letter-spacing:-.01em}',
			'.evrVersion{margin-left:8px;font-size:12px;font-weight:500;letter-spacing:0;color:var(--dsw-alias-label-tertiary);vertical-align:2px}',
			'.evrSubtitle{margin-top:3px;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.evrHeadActions{display:flex;align-items:center;gap:8px;flex:none;padding-top:3px}',
			'.evrTabs{display:flex;gap:4px;padding:16px 28px 0;flex:none;flex-wrap:wrap}',
			'.evrTab{display:inline-flex;align-items:center;height:28px;padding:0 11px;border:1px solid transparent;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease}',
			'.evrTab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.evrTab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
			'.evrTabActive{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500;border-color:var(--dsw-alias-border-l2)}',
			'.evrBody{flex:1;min-height:0;overflow:auto;padding:18px 28px 36px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}',
			'.evrBody::-webkit-scrollbar{width:10px;height:10px}',
			'.evrBody::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border:3px solid transparent;border-radius:6px;background-clip:content-box}',
			'.evrEnter{animation:evrEnter .22s cubic-bezier(.2,.7,.3,1) both;height:100%}',
			'@keyframes evrEnter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
			'@media (prefers-reduced-motion:reduce){.evrEnter{animation:none}}',
			'.evrGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}',
			'.evrCard{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:14px 16px;transition:border-color .15s ease,box-shadow .15s ease}',
			'.evrCard:hover{border-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-soft)}',
			'.evrCardHead{display:flex;align-items:center;gap:8px;margin-bottom:6px}',
			'.evrCardTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.evrCardCount{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
			'.evrCardHint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.55}',
			'.evrCardValue{font-size:22px;font-weight:600;line-height:28px;letter-spacing:-.02em;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
			'.evrSection{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin:22px 0 10px;display:flex;align-items:center;gap:10px}',
			'.evrSection::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l2)}',
			'.evrRow{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);margin-bottom:6px;cursor:pointer;transition:border-color .15s ease,background .15s ease}',
			'.evrRow:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}',
			'.evrRowMain{flex:1;min-width:0}',
			'.evrRowTitle{font-size:13px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.evrRowMeta{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.evrRowTime{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
			'.evrTagNode{display:flex;align-items:center;gap:2px;border-radius:var(--dsw-radius-sm)}',
			'.evrTagToggle{width:16px;height:24px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1;cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center}',
			'.evrTagToggle:hover{color:var(--dsw-alias-label-primary)}',
			'.evrTagToggleSpacer{cursor:default;visibility:hidden}',
			'.evrTagBtn{display:flex;align-items:center;justify-content:space-between;gap:6px;flex:1;min-width:0;padding:5px 4px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;text-align:left}',
			'.evrTagBtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
			'.evrTagBtnActive{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}',
			'.evrTagName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}',
			'.evrTagCount{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
			'.evrTagBtnStatic{cursor:default}',
			'.evrTagBtnStatic:hover{background:transparent;color:var(--dsw-alias-label-secondary)}',
			'.evrSubTabs{display:flex;gap:4px;flex-wrap:wrap;padding-bottom:8px;margin-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
			'.evrBadge{margin-left:auto;flex:none;padding:1px 7px;border-radius:99px;font-size:11px;font-weight:500;line-height:1.6;letter-spacing:0;text-transform:none}',
			'.evrBadgeOk{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}',
			'.evrBadgeWarn{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-state-warn-primary)}',
			'.evrDescList{display:flex;flex-direction:column;gap:2px;margin-bottom:4px}',
			'.evrDescRow{display:grid;grid-template-columns:minmax(120px,200px) minmax(0,1fr) 32px;gap:10px;align-items:center;padding:2px 0}',
			'.evrDescTag{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.evrDescRowMissing .evrDescTag{color:var(--dsw-alias-label-primary);font-weight:500}',
			'.evrDescInput{height:26px;font-size:12px}',
			'.evrDescRowMissing .evrDescInput{border-color:var(--dsw-alias-state-warn-primary)}',
			'.evrDescCount{flex:none;text-align:right;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
			'.evrMetaRow{display:flex;flex-wrap:wrap;gap:6px 20px;margin-bottom:14px}',
			'.evrMetaItem{display:inline-flex;align-items:baseline;gap:6px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
			'.evrMetaValue{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}',
			'.evrMd{font-size:13px;line-height:1.75;color:var(--dsw-alias-label-primary)}',
			'.evrMd h1,.evrMd h2,.evrMd h3,.evrMd h4,.evrMd h5,.evrMd h6{margin:16px 0 4px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}',
			'.evrMd h1{font-size:17px}',
			'.evrMd h2{font-size:15px}',
			'.evrMd h3{font-size:13.5px}',
			'.evrMd h4,.evrMd h5,.evrMd h6{font-size:13px}',
			'.evrMd h1:first-child,.evrMd h2:first-child,.evrMd h3:first-child{margin-top:0}',
			'.evrMdLine{margin:0}',
			'.evrMdList{margin:2px 0 8px;padding-left:18px}',
			'.evrMdList li{margin:2px 0}',
			'.evrMdQuote{margin:6px 0;padding:2px 0 2px 12px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
			'.evrMd code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;padding:1px 5px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3)}',
			'.evrMdPre{margin:8px 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);overflow-x:auto;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.65;white-space:pre-wrap}',
			'.evrMdPre code{padding:0;background:transparent}',
			'.evrMd hr{border:0;border-top:1px solid var(--dsw-alias-border-l2);margin:14px 0}',
			'.evrMd a{color:var(--dsw-alias-state-business-primary)}',
			'.evrCardsLayout{position:relative;display:grid;grid-template-columns:190px minmax(0,1fr);gap:18px;align-items:start;min-height:100%}',
			'.evrCardsTree{width:190px}',
			'.evrCardsBody{position:absolute;left:208px;right:0;top:0;bottom:0;display:flex;flex-direction:column;min-width:0}',
			'.evrCardsScroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding-right:6px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}',
			'.evrCardsScroll::-webkit-scrollbar{width:10px;height:10px}',
			'.evrCardsScroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border:3px solid transparent;border-radius:6px;background-clip:content-box}',
			'.evrOverviewSplit{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}',
			'.evrOverviewGraph{flex:1 1 0;min-width:0}',
			'.evrOverviewTree{flex:1 1 0;min-width:0}',
			'.evrLinkGraph{width:100%;height:auto;max-width:420px;display:block;margin:0 auto}',
			'.evrLinkEdge{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:1;stroke-opacity:.5}',
			'.evrLinkEdgeMutual{stroke-opacity:.85;stroke-width:1.4}',
			'.evrLinkNode circle{stroke:var(--dsw-alias-bg-base);stroke-width:1}',
			'.evrGraphWrap{position:relative}',
			'.evrGraph{width:100%;height:auto;max-width:460px;display:block;margin:0 auto;cursor:grab;touch-action:none}',
			'.evrGraph:active{cursor:grabbing}',
			'.evrGraphEdge{fill:none;stroke-width:1;stroke-opacity:.45}',
			'.evrGraphDot{fill:var(--dsw-alias-bg-base);stroke-width:1.2}',
			'.evrGraphDotRoot{fill:var(--dsw-alias-bg-base);stroke-width:1.6}',
			'.evrGraphHub{fill:var(--dsw-alias-label-tertiary)}',
			'.evrGraphLabel{fill:var(--dsw-alias-label-secondary);font-size:11px;font-family:inherit;cursor:pointer;user-select:none}',
			'.evrGraphRoot{fill:var(--dsw-alias-label-primary);font-size:12px;font-weight:500}',
			'.evrGraphNode:hover .evrGraphLabel{fill:var(--dsw-alias-label-primary)}',
			'.evrGraphNode:focus{outline:none}',
			'.evrGraphNode:focus .evrGraphLabel{fill:var(--dsw-alias-label-primary)}',
			'.evrGraphTip{position:absolute;transform:translate(8px,-50%);padding:4px 9px;border-radius:6px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 2px 8px rgba(0,0,0,.12);font-size:11px;color:var(--dsw-alias-label-primary);white-space:nowrap;pointer-events:none}',
			'.evrHeatmapWrap{--eh-cols:53;--eh-gap:2px;--eh-min:7px;--eh-max:18px;--eh-h:auto;--eh-ar:1;--eh-width:calc(var(--eh-cols) * var(--eh-max) + (var(--eh-cols) - 1) * var(--eh-gap));overflow-x:auto;padding:2px 18px 2px 0}',
			'.evrHeatmapBody{display:grid;grid-template-columns:12px minmax(0,1fr);gap:6px;align-items:stretch}',
			'.evrHeatmapDays{display:grid;grid-template-rows:repeat(7,1fr);font-size:9px;color:var(--dsw-alias-label-tertiary);text-align:right}',
			'.evrHeatmapDays span{display:flex;align-items:center;justify-content:flex-end}',
			'.evrHeatmapMonths{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(var(--eh-min),1fr);gap:var(--eh-gap);margin-left:18px;margin-bottom:4px;max-width:var(--eh-width);font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
			'.evrHeatmap{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(var(--eh-min),1fr);gap:var(--eh-gap);max-width:var(--eh-width)}',
			'.evrHeatmapWeek{display:grid;grid-template-rows:repeat(7,auto);gap:var(--eh-gap)}',
			'.evrHeatCell{width:100%;height:var(--eh-h);aspect-ratio:var(--eh-ar);border-radius:3px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);box-sizing:border-box}',
			'.evrHeatBlank{background:none;border-color:transparent}',
			'.evrHeat1{background:rgba(72,187,120,.28)}',
			'.evrHeat2{background:rgba(72,187,120,.55)}',
			'.evrHeat3{background:rgba(47,174,114,.85)}',
			'.evrHeatLegend{display:flex;align-items:center;gap:4px;margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.evrHeatLegend .evrHeatCell{width:10px;height:10px}',
			'.evrTag{display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;flex:none}',
			'.evrToolbar{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}',
			'.evrInput{flex:1;min-width:160px;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;box-sizing:border-box}',
			'.evrInput:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
			'.evrInputNarrow{flex:none;width:88px;min-width:0}',
			'.evrBtn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;transition:background .15s ease,border-color .15s ease}',
			'.evrBtn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}',
			'.evrBtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
			'.evrBtnPrimary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}',
			'.evrBtnDanger{color:var(--dsw-alias-state-error-primary)}',
			'.evrBtn[disabled]{opacity:.5;cursor:default}',
			'.evrTextarea{width:100%;min-height:220px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:12.5px;line-height:1.7;resize:vertical;box-sizing:border-box;tab-size:2}',
			'.evrTextarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
			'.evrEditorFoot{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}',
			'.evrField{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}',
			'.evrFieldRow{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}',
			'.evrLabel{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
			'.evrHint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.55}',
			'.evrEmpty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:44px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);line-height:1.7}',
			'.evrSpinner{display:flex;align-items:center;justify-content:center;padding:36px 0;color:var(--dsw-alias-label-tertiary)}',
			'.evrStatus{font-size:12px;margin-left:auto;color:var(--dsw-alias-label-tertiary)}',
			'.evrStatusError{color:var(--dsw-alias-state-error-primary)}',
			'.evrStatusOk{color:var(--dsw-alias-state-success-primary)}',
			'.evrMono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px}',
			'.evrPre{white-space:pre-wrap;word-break:break-word;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:10px 12px;margin:0}',
			'.evrWarn{border-left:3px solid var(--dsw-alias-state-warn-primary);padding-left:10px}',
			'.evrToast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:30;display:flex;align-items:center;gap:10px;max-width:min(620px,84%);padding:9px 11px 9px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-soft);font-size:12.5px;line-height:1.5}',
			'.evrToastOk{color:var(--dsw-alias-state-success-primary)}',
			'.evrToastError{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
			'.evrToastText{white-space:pre-wrap;word-break:break-word}',
			'.evrToastClose{flex:none;border:0;background:transparent;color:inherit;cursor:pointer;font-size:16px;line-height:1;padding:0 2px}',
			'.evrError{border-left:3px solid var(--dsw-alias-state-error-primary);padding-left:10px}',
			'.evrBtnOk{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);background:transparent}',
			'.evrBtnOk:disabled{opacity:1;cursor:default}',
			'.evrBar{height:6px;border-radius:99px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;margin:6px 0 8px}',
			'.evrBarFill{height:100%;background:var(--dsw-alias-state-business-primary,currentColor);border-radius:99px;transition:width .3s ease}',
		].join('\n');

		//#endregion

		//#region helpers

		/**
		 * Call one `/api/evolver` endpoint on the Host.
		 *
		 * @param {object} ctx - Client context.
		 * @param {string} endpoint - Endpoint name.
		 * @param {object} payload - JSON payload.
		 * @returns {Promise<object>} The endpoint's value.
		 */
		function callHost(ctx, endpoint, payload, timeoutMs) {
			if (ctx.get('connection') === undefined) return Promise.reject(new Error('连接不可用'));
			var deadline = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30000;
			var options = {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload ?? {}),
				credentials: 'same-origin',
			};
			// A hung Host must not leave every button disabled for the rest of the
			// session: the panel gives the request a deadline.
			if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
				options.signal = AbortSignal.timeout(deadline);
			}
			return fetch(API_PREFIX + '/' + endpoint, options).then(function (response) {
				return response.json().then(function (value) {
					var error = value !== null && typeof value === 'object' ? value.error : undefined;
					if (!response.ok || error !== undefined) {
						throw new Error((error && (error.message || error.code)) || ('HTTP ' + response.status));
					}
					return value;
				});
			}).catch(function (reason) {
				if (reason && (reason.name === 'TimeoutError' || reason.name === 'AbortError')) {
					throw new Error('请求超时（' + Math.round(deadline / 1000) + ' 秒）');
				}
				throw reason;
			});
		}

		/**
		 * Human-readable relative time.
		 *
		 * @param {string | null | undefined} iso - ISO timestamp.
		 * @param {Function} t - Translator.
		 * @returns {string} The formatted time.
		 */
		function relativeTime(iso, t) {
			if (typeof iso !== 'string' || iso === '') return '';
			var stamp = Date.parse(iso);
			if (!Number.isFinite(stamp)) return '';
			var seconds = Math.max(0, Math.round((Date.now() - stamp) / 1000));
			if (seconds < 60) return t('time.justNow');
			var minutes = Math.round(seconds / 60);
			if (minutes < 60) return t('time.minutes', { n: minutes });
			var hours = Math.round(minutes / 60);
			if (hours < 24) return t('time.hours', { n: hours });
			return t('time.days', { n: Math.round(hours / 24) });
		}

		/**
		 * The exact local time of a timestamp.
		 *
		 * @param {string} iso - ISO timestamp.
		 * @param {boolean} withSeconds - Whether to include the seconds.
		 * @returns {string} The formatted time.
		 */
		function absoluteTime(iso, withSeconds) {
			var stamp = Date.parse(iso);
			if (!Number.isFinite(stamp)) return '';
			var date = new Date(stamp);
			var pad = function (value) { return String(value).padStart(2, '0'); };
			var text = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
				+ ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
			return withSeconds === true ? text + ':' + pad(date.getSeconds()) : text;
		}

		/**
		 * The time of a card: relative while it is fresh, exact once it is old.
		 *
		 * Cards from the last day read as "3 分钟前"; older ones fall back to
		 * the exact local time, because a date alone hides when it happened.
		 *
		 * @param {string} iso - ISO timestamp.
		 * @param {Function} t - Translator.
		 * @returns {string} The formatted time.
		 */
		function cardTime(iso, t) {
			if (typeof iso !== 'string' || iso === '') return '';
			var stamp = Date.parse(iso);
			if (!Number.isFinite(stamp)) return '';
			var seconds = Math.max(0, Math.round((Date.now() - stamp) / 1000));
			if (seconds < 60) return t('time.justNow');
			var minutes = Math.round(seconds / 60);
			if (minutes < 60) return t('time.minutes', { n: minutes });
			var hours = Math.round(minutes / 60);
			if (hours < 24) return t('time.hours', { n: hours });
			return absoluteTime(iso, false);
		}

		/**
		 * Human-readable file size.
		 *
		 * @param {number} size - Byte count.
		 * @returns {string} The formatted size.
		 */
		function formatBytes(size) {
			var value = Number(size);
			if (!Number.isFinite(value)) return '';
			if (value < 1024) return value + ' B';
			if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
			return (value / 1024 / 1024).toFixed(1) + ' MB';
		}

		//#endregion

		//#region components

		/**
		 * The sidebar glyph: an orbit around a core.
		 *
		 * @param {object} props - Slot props.
		 * @returns {object} The element tree.
		 */
		function EvolverIcon(props) {
			var size = props.size ?? 18;
			return h('svg', {
				viewBox: '0 0 24 24',
				width: size,
				height: size,
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.7,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': true,
			},
				h('path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1' }),
				h('path', { d: 'M20.5 4.6V9h-4.4' }),
				h('circle', { cx: 12, cy: 12, r: 3.1 })
			);
		}

		/**
		 * The empty state.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function Empty(props) {
			return h('div', { className: 'evrEmpty' },
				h('div', { className: 'evrMono' }, '∅'),
				h('div', null, props.children));
		}

		/**
		 * The loading state.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function Spinner(props) {
			return h('div', { className: 'evrSpinner' }, props.children);
		}

		/**
		 * One statistic card.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function StatCard(props) {
			return h('div', { className: 'evrCard' },
				h('div', { className: 'evrCardHead' },
					h('span', { className: 'evrCardTitle' }, props.title),
					props.count === undefined ? null : h('span', { className: 'evrCardCount' }, String(props.count))),
				h('div', { className: 'evrCardValue' }, props.value),
				props.hint === undefined ? null : h('div', { className: 'evrCardHint' }, props.hint));
		}

		/**
		 * How much angular room a subtree needs.
		 *
		 * A branch's share of the circle is proportional to how many leaf tags
		 * hang off it, so a node with six children never gets the same slice
		 * as a node with none.
		 *
		 * @param {object} node - The tag node.
		 * @returns {number} The weight.
		 */
		/**
		 * The label of one node.
		 *
		 * Only roots carry their count: on a crowded ring the extra number is
		 * what pushes neighbouring labels into each other, and the exact
		 * count is one hover away.
		 *
		 * @param {object} node - The laid-out node.
		 * @returns {string} The label text.
		 */
		function tagGraphLabelOf(node) {
			return node.depth === 0 ? '#' + node.name + ' ' + node.count : '#' + node.name;
		}

		/**
		 * Estimate the rendered width of a label in graph units.
		 *
		 * @param {string} text - The label text.
		 * @returns {number} The width.
		 */
		function labelExtent(text) {
			var total = 0;
			for (var index = 0; index < text.length; index += 1) {
				total += text.charCodeAt(index) > 0x2e80 ? 11 : 6.1;
			}
			return total;
		}

		function tagGraphWeight(node) {
			var children = node.children ?? [];
			if (children.length === 0) return 1;
			return Math.max(1, children.reduce(function (sum, child) { return sum + tagGraphWeight(child); }, 0));
		}

		/**
		 * Lay the whole tag forest out as one radial picture.
		 *
		 * Every level is placed at once: roots on the inner ring, each deeper
		 * level one ring further out, and every subtree owns an angular sector
		 * of its parent's. Nothing is hidden, because the picture is zoomed
		 * rather than rebuilt when a node is clicked.
		 *
		 * @param {object[]} roots - Root tag nodes.
		 * @returns {object|null} The layout, or null when there is nothing to draw.
		 */
		function tagGraphLayout(roots) {
			var list = Array.isArray(roots) ? roots : [];
			if (list.length === 0) return null;
			var width = 520;
			var height = 460;
			var cx = width / 2;
			var cy = height / 2;
			var inner = 74;
			var ring = 54;
			var stagger = 16;
			var margin = 0.1;
			var nodes = [];
			var edges = [];
			/**
			 * Place one node, its sector already decided.
			 *
			 * @param {object} node - The tag node.
			 * @param {string} key - The full tag path.
			 * @param {number} from - Sector start angle.
			 * @param {number} to - Sector end angle.
			 * @param {number} depth - Distance from the centre in rings.
			 * @param {object|null} parent - The parent position, if any.
			 * @param {number} offset - Extra radius for this node.
			 * @returns {void}
			 */
			function place(node, key, from, to, depth, parent, offset) {
				var middle = (from + to) / 2;
				var radius = inner + depth * ring + (offset ?? 0);
				var x = cx + Math.cos(middle) * radius;
				var y = cy + Math.sin(middle) * radius;
				var root = parent === null ? key : parent.root;
				nodes.push({ path: key, name: node.name, count: node.count, depth: depth, x: x, y: y, angle: middle, root: root });
				edges.push({ from: parent === null ? { x: cx, y: cy } : { x: parent.x, y: parent.y }, to: { x: x, y: y }, root: root });
				var children = node.children ?? [];
				if (children.length === 0) return;
				var weights = children.map(tagGraphWeight);
				var total = weights.reduce(function (sum, weight) { return sum + weight; }, 0);
				var pad = (to - from) * margin;
				var cursor = from + pad;
				var usable = (to - from) - pad * 2;
				children.forEach(function (child, index) {
					var span = (weights[index] / total) * usable;
					// Alternate two radii: neighbours on the same ring would
					// otherwise land within a label width of each other.
					place(child, key + '/' + child.name, cursor, cursor + span, depth + 1, { x: x, y: y, root: root }, (index % 2) * stagger);
					cursor += span;
				});
			}
			var weights = list.map(tagGraphWeight);
			var total = weights.reduce(function (sum, weight) { return sum + weight; }, 0);
			var cursor = -Math.PI / 2;
			list.forEach(function (node, index) {
				var span = (weights[index] / total) * Math.PI * 2;
				place(node, node.path, cursor, cursor + span, 0, null, 0);
				cursor += span;
			});

			// Labels sit outside their dot, so the picture is as wide as the
			// widest label, not just as wide as the outermost ring. Measure
			// everything, then scale the whole thing to fill the box — that way
			// a deep or crowded tree shrinks instead of overlapping.
			var minX = Infinity;
			var minY = Infinity;
			var maxX = -Infinity;
			var maxY = -Infinity;
			nodes.forEach(function (node) {
				// Labels run outward along the spoke and are rotated to it, so
				// what bounds the picture is the far end of each label, not a
				// horizontal strip beside its dot.
				var reach = 9 + labelExtent('#' + node.name);
				var farX = node.x + Math.cos(node.angle) * reach;
				var farY = node.y + Math.sin(node.angle) * reach;
				var pad = 12;
				minX = Math.min(minX, node.x - 6, farX - pad);
				maxX = Math.max(maxX, node.x + 6, farX + pad);
				minY = Math.min(minY, node.y - pad, farY - pad);
				maxY = Math.max(maxY, node.y + pad, farY + pad);
			});
			var spanX = Math.max(1, maxX - minX);
			var spanY = Math.max(1, maxY - minY);
			var fit = Math.min(width / spanX, height / spanY, 1.6);
			var ox = (width - spanX * fit) / 2 - minX * fit;
			var oy = (height - spanY * fit) / 2 - minY * fit;
			return { width: width, height: height, cx: cx, cy: cy, nodes: nodes, edges: edges, fit: fit, ox: ox, oy: oy };
		}

		/**
		 * Layouts already computed, keyed by the node array they came from.
		 *
		 * @type {WeakMap<object[], object|null>}
		 */
		var tagGraphCache = new WeakMap();

		/**
		 * One radial graph of the whole tag tree.
		 *
		 * The full tree is drawn at all times — roots inside, their children
		 * outside. Clicking a node zooms the picture around it instead of
		 * replacing the level, so you keep seeing the shape of the whole tree
		 * while reading one branch. Clicking it again, or the empty space,
		 * goes back to the fit-everything view.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function TagGraph(props) {
			var t = props.t;
			var layout = useMemo(function () {
				if (Array.isArray(props.nodes) && tagGraphCache.has(props.nodes)) return tagGraphCache.get(props.nodes);
				var computed = tagGraphLayout(props.nodes);
				if (Array.isArray(props.nodes)) tagGraphCache.set(props.nodes, computed);
				return computed;
			}, [props.nodes]);
			// The camera is content→screen: a point p lands at (x + s*px, y + s*py).
			var [camera, setCamera] = useState(null);
			var [tip, setTip] = useState(null);
			var svgRef = useRef(null);
			var dragRef = useRef(null);
			var movedRef = useRef(false);
			useEffect(function () { setCamera(null); setTip(null); }, [layout]);

			var fitView = layout === null ? null : { s: layout.fit, x: layout.ox, y: layout.oy };
			var view = camera === null ? fitView : camera;

			// Wheel has to be a native listener: React attaches it passively,
			// so preventDefault would be ignored and the panel would scroll.
			useEffect(function () {
				var node = svgRef.current;
				if (node === null || node === undefined || fitView === null) return undefined;
				function onWheel(event) {
					event.preventDefault();
					var box = node.getBoundingClientRect();
					if (box.width === 0 || box.height === 0) return;
					var px = ((event.clientX - box.left) / box.width) * layout.width;
					var py = ((event.clientY - box.top) / box.height) * layout.height;
					setCamera(function (previous) {
						var base = previous === null ? fitView : previous;
						var factor = Math.exp(-event.deltaY * 0.0016);
						var next = Math.min(Math.max(base.s * factor, layout.fit * 0.6), layout.fit * 6);
						var ratio = next / base.s;
						return { s: next, x: px - (px - base.x) * ratio, y: py - (py - base.y) * ratio };
					});
				}
				node.addEventListener('wheel', onWheel, { passive: false });
				return function () { node.removeEventListener('wheel', onWheel); };
			}, [layout, fitView === null ? 0 : fitView.s]);

			if (layout === null) return h('div', { className: 'evrHint' }, t('overview.tree.empty'));

			/**
			 * Where one layout point lands on screen.
			 *
			 * @param {number} x - Layout x.
			 * @param {number} y - Layout y.
			 * @returns {{x: number, y: number}} Screen position in viewBox units.
			 */
			function toScreen(x, y) {
				return { x: view.x + view.s * x, y: view.y + view.s * y };
			}

			/**
			 * Move the camera so one node sits in the middle.
			 *
			 * @param {object} node - The node to frame.
			 * @param {boolean} alone - Whether to frame only the node itself.
			 * @returns {void}
			 */
			function frameOn(node, alone) {
				var sumX = 0;
				var sumY = 0;
				var framed = 0;
				layout.nodes.forEach(function (other) {
					var inside = alone ? other.path === node.path
						: (other.path === node.path || other.path.indexOf(node.path + '/') === 0);
					if (inside) {
						sumX += other.x;
						sumY += other.y;
						framed += 1;
					}
				});
				var anchorX = framed === 0 ? node.x : sumX / framed;
				var anchorY = framed === 0 ? node.y : sumY / framed;
				var target = layout.fit * (alone ? 2.6 : 1.9);
				setCamera({ s: target, x: layout.cx - target * anchorX, y: layout.cy - target * anchorY });
			}

			function colorOf(node) {
				return LINK_BRANCH_COLORS[node.root.split('/')[0]] ?? '#8a8f98';
			}
			function pick(node, event) {
				if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
				setTip({ path: '#' + node.path, x: node.x, y: node.y });
				frameOn(node, node.depth === 0 ? false : (node.children ?? []).length === 0);
			}

			var edgeEls = layout.edges.map(function (edge, index) {
				// A slight bow, the way flomo draws its spokes: straight lines
				// read as a starburst, curves read as a tree.
				var mx = (edge.from.x + edge.to.x) / 2;
				var my = (edge.from.y + edge.to.y) / 2;
				var dx = edge.to.x - edge.from.x;
				var dy = edge.to.y - edge.from.y;
				var len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
				var bend = Math.min(16, len * 0.08);
				var qx = mx - (dy / len) * bend;
				var qy = my + (dx / len) * bend;
				return h('path', {
					key: 'e-' + index,
					d: 'M ' + edge.from.x.toFixed(1) + ' ' + edge.from.y.toFixed(1)
						+ ' Q ' + qx.toFixed(1) + ' ' + qy.toFixed(1)
						+ ' ' + edge.to.x.toFixed(1) + ' ' + edge.to.y.toFixed(1),
					className: 'evrGraphEdge',
					stroke: LINK_BRANCH_COLORS[edge.root.split('/')[0]] ?? '#a8adb5',
				});
			});

			var nodeEls = layout.nodes.map(function (node) {
				var degrees = (node.angle * 180) / Math.PI;
				var flipped = Math.cos(node.angle) < 0;
				var labelX = flipped ? node.x - 9 : node.x + 9;
				var isRoot = node.depth === 0;
				var active = tip === null || node.path === tip.path.replace(/^#/, '')
					|| (tip !== null && node.path.indexOf(tip.path.replace(/^#/, '') + '/') === 0);
				return h('g', {
					key: node.path,
					className: 'evrGraphNode',
					role: 'button',
					tabIndex: 0,
					'aria-label': node.path + ' · ' + node.count,
					opacity: active ? 1 : 0.32,
					onClick: function (event) { pick(node, event); },
					onKeyDown: function (event) {
						if (event && (event.key === 'Enter' || event.key === ' ')) pick(node, event);
					},
				},
					h('circle', {
						cx: node.x,
						cy: node.y,
						r: isRoot ? 4.4 : 3.2,
						className: isRoot ? 'evrGraphDot evrGraphDotRoot' : 'evrGraphDot',
						stroke: colorOf(node),
					}),
					h('text', {
						x: labelX,
						y: node.y + 3.2,
						textAnchor: flipped ? 'end' : 'start',
						transform: 'rotate(' + (flipped ? degrees + 180 : degrees).toFixed(1) + ' ' + node.x.toFixed(1) + ' ' + node.y.toFixed(1) + ')',
						className: isRoot ? 'evrGraphLabel evrGraphRoot' : 'evrGraphLabel',
					}, '#' + node.name),
					h('title', null, '#' + node.path + ' · ' + node.count));
			});

			var tipNode = null;
			if (tip !== null) {
				layout.nodes.forEach(function (node) { if ('#' + node.path === tip.path) tipNode = node; });
			}
			var tipAt = tipNode === null ? null : toScreen(tipNode.x, tipNode.y);

			return h('div', { className: 'evrGraphWrap' },
				h('svg', {
					ref: svgRef,
					className: 'evrGraph',
					viewBox: '0 0 ' + layout.width + ' ' + layout.height,
					role: 'img',
					'aria-label': t('overview.tree.graphLabel'),
					onPointerDown: function (event) {
						movedRef.current = false;
						dragRef.current = { x: event.clientX, y: event.clientY, camera: view, box: event.currentTarget.getBoundingClientRect() };
					},
					onPointerMove: function (event) {
						var drag = dragRef.current;
						if (drag === null || drag === undefined) return;
						var dx = event.clientX - drag.x;
						var dy = event.clientY - drag.y;
						if (Math.abs(dx) + Math.abs(dy) > 3) movedRef.current = true;
						if (drag.box.width === 0 || drag.box.height === 0) return;
						var scaleX = layout.width / drag.box.width;
						var scaleY = layout.height / drag.box.height;
						setCamera({ s: drag.camera.s, x: drag.camera.x + dx * scaleX, y: drag.camera.y + dy * scaleY });
					},
					onPointerUp: function (event) {
						var dragged = movedRef.current;
						dragRef.current = null;
						if (dragged) return;
						// A click on the canvas itself, not on a node, fits the tree.
						if (event.target === event.currentTarget || event.target.tagName === 'svg') {
							setCamera(null);
							setTip(null);
						}
					},
					onPointerLeave: function () { dragRef.current = null; },
				},
					h('g', {
						style: {
							transform: 'translate(' + view.x.toFixed(1) + 'px,' + view.y.toFixed(1) + 'px) scale(' + view.s.toFixed(3) + ')',
							transition: 'transform 260ms ease',
						},
					},
						h('g', null, edgeEls),
						h('circle', { cx: layout.cx, cy: layout.cy, r: 4, className: 'evrGraphHub' }),
						h('g', null, nodeEls))),
				tipAt === null ? null : h('div', {
					className: 'evrGraphTip',
					style: {
						left: (tipAt.x / layout.width) * 100 + '%',
						top: (tipAt.y / layout.height) * 100 + '%',
					},
				}, tip.path),
				h('div', { className: 'evrHint', style: { marginTop: '4px' } }, t('overview.tree.zoomHint')));
		}

		/**
		 * A read-only or clickable hierarchical tag tree.
		 *
		 * Every node with children can be collapsed independently, recursively.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function TagTree(props) {
			var nodes = Array.isArray(props.nodes) ? props.nodes : [];
			var activePath = props.activePath ?? '';
			var onSelect = props.onSelect;
			var [collapsed, setCollapsed] = useState({});

			function toggle(path) {
				setCollapsed(function (current) {
					return { ...current, [path]: current[path] !== true };
				});
			}

			function rows(list, depth) {
				var result = [];
				(list ?? []).forEach(function (node) {
					var children = node.children ?? [];
					var hasChildren = children.length > 0;
					var isCollapsed = collapsed[node.path] === true;
					var active = activePath === node.path;
					result.push(h('div', {
						key: node.path,
						className: 'evrTagNode',
						style: { paddingLeft: (4 + depth * 12) + 'px' },
					},
						hasChildren
							? h('button', {
								type: 'button',
								className: 'evrTagToggle',
								'aria-label': (isCollapsed ? '展开标签 ' : '收起标签 ') + node.path,
								'aria-expanded': isCollapsed ? 'false' : 'true',
								onClick: function (event) { if (event && typeof event.stopPropagation === 'function') event.stopPropagation(); toggle(node.path); },
							}, isCollapsed ? '▸' : '▾')
							: h('span', { className: 'evrTagToggle evrTagToggleSpacer' }),
						onSelect === undefined
							? h('div', { className: 'evrTagBtn evrTagBtnStatic', title: node.path },
								h('span', { className: 'evrTagName' }, '#' + node.name),
								h('span', { className: 'evrTagCount' }, String(node.count)))
							: h('button', {
								type: 'button',
								className: 'evrTagBtn' + (active ? ' evrTagBtnActive' : ''),
								title: node.path,
								onClick: function () { onSelect(node.path); },
							},
								h('span', { className: 'evrTagName' }, '#' + node.name),
								h('span', { className: 'evrTagCount' }, String(node.count)))));
					if (hasChildren && !isCollapsed) result = result.concat(rows(children, depth + 1));
				});
				return result;
			}

			return h('div', null, rows(nodes, 0));
		}

		/**
		 * The card activity heatmap.
		 *
		 * The grid is fluid: the cells share the width of the pane, so the
		 * whole year of weeks fills the row whatever the pane is wide.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function Heatmap(props) {
			var t = props.t;
			var activity = Array.isArray(props.activity) ? props.activity : [];
			if (activity.length === 0) return h('div', { className: 'evrHint' }, t('overview.heatmap.empty'));
			var counts = {};
			activity.forEach(function (item) { counts[item.date] = item.count; });
			function parse(key) { return new Date(key + 'T00:00:00'); }
			function keyOf(date) {
				return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
			}
			var first = parse(activity[0].date);
			var last = parse(activity[activity.length - 1].date);
			var start = new Date(first);
			start.setDate(start.getDate() - start.getDay());
			// The strip ends today, not at the end of the week: cells for days
			// that have not happened yet are blank space, not empty days.
			var end = new Date(last);
			var weeks = [];
			var cursor = new Date(start);
			while (cursor <= end) {
				var week = [];
				for (var day = 0; day < 7; day += 1) {
					var date = new Date(cursor);
					date.setDate(date.getDate() + day);
					var key = keyOf(date);
					week.push({ key, count: counts[key], inside: date >= first && date <= last });
				}
				weeks.push(week);
				cursor.setDate(cursor.getDate() + 7);
			}
			var monthLabels = weeks.map(function (week, index) {
				var date = parse(week[0].key);
				var previous = index === 0 ? null : parse(weeks[index - 1][0].key);
				if (index === 0 || (previous !== null && previous.getMonth() !== date.getMonth())) {
					return (date.getMonth() + 1) + '月';
				}
				return '';
			});
			function level(count) {
				if (count === undefined || count === 0) return 0;
				if (count === 1) return 1;
				if (count === 2) return 2;
				return 3;
			}
			var style = { '--eh-cols': String(weeks.length) };
			return h('div', { className: 'evrHeatmapWrap', style: style },
				h('div', { className: 'evrHeatmapMonths' }, monthLabels.map(function (label, index) {
					return h('span', { key: index }, label);
				})),
				h('div', { className: 'evrHeatmapBody' },
					h('div', { className: 'evrHeatmapDays' }, ['日', '一', '二', '三', '四', '五', '六'].map(function (label, index) {
						return h('span', { key: index }, label);
					})),
					h('div', { className: 'evrHeatmap' }, weeks.map(function (week) {
						return h('div', { key: week[0].key, className: 'evrHeatmapWeek' }, week.map(function (cell) {
							return h('div', {
								key: cell.key,
								className: cell.inside ? 'evrHeatCell evrHeat' + level(cell.count) : 'evrHeatCell evrHeatBlank',
								title: cell.inside ? cell.key + ' · ' + (cell.count ?? 0) + ' ' + t('overview.heatmap.unit') : '',
								'aria-label': cell.inside ? cell.key + ' · ' + (cell.count ?? 0) : '',
							});
						}));
					}))),
				h('div', { className: 'evrHeatLegend' },
					h('span', null, t('overview.heatmap.less')),
					h('span', { className: 'evrHeatCell evrHeat0' }),
					h('span', { className: 'evrHeatCell evrHeat1' }),
					h('span', { className: 'evrHeatCell evrHeat2' }),
					h('span', { className: 'evrHeatCell evrHeat3' }),
					h('span', null, t('overview.heatmap.more'))));
		}

		/**
		 * Whether a link target is safe to follow.
		 *
		 * @param {string} url - The link target.
		 * @returns {boolean} True for web, mail and in-document links.
		 */
		function safeUrl(url) {
			return /^(https?:|mailto:|#|\/|\.\/)/i.test(String(url ?? ''));
		}

		/**
		 * Parse a Markdown document into flat blocks.
		 *
		 * Only the constructs the injected documents use are supported:
		 * headings, lists, quotes, fenced code, rules and paragraphs. Every
		 * source line stays on its own line, because the tag tree is a line
		 * map and must not be merged into a paragraph.
		 *
		 * @param {string} text - The Markdown source.
		 * @returns {object[]} The parsed blocks.
		 */
		function parseMarkdown(text) {
			var lines = String(text ?? '').split('\n');
			var blocks = [];
			var index = 0;

			/**
			 * Whether a line opens another block.
			 *
			 * @param {string} line - The source line.
			 * @returns {boolean} True when the line starts a new block.
			 */
			function opensBlock(line) {
				return /^\s*```/.test(line)
					|| /^(#{1,6})\s/.test(line)
					|| /^\s*>\s?/.test(line)
					|| /^(\s*)([-*+]|\d+[.)])\s+/.test(line)
					|| /^\s*([-*_])\s*(\1\s*){2,}$/.test(line);
			}

			while (index < lines.length) {
				var line = lines[index];
				if (/^\s*$/.test(line)) {
					index += 1;
					continue;
				}
				if (/^\s*```/.test(line)) {
					var code = [];
					index += 1;
					while (index < lines.length && !/^\s*```/.test(lines[index])) {
						code.push(lines[index]);
						index += 1;
					}
					index += 1;
					blocks.push({ type: 'code', text: code.join('\n') });
					continue;
				}
				var heading = /^(#{1,6})\s+(.*)$/.exec(line);
				if (heading !== null) {
					blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
					index += 1;
					continue;
				}
				if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
					blocks.push({ type: 'rule' });
					index += 1;
					continue;
				}
				if (/^\s*>\s?/.test(line)) {
					var quoted = [];
					while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
						quoted.push(lines[index].replace(/^\s*>\s?/, ''));
						index += 1;
					}
					blocks.push({ type: 'quote', lines: quoted });
					continue;
				}
				var first = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
				if (first !== null) {
					var items = [];
					var base = first[1].length;
					while (index < lines.length) {
						var entry = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
						if (entry === null) break;
						items.push({
							level: Math.max(0, Math.round((entry[1].length - base) / 2)),
							text: entry[3],
						});
						index += 1;
					}
					blocks.push({ type: 'list', items: items });
					continue;
				}
				blocks.push({
					type: 'line',
					indent: (/^\s*/.exec(line))[0].length,
					text: line.trim(),
				});
				index += 1;
			}
			return blocks;
		}

		/**
		 * Render the inline Markdown of one line.
		 *
		 * @param {string} text - The line text.
		 * @param {string} key - The key prefix of the produced nodes.
		 * @returns {object[]} The rendered nodes.
		 */
		function inlineMarkdown(text, key) {
			var nodes = [];
			var pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\n]+\*)/g;
			var last = 0;
			var count = 0;
			var match;
			while ((match = pattern.exec(text)) !== null) {
				if (match.index > last) nodes.push(text.slice(last, match.index));
				var token = match[0];
				if (token.indexOf('**') === 0) {
					nodes.push(h('strong', { key: key + 'b' + count }, token.slice(2, -2)));
				} else if (token.charAt(0) === '`') {
					nodes.push(h('code', { key: key + 'c' + count }, token.slice(1, -1)));
				} else if (token.charAt(0) === '[') {
					var link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
					if (link !== null && safeUrl(link[2])) {
						nodes.push(h('a', {
							key: key + 'l' + count,
							href: link[2],
							target: '_blank',
							rel: 'noreferrer',
						}, link[1]));
					} else {
						nodes.push(token);
					}
				} else {
					nodes.push(h('em', { key: key + 'i' + count }, token.slice(1, -1)));
				}
				last = match.index + token.length;
				count += 1;
			}
			if (last < text.length) nodes.push(text.slice(last));
			return nodes;
		}

		/**
		 * A read-only Markdown preview of an injected block.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function Markdown(props) {
			var t = props.t;
			var text = typeof props.text === 'string' ? props.text : '';
			if (text.trim() === '') return h('div', { className: 'evrHint' }, t('overview.preview.empty'));
			var blocks = parseMarkdown(text);
			return h('div', { className: 'evrMd' }, blocks.map(function (block, index) {
				var key = 'b' + index;
				if (block.type === 'heading') {
					return h('h' + Math.min(6, block.level), { key: key }, inlineMarkdown(block.text, key));
				}
				if (block.type === 'rule') return h('hr', { key: key });
				if (block.type === 'code') {
					return h('pre', { key: key, className: 'evrMdPre' }, h('code', null, block.text));
				}
				if (block.type === 'quote') {
					return h('blockquote', { key: key, className: 'evrMdQuote' }, block.lines.map(function (line, lineIndex) {
						return h('p', { key: key + 'q' + lineIndex }, inlineMarkdown(line, key + 'q' + lineIndex));
					}));
				}
				if (block.type === 'list') {
					return h('ul', { key: key, className: 'evrMdList' }, block.items.map(function (item, itemIndex) {
						return h('li', {
							key: key + 'i' + itemIndex,
							style: item.level > 0 ? { marginLeft: (item.level * 16) + 'px' } : undefined,
						}, inlineMarkdown(item.text, key + 'i' + itemIndex));
					}));
				}
				return h('p', {
					key: key,
					className: 'evrMdLine',
					style: block.indent > 0 ? { paddingLeft: (block.indent * 6) + 'px' } : undefined,
				}, inlineMarkdown(block.text, key));
			}));
		}


		/**
		 * The colour of one card, by its top-level branch.
		 *
		 * @param {object} card - The card view.
		 * @returns {string} The colour.
		 */
		function linkColorOf(card) {
			var root = (card.tags ?? [])[0];
			var branch = root === undefined ? '' : root.split('/')[0];
			return LINK_BRANCH_COLORS[branch] ?? '#8a8f98';
		}

		/**
		 * Layouts already computed, keyed by the card array they came from.
		 *
		 * The panel replaces that array only when the library is reloaded, so a
		 * cache hit means "same library". It outlives the component, which
		 * matters because leaving the sub-tab unmounts the graph and coming
		 * back would otherwise pay for the simulation again.
		 *
		 * @type {WeakMap<object[], object | null>}
		 */
		var linkLayoutCache = new WeakMap();

		/**
		 * Lay the card graph out once.
		 *
		 * This is the expensive half: a force simulation over the linked cards,
		 * O(n²) per step and 220 steps. It belongs behind a memo, because the
		 * overview re-renders whenever a sub-tab, the heatmap range or a tag
		 * description changes — none of which move a node.
		 *
		 * The simulation is deterministic (no random seeding), so the picture is
		 * identical between runs and needs no animation.
		 *
		 * @param {object[]} cards - Every card in the library.
		 * @returns {object | null} The laid-out graph, or null when nothing links.
		 */
		function linkLayout(cards) {
			if (Array.isArray(cards) && linkLayoutCache.has(cards)) return linkLayoutCache.get(cards);
			var layout = computeLinkLayout(cards);
			if (Array.isArray(cards)) linkLayoutCache.set(cards, layout);
			return layout;
		}

		/**
		 * Compute one layout from scratch.
		 *
		 * @param {object[]} cards - Every card in the library.
		 * @returns {object | null} The laid-out graph, or null when nothing links.
		 */
		function computeLinkLayout(cards) {
			var list = Array.isArray(cards) ? cards : [];
			var byId = {};
			list.forEach(function (card) { byId[card.id] = card; });
			var seen = {};
			var edges = [];
			list.forEach(function (card) {
				(card.links ?? []).forEach(function (target) {
					if (byId[target] === undefined) return;
					var key = card.id + '>' + target;
					if (seen[key] === true) return;
					seen[key] = true;
					edges.push({
						source: card.id,
						target: target,
						mutual: seen[target + '>' + card.id] === true,
					});
				});
			});
			var involved = {};
			edges.forEach(function (edge) {
				involved[edge.source] = true;
				involved[edge.target] = true;
			});
			var linked = list.filter(function (card) { return involved[card.id] === true; });
			if (linked.length === 0) return null;
			var width = 320;
			var height = 300;
			var cx = width / 2;
			var cy = height / 2;
			var degree = {};
			edges.forEach(function (edge) {
				degree[edge.source] = (degree[edge.source] ?? 0) + 1;
				degree[edge.target] = (degree[edge.target] ?? 0) + 1;
			});
			var placed = linked.map(function (card, index) {
				var angle = (index / linked.length) * Math.PI * 2;
				return {
					card: card,
					x: cx + Math.cos(angle) * 90,
					y: cy + Math.sin(angle) * 90,
					vx: 0,
					vy: 0,
				};
			});
			var index = {};
			placed.forEach(function (node) { index[node.card.id] = node; });
			for (var step = 0; step < 220; step += 1) {
				for (var i = 0; i < placed.length; i += 1) {
					for (var j = i + 1; j < placed.length; j += 1) {
						var dx = placed[j].x - placed[i].x;
						var dy = placed[j].y - placed[i].y;
						var distance = Math.max(2, Math.sqrt(dx * dx + dy * dy));
						var push = 1400 / (distance * distance);
						var fx = (dx / distance) * push;
						var fy = (dy / distance) * push;
						placed[i].vx -= fx;
						placed[i].vy -= fy;
						placed[j].vx += fx;
						placed[j].vy += fy;
					}
				}
				edges.forEach(function (edge) {
					var source = index[edge.source];
					var target = index[edge.target];
					if (source === undefined || target === undefined) return;
					var ex = target.x - source.x;
					var ey = target.y - source.y;
					var span = Math.max(2, Math.sqrt(ex * ex + ey * ey));
					var pull = (span - 84) * 0.03;
					source.vx += (ex / span) * pull;
					source.vy += (ey / span) * pull;
					target.vx -= (ex / span) * pull;
					target.vy -= (ey / span) * pull;
				});
				placed.forEach(function (node) {
					node.vx += (cx - node.x) * 0.012;
					node.vy += (cy - node.y) * 0.012;
					node.x += node.vx * 0.4;
					node.y += node.vy * 0.4;
					node.vx *= 0.86;
					node.vy *= 0.86;
				});
			}
			var minX = Infinity;
			var minY = Infinity;
			var maxX = -Infinity;
			var maxY = -Infinity;
			placed.forEach(function (node) {
				minX = Math.min(minX, node.x);
				minY = Math.min(minY, node.y);
				maxX = Math.max(maxX, node.x);
				maxY = Math.max(maxY, node.y);
			});
			var spanX = Math.max(1, maxX - minX);
			var spanY = Math.max(1, maxY - minY);
			var scale = Math.min((width - 40) / spanX, (height - 40) / spanY);
			var offsetX = (width - spanX * scale) / 2;
			var offsetY = (height - spanY * scale) / 2;
			placed.forEach(function (node) {
				node.x = offsetX + (node.x - minX) * scale;
				node.y = offsetY + (node.y - minY) * scale;
			});
			return {
				width: width,
				height: height,
				nodes: placed.map(function (node) {
					var count = degree[node.card.id] ?? 0;
					return {
						id: node.card.id,
						label: node.card.label,
						color: linkColorOf(node.card),
						x: node.x,
						y: node.y,
						r: 3.5 + Math.min(4, count * 1.1),
						degree: count,
					};
				}),
				edges: edges.map(function (edge) {
					var source = index[edge.source];
					var target = index[edge.target];
					var dx = target.x - source.x;
					var dy = target.y - source.y;
					var length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
					var bend = edge.mutual === true ? 14 : 6;
					var qx = (source.x + target.x) / 2 - (dy / length) * bend;
					var qy = (source.y + target.y) / 2 + (dx / length) * bend;
					return {
						mutual: edge.mutual === true,
						d: 'M ' + source.x.toFixed(1) + ' ' + source.y.toFixed(1)
							+ ' Q ' + qx.toFixed(1) + ' ' + qy.toFixed(1)
							+ ' ' + target.x.toFixed(1) + ' ' + target.y.toFixed(1),
					};
				}),
			};
		}

		/**
		 * A graph of the cards and the links between them.
		 *
		 * Every card that links to another card, or is linked back to, becomes
		 * a node and a link becomes an edge.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function LinkGraph(props) {
			var t = props.t;
			// The layout depends on the cards alone, so it is computed once per
			// library change rather than once per render.
			var layout = useMemo(function () { return linkLayout(props.cards); }, [props.cards]);
			if (layout === null) {
				return h('div', { className: 'evrHint' }, t('overview.linkGraph.empty'));
			}
			return h('div', null,
				h('svg', {
					className: 'evrLinkGraph',
					viewBox: '0 0 ' + layout.width + ' ' + layout.height,
					role: 'img',
					'aria-label': t('overview.linkGraph.label'),
				},
					h('g', null, layout.edges.map(function (edge, edgeIndex) {
						return h('path', {
							key: 'e-' + edgeIndex,
							d: edge.d,
							className: 'evrLinkEdge' + (edge.mutual ? ' evrLinkEdgeMutual' : ''),
						});
					})),
					h('g', null, layout.nodes.map(function (node) {
						return h('g', { key: node.id, className: 'evrLinkNode' },
							h('circle', { cx: node.x, cy: node.y, r: node.r, fill: node.color }),
							h('title', null, node.label + ' · ' + node.degree + ' ' + t('overview.linkGraph.links')));
					}))),
				);
		}

		/**
		 * One labelled field.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function Field(props) {
			return h('label', { className: 'evrField' },
				h('span', { className: 'evrLabel' }, props.label),
				props.children,
				props.hint === undefined ? null : h('span', { className: 'evrHint' }, props.hint));
		}

		//#endregion

		//#region tabs

		/**
		 * The overview: the three injected blocks and the folder's health.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function OverviewTab(props) {
			var t = props.t;
			var injection = props.injection;
			var overview = props.overview;
			var [section, setSection] = useState('stats');
			if (injection === null || overview === null) return h(Spinner, null, t('state.loading'));
			var stats = overview.stats ?? {};
			var year = overview.year ?? {};
			var activity = Array.isArray(overview.activity) ? overview.activity : [];
			var tree = Array.isArray(overview.tree) ? overview.tree : [];
			var heatHint = t('overview.yearHeatmap.hint')
				.replace('{notes}', String(year.notes ?? 0))
				.replace('{days}', String(year.activeDays ?? 0));
			var prefsLink = injection.preferences.link.kind !== 'link'
				? t('prefs.link.missing')
				: (injection.preferences.link.ours === false ? t('prefs.link.foreign') : t('prefs.link.linked'));
			var sections = [
				{ id: 'stats', label: t('overview.stats') },
				// The editor only exists when the host can serve it; an older
				// host gets no tab instead of a dead one.
				props.descriptions === null ? null : { id: 'descriptions', label: t('overview.descriptions') },
				{ id: 'cards', label: t('overview.cards') },
				{ id: 'soul', label: t('overview.soul') },
				{ id: 'preferences', label: t('overview.preferences') },
			].filter(function (item) { return item !== null; });

			/**
			 * A row of key and value pairs.
			 *
			 * @param {Array} pairs - The pairs to show.
			 * @returns {object} The element tree.
			 */
			function metaRow(pairs) {
				return h('div', { className: 'evrMetaRow' }, pairs.map(function (pair, index) {
					return h('span', { key: index, className: 'evrMetaItem' },
						h('span', { className: 'evrMetaLabel' }, pair[0]),
						h('span', { className: 'evrMetaValue' }, pair[1]));
				}));
			}

			/**
			 * A read-only preview of one injected block.
			 *
			 * @param {string} title - The block title.
			 * @param {Array} pairs - The key and value pairs of the block.
			 * @param {string} text - The injected text.
			 * @returns {object} The element tree.
			 */
			function preview(title, pairs, text) {
				return h('div', { role: 'tabpanel' },
					h('div', { className: 'evrSection' }, title),
					h('div', { className: 'evrHint', style: { marginBottom: '8px' } }, t('overview.preview.readonly')),
					metaRow(pairs),
					h(Markdown, { t: t, text: text }));
			}

			/**
			 * The panel of one sub-tab.
			 *
			 * Written as a chain of branches rather than nested ternaries: there
			 * are five of them now, and the shape has to stay readable.
			 *
			 * @returns {object} The element tree.
			 */
			function panel() {
				if (section === 'descriptions') {
					return h('div', { role: 'tabpanel' },
						h(TagDescriptionsEditor, {
							t: t,
							tree: tree,
							descriptions: props.descriptions,
							busy: props.busy,
							onSave: props.onSaveDescriptions,
						}));
				}
				if (section === 'cards') {
					return preview(t('overview.projection'), [
						[t('overview.bytes'), formatBytes(injection.cards.bytes)],
						[t('overview.budget'), formatBytes(injection.cards.budget)],
						[t('overview.dropped'), String(injection.cards.dropped)],
						[t('overview.entries'), String(injection.cards.entries)],
					], injection.cards.text ?? '');
				}
				if (section === 'soul') {
					return preview(t('overview.soul'), [
						[t('overview.bytes'), formatBytes(injection.soul.bytes)],
						[t('overview.budget'), formatBytes(injection.soul.budget)],
					].concat(injection.soul.truncated === true ? [[t('overview.truncated'), '—']] : []), injection.soul.text ?? '');
				}
				if (section === 'preferences') {
					return preview(t('overview.preferences'), [
						[t('overview.bytes'), formatBytes(injection.preferences.bytes)],
						[t('overview.link'), prefsLink],
					], injection.preferences.text ?? '');
				}
				return h('div', { role: 'tabpanel' },
					h('div', { className: 'evrSection' }, t('overview.heatmap.section')),
					h('div', { className: 'evrHint', style: { marginBottom: '8px' } }, heatHint),
					h(Heatmap, { t: t, activity: activity }),
					h('div', { className: 'evrSection' }, t('overview.stats')),
					h('div', { className: 'evrGrid' },
						h(StatCard, { title: t('overview.notes'), value: String(stats.cards ?? 0), hint: t('overview.notesHint') }),
						h(StatCard, { title: t('overview.tags'), value: String(stats.tags ?? 0), hint: t('overview.tagsHint') }),
						h(StatCard, { title: t('overview.days'), value: String(stats.days ?? 0), hint: t('overview.daysHint') })),
					h('div', { className: 'evrOverviewSplit' },
						h('div', { className: 'evrOverviewPane evrOverviewGraph' },
							h('div', { className: 'evrSection' }, t('overview.graph')),
							h('div', { className: 'evrHint', style: { marginBottom: '8px' } }, t('overview.tree.hint')),
							h(TagGraph, { t: t, nodes: tree })),
						h('div', { className: 'evrOverviewPane evrOverviewTree' },
							h('div', { className: 'evrSection' }, t('overview.linkGraph')),
							h('div', { className: 'evrHint', style: { marginBottom: '8px' } }, t('overview.linkGraph.hint')),
							h(LinkGraph, { t: t, cards: props.cards?.cards }))));
			}

			return h('div', null,
				h('div', { className: 'evrSubTabs', role: 'tablist', 'aria-label': t('tab.overview') }, sections.map(function (item) {
					return h('button', {
						key: item.id,
						type: 'button',
						role: 'tab',
						className: 'evrTab' + (section === item.id ? ' evrTabActive' : ''),
						'aria-selected': section === item.id,
						onClick: function () { setSection(item.id); },
					}, item.label);
				})),
				panel()
			);
		}

		/**
		 * The tag descriptions, editable in place.
		 *
		 * The descriptions are what the injected tag tree shows next to each
		 * branch. A branch appears as soon as a card uses a new path, so the
		 * editor lists the live tree instead of a fixed vocabulary: whatever
		 * grew there can be documented here without touching the source.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function TagDescriptionsEditor(props) {
			var t = props.t;
			var tree = Array.isArray(props.tree) ? props.tree : [];
			var saved = props.descriptions ?? {};
			var [draft, setDraft] = useState(function () { return { ...saved }; });
			var [dirty, setDirty] = useState(false);

			useEffect(function () {
				setDraft({ ...(props.descriptions ?? {}) });
				setDirty(false);
			}, [props.descriptions]);

			/**
			 * Flatten the tree into rows with their depth.
			 *
			 * @param {object[]} nodes - The tag nodes.
			 * @param {number} depth - The current depth.
			 * @returns {object[]} One row per branch.
			 */
			function rows(nodes, depth) {
				var result = [];
				(nodes ?? []).forEach(function (node) {
					if (node.path.slice(-3) === '/归档') return;
					result.push({ path: node.path, name: node.name, count: node.count, depth: depth });
					result = result.concat(rows(node.children, depth + 1));
				});
				return result;
			}

			var list = rows(tree, 0);
			if (list.length === 0) return h('div', { className: 'evrHint' }, t('overview.tree.empty'));
			var missing = list.filter(function (row) { return (draft[row.path] ?? '').trim() === ''; }).length;
			return h('div', null,
				h('div', { className: 'evrSection' },
					t('overview.descriptions'),
					missing === 0
						? h('span', { className: 'evrBadge evrBadgeOk' }, t('overview.descriptions.complete'))
						: h('span', { className: 'evrBadge evrBadgeWarn' }, t('overview.descriptions.missing').replace('{n}', String(missing)))),
				h('div', { className: 'evrHint', style: { marginBottom: '10px' } }, t('overview.descriptions.hint')),
				h('div', { className: 'evrDescList' }, list.map(function (row) {
					var value = draft[row.path] ?? '';
					return h('div', {
						key: row.path,
						className: 'evrDescRow' + (value.trim() === '' ? ' evrDescRowMissing' : ''),
					},
						h('span', {
							className: 'evrDescTag',
							style: { paddingLeft: (row.depth * 12) + 'px' },
							title: row.path,
						}, '#' + row.name),
						h('input', {
							className: 'evrInput evrDescInput',
							type: 'text',
							value: value,
							placeholder: t('overview.descriptions.placeholder'),
							onChange: function (event) {
								var next = event.target.value;
								setDraft(function (current) {
									var map = { ...current };
									if (next.trim() === '') delete map[row.path];
									else map[row.path] = next;
									return map;
								});
								setDirty(true);
							},
						}),
						h('span', { className: 'evrDescCount' }, String(row.count)));
				})),
				h('div', { className: 'evrEditorFoot' },
					h('button', {
						type: 'button',
						className: 'evrBtn evrBtnPrimary',
						disabled: props.busy || !dirty,
						onClick: function () { props.onSave(draft); },
					}, t('action.save')),
					h('button', {
						type: 'button',
						className: 'evrBtn',
						disabled: props.busy || !dirty,
						onClick: function () {
							setDraft({ ...(props.descriptions ?? {}) });
							setDirty(false);
						},
					}, t('action.cancel')),
					missing === 0 ? null : h('span', { className: 'evrHint' }, t('overview.descriptions.warn'))));
		}

		/**
		 * The soul document, on its own tab.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function SoulTab(props) {
			var t = props.t;
			return h('div', null,
				h('div', { className: 'evrSection' }, t('soul.content')),
				h('div', { className: 'evrHint', style: { marginBottom: '8px' } }, t('soul.hint')),
				h('textarea', {
					className: 'evrTextarea',
					value: props.soul?.content ?? '',
					onChange: function (event) { props.onSoulChange(event.target.value); },
				}),
				h('div', { className: 'evrEditorFoot' },
					h('button', {
						type: 'button',
						className: 'evrBtn evrBtnPrimary',
						disabled: props.busy,
						onClick: props.onSoulSave,
					}, t('action.save')),
					props.status === undefined || props.status === null
						? null
						: h('span', { className: 'evrStatus' + (props.status.error ? ' evrStatusError' : ' evrStatusOk') }, props.status.message)));
		}

		/**
		 * The unified card view: tag tree, filters, list, detail and editor.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function CardsTab(props) {
			var t = props.t;
			var state = props.state;
			var filter = props.filter ?? {};
			var [search, setSearch] = useState(filter.query ?? '');
			var [promoteTarget, setPromoteTarget] = useState('践行');
			if (state === null || state === undefined) return h(Spinner, null, t('state.loading'));
			var cards = Array.isArray(state.cards) ? state.cards : [];
			var tree = Array.isArray(state.tree) ? state.tree : [];

			function filterButton(label, patch, active) {
				return h('button', {
					key: label,
					type: 'button',
					className: 'evrTab' + (active ? ' evrTabActive' : ''),
					onClick: function () { props.onFilter(patch); },
				}, label);
			}

			function field(label, input, hint) {
				return h(Field, { label: label, hint: hint }, input);
			}

			function renderList() {
				if (cards.length === 0) return h(Empty, null, t('cards.empty'));
				return h('div', null, cards.map(function (card) {
					return h('div', {
						key: card.id,
						className: 'evrRow',
						onClick: function () { props.onOpen(card.id); },
					},
						h('div', { className: 'evrRowMain' },
							h('div', { className: 'evrRowTitle' }, card.label || t('cards.empty')),
							h('div', { className: 'evrRowMeta' }, String(card.body ?? '').slice(0, 180)),
							h('div', { className: 'evrRowMeta' },
								(card.tags ?? []).map(function (tag) {
									return h('span', { key: tag, className: 'evrTag' }, "#" + tag);
								}))),
						h('div', {
							className: 'evrRowTime',
							title: absoluteTime(card.updated ?? '', true),
						}, cardTime(card.updated ?? '', t)));
				}));
			}

			function renderDetail() {
				var detail = props.detail;
				if (detail === null || detail === undefined || detail.card === null) return renderList();
				var card = detail.card;
				var settled = (card.tags ?? []).some(function (tag) {
					var root = tag.split('/')[0];
					return root !== '即兴' && ['践行', '见闻', '复盘', '觉察', '试错'].indexOf(root) >= 0;
				});
				var archived = (card.tags ?? []).some(function (tag) { return tag.slice(-3) === '/归档'; });
				return h('div', null,
					h('div', { className: 'evrCard' },
						h('div', { className: 'evrCardHead' },
							h('span', { className: 'evrCardTitle' }, card.label || '(未命名)'),
							h('span', { className: 'evrCardCount' }, (card.tags ?? []).slice(0, 3).map(function (tag) { return '#' + tag; }).join(' · '))),
						h('div', { className: 'evrHint evrMono' }, card.id),
						h('div', { className: 'evrPre', style: { whiteSpace: 'pre-wrap', marginTop: '8px' } }, card.body || ''),
						h('div', { className: 'evrRowMeta', style: { marginTop: '8px' } },
							(card.tags ?? []).map(function (tag) { return h('span', { key: tag, className: 'evrTag' }, "#" + tag); }))),
					h('div', { className: 'evrToolbar' },
						h('button', { type: 'button', className: 'evrBtn', onClick: props.onEdit }, t('cards.edit')),
						!settled && !archived
							? h('select', {
								className: 'evrInput',
								value: promoteTarget,
								onChange: function (event) { setPromoteTarget(event.target.value); },
							}, ['践行', '见闻', '复盘', '觉察', '试错'].map(function (branch) {
								return h('option', { key: branch, value: branch }, branch);
							}))
							: null,
						!settled && !archived
							? h('button', { type: 'button', className: 'evrBtn evrBtnPrimary', onClick: function () { props.onPromote(card.id, promoteTarget); } }, t('cards.promote'))
							: null,
						!archived
							? h('button', { type: 'button', className: 'evrBtn', onClick: function () { props.onArchive(card.id); } }, t('cards.archive'))
							: null,
						h('button', { type: 'button', className: 'evrBtn', onClick: function () { props.onDelete(card.id); } }, t('cards.delete'))),
					(detail.links ?? []).length > 0
						? h('div', { className: 'evrSection' }, t('cards.links'))
						: null,
					(detail.links ?? []).map(function (item) {
						return h('div', { key: 'l-' + item.id, className: 'evrHint' }, '→ ' + item.label);
					}),
					(detail.backlinks ?? []).length > 0 ? h('div', { className: 'evrSection' }, t('cards.backlinks')) : null,
					(detail.backlinks ?? []).map(function (item) {
						return h('button', {
							key: 'b-' + item.id,
							type: 'button',
							className: 'evrBtn',
							style: { marginRight: '6px', marginBottom: '4px' },
							onClick: function () { props.onOpen(item.id); },
						}, item.label);
					}),
					h('div', { className: 'evrSection' }, t('cards.attachments')),
					(card.resources ?? []).length === 0
						? h('div', { className: 'evrHint' }, t('cards.noAttachments'))
						: h('div', null, (card.resources ?? []).map(function (resource) {
							return h('div', { key: resource.name, className: 'evrHint evrMono' }, resource.name + ' · ' + formatBytes(resource.bytes));
						})),
					h('label', { className: 'evrBtn', style: { display: 'inline-block', cursor: 'pointer', marginTop: '6px' } },
						t('cards.attach'),
						h('input', {
							type: 'file',
							style: { display: 'none' },
							onChange: function (event) {
								var file = event.target.files?.[0];
								if (file) props.onAttach(card.id, file);
								event.target.value = '';
							},
						})));
			}

			function renderEditor() {
				var editor = props.editor;
				if (editor === null || editor === undefined) return null;
				var fields = editor.fields;
				var patch = props.onDraft;
				var bodyLength = [...String(fields.body ?? '')].length;
				return h('div', null,
					h('div', { className: 'evrSection' }, editor.mode === 'new' ? t('cards.editor.new') : t('cards.editor.edit')),
					field(t('cards.field.body') + ' · ' + bodyLength + '/' + (state.cardMaxChars ?? 1000) + ' ' + t('cards.charCount'),
						h('textarea', {
							className: 'evrTextarea',
							value: fields.body,
							onChange: function (event) { patch({ body: event.target.value }); },
						})),
					field(t('cards.field.tags'), h('input', {
						className: 'evrInput',
						value: fields.tags,
						placeholder: t('cards.field.tagsHint'),
						onChange: function (event) { patch({ tags: event.target.value }); },
					})),
					field(t('cards.field.links'), h('input', {
						className: 'evrInput',
						value: fields.links,
						onChange: function (event) { patch({ links: event.target.value }); },
					})),
					h('div', { className: 'evrEditorFoot' },
						h('button', {
							type: 'button',
							className: 'evrBtn evrBtnPrimary',
							disabled: props.busy,
							onClick: props.onSave,
						}, t('cards.save')),
						h('button', {
							type: 'button',
							className: 'evrBtn',
							disabled: props.busy,
							onClick: props.onCancel,
						}, t('cards.cancel'))));
			}

			return h('div', { className: 'evrCardsLayout' },
				h('div', { className: 'evrCardsTree' },
					h('div', { className: 'evrSection' }, t('cards.tags')),
					h('button', {
						type: 'button',
						className: 'evrBtn',
						style: { width: '100%', marginBottom: '6px' },
						onClick: function () { props.onFilter({ tag: '', anyTags: [], archivedOnly: false }); },
					}, t('cards.tagReset')),
					h(TagTree, {
						nodes: tree,
						activePath: filter.tag,
						onSelect: function (path) { props.onFilter({ tag: path, anyTags: [], archivedOnly: false }); },
					})),
				h('div', { className: 'evrCardsBody' },
					h('div', { className: 'evrToolbar' },
						filterButton(t('cards.filter.all'), { tag: '', anyTags: [], archivedOnly: false }, filter.tag === '' && (filter.anyTags ?? []).length === 0 && filter.archivedOnly !== true),
						filterButton(t('cards.filter.execution'), { tag: '践行', anyTags: [], archivedOnly: false }, filter.tag === '践行'),
						filterButton(t('cards.filter.input'), { tag: '见闻', anyTags: [], archivedOnly: false }, filter.tag === '见闻'),
						filterButton(t('cards.filter.improvise'), { tag: '即兴', anyTags: [], archivedOnly: false }, filter.tag === '即兴'),
						filterButton(t('cards.filter.review'), { tag: '复盘', anyTags: [], archivedOnly: false }, filter.tag === '复盘'),
						filterButton(t('cards.filter.awareness'), { tag: '觉察', anyTags: [], archivedOnly: false }, filter.tag === '觉察'),
						filterButton(t('cards.filter.experiment'), { tag: '试错', anyTags: [], archivedOnly: false }, filter.tag === '试错'),
						filterButton(t('cards.filter.archived'), { tag: '', anyTags: [], archivedOnly: true }, filter.archivedOnly === true)),
					h('div', { className: 'evrToolbar' },
						h('input', {
							className: 'evrInput',
							type: 'search',
							value: search,
							placeholder: t('cards.search'),
							onChange: function (event) { setSearch(event.target.value); },
						}),
						h('button', {
							type: 'button',
							className: 'evrBtn',
							disabled: props.busy,
							onClick: function () { props.onFilter({ query: search }); },
						}, t('cards.searchAction')),
						h('button', {
							type: 'button',
							className: 'evrBtn evrBtnPrimary',
							disabled: props.busy,
							onClick: props.onNew,
						}, t('cards.new'))),
					props.editor !== null && props.editor !== undefined
						? h('div', { className: 'evrCardsScroll' }, renderEditor())
						: props.detail !== null && props.detail !== undefined
							? h('div', { className: 'evrCardsScroll' }, renderDetail())
							: h('div', { className: 'evrCardsScroll' }, renderList())));
		}

		/**
		 * The global preferences.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function PreferencesTab(props) {
			var t = props.t;
			var preferences = props.preferences;
			var link = preferences?.link ?? { kind: 'missing' };
			// A link the plugin did not create belongs to somebody else: it is
			// shown as such, and replacing it stays a deliberate takeover.
			var foreign = link.kind === 'link' && link.ours === false;
			var linkLabel = t(foreign ? 'prefs.link.foreign' : 'prefs.link.' + link.kind);
			return h('div', null,
				h('div', { className: 'evrSection' }, t('prefs.content')),
				h('div', { className: 'evrHint', style: { marginBottom: '8px' } }, t('prefs.hint')),
				h('textarea', {
					className: 'evrTextarea',
					value: preferences?.content ?? '',
					onChange: function (event) { props.onChange(event.target.value); },
				}),
				h('div', { className: 'evrEditorFoot' },
					h('button', {
						type: 'button',
						className: 'evrBtn evrBtnPrimary',
						disabled: props.busy,
						onClick: function () { props.onSave(); },
					}, t('action.save')),
					link.kind === 'link' && !foreign
						? h('button', {
							type: 'button',
							className: 'evrBtn',
							disabled: props.busy,
							onClick: function () { props.onUnlink(); },
						}, t('action.unlink'))
						: h('button', {
							type: 'button',
							className: 'evrBtn',
							disabled: props.busy,
							onClick: function () { props.onLink(); },
						}, t(foreign ? 'action.takeover' : 'action.link')),
					props.status === undefined || props.status === null
						? null
						: h('span', { className: 'evrStatus' + (props.status.error ? ' evrStatusError' : ' evrStatusOk') }, props.status.message)),
				h('div', { className: 'evrSection' }, t('prefs.global')),
				h('div', { className: 'evrCard' },
					h('div', { className: 'evrCardHead' },
						h('span', { className: 'evrCardTitle' }, linkLabel),
						h('span', { className: 'evrCardCount' }, formatBytes(preferences?.bytes ?? 0))),
					h('div', { className: 'evrCardHint evrMono' }, preferences?.globalPath ?? ''),
					foreign ? h('div', { className: 'evrCardHint evrMono' }, '→ ' + (link.target ?? '')) : null,
					h('div', { className: 'evrCardHint evrMono' }, preferences?.path ?? '')));
		}

		/**
		 * The form values of the embedding settings.
		 *
		 * @param {object | null | undefined} status - The embedding status.
		 * @returns {object} The form values.
		 */
		function embeddingFormOf(status) {
			var e = (status && status.embedding) || {};
			return {
				provider: e.provider || 'local',
				model: e.model || 'multilingual-e5-small',
				runtimePath: e.runtimePath || '',
				baseURL: e.baseURL || '',
				apiKey: '',
				mirror: e.mirror || 'https://hf-mirror.com',
			};
		}

		/**
		 * The initial values of the ingest form.
		 *
		 * @param {object} status - The ingest status.
		 * @returns {object} The form values.
		 */
		function ingestFormOf(status) {
			return {
				enabled: status?.enabled !== false,
				idleMinutes: status?.idleMinutes ?? 15,
			};
		}

		/**
		 * The form values of the daily card consolidation.
		 *
		 * @param {object | null | undefined} status - The consolidation status.
		 * @returns {object} The form values.
		 */
		function consolidateFormOf(status) {
			return {
				enabled: status?.enabled === true,
				dailyCards: status?.dailyCards ?? 15,
				hour: status?.hour ?? 3,
			};
		}

		/**
		 * The initial values of the backup form.
		 *
		 * @param {object | null | undefined} settings - The settings view.
		 * @returns {object} The form values.
		 */
		function backupForm(settings) {
			var backup = (settings && settings.backup) || {};
			return {
				enabled: backup.enabled === true,
				endpoint: backup.endpoint || '',
				bucket: backup.bucket || '',
				accessKeyId: backup.accessKeyId || '',
				accessKeySecret: '',
				prefix: backup.prefix || 'dsh-evolver',
				keep: String(backup.keep === undefined ? 7 : backup.keep),
				intervalMinutes: String(backup.intervalMinutes === undefined ? 1440 : backup.intervalMinutes),
			};
		}

		/**
		 * The settings: the data folder, import/export and the OSS backup.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function SettingsTab(props) {
			var t = props.t;
			var settings = props.settings;
			var busy = props.busy === true;
			var [form, setForm] = useState(function () { return backupForm(settings); });
			var [dataDir, setDataDir] = useState('');
			var [cardCap, setCardCap] = useState(settings?.cardMaxChars ?? 1000);
			var [dataForce, setDataForce] = useState(false);
			var [exportDir, setExportDir] = useState('');
			var [exportName, setExportName] = useState('');
			var [archiveList, setArchiveList] = useState(null);
			var [section, setSection] = useState('data');
			var [importDir, setImportDir] = useState('');
			var [transferForce, setTransferForce] = useState(false);

			useEffect(function () {
				setForm(backupForm(settings));
			}, [settings]);

			useEffect(function () {
				if (settings && settings.cardMaxChars !== undefined) setCardCap(settings.cardMaxChars);
			}, [settings]);

			useEffect(function () {
				if (!settings) return;
				if (exportDir === '' && typeof settings.suggestedArchiveDir === 'string') {
					setExportDir(settings.suggestedArchiveDir);
				}
				if (exportName === '' && typeof settings.suggestedArchiveName === 'string') {
					setExportName(settings.suggestedArchiveName);
				}
			}, [settings, exportDir, exportName]);

			var embeddingDownloading = props.embedding !== null
				&& props.embedding !== undefined
				&& props.embedding.download !== undefined
				&& props.embedding.download.status === 'downloading';
			useEffect(function () {
				if (!embeddingDownloading) return undefined;
				var timer = setInterval(function () { props.onRefreshEmbedding(); }, 900);
				return function () { clearInterval(timer); };
			}, [embeddingDownloading, props.onRefreshEmbedding]);

			if (settings === null || settings === undefined) return h(Spinner, null, t('state.loading'));

			var backup = settings.backup || {};
			var status = settings.status || {};
			var sourceKey = 'settings.data.source.' + (settings.dataDirSource || 'settings');
			var samePath = function (left, right) {
				var clean = function (value) { return String(value || '').replace(/\/+$/, ''); };
				return clean(left) !== '' && clean(left) === clean(right);
			};
			var targetIsCurrent = samePath(dataDir, settings.dataDir);
			var statusLines = [
				t('settings.backup.lastBackup') + ': ' + (status.lastBackupAt ? relativeTime(status.lastBackupAt, t) : t('settings.backup.never')),
				t('settings.backup.lastAttempt') + ': ' + (status.lastAttemptAt ? relativeTime(status.lastAttemptAt, t) : '—'),
				status.lastBytes ? t('settings.backup.size') + ': ' + formatBytes(status.lastBytes) : '',
				status.lastFiles ? t('settings.backup.files') + ': ' + status.lastFiles : '',
				status.lastRemoved ? t('settings.backup.removed') + ': ' + status.lastRemoved : '',
				status.lastObjectKey ? t('settings.backup.object') + ': ' + status.lastObjectKey : '',
				settings.backupRunning ? t('settings.backup.running') : '',
				status.lastError ? t('settings.backup.error') + ': ' + status.lastError : '',
			].filter(function (line) { return line !== ''; });

			function patch(values) {
				setForm(function (previous) {
					var next = {};
					for (var key in previous) next[key] = previous[key];
					for (var name in values) next[name] = values[name];
					return next;
				});
			}

			function migrateNow() {
				if (dataDir.trim() === '') {
					props.onNotify(t('settings.needDataDir'), true);
					return;
				}
				if (targetIsCurrent) return;
				props.onMigrate(dataDir.trim(), dataForce);
			}

			function exportNow() {
				if (exportDir.trim() === '') {
					props.onNotify(t('settings.needDir'), true);
					return;
				}
				if (exportName.trim() === '') {
					props.onNotify(t('settings.needName'), true);
					return;
				}
				props.onExport(exportDir.trim(), exportName.trim(), transferForce);
			}

			function importNow() {
				if (importDir.trim() === '') {
					props.onNotify(t('settings.needArchive'), true);
					return;
				}
				props.onImport(importDir.trim(), transferForce);
			}

			function saveBackup() {
				props.onSaveBackup({
					enabled: form.enabled,
					endpoint: form.endpoint,
					bucket: form.bucket,
					accessKeyId: form.accessKeyId,
					accessKeySecret: form.accessKeySecret,
					prefix: form.prefix,
					keep: Number(form.keep),
					intervalMinutes: Number(form.intervalMinutes),
				});
			}

			/**
			 * Pick a folder and list the archives inside it.
			 *
			 * @returns {void}
			 */
			function browseArchives() {
				if (typeof props.onBrowseArchives !== 'function') return;
				props.onBrowseArchives().then(function (value) {
					if (value && Array.isArray(value.files)) setArchiveList(value);
				});
			}

			/**
			 * The archives the folder picker found.
			 *
			 * @returns {object | null} The list card.
			 */
			function renderArchiveList() {
				if (archiveList === null) return null;
				var files = Array.isArray(archiveList.files) ? archiveList.files : [];
				return h('div', { className: 'evrCard', style: { marginTop: '8px' } },
					h('div', { className: 'evrCardHead' },
						h('span', { className: 'evrCardTitle' }, t('settings.transfer.archives')),
						h('span', { className: 'evrCardCount' }, String(files.length))),
					files.length === 0
						? h('div', { className: 'evrCardHint' }, t('settings.transfer.noArchives'))
						: h('div', null, files.map(function (item) {
							return h('div', {
								key: item.path,
								className: 'evrRow',
								onClick: function () { setImportDir(item.path); },
							},
								h('div', { className: 'evrRowMain' },
									h('div', { className: 'evrRowTitle' }, item.name),
									h('div', { className: 'evrRowMeta' }, formatBytes(item.size) + ' · ' + relativeTime(item.updatedAt, t))));
						})));
			}

			/**
			 * Ask the Host for the native folder picker and fill one field.
			 *
			 * @param {Function} setter - The state setter of the field.
			 * @returns {void}
			 */
			function pick(setter) {
				if (typeof props.onPickDirectory !== 'function') return;
				props.onPickDirectory().then(function (path) {
					if (typeof path === 'string' && path !== '') setter(path);
				});
			}

			/**
			 * One absolute-path input with a browse button.
			 *
			 * @param {Function} setter - The state setter of the field.
			 * @param {string} value - Current value.
			 * @param {string} placeholder - Placeholder text.
			 * @returns {object} The element tree.
			 */
			function pathField(setter, value, placeholder) {
				return h('div', { style: { display: 'flex', gap: '6px' } },
					h('input', {
						className: 'evrInput',
						value: value,
						placeholder: placeholder,
						onChange: function (event) { setter(event.target.value); },
					}),
					h('button', {
						type: 'button',
						className: 'evrBtn',
						disabled: busy,
						onClick: function () { pick(setter); },
					}, t('settings.action.pick')));
			}

			/**
			 * The embedding backend settings.
			 *
			 * @returns {object} The section.
			 */
			function renderEmbedding() {
				var status = props.embedding;
				var form = props.embeddingDraft;
				if (!status || !form) return h('div', { className: 'evrHint' }, t('state.loading'));
				var runtime = status.runtime || {};
				var store = status.store || {};
				var download = status.download || {};
				var catalog = Array.isArray(status.catalog) ? status.catalog : [];
				var present = status.present || {};
				var set = function (patch) { props.onEmbeddingDraft(patch); };
				var downloading = download.status === 'downloading';
				var percent = download.totalBytes > 0 ? Math.min(100, Math.round(download.bytes / download.totalBytes * 100)) : 0;
				var providers = [
					{ id: 'local', label: t('settings.embedding.providerLocal') },
					{ id: 'model', label: t('settings.embedding.providerModel') },
					{ id: 'http', label: t('settings.embedding.providerHttp') },
				];
				return h('div', null,
					h('div', { className: 'evrSection' }, t('settings.embedding.title')),
					h('div', { className: 'evrHint', style: { marginBottom: '6px' } }, t('settings.embedding.hint')),
					h('div', { className: 'evrHint evrMono', style: { marginBottom: '10px' } }, t('settings.embedding.storage')),
					h('div', { className: 'evrCard' },
						h('div', { className: 'evrCardHead' },
							h('span', { className: 'evrCardTitle' }, t('settings.embedding.status')),
							h('span', { className: 'evrCardCount' }, store.embedder || '—')),
						h('div', { className: 'evrCardHint' },
							t('settings.embedding.backend') + ': ' + (store.embedder || '—')
							+ ' · ' + t('settings.embedding.dimensions') + ': ' + (store.dimensions || '—')
							+ ' · ' + (store.aligned ? t('settings.embedding.aligned') : t('settings.embedding.rebuilding'))
							+ ' · ' + t('settings.embedding.entries') + ': ' + (store.cards ?? store.entries ?? 0))),
					h(Field, { label: t('settings.embedding.provider') },
						h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap' } },
							providers.map(function (item) {
								return h('label', { key: item.id, style: { display: 'flex', alignItems: 'center', gap: '6px' } },
									h('input', {
										type: 'radio',
										name: 'evr-embedding-provider',
										checked: form.provider === item.id,
										onChange: function () {
											var patch = { provider: item.id };
											var known = catalog.some(function (model) { return model.id === form.model; });
											if (item.id === 'model' && !known && catalog.length > 0) patch.model = catalog[0].id;
											set(patch);
										},
									}),
									item.label);
							}))),
					form.provider === 'local'
						? h('div', { className: 'evrHint' }, t('settings.embedding.localHint'))
						: null,
					form.provider === 'model' ? h('div', null,
						h('div', { className: 'evrSection' }, t('settings.embedding.catalog')),
						catalog.map(function (model) {
							var selected = form.model === model.id;
							var downloaded = present[model.id] === true;
							return h('div', { key: model.id, className: 'evrRow', style: { cursor: 'default', marginBottom: '6px' } },
								h('input', {
									type: 'radio',
									name: 'evr-embedding-model',
									checked: selected,
									onChange: function () { set({ model: model.id }); },
								}),
								h('div', { className: 'evrRowMain' },
									h('div', { className: 'evrRowTitle' }, model.label),
									h('div', { className: 'evrRowMeta' }, model.languages + ' · ' + model.dimensions + ' ' + t('settings.embedding.dimensions') + ' · ' + formatBytes(model.bytes) + ' · ' + (downloaded ? t('settings.embedding.downloaded') : t('settings.embedding.notDownloaded'))),
									h('div', { className: 'evrRowMeta' }, model.note)),
								downloaded
									? h('button', { type: 'button', className: 'evrBtn evrBtnOk', disabled: true }, t('settings.embedding.downloaded'))
									: downloading && download.model === model.id
										? h('span', { className: 'evrStatus' }, percent + '%')
										: h('button', {
											type: 'button',
											className: 'evrBtn',
											disabled: props.busy || downloading,
											onClick: function () { props.onEmbeddingDownload(model.id); },
										}, t('settings.embedding.download')));
						}),
						downloading
							? h('div', { className: 'evrCard' },
								h('div', { className: 'evrHint' }, t('settings.embedding.downloading') + ' · ' + download.model + ' · ' + formatBytes(download.bytes) + ' / ' + formatBytes(download.totalBytes)),
								h('div', { className: 'evrBar' }, h('div', { className: 'evrBarFill', style: { width: percent + '%' } })),
								h('button', { type: 'button', className: 'evrBtn', onClick: props.onEmbeddingCancel }, t('settings.embedding.cancel')))
							: null,
						download.status === 'done'
							? h('div', { className: 'evrHint' }, t('settings.embedding.downloadDone'))
							: null,
						download.status === 'error'
							? h('div', { className: 'evrHint evrError' }, t('settings.embedding.downloading') + ': ' + (download.error || ''))
							: null,
						h('div', { style: { marginTop: '10px' } },
							h(Field, { label: t('settings.embedding.runtime'), hint: t('settings.embedding.runtimeFieldHint') },
								pathField(function (value) { set({ runtimePath: value }); }, form.runtimePath, status.resolved?.runtimePath ?? ''))),
						h('div', { className: 'evrHint' + (runtime.available ? '' : ' evrWarn') },
							runtime.available ? t('settings.embedding.runtimeReady') : t('settings.embedding.runtimeMissing')),
						runtime.available ? null : h('pre', { className: 'evrPre', style: { marginTop: '6px' } }, t('settings.embedding.runtimeHint') + '\n' + (runtime.hint || '')),
						h(Field, { label: t('settings.embedding.mirror'), hint: t('settings.embedding.mirrorHint') },
							h('input', {
								className: 'evrInput',
								value: form.mirror,
								onChange: function (event) { set({ mirror: event.target.value }); },
							}))
					) : null,
					form.provider === 'http' ? h('div', null,
						h(Field, { label: t('settings.embedding.baseURL'), hint: t('settings.embedding.baseURLHint') },
							h('input', {
								className: 'evrInput',
								value: form.baseURL,
								placeholder: 'http://127.0.0.1:11434/v1',
								onChange: function (event) { set({ baseURL: event.target.value }); },
							})),
						h(Field, { label: t('settings.embedding.modelName') },
							h('input', {
								className: 'evrInput',
								value: form.model,
								placeholder: 'nomic-embed-text',
								onChange: function (event) { set({ model: event.target.value }); },
							})),
						h(Field, { label: t('settings.embedding.apiKey'), hint: status.embedding?.hasApiKey ? t('settings.embedding.hasKey') : '' },
							h('input', {
								className: 'evrInput',
								type: 'password',
								value: form.apiKey,
								onChange: function (event) { set({ apiKey: event.target.value }); },
							}))
					) : null,
					h('div', { className: 'evrEditorFoot' },
						h('button', {
							type: 'button',
							className: 'evrBtn evrBtnPrimary',
							disabled: props.busy,
							onClick: function () { props.onEmbeddingSave(form); },
						}, t('settings.embedding.save')),
						h('button', {
							type: 'button',
							className: 'evrBtn',
							disabled: props.busy,
							onClick: props.onEmbeddingTest,
						}, t('settings.embedding.test'))));
			}

			var sectionBar = h('div', { className: 'evrToolbar', role: 'tablist' }, [
				{ id: 'data', label: t('settings.data') },
				{ id: 'transfer', label: t('settings.transfer') },
				{ id: 'organize', label: t('settings.section.organize') },
				{ id: 'backup', label: t('settings.section.backup') },
				{ id: 'embedding', label: t('settings.section.embedding') },
			].map(function (item) {
				return h('button', {
					key: item.id,
					type: 'button',
					role: 'tab',
					'aria-selected': section === item.id,
					className: 'evrTab' + (section === item.id ? ' evrTabActive' : ''),
					onClick: function () { setSection(item.id); },
				}, item.label);
			}));

			/**
			 * The two organisers, each with its own switch and schedule.
			 *
			 * They are kept apart because they do different work on different
			 * material: the session ingest reads conversations and writes new
			 * fleeting cards, while the card consolidation edits the library
			 * that is already there.
			 *
			 * @returns {object[]} The section content.
			 */
			function renderOrganize() {
				var ingestStatus = props.ingest;
				var ingestForm = props.ingestDraft;
				var consolidateStatus = props.consolidate;
				var consolidateForm = props.consolidateDraft;
				var ingestReady = ingestStatus !== null && ingestStatus !== undefined && ingestForm !== null && ingestForm !== undefined;
				var consolidateReady = consolidateStatus !== null && consolidateStatus !== undefined && consolidateForm !== null && consolidateForm !== undefined;
				return [
					h('div', { className: 'evrSection' }, t('settings.section.organize')),
					h('div', { className: 'evrHint', style: { marginBottom: '10px' } }, t('settings.organize.hint')),
					ingestReady
						? h('div', { className: 'evrCard', style: { marginBottom: '12px' } },
							h('div', { className: 'evrCardHead' },
								h('span', { className: 'evrCardTitle' }, t('sight.ingest.auto')),
								h('span', { className: 'evrCardCount' }, ingestStatus.enabled ? t('sight.ingest.on') : t('sight.ingest.off'))),
							h('div', { className: 'evrCardHint', style: { marginBottom: '8px' } }, t('settings.organize.ingestHint')),
							h('label', { className: 'evrHint', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
								h('input', {
									type: 'checkbox',
									checked: ingestForm.enabled,
									onChange: function (event) { props.onIngestDraft({ enabled: event.target.checked }); },
								}),
								t('sight.ingest.enable')),
							h('div', { className: 'evrToolbar' },
								h('input', {
									className: 'evrInput evrInputNarrow',
									type: 'number',
									min: 5,
									max: 240,
									value: ingestForm.idleMinutes,
									onChange: function (event) { props.onIngestDraft({ idleMinutes: Number(event.target.value) }); },
								}),
								h('span', { className: 'evrHint' }, t('sight.ingest.idleUnit')),
								h('span', { style: { flex: '1' } }),
								h('button', { type: 'button', className: 'evrBtn', onClick: function () { props.onIngestSave(ingestForm); } }, t('action.save')),
								h('button', {
									type: 'button',
									className: 'evrBtn',
									disabled: props.busy || !ingestStatus.available,
									onClick: props.onIngestRun,
								}, t('sight.ingest.run'))),
							h('div', { className: 'evrHint' }, ingestStatus.available
								? t('sight.ingest.pending') + ': ' + (ingestStatus.pending ?? 0) + ' · ' + t('sight.ingest.processed') + ': ' + (ingestStatus.ledger?.processed ?? 0)
								: t('sight.ingest.unavailable')))
						: null,
					consolidateReady
						? h('div', { className: 'evrCard' },
							h('div', { className: 'evrCardHead' },
								h('span', { className: 'evrCardTitle' }, t('settings.consolidate.title')),
								h('span', { className: 'evrCardCount' }, consolidateStatus.enabled ? t('sight.ingest.on') : t('sight.ingest.off'))),
							h('div', { className: 'evrCardHint', style: { marginBottom: '8px' } }, t('settings.consolidate.hint')),
							h('label', { className: 'evrHint', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
								h('input', {
									type: 'checkbox',
									checked: consolidateForm.enabled,
									onChange: function (event) { props.onConsolidateDraft({ enabled: event.target.checked }); },
								}),
								t('sight.ingest.enable')),
							h('div', { className: 'evrToolbar' },
								h('span', { className: 'evrHint' }, t('settings.consolidate.cards')),
								h('input', {
									className: 'evrInput evrInputNarrow',
									type: 'number',
									min: 1,
									max: 100,
									value: consolidateForm.dailyCards,
									onChange: function (event) { props.onConsolidateDraft({ dailyCards: Number(event.target.value) }); },
								}),
								h('span', { className: 'evrHint' }, t('settings.consolidate.at')),
								h('input', {
									className: 'evrInput evrInputNarrow',
									type: 'number',
									min: 0,
									max: 23,
									value: consolidateForm.hour,
									onChange: function (event) { props.onConsolidateDraft({ hour: Number(event.target.value) }); },
								}),
								h('span', { className: 'evrHint' }, t('settings.consolidate.hourUnit')),
								h('span', { style: { flex: '1' } }),
								h('button', { type: 'button', className: 'evrBtn', onClick: function () { props.onConsolidateSave(consolidateForm); } }, t('action.save')),
								h('button', {
									type: 'button',
									className: 'evrBtn',
									disabled: props.busy || !consolidateStatus.available,
									onClick: props.onConsolidateRun,
								}, t('settings.consolidate.run'))),
							h('div', { className: 'evrHint' }, consolidateStatus.available
								? t('settings.consolidate.due') + ': ' + (consolidateStatus.due ?? 0) + ' / ' + (consolidateStatus.total ?? 0)
									+ ' · ' + t('settings.consolidate.lastRun') + ': '
									+ (consolidateStatus.lastRunAt === null || consolidateStatus.lastRunAt === undefined
										? t('settings.consolidate.never')
										: relativeTime(consolidateStatus.lastRunAt, t))
									+ (consolidateStatus.lastError === '' ? '' : ' · ' + consolidateStatus.lastError)
								: t('sight.ingest.unavailable')))
						: null,
					h('div', { className: 'evrHint evrMono', style: { marginTop: '10px' } }, t('settings.consolidate.trashHint'))
				];
			}

			var sections = {
				data: [
				h('div', { className: 'evrSection' }, t('settings.data')),
				h('div', { className: 'evrHint', style: { marginBottom: '10px' } }, t('settings.hint')),
				settings.dataDirWarning
					? h('div', { className: 'evrHint evrWarn', style: { marginBottom: '10px' } }, settings.dataDirWarning)
					: null,
				h('div', { className: 'evrCard' },
					h('div', { className: 'evrCardHead' },
						h('span', { className: 'evrCardTitle' }, t('settings.data.current')),
						h('span', { className: 'evrCardCount' }, t(sourceKey))),
					h('div', { className: 'evrCardHint evrMono' }, settings.dataDir || '')),
				h('div', { style: { marginTop: '10px' } },
					h(Field, { label: t('settings.cardCap'), hint: t('settings.cardCapHint') },
						h('div', { style: { display: 'flex', gap: '6px' } },
							h('input', {
								className: 'evrInput',
								type: 'number',
								min: 200,
								max: 4000,
								value: cardCap,
								onChange: function (event) { setCardCap(Number(event.target.value)); },
							}),
							h('button', {
								type: 'button',
								className: 'evrBtn',
								disabled: busy,
								onClick: function () { props.onSaveCardCap(Number(cardCap)); },
							}, t('action.save'))))),
				h('div', { style: { marginTop: '10px' } },
					h(Field, { label: t('settings.data.new'), hint: t('settings.data.moveHint') },
						pathField(setDataDir, dataDir, '/Users/you/data/dsh-evolver'))),
				targetIsCurrent
					? h('div', { className: 'evrHint evrWarn', style: { marginTop: '8px' } }, t('settings.data.same'))
					: null,
				h('label', { className: 'evrHint', style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' } },
					h('input', { type: 'checkbox', checked: dataForce, onChange: function (event) { setDataForce(event.target.checked); } }),
					t('settings.data.force')),
				h('div', { className: 'evrEditorFoot' },
					h('button', {
						type: 'button',
						className: 'evrBtn evrBtnPrimary',
						disabled: busy || targetIsCurrent,
						onClick: migrateNow,
					}, t('settings.action.migrate'))),

				],
				transfer: [
				h('div', { className: 'evrSection' }, t('settings.transfer')),
				h('div', { className: 'evrHint', style: { marginBottom: '10px' } }, t('settings.transfer.hint')),
				h('div', { className: 'evrFieldRow' },
					h(Field, { label: t('settings.transfer.exportPath') },
						pathField(setExportDir, exportDir, '/Users/you/Desktop')),
					h(Field, { label: t('settings.transfer.exportName') },
						h('input', {
							className: 'evrInput',
							value: exportName,
							placeholder: 'dsh-evolver-20260101-120000.tar.gz',
							onChange: function (event) { setExportName(event.target.value); },
						}))),
				h(Field, { label: t('settings.transfer.importPath') },
					h('div', { style: { display: 'flex', gap: '6px' } },
						h('input', {
							className: 'evrInput',
							value: importDir,
							placeholder: '/Users/you/Desktop/dsh-evolver-20260101-120000.tar.gz',
							onChange: function (event) { setImportDir(event.target.value); },
						}),
						h('button', {
							type: 'button',
							className: 'evrBtn',
							disabled: busy,
							onClick: browseArchives,
						}, t('settings.action.pick')))),
				renderArchiveList(),
				h('label', { className: 'evrHint', style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' } },
					h('input', { type: 'checkbox', checked: transferForce, onChange: function (event) { setTransferForce(event.target.checked); } }),
					t('settings.transfer.force')),
				h('div', { className: 'evrEditorFoot' },
					h('button', {
						type: 'button',
						className: 'evrBtn',
						disabled: busy,
						onClick: exportNow,
					}, t('settings.action.export')),
					h('button', {
						type: 'button',
						className: 'evrBtn',
						disabled: busy,
						onClick: importNow,
					}, t('settings.action.import'))),

				],
				backup: [
				h('div', { className: 'evrSection' }, t('settings.backup')),
				h('div', { className: 'evrHint', style: { marginBottom: '10px' } }, t('settings.backup.hint')),
				h('label', { className: 'evrHint', style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' } },
					h('input', { type: 'checkbox', checked: form.enabled, onChange: function (event) { patch({ enabled: event.target.checked }); } }),
					t('settings.backup.enabled')),
				h('div', { className: 'evrFieldRow' },
					h(Field, { label: t('settings.backup.endpoint'), hint: t('settings.backup.endpointHint') },
						h('input', {
							className: 'evrInput',
							value: form.endpoint,
							placeholder: 'oss-cn-hangzhou.aliyuncs.com',
							onChange: function (event) { patch({ endpoint: event.target.value }); },
						})),
					h(Field, { label: t('settings.backup.bucket') },
						h('input', {
							className: 'evrInput',
							value: form.bucket,
							onChange: function (event) { patch({ bucket: event.target.value }); },
						}))),
				h('div', { className: 'evrFieldRow' },
					h(Field, { label: t('settings.backup.keyId') },
						h('input', {
							className: 'evrInput',
							value: form.accessKeyId,
							onChange: function (event) { patch({ accessKeyId: event.target.value }); },
						})),
					h(Field, {
						label: t('settings.backup.keySecret'),
						hint: backup.hasAccessKeySecret ? t('settings.backup.keySecret.saved') : '',
					}, h('input', {
						className: 'evrInput',
						type: 'password',
						value: form.accessKeySecret,
						placeholder: backup.hasAccessKeySecret ? '••••••••' : '',
						onChange: function (event) { patch({ accessKeySecret: event.target.value }); },
					}))),
				h('div', { className: 'evrFieldRow' },
					h(Field, { label: t('settings.backup.prefix') },
						h('input', {
							className: 'evrInput',
							value: form.prefix,
							onChange: function (event) { patch({ prefix: event.target.value }); },
						})),
					h(Field, { label: t('settings.backup.keep') },
						h('input', {
							className: 'evrInput',
							type: 'number',
							min: 1,
							max: 60,
							value: form.keep,
							onChange: function (event) { patch({ keep: event.target.value }); },
						})),
					h(Field, { label: t('settings.backup.interval'), hint: t('settings.backup.intervalHint') },
						h('input', {
							className: 'evrInput',
							type: 'number',
							min: 5,
							max: 10080,
							value: form.intervalMinutes,
							onChange: function (event) { patch({ intervalMinutes: event.target.value }); },
						}))),
				h('div', { className: 'evrEditorFoot' },
					h('button', {
						type: 'button',
						className: 'evrBtn evrBtnPrimary',
						disabled: busy,
						onClick: saveBackup,
					}, t('settings.action.save')),
					h('button', {
						type: 'button',
						className: 'evrBtn',
						disabled: busy || backup.hasAccessKeySecret !== true,
						onClick: function () { props.onTestBackup(); },
					}, t('settings.action.test')),
					h('button', {
						type: 'button',
						className: 'evrBtn',
						disabled: busy || backup.hasAccessKeySecret !== true,
						onClick: function () { props.onBackupNow(); },
					}, t('settings.action.backupNow')),
					backup.hasAccessKeySecret === true
						? h('button', {
							type: 'button',
							className: 'evrBtn evrBtnDanger',
							disabled: busy,
							onClick: function () { props.onClearSecret(); },
						}, t('settings.action.clearSecret'))
						: null),
				h('div', { className: 'evrSection' }, t('settings.backup.status')),
				h('pre', { className: 'evrPre' }, statusLines.join('\n')),
				h('div', { className: 'evrHint evrMono', style: { marginTop: '8px' } },
					t('settings.backup.settingsPath') + ': ' + (settings.settingsPath || '')),
				],
				organize: renderOrganize(),
				embedding: [renderEmbedding()],
			};

			return h.apply(null, ['div', null, sectionBar].concat(sections[section] ?? []));
		}

		//#endregion

		//#region panel

		/**
		 * The evolver panel.
		 *
		 * @param {object} props - Slot props, including the plugin's `ctx`.
		 * @returns {object} The element tree.
		 */
		function Panel(props) {
			var ctx = props.ctx;
			var t = props.t;
			var call = useCallback(function (endpoint, payload, timeoutMs) { return callHost(ctx, endpoint, payload, timeoutMs); }, [ctx]);

			var [tab, setTab] = useState('overview');
			var [overview, setOverview] = useState(null);
			var [injection, setInjection] = useState(null);
			var [soul, setSoul] = useState(null);
			var [preferences, setPreferences] = useState(null);
			var [settings, setSettings] = useState(null);
			var [settingsEpoch, setSettingsEpoch] = useState(0);
			var [embedding, setEmbedding] = useState(null);
			var [embeddingDraft, setEmbeddingDraft] = useState(null);
			var [ingest, setIngest] = useState(null);
			var [ingestDraft, setIngestDraft] = useState(null);
			var [consolidate, setConsolidate] = useState(null);
			var [consolidateDraft, setConsolidateDraft] = useState(null);
			var [cards, setCards] = useState(null);
			var [descriptions, setDescriptions] = useState(null);
			var [cardFilter, setCardFilter] = useState({ tag: '', anyTags: [], archivedOnly: false, query: '' });
			var [cardDetail, setCardDetail] = useState(null);
			var [cardEditor, setCardEditor] = useState(null);
			var [status, setStatus] = useState(null);
			var [toast, setToast] = useState(null);
			var [busy, setBusy] = useState(false);
			var [error, setError] = useState(null);

			var report = useCallback(function (message, isError) {
				setStatus({ message: message, error: isError === true });
			}, []);

			var notify = useCallback(function (message, isError) {
				setToast({ message: message, error: isError === true });
			}, []);

			useEffect(function () {
				if (toast === null || toast.error === true) return undefined;
				var timer = setTimeout(function () { setToast(null); }, 4500);
				return function () { clearTimeout(timer); };
			}, [toast]);

			var loadAll = useCallback(function () {
				return Promise.all([
					call('overview'),
					call('injection'),
					call('soul'),
					call('preferences'),
					call('settings'),
					call('embedding-status'),
					call('ingest-status'),
					call('consolidate-status').catch(function () { return null; }),
					call('card-list', {}),
					// A host from before this feature answers with an unknown-endpoint
					// error; the panel then simply has no descriptions to edit.
					call('tag-descriptions').catch(function () { return null; }),
				]).then(function (results) {
					setOverview(results[0]);
					setInjection(results[1]);
					setSoul(results[2]);
					setPreferences(results[3]);
					setSettings(results[4]);
					setEmbedding(results[5]);
					setEmbeddingDraft(function (current) { return current === null || current === undefined ? embeddingFormOf(results[5]) : current; });
					setIngest(results[6]);
					setIngestDraft(function (current) { return current === null || current === undefined ? ingestFormOf(results[6]) : current; });
					setConsolidate(results[7]);
					setConsolidateDraft(function (current) { return current === null || current === undefined ? consolidateFormOf(results[7]) : current; });
					setCards(results[8]);
					setDescriptions(results[9]?.descriptions ?? null);
					setError(null);
				}).catch(function (reason) {
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			}, [call]);

			useEffect(function () {
				void loadAll();
			}, [loadAll]);

			var saveTagDescriptions = useCallback(function (draft) {
				setBusy(true);
				call('tag-descriptions-save', { descriptions: draft }).then(function (value) {
					setDescriptions(value.descriptions ?? {});
					report(t('overview.descriptions.saved'), false);
					// The injected block embeds the descriptions, so it is re-read.
					return Promise.all([call('injection'), call('overview')]).then(function (results) {
						setInjection(results[0]);
						setOverview(results[1]);
					});
				}).catch(function (reason) {
					report(reason instanceof Error ? reason.message : String(reason), true);
				}).then(function () {
					setBusy(false);
				});
			}, [call, report, t]);

			var saveSoul = useCallback(function () {
				setBusy(true);
				call('soul-save', { content: soul?.content ?? '' }).then(function () {
					report(t('state.saved'), false);
					return Promise.all([call('injection'), call('overview')]).then(function (results) {
						setInjection(results[0]);
						setOverview(results[1]);
					});
				}).catch(function (reason) {
					report(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, report, soul, t]);

			var savePreferences = useCallback(function () {
				setBusy(true);
				call('preferences-save', { content: preferences?.content ?? '' }).then(function (value) {
					setPreferences(value);
					report(t('state.saved'), false);
				}).catch(function (reason) {
					report(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, preferences, report, t]);

			var linkGlobal = useCallback(function () {
				setBusy(true);
				call('preferences-link', {}).then(function (value) {
					report(value.message ?? t('state.linked'), false);
					return call('preferences');
				}).then(function (value) {
					setPreferences(value);
				}).catch(function (reason) {
					report(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, report, t]);

			var unlinkGlobal = useCallback(function () {
				setBusy(true);
				call('preferences-unlink', {}).then(function (value) {
					report(value.message ?? t('state.saved'), false);
					return call('preferences');
				}).then(function (value) {
					setPreferences(value);
				}).catch(function (reason) {
					report(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, report, t]);

			var saveCardCap = useCallback(function (value) {
				setBusy(true);
				return call('settings-save', { cardMaxChars: value }).then(function (next) {
					setSettings(next);
					notify(t('state.saved'), false);
					return refreshCards();
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, refreshCards, t]);

			var saveBackupSettings = useCallback(function (form) {
				setBusy(true);
				call('settings-save', { backup: form }).then(function (value) {
					setSettings(value);
					notify(t('state.saved'), false);
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, report, t]);

			var clearBackupSecret = useCallback(function () {
				setBusy(true);
				call('settings-save', { backup: { clearAccessKeySecret: true } }).then(function (value) {
					setSettings(value);
					notify(t('state.saved'), false);
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, report, t]);

			var migrateData = useCallback(function (dir, force) {
				setBusy(true);
				notify(t('state.working'), false);
				call('data-migrate', { dir: dir, force: force }, 300000).then(function (value) {
					notify(t('state.migrated') + ' → ' + String(value.root ?? dir), false);
					setSettingsEpoch(function (value) { return value + 1; });
					return loadAll();
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, loadAll, report, t]);

			var exportData = useCallback(function (dir, name, force) {
				setBusy(true);
				notify(t('state.working'), false);
				call('data-export', { dir: dir, name: name, force: force }, 300000).then(function (value) {
					notify(t('state.exported') + ' → ' + String(value.file ?? dir) + ' · ' + String(value.files ?? 0) + ' · ' + formatBytes(value.bytes ?? 0), false);
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, report, t]);

			var importData = useCallback(function (dir, force) {
				setBusy(true);
				notify(t('state.working'), false);
				call('data-import', { file: dir, force: force }, 300000).then(function (value) {
					notify(t('state.imported') + ' · ' + String(value.files ?? 0) + ' · ' + formatBytes(value.bytes ?? 0) + (value.skipped > 0 ? ' · ' + t('state.skipped') + ' ' + value.skipped : ''), false);
					return loadAll();
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, loadAll, report, t]);

			var backupNow = useCallback(function () {
				setBusy(true);
				notify(t('state.working'), false);
				call('backup-now', { force: true }, 300000).then(function (value) {
					if (value && value.settings) setSettings(value.settings);
					notify(t('state.backed') + ' · ' + formatBytes(value.bytes ?? 0), false);
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, report, t]);

			var testBackup = useCallback(function () {
				setBusy(true);
				notify(t('state.working'), false);
				call('backup-test', {}).then(function (value) {
					notify(t('settings.backup.testOk') + ' · ' + String(value.endpoint ?? ''), false);
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, report, t]);

			var pickDirectory = useCallback(function () {
				var service = ctx.get('uiWorkspace');
				if (service === undefined || typeof service.pickDirectory !== 'function') {
					notify(t('settings.pick.unavailable'), true);
					return Promise.resolve(null);
				}
				return Promise.resolve(service.pickDirectory()).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
					return null;
				});
			}, [ctx, report, t]);

			var browseArchives = useCallback(function () {
				var service = ctx.get('uiWorkspace');
				if (service === undefined || typeof service.pickDirectory !== 'function') {
					notify(t('settings.pick.unavailable'), true);
					return Promise.resolve(null);
				}
				return Promise.resolve(service.pickDirectory()).then(function (dir) {
					if (typeof dir !== 'string' || dir === '') return null;
					return call('data-archives', { dir: dir }).catch(function (reason) {
						notify(reason instanceof Error ? reason.message : String(reason), true);
						return null;
					});
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
					return null;
				});
			}, [call, ctx, report, t]);

			var patchEmbeddingDraft = useCallback(function (patch) {
				setEmbeddingDraft(function (current) { return { ...(current ?? {}), ...patch }; });
			}, []);

			var refreshEmbedding = useCallback(function () {
				return call('embedding-status').then(function (value) {
					setEmbedding(value);
					return value;
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
					return null;
				});
			}, [call, notify]);

			var saveEmbedding = useCallback(function (form) {
				setBusy(true);
				return call('embedding-save', { embedding: form }).then(function (value) {
					setEmbedding(value);
					setEmbeddingDraft(embeddingFormOf(value));
					notify(t('state.saved'), false);
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, t]);

			var downloadEmbedding = useCallback(function (model) {
				setBusy(true);
				return call('embedding-download', { model: model }).then(function (value) {
					setEmbedding(value);
					notify(t('settings.embedding.downloading'), false);
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, t]);

			var cancelEmbedding = useCallback(function () {
				return call('embedding-cancel').then(function (value) {
					setEmbedding(value);
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				});
			}, [call, notify]);

			var patchIngestDraft = useCallback(function (patch) {
				setIngestDraft(function (current) { return { ...(current ?? ingestFormOf(ingest)), ...patch }; });
			}, [ingest]);

			var saveIngest = useCallback(function (form) {
				setBusy(true);
				return call('ingest-save', { ingest: form }).then(function (value) {
					setIngest(value);
					setIngestDraft(ingestFormOf(value));
					notify(t('state.saved'), false);
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, t]);

			var runIngest = useCallback(function () {
				setBusy(true);
				return call('ingest-run', {}, 300000).then(function (value) {
					var message = value && value.message
						? value.message
						: t('sight.ingest.done') + ' · ' + String(value?.sessions ?? 0) + ' ' + t('sight.ingest.sessionsUnit') + ' · ' + String(value?.saved ?? 0) + ' ' + t('sight.ingest.memoriesUnit');
					notify(message, false);
					return call('ingest-status').then(function (status) {
						setIngest(status);
						setIngestDraft(ingestFormOf(status));
					}).catch(function () {});
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, t]);

			var patchConsolidateDraft = useCallback(function (patch) {
				setConsolidateDraft(function (current) { return { ...(current ?? consolidateFormOf(consolidate)), ...patch }; });
			}, [consolidate]);

			var saveConsolidate = useCallback(function (form) {
				setBusy(true);
				return call('consolidate-save', { consolidate: form }).then(function (value) {
					setConsolidate(value);
					setConsolidateDraft(consolidateFormOf(value));
					notify(t('state.saved'), false);
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, t]);

			var runConsolidate = useCallback(function () {
				setBusy(true);
				return call('consolidate-run', {}, 600000).then(function (value) {
					var message = value && value.message
						? value.message
						: t('settings.consolidate.done')
							.replace('{batch}', String(value?.batch ?? 0))
							.replace('{applied}', String((value?.updated ?? 0) + (value?.merged ?? 0) + (value?.deleted ?? 0)));
					notify(message, false);
					return Promise.all([
						call('consolidate-status').catch(function () { return null; }),
						call('card-list', {}).catch(function () { return null; }),
						call('overview').catch(function () { return null; }),
					]).then(function (results) {
						if (results[0] !== null) {
							setConsolidate(results[0]);
							setConsolidateDraft(consolidateFormOf(results[0]));
						}
						if (results[1] !== null) setCards(results[1]);
						if (results[2] !== null) setOverview(results[2]);
					}).catch(function () {});
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, t]);

			var refreshCards = useCallback(function (nextFilter) {
				var filter = nextFilter ?? cardFilter;
				var payload = {
					query: filter.query ?? '',
					tags: filter.tag ? [filter.tag] : [],
					anyTags: filter.anyTags ?? [],
					archivedOnly: filter.archivedOnly === true,
				};
				return call('card-list', payload).then(function (value) {
					setCards(value);
					return value;
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
					return null;
				});
			}, [call, cardFilter, notify]);

			var changeCardFilter = useCallback(function (patch) {
				var next = { ...cardFilter, ...patch };
				setCardFilter(next);
				setCardDetail(null);
				setCardEditor(null);
				return refreshCards(next);
			}, [cardFilter, refreshCards]);

			var openCard = useCallback(function (id) {
				return call('card-read', { id: id }).then(function (value) {
					setCardDetail(value);
					setCardEditor(null);
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				});
			}, [call, notify]);

			var newCard = useCallback(function () {
				setCardDetail(null);
				setCardEditor({
					mode: 'new',
					fields: {
						id: '',
						body: '',
						tags: '即兴',
						links: '',
					},
				});
			}, []);

			var editCard = useCallback(function () {
				if (cardDetail === null || cardDetail === undefined || cardDetail.card === null) return;
				var card = cardDetail.card;
				setCardEditor({
					mode: 'edit',
					fields: {
						id: card.id,
						body: card.body,
						tags: (card.tags ?? []).join(', '),
						links: (card.links ?? []).join(', '),
					},
				});
			}, [cardDetail]);

			var patchCardDraft = useCallback(function (patch) {
				setCardEditor(function (previous) {
					return previous === null ? null : { ...previous, fields: { ...previous.fields, ...patch } };
				});
			}, []);

			var saveCard = useCallback(function () {
				if (cardEditor === null) return;
				var fields = cardEditor.fields;
				var split = function (value) {
					return String(value ?? '').split(/[,，\n]/).map(function (item) { return item.trim(); }).filter(function (item) { return item !== ''; });
				};
				var card = {
					...(fields.id === '' ? {} : { id: fields.id }),
					body: fields.body,
					tags: split(fields.tags),
					links: split(fields.links),
				};
				setBusy(true);
				return call('card-write', { card: card }).then(function (saved) {
					setCardEditor(null);
					return refreshCards().then(function () {
						notify(t('cards.saved'), false);
						return openCard(saved.id);
					});
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, cardEditor, notify, openCard, refreshCards, t]);

			var promoteCard = useCallback(function (id, target) {
				setBusy(true);
				return call('card-promote', { id: id, tags: [target || '践行'] }).then(function () {
					return refreshCards().then(function () { return openCard(id); });
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, openCard, refreshCards]);

			var archiveCard = useCallback(function (id) {
				setBusy(true);
				return call('card-archive', { id: id }).then(function () {
					return refreshCards().then(function () { return openCard(id); });
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, openCard, refreshCards]);

			var deleteCard = useCallback(function (id) {
				if (typeof confirm === 'function' && confirm(t('cards.deleteConfirm')) !== true) return;
				setBusy(true);
				return call('card-remove', { id: id }).then(function () {
					setCardDetail(null);
					return refreshCards().then(function () { notify(t('cards.removed'), false); });
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, refreshCards, t]);

			var attachCard = useCallback(function (id, file) {
				if (file === undefined || file === null) return;
				if (typeof FileReader === 'undefined') {
					notify(t('cards.attachFailed'), true);
					return;
				}
				var reader = new FileReader();
				reader.onload = function () {
					var encoded = String(reader.result ?? '').split(',')[1] ?? '';
					setBusy(true);
					call('card-attach', { id: id, name: file.name, data: encoded }, 120000).then(function () {
						return refreshCards().then(function () { return openCard(id); });
					}).catch(function (reason) {
						notify(reason instanceof Error ? reason.message : String(reason), true);
					}).finally(function () { setBusy(false); });
				};
				reader.onerror = function () { notify(t('cards.attachFailed'), true); };
				reader.readAsDataURL(file);
			}, [call, notify, openCard, refreshCards, t]);

			var testEmbedding = useCallback(function () {
				setBusy(true);
				return call('embedding-test', {}, 120000).then(function (value) {
					var message = t('settings.embedding.testOk') + ' · ' + String(value.backend) + ' · ' + String(value.dimensions) + ' 维 · ' + String(value.latencyMs) + ' ms';
					if (value.backend !== value.configured) message += ' · ' + t('settings.embedding.fellBack');
					notify(message, false);
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, t]);

			var body = null;
			if (error !== null) {
				body = h('div', { className: 'evrEmpty' },
					h('div', null, t('state.error')),
					h('div', { className: 'evrMono' }, error));
			} else if (tab === 'overview') {
				body = h(OverviewTab, {
					t: t,
					injection: injection,
					overview: overview,
					cards: cards,
					descriptions: descriptions,
					busy: busy,
					onSaveDescriptions: saveTagDescriptions,
				});
			} else if (tab === 'cards') {
				body = h(CardsTab, {
					t: t,
					state: cards,
					filter: cardFilter,
					detail: cardDetail,
					editor: cardEditor,
					busy: busy,
					onFilter: changeCardFilter,
					onOpen: openCard,
					onNew: newCard,
					onEdit: editCard,
					onDraft: patchCardDraft,
					onSave: saveCard,
					onCancel: function () { setCardEditor(null); },
					onPromote: promoteCard,
					onArchive: archiveCard,
					onDelete: deleteCard,
					onAttach: attachCard,
				});
			} else if (tab === 'soul') {
				body = h(SoulTab, {
					t: t,
					soul: soul,
					onSoulChange: function (content) { setSoul(function (previous) { return { ...(previous ?? {}), content: content }; }); },
					onSoulSave: saveSoul,
					busy: busy,
					status: status,
				});
			} else if (tab === 'preferences') {
				body = h(PreferencesTab, {
					t: t,
					preferences: preferences,
					onChange: function (content) { setPreferences(function (previous) { return { ...(previous ?? {}), content: content }; }); },
					onSave: savePreferences,
					onLink: linkGlobal,
					onUnlink: unlinkGlobal,
					busy: busy,
					status: status,
				});
			} else if (tab === 'settings') {
				body = h(SettingsTab, {
					key: settingsEpoch,
					t: t,
					settings: settings,
					busy: busy,
					onNotify: notify,
					onSaveBackup: saveBackupSettings,
					onSaveCardCap: saveCardCap,
					onClearSecret: clearBackupSecret,
					onMigrate: migrateData,
					onExport: exportData,
					onImport: importData,
					onBackupNow: backupNow,
					onTestBackup: testBackup,
					onPickDirectory: pickDirectory,
					onBrowseArchives: browseArchives,
					ingest: ingest,
					ingestDraft: ingestDraft,
					onIngestDraft: patchIngestDraft,
					onIngestSave: saveIngest,
					onIngestRun: runIngest,
					consolidate: consolidate,
					consolidateDraft: consolidateDraft,
					onConsolidateDraft: patchConsolidateDraft,
					onConsolidateSave: saveConsolidate,
					onConsolidateRun: runConsolidate,
					embedding: embedding,
					embeddingDraft: embeddingDraft,
					onEmbeddingDraft: patchEmbeddingDraft,
					onEmbeddingSave: saveEmbedding,
					onEmbeddingDownload: downloadEmbedding,
					onEmbeddingCancel: cancelEmbedding,
					onEmbeddingTest: testEmbedding,
					onRefreshEmbedding: refreshEmbedding,
				});
			}

			var subtitle = useMemo(function () {
				if (overview === null || overview === undefined) return t('state.loading');
				return overview.root ?? '';
			}, [overview, t]);

			return h('div', { className: 'evrRoot' },
				h('div', { className: 'evrHead' },
					h('div', { className: 'evrHeadMain' },
						h('h1', { className: 'evrTitle' },
							t('panel'),
							overview === null || overview === undefined || !overview.version
								? null
								: h('span', { className: 'evrVersion' }, 'v' + overview.version)),
						h('div', { className: 'evrSubtitle', title: subtitle }, subtitle)),
					h('div', { className: 'evrHeadActions' },
						h('button', {
							type: 'button',
							className: 'evrBtn',
							onClick: function () { void loadAll(); },
						}, t('action.refresh')))),
				h('div', { className: 'evrTabs', role: 'tablist' }, TABS.map(function (item) {
					return h('button', {
						key: item.id,
						type: 'button',
						role: 'tab',
						'aria-selected': tab === item.id,
						className: 'evrTab' + (tab === item.id ? ' evrTabActive' : ''),
						onClick: function () { setTab(item.id); },
					}, t(item.label));
				})),
				h('div', { className: 'evrBody' }, h('div', { className: 'evrEnter', key: tab }, body)),
				toast === null
					? null
					: h('div', {
						className: 'evrToast ' + (toast.error ? 'evrToastError' : 'evrToastOk'),
						role: 'status',
						'aria-live': 'polite',
					},
						h('span', { className: 'evrToastText' }, toast.message),
						h('button', {
							type: 'button',
							className: 'evrToastClose',
							'aria-label': t('action.close'),
							onClick: function () { setToast(null); },
						}, '×')));
		}

		//#endregion

		//#region plugin

		var inject = ['slots', 'locale', 'connection'];

		/**
		 * Register the panel and its sidebar entry.
		 *
		 * @param {object} ctx - Client context.
		 */
		function apply(ctx) {
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, 'dsh-evolver: dictionaries');
			var t = ctx.locale.bind(NS);

			ctx.effect(function () {
				var style = document.createElement('style');
				style.dataset.plugin = 'dsh-evolver';
				style.textContent = css;
				document.head.appendChild(style);
				return function () { style.remove(); };
			}, 'dsh-evolver: styles');

			ctx.effect(function () {
				return ctx.slots.inject('main', function () {
					return ctx.slots.register({
						name: 'main',
						key: PANEL_ID,
						locale: NS,
						inject: function () { return { ctx: ctx, t: t }; },
					}, Panel);
				});
			}, 'dsh-evolver: main panel');

			ctx.effect(function () {
				return ctx.slots.inject('sidebar.panellist', function () {
					return ctx.slots.register({
						name: 'sidebar.panellist',
						id: PANEL_ID,
						order: PANEL_ORDER,
						locale: NS,
						label: function () { return t('panel'); },
					}, EvolverIcon);
				});
			}, 'dsh-evolver: sidebar entry');
		}

		//#endregion

		return {
			inject: inject,
			apply: apply,
		};
	},
});
