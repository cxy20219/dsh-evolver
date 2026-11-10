import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { Evolver, resolveDshHome, slugify } from '../src/evolver.js'

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

test('slugify 把主题变成目录名', () => {
	assert.equal(slugify('验证方法'), '验证方法')
	assert.equal(slugify('Verify Method'), 'verify-method')
	assert.equal(slugify('verify-method'), 'verify-method')
	assert.equal(slugify(''), '')
})

test('ensure 建出目录骨架并写入种子文件', async () => {
	const { evolver, root, home } = await fixture()
	try {
		await evolver.ensure()
		const index = await readFile(join(root, 'practice/INDEX.md'), 'utf8')
		assert.match(index, /确认插件改动是否生效/)
		const soul = await readFile(join(root, 'sight/soul.md'), 'utf8')
		assert.match(soul, /灵魂/)
		const prefs = await readFile(join(root, 'preferences/AGENTS.md'), 'utf8')
		assert.match(prefs, /个人偏好/)
		assert.equal(evolver.globalPath, join(home, 'AGENTS.md'))
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('migrate 把旧布局与面板的数据搬进来，且不删源文件', async () => {
	const { evolver, root, home } = await fixture()
	try {
		await mkdir(join(root, 'experience'), { recursive: true })
		await writeFile(join(root, 'experience/old.md'), '---\ntitle: 旧经验\npurpose: x\n---\n', 'utf8')
		await mkdir(join(home, 'panel/memory'), { recursive: true })
		await writeFile(join(home, 'panel/memory/memories.jsonl'), '', 'utf8')
		await writeFile(join(home, 'panel/agent.md'), '# 旧偏好\n', 'utf8')

		const moved = await evolver.migrate()
		assert.equal(moved.length, 3)
		const legacy = await readFile(join(root, 'practice/docs/legacy-experience/old.md'), 'utf8')
		assert.match(legacy, /旧经验/)
		const memory = await readFile(join(root, 'sight/memory/memories.jsonl'), 'utf8')
		assert.equal(memory, '')
		const prefs = await readFile(join(root, 'preferences/AGENTS.md'), 'utf8')
		assert.match(prefs, /旧偏好/)
		// The sources stay where they were.
		await readFile(join(root, 'experience/old.md'), 'utf8')
		await readFile(join(home, 'panel/agent.md'), 'utf8')
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('practiceWrite 写入条目并重建索引，practiceRead 能读回', async () => {
	const { evolver, root, home } = await fixture()
	try {
		await evolver.ensure()
		const saved = await evolver.practiceWrite({
			kind: 'doc',
			name: 'check.md',
			title: '检查清单',
			purpose: '收尾前过一遍',
			topic: '验证方法',
			body: '正文内容。',
		})
		assert.equal(saved.path, 'docs/验证方法/check.md')
		assert.equal(Array.isArray(saved.problems), true)
		assert.ok(saved.entries >= 3)
		assert.ok(saved.injectedBytes > 0)
		const entry = await evolver.practiceRead(saved.path)
		assert.equal(entry.title, '检查清单')
		assert.match(entry.content, /正文内容/)
		const index = await readFile(join(root, 'practice/INDEX.md'), 'utf8')
		assert.match(index, /检查清单/)
		await assert.rejects(() => evolver.practiceWrite({
			kind: 'doc',
			name: 'secret.md',
			title: '令牌',
			purpose: '不该落盘',
			body: 'key: sk-abcdefghijklmnopqrstuvwx',
		}), /密钥/)
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('灵魂与偏好可以读写，全局链接可以被建立与移除', async () => {
	const { evolver, home } = await fixture()
	try {
		await evolver.ensure()
		await evolver.soulWrite('# 新灵魂\n')
		const soul = await evolver.soulRead()
		assert.match(soul.content, /新灵魂/)

		await evolver.preferencesWrite('# 新偏好\n')
		const preferences = await evolver.preferencesRead()
		assert.match(preferences.content, /新偏好/)
		assert.equal(preferences.link.kind, 'missing')

		const linked = await evolver.linkGlobal()
		assert.equal(linked.linked, true)
		const afterLink = await evolver.preferencesRead()
		assert.equal(afterLink.link.kind, 'link')
		const global = await readFile(join(home, 'AGENTS.md'), 'utf8')
		assert.match(global, /新偏好/)

		const unlinked = await evolver.unlinkGlobal()
		assert.equal(unlinked.linked, false)
		assert.equal((await evolver.preferencesRead()).link.kind, 'missing')
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('injectionPreview 给出三块注入与字节数', async () => {
	const { evolver, home } = await fixture()
	try {
		await evolver.ensure()
		const preview = await evolver.injectionPreview()
		assert.match(preview.practice.text, /\[实践\]/)
		assert.match(preview.practice.text, /\[纪律\]/)
		assert.ok(preview.practice.bytes > 0)
		assert.equal(preview.practice.budget, 2048)
		assert.match(preview.soul.text, /灵魂/)
		assert.match(preview.preferences.text, /个人偏好/)
		assert.ok(preview.totalBytes > 0)
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('overview 汇总条目、注入字节与建议', async () => {
	const { evolver, home } = await fixture()
	try {
		await evolver.ensure()
		const overview = await evolver.overview()
		assert.ok(overview.practice.entries >= 2)
		assert.ok(overview.practice.injectedBytes > 0)
		assert.equal(overview.practice.injectedBudget, 2048)
		assert.equal(Array.isArray(overview.suggestions), true)
		assert.equal(overview.root, join(home, 'evolver'))
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})
