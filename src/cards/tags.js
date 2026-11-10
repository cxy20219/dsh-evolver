/**
 * Hierarchical tags.
 *
 * A tag is a path (`验证/浏览器`). A card tagged `验证/浏览器` also belongs to
 * every ancestor, so the tag tree is a multi-parent forest: the card appears
 * under `验证` and under `验证/浏览器`. There is deliberately no single
 * parent — notes grow across branches.
 */

/** The deepest tag supported. */
export const MAX_TAG_DEPTH = 4

/** The longest one segment may be. */
export const MAX_SEGMENT_CHARS = 32

/** How many tags one card may carry. */
export const MAX_TAGS = 8

/**
 * Normalise one tag.
 *
 * Unicode letters and numbers survive (Chinese tags are expected); whitespace
 * and punctuation collapse into single hyphens. The result is lower-case for
 * ASCII, NFC-normalised, and empty when nothing usable remains.
 *
 * @param {unknown} value - The raw tag.
 * @returns {string} The normalised tag, or an empty string.
 */
export function normalizeTag(value) {
	const source = String(value ?? '').trim().replace(/^#+/, '').normalize('NFC')
	if (source === '') return ''
	const parts = []
	for (const raw of source.split('/')) {
		if (parts.length >= MAX_TAG_DEPTH) break
		const part = raw
			.trim()
			.toLowerCase()
			.replace(/\s+/g, '-')
			.replace(/[^\p{L}\p{N}_-]+/gu, '-')
			.replace(/-+/g, '-')
			.replace(/^[-_]+|[-_]+$/g, '')
			.slice(0, MAX_SEGMENT_CHARS)
		if (part === '' || part === '.' || part === '..') return ''
		parts.push(part)
	}
	return parts.join('/')
}

/**
 * Normalise a list of tags.
 *
 * @param {unknown} values - An array or a comma/space separated string.
 * @returns {string[]} Unique, normalised tags.
 */
export function normalizeTags(values) {
	const list = Array.isArray(values)
		? values
		: String(values ?? '').split(/[,，\s]+/)
	const seen = new Set()
	const tags = []
	for (const value of list) {
		const tag = normalizeTag(value)
		if (tag === '' || seen.has(tag)) continue
		seen.add(tag)
		tags.push(tag)
		if (tags.length >= MAX_TAGS) break
	}
	return tags
}

/**
 * Every branch a tag belongs to, including itself.
 *
 * @param {string} tag - A normalised tag.
 * @returns {string[]} The ancestors, shortest first.
 */
export function tagPrefixes(tag) {
	const parts = String(tag ?? '').split('/').filter(Boolean)
	const prefixes = []
	for (let index = 1; index <= parts.length; index += 1) prefixes.push(parts.slice(0, index).join('/'))
	return prefixes
}

/**
 * Whether a card tagged `tag` belongs under `prefix`.
 *
 * @param {string} tag - The card tag.
 * @param {string} prefix - The tree branch.
 * @returns {boolean} True when it is the same tag or a descendant.
 */
export function isUnder(tag, prefix) {
	return tag === prefix || tag.startsWith(`${prefix}/`)
}

/**
 * Build the tag forest from cards.
 *
 * Counts are unique cards per branch, not tag occurrences: a card tagged
 * `验证/浏览器` and `验证/索引` counts once under `验证`.
 *
 * @param {Array<object>} cards - Cards with a `tags` array.
 * @returns {Array<object>} Root nodes with nested children.
 */
export function buildTagTree(cards) {
	const nodes = new Map()
	/**
	 * Get or create one node.
	 *
	 * @param {string} path - The tag path.
	 * @returns {object} The node.
	 */
	function node(path) {
		let found = nodes.get(path)
		if (found === undefined) {
			const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
			found = { path, name, count: 0, direct: 0, cards: new Set(), children: [] }
			nodes.set(path, found)
		}
		return found
	}
	for (const card of cards) {
		const tags = Array.isArray(card.tags) ? card.tags : []
		for (const tag of tags) {
			for (const prefix of tagPrefixes(tag)) {
				const branch = node(prefix)
				branch.cards.add(card.id)
				if (prefix === tag) branch.direct += 1
			}
		}
	}
	for (const branch of nodes.values()) {
		branch.count = branch.cards.size
		delete branch.cards
	}
	const roots = []
	for (const branch of nodes.values()) {
		const slash = branch.path.lastIndexOf('/')
		if (slash < 0) {
			roots.push(branch)
			continue
		}
		const parent = nodes.get(branch.path.slice(0, slash))
		parent.children.push(branch)
	}
	const sort = (list) => {
		list.sort((left, right) => (left.path < right.path ? -1 : 1))
		for (const item of list) sort(item.children)
	}
	sort(roots)
	return roots
}
