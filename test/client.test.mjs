/**
 * Render the panel with a tiny React runtime.
 *
 * The feedback bug this guards against was invisible to static checks: the
 * status text existed but ended up somewhere the user could not see. So the
 * test renders the real component tree, clicks the export button and asserts
 * that a visible toast shows up with the result.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * A minimal React: createElement, state, effects and stable callbacks.
 *
 * @returns {object} The runtime, with render/settle helpers.
 */
function createRuntime() {
	const instances = new Map()
	let currentInstance = null
	let scheduled = false

	/**
	 * Compare two dependency arrays.
	 *
	 * @param {unknown[] | undefined} left - Previous deps.
	 * @param {unknown[] | undefined} right - Next deps.
	 * @returns {boolean} True when equal.
	 */
	function sameDeps(left, right) {
		if (left === undefined || right === undefined) return false
		if (left.length !== right.length) return false
		return left.every((value, index) => Object.is(value, right[index]))
	}

	/**
	 * The hook state of one component instance.
	 *
	 * @param {string} key - Stable instance key.
	 * @returns {object} The instance.
	 */
	function instanceFor(key) {
		let instance = instances.get(key)
		if (instance === undefined) {
			instance = { key, state: [], memo: [], effectSlots: [], pendingEffects: [], cursor: 0 }
			instances.set(key, instance)
		}
		instance.cursor = 0
		return instance
	}

	/**
	 * React.createElement.
	 *
	 * @param {Function | string} type - Element type.
	 * @param {object | null} props - Props.
	 * @param {...unknown} children - Children.
	 * @returns {object} The element.
	 */
	function createElement(type, props, ...children) {
		return {
			type,
			props: {
				...(props ?? {}),
				children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
			},
		}
	}

	function useState(initial) {
		const instance = currentInstance
		const index = instance.cursor++
		if (!(index in instance.state)) {
			instance.state[index] = typeof initial === 'function' ? initial() : initial
		}
		if (instance.setters === undefined) instance.setters = []
		if (instance.setters[index] === undefined) {
			instance.setters[index] = (value) => {
				const next = typeof value === 'function' ? value(instance.state[index]) : value
				if (Object.is(next, instance.state[index])) return
				instance.state[index] = next
				scheduled = true
			}
		}
		return [instance.state[index], instance.setters[index]]
	}

	function useEffect(effect, deps) {
		const instance = currentInstance
		const index = instance.cursor++
		const previous = instance.effectSlots[index]
		if (previous !== undefined && sameDeps(previous.deps, deps)) return
		instance.pendingEffects.push({ index, effect, deps })
	}

	function useCallback(callback, deps) {
		const instance = currentInstance
		const index = instance.cursor++
		const previous = instance.memo[index]
		if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
		instance.memo[index] = { deps, value: callback }
		return callback
	}

	function useMemo(factory, deps) {
		const instance = currentInstance
		const index = instance.cursor++
		const previous = instance.memo[index]
		if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
		const value = factory()
		instance.memo[index] = { deps, value }
		return value
	}

	/**
	 * Render one node tree.
	 *
	 * @param {unknown} node - Element, array, text or null.
	 * @param {string} key - Stable path.
	 * @returns {unknown} The rendered tree.
	 */
	function renderNode(node, key) {
		if (node === null || node === undefined || typeof node === 'boolean') return null
		if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
		if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${key}.${index}`))
		const { type, props } = node
		if (typeof type === 'function') {
			const name = type.name || 'component'
			const instanceKey = `${key}/${name}`
			const instance = instanceFor(instanceKey)
			const previous = currentInstance
			currentInstance = instance
			let output
			try {
				output = type(props)
			} finally {
				currentInstance = previous
			}
			return renderNode(output, instanceKey)
		}
		return {
			type,
			props: {
				...props,
				children: renderNode(props.children, `${key}.children`),
			},
		}
	}

	/**
	 * Run the effects queued by the last render.
	 *
	 * @returns {void}
	 */
	function flushEffects() {
		for (const instance of instances.values()) {
			const pending = instance.pendingEffects
			instance.pendingEffects = []
			for (const { index, effect, deps } of pending) {
				const previous = instance.effectSlots[index]
				if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
				const cleanup = effect()
				instance.effectSlots[index] = { deps, cleanup }
			}
		}
	}

	/**
	 * Render until no state update is pending, letting promises settle.
	 *
	 * @param {Function} render - The root render function.
	 * @returns {Promise<object>} The last rendered tree.
	 */
	async function settle(render) {
		let tree = render()
		flushEffects()
		for (let round = 0; round < 30; round += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0))
			if (!scheduled) {
				// One more pass: effects may have queued promises without state.
				flushEffects()
				if (!scheduled) return tree
			}
			scheduled = false
			tree = render()
			flushEffects()
		}
		return tree
	}

	return { createElement, useState, useEffect, useCallback, useMemo, renderNode, settle }
}

/**
 * Find every rendered node matching a predicate.
 *
 * @param {unknown} tree - A rendered tree.
 * @param {(node: object) => boolean} predicate - The matcher.
 * @returns {object[]} The matches.
 */
function findAll(tree, predicate) {
	const matches = []
	/**
	 * Walk one node.
	 *
	 * @param {unknown} node - The node.
	 * @returns {void}
	 */
	function walk(node) {
		if (node === null || node === undefined) return
		if (Array.isArray(node)) {
			for (const child of node) walk(child)
			return
		}
		if (typeof node !== 'object') return
		if (node.type !== undefined && predicate(node)) matches.push(node)
		walk(node.props?.children)
	}
	walk(tree)
	return matches
}

/**
 * Whether a node is the toast container itself.
 *
 * @param {object} node - A rendered node.
 * @returns {boolean} True for the toast root.
 */
function isToast(node) {
	const className = typeof node.props?.className === 'string' ? node.props.className : ''
	return className.split(' ').includes('evrToast')
}

/**
 * The text content of one rendered node.
 *
 * @param {object} node - The node.
 * @returns {string} Its text.
 */
function textOf(node) {
	let text = ''
	/**
	 * Walk one node.
	 *
	 * @param {unknown} current - The node.
	 * @returns {void}
	 */
	function walk(current) {
		if (current === null || current === undefined) return
		if (Array.isArray(current)) {
			for (const child of current) walk(child)
			return
		}
		if (typeof current === 'string') {
			text += current
			return
		}
		if (typeof current !== 'object') return
		if (typeof current.text === 'string') text += current.text
		walk(current.props?.children)
	}
	walk(node)
	return text
}

/**
 * Load the browser half and hand back the panel component.
 *
 * @param {object} runtime - The React runtime.
 * @returns {Promise<{Panel: Function, ctx: object}>} The component and its context.
 */
async function loadPanel(runtime) {
	let definition
	globalThis.window = {
		__ModuleLoader__: {
			load(value) {
				definition = value
			},
		},
	}
	globalThis.document = {
		createElement() {
			return { dataset: {}, setAttribute() {}, appendChild() {}, remove() {}, set textContent(value) {} }
		},
		head: { appendChild() {} },
	}
	const url = new URL('../client.js', import.meta.url)
	await import(`${url.href}?test=${Date.now()}`)
	assert.ok(definition !== undefined, '客户端没有调用 __ModuleLoader__.load')
	const api = definition.factory((name) => {
		assert.equal(name, 'react')
		return runtime
	})
	let Panel = null
	const styles = { locale: [], registered: [] }
	const ctx = {
		locale: {
			register() {
				return () => {}
			},
			bind() {
				return (key) => key
			},
		},
		slots: {
			inject(_key, callback) {
				const disposer = callback()
				return () => {
					if (typeof disposer === 'function') disposer()
				}
			},
			register(config, Component) {
				styles.registered.push(config.name ?? 'unknown')
				if (config.name === 'main') Panel = Component
				return () => {}
			},
		},
		effect(callback) {
			const disposer = callback()
			return () => {
				if (typeof disposer === 'function') disposer()
			}
		},
		get(name) {
			return name === 'connection' ? {} : undefined
		},
	}
	await api.apply(ctx)
	assert.ok(Panel !== null, '主面板没有注册')
	return { Panel, ctx }
}

/**
 * Whether the stubbed embedding model is already downloaded.
 */
let embeddingPresent = false

/**
 * Answer the panel's API calls.
 *
 * @param {string} endpoint - The endpoint name.
 * @param {object} payload - The request payload.
 * @returns {object} The response body.
 */
function apiPayload(endpoint, payload) {
	switch (endpoint) {
		case 'overview':
			return {
				version: '9.9.9',
				root: '/data/evolver',
				projection: { entries: 3, injectedBytes: 100, injectedBudget: 2048, byKind: [] },
				cards: { total: 3 },
				stats: { cards: 3, tags: 2, days: 10, words: 120 },
				period: { days: 30, notes: 3, words: 120, maxNotes: 2, maxWords: 80, activeDays: 2 },
				year: { days: 365, notes: 3, words: 120, maxNotes: 2, maxWords: 80, activeDays: 2 },
				activity: [{ date: '2026-11-09', count: 1 }, { date: '2026-11-10', count: 2 }],
				tree: [{
					path: '践行', name: '践行', count: 2, direct: 0, children: [{
						path: '践行/工作流', name: '工作流', count: 1, direct: 1, children: [],
					}],
				}],
				suggestions: [],
			}
		case 'injection':
			return {
				cards: { text: '[卡片]', bytes: 10, budget: 2048, entries: 3, dropped: 0 },
				soul: { text: 'soul', bytes: 4, budget: 1024 },
				preferences: { text: 'prefs', bytes: 5, link: { kind: 'missing' } },
				totalBytes: 19,
			}
		case 'soul':
			return { content: '', bytes: 0 }
		case 'preferences':
			return { content: '', bytes: 0, link: { kind: 'missing' }, globalPath: '/home/AGENTS.md', path: '/data/evolver/preferences/AGENTS.md' }
		case 'settings':
			return {
				dataDir: '/data/evolver',
				dataDirSource: 'settings',
				dataDirWarning: '',
				defaultDataDir: '/data/evolver',
				storedDataDir: '/data/evolver',
				settingsPath: '/home/evolver.config.json',
				suggestedArchive: '/data/dsh-evolver-20260101-120000.tar.gz',
				suggestedArchiveDir: '/data',
				suggestedArchiveName: 'dsh-evolver-20260101-120000.tar.gz',
				backup: {
					enabled: false,
					endpoint: '',
					bucket: '',
					accessKeyId: '',
					hasAccessKeySecret: false,
					prefix: 'dsh-evolver',
					keep: 7,
					intervalMinutes: 1440,
				},
				status: {},
			}
		case 'data-export':
			return { file: `${payload.dir}/${payload.name}`, files: 4, bytes: 1234 }
		case 'data-import':
			return { root: '/data/evolver', files: 2, bytes: 99, skipped: 0 }
		case 'card-list':
			return {
				cards: [{
					id: 'card-01HF7YAT00S37S1ZGTH35DPPXW',
					label: '卡片标题',
					body: '卡片正文',
					tags: ['践行/验证/浏览器'],
					links: [],
					resources: [],
					updated: '2026-11-10T00:00:00.000Z',
				}],
				tree: [{
					path: '践行', name: '践行', count: 2, direct: 0, children: [{
						path: '践行/工作流', name: '工作流', count: 1, direct: 1, children: [{
							path: '践行/工作流/部署', name: '部署', count: 1, direct: 1, children: [],
						}],
					}],
				}],
				status: { cards: 1 },
				cardMaxChars: 1000,
			}
		case 'card-read':
			return {
				card: {
					id: payload.id,
					label: '卡片标题',
					body: '卡片正文',
					tags: ['践行/验证/浏览器'],
					links: [],
					resources: [],
				},
				links: [],
				backlinks: [],
			}
		case 'ingest-status':
			return {
				enabled: true,
				idleMinutes: 15,
				available: false,
				pending: 0,
				taskId: '',
				lastActivityAt: 0,
				lastAutoAt: 0,
				ledger: { processed: 0, lastCommitAt: '' },
			}
		case 'embedding-status':
			return {
				embedding: {
					provider: 'local',
					model: 'multilingual-e5-small',
					modelPath: '',
					runtimePath: '',
					baseURL: '',
					hasApiKey: false,
					mirror: 'https://hf-mirror.com',
				},
				resolved: { modelsDir: '/data/models', runtimePath: '/data/runtime' },
				runtime: { path: '/data/runtime', available: false, hint: 'npm install --prefix /data/runtime @huggingface/transformers' },
				catalog: [{
					id: 'multilingual-e5-small',
					label: 'E5 Small',
					languages: '中文 + 英文',
					dimensions: 384,
					bytes: 135392183,
					note: '默认推荐',
				}],
				present: { 'multilingual-e5-small': embeddingPresent },
				download: { status: 'idle', model: '', file: '', fileIndex: 0, fileCount: 0, bytes: 0, totalBytes: 0, error: '' },
				store: { embedder: 'local', dimensions: 256, aligned: true, ready: false, backend: 'local', model: '', entries: 0 },
			}
		case 'data-archives':
			return {
				dir: payload.dir,
				files: [{ name: 'backup-1.tar.gz', path: `${payload.dir}/backup-1.tar.gz`, size: 10, updatedAt: new Date().toISOString() }],
			}
		default:
			return {}
	}
}

test('点击导出后面板显示可见的成功提示', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)

		// switch to the settings tab
		const settingsTab = findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.settings')
		assert.equal(settingsTab.length, 1)
		settingsTab[0].props.onClick()
		tree = await runtime.settle(render)

		// the settings page is split into sub-tabs; export lives in its own
		const transferTab = findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'settings.transfer')
		assert.equal(transferTab.length, 1)
		transferTab[0].props.onClick()
		tree = await runtime.settle(render)

		// click export with the prefilled folder and name
		const exportButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === 'settings.action.export')
		assert.equal(exportButton.length, 1)
		exportButton[0].props.onClick()
		tree = await runtime.settle(render)

		const toast = findAll(tree, isToast)
		assert.equal(toast.length, 1, '没有渲染 toast')
		assert.match(String(toast[0].props.className), /evrToastOk/)
		assert.match(textOf(toast[0]), /state\.exported/)
		assert.match(textOf(toast[0]), /\/data\/dsh-evolver-20260101-120000\.tar\.gz/)

		// the close button dismisses it and clears the auto-hide timer
		const close = findAll(toast[0], (node) => typeof node.props?.className === 'string' && node.props.className.includes('evrToastClose'))
		assert.equal(close.length, 1)
		close[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(findAll(tree, isToast).length, 0)
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('设置里的向量模型子标签展示可选模型和下载入口', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.settings')[0].props.onClick()
		tree = await runtime.settle(render)
		const embeddingTab = findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'settings.section.embedding')
		assert.equal(embeddingTab.length, 1)
		embeddingTab[0].props.onClick()
		tree = await runtime.settle(render)
		// 切到“本地模型”，模型目录与下载按钮才会出现
		const providers = findAll(tree, (node) => node.type === 'input' && node.props?.name === 'evr-embedding-provider')
		assert.equal(providers.length, 3)
		providers[1].props.onChange({ target: { checked: true } })
		tree = await runtime.settle(render)
		const text = textOf(tree)
		assert.match(text, /E5 Small/)
		assert.match(text, /settings\.embedding\.download/)
		assert.match(text, /settings\.embedding\.providerModel/)
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('已下载的模型显示绿色不可点的“已下载”', async () => {
	embeddingPresent = true
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.settings')[0].props.onClick()
		tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'settings.section.embedding')[0].props.onClick()
		tree = await runtime.settle(render)
		const providers = findAll(tree, (node) => node.type === 'input' && node.props?.name === 'evr-embedding-provider')
		providers[1].props.onChange({ target: { checked: true } })
		tree = await runtime.settle(render)
		const done = findAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes('evrBtnOk'))
		assert.equal(done.length, 1)
		assert.equal(done[0].props.disabled, true)
		assert.equal(textOf(done[0]), 'settings.embedding.downloaded')
	} finally {
		embeddingPresent = false
		globalThis.fetch = previousFetch
	}
})

test('卡片和灵魂是独立标签，卡片页有筛选、列表和新建入口', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		const tabs = findAll(tree, (node) => node.props?.role === 'tab').map((node) => textOf(node))
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.stats').length >= 1)
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.heatmap').length >= 1)
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.tree').length >= 1)
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.period').length >= 1)
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrMetric').length, 5)
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.yearHeatmap').length >= 1)
		assert.ok(findAll(tree, (node) => node.props?.className === 'evrHeatmapWrap evrHeatmapDense').length === 1)
		assert.ok(findAll(tree, (node) => node.props?.className === 'evrGraph').length === 1)
		assert.ok(findAll(tree, (node) => textOf(node).includes('#践行')).length >= 1)
		assert.ok(tabs.includes('tab.cards'))
		assert.ok(tabs.includes('tab.soul'))
		assert.equal(tabs.includes('tab.sight'), false)

		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.cards')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.ok(findAll(tree, (node) => node.type === 'button' && textOf(node) === 'cards.new').length === 1)
		assert.ok(findAll(tree, (node) => node.type === 'button' && textOf(node) === 'cards.filter.execution').length === 1)
		assert.ok(findAll(tree, (node) => node.props?.['aria-label'] === '收起标签 践行').length === 1)
		assert.ok(findAll(tree, (node) => textOf(node) === '#工作流').length >= 1)
		findAll(tree, (node) => node.props?.['aria-label'] === '收起标签 践行')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(findAll(tree, (node) => textOf(node) === '#工作流').length, 0)
		assert.ok(findAll(tree, (node) => node.props?.['aria-label'] === '展开标签 践行').length === 1)
		findAll(tree, (node) => node.props?.['aria-label'] === '展开标签 践行')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.ok(findAll(tree, (node) => textOf(node) === '#工作流').length >= 1)
		findAll(tree, (node) => node.props?.['aria-label'] === '收起标签 践行/工作流')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(findAll(tree, (node) => textOf(node) === '#部署').length, 0)
		assert.ok(findAll(tree, (node) => textOf(node) === '卡片标题').length >= 1)

		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.soul')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(findAll(tree, (node) => node.type === 'textarea').length, 1)
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('卡片筛选切到践行后保持选中，搜索和新建都在工具栏', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.cards')[0].props.onClick()
		tree = await runtime.settle(render)
		const execution = findAll(tree, (node) => node.type === 'button' && textOf(node) === 'cards.filter.execution')[0]
		execution.props.onClick()
		tree = await runtime.settle(render)
		const selected = findAll(tree, (node) => node.type === 'button' && textOf(node) === 'cards.filter.execution')[0]
		assert.match(String(selected.props.className), /evrTabActive/)
		assert.equal(findAll(tree, (node) => node.type === 'input' && node.props?.type === 'search').length >= 1, true)
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('导出目录为空时点击给出明确提示，而不是静默', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		const body = apiPayload(endpoint, payload)
		// Simulate a host that predates the suggested folder: fields stay empty.
		if (endpoint === 'settings') {
			delete body.suggestedArchiveDir
			delete body.suggestedArchiveName
		}
		return { ok: true, status: 200, json: async () => body }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.settings')[0].props.onClick()
		tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'settings.transfer')[0].props.onClick()
		tree = await runtime.settle(render)
		findAll(tree, (node) => node.type === 'button' && textOf(node) === 'settings.action.export')[0].props.onClick()
		tree = await runtime.settle(render)
		const toast = findAll(tree, isToast)
		assert.equal(toast.length, 1)
		assert.match(String(toast[0].props.className), /evrToastError/)
		assert.match(textOf(toast[0]), /settings\.needDir/)
	} finally {
		globalThis.fetch = previousFetch
	}
})
