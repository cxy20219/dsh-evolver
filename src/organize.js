/**
 * The model the two unattended organisers run on.
 *
 * The session ingest and the daily card review both call a model on their own
 * schedule; neither is part of a chat session, so "the model the session uses"
 * is a default, not a decision anyone made for them. One setting covers both:
 * they are the same kind of job — cheap, whole-library, unattended — and two
 * identical selectors would only invite the two to drift apart.
 *
 * `null` means "follow the chat". It is read at call time rather than copied
 * when the run starts, so a default the user changes in the chat applies to the
 * next run by itself, without touching this setting.
 */

/** How long the model catalogue is reused. */
const MODEL_CACHE_MS = 5 * 60_000

/**
 * The selection one organiser run should use.
 *
 * @param {object} settings - The settings store.
 * @param {object | undefined} modelSelection - The Host `agentDefaultModel` service.
 * @returns {{provider: string, model: string, reasoningEffort?: string}} The selection, possibly empty.
 */
export function resolveOrganizerModel(settings, modelSelection) {
	const configured = settings?.get?.()?.organize?.model ?? null
	if (configured !== null) return configured
	const fallback = modelSelection?.currentSelection?.() ?? {}
	const effort = typeof fallback.reasoningEffort === 'string' ? fallback.reasoningEffort : ''
	return {
		provider: typeof fallback.provider === 'string' ? fallback.provider : '',
		model: typeof fallback.model === 'string' ? fallback.model : '',
		...(effort === '' ? {} : { reasoningEffort: effort }),
	}
}

/**
 * Every routable provider, its models, and each model's reasoning levels.
 *
 * The panel cannot ask the host directly, so this is the one place the
 * catalogue crosses over. A provider or model the adapter refuses is left out
 * rather than failing the whole list: a broken route must not hide the healthy
 * ones behind an empty select.
 *
 * @param {object | undefined} llm - The Host `llm` service.
 * @returns {Promise<object[]>} The provider groups, possibly empty.
 */
async function readProviders(llm) {
	if (typeof llm?.listProviders !== 'function') return []
	let listed = []
	try {
		listed = await llm.listProviders()
	} catch {
		return []
	}
	const providers = []
	for (const provider of Array.isArray(listed) ? listed : []) {
		let entries = []
		try {
			entries = await llm.listModels(provider.id)
		} catch {
			entries = []
		}
		const models = []
		for (const model of Array.isArray(entries) ? entries : []) {
			let reasoning = null
			try {
				const resolved = await llm.resolveModelInfo(provider.id, model.id)
				const levels = resolved?.reasoning?.efforts
				if (Array.isArray(levels) && levels.length > 0) {
					reasoning = {
						efforts: levels.map((effort) => ({ id: String(effort.id), name: String(effort.name) })),
						defaultEffort: typeof resolved.reasoning.defaultEffort === 'string' ? resolved.reasoning.defaultEffort : null,
					}
				}
			} catch {
				reasoning = null
			}
			models.push({ id: String(model.id), name: String(model.name ?? model.id), reasoning })
		}
		providers.push({ id: String(provider.id), name: String(provider.name ?? provider.id), models })
	}
	return providers
}

/**
 * The organise page's model settings: what is saved, what would actually run,
 * and what the host can route.
 *
 * @param {object} options - Services.
 * @param {object} options.settings - The settings store.
 * @param {object | undefined} options.llm - The Host `llm` service.
 * @param {object | undefined} options.modelSelection - The Host `agentDefaultModel` service.
 * @param {() => number} [options.now] - Clock.
 * @returns {object} The controller: `status` and `save`.
 */
export function createOrganizeSettings({ settings, llm, modelSelection, now = () => Date.now() }) {
	/** The last catalogue handed to the panel, with the time it was read. */
	let cache = null

	/**
	 * Read the saved setting, the effective model and the catalogue.
	 *
	 * @returns {Promise<object>} `{model, current, providers}`.
	 */
	async function status() {
		const saved = settings.get().organize?.model ?? null
		const effective = resolveOrganizerModel(settings, modelSelection)
		const current = effective.provider === '' || effective.model === ''
			? null
			: { ...effective }
		const providers = cache !== null && now() - cache.at < MODEL_CACHE_MS
			? cache.providers
			: await readProviders(llm)
		if (cache === null || now() - cache.at >= MODEL_CACHE_MS) cache = { at: now(), providers }
		return { model: saved, current, providers }
	}

	/**
	 * Persist one change and answer with the new status.
	 *
	 * @param {object} patch - The partial `organize` block.
	 * @returns {Promise<object>} The new status.
	 */
	async function save(patch) {
		await settings.update({ organize: patch ?? {} })
		return status()
	}

	return { status, save }
}
