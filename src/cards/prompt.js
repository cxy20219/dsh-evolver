/**
 * The tag map injected on every request.
 *
 * Only the tag tree and the meaning of each tag branch are injected — never a
 * card label, id or body. Specific content is reached through `card_query`,
 * `card_read`, links and backlinks, so the prompt stays a stable map instead
 * of a stale index of cards.
 */

import { buildTagTree, descriptionOf } from './tags.js'

/** The branches that should lead the injected map. */
const ROOT_ORDER = ['收集箱', '临时', '永久笔记', '实践', '归档', '事实', '偏好', '约定', '纠正', '踩坑', '工具怪癖']

/** The fixed discipline text. */
export const CARD_DISCIPLINE = [
	'[卡片] 只注入标签树，不注入卡片正文；标签路径就是分类，父标签包含所有子标签。',
	'- 找内容用 card_query（关键词/标签），读全文用 card_read；双链和反链跟着卡片走。',
	'- 新卡默认 #收集箱；整理后用 #临时 或 #永久笔记；已验证的实践用 #实践/经验、#实践/工作流、#实践/工具。',
	'- 不写流水账、一次性命令、猜测、密钥；没有高信号就跳过。',
].join('\n')

/**
 * Render the tag tree, with a description on documented branches.
 *
 * @param {object} cards - The card store.
 * @returns {string[]} One line per branch.
 */
function treeLines(cards) {
	const roots = buildTagTree(cards.all())
	const lines = []
	/**
	 * Add one node and its children.
	 *
	 * @param {object} node - The tag node.
	 * @param {number} depth - Indentation depth.
	 * @returns {void}
	 */
	function walk(node, depth) {
		const description = descriptionOf(node.path)
		lines.push(`${'  '.repeat(depth)}#${node.path} (${node.count})${description === '' ? '' : ` — ${description}`}`)
		for (const child of node.children) walk(child, depth + 1)
	}
	const rank = (node) => {
		const index = ROOT_ORDER.indexOf(node.path)
		return index < 0 ? ROOT_ORDER.length : index
	}
	roots.sort((left, right) => rank(left) - rank(right) || left.path.localeCompare(right.path))
	for (const root of roots) walk(root, 0)
	return lines
}

/**
 * Build the injected card section.
 *
 * @param {object} cards - The card store.
 * @param {number} [budget] - Total section budget.
 * @returns {string} The section text.
 */
export function cardPrompt(cards, budget = 2048) {
	const header = `${CARD_DISCIPLINE}\n[标签类型] #收集箱=刚收集；#临时=未验证；#永久笔记=长期原子笔记；#实践=已验证实践；#归档=保留追溯\n[标签树]`
	const lines = treeLines(cards)
	if (lines.length === 0) return `${header}\n（空；新卡默认 #收集箱）`
	const kept = []
	let used = Buffer.byteLength(header, 'utf8')
	for (const line of lines) {
		const size = Buffer.byteLength(`${line}\n`, 'utf8')
		if (used + size > budget) break
		kept.push(line)
		used += size
	}
	if (kept.length < lines.length) kept.push('…（标签树超出预算，请用 card_query 按标签/关键词检索）')
	return `${header}\n${kept.join('\n')}`
}
