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
 * Cut one function out of client.js by matching its braces.
 *
 * @param {string} source - The file text.
 * @param {string} signature - Start of the function declaration.
 * @returns {string} The function source.
 */
function extractFunction(source, signature) {
	const start = source.indexOf(signature)
	if (start < 0) throw new Error(`not found: ${signature}`)
	let depth = 0
	for (let i = source.indexOf('{', start); i < source.length; i += 1) {
		if (source[i] === '{') depth += 1
		if (source[i] === '}') {
			depth -= 1
			if (depth === 0) return source.slice(start, i + 1)
		}
	}
	throw new Error(`unbalanced braces after: ${signature}`)
}

/**
 * Load createLinkSimulation straight out of client.js, the same way the layout
 * tool does: the engine must stay extractable and dependency-free.
 *
 * @returns {Function} The simulation factory.
 */
function linkSimulationFactory() {
	const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
	const body = extractFunction(source, 'function createLinkSimulation(cards, edges) {')
	return new Function('linkColorOf', `${body}; return createLinkSimulation`)(() => '#8a8f98')
}

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
				stats: { cards: 3, tags: 2, days: 10, words: 120 },
				year: { days: 365, notes: 3, words: 120, maxNotes: 2, maxWords: 80, activeDays: 2 },
				activity: [{ date: '2026-11-09', count: 1 }, { date: '2026-11-10', count: 2 }],
				injection: {
					section: '[卡片] 纪律段\n\n[主动性] 协议',
					index: '[卡片索引]\n- card-01HF7YAT00S37S1ZGTH35DPPXW｜示例卡｜连 2',
					snapshot: { at: '2026-11-13T01:43:33.080Z', day: '2026-11-13' },
				},
				tree: [{
					path: '践行', name: '践行', count: 2, direct: 0, children: [{
						path: '践行/工作流', name: '工作流', count: 1, direct: 1, children: [],
					}],
				}],
			}
		case 'logs':
			return {
				entries: [
					{ at: '2026-11-13T08:00:00.000Z', level: 'info', message: 'ingest run started (manual)' },
					{ at: '2026-11-13T08:00:01.000Z', level: 'warn', message: 'ingest run failed (manual): no model' },
				],
				status: { files: [{ name: 'plugin.log', bytes: 120 }], bytes: 120, maxBytes: 262144, keep: 3, dir: '/data/evolver/knowledge/logs' },
			}
		case 'organize-status':
			return {
				model: null,
				current: { provider: 'p1', model: 'm1' },
				providers: [{
					id: 'p1',
					name: 'Prov One',
					models: [
						{ id: 'm1', name: 'Model One', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
						{ id: 'm2', name: 'Model Two', reasoning: null },
					],
				}],
			}
		case 'organize-save':
			return {
				...(apiPayload('organize-status', payload)),
				model: payload.organize?.model ?? null,
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
				cardMaxChars: 1000,
				cardDescriptionMaxChars: 80,
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
		case 'health-status':
			return {
				rows: [{ date: '2026-11-13', cards: 100, fleeting: 20, unfiled: 0, outbound: 40, inbound: 30, islands: 12 }],
				lastRunAt: '2026-11-13T01:00:00.000Z',
				text: '卡片库健康度：即兴积压与链接率\n\n带 #即兴 20%，有出链 40%，孤岛 12 张。',
			}
		case 'card-list':
			return {
				cards: [{
					id: 'card-01HF7YAT00S37S1ZGTH35DPPXW',
					description: '部署为什么走 SSH 而不是面板',
					body: '卡片正文',
					tags: ['践行/验证/浏览器'],
					links: ['card-01HF7YAT00S37S1ZGTH35DPPW2'],
					resources: [],
					updated: '2026-11-10T00:00:00.000Z',
				}, {
					id: 'card-01HF7YAT00S37S1ZGTH35DPPW2',
					description: '被引用的那张卡',
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
		case 'resources-list':
			// 一行一个文件：文件名是主体，卡片是它的上下文。
			return [{
				name: 'run.sh',
				bytes: 1200,
				executable: true,
				path: 'knowledge/resources/card-01HF7YAT00S37S1ZGTH35DPPXW/run.sh',
				referenced: ['card-01HF7YAT00S37S1ZGTH35DPPXW', 'card-01HF7YAT00S37S1ZGTH35DPPW2'],
				card: {
					id: 'card-01HF7YAT00S37S1ZGTH35DPPXW',
					tags: ['践行/工具'],
					description: '跑测试的脚本',
					links: 1,
				},
			}]
		case 'resource-preview':
			return {
				kind: 'text',
				mime: 'text/markdown',
				bytes: 1200,
				name: payload.name ?? 'run.sh',
				text: '# 预览正文\n\n这一段应该出现在预览面板里。',
				truncated: false,
			}
		case 'resource-open':
			return { path: '/data/evolver/knowledge/resources/x/run.sh' }
		case 'card-read':
			return {
				card: {
					id: payload.id,
					description: '部署为什么走 SSH 而不是面板',
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
					id: 'c1', label: '正文首行卡一', description: '卡一', tags: ['践行/工作流'], branch: '践行',
					degree: 2, updated: '2026-11-10T00:00:00.000Z',
				}, {
					id: 'c2', label: '正文首行卡二', description: '卡二', tags: ['践行/工作流'], branch: '践行',
					degree: 1, updated: '2026-11-09T00:00:00.000Z',
				}, {
					id: 'c3', label: '正文首行卡三', description: '卡三', tags: ['践行/验证'], branch: '践行',
					degree: 1, updated: '2026-11-08T00:00:00.000Z',
				}, {
					id: 'c4', label: '正文首行卡四', description: '卡四', tags: ['践行/验证'], branch: '践行',
					degree: 0, updated: '2026-11-07T00:00:00.000Z',
				}, {
					id: 'c5', label: '正文首行卡五', description: '卡五', tags: ['见闻/网络'], branch: '见闻',
					degree: 2, updated: '2026-11-06T00:00:00.000Z',
				}, {
					id: 'c6', label: '正文首行卡六', description: '卡六', tags: ['见闻/网络'], branch: '见闻',
					degree: 1, updated: '2026-11-05T00:00:00.000Z',
				}, {
					id: 'c7', label: '正文首行卡七', description: '卡七', tags: ['见闻/读书'], branch: '见闻',
					degree: 1, updated: '2026-11-04T00:00:00.000Z',
				}, {
					id: 'c8', label: '正文首行卡八', description: '卡八', tags: ['复盘/方法'], branch: '复盘',
					degree: 1, updated: '2026-11-03T00:00:00.000Z',
				}, {
					id: 'c9', label: '正文首行卡九', description: '卡九', tags: ['复盘/方法'], branch: '复盘',
					degree: 1, updated: '2026-11-02T00:00:00.000Z',
				}, {
					id: 'c10', label: '正文首行卡十', description: '卡十', tags: ['复盘/方法'], branch: '复盘',
					degree: 0, updated: '2026-11-01T00:00:00.000Z',
				}],
				edges: [{
					source: 'c1', target: 'c2', kind: 'link', weight: 1, mutual: false,
				}, {
					source: 'c1', target: 'c3', kind: 'link', weight: 1, mutual: false,
				}, {
					source: 'c5', target: 'c6', kind: 'link', weight: 1, mutual: false,
				}, {
					source: 'c5', target: 'c7', kind: 'link', weight: 1, mutual: false,
				}, {
					source: 'c8', target: 'c9', kind: 'link', weight: 1, mutual: false,
				}, {
					source: 'c2', target: 'c3', kind: 'tag', weight: 0.5, mutual: false,
				}, {
					source: 'c3', target: 'c4', kind: 'tag', weight: 0.5, mutual: false,
				}, {
					source: 'c6', target: 'c7', kind: 'tag', weight: 0.5, mutual: false,
				}, {
					source: 'c9', target: 'c10', kind: 'tag', weight: 0.25, mutual: false,
				}],
				totals: { cards: 12, nodes: 10, edges: 9, links: 5, weak: 4, hiddenCards: 2, limit: 300 },
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
		// the explicit links as solid edges and the derived ties as weak ones.
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrLinkGraph').length, 1)
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrLinkEdge').length, 5)
		const graphNodeGroups = () => findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.split(' ').includes('evrLinkNode'))
		assert.equal(graphNodeGroups().length, 10, '孤立卡也要画出来')
		// Nothing is named by default and no region names exist: at rest the
		// drawing carries no text at all, and a name appears only for the card
		// under the pointer and the cards it is related to.
		const graphSvg = findAll(tree, (node) => node.props?.className === 'evrLinkGraph')[0]
		assert.equal(findAll(graphSvg, (node) => node.type === 'text').length, 0, '静止时不该有文字')

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
		assert.deepEqual(cardTitles, ['overview.notes', 'overview.tags', 'overview.days'])
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
		// 卡片没有标题：列表与详情显示的都是描述。
		assert.ok(findAll(tree, (node) => textOf(node) === '部署为什么走 SSH 而不是面板').length >= 1)

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

test('关系图按六大枝干成簇：节点与边分层、没有区域名、同枝干更靠拢', async () => {
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
		const svg = svgOf()
		assert.ok(svg !== undefined, '关系图没有渲染')
		const groups = findAll(svg, (node) => node.type === 'g' && typeof node.props?.['aria-label'] === 'string')
		const groupOf = (label) => groups.find((group) => String(group.props['aria-label']).split(' · ')[0] === label)
		assert.equal(groups.length, 10, '图谱载荷里的每个节点都要画出来')
		const branchOf = { 卡一: '践行', 卡二: '践行', 卡三: '践行', 卡四: '践行', 卡五: '见闻', 卡六: '见闻', 卡七: '见闻', 卡八: '复盘', 卡九: '复盘', 卡十: '复盘' }
		const dots = groups.map((group) => {
			const circle = findAll(group, (node) => node.type === 'circle')[0]
			const [label, degree] = group.props['aria-label'].split(' · ')
			return { label, degree: Number(degree), x: circle.props.cx, y: circle.props.cy, r: circle.props.r, branch: branchOf[label] }
		})
		// 1. Size is degree centrality.
		const byDegree = dots.slice().sort((left, right) => right.degree - left.degree)
		for (let i = 1; i < byDegree.length; i += 1) {
			if (byDegree[i].degree === byDegree[i - 1].degree) {
				assert.equal(byDegree[i].r, byDegree[i - 1].r, '同度数必须同大小')
			} else {
				assert.ok(byDegree[i].r <= byDegree[i - 1].r, `度数低的圆不能更大：${byDegree[i].label}`)
			}
		}
		// 2. No overlaps, and the whole picture stays inside the viewBox.
		for (let i = 0; i < dots.length; i += 1) {
			for (let j = i + 1; j < dots.length; j += 1) {
				const distance = Math.hypot(dots[i].x - dots[j].x, dots[i].y - dots[j].y)
				assert.ok(distance > dots[i].r + dots[j].r, `${dots[i].label} 与 ${dots[j].label} 重叠`)
			}
			assert.ok(dots[i].x - dots[i].r > 0 && dots[i].x + dots[i].r < 360, '节点跑出了画布')
			assert.ok(dots[i].y - dots[i].r > 0 && dots[i].y + dots[i].r < 340, '节点跑出了画布')
		}
		// 3. Community cohesion: a card is closer to its own branch centroid than
		//    to the other branches' centroids (the point of the layout).
		const centroids = {}
		for (const branch of ['践行', '见闻', '复盘']) {
			const members = dots.filter((dot) => dot.branch === branch)
			centroids[branch] = {
				x: members.reduce((sum, dot) => sum + dot.x, 0) / members.length,
				y: members.reduce((sum, dot) => sum + dot.y, 0) / members.length,
			}
		}
		const own = []
		const other = []
		for (const dot of dots) {
			const centre = centroids[dot.branch]
			own.push(Math.hypot(dot.x - centre.x, dot.y - centre.y))
			for (const [branch, otherCentre] of Object.entries(centroids)) {
				if (branch === dot.branch) continue
				other.push(Math.hypot(dot.x - otherCentre.x, dot.y - otherCentre.y))
			}
		}
		const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length
		assert.ok(mean(other) / mean(own) > 1.2, `同枝干没有聚拢：cohesion=${(mean(other) / mean(own)).toFixed(2)}`)
		// 4. Two edge layers: solid stated links with an arrowhead, dashed inferred
		//    ties without one, drawn under the dots.
		const edgesAtRest = () => findAll(svgOf(), (node) => node.type === 'path'
			&& typeof node.props?.className === 'string' && node.props.className.split(' ').includes('evrLinkEdge'))
		const edges = edgesAtRest()
		// 9 条关系里有 2 条弱边的两端都已经有显式链接：显式关系已经说了同一件事，
		// 静止时再画一遍只是噪声。
		assert.equal(edges.length, 7)
		const links = edges.filter((edge) => !edge.props.className.includes('evrLinkEdgeWeak'))
		assert.equal(links.length, 5)
		const weak = edges.filter((edge) => edge.props.className.includes('evrLinkEdgeWeak'))
		assert.equal(weak.length, 2)
		// At rest the picture is quiet: no arrowheads. Hovering a card brings the
		// direction back on its own edges only.
		assert.ok(links.every((edge) => edge.props.markerEnd === undefined), '静止时不应有箭头')
		assert.ok(weak.every((edge) => edge.props.markerEnd === undefined), '弱关系永远没有方向')
		groupOf('卡一').props.onMouseEnter()
		tree = await runtime.settle(render)
		const focusedEdges = findAll(svgOf(), (node) => node.type === 'path'
			&& typeof node.props?.className === 'string' && node.props.className.split(' ').includes('evrLinkEdge'))
		const focusedLinks = focusedEdges.filter((edge) => !edge.props.className.includes('evrLinkEdgeWeak'))
		const focusedWeak = focusedEdges.filter((edge) => edge.props.className.includes('evrLinkEdgeWeak'))
		assert.ok(focusedLinks.some((edge) => edge.props.markerEnd === 'url(#evrLinkArrow)'), '聚焦时要有方向箭头')
		assert.ok(focusedWeak.every((edge) => edge.props.markerEnd === undefined), '弱关系聚焦时也没有方向')
		assert.equal(focusedWeak.length, 4, '聚焦时把静止时省略的弱边一起带回来')
		// 让邻居亮起来的那条关系必须看得见：弱关系在聚焦时补一档可见度，否则
		// 同标签的卡会「凭空发亮」，读者只能看到一片亮着的无关节点。
		assert.equal(
			focusedWeak.filter((edge) => edge.props.className.includes('evrLinkEdgeWeakLit')).length,
			1,
			'只有两端都相关的弱边才提升可见度',
		)
		// 5. Names are on demand: after focusing 卡一 the drawing carries that
		//    card and its two neighbours, and nothing else.
		const drawings = findAll(svgOf(), (node) => node.type === 'text')
		assert.deepEqual(drawings.map((node) => textOf(node)).sort(), ['卡一', '卡三', '卡二'].sort())
		assert.equal(drawings.every((node) => String(node.props?.className ?? '').split(' ').includes('evrLinkLabel')), true, '图里只应有卡片标签')
		const documentOrder = findAll(svgOf(), () => true)
		const currentEdges = findAll(svgOf(), (node) => node.type === 'path'
			&& typeof node.props?.className === 'string' && node.props.className.split(' ').includes('evrLinkEdge'))
		const firstLabel = documentOrder.indexOf(drawings[0])
		const firstEdge = documentOrder.indexOf(currentEdges[0])
		assert.ok(firstLabel > -1 && firstEdge > -1, '文档顺序里找不到对应元素')
		assert.ok(firstLabel > firstEdge, '标签要画在边之上')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('关系图静止时不显示名称；悬停一张卡只显示它和邻居，且互不重叠、不盖节点', async () => {
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
		let svg = findAll(tree, (node) => node.props?.className === 'evrLinkGraph')[0]
		// At rest the picture is dots and lines: no card name, no branch name.
		assert.equal(findAll(svg, (node) => node.type === 'text').length, 0, '默认不该显示任何名称')

		// Hovering 卡一 names it and the two cards its edges lead to, and no one
		// else: the answer is exactly what the pointer asked for.
		const groups = findAll(svg, (node) => node.type === 'g' && typeof node.props?.['aria-label'] === 'string')
		const groupOf = (label) => groups.find((group) => String(group.props['aria-label']).split(' · ')[0] === label)
		groupOf('卡一').props.onMouseEnter()
		tree = await runtime.settle(render)
		svg = findAll(tree, (node) => node.props?.className === 'evrLinkGraph')[0]
		// Neighbour names carry the quiet class as well, so match on the token.
		const labels = findAll(svg, (node) => node.type === 'text'
			&& String(node.props?.className ?? '').split(' ').includes('evrLinkLabel'))
		assert.deepEqual(labels.map((node) => textOf(node)).sort(), ['卡一', '卡三', '卡二'].sort())
		// Label boxes, sized like the client does, must not overlap each other.
		const boxes = labels.map((node) => {
			const text = textOf(node)
			const width = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) >= 0x2e80 ? 9 : 5), 0) + 4
			const top = node.props.y - 8
			const left = node.props.textAnchor === 'start'
				? node.props.x
				: (node.props.textAnchor === 'end' ? node.props.x - width : node.props.x - width / 2)
			return { text, left, top, width, height: 11 }
		})
		for (let i = 0; i < boxes.length; i += 1) {
			for (let j = i + 1; j < boxes.length; j += 1) {
				const apartX = boxes[i].left + boxes[i].width <= boxes[j].left || boxes[j].left + boxes[j].width <= boxes[i].left
				const apartY = boxes[i].top + boxes[i].height <= boxes[j].top || boxes[j].top + boxes[j].height <= boxes[i].top
				assert.ok(apartX || apartY, `标签重叠：${boxes[i].text} / ${boxes[j].text}`)
			}
		}
		// Nor may a label cover a dot: a label is a name, not a lid.
		const dots = findAll(svg, (node) => node.type === 'g' && typeof node.props?.['aria-label'] === 'string')
			.map((group) => {
				const circle = findAll(group, (node) => node.type === 'circle')[0]
				return { x: circle.props.cx, y: circle.props.cy, r: circle.props.r }
			})
		for (const box of boxes) {
			for (const dot of dots) {
				const right = box.left + box.width
				const bottom = box.top + box.height
				const nearestX = Math.min(right, Math.max(box.left, dot.x))
				const nearestY = Math.min(bottom, Math.max(box.top, dot.y))
				// 标签可以贴到圆点自己的 1px 描边上（白色光晕盖得住），但不能盖住圆点。
				assert.ok(Math.hypot(dot.x - nearestX, dot.y - nearestY) >= dot.r - 1 - 0.001,
					`标签 ${box.text} 盖住了节点`)
			}
		}
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('关系图只有图谱本身：悬停高亮 1 跳邻居、缩放与拖拽保留、没有工具栏', async () => {
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
		const groupOf = (label) => findAll(svgOf(), (node) => node.type === 'g'
			&& typeof node.props?.['aria-label'] === 'string' && node.props['aria-label'].startsWith(label))[0]
		// Hovering one card lights it and its 1-hop neighbours and fades the rest.
		assert.equal(groupOf('卡一').props.opacity, 1)
		groupOf('卡一').props.onMouseEnter()
		tree = await runtime.settle(render)
		assert.equal(groupOf('卡一').props.opacity, 1)
		assert.equal(groupOf('卡二').props.opacity, 1, '1 跳邻居要亮着')
		assert.equal(groupOf('卡三').props.opacity, 1)
		assert.equal(groupOf('卡五').props.opacity, 0.16, '非邻居要淡化')
		// Leaving restores the full picture.
		groupOf('卡一').props.onMouseLeave()
		tree = await runtime.settle(render)
		assert.equal(groupOf('卡五').props.opacity, 1)
		// Keyboard: Enter pins the card; a click on the empty canvas lets it go.
		groupOf('卡一').props.onKeyDown({ key: 'Enter', preventDefault() {} })
		tree = await runtime.settle(render)
		assert.match(String(groupOf('卡一').props.className), /evrLinkNodeOn/)
		svgOf().props.onPointerUp({ target: svgOf(), currentTarget: svgOf() })
		tree = await runtime.settle(render)
		assert.equal(String(groupOf('卡一').props.className).includes('evrLinkNodeOn'), false)
		// Pan (pointer handlers) and zoom (native non-passive wheel listener).
		assert.equal(typeof svgOf().props.onPointerDown, 'function')
		assert.equal(typeof svgOf().props.onPointerMove, 'function')
		assert.equal(typeof svgOf().props.onPointerLeave, 'function')
		const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
		assert.ok(source.includes("addEventListener('wheel'"), '滚轮缩放没有挂上')
		// No toolbar, legend, counters, activity row or export/reset controls at
		// all: the pane is the title plus the drawing.
		const pane = findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.includes('evrOverviewTree'))[0]
		assert.ok(pane !== undefined, '找不到图谱所在的概览栏')
		assert.equal(findAll(pane, (node) => node.type === 'input').length, 0, '图谱区不应有输入框')
		assert.equal(findAll(pane, (node) => node.type === 'button').length, 0, '图谱区不应有按钮')
		for (const className of ['evrLinkTools', 'evrLinkLegend', 'evrLinkStat', 'evrLinkResult', 'evrLinkActivity', 'evrLinkPane']) {
			assert.equal(findAll(pane, (node) => typeof node.props?.className === 'string'
				&& node.props.className.includes(className)).length, 0, `图谱区不应有 ${className}`)
		}
		for (const key of ['overview.linkGraph.search', 'overview.linkGraph.weakToggle', 'overview.linkGraph.reset',
			'overview.linkGraph.export', 'overview.linkGraph.cards', 'overview.linkGraph.activity']) {
			assert.equal(findAll(pane, (node) => textOf(node) === key).length, 0, `图谱区不应出现 ${key}`)
		}
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('枝干布局是确定性的：computeLinkLayout 不读时钟也不随机', () => {
	const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
	const start = source.indexOf('function createLinkSimulation(cards, edges) {')
	const end = source.indexOf('function LinkGraph(props) {')
	assert.ok(start > -1 && end > start, '找不到力模拟引擎')
	const body = source.slice(start, end)
	assert.equal(/\bMath\.random\b/.test(body), false, '布局不能使用随机数')
	assert.equal(/\bDate\.now\b/.test(body), false, '布局不能读时钟')
	assert.equal(/\bnew Date\b/.test(body), false, '布局不能读时钟')
})

test('力模拟引擎：种子有限、alpha 单调冷却到静止、同输入两次结算一致', () => {
	const createLinkSimulation = linkSimulationFactory()
	const payload = apiPayload('graph', {})
	const sim = createLinkSimulation(payload.nodes, payload.edges)
	assert.ok(sim !== null, '模拟没有建起来')
	assert.equal(sim.width, 360)
	assert.equal(sim.height, 340)
	assert.equal(sim.nodes.length, 10)
	assert.equal(sim.alpha, 1)
	assert.ok(sim.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y) && node.r > 0),
		'种子坐标必须有限')
	const seeded = sim.nodes.map((node) => [node.x, node.y])
	let previous = sim.alpha
	for (let i = 0; i < 30; i += 1) {
		const alpha = sim.step()
		assert.ok(alpha < previous, 'alpha 必须单调下降')
		previous = alpha
	}
	assert.ok(sim.nodes.some((node, index) => node.x !== seeded[index][0] || node.y !== seeded[index][1]),
		'节点要动起来')
	let guard = 0
	while (sim.alpha >= 0.005 && guard < 500) {
		sim.step()
		guard += 1
	}
	assert.ok(sim.alpha < 0.005, '模拟必须冷却到静止')
	assert.ok(guard < 400, `冷却太慢：${guard} 步`)
	// Reheat is what a drag uses: it pumps a settled simulation back up and can
	// never cool it further.
	sim.reheat(0.5)
	assert.equal(sim.alpha, 0.5)
	// Deterministic settle: two runs of the same fixed cadence land on the same
	// coordinates. This is what makes the static render path assertable.
	const first = createLinkSimulation(payload.nodes, payload.edges)
	const second = createLinkSimulation(payload.nodes, payload.edges)
	for (let i = 0; i < 340; i += 1) {
		first.step(Math.pow(0.99, i))
		second.step(Math.pow(0.99, i))
	}
	const coordinates = (value) => value.nodes.map((node) => [node.id, node.x.toFixed(6), node.y.toFixed(6)]).sort()
	assert.deepEqual(coordinates(first), coordinates(second))
})

test('力模拟引擎：拖住的节点不动，松手后弹簧接管', () => {
	const createLinkSimulation = linkSimulationFactory()
	const payload = apiPayload('graph', {})
	const sim = createLinkSimulation(payload.nodes, payload.edges)
	const node = sim.nodes[0]
	node.fx = 300
	node.fy = 240
	for (let i = 0; i < 30; i += 1) sim.step(0.8)
	assert.equal(node.x, 300, '拖拽中的节点不能被力推动')
	assert.equal(node.y, 240)
	// Release: the pointer is gone, the springs own the dot again.
	node.fx = null
	node.fy = null
	for (let i = 0; i < 30; i += 1) sim.step(0.8)
	assert.ok(Math.hypot(node.x - 300, node.y - 240) > 0.01, '松手后节点要回到力的作用下')
})

test('节点可拖拽：按下不冒泡成平移、移动改坐标、松手结束拖拽', async () => {
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
		const svgOf = () => findAll(tree, (node) => node.props?.className !== undefined
			&& typeof node.props.className === 'string' && node.props.className.split(' ').includes('evrLinkGraph'))[0]
		const groupOf = (label) => findAll(svgOf(), (node) => node.type === 'g'
			&& typeof node.props?.['aria-label'] === 'string' && node.props['aria-label'].startsWith(label))[0]
		const circleOf = (label) => findAll(groupOf(label), (node) => node.type === 'circle')[0]
		const rect = () => ({ left: 0, top: 0, width: 360, height: 340 })
		const cameraTransform = () => {
			const group = findAll(svgOf(), (node) => node.type === 'g'
				&& typeof node.props?.style?.transform === 'string' && node.props.style.transform.includes('scale('))[0]
			return group.props.style.transform
		}
		assert.equal(typeof groupOf('卡一').props.onPointerDown, 'function', '节点缺少拖拽入口')
		const cameraBefore = cameraTransform()
		let stopped = false
		groupOf('卡一').props.onPointerDown({
			clientX: circleOf('卡一').props.cx,
			clientY: circleOf('卡一').props.cy,
			pointerId: 7,
			stopPropagation() { stopped = true },
			preventDefault() {},
		})
		assert.equal(stopped, true, '节点拖拽不能冒泡成背景平移')
		svgOf().props.onPointerMove({ clientX: 180, clientY: 170, pointerId: 7, currentTarget: { getBoundingClientRect: rect } })
		tree = await runtime.settle(render)
		const moved = circleOf('卡一')
		assert.ok(Math.abs(moved.props.cx - 180) < 2, `节点没跟住指针：${moved.props.cx}`)
		assert.ok(Math.abs(moved.props.cy - 170) < 2, `节点没跟住指针：${moved.props.cy}`)
		assert.equal(cameraTransform(), cameraBefore, '拖节点时背景不应平移')
		// Releasing ends the drag; the background drag works again afterwards.
		svgOf().props.onPointerUp({ pointerId: 7, target: {}, currentTarget: {} })
		tree = await runtime.settle(render)
		svgOf().props.onPointerDown({ clientX: 100, clientY: 100, currentTarget: { getBoundingClientRect: rect } })
		svgOf().props.onPointerMove({ clientX: 140, clientY: 100, currentTarget: { getBoundingClientRect: rect } })
		tree = await runtime.settle(render)
		assert.notEqual(cameraTransform(), cameraBefore, '背景拖拽仍然平移')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('浏览器动画路径：首帧是种子，rAF 推进后停住，拖拽能重新唤醒', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	const previousRaf = globalThis.requestAnimationFrame
	const previousCancel = globalThis.cancelAnimationFrame
	const frames = []
	// The real browser has requestAnimationFrame; node does not. Queue the
	// callbacks and drive them by hand so the animated path is covered here too.
	globalThis.requestAnimationFrame = (callback) => {
		frames.push(callback)
		return frames.length
	}
	globalThis.cancelAnimationFrame = () => {}
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
		const svgOf = () => findAll(tree, (node) => node.props?.className !== undefined
			&& typeof node.props.className === 'string' && node.props.className.split(' ').includes('evrLinkGraph'))[0]
		const groupOf = (label) => findAll(svgOf(), (node) => node.type === 'g'
			&& typeof node.props?.['aria-label'] === 'string' && node.props['aria-label'].startsWith(label))[0]
		const dots = () => findAll(svgOf(), (node) => node.type === 'g' && typeof node.props?.['aria-label'] === 'string')
			.map((group) => {
				const circle = findAll(group, (node) => node.type === 'circle')[0]
				return { label: group.props['aria-label'].split(' · ')[0], x: circle.props.cx, y: circle.props.cy }
			})
		const seeded = dots()
		assert.equal(seeded.length, 10)
		assert.ok(frames.length >= 1, '有 rAF 时动画循环要自己排程')
		let now = 0
		let framesRun = 0
		let guard = 0
		while (frames.length > 0 && guard < 400) {
			const batch = frames.splice(0)
			now += 40
			for (const callback of batch) callback(now)
			tree = await runtime.settle(render)
			framesRun += batch.length
			guard += 1
		}
		assert.ok(framesRun > 10, `动画只跑了 ${framesRun} 帧`)
		assert.equal(frames.length, 0, '冷却到静止后循环应当自己停下')
		const settled = dots()
		assert.ok(settled.some((dot, index) => Math.abs(dot.x - seeded[index].x) > 1 || Math.abs(dot.y - seeded[index].y) > 1),
			'节点要从种子位置开始运动')
		// A drag pumps heat back in, so the settled loop has to restart.
		groupOf('卡一').props.onPointerDown({
			clientX: 100,
			clientY: 100,
			pointerId: 3,
			stopPropagation() {},
			preventDefault() {},
		})
		tree = await runtime.settle(render)
		assert.ok(frames.length >= 1, '拖拽没有唤醒动画循环')
		svgOf().props.onPointerUp({ pointerId: 3, target: {}, currentTarget: {} })
		tree = await runtime.settle(render)
	} finally {
		if (previousRaf === undefined) delete globalThis.requestAnimationFrame
		else globalThis.requestAnimationFrame = previousRaf
		if (previousCancel === undefined) delete globalThis.cancelAnimationFrame
		else globalThis.cancelAnimationFrame = previousCancel
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
					{ id: 'c1', label: '第一张', description: '', tags: ['践行'], branch: '践行', degree: 1, updated: '2026-11-10T00:00:00.000Z' },
					{ id: 'c2', label: '第二张', description: '', tags: ['见闻'], branch: '见闻', degree: 1, updated: '2026-11-09T00:00:00.000Z' },
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
		{ id: 'c1', description: '第一张的说明', body: '正文一', tags: ['践行'], links: [], resources: [], updated: '2026-11-10T00:00:00.000Z' },
		{ id: 'c2', description: '第二张的说明', body: '正文二', tags: ['见闻'], links: [], resources: [], updated: '2026-11-09T00:00:00.000Z' },
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
		assert.deepEqual(titles, ['第二张的说明'], '慢响应覆盖了后点的卡片')
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

test('概览链接图与卡片页筛选解耦，自己按 limit 300 拉整库', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	const all = [
		{ id: 'a1', label: '甲', body: '正文', tags: ['践行'], links: ['a2'], resources: [], updated: '2026-11-10T00:00:00.000Z' },
		{ id: 'a2', label: '乙', body: '正文', tags: ['践行'], links: ['a1'], resources: [], updated: '2026-11-09T00:00:00.000Z' },
		{ id: 'a3', label: '丙', body: '正文', tags: ['见闻'], links: [], resources: [], updated: '2026-11-08T00:00:00.000Z' },
	]
	const graphRequests = []
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		if (endpoint === 'graph') graphRequests.push(payload)
		if (endpoint === 'card-list') {
			// The cards tab filters; the link graph asks for its own payload.
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
		assert.equal(graphNodeCount(), 10)
		assert.equal(graphRequests.length, 1)
		assert.equal(graphRequests[0].limit, 300, '图谱要按整库上限自己拉数据')
		// Narrow the cards tab, then go back: the graph must keep the whole library.
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.cards')[0].props.onClick()
		tree = await runtime.settle(render)
		findAll(tree, (node) => node.type === 'button' && textOf(node) === 'cards.filter.input')[0].props.onClick()
		tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.overview')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(graphNodeCount(), 10, '概览图不能继承卡片页的筛选')
		assert.equal(graphRequests.length, 1, '切页签不应重新请求图谱数据')
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

test('整理页顶部的模型卡片和两个整理器并列，默认跟随聊天', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	const sent = []
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		if (endpoint === 'organize-save') sent.push(payload)
		return { ok: true, status: 200, json: async () => apiPayload(endpoint, payload) }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.organize')[0].props.onClick()
		tree = await runtime.settle(render)

		// 模型卡片在整理页顶部，和两个整理器并列，不在卡片整理里面。
		assert.ok(findAll(tree, (node) => textOf(node) === 'settings.organize.modelTitle').length >= 1, '整理页要有独立的模型卡片')
		const modelSelect = () => findAll(tree, (node) => node.type === 'select'
			&& findAll(node, (child) => child.type === 'option' && textOf(child) === 'settings.organize.modelSession').length === 1)[0]
		assert.ok(modelSelect(), '要有模型选择器')
		assert.equal(modelSelect().props.value, '', '默认跟随聊天')
		assert.ok(findAll(tree, (node) => textOf(node).includes('p1 · m1')).length >= 1, '要显示当前生效的模型')
		// 没选模型就不出现思考强度：档位是模型给的，不能凭空列。
		assert.equal(findAll(tree, (node) => node.type === 'select'
			&& findAll(node, (child) => child.type === 'option' && textOf(child) === 'settings.organize.effortDefault').length === 1).length, 0)

		// 选一个带档位的模型：档位选择器出现，默认「模型默认」。
		modelSelect().props.onChange({ target: { value: 'p1::m1' } })
		tree = await runtime.settle(render)
		const effortSelect = () => findAll(tree, (node) => node.type === 'select'
			&& findAll(node, (child) => child.type === 'option' && textOf(child) === 'settings.organize.effortDefault').length === 1)[0]
		assert.ok(effortSelect(), '选了模型就要能选思考强度')
		assert.deepEqual(findAll(effortSelect(), (node) => node.type === 'option').map((node) => textOf(node)),
			['settings.organize.effortDefault', 'Low', 'High'])

		effortSelect().props.onChange({ target: { value: 'high' } })
		tree = await runtime.settle(render)
		// 模型卡片的「保存」是整理页第一个：它在这一页最上面。
		findAll(tree, (node) => node.type === 'button' && textOf(node) === 'action.save')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(sent.length >= 1, true, '保存要走到 organize-save')
		assert.deepEqual(sent[0].organize.model, { provider: 'p1', model: 'm1', reasoningEffort: 'high' })

		// 换回「跟随聊天」：模型整段变回 null，不残留上一个模型。
		modelSelect().props.onChange({ target: { value: '' } })
		tree = await runtime.settle(render)
		findAll(tree, (node) => node.type === 'button' && textOf(node) === 'action.save')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(sent[sent.length - 1].organize.model, null)
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('日志页在设置右边，倒序列出条目并显示轮转预算', async () => {
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

		// 标签顺序：日志排在设置右边。
		// 概览里的子标签也用 role=tab，只看主标签。
		const tabs = findAll(tree, (node) => node.props?.role === 'tab')
			.map((node) => textOf(node))
			.filter((label) => label.startsWith('tab.'))
		assert.equal(tabs.indexOf('tab.settings') >= 0, true)
		assert.equal(tabs[tabs.indexOf('tab.settings') + 1], 'tab.logs')
		assert.equal(tabs[tabs.length - 1], 'tab.logs', '日志是最后一个标签')

		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.logs')[0].props.onClick()
		tree = await runtime.settle(render)

		// 页标题由顶部的「日志」标签承担；这里只该出现和别的页面同款的子标签。
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrSubTabs').length, 1)
		assert.ok(findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'logs.tab.logs').length >= 1)
		const rows = findAll(tree, (node) => typeof node.props?.className === 'string'
			&& node.props.className.split(' ').includes('evrLogRow'))
		assert.equal(rows.length, 2)
		// 最新的在最上面：先看到失败那次，而不是更早的那次。
		assert.ok(textOf(rows[0]).includes('ingest run failed'))
		assert.ok(textOf(rows[1]).includes('ingest run started'))
		// 级别用词袋里的完整 key，而不是拼接出来的半个 key。
		assert.ok(textOf(rows[0]).includes('logs.levelWarn'))
		assert.ok(textOf(rows[1]).includes('logs.levelInfo'))
		// 轮转预算要写在页面上，否则用户不知道日志会不会涨到撑爆磁盘。
		// （测试里的 t 只回显 key，所以断言文案行本身，不断言插值后的数字。）
		assert.ok(findAll(tree, (node) => textOf(node).includes('logs.hint')).length >= 1)
		assert.ok(findAll(tree, (node) => textOf(node).includes('logs.files')).length >= 1)
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('热力图按最忙的一天分档：忙的日子才变深，不会一律最深', async () => {
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
		const value = apiPayload(endpoint, payload)
		if (endpoint === 'overview') {
			// 同一天里有 1 张、2 张、40 张：绝对阈值会把它们全画成最深的一档。
			return {
				ok: true, status: 200,
				json: async () => ({
					...value,
					activity: [
						{ date: '2026-11-09', count: 1 },
						{ date: '2026-11-10', count: 2 },
						{ date: '2026-11-11', count: 40 },
					],
				}),
			}
		}
		return { ok: true, status: 200, json: async () => value }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const tree = await runtime.settle(() => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root'))
		const grid = findAll(tree, (node) => node.props?.className === 'evrHeatmap')[0]
		const cellsOf = (level) => findAll(grid, (node) => node.props?.className === 'evrHeatCell evrHeat' + level).length
		// 40 张是峰值，1 张和 2 张都属于低档：这就是"不全是最深"的意思。
		assert.equal(cellsOf(4), 1, '峰值那一天是最深的一档')
		assert.equal(cellsOf(1), 2, '清淡的日子留浅色')
		assert.equal(cellsOf(3), 0)
		// 图例要覆盖整条色阶：空 + 四档。
		const legend = findAll(tree, (node) => node.props?.className === 'evrHeatLegend')[0]
		assert.equal(findAll(legend, (node) => typeof node.props?.className === 'string'
			&& node.props.className.split(' ').includes('evrHeatCell')).length, 5)
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('注入预览标出快照时间：看得懂"为什么这里是旧的"，也看得懂没有快照时是实时', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	let withSnapshot = true
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		const value = apiPayload(endpoint, payload)
		if (endpoint === 'overview') {
			return {
				ok: true, status: 200,
				json: async () => ({
					...value,
					injection: {
						...value.injection,
						snapshot: withSnapshot ? { at: '2026-11-13T01:43:33.080Z', day: '2026-11-13' } : null,
					},
				}),
			}
		}
		return { ok: true, status: 200, json: async () => value }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'overview.info')[0].props.onClick()
		tree = await runtime.settle(render)

		// 有快照：写明生成时间，并说明当天不再变。
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.info.snapshot').length >= 1, '要标注快照')

		withSnapshot = false
		findAll(tree, (node) => node.type === 'button' && textOf(node) === 'action.refresh')[0].props.onClick()
		tree = await runtime.settle(render)
		// 没有快照：说明这是实时排序，写卡就变。
		assert.ok(findAll(tree, (node) => textOf(node) === 'overview.info.snapshotLive').length >= 1, '没有快照时要说清楚是实时的')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('资源可以预览：点「预览」拉原文，在浮层里渲染', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	const called = []
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		called.push(endpoint)
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		const value = apiPayload(endpoint, payload)
		return { ok: true, status: 200, json: async () => value }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.resources')[0].props.onClick()
		tree = await runtime.settle(render)

		const button = findAll(tree, (node) => node.type === 'button' && textOf(node) === 'cards.resources.preview')[0]
		assert.ok(button !== undefined, '可预览类型要有「预览」按钮')
		button.props.onClick()
		tree = await runtime.settle(render)

		assert.equal(called.includes('resource-preview'), true, '点预览要拉原文')
		assert.ok(findAll(tree, (node) => node.props?.className === 'evrPreview').length === 1, '要有预览浮层')
		assert.ok(textOf(tree).includes('这一段应该出现在预览面板里'), '要渲染出文件内容')
		// 关闭
		findAll(tree, (node) => node.type === 'button' && textOf(node) === 'cards.resources.close')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(findAll(tree, (node) => node.props?.className === 'evrPreview').length, 0, '能关掉')
	} finally {
		globalThis.fetch = previousFetch
	}
})
test('设置页有「卡片描述上限」，保存时带上这个字段', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	const saved = []
	let settingsView = null
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		if (endpoint === 'settings-save') {
			saved.push(payload)
			settingsView = { ...apiPayload('settings', {}), ...payload }
			return { ok: true, status: 200, json: async () => settingsView }
		}
		const value = apiPayload(endpoint, payload)
		return { ok: true, status: 200, json: async () => value }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.settings')[0].props.onClick()
		tree = await runtime.settle(render)

		// 最内层同时含标题、一个数字输入和一个保存按钮的那块就是它。
		const block = findAll(tree, (node) => textOf(node).includes('settings.cardDescCap')
			&& findAll(node, (child) => child.type === 'button').length === 1
			&& findAll(node, (child) => child.props?.type === 'number').length === 1).pop()
		assert.ok(block !== undefined, '设置页没有卡片描述上限')
		const input = findAll(block, (node) => node.props?.type === 'number')[0]
		assert.equal(input.props.value, 80, '默认 80')
		input.props.onChange({ target: { value: '96' } })
		tree = await runtime.settle(render)
		const again = findAll(tree, (node) => textOf(node).includes('settings.cardDescCap')
			&& findAll(node, (child) => child.type === 'button').length === 1
			&& findAll(node, (child) => child.props?.type === 'number').length === 1).pop()
		findAll(again, (node) => node.type === 'button')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.deepEqual(saved.map((item) => item.cardDescriptionMaxChars), [96], '保存的是这一项')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('日志页有「库健康」子页：读记录的系列，不写卡片', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	const called = []
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		called.push(endpoint)
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		const value = apiPayload(endpoint, payload)
		return { ok: true, status: 200, json: async () => value }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.logs')[0].props.onClick()
		tree = await runtime.settle(render)
		assert.equal(called.includes('health-status'), true, '打开日志页就拉健康序列')

		// 两个子页：插件日志 / 库健康
		const sub = findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'logs.tab.health')
		assert.equal(sub.length, 1, '日志页要有「库健康」子页')
		sub[0].props.onClick()
		tree = await runtime.settle(render)
		assert.ok(findAll(tree, (node) => textOf(node).includes('带 #即兴 20%')).length >= 1, '要显示渲染好的表格')
		assert.ok(findAll(tree, (node) => node.type === 'button' && textOf(node) === 'logs.health.run').length === 1, '有立即记录按钮')
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('「资源」是顶层标签，排在卡片右边：列出全部附件，标出可执行与所属卡片', async () => {
	const runtime = createRuntime()
	const previousFetch = globalThis.fetch
	const called = []
	const cardListPayloads = []
	globalThis.fetch = async (url, options) => {
		const endpoint = String(url).split('/').pop()
		called.push(endpoint)
		let payload = {}
		try {
			payload = JSON.parse(options?.body ?? '{}')
		} catch {
			payload = {}
		}
		if (endpoint === 'card-list') cardListPayloads.push(payload)
		const value = apiPayload(endpoint, payload)
		return { ok: true, status: 200, json: async () => value }
	}
	try {
		const { Panel, ctx } = await loadPanel(runtime)
		const render = () => runtime.renderNode(runtime.createElement(Panel, { ctx, t: (key) => key }), 'root')
		let tree = await runtime.settle(render)
		const tabs = findAll(tree, (node) => node.props?.role === 'tab')
			.map((node) => textOf(node))
			.filter((label) => label.startsWith('tab.'))
		assert.equal(tabs[tabs.indexOf('tab.cards') + 1], 'tab.resources', '资源紧挨在卡片右边')

		findAll(tree, (node) => node.props?.role === 'tab' && textOf(node) === 'tab.resources')[0].props.onClick()
		tree = await runtime.settle(render)

		assert.equal(called.includes('resources-list'), true, '切过去就拉资源列表')
		const text = textOf(tree)
		assert.ok(text.includes('run.sh'), '要列出文件名')
		assert.ok(text.includes('跑测试的脚本'), '要显示所属卡片的描述')
		assert.ok(text.includes('cards.resources.exec'), '可执行附件要标出来')
		assert.ok(text.includes('cards.resources.refs'), '被引用次数要显示')
		assert.ok(text.includes('cards.resources.owner'), '要有「所属卡片」标签')
		assert.ok(text.includes('cards.resources.view'), '要能跳到引用它的卡片列表')
		// 有搜索框，且能过滤。
		const box = findAll(tree, (node) => node.props?.type === 'search')[0]
		assert.ok(box !== undefined, '资源页要有搜索框')
		box.props.onChange({ target: { value: 'run' } })
		tree = await runtime.settle(render)
		assert.ok(textOf(tree).includes('run.sh'), '匹配的文件还在')
		box.props.onChange({ target: { value: 'zzz' } })
		tree = await runtime.settle(render)
		assert.ok(textOf(tree).includes('cards.resources.emptySearch'), '搜不到时给明确空态')
		// 清空搜索，后面还要点按钮。
		findAll(tree, (node) => node.props?.type === 'search')[0].props.onChange({ target: { value: '' } })
		tree = await runtime.settle(render)

		// 点「看引用它的卡片」：切回卡片页，并按附件路径过滤。
		findAll(tree, (node) => node.type === 'button' && textOf(node) === 'cards.resources.view')[0].props.onClick()
		tree = await runtime.settle(render)
		const last = cardListPayloads[cardListPayloads.length - 1]
		assert.equal(last.resourcePath, 'knowledge/resources/card-01HF7YAT00S37S1ZGTH35DPPXW/run.sh')
		assert.ok(textOf(tree).includes('cards.filter.resource'), '卡片页要显示当前过滤条件')
		assert.ok(textOf(tree).includes('cards.filter.resourceClear'), '要能清除')
		// 文件名排在卡片描述前面：资源是这一页的主体。
		assert.ok(text.indexOf('run.sh') < text.indexOf('跑测试的脚本'), '文件名要在所属卡片之前')
	} finally {
		globalThis.fetch = previousFetch
	}
})
