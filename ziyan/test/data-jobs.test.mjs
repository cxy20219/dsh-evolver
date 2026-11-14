import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDataJobs, validateLibrary } from '../src/data-jobs.js'
import { readDataDirPointer } from '../src/home.js'
import { FileStore } from '../src/store.js'

/**
 * Build a small current library and its jobs.
 *
 * @returns {Promise<object>} Fixture.
 */
async function fixture() {
	const base = await mkdtemp(join(tmpdir(), 'ziyan-data-'))
	const root = join(base, 'current')
	const store = new FileStore({ dataDir: root })
	await store.open()
	await store.create({ name: 'a.md', description: '数据目录测试文件 A', content: 'A', tags: ['测试/数据'] })
	await store.create({ name: 'b.md', description: '数据目录测试文件 B', content: 'B', tags: ['测试/数据'] })
	await store.close()
	const pointerPath = join(base, 'ziyan.home.json')
	const settings = { publicView: () => ({ dataDir: root }) }
	const jobs = createDataJobs({ root, pointerPath, settings, version: 'test' })
	return { base, root, pointerPath, jobs }
}

test('数据目录：复制、指针、attach 与状态', async () => {
	const { base, root, jobs, pointerPath } = await fixture()
	const copy = join(base, 'copy')
	try {
		const before = await jobs.status()
		assert.equal(before.current, root)
		assert.equal(before.files, 2)

		const saved = await jobs.saveDir({ dir: copy, mode: 'copy' })
		assert.equal(saved.restartRequired, true)
		assert.equal((await readDataDirPointer(pointerPath)).dataDir, copy)
		assert.equal((await jobs.status()).pending, copy)
		assert.equal((await validateLibrary(copy)).files, 2)
		assert.equal((await jobs.status()).files, 2, '当前会话仍然读旧库')

		await assert.rejects(() => jobs.saveDir({ dir: copy, mode: 'copy' }), /目标目录不存在|已存在/)
		await assert.rejects(() => jobs.saveDir({ dir: join(root, 'inside'), mode: 'copy' }), /包含|当前/)

		const attached = await jobs.saveDir({ dir: copy, mode: 'attach' })
		assert.equal(attached.mode, 'attach')
		assert.equal((await jobs.status()).pending, copy)
		assert.equal((await jobs.status()).pendingExists, true)
	} finally {
		await rm(base, { recursive: true, force: true })
	}
})

test('导出与导入：base64 往返、导入到新目录、当前库不变', async () => {
	const { base, root, jobs, pointerPath } = await fixture()
	try {
		const exported = await jobs.exportLibrary()
		assert.equal(exported.files, 2)
		assert.ok(exported.base64.length > 0)
		assert.match(exported.name, /^ziyan-.*\.tar\.gz$/)

		const imported = await jobs.importLibrary({ data: `data:application/gzip;base64,${exported.base64}` })
		assert.equal(imported.restartRequired, true)
		assert.equal(imported.files, 2)
		assert.ok(imported.dir.startsWith(base))
		assert.equal((await readDataDirPointer(pointerPath)).dataDir, imported.dir)
		assert.equal((await validateLibrary(imported.dir)).files, 2)
		assert.equal((await validateLibrary(root)).files, 2, '旧库未被导入改动')
		assert.equal((await stat(join(root, 'files'))).isDirectory(), true)
	} finally {
		await rm(base, { recursive: true, force: true })
	}
})

test('复制模式要求目标不存在，写入指针前失败不产生目标目录', async () => {
	const { base, root, jobs } = await fixture()
	const target = join(base, 'not-created')
	try {
		await writeFile(join(base, 'marker'), 'x')
		await assert.rejects(() => jobs.saveDir({ dir: join(root, 'nested'), mode: 'copy' }), /包含|当前/)
		await assert.rejects(() => validateLibrary(target), /没有 files/)
	} finally {
		await rm(base, { recursive: true, force: true })
	}
})
