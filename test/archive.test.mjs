import assert from 'node:assert/strict'
import { createGzip } from 'node:zlib'
import { createWriteStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import test from 'node:test'

import { readArchiveFile, writeArchiveFile } from '../src/archive.js'
import { createDataJobs } from '../src/data-jobs.js'
import { readDataDirPointer } from '../src/home.js'
import { SettingsStore } from '../src/settings.js'
import { FileStore } from '../src/store.js'
import { buildTarHeader } from '../src/tar.js'

/**
 * A small source library.
 *
 * @returns {Promise<{root: string, data: string}>} Paths.
 */
async function library() {
	const root = await mkdtemp(join(tmpdir(), 'ziyan-archive-'))
	const data = join(root, 'data')
	const store = new FileStore({ dataDir: data })
	await store.open()
	await store.create({ name: 'note.md', description: '归档测试笔记', content: 'hello archive', tags: ['测试/归档'] })
	await store.create({ name: 'run.sh', description: '归档测试脚本', content: '#!/bin/sh\necho ok\n', tags: ['测试/归档', '类型/脚本'] })
	await mkdir(join(data, 'system'), { recursive: true })
	await writeFile(join(data, 'system', 'settings.json'), JSON.stringify({ descriptionMaxChars: 200 }))
	await store.close()
	return { root, data }
}

test('导出/导入往返：内容、边车、设置与可执行位；不包含 DB/日志', async () => {
	const { root, data } = await library()
	const archive = join(root, 'snapshot.tar.gz')
	const restored = join(root, 'restored')
	try {
		const packed = await writeArchiveFile(data, archive, { version: 'test' })
		assert.equal(packed.files, 2)
		assert.ok(packed.archiveBytes > 0)

		const read = await readArchiveFile(archive, restored)
		assert.equal(read.manifest.kind, 'ziyan-export')
		assert.equal(read.manifest.schema, 1)

		const store = new FileStore({ dataDir: restored })
		await store.open()
		try {
			const list = await store.list({ limit: 20 })
			assert.equal(list.total, 2)
			const note = list.files.find((file) => file.name === 'note.md')
			const script = list.files.find((file) => file.name === 'run.sh')
			assert.ok(note)
			assert.ok(script)
			assert.match((await store.read(note.id)).text, /hello archive/)
			// The tar header carries 0700, but Windows cannot represent it; the
			// store's executable flag is the contract both platforms share.
			if (process.platform !== 'win32') {
				assert.equal((await stat(join(restored, 'files', script.id, 'run.sh'))).mode & 0o111 ? true : false, true)
			}
			assert.equal((await store.read(script.id)).executable, true)
			assert.deepEqual(JSON.parse(await readFile(join(restored, 'system', 'settings.json'), 'utf8')), { descriptionMaxChars: 200 })
			const system = await readdir(join(restored, 'system'))
			assert.ok(system.includes('settings.json'))
			assert.ok(system.includes('ziyan.db'))
		} finally {
			store.close()
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('导入拒绝路径穿越与绝对路径', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ziyan-archive-bad-'))
	try {
		for (const [name, attack] of [['dotdot', 'files/../../evil.txt'], ['absolute', '/tmp/evil.txt']]) {
			const archive = join(root, `${name}.tar.gz`)
			const header = buildTarHeader({ path: attack, size: 4, mode: 0o600 })
			const body = Buffer.from('evil')
			const chunks = [header, body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)]
			await pipeline(Readable.from(chunks), createGzip(), createWriteStream(archive))
			const target = join(root, `${name}-target`)
			await assert.rejects(() => readArchiveFile(archive, target), /路径|不安全|越界|不允许/)
			await rm(target, { recursive: true, force: true })
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('导入/attach 的 settings 只采纳 limits：自动整理强制关、模型保留本机', async () => {
	const base = await mkdtemp(join(tmpdir(), 'ziyan-archive-settings-'))
	const current = join(base, 'current')
	try {
		// The local library owns the model route and the automatic switches.
		const localStore = new FileStore({ dataDir: current })
		await localStore.open()
		await localStore.create({
			name: 'local.md',
			description: '本机库里的文件，用来证明导入前的库结构是合法的。',
			content: 'local',
			tags: ['测试/导入'],
		})
		await localStore.close()
		const settings = new SettingsStore({ dataDir: current })
		await settings.load()
		await settings.save({
			organize: {
				model: { provider: 'local-provider', model: 'local-model' },
				auto: { sessions: { enabled: true, idleMinutes: 45 }, files: { enabled: false, hour: 5 } },
			},
		})

		// The archive carries a library plus a settings file that wants to spend
		// money and point the organizer at someone else's provider.
		const evil = join(base, 'evil')
		const evilStore = new FileStore({ dataDir: evil })
		await evilStore.open()
		await evilStore.create({
			name: 'evil.md',
			description: '归档里的文件，用来证明导入的数据本身可用。',
			content: 'evil',
			tags: ['测试/导入'],
		})
		await evilStore.close()
		await mkdir(join(evil, 'system'), { recursive: true })
		await writeFile(join(evil, 'system', 'settings.json'), JSON.stringify({
			descriptionMaxChars: 5,
			maxFileBytes: 999_999_999_999,
			readTextBytes: 3,
			organize: {
				model: { provider: 'evil', model: 'evil-model' },
				auto: { sessions: { enabled: true, idleMinutes: 5 }, files: { enabled: true, hour: 0 } },
			},
		}))
		const archive = join(base, 'evil.tar.gz')
		await writeArchiveFile(evil, archive, { version: 'test' })

		const pointerPath = join(base, 'ziyan.home.json')
		const jobs = createDataJobs({ root: current, pointerPath, settings, version: 'test' })
		const payload = (await readFile(archive)).toString('base64')
		const imported = await jobs.importLibrary({ data: payload, dir: join(base, 'imported') })

		const raw = JSON.parse(await readFile(join(imported.dir, 'system', 'settings.json'), 'utf8'))
		assert.equal(raw.organize.auto.sessions.enabled, false, '导入不能打开自动会话整理')
		assert.equal(raw.organize.auto.files.enabled, false, '导入不能打开自动文件整理')
		assert.deepEqual(raw.organize.model, { provider: 'local-provider', model: 'local-model' })
		assert.equal(raw.organize.auto.sessions.idleMinutes, 45)
		assert.equal(raw.organize.auto.files.hour, 5)
		assert.equal(raw.descriptionMaxChars, 20, 'limits 采纳但夹到安全下限')
		assert.equal(raw.maxFileBytes, 200 * 1024 * 1024)
		assert.equal(raw.readTextBytes, 4 * 1024)
		// The pointer is only written after the sanitized file is on disk.
		assert.equal((await readDataDirPointer(pointerPath)).dataDir, imported.dir)
		const reread = new SettingsStore({ dataDir: imported.dir })
		await reread.load()
		assert.equal(reread.get().organize.auto.sessions.enabled, false)
		assert.deepEqual(reread.get().organize.model, { provider: 'local-provider', model: 'local-model' })

		// Attaching an existing library follows the same rule.
		const attached = join(base, 'attached')
		const attachedStore = new FileStore({ dataDir: attached })
		await attachedStore.open()
		await attachedStore.create({
			name: 'attached.md',
			description: '被 attach 的库里的文件，用来证明 attach 会先做结构校验。',
			content: 'attached',
			tags: ['测试/导入'],
		})
		await attachedStore.close()
		await writeFile(join(attached, 'system', 'settings.json'), JSON.stringify({
			organize: { model: { provider: 'evil', model: 'evil-model' }, auto: { sessions: { enabled: true }, files: { enabled: true } } },
		}))
		await jobs.saveDir({ dir: attached, mode: 'attach' })
		const attachedRaw = JSON.parse(await readFile(join(attached, 'system', 'settings.json'), 'utf8'))
		assert.equal(attachedRaw.organize.auto.sessions.enabled, false)
		assert.equal(attachedRaw.organize.auto.files.enabled, false)
		assert.deepEqual(attachedRaw.organize.model, { provider: 'local-provider', model: 'local-model' })
	} finally {
		await rm(base, { recursive: true, force: true })
	}
})
