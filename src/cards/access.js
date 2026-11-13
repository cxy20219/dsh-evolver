/**
 * Card access accounting.
 *
 * The store knows what was written; this file is how the library finds out
 * what was actually read. `evolve_review` uses it to tell a card nobody opens
 * from one that is merely old, and the daily organiser uses the same numbers
 * to give a card that keeps being read a second look instead of a first one.
 *
 * The ledger is a derived cache, not a source of truth: a missing or corrupt
 * `access.json` means "no access recorded" and never an error. Reads happen on
 * every tool call, so writes are throttled — counters pile up in memory and
 * reach the disk on the first access of a process (a short session still
 * leaves a trace), then at most once per 30 seconds, or once 20 accesses have
 * accumulated.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** The on-disk format version. */
const ACCESS_VERSION = 1

/** The shortest gap between two writes while accesses trickle in. */
const ACCESS_FLUSH_INTERVAL_MS = 30_000

/** How many accesses may pile up before they force a write. */
const ACCESS_FLUSH_CHANGES = 20

/** How many entries `topAccessed` returns by default. */
const ACCESS_TOP_LIMIT = 10

/** The last temp-file suffix handed out, so two writers never share one. */
let tempSequence = 0

/**
 * The cards that were read most often.
 *
 * Ties fall back to the newest read and then the id, so the same data gives
 * the same order twice. Not on the request path; the idle review reads it.
 *
 * @param {string} dataDir - The data folder.
 * @param {number} [limit] - How many entries to return.
 * @returns {Promise<Array<{id: string, count: number, lastAt: string}>>} The ranking, hottest first.
 */
/** @internal exported for tests */
export async function topAccessed(dataDir, limit = ACCESS_TOP_LIMIT) {
	const stats = await accessStats(dataDir)
	const size = Math.max(1, Math.min(100, Math.round(Number(limit) || ACCESS_TOP_LIMIT)))
	return Object.entries(stats.ids)
		.map(([id, entry]) => ({ id, count: entry.count, lastAt: entry.lastAt }))
		.sort((left, right) => right.count - left.count || right.lastAt.localeCompare(left.lastAt) || left.id.localeCompare(right.id))
		.slice(0, size)
}


/**
 * Where the access ledger of one data folder lives.
 *
 * @param {string} dataDir - The data folder.
 * @returns {string} The absolute file path.
 */
/** @internal exported for tests */
export function accessPath(dataDir) {
	return join(dataDir, 'knowledge', 'access.json')
}

/**
 * An empty ledger.
 *
 * @returns {{version: number, ids: Record<string, {count: number, lastAt: string}>}} The ledger.
 */
function emptyStats() {
	return { version: ACCESS_VERSION, ids: {} }
}

/**
 * Write one JSON document without leaving a half-written file.
 *
 * The ledger is read back as empty when it cannot be parsed, so a crash in the
 * middle of a write would silently forget every earlier count rather than
 * complain. The temp name carries the pid and a counter: two writers in one
 * process must not rename over each other's half-written file.
 *
 * @param {string} path - Destination.
 * @param {object} value - The value to serialise.
 * @returns {Promise<void>} Resolves once the file is in place.
 */
async function writeJsonAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	tempSequence += 1
	const temp = `${path}.${process.pid}.${tempSequence}.tmp`
	await writeFile(temp, `${JSON.stringify(value, null, '\t')}\n`, { mode: 0o600 })
	await rename(temp, path)
}

/**
 * Read the access ledger.
 *
 * Best effort by design: the review and the panel must keep working when the
 * file is missing, truncated, or hand-edited into nonsense.
 *
 * @param {string} dataDir - The data folder.
 * @returns {Promise<{version: number, ids: Record<string, {count: number, lastAt: string}>}>} The counters, empty when unreadable.
 */
