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

/** The endpoints the browser may call. */
export const ENDPOINTS = [
	'overview',
	'injection',
	'soul',
	'soul-save',
	'preferences',
	'preferences-save',
	'preferences-link',
	'preferences-unlink',
	'settings',
	'settings-save',
	'data-migrate',
	'data-export',
	'data-import',
	'data-archives',
	'backup-now',
	'backup-test',
	'embedding-status',
	'embedding-save',
	'embedding-download',
	'embedding-cancel',
	'embedding-test',
	'ingest-status',
	'ingest-save',
	'ingest-run',
	'consolidate-status',
	'consolidate-save',
	'consolidate-run',
	'card-status',
	'card-list',
	'card-read',
	'card-write',
	'card-promote',
	'card-archive',
	'card-remove',
	'card-attach',
	'card-tags',
	'tag-descriptions',
	'tag-descriptions-save',
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
 * @param {{evolver: object, settings: object, backup: object, workspace: object, view: Function, embedding: object, ingest: object, cards: object}} deps - The services the endpoints use.
 * @returns {(endpoint: string, payload: unknown) => Promise<object>} The handler.
 */
export function createEvolverHandler({ evolver, settings, backup, workspace, view, embedding, ingest, consolidate, cards }) {
	return async function handleEvolver(endpoint, payload) {
		try {
			switch (endpoint) {
				case 'overview': {
					return { ok: true, value: await cards.overview() }
				}
				case 'injection': {
					return { ok: true, value: await cards.injection() }
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
				case 'settings': {
					return { ok: true, value: view() }
				}
				case 'settings-save': {
					// The backup block and the card budget are mutable here: the
					// data folder has its own endpoint, because moving it has to
					// copy and reopen.
					const patch = { backup: payload?.backup ?? {} }
					if (payload?.cardMaxChars !== undefined) patch.cardMaxChars = payload.cardMaxChars
					await settings.update(patch)
					cards.setCardMaxChars?.(settings.get().cardMaxChars)
					return { ok: true, value: view() }
				}
				case 'data-migrate': {
					const moved = await workspace.migrate(text(payload, 'dir'), { force: payload?.force === true })
					return { ok: true, value: { ...moved, settings: view() } }
				}
				case 'data-export': {
					return {
						ok: true,
						value: await workspace.exportTo({
							file: text(payload, 'file'),
							dir: text(payload, 'dir'),
							name: text(payload, 'name'),
							force: payload?.force === true,
						}),
					}
				}
				case 'data-archives': {
					return { ok: true, value: await workspace.listArchives(text(payload, 'dir')) }
				}
				case 'data-import': {
					const imported = await workspace.importFrom(text(payload, 'file'), { force: payload?.force === true })
					return { ok: true, value: { ...imported, settings: view() } }
				}
				case 'backup-now': {
					const backupResult = await backup.runNow({ force: payload?.force === true, reason: 'manual' })
					return { ok: true, value: { ...backupResult, settings: view() } }
				}
				case 'backup-test': {
					return { ok: true, value: await backup.testConnection() }
				}
				case 'embedding-status': {
					return { ok: true, value: await embedding.status() }
				}
				case 'embedding-save': {
					return { ok: true, value: await embedding.save(payload?.embedding ?? {}) }
				}
				case 'embedding-download': {
					return { ok: true, value: await embedding.download(text(payload, 'model')) }
				}
				case 'embedding-cancel': {
					return { ok: true, value: await embedding.cancel() }
				}
				case 'ingest-status': {
					return { ok: true, value: await ingest.status() }
				}
				case 'ingest-save': {
					return { ok: true, value: await ingest.save(payload?.ingest ?? {}) }
				}
				case 'ingest-run': {
					return { ok: true, value: await ingest.run() }
				}
				case 'consolidate-status': {
					return { ok: true, value: await consolidate.status() }
				}
				case 'consolidate-save': {
					return { ok: true, value: await consolidate.save(payload?.consolidate ?? {}) }
				}
				case 'consolidate-run': {
					return { ok: true, value: await consolidate.run() }
				}
				case 'card-status': {
					return { ok: true, value: await cards.status() }
				}
				case 'card-list': {
					return { ok: true, value: await cards.list(payload ?? {}) }
				}
				case 'card-read': {
					return { ok: true, value: await cards.read(payload ?? {}) }
				}
				case 'card-write': {
					return { ok: true, value: await cards.write(payload ?? {}) }
				}
				case 'card-promote': {
					return { ok: true, value: await cards.promote(payload ?? {}) }
				}
				case 'card-archive': {
					return { ok: true, value: await cards.archive(payload ?? {}) }
				}
				case 'card-remove': {
					return { ok: true, value: await cards.remove(payload ?? {}) }
				}
				case 'card-attach': {
					return { ok: true, value: await cards.attach(payload ?? {}) }
				}
				case 'card-tags': {
					return { ok: true, value: cards.tags() }
				}
				case 'tag-descriptions': {
					return { ok: true, value: await cards.tagDescriptionsView() }
				}
				case 'tag-descriptions-save': {
					return { ok: true, value: await cards.saveTagDescriptions(payload?.descriptions ?? {}) }
				}
				case 'embedding-test': {
					return { ok: true, value: await embedding.test() }
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
