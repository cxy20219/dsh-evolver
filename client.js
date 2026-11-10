/*
 * dsh-evolver — browser half.
 *
 * One sidebar entry opens one panel with five tabs:
 * 概览 / 卡片 / 灵魂 / 偏好 / 建议.
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
			'tab.suggestions': '建议',
			'tab.settings': '设置',
			'state.migrated': '已迁移到新目录',
			'state.exported': '已导出',
			'state.imported': '已导入',
			'state.backed': '备份完成',
			'state.working': '处理中…',
			'state.skipped': '跳过',
			'action.refresh': '刷新',
			'action.save': '保存',
			'action.close': '关闭',
			'action.unlink': '移除全局链接',
			'state.loading': '读取中…',
			'state.error': '读取失败',
			'state.saved': '已保存',
			'state.linked': '已建立全局链接',
			'overview.injection': '注入的上下文',
			'overview.injection.hint': 'Agent 每次请求都会拿到这三块，别的地方都不占它的上下文。',
			'overview.cards': '标签树',
			'overview.soul': '灵魂',
			'overview.preferences': '偏好',
			'overview.suggestions': '建议',
			'overview.root': '数据目录',
			'overview.version': '版本',
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
			'suggestion.empty': '没有待办：卡片库是健康的。',
			'suggestion.problem': '结构问题',
			'suggestion.stale': '久未验证',
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
			'tab.suggestions': 'Suggestions',
			'tab.settings': 'Settings',
			'state.migrated': 'Moved to the new folder',
			'state.exported': 'Exported',
			'state.imported': 'Imported',
			'state.backed': 'Backup complete',
			'state.working': 'Working…',
			'state.skipped': 'skipped',
			'action.refresh': 'Refresh',
			'action.save': 'Save',
			'action.close': 'Close',
			'action.unlink': 'Remove the global link',
			'state.loading': 'Loading…',
			'state.error': 'Failed to read',
			'state.saved': 'Saved',
			'state.linked': 'The global link is in place',
			'overview.injection': 'Injected context',
			'overview.injection.hint': 'The agent gets exactly these three blocks in every request.',
			'overview.cards': 'Tag tree',
			'overview.soul': 'Soul',
			'overview.preferences': 'Preferences',
			'overview.suggestions': 'Suggestions',
			'overview.root': 'Data folder',
			'overview.version': 'Version',
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
			'suggestion.empty': 'Nothing to do: the card store is healthy.',
			'suggestion.problem': 'Structure problem',
			'suggestion.stale': 'Not verified for a while',
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
			{ id: 'suggestions', label: 'tab.suggestions' },
			{ id: 'settings', label: 'tab.settings' },
		];

		//#endregion

		//#region styles

		var css = [
			'.evrRoot{position:relative;height:100%;display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}',
			'.evrHead{display:flex;align-items:flex-start;gap:16px;padding:22px 28px 0;flex:none}',
			'.evrHeadMain{flex:1;min-width:0}',
			'.evrTitle{margin:0;font-size:18px;font-weight:600;line-height:26px;letter-spacing:-.01em}',
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
			'.evrEnter{animation:evrEnter .22s cubic-bezier(.2,.7,.3,1) both}',
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
			'.evrTag{display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;flex:none}',
			'.evrToolbar{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}',
			'.evrInput{flex:1;min-width:160px;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;box-sizing:border-box}',
			'.evrInput:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
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
			if (injection === null || overview === null) return h(Spinner, null, t('state.loading'));
			var projection = overview.projection ?? {};
			return h('div', null,
				h('div', { className: 'evrSection' }, t('overview.injection')),
				h('div', { className: 'evrHint', style: { marginBottom: '10px' } }, t('overview.injection.hint')),
				h('div', { className: 'evrGrid' },
					h(StatCard, {
						title: t('overview.cards'),
						count: injection.cards.entries,
						value: formatBytes(injection.cards.bytes),
						hint: t('overview.budget') + ' ' + formatBytes(injection.cards.budget)
							+ ' · ' + t('overview.dropped') + ' ' + injection.cards.dropped,
					}),
					h(StatCard, {
						title: t('overview.soul'),
						value: formatBytes(injection.soul.bytes),
						hint: t('overview.budget') + ' ' + formatBytes(injection.soul.budget),
					}),
					h(StatCard, {
						title: t('overview.preferences'),
						value: formatBytes(injection.preferences.bytes),
						hint: injection.preferences.link.kind !== 'link'
							? t('prefs.link.missing')
							: (injection.preferences.link.ours === false ? t('prefs.link.foreign') : t('prefs.link.linked')),
					}),
					h(StatCard, {
						title: t('overview.root'),
						value: String(projection.entries ?? 0),
						hint: overview.root ?? '',
					}),
					h(StatCard, {
						title: t('overview.version'),
						value: overview.version ? 'v' + overview.version : '—',
						hint: 'dsh-evolver',
					})),
				h('div', { className: 'evrSection' }, t('overview.projection')),
				h('pre', { className: 'evrPre' }, injection.cards.text ?? ''),
				h('div', { className: 'evrSection' }, t('overview.suggestions')),
				(overview.suggestions ?? []).length === 0
					? h('div', { className: 'evrHint' }, t('suggestion.empty'))
					: h('div', null, (overview.suggestions ?? []).map(function (item, index) {
						return h('div', {
							key: index,
							className: 'evrRow',
							style: { cursor: 'default' },
						},
							h('div', { className: 'evrRowMain' },
								h('div', { className: 'evrRowTitle' }, item.path ?? ''),
								h('div', { className: 'evrRowMeta' }, item.message ?? '')),
							h('span', { className: 'evrTag' }, item.kind === 'stale' ? t('suggestion.stale') : t('suggestion.problem')));
					}))
			);
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
			var ingest = props.ingest;
			var ingestDraft = props.ingestDraft;

			function tagRows(nodes, depth) {
				var rows = [];
				(nodes ?? []).forEach(function (node) {
					rows.push(h('button', {
						key: node.path,
						type: 'button',
						className: 'evrRow',
						style: {
							cursor: 'pointer',
							width: '100%',
							textAlign: 'left',
							border: 'none',
							background: filter.tag === node.path ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
							paddingLeft: (8 + depth * 12) + 'px',
						},
						onClick: function () { props.onFilter({ tag: node.path, anyTags: [], archivedOnly: false }); },
					},
						h('div', { className: 'evrRowMain' },
							h('div', { className: 'evrRowTitle' }, node.name),
							h('div', { className: 'evrRowMeta' }, String(node.count)))));
					rows = rows.concat(tagRows(node.children ?? [], depth + 1));
				});
				return rows;
			}

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
						h('div', { className: 'evrRowTime' }, String(card.updated ?? '').slice(0, 10)));
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
						h('div', { className: 'evrHint evrMono' }, card.id + (card.verified ? ' · ' + card.verified : '')),
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

			return h('div', { style: { display: 'flex', gap: '18px', alignItems: 'flex-start' } },
				h('div', { style: { width: '190px', flexShrink: 0 } },
					h('div', { className: 'evrSection' }, t('cards.tags')),
					h('button', {
						type: 'button',
						className: 'evrBtn',
						style: { width: '100%', marginBottom: '6px' },
						onClick: function () { props.onFilter({ tag: '', anyTags: [], archivedOnly: false }); },
					}, t('cards.tagReset')),
					tagRows(tree, 0)),
				h('div', { style: { flex: 1, minWidth: 0 } },
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
					ingest !== null && ingest !== undefined && ingestDraft !== null && ingestDraft !== undefined
						? h('div', { className: 'evrCard' },
							h('div', { className: 'evrCardHead' },
								h('span', { className: 'evrCardTitle' }, t('sight.ingest.auto')),
								h('span', { className: 'evrCardCount' }, ingest.enabled ? t('sight.ingest.on') : t('sight.ingest.off'))),
							h('label', { className: 'evrHint', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
								h('input', {
									type: 'checkbox',
									checked: ingestDraft.enabled,
									onChange: function (event) { props.onIngestDraft({ enabled: event.target.checked }); },
								}),
								t('sight.ingest.enable')),
							h('div', { className: 'evrToolbar' },
								h('input', {
									className: 'evrInput',
									type: 'number',
									min: 5,
									max: 240,
									value: ingestDraft.idleMinutes,
									onChange: function (event) { props.onIngestDraft({ idleMinutes: Number(event.target.value) }); },
								}),
								h('span', { className: 'evrHint' }, t('sight.ingest.idleUnit')),
								h('button', { type: 'button', className: 'evrBtn', onClick: function () { props.onIngestSave(ingestDraft); } }, t('action.save')),
								h('button', {
									type: 'button',
									className: 'evrBtn',
									disabled: props.busy || !ingest.available,
									onClick: props.onIngestRun,
								}, t('sight.ingest.run'))),
							h('div', { className: 'evrHint' }, ingest.available
								? t('sight.ingest.pending') + ': ' + (ingest.pending ?? 0) + ' · ' + t('sight.ingest.processed') + ': ' + (ingest.ledger?.processed ?? 0)
								: t('sight.ingest.unavailable')))
						: null,
					props.editor !== null && props.editor !== undefined
						? renderEditor()
						: props.detail !== null && props.detail !== undefined
							? renderDetail()
							: renderList()));
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
		 * The suggestions: what could move and what looks stale.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function SuggestionsTab(props) {
			var t = props.t;
			var suggestions = props.suggestions ?? [];
			if (suggestions.length === 0) return h(Empty, null, t('suggestion.empty'));
			return h('div', null, suggestions.map(function (item, index) {
				return h('div', {
					key: index,
					className: 'evrRow',
					style: { cursor: 'default' },
				},
					h('div', { className: 'evrRowMain' },
						h('div', { className: 'evrRowTitle' }, item.path ?? ''),
						h('div', { className: 'evrRowMeta' }, item.message ?? '')),
					h('span', { className: 'evrTag' }, item.kind === 'stale' ? t('suggestion.stale') : t('suggestion.problem')));
			}));
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
			var [cards, setCards] = useState(null);
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
					call('card-list', {}),
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
					setCards(results[7]);
					setError(null);
				}).catch(function (reason) {
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			}, [call]);

			useEffect(function () {
				void loadAll();
			}, [loadAll]);

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
				body = h(OverviewTab, { t: t, injection: injection, overview: overview });
			} else if (tab === 'cards') {
				body = h(CardsTab, {
					t: t,
					state: cards,
					filter: cardFilter,
					detail: cardDetail,
					editor: cardEditor,
					busy: busy,
					ingest: ingest,
					ingestDraft: ingestDraft,
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
					onIngestDraft: patchIngestDraft,
					onIngestSave: saveIngest,
					onIngestRun: runIngest,
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
					embedding: embedding,
					embeddingDraft: embeddingDraft,
					onEmbeddingDraft: patchEmbeddingDraft,
					onEmbeddingSave: saveEmbedding,
					onEmbeddingDownload: downloadEmbedding,
					onEmbeddingCancel: cancelEmbedding,
					onEmbeddingTest: testEmbedding,
					onRefreshEmbedding: refreshEmbedding,
				});
			} else {
				body = h(SuggestionsTab, { t: t, suggestions: overview?.suggestions ?? [] });
			}

			var subtitle = useMemo(function () {
				if (overview === null || overview === undefined) return t('state.loading');
				return overview.root ?? '';
			}, [overview, t]);

			return h('div', { className: 'evrRoot' },
				h('div', { className: 'evrHead' },
					h('div', { className: 'evrHeadMain' },
						h('h1', { className: 'evrTitle' }, t('panel')),
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
