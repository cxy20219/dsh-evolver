/**
 * The organizer: model selection, job lifecycle, and the guarantees the panel
 * relies on.
 *
 * Every model call here is a fake `llm` service that yields scripted stream
 * chunks, so the suite never reaches a provider and never spends money. The
 * fake speaks the same chunk vocabulary the adapters do (`block-end` carries
 * the assembled block, `finish` carries the reason), which is what the tool
 * loop consumes.
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'

import { createOrganizeSettings } from '../src/organize.js'
import { createOrganizer, MAX_SESSIONS } from '../src/organize-jobs.js'
import { SettingsStore } from '../src/settings.js'
import { FileStore } from '../src/store.js'
import { tempDir } from './helpers.mjs'

const PROVIDER = 'fake-provider'
const MODEL = 'fake-model'

/**
 * One text-only model reply.
 *
 * @param {string} text - The visible answer.
 * @returns {object[]} The chunks.
 */
function textTurn(text) {
	return [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text },
		{ type: 'block-end', index: 0, block: { type: 'text', text } },
		{ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
		{ type: 'finish', reason: { kind: 'stop' } },
	]
}

/**
 * One reply that asks for tool calls.
 *
 * @param {Array<{id: string, name: string, arguments: string}>} calls - The calls.
 * @returns {object[]} The chunks.
 */
function toolTurn(calls) {
	const chunks = []
	for (const [index, call] of calls.entries()) {
		chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
		chunks.push({ type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments })
		chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } })
	}
	chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
	return chunks
}

/**
 * A scripted `llm` service.
 *
 * @param {object[][]} turns - One chunk list per model turn; the last repeats.
 * @returns {object} The fake service with a `calls` log.
 */
function fakeLlm(turns) {
	const calls = []
	let index = 0
	return {
		calls,
		listProviders: async () => [{ id: PROVIDER, name: 'Fake 提供者' }],
		listModels: async () => [{ provider: PROVIDER, id: MODEL, name: 'Fake 模型' }],
		resolveModelInfo: async () => ({
			provider: PROVIDER,
			id: MODEL,
			name: 'Fake 模型',
			reasoning: {
				efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }],
				defaultEffort: 'low',
			},
		}),
		stream(options) {
			// The loop keeps one `messages` array and grows it in place, so the
			// fake snapshots the view each request actually saw.
			calls.push({ ...options, messages: options.messages.map((message) => ({ ...message })) })
			const turn = turns[Math.min(index, turns.length - 1)]
			index += 1
			return (async function* chunks() {
				for (const chunk of turn) yield chunk
			})()
		},
	}
}

/**
 * A temporary library plus settings and a sessions folder.
 *
 * @param {{organize?: object, now?: () => number}} [options] - A saved organize block and a clock.
 * @returns {Promise<object>} The fixture.
 */
async function setup({ organize, now } = {}) {
	const dir = await tempDir()
	const sessionsRoot = await tempDir()
	const store = new FileStore({ dataDir: dir })
	await store.open()
	const settings = new SettingsStore({ dataDir: dir })
	await settings.load()
	if (organize !== undefined) await settings.save({ organize })
	return {
		dir,
		sessionsRoot,
		store,
		settings,
		now: now ?? (() => Date.now()),
		async cleanup() {
			store.close()
			await rm(dir, { recursive: true, force: true })
			await rm(sessionsRoot, { recursive: true, force: true })
		},
	}
}

/**
 * The organizer a test drives.
 *
 * @param {object} fixture - `setup()` output.
 * @param {object} llm - The fake service.
 * @returns {object} The organizer.
 */
function makeOrganizer(fixture, llm) {
	return createOrganizer({
		store: fixture.store,
		settings: fixture.settings,
		llm,
		modelSelection: undefined,
		logs: null,
		root: fixture.dir,
		sessionsRoot: fixture.sessionsRoot,
		now: fixture.now,
	})
}

/**
 * A settable clock, so the automatic schedule can be driven without waiting.
 *
 * @param {number} at - The initial epoch milliseconds.
 * @returns {{now: () => number, set: (value: number) => void}} The clock.
 */
function fakeClock(at) {
	let value = at
	return {
		now: () => value,
		set(next) {
			value = next
		},
	}
}

/**
 * A saved organize block with the two automatic switches configured.
 *
 * @param {{sessions?: object, files?: object}} [auto] - The switch overrides.
 * @returns {object} The settings block.
 */
function autoOrganize({ sessions, files } = {}) {
	return {
		model: { provider: PROVIDER, model: MODEL },
		auto: {
			sessions: { enabled: false, idleMinutes: 30, ...sessions },
			files: { enabled: false, hour: 3, ...files },
		},
	}
}

/**
 * The automatic scheduler's ledger on disk.
 *
 * @param {string} dir - The data directory.
 * @returns {Promise<object>} The parsed ledger.
 */
async function readLedger(dir) {
	return JSON.parse(await readFile(join(dir, 'system', 'organize-ledger.json'), 'utf8'))
}

