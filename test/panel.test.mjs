/*
 * The panel's static and rendered contract.
 *
 * `client.js` is one browser factory with no import surface, so this file has
 * two halves:
 *
 *   - static checks load the source and the registered dictionaries (through
 *     `loadClient()`): new locale keys must exist in both languages, and every
 *     endpoint the UI uses must be a literal `call('…')` — contract.test.mjs
 *     keeps that set aligned with ENDPOINTS and the host switch;
 *   - rendered checks run the panel against a tiny hooks runtime (see
 *     `loadPanel`). The runtime renders the tree, runs effects, resolves the
 *     fake `fetch`, and lets a test click a button the way a person would.
 *
 * The organize page is the old evolver's shape on purpose: three compact cards
 * (model / sessions / files) plus a compact recent-jobs list. There is no
 * manual maintenance button — the injected snapshot is rebuilt by the host
 * daily and organizing runs as a host-side agent job — so the tests assert the
 * buttons that must be gone as much as the ones that must be there.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ENDPOINTS } from '../src/remote.js'
import { loadClient } from './helpers.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Locale keys the organize page's three cards and job list use. */
const ORGANIZE_KEYS = [
	'organize.hint',
	'organize.enabled',
	'organize.disabled',
	'organize.model',
	'organize.model.hint',
	'organize.model.follow',
	'organize.model.provider',
	'organize.model.model',
	'organize.model.effort',
	'organize.model.defaultEffort',
	'organize.model.save',
	'organize.model.saved',
	'organize.model.catalogFailed',
	'organize.model.unavailable',
	'organize.sessions.title',
	'organize.sessions.hint',
	'organize.sessions.enable',
	'organize.sessions.idle',
	'organize.sessions.idleUnit',
	'organize.sessions.total',
	'organize.sessions.pending',
	'organize.sessions.run',
	'organize.files.title',
	'organize.files.hint',
	'organize.files.enable',
	'organize.files.hour',
	'organize.files.hourUnit',
	'organize.files.run',
	'organize.never',
	'organize.lastRun',
	'organize.lastResult',
	'organize.lastError',
	'organize.busy',
	'organize.saved',
	'organize.jobs',
	'organize.job.none',
	'organize.job.started',
	'organize.job.cancel',
	'organize.job.cancelRequested',
	'organize.job.noChanges',
	'organize.job.counts',
	'organize.job.log',
	'organize.job.error',
	'organize.job.queued',
	'organize.job.running',
	'organize.job.done',
	'organize.job.failed',
	'organize.job.cancelled',
	'organize.job.kind.sessions',
	'organize.job.kind.files',
	'organize.job.kind.all',
]

/** Locale keys the injection page's three sub-tabs still need. */
const INJECTION_KEYS = [
	'injection.tab.prompts',
	'injection.tab.tools',
	'injection.tab.preferences',
	'injection.static',
	'injection.static.hint',
	'injection.runtime.removed',
]

/** Locale keys the tool catalog sub-tab needs. */
const INJECTION_TOOL_KEYS = [
	'injection.tools.hint',
	'injection.tools.read',
	'injection.tools.write',
	'injection.tools.destructive',
	'injection.tools.empty',
	'injection.tools.failed',
	'injection.tools.params',
	'injection.tools.noParams',
	'injection.tools.required',
	'injection.tools.retry',
]

/** Endpoints the new organize page must register. */
const ORGANIZE_ENDPOINTS = ['digest', 'organize-status', 'organize-save', 'organize-start', 'organize-jobs', 'organize-cancel']

/**
 * Load client.js and capture the dictionaries it registers.
 *
 * @returns {Promise<{zh: object, en: object}>} The registered dictionaries.
 */
async function loadDictionaries() {
	const { module } = await loadClient()
	const registered = []
	const ctx = {
		effect(effect) {
			effect()
			return function () {}
		},
		locale: {
			register(namespace, dictionaries) {
				registered.push([namespace, dictionaries])
				return function () {}
			},
			bind() {
				return function (key) { return key }
			},
		},
		slots: {
			inject(name, callback) {
				callback()
				return function () {}
			},
			register() {
				return function () {}
			},
		},
	}
	module.apply(ctx)
	const entry = registered.find((item) => item[0] === 'dsh-ziyan')
	assert.ok(entry, '插件注册了 dsh-ziyan 词典')
	return entry[1]
}

/**
 * Assert every key exists and is non-empty in both dictionaries.
 *
 * @param {{zh: object, en: object}} dictionaries - The dictionaries.
 * @param {string[]} keys - The keys.
 * @param {string} label - Shown on failure.
 * @returns {void}
 */
function assertLocaleKeys(dictionaries, keys, label) {
	for (const key of keys) {
		for (const language of ['zh', 'en']) {
			const value = dictionaries[language][key]
			assert.equal(typeof value, 'string', `${label}：${language} 缺 ${key}`)
			assert.notEqual(value.trim(), '', `${label}：${language} 的 ${key} 是空串`)
		}
	}
}

