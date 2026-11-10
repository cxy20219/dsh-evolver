/**
 * The vocabulary the memory store uses.
 *
 * `kind` is ours (what the tools and the panel speak), `category` is the
 * reference implementation's taxonomy. Both live on a record so neither has
 * to be translated at read time.
 */

export { EDGE_KINDS, ENTRY_KINDS, NODE_KINDS, SCOPES, SOURCES, isEntryKind, isNodeKind, scopeForKind } from '../kinds.js'
