/**
 * The tag directory behind the `card_index` tool.
 *
 * Rendering is line-oriented on purpose: the JSON tree this replaced wrote
 * every path twice (once as a node, once as a description key) and paid for
 * quotes and braces. One line per tag — path, card count, description inline —
 * is about 60% smaller for the same information, and the model copies the path
 * from a line just as well.
 *
 * The result has a byte budget because it stays in the conversation for the
 * rest of the session: a 300-tag tree as JSON was ~40 KB, which every later
 * request would pay for again. The ladder mirrors the injected card index:
 *
 *   1. every level with descriptions;
 *   2. every level without descriptions;
 *   3. fewer levels, first with descriptions then without;
 *   4. roots only, whole lines, plus a hint to drill in with `tag`.
 *
 * `truncated: true` means the budget forced less than what was asked for; a
 * caller that limited `depth` on purpose still gets `truncated: false`.
 */

import { descriptionOf } from './tags.js'

/** The byte budget of one `card_index` result. @internal exported for tests */
export const INDEX_BUDGET_BYTES = 2048

/** How many levels a full directory may show (1 = roots only). */
const INDEX_MAX_DEPTH = 3

/** One indent level, shared by every rendered line. */
const INDENT = '  '

/**
 * Flatten a tag forest into a list.
 *
 * @param {object[]} nodes - Root nodes.
 * @returns {object[]} Every node, roots first.
 */
export function flattenTagTree(nodes) {
	const result = []
	for (const node of nodes ?? []) {
		result.push(node)
		result.push(...flattenTagTree(node.children))
	}
	return result
}

/**
 * The card count a directory node carries.
 *
 * @param {object} node - A tag node.
 * @returns {number} The count.
 */
function countOf(node) {
	return Number.isFinite(node?.count) ? node.count : 0
}

/**
 * Render one tag as a single line.
 *
 * @param {object} node - The tag node.
 * @param {object} descriptions - Effective tag descriptions.
 * @param {{withDescription: boolean, unexpanded: number}} options - Detail level.
 * @returns {string} One line, without indentation.
 */
function lineOf(node, descriptions, { withDescription, unexpanded }) {
	const parts = [`${node.path} (${countOf(node)})`]
	// A marker, not a paragraph: it tells the model a branch continues without
	// paying for the whole subtree here.
	if (unexpanded > 0) parts.push(`[${unexpanded} 子]`)
	const description = withDescription ? descriptionOf(node.path, descriptions) : ''
	if (description !== '') parts.push(description)
	return parts.join(' ')
}

/**
 * Render a forest, level by level.
 *
 * @param {object[]} nodes - The forest.
 * @param {object} descriptions - Effective tag descriptions.
 * @param {{levels: number, withDescription: boolean, level?: number}} options - How deep and how detailed.
 * @returns {string[]} The lines.
 */
function renderLevels(nodes, descriptions, { levels, withDescription, level = 0 }) {
	const lines = []
	for (const node of nodes ?? []) {
		const children = Array.isArray(node.children) ? node.children : []
		const expand = level + 1 < levels && children.length > 0
		lines.push(INDENT.repeat(level) + lineOf(node, descriptions, {
			withDescription,
			unexpanded: expand ? 0 : children.length,
		}))
		if (expand) lines.push(...renderLevels(children, descriptions, { levels, withDescription, level: level + 1 }))
	}
	return lines
}

/**
 * Whether a set of lines fits the budget.
 *
 * @param {string[]} lines - The lines.
 * @param {number} budget - Byte budget.
 * @returns {boolean} True when it fits.
 */
function fits(lines, budget) {
	return Buffer.byteLength(lines.join('\n'), 'utf8') <= budget
}

/**
 * The one line that tells the model what the budget cost it.
 *
 * A degraded directory must say what is missing, otherwise the model reads a
 * shorter tree as the whole tree and files cards into a branch it never saw.
 *
 * @param {{levels: number, withDescription: boolean}} chosen - The attempt that fit.
 * @param {{levels: number, withDescription: boolean}} full - What the caller asked for.
 * @returns {string} The hint line, or an empty string when nothing was lost.
 */
function degradationHint(chosen, full) {
	if (chosen.levels === full.levels && chosen.withDescription === full.withDescription) return ''
	const lost = []
	if (chosen.levels < full.levels) lost.push(`只展开到第 ${chosen.levels} 层`)
	if (chosen.withDescription === false) lost.push('省略说明')
	return `（预算内${lost.join('、')}；用 tag 钻取某个枝干看更多）`
}

/**
 * The detail ladder, most informative first.
 *
 * Paths are kept before descriptions: knowing which branches exist is what
 * prevents duplicate classification; a missing description only costs one
 * extra `tag` call.
 *
 * @param {number} levels - The most levels the caller asked for.
 * @returns {Array<{levels: number, withDescription: boolean}>} The attempts.
 */
function ladderOf(levels) {
	const attempts = []
	for (let depth = levels; depth >= 1; depth -= 1) {
		attempts.push({ levels: depth, withDescription: true }, { levels: depth, withDescription: false })
	}
	return attempts
}

