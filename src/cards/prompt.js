/**
 * The tag map injected on every request.
 *
 * Only the tag tree and the meaning of each tag branch are injected — never a
 * card label, id or body. Specific content is reached through `card_query`,
 * `card_read`, links and backlinks, so the prompt stays a stable map instead
 * of a stale index of cards.
 */

import { buildTagTree, descriptionOf, TAG_DESCRIPTIONS } from './tags.js'

/** The branches that should lead the injected map. */
const ROOT_ORDER = ['践行', '见闻', '即兴', '复盘', '觉察', '试错']

/**
 * The default byte budget of the injected card section.
 *
 * The tag tree now carries a one-line meaning per branch, which roughly
 * doubles its length; the budget has to cover the documented tree instead of
 * silently cutting the last branches off.
 */
export const DEFAULT_PROMPT_BUDGET = 4096

/** The fixed discipline text. */
export const CARD_DISCIPLINE = [
	'[卡片] 只注入标签树，不注入卡片正文；标签路径就是分类，父标签包含所有子标签。',
	'- 找内容用 card_query（关键词/标签），读全文用 card_read；双链和反链跟着卡片走。',
	'- 顶层只允许 #践行 #见闻 #即兴 #复盘 #觉察 #试错；新卡默认 #即兴，整理时选一个枝干继续向下生长。',
	'- 归档写成 <枝干>/归档，例如 #践行/归档；不要创建第七个顶层标签。',
	'- 有附件时正文必须写 `[标题]({{resource}})：用途、入口命令、输入输出、关联流程`；resourceContent 放完整文件，脚本附件自动可执行。',
	'- 不写流水账、一次性命令、猜测、密钥；没有高信号就跳过。',
].join('\n')

/**
 * Render the tag tree, with a description on documented branches.
 *
 * @param {object} cards - The card store.
 * @param {Record<string, string>} descriptions - The effective description map.
 * @returns {string[]} One line per branch.
 */
function treeLines(cards, descriptions) {
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
		const description = descriptionOf(node.path, descriptions)
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
 * @param {Record<string, string>} [descriptions] - The effective description map.
 * @returns {string} The section text.
 */
export function cardPrompt(cards, budget = DEFAULT_PROMPT_BUDGET, descriptions = TAG_DESCRIPTIONS) {
	const header = `${CARD_DISCIPLINE}\n[标签类型] #践行=落地行动；#见闻=外部输入；#即兴=主动应变；#复盘=反思提炼；#觉察=内省盲区；#试错=低成本迭代\n[标签树]`
	const lines = treeLines(cards, descriptions)
	if (lines.length === 0) return `${header}\n（空；新卡默认 #即兴）`
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
