import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { SessionLedger, digestSessions, probeSessions, readSessionExcerpt } from '../src/sessions.js'

const NOW = Date.parse('2026-11-10T12:00:00Z')

test('会话摘录围绕引文取窗口：只含人说的话，密钥被抹掉', async () => {
	const events = [
		user(1, '前面先聊了一些无关的事，比如说天气不错，适合出门走走，顺便把服务器装一下。'),
		{ type: 'assistant/message', seq: 2, time: NOW - 30_000, data: { message: { content: [{ type: 'text', text: '好的，我来处理。' }] } } },
		user(3, '部署用 SSH，不要用 HTTPS，密钥是 sk-abcdefghijklmnopqrstuvwx。'),
		user(4, '这条跑题了，不应该出现在摘录里。', NOW - 10_000),
	]
	const query = {
		async readSession() {
			return { events }
		},
	}
	const excerpt = await readSessionExcerpt({ query, id: 's1', quote: '部署用 SSH，不要用 HTTPS', maxChars: 120 })
	assert.match(excerpt, /部署用 SSH/)
	assert.equal(excerpt.includes('sk-abcdefghijklmnopqrstuvwx'), false, '密钥必须被抹掉')
	assert.ok(excerpt.length <= 120)

	// 引文找不到时退回首段，仍然是截断的。
	const head = await readSessionExcerpt({ query, id: 's1', quote: '不存在的句子', maxChars: 200 })
	assert.ok(head.length <= 200)
	// 宿主没有读取能力或会话不存在时返回 null，不抛。
	assert.equal(await readSessionExcerpt({ query: undefined, id: 's1' }), null)
	assert.equal(await readSessionExcerpt({ query: { async readSession() { return undefined } }, id: 's1' }), null)
})


/**
 * Build a user event.
 *
 * @param {number} seq - Sequence number.
 * @param {string} text - The message.
 * @param {number} [time] - Event time.
 * @returns {object} The event.
 */
function user(seq, text, time = NOW - 60_000) {
	return { type: 'user/message', seq, time, data: { role: 'user', content: [{ type: 'text', text }] } }
}

/**
 * Build an assistant event.
 *
 * @param {number} seq - Sequence number.
 * @param {string} text - The message.
 * @returns {object} The event.
 */
function assistant(seq, text) {
	return {
		type: 'assistant/message',
		seq,
		time: NOW - 30_000,
		data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [] },
	}
}

/**
 * A `sessionQuery` fake over a fixed event map.
 *
 * @param {Record<string, object[]>} eventsById - Events per session.
 * @param {Array<object>} records - Session records.
 * @returns {object} The query service.
 */
function fakeQuery(eventsById, records) {
	return {
		async listSessions() {
			return records
		},
		async listEvents(id) {
			return (eventsById[id] ?? []).map((event) => ({ seq: event.seq, type: event.type, time: event.time }))
		},
		async readSession(id) {
			return { events: eventsById[id] ?? [] }
		},
		async readTitle(id) {
			return { title: `title-${id}` }
		},
	}
}

/**
 * The default two-session corpus.
 *
 * @returns {object} The query and events.
 */
function corpus() {
	const events = {
		s1: [
			user(1, '记住：部署要用 SSH，不要 HTTPS。'),
			assistant(2, '明白，我记下这条。'),
			{ type: 'tool/result', seq: 3, time: NOW - 20_000, data: {} },
			user(4, '另外 API key 是 sk-abcdefghijklmnopqrstuvwx，别存。'),
		],
		s2: [
			user(1, '[evolver-ingest] 整理任务'),
			assistant(2, '已处理。'),
		],
	}
	const records = [
		{ header: { id: 's1', createdAt: NOW - 3_600_000, cwd: '/repo' } },
		{ header: { id: 's2', createdAt: NOW - 3_600_000 } },
		{ header: { id: 'sub', createdAt: NOW - 3_600_000, origin: 'subagent' } },
		{ header: { id: 'seeded', createdAt: NOW - 3_600_000, isSeeded: true } },
	]
	return { events, query: fakeQuery(events, records) }
}

