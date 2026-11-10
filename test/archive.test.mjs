import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { isGzip, packDataDir, restoreEntries, unpackArchive } from '../src/backup/archive.js'
import { createTar } from '../src/backup/tar.js'

/**
 * Build a small data folder.
 *
 * @returns {Promise<string>} The folder.
 */
async function dataFolder() {
	const root = await mkdtemp(join(tmpdir(), 'evr-archive-'))
	await mkdir(join(root, 'practice', 'docs'), { recursive: true })
	await mkdir(join(root, 'practice', 'tools'), { recursive: true })
	await mkdir(join(root, 'sight', 'memory'), { recursive: true })
	await mkdir(join(root, 'preferences'), { recursive: true })
	await writeFile(join(root, 'practice', 'docs', 'entry.md'), '---\ntitle: 条目\n---\n\n正文\n', 'utf8')
	await writeFile(join(root, 'sight', 'soul.md'), '# 灵魂\n', 'utf8')
	await writeFile(join(root, 'sight', 'memory', 'memories.jsonl'), '{"id":"m1"}\n', 'utf8')
	await writeFile(join(root, 'preferences', 'AGENTS.md'), '# 偏好\n', 'utf8')
	await writeFile(join(root, 'practice', 'tools', 'run.sh'), '#!/bin/sh\n', 'utf8')
	await chmod(join(root, 'practice', 'tools', 'run.sh'), 0o755)
	return root
}

test('打包成 gzip tar 再解开：路径、内容与权限都在', async () => {
	const source = await dataFolder()
	const target = await mkdtemp(join(tmpdir(), 'evr-archive-out-'))
	try {
		const { archive, files } = await packDataDir(source)
		assert.equal(isGzip(archive), true)
		assert.equal(files, 5)
		const entries = unpackArchive(archive)
		assert.deepEqual(entries.map((entry) => entry.path).sort(), [
			'practice/docs/entry.md',
			'practice/tools/run.sh',
			'preferences/AGENTS.md',
			'sight/memory/memories.jsonl',
			'sight/soul.md',
		])
		const restored = await restoreEntries(target, entries)
		assert.equal(restored.files, 5)
		assert.equal(await readFile(join(target, 'practice', 'docs', 'entry.md'), 'utf8').then((text) => text.includes('条目')), true)
		assert.equal((await lstat(join(target, 'practice', 'tools', 'run.sh'))).mode & 0o777, 0o755)
	} finally {
		await rm(source, { recursive: true, force: true })
		await rm(target, { recursive: true, force: true })
	}
})

test('未压缩的 tar（云端备份格式）也能导入', () => {
	const tar = createTar([
		{ path: 'practice/INDEX.md', content: '# 索引\n' },
		{ path: 'sight/soul.md', content: '# 灵魂\n' },
	])
	assert.equal(isGzip(tar), false)
	const entries = unpackArchive(tar)
	assert.deepEqual(entries.map((entry) => entry.path), ['practice/INDEX.md', 'sight/soul.md'])
})

test('损坏的或空的压缩包给出可读错误', () => {
	assert.throws(() => unpackArchive(Buffer.alloc(0)), /空/)
	assert.throws(() => unpackArchive(Buffer.from('definitely not an archive')), /tar|截断|校验/)
	const gzipped = Buffer.from([0x1f, 0x8b, 0x08, 0x00])
	assert.throws(() => unpackArchive(gzipped), /不是可读的/)
})

test('导入只写 practice / sight / preferences，跳过路径穿越与其他目录', async () => {
	const root = await mkdtemp(join(tmpdir(), 'evr-archive-dst-'))
	try {
		const entries = [
			{ path: 'practice/a.md', content: Buffer.from('a') },
			{ path: 'other/b.md', content: Buffer.from('b') },
			{ path: '../evil.md', content: Buffer.from('x') },
			{ path: '/abs.md', content: Buffer.from('x') },
			{ path: 'practice/../escape.md', content: Buffer.from('x') },
		]
		const restored = await restoreEntries(root, entries)
		assert.equal(restored.files, 1)
		assert.equal(restored.skipped, 4)
		assert.equal(await readFile(join(root, 'practice', 'a.md'), 'utf8'), 'a')
		await assert.rejects(() => readFile(join(root, 'other', 'b.md'), 'utf8'))
		await assert.rejects(() => readFile(join(root, 'evil.md'), 'utf8'))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('导入默认不覆盖，force 才覆盖', async () => {
	const root = await mkdtemp(join(tmpdir(), 'evr-archive-force-'))
	try {
		await mkdir(join(root, 'practice'), { recursive: true })
		await writeFile(join(root, 'practice', 'a.md'), 'old', 'utf8')
		const entries = [{ path: 'practice/a.md', content: Buffer.from('new') }]
		const first = await restoreEntries(root, entries)
		assert.equal(first.files, 0)
		assert.equal(first.skipped, 1)
		assert.equal(await readFile(join(root, 'practice', 'a.md'), 'utf8'), 'old')
		const forced = await restoreEntries(root, entries, { force: true })
		assert.equal(forced.files, 1)
		assert.equal(await readFile(join(root, 'practice', 'a.md'), 'utf8'), 'new')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
