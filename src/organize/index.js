/**
 * The organizer: assembly root for the unattended cleanup engine.
 *
 * The panel starts a job; the scheduler may start one by itself; this module
 * wires the pieces together and exposes the controller the host holds
 * (`status`, `save`, `start`, `jobs`, `cancel`, `open`, `close`,
 * `waitForIdle`, and the test-only `tick`).
 *
 * All host services are optional by transport: the panel still gets a working
 * `status()` on a host without `llm`, and `start()` explains the missing piece
 * instead of crashing the plugin.
 *
 * The state stays in closures owned by the composition root, never at module
 * level: two organizers in one process (tests) must not see each other's jobs,
 * ledger or timers. Cross-module calls go through the shared `runtime` bag that
 * the factories install their methods into.
 */

import { createOrganizeSettings } from '../organize.js'
import {
	CANCEL_GRACE_MS,
	JOB_TIMEOUT_MS,
	TURN_TIMEOUT_MS,
	duration,
} from './budget.js'
import { createExecutor } from './executor.js'
import { createJobsStore } from './jobs-store.js'
import { createScheduler } from './scheduler.js'

/**
 * Create the organizer: model settings plus the job manager.
 *
 * @param {object} deps - The services and paths.
 * @param {object} deps.store - The open file store.
 * @param {object} deps.settings - The settings store.
 * @param {object | undefined} deps.llm - The Host `llm` service.
 * @param {object | undefined} deps.modelSelection - The Host `agentDefaultModel` service.
 * @param {object} [deps.logs] - The plugin log.
 * @param {string} deps.root - The data root.
 * @param {string} deps.sessionsRoot - The host's sessions folder.
 * @param {() => number} [deps.now] - Clock.
 * @param {{turn?: number, job?: number, grace?: number}} [deps.timeouts] - Deadlines in milliseconds (tests shorten them).
 * @returns {object} The controller: `status`, `save`, `start`, `jobs`, `cancel`, `open`, `close`, `waitForIdle`.
 */
export function createOrganizer({
	store,
	settings,
	llm,
	modelSelection,
	logs,
	root,
	sessionsRoot,
	now = () => Date.now(),
	timeouts,
}) {
	if (typeof root !== 'string' || root === '') throw new Error('整理引擎需要数据目录。')
	const organizeSettings = createOrganizeSettings({ settings, llm, modelSelection, now })
	const timing = {
		turn: duration(timeouts?.turn, TURN_TIMEOUT_MS),
		job: duration(timeouts?.job, JOB_TIMEOUT_MS),
		grace: duration(timeouts?.grace, CANCEL_GRACE_MS),
	}
	// The composition root: configuration plus the methods the factories install
	// into it. A method may be looked up here before it is installed (the
	// scheduler calls `startJob`, which the executor installs later), but every
	// lookup happens at call time, after assembly finished.
	const runtime = { store, settings, llm, modelSelection, logs, root, sessionsRoot, now, timing, organizeSettings }
	Object.assign(runtime, createJobsStore(runtime))
	Object.assign(runtime, createScheduler({ runtime, settings, sessionsRoot, now, logs }))
	Object.assign(runtime, createExecutor(runtime))
	runtime.startScheduler()

	return {
		/**
		 * Explicit load; every public method also waits for it.
		 *
		 * @returns {Promise<void>} Resolves when loaded.
		 */
		async open() {
			await runtime.load()
		},

		status: runtime.status,

		/**
		 * The panel's `organize-save`.
		 *
		 * Accepts either half of the organize block, alone or together:
		 * `{model}`, `{auto: {sessions?, files?}}`, or `{organize: {…}}`. Values
		 * are normalised by the settings store, so a half-filled model becomes
		 * "follow the chat" and an out-of-range number is clamped instead of
		 * failing the save.
		 *
		 * @param {object} [patch] - `{model?, auto?}` or `{organize: {model?, auto?}}`.
		 * @returns {Promise<object>} The new status.
		 */
		async save(patch = {}) {
			const input = patch !== null && typeof patch === 'object' ? patch : {}
			const next = {}
			for (const source of [input, input.organize]) {
				if (source === null || typeof source !== 'object' || Array.isArray(source)) continue
				if (Object.prototype.hasOwnProperty.call(source, 'model')) next.model = source.model ?? null
				if (Object.prototype.hasOwnProperty.call(source, 'auto')) next.auto = source.auto
			}
			if (Object.keys(next).length > 0) await settings.save({ organize: next })
			return runtime.status()
		},

		/**
		 * The panel's `organize-start`: validate, record, and run in the background.
		 *
		 * @param {object} [payload] - `{kind, sessionIds, dryRun, allowRemove}`.
		 * @returns {Promise<{job: object}>} The queued job.
		 */
		async start(payload = {}) {
			const { job } = await runtime.startJob(payload)
			return { job }
		},

		jobs: runtime.jobs,
		cancel: runtime.cancel,
		waitForIdle: runtime.waitForIdle,

		/**
		 * One automatic-scheduling pass.
		 *
		 * The host timer calls it every minute; tests call it directly with a
		 * fake clock, which is the only way to prove the schedule without
		 * waiting. Exposed on the controller, never on the panel API.
		 *
		 * @returns {Promise<{started: string | null, reason: string}>} What this pass did.
		 */
		tick: runtime.tick,

		close: runtime.close,
	}
}
