/**
 * Text normalisation for the description index.
 *
 * Only the catalogue is indexed: name, description and tags. The payload is
 * not indexed and not summarised here — the agent reads it when it matters.
 * That keeps the database a semantic index rather than a second copy of the
 * library, and it keeps a Word file's content out of the plugin's scope.
 *
 * SQLite's FTS5 still cannot segment Chinese: `unicode61` treats a whole run
 * of CJK as one token, and `trigram` needs three characters, so the
 * two-character query 「插件」 matches nothing. The description is therefore
 * pre-tokenised into Latin words plus CJK bigrams on both write and query.
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
