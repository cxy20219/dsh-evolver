/**
 * Plugin settings.
 *
 * Everything the plugin owns lives under one data directory — including this
 * file. The directory is chosen by the panel pointer
 * (`~/.dsh/ziyan.home.json`), then the composition (`config.dataDir`), then
 * the default `~/.dsh/ziyan`. The pointer is the one exception beside the
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

/** The longest provider/model id an organize run may name. */
const MODEL_ID_MAX = 200

/** Defaults and bounds for the automatic organizer. */
const AUTO_IDLE_MINUTES_DEFAULT = 30
const AUTO_IDLE_MINUTES_MIN = 5
const AUTO_IDLE_MINUTES_MAX = 240
const AUTO_FILES_HOUR_DEFAULT = 3
const AUTO_FILES_HOUR_MIN = 0
const AUTO_FILES_HOUR_MAX = 23

/**
 * Normalise the organize model selection.
 *
 * `null` means "follow the chat". A configured selection needs both a provider
 * and a model; anything half-filled degrades to `null` instead of failing the
 * whole settings file, because the host may have been configured before the
 * provider was known.
 *
 * @param {unknown} raw - The raw value from the settings file.
 * @returns {null | {provider: string, model: string, reasoningEffort?: string}} The selection.
 */
function normalizeOrganizeModel(raw) {
	if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null
	const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
	const model = typeof raw.model === 'string' ? raw.model.trim() : ''
	if (provider === '' || model === '') return null
	const effort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : ''
	return {
		provider: provider.slice(0, MODEL_ID_MAX),
		model: model.slice(0, MODEL_ID_MAX),
		...(effort === '' ? {} : { reasoningEffort: effort.slice(0, MODEL_ID_MAX) }),
	}
}

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
 * Normalise the automatic-organize switches.
 *
 * Both are off by default: a host that loads a new plugin version must never
 * start spending money just because the feature exists. The panel is the only
 * place that can switch them on. The idle window and the daily hour are clamped
 * rather than rejected, so a hand-edited settings file cannot make the
 * scheduler fire every few seconds or never.
 *
 * @param {unknown} raw - The raw `organize.auto` block.
 * @returns {{sessions: {enabled: boolean, idleMinutes: number}, files: {enabled: boolean, hour: number}}} The block.
 */
function normalizeOrganizeAuto(raw) {
	return {
		sessions: {
			enabled: raw?.sessions?.enabled === true,
			idleMinutes: clamp(raw?.sessions?.idleMinutes, AUTO_IDLE_MINUTES_DEFAULT, AUTO_IDLE_MINUTES_MIN, AUTO_IDLE_MINUTES_MAX),
		},
		files: {
			enabled: raw?.files?.enabled === true,
			hour: clamp(raw?.files?.hour, AUTO_FILES_HOUR_DEFAULT, AUTO_FILES_HOUR_MIN, AUTO_FILES_HOUR_MAX),
		},
	}
}

/**
 * The organize defaults.
 *
 * The model is the selection every run uses ("follow the chat" is `null`); the
 * `auto` half only says *when* the host may start a run by itself. With both
 * switches off nothing is scheduled, so a settings save can never schedule a
 * model call on its own.
 *
 * @param {unknown} raw - The raw `organize` block.
 * @returns {{model: null | {provider: string, model: string, reasoningEffort?: string}, auto: {sessions: {enabled: boolean, idleMinutes: number}, files: {enabled: boolean, hour: number}}}} The block.
 */
function normalizeOrganize(raw) {
	return {
		model: normalizeOrganizeModel(raw?.model),
		auto: normalizeOrganizeAuto(raw?.auto),
	}
}

/**
 * Merge one organize patch into the stored block.
 *
 * The organize block is the only nested object in the settings file, and the
 * store's `save()` is a shallow merge. Saving the model through a shallow
 * spread would silently reset the automatic switches (and saving a switch
 * would reset the model), so the two halves are merged field by field here.
 * An absent key means "leave it alone"; `model: null` still means "follow the
 * chat" and an unknown `auto` shape is ignored.
 *
 * @param {{model: unknown, auto: object}} current - The block on disk.
 * @param {unknown} patch - The incoming patch.
 * @returns {{model: unknown, auto: object}} The merged block.
 */
function mergeOrganize(current, patch) {
	const next = { ...current, auto: { ...current.auto, sessions: { ...current.auto.sessions }, files: { ...current.auto.files } } }
	if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return next
	if (Object.prototype.hasOwnProperty.call(patch, 'model')) next.model = patch.model
	const auto = patch.auto
	if (auto !== null && typeof auto === 'object' && !Array.isArray(auto)) {
		for (const kind of ['sessions', 'files']) {
			const part = auto[kind]
			if (part !== null && typeof part === 'object' && !Array.isArray(part)) {
				next.auto[kind] = { ...next.auto[kind], ...part }
			}
		}
	}
	return next
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
		organize: normalizeOrganize(raw?.organize),
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
	 * A patch that names `organize` is merged with the stored block (the only
	 * nested object in the file), so a panel save can change the model without
	 * resetting the automatic switches and vice versa.
	 *
	 * @param {object} patch - The fields to change.
	 * @returns {Promise<object>} The new settings.
	 */
	async save(patch = {}) {
		const next = { ...this.values, ...patch }
		if (patch !== null && typeof patch === 'object' && Object.prototype.hasOwnProperty.call(patch, 'organize')) {
			next.organize = mergeOrganize(this.values.organize, patch.organize)
		}
		this.values = normalizeSettings(next)
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
