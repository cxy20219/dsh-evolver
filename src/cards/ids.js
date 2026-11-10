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
