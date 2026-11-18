/**
 * The standalone host, exercised over real HTTP.
 *
 * The interesting claims are not "the handler returns JSON" — that is the
 * plugin's test — but the three things only the standalone assembly can get
 * wrong: the service listens where it says, it serves the browser half without
 * handing out files outside its roots, and it closes cleanly enough that the
 * port can be reopened.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { startService } from '../desktop/server.js'

/**
 * Start a service on a throwaway library and always close it.
 *
 * @param {(service: Awaited<ReturnType<typeof startService>>) => Promise<void>} body - The test body.
 * @returns {Promise<void>} Resolves when the body finished and the service closed.
 */
async function withService(body) {
	const dir = await mkdtemp(join(tmpdir(), 'ziyan-desktop-'))
	const service = await startService({ dataDir: dir, port: 0 })
	try {
		assert.notEqual(service.port, 0, '绑定 0 也要回报实际端口')
		await body(service)
	} finally {
		await service.close()
		await rm(dir, { recursive: true, force: true })
	}
}

test('独立服务：监听回环地址，概览端点可用，端口是实际分配的那个', async () => {
	await withService(async (service) => {
		assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+$/)
		const response = await fetch(`${service.url}/api/ziyan/overview`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		})
		assert.equal(response.status, 200)
		const body = await response.json()
		assert.equal(body.version.length > 0, true, '版本从 package.json 读出来')
		assert.equal(body.stats.files, 0, '空库')
	})
})

test('独立服务：写入后能检索到，数据落在 dataDir', async () => {
	await withService(async (service) => {
		const created = await (await fetch(`${service.url}/api/ziyan/file-write`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			// 面板端点是扁平参数：name/description/tags 直接在顶层，
			// 与工具的 meta 嵌套不是同一个契约。
			body: JSON.stringify({
				content: '独立服务验证：紫电协议只在正文里出现。\n',
				name: 'v.md',
				description: '验证独立服务能写能搜',
				tags: ['测试'],
			}),
		})).json()
		assert.match(created.id, /^file-/)

		const found = await (await fetch(`${service.url}/api/ziyan/file-list`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ query: '紫电' }),
		})).json()
		assert.equal(found.total, 1, '正文进索引，独立服务同样生效')
		assert.equal(found.files[0].id, created.id)
	})
})

test('独立服务：浏览器半边可访问，越出根目录的文件拒绝', async () => {
	await withService(async (service) => {
		for (const path of ['/', '/client.js', '/shim.js', '/react.js', '/icon.svg']) {
			const response = await fetch(`${service.url}${path}`)
			assert.equal(response.status, 200, `${path} 应当可访问`)
			await response.arrayBuffer()
		}
		const escaped = await fetch(`${service.url}/..%2f..%2fpackage.json`)
		assert.equal(escaped.ok, false, '路径穿越被拒绝')
		await escaped.arrayBuffer()
	})
})

test('独立服务：未知端点与坏的 JSON 都是 400，不是 500', async () => {
	await withService(async (service) => {
		const unknown = await fetch(`${service.url}/api/ziyan/nope`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		})
		assert.equal(unknown.status, 400)
		assert.match((await unknown.json()).error.message, /未知接口/)

		const bad = await fetch(`${service.url}/api/ziyan/overview`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{not json',
		})
		assert.equal(bad.status, 400)
		assert.match((await bad.json()).error.message, /JSON/)
	})
})

test('独立服务：关闭后端口释放，重复启动不冲突', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ziyan-desktop-'))
	try {
		const first = await startService({ dataDir: dir, port: 0 })
		const port = first.port
		await first.close()
		const second = await startService({ dataDir: dir, port })
		assert.equal(second.port, port, '同一个端口可以重新绑定')
		await second.close()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('独立服务：dataDir 相对路径被拒绝', async () => {
	await assert.rejects(
		() => startService({ dataDir: 'relative/path', port: 0 }),
		/绝对路径/,
	)
})

test('独立服务：删掉索引再启动，库文件仍被扫描出来（等价于同步到另一台设备）', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ziyan-desktop-'))
	try {
		// 第一次：用服务写一个文件，然后关闭。
		const first = await startService({ dataDir: dir, port: 0 })
		const created = await (await fetch(`${first.url}/api/ziyan/file-write`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				content: '另一台设备只拿到文件夹和边车。\n',
				name: 'synced.md',
				description: '同步场景验证：删掉本地索引后仍能重建',
				tags: ['测试'],
			}),
		})).json()
		await first.close()

		// 模拟另一台设备：索引不存在，只有文件与边车。
		await rm(join(dir, 'system', 'ziyan.db'), { force: true })

		const second = await startService({ dataDir: dir, port: 0 })
		try {
			const body = await (await fetch(`${second.url}/api/ziyan/file-list`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ query: '重建' }),
			})).json()
			assert.equal(body.total, 1, '索引从文件夹重建')
			assert.equal(body.files[0].id, created.id)
		} finally {
			await second.close()
		}
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
