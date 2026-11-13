/**
 * Text normalisation for the keyword index and for snippets.
 *
 * SQLite's FTS5 cannot segment Chinese: `unicode61` treats a whole run of CJK
 * as one token, and its `trigram` tokenizer needs three characters, so the
 * two-character query 「插件」 matches nothing. The store therefore indexes a
 * pre-tokenised form — Latin words plus CJK bigrams — and keeps the raw text
 * on disk for snippets. That split is why this module has both `tokenize` and
 * `snippetOf`: the index is a lossy projection, and the snippet is read back
 * from the original.
 */

const LATIN = /[a-z0-9][a-z0-9_.-]*/gi

/** CJK ideographs, including extensions A and compatibility ideographs. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/** Japanese kana. */
const KANA = /[\u3040-\u30ff\u31f0-\u31ff]+/g

/** Hangul syllables. */
const HANGUL = /[\uac00-\ud7af]+/g

/**
 * Split one run into bigrams (a one-character run stays one token).
 *
 * @param {string} run - A script run without spaces.
 * @param {string[]} out - The token sink.
 * @returns {void}
 */
function bigrams(run, out) {
	if (run.length === 1) {
		out.push(run)
		return
	}
	for (let index = 0; index + 2 <= run.length; index += 1) out.push(run.slice(index, index + 2))
}

/**
 * Split text into the tokens the index and the query share.
 *
 * Latin words are lower-cased; CJK, kana and hangul runs become overlapping
 * bigrams. The same function is used on write and on query, so a query cannot
 * be tokenised differently from the document it is meant to match.
 *
 * @param {unknown} text - The source text.
 * @returns {string[]} The tokens, in source order.
 */
export function tokenize(text) {
	const value = String(text ?? '')
	const tokens = []
	for (const match of value.matchAll(LATIN)) tokens.push(match[0].toLowerCase())
	for (const pattern of [CJK, KANA, HANGUL]) {
		for (const match of value.matchAll(pattern)) bigrams(match[0], tokens)
	}
	return tokens
}

/**
 * Build an FTS5 MATCH expression from query tokens.
 *
 * Terms are OR-ed: BM25 already rewards a document that matches more of them,
 * while AND would make a natural-language question match nothing. The tokens
 * are alphanumeric/bigram only, but they are quoted so a future token shape
 * cannot accidentally become FTS syntax.
 *
 * @param {string[]} tokens - The query tokens.
 * @returns {string} The MATCH expression, or an empty string.
 */
export function matchExpression(tokens) {
	const unique = [...new Set((tokens ?? []).filter((token) => typeof token === 'string' && token !== ''))]
	if (unique.length === 0) return ''
	return unique.map((token) => `"${token.replace(/"/g, '')}"`).join(' OR ')
}

/**
 * Collapse whitespace and keep one line.
 *
 * @param {string} text - The text.
 * @returns {string} The clean text.
 */
function oneLine(text) {
	return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Pick the first place any query token happens in the raw text.
 *
 * The FTS index stores pre-tokenised text, so `snippet()` from SQLite would
 * return 「接口 口约 约定」 instead of the sentence the user wrote. Reading the
 * raw file for the handful of results that survive ranking costs little and
 * produces a snippet that is actually readable.
 *
 * @param {string} text - The raw text.
 * @param {string[]} tokens - The query tokens.
 * @param {{radius?: number}} [options] - Characters of context on each side.
 * @returns {string} A one-line snippet, possibly with ellipses.
 */
export function snippetOf(text, tokens, { radius = 80 } = {}) {
	const raw = oneLine(text)
	if (raw === '') return ''
	const haystack = raw.toLowerCase()
	let at = -1
	let length = 0
	for (const token of tokens ?? []) {
		if (typeof token !== 'string' || token === '') continue
		const index = haystack.indexOf(token.toLowerCase())
		if (index < 0) continue
		if (at < 0 || index < at) {
			at = index
			length = token.length
		}
	}
	if (at < 0) {
		const head = raw.slice(0, radius * 2)
		return raw.length > head.length ? `${head}…` : head
	}
	const start = Math.max(0, at - radius)
	const end = Math.min(raw.length, at + length + radius)
	return `${start > 0 ? '…' : ''}${raw.slice(start, end)}${end < raw.length ? '…' : ''}`
}

/**
 * The number of Unicode code points in a string.
 *
 * @param {unknown} text - The text.
 * @returns {number} The code point count.
 */
export function charCount(text) {
	return [...String(text ?? '')].length
}

/**
 * Keep at most `limit` code points.
 *
 * Used before tokenising a large file: the index holds a head of the document,
 * not the whole thing, so one huge log cannot make startup and writes slow.
 *
 * @param {unknown} text - The text.
 * @param {number} limit - The code point limit.
 * @returns {string} The clipped text.
 */
export function clipChars(text, limit) {
	const value = String(text ?? '')
	const chars = [...value]
	if (chars.length <= limit) return value
	return chars.slice(0, limit).join('')
}
