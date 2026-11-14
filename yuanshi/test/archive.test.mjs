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
import { FileStore } from '../src/store.js'
import { buildTarHeader } from '../src/tar.js'

/**
 * A small source library.
 *
 * @returns {Promise<{root: string, data: string}>} Paths.
 */
async function library() {
	const root = await mkdtemp(join(tmpdir(), 'yuanshi-archive-'))
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
		assert.equal(read.manifest.kind, 'yuanshi-export')
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
			assert.equal((await stat(join(restored, 'files', script.id, 'run.sh'))).mode & 0o111 ? true : false, true)
			assert.deepEqual(JSON.parse(await readFile(join(restored, 'system', 'settings.json'), 'utf8')), { descriptionMaxChars: 200 })
			const system = await readdir(join(restored, 'system'))
			assert.ok(system.includes('settings.json'))
			assert.ok(system.includes('yuanshi.db'))
		} finally {
			store.close()
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('导入拒绝路径穿越与绝对路径', async () => {
	const root = await mkdtemp(join(tmpdir(), 'yuanshi-archive-bad-'))
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
