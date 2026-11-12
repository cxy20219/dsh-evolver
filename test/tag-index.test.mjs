/**
 * The budgeted tag directory behind `card_index`.
 *
 * The tool result stays in the conversation, so the tests pin the contract
 * that matters: the output never exceeds its byte budget, it degrades detail
 * before structure, and drilling into a tag stays readable.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
	INDEX_BUDGET_BYTES,
	flattenTagTree,
	renderTagBranch,
	renderTagIndex,
	resolveTag,
} from '../src/cards/tag-index.js'

/**
 * Build one tag node.
 *
 * @param {string} path - The tag path.
 * @param {number} count - Card count.
 * @param {object[]} [children] - Child nodes.
 * @returns {object} The node.
 */
function node(path, count, children = []) {
	return { path, name: path.slice(path.lastIndexOf('/') + 1), count, direct: count, children }
}

/** Descriptions for the small fixture. */
const DESCRIPTIONS = {
	践行: '落地与持续行动',
	'践行/工作流': '可重复执行的工作流',
	'践行/work/重试': '重试的边界',
	复盘: '事后反思',
	'复盘/经验': '提炼的判断',
}

/** Every line that names a tag: `path (count) ...`. */
const TAG_LINE = /^\s*\S+ \(\d+\)/

/**
 * Count the tag lines in a rendering.
 *
 * @param {string} text - Rendered directory.
 * @returns {string[]} The paths.
 */
function pathsOf(text) {
	return [...text.matchAll(/^\s*(\S+) \(\d+\)/gm)].map((match) => match[1])
}

test('小树一次看全：路径、计数、说明在同一行，不标记截断', () => {
	const tree = [
		node('践行', 3, [
			node('践行/工作流', 2, [node('践行/work/重试', 1)]),
			node('践行/经验', 1),
		]),
		node('复盘', 2, [node('复盘/经验', 2)]),
	]
	const result = renderTagIndex(tree, DESCRIPTIONS)
	assert.equal(result.truncated, false)
	assert.deepEqual(pathsOf(result.text), ['践行', '践行/工作流', '践行/work/重试', '践行/经验', '复盘', '复盘/经验'])
	assert.match(result.text, /^践行 \(3\) 落地与持续行动$/m)
	assert.match(result.text, /^ {2}践行\/工作流 \(2\) 可重复执行的工作流$/m)
	// 说明内联在同一行：模型读一行就知道这个标签是干什么的。
	assert.match(result.text, /^ {4}践行\/work\/重试 \(1\) 重试的边界$/m)
})

test('depth 控制层数：显式只列顶层枝干不算截断', () => {
	const tree = [node('践行', 3, [node('践行/工作流', 2, [node('践行/work/重试', 1)])])]
	const roots = renderTagIndex(tree, DESCRIPTIONS, { depth: 1 })
	assert.equal(roots.truncated, false)
	assert.deepEqual(pathsOf(roots.text), ['践行'])
	// 未展开的分支用计数标记告诉模型下面还有东西。
	assert.match(roots.text, /^践行 \(3\) \[1 子\] 落地与持续行动$/m)
	const two = renderTagIndex(tree, DESCRIPTIONS, { depth: 2 })
	assert.deepEqual(pathsOf(two.text), ['践行', '践行/工作流'])
})

