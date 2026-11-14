/**
 * The model the unattended organizer runs on.
 *
 * Organizing is not part of a chat session, so "the model the session uses" is
 * a default, not a decision anyone made for the job. One setting covers every
 * kind of organize run: they are the same kind of work — whole-library,
 * unattended — and two identical selectors would only invite the two to drift
 * apart.
 *
 * `null` means "follow the chat". It is read at call time rather than copied
 * when a job starts, so a default the user changes in the chat applies to the
 * next run by itself, without touching this setting.
 */

/** How long the model catalogue is reused. */
export const MODEL_CACHE_MS = 5 * 60_000

/** The longest provider/model id kept from the catalogue. */
const ID_MAX = 200

/**
 * The selection one organize run should use.
 *
 * @param {object} settings - The settings store.
 * @param {object | undefined} modelSelection - The Host `agentDefaultModel` service.
 * @returns {{provider: string, model: string, reasoningEffort?: string}} The selection, possibly empty.
 */
export function resolveOrganizerModel(settings, modelSelection) {
	const configured = settings?.get?.()?.organize?.model ?? null
	if (configured !== null) return { ...configured }
	const fallback = modelSelection?.currentSelection?.() ?? {}
	const effort = typeof fallback.reasoningEffort === 'string' ? fallback.reasoningEffort : ''
	return {
		provider: typeof fallback.provider === 'string' ? fallback.provider : '',
		model: typeof fallback.model === 'string' ? fallback.model : '',
		...(effort === '' ? {} : { reasoningEffort: effort }),
	}
}

/**
 * One adapter-owned reasoning level, trimmed to what a selector needs.
 *
 * @param {unknown} effort - A resolved `LlmReasoningEffortInfo`.
 * @returns {null | {id: string, name: string}} The entry.
 */
function reasoningEffort(effort) {
	if (effort === null || typeof effort !== 'object') return null
	const id = typeof effort.id === 'string' ? effort.id : ''
	if (id === '') return null
	const name = typeof effort.name === 'string' && effort.name !== '' ? effort.name : id
	return { id: id.slice(0, ID_MAX), name: name.slice(0, ID_MAX) }
}

/**
 * Every routable provider, its models, and each model's reasoning levels.
 *
 * The panel cannot ask the host directly, so this is the one place the
 * catalogue crosses over. A provider or model the adapter refuses is left out
 * rather than failing the whole list: a broken route must not hide the healthy
 * ones behind an empty select. Each model keeps its full reasoning catalog —
 * a selector that silently loses a level cannot offer it back.
 *
 * @param {object | undefined} llm - The Host `llm` service.
 * @returns {Promise<{providers: object[], failed: boolean}>} The provider groups, and whether the catalogue itself could not be read.
 */
async function readProviders(llm) {
	if (typeof llm?.listProviders !== 'function') return { providers: [], failed: true }
	let listed = []
	try {
		listed = await llm.listProviders()
	} catch {
		return { providers: [], failed: true }
	}
	const providers = []
	for (const provider of Array.isArray(listed) ? listed : []) {
		const providerId = typeof provider?.id === 'string' ? provider.id : ''
		if (providerId === '') continue
		let entries = []
		try {
			entries = await llm.listModels(providerId)
		} catch {
			entries = []
		}
		const models = []
		for (const model of Array.isArray(entries) ? entries : []) {
			const modelId = typeof model?.id === 'string' ? model.id : ''
			if (modelId === '') continue
			const name = typeof model.name === 'string' && model.name !== '' ? model.name : modelId
			let reasoning = null
			try {
				const resolved = await llm.resolveModelInfo(providerId, modelId)
				const efforts = Array.isArray(resolved?.reasoning?.efforts)
					? resolved.reasoning.efforts.map(reasoningEffort).filter((effort) => effort !== null)
					: []
				if (efforts.length > 0) {
					const fallback = typeof resolved.reasoning.defaultEffort === 'string'
						? resolved.reasoning.defaultEffort
						: ''
					reasoning = {
						efforts,
						defaultEffort: fallback === '' ? null : fallback.slice(0, ID_MAX),
					}
				}
			} catch {
				reasoning = null
			}
			models.push({
				id: modelId.slice(0, ID_MAX),
				name: name.slice(0, ID_MAX),
				reasoning,
			})
		}
		providers.push({
			id: providerId.slice(0, ID_MAX),
			name: (typeof provider.name === 'string' && provider.name !== '' ? provider.name : providerId).slice(0, ID_MAX),
			models,
		})
	}
	return { providers, failed: false }
}

/**
 * The organize page's model settings: what is saved, what would actually run,
 * and what the host can route.
 *
 * @param {object} options - Services.
 * @param {object} options.settings - The settings store.
 * @param {object | undefined} options.llm - The Host `llm` service.
 * @param {object | undefined} options.modelSelection - The Host `agentDefaultModel` service.
 * @param {() => number} [options.now] - Clock.
 * @returns {{status: () => Promise<object>, save: (patch?: object) => Promise<object>, effective: () => object}} The controller.
 */
export function createOrganizeSettings({ settings, llm, modelSelection, now = () => Date.now() }) {
	/** The last catalogue handed to the panel, with the time it was read. */
	let cache = null

	/**
	 * The selection one run would use right now.
	 *
	 * @returns {{provider: string, model: string, reasoningEffort?: string}} The selection, possibly empty.
	 */
	function effective() {
		return resolveOrganizerModel(settings, modelSelection)
	}

	/**
	 * Read the saved setting, the effective model and the catalogue.
	 *
	 * @returns {Promise<object>} `{model, current, followsChat, providers, catalogFailed}`.
	 */
	async function status() {
		const saved = settings.get().organize?.model ?? null
		const effectiveModel = effective()
		const current = effectiveModel.provider === '' || effectiveModel.model === ''
			? null
			: { ...effectiveModel }
		const fresh = cache !== null && now() - cache.at < MODEL_CACHE_MS
		let providers = fresh ? cache.providers : []
		let catalogFailed = false
		if (!fresh) {
			const read = await readProviders(llm)
			catalogFailed = read.failed
			// A failed read keeps the last good catalogue (and does not replace it
			// with the empty list), so one adapter hiccup does not make the panel
			// claim there are no models for five minutes.
			providers = read.failed && cache !== null ? cache.providers : read.providers
			if (!read.failed) cache = { at: now(), providers }
		}
		return {
			model: saved,
			current,
			followsChat: saved === null,
			providers,
			catalogFailed,
		}
	}

	/**
	 * Persist one change and answer with the new status.
	 *
	 * `model: null` returns to following the chat. The value is normalised by
	 * the settings store, so a half-filled selection becomes `null` rather than
	 * a selection that can never run.
	 *
	 * @param {object} [patch] - `{model}` or `{organize: {model}}`.
	 * @returns {Promise<object>} The new status.
	 */
	async function save(patch = {}) {
		const hasModel = Object.prototype.hasOwnProperty.call(patch ?? {}, 'model')
			|| Object.prototype.hasOwnProperty.call(patch?.organize ?? {}, 'model')
		if (hasModel) {
			const next = Object.prototype.hasOwnProperty.call(patch, 'model') ? patch.model : patch.organize.model
			await settings.save({ organize: { model: next ?? null } })
		}
		return status()
	}

	return { status, save, effective }
}
