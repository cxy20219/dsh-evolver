/**
 * An `llm` service that talks the OpenAI chat-completions wire protocol.
 *
 * The organizer was written against a host service with one method:
 * `llm.stream(...)` returns an async iterable of chunks. Anything that speaks
 * this protocol can fill that hole — OpenAI, a compatible gateway, a local
 * server (llama.cpp, Ollama, LM Studio) — which is why the standalone host only
 * needs a base URL, a key and a model name, not a vendor SDK.
 *
 * The chunk vocabulary is the organizer's, not OpenAI's:
 *
 *   {type: 'text-delta', text}                 streaming text
 *   {type: 'block-end', block}                 one finished block
 *   {type: 'finish', reason: {kind, failure?}} end of turn
 *
 * `block` is `{type: 'text', text}` or `{type: 'tool-call', id, name, arguments}`.
 * Rebuilding that from SSE is most of this file: OpenAI streams tool calls in
 * fragments keyed by index, with the id, the name and the JSON arguments each
 * arriving in pieces.
 */

/** How long one stream may take before the caller's signal is expected to fire. */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Turn the organizer's message shape into the wire shape.
 *
 * The organizer keeps content as typed blocks so a turn can mix text and tool
 * calls; the wire protocol wants flat `content` plus a `tool_calls` array, and
 * tool results as their own role.
 *
 * @param {object[]} messages - Organizer messages.
 * @returns {object[]} Wire messages.
 */
export function toWireMessages(messages) {
	const out = []
	for (const message of messages ?? []) {
		const content = Array.isArray(message?.content) ? message.content : []
		if (message?.role === 'assistant') {
			const text = content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('')
			const calls = content.filter((block) => block?.type === 'tool-call')
			const wire = { role: 'assistant', content: text === '' && calls.length > 0 ? null : text }
			if (calls.length > 0) {
				wire.tool_calls = calls.map((call, index) => ({
					id: typeof call.id === 'string' && call.id !== '' ? call.id : `call_${index}`,
					type: 'function',
					function: {
						name: call.name ?? '',
						arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
					},
				}))
			}
			out.push(wire)
			continue
		}
		if (message?.role === 'tool') {
			out.push({
				role: 'tool',
				tool_call_id: message.toolCallId ?? message.source?.callId ?? '',
				content: content.map((block) => block?.text ?? '').join(''),
			})
			continue
		}
		out.push({ role: message?.role ?? 'user', content: content.map((block) => block?.text ?? '').join('') })
	}
	return out
}

/**
 * Split a byte stream into SSE `data:` payloads.
 *
 * @param {ReadableStream<Uint8Array>} body - The response body.
 * @returns {AsyncGenerator<string>} One JSON string per event.
 */
async function* sseEvents(body) {
	const decoder = new TextDecoder()
	let buffer = ''
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true })
		let boundary = buffer.indexOf('\n\n')
		while (boundary !== -1) {
			const raw = buffer.slice(0, boundary)
			buffer = buffer.slice(boundary + 2)
			for (const line of raw.split('\n')) {
				const trimmed = line.trim()
				if (!trimmed.startsWith('data:')) continue
				const payload = trimmed.slice('data:'.length).trim()
				if (payload === '' || payload === '[DONE]') continue
				yield payload
			}
			boundary = buffer.indexOf('\n\n')
		}
	}
}

/**
 * Build the `llm` service.
 *
 * The connection is read through `config()` on every call rather than captured
 * once: the settings page can change the address, the key or the model while
 * the process is running, and a snapshot taken at start-up would keep using the
 * old values until a restart — which looks like "saving does nothing".
 *
 * @param {{config: () => {baseUrl: string, apiKey?: string, model?: string}, fetchImpl?: typeof fetch, timeoutMs?: number}} options - Connection settings source.
 * @returns {{stream: Function, listProviders: Function, listModels: Function, resolveModelInfo: Function}} The service.
 */
