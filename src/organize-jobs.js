/**
 * The organizer — the stable import path.
 *
 * The implementation lives in `src/organize/` (budget, prompts, loop,
 * jobs-store, scheduler, executor, assembled by `index.js`). The module was one
 * 2,100-line file; this entry keeps `createOrganizer` and the public budget
 * constants importable from the old path, so the host and the tests do not
 * depend on the internal layout.
 */

export {
	AUTO_TICK_MS,
	CANCEL_GRACE_MS,
	JOB_KINDS,
	JOB_STATUSES,
	JOB_TIMEOUT_MS,
	MAX_SESSION_CHARS,
	MAX_SESSIONS,
	MAX_STEPS,
	MAX_TOOL_CALLS,
	TURN_TIMEOUT_MS,
} from './organize/budget.js'
export { createOrganizer } from './organize/index.js'
