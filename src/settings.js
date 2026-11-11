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
import { dirname, isAbsolute, join } from 'node:path'

/** How many searches may be stored remotely. */
const KEEP_MIN = 1
const KEEP_MAX = 60

/** The shortest and longest automatic backup interval, in minutes. */
const INTERVAL_MIN = 5
const INTERVAL_MAX = 10_080

/** A backup prefix is one safe object-name segment. */
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** An access key id is an identifier, not a secret, but still has a shape. */
const KEY_ID_PATTERN = /^[A-Za-z0-9_=+-]{3,128}$/

/**
 * The default backup configuration.
 *
 * @returns {object} A fresh object.
 */
export function defaultBackup() {
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
export function defaultStatus() {
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
export function normalizeIngest(value, fallback = defaultIngest()) {
	const source = value !== null && typeof value === 'object' ? value : {}
	const minutes = Math.round(Number(source.idleMinutes))
	return {
		enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
		idleMinutes: Number.isFinite(minutes) ? Math.min(240, Math.max(5, minutes)) : fallback.idleMinutes,
	}
}

/** The most cards one daily consolidation may take. */
const CONSOLIDATE_MAX = 100

/**
 * The default daily card consolidation.
 *
 * Off by default: it rewrites and deletes cards, so it is switched on
 * deliberately rather than as a surprise after an upgrade.
 *
 * @returns {object} A fresh object.
 */
export function defaultConsolidate() {
	return { enabled: false, dailyCards: 15, hour: 3 }
}

/**
 * Normalise the daily card consolidation.
 *
 * @param {unknown} value - The raw value.
 * @param {object} [fallback] - What to use for missing fields.
 * @returns {object} The normalised value.
 */
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
export function defaultCardMaxChars() {
	return 1000
}
/**
 * Normalise the card body budget.
 *
 * @param {unknown} value - The raw value.
 * @returns {number} A number between 200 and 4000.
 */
export function normalizeCardMaxChars(value) {
	const size = Math.round(Number(value))
	if (!Number.isFinite(size)) return defaultCardMaxChars()
	return Math.min(4000, Math.max(200, size))
}

/**
 * The default settings.
 *
 * @returns {object} A fresh object.
 */
export function defaultSettings() {
	return {
		dataDir: '',
		cardMaxChars: defaultCardMaxChars(),
		backup: defaultBackup(),
		status: defaultStatus(),
		ingest: defaultIngest(),
		consolidate: defaultConsolidate(),
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
 * Normalise one backup configuration.
 *
 * @param {unknown} value - The raw configuration.
 * @returns {object} The normalised configuration.
 */
export function normalizeBackup(value) {
	const source = value !== null && typeof value === 'object' ? value : {}
	const fallback = defaultBackup()
	const prefix = String(source.prefix ?? '').trim()
	const bucket = readString(source.bucket, fallback.bucket, 128)
	return {
		enabled: readBoolean(source.enabled, fallback.enabled),
		endpoint: readString(source.endpoint, fallback.endpoint, 200).replace(/\/+$/, ''),
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
export function normalizeStatus(value) {
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
		/** Counts temp files so two saves in the same millisecond cannot collide. */
		this.writeSequence = 0
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
		} catch {
			return this.data
		}
		try {
			const parsed = JSON.parse(raw)
			this.data = {
				dataDir: typeof parsed?.dataDir === 'string' ? parsed.dataDir : '',
				cardMaxChars: normalizeCardMaxChars(parsed?.cardMaxChars),
				backup: normalizeBackup(parsed?.backup),
				status: normalizeStatus(parsed?.status),
				ingest: normalizeIngest(parsed?.ingest),
				consolidate: normalizeConsolidate(parsed?.consolidate),
			}
		} catch (error) {
			// Keep the broken file around: it explains what happened after a
			// hand edit went wrong, and it never contains anything to preserve
			// beyond what the user typed.
			this.logger?.warn?.(`dsh-evolver: 设置文件无法解析，改用默认设置：${error instanceof Error ? error.message : String(error)}`)
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
		const backup = patch.backup
		if (backup !== null && typeof backup === 'object') {
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
		const temp = `${this.path}.${process.pid}.${Date.now()}.${this.writeSequence}.tmp`
		try {
			await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
			await rename(temp, this.path)
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {})
			throw error
		}
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
			dataDirSource: rootInfo.source,
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

		}
	}
}
