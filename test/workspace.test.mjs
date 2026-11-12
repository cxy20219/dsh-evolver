import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
	copyTree,
	countEntries,
	describeTree,
	isDirectory,
	isInsidePath,
	isTransient,
	pathsOverlap,
} from '../src/workspace.js'

test('isInsidePath 和 pathsOverlap 按解析后的路径判断', () => {
	assert.equal(isInsidePath('/a/b', '/a/b/c'), true)
	assert.equal(isInsidePath('/a/b', '/a/b'), false)
	assert.equal(isInsidePath('/a/b', '/a/c'), false)
	assert.equal(pathsOverlap('/a/b', '/a/b/c'), true)
	assert.equal(pathsOverlap('/a/b', '/a/c'), false)
	assert.equal(pathsOverlap('/a/b', '/a/b'), true)
})

test('describeTree 统计文件与字节，跳过软链与临时文件', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-tree-'))
	try {
		await mkdir(join(dir, 'practice', 'docs'), { recursive: true })
		await writeFile(join(dir, 'practice', 'docs', 'a.md'), 'hello', 'utf8')
		await writeFile(join(dir, 'practice', 'docs', 'b.tmp'), 'ignore', 'utf8')
		await writeFile(join(dir, 'top.txt'), 'x', 'utf8')
		await symlink(join(dir, 'top.txt'), join(dir, 'link.txt'))
		const totals = await describeTree(dir)
		assert.equal(totals.files, 2)
		assert.equal(totals.bytes, 6)
		assert.equal(totals.skippedLinks, 1)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('copyTree 默认只补缺，force 才覆盖', async () => {
	const source = await mkdtemp(join(tmpdir(), 'evr-src-'))
	const target = await mkdtemp(join(tmpdir(), 'evr-dst-'))
	try {
		await mkdir(join(source, 'practice'), { recursive: true })
		await writeFile(join(source, 'practice', 'a.md'), 'new', 'utf8')
		await writeFile(join(source, 'practice', 'b.md'), 'added', 'utf8')
		await mkdir(join(target, 'practice'), { recursive: true })
		await writeFile(join(target, 'practice', 'a.md'), 'old', 'utf8')

		const counts = await copyTree(source, target)
		assert.equal(counts.files, 2)
		assert.equal(await readFile(join(target, 'practice', 'a.md'), 'utf8'), 'old')
		assert.equal(await readFile(join(target, 'practice', 'b.md'), 'utf8'), 'added')

		await copyTree(source, target, { force: true })
		assert.equal(await readFile(join(target, 'practice', 'a.md'), 'utf8'), 'new')
	} finally {
		await rm(source, { recursive: true, force: true })
		await rm(target, { recursive: true, force: true })
	}
})

test('copyTree 不跟随软链，countEntries / isDirectory 容忍缺失', async () => {
	const source = await mkdtemp(join(tmpdir(), 'evr-src-'))
	const target = await mkdtemp(join(tmpdir(), 'evr-dst-'))
	const outside = await mkdtemp(join(tmpdir(), 'evr-out-'))
	try {
		await writeFile(join(source, 'real.md'), 'x', 'utf8')
		await writeFile(join(outside, 'secret.md'), 'secret', 'utf8')
		await symlink(join(outside, 'secret.md'), join(source, 'link.md'))
		await copyTree(source, target)
		assert.equal(await readFile(join(target, 'real.md'), 'utf8'), 'x')
		await assert.rejects(() => readFile(join(target, 'link.md'), 'utf8'))
		assert.equal(await countEntries(join(target, 'missing')), 0)
		assert.equal(await isDirectory(join(target, 'missing')), false)
	} finally {
		await rm(source, { recursive: true, force: true })
		await rm(target, { recursive: true, force: true })
		await rm(outside, { recursive: true, force: true })
	}
})

test('临时文件与导入备份不被复制或归档（一套 isTransient 规则）', async () => {
	const base = await mkdtemp(join(tmpdir(), 'evr-ws-'))
	const dir = join(base, 'src')
	const target = join(base, 'copy')
	try {
		await mkdir(dir, { recursive: true })
		await writeFile(join(dir, 'keep.md'), 'x', 'utf8')
		await writeFile(join(dir, 'half.part'), 'x', 'utf8')
		await writeFile(join(dir, 'save.tmp'), 'x', 'utf8')
		await writeFile(join(dir, 'cards.jsonl.before-import-2026-01-01T00-00-00-000Z'), 'x', 'utf8')
		await writeFile(join(dir, '.DS_Store'), 'x', 'utf8')
		assert.equal(isTransient('half.part'), true)
		assert.equal(isTransient('cards.jsonl.before-import-x'), true)
		assert.equal(isTransient('keep.md'), false)
		assert.equal((await describeTree(dir)).files, 1, '只统计真文件')
		await copyTree(dir, target)
		const copied = (await readdir(target)).sort()
		assert.deepEqual(copied, ['keep.md'])
	} finally {
		await rm(base, { recursive: true, force: true })
	}
})
