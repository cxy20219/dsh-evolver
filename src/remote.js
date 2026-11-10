/**
 * The browser-facing face of the evolver.
 *
 * The panel is a client plugin, so it needs the same data the agent sees.
 * The sanctioned channel is the Host's Connection service: one authenticated
 * API prefix (`/api/evolver`) that this plugin owns end to end.
 *
 * Every endpoint takes plain JSON and answers plain JSON. The endpoint names
 * stay stable across Host reloads, so the browser artifact never has to be
 * reloaded with the Host.
 */

import { KINDS } from './practice.js'

/** The endpoints the browser may call. */
export const ENDPOINTS = [
	'overview',
	'injection',
	'practice',
	'practice-read',
	'practice-write',
	'practice-delete',
	'practice-query',
	'soul',
	'soul-save',
	'preferences',
	'preferences-save',
	'preferences-link',
	'preferences-unlink',
	'memory-list',
	'memory-recall',
	'memory-save',
	'memory-forget',
	'memory-stats',
	'settings',
	'settings-save',
	'data-migrate',
	'data-export',
	'data-import',
	'backup-now',
	'backup-test',
]

/**
 * Turn a thrown value into a wire-safe failure.
 *
 * @param {unknown} error - The thrown value.
 * @returns {{code: string, message: string, details: object}} The failure payload.
 */
function failure(error) {
	const message = error instanceof Error ? error.message : String(error)
	return { code: 'evolver/error', message, details: {} }
}

/**
 * Read one string field from a request payload.
 *
 * @param {unknown} payload - The request payload.
 * @param {string} field - Field name.
 * @param {string} fallback - Value used when the field is absent.
 * @returns {string} The field's value.
 */
function text(payload, field, fallback = '') {
	const value = payload?.[field]
	return typeof value === 'string' ? value : fallback
}

/**
 * Read one bounded count from a request payload.
 *
 * A missing or non-numeric field falls back to the default instead of turning
 * into `NaN`, which `slice` reads as zero and silently answers with nothing.
 *
 * @param {unknown} payload - The request payload.
 * @param {string} field - Field name.
 * @param {number} fallback - Value used when the field is absent or invalid.
 * @param {number} max - The largest accepted value.
 * @returns {number} The count.
 */
function count(payload, field, fallback, max) {
	const value = payload?.[field]
	if (value === undefined || value === null || value === '') return fallback
	const number = Number(value)
	if (!Number.isFinite(number)) return fallback
	return Math.min(Math.max(Math.trunc(number), 1), max)
}

/**
 * Build the endpoint handler for the evolver.
 *
 * @param {{evolver: object, memory: object}} deps - The evolver and the memory actions.
 * @returns {(endpoint: string, payload: unknown) => Promise<object>} The handler.
 */
export function createEvolverHandler({ evolver, memory, settings, backup, workspace, view }) {
	return async function handleEvolver(endpoint, payload) {
		try {
			switch (endpoint) {
				case 'overview': {
					return { ok: true, value: await evolver.overview() }
				}
				case 'injection': {
					return { ok: true, value: await evolver.injectionPreview() }
				}
				case 'practice': {
					const state = await evolver.practice()
					return {
						ok: true,
						value: {
							kinds: KINDS.map((kind) => ({ id: kind.id, title: kind.title })),
							entries: state.entries.map((entry) => ({
								kind: entry.kind,
								kindTitle: entry.kindTitle,
								topic: entry.topic,
								topicSlug: entry.topicSlug,
								name: entry.name,
								title: entry.title,
								purpose: entry.purpose,
								path: entry.relPath,
								verified: entry.verified,
								bytes: entry.bytes,
								updatedAt: entry.updatedAt,
							})),
							problems: state.problems,
							projection: state.projection,
						},
					}
				}
				case 'practice-read': {
					return { ok: true, value: await evolver.practiceRead(text(payload, 'path')) }
				}
				case 'practice-write': {
					return {
						ok: true,
						value: await evolver.practiceWrite({
							kind: text(payload, 'kind'),
							name: text(payload, 'name'),
							title: text(payload, 'title'),
							purpose: text(payload, 'purpose'),
							topic: text(payload, 'topic'),
							body: text(payload, 'body'),
							verified: text(payload, 'verified'),
							links: Array.isArray(payload?.links) ? payload.links : [],
						}),
					}
				}
				case 'practice-delete': {
					return { ok: true, value: await evolver.practiceDelete(text(payload, 'path')) }
				}
				case 'practice-query': {
					const results = await evolver.practiceSearch(text(payload, 'query'), {
						kind: text(payload, 'kind'),
						limit: count(payload, 'limit', 8, 50),
					})
					return { ok: true, value: { total: results.length, results } }
				}
				case 'soul': {
					return { ok: true, value: await evolver.soulRead() }
				}
				case 'soul-save': {
					return { ok: true, value: await evolver.soulWrite(text(payload, 'content')) }
				}
				case 'preferences': {
					return { ok: true, value: await evolver.preferencesRead() }
				}
				case 'preferences-save': {
					return { ok: true, value: await evolver.preferencesWrite(text(payload, 'content')) }
				}
				case 'preferences-link': {
					return { ok: true, value: await evolver.linkGlobal() }
				}
				case 'preferences-unlink': {
					return { ok: true, value: await evolver.unlinkGlobal() }
				}
				case 'memory-list': {
					return { ok: true, value: memory.list(payload ?? {}) }
				}
				case 'memory-recall': {
					return { ok: true, value: await memory.recall(payload ?? {}) }
				}
				case 'memory-save': {
					return { ok: true, value: await memory.save(payload ?? {}) }
				}
				case 'memory-forget': {
					return { ok: true, value: await memory.forget(payload ?? {}) }
				}
				case 'memory-stats': {
					return { ok: true, value: memory.stats() }
				}
				case 'settings': {
					return { ok: true, value: view() }
				}
				case 'settings-save': {
					// Only the backup block is mutable here: the data folder has
					// its own endpoint, because moving it has to copy and reopen.
					await settings.update({ backup: payload?.backup ?? {} })
					return { ok: true, value: view() }
				}
				case 'data-migrate': {
					const moved = await workspace.migrate(text(payload, 'dir'), { force: payload?.force === true })
					return { ok: true, value: { ...moved, settings: view() } }
				}
				case 'data-export': {
					return { ok: true, value: await workspace.exportTo(text(payload, 'dir'), { force: payload?.force === true }) }
				}
				case 'data-import': {
					const imported = await workspace.importFrom(text(payload, 'dir'), { force: payload?.force === true })
					return { ok: true, value: { ...imported, settings: view() } }
				}
				case 'backup-now': {
					const backupResult = await backup.runNow({ force: payload?.force === true, reason: 'manual' })
					return { ok: true, value: { ...backupResult, settings: view() } }
				}
				case 'backup-test': {
					return { ok: true, value: await backup.testConnection() }
				}
				default: {
					return {
						ok: false,
						error: { code: 'evolver/unknown-endpoint', message: `未知接口：${endpoint}`, details: {} },
					}
				}
			}
		} catch (error) {
			return { ok: false, error: failure(error) }
		}
	}
}
