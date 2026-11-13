/**
 * File identities.
 *
 * A file id is a ULID: 48 bits of milliseconds plus 80 random bits, encoded in
 * Crockford base32. It sorts by creation time, stays unique when several files
 * are written in the same millisecond, and does not depend on a name the user
 * may later change.
 *
 * The `file-` prefix is part of the id, the same way `card-` was: it makes an
 * id recognisable in prose, in a log line, and in a link, and it keeps the two
 * stores from ever being confused during migration.
 */

import { randomBytes } from 'node:crypto'

/** Crockford base32: no I, L, O or U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** The full id shape, including the `file-` prefix. */
const FILE_ID = /^file-[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * Encode one ULID.
 *
 * @param {number} [now] - Millisecond timestamp.
 * @param {(size: number) => Buffer} [random] - Random byte source.
 * @returns {string} A new file id.
 */
export function fileId(now = Date.now(), random = randomBytes) {
	let time = Math.max(0, Math.floor(Number(now)))
	let timePart = ''
	for (let index = 0; index < 10; index += 1) {
		timePart = ALPHABET[time % 32] + timePart
		time = Math.floor(time / 32)
	}
	const bytes = random(10)
	let value = 0
	let bits = 0
	let randomPart = ''
	for (const byte of bytes) {
		value = (value << 8) | byte
		bits += 8
		while (bits >= 5) {
			randomPart += ALPHABET[(value >>> (bits - 5)) & 31]
			bits -= 5
		}
	}
	return `file-${timePart}${randomPart}`
}

/**
 * Whether a value is a file id.
 *
 * @param {unknown} value - The candidate.
 * @returns {boolean} True for a well-formed id.
 */
export function isFileId(value) {
	return typeof value === 'string' && FILE_ID.test(value)
}

/**
 * Decode the creation time embedded in a file ULID.
 *
 * @param {unknown} value - A file id.
 * @returns {string} ISO timestamp, or an empty string for an invalid id.
 */
export function fileCreatedAt(value) {
	if (!isFileId(value)) return ''
	let time = 0
	for (let index = 5; index < 15; index += 1) {
		const digit = ALPHABET.indexOf(value[index])
		if (digit < 0) return ''
		time = time * 32 + digit
	}
	return new Date(time).toISOString()
}

/** The shortest suffix a display id may use. */
const MIN_SHORT_ID = 5

/** The longest suffix; beyond this the full id is safer. */
const MAX_SHORT_ID = 8

/**
 * The shortest suffix of each id that is still unique in the library.
 *
 * The full id is 31 characters; an injected line can carry a description
 * instead of 26 more characters of address. The tail of a ULID is the random
 * half, so a suffix is where uniqueness lives. A suffix is only chosen when it
 * is unambiguous right now; if no suffix is unique within `MAX_SHORT_ID`, the
 * full id is returned rather than a short form that would make a read fail.
 *
 * @param {string[]} ids - The ids to shorten (duplicates are fine).
 * @returns {Map<string, string>} Full id to display suffix (or the full id).
 */
export function shortIds(ids) {
	const bodies = [...new Set((ids ?? []).filter((id) => isFileId(id)).map((id) => id.slice(5)))]
	const counts = new Map()
	for (let length = MIN_SHORT_ID; length <= MAX_SHORT_ID; length += 1) {
		const table = new Map()
		for (const body of bodies) {
			const suffix = body.slice(-length)
			table.set(suffix, (table.get(suffix) ?? 0) + 1)
		}
		counts.set(length, table)
	}
	const result = new Map()
	for (const body of bodies) {
		let chosen = `file-${body}`
		for (let length = MIN_SHORT_ID; length <= MAX_SHORT_ID; length += 1) {
			const suffix = body.slice(-length)
			if (counts.get(length).get(suffix) === 1) {
				chosen = suffix
				break
			}
		}
		result.set(`file-${body}`, chosen)
	}
	return result
}
