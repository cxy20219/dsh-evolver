import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { dataDirPointerPath, readDataDirPointer, writeDataDirPointer } from '../src/home.js'
import { FileStore } from '../src/store.js'

test('指针：缺失、写入、读取与非法路径', async () => {
	const root = await mkdtemp(join(tmpdir(), 'yuanshi-home-'))
	const pointer = join(root, 'yuanshi.home.json')
	try {
		assert.equal(await readDataDirPointer(pointer), undefined)
		await writeDataDirPointer(pointer, join(root, 'data'))
		assert.equal((await readDataDirPointer(pointer)).dataDir, join(root, 'data'))
		await writeFile(pointer, JSON.stringify({ dataDir: 'relative/path' }))
		await assert.rejects(() => readDataDirPointer(pointer), /绝对路径/)
		await writeFile(pointer, 'not json')
		await assert.rejects(() => readDataDirPointer(pointer), /不是合法 JSON/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('apply 读取指针目录，而不是默认目录', async () => {
	const home = await mkdtemp(join(tmpdir(), 'yuanshi-home-apply-'))
	const pointed = join(home, 'pointed')
	const pointer = dataDirPointerPath(home)
	const prev = process.env.DSH_HOME
	try {
		const seed = new FileStore({ dataDir: pointed })
		await seed.open()
		await seed.create({ name: 'seed.md', description: '指针目录里的种子文件', content: 'seed', tags: ['测试/指针'] })
		seed.close()
		await writeDataDirPointer(pointer, pointed)

		process.env.DSH_HOME = home
		const tools = []
		const effects = []
		const ctx = {
			logger: { info() {}, warn() {}, error() {} },
			tools: { register(tool) { tools.push(tool); return () => {} } },
			systemPrompt: { section() { return () => {} }, context() { return () => {} } },
			get() { return undefined },
			effect(effect) { effects.push(effect); return () => {} },
		}
		await apply(ctx, {})
		assert.equal(tools.length, 8)
		assert.match(await readFile(join(pointed, 'system', 'settings.json'), 'utf8'), /descriptionMaxChars/)
		assert.ok(effects.length > 0)
		const dispose = effects[0]
		await dispose()
	} finally {
		if (prev === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = prev
		await rm(home, { recursive: true, force: true })
	}
})

test('指针指向缺失库时 apply 明确报错', async () => {
	const home = await mkdtemp(join(tmpdir(), 'yuanshi-home-bad-'))
	const pointer = dataDirPointerPath(home)
	const prev = process.env.DSH_HOME
	try {
		await writeDataDirPointer(pointer, join(home, 'missing'))
		process.env.DSH_HOME = home
		const ctx = {
			logger: { info() {}, warn() {}, error() {} },
			tools: { register() { return () => {} } },
			systemPrompt: { section() { return () => {} }, context() { return () => {} } },
			get() { return undefined },
			effect() { return () => {} },
		}
		await assert.rejects(() => apply(ctx, {}), /指针指向的不是自衍中枢库/)
	} finally {
		if (prev === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = prev
		await rm(home, { recursive: true, force: true })
	}
})