test('摘录只保留用户与助手文本，并抹掉密钥', async () => {
	const { query } = corpus()
	const dir = await mkdtemp(join(tmpdir(), 'evr-ledger-'))
	try {
		const result = await digestSessions({ query, ledger: new SessionLedger({ dataDir: dir }), now: NOW })
		assert.equal(result.sessions.length, 1)
		const session = result.sessions[0]
		assert.equal(session.id, 's1')
		assert.equal(session.title, 'title-s1')
		assert.equal(session.cwd, '/repo')
		assert.deepEqual(session.messages.map((message) => message.role), ['user', 'assistant', 'user'])
		assert.match(session.messages[0].text, /SSH/)
		assert.match(session.messages[2].text, /\[REDACTED\]/)
		assert.equal(JSON.stringify(result).includes('sk-abcdefghijklmnopqrstuvwx'), false)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('摘录是只读的：游标只由调用方显式 commit 推进', async () => {
	const { query, events } = corpus()
	const dir = await mkdtemp(join(tmpdir(), 'evr-ledger-'))
	try {
		const ledger = new SessionLedger({ dataDir: dir })
		const first = await digestSessions({ query, ledger, now: NOW })
		// 未提交：摘录不推进游标，重复读还是同一批会话（手动读取不会吞掉会话）。
		assert.deepEqual(await digestSessions({ query, ledger, now: NOW }).then((r) => r.sessions.map((s) => s.id)), ['s1'])
		assert.deepEqual(first.empty.map((entry) => entry.id), ['s2'])
		await ledger.commit([
			...first.sessions.map((session) => ({ id: session.id, seq: session.through })),
			...first.empty,
		], new Date(NOW).toISOString())
		const after = await digestSessions({ query, ledger, now: NOW })
		assert.equal(after.sessions.length, 0)

		events.s1.push(user(5, '补充：端口 22 正常。', NOW - 10_000))
		const next = await digestSessions({ query, ledger, now: NOW + 60_000 })
		assert.equal(next.sessions.length, 1)
		assert.deepEqual(next.sessions[0].messages.map((message) => message.text), ['补充：端口 22 正常。'])
		assert.equal(next.sessions[0].through, 5)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('probe 只数有新增事件的会话；未提交时仍算 pending', async () => {
	const { query } = corpus()
	const dir = await mkdtemp(join(tmpdir(), 'evr-ledger-'))
	try {
		const ledger = new SessionLedger({ dataDir: dir })
		const probe = await probeSessions({ query, ledger, now: NOW })
		assert.equal(probe.pending, 2)
		const digest = await digestSessions({ query, ledger, now: NOW })
		// 只读摘录不推进游标：probe 仍然看到这两个会话，不会静默丢。
		assert.equal((await probeSessions({ query, ledger, now: NOW })).pending, 2)
		await ledger.commit([
			...digest.sessions.map((session) => ({ id: session.id, seq: session.through })),
			...digest.empty,
		], new Date(NOW).toISOString())
		const after = await probeSessions({ query, ledger, now: NOW })
		assert.equal(after.pending, 0)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('游标文件损坏时从头开始，写盘后可重新读取', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-ledger-'))
	try {
		const path = join(dir, 'sight', 'sessions.json')
		await mkdir(join(dir, 'sight'), { recursive: true })
		await writeFile(path, '{broken', 'utf8')
		const ledger = new SessionLedger({ dataDir: dir })
		assert.equal(await ledger.through('s1'), -1)
		await ledger.commit([{ id: 's1', seq: 7 }], '2026-11-10T00:00:00Z')
		const raw = JSON.parse(await readFile(path, 'utf8'))
		assert.equal(raw.sessions.s1.lastSeq, 7)
		assert.equal((await new SessionLedger({ dataDir: dir }).through('s1')), 7)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('运行时上下文等合成 user 消息不会进入摘录，空会话会被标记已处理', async () => {
	const events = {
		s1: [
			{
				type: 'user/message',
				seq: 1,
				time: NOW,
				data: {
					source: { kind: 'runtime-context' },
					content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier ones.' }],
				},
			},
			assistant(2, '收到。'),
		],
	}
	const query = fakeQuery(events, [{ header: { id: 's1', createdAt: NOW - 3_600_000 } }])
	const dir = await mkdtemp(join(tmpdir(), 'evr-ledger-'))
	try {
		const ledger = new SessionLedger({ dataDir: dir })
		const digest = await digestSessions({ query, ledger, now: NOW })
		assert.equal(digest.sessions.length, 0)
		assert.deepEqual(digest.empty.map((entry) => entry.id), ['s1'])
		assert.equal(await ledger.through('s1'), -1, '只读不推进游标')
		await ledger.commit(digest.empty, new Date(NOW).toISOString())
		assert.equal(await ledger.through('s1'), 2)
		const again = await digestSessions({ query, ledger, now: NOW })
		assert.equal(again.sessions.length + again.empty.length, 0)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})


test('两个写者并发提交会话游标不会互相覆盖', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-ledger-'))
	try {
		const path = join(dir, 'sight', 'sessions.json')
		const first = new SessionLedger({ path })
		const second = new SessionLedger({ path })
		await first.load()
		await second.load()
		await first.commit([{ id: 's1', seq: 10 }], '2026-11-10T10:00:00.000Z')
		await second.commit([{ id: 's2', seq: 20 }], '2026-11-10T11:00:00.000Z')
		const reader = new SessionLedger({ path })
		assert.equal(await reader.through('s1'), 10, '先写者的游标不能被后写者抹掉')
		assert.equal(await reader.through('s2'), 20)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})


test('大会话摘录在引文窗口处提前停止，不物化整段会话', async () => {
	const events = [
		user(1, '部署用 SSH，不要用 HTTPS。'),
		assistant(2, '明白。'),
	]
	// 引文之后再有 2 万条消息与一个远在末尾的标记；摘录不应读到它们。
	for (let seq = 3; seq < 20_003; seq += 1) {
		events.push(seq % 2 === 1 ? user(seq, `后续废话 ${seq} `.repeat(20)) : assistant(seq, `后续回复 ${seq} `.repeat(20)))
	}
	const query = {
		async readSession() {
			return { events }
		},
	}
	const excerpt = await readSessionExcerpt({ query, id: 's1', quote: '部署用 SSH，不要用 HTTPS', maxChars: 600 })
	assert.match(excerpt, /部署用 SSH/)
	assert.ok(excerpt.length <= 600, '返回值不超过预算')
	assert.equal(excerpt.includes('后续废话 20000'), false, '窗口之后的正文不会被读进来')
})


test('早停不影响找不到引文时的退回首段', async () => {
	const events = []
	for (let seq = 1; seq < 2_000; seq += 1) events.push(user(seq, `第 ${seq} 条普通消息`))
	const query = { async readSession() { return { events } } }
	const head = await readSessionExcerpt({ query, id: 's1', quote: '根本不存在的引文', maxChars: 200 })
	assert.ok(head.length <= 200)
	assert.match(head, /第 1 条普通消息/)
})

test('超大会话不触发参数上限：13 万事件仍能把游标算到最后一条', async () => {
	const huge = [user(1, '[evolver-ingest] 整理任务')]
	for (let seq = 2; seq <= 130_000; seq += 1) {
		huge.push({ type: 'tool/result', seq, time: NOW - 60_000, data: {} })
	}
	const events = { huge }
	const query = fakeQuery(events, [{ header: { id: 'huge', createdAt: NOW - 3_600_000 } }])
	const dir = await mkdtemp(join(tmpdir(), 'evr-ledger-'))
	try {
		const result = await digestSessions({ query, ledger: new SessionLedger({ dataDir: dir }), now: NOW })
		assert.equal(result.empty.length, 1)
		assert.equal(result.empty[0].id, 'huge')
		assert.equal(result.empty[0].seq, 130_000, '游标要落在最后一条事件，而不是栈溢出')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('并发提交会话游标不会撞临时文件名', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-ledger-'))
	try {
		const ledger = new SessionLedger({ dataDir: dir })
		const results = await Promise.allSettled([
			ledger.commit([{ id: 's1', seq: 3 }], new Date(NOW).toISOString()),
			ledger.commit([{ id: 's2', seq: 5 }], new Date(NOW).toISOString()),
			ledger.commit([{ id: 's3', seq: 7 }], new Date(NOW).toISOString()),
		])
		assert.deepEqual(results.filter((result) => result.status === 'rejected'), [])
		const snapshot = await new SessionLedger({ dataDir: dir }).snapshot()
		assert.ok(snapshot.processed >= 1)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
