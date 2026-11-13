import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
	copyTree,
	countEntries,
	isDirectory,
	isInsidePath,
	isTransient,
	pathsOverlap,
} from '../src/workspace.js'
import { createWorkspaceJobs } from '../src/workspace-jobs.js'

test('isInsidePath 和 pathsOverlap 按解析后的路径判断', () => {
	assert.equal(isInsidePath('/a/b', '/a/b/c'), true)
	assert.equal(isInsidePath('/a/b', '/a/b'), false)
	assert.equal(isInsidePath('/a/b', '/a/c'), false)
	assert.equal(pathsOverlap('/a/b', '/a/b/c'), true)
	assert.equal(pathsOverlap('/a/b', '/a/c'), false)
	assert.equal(pathsOverlap('/a/b', '/a/b'), true)
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

		await copyTree(dir, target)
		const copied = (await readdir(target)).sort()
		assert.deepEqual(copied, ['keep.md'])
	} finally {
		await rm(base, { recursive: true, force: true })
	}
})


test('迁移在切换失败时回到原目录，不留半迁移状态', async () => {
	const base = await mkdtemp(join(tmpdir(), 'evr-migrate-'))
	const oldRoot = join(base, 'old')
	const newRoot = join(base, 'new')
	try {
		await mkdir(join(oldRoot, 'knowledge'), { recursive: true })
		await writeFile(join(oldRoot, 'knowledge', 'a.md'), 'x', 'utf8')

		let stored = ''
		const evolver = {
			root: oldRoot,
			async ensure() {},
			async switchRoot(root) { this.root = root },
		}
		const settings = {
			path: join(base, 'settings.json'),
			get: () => ({ dataDir: stored }),
			async update(patch) { if (patch.dataDir !== undefined) stored = patch.dataDir },
		}
		const opened = []
		const openCards = async (root) => {
			if (root === newRoot) throw new Error('EACCES')
			opened.push(root)
			return { dataDir: root, async close() {} }
		}
		const jobs = createWorkspaceJobs({
			evolver,
			settings,
			rootState: { source: 'default', warning: '' },
			defaultRoot: oldRoot,
			currentStore: () => ({ dataDir: oldRoot, async close() {} }),
			openCards,
		})
		await assert.rejects(() => jobs.migrate(newRoot), /迁移未完成，已回到原数据目录/)
		assert.equal(evolver.root, oldRoot)
		assert.equal(stored, '')
		assert.equal(opened.at(-1), oldRoot, '失败后必须把旧库重新打开')
	} finally {
		await rm(base, { recursive: true, force: true })
	}
})
