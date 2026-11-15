/**
 * Short display ids at the index level.
 *
 * The short-id map used to be rebuilt from every id after each write (hundreds
 * of milliseconds per write at scale). `ShortIdIndex` keeps a five-character
 * suffix map and derives the display suffix on demand instead, so these tests
 * pin the two properties the rewrite must keep: a suffix is used only when it
 * is unique, and resolution accepts exactly the values that identify one file.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ShortIdIndex, isFileId } from '../src/ids.js'

/**
 * Build a syntactically valid id from the 19 characters that keep two ids in
 * the same five-character suffix group.
 *
 * @param {string} head - The distinguishing prefix (padded to 21 characters).
 * @param {string} tail - The last characters of the id body.
 * @returns {string} A full id whose body is 26 characters.
 */
function id(head, tail) {
	const body = head.repeat(Math.ceil((26 - tail.length) / head.length)).slice(0, 26 - tail.length) + tail
	assert.equal(body.length, 26)
	const value = `file-${body}`
	assert.ok(isFileId(value))
	return value
}

test('短 id：唯一后缀用最短的五位', () => {
	const alpha = id('A', '')
	const beta = id('B', '')
	const index = new ShortIdIndex([alpha, beta])
	assert.equal(index.count, 2)
	assert.equal(index.shortOf(alpha), 'AAAAA')
	assert.equal(index.shortOf(beta), 'BBBBB')
	assert.equal(index.resolve('AAAAA'), alpha)
	assert.equal(index.resolve('AAAAAB'), undefined, '不存在的后缀解析不到')
})

test('短 id：五位后缀撞车时按需延长，且互不歧义', () => {
	const left = id('A', 'XYZAB')
	const right = id('B', 'XYZAB')
	const index = new ShortIdIndex([left, right])
	assert.equal(index.resolve('XYZAB'), undefined, '五位后缀撞车时不能解析')
	assert.equal(index.shortOf(left), 'AXYZAB')
	assert.equal(index.shortOf(right), 'BXYZAB')
	assert.equal(index.resolve('AXYZAB'), left)
	assert.equal(index.resolve('BXYZAB'), right)
})

test('短 id：增量增删不重建，删掉撞车项后自动缩回五位', () => {
	const left = id('C', 'ABCDE')
	const right = id('D', 'ABCDE')
	const index = new ShortIdIndex()
	index.add(left)
	assert.equal(index.shortOf(left), 'ABCDE')
	index.add(right)
	assert.equal(index.shortOf(left), 'CABCDE')
	assert.equal(index.resolve('ABCDE'), undefined)
	index.remove(right)
	assert.equal(index.count, 1)
	assert.equal(index.shortOf(left), 'ABCDE', '删除后后缀重新变短，无需全量重建')
	assert.equal(index.resolve('ABCDE'), left)
	index.remove('file-00000000000000000000000000')
	assert.equal(index.count, 1, '删除不存在的 id 不影响索引')
})

test('短 id：八位仍撞车时退化为完整 id', () => {
	const left = id('A', '12345678')
	const right = id('B', '12345678')
	const index = new ShortIdIndex([left, right])
	assert.equal(index.shortOf(left), left, '没有唯一后缀时给完整 id，而不是会读错的短地址')
	assert.equal(index.resolve('12345678'), undefined)
	assert.equal(index.resolve(left.slice(5)), left, '更长的后缀仍然可以唯一定位')
})

test('短 id：非法的值既不进索引也不解析', () => {
	const useful = id('Z', '')
	const index = new ShortIdIndex([useful, 'not-an-id', '', null, 42])
	assert.equal(index.count, 1)
	assert.equal(index.shortOf('not-an-id'), 'not-an-id')
	assert.equal(index.resolve('ZZZZZ'), useful)
	assert.equal(index.resolve('ZZZZ'), undefined, '不足五位不做后缀解析')
})
