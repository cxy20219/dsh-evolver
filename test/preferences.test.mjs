import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
	BEGIN_MARKER,
	END_MARKER,
	MAX_PREFERENCES_BYTES,
	preferencesPath,
	readPreferences,
	writePreferences
} from '../src/preferences.js'

/**
 * 造一个临时的 DSH home。
 *
 * @returns {Promise<string>} 目录路径。
 */
async function home() {
	return mkdtemp(join(tmpdir(), 'ziyan-prefs-'))
}

test('偏好：文件不存在时读得出「还没有」，不是读失败', async () => {
	const dir = await home()
	const state = await readPreferences(dir)
	assert.equal(state.exists, false)
	assert.equal(state.readable, true)
	assert.equal(state.hasBlock, false)
	assert.equal(state.content, '')
	assert.equal(state.path, preferencesPath(dir))
	await rm(dir, { recursive: true, force: true })
})

test('偏好：第一次保存写出带标记的段落，再读回来一字不差', async () => {
	const dir = await home()
	const saved = await writePreferences(dir, '# 偏好\n\n- 先读再改\n')
	assert.equal(saved.exists, true)
	assert.equal(saved.hasBlock, true)
	assert.equal(saved.content, '# 偏好\n\n- 先读再改')
	const text = await readFile(preferencesPath(dir), 'utf8')
	assert.ok(text.includes(BEGIN_MARKER))
	assert.ok(text.includes(END_MARKER))
	const reread = await readPreferences(dir)
	assert.equal(reread.content, '# 偏好\n\n- 先读再改')
	await rm(dir, { recursive: true, force: true })
})

test('偏好：用户自己的 AGENTS.md 接在末尾，原有内容一个字节都不动', async () => {
	const dir = await home()
	const original = '# 核心原则\n\n- 全程使用中文\n'
	await writeFile(preferencesPath(dir), original, 'utf8')
	const saved = await writePreferences(dir, '一次只做一件事。')
	const text = await readFile(preferencesPath(dir), 'utf8')
	assert.ok(text.startsWith(original), '原有内容必须原样在前')
	assert.equal(saved.content, '一次只做一件事。')
	assert.equal(saved.hasBlock, true)
	await rm(dir, { recursive: true, force: true })
})

test('偏好：第二次保存只换段落，段落外的内容不变', async () => {
	const dir = await home()
	await writeFile(preferencesPath(dir), '头部规则\n\n尾部规则\n', 'utf8')
	await writePreferences(dir, '第一版')
	await writePreferences(dir, '第二版')
	const text = await readFile(preferencesPath(dir), 'utf8')
	assert.ok(text.startsWith('头部规则\n\n尾部规则\n'))
	assert.equal(text.split(BEGIN_MARKER).length, 2, '标记只能出现一次')
	assert.ok(text.includes('第二版'))
	assert.ok(!text.includes('第一版'))
	await rm(dir, { recursive: true, force: true })
})

test('偏好：正文里带标记会被剔掉，不会把段落边界搞乱', async () => {
	const dir = await home()
	const saved = await writePreferences(dir, `前面的 ${BEGIN_MARKER} 中间的 ${END_MARKER} 后面的`)
	const text = await readFile(preferencesPath(dir), 'utf8')
	assert.equal(text.split(BEGIN_MARKER).length, 2)
	assert.equal(text.split(END_MARKER).length, 2)
	assert.equal(saved.content, '前面的  中间的  后面的')
	await rm(dir, { recursive: true, force: true })
})

test('偏好：超过 64 KB 拒绝写入，文件保持原样', async () => {
	const dir = await home()
	await writePreferences(dir, '原来的偏好')
	const tooBig = 'x'.repeat(MAX_PREFERENCES_BYTES + 1)
	await assert.rejects(() => writePreferences(dir, tooBig), /字节/)
	const state = await readPreferences(dir)
	assert.equal(state.content, '原来的偏好')
	await rm(dir, { recursive: true, force: true })
})

test('偏好：AGENTS.md 是软链时写穿链接，链接本身不被替换', async () => {
	const dir = await home()
	const target = join(dir, 'real-preferences.md')
	await writeFile(target, '# 旧偏好\n', 'utf8')
	try {
		await symlink(target, preferencesPath(dir), 'file')
	} catch (error) {
		// 没开开发者模式的 Windows 建不了软链，这一条跳过。
		if (error?.code === 'EPERM' || error?.code === 'EACCES') {
			await rm(dir, { recursive: true, force: true })
			return
		}
		throw error
	}
	const before = await readPreferences(dir)
	assert.equal(before.link, target)
	const saved = await writePreferences(dir, '新的偏好')
	assert.equal(saved.content, '新的偏好')
	const info = await lstat(preferencesPath(dir))
	assert.ok(info.isSymbolicLink(), '原子写不能把链接换成普通文件')
	const text = await readFile(target, 'utf8')
	assert.ok(text.startsWith('# 旧偏好\n'), '链接目标的原有内容要留住')
	assert.ok(text.includes('新的偏好'))
	await rm(dir, { recursive: true, force: true })
})

test('偏好：读不出来时标 readable=false，界面据此禁用保存', async () => {
	const dir = await home()
	// 让 AGENTS.md 是个目录：Windows 与 POSIX 上读取都会失败。
	await mkdir(preferencesPath(dir), { recursive: true })
	const state = await readPreferences(dir)
	assert.equal(state.readable, false)
	assert.equal(state.exists, false)
	assert.equal(state.content, '')
	await rm(dir, { recursive: true, force: true })
})
