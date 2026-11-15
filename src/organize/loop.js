/**
 * The bounded agent loop of one organize run.
 *
 * An organize job is an agent, not a one-shot plan: the model may read bodies
 * and neighbours before deciding, so it gets the store's own tools. Everything
 * that touches the model's wire format lives here — the stream reader, the
 * hand-built message history, the tool-result shape, and the step/tool/character
 * budgets that stop one job from running forever. Writes go through an
 * instrumented store so the host counts what actually happened, never the
 * model's account of itself.
 */

import { createTools } from '../tools.js'
import {
	MAX_CHANGES,
	MAX_FINAL_TOKENS,
	MAX_OUTPUT_TOKENS,
	MAX_STEPS,
	MAX_TOOL_CALLS,
	MAX_TOOL_RESULT_CHARS,
	MAX_TOOL_RESULT_TOTAL,
	MAX_WRITES,
	TURN_TIMEOUT_MS,
	abortError,
	clip,
	closeIteratorQuietly,
	errorMessage,
	newMessageId,
	turnAbortError,
} from './budget.js'
import { wrapUpInstruction } from './prompts.js'

/**
 * The changelog of one job, with the store behind it instrumented.
 *
 * Every mutating call the tools make lands here, so the result counts describe
 * the library rather than the model's account of itself. Non-mutating methods
 * pass straight through with their receiver bound to the real store.
 *
 * @param {object} store - The real file store.
 * @returns {{store: object, counters: object, changes: Array<{op: string, id: string}>, record: (op: string, id: unknown) => void}} The accounting view.
 */
