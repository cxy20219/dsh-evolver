import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
	MAX_PREFERENCES_BYTES,
	preferencesDataPath,
	preferencesPath,
	readPreferences,
	writePreferences
} from '../src/preferences.js'

/** 旧版 ziyan 的受管段标记，迁移时应只删标记行。 */
const LEGACY_BEGIN = '<!-- ziyan:preferences:begin -->'
const LEGACY_END = '<!-- ziyan:preferences:end -->'

/**
 * 造一对临时的 DSH home 与插件数据目录。
 *
 * @returns {Promise<{dshHome: string, dataDir: string}>} 两个目录。
 */
async function dirs() {
	const dshHome = await mkdtemp(join(tmpdir(), 'ziyan-prefs-home-'))
	const dataDir = await mkdtemp(join(tmpdir(), 'ziyan-prefs-data-'))
	return { dshHome, dataDir }
}

/**
 * 删掉一对临时目录。
 *
 * @param {{dshHome: string, dataDir: string}} pair - 目录。
 * @returns {Promise<void>} 完成。
 */
async function cleanup(pair) {
	await rm(pair.dshHome, { recursive: true, force: true })
	await rm(pair.dataDir, { recursive: true, force: true })
}

test('偏好：首次读取把数据建在自衍数据目录，并把 AGENTS.md 对齐过去', async () => {
	const pair = await dirs()
	try {
		const state = await readPreferences(pair)
		assert.equal(state.path, preferencesDataPath(pair.dataDir), '权威文件在数据目录')
		assert.equal(state.agentsPath, preferencesPath(pair.dshHome), 'DSH 读取入口在 DSH home')
		assert.equal(state.exists, true)
		assert.equal(state.readable, true)
		assert.equal(state.content, '')
		assert.equal(state.totalBytes, 0)
		assert.equal(state.cap, MAX_PREFERENCES_BYTES)
		assert.equal(await readFile(state.path, 'utf8'), '')
		assert.ok(state.mode === 'link' || state.mode === 'copy')
		if (state.mode === 'link') {
			assert.ok((await lstat(state.agentsPath)).isSymbolicLink())
		}
	} finally {
		await cleanup(pair)
	}
})

