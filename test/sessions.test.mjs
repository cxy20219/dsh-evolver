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

import { listSessions } from '../src/sessions.js'

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
