/**
 * Render the panel with a tiny React runtime.
 *
 * The feedback bug this guards against was invisible to static checks: the
 * status text existed but ended up somewhere the user could not see. So the
 * test renders the real component tree, clicks the export button and asserts
 * that a visible toast shows up with the result.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
			instance = { key, state: [], memo: [], refs: [], effectSlots: [], pendingEffects: [], cursor: 0, kinds: [], lastKinds: undefined }
			instances.set(key, instance)
		}
		instance.cursor = 0
		instance.kinds = []
		return instance
	}

	/**
	 * Record one hook call, so a component cannot change its hook sequence
	 * between renders (real React throws "Rendered more/fewer hooks").
	 *
	 * @param {string} kind - Hook name.
	 * @returns {number} The hook slot index.
	 */
	function noteHook(kind) {
		const instance = currentInstance
		instance.kinds.push(kind)
		return instance.cursor++
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
		const index = noteHook('state')
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
		const index = noteHook('effect')
		const previous = instance.effectSlots[index]
		if (previous !== undefined && sameDeps(previous.deps, deps)) return
		instance.pendingEffects.push({ index, effect, deps })
	}

	/** A ref that survives re-renders, like React's. */
	function useRef(initial) {
		const instance = currentInstance
		const index = noteHook('ref')
		if (!(index in instance.refs)) instance.refs[index] = { current: initial }
		return instance.refs[index]
	}

	function useCallback(callback, deps) {
		const instance = currentInstance
		const index = noteHook('callback')
		const previous = instance.memo[index]
		if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
		instance.memo[index] = { deps, value: callback }
		return callback
	}

	function useMemo(factory, deps) {
		const instance = currentInstance
		const index = noteHook('memo')
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
				if (instance.lastKinds !== undefined) {
					const same = instance.lastKinds.length === instance.kinds.length
						&& instance.lastKinds.every((kind, index) => kind === instance.kinds[index])
					assert.ok(same, `Hook 序列在同一次挂载内变化：${instanceKey}\n  前: ${instance.lastKinds.join(',')}\n  后: ${instance.kinds.join(',')}`)
				}
				instance.lastKinds = instance.kinds
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

	return { createElement, useState, useEffect, useCallback, useMemo, useRef, renderNode, settle }
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
	const styles = { registered: [] }
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
				cards: { total: 3 },
				stats: { cards: 3, tags: 2, days: 10, words: 120, indexRatio: 0.015 },
				year: { days: 365, notes: 3, words: 120, maxNotes: 2, maxWords: 80, activeDays: 2 },
				activity: [{ date: '2026-11-09', count: 1 }, { date: '2026-11-10', count: 2 }],
				injection: {
					section: '[卡片] 纪律段\n\n[主动性] 协议',
					index: '[卡片索引]\n- card-01HF7YAT00S37S1ZGTH35DPPXW｜示例卡｜连 2',
				},
				tree: [{
					path: '践行', name: '践行', count: 2, direct: 0, children: [{
						path: '践行/工作流', name: '工作流', count: 1, direct: 1, children: [],
					}],
				}],
			}
		case 'consolidate-status':
			return {
				enabled: true,
				dailyCards: 15,
				hour: 3,
				available: true,
				due: 4,
				total: 9,
				lastRunAt: '2026-11-10T03:00:00.000Z',
				lastApplied: 3,
				lastBatch: 15,
				lastError: '',
				running: false,
				lastRun: { at: '2026-11-12T03:00:00.000Z', actions: 3, retagged: 2, tagMerges: 1 },
			}
		case 'consolidate-save':
			return { ...apiPayload('consolidate-status', payload), ...(payload.consolidate ?? {}) }
		case 'tag-descriptions':
			return {
				path: '/data/evolver/knowledge/tags.json',
				descriptions: { 践行: '落地与持续行动' },
				missing: [{ path: '践行/工作流', count: 1 }],
			}
		case 'tag-descriptions-save':
			return {
				path: '/data/evolver/knowledge/tags.json',
				descriptions: payload.descriptions ?? {},
			}
		case 'injection':
			return {
				cards: { text: '[卡片]', bytes: 10, budget: 2048, entries: 3, dropped: 0 },
				preferences: { text: 'prefs', bytes: 5, link: { kind: 'missing' } },
				totalBytes: 15,
			}
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
					links: ['card-01HF7YAT00S37S1ZGTH35DPPW2'],
					resources: [],
					updated: '2026-11-10T00:00:00.000Z',
				}, {
					id: 'card-01HF7YAT00S37S1ZGTH35DPPW2',
					label: '被引用的卡片',
					body: '正文',
					tags: ['见闻/git'],
					links: [],
					resources: [],
					updated: '2026-11-09T00:00:00.000Z',
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
					source: { quote: '用户原话：部署走 SSH，不要用 HTTPS。' },
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
				lastSaved: 3,
				lastQuoted: 2,
				ledger: { processed: 0, lastCommitAt: '' },
			}
		case 'graph':
			return {
				nodes: [{
					id: 'card-01HF7YAT00S37S1ZGTH35DPPXW',
					label: '卡片标题',
					description: '第一张卡',
					tags: ['践行/验证/浏览器'],
					branch: '践行',
					degree: 1,
					updated: '2026-11-10T00:00:00.000Z',
					readCount: 4,
					lastReadAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
				}, {
					id: 'card-01HF7YAT00S37S1ZGTH35DPPW2',
					label: '被引用的卡片',
					description: '第二张卡',
					tags: ['见闻/git'],
					branch: '见闻',
					degree: 1,
					updated: '2026-11-09T00:00:00.000Z',
					readCount: 0,
					lastReadAt: '',
				}, {
					id: 'card-01HF7YAT00S37S1ZGTH35DPPW3',
					label: '复盘随记',
					description: '第三张卡',
					tags: ['复盘'],
					branch: '复盘',
					degree: 1,
					updated: '2026-11-08T00:00:00.000Z',
					readCount: 0,
					lastReadAt: '',
				}, {
					id: 'card-01HF7YAT00S37S1ZGTH35DPPW4',
					label: '孤岛卡片',
					description: '没有显式链接',
					tags: ['觉察'],
					branch: '觉察',
					degree: 0,
					updated: '2026-11-07T00:00:00.000Z',
					readCount: 0,
					lastReadAt: '',
				}],
				edges: [{
					source: 'card-01HF7YAT00S37S1ZGTH35DPPXW',
					target: 'card-01HF7YAT00S37S1ZGTH35DPPW2',
					kind: 'link',
					weight: 1,
					mutual: false,
				}, {
					source: 'card-01HF7YAT00S37S1ZGTH35DPPW2',
					target: 'card-01HF7YAT00S37S1ZGTH35DPPW3',
					kind: 'tag',
					weight: 0.5,
					mutual: false,
				}],
				totals: { cards: 7, nodes: 4, edges: 2, links: 1, weak: 1, hiddenCards: 3, limit: 300 },
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

test('两个整理器在独立整理页，卡片页与设置页都不再自带整理块', async () => {
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

		// The cards tab no longer carries the organiser.
		assert.equal(findAll(tree, (node) => textOf(node) === 'sight.ingest.auto').length, 0)

		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.organize')[0].props.onClick()
		tree = await runtime.settle(render)

		// Both organisers live here: the session ingest and the daily cards.
		assert.ok(findAll(tree, (node) => textOf(node) === 'sight.ingest.auto').length >= 1)
		assert.ok(findAll(tree, (node) => textOf(node) === 'settings.consolidate.title').length >= 1)
		assert.ok(findAll(tree, (node) => textOf(node).includes('settings.consolidate.due')).length >= 1)
		// 出处捕获率要看得见，否则不知道这个约定有没有在生效。
		assert.ok(findAll(tree, (node) => textOf(node) === 'sight.ingest.quoted').length >= 1)
		assert.ok(findAll(tree, (node) => textOf(node) === 'settings.consolidate.lastTags').length >= 1, '面板要能看到上次整理改了几个标签')

		// The daily batch defaults to 15 and can be changed before saving.
		const numbers = findAll(tree, (node) => node.type === 'input' && node.props?.type === 'number')
		assert.ok(numbers.length >= 2)
		const batch = numbers.find((node) => node.props.value === 15)
		assert.ok(batch, '每天张数默认为 15')
		batch.props.onChange({ target: { value: '30' } })
		tree = await runtime.settle(render)
		assert.ok(findAll(tree, (node) => node.type === 'input' && node.props?.value === 30).length >= 1)

		// Settings keeps only the three data tabs; the organiser is not one.
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.settings')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'settings.section.organize').length, 0)
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('卡片和偏好是独立标签，卡片页有筛选、列表和新建入口', async () => {
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
		assert.ok(findAll(tree, (node) => textOf(node).includes('overview.heatmap.section')).length >= 1)
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.graph').length >= 1)
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.linkGraph').length >= 1)
		// The link graph draws every node of the graph payload: one dot per card,
		// the explicit link as a solid edge and the derived tag tie as a weak one.
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrLinkGraph').length, 1)
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrLinkEdge').length, 1)
		const graphNodeGroups = () => findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.split(' ').includes('evrLinkNode'))
		assert.equal(graphNodeGroups().length, 4, '孤立卡也要画出来')
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrLinkNode evrLinkNodeRecent').length, 1,
			'最近读取的卡片带活动环')
		// Labels are on by default: the top-degree cards are named without hover.
		const graphLabelTexts = () => findAll(tree, (node) => node.type === 'text'
			&& node.props?.className === 'evrLinkLabel').map((node) => textOf(node))
		assert.ok(graphLabelTexts().includes('卡片标题'), '默认标签应包含高度数卡片')

		// The layout is memoised: an unrelated re-render must reproduce it
		// exactly rather than drifting on a fresh simulation.
		const edgePath = () => findAll(tree, (node) => node.props?.className === 'evrLinkEdge')[0].props.d
		const positions = () => findAll(tree, (node) => node.type === 'circle' && node.props?.fill !== undefined)
			.filter((node) => typeof node.props.cx === 'number')
			.map((node) => `${node.props.cx.toFixed(3)},${node.props.cy.toFixed(3)}`)
			.sort()
		const before = { edge: edgePath(), nodes: positions() }
		// Leaving the sub-tab and coming back must reproduce the same picture,
		// not jitter on a fresh simulation.
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'overview.descriptions')[0].props.onClick()
		tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'overview.info')[0].props.onClick()
		tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'overview.stats')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(edgePath(), before.edge, '重渲染后连线不能漂移')
		assert.deepEqual(positions(), before.nodes, '重渲染后节点位置不能漂移')
		assert.equal(findAll(tree, (node) => textOf(node) === 'overview.yearHeatmap').length, 0)
		// The version sits next to the panel title; the injected-context cards are gone.
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrVersion' && textOf(node) === 'v9.9.9').length, 1)
		const cardTitles = findAll(tree, (node) => node.props?.className === 'evrCardTitle').map((node) => textOf(node))
		assert.deepEqual(cardTitles, ['overview.notes', 'overview.tags', 'overview.days', 'overview.index'])
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrHeatmapWrap').length, 1)
		assert.ok(findAll(tree, (node) => node.props?.className === 'evrGraph').length === 1)
		// Graph labels are plain tag names; the '#' prefix is not drawn.
		assert.ok(findAll(tree, (node) => textOf(node) === '践行').length >= 1)
		assert.equal(findAll(tree, (node) => textOf(node).includes('#践行')).length, 0)
		assert.ok(tabs.includes('tab.cards'))
		assert.ok(tabs.includes('tab.preferences'))
		assert.ok(tabs.includes('tab.organize'))
		assert.equal(tabs.includes('tab.soul'), false)
		assert.equal(tabs.includes('tab.sight'), false)

		// One heatmap, always the whole year; no range switch, and no fixed
		// width either: the cells share whatever width the pane has.
		const heatmap = findAll(tree, (node) => node.props?.className === 'evrHeatmapWrap')
		assert.equal(heatmap.length, 1)
		assert.equal(heatmap[0].props.style, undefined)
		assert.equal(findAll(heatmap[0], (node) => node.props?.className === 'evrHeatmapWeek').length, 1)
		const grid = findAll(heatmap[0], (node) => node.props?.className === 'evrHeatmap')[0]
		assert.equal(findAll(grid, (node) => node.props?.className === 'evrHeatCell evrHeat1').length, 1)
		assert.equal(findAll(grid, (node) => node.props?.className === 'evrHeatCell evrHeat2').length, 1)
		assert.equal(findAll(grid, (node) => node.props?.className === 'evrHeatCell evrHeatBlank').length, 5)
		assert.equal(findAll(tree, (node) => node.type === 'button' && textOf(node) === 'overview.range.year').length, 0)
		assert.equal(findAll(tree, (node) => node.type === 'button' && textOf(node) === 'overview.range.days').length, 0)
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.yearHeatmap.hint').length >= 1)

		// The graph draws the whole tree at once: roots and their children are
		// both in the picture before anything is clicked.
		const graphLabels = () => findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.includes('evrGraphLabel')).map((node) => textOf(node))
		assert.ok(graphLabels().filter((label) => label.startsWith('工作流')).length >= 1, '子标签一开始就在图上')
		const camera = () => findAll(tree, (node) => node.type === 'g'
			&& typeof node.props?.style?.transform === 'string' && node.props.style.transform.indexOf('scale(') > -1)[0]
		const zoomOf = () => Number(/scale\(([\d.]+)\)/.exec(camera().props.style.transform)[1])
		const fitted = zoomOf()

		// Clicking a node zooms the same picture instead of replacing the level:
		// the camera moves closer, and no label leaves the tree.
		const nodeGroup = findAll(tree, (node) => node.type === 'g'
			&& typeof node.props?.['aria-label'] === 'string' && node.props['aria-label'].startsWith('践行/工作流 ·'))[0]
		nodeGroup.props.onClick({ preventDefault() {}, stopPropagation() {} })
		tree = await runtime.settle(render)
		assert.ok(zoomOf() > fitted, '点击后放大')
		assert.ok(graphLabels().filter((label) => label.startsWith('工作流')).length >= 1, '放大后子标签还在')

		// Clicking the empty space fits the whole tree again.
		const svg = findAll(tree, (node) => node.type === 'svg'
			&& typeof node.props?.className === 'string' && node.props.className.includes('evrGraph'))[0]
		svg.props.onPointerDown({ clientX: 10, clientY: 10, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 460, height: 407 }) } })
		svg.props.onPointerUp({ clientX: 10, clientY: 10, target: { tagName: 'svg' }, currentTarget: { tagName: 'svg' } })
		tree = await runtime.settle(render)
		assert.equal(zoomOf(), fitted, '点空白回到适应全貌')

		// The overview splits into four sub-tabs; the injected blocks are read-only previews.
		const subTabs = findAll(tree, (node) => node.props?.role === 'tab').map((node) => textOf(node))
		for (const label of ['overview.stats', 'overview.descriptions', 'overview.info', 'overview.preferences']) {
			assert.ok(subTabs.includes(label), `missing sub-tab ${label}`)
		}
		assert.equal(subTabs.includes('overview.soul'), false)
		// The tag tree sits next to the relationship graph, and the graph keeps the drill-down.
		assert.ok(findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.includes('evrOverviewGraph')).length === 1)
		assert.ok(findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.includes('evrOverviewTree')).length === 1)
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.graph').length >= 1)
		// Both graphs carry a title and nothing else: the explanatory lines
		// were removed, so no hint text may sit above or below either canvas.
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.linkGraph').length >= 1)
		assert.equal(findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.includes('evrOverviewPane'))
			.some((pane) => findAll(pane, (node) => node.props?.className === 'evrHint').length > 0), false)
		const infoSubTab = findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'overview.info')
		assert.equal(infoSubTab.length, 1)
		infoSubTab[0].props.onClick()
		tree = await runtime.settle(render)
		// 信息页把每次请求注入的内容分成两张卡：静态段（纪律 + 主动性）、卡片索引。
		const infoBlocks = findAll(tree, (node) => node.props?.className === 'evrInfoBlock')
		assert.equal(infoBlocks.length, 2)
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrPre').length, 0)
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.info.hint').length >= 1)
		assert.ok(findAll(tree, (node) => typeof textOf(node) === 'string'
			&& /^overview\.info\.total$/.test(textOf(node)) === false
			&& textOf(node).includes('overview.info.total')).length >= 1, '页首有总量与预算')
		const blockTitles = findAll(tree, (node) => node.props?.className === 'evrSection evrInfoTitle').map((node) => textOf(node))
		assert.deepEqual(blockTitles, ['overview.info.section', 'overview.info.index'])
		// 两块默认展开，正文都渲染；卡片索引里有具体卡。
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrMd').length, 2)
		assert.ok(findAll(tree, (node) => typeof textOf(node) === 'string' && textOf(node).includes('示例卡')).length >= 1,
			'卡片索引的正文要渲染出来')
		// 收起一块 → 只少一块正文；再展开回来。
		const toggles = findAll(tree, (node) => node.type === 'button' && textOf(node) === 'overview.info.collapse')
		assert.equal(toggles.length, 2)
		toggles[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrMd').length, 1, '收起后正文隐藏')
		assert.equal(findAll(tree, (node) => node.type === 'button' && textOf(node) === 'overview.info.expand').length, 1)
		findAll(tree, (node) => node.type === 'button' && textOf(node) === 'overview.info.expand')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrMd').length, 2, '展开后正文回来')

		// Descriptions and the injected tree are separate pages: the editor is
		// not crammed under the prompt preview any more.
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrInput evrDescInput').length, 0,
			'注入预览页不出现描述编辑器')
		const descSubTab = findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'overview.descriptions')
		assert.equal(descSubTab.length, 1)
		descSubTab[0].props.onClick()
		tree = await runtime.settle(render)
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.descriptions').length >= 1)
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrMd').length, 0,
			'描述页不渲染注入预览')
		const descInputs = findAll(tree, (node) => node.props?.className === 'evrInput evrDescInput')
		assert.equal(descInputs.length, 2, '每个未归档分支一行')
		assert.equal(descInputs[0].props.value, '落地与持续行动')
		assert.equal(descInputs[1].props.value, '', '没有描述的分支是空的')
		assert.ok(findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.includes('evrDescRowMissing')).length === 1)
		descInputs[1].props.onChange({ target: { value: '可重复执行的工作流/流程' } })
		tree = await runtime.settle(render)
		const saveDescriptions = findAll(tree, (node) => node.type === 'button'
			&& typeof node.props?.className === 'string'
			&& node.props.className.includes('evrBtnPrimary')
			&& textOf(node) === 'action.save')
		assert.equal(saveDescriptions.length, 1)
		assert.equal(saveDescriptions[0].props.disabled, false)
		saveDescriptions[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.includes('evrDescRowMissing')).length, 0)

		const prefsSubTab = findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'overview.preferences')
		assert.equal(prefsSubTab.length, 1)
		prefsSubTab[0].props.onClick()
		tree = await runtime.settle(render)
		assert.ok(findAll(tree, (node) => textOf(node) === 'prefs').length >= 1)

		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.cards')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.ok(findAll(tree, (node) => node.type === 'button' && textOf(node) === 'cards.new').length === 1)
		assert.ok(findAll(tree, (node) => node.type === 'button' && textOf(node) === 'cards.filter.execution').length === 1)
		// The card list scrolls inside a column that follows the tag tree height.
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrCardsLayout').length, 1)
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrCardsTree').length, 1)
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrCardsBody').length, 1)
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrCardsScroll').length, 1)
		// The list time is relative while fresh, exact once the card is old.
		const rowTime = findAll(tree, (node) => node.props?.className === 'evrRowTime')
		assert.equal(rowTime.length, 2)
		assert.ok(/^(time\.(justNow|minutes|hours)|\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/.test(textOf(rowTime[0])))
		assert.match(rowTime[0].props.title, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
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

		// 详情里要能看到出处：卡片本身证明不了自己有没有记错。
		findAll(tree, (node) => node.props?.className === 'evrRow')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.ok(findAll(tree, (node) => textOf(node).includes('用户原话：部署走 SSH，不要用 HTTPS。')).length >= 1)
		assert.ok(findAll(tree, (node) => textOf(node).includes('cards.source')).length >= 1)

		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.preferences')[0].props.onClick()
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

test('搜索框边输入边过滤，没有搜索按钮', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	const calls = []
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		if (endpoint === 'card-list') calls.push(payload.query ?? '')
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.cards')[0].props.onClick()
		tree = await runtime.settle(render)

		// The button is gone; the input is the whole affordance.
		assert.equal(findAll(tree, (node) => node.type === 'button' && textOf(node) === 'cards.searchAction').length, 0)

		const input = findAll(tree, (node) => node.type === 'input' && node.props?.type === 'search')[0]
		const before = calls.length
		input.props.onChange({ target: { value: '缓存' } })
		// Render so the debounce is armed, but nothing is requested yet.
		tree = await runtime.settle(render)
		assert.equal(calls.length, before, '打字过程中不发请求')
		await new Promise((resolve) => setTimeout(resolve, 320))
		tree = await runtime.settle(render)
		assert.equal(calls[calls.length - 1], '缓存', '停顿后按输入内容过滤')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('链接关系图：连线越多的圆越大、枢纽居中，节点互不重叠', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	// One obvious hub, one second-tier hub, one two-link card and six leaves:
	// enough for the layout to show a core, a halo and a periphery.
	const cards = [
		{ id: 'hub', label: '枢纽', tags: ['践行'], links: ['a', 'b', 'c', 'd', 'e', 'second'] },
		{ id: 'second', label: '次枢纽', tags: ['见闻'], links: ['f', 'g'] },
		{ id: 'g', label: '两连接', tags: ['践行'], links: ['h'] },
		{ id: 'a', label: '叶子甲', tags: ['践行'], links: [] },
		{ id: 'b', label: '叶子乙', tags: ['践行'], links: [] },
		{ id: 'c', label: '叶子丙', tags: ['践行'], links: [] },
		{ id: 'd', label: '叶子丁', tags: ['见闻'], links: [] },
		{ id: 'e', label: '叶子戊', tags: ['见闻'], links: [] },
		{ id: 'f', label: '叶子己', tags: ['见闻'], links: [] },
		{ id: 'h', label: '叶子庚', tags: ['践行'], links: [] },
	]
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		if (endpoint === 'graph') {
			// What the Host derives from these cards: one node per card, one edge
			// per explicit link, degree from the links.
			const degree = new Map(cards.map((card) => [card.id, 0]))
			const edges = []
			const seen = new Set()
			for (const card of cards) {
				for (const target of card.links) {
					degree.set(card.id, degree.get(card.id) + 1)
					degree.set(target, (degree.get(target) ?? 0) + 1)
					const key = card.id < target ? `${card.id}|${target}` : `${target}|${card.id}`
					if (seen.has(key)) continue
					seen.add(key)
					edges.push({ source: card.id, target, kind: 'link', weight: 1, mutual: false })
				}
			}
			const nodes = cards.map((card) => ({
				id: card.id,
				label: card.label,
				description: '',
				tags: card.tags,
				branch: card.tags[0].split('/')[0],
				degree: degree.get(card.id),
				updated: '2026-11-10T00:00:00.000Z',
				readCount: 0,
				lastReadAt: '',
			}))
			return {
				ok: true,
				status: 200,
				json: async () => ({
					nodes,
					edges,
					totals: { cards: cards.length, nodes: nodes.length, edges: edges.length, links: edges.length, weak: 0, hiddenCards: 0, limit: 300 },
				}),
			}
		}
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const tree = await runtime.settle(() => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root'))
		const svg = findAll(tree, (node) => node.props?.className === 'evrLinkGraph')[0]
		assert.ok(svg !== undefined, '关系图没有渲染')
		const dots = findAll(svg, (node) => node.type === 'g' && typeof node.props?.['aria-label'] === 'string')
			.map((group) => {
				const circle = findAll(group, (node) => node.type === 'circle')[0]
				const [label, degree] = group.props['aria-label'].split(' · ')
				return { label, degree: Number(degree), x: circle.props.cx, y: circle.props.cy, r: circle.props.r }
			})
		assert.equal(dots.length, cards.length)
		const byDegree = dots.slice().sort((left, right) => right.degree - left.degree)
		// 1. Size is degree centrality: never decreasing as links grow.
		for (let i = 1; i < byDegree.length; i += 1) {
			if (byDegree[i].degree === byDegree[i - 1].degree) {
				assert.equal(byDegree[i].r, byDegree[i - 1].r, '同度数必须同大小')
			} else {
				assert.ok(byDegree[i].r <= byDegree[i - 1].r, `度数低的圆不能更大：${byDegree[i].label}`)
			}
		}
		assert.ok(byDegree[0].r > byDegree[byDegree.length - 1].r * 2, '枢纽必须明显大于叶子')
		// 2. No two circles overlap, and the whole picture stays inside the viewBox.
		for (let i = 0; i < dots.length; i += 1) {
			for (let j = i + 1; j < dots.length; j += 1) {
				const distance = Math.hypot(dots[i].x - dots[j].x, dots[i].y - dots[j].y)
				assert.ok(distance > dots[i].r + dots[j].r, `${dots[i].label} 与 ${dots[j].label} 重叠`)
			}
			assert.ok(dots[i].x - dots[i].r > 0 && dots[i].x + dots[i].r < 320, '节点跑出了画布')
			assert.ok(dots[i].y - dots[i].r > 0 && dots[i].y + dots[i].r < 300, '节点跑出了画布')
		}
		// 3. Core and periphery: the hub sits nearer the middle than the leaves,
		//    and holds its neighbours closer than the leaves sit to each other.
		const centreX = dots.reduce((sum, dot) => sum + dot.x, 0) / dots.length
		const centreY = dots.reduce((sum, dot) => sum + dot.y, 0) / dots.length
		const radiusOf = (dot) => Math.hypot(dot.x - centreX, dot.y - centreY)
		const leaves = dots.filter((dot) => dot.degree === 1)
		const hub = dots.find((dot) => dot.degree === 6)
		assert.ok(radiusOf(hub) < leaves.reduce((sum, dot) => sum + radiusOf(dot), 0) / leaves.length,
			'枢纽应当比叶子更靠中心')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('mini React 在 Hook 序列变化时报错（守卫自检）', () => {
	const runtime = createRuntime()
	let flip = false
	/**
	 * A component that calls an extra hook on the second render.
	 *
	 * @returns {object} The element.
	 */
	function Probe() {
		const [value] = runtime.useState(0)
		if (flip) runtime.useState(1)
		return runtime.createElement('div', null, String(value))
	}
	const render = () => runtime.renderNode(runtime.createElement(Probe), 'probe')
	render()
	flip = true
	assert.throws(render, /Hook 序列/)
})

test('客户端 t() 用到的 key 在中英文字典里都存在且两份字典键一致', () => {
	const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
	const zhStart = source.indexOf('var zh = {')
	const enStart = source.indexOf('var en = {')
	const enEnd = source.indexOf('//#endregion', enStart)
	assert.ok(zhStart > -1 && enStart > zhStart && enEnd > enStart, '找不到内联字典')
	/**
	 * The literal keys of one dictionary block.
	 *
	 * @param {string} text - The block source.
	 * @returns {Set<string>} The keys.
	 */
	function keysOf(text) {
		return new Set([...text.matchAll(/'([a-zA-Z][\w.\-]*)':/g)].map((match) => match[1]))
	}
	const zh = keysOf(source.slice(zhStart, enStart))
	const en = keysOf(source.slice(enStart, enEnd))
	assert.deepEqual([...zh].sort(), [...en].sort(), '中英文字典的键必须一致')
	const used = new Set()
	// t('key') 里出现的每个字面量都是字典键；t(item.label) 的 TABS 标签单独收集。
	for (const call of source.matchAll(/\bt\(([^)]*)\)/g)) {
		for (const inner of call[1].matchAll(/'([^']+)'/g)) used.add(inner[1])
	}
	for (const match of source.matchAll(/label: '([a-zA-Z][\w.\-]*)'/g)) used.add(match[1])
	const missing = [...used].filter((key) => !zh.has(key))
	assert.deepEqual(missing, [], `未定义的 i18n key：${missing.join(', ')}`)
})

test('非关键端点失败只提示部分失败，其它页签照常可用', async () => {
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
		if (endpoint === 'preferences') throw new Error('preferences down')
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		assert.equal(findAll(tree, (node) => textOf(node) === 'state.error').length, 0, '单个非关键端点失败不应出现错误页')
		assert.ok(findAll(tree, (node) => textOf(node) === 'state.partial').length >= 1, '应有部分失败提示')
		assert.ok(findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.cards').length === 1)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.cards')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.ok(findAll(tree, (node) => node.type === 'button' && textOf(node) === 'cards.new').length === 1, '卡片页仍可用')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('首屏端点失败显示错误页与重试按钮，重试后恢复；非 JSON 错误回落到状态码', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	let broken = true
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		if (broken && endpoint === 'overview') {
			// A proxy-style failure: HTML/text body with a 502 status.
			return { ok: false, status: 502, json: async () => { throw new SyntaxError('not json') } }
		}
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		assert.ok(findAll(tree, (node) => node.props?.className === 'evrEmpty').length >= 1, '应显示错误页')
		assert.match(textOf(findAll(tree, (node) => node.props?.className === 'evrEmpty')[0]), /HTTP 502/)
		const retry = findAll(tree, (node) => node.type === 'button' && textOf(node) === 'action.retry')
		assert.equal(retry.length, 1, '错误页应有重试按钮')
		broken = false
		retry[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(findAll(tree, (node) => textOf(node) === 'state.error').length, 0)
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.stats').length >= 1, '重试后恢复首屏')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('链接图的 Hook 数量不随布局有无翻转（真实 React 白屏回归）', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	let linked = false
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		if (endpoint === 'graph') {
			const nodes = linked
				? [
					{ id: 'c1', label: '第一张', description: '', tags: ['践行'], branch: '践行', degree: 1, updated: '2026-11-10T00:00:00.000Z', readCount: 0, lastReadAt: '' },
					{ id: 'c2', label: '第二张', description: '', tags: ['见闻'], branch: '见闻', degree: 1, updated: '2026-11-09T00:00:00.000Z', readCount: 0, lastReadAt: '' },
				]
				: []
			const edges = linked ? [{ source: 'c1', target: 'c2', kind: 'link', weight: 1, mutual: false }] : []
			return {
				ok: true,
				status: 200,
				json: async () => ({
					nodes,
					edges,
					totals: { cards: 2, nodes: nodes.length, edges: edges.length, links: edges.length, weak: 0, hiddenCards: 0, limit: 300 },
				}),
			}
		}
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		const refresh = () => findAll(tree, (node) => node.type === 'button' && textOf(node) === 'action.refresh')[0]
		const graphNodeCount = () => findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.split(' ').includes('evrLinkNode')).length
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrLinkGraph').length, 0, '空图时只有空态')
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.linkGraph.empty').length >= 1, '空图要有提示')
		// 空图 → 有图：Hook 数量若翻转，mini React 的守卫会直接抛错。
		linked = true
		refresh().props.onClick()
		tree = await runtime.settle(render)
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrLinkGraph').length, 1)
		assert.equal(graphNodeCount(), 2)
		// 有链接 → 无链接：反向也要通过。
		linked = false
		refresh().props.onClick()
		tree = await runtime.settle(render)
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrLinkGraph').length, 0)
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('快速连点两张卡时，后点的卡片不会被先前的慢响应覆盖', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	const cards = [
		{ id: 'c1', label: '第一张', body: '正文一', tags: ['践行'], links: [], resources: [], updated: '2026-11-10T00:00:00.000Z' },
		{ id: 'c2', label: '第二张', body: '正文二', tags: ['见闻'], links: [], resources: [], updated: '2026-11-09T00:00:00.000Z' },
	]
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		if (endpoint === 'card-list') return { ok: true, status: 200, json: async () => ({ cards, total: cards.length, tree: [], status: {}, cardMaxChars: 1000 }) }
		if (endpoint === 'card-read') {
			const id = payload.id
			await new Promise((resolve) => setTimeout(resolve, id === 'c1' ? 120 : 5))
			return { ok: true, status: 200, json: async () => ({ card: cards.find((card) => card.id === id), links: [], backlinks: [] }) }
		}
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.cards')[0].props.onClick()
		tree = await runtime.settle(render)
		const rows = findAll(tree, (node) => node.props?.className === 'evrRow')
		assert.equal(rows.length, 2)
		rows[0].props.onClick()
		rows[1].props.onClick()
		await new Promise((resolve) => setTimeout(resolve, 250))
		tree = await runtime.settle(render)
		const titles = findAll(tree, (node) => node.props?.className === 'evrCardTitle').map((node) => textOf(node))
		assert.deepEqual(titles, ['第二张'], '慢响应覆盖了后点的卡片')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('220ms 内点标签筛选时，搜索防抖不会丢掉标签条件', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	const calls = []
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		if (endpoint === 'card-list') calls.push(payload)
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.cards')[0].props.onClick()
		tree = await runtime.settle(render)
		const input = findAll(tree, (node) => node.type === 'input' && node.props?.type === 'search')[0]
		input.props.onChange({ target: { value: '缓存' } })
		// Arm the debounce timer first, then click the tag filter while it is pending.
		tree = await runtime.settle(render)
		findAll(tree, (node) => node.type === 'button' && textOf(node) === 'cards.filter.input')[0].props.onClick()
		tree = await runtime.settle(render)
		await new Promise((resolve) => setTimeout(resolve, 320))
		tree = await runtime.settle(render)
		const last = calls[calls.length - 1]
		assert.equal(last.query, '缓存')
		assert.deepEqual(last.tags, ['见闻'], '防抖把刚点的标签条件丢了')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('概览链接图与卡片页筛选解耦，未入图的卡片要注明', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	const all = [
		{ id: 'a1', label: '甲', body: '正文', tags: ['践行'], links: ['a2'], resources: [], updated: '2026-11-10T00:00:00.000Z' },
		{ id: 'a2', label: '乙', body: '正文', tags: ['践行'], links: ['a1'], resources: [], updated: '2026-11-09T00:00:00.000Z' },
		{ id: 'a3', label: '丙', body: '正文', tags: ['见闻'], links: [], resources: [], updated: '2026-11-08T00:00:00.000Z' },
	]
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		if (endpoint === 'card-list') {
			// The cards tab filters; the link graph asks for its own page (limit 200).
			const filtered = Array.isArray(payload.tags) && payload.tags.length > 0
			const cards = filtered ? [all[2]] : all
			return { ok: true, status: 200, json: async () => ({ cards, total: filtered ? 1 : all.length + 4, tree: [], status: {}, cardMaxChars: 1000 }) }
		}
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		const graphNodeCount = () => findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.split(' ').includes('evrLinkNode')).length
		assert.equal(graphNodeCount(), 4)
		assert.ok(findAll(tree, (node) => textOf(node).includes('overview.linkGraph.hidden')).length >= 1,
			'totals.hiddenCards > 0 时要注明未入图')
		// Narrow the cards tab, then go back: the graph must keep the whole library.
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.cards')[0].props.onClick()
		tree = await runtime.settle(render)
		findAll(tree, (node) => node.type === 'button' && textOf(node) === 'cards.filter.input')[0].props.onClick()
		tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.overview')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(graphNodeCount(), 4, '概览图不能继承卡片页的筛选')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('超过 8MB 的附件在读取前就被拒绝', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	const calls = []
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		calls.push(endpoint)
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.cards')[0].props.onClick()
		tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.className === 'evrRow')[0].props.onClick()
		tree = await runtime.settle(render)
		const input = findAll(tree, (node) => node.type === 'input' && node.props?.type === 'file')[0]
		assert.ok(input !== undefined, '附件入口没有渲染')
		input.props.onChange({ target: { files: [{ name: 'big.log', size: 9 * 1024 * 1024 }], value: '' } })
		tree = await runtime.settle(render)
		const toast = findAll(tree, isToast)
		assert.equal(toast.length, 1)
		assert.match(textOf(toast[0]), /cards\.attachTooLarge/)
		assert.equal(calls.includes('card-attach'), false, '大文件不应发出上传请求')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('Markdown 预览不把 //host 变成可点的站外链接', async () => {
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
		if (endpoint === 'overview') {
			body.injection = {
				section: '[点我](//evil.example/phish) 与 [正常](https://example.com/ok)',
				index: '[卡片索引]',
			}
		}
		return { ok: true, status: 200, json: async () => body }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'overview.info')[0].props.onClick()
		tree = await runtime.settle(render)
		const anchors = findAll(tree, (node) => node.type === 'a')
		const hrefs = anchors.map((node) => node.props.href)
		assert.equal(hrefs.includes('//evil.example/phish'), false, '协议相对 URL 不能渲染成链接')
		assert.ok(hrefs.includes('https://example.com/ok'), '正常外链仍要渲染')
		assert.equal(anchors.find((node) => node.props.href === 'https://example.com/ok').props.rel, 'noopener noreferrer')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('关系图工具栏：计数行、弱关系开关、枝干图例与重置/导出', async () => {
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
		const svgOf = () => findAll(tree, (node) => node.props?.className === 'evrLinkGraph')[0]
		const weakEdges = () => findAll(svgOf(), (node) => typeof node.props?.className === 'string'
			&& node.props.className.split(' ').includes('evrLinkEdgeWeak'))
		const nodesOf = () => findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.split(' ').includes('evrLinkNode')).length

		// 计数行：库里有 7 张卡、1 条显式关系、1 条弱关系，画了 4 个节点，3 张没入图。
		const stat = findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.split(' ').includes('evrLinkStat')
			&& textOf(node).includes('overview.linkGraph.cards'))
		assert.equal(stat.length, 1, '计数行没有渲染')
		const statText = textOf(stat[0])
		for (const key of ['overview.linkGraph.cards', 'overview.linkGraph.explicit', 'overview.linkGraph.weak', 'overview.linkGraph.shown', 'overview.linkGraph.hidden']) {
			assert.ok(statText.includes(key), `计数行缺少 ${key}`)
		}

		// 显式关系保留箭头，弱关系是虚线且没有方向。
		const linkEdge = findAll(svgOf(), (node) => node.props?.className === 'evrLinkEdge')[0]
		assert.equal(linkEdge.props.markerEnd, 'url(#evrLinkArrow)')
		assert.equal(weakEdges()[0].props.markerEnd, undefined)

		// 弱关系默认显示；关掉后只剩显式关系。
		assert.equal(weakEdges().length, 1)
		const weakToggle = findAll(tree, (node) => node.type === 'button' && textOf(node) === 'overview.linkGraph.weakToggle')[0]
		assert.equal(weakToggle.props['aria-pressed'], true)
		weakToggle.props.onClick()
		tree = await runtime.settle(render)
		assert.equal(weakEdges().length, 0, '关掉弱关系后不应再画 tag/branch 边')
		findAll(tree, (node) => node.type === 'button' && textOf(node) === 'overview.linkGraph.weakToggle')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(weakEdges().length, 1, '再打开弱关系要恢复')

		// 六个枝干图例按钮，默认都可见；点掉践行后它的节点不再绘制。
		const legend = findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.split(' ').includes('evrLinkLegendBtn'))
		assert.equal(legend.length, 6)
		assert.equal(nodesOf(), 4)
		const execution = findAll(tree, (node) => node.type === 'button' && node.props?.title === 'cards.filter.execution')[0]
		assert.equal(execution.props['aria-pressed'], true)
		execution.props.onClick()
		tree = await runtime.settle(render)
		assert.equal(nodesOf(), 3, '隐藏枝干后节点不再绘制')
		assert.equal(findAll(tree, (node) => node.type === 'button' && node.props?.title === 'cards.filter.execution')[0].props['aria-pressed'], false)

		// 重置视角与导出按钮都在；没有 canvas 的测试环境里导出只能静默。
		assert.equal(findAll(tree, (node) => node.type === 'button' && textOf(node) === 'overview.linkGraph.reset').length, 1)
		const exportButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === 'overview.linkGraph.export')
		assert.equal(exportButton.length, 1)
		exportButton[0].props.onClick()
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('关系图搜索：命中与 1 跳邻居高亮、命中显示标签、点结果聚焦并可重置', async () => {
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
		const svgOf = () => findAll(tree, (node) => node.props?.className === 'evrLinkGraph')[0]
		const groupOf = (prefix) => findAll(svgOf(), (node) => node.type === 'g'
			&& typeof node.props?.['aria-label'] === 'string' && node.props['aria-label'].startsWith(prefix))[0]
		const labelTexts = () => findAll(tree, (node) => node.type === 'text'
			&& typeof node.props?.className === 'string' && node.props.className.split(' ').includes('evrLinkLabel'))
			.map((node) => textOf(node))
		const cameraScale = () => {
			const group = findAll(svgOf(), (node) => node.type === 'g'
				&& typeof node.props?.style?.transform === 'string' && node.props.style.transform.includes('scale('))[0]
			return Number(/scale\(([\d.]+)\)/.exec(group.props.style.transform)[1])
		}
		assert.equal(cameraScale(), 1)
		assert.ok(labelTexts().includes('卡片标题'), '默认标签里有排在前面的卡片')

		const input = findAll(tree, (node) => node.type === 'input' && node.props?.type === 'search'
			&& typeof node.props?.className === 'string' && node.props.className.includes('evrLinkSearch'))[0]
		assert.ok(input !== undefined, '关系图没有搜索框')
		input.props.onChange({ target: { value: '孤岛' } })
		tree = await runtime.settle(render)

		assert.equal(groupOf('孤岛卡片').props.opacity, 1, '命中节点保持高亮')
		assert.equal(groupOf('卡片标题').props.opacity, 0.16, '非命中节点淡化')
		assert.ok(labelTexts().includes('孤岛卡片'), '命中卡片显示标签')
		assert.equal(labelTexts().includes('卡片标题'), false, '非命中卡片不显示标签')

		const results = findAll(tree, (node) => node.type === 'button' && node.props?.className === 'evrLinkResult')
		assert.equal(results.length, 1, '搜索结果列表应有一条')
		results[0].props.onClick()
		tree = await runtime.settle(render)
		assert.ok(cameraScale() > 1, '点搜索结果后相机放大到该节点')
		// The camera centres the card: screen position = scale * node + translate
		// lands on the middle of the 320x300 viewBox.
		const camera = findAll(svgOf(), (node) => node.type === 'g'
			&& typeof node.props?.style?.transform === 'string' && node.props.style.transform.includes('scale('))[0]
		const [, tx, ty, scale] = /translate\(([-\d.]+)px,([-\d.]+)px\) scale\(([\d.]+)\)/.exec(camera.props.style.transform)
		const circle = findAll(groupOf('孤岛卡片'), (node) => node.type === 'circle')[0]
		assert.ok(Math.abs(Number(tx) + circle.props.cx * Number(scale) - 160) < 1, '聚焦后卡片应水平居中')
		assert.ok(Math.abs(Number(ty) + circle.props.cy * Number(scale) - 150) < 1, '聚焦后卡片应垂直居中')

		findAll(tree, (node) => node.type === 'button' && textOf(node) === 'overview.linkGraph.reset')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(cameraScale(), 1, '重置视角回到全图')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('关系图写入活动：近 2 小时写过的卡片带金色环，状态行分开写/读', async () => {
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
		if (endpoint === 'graph') {
			// The fixture cards were written days ago; make one freshly written so
			// the write window has something to mark.
			body.nodes[1].updated = new Date(Date.now() - 20 * 60 * 1000).toISOString()
		}
		return { ok: true, status: 200, json: async () => body }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		const tree = await runtime.settle(render)
		const freshOf = () => findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.split(' ').includes('evrLinkNodeFresh'))
		const activityOf = () => findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.split(' ').includes('evrLinkActivity'))
		assert.equal(freshOf().length, 1, '近 2 小时写过的卡片要有金色环')
		assert.ok(freshOf()[0].props['aria-label'].startsWith('被引用的卡片'), '金色环应挂在刚写过的卡片上')
		assert.equal(activityOf().length, 1, '顶部要显示活动状态行')
		const status = textOf(activityOf()[0])
		assert.ok(status.includes('overview.linkGraph.activityWrite'), '状态行要报告最近写入数')
		assert.ok(status.includes('overview.linkGraph.activity'), '状态行要报告最近读取数')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('关系图活动高亮：近 12 小时读过的卡片带环，缺数据时不显示', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	let withActivity = true
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		const body = apiPayload(endpoint, payload)
		if (endpoint === 'graph' && !withActivity) {
			for (const node of body.nodes) {
				delete node.lastReadAt
				delete node.readCount
			}
		}
		return { ok: true, status: 200, json: async () => body }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		const recentOf = () => findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.split(' ').includes('evrLinkNodeRecent'))
		const activityOf = () => findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.split(' ').includes('evrLinkActivity'))
		assert.equal(recentOf().length, 1, '最近读过的卡片要有活动环')
		assert.ok(recentOf()[0].props['aria-label'].startsWith('卡片标题'), '活动环应挂在最近读过的卡片上')
		assert.equal(activityOf().length, 1, '顶部要显示最近读取数')
		assert.ok(textOf(activityOf()[0]).includes('overview.linkGraph.activity'))

		// 数据缺省时不显示活动环，也不显示状态行。
		withActivity = false
		findAll(tree, (node) => node.type === 'button' && textOf(node) === 'action.refresh')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(recentOf().length, 0)
		assert.equal(activityOf().length, 0)
	} finally {
		globalThis.fetch = previousFetch
	}
})
