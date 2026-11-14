/**
 * Plugin settings.
 *
 * Everything the plugin owns lives under one data directory — including this
 * file. The directory is chosen by the panel pointer
 * (`~/.dsh/yuanshi.home.json`), then the composition (`config.dataDir`), then
 * the default `~/.dsh/yuanshi`. The pointer is the one exception beside the
 * folder; it contains only the absolute data path, so moving the folder still
 * moves the whole library.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic } from './atomic.js'

/** The settings schema version. */
export const SETTINGS_SCHEMA = 1

/** The longest a file description may be. */
const DESCRIPTION_MIN = 20
const DESCRIPTION_MAX = 200
const DESCRIPTION_DEFAULT = 160

/** Bounds for the payload budget. */
const MAX_BYTES_MIN = 1024 * 1024
const MAX_BYTES_MAX = 200 * 1024 * 1024
const MAX_BYTES_DEFAULT = 25 * 1024 * 1024

/** Bounds for the text returned by one read. */
const READ_BYTES_MIN = 4 * 1024
const READ_BYTES_MAX = 4 * 1024 * 1024
const READ_BYTES_DEFAULT = 256 * 1024

/** Bounds for the injected file index. */
const BUDGET_MIN = 1024
const BUDGET_MAX = 16 * 1024
const BUDGET_DEFAULT = 4096

/**
 * Clamp a number to a range.
 *
 * @param {unknown} value - The raw value.
 * @param {number} fallback - Used when the value is not a number.
 * @param {number} min - Inclusive minimum.
 * @param {number} max - Inclusive maximum.
 * @returns {number} The clamped number.
 */
function clamp(value, fallback, min, max) {
	const number = Math.round(Number(value))
	if (!Number.isFinite(number)) return fallback
	return Math.min(max, Math.max(min, number))
}

/**
 * Normalise one raw settings object.
 *
 * @param {object} raw - The parsed JSON.
 * @returns {object} The valid settings.
 */
function normalizeSettings(raw) {
	return {
		schema: SETTINGS_SCHEMA,
		descriptionMaxChars: clamp(raw?.descriptionMaxChars, DESCRIPTION_DEFAULT, DESCRIPTION_MIN, DESCRIPTION_MAX),
		maxFileBytes: clamp(raw?.maxFileBytes, MAX_BYTES_DEFAULT, MAX_BYTES_MIN, MAX_BYTES_MAX),
		readTextBytes: clamp(raw?.readTextBytes, READ_BYTES_DEFAULT, READ_BYTES_MIN, READ_BYTES_MAX),
		injectionBudget: clamp(raw?.injectionBudget, BUDGET_DEFAULT, BUDGET_MIN, BUDGET_MAX),
	}
}

/**
 * The settings store.
 */
export class SettingsStore {
	/**
	 * @param {{dataDir: string, logger?: object}} options - The data directory and a log sink.
	 */
	constructor({ dataDir, logger }) {
		this.dataDir = dataDir
		this.path = join(dataDir, 'system', 'settings.json')
		this.logger = logger
		this.values = normalizeSettings({})
	}

	/**
	 * Load the settings, creating the default file when it is missing.
	 *
	 * A malformed file is not fatal: the default settings are restored and the
	 * broken file is left in place for inspection.
	 *
	 * @returns {Promise<void>} Resolves when loaded.
	 */
	async load() {
		let text
		try {
			text = await readFile(this.path, 'utf8')
		} catch {
			text = undefined
		}
		if (text === undefined) {
			await this.save({})
			return
		}
		try {
			this.values = normalizeSettings(JSON.parse(text))
		} catch (error) {
			this.logger?.warn?.(`自衍中枢：settings.json 无法解析，已使用默认设置（${error instanceof Error ? error.message : String(error)}）`)
			this.values = normalizeSettings({})
		}
	}

	/**
	 * The current settings.
	 *
	 * @returns {object} A copy.
	 */
	get() {
		return { ...this.values }
	}

	/**
	 * Merge and persist a patch.
	 *
	 * @param {object} patch - The fields to change.
	 * @returns {Promise<object>} The new settings.
	 */
	async save(patch = {}) {
		this.values = normalizeSettings({ ...this.values, ...patch })
		await writeFileAtomic(this.path, `${JSON.stringify(this.values, null, '\t')}\n`)
		return this.get()
	}

	/**
	 * The panel-facing view.
	 *
	 * @returns {object} The settings plus their location.
	 */
	publicView() {
		return { ...this.get(), dataDir: this.dataDir, settingsPath: this.path }
	}
}
