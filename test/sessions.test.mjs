/**
 * Reading the host's session logs.
 *
 * The logs are append-only: every append is its own zstd frame, and Node's
 * `zstdDecompressSync` stops after the first one. These tests build a log the
 * same way the host does — one frame per line — so the frame splitting is
 * exercised rather than assumed.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'

import { listSessions, readSessionText } from '../src/sessions.js'

/**
 * Build one session log the way the host appends it: one frame per line.
 *
 * @param {object[]} entries - The log lines.
 * @returns {Buffer} The concatenated frames.
 */
function logOf(entries) {
	return Buffer.concat(entries.map((entry) => zstdCompressSync(Buffer.from(`${JSON.stringify(entry)}\n`))))
}

/**
 * One session folder under a workspace folder.
 *
 * @param {string} root - The sessions root.
 * @param {string} workspace - The encoded workspace folder.
 * @param {string} id - The session id.
 * @param {Buffer} log - The bytes.
 * @returns {Promise<string>} The written path.
 */
async function seed(root, workspace, id, log) {
	const dir = join(root, workspace, id)
	await mkdir(dir, { recursive: true })
	const path = join(dir, 'session.v4.jsonl.zstd')
	await writeFile(path, log)
	return path
}

test('会话摘要：多帧日志拼回来，标题/轮数/时间都对', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ziyan-sessions-'))
	try {
		await seed(root, '--E-AI-work-demo--', 'session-aaa', logOf([
			{ type: 'session', id: 'session-aaa', createdAt: Date.parse('2026-11-01T08:00:00Z'), cwd: 'E:\\AI-work\\demo' },
			{ type: 'user/message', seq: 1, time: Date.parse('2026-11-01T08:01:00Z'), data: { content: [{ type: 'text', text: '第一个问题' }] } },
			{ type: 'assistant/message', seq: 2, time: Date.parse('2026-11-01T08:02:00Z'), data: { message: { role: 'assistant', content: [] } } },
			{ type: 'session/title', seq: 3, time: Date.parse('2026-11-01T08:02:30Z'), data: { title: '演示会话' } },
			{ type: 'user/message', seq: 4, time: Date.parse('2026-11-01T08:03:00Z'), data: { content: [{ type: 'text', text: '第二个问题' }] } },
		]))

		const listing = await listSessions({ root, limit: 10 })
		assert.equal(listing.total, 1)
		assert.equal(listing.sessions.length, 1)
		const [session] = listing.sessions
		assert.equal(session.id, 'session-aaa')
		assert.equal(session.title, '演示会话')
		assert.equal(session.cwd, 'E:\\AI-work\\demo')
		assert.equal(session.prompts, 2)
		assert.equal(session.replies, 1)
		assert.equal(session.createdAt, '2026-11-01T08:00:00.000Z')
		assert.equal(session.updatedAt, '2026-11-01T08:03:00.000Z')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('会话列表：按修改时间倒序，缺日志的目录被跳过', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ziyan-sessions-'))
	try {
		await seed(root, '--E-AI-work-a--', 'session-old', logOf([
			{ type: 'session', id: 'session-old', createdAt: Date.parse('2026-10-01T00:00:00Z') },
			{ type: 'session/title', time: Date.parse('2026-10-01T00:00:01Z'), data: { title: '旧的' } },
		]))
		await seed(root, '--E-AI-work-b--', 'session-new', logOf([
			{ type: 'session', id: 'session-new', createdAt: Date.parse('2026-11-10T00:00:00Z') },
			{ type: 'session/title', time: Date.parse('2026-11-10T00:00:01Z'), data: { title: '新的' } },
		]))
		// A folder with no log at all must not appear.
		await mkdir(join(root, '--E-AI-work-a--', 'session-empty'), { recursive: true })

		const listing = await listSessions({ root, limit: 10 })
		assert.equal(listing.total, 2)
		assert.deepEqual(listing.sessions.map((session) => session.id), ['session-new', 'session-old'])

		const first = await listSessions({ root, limit: 1 })
		assert.equal(first.sessions.length, 1)
		assert.equal(first.sessions[0].id, 'session-new')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('会话全文：只收用户输入与助手文本，注入消息与工具/思考块不收', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ziyan-sessions-'))
	try {
		await seed(root, '--E-AI-work-demo--', 'session-full', logOf([
			{
				type: 'session',
				id: 'session-full',
				createdAt: Date.parse('2026-11-02T08:00:00Z'),
				cwd: 'E:\\AI-work\\demo',
				isSeeded: false,
				delegationDepth: 0,
			},
			{ type: 'session/title', time: Date.parse('2026-11-02T08:00:01Z'), data: { title: '全文测试' } },
			{
				type: 'user/message',
				seq: 1,
				time: Date.parse('2026-11-02T08:01:00Z'),
				data: { content: [{ type: 'text', text: '人打的第一问' }], source: { kind: 'user' } },
			},
			{
				type: 'user/message',
				seq: 2,
				time: Date.parse('2026-11-02T08:01:01Z'),
				data: { content: [{ type: 'text', text: '<system-reminder>注入的上下文</system-reminder>' }], source: { kind: 'runtime-context' } },
			},
			{
				type: 'user/message',
				seq: 3,
				time: Date.parse('2026-11-02T08:01:02Z'),
				data: { content: [{ type: 'text', text: '技能目录' }], source: { kind: 'skill-catalog' } },
			},
			{
				type: 'assistant/message',
				seq: 4,
				time: Date.parse('2026-11-02T08:02:00Z'),
				data: {
					message: {
						role: 'assistant',
						content: [
							{ type: 'reasoning', text: '内心戏不该出现' },
							{ type: 'text', text: '可见回答' },
							{ type: 'tool-call', id: 'call-1', name: 'file_read', arguments: '{}' },
						],
					},
				},
			},
			{
				type: 'user/message',
				seq: 5,
				time: Date.parse('2026-11-02T08:03:00Z'),
				data: { content: [{ type: 'text', text: '人打的第二问' }], source: { kind: 'user' } },
			},
		]))

		const session = await readSessionText({ root, id: 'session-full' })
		assert.ok(session !== undefined)
		assert.equal(session.id, 'session-full')
		assert.equal(session.title, '全文测试')
		assert.equal(session.cwd, 'E:\\AI-work\\demo')
		assert.equal(session.isSeeded, false)
		assert.equal(session.delegationDepth, 0)
		assert.equal(session.truncated, false)
		assert.equal(session.throughSeq, 5)
		assert.deepEqual(session.messages.map((message) => [message.role, message.text]), [
			['user', '人打的第一问'],
			['assistant', '可见回答'],
			['user', '人打的第二问'],
		])
		assert.equal(session.chars, '人打的第一问'.length + '可见回答'.length + '人打的第二问'.length)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('会话全文：条数/字符上限生效并标记截断', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ziyan-sessions-'))
	try {
		const entries = [{ type: 'session', id: 'session-caps', createdAt: Date.parse('2026-11-03T08:00:00Z') }]
		// Each message is long enough that the character cap, not the count cap,
		// is what stops the read.
		for (let index = 0; index < 100; index += 1) {
			entries.push({
				type: 'user/message',
				seq: index + 1,
				time: Date.parse('2026-11-03T08:00:00Z') + index * 1000,
				data: { content: [{ type: 'text', text: `第${index + 1}条` + 'x'.repeat(300) }], source: { kind: 'user' } },
			})
		}
		await seed(root, '--E-AI-work-caps--', 'session-caps', logOf(entries))

		const byCount = await readSessionText({ root, id: 'session-caps', maxMessages: 3 })
		assert.equal(byCount.messages.length, 3)
		assert.equal(byCount.truncated, true)
		assert.match(byCount.messages[0].text, /^第1条/)

		const byChars = await readSessionText({ root, id: 'session-caps', maxChars: 1000 })
		assert.equal(byChars.messages.length, 3)
		assert.equal(byChars.truncated, true)
		assert.ok(byChars.chars <= 1000)

		const clipped = await readSessionText({ root, id: 'session-caps', maxMessages: 1, maxMessageChars: 200 })
		assert.equal(clipped.messages[0].text.length, 201)
		assert.ok(clipped.messages[0].text.endsWith('…'))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('会话全文：不存在的会话返回 undefined，非法 id 拒绝', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ziyan-sessions-'))
	try {
		await seed(root, '--E-AI-work-demo--', 'session-ok', logOf([
			{ type: 'session', id: 'session-ok', createdAt: Date.parse('2026-11-04T08:00:00Z') },
		]))
		assert.equal(await readSessionText({ root, id: 'session-missing' }), undefined)
		await assert.rejects(readSessionText({ root, id: '../escape' }), /不合法/)
		await assert.rejects(readSessionText({ root, id: '' }), /不合法/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
