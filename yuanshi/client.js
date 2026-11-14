/*
 * 元始 — browser half.
 *
 * One sidebar entry opens one panel:
 * 概览 / 文件 / 图谱 / 设置 / 日志.
 *
 * The panel never sends a path: it sends ids and the Host resolves them. The
 * list and the detail are two views of the same file entity; the graph is the
 * explicit link graph, not an inferred similarity map.
 */
window.__ModuleLoader__.load({
	id: 'dsh-yuanshi',
	factory: function (require) {
		var react = require('react');
		var h = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;
		var useCallback = react.useCallback;
		var useMemo = react.useMemo;
		var useRef = react.useRef;

		var NS = 'dsh-yuanshi';
		var PANEL_ID = 'yuanshi';
		var PANEL_ORDER = 31;
		var API_PREFIX = '/api/yuanshi';
		var MAX_UPLOAD_MB = 20;

		//#region locale

		var zh = {
			panel: '元始',
			'tab.overview': '概览',
			'tab.files': '文件',
			'tab.graph': '图谱',
			'tab.settings': '设置',
			'tab.logs': '日志',
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
			'files.more': '加载更多',
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
			'overview.links': '链接',
			'overview.tags': '标签',
			'overview.orphans': '孤儿',
			'overview.archived': '归档',
			'overview.types': '类型分布',
			'overview.topTags': '常用标签',
			'overview.recent': '最近更新',
			'overview.injection': '注入预览',
			'graph.empty': '没有可画的链接。',
			'graph.hint': '节点 = 文件，边 = 链接；点击节点打开文件。',
			'settings.dataDir': '数据目录',
			'settings.descriptionMaxChars': '描述上限（字）',
			'settings.maxFileMb': '单文件上限（MB）',
			'settings.readTextKb': '单次读取上限（KB）',
			'settings.injectionBudget': '注入预算（字节）',
			'settings.data': '数据',
			'settings.data.current': '当前数据目录',
			'settings.data.pending': '下次启动将使用',
			'settings.data.dir': '新数据目录（绝对路径）',
			'settings.data.mode': '模式',
			'settings.data.copy': '复制当前库到新目录',
			'settings.data.attach': '使用已有元始库',
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
			'settings.data.busy': '处理中…',
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
			panel: 'Yuanshi',
			'tab.overview': 'Overview',
			'tab.files': 'Files',
			'tab.graph': 'Graph',
			'tab.settings': 'Settings',
			'tab.logs': 'Logs',
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
			'files.more': 'Load more',
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
			'overview.links': 'Links',
			'overview.tags': 'Tags',
			'overview.orphans': 'Orphans',
			'overview.archived': 'Archived',
			'overview.types': 'Types',
			'overview.topTags': 'Top tags',
			'overview.recent': 'Recent',
			'overview.injection': 'Injected index',
			'graph.empty': 'No links to draw.',
			'graph.hint': 'Node = file, edge = link. Click a node to open it.',
			'settings.dataDir': 'Data directory',
			'settings.descriptionMaxChars': 'Description cap',
			'settings.maxFileMb': 'File cap (MB)',
			'settings.readTextKb': 'Read cap (KB)',
			'settings.injectionBudget': 'Injection budget (bytes)',
			'settings.data': 'Data',
			'settings.data.current': 'Current data directory',
			'settings.data.pending': 'Next start will use',
			'settings.data.dir': 'New data directory (absolute)',
			'settings.data.mode': 'Mode',
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
			'settings.data.busy': 'Working…',
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
			'.ysTab{display:inline-flex;align-items:center;height:28px;padding:0 11px;border:1px solid transparent;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}',
			'.ysTab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.ysTabActive{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500;border-color:var(--dsw-alias-border-l2)}',
			'.ysBody{flex:1;min-height:0;overflow:auto;padding:18px 28px 36px}',
			'.ysGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}',
			'.ysCard{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:14px 16px}',
			'.ysStatValue{font-size:22px;font-weight:600;line-height:28px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}',
			'.ysStatLabel{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px}',
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
			'.ysSplit{display:grid;grid-template-columns:minmax(260px,380px) minmax(0,1fr);gap:16px;align-items:start}',
			'@media(max-width:900px){.ysSplit{grid-template-columns:1fr}.ysList{max-height:none}}',
			'.ysList{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden;max-height:calc(100vh - 260px);overflow-y:auto;overscroll-behavior:contain}',
			'.ysItem{display:flex;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);cursor:pointer}',
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
			'.ysGraphWrap{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
			'.ysGraph{display:block;width:100%;height:min(62vh,560px)}',
			'.ysGraphEdge{stroke:var(--dsw-alias-border-l3);stroke-width:1}',
			'.ysGraphNode{cursor:pointer}.ysGraphNode:hover{stroke:var(--dsw-alias-label-primary);stroke-width:2}',
			'.ysGraphLabel{font-size:10px;fill:var(--dsw-alias-label-secondary);pointer-events:none}',
			'.ysLegend{display:flex;gap:12px;flex-wrap:wrap;padding:8px 12px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l2)}',
			'.ysDot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:0}',
			'.ysEmpty{padding:28px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}',
			'.ysError{display:flex;align-items:center;gap:10px;padding:9px 12px;margin-bottom:12px;border:1px solid var(--dsw-alias-state-error-primary,#c45a5a);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-state-error-primary,#c45a5a);font-size:12px}',
			'.ysGraphHint{font-size:12.5px;color:var(--dsw-alias-label-secondary);margin-bottom:8px}',
			'.ysHint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.55}',
			'.ysToast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:60;padding:8px 14px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font-size:12px;box-shadow:var(--dsw-elevation-soft);max-width:70%}',
			'.ysToastError{background:var(--dsw-alias-state-error-primary,#b34545);color:#fff}',
			'.ysModal{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:24px}',
			'.ysModalCard{width:min(560px,100%);max-height:90vh;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-soft)}',
			'.ysModalHead{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l2);font-weight:600}',
			'.ysModalBody{padding:16px 18px}',
			'.ysModalFoot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l2)}',
			'.ysClose{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:18px;line-height:1;cursor:pointer}',
			'.ysBar{height:5px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:6px}',
			'.ysBarFill{height:100%;background:var(--dsw-alias-state-business-primary)}'
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

		//#region graph layout

		function layoutGraph(graph) {
			var nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
			var edges = Array.isArray(graph && graph.edges) ? graph.edges : [];
			var width = 960;
			var height = 620;
			var at = new Map();
			nodes.forEach(function (node, index) {
				var angle = index * 2.399963229728653;
				var radius = 40 + Math.sqrt(index + 1) * 42;
				at.set(node.id, {
					id: node.id,
					x: width / 2 + Math.cos(angle) * radius,
					y: height / 2 + Math.sin(angle) * radius,
					vx: 0,
					vy: 0
				});
			});
			var pairs = edges.map(function (edge) {
				return [at.get(edge.from), at.get(edge.to)];
			}).filter(function (pair) { return pair[0] !== undefined && pair[1] !== undefined; });
			var points = Array.from(at.values());
			for (var iter = 0; iter < 110; iter += 1) {
				var cooling = 1 - iter / 110;
				for (var i = 0; i < points.length; i += 1) {
					var a = points[i];
					for (var j = i + 1; j < points.length; j += 1) {
						var b = points[j];
						var dx = b.x - a.x;
						var dy = b.y - a.y;
						var dist2 = dx * dx + dy * dy + 0.01;
						var force = 640 / dist2;
						var dist = Math.sqrt(dist2);
						var fx = (dx / dist) * force;
						var fy = (dy / dist) * force;
						a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
					}
				}
				pairs.forEach(function (pair) {
					var a = pair[0]; var b = pair[1];
					var dx = b.x - a.x; var dy = b.y - a.y;
					var dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
					var force = (dist - 110) * 0.02;
					var fx = (dx / dist) * force;
					var fy = (dy / dist) * force;
					a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
				});
				points.forEach(function (point) {
					point.vx += (width / 2 - point.x) * 0.002;
					point.vy += (height / 2 - point.y) * 0.002;
					point.x += point.vx * cooling;
					point.y += point.vy * cooling;
					point.vx *= 0.72;
					point.vy *= 0.72;
					point.x = Math.max(18, Math.min(width - 18, point.x));
					point.y = Math.max(18, Math.min(height - 18, point.y));
				});
			}
			return { at: at, width: width, height: height };
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

		function OverviewTab(props) {
			var t = props.t;
			var overview = props.overview;
			if (overview === null || overview === undefined) return h('div', { className: 'ysEmpty' }, t('state.loading'));
			var stats = overview.stats || {};
			var tags = Array.isArray(overview.tags) ? overview.tags : [];
			var types = Array.isArray(stats.mimes) ? stats.mimes : [];
			var maxType = types.reduce(function (max, row) { return Math.max(max, row.count); }, 1);
			return h('div', null,
				h('div', { className: 'ysGrid' },
					[
						[t('overview.files'), stats.files],
						[t('overview.links'), stats.links],
						[t('overview.tags'), stats.tags],
						[t('overview.orphans'), stats.orphans],
						[t('overview.archived'), stats.archived]
					].map(function (item) {
						return h('div', { className: 'ysCard', key: item[0] },
							h('div', { className: 'ysStatValue' }, String(item[1] ?? 0)),
							h('div', { className: 'ysStatLabel' }, item[0]));
					})
				),
				h('div', { className: 'ysSection' }, t('overview.types')),
				types.length === 0 ? h('div', { className: 'ysEmpty' }, '—') : types.map(function (row) {
					return h('div', { key: row.mime, style: { marginBottom: 8 } },
						h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12 } },
							h('span', null, typeLabel(row.mime)),
							h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, String(row.count))),
						h('div', { className: 'ysBar' },
							h('div', { className: 'ysBarFill', style: { width: Math.max(3, (row.count / maxType) * 100) + '%' } })));
				}),
				h('div', { className: 'ysSection' }, t('overview.topTags')),
				tags.length === 0 ? h('div', { className: 'ysEmpty' }, '—') : h('div', { className: 'ysTags' },
					tags.map(function (row) {
						return h('button', {
							key: row.tag,
							className: 'ysTag',
							style: { cursor: 'pointer', border: 'none' },
							onClick: function () { props.onTag(row.tag); }
						}, row.tag + ' ' + row.count);
					})),
				h('div', { className: 'ysSection' }, t('overview.recent')),
				h('div', { className: 'ysList' },
					(overview.recent || []).length === 0
						? h('div', { className: 'ysEmpty' }, t('files.empty'))
						: (overview.recent || []).map(function (file) {
							return h('div', { className: 'ysItem', key: file.id, onClick: function () { props.onOpen(file.id); } },
								h('div', { className: 'ysItemMain' },
									h('div', { className: 'ysItemTitle' }, file.name),
									h('div', { className: 'ysItemDesc' }, file.description),
									h('div', { className: 'ysItemMeta' }, typeLabel(file.mime) + ' · ' + formatBytes(file.bytes) + ' · ' + relativeTime(file.updated))),
								h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 180 } },
									(file.tags || []).slice(0, 2).map(function (tag) {
										return h('span', { className: 'ysTag', key: tag }, tag);
									})));
						})),
				h('div', { className: 'ysSection' }, t('overview.injection')),
				h('div', { className: 'ysHint', style: { marginBottom: 6 } }, '每日快照：当天写入不会立即改变注入，跨日后刷新。'),
				h('pre', { className: 'ysPre' }, overview.injection || ''));
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
			return h('div', null,
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
					h('select', {
						className: 'ysSelect',
						value: props.mime,
						onChange: function (event) { props.setMime(event.target.value); }
					},
						h('option', { value: '' }, t('files.mime')),
						h('option', { value: 'text/' }, '文本'),
						h('option', { value: 'image/' }, '图片'),
						h('option', { value: 'application/pdf' }, 'PDF'),
						h('option', { value: 'application/vnd' }, 'Office')
					),
					h('label', { className: 'ysCheck' },
						h('input', { type: 'checkbox', checked: props.archived, onChange: function (event) { props.setArchived(event.target.checked); } }),
						t('files.archived')),
					h('button', { className: 'ysButton', onClick: function () { uploadRef.current?.click(); } }, t('action.upload')),
					h('input', { ref: uploadRef, type: 'file', style: { display: 'none' }, onChange: props.onPickFile }),
					h('button', { className: 'ysButton ysButtonPrimary', onClick: props.onNew }, t('action.create')),
					files !== null && files !== undefined
						? h('span', { className: 'ysHint' }, t('files.total').replace('{n}', String(files.total)))
						: null),
				h('div', { className: 'ysSplit' },
					h('div', { className: 'ysList' },
						files === null || files === undefined
							? h('div', { className: 'ysEmpty' }, t('state.loading'))
							: (files.files || []).length === 0
								? h('div', { className: 'ysEmpty' },
									props.query || props.tag || props.mime || props.archived
										? h('div', null,
											h('div', null, t('files.noMatch')),
											h('button', { className: 'ysButton', style: { marginTop: 8 }, onClick: props.onClear }, t('files.clear')))
										: t('files.empty'))
								: (files.files || []).map(function (file) {
									return h(FileRow, { key: file.id, t: t, file: file, active: props.selectedId === file.id, onOpen: props.onOpen });
								}),
							files !== null && files !== undefined && files.files.length < files.total
								? h('div', { style: { padding: 10, textAlign: 'center' } },
									h('button', { className: 'ysButton', onClick: props.onMore },
										t('files.more') + '（' + (files.total - files.files.length) + '）'))
								: null),
					h(DetailPane, props)));
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

		function GraphTab(props) {
			var t = props.t;
			var graph = props.graph;
			var layout = useMemo(function () { return layoutGraph(graph); }, [graph]);
			if (graph === null || graph === undefined) return h('div', { className: 'ysEmpty' }, t('state.loading'));
			var nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
			var edges = Array.isArray(graph.edges) ? graph.edges : [];
			if (nodes.length === 0) return h('div', { className: 'ysEmpty' }, t('graph.empty'));
			var top = nodes.slice().sort(function (a, b) {
				var da = a.degree ? a.degree.in + a.degree.out : 0;
				var db = b.degree ? b.degree.in + b.degree.out : 0;
				return db - da;
			}).slice(0, 20);
			var topIds = new Set(top.map(function (node) { return node.id; }));
			return h('div', null,
				h('div', { className: 'ysGraphHint' }, t('graph.hint')),
				h('div', { className: 'ysGraphWrap' },
					h('svg', { className: 'ysGraph', viewBox: '0 0 ' + layout.width + ' ' + layout.height },
						edges.map(function (edge, index) {
							var a = layout.at.get(edge.from); var b = layout.at.get(edge.to);
							if (a === undefined || b === undefined) return null;
							return h('line', { key: 'e' + index, className: 'ysGraphEdge', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
						}),
						nodes.map(function (node) {
							var point = layout.at.get(node.id);
							if (point === undefined) return null;
							var degree = node.degree ? node.degree.in + node.degree.out : 0;
							return h('g', {
								key: node.id,
								className: 'ysGraphNode',
								role: 'button',
								tabIndex: 0,
								onClick: function () { props.onOpen(node.id); },
								onKeyDown: function (event) {
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										props.onOpen(node.id);
									}
								}
							},
								h('circle', {
									cx: point.x,
									cy: point.y,
									r: 6 + Math.min(10, degree),
									fill: typeColor(node.mime),
									stroke: 'var(--dsw-alias-border-l2)',
									strokeWidth: 1
								}, h('title', null, node.name + ' · ' + node.description)),
								topIds.has(node.id)
									? h('text', { x: point.x + 9, y: point.y + 3, className: 'ysGraphLabel' }, node.name)
									: null);
						}))),
				h('div', { className: 'ysLegend' },
					[['text/markdown', 'md'], ['image/png', 'img'], ['application/pdf', 'pdf'], ['application/x-sh', 'script']].map(function (entry) {
						return h('span', { key: entry[0] }, h('span', { className: 'ysDot', style: { background: typeColor(entry[0]) } }), entry[1]);
					})),
				h('div', { className: 'ysHint', style: { marginTop: 8 } },
					'节点 ' + nodes.length + ' · 边 ' + edges.length + (graph.totals && graph.totals.hidden > 0 ? ' · 还有 ' + graph.totals.hidden + ' 个文件未展开' : ''),
					edges.length === 0 ? ' · 还没有链接；在文件的出链里填目标 id 即可。' : ''));
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

			return h('div', { style: { marginTop: 24 } },
				h('div', { className: 'ysSection' }, t('settings.data')),
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
						placeholder: '/absolute/path/to/yuanshi',
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
			return h('div', { style: { maxWidth: 620 } },
				h('div', { className: 'ysField' },
					h('label', { className: 'ysLabel' }, t('settings.dataDir')),
					h('code', { style: { fontSize: 11, wordBreak: 'break-all' } }, settings.dataDir)),
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
					}, t('action.save'))),
				h(DataSection, props));
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
			var [mime, setMime] = useState('');
			var [archived, setArchived] = useState(false);
			var [selectedId, setSelectedId] = useState('');
			var [detail, setDetail] = useState(null);
			var [draft, setDraft] = useState(null);
			var [preview, setPreview] = useState(null);
			var [graph, setGraph] = useState(null);
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
					mime: mime,
					archived: archived,
					limit: 100
				}).then(function (value) {
					if (token === seq.current.files) { setFiles(value); setLoadError(null); }
				}).catch(function (error) { setLoadError(messageOf(error)); notify(messageOf(error), true); });
			}, [call, query, tagFilter, mime, archived, notify]);

			var loadMore = useCallback(function () {
				if (files === null || files === undefined || files.files.length >= files.total) return Promise.resolve();
				var token = ++seq.current.files;
				return call('file-list', {
					query: query,
					tags: tagFilter === '' ? [] : [tagFilter],
					mime: mime,
					archived: archived,
					limit: 100,
					offset: files.files.length
				}).then(function (value) {
					if (token !== seq.current.files) return;
					setFiles({ total: value.total, files: files.files.concat(value.files) });
				}).catch(function (error) { notify(messageOf(error), true); });
			}, [call, files, query, tagFilter, mime, archived, notify]);

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
			}, [tab, query, tagFilter, mime, archived, loadFiles]);

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
				['files', t('tab.files')],
				['graph', t('tab.graph')],
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
						? h(OverviewTab, { t: t, overview: overview, onOpen: openFile, onTag: function (tag) { setTagFilter(tag); setTab('files'); } })
						: tab === 'files'
							? h(FilesTab, {
								t: t,
								files: files,
								selectedId: selectedId,
								query: query,
								setQuery: setQuery,
								tag: tagFilter,
								setTag: setTagFilter,
								mime: mime,
								setMime: setMime,
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
								onMore: loadMore,
								onClear: function () { setQuery(''); setTagFilter(''); setMime(''); setArchived(false); },
								onCopy: function (path) {
									if (typeof navigator !== 'undefined' && navigator.clipboard) {
										navigator.clipboard.writeText(String(path || '')).then(function () { notify(t('action.copied')); }).catch(function () { notify('复制失败', true); });
									}
								}
							})
							: tab === 'graph'
								? h(GraphTab, { t: t, graph: graph, onOpen: openFile })
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
									: h(LogsTab, { t: t, logs: logs, onRefresh: function () { call('logs', { limit: 200 }).then(setLogs).catch(function (error) { notify(messageOf(error), true); }); } })),
				dialog ? h(Dialog, { t: t, dialog: dialog, setDialog: setDialog, busy: busy, onSubmit: submitDialog, onClose: function () { setDialog(null); } }) : null,
				toast ? h('div', { className: 'ysToast' + (toast.error ? ' ysToastError' : ''), role: 'status', 'aria-live': 'polite' }, toast.message) : null);
		}

		//#endregion

		//#region plugin

		var inject = ['slots', 'locale', 'connection'];

		function apply(ctx) {
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, 'dsh-yuanshi: dictionaries');

			var t = ctx.locale.bind(NS);

			ctx.effect(function () {
				var style = document.createElement('style');
				style.dataset.plugin = 'dsh-yuanshi';
				style.textContent = css;
				document.head.appendChild(style);
				return function () { style.remove(); };
			}, 'dsh-yuanshi: styles');

			ctx.effect(function () {
				return ctx.slots.inject('main', function () {
					return ctx.slots.register({
						name: 'main',
						key: PANEL_ID,
						locale: NS,
						inject: function () { return { ctx: ctx, t: t }; }
					}, Panel);
				});
			}, 'dsh-yuanshi: main panel');

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
			}, 'dsh-yuanshi: sidebar entry');
		}

		//#endregion

		return { inject: inject, apply: apply };
	}
});
