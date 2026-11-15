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
export const MIN_SHORT_ID = 5

/** The longest suffix; beyond this the full id is safer. */
export const MAX_SHORT_ID = 8

/**
 * The length of one id's body (the part after `file-`).
 *
 * @param {string} id - A file id.
 * @returns {string} The body.
 */
function bodyOf(id) {
	return id.slice(5)
}

/**
 * Short display ids, resolved without scanning the library.
 *
 * A short id is the shortest suffix of the id body that is still unique in the
 * library: the full id is 31 characters and an injected line can carry a
 * description instead of the address. The tail of a ULID is the random half,
 * so a suffix is where uniqueness lives.
 *
 * The obvious implementation is "a map from every full id to its suffix,
 * rebuilt after each write", and at a hundred thousand files that rebuild is
 * hundreds of milliseconds per write. This index instead keeps a map from the
 * five-character suffix to the id (or the ids that share it) and derives both
 * the display suffix and the resolution *on demand* from that map:
 *
 *   - five-way suffix groups are tiny (a collision of five Crockford digits is
 *     rare until tens of thousands of ids), so extending a colliding group to
 *     six, seven or eight characters only compares a handful of ids;
 *   - adding or removing one id touches one map entry, which makes a write
 *     O(1) instead of O(N);
 *   - a suffix longer than five characters always shares its last five, so the
 *     lookup starts from the same map entry and filters the small group.
 *
 * `shortOf` therefore returns the same value a full-library batch pass would,
 * and `resolve` accepts exactly the suffixes that identify one id.
 */
export class ShortIdIndex {
	/**
	 * @param {string[]} [ids] - The library's ids, in any order.
	 */
	constructor(ids = []) {
		/** @type {Map<string, string | string[]>} Five-character suffix to id(s). */
		this.bySuffix = new Map()
		/** @type {number} A cached population count. */
		this.count = 0
		for (const id of ids ?? []) this.add(id)
	}

	/**
	 * Add one id.
	 *
	 * @param {unknown} id - The id; anything that is not a file id is ignored.
	 * @returns {void}
	 */
	add(id) {
		if (!isFileId(id)) return
		const suffix = id.slice(-MIN_SHORT_ID)
		const group = this.bySuffix.get(suffix)
		if (group === undefined) {
			this.bySuffix.set(suffix, id)
			this.count += 1
			return
		}
		if (typeof group === 'string') {
			if (group === id) return
			this.bySuffix.set(suffix, [group, id])
			this.count += 1
			return
		}
		if (group.includes(id)) return
		group.push(id)
		this.count += 1
	}

	/**
	 * Remove one id.
	 *
	 * @param {unknown} id - The id; unknown ids are ignored.
	 * @returns {void}
	 */
	remove(id) {
		if (!isFileId(id)) return
		const suffix = id.slice(-MIN_SHORT_ID)
		const group = this.bySuffix.get(suffix)
		if (group === undefined) return
		if (typeof group === 'string') {
			if (group !== id) return
			this.bySuffix.delete(suffix)
			this.count -= 1
			return
		}
		const index = group.indexOf(id)
		if (index < 0) return
		group.splice(index, 1)
		this.count -= 1
		if (group.length === 1) this.bySuffix.set(suffix, group[0])
	}

	/**
	 * The ids that share one id's five-character suffix.
	 *
	 * @param {string} id - A full file id.
	 * @returns {string[]} The group; always contains `id` when it was added.
	 */
	groupOf(id) {
		const group = this.bySuffix.get(id.slice(-MIN_SHORT_ID))
		if (group === undefined) return [id]
		return typeof group === 'string' ? [group] : group
	}

	/**
	 * The display suffix of one id, or the id itself when no suffix is unique.
	 *
	 * @param {unknown} id - The full id.
	 * @returns {string} The short id.
	 */
	shortOf(id) {
		if (!isFileId(id)) return String(id ?? '')
		const body = bodyOf(id)
		const group = this.groupOf(id)
		if (group.length === 1) return body.slice(-MIN_SHORT_ID)
		for (let length = MIN_SHORT_ID + 1; length <= MAX_SHORT_ID; length += 1) {
			const suffix = body.slice(-length)
			let matches = 0
			for (const member of group) {
				if (bodyOf(member).endsWith(suffix)) matches += 1
			}
			if (matches === 1) return suffix
		}
		// Eight characters are not enough to separate this id: address it in full
		// rather than with a short form that would be ambiguous.
		return id
	}

	/**
	 * Resolve one suffix to a full id when exactly one id ends with it.
	 *
	 * @param {unknown} value - The suffix (five to eight characters in practice; anything at least five is accepted).
	 * @returns {string | undefined} The full id, or undefined when absent or ambiguous.
	 */
	resolve(value) {
		const raw = String(value ?? '').trim()
		if (raw.length < MIN_SHORT_ID) return undefined
		const group = this.bySuffix.get(raw.slice(-MIN_SHORT_ID))
		if (group === undefined) return undefined
		const members = typeof group === 'string' ? [group] : group
		const matches = raw.length === MIN_SHORT_ID
			? members
			: members.filter((id) => id.endsWith(raw))
		return matches.length === 1 ? matches[0] : undefined
	}
}
