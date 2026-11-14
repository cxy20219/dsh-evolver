/*
 * 自衍中枢 — browser half.
 *
 * One sidebar entry opens one panel:
 * 概览 / 文件 / 图谱 / 设置 / 日志.
 *
 * The panel never sends a path: it sends ids and the Host resolves them. The
 * list and the detail are two views of the same file entity; the graph is the
 * explicit link graph, not an inferred similarity map.
 */
window.__ModuleLoader__.load({
	id: 'dsh-ziyan',
	factory: function (require) {
		var react = require('react');
		var h = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;
		var useCallback = react.useCallback;
		var useMemo = react.useMemo;
		var useRef = react.useRef;

		var NS = 'dsh-ziyan';
		var PANEL_ID = 'ziyan';
		var PANEL_ORDER = 31;
		var API_PREFIX = '/api/ziyan';
		var MAX_UPLOAD_MB = 20;

		//#region locale

		var zh = {
			panel: '自衍中枢',
			'tab.overview': '概览',
			'tab.files': '文件',
			'tab.graph': '图谱',
			'tab.injection': '注入',
			'tab.organize': '自衍',
			'tab.settings': '设置',
			'tab.logs': '日志',
			'injection.static': '系统段：静态纪律',
			'injection.tab.prompts': '提示词',
			'injection.tab.preferences': '偏好',
			'injection.total': '合计 {total} B：静态纪律 {static} B + 文件索引 {index} B（预算只管索引）',
			'preferences.hint': '这一段写在 DSH 的全局 AGENTS.md 里，由加载器在每次会话开始时注入；插件只碰自己那对标记之间的内容，文件里其他规则原样保留。',
			'preferences.file': '文件',
			'preferences.link': '这是个软链，实际写入它指向的文件，链接本身保留：{target}',
			'preferences.unreadable': '偏好文件读取失败，为避免覆盖原文件，保存已禁用；请检查文件权限后刷新。',
			'preferences.append': '这个文件已经存在且没有偏好段，第一次保存会把它接在文件末尾，不覆盖已有内容。',
			'preferences.dirty': '未保存',
			'preferences.reset': '撤销修改',
			'preferences.save': '保存',
			'preferences.saved': '偏好已保存',
			'injection.static.hint': '每轮请求都带，{bytes} 字节；它不发散，但会永久占住前缀。',
			'injection.index': '运行时上下文：文件索引',
			'injection.meta': '快照 {day} · {entries} 条候选 · {state}',
			'injection.never': '未生成',
			'injection.stale': '已过期，点下面的按钮重建',
			'injection.fresh': '当天',
			'injection.refresh': '重建快照',
			'injection.refreshed': '快照已重建',
			'organize.sessions': '会话',
			'organize.sessions.hint': '最近的会话日志，用来判断哪些对话还没沉淀成文件',
			'organize.sessions.total': '共 {n} 个会话，{m} 个太大读不出',
			'organize.session.turns': '{n} 轮提问',
			'organize.noSessions': '没有找到会话日志。',
			'organize.issues': '待整理',
			'organize.orphans': '孤立文件',
			'organize.orphans.hint': '没有任何出链和入链',
			'organize.dangling': '悬空链接',
			'organize.dangling.hint': '链接目标已经不在了',
			'organize.stale': '{days} 天没动过',
			'organize.stale.hint': '可以考虑归档',
			'organize.singleTags': '只用过一次的标签',
			'organize.singleTags.hint': '可能是拼写漂移，值得合并',
			'organize.empty': '这一类是空的',
			'organize.actions': '维护',
			'organize.rebuild': '重建索引',
			'organize.reload': '重新读取',
			'organize.rebuilt': '重建完成：{files} 个文件 · {links} 条链接 · {ms} ms',
			'action.refresh': '刷新',
			'action.save': '保存',
			'action.cancel': '取消',
			'action.upload': '上传文件',
			'action.create': '新建文件',
			'action.delete': '删除',
			'action.archive': '归档',
			'action.unarchive': '取消归档',
			'action.copy': '复制路径',
			'action.copied': '已复制',
			'files.search': '搜索描述 / 名字 / 标签…',
			'files.tag': '标签前缀',
			'files.mime': '全部类型',
			'files.archived': '显示归档',
			'files.empty': '还没有文件。',
			'files.select': '从列表选一个文件查看详情。',
			'files.total': '共 {n} 个',
			'files.page': '第 {a} / {b} 页',
			'files.prev': '上一页',
			'files.next': '下一页',
			'files.close': '关闭',
			'files.noMatch': '没有匹配的文件。',
			'files.clear': '清除筛选',
			'file.archived': '归档',
			'action.copyId': '复制 id',
			'file.description': '描述',
			'file.tags': '标签',
			'file.links': '出链',
			'file.linksEdit': '出链（完整 id 或唯一短 id，逗号/换行）',
			'file.linksResolved': '已解析出链',
			'file.backlinks': '反链',
			'file.content': '正文',
			'file.path': '路径',
			'file.size': '大小',
			'file.type': '类型',
			'file.updated': '更新',
			'file.degree': '度数',
			'file.id': 'id',
			'file.executable': '可执行',
			'file.missing': '文件本体缺失',
			'file.unsafe': '符号链接已拒绝',
			'overview.files': '文件',
			'overview.tags': '标签',
			'overview.days': '天数',
			'overview.filesHint': '活跃文件',
			'overview.tagsHint': '不同标签路径',
			'overview.daysHint': '自首个文件',
			'overview.heatmap': '记录热力',
			'overview.heatmap.hint': '记录 {notes} 个文件 · {days} 天有记录。',
			'overview.heatmap.empty': '还没有文件活动。',
			'overview.heatmap.unit': '个',
			'overview.heatmap.less': '少',
			'overview.heatmap.more': '多',
			'overview.heatmap.weekdays': '日,一,二,三,四,五,六',
			'overview.heatmap.monthSuffix': '月',
			'overview.types': '文件类型',
			'overview.types.hint': '按文件后缀分组，面积和绿色深浅表示数量',
			'overview.types.empty': '还没有文件。',
			'overview.types.none': '无后缀',
			'overview.types.open': '查看全部 {n} 文件',
			'overview.tagGraph.empty': '还没有标签。',
			'graph.tab.planet': '星球图',
			'graph.tab.relations': '关系图',
			'graph.tab.tags': '标签图',
			'graph.sphere.hint': '球面：拖拽旋转，滚轮缩放，点击节点打开文件',
			'graph.network.hint': '网状：拖拽平移，Shift + 拖拽旋转，滚轮缩放，点击节点打开文件',
			'graph.tags.hint': '标签层级；点击标签按它筛选文件',
			'graph.counts': '节点 {nodes} · 边 {edges}',
			'graph.hidden': '还有 {n} 个文件未画出',
			'graph.empty': '还没有文件。',
			'settings.dataDir': '数据目录',
			'settings.descriptionMaxChars': '描述上限（字）',
			'settings.maxFileMb': '单文件上限（MB）',
			'settings.readTextKb': '单次读取上限（KB）',
			'settings.injectionBudget': '注入预算（字节）',
			'settings.tab.general': '常规',
			'settings.tab.data': '数据',
			'settings.data.current': '当前数据目录',
			'settings.data.pending': '下次启动将使用',
			'settings.data.copy': '复制当前库到新目录',
			'settings.data.attach': '使用已有自衍中枢库',
			'settings.data.copyHint': '只复制 files/ 与设置；DB、索引、日志、回收站会重建。目标目录必须不存在。',
			'settings.data.attachHint': '目标目录必须已经包含 files/，不会复制或覆盖。',
			'settings.data.save': '保存目录',
			'settings.data.export': '导出 .tar.gz',
			'settings.data.exportHint': '包含 files/ 与设置，不包含 DB、索引、日志、回收站。',
			'settings.data.import': '导入 .tar.gz',
			'settings.data.importHint': '解压到新目录并切换，旧库保留；重启后生效。',
			'settings.data.importDir': '导入到目录（可选，留空自动新建）',
			'settings.data.restart': '重启后生效；当前会话继续使用旧库。',
			'settings.data.saved': '已写入数据目录指针，重启后生效。',
			'settings.data.exported': '已生成导出包',
			'settings.data.imported': '已导入，重启后生效。',
			'settings.data.choose': '选择文件',
			'upload.title': '上传文件',
			'create.title': '新建文本文件',
			'form.name': '文件名',
			'form.description': '描述（必填）',
			'form.tags': '标签（逗号分隔，至少一个）',
			'form.links': '关联文件 id（逗号或换行分隔）',
			'form.content': '正文',
			'state.loading': '加载中…',
			'state.failed': '加载失败',
			'msg.saved': '已保存',
			'msg.deleted': '已删除',
			'msg.archived': '已归档',
			'msg.unarchived': '已取消归档'
		};

		var en = {
			panel: 'Self-Evolving Hub',
			'tab.overview': 'Overview',
			'tab.files': 'Files',
			'tab.graph': 'Graph',
			'tab.injection': 'Injection',
			'tab.organize': 'Organize',
			'tab.settings': 'Settings',
			'tab.logs': 'Logs',
			'injection.static': 'System section: the fixed discipline',
			'injection.tab.prompts': 'Prompts',
			'injection.tab.preferences': 'Preferences',
			'injection.total': '{total} B total: {static} B discipline + {index} B index (the budget covers the index only)',
			'preferences.hint': 'This block lives in DSH global AGENTS.md and the loader injects it into every session. The plugin only touches what sits between its two markers; the rest of the file is left alone.',
			'preferences.file': 'File',
			'preferences.link': 'This is a symlink. The write lands on its target and the link stays: {target}',
			'preferences.unreadable': 'The preferences file could not be read. Saving is disabled so the original is not overwritten; check the file permissions and refresh.',
			'preferences.append': 'The file exists but has no preference block yet. The first save appends one at the end and leaves what is already there untouched.',
			'preferences.dirty': 'unsaved',
			'preferences.reset': 'Discard changes',
			'preferences.save': 'Save',
			'preferences.saved': 'Preferences saved',
			'injection.static.hint': 'Sent with every request, {bytes} bytes; it never changes, but it holds the prefix.',
			'injection.index': 'Runtime context: the file index',
			'injection.meta': 'Snapshot {day} · {entries} candidates · {state}',
			'injection.never': 'never built',
			'injection.stale': 'stale; rebuild it below',
			'injection.fresh': 'today',
			'injection.refresh': 'Rebuild snapshot',
			'injection.refreshed': 'Snapshot rebuilt',
			'organize.sessions': 'Sessions',
			'organize.sessions.hint': 'Recent session logs, to judge which conversations are not distilled into files yet',
			'organize.sessions.total': '{n} sessions, {m} too large to read',
			'organize.session.turns': '{n} prompts',
			'organize.noSessions': 'No session logs found.',
			'organize.issues': 'To organize',
			'organize.orphans': 'Orphans',
			'organize.orphans.hint': 'No incoming and no outgoing links',
			'organize.dangling': 'Dangling links',
			'organize.dangling.hint': 'The target no longer exists',
			'organize.stale': 'Untouched for {days} days',
			'organize.stale.hint': 'Consider archiving',
			'organize.singleTags': 'Tags used once',
			'organize.singleTags.hint': 'Often a spelling drift worth merging',
			'organize.empty': 'Nothing here',
			'organize.actions': 'Maintenance',
			'organize.rebuild': 'Rebuild index',
			'organize.reload': 'Reload',
			'organize.rebuilt': 'Rebuilt: {files} files · {links} links · {ms} ms',
			'action.refresh': 'Refresh',
			'action.save': 'Save',
			'action.cancel': 'Cancel',
			'action.upload': 'Upload',
			'action.create': 'New file',
			'action.delete': 'Delete',
			'action.archive': 'Archive',
			'action.unarchive': 'Unarchive',
			'action.copy': 'Copy path',
			'action.copied': 'Copied',
			'files.search': 'Search description / name / tags…',
			'files.tag': 'Tag prefix',
			'files.mime': 'All types',
			'files.archived': 'Show archived',
			'files.empty': 'No files yet.',
			'files.select': 'Select a file from the list.',
			'files.total': '{n} files',
			'files.page': 'Page {a} of {b}',
			'files.prev': 'Previous',
			'files.next': 'Next',
			'files.close': 'Close',
			'files.noMatch': 'No matching files.',
			'files.clear': 'Clear filters',
			'file.archived': 'Archived',
			'action.copyId': 'Copy id',
			'file.description': 'Description',
			'file.tags': 'Tags',
			'file.links': 'Links',
			'file.linksEdit': 'Links (full or unique short id, comma/newline)',
			'file.linksResolved': 'Resolved links',
			'file.backlinks': 'Backlinks',
			'file.content': 'Content',
			'file.path': 'Path',
			'file.size': 'Size',
			'file.type': 'Type',
			'file.updated': 'Updated',
			'file.degree': 'Degree',
			'file.id': 'id',
			'file.executable': 'Executable',
			'file.missing': 'Payload missing',
			'file.unsafe': 'Symlink refused',
			'overview.files': 'Files',
			'overview.tags': 'Tags',
			'overview.days': 'Days',
			'overview.filesHint': 'Live files',
			'overview.tagsHint': 'Distinct tag paths',
			'overview.daysHint': 'Since first file',
			'overview.heatmap': 'Activity',
			'overview.heatmap.hint': '{notes} files · {days} active days.',
			'overview.heatmap.empty': 'No file activity yet.',
			'overview.heatmap.unit': 'files',
			'overview.heatmap.less': 'Less',
			'overview.heatmap.more': 'More',
			'overview.heatmap.weekdays': 'S,M,T,W,T,F,S',
			'overview.heatmap.monthSuffix': '',
			'overview.types': 'File types',
			'overview.types.hint': 'Grouped by suffix; area and green depth show count',
			'overview.types.empty': 'No files yet.',
			'overview.types.none': 'no suffix',
			'overview.types.open': 'Show all {n} files',
			'overview.tagGraph.empty': 'No tags yet.',
			'graph.tab.planet': 'Sphere',
			'graph.tab.relations': 'Network',
			'graph.tab.tags': 'Tags',
			'graph.sphere.hint': 'Sphere: drag to rotate, wheel to zoom, click a node to open it',
			'graph.network.hint': 'Network: drag to pan, Shift + drag to rotate, wheel to zoom, click a node to open it',
			'graph.tags.hint': 'Tag hierarchy; click a tag to filter files by it',
			'graph.counts': '{nodes} nodes · {edges} links',
			'graph.hidden': '{n} more files are not drawn',
			'graph.empty': 'No files yet.',
			'settings.dataDir': 'Data directory',
			'settings.descriptionMaxChars': 'Description cap',
			'settings.maxFileMb': 'File cap (MB)',
			'settings.readTextKb': 'Read cap (KB)',
			'settings.injectionBudget': 'Injection budget (bytes)',
			'settings.tab.general': 'General',
			'settings.tab.data': 'Data',
			'settings.data.current': 'Current data directory',
			'settings.data.pending': 'Next start will use',
			'settings.data.copy': 'Copy this library',
			'settings.data.attach': 'Use an existing library',
			'settings.data.copyHint': 'Copies files/ and settings only; DB, index, logs and trash are rebuilt. The target must not exist.',
			'settings.data.attachHint': 'The target must already contain files/. Nothing is copied or overwritten.',
			'settings.data.save': 'Save directory',
			'settings.data.export': 'Export .tar.gz',
			'settings.data.exportHint': 'Includes files/ and settings, not the DB, index, logs or trash.',
			'settings.data.import': 'Import .tar.gz',
			'settings.data.importHint': 'Extracts to a new library and switches; the old library is kept. Restart to apply.',
			'settings.data.importDir': 'Import to directory (optional)',
			'settings.data.restart': 'Takes effect after a restart; this session keeps the old library.',
			'settings.data.saved': 'Data-directory pointer saved; restart to apply.',
			'settings.data.exported': 'Export created',
			'settings.data.imported': 'Imported; restart to apply.',
			'settings.data.choose': 'Choose file',
			'upload.title': 'Upload file',
			'create.title': 'New text file',
			'form.name': 'File name',
			'form.description': 'Description (required)',
			'form.tags': 'Tags (comma separated, at least one)',
			'form.links': 'Linked ids (comma or newline)',
			'form.content': 'Content',
			'state.loading': 'Loading…',
			'state.failed': 'Failed to load',
			'msg.saved': 'Saved',
			'msg.deleted': 'Deleted',
			'msg.archived': 'Archived',
			'msg.unarchived': 'Unarchived'
		};

		en = Object.assign({}, zh, en);

		//#endregion

		//#region styles

		var css = [
			'.ysRoot{height:100%;display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}',
			'.ysHead{display:flex;align-items:flex-start;gap:16px;padding:22px 28px 0;flex:none}',
			'.ysHeadMain{flex:1;min-width:0}',
			'.ysTitle{margin:0;font-size:18px;font-weight:600;line-height:26px;letter-spacing:-.01em}',
			'.ysVersion{margin-left:8px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary);vertical-align:2px}',
			'.ysSubtitle{margin-top:3px;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.ysHeadActions{display:flex;align-items:center;gap:8px;flex:none;padding-top:3px}',
			'.ysTabs{display:flex;gap:4px;padding:16px 28px 0;flex:none;flex-wrap:wrap}',
			'.ysSubtabs{padding:0 0 12px}',
			'.ysTab{display:inline-flex;align-items:center;height:28px;padding:0 11px;border:1px solid transparent;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}',
			'.ysTab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.ysTabActive{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500;border-color:var(--dsw-alias-border-l2)}',
			'.ysBody{flex:1;min-height:0;overflow:auto;padding:18px 28px 36px}',
			'.ysGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}',
			'.ysCard{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:14px 16px}',
			'.ysStatValue{font-size:22px;font-weight:600;line-height:28px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}',
			'.ysStatLabel{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px}',
			'.ysStatHint{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:1px}',
			'.ysGridThree{grid-template-columns:repeat(3,minmax(0,1fr))}',
			'@media(max-width:600px){.ysGridThree{grid-template-columns:1fr}}',
			'.ysSection{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin:22px 0 10px;display:flex;align-items:center;gap:10px}',
			'.ysSection::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l2)}',
			'.ysToolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}',
			'.ysInput,.ysSelect,.ysTextarea{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;padding:6px 9px;min-width:0}',
			'.ysInput{flex:1;min-width:160px}.ysInput:focus,.ysSelect:focus,.ysTextarea:focus{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}',
			'.ysTextarea{width:100%;resize:vertical;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.55}',
			'.ysButton{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}',
			'.ysButton:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l3)}',
			'.ysButton:disabled{opacity:.5;cursor:default}',
			'.ysButtonPrimary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}',
			'.ysButtonPrimary:hover{background:var(--dsw-alias-button-primary-hover);border-color:transparent}',
			'.ysButtonDanger{color:var(--dsw-alias-state-error-primary,#c45a5a)}',
			'.ysCheck{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
			'.ysFiles{display:flex;flex-direction:column;height:100%;min-height:0}',
			'.ysListWrap{flex:1;min-height:0}',
			'.ysPager{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:10px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
			'.ysSheetMask{position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,.26);z-index:55;display:flex;justify-content:flex-end}',
			'.ysSheet{width:min(720px,94vw);height:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-soft);overflow:auto;padding:12px 20px 28px}',
			'.ysSheetBar{display:flex;justify-content:flex-end;margin-bottom:4px;position:sticky;top:0;background:var(--dsw-alias-bg-base);padding:4px 0;z-index:1}',
			'@media(max-width:900px){.ysItem{max-height:none}}',
			'.ysList{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden;height:100%;display:flex;flex-direction:column}',
			'.ysItem{display:flex;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);cursor:pointer;flex:1 1 0;min-height:0;max-height:150px;overflow:hidden}',
			'.ysItem:last-child{border-bottom:none}',
			'.ysItem:hover{background:var(--dsw-alias-bg-layer-2)}',
			'.ysItemActive{background:var(--dsw-alias-interactive-bg-active)}',
			'.ysItemMain{flex:1;min-width:0}',
			'.ysItemTitle{font-size:13px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.ysItemDesc{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.ysItemMeta{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.ysTags{display:flex;gap:4px;flex-wrap:wrap;margin-top:5px}',
			'.ysTag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;white-space:nowrap}',
			'.ysDetail{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:16px 18px;min-width:0}',
			'.ysDetailHead{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}',
			'.ysDetailTitle{font-size:16px;font-weight:600;line-height:22px;word-break:break-all;flex:1}',
			'.ysDetailId{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-family-mono,ui-monospace,monospace);word-break:break-all;margin-top:2px}',
			'.ysMetaGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:6px 16px;margin:10px 0 14px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
			'.ysMetaKey{color:var(--dsw-alias-label-tertiary)}',
			'.ysField{margin-bottom:12px}',
			'.ysLabel{display:block;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:5px}',
			'.ysInputWide{width:100%;box-sizing:border-box}',
			'.ysPre{max-height:340px;overflow:auto;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}',
			'.ysPreview{max-width:100%;max-height:420px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);display:block}',
			'.ysActions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:12px;padding-bottom:4px;border-top:1px solid var(--dsw-alias-border-l2);position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-1)}',
			'.ysNeighbor{display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left;border:none;background:transparent;font-family:inherit}',
			'.ysNeighbor:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}',
			'.ysTypeMatrix{position:relative;width:100%;height:420px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);overflow:hidden;background:var(--dsw-alias-bg-layer-2)}',
			'.ysTypeTile{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;justify-content:flex-end;gap:2px;padding:10px 12px;border:none;text-align:left;font-family:inherit;background:var(--dsw-alias-bg-layer-2);color:#173b27;overflow:hidden;box-shadow:inset 0 0 0 2px var(--dsw-alias-bg-layer-1);cursor:pointer}',
			'.ysTypeTile:hover{box-shadow:inset 0 0 0 2px var(--dsw-alias-label-tertiary)}',
			'.ysTypeTile:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:-4px}',
			'.ysTypeTileName{font-size:12px;font-weight:600;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.ysTypeTileValue{font-size:10.5px;line-height:14px;opacity:.72;font-variant-numeric:tabular-nums;white-space:nowrap}',
			'.ysOverview{display:flex;flex-direction:column;height:100%;min-height:0}',
			'.ysOverviewTypes{display:flex;flex-direction:column;flex:1;min-height:140px}',
			'.ysOverviewTypes .ysTypeMatrix{flex:1;height:auto;min-height:0}',
			'@media(max-width:700px){.ysTypeMatrix{height:300px}}',
			'.ysHeatmapWrap{--ys-heat-gap:2px;overflow-x:auto;padding:2px 0}',
			'.ysHeatmapBody{display:grid;grid-template-columns:12px minmax(0,1fr);gap:6px;align-items:stretch}',
			'.ysHeatmapDays{display:grid;grid-template-rows:repeat(7,1fr);font-size:9px;color:var(--dsw-alias-label-tertiary);text-align:right}',
			'.ysHeatmapDays span{display:flex;align-items:center;justify-content:flex-end}',
			'.ysHeatmapMonths{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(7px,1fr);gap:var(--ys-heat-gap);margin-left:18px;margin-bottom:4px;font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
			'.ysHeatmap{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(7px,1fr);gap:var(--ys-heat-gap)}',
			'.ysHeatmapWeek{display:grid;grid-template-rows:repeat(7,auto);gap:var(--ys-heat-gap)}',
			'.ysHeatCell{width:100%;aspect-ratio:1;border-radius:3px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);box-sizing:border-box}',
			'.ysHeatBlank{background:none;border-color:transparent}',
			'.ysHeat1{background:rgba(72,187,120,.28)}',
			'.ysHeat2{background:rgba(72,187,120,.55)}',
			'.ysHeat3{background:rgba(47,174,114,.85)}',
			'.ysHeat4{background:rgba(24,120,74,.95)}',
			'.ysHeat0{background:var(--dsw-alias-bg-layer-3)}',
			'.ysHeatLegend{display:flex;align-items:center;gap:4px;margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.ysHeatLegend .ysHeatCell{width:10px;height:10px;flex:none}',
			'.ysTagGraphWrap{position:relative;min-height:220px}',
			'.ysTagGraph{width:100%;height:auto;max-width:520px;display:block;margin:0 auto;overflow:visible}',
			'.ysTagEdge{fill:none;stroke-width:1;stroke-opacity:.45}',
			'.ysTagDot{fill:var(--dsw-alias-bg-base);stroke-width:1.2}',
			'.ysTagDotRoot{fill:var(--dsw-alias-bg-base);stroke-width:1.6}',
			'.ysTagHub{fill:var(--dsw-alias-label-tertiary)}',
			'.ysTagLabel{fill:var(--dsw-alias-label-secondary);font-size:11px;font-family:inherit;cursor:pointer;user-select:none}',
			'.ysTagRoot{fill:var(--dsw-alias-label-primary);font-size:12px;font-weight:500}',
			'.ysTagGraphNode{cursor:pointer}',
			'.ysTagGraphNode:hover .ysTagLabel,.ysTagGraphNode:focus .ysTagLabel{fill:var(--dsw-alias-label-primary)}',
			'.ysTagGraphNode:focus{outline:none}',
			'.ysCanvasWrap{position:relative}',
			'.ysCanvas{display:block;width:100%;height:min(62vh,560px);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);touch-action:none;cursor:grab;outline:none}',
			'.ysCanvas:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
			'@media(max-width:700px){.ysCanvas{height:420px}}',
			'.ysEmpty{padding:28px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}',
			'.ysError{display:flex;align-items:center;gap:10px;padding:9px 12px;margin-bottom:12px;border:1px solid var(--dsw-alias-state-error-primary,#c45a5a);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-state-error-primary,#c45a5a);font-size:12px}',
			'.ysHint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.55}',
			'.ysPre{margin:0 0 18px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;max-height:340px;overflow:auto}',
			'.ysMeter{position:relative;height:22px;border-radius:11px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;margin:8px 0}',
			'.ysMeterFill{position:absolute;top:0;bottom:0;left:0;background:rgba(47,174,114,.34)}',
			'.ysMeterText{position:relative;display:block;text-align:center;font-size:11px;line-height:22px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
			'.ysIssueGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:10px 0 18px}',
			'.ysIssue{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:12px 14px;min-width:0}',
			'.ysIssueTitle{font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.ysIssueCount{font-size:24px;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums}',
			'.ysIssueHint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.ysIssueList{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}',
			'.ysIssueItem{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}',
			'.ysIssueItem:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}',
			'.ysSessionRow{display:flex;align-items:baseline;gap:10px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}',
			'.ysSessionTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
			'.ysSessionMeta{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}',
			'.ysToast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:60;padding:8px 14px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font-size:12px;box-shadow:var(--dsw-elevation-soft);max-width:70%}',
			'.ysToastError{background:var(--dsw-alias-state-error-primary,#b34545);color:#fff}',
			'.ysModal{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:24px}',
			'.ysModalCard{width:min(560px,100%);max-height:90vh;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-soft)}',
			'.ysModalHead{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l2);font-weight:600}',
			'.ysModalBody{padding:16px 18px}',
			'.ysModalFoot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l2)}',
			'.ysClose{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:18px;line-height:1;cursor:pointer}',
		].join('\n');

		//#endregion

		//#region helpers

		function callHost(ctx, endpoint, payload, timeoutMs) {
			if (ctx.get('connection') === undefined) return Promise.reject(new Error('连接不可用'));
			var options = {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload || {}),
				credentials: 'same-origin'
			};
			if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
				options.signal = AbortSignal.timeout(typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30000);
			}
			return fetch(API_PREFIX + '/' + endpoint, options).then(function (response) {
				return response.json().catch(function () {
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
					throw new Error('请求超时');
				}
				throw reason;
			});
		}

		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		function formatBytes(size) {
			var value = Number(size);
			if (!Number.isFinite(value)) return '—';
			if (value < 1024) return value + ' B';
			if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
			return (value / 1024 / 1024).toFixed(1) + ' MB';
		}

		function relativeTime(iso) {
			var at = Date.parse(String(iso || ''));
			if (!Number.isFinite(at)) return '';
			var delta = Date.now() - at;
			if (delta < 60000) return '刚刚';
			if (delta < 3600000) return Math.floor(delta / 60000) + ' 分钟前';
			if (delta < 86400000) return Math.floor(delta / 3600000) + ' 小时前';
			return Math.floor(delta / 86400000) + ' 天前';
		}

		function shortId(id) {
			return String(id || '').slice(-6);
		}

		function typeLabel(mime) {
			var value = String(mime || '');
			if (value === 'text/markdown') return 'md';
			if (value === 'text/plain') return 'txt';
			if (value === 'application/json') return 'json';
			if (value === 'application/pdf') return 'pdf';
			if (value.indexOf('wordprocessingml') >= 0) return 'docx';
			if (value.indexOf('spreadsheetml') >= 0) return 'xlsx';
			if (value.indexOf('presentationml') >= 0) return 'pptx';
			if (value.indexOf('image/') === 0) return 'img';
			if (value.indexOf('audio/') === 0) return 'audio';
			if (value.indexOf('video/') === 0) return 'video';
			if (value.indexOf('text/') === 0) return value.slice(5).slice(0, 8);
			if (value.indexOf('application/') === 0) return value.slice(12).split('+')[0].slice(0, 8);
			return value.slice(0, 8) || 'file';
		}

		function typeColor(mime) {
			var value = String(mime || '');
			if (value.indexOf('image/') === 0) return '#d29a62';
			if (value === 'application/pdf') return '#c97373';
			if (value.indexOf('video/') === 0 || value.indexOf('audio/') === 0) return '#9d7bb0';
			if (value === 'application/x-sh' || value === 'text/x-python' || value === 'text/javascript' || value === 'application/typescript') return '#6fae86';
			if (value.indexOf('text/') === 0 || value === 'application/json') return '#6d93c9';
			return '#8a8f98';
		}

		function splitText(value) {
			return String(value || '').split(/[,，\n]/).map(function (item) { return item.trim(); }).filter(function (item) { return item !== ''; });
		}

		function draftDirty(detail, draft) {
			if (detail === null || detail === undefined || draft === null || draft === undefined) return false;
			var contentDirty = detail.text !== undefined && detail.truncated !== true && draft.content !== (detail.text || '');
			return draft.description !== (detail.description || '')
				|| draft.tags !== (detail.tags || []).join(', ')
				|| draft.links !== (detail.links || []).join('\n')
				|| contentDirty;
		}

		function fieldValue(state, setState, key) {
			return {
				value: state[key] || '',
				onChange: function (event) {
					var next = Object.assign({}, state);
					next[key] = event.target.value;
					setState(next);
				}
			};
		}

		//#endregion

		//#region canvas graph

		/*
		 * The two canvas layouts started as a port of 万象知识库
		 * (dsh-wanxiang-knowledge): the globe puts every file on one sphere,
		 * grouped into clusters that stay together; the network is a force layout
		 * of the same nodes and links.
		 *
		 * Where this departs from the original, and why:
		 *
		 * - Size and mass come from the degree normalised against the busiest
		 *   file (`radiusOf` / `massOf`), not from a log curve. The original
		 *   mapped degree through `log2` and capped it, which on a flat library
		 *   leaves every dot within a pixel of every other.
		 * - The globe is relaxed by its own forces instead of only being seeded
		 *   (`SphereLayout`): the original's `cloudOffset` piles a community's
		 *   dots into the centre of its cap.
		 *
		 * The data model also differs, so the adapter is here: ziyan's cluster is
		 * the first tag root that is not the synthetic `测试` marker or the `类型`
		 * facet, and the node colour is the same MIME palette the list uses.
		 */

		/**
		 * The cluster one file belongs to, for the globe's grouping.
		 *
		 * @param {object} node - A graph node.
		 * @returns {string} The cluster root.
		 */
		function clusterOf(node) {
			var tags = node.tags || [];
			for (var index = 0; index < tags.length; index += 1) {
				var root = String(tags[index]).split('/')[0];
				if (root !== '测试' && root !== '类型') return root;
			}
			return tags.length > 0 ? String(tags[0]).split('/')[0] : '其他';
		}

		/**
		 * Turn one `/api/ziyan/graph` payload into what the canvas engine eats.
		 *
		 * @param {object} graph - The host payload.
		 * @returns {{nodes: object[], edges: object[]}} The canvas data.
		 */
		function canvasGraphData(graph) {
			var nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
			var edges = Array.isArray(graph && graph.edges) ? graph.edges : [];
			var known = new Set(nodes.map(function (node) { return node.id; }));
			var degrees = nodes.map(function (node) { return node.degree ? node.degree.in + node.degree.out : 0; });
			var top = degrees.reduce(function (best, degree) { return Math.max(best, degree); }, 0);
			return {
				nodes: nodes.map(function (node, index) {
					var degree = degrees[index];
					// Normalised against the busiest dot, the way old evolver did
					// it: the ranking is the same as `degree`, but the scale
					// adapts to the library instead of to a fixed log curve.
					var weight = top === 0 ? 0 : degree / top;
					return {
						id: node.id,
						title: node.name,
						description: node.description,
						mime: node.mime,
						color: typeColor(node.mime),
						cluster: clusterOf(node),
						degree: degree,
						weight: weight,
						mass: massOf(weight),
						radius: radiusOf(weight)
					};
				}),
				edges: edges
					.filter(function (edge) { return known.has(edge.from) && known.has(edge.to); })
					.map(function (edge) { return { s: edge.from, t: edge.to, w: 1 }; })
			};
		}

		function rotatePoint(point, angle) {
			var cosine = Math.cos(angle);
			var sine = Math.sin(angle);
			return { x: point.x * cosine - point.y * sine, y: point.x * sine + point.y * cosine };
		}

		function rotationRadians(degrees) {
			if (!Number.isFinite(degrees)) return 0;
			var wrapped = ((degrees + 180) % 360 + 360) % 360 - 180;
			return (wrapped === -180 && degrees > 0 ? 180 : wrapped) * Math.PI / 180;
		}

		function rotatedExtent(extent, angle) {
			var cosine = Math.abs(Math.cos(angle));
			var sine = Math.abs(Math.sin(angle));
			return { x: extent.x * cosine + extent.y * sine, y: extent.x * sine + extent.y * cosine };
		}

		var GOLDEN = Math.PI * (3 - Math.sqrt(5));

		function fibonacciPoint(index, count) {
			var y = 1 - 2 * (index + 0.5) / count;
			var radius = Math.sqrt(Math.max(0, 1 - y * y));
			return { x: radius * Math.cos(index * GOLDEN), y: y, z: radius * Math.sin(index * GOLDEN) };
		}

		function variationOf(id) {
			var hash = 2166136261;
			for (var index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
			return (hash >>> 0) / 4294967296;
		}

		function cloudOffset(index, count, id) {
			var angle = index * GOLDEN + (variationOf(id) - 0.5) * 0.65;
			var contour = 1 + 0.12 * Math.sin(angle * 3 + 0.7) + 0.07 * Math.cos(angle * 5);
			var radius = Math.pow((index + 0.5) / count, 0.66) * contour;
			return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
		}

		/**
		 * Group nodes by cluster, biggest cluster first, busiest node first.
		 *
		 * @param {object[]} nodes - The nodes.
		 * @returns {object[][]} The groups.
		 */
		function communitiesOf(nodes) {
			var groups = new Map();
			for (var index = 0; index < nodes.length; index += 1) {
				var node = nodes[index];
				var members = groups.get(node.cluster) || [];
				members.push(node);
				groups.set(node.cluster, members);
			}
			return Array.from(groups.values())
				.sort(function (left, right) {
					return right.length - left.length || String(left[0].cluster).localeCompare(String(right[0].cluster));
				})
				.map(function (members) {
					return members.slice().sort(function (left, right) {
						return right.degree - left.degree || String(left.id).localeCompare(String(right.id));
					});
				});
		}

		/**
		 * Seat every node on one sphere, each cluster inside its own cap.
		 *
		 * @param {object[]} nodes - The nodes.
		 * @returns {object[]} The nodes with `x/y/z`.
		 */
		function sphereLayout(nodes) {
			var groups = communitiesOf(nodes);
			var seeds = groups.map(function (_, index) { return fibonacciPoint(index, groups.length); });
			var forward = seeds.reduce(function (sum, seed, index) {
				return {
					x: sum.x + seed.x * groups[index].length,
					y: sum.y + seed.y * groups[index].length,
					z: sum.z + seed.z * groups[index].length
				};
			}, { x: 0, y: 0, z: 0 });
			function normalize(point) {
				var length = Math.hypot(point.x, point.y, point.z) || 1;
				return { x: point.x / length, y: point.y / length, z: point.z / length };
			}
			var front = normalize(forward);
			var right = Math.hypot(front.x, front.z) > 1e-3
				? normalize({ x: front.z, y: 0, z: -front.x })
				: { x: 1, y: 0, z: 0 };
			var up = { x: front.y * right.z, y: front.z * right.x - front.x * right.z, z: -front.y * right.x };
			function dot(a, b) {
				return a.x * b.x + a.y * b.y + a.z * b.z;
			}
			var assigned = new Map();
			groups.forEach(function (members, index) {
				var center = seeds[index];
				var tangent = normalize({ x: -center.z, y: 0, z: center.x });
				var bitangent = {
					x: center.y * tangent.z,
					y: center.z * tangent.x - center.x * tangent.z,
					z: -center.y * tangent.x
				};
				var spread = Math.min(0.95, 0.22 + 0.76 * Math.sqrt(members.length / nodes.length));
				members.forEach(function (node, local) {
					var offset = cloudOffset(local, members.length, node.id);
					var radius = Math.hypot(offset.x, offset.y);
					var angle = spread * radius;
					var factor = radius > 0 ? Math.sin(angle) / radius : 0;
					var point = groups.length === 1 ? fibonacciPoint(local, members.length) : {
						x: center.x * Math.cos(angle) + (tangent.x * offset.x + bitangent.x * offset.y) * factor,
						y: center.y * Math.cos(angle) + (tangent.y * offset.x + bitangent.y * offset.y) * factor,
						z: center.z * Math.cos(angle) + (tangent.z * offset.x + bitangent.z * offset.y) * factor
					};
					var position = groups.length === 1 ? point : { x: dot(point, right), y: dot(point, up), z: dot(point, front) };
					assigned.set(node.id, { id: node.id, x: position.x, y: position.y, z: position.z, cluster: node.cluster });
				});
			});
			return nodes.map(function (node) { return assigned.get(node.id); });
		}

		/**
		 * The dot radius for a normalised degree.
		 *
		 * The ported formula was `2.3 + log2(1 + degree) * 0.32` capped at 4.6,
		 * which on the live library (2200 files, 3035 links, busiest dot 17)
		 * squeezes everything into 2.3–4.6 px: 2089 of 2200 dots land between
		 * 2.5 and 3.1 px, so the files that hold the library together look
		 * exactly like the leaves. Mapping 0–1 over the same span instead
		 * spreads those same dots over 2.2–7.8 px, which is what "the more
		 * links, the bigger the dot" has to mean to be visible at all.
		 *
		 * @param {number} weight - Degree divided by the busiest degree, 0–1.
		 * @returns {number} The base radius in pixels, before the globe's perspective.
		 */
		function radiusOf(weight) {
			return 2.2 + 5.6 * Math.pow(weight, 0.75);
		}

		/**
		 * The mass for a normalised degree: what a dot weighs when forces meet.
		 *
		 * A hub is heavy in both senses the request asks for — it pushes its
		 * neighbours away (repulsion is the mass product) and the springs move
		 * it less (acceleration is force over mass), so the leaves arrange
		 * themselves around it instead of dragging it along.
		 *
		 * @param {number} weight - Degree divided by the busiest degree, 0–1.
		 * @returns {number} A mass in 0.6–1.5.
		 */
		function massOf(weight) {
			return 0.6 + 0.9 * weight;
		}

		/**
		 * The globe's forces.
		 *
		 * The cap seeding above answers "which patch of the sphere does this
		 * cluster sit on"; it says nothing about where the dots sit inside it,
		 * which is why the old globe read as a printed star chart — `cloudOffset`
		 * is densest at the centre of every cap, so the middle of each community
		 * was a pile of overlapping dots.
		 *
		 * This relaxes the seeded positions with the ingredients the 关系图 uses
		 * — springs, near-range repulsion, an anchor back to the community — and
		 * two rules that the seed makes necessary:
		 *
		 * - Springs only work on links whose two ends were seeded near each other
		 *   (chord under 0.45). A link across two caps is a *bridge*, and pulling
		 *   it to spring length is exactly what dragged the whole globe into one
		 *   knot when this ran with every link: measured median drift from the
		 *   seed was 1.6 rad, i.e. half the ball.
		 * - Every step is projected back onto the unit sphere, keeping only the
		 *   tangential velocity. Without it the springs flatten the ball into a disc.
		 *
		 * Deterministic like the rest of the engine: `alpha` is the only clock.
		 */
		class SphereLayout {
			constructor(nodes, edges) {
				var byId = new Map(nodes.map(function (node) { return [node.id, node]; }));
				this.alpha = 1;
				this.particles = sphereLayout(nodes).map(function (point) {
					var node = byId.get(point.id);
					return {
						id: point.id,
						x: point.x,
						y: point.y,
						z: point.z,
						// The seeded position is the anchor: the relaxation may move
						// a dot, but it may not reshuffle the communities.
						sx: point.x,
						sy: point.y,
						sz: point.z,
						vx: 0,
						vy: 0,
						vz: 0,
						cluster: node.cluster,
						weight: node.weight,
						mass: node.mass
					};
				});
				this.byId = new Map(this.particles.map(function (particle) { return [particle.id, particle]; }));
				// A link is a spring when both ends live in the same community: a
				// bridge between two caps must not pull them together. The rest
				// length is a fixed fraction of where the seeding put the pair, so
				// the tightening means the same thing on a 40-file library and on a
				// 2000-file one — an absolute cutoff would drop every link on the
				// small one and only the bridges on the big one.
				this.links = [];
				edges.forEach(function (edge) {
					var left = this.byId.get(edge.s);
					var right = this.byId.get(edge.t);
					if (left === undefined || right === undefined) return;
					if (left.cluster !== right.cluster) return;
					var chord = Math.hypot(right.sx - left.sx, right.sy - left.sy, right.sz - left.sz);
					this.links.push([left, right, edge.w, chord * 0.6]);
				}, this);
			}

			tick() {
				if (this.alpha < 5e-3) return;
				var alpha = this.alpha;
				this.links.forEach(function (link) {
					var left = link[0];
					var right = link[1];
					var dx = right.x - left.x;
					var dy = right.y - left.y;
					var dz = right.z - left.z;
					var distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
					if (distance < 1e-6) return;
					var pull = (distance - link[3]) * 0.05 * Math.min(link[2], 2) * alpha;
					left.vx += (dx / distance) * pull / left.mass;
					left.vy += (dy / distance) * pull / left.mass;
					left.vz += (dz / distance) * pull / left.mass;
					right.vx -= (dx / distance) * pull / right.mass;
					right.vy -= (dy / distance) * pull / right.mass;
					right.vz -= (dz / distance) * pull / right.mass;
				});
				// Repulsion runs on a 0.12-unit lattice: 27 candidate cells per dot,
				// so the sweep walks the 13 *forward* cells only and lets every pair
				// meet exactly once (in its own cell, from the lower index).
				var cells = new Array(32768);
				var occupied = [];
				this.particles.forEach(function (particle) {
					var key = cellKey(particle);
					particle.cell = key;
					var list = cells[key];
					if (list === undefined) {
						occupied.push(key);
						cells[key] = [particle];
					} else list.push(particle);
				});
				occupied.forEach(function (key) {
					var list = cells[key];
					for (var index = 0; index < list.length; index += 1) {
						var particle = list[index];
						for (var after = index + 1; after < list.length; after += 1) {
							pushApart(particle, list[after], alpha);
						}
						for (var near = 0; near < CELL_NEIGHBOURS.length; near += 1) {
							var peers = cells[key + CELL_NEIGHBOURS[near]];
							if (peers === undefined) continue;
							for (var peer = 0; peer < peers.length; peer += 1) {
								pushApart(particle, peers[peer], alpha);
							}
						}
					}
				});
				this.particles.forEach(function (particle) {
					// The anchor is what keeps the communities where the seeding put
					// them; the mass already decides who wins when forces disagree.
					var strength = 0.09 * alpha;
					particle.vx += (particle.sx - particle.x) * strength;
					particle.vy += (particle.sy - particle.y) * strength;
					particle.vz += (particle.sz - particle.z) * strength;
					particle.x += particle.vx * 0.4;
					particle.y += particle.vy * 0.4;
					particle.z += particle.vz * 0.4;
					// Back onto the surface, then keep only the tangential part of
					// the velocity: the radial part was just spent as position.
					var length = Math.sqrt(particle.x * particle.x + particle.y * particle.y + particle.z * particle.z) || 1;
					particle.x /= length;
					particle.y /= length;
					particle.z /= length;
					var radial = particle.vx * particle.x + particle.vy * particle.y + particle.vz * particle.z;
					particle.vx = (particle.vx - radial * particle.x) * 0.82;
					particle.vy = (particle.vy - radial * particle.y) * 0.82;
					particle.vz = (particle.vz - radial * particle.z) * 0.82;
				});
				this.alpha *= 0.94;
			}
		}

		/**
		 * The lattice cell a globe particle falls in, as one integer.
		 *
		 * @param {{x: number, y: number, z: number}} point - A point on the unit sphere.
		 * @returns {number} The cell key.
		 */
		function cellKey(point) {
			var size = 0.12;
			return ((Math.floor(point.x / size) + 16) * 32 + Math.floor(point.y / size) + 16) * 32 + Math.floor(point.z / size) + 16;
		}

		/**
		 * The 13 forward cells of a 3×3×3 sweep, as key offsets.
		 *
		 * A cell is `((x)·32 + y)·32 + z`, so one step along x is 1024, one along
		 * y is 32 and one along z is 1.
		 */
		var CELL_NEIGHBOURS = [1024 + 32 + 1, 1024 + 32, 1024 + 32 - 1, 1024 + 1, 1024, 1024 - 1, 1024 - 32 + 1, 1024 - 32, 1024 - 32 - 1, 32 + 1, 32, 32 - 1, 1];

		/**
		 * Push one pair of globe dots apart when they share a cell.
		 *
		 * Symmetric, and each end moves by force over its own mass: the hub is
		 * shoved just as hard as the leaf, but it barely budges, so the leaves
		 * arrange themselves around it instead of dragging it along.
		 *
		 * @param {object} left - One particle.
		 * @param {object} right - The other particle.
		 * @param {number} alpha - The cooling factor.
		 * @returns {void}
		 */
		function pushApart(left, right, alpha) {
			var dx = left.x - right.x;
			var dy = left.y - right.y;
			var dz = left.z - right.z;
			var square = dx * dx + dy * dy + dz * dz;
			if (square > 0.0144 || square < 1e-12) return;
			var distance = Math.sqrt(square);
			// Soft at contact: a pair that touched exactly would launch itself.
			var push = alpha * 0.005 * left.mass * right.mass * (0.12 - distance) / (distance + 0.02);
			left.vx += (dx / distance) * push / left.mass;
			left.vy += (dy / distance) * push / left.mass;
			left.vz += (dz / distance) * push / left.mass;
			right.vx -= (dx / distance) * push / right.mass;
			right.vy -= (dy / distance) * push / right.mass;
			right.vz -= (dz / distance) * push / right.mass;
		}

		/**
		 * The network layout: cluster anchors, cell repulsion, link springs.
		 */
		class NetworkLayout {
			constructor(nodes, edges) {
				var clusters = Array.from(new Set(nodes.map(function (node) { return node.cluster; })));
				var extent = Math.max(180, Math.sqrt(nodes.length) * 16);
				var anchors = new Map();
				clusters.forEach(function (cluster, index) {
					anchors.set(cluster, {
						x: Math.cos(index * GOLDEN) * extent * 0.5,
						y: Math.sin(index * GOLDEN) * extent * 0.5
					});
				});
				this.anchors = anchors;
				this.alpha = 1;
				this.particles = nodes.map(function (node, index) {
					return {
						id: node.id,
						cluster: node.cluster,
						x: Math.cos(index * GOLDEN) * Math.sqrt(index + 1) * 15,
						y: Math.sin(index * GOLDEN) * Math.sqrt(index + 1) * 15,
						z: 0,
						vx: 0,
						vy: 0,
						weight: node.weight,
						mass: node.mass
					};
				});
				this.byId = new Map(this.particles.map(function (particle) { return [particle.id, particle]; }));
				this.links = edges.map(function (edge) {
					return [this.byId.get(edge.s), this.byId.get(edge.t), edge.w];
				}, this).filter(function (link) { return link[0] !== undefined && link[1] !== undefined; });
			}

			tick(fixed) {
				if (this.alpha < 5e-3) return;
				var cells = new Map();
				var cellSize = Math.max(70, Math.sqrt(this.particles.length) * 12);
				this.particles.forEach(function (particle) {
					var key = Math.floor(particle.x / cellSize) + ',' + Math.floor(particle.y / cellSize);
					var cell = cells.get(key) || { x: 0, y: 0, count: 0 };
					cell.x += particle.x;
					cell.y += particle.y;
					cell.count += 1;
					cells.set(key, cell);
				});
				var alpha = this.alpha;
				this.particles.forEach(function (particle) {
					cells.forEach(function (cell) {
						var dx = particle.x - cell.x / cell.count;
						var dy = particle.y - cell.y / cell.count;
						var distance = dx * dx + dy * dy + 100;
						var force = Math.min(2, cell.count * 30 / distance) * alpha;
						particle.vx += dx * force / particle.mass;
						particle.vy += dy * force / particle.mass;
					});
					var anchor = this.anchors.get(particle.cluster);
					// A hub is anchored more loosely, so the busiest files can sit
					// between the communities they connect rather than inside one.
					var tie = 4e-3 * (1 - 0.5 * particle.weight);
					particle.vx += ((anchor.x - particle.x) * tie - particle.x * 1e-3) * alpha;
					particle.vy += ((anchor.y - particle.y) * tie - particle.y * 1e-3) * alpha;
				}, this);
				this.links.forEach(function (link) {
					var left = link[0];
					var right = link[1];
					var dx = right.x - left.x;
					var dy = right.y - left.y;
					var distance = Math.hypot(dx, dy) || 1;
					var force = (distance - 65) / distance * 0.012 * Math.min(link[2], 2) * alpha;
					left.vx += dx * force / left.mass;
					left.vy += dy * force / left.mass;
					right.vx -= dx * force / right.mass;
					right.vy -= dy * force / right.mass;
				});
				this.particles.forEach(function (particle) {
					if (particle.id === fixed) {
						particle.vx = 0;
						particle.vy = 0;
						return;
					}
					particle.x += Math.max(-15, Math.min(15, particle.vx *= 0.55));
					particle.y += Math.max(-15, Math.min(15, particle.vy *= 0.55));
				});
				this.alpha *= 0.94;
			}
		}

		/** The great-circle interpolation between two points on the sphere. */
		function sphereArc(left, right, t) {
			var dot = Math.max(-1, Math.min(1, left.x * right.x + left.y * right.y + left.z * right.z));
			var angle = Math.acos(dot);
			if (angle < 1e-3 || Math.sin(angle) < 1e-3) {
				return {
					x: left.x * (1 - t) + right.x * t,
					y: left.y * (1 - t) + right.y * t,
					z: left.z * (1 - t) + right.z * t
				};
			}
			var u = Math.sin((1 - t) * angle) / Math.sin(angle);
			var v = Math.sin(t * angle) / Math.sin(angle);
			return { x: left.x * u + right.x * v, y: left.y * u + right.y * v, z: left.z * u + right.z * v };
		}

		/** Keeps labels from stacking on top of each other. */
		class LabelPlacer {
			constructor(width, height, limit) {
				this.width = width;
				this.height = height;
				this.limit = limit;
				this.boxes = [];
			}

			place(x, y, radius, width) {
				if (this.boxes.length >= this.limit) return undefined;
				var height = 20;
				var candidates = [
					{ x: x + radius + 5, y: y - height / 2 },
					{ x: x - radius - 5 - width, y: y - height / 2 },
					{ x: x - width / 2, y: y - radius - height - 5 },
					{ x: x - width / 2, y: y + radius + 5 }
				];
				for (var index = 0; index < candidates.length; index += 1) {
					var box = { x: candidates[index].x, y: candidates[index].y, width: width, height: height };
					if (box.x < 8 || box.y < 8 || box.x + width > this.width - 8 || box.y + height > this.height - 8) continue;
					var clash = this.boxes.some(function (other) {
						return box.x < other.x + other.width && box.x + box.width > other.x
							&& box.y < other.y + other.height && box.y + box.height > other.y;
					});
					if (clash) continue;
					this.boxes.push(box);
					return box;
				}
				return undefined;
			}
		}

		/** A coarse spatial index, so hover stays cheap with thousands of nodes. */
		class HitGrid {
			constructor(size) {
				this.size = size || 32;
				this.cells = new Map();
			}

			rebuild(points) {
				this.cells.clear();
				for (var index = 0; index < points.length; index += 1) {
					var point = points[index];
					var key = this.key(point.x, point.y);
					var cell = this.cells.get(key) || [];
					cell.push(point);
					this.cells.set(key, cell);
				}
			}

			hit(x, y) {
				var result;
				var cx = Math.floor(x / this.size);
				var cy = Math.floor(y / this.size);
				for (var dx = -1; dx <= 1; dx += 1) {
					for (var dy = -1; dy <= 1; dy += 1) {
						var cell = this.cells.get((cx + dx) + ',' + (cy + dy)) || [];
						for (var index = 0; index < cell.length; index += 1) {
							var point = cell[index];
							if (Math.hypot(point.x - x, point.y - y) <= point.radius + 5 && (!result || point.depth >= result.depth)) result = point;
						}
					}
				}
				return result === undefined ? undefined : result.id;
			}

			key(x, y) {
				return Math.floor(x / this.size) + ',' + Math.floor(y / this.size);
			}
		}

		/**
		 * The colours the canvas paints with, resolved from the panel's tokens.
		 *
		 * Canvas cannot use CSS variables, so the tokens are read once on mount
		 * and again on resize; a theme switch is a repaint anyway.
		 *
		 * @param {HTMLCanvasElement} canvas - The canvas.
		 * @returns {object} Resolved colours.
		 */
		function canvasTheme(canvas) {
			var computed = typeof getComputedStyle === 'function' ? getComputedStyle(canvas) : null;
			function token(name, fallback) {
				if (computed === null) return fallback;
				var value = String(computed.getPropertyValue(name) || '').trim();
				return value === '' ? fallback : value;
			}
			var dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
			return {
				background: token('--dsw-alias-bg-base', dark ? '#141a26' : '#ffffff'),
				grid: token('--dsw-alias-border-l2', dark ? '#273349' : '#dce7f5'),
				label: token('--dsw-alias-label-secondary', dark ? '#c8d2e4' : '#526681'),
				halo: dark ? '#1b2433' : '#f4f8ff'
			};
		}

		/**
		 * The link colour.
		 *
		 * Green says "relation" the way the rest of the panel does. Blue read as
		 * interface chrome and competed with the selected node's ring; grey read
		 * as a grid line. At this density the base stroke is mostly texture, so
		 * it is a green wash and the focused edges are the readable ones.
		 */
		var EDGE_COLOR = '#2fae72';
		var EDGE_LIT = '#17945e';
		/** The focused label's ink: the same green, darkened for text contrast. */
		var EDGE_TEXT = '#0f7a4a';

		/**
		 * One canvas, two layouts: `sphere` is the globe, `network` the force graph.
		 */
		class CanvasGraph {
			constructor(canvas, data, options) {
				var config = options || {};
				this.canvas = canvas;
				this.data = data;
				this.onOpen = typeof config.onOpen === 'function' ? config.onOpen : function () {};
				this.ctx = canvas.getContext('2d');
				this.layout = config.layout === 'network' ? 'network' : 'sphere';
				this.nodes = new Map(data.nodes.map(function (node) { return [node.id, node]; }));
				this.neighbors = new Map();
				this.incident = new Map();
				data.edges.forEach(function (edge) {
					[[edge.s, edge.t], [edge.t, edge.s]].forEach(function (pair) {
						var values = this.neighbors.get(pair[0]) || new Set();
						values.add(pair[1]);
						this.neighbors.set(pair[0], values);
						var incident = this.incident.get(pair[0]) || [];
						incident.push(edge);
						this.incident.set(pair[0], incident);
					}, this);
				}, this);
				var ranked = data.edges.slice().sort(function (left, right) { return right.w - left.w; });
				var self = this;
				this.bridges = new Set(ranked.filter(function (edge) {
					var left = self.nodes.get(edge.s);
					var right = self.nodes.get(edge.t);
					return left !== undefined && right !== undefined && left.cluster !== right.cluster;
				}).slice(0, 120));
				var budget = Math.min(4000, data.nodes.length * 2);
				this.networkEdges = data.nodes.length > 300 ? ranked.slice(0, budget) : data.edges;
				this.edges = data.nodes.length > 300
					? Array.from(new Set([...this.bridges, ...ranked.slice(0, budget)]))
					: data.edges;

				this.selected = '';
				this.hover = '';
				this.width = 600;
				this.height = 360;
				this.zoom = 1;
				this.pan = { x: 0, y: 0 };
				this.yaw = 0;
				this.pitch = 0;
				this.velocity = { x: 0, y: 0 };
				this.target = undefined;
				this.drag = undefined;
				this.frame = 0;
				this.lastDrawAt = 0;
				this.networkAngle = 0;
				this.networkCenter = { x: 0, y: 0 };
				this.networkExtent = { x: 200, y: 150 };
				this.grid = new HitGrid();
				this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
				this.lifetime = typeof AbortController === 'function' ? new AbortController() : null;
				this.theme = canvasTheme(canvas);

				var options2 = this.lifetime === null ? undefined : { signal: this.lifetime.signal };
				this.draw = this.draw.bind(this);
				this.pointerDown = this.pointerDown.bind(this);
				this.pointerMove = this.pointerMove.bind(this);
				this.pointerUp = this.pointerUp.bind(this);
				this.wheel = this.wheel.bind(this);
				canvas.addEventListener('pointerdown', this.pointerDown, options2);
				canvas.addEventListener('pointermove', this.pointerMove, options2);
				canvas.addEventListener('pointerup', this.pointerUp, options2);
				canvas.addEventListener('pointercancel', this.pointerUp, options2);
				canvas.addEventListener('pointerleave', this.pointerUp, options2);
				canvas.addEventListener('dblclick', function (event) {
					var point = this.point(event);
					var id = this.grid.hit(point.x, point.y);
					if (id !== undefined) {
						this.zoom = Math.min(3, this.zoom * 1.2);
						this.onOpen(id);
						this.wake();
					}
				}.bind(this), options2);
				canvas.addEventListener('wheel', this.wheel, options2 === undefined ? { passive: false } : { signal: options2.signal, passive: false });
				if (typeof ResizeObserver === 'function') {
					this.resize = new ResizeObserver(function () { this.measure(); }.bind(this));
					this.resize.observe(canvas);
				}
				if (typeof document !== 'undefined') {
					document.addEventListener('visibilitychange', function () {
						if (document.hidden) {
							cancelAnimationFrame(this.frame);
							this.frame = 0;
						} else this.wake();
					}.bind(this), options2);
				}
				this.measure();
			}

			get sphere() {
				if (this.sphereState === undefined) {
					this.sphereState = new SphereLayout(this.data.nodes, this.data.edges);
					// A few rounds at mount so the first paint is a relaxed globe
					// rather than the raw seed; the rest of the cooling happens in
					// front of the reader (see `draw`).
					for (var index = 0; index < 6; index += 1) this.sphereState.tick();
				}
				return this.sphereState;
			}

			get network() {
				if (this.networkState === undefined) {
					this.networkState = new NetworkLayout(this.data.nodes, this.data.edges);
					var rounds = this.data.nodes.length <= 1500 ? 80 : 4;
					for (var index = 0; index < rounds; index += 1) this.networkState.tick();
					var minX = Infinity;
					var maxX = -Infinity;
					var minY = Infinity;
					var maxY = -Infinity;
					this.networkState.particles.forEach(function (particle) {
						minX = Math.min(minX, particle.x);
						maxX = Math.max(maxX, particle.x);
						minY = Math.min(minY, particle.y);
						maxY = Math.max(maxY, particle.y);
					});
					if (Number.isFinite(minX)) {
						this.networkCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
						this.networkExtent = { x: Math.max(100, (maxX - minX) * 0.6), y: Math.max(100, (maxY - minY) * 0.6) };
					}
				}
				return this.networkState;
			}

			setLayout(layout) {
				this.layout = layout;
				this.wake();
			}

			reset() {
				this.zoom = 1;
				this.pan = { x: 0, y: 0 };
				this.yaw = 0;
				this.pitch = 0;
				this.networkAngle = 0;
				this.target = undefined;
				this.velocity = { x: 0, y: 0 };
				this.wake();
			}

			destroy() {
				cancelAnimationFrame(this.frame);
				this.frame = 0;
				if (this.lifetime !== null) this.lifetime.abort();
				if (this.resize !== undefined) this.resize.disconnect();
			}

			point(event) {
				var rect = this.canvas.getBoundingClientRect();
				return { x: event.clientX - rect.left, y: event.clientY - rect.top };
			}

			measure() {
				var rect = this.canvas.getBoundingClientRect();
				this.width = Math.max(1, rect.width);
				this.height = Math.max(1, rect.height);
				var dpr = Math.min((typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1, 3);
				this.canvas.width = Math.round(this.width * dpr);
				this.canvas.height = Math.round(this.height * dpr);
				this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				this.theme = canvasTheme(this.canvas);
				this.wake();
			}

			wake() {
				if (!this.frame && !(typeof document !== 'undefined' && document.hidden)) {
					this.frame = requestAnimationFrame(this.draw);
				}
			}

			networkPoint(point) {
				return rotatePoint({ x: point.x - this.networkCenter.x, y: point.y - this.networkCenter.y }, this.networkAngle);
			}

			networkScale() {
				var extent = rotatedExtent(this.networkExtent, this.networkAngle);
				return Math.min(
					Math.max(80, this.width - 100) / (extent.x * 2),
					Math.max(80, this.height - 60) / (extent.y * 2)
				) * this.zoom;
			}

			spherePoint(point) {
				var x = point.x * Math.cos(this.yaw) + point.z * Math.sin(this.yaw);
				var z0 = point.z * Math.cos(this.yaw) - point.x * Math.sin(this.yaw);
				var y = point.y * Math.cos(this.pitch) - z0 * Math.sin(this.pitch);
				var z = point.y * Math.sin(this.pitch) + z0 * Math.cos(this.pitch);
				var radius = Math.min(this.width, this.height) * 0.35 * this.zoom;
				var scale = 2.8 / (2.8 - z);
				return { x: this.width / 2 + x * radius * scale, y: this.height / 2 + y * radius * scale, depth: z, scale: scale };
			}

			/**
			 * Draw a small arrowhead at the tip of one focused edge.
			 *
			 * Direction is the one thing a plain line cannot say, and it is only
			 * worth the ink on the edges the reader is already looking at.
			 *
			 * @param {number} fromX - A point behind the tip, on the line.
			 * @param {number} fromY - A point behind the tip, on the line.
			 * @param {number} toX - The tip.
			 * @param {number} toY - The tip.
			 * @returns {void}
			 */
			arrow(fromX, fromY, toX, toY) {
				var angle = Math.atan2(toY - fromY, toX - fromX);
				var size = 7;
				var ctx = this.ctx;
				ctx.beginPath();
				ctx.moveTo(toX, toY);
				ctx.lineTo(toX - size * Math.cos(angle - 0.42), toY - size * Math.sin(angle - 0.42));
				ctx.moveTo(toX, toY);
				ctx.lineTo(toX - size * Math.cos(angle + 0.42), toY - size * Math.sin(angle + 0.42));
				ctx.stroke();
			}

			drawGlobe() {
				var ctx = this.ctx;
				ctx.strokeStyle = this.theme.grid;
				ctx.lineWidth = 0.6;
				ctx.globalAlpha = 0.7;
				for (var latitude = -2; latitude <= 2; latitude += 1) {
					ctx.beginPath();
					for (var step = 0; step <= 64; step += 1) {
						var angle = step * Math.PI / 32;
						var y = Math.sin(latitude * Math.PI / 6);
						var radius = Math.sqrt(Math.max(0, 1 - y * y));
						var point = this.spherePoint({ x: Math.cos(angle) * radius, y: y, z: Math.sin(angle) * radius });
						if (step === 0) ctx.moveTo(point.x, point.y);
						else ctx.lineTo(point.x, point.y);
					}
					ctx.stroke();
				}
				for (var longitude = 0; longitude < 6; longitude += 1) {
					ctx.beginPath();
					for (var index = 0; index <= 64; index += 1) {
						var sweep = index * Math.PI / 32;
						var meridian = longitude * Math.PI / 6;
						var projected = this.spherePoint({
							x: Math.sin(sweep) * Math.cos(meridian),
							y: Math.cos(sweep),
							z: Math.sin(sweep) * Math.sin(meridian)
						});
						if (index === 0) ctx.moveTo(projected.x, projected.y);
						else ctx.lineTo(projected.x, projected.y);
					}
					ctx.stroke();
				}
			}

			draw(time) {
				this.frame = 0;
				if (!this.canvas.isConnected || (typeof document !== 'undefined' && document.hidden)) return;
				var gap = this.data.nodes.length > 20000 ? 66 : this.data.nodes.length > 5000 ? 33 : 0;
				if (time - this.lastDrawAt < gap) {
					this.wake();
					return;
				}
				this.lastDrawAt = time;
				var ctx = this.ctx;
				var theme = this.theme;
				if (this.layout === 'network') {
					var iterations = this.reduced ? 100 : 2;
					for (var tick = 0; tick < iterations; tick += 1) this.network.tick(this.drag === undefined ? undefined : this.drag.node);
				} else {
					// The globe cools down in front of the reader, the same way the
					// network does. Reduced motion gets the settled picture at once.
					var rounds = this.reduced ? 100 : 2;
					for (var round = 0; round < rounds; round += 1) this.sphere.tick();
					if (!this.reduced) {
						if (this.target !== undefined) {
							this.yaw += (this.target.yaw - this.yaw) * 0.12;
							this.pitch += (this.target.pitch - this.pitch) * 0.12;
							if (Math.abs(this.target.yaw - this.yaw) + Math.abs(this.target.pitch - this.pitch) < 1e-3) this.target = undefined;
						} else if (this.drag === undefined) {
							// A slow ambient spin keeps the globe alive; a flick keeps going
							// but settles quickly (the sum of the decayed velocity is only
							// about a tenth of the last drag step).
							this.yaw += this.velocity.x + (this.selected === '' ? 12e-4 : 0);
							this.pitch += this.velocity.y;
							this.velocity.x *= 0.88;
							this.velocity.y *= 0.88;
						}
					}
				}
				ctx.globalAlpha = 1;
				ctx.fillStyle = theme.background;
				ctx.fillRect(0, 0, this.width, this.height);
				if (this.layout === 'sphere') this.drawGlobe();

				var particles = this.layout === 'sphere' ? this.sphere.particles : this.network.particles;
				var projected = [];
				particles.forEach(function (particle) {
					var rotated = this.layout === 'network' ? this.networkPoint(particle) : particle;
					var point = this.layout === 'sphere' ? this.spherePoint(particle) : {
						x: this.width / 2 + rotated.x * this.networkScale() + this.pan.x,
						y: this.height / 2 + rotated.y * this.networkScale() + this.pan.y,
						depth: 0,
						scale: 1
					};
					var node = this.nodes.get(particle.id);
					projected.push({
						id: particle.id,
						x: point.x,
						y: point.y,
						depth: point.depth,
						radius: node.radius * (this.layout === 'sphere' ? point.scale : 1)
					});
				}, this);
				projected = projected.filter(function (point) {
					return point.x + point.radius >= 0 && point.y + point.radius >= 0
						&& point.x - point.radius <= this.width && point.y - point.radius <= this.height;
				}, this).sort(function (left, right) { return left.depth - right.depth; });
				var positions = new Map(projected.map(function (point) { return [point.id, point]; }));
				this.grid.rebuild(projected);
				this.positions = positions;

				var visible = new Set(this.layout === 'network' ? this.networkEdges : this.edges);
				var focus = this.hover !== '' ? this.hover : this.selected;
				if (focus !== '') {
					(this.incident.get(focus) || []).forEach(function (edge) { visible.add(edge); });
				}
				var sphereMap = new Map(this.sphere.particles.map(function (point) { return [point.id, point]; }));
				visible.forEach(function (edge) {
					var left = positions.get(edge.s);
					var right = positions.get(edge.t);
					if (left === undefined || right === undefined) return;
					var highlighted = edge.s === focus || edge.t === focus;
					var bridge = this.edges === undefined ? false : this.bridges.has(edge);
					if (this.layout === 'sphere' && !highlighted && this.data.nodes.length > 300 && !bridge) return;
					var dx = right.x - left.x;
					var dy = right.y - left.y;
					var length = Math.hypot(dx, dy);
					// A line that runs under a dot reads as a smudge at this density,
					// so both ends stop at the circle edge.
					if (length <= left.radius + right.radius + 1) return;
					var ux = dx / length;
					var uy = dy / length;
					// The globe draws only its between-cluster bridges, so those carry
					// the whole picture and get a little more weight than the network's
					// background mesh.
					var baseAlpha = this.layout === 'sphere' ? 0.16 : 0.085;
					ctx.globalAlpha = highlighted ? 0.85 : baseAlpha;
					ctx.strokeStyle = highlighted ? EDGE_LIT : EDGE_COLOR;
					ctx.lineWidth = highlighted ? 1.4 : 0.7;
					var tipX = right.x - ux * (right.radius + 1);
					var tipY = right.y - uy * (right.radius + 1);
					// A great circle between two distant points runs around the back
					// of the globe, so the projected arc ends up far away from both
					// dots it connects. Past roughly 70° the direct chord is the
					// honest picture: it hugs the dots and still says they are related.
					var from = sphereMap.get(edge.s);
					var to = sphereMap.get(edge.t);
					var cosine = from === undefined || to === undefined
						? 1
						: Math.max(-1, Math.min(1, from.x * to.x + from.y * to.y + from.z * to.z));
					var onArc = this.layout === 'sphere' && (highlighted || bridge) && Math.acos(cosine) <= 1.25;
					ctx.beginPath();
					if (onArc) {
						// On the globe an arc is the shortest path on the surface, so
						// the projected great circle is the honest line; the ends are
						// trimmed by dropping the samples that fall inside a dot.
						var samples = [];
						for (var step = 0; step <= 16; step += 1) {
							samples.push(this.spherePoint(sphereArc(sphereMap.get(edge.s), sphereMap.get(edge.t), step / 16)));
						}
						var first = 0;
						var last = samples.length - 1;
						while (first <= last && Math.hypot(samples[first].x - left.x, samples[first].y - left.y) < left.radius + 0.5) first += 1;
						while (last >= first && Math.hypot(samples[last].x - right.x, samples[last].y - right.y) < right.radius + 0.5) last -= 1;
						if (first >= last) return;
						ctx.moveTo(samples[first].x, samples[first].y);
						for (var index = first + 1; index <= last; index += 1) {
							ctx.lineTo(samples[index].x, samples[index].y);
						}
						tipX = samples[last].x;
						tipY = samples[last].y;
						if (highlighted) {
							ctx.lineTo(tipX, tipY);
							ctx.stroke();
							this.arrow(samples[last - 1].x, samples[last - 1].y, tipX, tipY);
							return;
						}
					} else {
						ctx.moveTo(left.x + ux * (left.radius + 0.5), left.y + uy * (left.radius + 0.5));
						ctx.lineTo(tipX, tipY);
					}
					ctx.stroke();
					if (highlighted && !onArc) {
						this.arrow(tipX - ux * 10, tipY - uy * 10, tipX, tipY);
					}
				}, this);

				projected.forEach(function (point) {
					var node = this.nodes.get(point.id);
					var selected = point.id === this.selected || point.id === this.hover;
					var active = focus === '' || point.id === focus || (this.neighbors.get(focus) || new Set()).has(point.id);
					ctx.globalAlpha = (this.layout === 'sphere' ? 0.3 + (point.depth + 1) * 0.35 : 1) * (active ? 1 : 0.15);
					var radius = point.radius * (!this.reduced ? 1 + 0.025 * Math.sin(time / 900) : 1);
					ctx.fillStyle = node.color;
					ctx.strokeStyle = selected ? EDGE_LIT : theme.background;
					ctx.lineWidth = selected ? 2 : 1;
					ctx.beginPath();
					ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
					ctx.fill();
					ctx.stroke();
				}, this);

				// Labels are re-placed every frame; while a layout is still cooling
				// that reads as jitter, so a moving graph shows only what is under
				// the cursor. The globe cools faster than the network — its dots move
				// a couple of degrees, not a box's worth — so it gets its labels back
				// as soon as the initial de-overlap is done.
				var settled = this.layout === 'sphere' ? this.sphere.alpha < 0.3 : this.network.alpha < 5e-3;
				var placer = new LabelPlacer(this.width, this.height, Math.max(4, Math.min(12, Math.floor(this.width * this.height / 40000))));
				var focusId = focus;
				var candidates = settled || focusId !== '' ? projected
					.filter(function (point) {
						return focusId === '' || point.id === focusId || (this.neighbors.get(focusId) || new Set()).has(point.id);
					}, this)
					.filter(function (point) {
						return this.nodes.get(point.id).degree >= 4 || point.id === focusId;
					}, this)
					.sort(function (left, right) {
						return (right.id === focusId ? 1 : 0) - (left.id === focusId ? 1 : 0)
							|| this.nodes.get(right.id).degree - this.nodes.get(left.id).degree
							|| right.depth - left.depth;
					}.bind(this)) : [];
				ctx.textBaseline = 'middle';
				candidates.forEach(function (point) {
					var node = this.nodes.get(point.id);
					var focused = point.id === focusId;
					var text = String(node.title || '');
					if (text.length > 15) text = text.slice(0, 15) + '…';
					ctx.font = focused ? '600 12px sans-serif' : '11px sans-serif';
					var box = placer.place(point.x, point.y, point.radius, Math.ceil(ctx.measureText(text).width) + 12);
					if (box === undefined) return;
					ctx.globalAlpha = focused ? 1 : 0.88;
					ctx.fillStyle = theme.background;
					ctx.beginPath();
					if (typeof ctx.roundRect === 'function') ctx.roundRect(box.x, box.y, box.width, box.height, 4);
					else ctx.rect(box.x, box.y, box.width, box.height);
					ctx.fill();
					ctx.fillStyle = focused ? EDGE_TEXT : theme.label;
					ctx.textBaseline = 'alphabetic';
					ctx.fillText(text, box.x + 6, box.y + 14);
					ctx.textBaseline = 'middle';
				}, this);
				ctx.globalAlpha = 1;

				var moving = this.layout === 'sphere'
					? (!this.reduced && (this.target !== undefined || Math.abs(this.velocity.x) + Math.abs(this.velocity.y) > 1e-4 || this.selected === '' || this.sphere.alpha >= 5e-3))
					: (this.network.alpha >= 5e-3 || this.data.nodes.length <= 300);
				if (moving) this.wake();
			}

			pointerDown(event) {
				var at = this.point(event);
				var rotate = this.layout === 'network' && event.shiftKey;
				this.drag = {
					x: at.x,
					y: at.y,
					startX: at.x,
					startY: at.y,
					node: rotate ? undefined : this.grid.hit(at.x, at.y),
					rotate: rotate,
					moved: false
				};
				this.target = undefined;
				this.velocity = { x: 0, y: 0 };
				if (typeof this.canvas.setPointerCapture === 'function') this.canvas.setPointerCapture(event.pointerId);
			}

			pointerMove(event) {
				var at = this.point(event);
				if (this.drag !== undefined) {
					var dx = at.x - this.drag.x;
					var dy = at.y - this.drag.y;
					if (!this.drag.moved && Math.hypot(at.x - this.drag.startX, at.y - this.drag.startY) > 4) this.drag.moved = true;
					if (this.layout === 'sphere') {
						// The surface follows the pointer: a rightward drag spins the
						// front of the globe right, so yaw grows with dx. A downward
						// drag tips the front down, and positive pitch moves the front
						// *up*, so pitch shrinks with dy — the sign is the whole
						// difference between "the ball turns with my hand" and "it
						// turns against it".
						this.yaw += dx * 6e-3;
						this.pitch -= dy * 6e-3;
						// A flick keeps going a little, but only a little: the old
						// factor let inertia add ~70% more rotation after the release,
						// which read as the globe running away from the hand.
						this.velocity = this.reduced ? { x: 0, y: 0 } : { x: dx * 0.5e-3, y: -dy * 0.5e-3 };
					} else if (this.drag.rotate) {
						this.networkAngle = rotationRadians(this.networkAngle * 180 / Math.PI + dx * 0.6);
					} else if (this.drag.node !== undefined) {
						var particle = this.network.particles.find(function (candidate) { return candidate.id === this.drag.node; }, this);
						var movement = rotatePoint({ x: dx / this.networkScale(), y: dy / this.networkScale() }, -this.networkAngle);
						if (particle !== undefined) {
							particle.x += movement.x;
							particle.y += movement.y;
							this.network.alpha = 0.4;
						}
					} else {
						this.pan.x += dx;
						this.pan.y += dy;
					}
					this.drag.x = at.x;
					this.drag.y = at.y;
				} else {
					this.hover = this.grid.hit(at.x, at.y) || '';
					this.canvas.style.cursor = this.hover === '' ? 'grab' : 'pointer';
				}
				this.canvas.title = this.hover === ''
					? (this.layout === 'network' ? '拖拽平移，Shift+拖拽旋转，滚轮缩放' : '拖拽旋转，滚轮缩放；点击节点打开文件')
					: (this.nodes.get(this.hover) || {}).title || '';
				this.wake();
			}

			pointerUp(event) {
				if (this.drag === undefined) return;
				var drag = this.drag;
				this.drag = undefined;
				this.canvas.style.cursor = 'grab';
				if (!drag.moved && drag.node !== undefined) {
					this.selected = drag.node;
					this.onOpen(drag.node);
				}
				if (typeof this.canvas.hasPointerCapture === 'function' && this.canvas.hasPointerCapture(event.pointerId)) {
					this.canvas.releasePointerCapture(event.pointerId);
				}
				this.wake();
			}

			wheel(event) {
				event.preventDefault();
				var at = this.point(event);
				var before = this.zoom;
				this.zoom = Math.max(0.2, Math.min(5, this.zoom * Math.exp(-event.deltaY * 1e-3)));
				if (this.layout === 'network') {
					var ratio = this.zoom / before;
					this.pan.x = at.x - this.width / 2 - (at.x - this.width / 2 - this.pan.x) * ratio;
					this.pan.y = at.y - this.height / 2 - (at.y - this.height / 2 - this.pan.y) * ratio;
				}
				this.wake();
			}
		}

		/**
		 * One canvas view; the engine is created on mount and disposed on unmount.
		 *
		 * @param {object} props - `{layout, graph, onOpen, hidden}`.
		 * @returns {object} The element.
		 */
		function CanvasGraphView(props) {
			var t = props.t;
			var canvasRef = useRef(null);
			var graph = props.graph;
			var layout = props.layout;
			var onOpen = props.onOpen;
			useEffect(function () {
				if (canvasRef.current === null || graph === null || graph === undefined) return undefined;
				var data = canvasGraphData(graph);
				if (data.nodes.length === 0) return undefined;
				var engine = new CanvasGraph(canvasRef.current, data, {
					layout: layout,
					onOpen: onOpen
				});
				return function () { engine.destroy(); };
			}, [graph, layout]);
			var nodes = Array.isArray(graph && graph.nodes) ? graph.nodes.length : 0;
			var edges = Array.isArray(graph && graph.edges) ? graph.edges.length : 0;
			if (nodes === 0) return h('div', { className: 'ysEmpty' }, t('graph.empty'));
			return h('div', { className: 'ysCanvasWrap' },
				h('canvas', {
					ref: canvasRef,
					className: 'ysCanvas',
					role: 'img',
					'aria-label': t(layout === 'network' ? 'graph.tab.relations' : 'graph.tab.planet')
				}),
				h('div', { className: 'ysHint', style: { marginTop: 8 } },
					(layout === 'network' ? t('graph.network.hint') : t('graph.sphere.hint'))
					+ ' · ' + t('graph.counts').replace('{nodes}', String(nodes)).replace('{edges}', String(edges))
					+ (graph.totals && graph.totals.hidden > 0
						? ' · ' + t('graph.hidden').replace('{n}', String(graph.totals.hidden))
						: '')));
		}

		//#endregion


		//#region components

		function Icon(props) {
			var size = props.size || 18;
			return h('svg', {
				viewBox: '0 0 24 24',
				width: size,
				height: size,
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.7,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': true
			},
				h('path', { d: 'M7 3.5h7l4 4v13H7z' }),
				h('path', { d: 'M14 3.5v4.5h4' }),
				h('path', { d: 'M9.5 12h6M9.5 15h6M9.5 18h3.5' })
			);
		}

		function buildTagTree(rows) {
			var roots = [];
			var nodes = new Map();
			(Array.isArray(rows) ? rows : []).forEach(function (row) {
				var parts = String(row.tag ?? '').split('/').filter(function (part) { return part !== ''; });
				var count = Number(row.count) || 0;
				var children = roots;
				var prefix = '';
				parts.forEach(function (name) {
					var path = prefix === '' ? name : prefix + '/' + name;
					var node = nodes.get(path);
					if (node === undefined) {
						node = { name: name, path: path, count: 0, children: [] };
						nodes.set(path, node);
						children.push(node);
					}
					// Every ancestor gets the same assignment, so the root count is
					// the number of live files under that branch.
					node.count += count;
					children = node.children;
					prefix = path;
				});
			});
			function sort(list) {
				list.sort(function (left, right) {
					return right.count - left.count || left.path.localeCompare(right.path);
				});
				list.forEach(function (node) { sort(node.children); });
			}
			sort(roots);
			return roots;
		}

		function Heatmap(props) {
			var t = props.t;
			var activity = Array.isArray(props.activity) ? props.activity : [];
			if (activity.length === 0) return h('div', { className: 'ysHint' }, t('overview.heatmap.empty'));
			var counts = {};
			activity.forEach(function (item) { counts[item.date] = item.count; });
			function parse(key) { return new Date(key + 'T00:00:00'); }
			function keyOf(date) {
				return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
			}
			var first = parse(activity[0].date);
			var last = parse(activity[activity.length - 1].date);
			if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime())) return h('div', { className: 'ysHint' }, t('overview.heatmap.empty'));
			var start = new Date(first);
			start.setDate(start.getDate() - start.getDay());
			var weeks = [];
			var cursor = new Date(start);
			while (cursor <= last) {
				var week = [];
				for (var day = 0; day < 7; day += 1) {
					var date = new Date(cursor);
					date.setDate(date.getDate() + day);
					var key = keyOf(date);
					week.push({ key: key, count: counts[key], inside: date >= first && date <= last });
				}
				weeks.push(week);
				cursor.setDate(cursor.getDate() + 7);
			}
			var monthLabels = weeks.map(function (week, index) {
				var date = parse(week[0].key);
				var previous = index === 0 ? null : parse(weeks[index - 1][0].key);
				if (index === 0 || (previous !== null && previous.getMonth() !== date.getMonth())) {
					return (date.getMonth() + 1) + t('overview.heatmap.monthSuffix');
				}
				return '';
			});
			var peak = 0;
			activity.forEach(function (item) {
				var value = Number(item.count);
				if (Number.isFinite(value) && value > peak) peak = value;
			});
			function level(count) {
				var value = Number(count);
				if (!Number.isFinite(value) || value <= 0) return 0;
				if (peak <= 3) return Math.min(4, value);
				return Math.min(4, Math.max(1, Math.ceil((value / peak) * 4)));
			}
			var weekdays = t('overview.heatmap.weekdays').split(',');
			return h('div', { className: 'ysHeatmapWrap' },
				h('div', { className: 'ysHeatmapMonths' }, monthLabels.map(function (label, index) {
					return h('span', { key: index }, label);
				})),
				h('div', { className: 'ysHeatmapBody' },
					h('div', { className: 'ysHeatmapDays' }, weekdays.map(function (label, index) {
						return h('span', { key: index }, label);
					})),
					h('div', { className: 'ysHeatmap' }, weeks.map(function (week) {
						return h('div', { key: week[0].key, className: 'ysHeatmapWeek' }, week.map(function (cell) {
							return h('div', {
								key: cell.key,
								className: cell.inside ? 'ysHeatCell ysHeat' + level(cell.count) : 'ysHeatCell ysHeatBlank',
								title: cell.inside ? cell.key + ' · ' + (cell.count ?? 0) + ' ' + t('overview.heatmap.unit') : '',
								'aria-label': cell.inside ? cell.key + ' · ' + (cell.count ?? 0) : '',
							});
						}));
					}))),
				h('div', { className: 'ysHeatLegend' },
					h('span', null, t('overview.heatmap.less')),
					h('span', { className: 'ysHeatCell ysHeat0' }),
					h('span', { className: 'ysHeatCell ysHeat1' }),
					h('span', { className: 'ysHeatCell ysHeat2' }),
					h('span', { className: 'ysHeatCell ysHeat3' }),
					h('span', { className: 'ysHeatCell ysHeat4' }),
					h('span', null, t('overview.heatmap.more'))));
		}

		var TAG_BRANCH_COLORS = {
			'践行': '#4f8a6e',
			'见闻': '#657ea6',
			'即兴': '#a77b55',
			'复盘': '#87679a',
			'觉察': '#4f8794',
			'试错': '#9b6b6b'
		};

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

		/**
		 * How much angular room a subtree needs.
		 *
		 * @param {object} node - The tag node.
		 * @returns {number} The weight.
		 */
		function tagGraphWeight(node) {
			var children = node.children ?? [];
			if (children.length === 0) return 1;
			return Math.max(1, children.reduce(function (sum, child) { return sum + tagGraphWeight(child); }, 0));
		}

		/**
		 * Lay the whole tag forest out as one radial picture.
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
			function place(node, key, from, to, depth, parent, offset) {
				var middle = (from + to) / 2;
				var radius = inner + depth * ring + (offset ?? 0);
				var x = cx + Math.cos(middle) * radius;
				var y = cy + Math.sin(middle) * radius;
				var root = parent === null ? key : parent.root;
				nodes.push({ path: key, name: node.name, count: node.count, depth: depth, x: x, y: y, angle: middle, root: root, children: node.children ?? [] });
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
			var minX = Infinity;
			var minY = Infinity;
			var maxX = -Infinity;
			var maxY = -Infinity;
			nodes.forEach(function (node) {
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
		 * The radial tag graph, matching the old evolver overview.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function TagGraph(props) {
			var t = props.t;
			var layout = useMemo(function () { return tagGraphLayout(props.nodes); }, [props.nodes]);
			if (layout === null) return h('div', { className: 'ysHint' }, t('overview.tagGraph.empty'));
			function colorOf(node) { return TAG_BRANCH_COLORS[node.root.split('/')[0]] ?? '#8a8f98'; }
			var edgeEls = layout.edges.map(function (edge, index) {
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
					className: 'ysTagEdge',
					stroke: TAG_BRANCH_COLORS[edge.root.split('/')[0]] ?? '#a8adb5'
				});
			});
			var nodeEls = layout.nodes.map(function (node) {
				var degrees = (node.angle * 180) / Math.PI;
				var flipped = Math.cos(node.angle) < 0;
				var labelX = flipped ? node.x - 9 : node.x + 9;
				var isRoot = node.depth === 0;
				return h('g', {
					key: node.path,
					className: 'ysTagGraphNode',
					role: 'button',
					tabIndex: 0,
					'aria-label': node.path + ' · ' + node.count,
					onClick: function () { if (props.onTag !== undefined) props.onTag(node.path); },
					onKeyDown: function (event) {
						if (event && (event.key === 'Enter' || event.key === ' ') && props.onTag !== undefined) {
							event.preventDefault();
							props.onTag(node.path);
						}
					}
				},
					h('circle', {
						cx: node.x,
						cy: node.y,
						r: isRoot ? 4.4 : 3.2,
						className: isRoot ? 'ysTagDot ysTagDotRoot' : 'ysTagDot',
						stroke: colorOf(node)
					}),
					h('text', {
						x: labelX,
						y: node.y + 3.2,
						textAnchor: flipped ? 'end' : 'start',
						transform: 'rotate(' + (flipped ? degrees + 180 : degrees).toFixed(1) + ' ' + node.x.toFixed(1) + ' ' + node.y.toFixed(1) + ')',
						className: isRoot ? 'ysTagLabel ysTagRoot' : 'ysTagLabel'
					}, node.name),
					h('title', null, node.path + ' · ' + node.count));
			});
			return h('div', { className: 'ysTagGraphWrap' },
				h('svg', {
					className: 'ysTagGraph',
					viewBox: '0 0 ' + layout.width + ' ' + layout.height,
					role: 'img',
					'aria-label': t('overview.tagGraph')
				},
					h('g', { transform: 'translate(' + layout.ox.toFixed(1) + ' ' + layout.oy.toFixed(1) + ') scale(' + layout.fit.toFixed(3) + ')' },
						h('g', null, edgeEls),
						h('circle', { cx: layout.cx, cy: layout.cy, r: 4, className: 'ysTagHub' }),
						h('g', null, nodeEls))));
		}

		/**
		 * Five green steps, from the palest tint to a medium green. The matrix
		 * uses only this family so the panel stays visually quiet and the
		 * heatmap and type matrix read as the same system.
		 */
		var TYPE_GREEN_SHADES = ['#eef8f1', '#d9f0e1', '#bde5cc', '#98d5b2', '#72c497'];

		/**
		 * Look up one green step.
		 *
		 * @param {number} level - 1 (palest) to 5 (deepest).
		 * @returns {string} A CSS color.
		 */
		function typeGreen(level) {
			return TYPE_GREEN_SHADES[Math.max(0, Math.min(4, level - 1))];
		}

		/**
		 * Split a fixed rectangle into proportional tiles.
		 *
		 * A binary treemap: each cut takes the half of the remaining rows whose
		 * area is closest to half, and splits along the longer side. The result
		 * is deterministic and every tile's area stays proportional to its
		 * count; one type simply fills the whole block.
		 *
		 * @param {Array<{suffix: string, count: number}>} rows - Sorted counts.
		 * @param {number} width - Layout width.
		 * @param {number} height - Layout height.
		 * @returns {Array<object>} The tiles.
		 */
		function treemapLayout(rows, width, height) {
			var total = rows.reduce(function (sum, row) { return sum + row.count; }, 0);
			var items = rows.map(function (row) {
				return { suffix: row.suffix, count: row.count, area: total === 0 ? 0 : (row.count / total) * width * height };
			});
			var tiles = [];
			function sumArea(list) {
				return list.reduce(function (sum, item) { return sum + item.area; }, 0);
			}
			function place(list, x, y, w, h) {
				if (list.length === 1) {
					tiles.push({ suffix: list[0].suffix, count: list[0].count, x: x, y: y, w: w, h: h });
					return;
				}
				var area = sumArea(list);
				var acc = 0;
				var cut = 1;
				var best = Infinity;
				for (var index = 1; index < list.length; index += 1) {
					acc += list[index - 1].area;
					var diff = Math.abs(acc - area / 2);
					if (diff < best) { best = diff; cut = index; }
				}
				var first = list.slice(0, cut);
				var second = list.slice(cut);
				var ratio = sumArea(first) / area;
				if (w >= h) {
					var w1 = w * ratio;
					place(first, x, y, w1, h);
					place(second, x + w1, y, w - w1, h);
				} else {
					var h1 = h * ratio;
					place(first, x, y, w, h1);
					place(second, x, y + h1, w, h - h1);
				}
			}
			if (items.length > 0) place(items, 0, 0, width, height);
			return tiles;
		}

		/**
		 * File-type matrix, grouped by suffix.
		 *
		 * @param {object} props - Component props.
		 * @returns {object} The element tree.
		 */
		function FileTypes(props) {
			var t = props.t;
			var rows = Array.isArray(props.rows) ? props.rows : [];
			var boxRef = useRef(null);
			var [box, setBox] = useState({ width: 1000, height: 420 });
			useEffect(function () {
				var node = boxRef.current;
				if (node === null || typeof ResizeObserver !== 'function') return undefined;
				var observer = new ResizeObserver(function (entries) {
					var rect = entries[0].contentRect;
					setBox(function (current) {
						var width = Math.max(1, Math.round(rect.width));
						var height = Math.max(1, Math.round(rect.height));
						return width === current.width && height === current.height ? current : { width: width, height: height };
					});
				});
				observer.observe(node);
				return function () { observer.disconnect(); };
			}, []);
			if (rows.length === 0) return h('div', { className: 'ysEmpty' }, t('overview.types.empty'));
			var total = rows.reduce(function (sum, row) { return sum + row.count; }, 0);
			var maxCount = rows.reduce(function (max, row) { return Math.max(max, row.count); }, 0);
			var minCount = rows.reduce(function (min, row) { return Math.min(min, row.count); }, Infinity);
			function levelOf(count) {
				if (rows.length <= 1 || maxCount === minCount) return 3;
				return Math.max(1, Math.min(5, 1 + Math.round(((count - minCount) / (maxCount - minCount)) * 4)));
			}
			// The treemap is laid out in the measured box, so tiles keep their
			// proportions whatever the window does — the container is sized by
			// the parent's flex rules, not by a constant here.
			var width = box.width;
			var height = box.height;
			var tiles = treemapLayout(rows, width, height);
			return h('div', {
				ref: boxRef,
				className: 'ysTypeMatrix',
				role: 'group',
				'aria-label': rows.map(function (row) { return (row.suffix || t('overview.types.none')) + ' ' + row.count; }).join(', ')
			}, tiles.map(function (tile) {
				var pct = total === 0 ? 0 : (tile.count / total) * 100;
				var label = tile.suffix === '' ? t('overview.types.none') : '.' + tile.suffix;
				return h('button', {
					type: 'button',
					key: tile.suffix || 'none',
					className: 'ysTypeTile',
					style: {
						left: (tile.x / width) * 100 + '%',
						top: (tile.y / height) * 100 + '%',
						width: (tile.w / width) * 100 + '%',
						height: (tile.h / height) * 100 + '%',
						background: typeGreen(levelOf(tile.count))
					},
					title: t('overview.types.open').replace('{n}', label) + ' · ' + tile.count + ' · ' + pct.toFixed(pct % 1 === 0 ? 0 : 1) + '%',
					onClick: function () { if (props.onType !== undefined) props.onType(tile.suffix); }
				},
					pct >= 0.025
						? h('span', { className: 'ysTypeTileName' }, label)
						: null,
					pct >= 0.025
						? h('span', { className: 'ysTypeTileValue' }, tile.count + ' · ' + pct.toFixed(pct % 1 === 0 ? 0 : 1) + '%')
						: null);
			}));
		}

		function OverviewTab(props) {
			var t = props.t;
			var overview = props.overview;
			if (overview === null || overview === undefined) return h('div', { className: 'ysEmpty' }, t('state.loading'));
			var stats = overview.stats || {};
			var year = overview.year || {};
			var hint = t('overview.heatmap.hint')
				.replace('{notes}', String(stats.files ?? year.notes ?? 0))
				.replace('{days}', String(year.activeDays ?? 0));
			return h('div', { className: 'ysOverview' },
				h('div', { className: 'ysOverviewTop' },
					h('div', { className: 'ysSection' }, t('overview.heatmap')),
					h('div', { className: 'ysHint', style: { marginBottom: 8 } }, hint),
					h(Heatmap, { t: t, activity: overview.activity }),
					h('div', { className: 'ysGrid ysGridThree' },
						[
							[t('overview.files'), stats.files, t('overview.filesHint')],
							[t('overview.tags'), stats.tags, t('overview.tagsHint')],
							[t('overview.days'), stats.days, t('overview.daysHint')]
						].map(function (item) {
							return h('div', { className: 'ysCard', key: item[0] },
								h('div', { className: 'ysStatValue' }, String(item[1] ?? 0)),
								h('div', { className: 'ysStatLabel' }, item[0]),
								h('div', { className: 'ysStatHint' }, item[2]));
						}))),
				h('div', { className: 'ysOverviewTypes' },
					h('div', { className: 'ysSection' }, t('overview.types')),
					h('div', { className: 'ysHint', style: { marginBottom: 10 } }, t('overview.types.hint')),
					h(FileTypes, { t: t, rows: overview.suffixes, onType: props.onType })));
		}

		function FileRow(props) {
			var file = props.file;
			return h('div', {
				className: 'ysItem' + (props.active ? ' ysItemActive' : ''),
				role: 'button',
				tabIndex: 0,
				onClick: function () { props.onOpen(file.id); },
				onKeyDown: function (event) {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						props.onOpen(file.id);
					}
				}
			},
				h('div', { className: 'ysItemMain' },
					h('div', { className: 'ysItemTitle' }, file.name),
					h('div', { className: 'ysItemDesc' }, file.description),
					h('div', { className: 'ysItemMeta' },
						typeLabel(file.mime) + ' · ' + formatBytes(file.bytes) + ' · 入/出 ' + (file.degree ? file.degree.in + '/' + file.degree.out : '0/0') + ' · ' + relativeTime(file.updated)),
					h('div', { className: 'ysTags' },
						(file.tags || []).slice(0, 3).map(function (tag) {
							return h('span', { className: 'ysTag', key: tag }, tag);
						}),
						file.archived ? h('span', { className: 'ysTag' }, props.t('file.archived')) : null)));
		}

		function FilesTab(props) {
			var t = props.t;
			var files = props.files;
			var uploadRef = useRef(null);
			var listRef = useRef(null);
			var [measured, setMeasured] = useState(0);
			// One page fills exactly the space the list has, so the panel never
			// scrolls as a whole. The row height is the unit the page size is
			// derived from; rows stretch to fill any remainder.
			useEffect(function () {
				var node = listRef.current;
				if (node === null || typeof ResizeObserver !== 'function') return undefined;
				var observer = new ResizeObserver(function (entries) {
					var height = Math.round(entries[0].contentRect.height);
					setMeasured(function (current) { return current === height ? current : height; });
				});
				observer.observe(node);
				return function () { observer.disconnect(); };
			}, []);
			useEffect(function () {
				if (measured === 0) return;
				props.onPageSize(Math.max(3, Math.min(40, Math.floor(measured / 96))));
			}, [measured]);
			var detailOpen = props.detail !== null && props.detail !== undefined;
			useEffect(function () {
				if (!detailOpen) return undefined;
				function onKey(event) {
					if (event.key === 'Escape') props.onCloseDetail();
				}
				document.addEventListener('keydown', onKey);
				return function () { document.removeEventListener('keydown', onKey); };
			}, [detailOpen, props.onCloseDetail]);
			var total = files === null || files === undefined ? 0 : files.total;
			var pages = Math.max(1, Math.ceil(total / Math.max(1, props.pageSize)));
			var page = Math.min(props.page, pages - 1);
			var filtered = props.query || props.tag || props.archived
				|| (props.suffix !== null && props.suffix !== undefined);
			var rows = files === null || files === undefined
				? h('div', { className: 'ysEmpty' }, t('state.loading'))
				: (files.files || []).length === 0
					? h('div', { className: 'ysEmpty' },
						filtered
							? h('div', null,
								h('div', null, t('files.noMatch')),
								h('button', { className: 'ysButton', style: { marginTop: 8 }, onClick: props.onClear }, t('files.clear')))
							: t('files.empty'))
					: (files.files || []).map(function (file) {
						return h(FileRow, { key: file.id, t: t, file: file, active: props.selectedId === file.id, onOpen: props.onOpen });
					});
			var typeOptions = (props.suffixes || []).slice();
			// A filter can outlive its option (the last file of a suffix was
			// renamed away); keep the select showing what is actually filtered.
			if (props.suffix !== null && props.suffix !== undefined
				&& !typeOptions.some(function (row) { return row.suffix === props.suffix; })) {
				typeOptions.push({ suffix: props.suffix, count: 0 });
			}
			var suffixValue = props.suffix === null || props.suffix === undefined
				? ''
				: (props.suffix === '' ? '-' : props.suffix);
			return h('div', { className: 'ysFiles' },
				h('div', { className: 'ysToolbar' },
					h('input', {
						className: 'ysInput',
						type: 'search',
						placeholder: t('files.search'),
						value: props.query,
						onChange: function (event) { props.setQuery(event.target.value); }
					}),
					h('input', {
						className: 'ysInput',
						style: { flex: '0 0 150px' },
						placeholder: t('files.tag'),
						value: props.tag,
						onChange: function (event) { props.setTag(event.target.value); }
					}),
					// The type filter is the same list the overview's matrix draws:
					// one extension per row. `-` is the "no extension" bucket.
					h('select', {
						className: 'ysSelect',
						value: suffixValue,
						onChange: function (event) {
							var value = event.target.value;
							props.setSuffix(value === '' ? null : (value === '-' ? '' : value));
						}
					},
						h('option', { value: '' }, t('files.mime')),
						typeOptions.map(function (row) {
							var label = row.suffix === '' ? t('overview.types.none') : '.' + row.suffix;
							return h('option', { key: row.suffix === '' ? '-' : row.suffix, value: row.suffix === '' ? '-' : row.suffix },
								row.count > 0 ? label + ' · ' + row.count : label);
						})),
					h('label', { className: 'ysCheck' },
						h('input', { type: 'checkbox', checked: props.archived, onChange: function (event) { props.setArchived(event.target.checked); } }),
						t('files.archived')),
					h('button', { className: 'ysButton', onClick: function () { uploadRef.current?.click(); } }, t('action.upload')),
					h('input', { ref: uploadRef, type: 'file', style: { display: 'none' }, onChange: props.onPickFile }),
					h('button', { className: 'ysButton ysButtonPrimary', onClick: props.onNew }, t('action.create')),
					files !== null && files !== undefined
						? h('span', { className: 'ysHint' }, t('files.total').replace('{n}', String(files.total)))
						: null),
				h('div', { className: 'ysListWrap', ref: listRef },
					h('div', { className: 'ysList' }, rows)),
				h('div', { className: 'ysPager' },
					files === null || files === undefined
						? null
						: h('span', null, t('files.page').replace('{a}', String(page + 1)).replace('{b}', String(pages))),
					h('button', { className: 'ysButton', disabled: page <= 0, onClick: function () { props.onPage(page - 1); } }, t('files.prev')),
					h('button', { className: 'ysButton', disabled: page >= pages - 1, onClick: function () { props.onPage(page + 1); } }, t('files.next'))),
				detailOpen
					? h('div', { className: 'ysSheetMask', role: 'presentation', onClick: props.onCloseDetail },
						h('div', {
							className: 'ysSheet',
							role: 'dialog',
							'aria-modal': 'true',
							onClick: function (event) { event.stopPropagation(); }
						},
							h('div', { className: 'ysSheetBar' },
								h('button', { className: 'ysButton', onClick: props.onCloseDetail }, t('files.close'))),
							h(DetailPane, props)))
					: null);
		}

		function DetailPane(props) {
			var t = props.t;
			var detail = props.detail;
			if (detail === null || detail === undefined) {
				return h('div', { className: 'ysDetail' }, h('div', { className: 'ysEmpty' }, t('files.select')));
			}
			var draft = props.draft || { description: '', tags: '', links: '', content: '' };
			var neighbors = detail.neighbors || { out: [], in: [] };
			var dirty = draftDirty(detail, draft);
			var actions = h('div', { className: 'ysActions', style: { marginTop: 0, marginBottom: 12 } },
				h('button', { className: 'ysButton ysButtonPrimary', disabled: props.busy, onClick: props.onSave }, t('action.save')),
				h('button', { className: 'ysButton', disabled: props.busy, onClick: function () { props.onArchive(detail, !detail.archived); } },
					detail.archived ? t('action.unarchive') : t('action.archive')),
				h('button', { className: 'ysButton ysButtonDanger', disabled: props.busy, onClick: function () { props.onRemove(detail); } }, t('action.delete')));
			return h('div', { className: 'ysDetail' },
				h('div', { className: 'ysDetailHead' },
					h('div', { style: { flex: 1, minWidth: 0 } },
						h('div', { className: 'ysDetailTitle' }, detail.name),
						h('div', { className: 'ysDetailId' }, detail.id)),
					detail.archived ? h('span', { className: 'ysTag' }, t('file.archived')) : null,
					dirty ? h('span', { className: 'ysTag' }, '未保存') : null,
					detail.executable ? h('span', { className: 'ysTag' }, t('file.executable')) : null,
					h('button', { className: 'ysButton', onClick: function () { props.onCopy(detail.id); } }, t('action.copyId'))),
				detail.missing ? h('div', { className: 'ysHint' }, t('file.missing')) : null,
				detail.unsafe ? h('div', { className: 'ysHint' }, t('file.unsafe')) : null,
				h('div', { className: 'ysMetaGrid' },
					h('div', null, h('span', { className: 'ysMetaKey' }, t('file.type') + '：'), typeLabel(detail.mime)),
					h('div', null, h('span', { className: 'ysMetaKey' }, t('file.size') + '：'), formatBytes(detail.bytes)),
					h('div', null, h('span', { className: 'ysMetaKey' }, t('file.degree') + '：'), (detail.degree ? detail.degree.in + ' / ' + detail.degree.out : '0 / 0')),
					h('div', null, h('span', { className: 'ysMetaKey' }, t('file.updated') + '：'), relativeTime(detail.updated))),
				actions,
				h('div', { className: 'ysField' },
					h('label', { className: 'ysLabel' }, t('file.path')),
					h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
						h('code', { style: { fontSize: 11, wordBreak: 'break-all', flex: 1 } }, detail.path || ''),
						h('button', { className: 'ysButton', onClick: function () { props.onCopy(detail.path); } }, t('action.copy')))),
				h('div', { className: 'ysField' },
					h('label', { className: 'ysLabel' }, t('file.description')),
					h('input', Object.assign({ className: 'ysInput ysInputWide' }, fieldValue(draft, props.setDraft, 'description')))),
				h('div', { className: 'ysField' },
					h('label', { className: 'ysLabel' }, t('file.tags')),
					h('input', Object.assign({ className: 'ysInput ysInputWide' }, fieldValue(draft, props.setDraft, 'tags')))),
				h('div', { className: 'ysField' },
					h('label', { className: 'ysLabel' }, t('file.linksEdit')),
					h('textarea', Object.assign({ className: 'ysTextarea', rows: 2 }, fieldValue(draft, props.setDraft, 'links')))),
				neighbors.in && neighbors.in.length > 0 ? h('div', { className: 'ysField' },
					h('div', { className: 'ysLabel' }, t('file.backlinks')),
					neighbors.in.map(function (item) {
						return h('button', { key: item.id, className: 'ysNeighbor', onClick: function () { props.onOpen(item.id); } },
							'← ' + (item.missing ? shortId(item.id) + '（缺失）' : item.name));
					})) : null,
				neighbors.out && neighbors.out.length > 0 ? h('div', { className: 'ysField' },
					h('div', { className: 'ysLabel' }, t('file.linksResolved')),
					neighbors.out.map(function (item) {
						return h('button', { key: item.id, className: 'ysNeighbor', onClick: function () { props.onOpen(item.id); } },
							'→ ' + (item.missing ? shortId(item.id) + '（缺失）' : item.name));
					})) : null,
				detail.text !== undefined
					? h('div', { className: 'ysField' },
						h('label', { className: 'ysLabel' }, t('file.content')),
						detail.truncated
							? h('div', { className: 'ysHint' }, '文件超过单次读取上限，正文编辑已禁用；请用路径在外部编辑。')
							: h('textarea', Object.assign({ className: 'ysTextarea', rows: 12 }, fieldValue(draft, props.setDraft, 'content'))))
					: props.preview && props.preview.kind === 'image'
						? h('img', { className: 'ysPreview', src: 'data:' + props.preview.mime + ';base64,' + props.preview.base64, alt: detail.name })
						: props.preview && props.preview.kind === 'pdf'
							? h('iframe', { className: 'ysPreview', style: { width: '100%', height: 420 }, src: 'data:application/pdf;base64,' + props.preview.base64, title: detail.name })
							: h('div', { className: 'ysHint' }, '二进制文件：用路径打开；插件不预览内容。'));
		}

		/**
		 * The graph tab: three views of the same library.
		 *
		 * Only the active view is mounted. A canvas engine builds its layout on
		 * mount and keeps an animation loop alive, so two mounted canvases would
		 * double both; the tag tree is cheap but follows the same rule so every
		 * switch shows current data.
		 */
		function GraphTab(props) {
			var t = props.t;
			var [section, setSection] = useState('sphere');
			var graph = props.graph;
			var options = [
				['sphere', t('graph.tab.planet')],
				['network', t('graph.tab.relations')],
				['tags', t('graph.tab.tags')]
			];
			var body;
			if (graph === null || graph === undefined) {
				body = h('div', { className: 'ysEmpty' }, t('state.loading'));
			} else if (section === 'tags') {
				body = h('div', null,
					h('div', { className: 'ysHint', style: { marginBottom: 8 } }, t('graph.tags.hint')),
					h(TagGraph, { t: t, nodes: buildTagTree(props.tags), onTag: props.onTag }));
			} else {
				body = h(CanvasGraphView, {
					t: t,
					layout: section === 'network' ? 'network' : 'sphere',
					graph: graph,
					onOpen: props.onOpen
				});
			}
			return h('div', null,
				h('div', { className: 'ysTabs ysSubtabs', role: 'tablist', 'aria-label': t('tab.graph') },
					options.map(function (option) {
						return h('button', {
							key: option[0],
							type: 'button',
							role: 'tab',
							className: 'ysTab' + (section === option[0] ? ' ysTabActive' : ''),
							'aria-selected': section === option[0],
							onClick: function () { setSection(option[0]); }
						}, option[1]);
					})),
				body);
		}

		/**
		 * 注入页：模型每轮看到的文本，分成「提示词」和「偏好」两栏。
		 *
		 * 提示词栏是插件自己拼出来的两段——静态纪律进系统段、文件索引进运行时
		 * 上下文，两天分开显示是因为它们的稳定性不同；预算条放在这一栏顶部。
		 * 偏好栏是写进 `~/.dsh/AGENTS.md` 的那一段，由 DSH 的 AGENTS.md 加载器
		 * 在每次会话开始时注入，所以它跟插件版本无关，改完立刻对下一个会话生效。
		 */
		function InjectionTab(props) {
			var t = props.t;
			var [section, setSection] = useState('prompts');
			var options = [
				['prompts', t('injection.tab.prompts')],
				['preferences', t('injection.tab.preferences')]
			];
			return h('div', null,
				h('div', { className: 'ysTabs ysSubtabs', role: 'tablist', 'aria-label': t('tab.injection') },
					options.map(function (option) {
						return h('button', {
							key: option[0],
							type: 'button',
							role: 'tab',
							className: 'ysTab' + (section === option[0] ? ' ysTabActive' : ''),
							'aria-selected': section === option[0],
							onClick: function () { setSection(option[0]); }
						}, option[1]);
					})),
				section === 'preferences'
					? h(PreferencesPane, props)
					: h(PromptsPane, props));
		}

		/**
		 * 提示词栏：预算条在最上面，下面依次是静态纪律和文件索引。
		 *
		 * 预算只管文件索引（静态纪律是常量），所以条上同时写清两段的字节，
		 * 免得把「索引没超预算」误读成「整个注入很轻」。
		 */
		function PromptsPane(props) {
			var t = props.t;
			var injection = props.injection;
			var [busy, setBusy] = useState(false);
			if (injection === null || injection === undefined) return h('div', { className: 'ysEmpty' }, t('state.loading'));
			var budget = Number(injection.budget) || 0;
			var bytes = Number(injection.bytes) || 0;
			var staticBytes = Number(injection.staticBytes) || 0;
			var percent = budget > 0 ? Math.min(100, Math.round((bytes / budget) * 100)) : 0;
			function refresh() {
				setBusy(true);
				props.call('injection', { refresh: true }).then(function (value) {
					props.onLoaded(value);
					props.notify(t('injection.refreshed'));
				}).catch(function (error) {
					props.notify(messageOf(error), true);
				}).then(function () { setBusy(false); });
			}
			return h('div', null,
				h('div', { className: 'ysMeter' },
					h('div', { className: 'ysMeterFill', style: { width: percent + '%' } }),
					h('span', { className: 'ysMeterText' }, bytes + ' / ' + budget + ' B · ' + percent + '%')),
				h('div', { className: 'ysHint', style: { marginBottom: 10 } },
					t('injection.total')
						.replace('{static}', String(staticBytes))
						.replace('{index}', String(bytes))
						.replace('{total}', String(staticBytes + bytes))),
				h('div', { className: 'ysSection', style: { marginTop: 0 } }, t('injection.static')),
				h('div', { className: 'ysHint', style: { marginBottom: 8 } },
					t('injection.static.hint').replace('{bytes}', String(staticBytes))),
				h('pre', { className: 'ysPre' }, injection.static),
				h('div', { className: 'ysSection' }, t('injection.index')),
				h('div', { className: 'ysHint', style: { marginBottom: 8 } },
					t('injection.meta')
						.replace('{day}', injection.day === '' ? t('injection.never') : String(injection.day))
						.replace('{entries}', String(injection.entries ?? 0))
						.replace('{state}', injection.stale ? t('injection.stale') : t('injection.fresh'))),
				h('pre', { className: 'ysPre' }, injection.index),
				h('div', { className: 'ysActions' },
					h('button', { className: 'ysButton', disabled: busy, onClick: refresh }, t('injection.refresh'))));
		}

		/**
		 * 偏好栏：编辑 `~/.dsh/AGENTS.md` 里插件维护的那一段。
		 *
		 * 这个文件是 DSH 的全局指令文件，插件只碰自己那对标记之间的内容；
		 * 读失败时禁用保存，免得把空串写回去把用户的规则清空。
		 */
		function PreferencesPane(props) {
			var t = props.t;
			var preferences = props.preferences;
			var [draft, setDraft] = useState('');
			var [busy, setBusy] = useState(false);
			var [loadedAt, setLoadedAt] = useState('');
			useEffect(function () {
				if (preferences === null || preferences === undefined) return;
				setDraft(String(preferences.content ?? ''));
				setLoadedAt(String(preferences.content ?? ''));
			}, [preferences]);
			if (preferences === null || preferences === undefined) return h('div', { className: 'ysEmpty' }, t('state.loading'));
			var dirty = draft !== loadedAt;
			var cap = Number(preferences.cap) || 0;
			var bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(draft).length : draft.length;
			var overCap = cap > 0 && bytes > cap;
			function save() {
				setBusy(true);
				props.call('preferences-save', { content: draft }).then(function (value) {
					props.onPreferences(value);
					setDraft(String(value.content ?? ''));
					setLoadedAt(String(value.content ?? ''));
					props.notify(t('preferences.saved'));
				}).catch(function (error) {
					props.notify(messageOf(error), true);
				}).then(function () { setBusy(false); });
			}
			return h('div', null,
				h('div', { className: 'ysHint', style: { marginBottom: 8 } }, t('preferences.hint')),
				h('div', { className: 'ysField' },
					h('label', { className: 'ysLabel' }, t('preferences.file')),
					h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
						h('code', { style: { fontSize: 11, wordBreak: 'break-all', flex: 1 } }, preferences.path || ''),
						h('button', { className: 'ysButton', onClick: function () { props.onCopy(preferences.path); } }, t('action.copy')))),
				preferences.link
					? h('div', { className: 'ysHint', style: { marginBottom: 8 } }, t('preferences.link').replace('{target}', String(preferences.link)))
					: null,
				preferences.readable === false
					? h('div', { className: 'ysIssue' }, t('preferences.unreadable'))
					: null,
				preferences.hasBlock !== true && preferences.exists
					? h('div', { className: 'ysHint', style: { marginBottom: 8 } }, t('preferences.append'))
					: null,
				h('textarea', {
					className: 'ysTextarea',
					rows: 18,
					style: { fontFamily: 'var(--dsw-font-family-mono,ui-monospace,monospace)', fontSize: 12, lineHeight: '18px' },
					value: draft,
					disabled: preferences.readable === false,
					onChange: function (event) { setDraft(event.target.value); }
				}),
				h('div', { className: 'ysActions', style: { justifyContent: 'space-between' } },
					h('span', { className: 'ysHint' },
						bytes + ' / ' + cap + ' B' + (dirty ? ' · ' + t('preferences.dirty') : '')),
					h('span', { style: { display: 'flex', gap: 8 } },
						h('button', {
							className: 'ysButton',
							disabled: !dirty,
							onClick: function () { setDraft(loadedAt); }
						}, t('preferences.reset')),
						h('button', {
							className: 'ysButton ysButtonPrimary',
							disabled: busy || !dirty || overCap || preferences.readable === false,
							onClick: save
						}, t('preferences.save')))));
		}

		/**
		 * 自衍页：整理会话与文件。
		 *
		 * 会话区回答“哪些对话还没沉淀”，文件区回答“库里哪些地方需要收拾”。
		 * 两个维护动作（重建索引、重新读取）是这里唯一会写库的操作，会话本身
		 * 只读——把对话变成文件仍然由 agent 在会话里完成。
		 */
		function OrganizeTab(props) {
			var t = props.t;
			var digest = props.digest;
			var [busy, setBusy] = useState('');
			var [message, setMessage] = useState('');
			if (digest === null || digest === undefined) return h('div', { className: 'ysEmpty' }, t('state.loading'));
			var organize = digest.organize || {};
			var sessions = Array.isArray(digest.sessions) ? digest.sessions : [];
			var issues = [
				['orphans', t('organize.orphans'), t('organize.orphans.hint'), organize.orphans],
				['dangling', t('organize.dangling'), t('organize.dangling.hint'), organize.dangling],
				['stale', t('organize.stale').replace('{days}', String(organize.staleDays ?? 90)), t('organize.stale.hint'), organize.stale],
				['singleTags', t('organize.singleTags'), t('organize.singleTags.hint'), organize.singleTags]
			];
			function rebuild() {
				setBusy('rebuild');
				props.call('rebuild').then(function (value) {
					setMessage(t('organize.rebuilt')
						.replace('{files}', String(value.files))
						.replace('{links}', String(value.links))
						.replace('{ms}', String(value.ms)));
					props.onRefreshAll();
				}).catch(function (error) {
					props.notify(messageOf(error), true);
				}).then(function () { setBusy(''); });
			}
			function reload() {
				setBusy('reload');
				props.call('digest').then(props.onLoaded).catch(function (error) {
					props.notify(messageOf(error), true);
				}).then(function () { setBusy(''); });
			}
			function sampleRow(key, item, index) {
				if (key === 'singleTags') return h('li', { className: 'ysIssueItem', key: 'i' + index }, item.tag);
				if (key === 'dangling') {
					return h('li', { className: 'ysIssueItem', key: 'i' + index },
						(item.fromName === '' ? item.from : item.fromName) + ' → ' + String(item.to).slice(0, 12));
				}
				return h('li', {
					className: 'ysIssueItem',
					key: 'i' + index,
					role: 'button',
					tabIndex: 0,
					onClick: function () { props.onOpen(item.id); }
				}, item.name + ' · ' + item.description);
			}
			return h('div', null,
				h('div', { className: 'ysSection' }, t('organize.sessions')),
				h('div', { className: 'ysHint', style: { marginBottom: 8 } },
					t('organize.sessions.hint') + ' · '
					+ t('organize.sessions.total')
						.replace('{n}', String(digest.sessionTotal ?? sessions.length))
						.replace('{m}', String(digest.unreadable ?? 0))),
				sessions.length === 0
					? h('div', { className: 'ysEmpty' }, t('organize.noSessions'))
					: h('div', null, sessions.map(function (session) {
						return h('div', { className: 'ysSessionRow', key: session.id },
							h('span', { className: 'ysSessionTitle' }, session.title === '' ? session.id : session.title),
							h('span', { className: 'ysSessionMeta' }, t('organize.session.turns').replace('{n}', String(session.prompts))),
							h('span', { className: 'ysSessionMeta' }, relativeTime(session.updatedAt)));
					})),
				h('div', { className: 'ysSection' }, t('organize.issues')),
				h('div', { className: 'ysIssueGrid' }, issues.map(function (issue) {
					var card = issue[3] || {};
					var samples = Array.isArray(card.sample) ? card.sample : [];
					return h('div', { className: 'ysIssue', key: issue[0] },
						h('div', { className: 'ysIssueTitle' }, issue[1]),
						h('div', { className: 'ysIssueCount' }, String(card.total ?? 0)),
						h('div', { className: 'ysIssueHint' }, issue[2]),
						samples.length === 0
							? h('div', { className: 'ysIssueHint' }, t('organize.empty'))
							: h('ul', { className: 'ysIssueList' }, samples.map(function (item, index) {
								return sampleRow(issue[0], item, index);
							})));
				})),
				h('div', { className: 'ysSection' }, t('organize.actions')),
				h('div', { className: 'ysActions' },
					h('button', { className: 'ysButton', disabled: busy !== '', onClick: rebuild }, t('organize.rebuild')),
					h('button', { className: 'ysButton', disabled: busy !== '', onClick: reload }, t('organize.reload')),
					message === '' ? null : h('span', { className: 'ysHint', style: { alignSelf: 'center' } }, message)));
		}


		function downloadBase64(base64, name) {
			if (typeof document === 'undefined' || typeof atob !== 'function') return;
			const binary = atob(base64);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
			const blob = new Blob([bytes], { type: 'application/gzip' });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = name;
			anchor.style.display = 'none';
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
		}

		function DataSection(props) {
			var t = props.t;
			var call = props.call;
			var notify = props.notify;
			var status = props.status;
			var [dir, setDir] = useState('');
			var [mode, setMode] = useState('copy');
			var [importDir, setImportDir] = useState('');
			var [importFile, setImportFile] = useState(null);
			var [busy, setBusy] = useState(false);
			var [message, setMessage] = useState('');
			var importRef = useRef(null);
			if (status === null || status === undefined) return h('div', { className: 'ysHint' }, t('state.loading'));

			function saveDir() {
				setBusy(true);
				setMessage('');
				call('data-dir-save', { dir: dir, mode: mode }, 120000).then(function (value) {
					setMessage(t('settings.data.saved') + ' ' + value.dir);
					props.onRefresh();
				}).catch(function (error) { notify(messageOf(error), true); }).then(function () { setBusy(false); });
			}

			function exportNow() {
				setBusy(true);
				setMessage('');
				call('data-export', {}, 120000).then(function (value) {
					downloadBase64(value.base64, value.name);
					setMessage(t('settings.data.exported') + '：' + value.name + ' · ' + formatBytes(value.archiveBytes));
				}).catch(function (error) { notify(messageOf(error), true); }).then(function () { setBusy(false); });
			}

			function pickImport(event) {
				var file = event.target.files && event.target.files[0];
				event.target.value = '';
				if (!file) return;
				if (file.size > 32 * 1024 * 1024) {
					notify('压缩包超过 32 MB 上限。', true);
					return;
				}
				var reader = new FileReader();
				reader.onload = function () {
					setImportFile({ name: file.name, data: String(reader.result), size: file.size });
					setMessage('');
				};
				reader.onerror = function () { notify('读取压缩包失败。', true); };
				reader.readAsDataURL(file);
			}

			function importNow() {
				if (importFile === null) {
					notify('先选择一个 .tar.gz 压缩包。', true);
					return;
				}
				setBusy(true);
				setMessage('');
				call('data-import', { data: importFile.data, dir: importDir }, 120000).then(function (value) {
					setImportFile(null);
					setImportDir('');
					setMessage(t('settings.data.imported') + ' ' + value.dir);
					props.onRefresh();
				}).catch(function (error) { notify(messageOf(error), true); }).then(function () { setBusy(false); });
			}

			return h('div', null,
				h('div', { className: 'ysField' },
					h('label', { className: 'ysLabel' }, t('settings.data.current')),
					h('code', { style: { fontSize: 11, wordBreak: 'break-all' } }, status.current + ' · ' + status.files + ' 文件')),
				status.pending
					? h('div', { className: 'ysHint', style: { marginBottom: 10 } },
						t('settings.data.pending') + '：' + status.pending + (status.pendingExists ? '' : '（目标不存在）'))
					: null,
				h('div', { className: 'ysToolbar' },
					h('input', {
						className: 'ysInput',
						placeholder: '/absolute/path/to/ziyan',
						value: dir,
						onChange: function (event) { setDir(event.target.value); }
					}),
					h('select', {
						className: 'ysSelect',
						value: mode,
						onChange: function (event) { setMode(event.target.value); }
					},
						h('option', { value: 'copy' }, t('settings.data.copy')),
						h('option', { value: 'attach' }, t('settings.data.attach'))),
					h('button', { className: 'ysButton', disabled: busy, onClick: saveDir }, t('settings.data.save'))),
				h('div', { className: 'ysHint', style: { marginBottom: 10 } },
					mode === 'copy' ? t('settings.data.copyHint') : t('settings.data.attachHint')),
				h('div', { className: 'ysToolbar' },
					h('button', { className: 'ysButton', disabled: busy, onClick: function () { importRef.current?.click(); } }, t('settings.data.choose')),
					h('input', { ref: importRef, type: 'file', accept: '.tar.gz,.tgz,.tar', style: { display: 'none' }, onChange: pickImport }),
					h('input', {
						className: 'ysInput',
						placeholder: t('settings.data.importDir'),
						value: importDir,
						onChange: function (event) { setImportDir(event.target.value); }
					}),
					h('button', { className: 'ysButton ysButtonPrimary', disabled: busy || importFile === null, onClick: importNow },
						importFile ? '导入 ' + importFile.name : t('settings.data.import'))),
				h('div', { className: 'ysHint', style: { marginBottom: 10 } }, t('settings.data.importHint')),
				h('div', { className: 'ysToolbar' },
					h('button', { className: 'ysButton', disabled: busy, onClick: exportNow }, t('settings.data.export')),
					h('span', { className: 'ysHint' }, t('settings.data.exportHint'))),
				message ? h('div', { className: 'ysHint' }, message) : null,
				h('div', { className: 'ysHint', style: { marginTop: 6 } }, t('settings.data.restart')));
		}

		function SettingsTab(props) {
			var t = props.t;
			var settings = props.settings;
			var [draft, setDraft] = useState(null);
			var [subTab, setSubTab] = useState('general');
			useEffect(function () {
				if (settings === null || settings === undefined) return;
				setDraft({
					descriptionMaxChars: settings.descriptionMaxChars,
					maxFileMb: Math.round((settings.maxFileBytes || 0) / 1024 / 1024),
					readTextKb: Math.round((settings.readTextBytes || 0) / 1024),
					injectionBudget: settings.injectionBudget
				});
			}, [settings]);
			if (settings === null || settings === undefined || draft === null) return h('div', { className: 'ysEmpty' }, t('state.loading'));
			var general = h('div', null,
				h('div', { className: 'ysField' },
					h('label', { className: 'ysLabel' }, t('settings.descriptionMaxChars')),
					h('input', { className: 'ysInput', type: 'number', min: 20, max: 200, value: draft.descriptionMaxChars, onChange: function (event) { setDraft(Object.assign({}, draft, { descriptionMaxChars: Number(event.target.value) })); } })),
				h('div', { className: 'ysField' },
					h('label', { className: 'ysLabel' }, t('settings.maxFileMb')),
					h('input', { className: 'ysInput', type: 'number', min: 1, max: 200, value: draft.maxFileMb, onChange: function (event) { setDraft(Object.assign({}, draft, { maxFileMb: Number(event.target.value) })); } }),
					h('div', { className: 'ysHint', style: { marginTop: 4 } }, '上传接口硬上限 20 MB，与单文件上限独立。')),
				h('div', { className: 'ysField' },
					h('label', { className: 'ysLabel' }, t('settings.readTextKb')),
					h('input', { className: 'ysInput', type: 'number', min: 4, max: 4096, value: draft.readTextKb, onChange: function (event) { setDraft(Object.assign({}, draft, { readTextKb: Number(event.target.value) })); } })),
				h('div', { className: 'ysField' },
					h('label', { className: 'ysLabel' }, t('settings.injectionBudget')),
					h('input', { className: 'ysInput', type: 'number', min: 1024, max: 16384, value: draft.injectionBudget, onChange: function (event) { setDraft(Object.assign({}, draft, { injectionBudget: Number(event.target.value) })); } })),
				h('div', { className: 'ysActions' },
					h('button', {
						className: 'ysButton ysButtonPrimary',
						onClick: function () {
							props.onSave({
								descriptionMaxChars: draft.descriptionMaxChars,
								maxFileBytes: draft.maxFileMb * 1024 * 1024,
								readTextBytes: draft.readTextKb * 1024,
								injectionBudget: draft.injectionBudget
							});
						}
					}, t('action.save'))));
			return h('div', { style: { maxWidth: 620 } },
				h('div', { className: 'ysTabs ysSubtabs' },
					h('button', {
						className: 'ysTab' + (subTab === 'general' ? ' ysTabActive' : ''),
						onClick: function () { setSubTab('general'); }
					}, t('settings.tab.general')),
					h('button', {
						className: 'ysTab' + (subTab === 'data' ? ' ysTabActive' : ''),
						onClick: function () { setSubTab('data'); }
					}, t('settings.tab.data'))),
				h('div', { style: { display: subTab === 'general' ? 'block' : 'none' } }, general),
				h('div', { style: { display: subTab === 'data' ? 'block' : 'none' } },
					h(DataSection, props)));
		}

		function LogsTab(props) {
			var t = props.t;
			var logs = props.logs;
			if (logs === null || logs === undefined) return h('div', { className: 'ysEmpty' }, t('state.loading'));
			return h('div', null,
				h('div', { className: 'ysToolbar' },
					h('span', { className: 'ysHint' }, logs.path || ''),
					h('button', { className: 'ysButton', onClick: props.onRefresh }, t('action.refresh'))),
				h('pre', { className: 'ysPre', style: { maxHeight: 520 } }, (logs.lines || []).join('\n') || '—'));
		}

		function Dialog(props) {
			var t = props.t;
			var dialog = props.dialog;
			var setDialog = props.setDialog;
			useEffect(function () {
				function onKey(event) {
					if (event.key === 'Escape') props.onClose();
				}
				if (typeof window !== 'undefined') window.addEventListener('keydown', onKey);
				return function () {
					if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
				};
			}, [props.onClose]);
			if (dialog === null || dialog === undefined) return null;
			var isUpload = dialog.kind === 'upload';
			return h('div', { className: 'ysModal', role: 'dialog', 'aria-modal': 'true', onMouseDown: function (event) { if (event.target === event.currentTarget) props.onClose(); } },
				h('div', { className: 'ysModalCard' },
					h('div', { className: 'ysModalHead' },
						h('span', null, isUpload ? t('upload.title') : t('create.title')),
						h('button', { className: 'ysClose', onClick: props.onClose }, '×')),
					h('div', { className: 'ysModalBody' },
						h('div', { className: 'ysField' },
							h('label', { className: 'ysLabel' }, t('form.name')),
							h('input', Object.assign({ className: 'ysInput ysInputWide' }, fieldValue(dialog, setDialog, 'name'), { readOnly: isUpload }))),
						h('div', { className: 'ysField' },
							h('label', { className: 'ysLabel' }, t('form.description')),
							h('input', Object.assign({ className: 'ysInput ysInputWide' }, fieldValue(dialog, setDialog, 'description')))),
						h('div', { className: 'ysField' },
							h('label', { className: 'ysLabel' }, t('form.tags')),
							h('input', Object.assign({ className: 'ysInput ysInputWide' }, fieldValue(dialog, setDialog, 'tags')))),
						h('div', { className: 'ysField' },
							h('label', { className: 'ysLabel' }, t('form.links')),
							h('input', Object.assign({ className: 'ysInput ysInputWide' }, fieldValue(dialog, setDialog, 'links')))),
						isUpload ? null : h('div', { className: 'ysField' },
							h('label', { className: 'ysLabel' }, t('form.content')),
							h('textarea', Object.assign({ className: 'ysTextarea', rows: 8 }, fieldValue(dialog, setDialog, 'content')))),
						isUpload ? h('div', { className: 'ysHint' }, '文件：' + dialog.name + ' · ' + formatBytes(dialog.size)) : null),
					h('div', { className: 'ysModalFoot' },
						h('button', { className: 'ysButton', onClick: props.onClose }, t('action.cancel')),
						h('button', { className: 'ysButton ysButtonPrimary', disabled: props.busy, onClick: props.onSubmit }, props.busy ? '处理中…' : (isUpload ? '上传' : '创建')))));
		}

		function Panel(props) {
			var ctx = props.ctx;
			var t = props.t;
			var call = useCallback(function (endpoint, payload, timeoutMs) { return callHost(ctx, endpoint, payload, timeoutMs); }, [ctx]);
			var [tab, setTab] = useState('overview');
			var [overview, setOverview] = useState(null);
			var [files, setFiles] = useState(null);
			var [query, setQuery] = useState('');
			var [tagFilter, setTagFilter] = useState('');
			// `null` means no suffix filter; `''` means "files without an
			// extension", which the type matrix has a tile for.
			var [suffix, setSuffix] = useState(null);
			var [archived, setArchived] = useState(false);
			// One page of the list, sized to the height the list is given.
			var [page, setPage] = useState(0);
			var [pageSize, setPageSize] = useState(10);
			var [selectedId, setSelectedId] = useState('');
			var [detail, setDetail] = useState(null);
			var [draft, setDraft] = useState(null);
			var [preview, setPreview] = useState(null);
			var [graph, setGraph] = useState(null);
			var [injection, setInjection] = useState(null);
			var [preferences, setPreferences] = useState(null);
			var [digest, setDigest] = useState(null);
			var [settings, setSettings] = useState(null);
			var [logs, setLogs] = useState(null);
			var [dataStatus, setDataStatus] = useState(null);
			var [dialog, setDialog] = useState(null);
			var [busy, setBusy] = useState(false);
			var [toast, setToast] = useState(null);
			var [loadError, setLoadError] = useState(null);
			var seq = useRef({ overview: 0, files: 0, detail: 0 });
			var toastTimer = useRef(0);
			var editorState = useRef({ detail: null, draft: null, selectedId: '' });
			editorState.current = { detail: detail, draft: draft, selectedId: selectedId };

			var notify = useCallback(function (message, isError) {
				setToast({ message: message, error: isError === true });
				clearTimeout(toastTimer.current);
				toastTimer.current = setTimeout(function () { setToast(null); }, 4200);
			}, []);

			var loadOverview = useCallback(function () {
				var token = ++seq.current.overview;
				return call('overview').then(function (value) {
					if (token === seq.current.overview) { setOverview(value); setLoadError(null); }
				}).catch(function (error) { setLoadError(messageOf(error)); notify(messageOf(error), true); });
			}, [call, notify]);

			var loadFiles = useCallback(function () {
				var token = ++seq.current.files;
				return call('file-list', {
					query: query,
					tags: tagFilter === '' ? [] : [tagFilter],
					suffix: suffix,
					archived: archived,
					limit: pageSize,
					offset: page * pageSize
				}).then(function (value) {
					if (token !== seq.current.files) return;
					// A filter can shrink the result under the current page; walk
					// back instead of showing an empty page.
					var pages = Math.max(1, Math.ceil(value.total / Math.max(1, pageSize)));
					if (page > pages - 1) {
						setPage(pages - 1);
						return;
					}
					setFiles(value);
					setLoadError(null);
				}).catch(function (error) { setLoadError(messageOf(error)); notify(messageOf(error), true); });
			}, [call, query, tagFilter, suffix, archived, page, pageSize, notify]);

			var closeDetail = useCallback(function () {
				setSelectedId('');
				setDetail(null);
				setDraft(null);
				setPreview(null);
			}, []);

			var loadDetail = useCallback(function (id) {
				var token = ++seq.current.detail;
				setBusy(true);
				setDetail(null);
				setDraft(null);
				setPreview(null);
				return call('file-read', { id: id }).then(function (file) {
					if (token !== seq.current.detail) return;
					if (file && file.found === false) {
						setLoadError('文件不存在');
						notify('文件不存在', true);
						return;
					}
					setLoadError(null);
					setDetail(file);
					setDraft({
						description: file.description || '',
						tags: (file.tags || []).join(', '),
						links: (file.links || []).join('\n'),
						content: file.text || ''
					});
					if (file.mime && (file.mime.indexOf('image/') === 0 || file.mime === 'application/pdf')) {
						return call('file-preview', { id: file.id }).then(function (value) {
							if (token === seq.current.detail) setPreview(value);
						}).catch(function () {});
					}
					return undefined;
				}).catch(function (error) { setLoadError(messageOf(error)); notify(messageOf(error), true); }).then(function () {
					if (token === seq.current.detail) setBusy(false);
				});
			}, [call, notify]);

			var openFile = useCallback(function (id) {
				var current = editorState.current;
				if (id !== current.selectedId && draftDirty(current.detail, current.draft)) {
					if (typeof window !== 'undefined' && typeof window.confirm === 'function'
						&& !window.confirm('有未保存的修改，放弃并打开另一个文件？')) return;
				}
				setTab('files');
				setSelectedId(id);
				loadDetail(id);
			}, [loadDetail]);

			var loadDataStatus = useCallback(function () {
				return call('data-status').then(setDataStatus).catch(function (error) { setLoadError(messageOf(error)); notify(messageOf(error), true); });
			}, [call, notify]);

			useEffect(function () {
				loadOverview();
				loadDataStatus();
				call('settings').then(setSettings).catch(function (error) { setLoadError(messageOf(error)); notify(messageOf(error), true); });
				call('logs', { limit: 200 }).then(setLogs).catch(function (error) { setLoadError(messageOf(error)); });
			}, [loadOverview, loadDataStatus, call, notify]);

			useEffect(function () {
				if (tab !== 'files') return undefined;
				var timer = setTimeout(loadFiles, query === '' ? 0 : 220);
				return function () { clearTimeout(timer); };
			}, [tab, query, tagFilter, suffix, archived, page, pageSize, loadFiles]);

			// A changed filter means a new result set, and page 4 of the old one
			// is meaningless in it.
			useEffect(function () {
				setPage(0);
			}, [query, tagFilter, suffix, archived]);

			useEffect(function () {
				if (tab !== 'graph') return undefined;
				call('graph').then(setGraph).catch(function (error) { setLoadError(messageOf(error)); notify(messageOf(error), true); });
				return undefined;
			}, [tab, call, notify]);

			useEffect(function () {
				if (tab !== 'logs') return undefined;
				call('logs', { limit: 200 }).then(setLogs).catch(function (error) { setLoadError(messageOf(error)); notify(messageOf(error), true); });
				return undefined;
			}, [tab, call, notify]);

			useEffect(function () {
				if (tab !== 'injection') return undefined;
				call('injection').then(setInjection).catch(function (error) { setLoadError(messageOf(error)); notify(messageOf(error), true); });
				// The preferences file lives outside the library and another
				// session may have edited it; read it whenever the tab opens.
				call('preferences').then(setPreferences).catch(function (error) { setLoadError(messageOf(error)); notify(messageOf(error), true); });
				return undefined;
			}, [tab, call, notify]);

			useEffect(function () {
				if (tab !== 'organize') return undefined;
				call('digest').then(setDigest).catch(function (error) { setLoadError(messageOf(error)); notify(messageOf(error), true); });
				return undefined;
			}, [tab, call, notify]);

			function saveDetail() {
				if (detail === null || draft === null) return;
				var payload = {
					id: detail.id,
					description: draft.description,
					tags: splitText(draft.tags),
					links: splitText(draft.links)
				};
				if (detail.text !== undefined && detail.truncated !== true) payload.content = draft.content;
				setBusy(true);
				call('file-write', payload).then(function (saved) {
					if (saved && Array.isArray(saved.warnings) && saved.warnings.length > 0) {
						notify('已保存，但丢弃了：' + saved.warnings.join('；'), true);
					} else {
						notify(t('msg.saved'));
					}
					loadDetail(detail.id);
					loadFiles();
					loadOverview();
				}).catch(function (error) { notify(messageOf(error), true); }).then(function () { setBusy(false); });
			}

			function archiveFile(file, next) {
				call('file-archive', { id: file.id, archived: next }).then(function () {
					notify(next ? t('msg.archived') : t('msg.unarchived'));
					loadDetail(file.id);
					loadFiles();
					loadOverview();
				}).catch(function (error) { notify(messageOf(error), true); });
			}

			function removeFile(file) {
				if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm('删除 ' + file.name + '？文件会先进回收站。')) return;
				call('file-remove', { id: file.id }).then(function () {
					notify(t('msg.deleted'));
					setSelectedId('');
					setDetail(null);
					setDraft(null);
					loadFiles();
					loadOverview();
				}).catch(function (error) { notify(messageOf(error), true); });
			}

			function pickFile(event) {
				var file = event.target.files && event.target.files[0];
				event.target.value = '';
				if (!file) return;
				if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
					notify('文件超过 ' + MAX_UPLOAD_MB + ' MB 上传上限。', true);
					return;
				}
				var reader = new FileReader();
				reader.onload = function () {
					setDialog({
						kind: 'upload',
						name: file.name,
						size: file.size,
						data: String(reader.result),
						description: '',
						tags: '',
						links: ''
					});
				};
				reader.onerror = function () { notify('读取文件失败', true); };
				reader.readAsDataURL(file);
			}

			function submitDialog() {
				if (dialog === null) return;
				var tags = splitText(dialog.tags);
				var links = splitText(dialog.links);
				if (String(dialog.description || '').trim() === '') {
					notify('描述不能为空。', true);
					return;
				}
				if (tags.length === 0) {
					notify('至少填一个标签。', true);
					return;
				}
				setBusy(true);
				var task = dialog.kind === 'upload'
					? call('file-upload', { name: dialog.name, description: dialog.description, tags: tags, links: links, data: dialog.data })
					: call('file-write', { name: dialog.name, description: dialog.description, tags: tags, links: links, content: dialog.content || '' });
				task.then(function (file) {
					if (file && Array.isArray(file.warnings) && file.warnings.length > 0) {
						notify('已保存，但丢弃了：' + file.warnings.join('；'), true);
					} else {
						notify(t('msg.saved'));
					}
					setDialog(null);
					loadFiles();
					loadOverview();
					if (file && file.id) openFile(file.id);
				}).catch(function (error) { notify(messageOf(error), true); }).then(function () { setBusy(false); });
			}

			var refreshAll = useCallback(function () {
				setLoadError(null);
				loadOverview();
				loadFiles();
				call('settings').then(setSettings).catch(function (error) { setLoadError(messageOf(error)); });
				call('logs', { limit: 200 }).then(setLogs).catch(function (error) { setLoadError(messageOf(error)); });
				if (tab === 'graph') call('graph').then(setGraph).catch(function (error) { setLoadError(messageOf(error)); });
			}, [call, loadOverview, loadFiles, tab]);

			var tabs = [
				['overview', t('tab.overview')],
				['graph', t('tab.graph')],
				['files', t('tab.files')],
				['injection', t('tab.injection')],
				['organize', t('tab.organize')],
				['settings', t('tab.settings')],
				['logs', t('tab.logs')]
			];

			return h('div', { className: 'ysRoot' },
				h('div', { className: 'ysHead' },
					h('div', { className: 'ysHeadMain' },
						h('h1', { className: 'ysTitle' }, t('panel'),
							overview && overview.version ? h('span', { className: 'ysVersion' }, overview.version) : null),
						h('div', { className: 'ysSubtitle' }, settings ? settings.dataDir : '')),
					h('div', { className: 'ysHeadActions' },
						h('button', {
							className: 'ysButton',
							disabled: busy,
							onClick: refreshAll
						}, t('action.refresh')))),
				h('div', { className: 'ysTabs' },
					tabs.map(function (item) {
						return h('button', {
							key: item[0],
							className: 'ysTab' + (tab === item[0] ? ' ysTabActive' : ''),
							onClick: function () { setTab(item[0]); }
						}, item[1]);
					})),
				h('div', { className: 'ysBody' },
					loadError
						? h('div', { className: 'ysError' },
							h('span', { style: { flex: 1 } }, loadError),
							h('button', { className: 'ysButton', onClick: refreshAll }, '重试'))
						: null,
					tab === 'overview'
						? h(OverviewTab, {
							t: t,
							overview: overview,
							onType: function (value) { setSuffix(value); setTab('files'); }
						})
						: tab === 'files'
							? h(FilesTab, {
								t: t,
								files: files,
								selectedId: selectedId,
								query: query,
								setQuery: setQuery,
								tag: tagFilter,
								setTag: setTagFilter,
								suffix: suffix,
								setSuffix: setSuffix,
								suffixes: overview === null || overview === undefined ? [] : overview.suffixes,
								archived: archived,
								setArchived: setArchived,
								detail: detail,
								draft: draft,
								setDraft: setDraft,
								preview: preview,
								busy: busy,
								onOpen: openFile,
								onSave: saveDetail,
								onArchive: archiveFile,
								onRemove: removeFile,
								onPickFile: pickFile,
								onNew: function () { setDialog({ kind: 'create', name: 'note.md', description: '', tags: '', links: '', content: '' }); },
								page: page,
								pageSize: pageSize,
								onPage: setPage,
								onPageSize: setPageSize,
								onCloseDetail: closeDetail,
								onClear: function () { setQuery(''); setTagFilter(''); setSuffix(null); setArchived(false); },
								onCopy: function (path) {
									if (typeof navigator !== 'undefined' && navigator.clipboard) {
										navigator.clipboard.writeText(String(path || '')).then(function () { notify(t('action.copied')); }).catch(function () { notify('复制失败', true); });
									}
								}
							})
							: tab === 'graph'
								? h(GraphTab, {
									t: t,
									graph: graph,
									tags: overview === null || overview === undefined ? [] : overview.tags,
									onOpen: openFile,
									onTag: function (tag) { setTagFilter(tag); setTab('files'); }
								})
								: tab === 'settings'
									? h(SettingsTab, {
										t: t,
										settings: settings,
										call: call,
										notify: notify,
										status: dataStatus,
										onRefresh: loadDataStatus,
										onSave: function (patch) {
											call('settings-save', patch).then(function (value) {
												setSettings(value);
												notify(t('msg.saved'));
												loadOverview();
											}).catch(function (error) { notify(messageOf(error), true); });
										}
									})
									: tab === 'injection'
										? h(InjectionTab, {
											t: t,
											injection: injection,
											preferences: preferences,
											call: call,
											notify: notify,
											onLoaded: setInjection,
											onPreferences: setPreferences,
											onCopy: function (path) {
												if (typeof navigator !== 'undefined' && navigator.clipboard) {
													navigator.clipboard.writeText(String(path || '')).then(function () { notify(t('action.copied')); }).catch(function () { notify('复制失败', true); });
												}
											}
										})
										: tab === 'organize'
											? h(OrganizeTab, {
												t: t,
												digest: digest,
												call: call,
												notify: notify,
												onOpen: openFile,
												onLoaded: setDigest,
												onRefreshAll: refreshAll
											})
											: h(LogsTab, { t: t, logs: logs, onRefresh: function () { call('logs', { limit: 200 }).then(setLogs).catch(function (error) { notify(messageOf(error), true); }); } })),
				dialog ? h(Dialog, { t: t, dialog: dialog, setDialog: setDialog, busy: busy, onSubmit: submitDialog, onClose: function () { setDialog(null); } }) : null,				toast ? h('div', { className: 'ysToast' + (toast.error ? ' ysToastError' : ''), role: 'status', 'aria-live': 'polite' }, toast.message) : null);
		}

		//#endregion

		//#region plugin

		var inject = ['slots', 'locale', 'connection'];

		function apply(ctx) {
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, 'dsh-ziyan: dictionaries');

			var t = ctx.locale.bind(NS);

			ctx.effect(function () {
				var style = document.createElement('style');
				style.dataset.plugin = 'dsh-ziyan';
				style.textContent = css;
				document.head.appendChild(style);
				return function () { style.remove(); };
			}, 'dsh-ziyan: styles');

			ctx.effect(function () {
				return ctx.slots.inject('main', function () {
					return ctx.slots.register({
						name: 'main',
						key: PANEL_ID,
						locale: NS,
						inject: function () { return { ctx: ctx, t: t }; }
					}, Panel);
				});
			}, 'dsh-ziyan: main panel');

			ctx.effect(function () {
				return ctx.slots.inject('sidebar.panellist', function () {
					return ctx.slots.register({
						name: 'sidebar.panellist',
						id: PANEL_ID,
						order: PANEL_ORDER,
						locale: NS,
						label: function () { return t('panel'); }
					}, Icon);
				});
			}, 'dsh-ziyan: sidebar entry');
		}

		//#endregion

		/*
		 * The layout math is pure and the browser half has no import surface, so
		 * `node --test` reaches it through this seam instead of a canvas. The
		 * panel never reads it.
		 */
		return {
			inject: inject,
			apply: apply,
			__graph: {
				canvasGraphData: canvasGraphData,
				radiusOf: radiusOf,
				massOf: massOf,
				sphereLayout: sphereLayout,
				SphereLayout: SphereLayout,
				NetworkLayout: NetworkLayout
			}
		};
	}
});
