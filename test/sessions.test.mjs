import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { SessionLedger, digestSessions, probeSessions } from '../src/sessions.js'

const NOW = Date.parse('2026-11-10T12:00:00Z')

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

test('commit 后只读新增事件，整理任务自己不会被摘录', async () => {
	const { query, events } = corpus()
	const dir = await mkdtemp(join(tmpdir(), 'evr-ledger-'))
	try {
		const ledger = new SessionLedger({ dataDir: dir })
		const first = await digestSessions({ query, ledger, commit: true, now: NOW })
		assert.deepEqual(first.committed, ['s1', 's2'])
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

test('probe 只数有新增事件的会话', async () => {
	const { query } = corpus()
	const dir = await mkdtemp(join(tmpdir(), 'evr-ledger-'))
	try {
		const ledger = new SessionLedger({ dataDir: dir })
		const probe = await probeSessions({ query, ledger, now: NOW })
		assert.equal(probe.pending, 2)
		await digestSessions({ query, ledger, commit: true, now: NOW })
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
		await digestSessions({ query, ledger, commit: true, now: NOW })
		assert.equal(await ledger.through('s1'), 2)
		const again = await digestSessions({ query, ledger, now: NOW })
		assert.equal(again.sessions.length + again.empty.length, 0)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
