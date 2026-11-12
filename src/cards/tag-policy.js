/**
 * The tag charter, as code.
 *
 * The daily consolidation prompt states the policy in words; this module is
 * what actually enforces it, so a reply that ignores the rules cannot grow the
 * tree by accident. Every tag list that comes from the review job — `retag`,
 * `update`, `merge`, `tag-merge` — is filtered here before it reaches a card.
 *
 * Four rules, in the order they bite:
 *
 * 1. `归档` is a state, not a classification: the review job never writes it.
 * 2. A branch may not be deeper than three segments.
 * 3. One run may introduce at most one new branch.
 * 4. A new branch must arrive with a one-line description.
 *
 * Existing branches are always accepted, even when they are deeper than the
 * policy allows: the rule governs growth, not an older library that already
 * has a three-level path.
 */

import { normalizeTag, rootOf, TOP_TAGS, ARCHIVE_SEGMENT } from './tags.js'

/** The deepest path a branch may take: branch / topic / subtopic. */
/** @internal exported for tests */
export const POLICY_MAX_DEPTH = 3

/** How many new branches one consolidation run may introduce. */
/** @internal exported for tests */
export const MAX_NEW_BRANCHES = 1

/**
 * Whether the tag belongs to one of the six branches.
 *
 * @param {string} tag - A normalised tag.
 * @returns {boolean} True when the top segment is allowed.
 */
function hasAllowedRoot(tag) {
	return TOP_TAGS.includes(rootOf(tag))
}

/**
 * Whether a list already carries a settled branch.
 *
 * #即兴 is the inbox and #归档 is a state, so neither counts as settled.
 *
 * @param {string[]} tags - The tags.
 * @returns {boolean} True when at least one branch is settled.
 */
export function hasSettledTag(tags) {
	return tags.some((tag) => hasAllowedRoot(tag) && rootOf(tag) !== '即兴' && !tag.endsWith(`/${ARCHIVE_SEGMENT}`))
}

/**
 * Filter one proposed tag list through the charter.
 *
 * @param {unknown[]} proposed - The raw tags from the model.
 * @param {{known: Set<string>, described: Set<string>, introduced: Set<string>}} context - What the run knows: existing branches, branches with a description, and the new branches it has already accepted (mutated).
 * @returns {{tags: string[], dropped: Array<{tag: string, why: string}>}} What survived and why the rest did not.
 */
export function enforceTagPolicy(proposed, context) {
	const tags = []
	const dropped = []
	const seen = new Set()
	for (const raw of Array.isArray(proposed) ? proposed : []) {
		// Depth is judged on the raw path: normalizeTag() would quietly cut a
		// too-deep path down to the limit, and a silent cut is how a proposal
		// becomes a branch nobody asked for.
		const source = String(raw ?? '').replace(/^#+/, '').trim()
		const rawDepth = source.split('/').filter((part) => part.trim() !== '').length
		if (rawDepth > POLICY_MAX_DEPTH) {
			dropped.push({ tag: source, why: `枝干最多 ${POLICY_MAX_DEPTH} 层` })
			continue
		}
		const tag = normalizeTag(raw)
		if (tag === '' || seen.has(tag)) continue
		seen.add(tag)
		if (tag.endsWith(`/${ARCHIVE_SEGMENT}`)) {
			dropped.push({ tag, why: '归档是状态，整理不写' })
			continue
		}
		if (!hasAllowedRoot(tag)) {
			dropped.push({ tag, why: '顶层只允许六大枝干' })
			continue
		}
		if (context.known.has(tag)) {
			tags.push(tag)
			continue
		}
		if (context.introduced.size >= MAX_NEW_BRANCHES) {
			dropped.push({ tag, why: `一次运行最多新建 ${MAX_NEW_BRANCHES} 个枝干` })
			continue
		}
		if (!context.described.has(tag)) {
			dropped.push({ tag, why: '新枝干必须带一句说明' })
			continue
		}
		context.introduced.add(tag)
		tags.push(tag)
	}
	return { tags, dropped }
}