export async function accessStats(dataDir) {
	if (typeof dataDir !== 'string' || dataDir === '') return emptyStats()
	let raw
	try {
		raw = await readFile(accessPath(dataDir), 'utf8')
	} catch {
		return emptyStats()
	}
	let parsed
	try {
		parsed = JSON.parse(raw)
	} catch {
		return emptyStats()
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyStats()
	const source = parsed.ids
	if (source === null || typeof source !== 'object' || Array.isArray(source)) return emptyStats()
	const ids = {}
	for (const [id, entry] of Object.entries(source)) {
		if (id === '' || entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
		const count = Math.round(Number(entry.count))
		if (!Number.isFinite(count) || count <= 0) continue
		ids[id] = { count, lastAt: typeof entry.lastAt === 'string' ? entry.lastAt : '' }
	}
	return { version: ACCESS_VERSION, ids }
}


/**
 * An access ledger bound to one data folder.
 *
 * Tests inject `dataDir` and `now`; the plugin builds one per card agent and
 * lets it flush on its own. Only one writer per folder is expected: two
 * instances would each merge the file they read, so the slower one wins.
 *
 * @param {{dataDir?: string, now?: () => number, flushIntervalMs?: number, flushChanges?: number}} [options] - Dependencies.
 * @returns {object} The ledger: `recordAccess`, `flushAccess`, `accessStats`, `topAccessed`.
 */
export function createAccessLog({
	dataDir,
	now = Date.now,
	flushIntervalMs = ACCESS_FLUSH_INTERVAL_MS,
	flushChanges = ACCESS_FLUSH_CHANGES,
} = {}) {
	const root = typeof dataDir === 'string' && dataDir !== '' ? dataDir : undefined
	const interval = Math.max(0, Number(flushIntervalMs) || 0)
	const threshold = Math.max(1, Math.round(Number(flushChanges) || ACCESS_FLUSH_CHANGES))
	/** Counters not yet written: card id to the delta since the last flush. */
	const pending = new Map()
	/** How many accesses those counters stand for. */
	let pendingChanges = 0
	/** When the last successful write happened; 0 forces the first one. */
	let lastFlushAt = 0
	/** Writes run one after another: two interleaved flushes would lose one. */
	let chain = Promise.resolve()

	/**
	 * Whether the counters are due for a write.
	 *
	 * @returns {boolean} True when writing now is allowed.
	 */
	function due() {
		return pendingChanges > 0 && (pendingChanges >= threshold || now() - lastFlushAt >= interval)
	}

	/**
	 * Aggregate one batch of reads.
	 *
	 * Never rejects: accounting a read must not be able to break the read.
	 *
	 * @param {Iterable<string>} ids - The card ids that were returned.
	 * @returns {Promise<void>} Resolves once any write it triggered is done.
	 */
	async function recordAccess(ids) {
		if (root === undefined) return
		const stamp = new Date(now()).toISOString()
		for (const raw of ids ?? []) {
			const id = String(raw ?? '')
			if (id === '') continue
			const entry = pending.get(id) ?? { count: 0, lastAt: stamp }
			entry.count += 1
			entry.lastAt = stamp
			pending.set(id, entry)
			pendingChanges += 1
		}
		if (!due()) return
		await flushAccess({ force: true }).catch(() => {})
	}

	/**
	 * Write the counters that are due.
	 *
	 * The delta is snapshotted inside the serialised write, not when the call
	 * is made: a read that lands while the file is being written belongs to the
	 * next flush, and a second flush queued behind the first must not write the
	 * same delta twice.
	 *
	 * @param {{force?: boolean}} [options] - `force` writes regardless of the throttle.
	 * @returns {Promise<boolean>} Whether a write happened.
	 */
	async function flushAccess({ force = false } = {}) {
		if (root === undefined || pendingChanges === 0) return false
		if (!force && !due()) return false
		const run = async () => {
			if (pendingChanges === 0) return false
			if (!force && !due()) return false
			const delta = new Map([...pending].map(([id, entry]) => [id, { ...entry }]))
			const changes = pendingChanges
			const stats = await accessStats(root)
			for (const [id, entry] of delta) {
				const previous = stats.ids[id]
				stats.ids[id] = { count: (previous?.count ?? 0) + entry.count, lastAt: entry.lastAt }
			}
			await writeJsonAtomic(accessPath(root), stats)
			// Only a successful write drops the delta: a failed one keeps the
			// counters in memory, so the next attempt simply retries them.
			for (const [id, entry] of delta) {
				const current = pending.get(id)
				if (current === undefined) continue
				current.count -= entry.count
				if (current.count <= 0) pending.delete(id)
			}
			pendingChanges = Math.max(0, pendingChanges - changes)
			lastFlushAt = now()
			return true
		}
		const started = chain.then(run, run)
		// One failed write must not poison every later one.
		chain = started.catch(() => {})
		return started
	}

	/**
	 * The ledger as it is on disk.
	 *
	 * @returns {Promise<{version: number, ids: Record<string, {count: number, lastAt: string}>}>} The persisted counters.
	 */
	function stats() {
		return root === undefined ? Promise.resolve(emptyStats()) : accessStats(root)
	}

	/**
	 * The hottest cards as they are on disk.
	 *
	 * @param {number} [limit] - How many entries to return.
	 * @returns {Promise<Array<{id: string, count: number, lastAt: string}>>} The ranking.
	 */
	function top(limit = ACCESS_TOP_LIMIT) {

	}

	return { dataDir: root, recordAccess, flushAccess, accessStats: stats, topAccessed: top }
}
