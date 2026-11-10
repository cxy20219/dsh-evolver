import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { BackupService, isBackupKey, keyStamp } from '../src/backup/service.js'
import { OssClient, canonicalResource, parseKeys, stringToSign } from '../src/backup/oss.js'
import { createTar, readTar } from '../src/backup/tar.js'
import { SettingsStore } from '../src/settings.js'
import { fakeOss } from './support/fake-oss.mjs'

test('tar 往返：普通、二进制、中文与长路径', () => {
	const files = [
		{ path: 'practice/INDEX.md', content: '# 索引\n' },
		{ path: 'sight/memory/memories.jsonl', content: '{"id":"m1","text":"x"}\n' },
		{ path: 'practice/docs/演化器/审计.md', content: '中文正文' },
		{ path: 'binary.bin', content: Buffer.from([0, 1, 2, 255, 0, 7]) },
		{ path: `${'a/'.repeat(60)}deep.md`, content: 'deep' },
	]
	const archive = createTar(files, { now: new Date('2026-11-10T00:00:00Z') })
	const restored = readTar(archive)
	assert.deepEqual(restored.map((file) => file.path).sort(), files.map((file) => file.path).sort())
	for (const file of files) {
		const found = restored.find((entry) => entry.path === file.path)
		assert.ok(found !== undefined, `缺少 ${file.path}`)
		assert.deepEqual(found.content, Buffer.from(file.content))
	}
	const modes = readTar(createTar([{ path: 'run.sh', content: '#!/bin/sh', mode: 0o755 }]))
	assert.equal(modes[0].mode, 0o755)
})

test('tar 校验和坏了会报错，路径里带 .. 会被拒绝', () => {
	const archive = createTar([{ path: 'a.md', content: 'x' }])
	const broken = Buffer.from(archive)
	broken[0] = broken[0] ^ 0xff
	assert.throws(() => readTar(broken), /校验失败/)

	const evil = createTar([{ path: 'ok.md', content: 'x' }])
	// 直接改写文件名：校验和随之失效，所以两种异常都算拒绝
	Buffer.from('../etc/passwd').copy(evil, 0)
	assert.throws(() => readTar(evil))
})

test('GNU/pax 扩展头会被明确拒绝，而不是静默解析错路径', () => {
	const archive = createTar([{ path: 'a.md', content: 'x' }])
	archive[156] = 'L'.charCodeAt(0)
	archive.fill(0x20, 148, 156)
	let sum = 0
	for (let index = 0; index < 512; index += 1) sum += archive[index]
	Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(archive, 148)
	assert.throws(() => readTar(archive), /GNU\/pax/)
})

test('OSS V1 待签字符串按规范拼装', () => {
	const request = {
		method: 'get',
		contentMd5: '',
		contentType: '',
		date: 'Tue, 10 Nov 2026 04:00:00 GMT',
		headers: { 'x-oss-meta-a': ' 1 ' },
		resource: '/bucket/key',
	}
	assert.equal(
		stringToSign(request),
		'GET\n\n\nTue, 10 Nov 2026 04:00:00 GMT\nx-oss-meta-a:1\n/bucket/key',
	)
	assert.equal(canonicalResource('bucket', 'key'), '/bucket/key')
	assert.equal(canonicalResource('bucket', ''), '/bucket/')
	assert.equal(canonicalResource('bucket', '', { prefix: 'x' }), '/bucket/')
	assert.equal(canonicalResource('bucket', 'key', { acl: '' }), '/bucket/key?acl')
})

test('解析 ListObjects 的 XML，并还原实体', () => {
	const xml = `<ListBucketResult>
		<Contents><Key>pre/a.tar</Key><Size>1</Size></Contents>
		<Contents><Key>pre/b&amp;c.tar</Key></Contents>
		<IsTruncated>false</IsTruncated>
	</ListBucketResult>`
	assert.deepEqual(parseKeys(xml), ['pre/a.tar', 'pre/b&c.tar'])
})

test('OSS 客户端对本地网关走路径风格：PUT / LIST / DELETE', async () => {
	const oss = await fakeOss()
	try {
		const client = new OssClient({
			endpoint: oss.url,
			bucket: 'test',
			accessKeyId: 'testid',
			accessKeySecret: 'secret',
		})
		const body = createTar([{ path: 'a.md', content: 'x' }])
		await client.putObject('pre/backup-1.tar', body)
		assert.deepEqual(oss.objects.get('pre/backup-1.tar'), body)

		const put = oss.requests.find((item) => item.method === 'PUT')
		assert.match(put.headers.authorization, /^OSS testid:/)
		assert.equal(put.headers.date.length > 10, true)
		assert.equal(put.headers['content-md5'], createHash('md5').update(body).digest('base64'))

		assert.deepEqual(await client.listObjects('pre/'), ['pre/backup-1.tar'])
		const listed = oss.requests.find((item) => item.method === 'GET')
		assert.equal(listed.key, '')
		assert.equal(listed.query.get('prefix'), 'pre/')

		await client.deleteObject('pre/backup-1.tar')
		assert.equal(oss.objects.has('pre/backup-1.tar'), false)
		assert.deepEqual(await client.check(), [])
	} finally {
		await oss.close()
	}
})