export function createOpenAiLlm({ config, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
	const read = () => {
		const current = config() ?? {}
		return {
			baseUrl: String(current.baseUrl ?? '').replace(/\/+$/, ''),
			apiKey: typeof current.apiKey === 'string' ? current.apiKey : '',
			model: typeof current.model === 'string' ? current.model : '',
		}
	}

	/**
	 * Run one streamed turn.
	 *
	 * @param {object} request - What the organizer sends.
	 * @returns {AsyncGenerator<object>} Chunks in the organizer's vocabulary.
	 */
	async function* stream({ model: requested, system, messages, tools = [], maxTokens = 4096, signal }) {
		const { baseUrl, apiKey, model } = read()
		const endpoint = `${baseUrl}/chat/completions`
		const chosen = typeof requested === 'string' && requested !== '' ? requested : model
		if (chosen === '') throw new Error('没有配置模型名：在设置里填一个 model。')
		const body = {
			model: chosen,
			stream: true,
			temperature: 0.2,
			max_tokens: maxTokens,
			messages: [
				...(typeof system === 'string' && system !== '' ? [{ role: 'system', content: system }] : []),
				...toWireMessages(messages),
			],
			...(tools.length === 0 ? {} : {
				tools: tools.map((tool) => ({
					type: 'function',
					function: { name: tool.name, description: tool.description, parameters: tool.parameters },
				})),
				tool_choice: 'auto',
			}),
		}

		const deadline = AbortSignal.timeout(timeoutMs)
		const composed = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
		let response
		try {
			response = await fetchImpl(endpoint, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
				},
				body: JSON.stringify(body),
				signal: composed,
			})
		} catch (error) {
			yield { type: 'finish', reason: { kind: 'error', failure: { message: `模型请求失败：${String(error?.message ?? error)}` } } }
			return
		}

		if (!response.ok || response.body === null) {
			const detail = await response.text().catch(() => '')
			yield {
				type: 'finish',
				reason: {
					kind: 'error',
					failure: { message: `模型返回 HTTP ${response.status}${detail === '' ? '' : `：${detail.slice(0, 300)}`}` },
				},
			}
			return
		}

		let text = ''
		// Tool calls arrive as fragments keyed by index: the id, the name and the
		// arguments JSON each come in pieces, and only the finished ones become
		// blocks.
		const pending = new Map()
		let finishKind = 'stop'

		try {
			for await (const payload of sseEvents(response.body)) {
				let event
				try {
					event = JSON.parse(payload)
				} catch {
					continue
				}
				const choice = event?.choices?.[0]
				if (choice === undefined) continue
				const delta = choice.delta ?? {}
				if (typeof delta.content === 'string' && delta.content !== '') {
					text += delta.content
					yield { type: 'text-delta', text: delta.content }
				}
				for (const call of delta.tool_calls ?? []) {
					const index = Number(call?.index ?? 0)
					const slot = pending.get(index) ?? { id: '', name: '', arguments: '' }
					if (typeof call?.id === 'string' && call.id !== '') slot.id = call.id
					if (typeof call?.function?.name === 'string' && call.function.name !== '') slot.name += call.function.name
					if (typeof call?.function?.arguments === 'string') slot.arguments += call.function.arguments
					pending.set(index, slot)
				}
				if (choice.finish_reason === 'length') finishKind = 'max-tokens'
				else if (choice.finish_reason === 'tool_calls') finishKind = 'stop'
			}
		} catch (error) {
			yield { type: 'finish', reason: { kind: 'error', failure: { message: `模型流中断：${String(error?.message ?? error)}` } } }
			return
		}

		if (text !== '') yield { type: 'block-end', block: { type: 'text', text } }
		for (const [index, slot] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
			yield {
				type: 'block-end',
				block: {
					type: 'tool-call',
					id: slot.id === '' ? `call_${index}` : slot.id,
					name: slot.name,
					arguments: slot.arguments === '' ? '{}' : slot.arguments,
				},
			}
		}
		yield { type: 'finish', reason: { kind: finishKind } }
	}

	/**
	 * The one provider this client represents.
	 *
	 * The organizer's model picker asks for provider groups so a library can
	 * follow the chat's route. Standalone there is exactly one route, but it
	 * still has to be *listed* — an empty catalogue leaves the picker blank and
	 * looks like a broken install.
	 *
	 * @returns {Promise<object[]>} The provider group.
	 */
	async function listProviders() {
		return [{ id: 'compatible', name: 'OpenAI 兼容接口' }]
	}

	/**
	 * The models this endpoint offers.
	 *
	 * OpenAI-compatible servers usually expose `GET /models`; a server that does
	 * not still works, it just cannot be browsed — the configured model is then
	 * the only entry, which is enough to pick and run.
	 *
	 * @returns {Promise<object[]>} `{id, name}` entries.
	 */
	async function listModels() {
		const { baseUrl, apiKey, model } = read()
		const url = `${baseUrl}/models`
		try {
			const response = await fetchImpl(url, {
				headers: apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(15_000),
			})
			if (response.ok) {
				const payload = await response.json()
				const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
				const models = entries
					.map((entry) => (typeof entry?.id === 'string' ? { id: entry.id, name: entry.id } : undefined))
					.filter((entry) => entry !== undefined)
				if (models.length > 0) return models.sort((a, b) => a.id.localeCompare(b.id))
			}
		} catch {
			// A server without /models is normal; fall through to the configured id.
		}
		return model === '' ? [] : [{ id: model, name: model }]
	}

	/**
	 * Reasoning levels for one model.
	 *
	 * The wire protocol this client speaks carries no such catalogue, so the
	 * picker simply offers no reasoning selector.
	 *
	 * @returns {Promise<object>} An empty model info.
	 */
	async function resolveModelInfo() {
		return {}
	}

	return { stream, listProviders, listModels, resolveModelInfo }
}

/**
 * Probe a connection with one cheap completion.
 *
 * Used by the settings page so a person can tell "wrong key" from "wrong model"
 * without running a whole organize job.
 *
 * @param {{baseUrl: string, apiKey?: string, model: string, fetchImpl?: typeof fetch}} options - Connection settings.
 * @returns {Promise<{ok: boolean, message: string}>} The verdict.
 */
export async function probeOpenAi({ baseUrl, apiKey = '', model, fetchImpl = fetch }) {
	const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
	try {
		const response = await fetchImpl(endpoint, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
			},
			body: JSON.stringify({
				model,
				max_tokens: 1,
				messages: [{ role: 'user', content: 'ping' }],
			}),
			signal: AbortSignal.timeout(20_000),
		})
		if (!response.ok) {
			const detail = await response.text().catch(() => '')
			return { ok: false, message: `HTTP ${response.status}${detail === '' ? '' : `：${detail.slice(0, 200)}`}` }
		}
		await response.arrayBuffer()
		return { ok: true, message: '连接正常' }
	} catch (error) {
		return { ok: false, message: String(error?.message ?? error) }
	}
}
