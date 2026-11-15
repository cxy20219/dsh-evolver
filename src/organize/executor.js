/**
 * The job executor: the one job that may run, its life cycle, and the two
 * watchdogs that keep a stuck adapter from disabling organizing.
 *
 * This module owns the single-job gate (`running`), the idle waiters and the
 * cancel/close watchdogs. Starting, running and settling a job all happen here;
 * the scheduler only decides *when* to ask, and the panel only reads snapshots.
 */

import { resolveOrganizerModel } from '../organize.js'
import { readSessionText } from '../sessions.js'
import {
	JOB_KINDS,
	MAX_CHANGES,
	MAX_LISTED_JOBS,
	MAX_MESSAGE_CHARS,
	MAX_PERSISTED_JOBS,
	MAX_SESSION_CHARS,
	MAX_SESSIONS,
	MAX_STEPS,
	abortError,
	clip,
	errorMessage,
	iso,
	newJobId,
	timeoutError,
} from './budget.js'
import { snapshot } from './jobs-store.js'
import { createAccounting, runToolLoop, stepBudget, toolsForJob } from './loop.js'
import { FILES_SYSTEM, SESSION_SYSTEM, closingText, filesPrompt, sessionPrompt } from './prompts.js'

/**
 * Create the executor over one organizer's shared runtime.
 *
 * The runtime bag is the composition root: it carries the services and the
 * methods the sibling modules installed (`load`, `persist`, `appendLog`,
 * `pendingSessions`, `recordSessions`, `rollbackLedger`, `autoSettings`,
 * `lastRunOf`, `stopScheduler`). Calling them through the bag is what keeps the
 * modules from importing each other in a cycle.
 *
 * @param {object} runtime - The shared runtime bag.
 * @returns {object} The executor methods.
 */