test('OSS 错误响应转成可读信息', async () => {
	const oss = await fakeOss()
	try {
		const client = new OssClient({
			endpoint: oss.url,
			bucket: 'test',
			accessKeyId: 'testid',
			accessKeySecret: 'secret',
		})
		oss.failNext = true
		await assert.rejects(() => client.putObject('x.tar', Buffer.from('x')), /HTTP 403 AccessDenied: nope/)
	} finally {
		await oss.close()
	}
})

/**
 * Build a service on a temporary data folder and settings file.
 *
 * @param {object} [options] - Overrides.
 * @returns {Promise<object>} The fixture.
 */
async function serviceFixture({ keep = 2, enabled = true, now } = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'evr-backup-'))
	const dataDir = join(dir, 'data')
	await mkdir(join(dataDir, 'practice'), { recursive: true })
	await mkdir(join(dataDir, 'sight', 'memory'), { recursive: true })
	await writeFile(join(dataDir, 'practice', 'INDEX.md'), '# 索引\n', 'utf8')
	await writeFile(join(dataDir, 'sight', 'memory', 'memories.jsonl'), '{"id":"m1"}\n', 'utf8')

	const settings = new SettingsStore({ path: join(dir, 'settings.json') })
	await settings.load()
	await settings.update({
		backup: {
			enabled,
			endpoint: 'https://fake.example.com',
			bucket: 'bucket',
			accessKeyId: 'id',
			accessKeySecret: 'secret',
			prefix: 'evolver',
			keep,
			intervalMinutes: 60,
		},
	})

	const objects = new Map()
	const calls = []
	const client = {
		objects,
		async putObject(key, body) {
			calls.push({ type: 'put', key })
			objects.set(key, Buffer.from(body))
			return body.length
		},
		async listObjects(prefix) {
			calls.push({ type: 'list', prefix })
			return [...objects.keys()].filter((key) => key.startsWith(prefix))
		},
		async deleteObject(key) {
			calls.push({ type: 'delete', key })
			objects.delete(key)
		},
		async check() {
			return [...objects.keys()].slice(0, 1)
		},
		baseUrl() {
			return 'https://bucket.fake.example.com'
		},
	}
	const clock = { value: now ?? new Date('2026-11-10T12:00:00.000Z') }
	const service = new BackupService({
		settings,
		root: () => dataDir,
		client: () => client,
		now: () => clock.value,
	})
	return { dir, dataDir, settings, service, client, objects, calls, clock }
}

test('备份上传一个 tar，并按保留份数删除最旧的', async () => {
	const fixture = await serviceFixture({ keep: 2 })
	try {
		for (const name of ['20260101T000000Z', '20260102T000000Z', '20260103T000000Z']) {
			fixture.objects.set(`evolver/backup-${name}.tar`, Buffer.from('old'))
		}
		const result = await fixture.service.runNow({ force: true })
		assert.equal(result.key, `evolver/backup-${keyStamp(fixture.clock.value)}.tar`)
		assert.equal(result.files, 2)
		assert.equal(result.removed, 2)

		const keys = [...fixture.objects.keys()].sort()
		assert.equal(keys.length, 2)
		assert.deepEqual(keys, ['evolver/backup-20260103T000000Z.tar', result.key])

		const restored = readTar(fixture.objects.get(result.key))
		assert.deepEqual(restored.map((file) => file.path).sort(), [
			'practice/INDEX.md',
			'sight/memory/memories.jsonl',
		])
		const status = fixture.settings.get().status
		assert.equal(status.lastBackupAt, '2026-11-10T12:00:00.000Z')
		assert.equal(status.lastError, '')
		assert.equal(status.lastFiles, 2)
	} finally {
		await rm(fixture.dir, { recursive: true, force: true })
	}
})

test('设置写入失败不会让“备份进行中”卡死', async () => {
	const fixture = await serviceFixture({ keep: 1 })
	try {
		const original = fixture.settings.updateStatus.bind(fixture.settings)
		let failOnce = true
		fixture.settings.updateStatus = async function (patch) {
			if (failOnce) {
				failOnce = false
				throw new Error('disk full')
			}
			return original(patch)
		}
		await assert.rejects(() => fixture.service.runNow({ force: true }), /disk full/)
		assert.equal(fixture.service.running, false)
		// 第一次失败后仍可再次备份，而不是永远报“正在进行中”
		const result = await fixture.service.runNow({ force: true })
		assert.ok(result.key.endsWith('.tar'))
		assert.equal(fixture.service.running, false)
	} finally {
		await rm(fixture.dir, { recursive: true, force: true })
	}
})