test('大树不超预算：先省说明再少层，最后只留枝干并提示钻取', () => {
	const tree = []
	const descriptions = {}
	let index = 0
	for (const root of ['践行', '见闻', '即兴', '复盘', '觉察', '试错']) {
		const themes = []
		for (let theme = 0; theme < 20; theme += 1) {
			const subs = []
			for (let sub = 0; sub < 5; sub += 1) {
				const path = `${root}/主题${theme}/子题${sub}`
				descriptions[path] = `第 ${index++} 条标签说明，用足够长的文字把预算撑爆，确保降级阶梯真的被执行。`
				subs.push(node(path, sub + 1))
			}
			const themePath = `${root}/主题${theme}`
			descriptions[themePath] = `主题 ${theme} 的说明，也写得长一点。`
			themes.push(node(themePath, 5, subs))
		}
		descriptions[root] = `${root} 的根说明。`
		tree.push(node(root, 100, themes))
	}
	const total = flattenTagTree(tree).length
	assert.ok(total > 700, `fixture 要足够大：${total}`)

	const result = renderTagIndex(tree, descriptions)
	assert.ok(Buffer.byteLength(result.text, 'utf8') <= INDEX_BUDGET_BYTES, `超预算：${Buffer.byteLength(result.text, 'utf8')}`)
	assert.equal(result.truncated, true)
	assert.match(result.text, /用 tag 钻取/)
	// 降级先砍细节、不砍结构：所有根枝干都还在。
	for (const root of ['践行', '见闻', '即兴', '复盘', '觉察', '试错']) {
		assert.equal(pathsOf(result.text).includes(root), true, `根枝干缺失：${root}`)
	}
	// 每一行要么是完整标签行，要么是提示行；没有半截路径。
	for (const line of result.text.split('\n')) {
		assert.ok(TAG_LINE.test(line) || line.startsWith('（'), `不完整的输出行：${line}`)
	}
})

test('钻取一个标签：节点 + 直接子标签，未展开的层级带计数标记', () => {
	const branch = node('践行', 9, [
		node('践行/工作流', 4, [node('践行/工作流/重试', 2)]),
		node('践行/经验', 5),
	])
	const result = renderTagBranch(branch, DESCRIPTIONS)
	assert.equal(result.truncated, false)
	assert.deepEqual(pathsOf(result.text), ['践行', '践行/工作流', '践行/经验'])
	assert.match(result.text, /^践行 \(9\) 落地与持续行动$/m)
	assert.match(result.text, /^ {2}践行\/工作流 \(4\) \[1 子\] 可重复执行的工作流$/m)
	const deeper = renderTagBranch(branch, DESCRIPTIONS, { depth: 2 })
	assert.deepEqual(pathsOf(deeper.text), ['践行', '践行/工作流', '践行/工作流/重试', '践行/经验'])
})

test('钻取的子标签太多时也受预算约束，保留节点行与整行子标签', () => {
	const children = []
	const descriptions = { 践行: '根说明' }
	for (let index = 0; index < 100; index += 1) {
		const path = `践行/主题${index}`
		descriptions[path] = `第 ${index} 个子标签的说明，写得足够长以便触发预算降级。`
		children.push(node(path, index + 1))
	}
	const result = renderTagBranch(node('践行', 500, children), descriptions)
	assert.ok(Buffer.byteLength(result.text, 'utf8') <= INDEX_BUDGET_BYTES)
	assert.equal(result.truncated, true)
	assert.match(result.text, /^践行 \(500\) \[100 子\] 根说明$/m)
	assert.match(result.text, /还有 \d+ 个子标签未列出/)
	for (const line of result.text.split('\n')) {
		assert.ok(TAG_LINE.test(line) || line.startsWith('（'), `不完整的输出行：${line}`)
	}
})

test('标签解析：完整路径、唯一后缀、唯一前缀都能对上，歧义给候选', () => {
	const tree = [
		node('践行', 3, [node('践行/工作流', 2, [node('践行/工作流/重试', 1)])]),
		node('复盘', 2, [node('复盘/经验', 1)]),
		node('见闻', 2, [node('见闻/经验', 1)]),
	]
	assert.equal(resolveTag(tree, '践行/工作流').node.path, '践行/工作流')
	assert.equal(resolveTag(tree, '#复盘').node.path, '复盘')
	assert.equal(resolveTag(tree, ' 践行/工作流/重试 ').node.path, '践行/工作流/重试')
	assert.equal(resolveTag(tree, '工作流').node.path, '践行/工作流')
	const ambiguous = resolveTag(tree, '经验')
	assert.deepEqual(ambiguous.suggestions.sort(), ['复盘/经验', '见闻/经验'])
	const unknown = resolveTag(tree, '不存在')
	assert.deepEqual(unknown.suggestions, [])
})

test('空标签库给出可操作的提示，而不是空字符串', () => {
	const result = renderTagIndex([], {})
	assert.equal(result.truncated, false)
	assert.match(result.text, /标签库为空/)
})
