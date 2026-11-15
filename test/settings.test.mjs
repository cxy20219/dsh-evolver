import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { sanitizeImportedSettings, SettingsStore } from '../src/settings.js'
import { tempDir } from './helpers.mjs'

test('设置文件在数据目录内，默认值可读', async () => {
	const dir = await tempDir()
	try {
		const warnings = []
		const settings = new SettingsStore({ dataDir: dir, logger: { warn: (message) => warnings.push(message) } })
		await settings.load()
		assert.equal(settings.path, join(dir, 'system', 'settings.json'))
		assert.equal(settings.get().descriptionMaxChars, 160)
		assert.equal(settings.get().maxFileBytes, 25 * 1024 * 1024)
		assert.equal('injectionBudget' in settings.get(), false, '注入预算已不再属于设置')
		assert.deepEqual(warnings, [])
		const raw = JSON.parse(await readFile(settings.path, 'utf8'))
		assert.equal(raw.schema, 1)
		assert.equal(raw.dataDir, undefined)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('设置越界被夹紧，保存后可重新读取', async () => {
	const dir = await tempDir()
	try {
		const settings = new SettingsStore({ dataDir: dir })
		await settings.load()
		const saved = await settings.save({
			descriptionMaxChars: 500,
			maxFileBytes: 1,
			readTextBytes: 1024,
		})
		assert.equal(saved.descriptionMaxChars, 200)
		assert.equal(saved.maxFileBytes, 1024 * 1024)
		assert.equal(saved.readTextBytes, 4096)
		const again = new SettingsStore({ dataDir: dir })
		await again.load()
		assert.equal(again.get().descriptionMaxChars, 200)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('settings.json 里残留的 injectionBudget 被忽略，不写回 publicView', async () => {
	const dir = await tempDir()
	try {
		await mkdir(join(dir, 'system'), { recursive: true })
		await writeFile(
			join(dir, 'system', 'settings.json'),
			JSON.stringify({ schema: 1, descriptionMaxChars: 99, injectionBudget: 8192 }),
		)
		const settings = new SettingsStore({ dataDir: dir })
		await settings.load()
		assert.equal(settings.get().descriptionMaxChars, 99)
		assert.equal('injectionBudget' in settings.get(), false)
		assert.equal('injectionBudget' in settings.publicView(), false)
		await settings.save({ descriptionMaxChars: 100 })
		const raw = JSON.parse(await readFile(settings.path, 'utf8'))
		assert.equal('injectionBudget' in raw, false, '保存后不再写回旧键')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('settings.json 损坏时回退默认并告警，文件保留', async () => {
	const dir = await tempDir()
	try {
		await mkdir(join(dir, 'system'), { recursive: true })
		await writeFile(join(dir, 'system', 'settings.json'), '{ not json')
		const warnings = []
		const settings = new SettingsStore({ dataDir: dir, logger: { warn: (message) => warnings.push(message) } })
		await settings.load()
		assert.equal(settings.get().descriptionMaxChars, 160)
		assert.equal(warnings.length, 1)
		assert.match(warnings[0], /settings\.json/)
		assert.equal(await readFile(join(dir, 'system', 'settings.json'), 'utf8'), '{ not json')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('导入设置净化：只采纳被夹紧的 limits，自动整理强制关，模型用本机', async () => {
	const local = {
		organize: {
			model: { provider: 'local-provider', model: 'local-model' },
			auto: { sessions: { enabled: true, idleMinutes: 45 }, files: { enabled: false, hour: 5 } },
		},
	}
	const safe = sanitizeImportedSettings({
		descriptionMaxChars: 9_999,
		maxFileBytes: 1,
		readTextBytes: 999 * 1024 * 1024,
		organize: {
			model: { provider: 'evil', model: 'evil-model' },
			auto: { sessions: { enabled: true, idleMinutes: 5 }, files: { enabled: true, hour: 0 } },
		},
	}, local)
	assert.equal(safe.schema, 1)
	assert.equal(safe.descriptionMaxChars, 200, '归档 limits 被采纳并夹到上限')
	assert.equal(safe.maxFileBytes, 1024 * 1024, '归档 limits 被采纳并夹到下限')
	assert.equal(safe.readTextBytes, 4 * 1024 * 1024, '归档 limits 被采纳并夹到上限')
	assert.deepEqual(safe.organize.model, { provider: 'local-provider', model: 'local-model' })
	assert.equal(safe.organize.auto.sessions.enabled, false)
	assert.equal(safe.organize.auto.files.enabled, false)
	assert.equal(safe.organize.auto.sessions.idleMinutes, 45, '本机空闲窗口保留')
	assert.equal(safe.organize.auto.files.hour, 5, '本机每日时点保留')

	// No local model: the imported route is still discarded (follow the chat).
	const followChat = sanitizeImportedSettings(
		{ organize: { model: { provider: 'evil', model: 'evil-model' } } },
		{ organize: { model: null } },
	)
	assert.equal(followChat.organize.model, null)
	// A malformed archive block degrades to defaults instead of throwing.
	const malformed = sanitizeImportedSettings({ organize: 'not-an-object' }, undefined)
	assert.equal(malformed.organize.model, null)
	assert.equal(malformed.organize.auto.sessions.enabled, false)
})
