/**
 * Cache reporting: the difference between "the cache is working" and "it is
 * working except every request pays for the whole prefix again" is invisible
 * without these numbers.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { assistantEvents, summarizeUsage } from '../src/cache.js'

/**
 * One assistant event with usage.
 *
 * @param {object} usage - Token counts.
 * @param {number} turn - Turn number.
 * @returns {object} The event.
 */
function message(usage, turn = 1, step = 1) {
	return { type: 'assistant/message', time: turn * 1000, data: { turn, step, usage } }
}

test('命中率按 prompt 总量算，缓存读是分子', () => {
	const report = summarizeUsage([
		message({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 900, outputTokens: 50 }),
		message({ inputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 40, outputTokens: 60 }, 2),
	])
	assert.equal(report.messages, 2)
	assert.equal(report.totals.cacheRead, 1000)
	assert.equal(report.totals.cacheWrite, 940)
	assert.equal(report.prompt, 2050)
	assert.equal(Number(report.hitRate.toFixed(4)), 0.4878)
})

test('首条不算未命中，之后读到 0 才是前缀被重建', () => {
	const report = summarizeUsage([
		message({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 900 }),
		message({ inputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 40 }, 2),
		// A turn that read nothing: the prefix was rebuilt.
		message({ inputTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 300 }, 3),
	])
	assert.equal(report.misses.length, 1)
	assert.equal(report.misses[0].turn, 3)
	assert.equal(report.misses[0].prompt, 1500)
	assert.equal(report.reads, 1)
	assert.equal(report.missCost, 1500, '未命中的代价就是那一次的全量读')
	assert.equal(Number(report.missShare.toFixed(4)), Number((1500 / report.prompt).toFixed(4)))
})

test('没有 usage 的事件被跳过，空输入不除以零', () => {
	assert.deepEqual(
		summarizeUsage([{ type: 'user/message', data: {} }, message({})]).hitRate,
		null,
	)
	const empty = summarizeUsage([])
	assert.equal(empty.messages, 0)
	assert.equal(empty.hitRate, null)
	assert.deepEqual(empty.misses, [])
	assert.equal(empty.largest, null)
})

test('只挑出 assistant/message 事件', () => {
	const events = [
		{ type: 'user/message', data: {} },
		{ type: 'assistant/message', data: { usage: { inputTokens: 1 } } },
		{ type: 'tool/call', data: {} },
	]
	assert.equal(assistantEvents({ events }).length, 1)
	assert.deepEqual(assistantEvents(undefined), [])
})