/**
 * Render the whole tag directory within the budget.
 *
 * @param {object[]} nodes - The root branches.
 * @param {object} descriptions - Effective tag descriptions.
 * @param {{depth?: number, budget?: number}} [options] - Depth and budget.
 * @returns {{text: string, truncated: boolean}} The directory and whether the budget forced less detail.
 */
export function renderTagIndex(nodes, descriptions, { depth = INDEX_MAX_DEPTH, budget = INDEX_BUDGET_BYTES } = {}) {
	const total = flattenTagTree(nodes).length
	if (total === 0) return { text: '（标签库为空；新卡默认 #即兴）', truncated: false }
	const levels = Math.max(1, Math.min(INDEX_MAX_DEPTH, Math.round(Number(depth)) || INDEX_MAX_DEPTH))
	const attempts = ladderOf(levels)
	for (const attempt of attempts) {
		const lines = renderLevels(nodes, descriptions, attempt)
		const hint = degradationHint(attempt, attempts[0])
		if (fits(hint === '' ? lines : [...lines, hint], budget)) {
			return { text: [...lines, ...(hint === '' ? [] : [hint])].join('\n'), truncated: hint !== '' }
		}
	}
	// Nothing above fits: keep whole root lines until the budget runs out and
	// say how many branches are missing. Partial paths are never emitted.
	const rootLines = renderLevels(nodes, descriptions, { levels: 1, withDescription: true })
	const kept = []
	for (const line of rootLines) {
		const hint = `（还有 ${rootLines.length - kept.length - 1} 个枝干未列出，共 ${total} 个标签；用 tag 钻取）`
		if (kept.length > 0 && !fits([...kept, line, hint], budget)) break
		kept.push(line)
	}
	const dropped = rootLines.length - kept.length
	const hint = dropped > 0
		? `（还有 ${dropped} 个枝干未列出，共 ${total} 个标签；用 tag 钻取）`
		: `（共 ${total} 个标签；用 tag 钻取单个枝干看说明）`
	return { text: [...kept, hint].join('\n'), truncated: true }
}

/**
 * Render one branch: the tag itself plus its children, within the budget.
 *
 * @param {object} node - The requested tag node.
 * @param {object} descriptions - Effective tag descriptions.
 * @param {{depth?: number, budget?: number}} [options] - How many levels below the tag (1 = direct children).
 * @returns {{text: string, truncated: boolean}} The branch and whether the budget forced less detail.
 */
export function renderTagBranch(node, descriptions, { depth = 1, budget = INDEX_BUDGET_BYTES } = {}) {
	const levels = Math.max(2, Math.round(Number(depth)) + 1 || 2)
	const attempts = [
		{ levels, withDescription: true },
		{ levels, withDescription: false },
		{ levels: 2, withDescription: true },
		{ levels: 2, withDescription: false },
	]
	for (const attempt of attempts) {
		const lines = renderLevels([node], descriptions, attempt)
		if (fits(lines, budget)) return { text: lines.join('\n'), truncated: attempt !== attempts[0] }
	}
	// Keep the requested line and as many direct children as fit, whole lines.
	const childLines = renderLevels(node.children, descriptions, { levels: 1, withDescription: false })
	const head = renderLevels([node], descriptions, { levels: 1, withDescription: true })[0]
	const kept = []
	for (const line of childLines) {
		const hint = `（还有 ${childLines.length - kept.length - 1} 个子标签未列出；用 tag 继续钻取）`
		if (kept.length > 0 && !fits([head, ...kept, line, hint], budget)) break
		kept.push(line)
	}
	const dropped = childLines.length - kept.length
	const hint = dropped > 0
		? `（还有 ${dropped} 个子标签未列出；用 tag 继续钻取）`
		: ''
	return { text: [head, ...kept, hint].filter((line) => line !== '').join('\n'), truncated: true }
}

/**
 * Resolve a tag token to one node.
 *
 * Accepts the full path (`践行/工作流`), a unique suffix (`工作流`) or a unique
 * path prefix, because the model should not have to remember the exact
 * spelling of a branch it just read.
 *
 * @param {object[]} nodes - The root branches.
 * @param {string} token - What the caller asked for.
 * @returns {{node: object} | {suggestions: string[]}} The node, or what to try instead.
 */
export function resolveTag(nodes, token) {
	const clean = String(token ?? '').trim().replace(/^#+/, '').replace(/^\/+|\/+$/g, '')
	if (clean === '') return { suggestions: [] }
	const all = flattenTagTree(nodes)
	const exact = all.find((node) => node.path === clean)
	if (exact !== undefined) return { node: exact }
	const suffix = all.filter((node) => node.path.endsWith(`/${clean}`))
	if (suffix.length === 1) return { node: suffix[0] }
	const prefix = all.filter((node) => node.path.startsWith(clean))
	if (prefix.length === 1) return { node: prefix[0] }
	const pool = suffix.length > 0 ? suffix : prefix
	return { suggestions: pool.slice(0, 3).map((node) => node.path) }
}
