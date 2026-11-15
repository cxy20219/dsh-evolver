/**
 * Rough token estimates for prompt text.
 *
 * The plugin runs no tokenizer for a model route: it only needs a stable size
 * for prompt surfaces it shows (the static section, organize prompts, tool
 * schemas, the preference block). The rule below is the one the panel displays:
 * CJK and full-width characters cost about one token each, everything else
 * about four characters per token. It is an estimate for budgeting, not a
 * billing number; a provider tokenizer would price the same text differently.
 */

/** CJK blocks, CJK punctuation, kana, hangul and full-width forms. */
const CJK = /[\u2e80-\u2eff\u2f00-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u31a0-\u31bf\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\uac00-\ud7af]/u

/**
 * Estimate the tokens a prompt string occupies.
 *
 * @param {unknown} value - The text.
 * @returns {number} The estimated tokens; 0 for empty text.
 */
export function estimateTokens(value) {
	const text = String(value ?? '')
	if (text === '') return 0
	let cjk = 0
	let other = 0
	for (const char of text) {
		if (CJK.test(char)) cjk += 1
		else other += 1
	}
	return cjk + Math.ceil(other / 4)
}
