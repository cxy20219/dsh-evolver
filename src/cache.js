/**
 * What the model reports about its own prompt cache.
 *
 * Every assistant message carries token usage, and the cached part is split
 * three ways: `inputTokens` (sent fresh), `cacheReadTokens` (served from the
 * cache) and `cacheWriteTokens` (written to the cache this turn). The ratio
 * between them is the only honest measure of whether the injected prefix is
 * stable — everything else is inference.
 *
 * A turn naturally writes its own increment to the cache, so `cacheWrite > 0`
 * alone means nothing. What matters is a turn that read *nothing*: that is a
 * prefix the model had to read again from the start.
 */

/**
 * Turn token usage into cache numbers.
 *
 * @param {object[]} messages - Assistant events with `data.usage`.
 * @returns {object} The report.
 */
export function summarizeUsage(messages) {
	const steps = []
	let totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
	for (const message of messages ?? []) {
		const usage = message?.data?.usage ?? message?.usage
		if (usage === undefined || usage === null) continue
		const row = {
			turn: Number(message?.data?.turn ?? message?.turn ?? 0),
			step: Number(message?.data?.step ?? message?.step ?? 0),
			time: Number(message?.time ?? message?.data?.time ?? 0),
			input: Number(usage.inputTokens ?? 0),
			cacheRead: Number(usage.cacheReadTokens ?? 0),
			cacheWrite: Number(usage.cacheWriteTokens ?? 0),
			output: Number(usage.outputTokens ?? 0),
		}
		row.prompt = row.input + row.cacheRead + row.cacheWrite
		row.hitRate = row.prompt === 0 ? null : row.cacheRead / row.prompt
		steps.push(row)
		totals = {
			input: totals.input + row.input,
			cacheRead: totals.cacheRead + row.cacheRead,
			cacheWrite: totals.cacheWrite + row.cacheWrite,
			output: totals.output + row.output,
		}
	}

	const prompt = totals.input + totals.cacheRead + totals.cacheWrite
	const hitRate = prompt === 0 ? null : totals.cacheRead / prompt
	// The first message has nothing to read from, so it does not count as a
	// miss. Every later message that read nothing had its prefix rebuilt.
	const misses = steps
		.map((row, index) => ({ ...row, index }))
		.filter((row) => row.index > 0 && row.cacheRead === 0 && row.prompt > 0)
		.map((row) => ({ index: row.index, turn: row.turn, step: row.step, prompt: row.prompt, time: row.time }))

	// What the misses actually cost: every one of them is a full prompt read.
	const missCost = misses.reduce((sum, row) => sum + row.prompt, 0)

	// The session average is dragged down by whatever happened hours ago. The
	// tail is what a person can still act on: one window for "is it healthy
	// right now", and one for "has it been healthy since the last rebuild".
	const recent = window_(steps, 50)
	const sinceMiss = steps.length - (misses.length === 0 ? 0 : misses[misses.length - 1].index + 1)

	return {
		messages: steps.length,
		prompt,
		totals,
		hitRate,
		missCost,
		missShare: prompt === 0 ? null : missCost / prompt,
		misses,
		// The last 50 steps, and the steps after the most recent rebuild.
		recent,
		sinceMiss,
		reads: steps.filter((row) => row.cacheRead > 0).length,
		largest: steps.reduce((max, row) => (row.prompt > (max?.prompt ?? 0) ? row : max), undefined) ?? null,
	}
}

/**
 * Aggregate the last N steps.
 *
 * @param {object[]} steps - All steps, oldest first.
 * @param {number} size - How many to take.
 * @returns {{messages: number, prompt: number, hitRate: number | null, misses: number}} The window.
 */
function window_(steps, size) {
	const tail = steps.slice(Math.max(0, steps.length - size))
	const prompt = tail.reduce((sum, row) => sum + row.prompt, 0)
	const read = tail.reduce((sum, row) => sum + row.cacheRead, 0)
	return {
		messages: tail.length,
		prompt,
		hitRate: prompt === 0 ? null : read / prompt,
		misses: tail.filter((row) => row.cacheRead === 0 && row.prompt > 0).length,
	}
}

/**
 * Read the assistant messages out of one session snapshot.
 *
 * @param {object} snapshot - The `readSession` result.
 * @returns {object[]} The assistant events, oldest first.
 */
export function assistantEvents(snapshot) {
	const events = Array.isArray(snapshot?.events) ? snapshot.events : []
	return events.filter((event) => event?.type === 'assistant/message')
}
