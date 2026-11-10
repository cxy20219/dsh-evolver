/**
 * Vocabulary shared by the storage schema, the tools and the pure logic.
 *
 * Kept free of host imports so every other module stays testable with a bare
 * `node --test` run.
 */

export const ENTRY_KINDS = ['fact', 'preference', 'convention', 'correction', 'failure', 'tool-quirk']
export const NODE_KINDS = ['constraint', 'decision', 'artifact', 'progress']
export const EDGE_KINDS = ['derived', 'supersedes', 'depends', 'supports', 'contradicts']
export const SCOPES = ['global', 'user', 'project', 'failure']
export const SOURCES = ['explicit', 'capture', 'archive', 'import']

export function isNodeKind(kind) {
	return NODE_KINDS.includes(kind)
}

export function isEntryKind(kind) {
	return ENTRY_KINDS.includes(kind)
}

/** Scope a captured statement belongs to. */
export function scopeForKind(kind) {
	if (kind === 'preference') return 'user'
	if (kind === 'failure') return 'failure'
	if (kind === 'fact') return 'global'
	return 'project'
}
