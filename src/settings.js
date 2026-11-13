/**
 * The plugin's own settings.
 *
 * These live *next to* the harness home, not inside the data folder: the data
 * folder can be moved to another disk, while the settings have to remember
 * where it went. They also hold the OSS credentials, which therefore never
 * travel into a cloud backup of the data folder.
 *
 * The file is written atomically with mode 0600, and the API never sends the
 * secret back to the browser: the panel only learns whether one is stored.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** How many searches may be stored remotely. */
const KEEP_MIN = 1
const KEEP_MAX = 60

/** The shortest and longest automatic backup interval, in minutes. */
const INTERVAL_MIN = 5
const INTERVAL_MAX = 10_080

/** A backup prefix is one safe object-name segment. */
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * The default backup configuration.
 *
 * @returns {object} A fresh object.
 */
function defaultBackup() {
	return {
		enabled: false,
		endpoint: '',
		bucket: '',
		accessKeyId: '',
		accessKeySecret: '',
		prefix: 'dsh-evolver',
		keep: 7,
		intervalMinutes: 1440,
	}
}


/**
 * The default status block.
 *
 * @returns {object} A fresh object.
 */
function defaultStatus() {
	return {
		lastAttemptAt: '',
		lastBackupAt: '',
		lastObjectKey: '',
		lastBytes: 0,
		lastFiles: 0,
		lastRemoved: 0,
		lastError: '',
	}
}

/**
 * The default idle-ingest configuration.
 *
 * The user can turn this off; the default is on because the whole point is a
 * safety net for sessions where nobody remembered to save anything.
 *
 * @returns {object} A fresh object.
 */
/** @internal exported for tests */
export function defaultIngest() {
	return { enabled: true, idleMinutes: 15 }
}

/**
 * Normalise the idle-ingest configuration.
 *
 * @param {unknown} value - The raw value.
 * @param {object} [fallback] - What to use for missing fields.
 * @returns {object} The normalised value.
 */
function normalizeIngest(value, fallback = defaultIngest()) {
	const source = value !== null && typeof value === 'object' ? value : {}
	const minutes = Math.round(Number(source.idleMinutes))
	return {
		enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
		idleMinutes: Number.isFinite(minutes) ? Math.min(240, Math.max(5, minutes)) : fallback.idleMinutes,
	}
}

/** The most cards one consolidation batch may take. */
const CONSOLIDATE_MAX = 100

/**
 * Normalise a stored model selection.
 *
 * `null` is the meaningful "follow whatever the session uses" value, so it is
 * kept rather than replaced: a user who never picked a model must keep getting
 * the default one when it changes.
 *
 * @param {unknown} value - The raw value.
 * @param {object | null} fallback - What to use when the value is absent or broken.
 * @returns {{provider: string, model: string, reasoningEffort?: string} | null} The selection.
 */
function normalizeModelSelection(value, fallback) {
	if (value === null) return null
	if (value === undefined) return fallback
	if (typeof value !== 'object' || Array.isArray(value)) return fallback
	const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
	const model = typeof value.model === 'string' ? value.model.trim() : ''
	if (provider === '' || model === '') return fallback
	const effort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : ''
	return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
}

/**
 * The default daily card consolidation.
 *
 * Off by default: it rewrites and deletes cards, so it is switched on
 * deliberately rather than as a surprise after an upgrade.
 *
 * `dailyCards` is the size of one batch, and the floor of the day's quota: the
 * daily total follows how fast the library grew, up to a few batches, so a
 * burst of writes is reviewed at the pace it was written instead of waiting
 * weeks behind a fixed trickle.
 *
 * The model it runs on lives in the `organize` block, next to the session
 * ingest: both are unattended whole-library jobs, and one selector for the two
 * is the one that cannot drift apart.
 *
 * @returns {object} A fresh object.
 */
/** @internal exported for tests */
export function defaultConsolidate() {
	return { enabled: false, dailyCards: 15, hour: 3 }
}

/**
 * The default settings shared by the two unattended organisers.
 *
 * @returns {object} A fresh object.
 */
/** @internal exported for tests */
export function defaultOrganize() {
	return { model: null }
}

