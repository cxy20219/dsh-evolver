import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLogSink } from '../src/logs.js'

/**
 * A sink on a temporary folder.
 *
 * @param {object} [options] - Sink overrides.
 * @returns {Promise<{dir: string, sink: object}>} The fixture.
 */
async function fixture(options = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'evr-logs-'))
	const sink = createLogSink({
		dataDir: () => dir,
		now: () => Date.parse('2026-11-13T08:00:00.000Z'),
		...options,
	})
	return { dir, sink }
}

test('日志按顺序落盘并读回：最新的在最后', async () => {
	const { dir, sink } = await fixture()
	try {
		sink.info('first line')
		sink.warn('second line')
		sink.error('third line')
		await sink.flush()
		const entries = await sink.tail(10)
		assert.deepEqual(entries.map((entry) => entry.level), ['info', 'warn', 'error'])
		assert.deepEqual(entries.map((entry) => entry.message), ['first line', 'second line', 'third line'])
		assert.match(entries[0].at, /^2026-11-13T08:00:00\.000Z$/)
		const status = await sink.status()
		assert.equal(status.files.length, 1)
		assert.ok(status.bytes > 0)
		assert.equal(status.maxBytes, 256 * 1024)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('超过大小时轮转：文件数封顶，最旧的先丢', async () => {
	const { dir, sink } = await fixture({ maxBytes: 240, keep: 2 })
	try {
		for (let index = 0; index < 30; index += 1) sink.info(`line ${index} ${'x'.repeat(40)}`)
		await sink.flush()
		const status = await sink.status()
		assert.ok(status.files.length <= 2, `文件数应封顶在 2，实际 ${status.files.length}`)
		assert.ok(status.bytes <= 240 * 2 + 200, `总字节应受预算约束，实际 ${status.bytes}`)
		const entries = await sink.tail(500)
		assert.ok(entries.length > 0)
		assert.ok(entries.length < 30, '最旧的记录被轮转掉了')
		// 保留下来的必须是最近的：最后一条一定在，第一条一定不在。
		assert.match(entries[entries.length - 1].message, /^line 29 /)
		assert.equal(entries.some((entry) => entry.message.startsWith('line 0 ')), false)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('轮转后跨文件仍是时间顺序，且只给要求的条数', async () => {
	const { dir, sink } = await fixture({ maxBytes: 240, keep: 3 })
	try {
		for (let index = 0; index < 20; index += 1) sink.info(`entry-${index}-${'y'.repeat(40)}`)
		await sink.flush()
		const all = await sink.tail(500)
		// 跨文件拼接后仍按时间顺序：index 单调递增。
		const indexes = all.map((entry) => Number(/^entry-(\d+)-/.exec(entry.message)?.[1]))
		for (let index = 1; index < indexes.length; index += 1) {
			assert.ok(indexes[index] > indexes[index - 1], '跨文件读出的顺序被打乱')
		}
		assert.equal((await sink.tail(3)).length, 3)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('落盘失败不抛给调用方：数据目录为空时静默丢弃', async () => {
	const sink = createLogSink({ dataDir: () => '' })
	sink.info('nowhere to go')
	await sink.flush()
	assert.deepEqual(await sink.tail(10), [])
	assert.deepEqual((await sink.status()).files, [])
	// 一个读不掉的文件也不能让面板崩：目录不存在时就是空列表。
	const missing = createLogSink({ dataDir: () => '/nonexistent-evolver-test' })
	assert.deepEqual(await missing.tail(5), [])
})

test('宿主 logger 被镜像：同一条既进文件也进宿主日志', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-logs-'))
	const seen = []
	const sink = createLogSink({
		dataDir: () => dir,
		forward: { info: (message) => seen.push(['info', message]), warn: (message) => seen.push(['warn', message]) },
	})
	try {
		sink.warn('mirrored')
		await sink.flush()
		assert.deepEqual(seen, [['warn', 'mirrored']])
		assert.equal((await sink.tail(5))[0].message, 'mirrored')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
