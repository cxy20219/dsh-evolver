/*
 * dsh-evolver — browser half.
 *
 * One sidebar entry opens one panel with seven tabs:
 * 概览 / 卡片 / 资源 / 偏好 / 整理 / 设置 / 日志.
 *
 * The panel shows the same two things the agent gets: the card projection
 * and the global preferences — plus the health of the folder.
 */
window.__ModuleLoader__.load({
	id: 'dsh-evolver',
	factory: function (require) {
		var react = require('react');

		var Component = react.Component;
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
			'tab.resources': '资源',
			'resources.title': '资源',
			'cards.resources.empty': '还没有附件。卡片正文用 [标题]({{resource}}) 引用附件；脚本附件会自动设为可执行，agent 拿到绝对路径就能直接跑。',
			'cards.resources.view': '看引用它的卡片',
			'cards.resources.search': '搜索资源…',
			'cards.resources.preview': '预览',
			'cards.resources.open': '打开',
			'cards.resources.close': '关闭',
			'cards.resources.noPreview': '这个类型没法在面板里预览，用系统程序打开更合适。',
			'cards.resources.emptySearch': '没有匹配的资源。',
			'cards.resources.revealed': '已改为在文件管理器中定位（脚本与安装包不会直接运行）。',
			'cards.resources.more': '还有 {n} 个文件，用搜索收窄。',
			'cards.resources.truncated': '文件较大，预览只显示前 200 KB。',
			'cards.filter.resource': '引用资源：{name}',
			'cards.filter.resourceClear': '清除',
			'cards.resources.owner': '所属卡片',
			'cards.resources.exec': '可执行',
			'cards.resources.refs': '引用',
			'cards.resources.count': '共 {files} 个文件 · {cards} 张卡',
			'cards.new': '新建卡片',
			'cards.search': '搜索卡片…',
			'cards.filter.all': '全部',
			'cards.filter.execution': '践行',
			'cards.filter.input': '见闻',
			'cards.filter.improvise': '即兴',
			'cards.filter.review': '复盘',
			'cards.filter.awareness': '觉察',
			'cards.filter.experiment': '试错',
			'cards.filter.archived': '归档',
			'cards.empty': '还没有卡片。',
			'cards.truncated': '只显示前 {shown} 张，共 {total} 张；用搜索或标签收窄范围。',
			'cards.tags': '标签',
			'cards.tagReset': '全部标签',
			'cards.editor.new': '新建卡片',
			'cards.editor.edit': '编辑卡片',
			'cards.field.body': '正文',
			'cards.field.tags': '标签（逗号分隔）',
			'cards.field.description': '描述（必填：一句话说清这张卡回答什么问题，≤{max} 字）',
			'cards.field.descriptionHint': '例如：说明部署走 SSH 的原因，和 HTTPS 的边界',
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
			'cards.source': '原文',
			'cards.backlinks': '被引用',
			'cards.saved': '已保存',
			'cards.removed': '已删除',
			'cards.attachFailed': '附件读取失败',
			'cards.attachTooLarge': '附件超过 8 MB，先压缩或拆分后再添加。',
			'settings.cardDescCap': '卡片描述上限',
			'settings.cardDescCapHint': '20–200 字。描述就是注入索引里 id 后面那句话；超过上限会被拒绝写入，不会截断。',
			'settings.cardCap': '卡片正文上限',
			'settings.cardCapHint': '200–4000 字；超长内容请放资源附件。',
			'sight.ingest.auto': '闲时自动整理',
			'sight.ingest.on': '开',
			'sight.ingest.off': '关',
			'sight.ingest.enable': '启用',
			'sight.ingest.idleUnit': '分钟无活动后',
			'sight.ingest.pending': '待整理',
			'sight.ingest.quoted': '上次保存 {saved} 条，其中 {quoted} 条带得出原文',
			'sight.ingest.processed': '已处理',
			'sight.ingest.unavailable': '宿主没有提供会话读取或模型调用能力。',
			'sight.ingest.run': '立即整理',
			'sight.ingest.done': '整理完成',
			'sight.ingest.sessionsUnit': '个会话',
			'sight.ingest.memoriesUnit': '条记忆',
			'tab.preferences': '偏好',
			'tab.organize': '整理',
			'tab.settings': '设置',
			'tab.logs': '日志',
			'logs.tab.logs': '插件日志',
			'logs.tab.health': '库健康',
			'logs.health.hint': '每天 9:00 记一行：即兴积压、出链率、孤岛数、提示词缓存。只记数据，不写卡片。',
			'logs.health.lastRun': '上次记录 {at}',
			'logs.health.never': '还没记录过',
			'logs.health.run': '立即记录',
			'logs.title': '插件日志',
			'logs.hint': '只记插件自己的运行轨迹：谁在什么时候跑了什么、停在哪个阶段、为什么停下。按大小轮转，最多 {max}，最旧的先删。',
			'logs.empty': '还没有日志。跑一次整理或等一次定时任务，这里就会出现记录。',
			'logs.refresh': '刷新',
			'logs.files': '{files} 个文件 · {bytes}',
			'logs.levelInfo': '信息',
			'logs.levelWarn': '警告',
			'logs.levelError': '错误',
			'state.migrated': '已迁移到新目录',
			'state.exported': '已导出',
			'state.imported': '已导入',
			'state.backed': '备份完成',
			'state.working': '处理中…',
			'state.skipped': '跳过',
			'state.partial': '部分数据读取失败：{items}；可点「重试」重新加载。',
			'action.refresh': '刷新',
			'action.save': '保存',
			'action.cancel': '撤销',
			'action.close': '关闭',
			'action.unlink': '移除全局链接',
			'action.retry': '重试',
			'action.link': '建立全局链接',
			'action.takeover': '接管全局链接',
			'state.loading': '读取中…',
			'state.error': '读取失败',
			'state.saved': '已保存',
			'state.linked': '已建立全局链接',
			'overview.stats': '数据概览',
			'overview.notes': '笔记',
			'overview.tags': '标签',
			'overview.days': '天',
			'overview.notesHint': '未归档的卡片',
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
			'overview.linkGraph.label': '卡片链接关系图',
			'overview.linkGraph.empty': '还没有卡片之间的链接。',
			'overview.linkGraph.links': '条链接',
			'overview.linkGraph.count': '显示 {shown} / 共 {total} 张',
			'overview.tree.graphLabel': '标签关系图',
			'overview.tree.empty': '还没有标签。',
			'overview.descriptions': '标签描述',
			'overview.descriptions.hint': '这些说明会进每日快照的结构摘要；新分支出现后在这里补一句，当天整理后生效。',
			'overview.descriptions.placeholder': '这个分支收什么',
			'overview.descriptions.complete': '全部已描述',
			'overview.descriptions.saved': '标签描述已保存，注入已更新。',
			'overview.descriptions.missing': '{n} 个分支还没有描述',
			'overview.descriptions.warn': '留空的分支会以「只有计数、没有说明」的形式注入。',
			'overview.preview.readonly': '只读预览：Agent 每次请求都会收到这一段内容。',
			'overview.preview.empty': '这一段现在是空的。',
			'overview.bytes': '大小',
			'overview.link': '链接',
			'overview.info': '信息',
			'overview.info.snapshot': '快照 {at} 生成 · 当天固定不变：这期间写的卡要等下一次快照（每日整理或重开数据目录）才进这里。这是刻意为之——注入块每变一次，整段提示词的前缀缓存就作废一次。',
			'overview.info.snapshotLive': '没有今天的快照：这里显示的是实时排序，写一张卡它就变一次（每变一次都在作废前缀缓存）。',
			'overview.info.hint': '这些内容每次请求都会注入，分两块：纪律与主动性协议是静态的，进系统段；卡片索引随库变，进运行时上下文（每日快照）。',
			'overview.info.section': '纪律与主动性',
			'overview.info.index': '卡片索引',
			'overview.info.badge.section': '系统提示 · 静态',
			'overview.info.badge.context': '运行时上下文 · 每日快照',
			'overview.info.total': '共 {blocks} 块 · {bytes}（预算 {budget}）',
			'overview.info.collapse': '收起',
			'overview.info.expand': '展开',
			'overview.info.preferencesHint': '偏好注入（preferences/AGENTS.md）在「偏好」子页查看。',
			'overview.preferences': '偏好',
			'overview.projection': '注入的卡片索引',
			'prefs.hint': '这里是全局偏好。保存后由 DSH 的 AGENTS.md 加载器注入给每个会话。',
			'prefs.content': '全局偏好（Markdown）',
			'prefs.readFailed': '偏好文件读取失败，为避免覆盖原文件，保存已禁用；请检查文件权限后刷新。',
			'prefs.truncated': '文件超过 64 KB，这里只加载了前 64 KB；直接保存会截断，保存已禁用。',
			'prefs.notLoaded': '偏好还没读取成功，先刷新再编辑；为避免把空内容写回去，保存已禁用。',
			'prefs.global': '全局加载',
			'prefs.link.linked': '已链接',
			'prefs.link.foreign': '被其他来源占用',
			'prefs.link.missing': '未链接',
			'time.justNow': '刚刚',
			'time.minutes': '{n} 分钟前',
			'time.hours': '{n} 小时前',
			'time.days': '{n} 天前',
			'settings.hint': '数据目录决定卡片与偏好放在哪里；云端备份把整个目录打包上传。',
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
			'settings.confirmMigrate': '目标目录非空时会覆盖同名文件，确定继续迁移？',
			'settings.confirmImport': '覆盖模式会替换现有的偏好与卡片，确定继续导入？',
			'settings.transfer': '导入 / 导出',
			'settings.transfer.hint': '导出会生成一个 .tar.gz 压缩包（整份数据目录）；导入支持 .tar.gz / .tgz / .tar，默认不覆盖同名文件。勾选覆盖后，压缩包里的偏好和卡片会替换你现在的——包括写进每次会话的那部分指令，只导入自己生成的包。',
			'settings.absorb': '吸收合并',
			'settings.absorb.hint': '把另一台设备导出的压缩包并进当前知识库：只增不改，本地已有的卡保持原样。偏好、会话游标和整理台账属于设备状态，不会合并。',
			'settings.absorb.file': '来自其他设备的归档',
			'settings.absorb.placeholder': '/Users/you/Desktop/dsh-evolver-20260101-120000.tar.gz',
			'settings.absorb.rules': '同 id 已存在 → 保留本地；正文完全相同 → 视为重复跳过；其余卡片连同附件、链接与枝干说明一起吸收。',
			'settings.absorb.archives': '可吸收的归档',
			'settings.absorb.noArchives': '这个目录里没有 .tar.gz / .tgz / .tar',
			'settings.absorb.run': '开始吸收',
			'settings.absorb.confirm': '确认把这台设备的卡片并进当前知识库？本地已有的同 id 卡片不会被覆盖。',
			'settings.absorb.result': '上次吸收',
			'settings.absorb.problems': '需要注意',
			'settings.absorb.count.incoming': '归档卡片',
			'settings.absorb.count.added': '新增',
			'settings.absorb.count.duplicate': '重复跳过',
			'settings.absorb.count.existing': '同 id 保留本地',
			'settings.absorb.count.skipped': '跳过',
			'settings.absorb.count.files': '附件',
			'settings.absorb.count.branches': '枝干说明',
			'state.absorbed': '吸收完成',
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
			'settings.consolidate.hint': '每天按入库量分批复查（每批张数可设，一天最多 4 批）：用自己的话重写、找关联做双向链接、合并重复、删掉以后用不上的，并让每张卡落到对的枝干（归只用 retag，不动正文）。被删掉的内容会先写进回收站日志。',
			'settings.consolidate.cards': '每批整理张数',
			'settings.organize.modelTitle': '整理用的模型',
			'settings.organize.modelHint': '会话整理和卡片整理都在后台自己调模型；这里设给它们共用。默认跟随聊天里选的模型。',
			'settings.organize.model': '模型',
			'settings.organize.modelSession': '跟随聊天默认',
			'settings.organize.effort': '思考强度',
			'settings.organize.effortDefault': '模型默认',
			'settings.organize.modelEffective': '当前生效',
			'settings.consolidate.at': '执行时间',
			'settings.consolidate.hourUnit': '点（本机时区）',
			'settings.consolidate.run': '立即整理',
			'settings.consolidate.due': '待复查',
			'settings.consolidate.lastRun': '上次整理',
			'settings.consolidate.lastTags': '上次整理改标签 {tags} 次 · 合并枝干 {merged} 个',
			'settings.consolidate.never': '还没整理过',
			'settings.consolidate.done': '整理完成 · 复查 {batch} 张 · 改动 {applied} 处',
			'settings.consolidate.trashHint': '回收站：数据目录的 knowledge/trash.jsonl；整理记录：knowledge/consolidation.json',
			'settings.section.backup': '云端备份',
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
			'tab.resources': 'Resources',
			'resources.title': 'Resources',
			'cards.resources.empty': 'No attachments yet. Reference one from a card body with [title]({{resource}}); script attachments are marked executable and the agent can run them by absolute path.',
			'cards.resources.view': 'Cards using it',
			'cards.resources.search': 'Search resources…',
			'cards.resources.preview': 'Preview',
			'cards.resources.open': 'Open',
			'cards.resources.close': 'Close',
			'cards.resources.noPreview': 'This type cannot be previewed here; open it with the system app.',
			'cards.resources.emptySearch': 'No matching resources.',
			'cards.resources.revealed': 'Revealed in the file manager (scripts and installers are not run).',
			'cards.resources.more': '{n} more files; narrow the list with a search.',
			'cards.resources.truncated': 'Large file: the preview shows the first 200 KB only.',
			'cards.filter.resource': 'Uses resource: {name}',
			'cards.filter.resourceClear': 'Clear',
			'cards.resources.owner': 'Card',
			'cards.resources.exec': 'Exec',
			'cards.resources.refs': 'Used by',
			'cards.resources.count': '{files} files · {cards} cards',
			'cards.new': 'New card',
			'cards.search': 'Search cards…',
			'cards.filter.all': 'All',
			'cards.filter.execution': 'Practice',
			'cards.filter.input': 'Input',
			'cards.filter.improvise': 'Improvise',
			'cards.filter.review': 'Review',
			'cards.filter.awareness': 'Awareness',
			'cards.filter.experiment': 'Experiment',
			'cards.filter.archived': 'Archived',
			'cards.empty': 'No cards yet.',
			'cards.truncated': 'Showing {shown} of {total} cards; narrow it with a search or a tag.',
			'cards.tags': 'Tags',
			'cards.tagReset': 'All tags',
			'cards.editor.new': 'New card',
			'cards.editor.edit': 'Edit card',
			'cards.field.body': 'Body',
			'cards.field.tags': 'Tags (comma separated)',
			'cards.field.description': 'Description (required: one line on what this card answers, ≤{max} chars)',
			'cards.field.descriptionHint': 'e.g. why deploys use SSH and where HTTPS does not fit',
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
			'cards.source': 'Source',
			'cards.backlinks': 'Linked from',
			'cards.saved': 'Saved',
			'cards.removed': 'Removed',
			'cards.attachFailed': 'Could not read the attachment',
			'cards.attachTooLarge': 'The attachment is larger than 8 MB; compress or split it first.',
			'settings.cardDescCap': 'Card description limit',
			'settings.cardDescCapHint': '20–200 characters. The description is what the injected index shows next to an id; longer text is rejected instead of being cut.',
			'settings.cardCap': 'Card body limit',
			'settings.cardCapHint': '200–4000 characters; long content should be an attachment.',
			'sight.ingest.auto': 'Automatic on idle',
			'sight.ingest.on': 'On',
			'sight.ingest.off': 'Off',
			'sight.ingest.enable': 'Enable',
			'sight.ingest.idleUnit': 'minutes without activity',
			'sight.ingest.pending': 'Pending',
			'sight.ingest.quoted': 'Last run saved {saved}, {quoted} with a verified quote',
			'sight.ingest.processed': 'Processed',
			'sight.ingest.unavailable': 'This host does not expose session reading or model calls.',
			'sight.ingest.run': 'Run now',
			'sight.ingest.done': 'Ingest finished',
			'sight.ingest.sessionsUnit': 'sessions',
			'sight.ingest.memoriesUnit': 'memories',
			'tab.preferences': 'Preferences',
			'tab.organize': 'Organise',
			'tab.settings': 'Settings',
			'tab.logs': 'Logs',
			'logs.tab.logs': 'Plugin log',
			'logs.tab.health': 'Library health',
			'logs.health.hint': 'One line a day at 09:00: improvised backlog, outbound links, islands, prompt cache. Data only — no card is written.',
			'logs.health.lastRun': 'Last recorded {at}',
			'logs.health.never': 'Nothing recorded yet',
			'logs.health.run': 'Record now',
			'logs.title': 'Plugin log',
			'logs.hint': 'Only the plugin its own runs: who started what, which stage it reached, and why it stopped. Rotated by size, {max} at most, oldest dropped first.',
			'logs.empty': 'Nothing logged yet. Run an organiser, or wait for one, and entries will appear here.',
			'logs.refresh': 'Refresh',
			'logs.files': '{files} file(s) · {bytes}',
			'logs.levelInfo': 'info',
			'logs.levelWarn': 'warn',
			'logs.levelError': 'error',
			'state.migrated': 'Moved to the new folder',
			'state.exported': 'Exported',
			'state.imported': 'Imported',
			'state.backed': 'Backup complete',
			'state.working': 'Working…',
			'state.skipped': 'skipped',
			'state.partial': 'Some data failed to load: {items}; use Retry to load it again.',
			'action.refresh': 'Refresh',
			'action.save': 'Save',
			'action.cancel': 'Revert',
			'action.close': 'Close',
			'action.unlink': 'Remove the global link',
			'action.retry': 'Retry',
			'action.link': 'Link globally',
			'action.takeover': 'Take over the link',
			'state.loading': 'Loading…',
			'state.error': 'Failed to read',
			'state.saved': 'Saved',
			'state.linked': 'The global link is in place',
			'overview.stats': 'Overview',
			'overview.notes': 'Notes',
			'overview.tags': 'Tags',
			'overview.days': 'Days',
			'overview.notesHint': 'Unarchived cards',
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
			'overview.linkGraph.label': 'Card link graph',
			'overview.linkGraph.empty': 'No links between cards yet.',
			'overview.linkGraph.links': 'links',
			'overview.linkGraph.count': 'Showing {shown} of {total} cards',
			'overview.tree.graphLabel': 'Tag relationship graph',
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
			'overview.link': 'Link',
			'overview.info': 'Context',
			'overview.info.snapshot': 'Snapshot written {at} · fixed for the day: cards written since then reach this block at the next snapshot (the daily run, or reopening the data folder). That is deliberate — every change to an injected block invalidates the whole prompt prefix.',
			'overview.info.snapshotLive': 'No snapshot for today: this is the live ranking, so it changes with every card written (and each change invalidates the prompt prefix).',
			'overview.info.hint': 'Injected on every request as two blocks: the discipline and the proactive protocol are static and ride in the system prompt, the card index changes with the library and rides in runtime context refreshed daily.',
			'overview.info.section': 'Discipline and proactivity',
			'overview.info.index': 'Card index',
			'overview.info.badge.section': 'system prompt · static',
			'overview.info.badge.context': 'runtime context · daily',
			'overview.info.total': '{blocks} blocks · {bytes} (budget {budget})',
			'overview.info.collapse': 'Collapse',
			'overview.info.expand': 'Expand',
			'overview.info.preferencesHint': 'The preferences injection (preferences/AGENTS.md) has its own sub-tab.',
			'overview.preferences': 'Preferences',
			'overview.projection': 'Injected card index',
			'prefs.hint': 'Global preferences. DSH injects this file through its AGENTS.md loader.',
			'prefs.content': 'Global preferences (Markdown)',
			'prefs.readFailed': 'The preferences file could not be read. Saving is disabled so the original is not overwritten; check permissions and refresh.',
			'prefs.truncated': 'The file is larger than 64 KB and only the first 64 KB is loaded. Saving would truncate it, so saving is disabled.',
			'prefs.notLoaded': 'Preferences have not loaded yet. Refresh before editing; saving is disabled so empty content cannot be written back.',
			'prefs.global': 'Global load',
			'prefs.link.linked': 'linked',
			'prefs.link.foreign': 'linked elsewhere',
			'prefs.link.missing': 'not linked',
			'time.justNow': 'just now',
			'time.minutes': '{n} min ago',
			'time.hours': '{n} h ago',
			'time.days': '{n} d ago',
			'settings.hint': 'The data folder holds the cards and the preferences; a cloud backup uploads the whole folder.',
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
			'settings.confirmMigrate': 'The target folder is not empty and same-named files will be overwritten. Continue?',
			'settings.confirmImport': 'Overwrite mode replaces the existing preferences and cards. Continue?',
			'settings.transfer': 'Import / export',
			'settings.transfer.hint': 'Export writes one .tar.gz archive of the whole data folder; import accepts .tar.gz / .tgz / .tar and does not overwrite by default. With overwrite on, the archive replaces your preferences and cards — including the text injected into every session. Only import archives you made yourself.',
			'settings.absorb': 'Absorb',
			'settings.absorb.hint': 'Merge an archive exported on another device into this library. It only adds: existing cards stay as they are. Preferences, session cursors and review ledgers are device state and are never merged.',
			'settings.absorb.file': 'Archive from another device',
			'settings.absorb.placeholder': '/Users/you/Desktop/dsh-evolver-20260101-120000.tar.gz',
			'settings.absorb.rules': 'Same id → the local card wins; an identical body → duplicate, skipped; everything else is added with its attachments, links and branch descriptions.',
			'settings.absorb.archives': 'Archives to absorb',
			'settings.absorb.noArchives': 'No .tar.gz / .tgz / .tar in this folder',
			'settings.absorb.run': 'Start absorbing',
			'settings.absorb.confirm': 'Merge this device\'s cards into this library? Existing cards with the same id will not be overwritten.',
			'settings.absorb.result': 'Last absorb',
			'settings.absorb.problems': 'Needs attention',
			'settings.absorb.count.incoming': 'Cards in archive',
			'settings.absorb.count.added': 'Added',
			'settings.absorb.count.duplicate': 'Duplicates skipped',
			'settings.absorb.count.existing': 'Same id kept local',
			'settings.absorb.count.skipped': 'Skipped',
			'settings.absorb.count.files': 'Attachments',
			'settings.absorb.count.branches': 'Branch descriptions',
			'state.absorbed': 'Absorbed',
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
			'settings.consolidate.hint': 'Reviews cards in batches that follow how fast the library grows (four batches a day at most): rewrite in your own words, link related cards both ways, merge duplicates, delete what has no future use, and settle every card into the right branch with a tag-only retag. Removed content lands in a trash log first.',
			'settings.consolidate.cards': 'Cards per batch',
			'settings.organize.modelTitle': 'Model for the organisers',
			'settings.organize.modelHint': 'The session ingest and the daily card review both call a model in the background; this is the one they share. It follows the chat by default.',
			'settings.organize.model': 'Model',
			'settings.organize.modelSession': 'Follow the chat',
			'settings.organize.effort': 'Reasoning',
			'settings.organize.effortDefault': 'Model default',
			'settings.organize.modelEffective': 'In effect',
			'settings.consolidate.at': 'Runs at',
			'settings.consolidate.hourUnit': ':00 local time',
			'settings.consolidate.run': 'Consolidate now',
			'settings.consolidate.due': 'Due for review',
			'settings.consolidate.lastRun': 'Last run',
			'settings.consolidate.lastTags': 'Last run changed {tags} tag(s) and merged {merged} branch(es)',
			'settings.consolidate.never': 'never',
			'settings.consolidate.done': 'Done · reviewed {batch} · applied {applied}',
			'settings.consolidate.trashHint': 'Trash: knowledge/trash.jsonl in the data folder; review ledger: knowledge/consolidation.json',
			'settings.section.backup': 'Cloud backup',
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
			{ id: 'resources', label: 'tab.resources' },
			{ id: 'preferences', label: 'tab.preferences' },
			{ id: 'organize', label: 'tab.organize' },
			{ id: 'settings', label: 'tab.settings' },
			{ id: 'logs', label: 'tab.logs' },
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
			'.evrRow:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
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
			'.evrInfoBlock{margin-top:12px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}',
			'.evrInfoHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
			'.evrInfoHead .evrBadge{margin-left:0}',
			'.evrInfoTitle{margin:0}',
			'.evrInfoBytes{margin-left:auto;flex:none}',
			'.evrInfoToggle{flex:none;padding:1px 8px;font-size:11px}',
			'.evrInfoBody{margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2);font-weight:400;max-height:420px;overflow:auto}',
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
			'.evrMetaLabel{color:var(--dsw-alias-label-tertiary)}',
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
			'.evrOverviewPane{min-width:0}',
			'.evrOverviewGraph{flex:1 1 0;min-width:0}',
			'.evrOverviewTree{flex:1 1 0;min-width:0}',
			'.evrLinkGraph{width:100%;height:auto;max-width:460px;display:block;margin:0 auto;cursor:grab;touch-action:none}',
			'.evrLinkGraph:active{cursor:grabbing}',
			'.evrLinkLabel{fill:var(--dsw-alias-label-primary);font-size:9px;font-family:inherit;pointer-events:none;paint-order:stroke;stroke:var(--dsw-alias-bg-base);stroke-width:2.5px;stroke-linejoin:round}',
			'.evrLinkLabelQuiet{fill:var(--dsw-alias-label-secondary);font-size:8.5px}',
			'.evrLinkEdge{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:1;stroke-opacity:.5}',
			'.evrLinkEdgeMutual{stroke-opacity:.85;stroke-width:1.4}',
			'.evrLinkArrow{fill:var(--dsw-alias-label-tertiary);fill-opacity:.6}',
			'.evrLinkNode circle{stroke:var(--dsw-alias-bg-base);stroke-width:1}',
			'.evrLinkNode{cursor:grab}',
			'.evrLinkNodeDragging{cursor:grabbing}',
			'.evrLinkNodeDragging circle{stroke:var(--dsw-alias-label-primary);stroke-width:1.5}',
			'.evrLinkGraphDragging{cursor:grabbing}',
			'.evrLinkNodeOn circle{stroke:var(--dsw-alias-label-primary);stroke-width:1.5}',
			'.evrLinkEdgeWeak{stroke-dasharray:2 4;stroke-width:.75;stroke-opacity:.22}',
			// A tie that the hover explains has to be visible, or the card it
			// points at lights up for no reason the reader can see.
			'.evrLinkEdgeWeakLit{stroke-dasharray:3 3;stroke-width:1;stroke-opacity:.55}',
			'.evrLog{display:flex;flex-direction:column;gap:2px;max-height:420px;overflow:auto;border:1px solid var(--dsw-alias-border-subtle);border-radius:6px;padding:6px 8px;font-size:11.5px;line-height:1.5}',
			'.evrLogRow{display:flex;gap:8px;align-items:baseline;font-variant-numeric:tabular-nums}',
			'.evrLogTime{flex:none;color:var(--dsw-alias-label-tertiary)}',
			'.evrLogLevel{flex:none;width:28px;text-transform:uppercase;font-size:10px;letter-spacing:.04em}',
			'.evrLogInfo .evrLogLevel{color:var(--dsw-alias-label-tertiary)}',
			'.evrLogWarn .evrLogLevel{color:#b8860b}',
			'.evrLogError .evrLogLevel{color:#b0402e}',
			'.evrLogText{flex:1;min-width:0;word-break:break-word;font-family:ui-monospace,Menlo,monospace}',
			'.evrGraphWrap{position:relative}',
			'.evrGraphCap{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px;text-align:right;font-variant-numeric:tabular-nums}',
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
			'.evrHeatmapWrap{--eh-gap:2px;--eh-min:7px;overflow-x:auto;padding:2px 0}',
			'.evrHeatmapBody{display:grid;grid-template-columns:12px minmax(0,1fr);gap:6px;align-items:stretch}',
			'.evrHeatmapDays{display:grid;grid-template-rows:repeat(7,1fr);font-size:9px;color:var(--dsw-alias-label-tertiary);text-align:right}',
			'.evrHeatmapDays span{display:flex;align-items:center;justify-content:flex-end}',
			'.evrHeatmapMonths{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(var(--eh-min),1fr);gap:var(--eh-gap);margin-left:18px;margin-bottom:4px;font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
			'.evrHeatmap{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(var(--eh-min),1fr);gap:var(--eh-gap)}',
			'.evrHeatmapWeek{display:grid;grid-template-rows:repeat(7,auto);gap:var(--eh-gap)}',
			'.evrHeatCell{width:100%;aspect-ratio:1;border-radius:3px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);box-sizing:border-box}',
			'.evrHeatBlank{background:none;border-color:transparent}',
			'.evrHeat1{background:rgba(72,187,120,.28)}',
			'.evrHeat2{background:rgba(72,187,120,.55)}',
			'.evrHeat3{background:rgba(47,174,114,.85)}',
			'.evrHeat4{background:rgba(24,120,74,.95)}',
			'.evrHeat0{background:var(--dsw-alias-bg-layer-3)}',
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
			'.evrEditorPage{display:flex;flex-direction:column;height:100%;min-height:0}',
			'.evrEditorPage .evrTextarea{flex:1;min-height:180px;resize:none}',
			'.evrEditorFoot{flex:none;display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}',
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
			'.evrPreview{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32);padding:24px}',
			'.evrPreviewPanel{display:flex;flex-direction:column;width:min(980px,92vw);max-height:86vh;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);overflow:hidden}',
			'.evrPreviewHead{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12.5px}',
			'.evrPreviewBody{flex:1;min-height:0;overflow:auto;padding:14px}',
			'.evrPreviewBody img{max-width:100%;height:auto;display:block;margin:0 auto}',
			'.evrPreviewBody iframe{width:100%;height:70vh;border:0;background:var(--dsw-alias-bg-base)}',
			'.evrToast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:30;display:flex;align-items:center;gap:10px;max-width:min(620px,84%);padding:9px 11px 9px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-soft);font-size:12.5px;line-height:1.5}',
			'.evrToastOk{color:var(--dsw-alias-state-success-primary)}',
			'.evrToastError{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
			'.evrToastText{white-space:pre-wrap;word-break:break-word}',
			'.evrToastClose{flex:none;border:0;background:transparent;color:inherit;cursor:pointer;font-size:16px;line-height:1;padding:0 2px}',
		].join('\n');

		//#endregion

		//#region helpers

		/**
		 * The message of a rejected request, for the status line.
		 *
		 * @param {unknown} reason - The rejection reason.
		 * @returns {string} A human-readable message.
		 */
		function messageOf(reason) {
			if (reason instanceof Error) return reason.message;
			return String(reason);
		}

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
				// A failing Host can answer with a non-JSON page (proxy error,
				// HTML 500). Parse defensively so the panel reports the status
				// instead of a JSON syntax error.
				return Promise.resolve().then(function () {
					return response.json();
				}).catch(function () {
					if (response.ok !== true) throw new Error('HTTP ' + response.status);
					throw new Error('响应不是 JSON（HTTP ' + response.status + '）');
				}).then(function (value) {
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
			// 一天以内读相对时间；再老就落到绝对时间，日期单独一个看不出时刻。
			if (Date.now() - stamp < 24 * 60 * 60 * 1000) return relativeTime(iso, t);
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
				var reach = 9 + labelExtent(node.name);
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

			// The drawing is memoised: a pan or a wheel only moves the outer
			// <g> transform, and rebuilding every edge and node on each
			// pointermove is what made a big tree stutter while dragging.
			var edgeEls = useMemo(function () {
				if (layout === null) return [];
				return layout.edges.map(function (edge, index) {
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
			}, [layout]);

			var nodeEls = useMemo(function () {
				if (layout === null) return [];
				return layout.nodes.map(function (node) {
					var degrees = (node.angle * 180) / Math.PI;
					var flipped = Math.cos(node.angle) < 0;
					var labelX = flipped ? node.x - 9 : node.x + 9;
					var isRoot = node.depth === 0;
					var active = tip === null || node.path === tip.path
						|| (tip !== null && node.path.indexOf(tip.path + '/') === 0);
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
						}, node.name),
						h('title', null, node.path + ' · ' + node.count));
				});
			}, [layout, tip, t]);

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
				setTip({ path: node.path, x: node.x, y: node.y });
				frameOn(node, node.depth === 0 ? false : (node.children ?? []).length === 0);
			}

			var tipNode = null;
			if (tip !== null) {
				layout.nodes.forEach(function (node) { if (node.path === tip.path) tipNode = node; });
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
				}, tip.path));
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
		 * whole year of weeks fills the row whatever the pane is wide. The
		 * cells stay square, so the strip also gets taller on a wide window;
		 * a fixed cell size is what used to leave the right half of the row
		 * empty. Below the minimum column width the strip scrolls sideways.
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
			// The busiest day in the window sets the scale. Fixed steps ("three or
			// more is the darkest") turn every day dark as soon as the library is
			// busy — three cards a day is ordinary here — and a uniformly green map
			// tells nothing. Relative to the peak, a quiet day stays pale and only
			// the real spikes go dark. Exact numbers are in each cell's tooltip.
			var peak = 0;
			activity.forEach(function (item) {
				var value = Number(item.count);
				if (Number.isFinite(value) && value > peak) peak = value;
			});
			function level(count) {
				var value = Number(count);
				if (!Number.isFinite(value) || value <= 0) return 0;
				// Three cards ever is not a distribution: fall back to one step per
				// card so the first days still read as light / medium / heavy.
				if (peak <= 3) return Math.min(4, value);
				return Math.min(4, Math.max(1, Math.ceil((value / peak) * 4)));
			}
			return h('div', { className: 'evrHeatmapWrap' },
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
					h('span', { className: 'evrHeatCell evrHeat4' }),
					h('span', null, t('overview.heatmap.more'))));
		}

		/**
		 * Whether a link target is safe to follow.
		 *
		 * @param {string} url - The link target.
		 * @returns {boolean} True for web, mail and in-document links.
		 */
		function safeUrl(url) {
			var text = String(url ?? '');
			// 协议相对 URL（//host）和 /\\host 都会被浏览器当成站外地址：预览里
			// 的链接必须带明确协议、站内绝对路径、锚点或 ./ 相对路径。
			if (/^\/\/|^\/\\/.test(text)) return false;
			return /^(https?:|mailto:|#|\/|\.\/)/i.test(text);
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
							rel: 'noopener noreferrer',
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
		 * The top-level branch of one tag path.
		 *
		 * @param {string | undefined} tag - The first tag of a card.
		 * @returns {string} The branch, or '' when untagged.
		 */
		function branchOfTag(tag) {
			return typeof tag === 'string' ? tag.split('/')[0] : '';
		}

		/**
		 * The colour of one card, by its top-level branch.
		 *
		 * @param {object} card - A graph node or a card view.
		 * @returns {string} The colour.
		 */
		function linkColorOf(card) {
			var branch = typeof card.branch === 'string' ? card.branch : branchOfTag((card.tags ?? [])[0]);
			return LINK_BRANCH_COLORS[branch] ?? '#8a8f98';
		}

		/**
		 * Simulations already built, keyed by the graph payload they came from.
		 *
		 * The panel replaces that payload only when the graph is reloaded, so a
		 * cache hit means "same simulation". It outlives the component: leaving
		 * the sub-tab unmounts the graph, and coming back to a settled picture
		 * must not restart the animation.
		 *
		 * @type {WeakMap<object, object | null>}
		 */
		var linkSimulationCache = new WeakMap();

		/**
		 * Estimate the rendered width of a label in graph units.
		 *
		 * CJK glyphs are square at this font size and Latin ones roughly half as
		 * wide; the estimate only has to be close enough to keep boxes apart.
		 *
		 * @param {string} text - The label text.
		 * @returns {number} The estimated width.
		 */
		function linkLabelWidth(text) {
			var width = 0;
			for (var i = 0; i < text.length; i += 1) {
				width += text.charCodeAt(i) >= 0x2e80 ? 9 : 5;
			}
			return width;
		}

		/**
		 * Place labels for cards, clear of each other and of the nodes.
		 *
		 * Each card tries eight sides at a growing distance before giving up: in a
		 * dense cluster a fixed four-position ring almost always sits on top of
		 * another dot, and a name that covers a dot is worse than no name. A label
		 * that cannot be placed is simply not drawn, so the picture stays readable
		 * and the placement stays deterministic.
		 *
		 * @param {object[]} ordered - Nodes, highest priority first.
		 * @param {object[]} nodes - Every drawn node, for the circle collision test.
		 * @param {number} width - ViewBox width.
		 * @param {number} height - ViewBox height.
		 * @param {number} limit - Maximum number of labels to place.
		 * @param {object[]} boxes - Already placed label boxes; extended in place.
		 * @returns {object} Map of node id to {x, y, anchor, text}.
		 */
		function placeLinkLabels(ordered, nodes, width, height, limit, boxes) {
			var placed = {};
			var count = 0;
			// Near positions first; a name pulled a little further out still names
			// its dot, and stepping away is the only way out of a crowded cluster.
			var distances = [4, 8, 12, 16, 22, 28];
			/**
			 * Whether a label box fits without leaving the frame, touching another
			 * label or covering a node circle.
			 *
			 * @param {number} left - Box left edge.
			 * @param {number} top - Box top edge.
			 * @param {number} boxWidth - Box width.
			 * @returns {boolean} True when the position is free.
			 */
			function free(left, top, boxWidth) {
				var right = left + boxWidth;
				var bottom = top + 11;
				if (left < 1 || top < 1 || right > width - 1 || bottom > height - 1) return false;
				for (var i = 0; i < boxes.length; i += 1) {
					var box = boxes[i];
					var apartX = right + 1 <= box.left || box.left + box.width + 1 <= left;
					var apartY = bottom + 1 <= box.top || box.top + box.height + 1 <= top;
					if (!apartX && !apartY) return false;
				}
				for (var j = 0; j < nodes.length; j += 1) {
					var node = nodes[j];
					var nearestX = Math.min(right, Math.max(left, node.x));
					var nearestY = Math.min(bottom, Math.max(top, node.y));
					var dx = node.x - nearestX;
					var dy = node.y - nearestY;
					// One pixel of the dot's own rim is fair game: the label carries a
					// 2.5px background halo, so touching the edge still reads as "beside
					// the dot", while demanding a full pixel of air left most names in a
					// crowded cluster unplaceable — which is what made hovering a card
					// look broken. The dot itself is never covered.
					var margin = node.r - 1;
					if (dx * dx + dy * dy < margin * margin) return false;
				}
				return true;
			}
			for (var index = 0; index < ordered.length && count < limit; index += 1) {
				var node = ordered[index];
				// The name is the card's description; a dozen characters is what
				// fits between the dots, and the title carries the full text.
				var label = node.text.length > 12 ? node.text.slice(0, 12) + '…' : node.text;
				if (label === '') continue;
				var boxWidth = linkLabelWidth(label) + 4;
				var spot = null;
				for (var d = 0; d < distances.length && spot === null; d += 1) {
					var distance = distances[d];
					var side = node.r * 0.6 + distance * 0.8;
					var candidates = [
						{ left: node.x + node.r + distance, top: node.y - 5.5, anchor: 'start' },
						{ left: node.x - node.r - distance - boxWidth, top: node.y - 5.5, anchor: 'end' },
						{ left: node.x - boxWidth / 2, top: node.y - node.r - distance - 11, anchor: 'middle' },
						{ left: node.x - boxWidth / 2, top: node.y + node.r + distance, anchor: 'middle' },
						{ left: node.x + side - boxWidth / 2, top: node.y - side - 11, anchor: 'middle' },
						{ left: node.x - side - boxWidth / 2, top: node.y - side - 11, anchor: 'middle' },
						{ left: node.x + side - boxWidth / 2, top: node.y + side, anchor: 'middle' },
						{ left: node.x - side - boxWidth / 2, top: node.y + side, anchor: 'middle' },
					];
					for (var c = 0; c < candidates.length; c += 1) {
						var candidate = candidates[c];
						if (!free(candidate.left, candidate.top, boxWidth)) continue;
						spot = candidate;
						break;
					}
				}
				if (spot === null) continue;
				boxes.push({ left: spot.left, top: spot.top, width: boxWidth, height: 11 });
				placed[node.id] = {
					x: spot.anchor === 'start' ? spot.left : (spot.anchor === 'end' ? spot.left + boxWidth : node.x),
					y: spot.top + 8,
					anchor: spot.anchor,
					text: label,
				};
				count += 1;
			}
			return placed;
		}

		/**
		 * Build the live force simulation behind the card graph.
		 *
		 * The same four forces as the headless layout, but driven by a clock
		 * instead of a fixed step count: the panel ticks it two or three times per
		 * painted frame and re-renders from `snapshot()`, so the picture cools
		 * down in front of the reader instead of appearing finished.
		 *
		 * Cost model, because this runs on the render thread:
		 * - One tick is O(n²) in the near-range repulsion (pairs past 60 units are
		 *   skipped), O(E) in the springs and O(n²) in one collision pass. For the
		 *   real 105-card library that is ~5.5k pair checks per tick; for the
		 *   panel's 300-node ceiling it is ~45k.
		 * - The panel paints at ~30fps with two ticks per painted frame, so the
		 *   simulation settles in about four seconds. The measured tick cost is
		 *   in the same order as one React diff of the graph (see the tool's
		 *   `layoutMs`), which is why the simulation is not run at 60fps.
		 * - `snapshot()` allocates one projected node/edge array per painted
		 *   frame, not per tick; labels are only re-laid-out when the simulation
		 *   is at rest (see LinkGraph), so a moving picture stays cheap.
		 *
		 * Deterministic: no clock and no random numbers — the alpha decay is the
		 * only "time", and it is a pure function of the step count.
		 *
		 * Called with one argument it keeps the old contract: `cards` is a raw
		 * card list, links are derived from `card.links`, and cards without any
		 * link are left out. Called with `edges` it includes every node given.
		 *
		 * @param {object[]} cards - Graph nodes, or raw cards in the one-argument form.
		 * @param {object[]} [edges] - Graph edges, `{source, target, kind, mutual}`.
		 * @returns {object | null} The simulation, or null when nothing is drawn.
		 */
		function createLinkSimulation(cards, edges) {
			var list = Array.isArray(cards) ? cards : [];
			var explicit = Array.isArray(edges);
			var byId = {};
			var seenId = {};
			var unique = [];
			list.forEach(function (card) {
				if (card === null || card === undefined || typeof card.id !== 'string') return;
				if (seenId[card.id] === true) return;
				seenId[card.id] = true;
				byId[card.id] = card;
				unique.push(card);
			});

			// One undirected pair per unordered pair: the host already dedupes,
			// but the browser must not draw a doubled line if it ever does not.
			var pairs = [];
			var seenPair = {};
			/**
			 * Record one edge when both ends are in the picture.
			 *
			 * @param {string} source - One end.
			 * @param {string} target - The other end.
			 * @param {string} [kind] - 'link', 'tag' or 'branch'.
			 * @param {boolean} [mutual] - Both cards link to each other.
			 * @returns {void}
			 */
			function addPair(source, target, kind, mutual) {
				if (typeof source !== 'string' || typeof target !== 'string') return;
				if (source === target) return;
				if (byId[source] === undefined || byId[target] === undefined) return;
				var key = source < target ? source + '\u0000' + target : target + '\u0000' + source;
				if (seenPair[key] === true) return;
				seenPair[key] = true;
				pairs.push({
					source: source,
					target: target,
					kind: kind === 'tag' || kind === 'branch' ? kind : 'link',
					mutual: mutual === true,
				});
			}
			if (explicit) {
				edges.forEach(function (edge) {
					if (edge === null || edge === undefined) return;
					addPair(edge.source, edge.target, edge.kind, edge.mutual);
				});
			} else {
				list.forEach(function (card) {
					if (card === null || card === undefined || typeof card.id !== 'string') return;
					(card.links ?? []).forEach(function (target) {
						if (byId[target] === undefined) return;
						var mutual = Array.isArray(byId[target].links) && byId[target].links.indexOf(card.id) > -1;
						addPair(card.id, target, 'link', mutual);
					});
				});
			}

			var involved = {};
			pairs.forEach(function (edge) {
				involved[edge.source] = true;
				involved[edge.target] = true;
			});
			var active = explicit
				? unique
				// Old one-argument form: only cards that carry or receive a link.
				: unique.filter(function (card) { return involved[card.id] === true; });
			if (active.length === 0) return null;

			var width = 360;
			var height = 340;
			var cx = width / 2;
			var cy = height / 2;

			// Degree centrality: the graph payload ranks nodes by explicit links;
			// a raw card list falls back to the edge count. Normalise against the
			// busiest card but never against a two-card graph, where a single link
			// would make both ends look like hubs.
			var edgeDegree = {};
			pairs.forEach(function (edge) {
				edgeDegree[edge.source] = (edgeDegree[edge.source] ?? 0) + 1;
				edgeDegree[edge.target] = (edgeDegree[edge.target] ?? 0) + 1;
			});
			var degree = {};
			active.forEach(function (card) {
				degree[card.id] = typeof card.degree === 'number' && Number.isFinite(card.degree)
					? card.degree
					: (edgeDegree[card.id] ?? 0);
			});
			var top = 2;
			active.forEach(function (card) { top = Math.max(top, degree[card.id] ?? 0); });
			var weightOf = function (id) { return (degree[id] ?? 0) / top; };
			var radiusOf = function (id) { return 2.4 + 6.2 * Math.pow(weightOf(id), 0.75); };
			var massOf = function (id) { return 0.6 + 0.9 * weightOf(id); };

			// The community of a card is its branch. Inlined instead of calling a
			// helper: this function is extracted verbatim by the layout tool and
			// may only depend on its own scope plus linkColorOf.
			var branchOf = function (card) {
				if (typeof card.branch === 'string') return card.branch;
				var root = (card.tags ?? [])[0];
				return typeof root === 'string' ? root.split('/')[0] : '';
			};
			var groups = {};
			active.forEach(function (card) {
				var branch = branchOf(card);
				(groups[branch] ?? (groups[branch] = [])).push(card);
			});
			// Fixed branch order first, so the same library always draws the same
			// region positions; unexpected branches (including '') trail behind.
			var branchOrder = ['践行', '见闻', '即兴', '复盘', '觉察', '试错'];
			var present = [];
			branchOrder.forEach(function (branch) {
				if (groups[branch] !== undefined) present.push(branch);
			});
			Object.keys(groups).forEach(function (branch) {
				if (branchOrder.indexOf(branch) === -1) present.push(branch);
			});

			var anchorRadius = 100;
			var anchors = {};
			present.forEach(function (branch, index) {
				var angle = -Math.PI / 2 + (index * 2 * Math.PI) / present.length;
				anchors[branch] = { x: cx + Math.cos(angle) * anchorRadius, y: cy + Math.sin(angle) * anchorRadius };
			});

			// Deterministic per-card jitter. The FNV-1a hash of the id only picks
			// the start angle; two runs on the same library start identically.
			/**
			 * Map an id to a stable number in [0, 1).
			 *
			 * @param {string} id - The card id.
			 * @returns {number} The pseudo-random, deterministic value.
			 */
			function variation(id) {
				var hash = 2166136261;
				for (var i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
				return (hash >>> 0) / 4294967296;
			}
			/**
			 * The deterministic seed offset of one card inside its cluster.
			 *
			 * @param {number} index - Rank inside the cluster.
			 * @param {number} count - Cluster size.
			 * @param {string} id - The card id.
			 * @returns {{x: number, y: number}} Offset in cloud units.
			 */
			function cloudOffset(index, count, id) {
				var angle = index * Math.PI * (3 - Math.sqrt(5)) + (variation(id) - 0.5) * 0.65;
				var contour = 1 + 0.12 * Math.sin(angle * 3 + 0.7) + 0.07 * Math.cos(angle * 5);
				var radius = Math.pow((index + 0.5) / count, 0.66) * contour;
				return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
			}

			// Seed each cluster as a cloud around its anchor. Big branches get a
			// wider cloud; every cluster keeps roughly the same visual density.
			var nodes = [];
			present.forEach(function (branch) {
				var members = groups[branch] ?? [];
				members.sort(function (left, right) {
					return (degree[right.id] ?? 0) - (degree[left.id] ?? 0) || (left.id < right.id ? -1 : 1);
				});
				var spread = 24 + 26 * Math.sqrt(members.length / active.length);
				var anchor = anchors[branch];
				members.forEach(function (card, index) {
					var offset = cloudOffset(index, members.length, card.id);
					nodes.push({
						id: card.id,
						text: typeof card.description === 'string' ? card.description : '',
						branch: branch,
						color: linkColorOf(card),
						degree: degree[card.id] ?? 0,
						weight: weightOf(card.id),
						x: anchor.x + offset.x * spread,
						y: anchor.y + offset.y * spread,
						vx: 0,
						vy: 0,
						r: radiusOf(card.id),
						mass: massOf(card.id),
						anchor: anchor,
						// While a node is dragged the pointer owns fx/fy; the
						// integration step leaves it there and the springs move
						// the neighbours instead.
						fx: null,
						fy: null,
					});
				});
			});
			// The seed cloud may reach past the frame for a big branch; clamp it
			// once so the very first painted frame is already complete.
			nodes.forEach(function (node) {
				node.x = Math.min(width - node.r - 2, Math.max(node.r + 2, node.x));
				node.y = Math.min(height - node.r - 2, Math.max(node.r + 2, node.y));
			});
			var index = {};
			nodes.forEach(function (node) { index[node.id] = node; });

			// A stated link is short and stiff; an inferred tie is long and soft.
			// The rest length shrinks with the average degree weight, so a hub's
			// neighbours hug it while loose chains end up on the rim of a cluster.
			var springs = pairs.map(function (edge) {
				var average = (weightOf(edge.source) + weightOf(edge.target)) / 2;
				var weak = edge.kind !== 'link';
				return {
					source: index[edge.source],
					target: index[edge.target],
					rest: weak ? 14 + 26 * (1 - average) : 14 + 34 * (1 - average),
					stiffness: weak ? 0.02 : 0.05,
				};
			});

			var neighbours = pairs.reduce(function (map, edge) {
				(map[edge.source] ?? (map[edge.source] = [])).push(edge.target);
				(map[edge.target] ?? (map[edge.target] = [])).push(edge.source);
				return map;
			}, {});

			/**
			 * Whether the pointer currently owns this node's position.
			 *
			 * @param {object} node - A simulation node.
			 * @returns {boolean} True while it is being dragged.
			 */
			function isFixed(node) {
				return typeof node.fx === 'number' && Number.isFinite(node.fx)
					&& typeof node.fy === 'number' && Number.isFinite(node.fy);
			}

			// Overlaps are resolved geometrically on top of the soft repulsion. One
			// pass per tick is enough while the simulation is hot; the headless
			// layout adds the extra passes at the end.
			/**
			 * Push overlapping dots apart, leaving a gap.
			 *
			 * @param {number} gap - Extra space between two circles.
			 * @returns {void}
			 */
			function collide(gap) {
				for (var i = 0; i < nodes.length; i += 1) {
					for (var j = i + 1; j < nodes.length; j += 1) {
						var a = nodes[i];
						var b = nodes[j];
						var need = a.r + b.r + gap;
						var dx = b.x - a.x;
						var dy = b.y - a.y;
						var distance = Math.sqrt(dx * dx + dy * dy);
						if (distance >= need) continue;
						// Coincident nodes have no direction to part along; this
						// nudge is deterministic, not a random jitter.
						if (distance < 0.01) {
							dx = 0.01;
							dy = 0;
							distance = 0.01;
						}
						var shift = (need - distance) / 2;
						var ux = dx / distance;
						var uy = dy / distance;
						var aFixed = isFixed(a);
						var bFixed = isFixed(b);
						if (aFixed && bFixed) continue;
						// A pinned circle stays put; the free end takes the whole gap.
						if (aFixed) {
							b.x += ux * shift * 2;
							b.y += uy * shift * 2;
						} else if (bFixed) {
							a.x -= ux * shift * 2;
							a.y -= uy * shift * 2;
						} else {
							a.x -= ux * shift;
							a.y -= uy * shift;
							b.x += ux * shift;
							b.y += uy * shift;
						}
					}
				}
			}

			var self = {
				width: width,
				height: height,
				nodes: nodes,
				pairs: pairs,
				neighbours: neighbours,
				alpha: 1,
				step: step,
				reheat: reheat,
				snapshot: snapshot,
			};

			/**
			 * Advance the simulation one tick.
			 *
			 * @param {number} [alpha] - Force strength to use instead of the
			 *   simulation's own; the headless layout drives a fixed cooling curve
			 *   this way.
			 * @returns {number} The alpha used for this tick.
			 */
			function step(alpha) {
				var heat = typeof alpha === 'number' ? alpha : self.alpha;
				for (var i = 0; i < nodes.length; i += 1) {
					for (var j = i + 1; j < nodes.length; j += 1) {
						var a = nodes[i];
						var b = nodes[j];
						var dx = b.x - a.x;
						var dy = b.y - a.y;
						var d2 = dx * dx + dy * dy;
						// Past this range a pair is too far apart to matter; letting
						// distant clusters keep pushing each other is what merges
						// them into one cloud.
						if (d2 > 3600) continue;
						var distance = Math.max(1, Math.sqrt(d2));
						var push = (heat * 900 * a.mass * b.mass) / (d2 + 49);
						a.vx -= (dx / distance) * push;
						a.vy -= (dy / distance) * push;
						b.vx += (dx / distance) * push;
						b.vy += (dy / distance) * push;
					}
				}
				springs.forEach(function (spring) {
					var source = spring.source;
					var target = spring.target;
					var dx = target.x - source.x;
					var dy = target.y - source.y;
					var distance = Math.max(0.5, Math.sqrt(dx * dx + dy * dy));
					var pull = (distance - spring.rest) * spring.stiffness * heat;
					source.vx += (dx / distance) * pull;
					source.vy += (dy / distance) * pull;
					target.vx -= (dx / distance) * pull;
					target.vy -= (dy / distance) * pull;
				});
				for (var k = 0; k < nodes.length; k += 1) {
					var node = nodes[k];
					if (isFixed(node)) {
						node.x = node.fx;
						node.y = node.fy;
						node.vx = 0;
						node.vy = 0;
						continue;
					}
					// The branch anchor is what makes the picture six regions. A
					// hub is pulled less, so it can sit between branches as the
					// bridge between communities.
					var strength = 0.040 * (1 - 0.75 * node.weight) * heat;
					node.vx += (node.anchor.x - node.x) * strength;
					node.vy += (node.anchor.y - node.y) * strength;
					node.x += node.vx * 0.45;
					node.y += node.vy * 0.45;
					node.vx *= 0.82;
					node.vy *= 0.82;
				}
				collide(4);
				// The live canvas has no final fit pass, so a card that drifts out
				// of the frame is a lost card: keep every free dot inside, radius
				// included, after both the forces and the collision pass.
				for (var m = 0; m < nodes.length; m += 1) {
					var kept = nodes[m];
					if (isFixed(kept)) continue;
					kept.x = Math.min(width - kept.r - 2, Math.max(kept.r + 2, kept.x));
					kept.y = Math.min(height - kept.r - 2, Math.max(kept.r + 2, kept.y));
				}
				if (typeof alpha === 'number') return heat;
				// d3's cooling curve: alpha eases towards zero (and a drag can
				// pump it back up), so a settled picture costs no more ticks.
				self.alpha += (0 - self.alpha) * 0.0228;
				return self.alpha;
			}

			/**
			 * Pump heat back into a settled simulation (a drag does this).
			 *
			 * @param {number} value - Minimum alpha after the call.
			 * @returns {number} The new alpha.
			 */
			function reheat(value) {
				self.alpha = Math.max(self.alpha, value);
				return self.alpha;
			}

			/**
			 * Project the current state into what the component draws.
			 *
			 * @returns {object} `{nodes, edges, neighbours}` with edge paths already
			 *   resolved for this frame.
			 */
			function snapshot() {
				var projected = nodes.map(function (node) {
					return {
						id: node.id,
						text: node.text,
						color: node.color,
						x: node.x,
						y: node.y,
						r: node.r,
						degree: node.degree,
						branch: node.branch,
					};
				});
				// The cards that already have a stated relation. An inferred tie
				// is only worth ink where it is the only evidence: around a card
				// that already has links it doubles the lines and says nothing
				// the link did not already say.
				var linked = {};
				pairs.forEach(function (edge) {
					if (edge.kind !== 'link') return;
					linked[edge.source] = true;
					linked[edge.target] = true;
				});
				var edgePaths = pairs.map(function (edge) {
					var source = index[edge.source];
					var target = index[edge.target];
					var weak = edge.kind !== 'link';
					var dx = target.x - source.x;
					var dy = target.y - source.y;
					var length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
					var ux = dx / length;
					var uy = dy / length;
					// A relation is a straight line. A curve has to earn its extra
					// ink: it says "this way around", and a plain tie says nothing
					// of the sort — the graph draws direction with an arrowhead on
					// hover instead. Straight also matches how the reference
					// implementation draws its network view, and a straight line is
					// the shortest path between two dots the reader already knows
					// are related.
					// Both ends stop at the circle edge so a line never runs under a
					// dot; a stated link stops a little further out to leave room
					// for its arrowhead.
					var startX = source.x + ux * (source.r + 1);
					var startY = source.y + uy * (source.r + 1);
					var trim = target.r + (weak ? 1 : 4);
					var endX = target.x - ux * trim;
					var endY = target.y - uy * trim;
					return {
						source: edge.source,
						target: edge.target,
						kind: edge.kind,
						mutual: edge.mutual === true,
						tied: weak && linked[edge.source] === true && linked[edge.target] === true,
						d: 'M ' + startX.toFixed(1) + ' ' + startY.toFixed(1)
							+ ' L ' + endX.toFixed(1) + ' ' + endY.toFixed(1),
					};
				});
				return {
					nodes: projected,
					edges: edgePaths,
					neighbours: neighbours,
				};
			}

			return self;
		}

		/**
		 * Settle the graph once, headless.
		 *
		 * The layout tool and the static render path need one deterministic
		 * picture, not an animation: build the same simulation, run a fixed
		 * 340-step cooling curve (0.99^step), then fit what came out into the
		 * viewBox — radii included — and hand back the same shape a live
		 * snapshot has.
		 *
		 * @param {object[]} cards - Graph nodes, or raw cards in the one-argument form.
		 * @param {object[]} [edges] - Graph edges, `{source, target, kind, mutual}`.
		 * @returns {object | null} The laid-out graph, or null when nothing is drawn.
		 */
		function computeLinkLayout(cards, edges) {
			var sim = createLinkSimulation(cards, edges);
			if (sim === null) return null;
			for (var step = 0; step < 340; step += 1) sim.step(Math.pow(0.99, step));
			var nodes = sim.nodes;
			// Fit the viewBox, radii included, so the picture stays proportional.
			// The cap keeps a two-card graph from being blown up to poster size.
			var minX = Infinity;
			var minY = Infinity;
			var maxX = -Infinity;
			var maxY = -Infinity;
			nodes.forEach(function (node) {
				minX = Math.min(minX, node.x - node.r);
				minY = Math.min(minY, node.y - node.r);
				maxX = Math.max(maxX, node.x + node.r);
				maxY = Math.max(maxY, node.y + node.r);
			});
			var spanX = Math.max(1, maxX - minX);
			var spanY = Math.max(1, maxY - minY);
			var fit = Math.min(1.5, (sim.width - 20) / spanX, (sim.height - 20) / spanY);
			var offsetX = (sim.width - spanX * fit) / 2;
			var offsetY = (sim.height - spanY * fit) / 2;
			nodes.forEach(function (node) {
				node.x = offsetX + (node.x - minX) * fit;
				node.y = offsetY + (node.y - minY) * fit;
				node.r = Math.max(1.3, node.r * fit);
			});
			// The radius floor eats the spacing the simulation settled on; the last
			// separation passes in fitted coordinates put the gaps back.
			var separate = function (passes, gap) {
				for (var pass = 0; pass < passes; pass += 1) {
					for (var i = 0; i < nodes.length; i += 1) {
						for (var j = i + 1; j < nodes.length; j += 1) {
							var a = nodes[i];
							var b = nodes[j];
							var need = a.r + b.r + gap;
							var dx = b.x - a.x;
							var dy = b.y - a.y;
							var distance = Math.sqrt(dx * dx + dy * dy);
							if (distance >= need) continue;
							if (distance < 0.01) {
								dx = 0.01;
								dy = 0;
								distance = 0.01;
							}
							var shift = (need - distance) / 2;
							var ux = dx / distance;
							var uy = dy / distance;
							a.x -= ux * shift;
							a.y -= uy * shift;
							b.x += ux * shift;
							b.y += uy * shift;
						}
					}
				}
			};
			separate(2, Math.max(0.5, 4 * fit));
			var snapshot = sim.snapshot();
			return {
				width: sim.width,
				height: sim.height,
				nodes: snapshot.nodes,
				edges: snapshot.edges,
				neighbours: snapshot.neighbours,
			};
		}

		/**
		 * A graph of the cards and the links between them.
		 *
		 * Layered the way Obsidian draws its graph: faint edges, a dot per card
		 * sized by how many links it has, colour by branch, labels on the
		 * busiest cards, and hovering or clicking a card names it and its
		 * neighbours and fades everything else. Explicit links are solid and
		 * drawn as distance-scaled arcs; the direction arrow only appears on the
		 * hovered card's own links; the tag ties the host derives are dashed,
		 * very faint, and only drawn where no stated link already speaks for
		 * both ends. No branch names: a region is told by its colour, and a name
		 * over a cluster competes with the card labels for the same space.
		 *
		 * The picture is alive: the simulation runs from its seed so the six
		 * communities visibly form, a node can be dragged (the simulation
		 * reheats and its neighbours follow), and the canvas pans and zooms
		 * around it. There is no toolbar.
		 *
		 * @param {object} props - Component props: `t` and the graph payload.
		 * @returns {object} The element tree.
		 */
		function LinkGraph(props) {
			var t = props.t;
			var graph = props.graph;
			// The host caps the picture at `limit`; the part that fell off is
			// invisible unless the panel says how many cards are missing.
			var totals = graph !== null && graph !== undefined && typeof graph === 'object' ? graph.totals : null;
			var hiddenCards = totals !== null && totals !== undefined ? Number(totals.hiddenCards) || 0 : 0;
			var shownCards = graph !== null && graph !== undefined && Array.isArray(graph.nodes) ? graph.nodes.length : 0;
			var totalCards = totals !== null && totals !== undefined && Number.isFinite(Number(totals.cards))
				? Number(totals.cards)
				: shownCards;
			var sim = useMemo(function () {
				if (graph === null || graph === undefined || typeof graph !== 'object') return null;
				if (linkSimulationCache.has(graph)) return linkSimulationCache.get(graph);
				var created = createLinkSimulation(graph.nodes, graph.edges);
				// A host without requestAnimationFrame (the test shell) gets the
				// settled picture synchronously: the same simulation and cooling
				// curve, just stepped to rest before the first paint, so the
				// rendered coordinates stay deterministic and assertable.
				if (created !== null && typeof requestAnimationFrame !== 'function') {
					for (var step = 0; step < 340; step += 1) created.step(Math.pow(0.99, step));
					created.alpha = 0;
				}
				linkSimulationCache.set(graph, created);
				return created;
			}, [graph]);
			var [camera, setCamera] = useState(null);
			var [hovered, setHovered] = useState(null);
			var [pinned, setPinned] = useState(null);
			var [tick, setTick] = useState(0);
			var [dragging, setDragging] = useState(null);
			var svgRef = useRef(null);
			var dragRef = useRef(null);
			var movedRef = useRef(false);
			var animRef = useRef({ handle: null, last: 0, alive: false, wake: null });
			var view = camera === null ? { s: 1, x: 0, y: 0 } : camera;
			var focus = hovered ?? pinned;

			// One projection per painted frame. The simulation is the source of
			// truth; React only ever sees this snapshot, so a drag or a tick is
			// just "take another snapshot and diff it".
			var snapshot = useMemo(function () {
				return sim === null ? null : sim.snapshot();
			}, [sim, tick]);

			useEffect(function () {
				setCamera(null);
				setHovered(null);
				setPinned(null);
				setDragging(null);
			}, [sim]);

			// The animation loop: ~30 painted frames per second, two physics ticks
			// per painted frame. Half the repaints of a 60fps loop for the same
			// settle time; the simulation stops on its own once alpha < 0.005, and
			// a drag calls wake() to start it again.
			useEffect(function () {
				if (sim === null || typeof requestAnimationFrame !== 'function') return undefined;
				var state = animRef.current;
				state.alive = true;
				state.last = 0;
				/**
				 * Advance the simulation and repaint.
				 *
				 * @param {number} now - Timestamp handed over by requestAnimationFrame.
				 * @returns {void}
				 */
				function frame(now) {
					state.handle = null;
					if (!state.alive) return;
					if (now - state.last < 32) {
						state.handle = requestAnimationFrame(frame);
						return;
					}
					state.last = now;
					sim.step();
					sim.step();
					setTick(function (value) { return value + 1; });
					if (sim.alpha >= 0.005) state.handle = requestAnimationFrame(frame);
				}
				/**
				 * Restart the loop after a reheat woke a settled simulation.
				 *
				 * @returns {void}
				 */
				state.wake = function () {
					if (!state.alive || state.handle !== null) return;
					state.last = 0;
					state.handle = requestAnimationFrame(frame);
				};
				if (sim.alpha >= 0.005) state.handle = requestAnimationFrame(frame);
				return function () {
					state.alive = false;
					state.wake = null;
					if (state.handle !== null) cancelAnimationFrame(state.handle);
					state.handle = null;
				};
			}, [sim]);

			useEffect(function () {
				if (sim === null) return undefined;
				var node = svgRef.current;
				if (node === null || node === undefined || typeof node.addEventListener !== 'function') return undefined;
				/**
				 * Zoom around the pointer, so the picture grows where the eye is.
				 *
				 * @param {object} event - The wheel event.
				 * @returns {void}
				 */
				function onWheel(event) {
					event.preventDefault();
					var box = node.getBoundingClientRect();
					if (box.width === 0 || box.height === 0) return;
					var px = ((event.clientX - box.left) / box.width) * sim.width;
					var py = ((event.clientY - box.top) / box.height) * sim.height;
					setCamera(function (previous) {
						var base = previous === null ? { s: 1, x: 0, y: 0 } : previous;
						var next = Math.min(Math.max(base.s * Math.exp(-event.deltaY * 0.0016), 0.7), 6);
						var ratio = next / base.s;
						return { s: next, x: px - (px - base.x) * ratio, y: py - (py - base.y) * ratio };
					});
				}
				node.addEventListener('wheel', onWheel, { passive: false });
				return function () { node.removeEventListener('wheel', onWheel); };
			}, [sim]);

			// Names are on demand, not on by default: a hundred cards labelled at
			// once is the same wall of text the branch names were, and the picture
			// reads better as colours and shapes until the reader asks a question.
			// Hovering or pinning a card names it and its neighbours, and nothing
			// else — the answer is exactly the cards the edges lead to.
			var labels = useMemo(function () {
				if (sim === null || snapshot === null || focus === null) return {};
				var byId = {};
				snapshot.nodes.forEach(function (node) { byId[node.id] = node; });
				var focusNode = byId[focus];
				// Stated relations first. The picture only has room for a few names
				// around a crowded card, and the ones a solid line already points at
				// are the answer the pointer asked for; a tag neighbour that merely
				// came first in edge order is not.
				var stated = {};
				sim.pairs.forEach(function (edge) {
					if (edge.kind !== 'link') return;
					if (edge.source === focus) stated[edge.target] = true;
					else if (edge.target === focus) stated[edge.source] = true;
				});
				var ordered = [];
				(sim.neighbours[focus] ?? []).slice().sort(function (left, right) {
					var leftStated = stated[left] === true ? 0 : 1;
					var rightStated = stated[right] === true ? 0 : 1;
					if (leftStated !== rightStated) return leftStated - rightStated;
					return ((byId[right] ?? {}).degree ?? 0) - ((byId[left] ?? {}).degree ?? 0);
				}).forEach(function (id) {
					if (byId[id] !== undefined) ordered.push(byId[id]);
				});
				if (focusNode === undefined && ordered.length === 0) return {};
				if (sim.alpha >= 0.005) {
					// While the layout is still moving, a full collision search per
					// painted frame would cost more than the motion it explains:
					// names follow their dot and flip to the other side near the edge.
					// The settled pass below replaces this with the real placement.
					var quick = {};
					var toDraw = focusNode === undefined ? ordered : [focusNode].concat(ordered);
					toDraw.forEach(function (node) {
						var text = node.text.length > 12 ? node.text.slice(0, 12) + '…' : node.text;
						if (text === '') return;
						var boxWidth = linkLabelWidth(text) + 4;
						var left = node.x + node.r + 4;
						var anchor = 'start';
						if (left + boxWidth > sim.width - 1) {
							left = node.x - node.r - 4 - boxWidth;
							anchor = 'end';
						}
						quick[node.id] = {
							x: anchor === 'start' ? left : left + boxWidth,
							y: node.y + 3,
							anchor: anchor,
							text: text,
						};
					});
					return quick;
				}
				// Focus first, so it wins the roomiest spot when space is short.
				var boxes = [];
				var placeable = focusNode === undefined ? ordered : [focusNode].concat(ordered);
				var map = placeLinkLabels(placeable, snapshot.nodes, sim.width, sim.height, placeable.length, boxes);
				if (focusNode !== undefined && map[focus] === undefined) {
					// The card under the pointer has to be named even in the densest
					// cluster: retry with the node clearance off. The label may touch a
					// dot, but it is the one name the reader explicitly asked for, and
					// without it the hover looks broken.
					var alone = placeLinkLabels([focusNode], [], sim.width, sim.height, 1, boxes);
					Object.keys(alone).forEach(function (id) { map[id] = alone[id]; });
				}
				return map;
			}, [sim, snapshot, focus]);

			/**
			 * Find the live simulation node behind a snapshot id.
			 *
			 * @param {string} id - The card id.
			 * @returns {object | null} The simulation node.
			 */
			function liveNodeOf(id) {
				if (sim === null) return null;
				for (var i = 0; i < sim.nodes.length; i += 1) {
					if (sim.nodes[i].id === id) return sim.nodes[i];
				}
				return null;
			}

			/**
			 * Where a pointer event lands in graph coordinates (camera included).
			 *
			 * @param {object} event - The pointer event.
			 * @returns {{x: number, y: number} | null} Graph coordinates.
			 */
			function graphPointOf(event) {
				if (sim === null) return null;
				var box = null;
				var svg = svgRef.current;
				if (svg !== null && svg !== undefined && typeof svg.getBoundingClientRect === 'function') {
					box = svg.getBoundingClientRect();
				} else if (event.currentTarget !== null && event.currentTarget !== undefined
					&& typeof event.currentTarget.getBoundingClientRect === 'function') {
					box = event.currentTarget.getBoundingClientRect();
				}
				if (box === null || box.width === 0 || box.height === 0) return null;
				var px = ((event.clientX - box.left) / box.width) * sim.width;
				var py = ((event.clientY - box.top) / box.height) * sim.height;
				return { x: (px - view.x) / view.s, y: (py - view.y) / view.s };
			}

			/** Wake a settled animation loop after a reheat. */
			function wakeLoop() {
				var state = animRef.current;
				if (typeof state.wake === 'function') state.wake();
			}

			/** Release a dragged node back to the springs and let it settle. */
			function endNodeDrag() {
				var drag = dragRef.current;
				if (drag === null || drag === undefined || drag.mode !== 'node') return;
				dragRef.current = null;
				var node = liveNodeOf(drag.id);
				if (node !== null) {
					node.fx = null;
					node.fy = null;
				}
				setDragging(null);
				if (sim !== null) sim.reheat(0.25);
				wakeLoop();
				setTick(function (value) { return value + 1; });
			}

			// The element tree depends on the snapshot, the labels and the focus,
			// not on the camera: a pan only moves the <g> transform.
			var parts = useMemo(function () {
				if (sim === null || snapshot === null) return { edges: [], nodes: [] };
				var related = {};
				if (focus !== null) {
					related[focus] = true;
					(sim.neighbours[focus] ?? []).forEach(function (id) { related[id] = true; });
				}
				var edgeEls = [];
				snapshot.edges.forEach(function (edge, index) {
					var weak = edge.kind !== 'link';
					// A tie between two cards that already have stated relations
					// stays out of the resting picture: the links already carry the
					// structure, and the extra dashed layer is what made the graph
					// unreadable. Focusing a card brings its own ties back, because
					// then they are the subject rather than background.
					if (edge.tied === true && focus === null) return;
					var lit = focus === null
						|| (related[edge.source] === true && related[edge.target] === true);
					edgeEls.push(h('path', {
						key: 'e-' + index,
						d: edge.d,
						className: 'evrLinkEdge'
							+ (weak
								? ' evrLinkEdgeWeak' + (lit && focus !== null ? ' evrLinkEdgeWeakLit' : '')
								: (edge.mutual === true ? ' evrLinkEdgeMutual' : '')),
						// Direction is only worth drawing while the reader is looking
						// at one card; a wall of arrowheads says nothing.
						markerEnd: weak || focus === null ? undefined : 'url(#evrLinkArrow)',
						opacity: lit ? 1 : 0.15,
					}));
				});
				var nodeEls = snapshot.nodes.map(function (node) {
					var nodeId = node.id;
					var lit = focus === null || related[nodeId] === true;
					var neighbour = focus !== null && nodeId !== focus && related[nodeId] === true;
					var label = labels[nodeId];
					var name = node.text === '' ? nodeId : node.text;
					return h('g', {
						key: nodeId,
						className: 'evrLinkNode'
							+ (focus === nodeId ? ' evrLinkNodeOn' : '')
							+ (dragging === nodeId ? ' evrLinkNodeDragging' : ''),
						role: 'button',
						tabIndex: 0,
						'aria-label': name + ' · ' + node.degree,
						opacity: lit ? 1 : 0.16,
						onPointerDown: function (event) {
							// Dragging a card must not start a background pan, so this
							// event stops here. The pointer capture is best effort: a
							// host without it just loses the pointer outside the svg.
							if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
							if (event && typeof event.preventDefault === 'function') event.preventDefault();
							var live = liveNodeOf(nodeId);
							if (live === null) return;
							var svg = svgRef.current;
							if (svg !== null && svg !== undefined && typeof svg.setPointerCapture === 'function'
								&& event.pointerId !== undefined) {
								try { svg.setPointerCapture(event.pointerId); } catch (error) { /* best effort */ }
							}
							movedRef.current = false;
							var point = graphPointOf(event);
							dragRef.current = {
								mode: 'node',
								id: nodeId,
								offsetX: point === null ? 0 : point.x - live.x,
								offsetY: point === null ? 0 : point.y - live.y,
								startX: event.clientX,
								startY: event.clientY,
							};
							live.fx = live.x;
							live.fy = live.y;
							setDragging(nodeId);
							if (sim !== null) sim.reheat(0.4);
							wakeLoop();
						},
						onMouseEnter: function () { setHovered(nodeId); },
						onMouseLeave: function () { setHovered(null); },
						onFocus: function () { setHovered(nodeId); },
						onBlur: function () { setHovered(null); },
						onClick: function (event) {
							if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
							// A drag that moved the card is not a click on it.
							if (movedRef.current) return;
							setPinned(pinned === nodeId ? null : nodeId);
						},
						onKeyDown: function (event) {
							if (event && (event.key === 'Enter' || event.key === ' ')) {
								if (typeof event.preventDefault === 'function') event.preventDefault();
								setPinned(pinned === nodeId ? null : nodeId);
							}
						},
					},
						h('circle', { cx: node.x, cy: node.y, r: node.r, fill: node.color }),
						label === undefined
							? null
							: h('text', {
								x: label.x,
								y: label.y,
								textAnchor: label.anchor,
								className: 'evrLinkLabel' + (neighbour ? ' evrLinkLabelQuiet' : ''),
							}, label.text),
						h('title', null, name + ' · ' + node.degree + ' ' + t('overview.linkGraph.links')));
				});
				return { edges: edgeEls, nodes: nodeEls };
			}, [sim, snapshot, labels, focus, dragging, t]);

			if (sim === null) return h('div', { className: 'evrHint' }, t('overview.linkGraph.empty'));

			return h('div', { className: 'evrGraphWrap' },
				hiddenCards > 0
					? h('div', { className: 'evrGraphCap' }, t('overview.linkGraph.count')
						.replace('{shown}', String(shownCards))
						.replace('{total}', String(totalCards)))
					: null,
				h('svg', {
					ref: svgRef,
					className: 'evrLinkGraph' + (dragging === null ? '' : ' evrLinkGraphDragging'),
					xmlns: 'http://www.w3.org/2000/svg',
					viewBox: '0 0 ' + sim.width + ' ' + sim.height,
					role: 'img',
					'aria-label': t('overview.linkGraph.label'),
					onPointerDown: function (event) {
						movedRef.current = false;
						dragRef.current = {
							mode: 'pan',
							x: event.clientX,
							y: event.clientY,
							camera: view,
							box: event.currentTarget.getBoundingClientRect(),
						};
					},
					onPointerMove: function (event) {
						var drag = dragRef.current;
						if (drag === null || drag === undefined) return;
						if (sim === null) return;
						if (drag.mode === 'node') {
							var point = graphPointOf(event);
							if (point === null) return;
							var node = liveNodeOf(drag.id);
							if (node === null) return;
							// The pointer owns the node while dragging; clamp inside the
							// frame so it cannot be lost off-canvas.
							node.fx = Math.min(sim.width - node.r - 2, Math.max(node.r + 2, point.x - drag.offsetX));
							node.fy = Math.min(sim.height - node.r - 2, Math.max(node.r + 2, point.y - drag.offsetY));
							node.x = node.fx;
							node.y = node.fy;
							if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > 3) {
								movedRef.current = true;
							}
							sim.reheat(0.3);
							wakeLoop();
							setTick(function (value) { return value + 1; });
							return;
						}
						var dx = event.clientX - drag.x;
						var dy = event.clientY - drag.y;
						if (Math.abs(dx) + Math.abs(dy) > 3) movedRef.current = true;
						if (drag.box.width === 0 || drag.box.height === 0) return;
						setCamera({
							s: drag.camera.s,
							x: drag.camera.x + dx * (sim.width / drag.box.width),
							y: drag.camera.y + dy * (sim.height / drag.box.height),
						});
					},
					onPointerUp: function (event) {
						var drag = dragRef.current;
						if (drag !== null && drag !== undefined && drag.mode === 'node') {
							var svg = svgRef.current;
							if (svg !== null && svg !== undefined && typeof svg.releasePointerCapture === 'function'
								&& event.pointerId !== undefined) {
								try { svg.releasePointerCapture(event.pointerId); } catch (error) { /* best effort */ }
							}
							endNodeDrag();
							return;
						}
						dragRef.current = null;
						var dragged = movedRef.current;
						if (dragged) return;
						// A click on the empty canvas fits the whole picture again.
						if (event.target === event.currentTarget) {
							setCamera(null);
							setPinned(null);
						}
					},
					onPointerLeave: function () {
						var drag = dragRef.current;
						if (drag !== null && drag !== undefined && drag.mode === 'node') {
							endNodeDrag();
							return;
						}
						dragRef.current = null;
					},
				},
					// The arrowhead is a marker so it follows the curve's own
					// direction: a link is a statement about who cites whom, and
					// a plain line cannot say that. `userSpaceOnUse` keeps the
					// head the same size whatever the stroke width is.
					h('defs', null,
						h('marker', {
							id: 'evrLinkArrow',
							viewBox: '0 0 10 10',
							refX: 8.5,
							refY: 5,
							markerWidth: 5,
							markerHeight: 5,
							markerUnits: 'userSpaceOnUse',
							orient: 'auto',
						},
							h('path', { d: 'M 0 1 L 9 5 L 0 9 z', className: 'evrLinkArrow' }))),
					h('g', {
						style: {
							transform: 'translate(' + view.x.toFixed(1) + 'px,' + view.y.toFixed(1) + 'px) scale(' + view.s.toFixed(3) + ')',
							transition: 'transform 200ms ease',
						},
					},
						h('g', null, parts.edges),
						h('g', null, parts.nodes))));
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
			// Which injected blocks are expanded. All start open: this page is
			// for reading the prompt, and the headers stay clickable when the
			// page gets long.
			var [infoOpen, setInfoOpen] = useState({ section: true, index: true });
			if (injection === null || overview === null) return h(Spinner, null, t('state.loading'));
			var stats = overview.stats ?? {};
			var year = overview.year ?? {};
			var activity = Array.isArray(overview.activity) ? overview.activity : [];
			var tree = Array.isArray(overview.tree) ? overview.tree : [];
			var heatHint = t('overview.yearHeatmap.hint')
				.replace('{notes}', String(year.notes ?? 0))
				.replace('{days}', String(year.activeDays ?? 0));
			var prefsLinkInfo = injection.preferences?.link ?? { kind: 'missing' };
			var prefsLink = prefsLinkInfo.kind !== 'link'
				? t('prefs.link.missing')
				: (prefsLinkInfo.ours === false ? t('prefs.link.foreign') : t('prefs.link.linked'));
			var sections = [
				{ id: 'stats', label: t('overview.stats') },
				// The editor only exists when the host can serve it; an older
				// host gets no tab instead of a dead one.
				props.descriptions === null ? null : { id: 'descriptions', label: t('overview.descriptions') },
				{ id: 'info', label: t('overview.info') },
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
			 * The UTF-8 size of a string, for the byte counters in the panel.
			 *
			 * @param {string} text - The text.
			 * @returns {number} Its size in bytes.
			 */
			function byteSize(text) {
				if (typeof TextEncoder === 'function') return new TextEncoder().encode(String(text ?? '')).length;
				return String(text ?? '').length;
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
			 * Written as a chain of branches rather than nested ternaries: the
			 * shape has to stay readable as the number of views grows.
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
				if (section === 'info') {
					var detail = overview.injection;
					var snapshot = detail === null || detail === undefined ? null : detail.snapshot;
					var snapshotAt = snapshot !== null && snapshot !== undefined && typeof snapshot.at === 'string' && snapshot.at !== ''
						? absoluteTime(snapshot.at, false)
						: '';
					var blocks = detail !== undefined && detail !== null
						? [
							{ key: 'section', title: t('overview.info.section'), badge: t('overview.info.badge.section'), text: detail.section ?? '' },
							{
								key: 'index',
								title: t('overview.info.index'),
								badge: t('overview.info.badge.context'),
								text: detail.index ?? '',
								// What the block above actually is. "It looks old" is the
								// right reading half the time; the other half it is the
								// live fallback, which changes on every write.
								note: snapshotAt === ''
									? t('overview.info.snapshotLive')
									: t('overview.info.snapshot').replace('{at}', snapshotAt),
							},
						]
						// An older host only serves the combined preview.
						: [{ key: 'all', title: t('overview.projection'), badge: t('overview.info.badge.context'), text: injection.cards.text ?? '' }];
					var total = blocks.reduce(function (sum, block) { return sum + byteSize(block.text); }, 0);
					return h('div', { role: 'tabpanel' },
						h('div', { className: 'evrSection' }, t('overview.info')),
						h('div', { className: 'evrHint', style: { marginBottom: '6px' } }, t('overview.info.hint')),
						h('div', { className: 'evrHint', style: { marginBottom: '10px' } },
							t('overview.info.total')
								.replace('{blocks}', String(blocks.length))
								.replace('{bytes}', formatBytes(total))
								.replace('{budget}', formatBytes(injection.cards.budget ?? 4096))),
						blocks.map(function (block) {
							var open = infoOpen[block.key] !== false;
							return h('div', { key: block.key, className: 'evrInfoBlock' },
								h('div', { className: 'evrInfoHead' },
									h('span', { className: 'evrSection evrInfoTitle' }, block.title),
									h('span', { className: 'evrBadge evrBadgeOk' }, block.badge),
									h('span', { className: 'evrHint evrInfoBytes' }, formatBytes(byteSize(block.text))),
									h('button', {
										type: 'button',
										className: 'evrBtn evrInfoToggle',
										onClick: function () {
											setInfoOpen(function (previous) {
												var next = { ...previous };
												next[block.key] = !open;
												return next;
											});
										},
									}, open ? t('overview.info.collapse') : t('overview.info.expand'))),
								block.note === undefined ? null : h('div', { className: 'evrHint evrInfoNote' }, block.note),
								open ? h('div', { className: 'evrInfoBody' }, h(Markdown, { t: t, text: block.text })) : null);
						}),
						h('div', { className: 'evrHint' }, t('overview.info.preferencesHint')));
				}
				if (section === 'preferences') {
					return preview(t('overview.preferences'), [
						[t('overview.bytes'), formatBytes(injection.preferences?.bytes ?? 0)],
						[t('overview.link'), prefsLink],
					], injection.preferences?.text ?? '');
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
							h(TagGraph, { t: t, nodes: tree })),
						h('div', { className: 'evrOverviewPane evrOverviewTree' },
							h('div', { className: 'evrSection' }, t('overview.linkGraph')),
							h(LinkGraph, { t: t, graph: props.graph }))));
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
			var searchSettled = useRef(false);
			// The debounced call must see the latest filter setter: it is replaced
			// whenever the filter changes, and a 220 ms old copy would apply the
			// query on a stale filter and drop the tag the user just clicked.
			var filterRef = useRef(props.onFilter);
			useEffect(function () { filterRef.current = props.onFilter; }, [props.onFilter]);
			useEffect(function () {
				// Typing filters as you go; the delay keeps it to one request per
				// burst of typing instead of one per keystroke. The first run
				// only marks the mount, because the panel already loaded the list.
				if (searchSettled.current === false) {
					searchSettled.current = true;
					return undefined;
				}
				var timer = setTimeout(function () { filterRef.current({ query: search }); }, 220);
				return function () { clearTimeout(timer); };
			}, [search]);
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
				var total = Number(state.total) || cards.length;
				var shown = h('div', null, cards.map(function (card) {
					return h('div', {
						key: card.id,
						className: 'evrRow',
						role: 'button',
						tabIndex: 0,
						onClick: function () { props.onOpen(card.id); },
						onKeyDown: function (event) {
							if (event && (event.key === 'Enter' || event.key === ' ')) {
								if (typeof event.preventDefault === 'function') event.preventDefault();
								props.onOpen(card.id);
							}
						},
					},
						h('div', { className: 'evrRowMain' },
							// 卡片没有标题：描述就是它在列表里的那一行，正文只进详情。
							h('div', { className: 'evrRowTitle' },
								card.description || card.id),
							h('div', { className: 'evrRowMeta' },
								(card.tags ?? []).map(function (tag) {
									return h('span', { key: tag, className: 'evrTag' }, "#" + tag);
								}))),
						h('div', {
							className: 'evrRowTime',
							title: absoluteTime(card.updated ?? '', true),
						}, cardTime(card.updated ?? '', t)));
				}));
				if (total <= cards.length) return shown;
				return h('div', null,
					shown,
					h('div', { className: 'evrHint', style: { marginTop: '8px' } },
						t('cards.truncated').replace('{shown}', String(cards.length)).replace('{total}', String(total))));
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
							h('span', { className: 'evrCardTitle' }, card.description || card.id),
							h('span', { className: 'evrCardCount' }, (card.tags ?? []).slice(0, 3).map(function (tag) { return '#' + tag; }).join(' · '))),
						h('div', { className: 'evrHint evrMono' }, card.id),
						h('div', { className: 'evrPre', style: { whiteSpace: 'pre-wrap', marginTop: '8px' } }, card.body || ''),
						card.source?.quote !== undefined
							? h('div', { className: 'evrHint', style: { marginTop: '8px' } }, t('cards.source') + '：' + card.source.quote)
							: null,
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
						// Outgoing links open like backlinks: the trail continues in
						// both directions, so both are buttons.
						return h('button', {
							key: 'l-' + item.id,
							type: 'button',
							className: 'evrBtn',
							style: { marginRight: '6px', marginBottom: '4px' },
							onClick: function () { props.onOpen(item.id); },
						}, '→ ' + (item.description || item.id));
					}),
					(detail.backlinks ?? []).length > 0 ? h('div', { className: 'evrSection' }, t('cards.backlinks')) : null,
					(detail.backlinks ?? []).map(function (item) {
						return h('button', {
							key: 'b-' + item.id,
							type: 'button',
							className: 'evrBtn',
							style: { marginRight: '6px', marginBottom: '4px' },
							onClick: function () { props.onOpen(item.id); },
						}, item.description || item.id);
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
					field(t('cards.field.description').replace('{max}', String(props.settings?.cardDescriptionMaxChars ?? 80)), h('input', {
						className: 'evrInput',
						value: fields.description,
						placeholder: t('cards.field.descriptionHint'),
						onChange: function (event) { patch({ description: event.target.value }); },
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
					(filter.resourcePath ?? '') === ''
						? null
						: h('div', { className: 'evrToolbar' },
							h('span', { className: 'evrTag' }, t('cards.filter.resource')
								.replace('{name}', String(filter.resourcePath).split('/').pop())),
							h('button', {
								type: 'button',
								className: 'evrBtn',
								onClick: function () { props.onFilter({ resourcePath: '' }); },
							}, t('cards.filter.resourceClear'))),
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
							onKeyDown: function (event) {
								// Enter searches at once instead of waiting out the debounce.
								if (event && event.key === 'Enter') props.onFilter({ query: search });
							},
						}),
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

		/** 能在面板里直接渲染的扩展名：其余类型交给系统程序。 */
		var PREVIEWABLE = ['md', 'markdown', 'txt', 'log', 'json', 'yaml', 'yml', 'toml', 'csv', 'tsv',
			'html', 'css', 'js', 'mjs', 'cjs', 'ts', 'py', 'sh', 'bash', 'zsh', 'rb', 'go', 'rs',
			'java', 'c', 'h', 'cpp', 'sql', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'pdf'];

		/** How many attachment rows the page paints before asking for a search. */
		var RESOURCE_ROW_LIMIT = 200;

		function previewableOf(name) {
			var match = /\.([0-9a-z]+)$/i.exec(String(name ?? ''));
			return match !== null && PREVIEWABLE.indexOf(match[1].toLowerCase()) >= 0;
		}

		/**
		 * 资源页：全部附件的只读清单。
		 *
		 * 不新建第二套存储——附件本来就属于某张卡片（`knowledge/resources/<卡片id>/`），
		 * 这里只是把散在卡片目录里的文件聚到一页：有什么、多大、能不能直接跑、
		 * 挂在哪张卡上、被几张卡引用。
		 *
		 * @param {object} props - Slot props plus the loaded rows.
		 * @returns {object} The page.
		 */
		function ResourcesTab(props) {
			var t = props.t;
			var [search, setSearch] = useState('');
			var [preview, setPreview] = useState(null);
			var [previewing, setPreviewing] = useState(false);
			var all = Array.isArray(props.rows) ? props.rows : [];
			var needle = search.trim().toLowerCase();
			// 搜索在本地做：这一页一次只有几十个文件，发一轮请求比过滤更慢。
			var list = needle === ''
				? all
				: all.filter(function (file) {
					var card = file.card ?? {};
					return String(file.name).toLowerCase().includes(needle)
						|| String(card.description ?? '').toLowerCase().includes(needle)
						|| (card.tags ?? []).some(function (tag) { return String(tag).toLowerCase().includes(needle); });
				});
			// A folder can hold hundreds of attachments; the page still has to
			// open. The rest is one search away, not one scroll away.
			var shown = list.slice(0, RESOURCE_ROW_LIMIT);
			var owners = {};
			all.forEach(function (file) {
				var owner = file.card ?? { id: '' };
				if (owner.id !== '') owners[owner.id] = true;
			});

			// Only the last preview wins: closing the overlay while a request is
			// still in flight must not reopen it when the late answer arrives.
			var previewSeq = useRef(0);

			function closePreview() {
				previewSeq.current += 1;
				setPreviewing(false);
				setPreview(null);
			}

			function openPreview(file) {
				var token = previewSeq.current + 1;
				previewSeq.current = token;
				setPreviewing(true);
				setPreview({ file: file, data: null });
				props.onPreview(file.card.id, file.name).then(function (value) {
					if (previewSeq.current !== token) return;
					setPreview({ file: file, data: value });
				}).catch(function (reason) {
					if (previewSeq.current !== token) return;
					closePreview();
					// A preview that silently does nothing reads as a broken button.
					if (typeof props.onNotify === 'function') props.onNotify(messageOf(reason), true);
				}).then(function () {
					if (previewSeq.current !== token) return;
					setPreviewing(false);
				});
			}

			function previewBody() {
				var body = h('div', { className: 'evrPreviewBody' });
				var data = preview === null ? null : preview.data;
				if (data === null || data === undefined) {
					return h('div', null, body, h('div', { className: 'evrHint' }, t('state.loading')));
				}
				if (data.kind === 'image' && typeof data.base64 === 'string') {
					body = h('div', { className: 'evrPreviewBody' }, h('img', { src: 'data:' + data.mime + ';base64,' + data.base64, alt: data.name }));
				} else if (data.kind === 'image') {
					// An older host could answer `kind: 'image'` without bytes;
					// rendering `data:...;base64,undefined` looks like a corrupt
					// file, so say the preview is unavailable instead.
					body = h('div', { className: 'evrPreviewBody' }, h('div', { className: 'evrHint' }, t('cards.resources.noPreview')));
				} else if (data.kind === 'pdf') {
					body = h('div', { className: 'evrPreviewBody' }, h('iframe', { src: 'data:application/pdf;base64,' + data.base64, title: data.name }));
				} else if (data.kind === 'text') {
					body = h('div', { className: 'evrPreviewBody' },
						data.mime === 'text/markdown'
							? h(Markdown, { t: t, text: data.text })
							: h('pre', { className: 'evrPre', style: { whiteSpace: 'pre-wrap', margin: 0 } }, data.text));
				} else {
					body = h('div', { className: 'evrPreviewBody' }, h('div', { className: 'evrHint' }, t('cards.resources.noPreview')));
				}
				return h('div', null,
					body,
					data.truncated === true ? h('div', { className: 'evrHint', style: { padding: '0 14px 10px' } }, t('cards.resources.truncated')) : null);
			}

			return h.apply(null, ['div', null].concat([
				h('div', { className: 'evrSection' }, t('resources.title')),
				h('div', { className: 'evrToolbar' },
					h('input', {
						className: 'evrInput',
						type: 'search',
						value: search,
						placeholder: t('cards.resources.search'),
						onChange: function (event) { setSearch(event.target.value); },
					}),
					h('span', { className: 'evrHint' }, t('cards.resources.count')
						.replace('{files}', String(list.length))
						.replace('{cards}', String(Object.keys(owners).length))),
					h('span', { style: { flex: '1' } }),
					h('button', {
						type: 'button',
						className: 'evrBtn',
						disabled: props.busy,
						onClick: props.onRefresh,
					}, t('action.refresh'))),
				all.length === 0
					? h(Empty, null, t('cards.resources.empty'))
					: list.length === 0
						? h(Empty, null, t('cards.resources.emptySearch'))
						// 文件名是这个页面的主体：先看到有什么文件，再决定要不要
						// 关心它属于哪张卡。
						: h('div', null, shown.map(function (file) {
							var card = file.card ?? {};
							return h('div', { key: (card.id ?? '') + '/' + file.name, className: 'evrRow' },
								h('div', { className: 'evrRowMain' },
									h('div', { className: 'evrRowTitle evrMono', style: { fontSize: '12.5px' } }, file.name),
									h('div', { className: 'evrRowMeta' },
										formatBytes(file.bytes),
										file.executable === true ? ' · ' + t('cards.resources.exec') : '',
										' · ',
										t('cards.resources.refs') + ' ' + String((file.referenced ?? []).length)),
									h('div', { className: 'evrRowMeta' },
										h('span', { className: 'evrHint' }, t('cards.resources.owner') + '：'),
										card.description || card.id || '',
										' ',
										h('span', { className: 'evrMono evrHint' }, String(card.id ?? '').slice(-5))),
									h('div', { className: 'evrRowMeta' },
										(card.tags ?? []).map(function (tag) {
											return h('span', { key: tag, className: 'evrTag' }, '#' + tag);
										}))),
								h('div', { style: { display: 'flex', gap: '6px', flex: 'none' } },
									previewableOf(file.name)
										? h('button', {
											type: 'button',
											className: 'evrBtn',
											disabled: previewing,
											onClick: function () { openPreview(file); },
										}, t('cards.resources.preview'))
										: null,
									h('button', {
										type: 'button',
										className: 'evrBtn',
										onClick: function () { props.onOpenFile(file.card.id, file.name); },
									}, t('cards.resources.open')),
									h('button', {
										type: 'button',
										className: 'evrBtn evrBtnPrimary',
										onClick: function () { props.onFilter({ resourcePath: file.path ?? '', query: '', tag: '', anyTags: [], archivedOnly: false }); },
									}, t('cards.resources.view'))));
						}),
						list.length > RESOURCE_ROW_LIMIT
							? h('div', { className: 'evrHint', style: { marginTop: '8px' } },
								t('cards.resources.more').replace('{n}', String(list.length - RESOURCE_ROW_LIMIT)))
							: null),
				preview === null
					? null
					: h('div', { className: 'evrPreview', onClick: closePreview },
						h('div', { className: 'evrPreviewPanel', onClick: function (event) { if (event && event.stopPropagation) event.stopPropagation(); } },
							h('div', { className: 'evrPreviewHead' },
								h('span', { className: 'evrMono' }, preview.file.name),
								h('span', { className: 'evrHint' }, formatBytes(preview.file.bytes)),
								h('span', { style: { flex: '1' } }),
								h('button', {
									type: 'button',
									className: 'evrBtn',
									onClick: closePreview,
								}, t('cards.resources.close'))),
							previewBody()))]));
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
			// An unreadable or truncated file must not be repairable by pressing
			// Save: the textarea would hold '' or half the file and write that
			// back over the real preferences.
			var unreadable = preferences !== null && preferences !== undefined && preferences.readable === false;
			var truncated = preferences?.truncated === true;
			var notLoaded = preferences === null || preferences === undefined;
			var locked = unreadable || truncated || notLoaded;
			var lockHint = unreadable ? t('prefs.readFailed') : (truncated ? t('prefs.truncated') : (notLoaded ? t('prefs.notLoaded') : ''));
			// A link the plugin did not create belongs to somebody else: it is
			// shown as such, and replacing it stays a deliberate takeover.
			// The host reports one of link / file / other / missing; only the
			// first and the last have a label of their own. A plain file or a
			// directory sitting at that path belongs to somebody else, so it
			// reads as "linked elsewhere" instead of showing a raw key.
			var linked = link.kind === 'link';
			var foreign = (linked && link.ours === false) || link.kind === 'file' || link.kind === 'other';
			var linkLabel = foreign
				? t('prefs.link.foreign')
				: (link.kind === 'missing' ? t('prefs.link.missing') : t('prefs.link.linked'));
			return h('div', { className: 'evrEditorPage' },
				h('div', { className: 'evrSection' }, t('prefs.content')),
				h('div', { className: 'evrHint', style: { marginBottom: '8px' } }, t('prefs.hint')),
				h('textarea', {
					className: 'evrTextarea',
					value: preferences?.content ?? '',
					readOnly: locked,
					onChange: function (event) { props.onChange(event.target.value); },
				}),
				lockHint === '' ? null : h('div', { className: 'evrHint', style: { marginTop: '6px' } }, lockHint),
				h('div', { className: 'evrEditorFoot' },
					h('button', {
						type: 'button',
						className: 'evrBtn evrBtnPrimary',
						disabled: props.busy || locked,
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
		 * The `<select>` value of a model selection.
		 *
		 * `''` is "follow the session". Provider and model ids never contain
		 * `::`, so the pair survives the round trip through a select value.
		 *
		 * @param {object | null | undefined} model - The selection.
		 * @returns {string} The option value.
		 */
		function modelOptionValue(model) {
			return model === null || model === undefined ? '' : model.provider + '::' + model.model;
		}

		/**
		 * The model behind one option value.
		 *
		 * @param {string} value - The option value.
		 * @returns {object} The selection, `{provider, model}` or bare.
		 */
		function modelFromOption(value) {
			if (value === '') return null;
			var parts = String(value).split('::');
			if (parts.length !== 2) return null;
			return { provider: parts[0], model: parts[1] };
		}

		/**
		 * The reasoning levels one model offers, or `null`.
		 *
		 * @param {object | null | undefined} catalog - The model catalogue.
		 * @param {object | null | undefined} model - The selection.
		 * @returns {object | null} `{efforts, defaultEffort}`.
		 */
		function effortsOf(catalog, model) {
			if (catalog === null || catalog === undefined || model === null || model === undefined) return null;
			var groups = Array.isArray(catalog.providers) ? catalog.providers : [];
			for (var index = 0; index < groups.length; index += 1) {
				if (groups[index].id !== model.provider) continue;
				var models = Array.isArray(groups[index].models) ? groups[index].models : [];
				for (var inner = 0; inner < models.length; inner += 1) {
					if (models[inner].id !== model.model) continue;
					return models[inner].reasoning ?? null;
				}
			}
			return null;
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
			var [descCap, setDescCap] = useState(settings?.cardDescriptionMaxChars ?? 80);
			var [dataForce, setDataForce] = useState(false);
			var [exportDir, setExportDir] = useState('');
			var [exportName, setExportName] = useState('');
			var [archiveList, setArchiveList] = useState(null);
			var [section, setSection] = useState('data');
			var [importDir, setImportDir] = useState('');
			var [transferForce, setTransferForce] = useState(false);
			var [absorbDir, setAbsorbDir] = useState('');
			var [absorbList, setAbsorbList] = useState(null);
			var [absorbResult, setAbsorbResult] = useState(null);

			useEffect(function () {
				setForm(backupForm(settings));
			}, [settings]);

			useEffect(function () {
				if (settings && settings.cardMaxChars !== undefined) setCardCap(settings.cardMaxChars);
			}, [settings]);

			useEffect(function () {
				if (settings && settings.cardDescriptionMaxChars !== undefined) setDescCap(settings.cardDescriptionMaxChars);
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
				if (dataForce && typeof confirm === 'function' && confirm(t('settings.confirmMigrate')) !== true) return;
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
				if (transferForce && typeof confirm === 'function' && confirm(t('settings.confirmImport')) !== true) return;
				props.onImport(importDir.trim(), transferForce);
			}

			/**
			 * Ask for a folder and list the archives inside it.
			 *
			 * @returns {void}
			 */
			function browseAbsorbArchives() {
				if (typeof props.onBrowseArchives !== 'function') return;
				props.onBrowseArchives().then(function (value) {
					if (value && Array.isArray(value.files)) setAbsorbList(value);
				});
			}

			/**
			 * Merge the chosen archive into the live library.
			 *
			 * @returns {void}
			 */
			function absorbNow() {
				if (absorbDir.trim() === '') {
					props.onNotify(t('settings.needArchive'), true);
					return;
				}
				if (typeof confirm === 'function' && confirm(t('settings.absorb.confirm')) !== true) return;
				setAbsorbResult(null);
				var pending = props.onAbsorb(absorbDir.trim());
				if (pending && typeof pending.then === 'function') {
					pending.then(function (value) {
						if (value !== null && value !== undefined) setAbsorbResult(value);
					});
				}
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
			 * One archive list, for whichever flow asked for it.
			 *
			 * @param {object | null} list - The `data-archives` answer.
			 * @param {Function} onPick - What a row click fills.
			 * @param {string} titleKey - The card title.
			 * @param {string} emptyKey - The empty-folder text.
			 * @returns {object | null} The list card.
			 */
			function renderArchiveList(list, onPick, titleKey, emptyKey) {
				if (list === null) return null;
				var files = Array.isArray(list.files) ? list.files : [];
				return h('div', { className: 'evrCard', style: { marginTop: '8px' } },
					h('div', { className: 'evrCardHead' },
						h('span', { className: 'evrCardTitle' }, t(titleKey)),
						h('span', { className: 'evrCardCount' }, String(files.length))),
					files.length === 0
						? h('div', { className: 'evrCardHint' }, t(emptyKey))
						: h('div', null, files.map(function (item) {
							return h('div', {
								key: item.path,
								className: 'evrRow',
								onClick: function () { onPick(item.path); },
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

			var sectionBar = h('div', { className: 'evrToolbar', role: 'tablist' }, [
				{ id: 'data', label: t('settings.data') },
				{ id: 'transfer', label: t('settings.transfer') },
				{ id: 'absorb', label: t('settings.absorb') },
				{ id: 'backup', label: t('settings.section.backup') },
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
					h(Field, { label: t('settings.cardDescCap'), hint: t('settings.cardDescCapHint') },
						h('div', { style: { display: 'flex', gap: '6px' } },
							h('input', {
								className: 'evrInput',
								type: 'number',
								min: 20,
								max: 200,
								value: descCap,
								onChange: function (event) { setDescCap(Number(event.target.value)); },
							}),
							h('button', {
								type: 'button',
								className: 'evrBtn',
								disabled: busy,
								onClick: function () { props.onSaveCardDescCap(Number(descCap)); },
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
				renderArchiveList(archiveList, setImportDir, 'settings.transfer.archives', 'settings.transfer.noArchives'),
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
				absorb: [
				h('div', { className: 'evrSection' }, t('settings.absorb')),
				h('div', { className: 'evrHint', style: { marginBottom: '10px' } }, t('settings.absorb.hint')),
				h(Field, { label: t('settings.absorb.file') },
					h('div', { style: { display: 'flex', gap: '6px' } },
						h('input', {
							className: 'evrInput',
							value: absorbDir,
							placeholder: t('settings.absorb.placeholder'),
							onChange: function (event) { setAbsorbDir(event.target.value); },
						}),
						h('button', {
							type: 'button',
							className: 'evrBtn',
							disabled: busy,
							onClick: browseAbsorbArchives,
						}, t('settings.action.pick')))),
				renderArchiveList(absorbList, setAbsorbDir, 'settings.absorb.archives', 'settings.absorb.noArchives'),
				h('div', { className: 'evrHint', style: { marginTop: '8px' } }, t('settings.absorb.rules')),
				h('div', { className: 'evrEditorFoot' },
					h('button', {
						type: 'button',
						className: 'evrBtn evrBtnPrimary',
						disabled: busy,
						onClick: absorbNow,
					}, t('settings.absorb.run'))),
				absorbResult === null
					? null
					: h('div', { className: 'evrCard', style: { marginTop: '10px' } },
						h('div', { className: 'evrCardHead' },
							h('span', { className: 'evrCardTitle' }, t('settings.absorb.result')),
							h('span', { className: 'evrCardCount' }, '+' + String(absorbResult.added ?? 0))),
						h('div', { className: 'evrRowMain' },
							[
								['settings.absorb.count.incoming', absorbResult.incoming],
								['settings.absorb.count.added', absorbResult.added],
								['settings.absorb.count.duplicate', absorbResult.duplicate],
								['settings.absorb.count.existing', absorbResult.existing],
								['settings.absorb.count.skipped', absorbResult.skipped],
								['settings.absorb.count.files', absorbResult.files],
								['settings.absorb.count.branches', absorbResult.branches],
							].filter(function (entry) { return typeof entry[1] === 'number'; }).map(function (entry) {
								return h('div', { key: entry[0], className: 'evrRowMeta' }, t(entry[0]) + ': ' + String(entry[1]));
							})),
						Array.isArray(absorbResult.problems) && absorbResult.problems.length > 0
							? h('div', { className: 'evrCardHint' }, t('settings.absorb.problems') + '：'
								+ absorbResult.problems.slice(0, 5).map(function (item) { return String(item.reason ?? ''); }).join('；'))
							: null),

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
			};

			return h.apply(null, ['div', null, sectionBar].concat(sections[section] ?? []));
		}

		/**
		 * The two organisers, each with its own switch and schedule.
		 *
		 * They are kept apart because they do different work on different
		 * material: the session ingest reads conversations and writes new
		 * fleeting cards, while the card consolidation edits the library
		 * that is already there.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function OrganiseTab(props) {
			var t = props.t;
			var ingestStatus = props.ingest;
			var ingestForm = props.ingestDraft;
			var consolidateStatus = props.consolidate;
			var consolidateForm = props.consolidateDraft;
			var organizeStatus = props.organize;
			var organizeDraft = props.organizeDraft;
			var organizeReady = organizeStatus !== null && organizeStatus !== undefined
				&& organizeDraft !== null && organizeDraft !== undefined;
			// `current` is what would actually run right now; an older host or a
			// failed probe may leave it out, so read it through one guard.
			var effectiveModel = organizeReady && organizeStatus.current !== null && organizeStatus.current !== undefined
				? organizeStatus.current
				: null;
			var draftModel = organizeReady ? organizeDraft.model : null;
			var organizeEfforts = effortsOf(organizeStatus, draftModel);
			var listedModelValues = ((organizeStatus?.providers) ?? []).reduce(function (values, provider) {
				(Array.isArray(provider.models) ? provider.models : []).forEach(function (model) {
					values.push(provider.id + '::' + model.id);
				});
				return values;
			}, []);
			var ingestReady = ingestStatus !== null && ingestStatus !== undefined && ingestForm !== null && ingestForm !== undefined;
			var consolidateReady = consolidateStatus !== null && consolidateStatus !== undefined && consolidateForm !== null && consolidateForm !== undefined;
			return h.apply(null, ['div', null].concat([
				h('div', { className: 'evrSection' }, t('settings.section.organize')),
				h('div', { className: 'evrHint', style: { marginBottom: '10px' } }, t('settings.organize.hint')),
				// One model for both organisers, above them: they are the same kind of
				// job, and a selector buried in one card would silently govern the
				// other as well.
				organizeReady
					? h('div', { className: 'evrCard', style: { marginBottom: '12px' } },
						h('div', { className: 'evrCardHead' },
							h('span', { className: 'evrCardTitle' }, t('settings.organize.modelTitle')),
							h('span', { className: 'evrCardCount' }, effectiveModel === null
								? '—'
								: effectiveModel.provider + ' · ' + effectiveModel.model)),
						h('div', { className: 'evrCardHint', style: { marginBottom: '8px' } }, t('settings.organize.modelHint')),
						h('div', { className: 'evrToolbar' },
							h('span', { className: 'evrHint' }, t('settings.organize.model')),
							h('select', {
								className: 'evrInput',
								value: modelOptionValue(draftModel),
								onChange: function (event) {
									props.onOrganizeDraft({ model: modelFromOption(event.target.value) });
								},
							},
								[h('option', { key: '__session', value: '' }, t('settings.organize.modelSession'))].concat(
									// A saved model the catalogue does not list (adapter down,
									// removed route) still has to read as the current value;
									// otherwise the select claims "follow the chat" while the
									// host is running something else.
									(draftModel !== null && listedModelValues.indexOf(modelOptionValue(draftModel)) === -1)
										? [h('option', {
											key: '__saved',
											value: modelOptionValue(draftModel),
										}, draftModel.provider + ' · ' + draftModel.model)]
										: [],
									((organizeStatus.providers) ?? []).map(function (provider) {
										return h('optgroup', { key: provider.id, label: provider.name },
											(Array.isArray(provider.models) ? provider.models : []).map(function (model) {
												return h('option', {
													key: provider.id + '::' + model.id,
													value: provider.id + '::' + model.id,
												}, model.name);
											}));
									}))),
							organizeEfforts === null
								? null
								: h('span', { className: 'evrHint' }, t('settings.organize.effort')),
							organizeEfforts === null
								? null
								: h('select', {
									className: 'evrInput',
									value: draftModel?.reasoningEffort ?? '',
									onChange: function (event) {
										var next = { ...draftModel };
										if (event.target.value === '') delete next.reasoningEffort;
										else next.reasoningEffort = event.target.value;
										props.onOrganizeDraft({ model: next });
									},
								},
									[h('option', { key: '__default', value: '' }, t('settings.organize.effortDefault'))].concat(
										organizeEfforts.efforts.map(function (effort) {
											return h('option', { key: effort.id, value: effort.id }, effort.name);
										}))),
							h('span', { style: { flex: '1' } }),
							h('button', {
								type: 'button',
								className: 'evrBtn',
								onClick: function () { props.onOrganizeSave(organizeDraft); },
							}, t('action.save'))),
						h('div', { className: 'evrHint' }, t('settings.organize.modelEffective') + ': '
							+ (effectiveModel === null
								? '—'
								: effectiveModel.provider + ' · ' + effectiveModel.model
									+ (effectiveModel.reasoningEffort === undefined
										? ''
										: ' · ' + effectiveModel.reasoningEffort))))
					: null,
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
							: t('sight.ingest.unavailable')),
						Number(ingestStatus.lastSaved) > 0
							? h('div', { className: 'evrHint' }, t('sight.ingest.quoted')
								.replace('{saved}', String(ingestStatus.lastSaved))
								.replace('{quoted}', String(ingestStatus.lastQuoted ?? 0)))
							: null)
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
							: t('sight.ingest.unavailable')),
						consolidateStatus.lastRun !== null
							&& consolidateStatus.lastRun !== undefined
							&& (consolidateStatus.lastRun.retagged + consolidateStatus.lastRun.tagMerges) > 0
							? h('div', { className: 'evrHint' }, t('settings.consolidate.lastTags')
								.replace('{tags}', String(consolidateStatus.lastRun.retagged))
								.replace('{merged}', String(consolidateStatus.lastRun.tagMerges)))
							: null)
					: null,
				h('div', { className: 'evrHint evrMono', style: { marginTop: '10px' } }, t('settings.consolidate.trashHint'))
			]));
		}

		//#endregion

		/**
		 * The plugin's own log: what the background jobs actually did.
		 *
		 * A read-only view. The file is written by the host and rotated there,
		 * so this tab cannot make the log grow; it only shows the tail and how
		 * much of the ring is in use.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		/** The dictionary key of each log level, spelled out so the i18n guard can see it. */
		var LOG_LEVEL_LABEL = { info: 'logs.levelInfo', warn: 'logs.levelWarn', error: 'logs.levelError' };

		function LogsTab(props) {
			var t = props.t;
			var [section, setSection] = useState('logs');
			var view = props.view;
			var health = props.health;
			var entries = view === null || view === undefined || !Array.isArray(view.entries) ? [] : view.entries;
			var status = view === null || view === undefined ? null : view.status;
			var budget = status === null || status === undefined
				? ''
				: formatBytes((status.maxBytes ?? 0) * (status.keep ?? 1));
			var healthText = health === null || health === undefined || typeof health.text !== 'string' ? '' : health.text;
			var lastRun = health === null || health === undefined || typeof health.lastRunAt !== 'string' ? '' : health.lastRunAt;

			function healthPanel() {
				return h('div', null,
					h('div', { className: 'evrHint', style: { marginBottom: '8px' } }, t('logs.health.hint')),
					h('div', { className: 'evrToolbar' },
						h('span', { className: 'evrHint' }, lastRun === ''
							? t('logs.health.never')
							: t('logs.health.lastRun').replace('{at}', absoluteTime(lastRun, false))),
						h('span', { style: { flex: '1' } }),
						h('button', {
							type: 'button',
							className: 'evrBtn',
							disabled: props.busy,
							onClick: props.onHealthRun,
						}, t('logs.health.run'))),
					healthText === ''
						? h('div', { className: 'evrHint' }, t('logs.health.never'))
						: h(Markdown, { t: t, text: healthText }));
			}

			function logPanel() {
				return h.apply(null, ['div', null].concat([
					h('div', { className: 'evrHint', style: { marginBottom: '8px' } }, t('logs.hint').replace('{max}', budget)),
					h('div', { className: 'evrToolbar' },
						h('span', { className: 'evrHint' }, status === null || status === undefined
							? ''
							: t('logs.files')
								.replace('{files}', String((status.files ?? []).length))
								.replace('{bytes}', formatBytes(status.bytes ?? 0))),
						h('span', { style: { flex: '1' } }),
						h('button', {
							type: 'button',
							className: 'evrBtn',
							disabled: props.busy,
							onClick: props.onRefresh,
						}, t('logs.refresh'))),
					entries.length === 0
						? h('div', { className: 'evrHint' }, t('logs.empty'))
						// Newest first: the reason to open this page is the run that
						// just failed, not the one from an hour ago.
						: h('div', { className: 'evrLog' }, entries.slice().reverse().map(function (entry, index) {
							var level = entry.level === 'warn' || entry.level === 'error' ? entry.level : 'info';
							return h('div', { key: 'log-' + index, className: 'evrLogRow evrLog' + level.charAt(0).toUpperCase() + level.slice(1) },
								h('span', { className: 'evrLogTime' }, absoluteTime(entry.at, true)),
								h('span', { className: 'evrLogLevel' }, t(LOG_LEVEL_LABEL[level])),
								h('span', { className: 'evrLogText' }, entry.message));
						}))]));
			}

			// Same sub-tab bar as every other page: a page-level tab strip here
			// would read as a second navigation level that does not exist.
			return h('div', null,
				h('div', { className: 'evrSubTabs', role: 'tablist', 'aria-label': t('logs.title') },
					[
						{ id: 'logs', label: t('logs.tab.logs') },
						{ id: 'health', label: t('logs.tab.health') },
					].map(function (item) {
						return h('button', {
							key: item.id,
							type: 'button',
							role: 'tab',
							'aria-selected': section === item.id,
							className: 'evrTab' + (section === item.id ? ' evrTabActive' : ''),
							onClick: function () { setSection(item.id); },
						}, item.label);
					})),
				section === 'health' ? healthPanel() : logPanel());
		}

		//#region panel

		/**
		 * Keep one broken page from blanking the whole panel.
		 *
		 * The tab body is wrapped in this boundary, which is keyed by the tab:
		 * React remounts it when the tab changes, so a page that threw while
		 * the host answered with an unexpected shape only loses that page, and
		 * the reader can still switch to the others.
		 */
		class TabErrorBoundary extends Component {
			/**
			 * @param {object} props - `{t, children}`.
			 */
			constructor(props) {
				super(props);
				this.state = { error: null };
			}

			/**
			 * The state after a descendant threw during render.
			 *
			 * @param {unknown} error - The thrown value.
			 * @returns {object} The next state.
			 */
			static getDerivedStateFromError(error) {
				return { error: error };
			}

			/**
			 * The fallback: a retry affordance that re-renders the same page.
			 *
			 * @returns {object} The element tree.
			 */
			render() {
				if (this.state.error === null) return this.props.children;
				var t = this.props.t;
				return h('div', { className: 'evrEmpty' },
					h('div', null, t('state.error')),
					h('button', {
						type: 'button',
						className: 'evrBtn',
						style: { marginTop: '10px' },
						onClick: function () { this.setState({ error: null }); }.bind(this),
					}, t('action.retry')));
			}
		}

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
			var [preferences, setPreferences] = useState(null);
			var [settings, setSettings] = useState(null);
			var [settingsEpoch, setSettingsEpoch] = useState(0);
			var [ingest, setIngest] = useState(null);
			var [ingestDraft, setIngestDraft] = useState(null);
			var [consolidate, setConsolidate] = useState(null);
			var [consolidateDraft, setConsolidateDraft] = useState(null);
			// The organisers' model settings are only needed on the organise page,
			// and reading them costs an adapter round trip for the catalogue: load
			// them when that page is shown.
			var [organize, setOrganize] = useState(null);
			var [organizeDraft, setOrganizeDraft] = useState(null);
			var [logsView, setLogsView] = useState(null);
			var [healthView, setHealthView] = useState(null);
			var [resourcesView, setResourcesView] = useState(null);
			var [cards, setCards] = useState(null);
			// The overview link graph reads its own whole-library payload: the
			// cards tab narrows its list, and the graph must not inherit that
			// filter. The host caps it at `limit` and reports the rest as
			// `totals.hiddenCards`.
			var [graph, setGraph] = useState(null);
			var [descriptions, setDescriptions] = useState(null);
			var [cardFilter, setCardFilter] = useState({ tag: '', anyTags: [], archivedOnly: false, query: '' });
			var [cardDetail, setCardDetail] = useState(null);
			var [cardEditor, setCardEditor] = useState(null);
			var [status, setStatus] = useState(null);
			var [toast, setToast] = useState(null);
			var [busy, setBusy] = useState(false);
			var [error, setError] = useState(null);
			var [notice, setNotice] = useState(null);
			// Only the last answer of each kind wins: a slow first request must not
			// overwrite what the user selected while waiting.
			var requestSeq = useRef({ load: 0, cards: 0, graph: 0, detail: 0 });
			// The filter the user has selected right now. Long-lived callbacks
			// (save a limit, refresh everything) must not answer to the empty
			// filter captured on mount, so they read it through this ref.
			var cardFilterRef = useRef(cardFilter);
			cardFilterRef.current = cardFilter;

			var report = useCallback(function (message, isError) {
				setStatus({ message: message, error: isError === true });
			}, []);

			var notify = useCallback(function (message, isError) {
				setToast({ message: message, error: isError === true });
			}, []);

			// Read through a ref: `loadAll` lives in an effect dependency array, so
			// it must not be re-created when the translator's identity changes.
			var tRef = useRef(t);
			tRef.current = t;

			/**
			 * Reload the card list with a filter, defaulting to the current one.
			 *
			 * @param {object} [nextFilter] - The filter to use instead.
			 * @returns {Promise<object | null>} The fresh payload.
			 */
			var refreshCards = useCallback(function (nextFilter) {
				var filter = nextFilter ?? cardFilterRef.current;
				var payload = {
					query: filter.query ?? '',
					tags: filter.tag ? [filter.tag] : [],
					anyTags: filter.anyTags ?? [],
					archivedOnly: filter.archivedOnly === true,
					resourcePath: filter.resourcePath ?? '',
				};
				var token = requestSeq.current.cards + 1;
				requestSeq.current.cards = token;
				return call('card-list', payload).then(function (value) {
					if (requestSeq.current.cards === token) setCards(value);
					return value;
				}).catch(function (reason) {
					notify(messageOf(reason), true);
					return null;
				});
			}, [call, notify]);

			/**
			 * Reload the whole-library payload the overview link graph draws.
			 *
			 * @returns {Promise<object | null>} The fresh payload.
			 */
			var refreshGraph = useCallback(function () {
				var token = requestSeq.current.graph + 1;
				requestSeq.current.graph = token;
				return call('graph', { limit: 300 }).then(function (value) {
					if (requestSeq.current.graph === token) setGraph(value);
					return value;
				}).catch(function (reason) {
					notify(messageOf(reason), true);
					return null;
				});
			}, [call, notify]);

			/**
			 * Reload everything a mutation can change.
			 *
			 * Mutations use this instead of `refreshCards`: the graph lives off
			 * its own request and would otherwise keep the pre-mutation picture,
			 * and the overview (counts, tag tree, injected text) is a separate
			 * projection that also went stale. A failed overview read keeps the
			 * previous value instead of blanking the page.
			 *
			 * @returns {Promise<unknown[]>} The fresh payloads.
			 */
			var refreshLibrary = useCallback(function () {
				return Promise.all([
					refreshCards(),
					refreshGraph(),
					call('overview').then(function (value) {
						setOverview(value);
						return value;
					}).catch(function () { return null; }),
				]);
			}, [call, refreshCards, refreshGraph]);

			useEffect(function () {
				if (toast === null || toast.error === true) return undefined;
				var timer = setTimeout(function () { setToast(null); }, 4500);
				return function () { clearTimeout(timer); };
			}, [toast]);

			var loadAll = useCallback(function () {
				var token = requestSeq.current.load + 1;
				requestSeq.current.load = token;
				// One failing endpoint must not blank the whole panel. Only the two
				// the first screen cannot work without are fatal; the rest downgrade
				// to a notice and keep whatever the other blocks loaded.
				// The list and the graph go through their own refreshers: a
				// global refresh has to respect the current filter and share the
				// request sequence with every other caller.
				var requests = [
					{ name: 'overview', request: call('overview') },
					{ name: 'injection', request: call('injection') },
					{ name: 'preferences', request: call('preferences') },
					{ name: 'settings', request: call('settings') },
					{ name: 'ingest-status', request: call('ingest-status') },
					{ name: 'consolidate-status', request: call('consolidate-status') },
					{ name: 'card-list', request: refreshCards() },
					// A host from before this feature answers with an unknown-endpoint
					// error; the panel then simply has no descriptions to edit.
					{ name: 'tag-descriptions', request: call('tag-descriptions') },
					{ name: 'link-graph', request: refreshGraph() },
				];
				return Promise.allSettled(requests.map(function (entry) { return entry.request; })).then(function (results) {
					if (requestSeq.current.load !== token) return;
					var valueOf = function (index) {
						return results[index].status === 'fulfilled' ? results[index].value : undefined;
					};
					var failures = [];
					results.forEach(function (result, index) {
						if (result.status === 'rejected') failures.push({ name: requests[index].name, reason: result.reason });
					});
					var nextOverview = valueOf(0);
					var nextInjection = valueOf(1);
					var nextPreferences = valueOf(2);
					var nextSettings = valueOf(3);
					var nextIngest = valueOf(4);
					var nextConsolidate = valueOf(5);
					// Index 6 (cards) and 8 (graph) apply themselves inside the
					// refreshers, behind their own request sequence.
					var nextDescriptions = valueOf(7);
					if (nextOverview !== undefined) setOverview(nextOverview);
					if (nextInjection !== undefined) setInjection(nextInjection);
					if (nextPreferences !== undefined) setPreferences(nextPreferences);
					if (nextSettings !== undefined) setSettings(nextSettings);
					if (nextIngest !== undefined) {
						setIngest(nextIngest);
						setIngestDraft(function (current) { return current === null || current === undefined ? ingestFormOf(nextIngest) : current; });
					}
					if (nextConsolidate !== undefined && nextConsolidate !== null) {
						setConsolidate(nextConsolidate);
						setConsolidateDraft(function (current) { return current === null || current === undefined ? consolidateFormOf(nextConsolidate) : current; });
					}
					if (nextDescriptions !== undefined) setDescriptions(nextDescriptions?.descriptions ?? null);
					var fatal = failures.filter(function (failure) { return failure.name === 'overview' || failure.name === 'injection'; });
					if (fatal.length > 0) {
						setError(messageOf(fatal[0].reason));
						setNotice(null);
						return;
					}
					setError(null);
					setNotice(failures.length === 0
						? null
						: tRef.current('state.partial').replace('{items}', failures.map(function (failure) { return failure.name; }).join(', ')));
				});
			}, [call, refreshCards, refreshGraph]);

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
					report(messageOf(reason), true);
				}).then(function () {
					setBusy(false);
				});
			}, [call, report, t]);

			var savePreferences = useCallback(function () {
				if (preferences?.readable === false || preferences?.truncated === true || preferences === null || preferences === undefined) {
					var why = preferences === null || preferences === undefined
						? t('prefs.notLoaded')
						: (preferences.truncated === true ? t('prefs.truncated') : t('prefs.readFailed'));
					report(why, true);
					return;
				}
				setBusy(true);
				call('preferences-save', { content: preferences?.content ?? '' }).then(function (value) {
					setPreferences(value);
					report(t('state.saved'), false);
				}).catch(function (reason) {
					report(messageOf(reason), true);
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
					report(messageOf(reason), true);
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
					report(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, report, t]);

			var saveCardDescCap = useCallback(function (value) {
				setBusy(true);
				return call('settings-save', { cardDescriptionMaxChars: value }).then(function (next) {
					setSettings(next);
					notify(t('state.saved'), false);
					return refreshCards();
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).then(function () {
					setBusy(false);
				});
			}, [call, notify, t, refreshCards]);

			var saveCardCap = useCallback(function (value) {
				setBusy(true);
				return call('settings-save', { cardMaxChars: value }).then(function (next) {
					setSettings(next);
					notify(t('state.saved'), false);
					return refreshCards();
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, refreshCards, t]);

			var saveBackupSettings = useCallback(function (form) {
				setBusy(true);
				call('settings-save', { backup: form }).then(function (value) {
					setSettings(value);
					notify(t('state.saved'), false);
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, t]);

			var clearBackupSecret = useCallback(function () {
				setBusy(true);
				call('settings-save', { backup: { clearAccessKeySecret: true } }).then(function (value) {
					setSettings(value);
					notify(t('state.saved'), false);
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, t]);

			var migrateData = useCallback(function (dir, force) {
				setBusy(true);
				notify(t('state.working'), false);
				call('data-migrate', { dir: dir, force: force }, 300000).then(function (value) {
					notify(t('state.migrated') + ' → ' + String(value.root ?? dir), false);
					setSettingsEpoch(function (value) { return value + 1; });
					return loadAll();
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, loadAll, notify, t]);

			var exportData = useCallback(function (dir, name, force) {
				setBusy(true);
				notify(t('state.working'), false);
				call('data-export', { dir: dir, name: name, force: force }, 300000).then(function (value) {
					notify(t('state.exported') + ' → ' + String(value.file ?? dir) + ' · ' + String(value.files ?? 0) + ' · ' + formatBytes(value.bytes ?? 0), false);
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, t]);

			var importData = useCallback(function (dir, force) {
				setBusy(true);
				notify(t('state.working'), false);
				call('data-import', { file: dir, force: force }, 300000).then(function (value) {
					notify(t('state.imported') + ' · ' + String(value.files ?? 0) + ' · ' + formatBytes(value.bytes ?? 0) + (value.skipped > 0 ? ' · ' + t('state.skipped') + ' ' + value.skipped : ''), false);
					return loadAll();
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, loadAll, notify, t]);

			var absorbData = useCallback(function (file) {
				setBusy(true);
				notify(t('state.working'), false);
				return call('data-absorb', { file: file }, 600000).then(function (value) {
					notify(t('state.absorbed') + ' · +' + String(value.added ?? 0), false);
					return refreshLibrary().then(function () { return value; });
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, refreshLibrary, t]);

			var backupNow = useCallback(function () {
				setBusy(true);
				notify(t('state.working'), false);
				call('backup-now', { force: true }, 300000).then(function (value) {
					if (value && value.settings) setSettings(value.settings);
					notify(t('state.backed') + ' · ' + formatBytes(value.bytes ?? 0), false);
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, t]);

			var testBackup = useCallback(function () {
				setBusy(true);
				notify(t('state.working'), false);
				call('backup-test', {}).then(function (value) {
					notify(t('settings.backup.testOk') + ' · ' + String(value.endpoint ?? ''), false);
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, t]);

			var pickDirectory = useCallback(function () {
				var service = ctx.get('uiWorkspace');
				if (service === undefined || typeof service.pickDirectory !== 'function') {
					notify(t('settings.pick.unavailable'), true);
					return Promise.resolve(null);
				}
				return Promise.resolve(service.pickDirectory()).catch(function (reason) {
					notify(messageOf(reason), true);
					return null;
				});
			}, [ctx, notify, t]);

			var browseArchives = useCallback(function () {
				var service = ctx.get('uiWorkspace');
				if (service === undefined || typeof service.pickDirectory !== 'function') {
					notify(t('settings.pick.unavailable'), true);
					return Promise.resolve(null);
				}
				return Promise.resolve(service.pickDirectory()).then(function (dir) {
					if (typeof dir !== 'string' || dir === '') return null;
					return call('data-archives', { dir: dir }).catch(function (reason) {
						notify(messageOf(reason), true);
						return null;
					});
				}).catch(function (reason) {
					notify(messageOf(reason), true);
					return null;
				});
			}, [call, ctx, notify, t]);

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
					notify(messageOf(reason), true);
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
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, t]);

			useEffect(function () {
				if (tab !== 'organize' || organize !== null) return undefined;
				call('organize-status').then(function (value) {
					var status = value ?? { model: null, current: null, providers: [] };
					setOrganize(status);
					setOrganizeDraft({ model: status.model ?? null });
				}).catch(function () {
					// An empty catalogue still lets the page show "follow the chat":
					// a failed probe must not hide the rest of the form.
					setOrganize({ model: null, current: null, providers: [] });
					setOrganizeDraft({ model: null });
				});
				return undefined;
			}, [tab, organize, call]);

			var loadLogs = useCallback(function () {
				return call('logs', { limit: 400 }).then(function (value) {
					setLogsView(value ?? { entries: [], status: null });
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				});
			}, [call, notify]);

			var loadResources = useCallback(function () {
				return call('resources-list').then(function (value) {
					setResourcesView(Array.isArray(value) ? value : []);
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				});
			}, [call, notify]);

			var loadHealth = useCallback(function () {
				return call('health-status').then(function (value) {
					setHealthView(value ?? { rows: [], lastRunAt: '', text: '' });
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				});
			}, [call, notify]);

			var runHealth = useCallback(function () {
				setBusy(true);
				return call('health-run').then(function (value) {
					setHealthView(value ?? null);
					notify(t('state.saved'), false);
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).then(function () {
					setBusy(false);
				});
			}, [call, notify, t]);

			// Re-read on every visit: the reason to open the page is the run that
			// just happened, so a cached copy would answer the wrong question.
			useEffect(function () {
				if (tab !== 'resources') return undefined;
				void loadResources();
				return undefined;
			}, [tab, loadResources]);

			useEffect(function () {
				if (tab !== 'logs') return undefined;
				void loadLogs();
				void loadHealth();
				return undefined;
			}, [tab, loadLogs, loadHealth]);

			var patchOrganizeDraft = useCallback(function (patch) {
				setOrganizeDraft(function (current) { return { ...(current ?? { model: null }), ...patch }; });
			}, []);

			var saveOrganize = useCallback(function (form) {
				setBusy(true);
				return call('organize-save', { organize: form }).then(function (value) {
					setOrganize(value);
					setOrganizeDraft({ model: value?.model ?? null });
					notify(t('state.saved'), false);
				}).catch(function (reason) {
					notify(messageOf(reason), true);
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
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, t]);

			var runConsolidate = useCallback(function () {
				setBusy(true);
				return call('consolidate-run', {}, 600000).then(function (value) {
					var message = value && value.message
						? value.message
						: t('settings.consolidate.done')
							.replace('{batch}', String(value?.batch ?? 0))
							.replace('{applied}', String((value?.updated ?? 0) + (value?.merged ?? 0) + (value?.deleted ?? 0)
								+ (value?.retagged ?? 0) + (value?.tagMerges ?? 0)));
					notify(message, false);
					return Promise.all([
						call('consolidate-status').catch(function () { return null; }),
						refreshCards(),
						call('overview').catch(function () { return null; }),
						refreshGraph(),
					]).then(function (results) {
						if (results[0] !== null) {
							setConsolidate(results[0]);
							setConsolidateDraft(consolidateFormOf(results[0]));
						}
						// The list and the graph applied themselves; the overview
						// is the only block still written here.
						if (results[2] !== null) setOverview(results[2]);
					}).catch(function () {});
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, refreshCards, refreshGraph, t]);

			var changeCardFilter = useCallback(function (patch) {
				var next = { ...cardFilter, ...patch };
				// A read that started under the old filter must not land in the
				// list the filter just changed.
				requestSeq.current.detail += 1;
				setCardFilter(next);
				setCardDetail(null);
				setCardEditor(null);
				return refreshCards(next);
			}, [cardFilter, refreshCards]);

			var openCard = useCallback(function (id) {
				var token = requestSeq.current.detail + 1;
				requestSeq.current.detail = token;
				// The panel shows attachment metadata only; the contents are the
				// tool's job and would be megabytes over the wire.
				return call('card-read', { id: id, metadataOnly: true }).then(function (value) {
					if (requestSeq.current.detail !== token) return;
					setCardDetail(value);
					setCardEditor(null);
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				});
			}, [call, notify]);

			var newCard = useCallback(function () {
				requestSeq.current.detail += 1;
				setCardDetail(null);
				setCardEditor({
					mode: 'new',
					fields: {
						id: '',
						body: '',
						tags: '即兴',
						description: '',
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
						description: card.description ?? '',
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
					description: String(fields.description ?? '').trim(),
					links: split(fields.links),
				};
				setBusy(true);
				return call('card-write', { card: card }).then(function (saved) {
					setCardEditor(null);
					return refreshLibrary().then(function () {
						notify(t('cards.saved'), false);
						return openCard(saved.id);
					});
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, cardEditor, notify, openCard, refreshLibrary, t]);

			var promoteCard = useCallback(function (id, target) {
				setBusy(true);
				return call('card-promote', { id: id, tags: [target || '践行'] }).then(function () {
					return refreshLibrary().then(function () { return openCard(id); });
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, openCard, refreshLibrary]);

			var archiveCard = useCallback(function (id) {
				setBusy(true);
				return call('card-archive', { id: id }).then(function () {
					return refreshLibrary().then(function () { return openCard(id); });
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, openCard, refreshLibrary]);

			var deleteCard = useCallback(function (id) {
				if (typeof confirm === 'function' && confirm(t('cards.deleteConfirm')) !== true) return;
				requestSeq.current.detail += 1;
				setBusy(true);
				return call('card-remove', { id: id }).then(function () {
					setCardDetail(null);
					return refreshLibrary().then(function () { notify(t('cards.removed'), false); });
				}).catch(function (reason) {
					notify(messageOf(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, notify, refreshLibrary, t]);

			var attachCard = useCallback(function (id, file) {
				if (file === undefined || file === null) return;
				// Reading a huge file into a base64 string freezes the renderer
				// long before the Host's request-body limit can reject it.
				if (typeof file.size === 'number' && file.size > 8 * 1024 * 1024) {
					notify(t('cards.attachTooLarge'), true);
					return;
				}
				if (typeof FileReader === 'undefined') {
					notify(t('cards.attachFailed'), true);
					return;
				}
				var reader = new FileReader();
				reader.onload = function () {
					var encoded = String(reader.result ?? '').split(',')[1] ?? '';
					setBusy(true);
					call('card-attach', { id: id, name: file.name, data: encoded }, 120000).then(function () {
						return refreshLibrary().then(function () { return openCard(id); });
					}).catch(function (reason) {
						notify(messageOf(reason), true);
					}).finally(function () { setBusy(false); });
				};
				reader.onerror = function () { notify(t('cards.attachFailed'), true); };
				reader.readAsDataURL(file);
			}, [call, notify, openCard, refreshLibrary, t]);

			var body = null;
			if (error !== null) {
				body = h('div', { className: 'evrEmpty' },
					h('div', null, t('state.error')),
					h('div', { className: 'evrMono' }, error),
					h('button', {
						type: 'button',
						className: 'evrBtn',
						onClick: function () { void loadAll(); },
					}, t('action.retry')));
			} else if (tab === 'overview') {
				body = h(OverviewTab, {
					t: t,
					injection: injection,
					overview: overview,
					graph: graph,
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
			} else if (tab === 'organize') {
				body = h(OrganiseTab, {
					t: t,
					busy: busy,
					ingest: ingest,
					ingestDraft: ingestDraft,
					onIngestDraft: patchIngestDraft,
					onIngestSave: saveIngest,
					onIngestRun: runIngest,
					consolidate: consolidate,
					consolidateDraft: consolidateDraft,
					organize: organize,
					organizeDraft: organizeDraft,
					onOrganizeDraft: patchOrganizeDraft,
					onOrganizeSave: saveOrganize,
					onConsolidateDraft: patchConsolidateDraft,
					onConsolidateSave: saveConsolidate,
					onConsolidateRun: runConsolidate,
				});
			} else if (tab === 'resources') {
				body = h(ResourcesTab, {
					t: t,
					rows: resourcesView,
					busy: busy,
					onRefresh: loadResources,
					onPreview: function (id, name) { return call('resource-preview', { id: id, name: name }); },
					onNotify: notify,
					onOpenFile: function (id, name) {
						return call('resource-open', { id: id, name: name }).then(function (value) {
							// Scripts and installers are not executed: the host reveals
							// them in the file manager instead, and the user has to know.
							if (value !== null && value !== undefined && value.mode === 'revealed') {
								notify(t('cards.resources.revealed'), false);
							}
						}).catch(function (reason) {
							notify(messageOf(reason), true);
						});
					},
					// The question a resource raises is "who uses it", not "who owns
					// it": jump to the filtered card list (the owner is in it too —
					// a card's body has to reference its own attachment).
					onFilter: function (patch) {
						changeCardFilter(patch);
						setTab('cards');
					},
				});
			} else if (tab === 'logs') {
				body = h(LogsTab, {
					t: t,
					view: logsView,
					health: healthView,
					busy: busy,
					onRefresh: loadLogs,
					onHealthRun: runHealth,
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
					onSaveCardDescCap: saveCardDescCap,
					onClearSecret: clearBackupSecret,
					onMigrate: migrateData,
					onExport: exportData,
					onImport: importData,
					onAbsorb: absorbData,
					onBackupNow: backupNow,
					onTestBackup: testBackup,
					onPickDirectory: pickDirectory,
					onBrowseArchives: browseArchives,
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
				h('div', { className: 'evrBody' },
					notice === null ? null : h('div', { className: 'evrHint evrWarn', role: 'status' }, notice),
					h('div', { className: 'evrEnter', key: tab },
						h(TabErrorBoundary, { key: tab, t: t }, body))),
				toast === null
					? null
					: h('div', {
						className: 'evrToast ' + (toast.error ? 'evrToastError' : 'evrToastOk'),
						role: toast.error === true ? 'alert' : 'status',
						'aria-live': toast.error === true ? 'assertive' : 'polite',
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
