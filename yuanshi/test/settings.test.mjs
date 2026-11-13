import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { SettingsStore } from '../src/settings.js'
import { tempDir } from './helpers.mjs'

test('设置文件在数据目录内，默认值可读', async () => {
	const dir = await tempDir()
	try {
		const warnings = []
		const settings = new SettingsStore({ dataDir: dir, logger: { warn: (message) => warnings.push(message) } })
		await settings.load()
		assert.equal(settings.path, join(dir, 'settings.json'))
		assert.equal(settings.get().descriptionMaxChars, 160)
		assert.equal(settings.get().maxFileBytes, 25 * 1024 * 1024)
		assert.equal(settings.get().injectionBudget, 4096)
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
			injectionBudget: 99_999,
		})
		assert.equal(saved.descriptionMaxChars, 200)
		assert.equal(saved.maxFileBytes, 1024 * 1024)
		assert.equal(saved.readTextBytes, 4096)
		assert.equal(saved.injectionBudget, 16 * 1024)
		const again = new SettingsStore({ dataDir: dir })
		await again.load()
		assert.equal(again.get().descriptionMaxChars, 200)
		assert.equal(again.get().injectionBudget, 16 * 1024)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('settings.json 损坏时回退默认并告警，文件保留', async () => {
	const dir = await tempDir()
	try {
		await writeFile(join(dir, 'settings.json'), '{ not json')
		const warnings = []
		const settings = new SettingsStore({ dataDir: dir, logger: { warn: (message) => warnings.push(message) } })
		await settings.load()
		assert.equal(settings.get().descriptionMaxChars, 160)
		assert.equal(warnings.length, 1)
		assert.match(warnings[0], /settings\.json/)
		assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), '{ not json')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
