/**
 * Scope grammar and visibility.
 *
 * A scope says who a memory belongs to. The grammar follows the one the
 * reference implementation uses, so a scope reads the same way everywhere:
 *
 *   global              everyone
 *   user:<id>           one person
 *   project:<path>      one workspace
 *   agent:<id>          one agent
 *   custom:<name>       a named bucket the user defines
 *   failure             lessons that only surface after a failure
 *
 * The bare forms `user` and `project` are kept for the records the previous
 * plugin wrote.
 */

/** The scope kinds this plugin understands. */
export const SCOPE_KINDS = ['global', 'user', 'project', 'agent', 'custom', 'failure']

/**
 * Parse a scope string.
 *
 * @param {string} scope - The scope string.
 * @returns {{kind: string, id: string, key: string}} The parsed scope.
 */
export function parseScope(scope) {
	const value = String(scope ?? 'global').trim()
	if (value === '') return { kind: 'global', id: '', key: 'global' }
	const separator = value.indexOf(':')
	if (separator < 0) return { kind: value, id: '', key: value }
	const kind = value.slice(0, separator)
	const id = value.slice(separator + 1)
	return { kind, id, key: `${kind}:${id}` }
}

/**
 * Build a scope string.
 *
 * @param {string} kind - Scope kind.
 * @param {string} [id] - Scope id.
 * @returns {string} The scope string.
 */
export function formatScope(kind, id = '') {
	if (kind === 'global' || kind === 'failure') return kind
	return id === '' ? kind : `${kind}:${id}`
}

/**
 * The scope a piece of content belongs to when the caller did not say.
 *
 * @param {{cwd?: string, agentId?: string, userId?: string}} context - Where the content came from.
 * @param {string} [kind] - The requested kind.
 * @returns {string} The scope string.
 */
export function defaultScope(context = {}, kind = 'global') {
	if (kind === 'project') return formatScope('project', context.cwd ?? '')
	if (kind === 'user') return formatScope('user', context.userId ?? '')
	if (kind === 'agent') return formatScope('agent', context.agentId ?? '')
	return 'global'
}

/**
 * Whether a memory in `scope` is visible to `context`.
 *
 * @param {string} scope - The memory's scope.
 * @param {{cwd?: string, agentId?: string, userId?: string, custom?: string[]}} context - The viewer's context.
 * @returns {boolean} True when the memory is visible.
 */
export function scopeVisible(scope, context = {}) {
	const parsed = parseScope(scope)
	switch (parsed.kind) {
		case 'global':
			return true
		case 'failure':
			return false
		case 'user':
			return parsed.id === '' || parsed.id === (context.userId ?? '')
		case 'project':
			return parsed.id === '' || parsed.id === (context.cwd ?? '')
		case 'agent':
			return parsed.id === '' || parsed.id === (context.agentId ?? '')
		case 'custom':
			return parsed.id === '' || (context.custom ?? []).includes(parsed.id)
		default:
			return false
	}
}

/**
 * Every scope string the viewer can see, for a query filter.
 *
 * @param {{cwd?: string, agentId?: string, userId?: string, custom?: string[]}} context - The viewer's context.
 * @returns {string[]} Visible scope keys.
 */
export function visibleScopes(context = {}) {
	const scopes = ['global']
	if (context.userId) scopes.push(formatScope('user', context.userId))
	if (context.cwd) scopes.push(formatScope('project', context.cwd))
	if (context.agentId) scopes.push(formatScope('agent', context.agentId))
	for (const name of context.custom ?? []) scopes.push(formatScope('custom', name))
	return scopes
}