/**
 * Write one session log the way the host appends it.
 *
 * @param {string} root - The sessions root.
 * @param {string} id - The session id.
 * @param {object[]} entries - The log lines.
 * @returns {Promise<void>} Resolves when written.
 */
async function seedSession(root, id, entries) {
	const folder = join(root, '--E-AI-work-demo--', id)
	await mkdir(folder, { recursive: true })
	const log = Buffer.concat(entries.map((entry) => zstdCompressSync(Buffer.from(`${JSON.stringify(entry)}\n`))))
	await writeFile(join(folder, 'session.v4.jsonl.zstd'), log)
}

/**
 * A minimal user/assistant conversation to summarize.
 *
 * The last event's time is what `listSessions` reports as `updatedAt`, so the
 * scheduler tests pass it explicitly and keep the rest relative to it.
 *
 * @param {string} title - The session title.
 * @param {number} [updatedAt] - When the conversation last changed.
 * @returns {object[]} The log lines.
 */
function sessionLog(title, updatedAt = Date.parse('2026-11-10T08:02:00Z')) {
	return [
		{ type: 'session', id: 'session-organize-1', createdAt: updatedAt - 120_000, isSeeded: false, delegationDepth: 0 },
		{ type: 'session/title', data: { title } },
		{
			type: 'user/message',
			seq: 1,
			time: updatedAt - 60_000,
			data: { content: [{ type: 'text', text: '请把整理链路的结论记住' }], source: { kind: 'user' } },
		},
		{
			type: 'assistant/message',
			seq: 2,
			time: updatedAt,
			data: { message: { role: 'assistant', content: [{ type: 'text', text: '结论：整理作业走工具循环。' }] } },
		},
	]
}

/**
 * Poll until a condition holds.
 *
 * @param {() => boolean} check - The condition.
 * @param {number} [timeoutMs] - How long to wait.
 * @returns {Promise<void>} Resolves when it holds.
 */