/**
 * Normalise the organisers' shared settings.
 *
 * @param {unknown} value - The raw value.
 * @param {object} [fallback] - What to use for missing fields.
 * @returns {object} The normalised value.
 */
/** @internal exported for tests */
export function normalizeOrganize(value, fallback = defaultOrganize()) {
	const source = value !== null && typeof value === 'object' ? value : {}
	return { model: normalizeModelSelection(source.model, fallback.model ?? null) }
}

/**
 * Normalise the daily card consolidation.
 *
 * @param {unknown} value - The raw value.
 * @param {object} [fallback] - What to use for missing fields.
 * @returns {object} The normalised value.
 */
/** @internal exported for tests */
export function normalizeConsolidate(value, fallback = defaultConsolidate()) {
	const source = value !== null && typeof value === 'object' ? value : {}
	const cards = Math.round(Number(source.dailyCards))
	const hour = Math.round(Number(source.hour))
	return {
		enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
		dailyCards: Number.isFinite(cards) ? Math.min(CONSOLIDATE_MAX, Math.max(1, cards)) : fallback.dailyCards,
		hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : fallback.hour,
	}
}

/** The default card body budget, in Unicode code points. */
function defaultCardMaxChars() {
	return 1000
}

/** The default description budget, in Unicode code points. */
function defaultCardDescriptionMaxChars() {
	return 80
}

/**
 * Normalise the card description budget.
 *
 * The description is what the injected index shows next to an id, so the range
 * is narrow on purpose: below 20 characters a sentence cannot say anything,
 * above 200 it is a summary rather than an index entry.
 *
 * @param {unknown} value - The raw value.
 * @returns {number} The clamped budget.
 */
function normalizeCardDescriptionMaxChars(value) {
	const size = Math.round(Number(value))
	if (!Number.isFinite(size)) return defaultCardDescriptionMaxChars()
	return Math.min(200, Math.max(20, size))
}

/**
 * Normalise the card body budget.
 *
 * @param {unknown} value - The raw value.
 * @returns {number} A number between 200 and 4000.
 */
function normalizeCardMaxChars(value) {
	const size = Math.round(Number(value))
	if (!Number.isFinite(size)) return defaultCardMaxChars()
	return Math.min(4000, Math.max(200, size))
}

/**
 * The default settings.
 *
 * @returns {object} A fresh object.
 */
/** @internal exported for tests */
export function defaultSettings() {
	return {
		dataDir: '',
		cardMaxChars: defaultCardMaxChars(),
		cardDescriptionMaxChars: defaultCardDescriptionMaxChars(),
		backup: defaultBackup(),
		status: defaultStatus(),
		ingest: defaultIngest(),
		consolidate: defaultConsolidate(),
		organize: defaultOrganize(),
	}
}

/**
 * A filename-friendly timestamp for a suggested export path.
 *
 * @param {Date} [date] - The time.
 * @returns {string} `YYYYMMDD-HHmmss`.
 */
function archiveStamp(date = new Date()) {
	return date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
}

/**
 * The filename the export field starts with.
 *
 * @param {Date} [date] - The time.
 * @returns {string} The suggested name.
 */
function suggestedArchiveName(date = new Date()) {
	return `dsh-evolver-${archiveStamp(date)}.tar.gz`
}

/**
 * Read a string, trimmed and clamped.
 *
 * @param {unknown} value - The raw value.
 * @param {string} fallback - Value used when absent.
 * @param {number} max - Maximum length.
 * @returns {string} The string.
 */
function readString(value, fallback = '', max = 512) {
	if (typeof value !== 'string') return fallback
	const text = value.trim()
	if (text === '') return fallback
	if (/[\r\n\u0000]/.test(text)) return fallback
	return text.slice(0, max)
}

/**
 * Read a boolean.
 *
 * @param {unknown} value - The raw value.
 * @param {boolean} fallback - Value used when absent.
 * @returns {boolean} The boolean.
 */
function readBoolean(value, fallback = false) {
	return typeof value === 'boolean' ? value : fallback
}

