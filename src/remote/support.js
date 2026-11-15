/**
 * Payload and path helpers shared by the panel domain modules.
 *
 * These are pure: no module-level state, no service access. A domain handler
 * receives the request payload and the assembled dependency bag, and uses
 * these to read the shape the panel sends.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The DeepSeek Harness home, resolved the same way the host resolves it.
 *
 * @returns {string} The absolute path.
 */
export function dshHome() {
	return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
		? process.env.DSH_HOME
		: join(homedir(), '.dsh')
}

/**
 * Read one string field.
 *
 * @param {object} payload - The request payload.
 * @param {string} field - The field name.
 * @param {string} [fallback] - Used when the field is absent.
 * @returns {string} The field value.
 */
export function text(payload, field, fallback = '') {
	const value = payload?.[field]
	return typeof value === 'string' ? value : fallback
}

/**
 * Read one array field, accepting a comma-separated string too.
 *
 * @param {object} payload - The request payload.
 * @param {string} field - The field name.
 * @returns {string[] | undefined} The array, or undefined when absent.
 */
export function list(payload, field) {
	const value = payload?.[field]
	if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
	if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter((item) => item !== '')
	return undefined
}

/**
 * Resolve a full id or a unique suffix.
 *
 * @param {object} store - The file store.
 * @param {unknown} value - The id or suffix.
 * @returns {string} The full id, or the raw string when it is already full.
 */
export function resolveId(store, value) {
	const raw = String(value ?? '').trim()
	if (raw === '') return ''
	const resolved = store.resolveId(raw)
	return resolved ?? raw
}

/**
 * A file without its body text, for list/write responses.
 *
 * @param {object} file - A file as `read()` returns it.
 * @returns {object} The summary.
 */
export function summary(file) {
	if (file === null || typeof file !== 'object') return file
	const { text: _text, ...rest } = file
	void _text
	return rest
}