async function until(check, timeoutMs = 3_000) {
	const started = Date.now()
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error('等待条件超时')
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

test('模型选择：null 跟随聊天、配置优先、目录含思考强度、失败降级且保留上次好目录', async () => {
	const dir = await tempDir()
	try {
		const settings = new SettingsStore({ dataDir: dir })
		await settings.load()
		let providerCalls = 0
		const llm = {
			listProviders: async () => {
				providerCalls += 1
				return [{ id: 'p1', name: '提供者一' }, { id: 'p2', name: '提供者二' }]
			},
			listModels: async (provider) => [{ provider, id: provider === 'p1' ? 'm1' : 'm2', name: `模型-${provider}` }],
			resolveModelInfo: async (provider, model) => ({
				provider,
				id: model,
				name: model,
				reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'high' },
			}),
		}
		let clock = 0
		const chat = { currentSelection: () => ({ provider: 'p2', model: 'm2', reasoningEffort: 'high' }) }
		const controller = createOrganizeSettings({ settings, llm, modelSelection: chat, now: () => clock })

		let status = await controller.status()
		assert.equal(status.followsChat, true)
		assert.deepEqual(status.current, { provider: 'p2', model: 'm2', reasoningEffort: 'high' })
		assert.equal(status.catalogFailed, false)
		assert.equal(status.providers.length, 2)
		assert.deepEqual(status.providers[0].models[0].reasoning, {
			efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }],
			defaultEffort: 'high',
		})
		assert.equal(providerCalls, 1, '目录首次读取')

		// Within the cache window the catalogue is reused.
		clock = 1_000
		await controller.status()
		assert.equal(providerCalls, 1, '目录走缓存')

		status = await controller.save({ model: { provider: 'p1', model: 'm1' } })
		assert.equal(status.followsChat, false)
		assert.deepEqual(status.current, { provider: 'p1', model: 'm1' })
		const reread = new SettingsStore({ dataDir: dir })
		await reread.load()
		assert.deepEqual(reread.get().organize.model, { provider: 'p1', model: 'm1' })

		// A half-filled selection is not a selection: it degrades to following chat.
		status = await controller.save({ model: { provider: 'p1' } })
		assert.equal(status.followsChat, true)
		status = await controller.save({ model: { provider: 'p1', model: 'm1', reasoningEffort: 'low' } })
		assert.equal(status.current.reasoningEffort, 'low')
		status = await controller.save({ model: null })
		assert.equal(status.followsChat, true)

		// A catalogue failure keeps the last good list instead of emptying the select.
		let broken = false
		let flakyCalls = 0
		const flaky = {
			...llm,
			listProviders: async () => {
				if (broken) throw new Error('目录炸了')
				flakyCalls += 1
				return [{ id: 'p1', name: '提供者一' }]
			},
		}
		clock = 0
		const flakyController = createOrganizeSettings({ settings, llm: flaky, modelSelection: undefined, now: () => clock })
		const good = await flakyController.status()
		assert.equal(good.catalogFailed, false)
		broken = true
		clock += 10 * 60_000
		const bad = await flakyController.status()
		assert.equal(bad.catalogFailed, true)
		assert.equal(bad.providers.length, 1, '失败不覆盖上次好目录')
		assert.equal(flakyCalls, 1)

		// No llm at all: the panel still gets a status and a clear flag.
		const absent = createOrganizeSettings({ settings, llm: undefined, modelSelection: undefined })
		const missing = await absent.status()
		assert.equal(missing.catalogFailed, true)
		assert.deepEqual(missing.providers, [])
		assert.equal(missing.current, null)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('失控模型：一直要工具也不会失败，按步数预算收尾为 done', async () => {
	const fixture = await setup({ organize: { model: { provider: PROVIDER, model: MODEL } } })
	try {
		const llm = fakeLlm([toolTurn([{ id: 'call-loop', name: 'file_index', arguments: '{}' }])])
		const organizer = makeOrganizer(fixture, llm)
		await organizer.start({ kind: 'files' })
		await organizer.waitForIdle()
		const [job] = (await organizer.jobs()).jobs
		assert.equal(job.status, 'done', '预算用尽不是失败')
		assert.equal(job.progress.steps, 12)
		assert.equal(job.progress.toolCalls, 12)
		assert.match(job.log.join('\n'), /步数预算用尽/)
		assert.equal(llm.calls.length, 12)
		// The first request is one user message; the loop grows the history by
		// one assistant + one tool-result pair per turn, never by retries.
		assert.equal(llm.calls[0].messages.length, 1)
		assert.equal(llm.calls[0].messages[0].role, 'user')
	} finally {
		await fixture.cleanup()
	}
})

test('作业生命周期：sessions 走工具循环写文件，计数/落盘/日志尾正确', async () => {
	const fixture = await setup({ organize: { model: { provider: PROVIDER, model: MODEL } } })
	try {
		const sessionId = 'session-organize-1'
		await seedSession(fixture.sessionsRoot, sessionId, sessionLog('整理链路'))
		const llm = fakeLlm([
			toolTurn([{
				id: 'call-1',
				name: 'file_write',
				arguments: JSON.stringify({
					name: '整理链路.md',
					description: '自衍整理作业的链路结论：会话结论如何沉淀成文件。',
					tags: ['测试/整理'],
					content: '结论：整理作业用工具循环。',
				}),
			}]),
			textTurn('已写入 1 个文件。'),
		])
		const organizer = makeOrganizer(fixture, llm)

		const started = await organizer.start({ kind: 'sessions', sessionIds: [sessionId] })
		assert.equal(started.job.status, 'queued')
		assert.equal(started.job.kind, 'sessions')
		assert.deepEqual(started.job.selection, { provider: PROVIDER, model: MODEL })

		await organizer.waitForIdle()
		const listing = await organizer.jobs({ limit: 5 })
		assert.equal(listing.total, 1)
		assert.equal(listing.running, '')
		const [job] = listing.jobs
		assert.equal(job.status, 'done')
		assert.equal(job.phase, '完成')
		assert.equal(job.result.created, 1)
		assert.equal(job.result.updated, 0)
		assert.equal(job.result.archived, 0)
		assert.equal(job.changes.length, 1)
		assert.equal(job.changes[0].op, 'create')
		assert.match(job.changes[0].id, /^file-/)
		assert.equal(job.progress.processed, 1)
		assert.ok(job.progress.steps >= 2)
		assert.equal(job.progress.toolCalls, 1)
		assert.equal(job.message, '已写入 1 个文件。')
		// Logs stay chronological: the newest line is last.
		assert.match(job.log[job.log.length - 1], /作业完成/)

		const first = llm.calls[0]
		assert.equal(first.provider, PROVIDER)
		assert.equal(first.model, MODEL)
		assert.equal(first.sessionId, job.id)
		assert.ok(first.tools.some((tool) => tool.name === 'file_write'))
		assert.ok(!first.tools.some((tool) => tool.name === 'file_remove'))
		assert.ok(!first.tools.some((tool) => tool.name === 'file_merge'), '会话整理不给合并工具')
		assert.match(first.messages[0].content[0].text, /请把整理链路的结论记住/)

		const written = await fixture.store.list({ query: '整理链路' })
		assert.equal(written.total, 1)
		assert.equal(written.files[0].name, '整理链路.md')

		const raw = JSON.parse(await readFile(join(fixture.dir, 'system', 'organize-jobs.json'), 'utf8'))
		assert.equal(raw.version, 1)
		assert.equal(raw.jobs.length, 1)
		assert.equal(raw.jobs[0].status, 'done')
		assert.equal(raw.jobs[0].result.created, 1)

		const status = await organizer.status()
		assert.deepEqual(status.kinds, ['sessions', 'files', 'all'])
		assert.equal(status.limits.maxSessions, MAX_SESSIONS)
		assert.equal(status.job.id, job.id)
		assert.equal(status.followsChat, false)
	} finally {
		await fixture.cleanup()
	}
})

test('dry-run：只给只读工具、不写库、结果计数全零', async () => {
	const fixture = await setup({ organize: { model: { provider: PROVIDER, model: MODEL } } })
	try {
		await fixture.store.create({
			name: '已有.md',
			description: 'dry-run 之前就存在的文件，用来确认库没有被改动。',
			tags: ['测试/整理'],
			content: '原样内容',
		})
		const before = fixture.store.stats().files
		const llm = fakeLlm([
			toolTurn([{ id: 'call-1', name: 'file_index', arguments: '{}' }]),
			textTurn('计划：把孤立文件补上链接。'),
		])
		const organizer = makeOrganizer(fixture, llm)
		await organizer.start({ kind: 'files', dryRun: true })
		await organizer.waitForIdle()
		const [job] = (await organizer.jobs()).jobs
		assert.equal(job.dryRun, true)
		assert.equal(job.status, 'done')
		assert.ok(!llm.calls.some((call) => call.tools.some((tool) => tool.name === 'file_write')))
		assert.deepEqual(llm.calls[0].tools.map((tool) => tool.name).sort(), ['file_index', 'file_query', 'file_read'])
		assert.equal(fixture.store.stats().files, before)
		assert.deepEqual(job.result, { created: 0, updated: 0, merged: 0, archived: 0, removed: 0, retagged: 0, linked: 0 })
		assert.deepEqual(job.changes, [])
		assert.match(job.message, /计划/)
		assert.match(llm.calls[0].messages[0].content[0].text, /预演/)
	} finally {
		await fixture.cleanup()
	}
})

test('kind=all：先会话后文件，同一作业内两阶段各用各的工具面', async () => {
	const fixture = await setup({ organize: { model: { provider: PROVIDER, model: MODEL } } })
	try {
		const sessionId = 'session-organize-1'
		await seedSession(fixture.sessionsRoot, sessionId, sessionLog('全部整理'))
		const llm = fakeLlm([
			toolTurn([{
				id: 'call-session',
				name: 'file_write',
				arguments: JSON.stringify({
					name: '全部整理.md',
					description: '全部整理作业的会话阶段写下的文件，用来验证两阶段顺序。',
					tags: ['测试/整理'],
					content: '会话阶段',
				}),
			}]),
			textTurn('会话阶段完成。'),
			toolTurn([{ id: 'call-files', name: 'file_index', arguments: '{}' }]),
			textTurn('文件阶段完成。'),
		])
		const organizer = makeOrganizer(fixture, llm)
		await organizer.start({ kind: 'all', sessionIds: [sessionId] })
		await organizer.waitForIdle()
		const [job] = (await organizer.jobs()).jobs
		assert.equal(job.kind, 'all')
		assert.equal(job.status, 'done')
		assert.equal(job.progress.processed, 1)
		assert.ok(job.progress.steps >= 4)
		assert.equal(job.result.created, 1)
		assert.match(job.message, /文件阶段完成/)

		// The session phase must not get the library phase's archive/merge tools.
		const sessionTools = llm.calls[0].tools.map((tool) => tool.name).sort()
		assert.deepEqual(sessionTools, ['file_index', 'file_link', 'file_query', 'file_read', 'file_write'])
		const fileTools = llm.calls[2].tools.map((tool) => tool.name)
		assert.ok(fileTools.includes('file_archive'))
		assert.ok(fileTools.includes('file_merge'))
	} finally {
		await fixture.cleanup()
	}
})

test('收尾轮被 max-tokens 截断：保留 done，message 明说截断，不用中间轮文本冒充结论', async () => {
	const fixture = await setup({ organize: { model: { provider: PROVIDER, model: MODEL } } })
	try {
		// One big text file: eight reads in one turn push the tool-result budget
		// over the limit, which is what forces the closing turn.
		const file = await fixture.store.create({
			name: '大文件.md',
			description: '收尾轮截断测试用的大文件，用来把工具结果预算吃满。',
			tags: ['测试/整理'],
			content: 'x'.repeat(8_000),
		})
		const reads = Array.from({ length: 8 }, (_, index) => ({
			id: `read-${index + 1}`,
			name: 'file_read',
			arguments: JSON.stringify({ id: file.id }),
		}))
		const partialChunks = [
			{ type: 'text-delta', index: 0, text: '我先看库的整体结构，然后' },
			{ type: 'finish', reason: { kind: 'max-tokens' } },
		]
		const emptyChunks = [{ type: 'finish', reason: { kind: 'max-tokens' } }]
		const llm = fakeLlm([toolTurn(reads), partialChunks, toolTurn(reads), emptyChunks])
		const organizer = makeOrganizer(fixture, llm)
		const before = fixture.store.stats().files

		// Job 1: truncated closing text. The final answer is incomplete but says so.
		await organizer.start({ kind: 'files', dryRun: true })
		await organizer.waitForIdle()
		const [first] = (await organizer.jobs()).jobs
		assert.equal(first.status, 'done', '预算用尽仍算做完')
		assert.deepEqual(first.result, { created: 0, updated: 0, merged: 0, archived: 0, removed: 0, retagged: 0, linked: 0 })
		assert.deepEqual(first.changes, [])
		assert.match(first.message, /我先看库的整体结构/)
		assert.match(first.message, /截断/)
		assert.match(first.log.join('\n'), /最终总结被 max-tokens 截断/)
		assert.equal(fixture.store.stats().files, before, 'dry-run 不写库')

		// The closing request itself: bigger budget, no tools, sharper instruction.
		const closing = llm.calls[1]
		assert.equal(closing.maxTokens, 8_192)
		assert.deepEqual(closing.tools, undefined)
		assert.match(closing.system, /【收尾】/)
		assert.match(closing.system, /300 字/)
		assert.equal(llm.calls[0].maxTokens, 4_096, '工具轮仍是常规预算')

		// Job 2: truncated with no visible text at all — the message must say the
		// final summary was cut off, not fall back to progress chatter.
		await organizer.start({ kind: 'files', dryRun: true })
		await organizer.waitForIdle()
		const [second] = (await organizer.jobs()).jobs
		assert.equal(second.status, 'done')
		assert.equal(second.message, '模型最终总结被截断，未给出完整结论。')
		assert.equal(llm.calls[3].maxTokens, 8_192)
		assert.deepEqual(llm.calls[3].tools, undefined)
		assert.equal(fixture.store.stats().files, before, '两次 dry-run 都没写库')
	} finally {
		await fixture.cleanup()
	}
})

test('allowRemove 门控：默认不给 file_remove，显式允许且非 dry-run 才给', async () => {
	const fixture = await setup({ organize: { model: { provider: PROVIDER, model: MODEL } } })
	try {
		const replies = () => [toolTurn([{ id: 'call-1', name: 'file_index', arguments: '{}' }]), textTurn('完成。')]

		const plain = fakeLlm(replies())
		const first = makeOrganizer(fixture, plain)
		await first.start({ kind: 'files' })
		await first.waitForIdle()
		const plainTools = plain.calls[0].tools.map((tool) => tool.name)
		assert.ok(plainTools.includes('file_merge'), '整理文件提供合并工具')
		assert.ok(!plainTools.includes('file_remove'), '默认不给物理删除')
		assert.ok(plainTools.includes('file_archive'))

		const allowed = fakeLlm(replies())
		const second = makeOrganizer(fixture, allowed)
		await second.start({ kind: 'files', allowRemove: true })
		await second.waitForIdle()
		assert.ok(allowed.calls[0].tools.some((tool) => tool.name === 'file_remove'))

		const drained = fakeLlm(replies())
		const third = makeOrganizer(fixture, drained)
		await third.start({ kind: 'files', dryRun: true, allowRemove: true })
		await third.waitForIdle()
		assert.ok(!drained.calls[0].tools.some((tool) => tool.name === 'file_remove'), 'dry-run 永不提供删除')
	} finally {
		await fixture.cleanup()
	}
})

test('模型失败：作业 failed、库不受影响、互斥被释放', async () => {
	const fixture = await setup({ organize: { model: { provider: PROVIDER, model: MODEL } } })
	try {
		const existing = await fixture.store.create({
			name: '保留.md',
			description: '失败作业不该动到已有文件，这个文件用来验证库仍然完整。',
			tags: ['测试/整理'],
			content: '保留内容',
		})
		const failing = fakeLlm([textTurn('不会被用到')])
		let calls = 0
		failing.stream = () => {
			calls += 1
			throw new Error('模型炸了')
		}
		const organizer = makeOrganizer(fixture, failing)
		await organizer.start({ kind: 'files' })
		await organizer.waitForIdle()
		let listing = await organizer.jobs()
		assert.equal(listing.jobs[0].status, 'failed')
		assert.match(listing.jobs[0].error, /模型炸了/)
		assert.match(listing.jobs[0].message, /模型炸了/)
		assert.equal(listing.running, '')

		const kept = await fixture.store.read(existing.id)
		assert.equal(kept.text, '保留内容')

		// The exclusivity gate was released: a second job is accepted (and fails again).
		await organizer.start({ kind: 'files' })
		await organizer.waitForIdle()
		listing = await organizer.jobs()
		assert.equal(listing.total, 2)
		assert.equal(listing.jobs[0].status, 'failed')
		assert.equal(calls, 2)
	} finally {
		await fixture.cleanup()
	}
})

test('取消：运行中作业收到取消，状态落为 cancelled，并发开始被拒绝', async () => {
	const fixture = await setup({ organize: { model: { provider: PROVIDER, model: MODEL } } })
	try {
		let announce
		const streaming = new Promise((resolve) => { announce = resolve })
		const calls = []
		const slow = {
			listProviders: async () => [{ id: PROVIDER, name: 'Fake 提供者' }],
			listModels: async () => [{ provider: PROVIDER, id: MODEL, name: 'Fake 模型' }],
			resolveModelInfo: async () => ({ provider: PROVIDER, id: MODEL, name: 'Fake 模型' }),
			stream(options) {
				calls.push(options)
				announce()
				return (async function* chunks() {
					yield { type: 'text-delta', index: 0, text: '思考中' }
					await new Promise((resolve) => {
						if (options.signal.aborted) resolve()
						else options.signal.addEventListener('abort', resolve, { once: true })
					})
					yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: '已取消' } } }
				})()
			},
		}
		const organizer = makeOrganizer(fixture, slow)
		const started = await organizer.start({ kind: 'files' })
		await streaming
		await assert.rejects(organizer.start({ kind: 'files' }), /已有整理作业在运行/)

		const cancelled = await organizer.cancel({ id: started.job.id })
		assert.equal(cancelled.cancelled, true)
		await organizer.waitForIdle()
		const [job] = (await organizer.jobs()).jobs
		assert.equal(job.status, 'cancelled')
		assert.equal(job.message, '已取消。')
		assert.equal(job.error, null)
		assert.ok(calls[0].signal.aborted, '取消信号传给了模型调用')
		assert.match(job.log[job.log.length - 1], /取消/)

		// Nothing to cancel any more.
		assert.deepEqual(await organizer.cancel({}), { cancelled: false, job: null })
	} finally {
		await fixture.cleanup()
	}
})