/**
 * Assert one pattern occurs in the client source.
 *
 * Kept separate from `assert.match` so a failure does not dump thousands of
 * lines of source into the TAP output.
 *
 * @param {string} source - The client source.
 * @param {RegExp} pattern - What must occur.
 * @param {string} message - Shown on failure.
 * @returns {void}
 */
function assertSource(source, pattern, message) {
	assert.ok(pattern.test(source), message)
}

//#region static contract

test('词典：自衍页三卡与注入页的中英键一一对应', async () => {
	const dictionaries = await loadDictionaries()
	assertLocaleKeys(dictionaries, ORGANIZE_KEYS, '整理台')
	assertLocaleKeys(dictionaries, INJECTION_KEYS, '注入页')
	assertLocaleKeys(dictionaries, INJECTION_TOOL_KEYS, '工具子标签')
	assert.deepEqual(
		Object.keys(dictionaries.zh).sort(),
		Object.keys(dictionaries.en).sort(),
		'zh 与 en 的键集合必须一致'
	)
})

test('词典：旧注入快照键已删除，运行时提示中英同步', async () => {
	const dictionaries = await loadDictionaries()
	for (const key of ['injection.total', 'injection.index', 'injection.meta', 'injection.never', 'injection.stale', 'injection.fresh', 'settings.injectionBudget']) {
		assert.equal(dictionaries.zh[key], undefined, `zh 仍残留 ${key}`)
		assert.equal(dictionaries.en[key], undefined, `en 仍残留 ${key}`)
	}
	assertLocaleKeys(dictionaries, ['injection.runtime.removed'], '运行时提示')
})

