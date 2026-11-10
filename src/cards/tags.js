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

/** The reserved lifecycle tags. */
export const LIFECYCLE_TAGS = {
	inbox: '收集箱',
	fleeting: '临时',
	permanent: '永久笔记',
	practice: '实践',
	archived: '归档',
}

/**
 * What each reserved branch means. Injected instead of card summaries, so the
 * agent knows where to search without seeing the cards themselves.
 */
export const TAG_DESCRIPTIONS = {
	收集箱: '刚收集、尚未整理的卡片；新卡默认入口',
	临时: '临时笔记，尚未验证，可随时丢弃',
	永久笔记: '长期保留的原子笔记；子标签表示领域/主题',
	'永久笔记/web开发': 'Web 开发主题的永久笔记',
	'永久笔记/web开发/react开发': 'React 开发主题的永久笔记',
	实践: '经过验证、可复用的实践笔记；子标签表示实践类型',
	'实践/经验': '踩坑经验、判断与边界',
	'实践/工作流': '可重复执行的工作流/流程',
	'实践/工具': '可复用的脚本、CLI 与工具用法',
	'实践/资源': '模板、示例与静态资源',
	归档: '不再活跃、保留追溯的卡片',
	事实: '确认过的事实',
	偏好: '长期稳定的个人/团队偏好',
	约定: '项目约定与规范',
	纠正: '对旧结论的纠正',
	踩坑: '踩过的坑与失败教训',
	工具怪癖: '外部工具的稳定怪癖',
}

/**
 * Whether a tag is under one of the given roots.
 *
 * @param {string} tag - The tag.
 * @param {string[]} roots - The roots.
 * @returns {boolean} True when it matches one.
 */
function underAny(tag, roots) {
	return roots.some((root) => isUnder(tag, root))
}

/**
 * The lifecycle implied by a card's tags.
 *
 * `归档` wins over everything; `实践` and `永久笔记` mean permanent; `临时`
 * means fleeting; anything else is the inbox.
 *
 * @param {string[]} tags - The card tags.
 * @returns {'archived'|'permanent'|'fleeting'|'inbox'} The lifecycle.
 */
export function lifecycleOf(tags = []) {
	if (tags.some((tag) => isUnder(tag, LIFECYCLE_TAGS.archived))) return 'archived'
	if (tags.some((tag) => underAny(tag, [LIFECYCLE_TAGS.practice, LIFECYCLE_TAGS.permanent]))) return 'permanent'
	if (tags.some((tag) => isUnder(tag, LIFECYCLE_TAGS.fleeting))) return 'fleeting'
	return 'inbox'
}

/**
 * Whether a card is archived.
 *
 * @param {string[]} tags - The card tags.
 * @returns {boolean} True when it is archived.
 */
export function isArchived(tags = []) {
	return tags.some((tag) => isUnder(tag, LIFECYCLE_TAGS.archived))
}

/**
 * Whether a card is permanent (practice or permanent note).
 *
 * @param {string[]} tags - The card tags.
 * @returns {boolean} True when it is permanent.
 */
export function isPermanent(tags = []) {
	return tags.some((tag) => underAny(tag, [LIFECYCLE_TAGS.practice, LIFECYCLE_TAGS.permanent]))
}

/**
 * The tag description, if the branch is documented.
 *
 * @param {string} tag - The tag path.
 * @returns {string} The description, or an empty string.
 */
export function descriptionOf(tag) {
	return TAG_DESCRIPTIONS[tag] ?? ''
}

/**
 * Keep one lifecycle marker and normalise the reserved tags.
 *
 * A card tagged `实践/经验` or `永久笔记/...` is permanent even when it has
 * no `永久笔记` root; `归档` stays as an independent state.
 *
 * @param {unknown} values - The tags.
 * @param {{defaultLifecycle?: 'inbox'|'fleeting'}} [options] - Fallback marker.
 * @returns {string[]} Normalised tags.
 */
export function normalizeLifecycleTags(values, { defaultLifecycle = 'inbox' } = {}) {
	const tags = normalizeTags(values)
	const permanent = tags.some((tag) => underAny(tag, [LIFECYCLE_TAGS.practice, LIFECYCLE_TAGS.permanent]))
	const fleeting = tags.some((tag) => isUnder(tag, LIFECYCLE_TAGS.fleeting))
	const inbox = tags.some((tag) => isUnder(tag, LIFECYCLE_TAGS.inbox))
	const kept = tags.filter((tag) => !underAny(tag, [LIFECYCLE_TAGS.inbox, LIFECYCLE_TAGS.fleeting]))
	if (permanent) return kept
	if (fleeting) return [LIFECYCLE_TAGS.fleeting, ...kept].slice(0, MAX_TAGS)
	if (inbox) return [LIFECYCLE_TAGS.inbox, ...kept].slice(0, MAX_TAGS)
	return [LIFECYCLE_TAGS[defaultLifecycle], ...kept].slice(0, MAX_TAGS)
}

/**
 * Turn a card permanent.
 *
 * @param {string[]} values - The current tags.
 * @returns {string[]} The tags with an archive marker removed.
 */
export function promoteTags(values) {
	const tags = normalizeTags(values).filter((tag) => !isUnder(tag, LIFECYCLE_TAGS.archived))
	const permanent = tags.some((tag) => underAny(tag, [LIFECYCLE_TAGS.practice, LIFECYCLE_TAGS.permanent]))
	return normalizeLifecycleTags(permanent ? tags : [LIFECYCLE_TAGS.permanent, ...tags])
}

/**
 * Mark a card archived.
 *
 * @param {string[]} values - The current tags.
 * @returns {string[]} The tags with `归档`.
 */
export function archiveTags(values) {
	const tags = normalizeTags(values)
	if (isArchived(tags)) return tags
	return normalizeLifecycleTags([LIFECYCLE_TAGS.archived, ...tags])
}
