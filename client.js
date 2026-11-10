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
			'action.refresh': '刷新',
			'action.save': '保存',
			'action.delete': '删除',
			'action.close': '关闭',
			'action.new': '新建',
			'action.link': '设为全局加载',
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
			'soul.hint': '灵魂是 Agent 的人格与边界，每个会话都会被读到；一次性的经历属于见闻。',
			'soul.content': '灵魂（Markdown）',
			'prefs.hint': '这里是全局偏好。保存后由 DSH 的 AGENTS.md 加载器注入给每个会话。',
			'prefs.content': '全局偏好（Markdown）',
			'prefs.global': '全局加载',
			'prefs.link.linked': '已链接',
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
			'kind.agent': 'Agents',
		};

		var en = {
			'panel': 'Evolver',
			'tab.overview': 'Overview',
			'tab.practice': 'Practice',
			'tab.sight': 'Sight',
			'tab.preferences': 'Preferences',
			'tab.suggestions': 'Suggestions',
			'action.refresh': 'Refresh',
			'action.save': 'Save',
			'action.delete': 'Delete',
			'action.close': 'Close',
			'action.new': 'New',
			'action.link': 'Load globally',
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
			'soul.hint': 'The soul is the agent’s persona and boundaries; it is read in every session.',
			'soul.content': 'Soul (Markdown)',
			'prefs.hint': 'Global preferences. DSH injects this file through its AGENTS.md loader.',
			'prefs.content': 'Global preferences (Markdown)',
			'prefs.global': 'Global load',
			'prefs.link.linked': 'linked',
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
			'kind.agent': 'Agents',
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
		];

		/** The practice kinds, in index order. */
		var KINDS = [
			{ id: 'doc', title: 'kind.doc' },
			{ id: 'tool', title: 'kind.tool' },
			{ id: 'resource', title: 'kind.resource' },
			{ id: 'agent', title: 'kind.agent' },
		];

		//#endregion

		//#region styles

		var css = [
			'.evrRoot{height:100%;display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}',
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
			return fetch(API_PREFIX + '/' + endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload ?? {}),
				credentials: 'same-origin',
			}).then(function (response) {
				return response.json().then(function (value) {
					var error = value !== null && typeof value === 'object' ? value.error : undefined;
					if (!response.ok || error !== undefined) {
						throw new Error((error && (error.message || error.code)) || ('HTTP ' + response.status));
					}
					return value;
				});
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
						hint: injection.preferences.link.kind === 'link'
							? t('prefs.link.linked')
							: t('prefs.link.missing'),
					}),
					h(StatCard, {
						title: t('overview.root'),
						value: String(practice.entries ?? 0),
						hint: overview.root ?? '',
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
			var linkLabel = t('prefs.link.' + link.kind);
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
					link.kind === 'link'
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
						}, t('action.link')),
					props.status === undefined || props.status === null
						? null
						: h('span', { className: 'evrStatus' + (props.status.error ? ' evrStatusError' : ' evrStatusOk') }, props.status.message)),
				h('div', { className: 'evrSection' }, t('prefs.global')),
				h('div', { className: 'evrCard' },
					h('div', { className: 'evrCardHead' },
						h('span', { className: 'evrCardTitle' }, linkLabel),
						h('span', { className: 'evrCardCount' }, formatBytes(preferences?.bytes ?? 0))),
					h('div', { className: 'evrCardHint evrMono' }, preferences?.globalPath ?? ''),
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
			var [memories, setMemories] = useState([]);
			var [kind, setKind] = useState('doc');
			var [editor, setEditor] = useState(null);
			var [status, setStatus] = useState(null);
			var [busy, setBusy] = useState(false);
			var [error, setError] = useState(null);
			var [query, setQuery] = useState('');

			var report = useCallback(function (message, isError) {
				setStatus({ message: message, error: isError === true });
			}, []);

			var loadAll = useCallback(function () {
				return Promise.all([
					call('overview'),
					call('injection'),
					call('practice'),
					call('soul'),
					call('preferences'),
					call('memory-list', { limit: 20 }),
				]).then(function (results) {
					setOverview(results[0]);
					setInjection(results[1]);
					setPractice(results[2]);
					setSoul(results[3]);
					setPreferences(results[4]);
					setMemories(results[5]?.results ?? []);
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
				h('div', { className: 'evrBody' }, h('div', { className: 'evrEnter', key: tab }, body)));
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
