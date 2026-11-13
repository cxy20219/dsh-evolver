/**
 * The wire between the browser half, the endpoint table and the Host half.
 *
 * Two halves of this plugin ship separately (a Node module and a browser file
 * that the Host serves as-is), so nothing imports the other side: a renamed
 * endpoint, a forgotten switch branch or a response field the panel reads but
 * the Host stopped producing all type-check nowhere. This file pins the three
 * places together.
 *
 * The endpoint part is static on purpose — it reads the sources without
 * importing the browser bundle. The response part runs the real `apply()`
 * against a temporary DSH home, because a hand-written fixture is exactly the
 * thing that drifts.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { API_PREFIX, apply } from '../index.js'
import { ENDPOINTS } from '../src/remote.js'

/** The repository root, from this file. */
const ROOT = new URL('..', import.meta.url)

/**
 * Read one repository file.
 *
 * @param {string} relative - Path from the repository root.
 * @returns {Promise<string>} The text.
 */
function readSource(relative) {
	return readFile(new URL(relative, ROOT), 'utf8')
}

/**
 * The endpoint names the browser half calls.
 *
 * The panel goes through one `call()` wrapper around `callHost()`; both shapes
 * are accepted so a refactor of the indirection does not silently empty the
 * set (an empty set would make the equality below pass for the wrong reason —
 * hence the non-empty assertion).
 *
 * @param {string} source - `client.js` text.
 * @returns {Set<string>} The names.
 */
function clientEndpoints(source) {
	const names = new Set()
	for (const match of source.matchAll(/\bcallHost\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*'([a-z][a-z-]*)'/g)) names.add(match[1])
	for (const match of source.matchAll(/\bcall\s*\(\s*'([a-z][a-z-]*)'/g)) names.add(match[1])
	return names
}

/**
 * A Host context with just enough of the real services to run `apply()`.
 *
 * @returns {{ctx: object, routes: Map<string, object>, effects: object[]}} The fake context.
 */
function fakeContext() {
	const routes = new Map()
	const effects = []
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		tools: {
			register() {
				return () => {}
			},
		},
		systemPrompt: {
			section() {
				return () => {}
			},
			context() {
				return () => {}
			},
		},
		get(name) {
			if (name !== 'connection') return undefined
			return {
				fetch: {
					register(route) {
						routes.set(route.path, route)
						return () => {}
					},
				},
			}
		},
		effect(effect) {
			effects.push(effect)
			return () => {}
		},
		on() {
			return () => {}
		},
	}
	return { ctx, routes, effects }
}

/**
 * Call one registered endpoint the way the browser would.
 *
 * @param {Map<string, object>} routes - The registered routes.
 * @param {string} endpoint - The endpoint name.
 * @param {object} [payload] - The request payload.
 * @returns {Promise<Response>} The response.
 */
