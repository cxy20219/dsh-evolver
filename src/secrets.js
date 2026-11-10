/**
 * Credential screening shared by practice, memory and session excerpts.
 *
 * The check is deliberately narrow: it recognizes common token shapes and
 * leaves ordinary prose alone. A false negative is possible; every caller
 * still says not to store secrets.
 */

/** Patterns that must never reach a stored memory or practice entry. */
export const SECRET_PATTERNS = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub 令牌'],
	[/\bAKIA[0-9A-Z]{16}\b/, 'AWS 访问密钥'],
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack 令牌'],
	[/\bsk-[A-Za-z0-9_-]{20,}\b/, 'API 密钥'],
]

/**
 * Detect a credential in text that is about to be stored.
 *
 * @param {string} text - The candidate text.
 * @returns {string | undefined} What the credential looks like, if any.
 */
export function findSecret(text) {
	const source = String(text ?? '')
	for (const [pattern, label] of SECRET_PATTERNS) {
		if (pattern.test(source)) return label
	}
	return undefined
}

/**
 * Replace credentials in text that is only being read, not stored.
 *
 * @param {string} text - The candidate text.
 * @returns {string} The text with credential-shaped runs replaced.
 */
export function redactSecrets(text) {
	let out = String(text ?? '')
	for (const [pattern] of SECRET_PATTERNS) {
		const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`)
		out = out.replace(global, '[REDACTED]')
	}
	return out
}