test('清理旧备份失败不判本次备份失败，也不会立刻重复上传', async () => {
	const fixture = await serviceFixture({ keep: 1 })
	try {
		fixture.objects.set('evolver/backup-20260101T000000Z.tar', Buffer.from('old'))
		fixture.client.deleteObject = async () => { throw new Error('AccessDenied') }
		const result = await fixture.service.runNow({ force: true })
		assert.equal(result.removed, 0)
		assert.match(result.cleanupError, /AccessDenied/)
		const status = fixture.settings.get().status
		assert.equal(status.lastBackupAt, '2026-11-10T12:00:00.000Z')
		assert.match(status.lastError, /清理旧备份失败/)

		fixture.clock.value = new Date('2026-11-10T12:10:00.000Z')
		const puts = fixture.calls.filter((call) => call.type === 'put').length
		await fixture.service.tick()
		assert.equal(fixture.calls.filter((call) => call.type === 'put').length, puts)
	} finally {
		await rm(fixture.dir, { recursive: true, force: true })
	}
})

test('未启用时拒绝自动备份，手动强制可以；失败会记录错误', async () => {
	const fixture = await serviceFixture({ enabled: false })
	try {
		await assert.rejects(() => fixture.service.runNow(), /未启用/)
		// 手动备份（设置页「立即备份」）带 force，不受自动备份开关限制
		await fixture.service.runNow({ force: true })
		assert.equal(fixture.calls.filter((call) => call.type === 'put').length, 1)
		await fixture.settings.update({ backup: { enabled: true } })
		const failed = {
			...fixture.client,
			putObject: async () => {
				throw new Error('network down')
			},
		}
		const service = new BackupService({
			settings: fixture.settings,
			root: () => fixture.dataDir,
			client: () => failed,
			now: () => fixture.clock.value,
		})
		await assert.rejects(() => service.runNow(), /network down/)
		assert.equal(fixture.settings.get().status.lastError, 'network down')
	} finally {
		await rm(fixture.dir, { recursive: true, force: true })
	}
})

test('心跳按间隔决定是否备份', async () => {
	const fixture = await serviceFixture()
	try {
		await fixture.settings.updateStatus({ lastBackupAt: '2026-11-10T11:30:00.000Z' })
		await fixture.service.tick()
		assert.equal(fixture.calls.filter((call) => call.type === 'put').length, 0)

		fixture.clock.value = new Date('2026-11-10T13:00:00.000Z')
		await fixture.service.tick()
		assert.equal(fixture.calls.filter((call) => call.type === 'put').length, 1)
		assert.match(fixture.settings.get().status.lastBackupAt, /^2026-11-10T13/)
	} finally {
		await rm(fixture.dir, { recursive: true, force: true })
	}
})

test('测试连接使用当前配置并返回端点', async () => {
	const fixture = await serviceFixture()
	try {
		fixture.objects.set('evolver/backup-x.tar', Buffer.from('x'))
		const result = await fixture.service.testConnection()
		assert.equal(result.endpoint, 'https://bucket.fake.example.com')
		assert.deepEqual(result.keys, ['evolver/backup-x.tar'])
	} finally {
		await rm(fixture.dir, { recursive: true, force: true })
	}
})

test('心跳：配置不完整不重试，失败后等五分钟再试', async () => {
	const fixture = await serviceFixture()
	try {
		// 缺密钥：不请求，也不反复写状态
		await fixture.settings.update({ backup: { clearAccessKeySecret: true } })
		await fixture.service.tick()
		assert.equal(fixture.calls.filter((call) => call.type === 'put').length, 0)

		await fixture.settings.update({ backup: { accessKeySecret: 'secret' } })
		await fixture.settings.updateStatus({
			lastAttemptAt: fixture.clock.value.toISOString(),
			lastBackupAt: '2026-11-09T00:00:00.000Z',
			lastError: 'network down',
		})
		await fixture.service.tick()
		assert.equal(fixture.calls.filter((call) => call.type === 'put').length, 0)

		fixture.clock.value = new Date('2026-11-10T12:06:00.000Z')
		await fixture.service.tick()
		assert.equal(fixture.calls.filter((call) => call.type === 'put').length, 1)
		assert.equal(fixture.settings.get().status.lastError, '')
	} finally {
		await rm(fixture.dir, { recursive: true, force: true })
	}
})

test('保留策略只删自己的快照，前缀下的其它对象不动', async () => {
	const fixture = await serviceFixture({ keep: 1 })
	try {
		assert.equal(isBackupKey('evolver', 'evolver/backup-20260101T000000Z.tar'), true)
		assert.equal(isBackupKey('evolver', 'evolver/notes.txt'), false)
		assert.equal(isBackupKey('evolver', 'evolver/backup-latest.tar'), false)
		fixture.objects.set('evolver/backup-20260101T000000Z.tar', Buffer.from('old'))
		fixture.objects.set('evolver/notes.txt', Buffer.from('keep me'))
		const result = await fixture.service.runNow({ force: true })
		assert.equal(result.removed, 1)
		assert.deepEqual([...fixture.objects.keys()].sort(), [result.key, 'evolver/notes.txt'].sort())
	} finally {
		await rm(fixture.dir, { recursive: true, force: true })
	}
})
