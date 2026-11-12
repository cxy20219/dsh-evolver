import { access, lstat, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { Evolver, MAX_PREFERENCES_BYTES, resolveDshHome } from '../src/evolver.js'

/**
 * Build an evolver on a temporary home.
 *
 * @returns {Promise<{evolver: Evolver, root: string, home: string}>} The fixture.
 */
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), 'evr-home-'))
	const root = join(home, 'evolver')
	const evolver = new Evolver({ root, dshHome: home })
	return { evolver, root, home }
}

test('resolveDshHome 用 DSH_HOME，否则用 ~/.dsh', () => {
	assert.equal(resolveDshHome({ DSH_HOME: '/tmp/dsh-home' }), '/tmp/dsh-home')
	assert.match(resolveDshHome({}), /\.dsh$/)
})

test('ensure 只建文档骨架，不再生成旧实践树', async () => {
	const { evolver, root, home } = await fixture()
	try {
		await evolver.ensure()
		const prefs = await readFile(join(root, 'preferences/AGENTS.md'), 'utf8')
		assert.match(prefs, /个人偏好/)
		// The soul was removed from the plugin; a new folder must not grow one back.
		await assert.rejects(() => access(join(root, 'sight/soul.md')), { code: 'ENOENT' })
		await assert.rejects(() => access(join(root, 'practice')), { code: 'ENOENT' })
		assert.equal(evolver.globalPath, join(home, 'AGENTS.md'))
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('数据目录与偏好目录按 0700 创建，偏好文件按 0600', async () => {
	const { evolver, root, home } = await fixture()
	try {
		await evolver.ensure()
		assert.equal((await stat(root)).mode & 0o777, 0o700)
		assert.equal((await stat(join(root, 'preferences'))).mode & 0o777, 0o700)
		assert.equal((await stat(join(root, 'preferences/AGENTS.md'))).mode & 0o777, 0o600)
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('偏好可以读写，全局链接可以被建立与移除', async () => {
	const { evolver, home } = await fixture()
	try {
		await evolver.ensure()

		await evolver.preferencesWrite('# 新偏好\n')
		assert.match((await evolver.preferencesRead()).content, /新偏好/)
		assert.equal((await evolver.preferencesRead()).link.kind, 'missing')

		assert.equal((await evolver.linkGlobal()).linked, true)
		const linked = await evolver.preferencesRead()
		assert.equal(linked.link.kind, 'link')
		assert.match(await readFile(join(home, 'AGENTS.md'), 'utf8'), /新偏好/)

		assert.equal((await evolver.unlinkGlobal()).linked, false)
		assert.equal((await evolver.preferencesRead()).link.kind, 'missing')
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('全局链接不自动接管别人的软链，也不删别人的链接', async () => {
	const { evolver, home } = await fixture()
	try {
		await evolver.ensure()
		const foreign = join(home, 'foreign.md')
		await writeFile(foreign, '# 别人的偏好\n', 'utf8')
		await symlink(foreign, join(home, 'AGENTS.md'))
		await evolver.linkGlobalIfNeeded()
		assert.equal((await lstat(join(home, 'AGENTS.md'))).isSymbolicLink(), true)
		assert.equal((await evolver.globalLinkState()).ours, false)
		const unlinked = await evolver.unlinkGlobal()
		assert.equal(unlinked.foreign, true)
		assert.equal((await lstat(join(home, 'AGENTS.md'))).isSymbolicLink(), true)
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('二次接管不会丢掉上一份全局指令（备份名带时间戳）', async () => {
	const { evolver, root, home } = await fixture()
	try {
		await evolver.ensure()
		await writeFile(join(home, 'AGENTS.md'), '# 第一次\n', 'utf8')
		assert.equal((await evolver.linkGlobal()).linked, true)
		// 用户手动把软链换回普通文件并改了内容
		await rm(join(home, 'AGENTS.md'), { force: true })
		await writeFile(join(home, 'AGENTS.md'), '# 第二次\n', 'utf8')
		assert.equal((await evolver.linkGlobal()).linked, true)
		const names = await readdir(join(root, 'preferences'))
		const imported = await Promise.all(
			names.filter((name) => name.startsWith('AGENTS.md.imported')).map((name) => readFile(join(root, 'preferences', name), 'utf8')),
		)
		assert.equal(imported.some((text) => text.includes('第一次')), true, '第一次的内容仍留着')
		assert.equal(imported.some((text) => text.includes('第二次')), true, '第二次的内容也有备份，不被静默删掉')
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('悬空的全局链接会修到当前偏好', async () => {
	const { evolver, root, home } = await fixture()
	try {
		await evolver.ensure()
		await symlink(join(home, 'gone', 'AGENTS.md'), join(home, 'AGENTS.md'))
		assert.equal((await evolver.globalLinkState()).ours, false)
		await evolver.linkGlobalIfNeeded()
		const state = await evolver.globalLinkState()
		assert.equal(state.kind, 'link')
		assert.equal(state.ours, true, '悬空链要修到当前数据目录')
		assert.equal(await readlink(join(home, 'AGENTS.md')), join(root, 'preferences', 'AGENTS.md'))
		assert.match(await readFile(join(home, 'AGENTS.md'), 'utf8'), /个人偏好/)
		// 指向存在目标的别人的链接不被接管（原有行为）
		await rm(join(home, 'AGENTS.md'), { force: true })
		const foreign = join(home, 'foreign.md')
		await writeFile(foreign, '# 别人的\n', 'utf8')
		await symlink(foreign, join(home, 'AGENTS.md'))
		await evolver.linkGlobalIfNeeded()
		assert.equal((await evolver.globalLinkState()).ours, false)
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('injectionPreview 只给偏好，卡片投影由 card API 提供', async () => {
	const { evolver, home } = await fixture()
	try {
		await evolver.ensure()
		const preview = await evolver.injectionPreview()
		assert.equal(preview.practice, undefined)
		assert.equal(preview.soul, undefined)
		assert.match(preview.preferences.text, /个人偏好/)
		assert.ok(preview.totalBytes > 0)
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('overview 带出版本、根目录和偏好', async () => {
	const { evolver, home } = await fixture()
	try {
		await evolver.ensure()
		const overview = await evolver.overview()
		assert.equal(overview.root, join(home, 'evolver'))
		assert.equal('suggestions' in overview, false, '恒空的 suggestions 已删')
		assert.equal(overview.soul, undefined)
		assert.ok(overview.preferences.bytes > 0)
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('偏好有大小上限，外部超限文件读取时截断', async () => {
	const { evolver, root, home } = await fixture()
	try {
		await evolver.ensure()
		await assert.rejects(() => evolver.preferencesWrite('x'.repeat(MAX_PREFERENCES_BYTES + 1)), /字节/)

		await writeFile(join(root, 'preferences', 'AGENTS.md'), 'b'.repeat(MAX_PREFERENCES_BYTES * 2), 'utf8')
		const preferences = await evolver.preferencesRead()
		assert.equal(preferences.truncated, true)
		assert.ok(preferences.bytes <= MAX_PREFERENCES_BYTES)
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})