function post(routes, endpoint, payload = {}) {
	const path = `${API_PREFIX}/${endpoint}`
	const route = routes.get(path)
	assert.ok(route !== undefined, `接口没有注册：${path}`)
	return route.fetch(new Request(`http://127.0.0.1${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	}))
}

/**
 * Run one test with a temporary DSH home, so the real `~/.dsh` is untouched.
 *
 * @param {(home: string) => Promise<void>} run - The test body.
 * @returns {Promise<void>} Resolves when the body and cleanup finished.
 */
async function withHome(run) {
	const home = await mkdtemp(join(tmpdir(), 'evr-contract-'))
	const previous = process.env.DSH_HOME
	process.env.DSH_HOME = home
	try {
		await run(home)
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previous
		await rm(home, { recursive: true, force: true })
	}
}

/**
 * Tear down the effects `apply()` registered, newest first.
 *
 * @param {object[]} effects - The `ctx.effect` callbacks.
 * @returns {Promise<void>} Resolves when everything is disposed.
 */
async function disposeEffects(effects) {
	for (const effect of [...effects].reverse()) {
		const dispose = await effect()
		if (typeof dispose === 'function') await dispose()
	}
}

test('客户端调用的接口、ENDPOINTS 与 switch 分支三处同集合', async () => {
	const [client, remote] = await Promise.all([readSource('client.js'), readSource('src/remote.js')])
	const called = clientEndpoints(client)
	const listed = new Set([...remote.matchAll(/^\t'([a-z][a-z-]*)',$/gm)].map((match) => match[1]))
	const handled = new Set([...remote.matchAll(/case '([a-z][a-z-]*)'/g)].map((match) => match[1]))

	assert.ok(called.size > 0, '没有从 client.js 里抽到任何接口调用：提取规则失效了，先修本测试')
	assert.deepEqual([...listed].sort(), ENDPOINTS.slice().sort(), 'ENDPOINTS 数组与导出的常量不一致')
	assert.deepEqual([...handled].sort(), [...listed].sort(), 'switch 分支与 ENDPOINTS 不同集合：漏登记一处就是 404 或 unknown-endpoint')
	assert.deepEqual([...called].sort(), [...listed].sort(), 'client 调用的接口与 ENDPOINTS 不同集合')
})

test('客户端读取的 injection / overview 字段在宿主响应里真的存在', async () => {
	await withHome(async (home) => {
		const { ctx, routes, effects } = fakeContext()
		await apply(ctx, { dataDir: join(home, 'evolver') })
		try {
			assert.equal(routes.size, ENDPOINTS.length, '注册的路由数应等于 ENDPOINTS 数')
			for (const endpoint of ENDPOINTS) {
				assert.ok(routes.has(`${API_PREFIX}/${endpoint}`), `接口没有注册：${endpoint}`)
			}

			const client = await readSource('client.js')

			// `injection` in the panel is the response of the `injection` endpoint:
			// `injection.cards.*` and `injection.preferences.*` are read directly.
			const injectionReads = new Set(
				[...client.matchAll(/\binjection\.(cards|preferences)\.([A-Za-z]+)/g)].map((match) => [match[1], match[2]]),
			)
			assert.ok(injectionReads.size > 0, '没有从 client.js 里抽到 injection 字段读取')
			const injection = await (await post(routes, 'injection')).json()
			for (const [group, field] of injectionReads) {
				assert.notEqual(injection?.[group]?.[field], undefined, `injection 响应缺客户端读取的字段：${group}.${field}`)
			}

			// The overview response is read field by field: the stat cards, the
			// heat map, both graphs and the injected-block viewer.
			const overviewReads = new Set(
				[...client.matchAll(/(?<!['"])overview\.(stats|year|activity|tree|injection)\b(?!')/g)].map((match) => match[1]),
			)
			assert.ok(overviewReads.size > 0, '没有从 client.js 里抽到 overview 字段读取')
			const response = await post(routes, 'overview')
			assert.equal(response.status, 200)
			const overview = await response.json()
			for (const field of overviewReads) {
				assert.notEqual(overview?.[field], undefined, `overview 响应缺客户端读取的字段：${field}`)
			}
			for (const stat of ['cards', 'tags', 'days', 'words']) {
				assert.equal(typeof overview.stats?.[stat], 'number', `overview.stats.${stat} 不是数字`)
			}
			for (const block of ['section', 'index']) {
				assert.equal(typeof overview.injection?.[block], 'string', `overview.injection.${block} 不是字符串`)
			}
			assert.ok(Array.isArray(overview.activity), 'overview.activity 不是数组')
			assert.ok(Array.isArray(overview.tree), 'overview.tree 不是数组')
		} finally {
			await disposeEffects(effects)
		}
	})
})

test('locale 的插件展示文案与 package.json 元数据一致，不各写一份', async () => {
	const [manifest, english] = await Promise.all([readSource('package.json'), readSource('locale/en.json')])
	const pkg = JSON.parse(manifest)
	const en = JSON.parse(english)
	assert.equal(typeof en.meta?.title, 'string')
	assert.equal(typeof en.meta?.description, 'string')
	assert.equal(en.meta.description, pkg.description, 'locale/en.json 的 meta.description 应与 package.json description 同一份文案')
})
