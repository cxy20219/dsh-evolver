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

/** The only allowed top-level branches. */
export const TOP_TAGS = ['践行', '见闻', '即兴', '复盘', '觉察', '试错']

/** The final segment that marks an archived branch. */
export const ARCHIVE_SEGMENT = '归档'

/**
 * What each top-level branch and the useful sub-branches mean.
 *
 * Injected into the prompt, so the agent knows where to search and where to
 * grow the tree without inventing a new top-level tag.
 */
export const TAG_DESCRIPTIONS = {
	践行: '落地与持续行动，偏个人执行',
	'践行/经验': '行动中验证过的判断与边界',
	'践行/工作流': '可重复执行的工作流/流程',
	'践行/工具': '可复用的脚本、CLI 与工具用法',
	'践行/资源': '模板、示例与静态资源',
	见闻: '外部输入与阅历积累',
	'见闻/事实': '确认过的事实',
	'见闻/工具怪癖': '外部工具的稳定怪癖',
	'见闻/网络': '网络环境与连通性见闻',
	即兴: '主动应变与灵活创造；新卡默认入口',
	复盘: '事后反思与经验提炼',
	'复盘/经验': '从前事中提炼的判断与边界',
	'复盘/纠正': '对旧结论的纠正',
	'复盘/踩坑': '踩过的坑与失败教训',
	觉察: '对内关注情绪、模式与盲区，是成长的内省起点',
	'觉察/偏好': '长期稳定的个人/团队偏好',
	'觉察/模式': '反复出现的行为/思维模式',
	'觉察/盲区': '尚未看见的盲区',
	试错: '低成本探索与迭代，与践行形成行动闭环',
	'试错/实验': '小成本实验与结果',
	'试错/踩坑': '试错中的失败与教训',
}

/**
 * The first segment of a tag.
 *
 * @param {string} tag - A normalised tag.
 * @returns {string} The top-level branch.
 */
export function rootOf(tag) {
	return String(tag ?? '').split('/')[0]
}

/**
 * Normalise and enforce the six top-level branches.
 *
 * @param {unknown} values - The tags.
 * @param {{defaultTop?: string}} [options] - Fallback for an empty list.
 * @returns {string[]} Normalised, whitelisted tags.
 */
export function normalizeCardTags(values, { defaultTop = '即兴' } = {}) {
	const tags = normalizeTags(values)
	for (const tag of tags) {
		const root = rootOf(tag)
		if (!TOP_TAGS.includes(root)) {
			throw new Error(`顶层标签只能是 ${TOP_TAGS.map((item) => `#${item}`).join(' / ')}，收到：#${tag}`)
		}
	}
	return tags.length === 0 ? [defaultTop] : tags
}

/**
 * Whether a card is archived through a `<branch>/归档` leaf.
 *
 * @param {string[]} tags - The tags.
 * @returns {boolean} True when archived.
 */
export function isArchived(tags = []) {
	return tags.some((tag) => tag.endsWith(`/${ARCHIVE_SEGMENT}`))
}

/**
 * Whether a card is still in the improvised branch.
 *
 * @param {string[]} tags - The tags.
 * @returns {boolean} True when it has an #即兴 branch.
 */
export function isImprovised(tags = []) {
	return tags.some((tag) => rootOf(tag) === '即兴')
}

/**
 * Whether a card has a settled top-level branch other than #即兴.
 *
 * @param {string[]} tags - The tags.
 * @returns {boolean} True when settled.
 */
export function isSettled(tags = []) {
	return tags.some((tag) => rootOf(tag) !== '即兴' && TOP_TAGS.includes(rootOf(tag)))
}

/**
 * Mark a card archived under its first top-level branch.
 *
 * @param {string[]} values - The current tags.
 * @returns {string[]} Tags with `<branch>/归档`.
 */
export function archiveTags(values) {
	const tags = normalizeCardTags(values)
	if (isArchived(tags)) return tags
	const root = rootOf(tags[0])
	return normalizeCardTags([`${root}/${ARCHIVE_SEGMENT}`, ...tags])
}

/**
 * Move a card out of #即兴 into one or more settled branches.
 *
 * Existing non-#即兴 tags are kept. Without targets, at least one existing
 * settled branch is required.
 *
 * @param {string[]} values - The current tags.
 * @param {string[]} targets - The branches chosen for the card.
 * @returns {string[]} The settled tags.
 */
export function settleTags(values, targets = []) {
	const existing = normalizeCardTags(values).filter((tag) => !isArchived([tag]) && rootOf(tag) !== '即兴')
	const rawTargets = normalizeTags(targets)
	const added = rawTargets.length === 0 ? [] : normalizeCardTags(rawTargets).filter((tag) => rootOf(tag) !== '即兴')
	const merged = [...existing, ...added.filter((tag) => !existing.includes(tag))]
	if (!isSettled(merged)) {
		throw new Error(`请选择六大枝干之一：${TOP_TAGS.filter((tag) => tag !== '即兴').map((tag) => `#${tag}`).join(' / ')}`)
	}
	return normalizeCardTags(merged)
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
