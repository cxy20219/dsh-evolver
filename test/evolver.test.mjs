import { access, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { Evolver, MAX_PREFERENCES_BYTES, MAX_SOUL_BYTES, resolveDshHome } from '../src/evolver.js'

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
		const soul = await readFile(join(root, 'sight/soul.md'), 'utf8')
		assert.match(soul, /灵魂/)
		const prefs = await readFile(join(root, 'preferences/AGENTS.md'), 'utf8')
		assert.match(prefs, /个人偏好/)
		await assert.rejects(() => access(join(root, 'practice')), { code: 'ENOENT' })
		assert.equal(evolver.globalPath, join(home, 'AGENTS.md'))
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('灵魂与偏好可以读写，全局链接可以被建立与移除', async () => {
	const { evolver, home } = await fixture()
	try {
		await evolver.ensure()
		await evolver.soulWrite('# 新灵魂\n')
		assert.match((await evolver.soulRead()).content, /新灵魂/)

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

test('injectionPreview 只给灵魂和偏好，卡片投影由 card API 提供', async () => {
	const { evolver, home } = await fixture()
	try {
		await evolver.ensure()
		const preview = await evolver.injectionPreview()
		assert.equal(preview.practice, undefined)
		assert.match(preview.soul.text, /灵魂/)
		assert.match(preview.preferences.text, /个人偏好/)
		assert.equal(preview.soul.budget, MAX_SOUL_BYTES)
		assert.ok(preview.totalBytes > 0)
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('overview 带出版本、根目录和两份文档', async () => {
	const { evolver, home } = await fixture()
	try {
		await evolver.ensure()
		const overview = await evolver.overview()
		assert.equal(overview.root, join(home, 'evolver'))
		assert.equal(Array.isArray(overview.suggestions), true)
		assert.ok(overview.soul.bytes > 0)
		assert.ok(overview.preferences.bytes > 0)
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('灵魂与偏好有大小上限，外部超限文件读取时截断', async () => {
	const { evolver, root, home } = await fixture()
	try {
		await evolver.ensure()
		await assert.rejects(() => evolver.soulWrite('x'.repeat(MAX_SOUL_BYTES + 1)), /字节/)
		await assert.rejects(() => evolver.preferencesWrite('x'.repeat(MAX_PREFERENCES_BYTES + 1)), /字节/)

		await writeFile(join(root, 'sight', 'soul.md'), 'a'.repeat(MAX_SOUL_BYTES * 4), 'utf8')
		await writeFile(join(root, 'preferences', 'AGENTS.md'), 'b'.repeat(MAX_PREFERENCES_BYTES * 2), 'utf8')
		const soul = await evolver.soulRead()
		assert.equal(soul.truncated, true)
		assert.equal(soul.fullBytes, MAX_SOUL_BYTES * 4)
		assert.ok(soul.bytes <= MAX_SOUL_BYTES)
		const preferences = await evolver.preferencesRead()
		assert.equal(preferences.truncated, true)
		assert.ok(preferences.bytes <= MAX_PREFERENCES_BYTES)
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})
