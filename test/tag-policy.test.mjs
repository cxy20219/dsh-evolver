/**
 * The tag charter: what the review job may grow and what it may not.
 *
 * The prompt asks for good behaviour; this module is what makes the rules
 * hold. The cases below are the exact failure modes the charter exists for:
 * archive tags written as classification, one-off branches, synonyms, and a
 * second new branch in the same run.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { enforceTagPolicy, hasSettledTag, MAX_NEW_BRANCHES, POLICY_MAX_DEPTH } from '../src/cards/tag-policy.js'

/**
 * A policy context.
 *
 * @param {{known?: string[], described?: string[]}} [options] - The state.
 * @returns {object} The context.
 */
function context({ known = [], described = [] } = {}) {
	return {
		known: new Set(known),
		described: new Set(described),
		introduced: new Set(),
	}
}

test('标签守则：已有枝干原样放行，三层的新枝干也可以建', () => {
	const state = context({ known: ['践行', '践行/经验', '见闻/git/rebase'] })
	const { tags, dropped } = enforceTagPolicy(['践行/经验', '见闻/git/rebase'], state)
	assert.deepEqual(tags, ['践行/经验', '见闻/git/rebase'])
	assert.deepEqual(dropped, [])

	const next = context({ known: ['践行'], described: ['践行/工具/日志'] })
	const fresh = enforceTagPolicy(['践行/工具/日志'], next)
	assert.deepEqual(fresh.tags, ['践行/工具/日志'], `新建枝干到 ${POLICY_MAX_DEPTH} 层是允许的`)
	assert.deepEqual(fresh.dropped, [])
})

test('标签守则：归档、第七个顶层、新深层路径都被挡下，且说得出为什么', () => {
	const state = context({ known: ['践行'], described: ['践行/新枝干/更细/最深', '胡说/分支'] })
	const { tags, dropped } = enforceTagPolicy(
		['践行/归档', '胡说/分支', '践行/新枝干/更细/最深', '践行'],
		state,
	)
	assert.deepEqual(tags, ['践行'])
	assert.deepEqual(dropped.map((item) => item.tag).sort(), ['胡说/分支', '践行/归档', '践行/新枝干/更细/最深'].sort())
	assert.match(dropped.find((item) => item.tag === '践行/归档').why, /归档是状态/)
	assert.match(dropped.find((item) => item.tag === '胡说/分支').why, /六大枝干/)
	assert.match(dropped.find((item) => item.tag === '践行/新枝干/更细/最深').why, new RegExp(`最多 ${POLICY_MAX_DEPTH} 层`))
})

test('标签守则：新枝干要带说明，一次运行只能新建一个', () => {
	const state = context({ known: ['践行'], described: ['践行/工具'] })
	const first = enforceTagPolicy(['践行/工具'], state)
	assert.deepEqual(first.tags, ['践行/工具'], '有说明的新枝干放行')
	assert.deepEqual([...state.introduced], ['践行/工具'])

	// The quota is shared by the whole run, not by one action.
	state.described.add('践行/资源')
	const second = enforceTagPolicy(['践行/资源'], state)
	assert.deepEqual(second.tags, [], `一次运行最多新建 ${MAX_NEW_BRANCHES} 个枝干`)
	assert.match(second.dropped[0].why, /最多新建/)

	const next = context({ known: [], described: [] })
	const bare = enforceTagPolicy(['践行/无说明'], next)
	assert.deepEqual(bare.tags, [])
	assert.match(bare.dropped[0].why, /必须带一句说明/)
})

test('落定判定：只有 #即兴 和 #归档 不算落定', () => {
	assert.equal(hasSettledTag(['即兴']), false)
	assert.equal(hasSettledTag(['即兴/想法']), false)
	assert.equal(hasSettledTag(['践行/归档']), false)
	assert.equal(hasSettledTag(['践行/经验']), true)
	assert.equal(hasSettledTag(['即兴', '觉察/偏好']), true)
})
