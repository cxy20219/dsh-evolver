/**
 * JSON plumbing shared by the tool set.
 *
 * The four tools live in one module but a tool result has one shape on the
 * wire: a JSON object rendered as text, and a summary that drops the body.
 * Duplicating that here once keeps search/read/write/edit from drifting apart —
 * the model must not see a different `render` depending on which tool it
 * called.
 */

/**
 * Render one tool result as text.
 *
 * @param {unknown} _args - The call arguments (unused).
 * @param {unknown} value - The result.
 * @returns {object[]} The content blocks.
 */
export function render(_args, value) {
	return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** The shared output declaration: a JSON object the model can read. */
export const OBJECT_OUTPUT = { schema: { type: 'object', additionalProperties: true }, render }

/**
 * Drop members that are `undefined`, so the result stays JSON.
 *
 * @param {unknown} value - The value.
 * @returns {unknown} The sanitized value.
 */
export function sanitize(value) {
	return JSON.parse(JSON.stringify(value ?? {}))
}

/**
 * A compact view of one file: everything except the payload text.
 *
 * @param {object} file - A file as the store returns it.
 * @returns {object} The summary.
 */
export function summaryOf(file) {
	if (file === null || typeof file !== 'object') return file
	const { text, ...rest } = file
	void text
	return sanitize(rest)
}
