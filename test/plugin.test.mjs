import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { API_PREFIX, apply } from '../index.js'

/**
 * A Host context with just enough of the real services.
 *
 * @returns {object} The fake context and what was registered on it.
 */
function fakeContext() {
	const routes = new Map()
	const tools = []
	const sections = []
	const effects = []
	const ctx = {
		logger: { info() {}, warn() {} },
		tools: {
			register(tool) {
				tools.push(tool)
				return () => {}
			},
		},
		systemPrompt: {
			section(section) {
				sections.push(section)
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
		effect(effect, label) {
			effects.push({ effect, label })
			return () => {}
		},
	}
	return { ctx, routes, tools, sections, effects }
}

/**
 * Call one registered endpoint the way the browser would.
 *
 * @param {Map<string, object>} routes - The registered routes.
 * @param {string} endpoint - The endpoint name.
 * @param {object} payload - The request payload.
 * @param {Record<string, string>} [headers] - Extra headers.
 * @returns {Promise<Response>} The response.
 */
function post(routes, endpoint, payload, headers = {}) {
	const path = `${API_PREFIX}/${endpoint}`
	const route = routes.get(path)
	assert.ok(route !== undefined, `接口没有注册：${path}`)
	return route.fetch(new Request(`http://127.0.0.1${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(payload),
	}))
}

/**
 * Run one test with a temporary DSH home.
 *
 * @param {(home: string) => Promise<void>} run - The test body.
 * @returns {Promise<void>} Resolves when the body and cleanup finished.
 */
async function withHome(run) {
	const home = await mkdtemp(join(tmpdir(), 'evr-plugin-'))
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

test('apply 注册工具、注入与接口，写操作后注入立刻更新', async () => {
	await withHome(async (home) => {
		const { ctx, routes, tools, sections, effects } = fakeContext()
		await apply(ctx, { dataDir: join(home, 'evolver') })
		try {
			assert.equal(tools.length, 9)
			assert.deepEqual(sections.map((section) => section.name), ['dsh-evolver:practice', 'dsh-evolver:soul'])
			assert.equal(routes.size, 18)
			assert.match(sections[0].text(), /\[实践\]/)

			const overview = await (await post(routes, 'overview', {})).json()
			assert.ok(overview.practice.entries >= 2)
			const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
			assert.equal(overview.version, pkg.version)

			const saved = await (await post(routes, 'practice-write', {
				kind: 'doc',
				name: 'api.md',
				title: '来自接口',
				purpose: '接口写入的条目',
				topic: 'T',
				body: '正文',
			})).json()
			assert.equal(saved.path, 'docs/t/api.md')
			// The prompt section reads the same cache, so it must see the write.
			assert.match(sections[0].text(), /来自接口/)

			const read = await (await post(routes, 'practice-read', { path: 'docs/t/api.md' })).json()
			assert.equal(read.title, '来自接口')

			const query = await (await post(routes, 'practice-query', { query: '来自接口', limit: 'many' })).json()
			assert.equal(query.total, 1)

			const filtered = await (await post(routes, 'practice-query', { query: '来自接口', limit: -3 })).json()
			assert.equal(filtered.total, 1)
		} finally {
			for (const { effect } of effects) {
				await effect()
			}
		}
	})
})

test('接口拒绝超大请求体', async () => {
	await withHome(async (home) => {
		const { ctx, routes, effects } = fakeContext()
		await apply(ctx, { dataDir: join(home, 'evolver') })
		try {
			const response = await post(routes, 'soul', {}, { 'content-length': String(9 * 1024 * 1024) })
			assert.equal(response.status, 413)
			const payload = await response.json()
			assert.match(payload.error.message, /超过/)
		} finally {
			for (const { effect } of effects) await effect()
		}
	})
})

test('dataDir 必须是绝对路径', async () => {
	await withHome(async () => {
		const { ctx } = fakeContext()
		await assert.rejects(() => apply(ctx, { dataDir: 'relative/evolver' }), /绝对路径/)
	})
})