export function createExecutor(runtime) {
	const { store, llm, modelSelection, settings, logs, sessionsRoot, now, timing, organizeSettings } = runtime
	let running = null
	let idleWaiters = []
	/** The settle write still in flight for the job that just released `running`. */
	let settlePromise = null
	const jobTimeoutMessage = () => `整理作业超过 ${Math.max(1, Math.round(timing.job / 1_000))} 秒仍未结束，已终止。`

	/**
	 * The job that is actually queued or running, or null.
	 *
	 * The gate latch is cleared after the record settles, so "is anything
	 * running" is derived from the record rather than the bookkeeping latch.
	 *
	 * @returns {object | null} The active job.
	 */
	function activeJob() {
		return running !== null && (running.job.status === 'queued' || running.job.status === 'running')
			? running.job
			: null
	}

	/**
	 * Clear a job's watchdog timers.
	 *
	 * @param {object} entry - The running entry.
	 * @returns {void}
	 */
	function clearEntryTimers(entry) {
		if (entry.deadlineTimer !== null) {
			clearTimeout(entry.deadlineTimer)
			entry.deadlineTimer = null
		}
		if (entry.graceTimer !== null) {
			clearTimeout(entry.graceTimer)
			entry.graceTimer = null
		}
	}

	/**
	 * Resolve every `waitForIdle()` caller.
	 *
	 * @returns {void}
	 */
	function releaseIdle() {
		const waiters = idleWaiters
		idleWaiters = []
		for (const resolve of waiters) resolve()
	}

	/**
	 * End a job that did not settle on its own.
	 *
	 * Cancellation and the job deadline are cooperative: the model stream, a
	 * tool call or a disk write may be the step that never observes the signal.
	 * This is the watchdog that still writes a terminal record, releases the
	 * single-job gate and resolves the idle waiters, so a stuck adapter cannot
	 * disable organizing until the host restarts. It runs at most once per job:
	 * `entry.finalized` is set synchronously before the first await.
	 *
	 * @param {object} entry - The running entry.
	 * @returns {Promise<void>} Resolves when the record is settled.
	 */
	async function forceTerminate(entry) {
		if (entry.finalized) return
		entry.finalized = true
		clearEntryTimers(entry)
		const { job } = entry
		const cancelled = entry.closing === true || !entry.timedOut
		job.phase = '完成'
		job.finishedAt = iso(now())
		if (cancelled) {
			job.status = 'cancelled'
			job.error = null
			job.message = entry.closing === true
				? '宿主关闭，作业已强制结束。'
				: '已取消（模型调用未在等待时间内结束，已强制终止）。'
			runtime.appendLog(job, entry.closing === true ? '宿主关闭，强制结束作业' : '取消后等待超时，强制结束作业')
			logs?.info?.(`自衍中枢：整理作业 ${job.id} 已强制结束（${entry.closing === true ? '宿主关闭' : '取消等待超时'}）`)
		} else {
			const message = jobTimeoutMessage()
			job.status = 'failed'
			job.error = message
			job.message = message
			runtime.appendLog(job, message)
			logs?.warn?.(`自衍中枢：整理作业 ${job.id} 超时，已强制结束`)
		}
		await runtime.rollbackLedger(entry)
		if (running === entry) running = null
		const writing = runtime.persist()
		settlePromise = writing
		try {
			await writing
		} finally {
			if (settlePromise === writing) settlePromise = null
		}
		releaseIdle()
		const resolve = entry.resolveDone
		entry.resolveDone = null
		if (typeof resolve === 'function') resolve()
	}

	/**
	 * The one job that should run, or a readable refusal.
	 *
	 * @returns {{provider: string, model: string, reasoningEffort?: string}} The route.
	 */
	function usableSelection() {
		if (typeof llm?.stream !== 'function') {
			throw new Error('宿主没有提供模型调用能力（llm），无法启动整理作业。')
		}
		const selection = resolveOrganizerModel(settings, modelSelection)
		if (selection.provider === '' || selection.model === '') {
			throw new Error('没有可用的模型：请先在「自衍」页选择模型，或在聊天里选择一个默认模型。')
		}
		return selection
	}

	/**
	 * Run one job's kind and settle the record.
	 *
	 * The record reaches its terminal state before the gate is released, so a
	 * poller never sees "no job running" while the record still says running.
	 * The watchdog (`forceTerminate`) may already have settled the record when
	 * an abandoned model call finally returns; in that case this function must
	 * not overwrite it.
	 *
	 * @param {{job: object, controller: AbortController, finalized: boolean}} entry - The running entry.
	 * @returns {Promise<void>} Resolves when the job is settled.
	 */
	async function execute(entry) {
		const { job, controller } = entry
		const accounting = createAccounting(store)
		try {
			if (job.status === 'cancelled') return
			job.status = 'running'
			job.startedAt = iso(now())
			runtime.appendLog(job, `开始整理（${job.kind}${job.dryRun ? '，预演' : ''}）`)
			logs?.info?.(`自衍中枢：整理作业 ${job.id} 开始（${job.kind}${job.dryRun ? '，预演' : ''}）`)
			await runtime.persist()
			if (job.kind === 'sessions' || job.kind === 'all') {
				await runSessions(entry, accounting)
			}
			if (job.kind === 'files' || job.kind === 'all') {
				await runFiles(entry, accounting)
			}
			if (controller.signal.aborted) throw abortError()
			if (entry.finalized) return
			job.status = 'done'
			job.phase = '完成'
			if (job.message === '') job.message = '整理完成。'
			runtime.appendLog(job, '作业完成')
			logs?.info?.(`自衍中枢：整理作业 ${job.id} 完成：${JSON.stringify(job.result)}`)
		} catch (error) {
			if (entry.finalized) return
			// The job deadline aborts the controller too, so the reason decides
			// between "a person cancelled" and "the watchdog's timeout".
			const reason = controller.signal.aborted ? controller.signal.reason : undefined
			const cancelled = !entry.timedOut
				&& (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
			job.status = cancelled ? 'cancelled' : 'failed'
			job.phase = '完成'
			if (cancelled) {
				job.message = '已取消。'
				job.error = null
				runtime.appendLog(job, '作业已取消')
				logs?.info?.(`自衍中枢：整理作业 ${job.id} 已取消`)
			} else {
				const message = entry.timedOut && reason instanceof Error && reason.message !== ''
					? reason.message
					: errorMessage(error)
				job.error = message
				job.message = message
				runtime.appendLog(job, `失败：${job.error}`)
				logs?.warn?.(`自衍中枢：整理作业 ${job.id} 失败：${job.error}`)
			}
		} finally {
			clearEntryTimers(entry)
			if (!entry.finalized) {
				entry.finalized = true
				job.result = { ...accounting.counters }
				job.changes = accounting.changes.slice(0, MAX_CHANGES)
				job.finishedAt = iso(now())
				if (job.status === 'done' && job.phase !== '完成') job.phase = '完成'
				// A failed/cancelled run organized nothing: its batch goes back to
				// the pending queue instead of being burned in the ledger.
				if (job.status !== 'done') await runtime.rollbackLedger(entry)
				// A terminal record and the gate release are one synchronous step.
				// When they were separated by the settle write's await, a poller
				// could read `done` while `start()` still refused with
				// "已有整理作业在运行".
				if (running === entry) running = null
				const writing = runtime.persist()
				settlePromise = writing
				try {
					await writing
				} finally {
					// A job started in this window can already own the slot; only
					// clear our own write so its settle window stays guarded.
					if (settlePromise === writing) settlePromise = null
				}
				// Idle waiters resolve after the record is on disk, so a caller
				// that waits and then reloads the jobs file reads the settled
				// record.
				releaseIdle()
				const resolve = entry.resolveDone
				entry.resolveDone = null
				if (typeof resolve === 'function') resolve()
			}
		}
	}

	/**
	 * Run the sessions part of a job.
	 *
	 * A session that cannot be read is skipped with a log line instead of
	 * failing the whole job: one moved log must not block the other four.
	 *
	 * @param {{job: object, controller: AbortController}} entry - The running entry.
	 * @param {object} accounting - The instrumented store.
	 * @returns {Promise<void>} Resolves when every selected session was tried.
	 */
	async function runSessions(entry, accounting) {
		const { job, controller } = entry
		const tools = toolsForJob(job, accounting, 'sessions')
		const summaries = []
		job.progress.total = job.sessionIds.length
		job.phase = '读取会话'
		await runtime.persist()
		for (const [index, sessionId] of job.sessionIds.entries()) {
			if (controller.signal.aborted) throw abortError()
			if (stepBudget(job) < 2) {
				runtime.appendLog(job, '作业步数预算已用完，跳过剩余会话')
				break
			}
			job.phase = `整理会话 ${index + 1}/${job.sessionIds.length}`
			runtime.appendLog(job, `读取会话 ${sessionId}`)
			let session
			try {
				session = await readSessionText({
					root: sessionsRoot,
					id: sessionId,
					maxChars: MAX_SESSION_CHARS,
				})
			} catch (error) {
				runtime.appendLog(job, `跳过会话 ${sessionId}：${errorMessage(error)}`)
				job.progress.processed = index + 1
				continue
			}
			if (session === undefined) runtime.appendLog(job, `跳过会话 ${sessionId}：日志不存在`)
			else if (session.origin === 'subagent' || session.isSeeded === true || session.delegationDepth > 0) {
				runtime.appendLog(job, `跳过会话 ${sessionId}：子代理/播种会话`)
			} else if (session.messages.length === 0) runtime.appendLog(job, `跳过会话 ${sessionId}：没有可读的用户/助手文本`)
			else {
				const result = await runToolLoop({
					job,
					llm,
					selection: { ...job.selection },
					system: SESSION_SYSTEM,
					prompt: sessionPrompt(session, store),
					tools,
					signal: controller.signal,
					maxSteps: Math.min(MAX_STEPS.sessions, stepBudget(job)),
					turnTimeoutMs: timing.turn,
					log: (line) => runtime.appendLog(job, line),
				})
				job.progress.steps += result.steps
				job.progress.toolCalls += result.toolCalls
				const closing = closingText(result)
				if (closing !== '') summaries.push(closing)
				if (result.finalTruncated) runtime.appendLog(job, '最终总结被 max-tokens 截断')
				else if (result.truncated) runtime.appendLog(job, '本轮输出被 max-tokens 截断')
				if (result.exhausted) runtime.appendLog(job, '步数预算用尽，按当前结果收尾')
				runtime.appendLog(job, `会话 ${sessionId} 完成（${result.steps} 轮，${result.toolCalls} 次工具）`)
			}
			job.progress.processed = index + 1
			await runtime.persist()
		}
		job.message = clip(summaries.join('\n'), MAX_MESSAGE_CHARS)
		if (job.message === '') job.message = '没有可沉淀的会话内容。'
	}

	/**
	 * Run the library part of a job.
	 *
	 * @param {{job: object, controller: AbortController}} entry - The running entry.
	 * @param {object} accounting - The instrumented store.
	 * @returns {Promise<void>} Resolves when the run settled.
	 */
	async function runFiles(entry, accounting) {
		const { job, controller } = entry
		const tools = toolsForJob(job, accounting, 'files')
		if (stepBudget(job) < 2) {
			job.phase = '完成'
			runtime.appendLog(job, '作业步数预算已用完，跳过文件整理')
			return
		}
		job.phase = '读取库'
		job.progress.total = 1
		runtime.appendLog(job, '读取库现状')
		await runtime.persist()
		const report = store.organizeReport({ staleDays: 90, sample: 5 })
		job.phase = '整理文件'
		const result = await runToolLoop({
			job,
			llm,
			selection: { ...job.selection },
			system: FILES_SYSTEM,
			prompt: filesPrompt(store, report, job),
			tools,
			signal: controller.signal,
			maxSteps: Math.min(MAX_STEPS.files, stepBudget(job)),
			turnTimeoutMs: timing.turn,
			log: (line) => runtime.appendLog(job, line),
		})
		job.progress.steps += result.steps
		job.progress.toolCalls += result.toolCalls
		if (result.finalTruncated) runtime.appendLog(job, '最终总结被 max-tokens 截断')
		else if (result.truncated) runtime.appendLog(job, '本轮输出被 max-tokens 截断')
		if (result.exhausted) runtime.appendLog(job, '步数预算用尽，按当前结果收尾')
		job.message = clip(
			closingText(result, job.dryRun ? '预演完成，模型没有给出计划。' : '整理完成。'),
			MAX_MESSAGE_CHARS,
		)
		job.progress.processed = 1
		await runtime.persist()
	}

	/**
	 * Validate one start request and run the job in the background.
	 *
	 * This is the one place a job is created: the panel's `organize-start` and
	 * the automatic scheduler both come through here, so the single-job gate,
	 * the model check and the ledger stay in one implementation.
	 *
	 * A `sessions` request without ids picks the idle sessions the automatic
	 * scheduler would; that is what makes the panel's one "run now" button
	 * useful without a session picker. The selection is recorded in the ledger
	 * immediately, so a following automatic pass does not repeat it; a failed
	 * run restores that record (see `rollbackLedger`).
	 *
	 * @param {object} [payload] - `{kind, sessionIds, dryRun, allowRemove}`.
	 * @param {{auto?: boolean, batch?: Array<{id: string, updatedAt: number}>}} [options] - Who asked and the selected session timestamps.
	 * @returns {Promise<{job: object, entry: object}>} The queued job and its running entry.
	 */
	async function startJob(payload = {}, options = {}) {
		await runtime.load()
		// Shape first, exclusivity second: an invalid request is invalid even
		// while another job runs, and the panel gets the actionable error
		// instead of "已有整理作业在运行".
		const kind = typeof payload.kind === 'string' ? payload.kind.trim() : ''
		if (!JOB_KINDS.includes(kind)) throw new Error(`整理类型只能是 ${JOB_KINDS.join(' / ')}。`)
		if (payload.dryRun !== undefined && typeof payload.dryRun !== 'boolean') {
			throw new Error('dryRun 只能是布尔值。')
		}
		if (payload.allowRemove !== undefined && typeof payload.allowRemove !== 'boolean') {
			throw new Error('allowRemove 只能是布尔值。')
		}
		const dryRun = payload.dryRun === true
		const allowRemove = payload.allowRemove === true && !dryRun
		let sessionIds = []
		let picked = []
		if (kind === 'sessions' || kind === 'all') {
			if (payload.sessionIds !== undefined && !Array.isArray(payload.sessionIds)) {
				throw new Error('sessionIds 必须是会话 id 数组。')
			}
			const raw = Array.isArray(payload.sessionIds) ? payload.sessionIds : []
			for (const item of raw) {
				if (typeof item !== 'string' || item.trim() === '') {
					throw new Error('sessionIds 里必须是会话 id 字符串（session-…）。')
				}
			}
			sessionIds = [...new Set(raw.map((item) => item.trim()))]
			if (sessionIds.length === 0 && kind === 'sessions') {
				// "Run now" from the panel sends no ids: the host picks the same
				// idle sessions the automatic pass would.
				picked = (await runtime.pendingSessions()).slice(0, MAX_SESSIONS)
				sessionIds = picked.map((item) => item.id)
				if (sessionIds.length === 0) {
					throw new Error('没有待整理的会话：它们都已整理过，或还没到空闲时间。')
				}
			}
			if (sessionIds.length === 0) throw new Error('整理会话需要至少选择 1 个会话。')
			if (sessionIds.length > MAX_SESSIONS) throw new Error(`一次最多整理 ${MAX_SESSIONS} 个会话。`)
		}
		// The latch can briefly outlive a terminal record only if a future
		// change reintroduces an await; the status guard keeps the refusal
		// truthful either way.
		if (running !== null && (running.job.status === 'queued' || running.job.status === 'running')) {
			throw new Error(`已有整理作业在运行（${running.job.id}），请等它结束或先取消。`)
		}
		const selection = usableSelection()
		const job = {
			id: newJobId(),
			kind,
			status: 'queued',
			dryRun,
			allowRemove,
			phase: '排队中',
			progress: { processed: 0, total: kind === 'sessions' ? sessionIds.length : 0, steps: 0, toolCalls: 0, writes: 0 },
			selection: { ...selection },
			sessionIds,
			startedAt: '',
			finishedAt: '',
			message: '',
			error: null,
			result: { created: 0, updated: 0, merged: 0, archived: 0, removed: 0, retagged: 0, linked: 0 },
			changes: [],
			log: [],
		}
		runtime.appendLog(job, `作业已排队：${kind}${dryRun ? '（预演，不写库）' : ''}`)
		if (options.auto === true) runtime.appendLog(job, '自动调度触发')
		if (picked.length > 0) runtime.appendLog(job, `自动挑选 ${picked.length} 个待整理会话`)
		runtime.state.jobs.unshift(job)
		if (runtime.state.jobs.length > MAX_PERSISTED_JOBS) runtime.state.jobs.length = MAX_PERSISTED_JOBS
		const entry = {
			job,
			controller: new AbortController(),
			finalized: false,
			timedOut: false,
			closing: false,
			deadlineTimer: null,
			graceTimer: null,
			ledgerPrevious: null,
			resolveDone: null,
		}
		entry.promise = new Promise((resolve) => { entry.resolveDone = resolve })
		running = entry
		// Two watchdogs guard the single-job gate. The job deadline aborts the
		// controller (a healthy run aborts within the turn deadline anyway); the
		// grace timer after any abort forcibly settles a step that ignores the
		// signal altogether.
		entry.deadlineTimer = setTimeout(() => {
			if (entry.finalized) return
			entry.timedOut = true
			entry.controller.abort(timeoutError(jobTimeoutMessage()))
		}, timing.job)
		entry.controller.signal.addEventListener('abort', () => {
			if (entry.finalized) return
			entry.graceTimer = setTimeout(() => { void forceTerminate(entry) }, timing.grace)
		}, { once: true })
		// The batch is recorded before the run so a concurrent pass cannot pick
		// it; the previous values are kept so a failed run can return it.
		const ledgerBatch = picked.length > 0
			? picked
			: (options.auto === true && Array.isArray(options.batch) ? options.batch : [])
		if (ledgerBatch.length > 0) entry.ledgerPrevious = await runtime.recordSessions(ledgerBatch)
		await runtime.persist()
		// Start on the next microtask so the caller always observes the
		// queued snapshot first, and an immediate cancel still wins.
		void Promise.resolve()
			.then(() => execute(entry))
			.catch((error) => {
				// `execute` settles its own record; this catch only refuses to
				// leave an unhandled rejection if a persistence helper fails.
				logs?.warn?.(`自衍中枢：整理作业 ${job.id} 收尾失败：${errorMessage(error)}`)
			})
			.finally(() => {
				const resolve = entry.resolveDone
				entry.resolveDone = null
				if (typeof resolve === 'function') resolve()
			})
		return { job: snapshot(job), entry }
	}

	/**
	 * The panel's `organize-status`: model settings, the latest job, and what
	 * the automatic scheduler would do next.
	 *
	 * @returns {Promise<object>} The status.
	 */
	async function status() {
		const base = await organizeSettings.status()
		await runtime.load()
		const pending = await runtime.pendingSessions()
		const active = activeJob()
		return {
			...base,
			auto: runtime.autoSettings(),
			job: runtime.state.jobs.length === 0 ? null : snapshot(runtime.state.jobs[0]),
			scheduler: {
				pendingSessions: pending.length,
				lastSessionRun: runtime.lastRunOf('sessions'),
				lastFilesRun: runtime.lastRunOf('files'),
				running: active === null ? '' : active.id,
			},
		}
	}

	/**
	 * The panel's `organize-jobs`: recent jobs, newest first.
	 *
	 * @param {{limit?: number}} [payload] - How many records.
	 * @returns {Promise<{jobs: object[], total: number, running: string}>} The list.
	 */
	async function jobs(payload = {}) {
		await runtime.load()
		const wanted = Math.round(Number(payload.limit) || 10)
		const limit = Math.max(1, Math.min(MAX_LISTED_JOBS, Number.isFinite(wanted) ? wanted : 10))
		// The record is settled before the running flag is cleared, so a
		// poller can observe a done job while `running` still names it. The
		// panel renders this field as "a job is executing now"; derive it
		// from the record instead of the bookkeeping latch.
		const active = activeJob()
		return {
			jobs: runtime.state.jobs.slice(0, limit).map(snapshot),
			total: runtime.state.jobs.length,
			running: active === null ? '' : active.id,
		}
	}

	/**
	 * The panel's `organize-cancel`.
	 *
	 * @param {{id?: string}} [payload] - The job id, or the current job.
	 * @returns {Promise<{cancelled: boolean, job: object | null}>} What happened.
	 */
	async function cancel(payload = {}) {
		await runtime.load()
		const id = typeof payload.id === 'string' ? payload.id.trim() : ''
		// The settle steps run after the record reaches its terminal status, so
		// the latch can still name a finished job. "Current job" means the one
		// that is actually queued or running.
		const active = activeJob()
		const target = id === ''
			? active
			: (runtime.state.jobs.find((job) => job.id === id) ?? null)
		if (target === null) return { cancelled: false, job: null }
		if (target.status === 'queued') {
			target.status = 'cancelled'
			target.phase = '完成'
			target.message = '已取消。'
			target.finishedAt = iso(now())
			runtime.appendLog(target, '作业在开始前被取消')
			// `execute` is already scheduled and sees the terminal record; it
			// performs the release (and the ledger rollback) in its finally, so
			// the gate and the record cannot disagree in the panel.
			if (running !== null && running.job === target) running.controller.abort()
			await runtime.persist()
			return { cancelled: true, job: snapshot(target) }
		}
		if (target.status === 'running') {
			runtime.appendLog(target, '收到取消请求')
			// The abort starts the grace window; if the current step ignores
			// the signal the watchdog settles the job within it.
			if (running !== null && running.job === target) running.controller.abort()
			await runtime.persist()
			return { cancelled: true, job: snapshot(target) }
		}
		return { cancelled: false, job: snapshot(target) }
	}

	/**
	 * Wait until no job is running (tests and graceful shutdown).
	 *
	 * Resolves once the settled record is on disk, including when the
	 * watchdog had to end a job its model step never returned from.
	 *
	 * @returns {Promise<void>} Resolves when idle.
	 */
	async function waitForIdle() {
		await runtime.load()
		// `settlePromise` covers the window where the job already released
		// the gate but its record is still being written.
		while (running !== null || settlePromise !== null) {
			await new Promise((resolve) => idleWaiters.push(resolve))
		}
	}

	/**
	 * Stop the scheduler and end a running job (plugin disposal).
	 *
	 * Disposal cannot wait for a cooperative abort: the host is about to
	 * close the store under the job. The record is settled immediately so a
	 * later `waitForIdle()` (or the next process, reading the file) sees a
	 * terminal job rather than a phantom "running" one.
	 *
	 * @returns {void}
	 */
	function close() {
		runtime.stopScheduler()
		if (running !== null) {
			running.closing = true
			running.controller.abort()
			void forceTerminate(running).catch(() => {})
		}
	}

	return {
		activeJob,
		usableSelection,
		execute,
		runSessions,
		runFiles,
		startJob,
		status,
		jobs,
		cancel,
		waitForIdle,
		close,
	}
}
