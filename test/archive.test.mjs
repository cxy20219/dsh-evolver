import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createGzip } from 'node:zlib'

import { MAX_EXTRACTED_BYTES, MAX_IMPORT_ENTRIES, extractArchiveFile, isGzip, writeArchiveFile, writeTarFile } from '../src/backup/archive.js'
import { buildTarHeader, parseTarHeader } from '../src/backup/tar.js'
import { createTar, readTar } from './support/tar-fixture.mjs'
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

/**
 * Turn a regular-file header into a link entry, with a correct checksum.
 *
 * @param {Buffer} header - The 512-byte header from buildTarHeader.
 * @param {'1' | '2'} type - '1' hard link, '2' symbolic link.
 * @param {string} linkname - The link target.
 * @returns {Buffer} The same buffer, retyped in place.
 */
function asLinkEntry(header, type, linkname) {
	header[156] = type.charCodeAt(0)
	Buffer.from(linkname, 'utf8').copy(header, 157, 0, 100)
	header.fill(0x20, 148, 156)
	let sum = 0
	for (const byte of header) sum += byte
	Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `, 'utf8').copy(header, 148)
	return header
}

test('tar 里的软链/硬链条目被跳过，且不影响后面的正常文件', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-archive-link-'))
	const target = await mkdtemp(join(tmpdir(), 'evr-archive-link-target-'))
	try {
		const body = Buffer.from('real content\n')
		const hard = asLinkEntry(buildTarHeader({ path: 'knowledge/hard', size: 0 }), '1', 'knowledge/ok.txt')
		const soft = asLinkEntry(buildTarHeader({ path: 'knowledge/escape', size: 0 }), '2', '../../outside')
		const regular = buildTarHeader({ path: 'knowledge/ok.txt', size: body.length })
		const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
		const archive = join(dir, 'links.tar')
		await writeFile(archive, Buffer.concat([hard, soft, regular, body, padding, Buffer.alloc(1024)]))

		const restored = await extractArchiveFile(archive, target)
		// Both link entries are skipped, not followed: one import, one normal file.
		assert.equal(restored.skipped, 2)
		assert.equal(restored.files, 1)
		await assert.rejects(() => lstat(join(target, 'knowledge', 'escape')), { code: 'ENOENT' })
		assert.equal(await readFile(join(target, 'knowledge', 'ok.txt'), 'utf8'), 'real content\n')
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

/**
 * Write a gzip of zeros that claims huge entries outside the import allowlist.
 *
 * The point is the size accounting: an importer that only counts entries it
 * accepts can be handed a one-megabyte file that makes it decompress terabytes.
 *
 * @param {string} target - The archive path.
 * @param {Array<{path: string, bytes: number}>} entries - Entry paths and sizes; sizes are multiples of 512.
 * @returns {Promise<void>} Resolves when the archive is on disk.
 */
async function writeBombArchive(target, entries) {
	const output = createWriteStream(target)
	const gzip = createGzip({ level: 1 })
	gzip.pipe(output)
	const zeros = Buffer.alloc(64 * 1024)
	for (const entry of entries) {
		gzip.write(buildTarHeader({ path: entry.path, size: entry.bytes, mode: 0o644 }))
		let written = 0
		while (written < entry.bytes) {
			const chunk = Math.min(zeros.length, entry.bytes - written)
			if (!gzip.write(chunk === zeros.length ? zeros : zeros.subarray(0, chunk))) await once(gzip, 'drain')
			written += chunk
		}
	}
	gzip.end(Buffer.alloc(1024))
	await once(output, 'finish')
}

test('条目上限对白名单外的条目同样计数：小包不能塞爆导入循环', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-bomb-'))
	const archive = join(dir, 'many.tar.gz')
	const root = join(dir, 'data')
	try {
		const entries = Array.from({ length: MAX_IMPORT_ENTRIES + 1 }, (_, index) => ({ path: `outside/${index}.txt`, bytes: 0 }))
		await writeBombArchive(archive, entries)
		await assert.rejects(() => extractArchiveFile(archive, root), /条目过多/)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('解压上限按实际解压字节算：白名单外的大条目也把预算花掉', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-bomb-'))
	const archive = join(dir, 'bomb.tar.gz')
	const root = join(dir, 'data')
	try {
		// 3 x 368 MiB = 1.078 GiB > 1 GiB, each entry below the 512 MiB entry cap.
		const each = 368 * 1024 * 1024
		await writeBombArchive(archive, [0, 1, 2].map((index) => ({ path: `outside/huge-${index}.bin`, bytes: each })))
		assert.ok(3 * each > MAX_EXTRACTED_BYTES)
		await assert.rejects(() => extractArchiveFile(archive, root), /解压后超过/)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})


test('tar 条目路径里的反斜杠被拒绝（Windows 分隔符会绕过按 / 的检查）', () => {
	// buildTarHeader normalises separators, so the hostile name is written
	// straight into a header and the checksum recomputed, the same way an
	// archive from another tool would arrive.
	const header = buildTarHeader({ path: 'knowledge/ok.txt', size: 1 })
	header.fill(0x20, 0, 100)
	Buffer.from('a\\..\\..\\x.md').copy(header, 0)
	header.fill(0x20, 148, 156)
	let sum = 0
	for (const byte of header) sum += byte
	Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(header, 148)
	assert.throws(() => parseTarHeader(header), /反斜杠/)
})
