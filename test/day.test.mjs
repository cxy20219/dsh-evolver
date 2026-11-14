import assert from 'node:assert/strict'
import test from 'node:test'

import { dayKey } from '../src/day.js'

/**
 * The local date of a moment, written out by hand — the contract under test.
 *
 * @param {Date} date - The moment.
 * @returns {string} `YYYY-MM-DD` from the local calendar fields.
 */
function expected(date) {
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${date.getFullYear()}-${month}-${day}`
}

test('dayKey：本地日期格式 YYYY-MM-DD，月和日补零', () => {
	assert.equal(dayKey(new Date(2026, 0, 5, 0, 30)), '2026-01-05')
	assert.equal(dayKey(new Date(2026, 0, 31, 23, 59, 59)), '2026-01-31')
	assert.equal(dayKey(new Date(2026, 10, 14, 12, 0)), '2026-11-14')
})

test('dayKey：跨月跨年按本地日历，不按 UTC', () => {
	assert.equal(dayKey(new Date(2025, 11, 31, 23, 59, 59, 999)), '2025-12-31')
	assert.equal(dayKey(new Date(2026, 0, 1, 0, 0, 0, 0)), '2026-01-01')
	assert.equal(dayKey(new Date(2024, 1, 29, 12, 0)), '2024-02-29')
	// 不带参数时用当前时刻。
	assert.equal(dayKey(), expected(new Date()))
})