export function createAccounting(store) {
	const counters = { created: 0, updated: 0, merged: 0, archived: 0, removed: 0, retagged: 0, linked: 0 }
	const changes = []
	const record = (op, id) => {
		if (changes.length >= MAX_CHANGES) return
		changes.push({ op, id: String(id ?? '') })
	}
	const proxied = new Proxy(store, {
		get(target, property) {
			if (property === 'create') {
				return async (input = {}) => {
					const file = await target.create(input)
					counters.created += 1
					record('create', file?.id)
					return file
				}
			}
			if (property === 'update') {
				return async (id, patch = {}) => {
					const before = (target.db.get(id)?.links ?? []).length
					const file = await target.update(id, patch)
					if (patch.content !== undefined || patch.description !== undefined || patch.name !== undefined) {
						counters.updated += 1
						record('update', file?.id)
					}
					if (patch.tags !== undefined) {
						counters.retagged += 1
						record('retag', file?.id)
					}
					const after = Array.isArray(file?.links) ? file.links.length : before
					if (after > before) {
						counters.linked += after - before
						record('link', file?.id)
					}
					return file
				}
			}
			if (property === 'archive') {
				return async (id, archived = true) => {
					const file = await target.archive(id, archived)
					if (archived !== false) {
						counters.archived += 1
						record('archive', id)
					}
					return file
				}
			}
			if (property === 'remove') {
				return async (id) => {
					const result = await target.remove(id)
					counters.removed += 1
					record('remove', id)
					return result
				}
			}
			if (property === 'link') {
				return async (from, to) => {
					const before = (target.db.get(from)?.links ?? []).length
					const file = await target.link(from, to)
					const after = Array.isArray(file?.links) ? file.links.length : before
					if (after > before) {
						counters.linked += after - before
						record('link', from)
					}
					return file
				}
			}
			if (property === 'unlink') {
				return async (from, to) => {
					const file = await target.unlink(from, to)
					record('unlink', from)
					return file
				}
			}
			const value = Reflect.get(target, property, target)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
	return { store: proxied, counters, changes, record }
}

/**
 * The organizer-only merge tool.
 *
 * Not registered with the host: chat sessions keep the four `file_*` tools
 * and only an organize job ever sees this compound action. The target's body
 * and metadata change in one store write; every source is archived, never
 * removed, so a merge never destroys content.
 *
 * @param {{raw: object, counters: object, record: (op: string, id: unknown) => void}} accounting - The real store and its counters.
 * @returns {object} The tool definition.
 */
export function createMergeTool({ raw, counters, record }) {
	return {
		name: 'file_merge',
		description: '合并文件：按需更新 target 的正文/描述/标签/链接，再把 sources 全部归档（不物理删除）。先把 target 与 sources 都 file_read 过再合并；sources 里不要放 target。',
		parameters: {
			type: 'object',
			properties: {
				target: { type: 'string', description: '保留的文件 id 或唯一短 id' },
				sources: { type: 'array', items: { type: 'string' }, description: '被合并后归档的文件 id 或短 id 列表' },
				content: { type: 'string', description: '合并后的正文；不传则不改正文' },
				description: { type: 'string', description: '合并后的描述；不传则不改' },
				tags: { type: 'array', items: { type: 'string' }, description: '合并后的标签；不传则不改' },
				links: { type: 'array', items: { type: 'string' }, description: '合并后的出链；不传则不改' },
			},
			required: ['target', 'sources'],
		},
		output: { schema: { type: 'object', additionalProperties: true } },
		async execute(args) {
			const input = args ?? {}
			const targetId = raw.resolveId(input.target)
			if (targetId === undefined) throw new Error(`合并目标不存在：${String(input.target ?? '')}`)
			const sourceIds = []
			for (const value of Array.isArray(input.sources) ? input.sources : []) {
				const id = raw.resolveId(value)
				if (id === undefined || id === targetId || sourceIds.includes(id)) continue
				sourceIds.push(id)
			}
			if (sourceIds.length === 0) throw new Error('sources 里没有可合并的有效文件 id。')
			const patch = {}
			for (const field of ['content', 'description']) {
				if (typeof input[field] === 'string' && input[field].trim() !== '') patch[field] = input[field]
			}
			if (Array.isArray(input.tags)) patch.tags = input.tags
			if (Array.isArray(input.links)) patch.links = input.links
			const target = Object.keys(patch).length === 0
				? await raw.read(targetId, { text: false, neighbors: false })
				: await raw.update(targetId, patch)
			for (const id of sourceIds) await raw.archive(id, true)
			counters.merged += sourceIds.length
			record('merge', targetId)
			return {
				merged: sourceIds.length,
				target: targetId,
				archived: sourceIds,
				...(Array.isArray(target?.warnings) && target.warnings.length > 0 ? { warnings: target.warnings } : {}),
			}
		},
	}
}

/**
 * The tool set one job's phase should see.
 *
 * Dry-run gets read-only tools and therefore cannot write by construction; the
 * prompt still asks for a plan, so the run is useful without pretending a write
 * succeeded. The sessions phase writes new files but cannot reorganize existing
 * ones; the files phase adds `file_edit` (replace, retag, relink, archive) and
 * the organizer-only merge. `file_edit`'s `meta.remove` is the delete action,
 * so `allowRemove` no longer changes the tool list: removal is never offered as
 * its own tool, only as a metadata field the prompt tells the model to avoid.
 *
 * @param {object} job - The job snapshot.
 * @param {{store: object, raw: object, counters: object, record: Function}} accounting - The instrumented store.
 * @param {'sessions' | 'files'} phase - Which half of the job is running.
 * @returns {object[]} The tools.
 */
export function toolsForJob(job, accounting, phase) {
	const all = createTools({ store: accounting.store })
	const byName = new Map(all.map((tool) => [tool.name, tool]))
	const pick = (names) => names.map((name) => byName.get(name)).filter((tool) => tool !== undefined)
	if (job.dryRun) return pick(['file_search', 'file_read'])
	if (phase === 'sessions') return pick(['file_search', 'file_read', 'file_write'])
	const tools = pick(['file_search', 'file_read', 'file_write', 'file_edit'])
	tools.push(createMergeTool(accounting))
	return tools
}

/**
 * How many more model turns the job may spend on this phase.
 *
 * The kind's step number is a budget for the whole job, not per session: a
 * five-session run must not multiply it by five.
 *
 * @param {object} job - The job snapshot.
 * @returns {number} The remaining steps, at least one.
 */
export function stepBudget(job) {
	const total = MAX_STEPS[job.kind] ?? MAX_STEPS.files
	return Math.max(1, total - job.progress.steps)
}

/**
 * Ask the model once and collect the streamed blocks.
 *
 * Only the block structure is kept: text deltas are used as a fallback for an
 * adapter that closes no text block, and the terminal finish decides success,
 * truncation, cancellation and failure. Nothing here stores the raw stream.
 *
 * @param {object} options - The call.
 * @param {object} options.llm - The Host `llm` service.
 * @param {{provider: string, model: string, reasoningEffort?: string}} options.selection - The model route.
 * @param {string} options.system - The system prompt.
 * @param {object[]} options.messages - The conversation.
 * @param {object[]} options.tools - The tool schemas.
 * @param {AbortSignal} options.signal - Cancellation.
 * @param {string} options.sessionId - Synthetic routing session id.
 * @param {number} [options.maxTokens] - The output budget for this turn.
 * @param {number} [options.turnTimeoutMs] - The per-turn deadline.
 * @returns {Promise<{blocks: object[], text: string, reason: object|null, replayState: unknown, truncated: boolean}>} The reply.
 */
export async function streamTurn({
	llm,
	selection,
	system,
	messages,
	tools,
	signal,
	sessionId,
	maxTokens = MAX_OUTPUT_TOKENS,
	turnTimeoutMs = TURN_TIMEOUT_MS,
}) {
	// A hung adapter never calls back into the loop, so the deadline has to race
	// the iteration; handing the combined signal to the adapter is what lets a
	// well-behaved one abort its own request first.
	const turnSignal = Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0
		? AbortSignal.any([signal, AbortSignal.timeout(turnTimeoutMs)])
		: signal
	if (turnSignal.aborted) throw turnAbortError(signal, turnTimeoutMs)
	const stream = llm.stream({
		provider: selection.provider,
		model: selection.model,
		...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
		sessionId,
		system,
		messages,
		...(tools.length === 0 ? {} : { tools }),
		maxTokens,
		signal: turnSignal,
	})
	const iterator = typeof stream?.[Symbol.asyncIterator] === 'function'
		? stream[Symbol.asyncIterator]()
		: stream?.[Symbol.iterator]?.()
	if (iterator === null || iterator === undefined || typeof iterator.next !== 'function') {
		throw new Error('模型流不是可迭代对象。')
	}
	const blocks = []
	let deltaText = ''
	let reason = null
	let replayState
	// One rejection per turn, not per chunk: every `Promise.race` below attaches
	// a handler to it, so an abort after the race settled cannot leak an
	// unhandled rejection, and the pending `next()` is left to resolve (or not)
	// on its own — awaiting it would move the hang instead of ending the turn.
	const aborted = new Promise((_, reject) => {
		turnSignal.addEventListener('abort', () => reject(turnAbortError(signal, turnTimeoutMs)), { once: true })
	})
	try {
		while (true) {
			const step = await Promise.race([iterator.next(), aborted])
			if (step === null || typeof step !== 'object' || step.done === true) break
			const chunk = step.value
			if (chunk === null || typeof chunk !== 'object') continue
			if (chunk.type === 'text-delta' && typeof chunk.text === 'string') deltaText += chunk.text
			else if (chunk.type === 'block-end' && chunk.block !== null && typeof chunk.block === 'object') blocks.push(chunk.block)
			else if (chunk.type === 'finish') {
				reason = chunk.reason ?? null
				replayState = chunk.replayState
			}
			if (turnSignal.aborted) throw turnAbortError(signal, turnTimeoutMs)
		}
	} finally {
		if (turnSignal.aborted) closeIteratorQuietly(iterator)
	}
	const kind = reason?.kind
	if (kind === 'error' || kind === 'aborted') {
		const failure = reason?.failure ?? {}
		const error = new Error(failure.message || '模型调用失败')
		if (kind === 'aborted') error.name = 'AbortError'
		throw error
	}
	let text = blocks
		.filter((block) => block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('')
	if (text === '') text = deltaText
	return { blocks, text, reason, replayState, truncated: kind === 'max-tokens' }
}

/**
 * Run one bounded tool loop until the model answers without asking for tools.
 *
 * Every tool call gets a result before the next model turn, because the wire
 * protocol requires it; when the call or character budget runs out the loop
 * stops asking and returns whatever final text exists instead of sending an
 * unbalanced history.
 *
 * @param {object} options - The loop.
 * @param {object} options.job - The job (for logging and progress).
 * @param {object} options.llm - The Host `llm` service.
 * @param {object} options.selection - The model route.
 * @param {string} options.system - The system prompt.
 * @param {string} options.prompt - The user message.
 * @param {object[]} options.tools - The tool definitions.
 * @param {AbortSignal} options.signal - Cancellation.
 * @param {number} options.maxSteps - The step cap.
 * @param {number} [options.turnTimeoutMs] - The per-turn deadline.
 * @param {(line: string) => void} options.log - Job log sink.
 * @returns {Promise<{text: string, steps: number, toolCalls: number, truncated: boolean, finalTruncated: boolean, exhausted: boolean}>} The closing answer and usage.
 */
export async function runToolLoop({ job, llm, selection, system, prompt, tools, signal, maxSteps, turnTimeoutMs = TURN_TIMEOUT_MS, log }) {
	const schemas = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}))
	const byName = new Map(tools.map((tool) => [tool.name, tool]))
	const messages = [{
		role: 'user',
		content: [{ type: 'text', text: prompt }],
		source: { kind: 'user' },
		id: newMessageId(),
	}]
	let steps = 0
	let toolCalls = 0
	let toolChars = 0
	let withdrawn = false
	let truncated = false
	for (let index = 0; index < maxSteps; index += 1) {
		if (signal.aborted) throw abortError()
		steps += 1
		const activeSchemas = withdrawn ? [] : schemas
		// The closing turn gets a bigger budget and a sharper instruction: it is
		// the only turn whose text the person ever sees. A reasoning-heavy route
		// can spend a tool-turn-sized budget on thinking and return nothing.
		const finalTurn = activeSchemas.length === 0
		const reply = await streamTurn({
			llm,
			selection,
			system: finalTurn ? `${system}\n\n${wrapUpInstruction(job)}` : system,
			messages,
			tools: activeSchemas,
			signal,
			sessionId: job.id,
			maxTokens: finalTurn ? MAX_FINAL_TOKENS : MAX_OUTPUT_TOKENS,
			turnTimeoutMs,
		})
		if (reply.truncated) truncated = true
		const calls = reply.blocks.filter((block) => block.type === 'tool-call')
		if (calls.length === 0 || finalTurn) {
			// Only this turn's text is the conclusion. Intermediate turns are
			// progress chatter ("I'll look at the library first…") and must not
			// stand in for a result the model never delivered.
			return {
				text: reply.text,
				steps,
				toolCalls,
				truncated,
				finalTruncated: reply.truncated,
				exhausted: false,
			}
		}
		// Reasoning blocks are not replayed: the organizer never needs the
		// model's private thought, and a hand-built request has no signed replay
		// state that would let a provider accept one. Text and tool calls are the
		// durable history.
		const history = reply.blocks.filter((block) => block.type === 'text' || block.type === 'tool-call')
		messages.push({
			id: newMessageId(),
			role: 'assistant',
			content: history,
			source: {
				kind: 'model',
				provider: selection.provider,
				model: selection.model,
				...(reply.replayState === undefined ? {} : { replayState: reply.replayState }),
			},
		})
		for (const [callIndex, call] of calls.entries()) {
			if (signal.aborted) throw abortError()
			const name = typeof call.name === 'string' ? call.name : ''
			if (toolCalls >= MAX_TOOL_CALLS || withdrawn) {
				// Answer the remaining calls without executing them: the history
				// stays valid, and the next turn goes out without tools so the
				// model can close with a summary instead of an unbalanced round.
				for (const pending of calls.slice(callIndex)) {
					messages.push(toolResultMessage(pending, { error: '工具调用预算已用完，未执行。' }, true))
				}
				withdrawn = true
				log('工具预算用尽，下一轮只收最终总结')
				break
			}
			toolCalls += 1
			const result = await executeTool(byName, call)
			const text = clip(JSON.stringify(result.value ?? {}), MAX_TOOL_RESULT_CHARS)
			toolChars += text.length
			if (toolChars > MAX_TOOL_RESULT_TOTAL && !withdrawn) {
				withdrawn = true
				log('工具结果预算用尽，要求模型收尾')
			}
			log(`工具 ${name === '' ? '?' : name}`)
			messages.push(toolResultMessage(call, result.value, result.isError, text))
			if (result.write === true) job.progress.writes = (job.progress.writes ?? 0) + 1
			if ((job.progress.writes ?? 0) >= MAX_WRITES && !withdrawn) {
				withdrawn = true
				log('写操作达到上限，要求模型收尾')
			}
		}
	}
	// The step budget ran out before the model answered. The writes that did
	// land stay; the job closes as done. No intermediate text is promoted to a
	// conclusion — the caller says the run ended early instead.
	return { text: '', steps, toolCalls, truncated, finalTruncated: false, exhausted: true }
}

/**
 * Build one tool-result message in the host's durable message shape.
 *
 * @param {object} call - The tool-call block.
 * @param {unknown} value - The tool result value.
 * @param {boolean} isError - Whether the call failed.
 * @param {string} [encoded] - The pre-encoded result text.
 * @returns {object} The message.
 */
function toolResultMessage(call, value, isError, encoded) {
	const text = typeof encoded === 'string' ? encoded : clip(JSON.stringify(value ?? {}), MAX_TOOL_RESULT_CHARS)
	const id = typeof call?.id === 'string' ? call.id : newMessageId()
	return {
		id: newMessageId(),
		role: 'tool',
		source: { kind: 'tool', callId: id },
		toolCallId: id,
		content: [{ type: 'text', text }],
		isError: isError === true,
	}
}

/**
 * Execute one tool call, turning throws into an error result.
 *
 * @param {Map<string, object>} byName - The tools of this job.
 * @param {object} call - The tool-call block.
 * @returns {Promise<{value: unknown, isError: boolean, write: boolean}>} The result.
 */
async function executeTool(byName, call) {
	const name = typeof call?.name === 'string' ? call.name : ''
	const tool = byName.get(name)
	if (tool === undefined) return { value: { error: `没有这个工具：${name}` }, isError: true, write: false }
	let args = {}
	try {
		const parsed = JSON.parse(typeof call.arguments === 'string' && call.arguments !== '' ? call.arguments : '{}')
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
	} catch {
		return { value: { error: '工具参数不是合法 JSON。' }, isError: true, write: false }
	}
	try {
		const value = await tool.execute(args)
		const write = name === 'file_write' || name === 'file_edit' || name === 'file_merge'
		return { value, isError: false, write }
	} catch (error) {
		return { value: { error: errorMessage(error) }, isError: true, write: false }
	}
}
