import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { extractArchiveFile, isGzip, writeArchiveFile, writeTarFile } from '../src/backup/archive.js'
import { createTar, readTar } from '../src/backup/tar.js'
import { safeResourceName } from '../src/cards/resources.js'

/** A 3 MB resource: big enough that the writer has to stream it. */
const BIG_BYTES = Buffer.alloc(3 * 1024 * 1024, 7)

/**
 * Build a small data folder, including a model-sized file.
 *
 * @returns {Promise<string>} The folder.
 */
async function dataFolder() {
	const root = await mkdtemp(join(tmpdir(), 'evr-archive-'))
	await mkdir(join(root, 'knowledge', 'cards'), { recursive: true })
	await mkdir(join(root, 'knowledge', 'resources'), { recursive: true })
	await mkdir(join(root, 'sight'), { recursive: true })
	await mkdir(join(root, 'preferences'), { recursive: true })
	await writeFile(join(root, 'knowledge', 'cards', 'cards.jsonl'), '{"id":"card-1"}\n', 'utf8')
	await writeFile(join(root, 'knowledge', 'resources', 'run.sh'), '#!/bin/sh\n', 'utf8')
	await writeFile(join(root, 'knowledge', 'resources', 'big.bin'), BIG_BYTES)
	await writeFile(join(root, 'sight', 'soul.md'), '# 灵魂\n', 'utf8')
	await writeFile(join(root, 'preferences', 'AGENTS.md'), '# 偏好\n', 'utf8')
	await chmod(join(root, 'knowledge', 'resources', 'run.sh'), 0o755)
	return root
}

test('流式导出 .tar.gz 再解压：内容与权限都在', async () => {
	const source = await dataFolder()
	const target = await mkdtemp(join(tmpdir(), 'evr-archive-out-'))
	const out = await mkdtemp(join(tmpdir(), 'evr-archive-file-'))
	try {
		const archive = join(out, 'export.tar.gz')
		const packed = await writeArchiveFile(source, archive)
		assert.equal(packed.files, 5)
		assert.equal(isGzip(await readFile(archive)), true)

		const restored = await extractArchiveFile(archive, target)
		assert.equal(restored.files, 5)
		assert.equal(restored.skipped, 0)
		assert.equal(await readFile(join(target, 'knowledge', 'cards', 'cards.jsonl'), 'utf8').then((text) => text.includes('card-1')), true)
		assert.equal((await stat(join(target, 'knowledge', 'resources', 'run.sh'))).mode & 0o777, 0o755)
	} finally {
		await rm(source, { recursive: true, force: true })
		await rm(target, { recursive: true, force: true })
		await rm(out, { recursive: true, force: true })
	}
})

test('流式 tar（云端备份格式）也能解压，且不需要整包进内存', async () => {
	const source = await dataFolder()
	const target = await mkdtemp(join(tmpdir(), 'evr-tar-out-'))
	const out = await mkdtemp(join(tmpdir(), 'evr-tar-file-'))
	try {
		const tar = join(out, 'snapshot.tar')
		const packed = await writeTarFile(source, tar)
		assert.equal(packed.files, 5)
		assert.equal(packed.bytes > 3 * 1024 * 1024, true)
		const entries = readTar(await readFile(tar))
		assert.deepEqual(entries.map((entry) => entry.path).sort(), [
			'knowledge/cards/cards.jsonl',
			'knowledge/resources/big.bin',
			'knowledge/resources/run.sh',
			'preferences/AGENTS.md',
			'sight/soul.md',
		])
		const restored = await extractArchiveFile(tar, target)
		assert.equal(restored.files, 5)
	} finally {
		await rm(source, { recursive: true, force: true })
		await rm(target, { recursive: true, force: true })
		await rm(out, { recursive: true, force: true })
	}
})

