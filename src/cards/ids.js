/**
 * Card identities.
 *
 * A card id is a ULID: 48 bits of milliseconds plus 80 random bits, encoded
 * in Crockford base32. It sorts by creation time, stays unique when several
 * cards are written in the same millisecond, and does not depend on a title
 * that the user may later change.
 */

import { randomBytes } from 'node:crypto'

/** Crockford base32: no I, L, O or U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** The full id shape, including the `card-` prefix. */
const CARD_ID = /^card-[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * Encode one ULID.
 *
 * @param {number} [now] - Millisecond timestamp.
 * @param {(size: number) => Buffer} [random] - Random byte source.
 * @returns {string} A new card id.
 */
export function cardId(now = Date.now(), random = randomBytes) {
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
	return `card-${timePart}${randomPart}`
}

/**
 * Whether a value is a card id.
 *
 * @param {unknown} value - The candidate.
 * @returns {boolean} True for a well-formed id.
 */
export function isCardId(value) {
	return typeof value === 'string' && CARD_ID.test(value)
}

/**
 * Decode the creation time embedded in a card ULID.
 *
 * @param {unknown} value - A card id.
 * @returns {string} ISO timestamp, or an empty string for an invalid id.
 */
export function cardCreatedAt(value) {
	if (!isCardId(value)) return ''
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
 * The full id is 31 characters — 32 hex-ish chars in the prompt for eight
 * cards is a lot of context for pure addressing. The tail of a ULID is the
 * random half, so a suffix is where uniqueness lives; the timestamp prefix is
 * shared by every card written the same millisecond. 5 characters already
 * separate a hundred cards, and the dictionary is checked against the library,
 * so a suffix is only used when it is unambiguous right now. If no suffix is
 * unique within MAX_SHORT_ID, the full id is returned: a collision that makes
 * `card_read` fail would be worse than the bytes.
 *
 * @param {string[]} ids - The ids to shorten (duplicates are fine).
 * @returns {Map<string, string>} Full id to display suffix (or the full id).
 */
export function shortIds(ids) {
	const bodies = [...new Set((ids ?? []).filter((id) => isCardId(id)).map((id) => id.slice(5)))]
	// One pass builds a suffix → count table for every length a short id may
	// use; each id then just reads its own suffix count. The old version
	// filtered the whole library once per id per length (O(N²) with a large
	// constant), which dominated the prompt fallback on a grown library.
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
		let chosen = `card-${body}`
		for (let length = MIN_SHORT_ID; length <= MAX_SHORT_ID; length += 1) {
			const suffix = body.slice(-length)
			if (counts.get(length).get(suffix) === 1) {
				chosen = suffix
				break
			}
		}
		result.set(`card-${body}`, chosen)
	}
	return result
}