test('偏好：迁移现有 AGENTS.md 全文，只删旧受管段标记、内容保留', async () => {
	const pair = await dirs()
	try {
		const existing = [
			'# 核心原则',
			'',
			'- 全程使用中文',
			'',
			LEGACY_BEGIN,
			'- 旧的 ziyan 偏好',
			LEGACY_END,
			'',
			'## 执行纪律',
			'',
			'- 只做用户要求的事',
			'',
		].join('\n')
		await writeFile(preferencesPath(pair.dshHome), existing, 'utf8')
		const state = await readPreferences(pair)
		assert.match(state.content, /# 核心原则/, '原有规则保留')
		assert.match(state.content, /## 执行纪律/, '标记之后的规则也保留')
		assert.match(state.content, /旧的 ziyan 偏好/, '旧受管段的内容保留成普通正文')
		assert.doesNotMatch(state.content, /ziyan:preferences/, '只删标记行')
		const stored = await readFile(state.path, 'utf8')
		assert.equal(stored.trimEnd(), state.content, '数据文件与面板内容一致')
		assert.equal((await readFile(preferencesPath(pair.dshHome), 'utf8')).trimEnd(), state.content, 'DSH 读到的就是这份全文')
	} finally {
		await cleanup(pair)
	}
})

test('偏好：保存整份内容，再读一致；DSH 的 AGENTS.md 同步可见', async () => {
	const pair = await dirs()
	try {
		const saved = await writePreferences(pair, '# 偏好\n\n- 先读再改\n')
		assert.equal(saved.content, '# 偏好\n\n- 先读再改')
		assert.equal(saved.bytes, Buffer.byteLength(saved.content, 'utf8'))
		assert.equal(await readFile(saved.path, 'utf8'), '# 偏好\n\n- 先读再改\n')
		assert.equal(await readFile(preferencesPath(pair.dshHome), 'utf8'), '# 偏好\n\n- 先读再改\n')
		const reread = await readPreferences(pair)
		assert.equal(reread.content, '# 偏好\n\n- 先读再改')
	} finally {
		await cleanup(pair)
	}
})

test('偏好：外部改写 AGENTS.md 后，下一次读取以它为全文同步回数据目录', async () => {
	const pair = await dirs()
	try {
		await writePreferences(pair, '# 旧内容')
		// 把 AGENTS.md 换成普通文件：模拟用户绕过面板直接编辑全局规则。
		await rm(preferencesPath(pair.dshHome), { force: true })
		await writeFile(preferencesPath(pair.dshHome), '# 外部新规则\n\n- 中文回答\n', 'utf8')
		const state = await readPreferences(pair)
		assert.match(state.content, /外部新规则/, '外部内容被采纳')
		assert.equal(await readFile(state.path, 'utf8'), '# 外部新规则\n\n- 中文回答\n', '数据文件同步')
		assert.equal(await readFile(preferencesPath(pair.dshHome), 'utf8'), '# 外部新规则\n\n- 中文回答\n', 'DSH 入口仍读得到')
	} finally {
		await cleanup(pair)
	}
})

test('偏好：旧软链目标不被改写，AGENTS.md 改指向数据目录', async () => {
	const pair = await dirs()
	const legacyTarget = join(pair.dshHome, 'evolver-preferences.md')
	try {
		await writeFile(legacyTarget, '# 旧 evolver 规则\n', 'utf8')
		try {
			await symlink(legacyTarget, preferencesPath(pair.dshHome), 'file')
		} catch (error) {
			// 没有建软链的权限时这条迁移场景不成立；读取会退化 copy 模式，另有用例覆盖。
			if (error?.code === 'EPERM' || error?.code === 'EACCES') return
			throw error
		}
		const state = await readPreferences(pair)
		assert.match(state.content, /旧 evolver 规则/, '旧内容迁移进数据目录')
		assert.equal(await readFile(legacyTarget, 'utf8'), '# 旧 evolver 规则\n', '旧目标保持原样，不覆盖')
		if (state.mode === 'link') {
			const target = await readFile(preferencesPath(pair.dshHome), 'utf8')
			assert.match(target, /旧 evolver 规则/, 'AGENTS.md 链接到数据文件后仍读到同一份')
		}
	} finally {
		await cleanup(pair)
	}
})

test('偏好：保存时清掉旧受管标记，不会把标记带进文件', async () => {
	const pair = await dirs()
	try {
		const saved = await writePreferences(pair, `前面的 ${LEGACY_BEGIN} 中间的 ${LEGACY_END} 后面的`)
		assert.equal(saved.content, '前面的  中间的  后面的')
		const text = await readFile(saved.path, 'utf8')
		assert.doesNotMatch(text, /ziyan:preferences/, '标记不落盘')
	} finally {
		await cleanup(pair)
	}
})

test('偏好：超过 64 KB 拒绝写入，原内容保持', async () => {
	const pair = await dirs()
	try {
		await writePreferences(pair, '原来的偏好')
		const tooBig = 'x'.repeat(MAX_PREFERENCES_BYTES + 1)
		await assert.rejects(() => writePreferences(pair, tooBig), /字节/)
		const state = await readPreferences(pair)
		assert.equal(state.content, '原来的偏好')
	} finally {
		await cleanup(pair)
	}
})

test('偏好：读不出来时标 readable=false，不建数据文件也不改链接', async () => {
	const pair = await dirs()
	try {
		// 让 AGENTS.md 是个目录：Windows 与 POSIX 上读取都会失败。
		await mkdir(preferencesPath(pair.dshHome), { recursive: true })
		const state = await readPreferences(pair)
		assert.equal(state.readable, false)
		assert.equal(state.exists, false)
		assert.equal(state.content, '')
		assert.equal(await lstat(preferencesDataPath(pair.dataDir)).catch(() => undefined), undefined, '失败时不创建数据文件')
	} finally {
		await cleanup(pair)
	}
})