/**
 * Read an integer inside a range.
 *
 * @param {unknown} value - The raw value.
 * @param {number} fallback - Value used when absent.
 * @param {number} min - Smallest accepted value.
 * @param {number} max - Largest accepted value.
 * @returns {number} The integer.
 */
function readInteger(value, fallback, min, max) {
	const number = Number(value)
	if (!Number.isFinite(number)) return fallback
	return Math.min(Math.max(Math.trunc(number), min), max)
}

/**
 * Validate one backup endpoint.
 *
 * Two shapes are legal: a bare OSS host (`oss-cn-hangzhou.aliyuncs.com`,
 * virtual-hosted style) and a full http(s) URL (a path-style gateway). A URL
 * carrying credentials is refused: `fetch` rejects those anyway, and it is the
 * shape that makes a typo send the signature and the key id somewhere else.
 *
 * @param {unknown} value - The raw value.
 * @returns {string} The normalised endpoint, or `''` when unusable.
 */
function normalizeEndpoint(value) {
	const raw = readString(value, '', 200).replace(/\/+$/, '')
	if (raw === '') return ''
	if (raw.includes('://')) {
		try {
			const url = new URL(raw)
			if (url.username !== '' || url.password !== '') return ''
			if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
			// The signature covers `/<bucket>/<key>`: a gateway prefix or a
			// query string would change the request path and every upload would
			// answer 403 forever. Only a bare origin is a valid endpoint.
			if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return ''
			// Plain http is kept for a loopback gateway only; anywhere else the
			// signature would travel in clear text, so it is refused instead of
			// being silently rewritten behind the panel's back.
			const loopback = url.hostname === 'localhost' || url.hostname === '::1' || /^127\./.test(url.hostname)
			if (url.protocol === 'http:' && !loopback) return ''
			return raw
		} catch {
			return ''
		}
	}
	return /^[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?$/.test(raw) ? raw : ''
}

/**
 * Normalise one backup configuration.
 *
 * @param {unknown} value - The raw configuration.
 * @returns {object} The normalised configuration.
 */
/** @internal exported for tests */
export function normalizeBackup(value) {
	const source = value !== null && typeof value === 'object' ? value : {}
	const fallback = defaultBackup()
	const prefix = String(source.prefix ?? '').trim()
	const bucket = readString(source.bucket, fallback.bucket, 128)
	return {
		enabled: readBoolean(source.enabled, fallback.enabled),
		endpoint: normalizeEndpoint(source.endpoint),
		// A bucket name becomes a host label or a path segment; separators and
		// whitespace would silently produce a different URL than intended.
		bucket: /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(bucket) ? bucket : '',
		accessKeyId: readString(source.accessKeyId, fallback.accessKeyId, 128),
		accessKeySecret: readString(source.accessKeySecret, fallback.accessKeySecret, 256),
		prefix: PREFIX_PATTERN.test(prefix) ? prefix : fallback.prefix,
		keep: readInteger(source.keep, fallback.keep, KEEP_MIN, KEEP_MAX),
		intervalMinutes: readInteger(source.intervalMinutes, fallback.intervalMinutes, INTERVAL_MIN, INTERVAL_MAX),
	}
}

/**
 * Normalise one status block.
 *
 * @param {unknown} value - The raw status.
 * @returns {object} The normalised status.
 */
function normalizeStatus(value) {
	const source = value !== null && typeof value === 'object' ? value : {}
	const fallback = defaultStatus()
	return {
		lastAttemptAt: readString(source.lastAttemptAt, fallback.lastAttemptAt, 64),
		lastBackupAt: readString(source.lastBackupAt, fallback.lastBackupAt, 64),
		lastObjectKey: readString(source.lastObjectKey, fallback.lastObjectKey, 512),
		lastBytes: readInteger(source.lastBytes, fallback.lastBytes, 0, Number.MAX_SAFE_INTEGER),
		lastFiles: readInteger(source.lastFiles, fallback.lastFiles, 0, Number.MAX_SAFE_INTEGER),
		lastRemoved: readInteger(source.lastRemoved, fallback.lastRemoved, 0, Number.MAX_SAFE_INTEGER),
		lastError: readString(source.lastError, fallback.lastError, 400),
	}
}

/**
 * The settings store.
 */
export class SettingsStore {
	/**
	 * @param {{path: string, logger?: object}} deps - Where the file lives.
	 */
	constructor({ path, logger }) {
		this.path = path
		this.logger = logger
		this.data = defaultSettings()
		/** Why the settings file could not be used, for the panel and the log. */
		this.warning = ''
		/** Counts temp files so two saves in the same millisecond cannot collide. */
		this.writeSequence = 0
		/** Writes are serialised: two saves must rename in the order they queued. */
		this.queue = Promise.resolve()
	}

	/**
	 * Read the settings file, tolerating a missing or broken one.
	 *
	 * @returns {Promise<object>} The loaded settings.
	 */
	async load() {
		let raw
		try {
			raw = await readFile(this.path, 'utf8')
		} catch (error) {
			// A missing file is the normal first run. An unreadable one is not:
			// it silently sent the plugin to the default data folder, where a
			// custom-path library looks lost, so it has to be reported.
			const code = error !== null && typeof error === 'object' ? error.code : undefined
			if (code !== 'ENOENT') {
				const detail = error instanceof Error ? error.message : String(error)
				this.warning = `设置文件无法读取（${this.path}）：${detail}；已使用默认设置，数据目录回到默认位置。`
				this.logger?.warn?.(`dsh-evolver: ${this.warning}`)
			}
			return this.data
		}
		try {
			const parsed = JSON.parse(raw)
			this.data = {
				dataDir: typeof parsed?.dataDir === 'string' ? parsed.dataDir : '',
				cardMaxChars: normalizeCardMaxChars(parsed?.cardMaxChars),
				cardDescriptionMaxChars: normalizeCardDescriptionMaxChars(parsed?.cardDescriptionMaxChars),
				backup: normalizeBackup(parsed?.backup),
				status: normalizeStatus(parsed?.status),
				ingest: normalizeIngest(parsed?.ingest),
				consolidate: normalizeConsolidate(parsed?.consolidate),
				organize: normalizeOrganize(parsed?.organize),
			}
		} catch (error) {
			// Keep the broken file around: it explains what happened after a
			// hand edit went wrong, and it never contains anything to preserve
			// beyond what the user typed.
			this.warning = `设置文件无法解析（${this.path}）：${error instanceof Error ? error.message : String(error)}；已保留为 .broken，改用默认设置，数据目录回到默认位置。`
			this.logger?.warn?.(`dsh-evolver: ${this.warning}`)
			await rename(this.path, `${this.path}.broken`).catch(() => {})
			this.data = defaultSettings()
		}
		return this.data
	}

	/**
	 * The current settings object (read-only by convention).
	 *
	 * @returns {object} The settings.
	 */
	get() {
		return this.data
	}

	/**
	 * Apply one patch and persist it.
	 *
	 * Only the fields the panel may change are read; the secret is written
	 * only when the caller supplies a new one, and cleared only when asked.
	 *
	 * @param {{dataDir?: unknown, backup?: object}} patch - The change.
	 * @returns {Promise<object>} The updated settings.
	 */
	async update(patch = {}) {
		if (typeof patch.dataDir === 'string') {
			this.data.dataDir = patch.dataDir.trim()
		}
		if (patch.cardDescriptionMaxChars !== undefined) {
			this.data.cardDescriptionMaxChars = normalizeCardDescriptionMaxChars(patch.cardDescriptionMaxChars)
		}
		if (patch.cardMaxChars !== undefined) {
			this.data.cardMaxChars = normalizeCardMaxChars(patch.cardMaxChars)
		}
		const ingest = patch.ingest
		if (ingest !== null && typeof ingest === 'object') {
			this.data.ingest = normalizeIngest({ ...this.data.ingest, ...ingest })
		}
		const consolidate = patch.consolidate
		if (consolidate !== null && typeof consolidate === 'object') {
			this.data.consolidate = normalizeConsolidate({ ...this.data.consolidate, ...consolidate })
		}
		const organize = patch.organize
		if (organize !== null && typeof organize === 'object') {
			this.data.organize = normalizeOrganize({ ...this.data.organize, ...organize })
		}
		const backup = patch.backup
		if (backup !== null && typeof backup === 'object') {
			// An empty endpoint is "not configured"; a non-empty one that
			// normalises away is a typo, and silently storing '' would look
			// like the user never typed anything.
			const rawEndpoint = backup.endpoint
			if (typeof rawEndpoint === 'string' && rawEndpoint.trim() !== '' && normalizeEndpoint(rawEndpoint) === '') {
				throw new Error('备份 endpoint 不合法：只填主机名（如 oss-cn-hangzhou.aliyuncs.com）或 https://主机名；不要带路径、查询、账号或明文 http。')
			}
			const next = normalizeBackup({ ...this.data.backup, ...backup })
			// The secret is write-only from the browser's point of view.
			if (backup.clearAccessKeySecret === true) {
				next.accessKeySecret = ''
			} else if (typeof backup.accessKeySecret !== 'string' || backup.accessKeySecret.trim() === '') {
				next.accessKeySecret = this.data.backup.accessKeySecret
			}
			this.data.backup = next
		}
		await this.save()
		return this.data
	}

	/**
	 * Update the status block and persist it.
	 *
	 * @param {object} patch - The status fields to change.
	 * @returns {Promise<object>} The updated status.
	 */
	async updateStatus(patch = {}) {
		this.data.status = normalizeStatus({ ...this.data.status, ...patch })
		await this.save()
		return this.data.status
	}

	/**
	 * Write the settings file atomically.
	 *
	 * @returns {Promise<void>} Resolves once the file is committed.
	 */
	async save() {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
		this.writeSequence += 1
		const sequence = this.writeSequence
		// The snapshot is taken now (the caller just mutated this.data); only
		// the disk write is queued. A backup status update and a panel save can
		// then never rename over each other out of order and lose a field.
		const text = `${JSON.stringify(this.data, null, 2)}\n`
		const write = async () => {
			const temp = `${this.path}.${process.pid}.${Date.now()}.${sequence}.tmp`
			try {
				await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
				await rename(temp, this.path)
			} catch (error) {
				await rm(temp, { force: true }).catch(() => {})
				throw error
			}
		}
		this.queue = this.queue.then(write, write)
		return this.queue
	}

	/**
	 * The panel's view: everything except the secret itself.
	 *
	 * @param {{root: string, source: string, warning: string, defaultRoot: string}} rootInfo - Where the data currently lives.
	 * @returns {object} The public view.
	 */
	publicView(rootInfo) {
		const backup = this.data.backup
		const archiveDir = dirname(rootInfo.root)
		const archiveName = suggestedArchiveName()
		return {
			dataDir: rootInfo.root,
			cardMaxChars: this.data.cardMaxChars,
			cardDescriptionMaxChars: this.data.cardDescriptionMaxChars,
			dataDirSource: rootInfo.source,
			backupRunning: rootInfo.backupRunning === true,
			dataDirWarning: rootInfo.warning ?? '',
			defaultDataDir: rootInfo.defaultRoot,
			storedDataDir: this.data.dataDir,
			settingsPath: this.path,
			// Next to the data folder, not inside it: a local export must not
			// end up in the next export. The folder and the name are separate
			// so the panel can offer a directory picker plus a name field; both
			// come from one timestamp so the full path always agrees.
			suggestedArchive: join(archiveDir, archiveName),
			suggestedArchiveDir: archiveDir,
			suggestedArchiveName: archiveName,
			backup: {
				enabled: backup.enabled,
				endpoint: backup.endpoint,
				bucket: backup.bucket,
				accessKeyId: backup.accessKeyId,
				hasAccessKeySecret: backup.accessKeySecret !== '',
				prefix: backup.prefix,
				keep: backup.keep,
				intervalMinutes: backup.intervalMinutes,
			},
			status: { ...this.data.status },
			ingest: { ...this.data.ingest },
			consolidate: { ...this.data.consolidate },
			organize: { ...this.data.organize },
		}
	}
}
