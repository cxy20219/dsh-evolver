import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { SettingsStore, defaultSettings, defaultIngest, normalizeBackup } from '../src/settings.js'

/**
 * Build a settings store on a temporary file.
 *
 * @returns {Promise<{store: SettingsStore, path: string, dir: string}>} The fixture.
 */
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), 'evr-settings-'))
	const path = join(dir, 'evolver.config.json')
	const store = new SettingsStore({ path })
	await store.load()
	return { store, path, dir }
}

const ROOT_INFO = { root: '/data/evolver', source: 'default', warning: '', defaultRoot: '/data/default' }

test('设置文件不存在时给出默认值', async () => {
	const { store, dir } = await fixture()
	try {
		assert.deepEqual(store.get(), defaultSettings())
		const view = store.publicView(ROOT_INFO)
		assert.equal(view.dataDir, '/data/evolver')
		assert.equal(view.backup.enabled, false)
		assert.equal(view.backup.keep, 7)
		assert.equal(view.backup.hasAccessKeySecret, false)
		assert.deepEqual(defaultIngest(), { enabled: true, idleMinutes: 15 })
		assert.equal(view.ingest.enabled, true)
		assert.equal(view.ingest.idleMinutes, 15)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('闲时整理间隔被夹在 5–240 分钟', async () => {
	const { store, dir } = await fixture()
	try {
		await store.update({ ingest: { idleMinutes: 1 } })
		assert.equal(store.get().ingest.idleMinutes, 5)
		await store.update({ ingest: { idleMinutes: 999 } })
		assert.equal(store.get().ingest.idleMinutes, 240)
		await store.update({ ingest: { enabled: false } })
		assert.equal(store.get().ingest.enabled, false)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('桶名里带路径分隔符会被拒绝，建议路径由同一个时间戳拼成', async () => {
	const { store, dir } = await fixture()
	try {
		await store.update({ backup: { bucket: 'a/b c' } })
		assert.equal(store.get().backup.bucket, '')
		const view = store.publicView(ROOT_INFO)
		assert.equal(view.suggestedArchive, join(view.suggestedArchiveDir, view.suggestedArchiveName))
		assert.match(view.suggestedArchive, /\/data\/dsh-evolver-\d{8}-\d{6}\.tar\.gz$/)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('保存后能读回，文件权限是 0600', async () => {
	const { store, path, dir } = await fixture()
	try {
		await store.update({
			dataDir: '/moved/evolver',
			backup: {
				enabled: true,
				endpoint: 'oss-cn-hangzhou.aliyuncs.com',
				bucket: 'bucket-a',
				accessKeyId: 'AKID',
				accessKeySecret: 'SECRET',
				prefix: 'evolver',
				keep: 3,
				intervalMinutes: 60,
			},
		})
		const reopened = new SettingsStore({ path })
		await reopened.load()
		const settings = reopened.get()
		assert.equal(settings.dataDir, '/moved/evolver')
		assert.equal(settings.backup.enabled, true)
		assert.equal(settings.backup.bucket, 'bucket-a')
		assert.equal(settings.backup.accessKeySecret, 'SECRET')
		assert.equal(settings.backup.keep, 3)
		const info = await stat(path)
		assert.equal(info.mode & 0o777, 0o600)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('密钥只写不读：面板视图永远不带 secret', async () => {
	const { store, dir } = await fixture()
	try {
		await store.update({ backup: { accessKeyId: 'AKID', accessKeySecret: 'SECRET' } })
		const view = store.publicView(ROOT_INFO)
		assert.equal(view.backup.hasAccessKeySecret, true)
		assert.equal(Object.hasOwn(view.backup, 'accessKeySecret'), false)
		assert.equal(JSON.stringify(view).includes('SECRET'), false)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('留空表示不修改密钥，clearAccessKeySecret 才清空', async () => {
	const { store, dir } = await fixture()
	try {
		await store.update({ backup: { accessKeySecret: 'FIRST' } })
		await store.update({ backup: { accessKeySecret: '' } })
		assert.equal(store.get().backup.accessKeySecret, 'FIRST')
		await store.update({ backup: { clearAccessKeySecret: true } })
		assert.equal(store.get().backup.accessKeySecret, '')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('配置会被夹取到合理范围', async () => {
	const { store, dir } = await fixture()
	try {
		await store.update({
			backup: {
				keep: 999,
				intervalMinutes: 1,
				prefix: 'bad prefix!',
				endpoint: 'https://oss.example.com/',
				bucket: 'b',
			},
		})
		const backup = store.get().backup
		assert.equal(backup.keep, 60)
		assert.equal(backup.intervalMinutes, 5)
		assert.equal(backup.prefix, 'dsh-evolver')
		assert.equal(backup.endpoint, 'https://oss.example.com')
		const lowered = normalizeBackup({ keep: -5, intervalMinutes: 999999 })
		assert.equal(lowered.keep, 1)
		assert.equal(lowered.intervalMinutes, 10_080)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('损坏的设置文件被保留为 .broken，并回到默认值', async () => {
	const { dir, path } = await fixture()
	try {
		await writeFile(path, '{ not json', 'utf8')
		await chmod(path, 0o600)
		const store = new SettingsStore({ path })
		await store.load()
		assert.deepEqual(store.get(), defaultSettings())
		const broken = await readFile(`${path}.broken`, 'utf8')
		assert.match(broken, /not json/)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
