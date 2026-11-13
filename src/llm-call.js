/**
 * One tool-free model call, shared by the two organisers.
 *
 * The session ingest and the daily review both ask a model for a small JSON
 * answer with no tools and no visible session. They used to carry two copies
 * of the streaming loop, which had to be kept in step by hand: `max-tokens`
 * ends the stream normally rather than as an error, and a reply that was cut
 * off has to say so, or it reads as "the model returned no JSON".
 */

import { resolveOrganizerModel } from './organize.js'
import { timeoutSignal } from './time.js'

/**
 * Ask the organiser model for one answer.
 *
 * @param {object} options - Services and request fields.
 * @param {object} options.settings - The settings store.
 * @param {object | undefined} options.llm - The Host `llm` service.
 * @param {object | undefined} options.modelSelection - The Host `agentDefaultModel` service.
 * @param {string} options.system - The system prompt.
 * @param {string} options.prompt - The user message.
 * @param {string} options.sessionId - The synthetic routing session id.
 * @param {number} options.maxTokens - The output budget.
 * @param {number} options.timeoutMs - The deadline for the whole call.
 * @returns {Promise<{text: string, truncated: boolean, selection: object}>} The reply.
 */
export async function callOrganizerModel({
	settings,
	llm,
	modelSelection,
	system,
	prompt,
	sessionId,
	maxTokens,
	timeoutMs,
}) {
	const selection = resolveOrganizerModel(settings, modelSelection)
	const provider = selection.provider
	const model = selection.model
	if (provider === '' || model === '') throw new Error('没有可用的默认模型；请先在聊天里选择模型。')
	const signal = timeoutSignal(timeoutMs)
	let text = ''
	let failure
	// `max-tokens` is not an error to the adapter: the stream ends normally and
	// whatever arrived is whatever fit. Reporting that as a plain "no JSON" is
	// how a truncated reply reads as a parsing bug.
	let truncated = false
	for await (const chunk of llm.stream({
		provider,
		model,
		...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
		// Some adapters route on the session header even though the call is
		// not part of a session; a stable synthetic id keeps the request
		// routable without creating a visible session.
		sessionId,
		system,
		messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
		temperature: 0,
		maxTokens,
		...(signal === undefined ? {} : { signal }),
	})) {
		if (chunk.type === 'text-delta') text += chunk.text
		if (chunk.type !== 'finish') continue
		const kind = chunk.reason?.kind
		if (kind === 'error' || kind === 'aborted') failure = chunk.reason.failure ?? chunk.reason
		if (kind === 'max-tokens') truncated = true
	}
	if (failure !== undefined) throw new Error(failure.message || '模型调用失败')
	return { text, truncated, selection }
}
