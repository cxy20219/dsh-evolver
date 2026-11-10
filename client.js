/*
 * dsh-evolver — browser half.
 *
 * One sidebar entry opens one panel with five tabs:
 * 概览 / 实践 / 见闻 / 偏好 / 建议.
 *
 * The panel shows the same three things the agent gets: the practice index,
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
			'tab.practice': '实践',
			'tab.sight': '见闻',
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
			'action.delete': '删除',
			'action.close': '关闭',
			'action.new': '新建',
			'action.link': '设为全局加载',
			'action.takeover': '接管这个链接',
			'action.unlink': '移除全局链接',
			'action.recall': '召回',
			'state.loading': '读取中…',
			'state.error': '读取失败',
			'state.empty': '这里还没有内容。',
			'state.saved': '已保存',
			'state.deleted': '已删除',
			'state.created': '已创建',
			'state.linked': '已建立全局链接',
			'overview.injection': '注入的上下文',
			'overview.injection.hint': 'Agent 每次请求都会拿到这三块，别的地方都不占它的上下文。',
			'overview.practice': '实践',
			'overview.sight': '见闻',
			'overview.preferences': '偏好',
			'overview.suggestions': '建议',
			'overview.root': '数据目录',
			'overview.version': '版本',
			'overview.budget': '预算',
			'overview.bytes': '字节',
			'overview.entries': '条目',
			'overview.dropped': '未进索引',
			'practice.index': '注入的索引',
			'practice.entries': '条目',
			'practice.problems': '问题',
			'practice.query': '检索实践…',
			'practice.empty': '这一类还没有条目。',
			'practice.problem': '这条有问题',
			'practice.new.kind': '类型',
			'practice.new.name': '文件名',
			'practice.new.title': '标题',
			'practice.new.purpose': '用途（会出现在索引里）',
			'practice.new.topic': '主题（可留空）',
			'practice.new.body': '正文（Markdown）',
			'practice.new.verified': '最后验证日期',
			'practice.new.links': '关联条目（逗号分隔）',
			'practice.truncated': '文件太大，只读取了开头；请先拆分再编辑。',
			'soul.hint': '灵魂是 Agent 的人格与边界，每个会话都会被读到；一次性的经历属于见闻。',
			'soul.content': '灵魂（Markdown）',
			'prefs.hint': '这里是全局偏好。保存后由 DSH 的 AGENTS.md 加载器注入给每个会话。',
			'prefs.content': '全局偏好（Markdown）',
			'prefs.global': '全局加载',
			'prefs.link.linked': '已链接',
			'prefs.link.foreign': '被其他来源占用',
			'prefs.link.file': '被一个独立文件占用',
			'prefs.link.missing': '未链接',
			'prefs.link.other': '状态未知',
			'memory.hint': '见闻是 Agent 自己的记忆，按需召回，不会自动塞进上下文。',
			'memory.list': '记忆',
			'memory.recall': '召回记忆',
			'memory.query': '关键词…',
			'memory.empty': '还没有记忆。',
			'memory.kind': '类型',
			'suggestion.empty': '没有待办：实践与记忆都是健康的。',
			'suggestion.problem': '结构问题',
			'suggestion.stale': '久未验证',
			'time.justNow': '刚刚',
			'time.minutes': '{n} 分钟前',
			'time.hours': '{n} 小时前',
			'time.days': '{n} 天前',
			'kind.doc': '文档',
			'kind.tool': '工具',
			'kind.resource': '资源',
			'settings.hint': '数据目录决定实践、见闻与偏好放在哪里；云端备份把整个目录打包上传。',
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
			'tab.practice': 'Practice',
			'tab.sight': 'Sight',
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
			'action.delete': 'Delete',
			'action.close': 'Close',
			'action.new': 'New',
			'action.link': 'Load globally',
			'action.takeover': 'Take over this link',
			'action.unlink': 'Remove the global link',
			'action.recall': 'Recall',
			'state.loading': 'Loading…',
			'state.error': 'Failed to read',
			'state.empty': 'Nothing here yet.',
			'state.saved': 'Saved',
			'state.deleted': 'Deleted',
			'state.created': 'Created',
			'state.linked': 'The global link is in place',
			'overview.injection': 'Injected context',
			'overview.injection.hint': 'The agent gets exactly these three blocks in every request.',
			'overview.practice': 'Practice',
			'overview.sight': 'Sight',
			'overview.preferences': 'Preferences',
			'overview.suggestions': 'Suggestions',
			'overview.root': 'Data folder',
			'overview.version': 'Version',
			'overview.budget': 'Budget',
			'overview.bytes': 'Bytes',
			'overview.entries': 'Entries',
			'overview.dropped': 'Left out of the index',
			'practice.index': 'Injected index',
			'practice.entries': 'Entries',
			'practice.problems': 'Problems',
			'practice.query': 'Search the practice…',
			'practice.empty': 'This kind has no entry yet.',
			'practice.problem': 'This one has a problem',
			'practice.new.kind': 'Kind',
			'practice.new.name': 'File name',
			'practice.new.title': 'Title',
			'practice.new.purpose': 'Purpose (it shows up in the index)',
			'practice.new.topic': 'Topic (optional)',
			'practice.new.body': 'Body (Markdown)',
			'practice.new.verified': 'Last verified',
			'practice.new.links': 'Related entries (comma separated)',
			'practice.truncated': 'The file is too large and was only partially read; split it before editing.',
			'soul.hint': 'The soul is the agent’s persona and boundaries; it is read in every session.',
			'soul.content': 'Soul (Markdown)',
			'prefs.hint': 'Global preferences. DSH injects this file through its AGENTS.md loader.',
			'prefs.content': 'Global preferences (Markdown)',
			'prefs.global': 'Global load',
			'prefs.link.linked': 'linked',
			'prefs.link.foreign': 'linked elsewhere',
			'prefs.link.file': 'taken by a separate file',
			'prefs.link.missing': 'not linked',
			'prefs.link.other': 'unknown',
			'memory.hint': 'Sight is what the agent remembers; it is recalled on demand, never pushed.',
			'memory.list': 'Memories',
			'memory.recall': 'Recall',
			'memory.query': 'Keywords…',
			'memory.empty': 'No memory yet.',
			'memory.kind': 'Kind',
			'suggestion.empty': 'Nothing to do: the practice and the memory are healthy.',
			'suggestion.problem': 'Structure problem',
			'suggestion.stale': 'Not verified for a while',
			'time.justNow': 'just now',
			'time.minutes': '{n} min ago',
			'time.hours': '{n} h ago',
			'time.days': '{n} d ago',
			'kind.doc': 'Documents',
			'kind.tool': 'Tools',
			'kind.resource': 'Resources',
			'settings.hint': 'The data folder holds the practice, sight and preferences; a cloud backup uploads the whole folder.',
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
			{ id: 'practice', label: 'tab.practice' },
			{ id: 'sight', label: 'tab.sight' },
			{ id: 'preferences', label: 'tab.preferences' },
			{ id: 'suggestions', label: 'tab.suggestions' },
			{ id: 'settings', label: 'tab.settings' },
		];

		/** The practice kinds, in index order. */
		var KINDS = [
			{ id: 'doc', title: 'kind.doc' },
			{ id: 'tool', title: 'kind.tool' },
			{ id: 'resource', title: 'kind.resource' },
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
			'.evrRowActive{border-color:var(--dsw-alias-state-business-primary)}',
			'.evrRowMain{flex:1;min-width:0}',
			'.evrRowTitle{font-size:13px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.evrRowMeta{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.evrRowTime{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
			'.evrTag{display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;flex:none}',
			'.evrToolbar{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}',
			'.evrInput{flex:1;min-width:160px;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;box-sizing:border-box}',
			'.evrInput:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
			'.evrSelect{height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;box-sizing:border-box}',
			'.evrSelect:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
			'.evrBtn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;transition:background .15s ease,border-color .15s ease}',
			'.evrBtn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}',
			'.evrBtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
			'.evrBtnPrimary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}',
			'.evrBtnDanger{color:var(--dsw-alias-state-error-primary)}',
			'.evrBtn[disabled]{opacity:.5;cursor:default}',
			'.evrTextarea{width:100%;min-height:220px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:12.5px;line-height:1.7;resize:vertical;box-sizing:border-box;tab-size:2}',
			'.evrTextareaShort{min-height:96px}',
			'.evrTextarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
			'.evrEditor{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:16px;margin-top:12px;box-shadow:var(--dsw-elevation-soft)}',
			'.evrEditorHead{display:flex;align-items:center;gap:10px;margin-bottom:10px}',
			'.evrEditorTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
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
			'.evrSplit{display:grid;grid-template-columns:minmax(240px,330px) 1fr;gap:16px;align-items:start}',
			'@media (max-width:960px){.evrSplit{grid-template-columns:1fr}}',
			'.evrList{max-height:calc(100vh - 300px);overflow:auto}',
			'.evrMono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px}',
			'.evrPre{white-space:pre-wrap;word-break:break-word;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:10px 12px;margin:0}',
			'.evrWarn{border-left:3px solid var(--dsw-alias-state-warn-primary);padding-left:10px}',
			'.evrToast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:30;display:flex;align-items:center;gap:10px;max-width:min(620px,84%);padding:9px 11px 9px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-soft);font-size:12.5px;line-height:1.5}',
			'.evrToastOk{color:var(--dsw-alias-state-success-primary)}',
			'.evrToastError{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
			'.evrToastText{white-space:pre-wrap;word-break:break-word}',
			'.evrToastClose{flex:none;border:0;background:transparent;color:inherit;cursor:pointer;font-size:16px;line-height:1;padding:0 2px}',
			'.evrError{border-left:3px solid var(--dsw-alias-state-error-primary);padding-left:10px}',
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
		function callHost(ctx, endpoint, payload) {
			if (ctx.get('connection') === undefined) return Promise.reject(new Error('连接不可用'));
			var options = {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload ?? {}),
				credentials: 'same-origin',
			};
			// A hung Host must not leave every button disabled for the rest of the
			// session: the panel gives the request a deadline.
			if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
				options.signal = AbortSignal.timeout(30000);
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
					throw new Error('请求超时（30 秒）');
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
			var practice = overview.practice ?? {};
			return h('div', null,
				h('div', { className: 'evrSection' }, t('overview.injection')),
				h('div', { className: 'evrHint', style: { marginBottom: '10px' } }, t('overview.injection.hint')),
				h('div', { className: 'evrGrid' },
					h(StatCard, {
						title: t('overview.practice'),
						count: injection.practice.entries,
						value: formatBytes(injection.practice.bytes),
						hint: t('overview.budget') + ' ' + formatBytes(injection.practice.budget)
							+ ' · ' + t('overview.dropped') + ' ' + injection.practice.dropped,
					}),
					h(StatCard, {
						title: t('overview.sight'),
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
						value: String(practice.entries ?? 0),
						hint: overview.root ?? '',
					}),
					h(StatCard, {
						title: t('overview.version'),
						value: overview.version ? 'v' + overview.version : '—',
						hint: 'dsh-evolver',
					})),
				h('div', { className: 'evrSection' }, t('practice.index')),
				h('pre', { className: 'evrPre' }, injection.practice.text ?? ''),
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
		 * The practice: the entries, their index and the query tool.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function PracticeTab(props) {
			var t = props.t;
			var state = props.state ?? {};
			var kind = props.kind;
			var entries = (state.entries ?? []).filter(function (entry) { return entry.kind === kind; });
			var editor = props.editor;

			return h('div', null,
				h('div', { className: 'evrToolbar' },
					KINDS.map(function (item) {
						return h('button', {
							key: item.id,
							type: 'button',
							className: 'evrTab' + (item.id === kind ? ' evrTabActive' : ''),
							onClick: function () { props.onKind(item.id); },
						}, t(item.title));
					}),
					h('span', { className: 'evrStatus' }, t('practice.entries') + ' ' + entries.length),
					h('button', {
						type: 'button',
						className: 'evrBtn evrBtnPrimary',
						onClick: function () { props.onNew(kind); },
					}, t('action.new'))),
				entries.length === 0
					? h(Empty, null, t('practice.empty'))
					: h('div', { className: 'evrSplit' },
						h('div', { className: 'evrList' }, entries.map(function (entry) {
							return h('div', {
								key: entry.path,
								className: 'evrRow' + (props.selectedPath === entry.path ? ' evrRowActive' : ''),
								onClick: function () { props.onOpen(entry.path); },
							},
								h('div', { className: 'evrRowMain' },
									h('div', { className: 'evrRowTitle' }, entry.title),
									h('div', { className: 'evrRowMeta' },
										h('span', { className: 'evrTag' }, entry.topic),
										h('span', null, entry.path + ' · ' + formatBytes(entry.bytes)))),
								h('div', { className: 'evrRowTime' }, relativeTime(entry.updatedAt, t)));
						})),
						h('div', null, editor)),
				h('div', { className: 'evrSection' }, t('practice.index')),
				h('pre', { className: 'evrPre' }, (state.projection ?? {}).text ?? ''));
		}

		/**
		 * The editor of one practice entry.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function PracticeEditor(props) {
			var t = props.t;
			var draft = props.draft;
			if (draft === null || draft === undefined) {
				return h('div', { className: 'evrEditor' }, h(Empty, null, t('state.empty')));
			}
			return h('div', { className: 'evrEditor' },
				h('div', { className: 'evrEditorHead' },
					h('span', { className: 'evrTag' }, draft.topic || t('practice.new.topic')),
					h('span', { className: 'evrEditorTitle' }, draft.title || t('practice.new.title')),
					h('span', { className: 'evrStatus' }, draft.path ?? '')),
				draft.truncated === true
					? h('div', { className: 'evrHint evrWarn', style: { marginBottom: '10px' } }, t('practice.truncated'))
					: null,
				h('div', { className: 'evrFieldRow' },
					h(Field, { label: t('practice.new.title') },
						h('input', {
							className: 'evrInput',
							value: draft.title ?? '',
							onChange: function (event) { props.onChange({ title: event.target.value }); },
						})),
					h(Field, { label: t('practice.new.purpose') },
						h('input', {
							className: 'evrInput',
							value: draft.purpose ?? '',
							onChange: function (event) { props.onChange({ purpose: event.target.value }); },
						}))),
				h('div', { className: 'evrFieldRow' },
					h(Field, { label: t('practice.new.topic') },
						h('input', {
							className: 'evrInput',
							value: draft.topic ?? '',
							onChange: function (event) { props.onChange({ topic: event.target.value }); },
						})),
					h(Field, { label: t('practice.new.verified') },
						h('input', {
							className: 'evrInput',
							value: draft.verified ?? '',
							placeholder: 'YYYY-MM-DD',
							onChange: function (event) { props.onChange({ verified: event.target.value }); },
						}))),
				h(Field, { label: t('practice.new.links') },
					h('input', {
						className: 'evrInput',
						value: (draft.links ?? []).join(', '),
						placeholder: 'slug-a, slug-b',
						onChange: function (event) { props.onChange({ links: event.target.value.split(',').map(function (item) { return item.trim(); }).filter(function (item) { return item !== ''; }) }); },
					})),
				h(Field, { label: t('practice.new.body') },
					h('textarea', {
						className: 'evrTextarea',
						value: draft.body ?? '',
						onChange: function (event) { props.onChange({ body: event.target.value }); },
					})),
				h('div', { className: 'evrEditorFoot' },
					h('button', {
						type: 'button',
						className: 'evrBtn evrBtnPrimary',
						disabled: props.busy,
						onClick: function () { props.onSave(); },
					}, t('action.save')),
					draft.path === undefined || draft.path === ''
						? null
						: h('button', {
							type: 'button',
							className: 'evrBtn evrBtnDanger',
							disabled: props.busy,
							onClick: function () { props.onDelete(); },
						}, t('action.delete')),
					h('button', {
						type: 'button',
						className: 'evrBtn',
						disabled: props.busy,
						onClick: function () { props.onClose(); },
					}, t('action.close')),
					props.status === undefined || props.status === null
						? null
						: h('span', { className: 'evrStatus' + (props.status.error ? ' evrStatusError' : ' evrStatusOk') }, props.status.message)));
		}

		/**
		 * The sight: the soul and the memories.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function SightTab(props) {
			var t = props.t;
			var soul = props.soul;
			var memories = props.memories ?? [];
			return h('div', null,
				h('div', { className: 'evrSection' }, t('soul.content')),
				h('div', { className: 'evrHint', style: { marginBottom: '8px' } }, t('soul.hint')),
				h('textarea', {
					className: 'evrTextarea',
					value: soul?.content ?? '',
					onChange: function (event) { props.onSoulChange(event.target.value); },
				}),
				h('div', { className: 'evrEditorFoot' },
					h('button', {
						type: 'button',
						className: 'evrBtn evrBtnPrimary',
						disabled: props.busy,
						onClick: function () { props.onSoulSave(); },
					}, t('action.save')),
					props.status === undefined || props.status === null
						? null
						: h('span', { className: 'evrStatus' + (props.status.error ? ' evrStatusError' : ' evrStatusOk') }, props.status.message)),
				h('div', { className: 'evrSection' }, t('memory.list')),
				h('div', { className: 'evrHint', style: { marginBottom: '8px' } }, t('memory.hint')),
				h('div', { className: 'evrToolbar' },
					h('input', {
						className: 'evrInput',
						type: 'search',
						value: props.query ?? '',
						placeholder: t('memory.query'),
						onChange: function (event) { props.onQuery(event.target.value); },
					}),
					h('button', {
						type: 'button',
						className: 'evrBtn',
						disabled: props.busy,
						onClick: function () { props.onRecall(); },
					}, t('action.recall'))),
				memories.length === 0
					? h(Empty, null, t('memory.empty'))
					: h('div', null, memories.map(function (item) {
						return h('div', {
							key: item.id,
							className: 'evrRow',
							style: { cursor: 'default' },
						},
							h('div', { className: 'evrRowMain' },
								h('div', { className: 'evrRowTitle' }, item.text ?? ''),
								h('div', { className: 'evrRowMeta' },
									h('span', { className: 'evrTag' }, item.kind),
									h('span', null, item.scope ?? ''))),
							h('div', { className: 'evrRowTime' }, item.score === undefined ? '' : String(item.score)));
					})));
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

			var sectionBar = h('div', { className: 'evrToolbar', role: 'tablist' }, [
				{ id: 'data', label: t('settings.data') },
				{ id: 'transfer', label: t('settings.transfer') },
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
			var call = useCallback(function (endpoint, payload) { return callHost(ctx, endpoint, payload); }, [ctx]);

			var [tab, setTab] = useState('overview');
			var [overview, setOverview] = useState(null);
			var [injection, setInjection] = useState(null);
			var [practice, setPractice] = useState(null);
			var [soul, setSoul] = useState(null);
			var [preferences, setPreferences] = useState(null);
			var [settings, setSettings] = useState(null);
			var [settingsEpoch, setSettingsEpoch] = useState(0);
			var [memories, setMemories] = useState([]);
			var [kind, setKind] = useState('doc');
			var [editor, setEditor] = useState(null);
			var [status, setStatus] = useState(null);
			var [toast, setToast] = useState(null);
			var [busy, setBusy] = useState(false);
			var [error, setError] = useState(null);
			var [query, setQuery] = useState('');

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
					call('practice'),
					call('soul'),
					call('preferences'),
					call('memory-list', { limit: 20 }),
					call('settings'),
				]).then(function (results) {
					setOverview(results[0]);
					setInjection(results[1]);
					setPractice(results[2]);
					setSoul(results[3]);
					setPreferences(results[4]);
					setMemories(results[5]?.results ?? []);
					setSettings(results[6]);
					setError(null);
				}).catch(function (reason) {
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			}, [call]);

			useEffect(function () {
				void loadAll();
			}, [loadAll]);

			var refreshPractice = useCallback(function () {
				return call('practice').then(function (value) {
					setPractice(value);
					return value;
				});
			}, [call]);

			var openEntry = useCallback(function (path) {
				setBusy(true);
				return call('practice-read', { path: path }).then(function (entry) {
					setEditor({
						path: entry.path,
						kind: entry.kind,
						name: entry.path.split('/').pop(),
						topic: entry.topic,
						title: entry.title,
						purpose: entry.purpose,
						verified: entry.verified,
						links: entry.links ?? [],
						body: entry.content ?? '',
						truncated: entry.truncated === true,
					});
					setStatus(null);
				}).catch(function (reason) {
					report(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, report]);

			var newEntry = useCallback(function (entryKind) {
				setEditor({
					path: '',
					kind: entryKind,
					name: 'new-note.md',
					topic: '',
					title: '',
					purpose: '',
					verified: new Date().toISOString().slice(0, 10),
					links: [],
					body: '',
					truncated: false,
				});
				setStatus(null);
			}, []);

			var saveEntry = useCallback(function () {
				if (editor === null) return;
				setBusy(true);
				var payload = {
					kind: editor.kind,
					name: editor.name,
					title: editor.title,
					purpose: editor.purpose,
					topic: editor.topic,
					body: editor.body,
					verified: editor.verified,
					links: editor.links ?? [],
				};
				call('practice-write', payload).then(function (saved) {
					report(t('state.saved'), false);
					setEditor(function (previous) {
						return previous === null ? null : { ...previous, path: saved.path };
					});
					return Promise.all([refreshPractice(), call('injection')]).then(function (results) {
						setInjection(results[1]);
					});
				}).catch(function (reason) {
					report(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, editor, refreshPractice, report, t]);

			var deleteEntry = useCallback(function () {
				if (editor === null || editor.path === '') return;
				setBusy(true);
				call('practice-delete', { path: editor.path }).then(function () {
					setEditor(null);
					report(t('state.deleted'), false);
					return Promise.all([refreshPractice(), call('injection')]).then(function (results) {
						setInjection(results[1]);
					});
				}).catch(function (reason) {
					report(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, editor, refreshPractice, report, t]);

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

			var recall = useCallback(function () {
				setBusy(true);
				call('memory-recall', { query: query, limit: 20 }).then(function (value) {
					setMemories(value?.results ?? []);
				}).catch(function (reason) {
					report(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, query, report]);


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
				call('data-migrate', { dir: dir, force: force }).then(function (value) {
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
				call('data-export', { dir: dir, name: name, force: force }).then(function (value) {
					notify(t('state.exported') + ' → ' + String(value.file ?? dir) + ' · ' + String(value.files ?? 0) + ' · ' + formatBytes(value.bytes ?? 0), false);
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, report, t]);

			var importData = useCallback(function (dir, force) {
				setBusy(true);
				notify(t('state.working'), false);
				call('data-import', { file: dir, force: force }).then(function (value) {
					notify(t('state.imported') + ' · ' + String(value.files ?? 0) + ' · ' + formatBytes(value.bytes ?? 0) + (value.skipped > 0 ? ' · ' + t('state.skipped') + ' ' + value.skipped : ''), false);
					return loadAll();
				}).catch(function (reason) {
					notify(reason instanceof Error ? reason.message : String(reason), true);
				}).finally(function () { setBusy(false); });
			}, [call, loadAll, report, t]);

			var backupNow = useCallback(function () {
				setBusy(true);
				notify(t('state.working'), false);
				call('backup-now', { force: true }).then(function (value) {
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

			var body = null;
			if (error !== null) {
				body = h('div', { className: 'evrEmpty' },
					h('div', null, t('state.error')),
					h('div', { className: 'evrMono' }, error));
			} else if (tab === 'overview') {
				body = h(OverviewTab, { t: t, injection: injection, overview: overview });
			} else if (tab === 'practice') {
				body = h(PracticeTab, {
					t: t,
					state: practice,
					kind: kind,
					onKind: setKind,
					onNew: newEntry,
					onOpen: openEntry,
					selectedPath: editor?.path,
					editor: h(PracticeEditor, {
						t: t,
						draft: editor,
						onChange: function (patch) {
							setEditor(function (previous) {
								return previous === null ? null : { ...previous, ...patch };
							});
						},
						onSave: saveEntry,
						onDelete: deleteEntry,
						onClose: function () { setEditor(null); },
						busy: busy,
						status: status,
					}),
				});
			} else if (tab === 'sight') {
				body = h(SightTab, {
					t: t,
					soul: soul,
					onSoulChange: function (content) { setSoul(function (previous) { return { ...(previous ?? {}), content: content }; }); },
					onSoulSave: saveSoul,
					memories: memories,
					query: query,
					onQuery: setQuery,
					onRecall: recall,
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
					onClearSecret: clearBackupSecret,
					onMigrate: migrateData,
					onExport: exportData,
					onImport: importData,
					onBackupNow: backupNow,
					onTestBackup: testBackup,
					onPickDirectory: pickDirectory,
					onBrowseArchives: browseArchives,
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