test('导入只写白名单目录，默认不覆盖，force 才覆盖', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-archive-rules-'))
	const target = await mkdtemp(join(tmpdir(), 'evr-archive-target-'))
	try {
		const archive = join(dir, 'mixed.tar')
		await writeFile(archive, createTar([
			{ path: 'knowledge/a.md', content: 'new' },
			{ path: 'other/b.md', content: 'outside the whitelist' },
		]))
		const first = await extractArchiveFile(archive, target)
		assert.equal(first.files, 1)
		assert.equal(first.skipped, 1)
		assert.equal(await readFile(join(target, 'knowledge', 'a.md'), 'utf8'), 'new')
		await assert.rejects(() => readFile(join(target, 'other', 'b.md'), 'utf8'))

		await writeFile(join(target, 'knowledge', 'a.md'), 'old', 'utf8')
		const skipped = await extractArchiveFile(archive, target)
		assert.equal(skipped.files, 0)
		assert.equal(skipped.skipped, 2)
		assert.equal(await readFile(join(target, 'knowledge', 'a.md'), 'utf8'), 'old')

		const forced = await extractArchiveFile(archive, target, { force: true })
		assert.equal(forced.files, 1)
		assert.equal(await readFile(join(target, 'knowledge', 'a.md'), 'utf8'), 'new')
	} finally {
		await rm(dir, { recursive: true, force: true })
		await rm(target, { recursive: true, force: true })
	}
})

test('路径穿越、损坏包和空包都会被拒绝', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-archive-bad-'))
	const target = await mkdtemp(join(tmpdir(), 'evr-archive-bad-target-'))
	try {
		const evil = join(dir, 'evil.tar')
		await writeFile(evil, createTar([{ path: '../evil.md', content: 'x' }]))
		await assert.rejects(() => extractArchiveFile(evil, target), /路径不安全/)

		const junk = join(dir, 'junk.tar.gz')
		await writeFile(junk, 'definitely not an archive', 'utf8')
		await assert.rejects(() => extractArchiveFile(junk, target), /校验|tar/)

		const empty = join(dir, 'empty.tar')
		await writeFile(empty, Buffer.alloc(1024))
		await assert.rejects(() => extractArchiveFile(empty, target), /没有可导入的条目/)

		await assert.rejects(() => readFile(join(dir, 'evil.md'), 'utf8'))
	} finally {
		await rm(dir, { recursive: true, force: true })
		await rm(target, { recursive: true, force: true })
	}
})

test('附件名按字节截断，不会让导出永久失败', () => {
	// The ustar name field is 100 bytes; the card folder takes 52 of the path,
	// so a 63-character Chinese name (189 bytes) used to break every export.
	for (const raw of ['汉'.repeat(63) + '.md', 'a'.repeat(200), '正常的名字.md']) {
		const safe = safeResourceName(raw)
		assert.ok(safe !== '', `${raw.slice(0, 8)}… 应当得到一个可用名字`)
		assert.ok(Buffer.byteLength(safe) <= 88, `${raw.slice(0, 8)}… 超长：${Buffer.byteLength(safe)} 字节`)
	}
})

test('打包途中文件被替换，归档仍然是可解开的', async () => {
	const src = await mkdtemp(join(tmpdir(), 'evr-race-src-'))
	const out = await mkdtemp(join(tmpdir(), 'evr-race-out-'))
	const dst = await mkdtemp(join(tmpdir(), 'evr-race-dst-'))
	try {
		await mkdir(join(src, 'knowledge'), { recursive: true })
		// A big leading file keeps the pack busy long enough to swap the second.
		await writeFile(join(src, 'knowledge', 'a-big.bin'), Buffer.alloc(24 * 1024 * 1024, 1))
		await writeFile(join(src, 'knowledge', 'b.txt'), 'v1')
		const tar = join(out, 'snap.tar')
		const packing = writeTarFile(src, tar)
		await new Promise((resolve) => setTimeout(resolve, 12))
		// The log gets written to while the backup is running: an atomic replace.
		await writeFile(join(src, 'knowledge', 'b.next'), `v2-${'x'.repeat(400)}`)
		await rename(join(src, 'knowledge', 'b.next'), join(src, 'knowledge', 'b.txt'))
		await packing
		// The header must describe the bytes that actually follow it, or every
		// later block shifts and the archive cannot be read back.
		const restored = await extractArchiveFile(tar, dst)
		assert.equal(restored.files, 2)
		assert.match(await readFile(join(dst, 'knowledge', 'b.txt'), 'utf8'), /^v\d-/)
	} finally {
		for (const dir of [src, out, dst]) await rm(dir, { recursive: true, force: true })
	}
})