test('重启恢复：落盘时还在 running/queued 的作业读盘后标为 failed', async () => {
	const dir = await tempDir()
	try {
		await mkdir(join(dir, 'system'), { recursive: true })
		await writeFile(join(dir, 'system', 'organize-jobs.json'), JSON.stringify({
			version: 1,
			jobs: [
				{ id: 'organize-running', kind: 'files', status: 'running', startedAt: '2026-01-02T00:00:00.000Z', progress: {}, result: {}, log: [] },
				{ id: 'organize-old', kind: 'sessions', status: 'done', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', progress: {}, result: { created: 2 }, log: [] },
			],
		}))
		const store = new FileStore({ dataDir: dir })
		await store.open()
		const settings = new SettingsStore({ dataDir: dir })
		await settings.load()
		try {
			const organizer = createOrganizer({
				store,
				settings,
				llm: fakeLlm([textTurn('x')]),
				root: dir,
				sessionsRoot: dir,
			})
			const listing = await organizer.jobs()
			assert.equal(listing.total, 2)
			assert.equal(listing.jobs[0].id, 'organize-running')
			assert.equal(listing.jobs[0].status, 'failed')
			assert.match(listing.jobs[0].error, /宿主重启/)
			assert.equal(listing.jobs[1].status, 'done')
			assert.equal(listing.jobs[1].result.created, 2)
			const raw = JSON.parse(await readFile(join(dir, 'system', 'organize-jobs.json'), 'utf8'))
			assert.equal(raw.jobs[0].status, 'failed')
		} finally {
			store.close()
		}
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('参数校验：类型/会话选择/模型缺失都给出可读中文错误', async () => {
	const fixture = await setup({ organize: { model: { provider: PROVIDER, model: MODEL } } })
	try {
		const organizer = makeOrganizer(fixture, fakeLlm([textTurn('x')]))
		await assert.rejects(organizer.start({ kind: 'bogus' }), /整理类型/)
		// kind=sessions without ids asks the host to pick idle sessions; there
		// are none in this empty sessions folder.
		await assert.rejects(organizer.start({ kind: 'sessions' }), /没有待整理的会话/)
		// kind=all has no auto-selection: the caller must name the sessions.
		await assert.rejects(organizer.start({ kind: 'all' }), /至少选择 1 个会话/)
		await assert.rejects(organizer.start({ kind: 'sessions', sessionIds: Array.from({ length: MAX_SESSIONS + 1 }, (_, index) => `session-${index}`) }), /一次最多整理/)
	} finally {
		await fixture.cleanup()
	}

	const bare = await setup()
	try {
		const noModel = makeOrganizer(bare, fakeLlm([textTurn('x')]))
		await assert.rejects(noModel.start({ kind: 'files' }), /没有可用的模型/)
		const noLlm = createOrganizer({
			store: bare.store,
			settings: bare.settings,
			llm: undefined,
			modelSelection: undefined,
			root: bare.dir,
			sessionsRoot: bare.sessionsRoot,
		})
		const status = await noLlm.status()
		assert.equal(status.catalogFailed, true)
		await assert.rejects(noLlm.start({ kind: 'files' }), /llm/)
	} finally {
		await bare.cleanup()
	}
})

test('自动整理默认关闭：tick 不建作业、不写台账', async () => {
	const clock = fakeClock(Date.parse('2026-11-10T09:00:00Z'))
	const fixture = await setup({ organize: { model: { provider: PROVIDER, model: MODEL } }, now: clock.now })
	try {
		await seedSession(fixture.sessionsRoot, 'session-auto-1', sessionLog('默认关闭'))
		const organizer = makeOrganizer(fixture, fakeLlm([textTurn('不该被调用')]))
		assert.deepEqual(await organizer.tick(), { started: null, reason: 'idle' })
		assert.equal((await organizer.jobs()).total, 0)
		await assert.rejects(readFile(join(fixture.dir, 'system', 'organize-ledger.json'), 'utf8'))
	} finally {
		await fixture.cleanup()
	}
})

test('自动会话整理：空闲触发一次，台账按 updatedAt 去重，未到空闲不触发', async () => {
	const clock = fakeClock(Date.parse('2026-11-10T09:00:00Z'))
	const fixture = await setup({ organize: autoOrganize({ sessions: { enabled: true, idleMinutes: 30 } }), now: clock.now })
	try {
		await seedSession(fixture.sessionsRoot, 'session-auto-1', sessionLog('自动整理'))
		const llm = fakeLlm([textTurn('已沉淀。')])
		const organizer = makeOrganizer(fixture, llm)

		const first = await organizer.tick()
		assert.equal(first.reason, 'sessions')
		assert.match(String(first.started), /^organize-/)
		let listing = await organizer.jobs()
		assert.equal(listing.total, 1)
		assert.equal(listing.jobs[0].kind, 'sessions')
		assert.equal(listing.jobs[0].status, 'done')
		assert.deepEqual(listing.jobs[0].sessionIds, ['session-auto-1'])
		assert.match(listing.jobs[0].log.join('\n'), /自动调度触发/)
		assert.equal(llm.calls.length, 1)

		const ledger = await readLedger(fixture.dir)
		assert.equal(ledger.sessions['session-auto-1'], Date.parse('2026-11-10T08:02:00Z'))

		// Same clock and same content: the attempt is already in the ledger.
		assert.deepEqual(await organizer.tick(), { started: null, reason: 'idle' })
		assert.equal((await organizer.jobs()).total, 1)

		// A session updated ten minutes ago is not idle yet.
		await seedSession(fixture.sessionsRoot, 'session-auto-2', sessionLog('刚聊完', Date.parse('2026-11-10T08:50:00Z')))
		assert.deepEqual(await organizer.tick(), { started: null, reason: 'idle' })
		assert.equal((await organizer.jobs()).total, 1)

		// After the idle window it is picked, and only it.
		clock.set(Date.parse('2026-11-10T09:30:00Z'))
		const second = await organizer.tick()
		assert.equal(second.reason, 'sessions')
		listing = await organizer.jobs()
		assert.equal(listing.total, 2)
		assert.deepEqual(listing.jobs[0].sessionIds, ['session-auto-2'])
		const after = await readLedger(fixture.dir)
		assert.equal(after.sessions['session-auto-1'], Date.parse('2026-11-10T08:02:00Z'))
		assert.equal(after.sessions['session-auto-2'], Date.parse('2026-11-10T08:50:00Z'))
	} finally {
		await fixture.cleanup()
	}
})

test('文件自动整理：每天 hour 点后触发一次，跨日再触发', async () => {
	const clock = fakeClock(new Date(2026, 10, 14, 2, 0, 0).getTime())
	const fixture = await setup({ organize: autoOrganize({ files: { enabled: true, hour: 3 } }), now: clock.now })
	try {
		const organizer = makeOrganizer(fixture, fakeLlm([textTurn('库整理完成。')]))
		// 02:00 is before the configured hour.
		assert.deepEqual(await organizer.tick(), { started: null, reason: 'idle' })
		assert.equal((await organizer.jobs()).total, 0)

		clock.set(new Date(2026, 10, 14, 3, 0, 0).getTime())
		const first = await organizer.tick()
		assert.equal(first.reason, 'files')
		let listing = await organizer.jobs()
		assert.equal(listing.jobs[0].kind, 'files')
		assert.equal(listing.jobs[0].status, 'done')
		let ledger = await readLedger(fixture.dir)
		assert.equal(ledger.files.lastDay, '2026-11-14')

		// Once a day: a later tick on the same day does nothing.
		clock.set(new Date(2026, 10, 14, 18, 0, 0).getTime())
		assert.deepEqual(await organizer.tick(), { started: null, reason: 'idle' })
		assert.equal((await organizer.jobs()).total, 1)

		// The next day's window opens a new run.
		clock.set(new Date(2026, 10, 15, 3, 5, 0).getTime())
		const next = await organizer.tick()
		assert.equal(next.reason, 'files')
		assert.equal((await organizer.jobs()).total, 2)
		ledger = await readLedger(fixture.dir)
		assert.equal(ledger.files.lastDay, '2026-11-15')
	} finally {
		await fixture.cleanup()
	}
})

test('有作业在跑时自动调度跳过本轮', async () => {
	const clock = fakeClock(Date.parse('2026-11-10T09:00:00Z'))
	const fixture = await setup({ organize: autoOrganize({ sessions: { enabled: true } }), now: clock.now })
	try {
		await seedSession(fixture.sessionsRoot, 'session-auto-1', sessionLog('在跑测试'))
		let release
		const gate = new Promise((resolve) => { release = resolve })
		const llm = {
			listProviders: async () => [{ id: PROVIDER, name: 'Fake 提供者' }],
			listModels: async () => [{ provider: PROVIDER, id: MODEL, name: 'Fake 模型' }],
			resolveModelInfo: async () => ({ provider: PROVIDER, id: MODEL, name: 'Fake 模型' }),
			stream() {
				return (async function* chunks() {
					await gate
					yield { type: 'text-delta', index: 0, text: '完成。' }
					yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成。' } }
					yield { type: 'finish', reason: { kind: 'stop' } }
				})()
			},
		}
		const organizer = makeOrganizer(fixture, llm)
		const started = await organizer.start({ kind: 'files' })
		assert.deepEqual(await organizer.tick(), { started: null, reason: 'running' })
		assert.equal((await organizer.jobs()).total, 1, '没有第二个作业')

		release()
		await organizer.waitForIdle()
		const [job] = (await organizer.jobs()).jobs
		assert.equal(job.id, started.job.id)
		assert.equal(job.status, 'done')
	} finally {
		await fixture.cleanup()
	}
})

test('立即整理不带 sessionIds：自动挑选空闲会话（最多 5 个），没有则报可读错误', async () => {
	const clock = fakeClock(Date.parse('2026-11-10T09:00:00Z'))
	const fixture = await setup({ organize: autoOrganize(), now: clock.now })
	try {
		const base = Date.parse('2026-11-10T08:00:00Z')
		for (let index = 1; index <= 6; index += 1) {
			await seedSession(fixture.sessionsRoot, `session-pick-${index}`, sessionLog(`会话 ${index}`, base + index * 60_000))
		}
		const organizer = makeOrganizer(fixture, fakeLlm([textTurn('完成。')]))
		const started = await organizer.start({ kind: 'sessions' })
		assert.equal(started.job.sessionIds.length, MAX_SESSIONS)
		await organizer.waitForIdle()
		const [job] = (await organizer.jobs()).jobs
		assert.equal(job.status, 'done')
		assert.equal(job.sessionIds.length, MAX_SESSIONS)
		assert.match(job.log.join('\n'), /自动挑选 5 个待整理会话/)
		const ledger = await readLedger(fixture.dir)
		assert.equal(Object.keys(ledger.sessions).length, MAX_SESSIONS)

		// The sixth session was over the batch size; the next run picks it and
		// then there is nothing left to organize.
		const second = await organizer.start({ kind: 'sessions' })
		assert.deepEqual(second.job.sessionIds, ['session-pick-6'])
		await organizer.waitForIdle()
		await assert.rejects(organizer.start({ kind: 'sessions' }), /没有待整理的会话/)
	} finally {
		await fixture.cleanup()
	}
})

test('status 增补 auto 与 scheduler：待整理数、上次运行、运行中', async () => {
	const clock = fakeClock(Date.parse('2026-11-10T09:00:00Z'))
	const fixture = await setup({ organize: autoOrganize({ sessions: { enabled: true, idleMinutes: 45 } }), now: clock.now })
	try {
		await seedSession(fixture.sessionsRoot, 'session-auto-1', sessionLog('状态测试'))
		const organizer = makeOrganizer(fixture, fakeLlm([textTurn('完成。')]))
		let status = await organizer.status()
		assert.deepEqual(status.auto, {
			sessions: { enabled: true, idleMinutes: 45 },
			files: { enabled: false, hour: 3 },
		})
		assert.equal(status.scheduler.pendingSessions, 1)
		assert.equal(status.scheduler.lastSessionRun, null)
		assert.equal(status.scheduler.lastFilesRun, null)
		assert.equal(status.scheduler.running, '')

		await organizer.tick()
		status = await organizer.status()
		assert.equal(status.scheduler.pendingSessions, 0, '台账已记录这次尝试')
		assert.equal(status.scheduler.lastSessionRun.status, 'done')
		assert.equal(status.scheduler.lastSessionRun.result.created >= 0, true)
	} finally {
		await fixture.cleanup()
	}
})

test('organize-save：模型与自动开关各自部分保存，非法值归一', async () => {
	const fixture = await setup({ organize: autoOrganize({ sessions: { enabled: true, idleMinutes: 60 } }) })
	try {
		const organizer = makeOrganizer(fixture, fakeLlm([textTurn('x')]))
		let status = await organizer.save({ model: null })
		assert.equal(status.followsChat, true)
		assert.deepEqual(status.auto.sessions, { enabled: true, idleMinutes: 60 }, '保存模型不动自动开关')
		assert.deepEqual(status.auto.files, { enabled: false, hour: 3 })

		status = await organizer.save({ auto: { files: { enabled: true, hour: 22 } } })
		assert.equal(status.followsChat, true, '保存自动开关不动模型')
		assert.deepEqual(status.auto.files, { enabled: true, hour: 22 })
		assert.deepEqual(status.auto.sessions, { enabled: true, idleMinutes: 60 })

		// Out-of-range numbers clamp, non-booleans read as off.
		status = await organizer.save({ auto: { sessions: { enabled: 'yes', idleMinutes: 9999 }, files: { hour: -4 } } })
		assert.deepEqual(status.auto.sessions, { enabled: false, idleMinutes: 240 })
		assert.deepEqual(status.auto.files, { enabled: true, hour: 0 })

		const reread = new SettingsStore({ dataDir: fixture.dir })
		await reread.load()
		assert.deepEqual(reread.get().organize.auto.sessions, { enabled: false, idleMinutes: 240 })
		assert.equal(reread.get().organize.model, null)
	} finally {
		await fixture.cleanup()
	}
})
