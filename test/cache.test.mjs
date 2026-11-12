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

test('最近窗口与「重建之后还剩几步」分开算', () => {
	const rows = []
	for (let index = 0; index < 60; index += 1) {
		// One rebuild at step 55 of 60: it belongs to the recent window, and
		// only four steps follow it.
		const miss = index === 55
		rows.push(message(miss ? { inputTokens: 1000, cacheReadTokens: 0 } : { inputTokens: 5, cacheReadTokens: 995 }, index))
	}
	const report = summarizeUsage(rows)
	assert.equal(report.recent.messages, 50)
	assert.equal(report.recent.misses, 1)
	assert.ok(report.recent.hitRate > 0.9 && report.recent.hitRate < 1)
	assert.equal(report.sinceMiss, 4)
	assert.equal(summarizeUsage([]).sinceMiss, 0)
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

test('未命中归因：换模型、重启、系统段重写分得开', async () => {
	const { missCause } = await import('../src/cache.js')
	const system = (model) => ({ type: 'system/message', data: { message: { content: [{ text: `You are powered by the ${model} model.` }] } } })
	assert.equal(missCause([system('MiniMax-M3.1-Flash')], 1000, true), 'model-switch')
	assert.equal(missCause([system('deepseek-v4.1-flash')], 1000, false), 'system-section')
	assert.equal(missCause([{ type: 'session/end-seed' }, system('deepseek-v4.1-flash')], 1000, false), 'resume')
	assert.equal(missCause([{ type: 'session/end-seed' }], 1000, false), 'resume')
	assert.equal(missCause([], 10 * 60_000, false), 'expired')
	assert.equal(missCause([{ type: 'tool/update' }], 1000, false), 'tools')
	assert.equal(missCause([{ type: 'foo' }], 1000, false), 'unknown')
})

test('归因沿着整条时间线追踪模型名，不只看单个间隔', () => {
	// 回退把模型换过去时，间隔里只有一条系统消息，它自己说不出「我换了」。
	const events = [
		{ type: 'system/message', time: 0, data: { message: { content: [{ text: 'powered by the MiniMax-M3.1-Flash model' }] } } },
		{ type: 'assistant/message', time: 10, data: { usage: { inputTokens: 100, cacheReadTokens: 900 } } },
		{ type: 'system/message', time: 20, data: { message: { content: [{ text: 'powered by the deepseek-v4.1-flash model' }] } } },
		{ type: 'assistant/message', time: 30, data: { usage: { inputTokens: 1000, cacheReadTokens: 0 } } },
	]
	const report = summarizeUsage(events.filter((e) => e.type === 'assistant/message'), events)
	assert.equal(report.misses.length, 1)
	assert.equal(report.misses[0].cause, 'model-switch')
	assert.deepEqual(report.byCause, { 'model-switch': 1 })
})