test('源码契约：整理台只调 organize-* 与 digest，手动维护入口已删除', async () => {
	const source = await readFile(join(ROOT, 'client.js'), 'utf8')
	for (const endpoint of ORGANIZE_ENDPOINTS) {
		assert.ok(ENDPOINTS.includes(endpoint), `src/remote.js 的 ENDPOINTS 缺 ${endpoint}`)
		assertSource(source, new RegExp(`\\bcall\\(\\s*'${endpoint}'`), `client.js 没有注册 call('${endpoint}')`)
	}
	// `injection` is still read on tab entry (the panel's only snapshot source).
	assertSource(source, /\bcall\('injection'\)/, '注入页仍读取 injection')
	assert.equal(ENDPOINTS.includes('rebuild'), false, 'rebuild 端点已删除')

	// Every manual maintenance action is gone, including the payload flags that
	// only existed to drive them.
	assert.doesNotMatch(source, /call\(\s*'rebuild'/, '不再调用 rebuild')
	assert.doesNotMatch(source, /refresh\s*:\s*true/, '不再请求重建快照')
	assert.doesNotMatch(source, /dryRun/, '不再有演练模式')
	assert.doesNotMatch(source, /sessionIds/, '不再有会话勾选列表')
	assert.doesNotMatch(source, /重建索引|重建快照|重新读取/, '不再有手动维护按钮文案')

	// 运行时上下文注入已移除：面板不再有预算条、索引/快照文案与注入预算设置。
	assert.doesNotMatch(source, /injectionBudget/, '设置页不再有注入预算')
	assert.doesNotMatch(source, /injection\.(total|index|meta|never|stale|fresh)\b/, '不再引用旧索引/快照键')
	assert.doesNotMatch(source, /ysMeter/, '不再渲染预算条')
})

test('源码契约：整理台的启动参数、轮询与自动开关', async () => {
	const source = await readFile(join(ROOT, 'client.js'), 'utf8')
	assertSource(source, /var ORGANIZE_POLL_MS = 2000;/, '轮询间隔常量')
	assertSource(source, /\{ kind: kind \}/, '会话/文件整理共用 kind 参数')
	assertSource(source, /auto: \{ sessions: \{ enabled: autoSessions, idleMinutes: idleValue \} \}/, '保存会话自动开关')
	assertSource(source, /auto: \{ files: \{ enabled: autoFiles, hour: hourValue \} \}/, '保存文件自动开关')
	assertSource(source, /call\('organize-jobs', \{ limit: 5 \}\)/, '最近作业只取 5 条')
	assertSource(source, /call\('organize-cancel', \{ id: job\.id \}\)/, '取消按钮带作业 id')
	assertSource(source, /call\('organize-status'\)\.then\(props\.onStatus\)/, '作业结束时刷新状态')
	assertSource(source, /clearTimeout/, '轮询要能停')
})

//#endregion

//#region rendered panel

/**
 * Run `client.js` with a minimal hooks runtime.
 *
 * Not React: `createElement` returns plain nodes, hooks keep per-component
 * cells, effects run after a render, and `settle()` drives the loop until the
 * tree stops changing. That is enough to click a tab and assert on the text.
 *
 * @returns {Promise<object>} The mounted panel.
 */
async function loadPanel() {
	const source = await readFile(join(ROOT, 'client.js'), 'utf8')
	let registration
	const window = {
		__ModuleLoader__: {
			load(config) {
				registration = config
			},
		},
	}
	const document = {
		createElement() {
			return { dataset: {}, textContent: '', remove() {} }
		},
		head: { appendChild() {} },
	}

	/** Per-component hook state: cells, effects, refs and memo slots. */
	const instances = new Map()
	let current = null
	let hookIndex = 0
	let dirty = false
	let tree = null
	let effectQueue = []
	let component = null
	let zh = null

	/**
	 * The hook state of one component function.
	 *
	 * @param {Function} type - The component.
	 * @returns {object} Its state.
	 */
	function instanceOf(type) {
		let instance = instances.get(type)
		if (instance === undefined) {
			instance = { cells: [], effects: [], refs: [], memos: [] }
			instances.set(type, instance)
		}
		return instance
	}

	function setCell(cell, value) {
		cell.value = typeof value === 'function' ? value(cell.value) : value
		dirty = true
	}

	function sameDeps(left, right) {
		if (left === undefined || right === undefined) return false
		if (left.length !== right.length) return false
		return left.every((value, index) => Object.is(value, right[index]))
	}

	const react = {
		createElement(type, props) {
			const children = Array.prototype.slice.call(arguments, 2)
			return { type: type, props: props || {}, children: children }
		},
		Component: function Component() {},
		useState(initial) {
			const instance = current
			const index = hookIndex
			hookIndex += 1
			const cell = instance.cells[index] || (instance.cells[index] = { value: initial })
			return [cell.value, function (value) { setCell(instance.cells[index], value) }]
		},
		useEffect(fn, deps) {
			const instance = current
			const index = hookIndex
			hookIndex += 1
			const slot = instance.effects[index] || (instance.effects[index] = { deps: undefined, cleanup: null, started: false })
			if (slot.started !== true || !sameDeps(slot.deps, deps)) {
				effectQueue.push({ slot: slot, fn: fn, deps: deps })
			}
		},
		useCallback(fn, deps) {
			const instance = current
			const index = hookIndex
			hookIndex += 1
			const slot = instance.memos[index] || (instance.memos[index] = { deps: undefined, value: undefined })
			if (slot.value === undefined || !sameDeps(slot.deps, deps)) {
				slot.value = fn
				slot.deps = deps
			}
			return slot.value
		},
		useMemo(fn, deps) {
			const instance = current
			const index = hookIndex
			hookIndex += 1
			const slot = instance.memos[index] || (instance.memos[index] = { deps: undefined, value: undefined })
			if (slot.value === undefined || !sameDeps(slot.deps, deps)) {
				slot.value = fn()
				slot.deps = deps
			}
			return slot.value
		},
		useRef(initial) {
			const instance = current
			const index = hookIndex
			hookIndex += 1
			if (instance.refs[index] === undefined) instance.refs[index] = { current: initial }
			return instance.refs[index]
		},
	}

	function renderNode(node) {
		if (node === null || node === undefined || node === false || node === true) return []
		if (Array.isArray(node)) return node.flatMap(renderNode)
		if (typeof node === 'string' || typeof node === 'number') return [String(node)]
		if (typeof node.type === 'function') {
			const instance = instanceOf(node.type)
			const previous = current
			const previousIndex = hookIndex
			current = instance
			hookIndex = 0
			const output = node.type(node.props)
			current = previous
			hookIndex = previousIndex
			return renderNode(output)
		}
		return [{ type: node.type, props: node.props, children: node.children.flatMap(renderNode) }]
	}

	function renderRoot() {
		dirty = false
		tree = renderNode({ type: component, props: rootProps, children: [] })
	}

	async function settle() {
		for (let round = 0; round < 100; round += 1) {
			if (dirty || tree === null) renderRoot()
			if (effectQueue.length > 0) {
				const queue = effectQueue
				effectQueue = []
				for (const item of queue) {
					if (item.slot.started && typeof item.slot.cleanup === 'function') item.slot.cleanup()
					item.slot.started = true
					item.slot.deps = item.deps
					const cleanup = item.fn()
					item.slot.cleanup = typeof cleanup === 'function' ? cleanup : null
				}
				continue
			}
			await new Promise((resolve) => setTimeout(resolve, 0))
			if (!dirty && effectQueue.length === 0) return
		}
		throw new Error('panel did not settle')
	}

	const calls = []
	const routes = {}
	const previousFetch = globalThis.fetch
	globalThis.fetch = async function (url, options) {
		const endpoint = String(url).slice(String(url).lastIndexOf('/') + 1)
		const payload = options !== undefined && typeof options.body === 'string' ? JSON.parse(options.body) : {}
		calls.push({ endpoint: endpoint, payload: payload })
		const route = routes[endpoint]
		const body = typeof route === 'function' ? route(payload) : route
		return { ok: true, status: 200, json: async function () { return body } }
	}

	const ctx = {
		get(name) {
			return name === 'connection' ? {} : undefined
		},
		effect(effect) {
			effect()
			return function () {}
		},
		locale: {
			register(namespace, dictionaries) {
				zh = dictionaries.zh
				return function () {}
			},
			bind() {
				return function (key) { return (zh && zh[key]) || key }
			},
		},
		slots: {
			inject(name, callback) {
				callback()
				return function () {}
			},
			register(spec, value) {
				if (spec.name === 'main') component = value
				return function () {}
			},
		},
	}

	new Function('window', 'document', source)(window, document)
	assert.ok(registration !== undefined, 'client.js 调用了 __ModuleLoader__.load')
	const module = registration.factory(function () { return react })
	module.apply(ctx)
	assert.ok(component !== null, '主面板注册到了 main 槽')
	const rootProps = { ctx: ctx, t: function (key) { return (zh && zh[key]) || key } }

	function dispose() {
		for (const instance of instances.values()) {
			for (const slot of instance.effects) {
				if (slot !== undefined && typeof slot.cleanup === 'function') {
					slot.cleanup()
					slot.cleanup = null
				}
			}
		}
		if (previousFetch === undefined) delete globalThis.fetch
		else globalThis.fetch = previousFetch
	}

	return {
		calls: calls,
		/**
		 * Set fixture responses, one value or one function per endpoint.
		 *
		 * @param {object} fixtures - endpoint → value | (payload) => value.
		 * @returns {void}
		 */
		route(fixtures) {
			Object.assign(routes, fixtures)
		},
		settle: settle,
		tree() {
			return tree
		},
		dispose: dispose,
	}
}

/**
 * Every string in a rendered tree.
 *
 * @param {unknown} nodes - The nodes.
 * @returns {string} The concatenated text.
 */
function textOf(nodes) {
	if (nodes === null || nodes === undefined || nodes === false || nodes === true) return ''
	if (typeof nodes === 'string') return nodes
	if (Array.isArray(nodes)) return nodes.map(textOf).join(' ')
	return textOf(nodes.children)
}

/**
 * Walk the rendered tree, handing every element node and its ancestors over.
 *
 * @param {unknown} nodes - The nodes.
 * @param {(node: object, ancestors: object[]) => void} visit - The visitor.
 * @param {object[]} [ancestors] - Elements above this node.
 * @returns {void}
 */
function walk(nodes, visit, ancestors = []) {
	if (nodes === null || nodes === undefined || typeof nodes === 'string') return
	if (Array.isArray(nodes)) {
		for (const node of nodes) walk(node, visit, ancestors)
		return
	}
	visit(nodes, ancestors)
	const next = ancestors.concat([nodes])
	for (const child of nodes.children) walk(child, visit, next)
}

/**
 * The button whose own text is exactly (or, failing that, contains) a label.
 *
 * @param {unknown} tree - The rendered tree.
 * @param {string} label - The label.
 * @returns {object | undefined} The node.
 */
function findButton(tree, label) {
	const buttons = []
	walk(tree, (node) => {
		if (node.type === 'button') buttons.push(node)
	})
	return buttons.find((node) => textOf(node).trim() === label)
		?? buttons.find((node) => textOf(node).includes(label))
}

/**
 * The first input/select of a type whose nearest wrapping element mentions a text.
 *
 * @param {unknown} tree - The rendered tree.
 * @param {string} type - `input` or `select`.
 * @param {string} text - Text in the nearest ancestor.
 * @returns {object | undefined} The node.
 */
function findControl(tree, type, text) {
	let found
	walk(tree, (node, ancestors) => {
		if (found !== undefined || node.type !== type) return
		const row = ancestors[ancestors.length - 1]
		if (row !== undefined && textOf(row).includes(text)) found = node
	})
	return found
}

/**
 * All inputs of one type under a node, in render order.
 *
 * @param {unknown} tree - The rendered tree.
 * @param {string} type - `input` or `select`.
 * @returns {object[]} The controls.
 */
function controlsIn(tree, type) {
	const found = []
	walk(tree, (node) => {
		if (node.type === type) found.push(node)
	})
	return found
}

/**
 * The card whose heading contains a title.
 *
 * @param {unknown} tree - The rendered tree.
 * @param {string} title - The card title.
 * @returns {object | undefined} The card node.
 */
function findCard(tree, title) {
	let container
	walk(tree, (node) => {
		if (container === undefined && node.props && node.props.className === 'ysOrganizeCards') container = node
	})
	if (container === undefined) return undefined
	return container.children.find((child) => textOf(child).includes(title))
}

/**
 * A button inside one card, so the two "立即整理"/"保存" buttons stay apart.
 *
 * @param {unknown} tree - The rendered tree.
 * @param {string} cardTitle - The card title.
 * @param {string} label - The button label.
 * @returns {object | undefined} The node.
 */
function cardButton(tree, cardTitle, label) {
	const card = findCard(tree, cardTitle)
	assert.ok(card !== undefined, `找不到卡片：${cardTitle}`)
	return findButton(card, label)
}

/**
 * Click a button inside one card and let the panel settle.
 *
 * @param {object} panel - The mounted panel.
 * @param {string} cardTitle - The card title.
 * @param {string} label - The button label.
 * @returns {Promise<void>} Resolves when the tree is stable.
 */
async function clickInCard(panel, cardTitle, label) {
	const node = cardButton(panel.tree(), cardTitle, label)
	assert.ok(node !== undefined, `找不到按钮：${cardTitle} / ${label}`)
	assert.notEqual(node.props.disabled, true, `按钮被禁用了：${cardTitle} / ${label}`)
	node.props.onClick({ preventDefault() {} })
	await panel.settle()
}

/**
 * Click a top-level button by label and let the panel settle.
 *
 * @param {object} panel - The mounted panel.
 * @param {string} label - The label.
 * @returns {Promise<void>} Resolves when the tree is stable.
 */
async function click(panel, label) {
	const node = findButton(panel.tree(), label)
	assert.ok(node !== undefined, `找不到按钮：${label}`)
	assert.notEqual(node.props.disabled, true, `按钮被禁用了：${label}`)
	node.props.onClick({ preventDefault() {} })
	await panel.settle()
}

/**
 * The last payload sent to one endpoint.
 *
 * @param {object} panel - The mounted panel.
 * @param {string} endpoint - The endpoint.
 * @returns {object | undefined} The payload.
 */
function lastPayload(panel, endpoint) {
	return panel.calls.filter((item) => item.endpoint === endpoint).pop()?.payload
}

/**
 * A finished job result shape with every counter.
 *
 * @param {object} [counts] - Counters to override.
 * @returns {object} The result object.
 */
function jobResult(counts = {}) {
	return {
		created: 0,
		updated: 0,
		merged: 0,
		archived: 0,
		removed: 0,
		retagged: 0,
		linked: 0,
		...counts,
	}
}

/**
 * One running organize job as the host reports it.
 *
 * @returns {object} The job.
 */
function runningJob() {
	return {
		id: 'organize-test-1',
		kind: 'files',
		status: 'running',
		dryRun: false,
		allowRemove: false,
		phase: '整理文件',
		progress: { processed: 0, total: 1, steps: 2, toolCalls: 1 },
		selection: { provider: 'p1', model: 'm1' },
		startedAt: new Date().toISOString(),
		finishedAt: '',
		message: '',
		error: null,
		result: jobResult({ created: 1, updated: 2, retagged: 1, linked: 3 }),
		changes: [{ op: 'update', id: 'file-01' }],
		log: ['[09:00:01] 阶段：整理文件'],
	}
}

/**
 * One finished organize job, for the last-run summaries.
 *
 * @param {object} options - `{kind, status, result, error}`.
 * @returns {object} The job summary the status endpoint returns.
 */
function lastRun({ kind = 'sessions', status = 'done', result = jobResult(), error = null } = {}) {
	return {
		id: 'organize-last-' + kind,
		kind: kind,
		status: status,
		startedAt: new Date(Date.now() - 120000).toISOString(),
		finishedAt: new Date(Date.now() - 60000).toISOString(),
		message: status === 'done' ? '整理完成。' : '失败',
		error: error,
		result: result,
	}
}

/**
 * The organize status as the host reports it.
 *
 * @returns {object} The status.
 */
function organizeStatus() {
	return {
		model: null,
		current: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
		followsChat: true,
		providers: [{
			id: 'p1',
			name: '服务商一',
			models: [{
				id: 'm1',
				name: '模型一',
				reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' },
			}],
		}],
		catalogFailed: false,
		job: null,
		kinds: ['sessions', 'files', 'all'],
		limits: { maxSessions: 5, maxSessionChars: 24000, maxSteps: { sessions: 8, files: 12, all: 16 } },
		auto: {
			sessions: { enabled: false, idleMinutes: 30 },
			files: { enabled: false, hour: 3 },
		},
		scheduler: {
			pendingSessions: 3,
			lastSessionRun: lastRun({ kind: 'sessions', result: jobResult({ created: 2, updated: 1 }) }),
			lastFilesRun: lastRun({ kind: 'files', status: 'failed', error: '模型炸了' }),
			running: '',
		},
	}
}

/**
 * Every endpoint the panel reads on its screens.
 *
 * @returns {object} Fixtures keyed by endpoint.
 */
function baseRoutes() {
	const now = new Date().toISOString()
	const job = runningJob()
	return {
		overview: { version: '9.9.9', stats: { files: 2, tags: 3, days: 1 }, activity: [], suffixes: [], year: { notes: 2, activeDays: 1 } },
		settings: { dataDir: 'C:\\ziyan' },
		logs: { path: 'plugin.log', lines: [] },
		'data-status': { current: 'C:\\ziyan' },
		injection: { static: '静态纪律', staticBytes: 12 },
		preferences: { path: 'AGENTS.md', content: '', cap: 65536, readable: true, exists: true, hasBlock: false },
		tools: {
			total: 1,
			tools: [{
				name: 'file_query',
				description: '按描述/名字/标签检索文件。',
				category: 'read',
				parameters: { type: 'object', properties: { query: { type: 'string', description: '检索词' } }, required: ['query'] },
			}],
		},
		digest: {
			sessions: [{
				id: 'session-abc',
				workspace: 'workspace',
				cwd: 'E:\\work',
				origin: '',
				title: '一次组件调试',
				createdAt: now,
				updatedAt: now,
				prompts: 4,
				replies: 6,
				bytes: 1024,
			}],
			sessionTotal: 4,
			unreadable: 0,
			organize: {
				staleDays: 90,
				staleBefore: now,
				orphans: { total: 2, sample: [{ id: 'file-1', name: 'a.md', description: '孤立文件' }] },
				dangling: { total: 1, sample: [{ from: 'file-1', fromName: 'a.md', to: 'file-gone' }] },
				stale: { total: 0, sample: [] },
				singleTags: { total: 1, sample: [{ tag: '测试', count: 1 }] },
			},
		},
		'organize-status': organizeStatus(),
		'organize-jobs': { jobs: [job], total: 1, running: job.id },
		'organize-start': (payload) => ({ job: Object.assign({}, job, { id: 'organize-new', status: 'queued', kind: payload.kind }) }),
		'organize-cancel': () => ({ cancelled: true, job: Object.assign({}, job, { status: 'cancelled' }) }),
		'organize-save': () => organizeStatus(),
	}
}

/**
 * Mount the panel with the base fixtures plus overrides.
 *
 * @param {object} [overrides] - Endpoint fixtures that win over the defaults.
 * @returns {Promise<object>} The mounted panel.
 */
async function mountPanel(overrides = {}) {
	const panel = await loadPanel()
	panel.route(Object.assign(baseRoutes(), overrides))
	await panel.settle()
	return panel
}

test('注入页提示词：只剩静态段与一句说明，没有预算/索引/快照', async () => {
	const panel = await mountPanel({
		injection: { static: '静态纪律：先读 AGENTS.md。', staticBytes: 30 },
	})
	try {
		await click(panel, '注入')
		const text = textOf(panel.tree())
		assert.match(text, /静态纪律：先读 AGENTS\.md/, '静态段照旧展示')
		assert.match(text, /30 字节/, '静态段字节数来自 staticBytes')
		assert.match(text, /运行时不再注入/, '说明运行时不再注入索引')
		assert.match(text, /file_query/, '说明 agent 需要文件时自己用 file_query 搜')
		assert.match(text, /harness/, '说明项目依赖与约定由项目 harness 管理')
		// 新提示用「不再注入文件索引」点名被移除的东西；除这一句外，提示词栏
		// 不应再有任何索引/快照/预算相关文案。
		const notice = '运行时不再注入文件索引'
		assert.ok(text.includes(notice), '出现「运行时不再注入」提示')
		assert.doesNotMatch(text.replace(notice, ''), /文件索引/, '除说明外不再出现文件索引文案')
		assert.doesNotMatch(text, /运行时上下文/, '不再有「运行时上下文」分栏')
		assert.doesNotMatch(text, /快照/, '不再有快照信息')
		assert.doesNotMatch(text, /预算/, '不再有预算文案')
		assert.doesNotMatch(text, /\d+ \/ \d+ B/, '不再有预算条读数')
		const meters = []
		walk(panel.tree(), (node) => {
			if (node.props && typeof node.props.className === 'string' && node.props.className.indexOf('ysMeter') !== -1) meters.push(node)
		})
		assert.deepEqual(meters, [], '不再渲染预算条')
		assert.equal(findButton(panel.tree(), '重建快照'), undefined, '不再有重建快照按钮')
		const injection = panel.calls.filter((item) => item.endpoint === 'injection').pop()
		assert.ok(injection !== undefined, '面板读取 injection')
		assert.equal(injection.payload.refresh, undefined, '不再传 refresh:true')
	} finally {
		panel.dispose()
	}
})

test('设置页：不再有注入预算字段，保存只带三项限额', async () => {
	const settings = { dataDir: 'C:\\ziyan', descriptionMaxChars: 160, maxFileBytes: 25 * 1024 * 1024, readTextBytes: 256 * 1024 }
	const panel = await mountPanel({
		settings: settings,
		'settings-save': (payload) => Object.assign({}, settings, payload),
	})
	try {
		await click(panel, '设置')
		const text = textOf(panel.tree())
		assert.doesNotMatch(text, /注入预算/, '设置页不再有注入预算')
		const numberInputs = controlsIn(panel.tree(), 'input').filter((node) => node.props.type === 'number')
		assert.equal(numberInputs.length, 3, '常规页只剩描述/文件/读取三个上限')
		await click(panel, '保存')
		assert.deepEqual(lastPayload(panel, 'settings-save'), {
			descriptionMaxChars: 160,
			maxFileBytes: 25 * 1024 * 1024,
			readTextBytes: 256 * 1024,
		})
	} finally {
		panel.dispose()
	}
})

test('注入页工具子标签仍展示分类与参数折叠', async () => {
	const panel = await mountPanel()
	try {
		await click(panel, '注入')
		await click(panel, '工具')
		let text = textOf(panel.tree())
		assert.match(text, /file_query/)
		assert.match(text, /只读/)
		assert.doesNotMatch(text, /检索词/, '参数默认折叠')
		await click(panel, '1 个参数')
		text = textOf(panel.tree())
		assert.match(text, /检索词/, '展开后显示参数说明')
	} finally {
		panel.dispose()
	}
})

test('自衍页三卡渲染：模型 / 会话整理 / 文件整理，自动开关默认关', async () => {
	const panel = await mountPanel()
	try {
		await click(panel, '自衍')
		const text = textOf(panel.tree())
		const modelCard = findCard(panel.tree(), '整理模型')
		const sessionsCard = findCard(panel.tree(), '会话整理')
		const filesCard = findCard(panel.tree(), '文件整理')
		assert.ok(modelCard !== undefined, '有整理模型卡')
		assert.ok(sessionsCard !== undefined, '有会话整理卡')
		assert.ok(filesCard !== undefined, '有文件整理卡')

		// One compact page-level hint, then three cards, then the recent jobs.
		assert.match(text, /整理由 agent 作业在会话外运行/)
		assert.match(text, /服务商一/, '模型卡列出目录')
		assert.match(text, /当前生效|p1 \/ m1/, '模型卡显示当前生效模型')

		const sessionInputs = controlsIn(sessionsCard, 'input')
		assert.equal(sessionInputs.length, 2, '会话卡只有自动开关与空闲分钟两个输入')
		assert.equal(sessionInputs[0].props.type, 'checkbox')
		assert.equal(sessionInputs[0].props.checked, false, '自动整理默认关')
		assert.equal(sessionInputs[1].props.type, 'number')
		assert.equal(String(sessionInputs[1].props.value), '30', '默认空闲 30 分钟')
		assert.match(textOf(sessionsCard), /共 4 个会话/)
		assert.match(textOf(sessionsCard), /待整理 3 个/)
		assert.match(textOf(sessionsCard), /上次整理：1 分钟前/)
		assert.match(textOf(sessionsCard), /创建 2 · 更新 1/)

		const fileInputs = controlsIn(filesCard, 'input')
		assert.equal(fileInputs.length, 2, '文件卡只有自动开关与小时两个输入')
		assert.equal(fileInputs[0].props.checked, false, '每日自动整理默认关')
		assert.equal(String(fileInputs[1].props.value), '3', '默认 3 点')
		assert.match(textOf(filesCard), /上次失败：模型炸了/)
	} finally {
		panel.dispose()
	}
})

test('自衍页：无会话勾选、无演练、无四类问题网格、无维护按钮', async () => {
	const panel = await mountPanel()
	try {
		await click(panel, '自衍')
		const text = textOf(panel.tree())
		assert.doesNotMatch(text, /一次组件调试/, '不再列出会话勾选')
		assert.doesNotMatch(text, /孤立文件|悬空链接|只用过一次的标签/, '不再展示四类问题网格与样例')
		assert.doesNotMatch(text, /演练/, '不再有演练模式开关')
		for (const label of ['重建索引', '重建快照', '重新读取', '全部整理']) {
			assert.equal(findButton(panel.tree(), label), undefined, `不再有「${label}」按钮`)
		}
		assert.equal(findControl(panel.tree(), 'input', '一次组件调试'), undefined, '没有会话 checkbox')
	} finally {
		panel.dispose()
	}
})

test('自衍页保存：会话自动开关与空闲分钟、文件自动开关与小时', async () => {
	const panel = await mountPanel()
	try {
		await click(panel, '自衍')
		const sessionsCard = findCard(panel.tree(), '会话整理')
		const fileCard = findCard(panel.tree(), '文件整理')
		const sessionInputs = controlsIn(sessionsCard, 'input')
		sessionInputs[0].props.onChange({ target: { checked: true } })
		sessionInputs[1].props.onChange({ target: { value: '45' } })
		await panel.settle()
		await clickInCard(panel, '会话整理', '保存')
		assert.deepEqual(lastPayload(panel, 'organize-save'), {
			auto: { sessions: { enabled: true, idleMinutes: 45 } },
		})

		const fileInputs = controlsIn(findCard(panel.tree(), '文件整理'), 'input')
		fileInputs[0].props.onChange({ target: { checked: true } })
		fileInputs[1].props.onChange({ target: { value: '5' } })
		await panel.settle()
		await clickInCard(panel, '文件整理', '保存')
		assert.deepEqual(lastPayload(panel, 'organize-save'), {
			auto: { files: { enabled: true, hour: 5 } },
		})
		assert.ok(fileCard !== undefined)
	} finally {
		panel.dispose()
	}
})

test('自衍页立即整理：会话/文件各发 kind，模型保存走 organize-save', async () => {
	const panel = await mountPanel({ 'organize-jobs': { jobs: [], total: 0, running: '' } })
	try {
		await click(panel, '自衍')
		await clickInCard(panel, '会话整理', '立即整理')
		assert.deepEqual(lastPayload(panel, 'organize-start'), { kind: 'sessions' })
		await clickInCard(panel, '文件整理', '立即整理')
		assert.deepEqual(lastPayload(panel, 'organize-start'), { kind: 'files' })

		// 跟随聊天 → save(null)；换成目录里的模型 → save({provider, model, …})。
		await clickInCard(panel, '整理模型', '保存模型')
		assert.deepEqual(lastPayload(panel, 'organize-save'), { model: null })

		const modelCard = findCard(panel.tree(), '整理模型')
		const follow = findControl(modelCard, 'input', '跟随聊天')
		assert.ok(follow !== undefined, '跟随聊天勾选框')
		follow.props.onChange({ target: { checked: false } })
		await panel.settle()
		const selects = controlsIn(findCard(panel.tree(), '整理模型'), 'select')
		assert.equal(selects.length, 3, '服务商 / 模型 / 思考强度三个下拉')
		selects[1].props.onChange({ target: { value: 'm1' } })
		selects[2].props.onChange({ target: { value: 'high' } })
		await panel.settle()
		await clickInCard(panel, '整理模型', '保存模型')
		assert.deepEqual(lastPayload(panel, 'organize-save'), {
			model: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
		})
	} finally {
		panel.dispose()
	}
})

test('自衍页最近作业：状态/结果/折叠日志与运行中取消', async () => {
	const panel = await mountPanel()
	try {
		await click(panel, '自衍')
		const text = textOf(panel.tree())
		assert.match(text, /最近作业/)
		assert.match(text, /运行中/, '作业状态')
		assert.match(text, /文件/, '作业 kind')
		assert.match(text, /创建 1 · 更新 2/, '结果计数')
		assert.match(text, /日志/, '日志折叠入口')
		// `details` is the fold: the browser hides its body until opened, and the
		// fake runtime renders it as a plain element, so assert the element
		// rather than the absence of the text.
		let foldedLog
		walk(panel.tree(), (node) => {
			if (node.type === 'details') foldedLog = node
		})
		assert.ok(foldedLog !== undefined, '日志在 details 里默认折叠')
		assert.match(textOf(foldedLog), /阶段：整理文件/, '展开后是完整日志尾')

		await click(panel, '取消')
		assert.deepEqual(lastPayload(panel, 'organize-cancel'), { id: 'organize-test-1' })
	} finally {
		panel.dispose()
	}
})

test('自衍页最近作业为空：显示空态', async () => {
	const panel = await mountPanel({ 'organize-jobs': { jobs: [], total: 0, running: '' } })
	try {
		await click(panel, '自衍')
		assert.match(textOf(panel.tree()), /还没有作业/)
	} finally {
		panel.dispose()
	}
})

test('自衍页降级：模型目录不可用时禁用两个立即整理并说明原因', async () => {
	const status = Object.assign(organizeStatus(), { catalogFailed: true, current: null, providers: [], model: null })
	const panel = await mountPanel({
		'organize-status': status,
		'organize-jobs': { jobs: [], total: 0, running: '' },
	})
	try {
		await click(panel, '自衍')
		const text = textOf(panel.tree())
		assert.match(text, /模型目录读取失败/)
		assert.equal(cardButton(panel.tree(), '会话整理', '立即整理').props.disabled, true)
		assert.equal(cardButton(panel.tree(), '文件整理', '立即整理').props.disabled, true)
	} finally {
		panel.dispose()
	}
})

test('自衍页：作业结束后重新读取 status 与 digest', async () => {
	const running = runningJob()
	const panel = await loadPanel()
	panel.route(Object.assign(baseRoutes(), {
		'organize-jobs': { jobs: [running], total: 1, running: running.id },
	}))
	await panel.settle()
	try {
		await click(panel, '自衍')
		const firstStatusCalls = panel.calls.filter((item) => item.endpoint === 'organize-status').length
		const firstDigestCalls = panel.calls.filter((item) => item.endpoint === 'digest').length

		// The running job settles; the next 2 s poll sees `running: ''` and must
		// refresh both the status endpoint and the digest once.
		panel.route({ 'organize-jobs': { jobs: [Object.assign({}, running, { status: 'done', finishedAt: new Date().toISOString() })], total: 1, running: '' } })
		await new Promise((resolve) => setTimeout(resolve, 2400))
		await panel.settle()
		assert.ok(panel.calls.filter((item) => item.endpoint === 'organize-status').length > firstStatusCalls, '作业结束后刷新 status')
		assert.ok(panel.calls.filter((item) => item.endpoint === 'digest').length > firstDigestCalls, '作业结束后刷新 digest')
	} finally {
		panel.dispose()
	}
})

//#endregion
