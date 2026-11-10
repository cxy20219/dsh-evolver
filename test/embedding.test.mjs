import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
	EMBEDDING_MODELS,
	ModelDownloader,
	embeddingConfig,
	findEmbeddingModel,
	legacyModelState,
	migrateLegacyModels,
	modelPresent,
	probeEmbedding,
	removeLegacyModels,
	requiredModelFiles,
	runtimeState,
} from '../src/embedding.js'

/** A tiny model the downloader tests can serve themselves. */
const FAKE_MODEL = {
	id: 'test-model',
	repo: 'test/model',
	label: 'Test Model',
	languages: '中文',
	dimensions: 2,
	bytes: 12,
	note: '',
	queryPrefix: '',
	passagePrefix: '',
	files: [
		{ path: 'config.json', bytes: 4 },
		{ path: 'onnx/model_quantized.onnx', bytes: 8 },
	],
}

/**
 * Serve the fake model's files from a throwaway local server.
 *
 * @param {{delayMs?: number}} [options] - How long to wait before answering.
 * @returns {Promise<{url: string, close: () => Promise<void>}>} The server.
 */
async function fakeModelServer({ delayMs = 0 } = {}) {
	const files = new Map([
		['/test/model/resolve/main/config.json', Buffer.from('cfg!')],
		['/test/model/resolve/main/onnx/model_quantized.onnx', Buffer.from('12345678')],
	])
	const server = createServer((request, response) => {
		const answer = () => {
			const body = files.get(request.url ?? '')
			if (body === undefined) {
				response.writeHead(404)
				response.end('missing')
				return
			}
			response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) })
			response.end(body)
		}
		if (delayMs > 0) setTimeout(answer, delayMs)
		else answer()
	})
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((resolve) => {
			server.closeAllConnections?.()
			server.close(() => resolve())
		}),
	}
}

test('模型目录完整：每个模型都有必需文件，大小与条目一致', () => {
	assert.equal(EMBEDDING_MODELS.length >= 3, true)
	const ids = new Set()
	for (const model of EMBEDDING_MODELS) {
		assert.equal(ids.has(model.id), false, `重复模型 ${model.id}`)
		ids.add(model.id)
		const sum = model.files.reduce((total, file) => total + file.bytes, 0)
		assert.equal(sum, model.bytes, `${model.id} 的 bytes 与文件之和不一致`)
		const required = requiredModelFiles(model).map((file) => file.path)
		assert.deepEqual(required.sort(), ['config.json', 'onnx/model_quantized.onnx', 'tokenizer.json'])
	}
	assert.equal(findEmbeddingModel('multilingual-e5-small')?.queryPrefix, 'query: ')
	assert.equal(findEmbeddingModel('bge-small-zh-v1.5')?.queryPrefix.includes('检索'), true)
	assert.equal(findEmbeddingModel('no-such-model'), undefined)
})

test('运行时目录：没有 transformers.js 时不可用，装上后可用', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-runtime-'))
	try {
		assert.equal(runtimeState(dir).available, false)
		const packageDir = join(dir, 'node_modules', '@huggingface', 'transformers')
		await mkdir(packageDir, { recursive: true })
		await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', version: '0.0.0', main: 'index.js' }), 'utf8')
		await writeFile(join(packageDir, 'index.js'), 'module.exports = {}\n', 'utf8')
		const state = runtimeState(dir)
		assert.equal(state.available, true)
		assert.match(state.hint, /npm install/)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('下载器把权重写到模型目录，逐个文件跳过已完成的', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-download-'))
	const server = await fakeModelServer()
	try {
		const downloader = new ModelDownloader({ models: [FAKE_MODEL], fetchImpl: (...args) => fetch(...args) })
		const starting = await downloader.start({ model: 'test-model', mirror: server.url, modelsDir: dir })
		assert.equal(starting.status, 'downloading')
		await downloader.whenDone()
		const state = downloader.state()
		assert.equal(state.status, 'done')
		assert.equal(state.bytes, 12)
		assert.equal(await readFile(join(dir, 'test-model', 'config.json'), 'utf8'), 'cfg!')
		assert.equal((await stat(join(dir, 'test-model', 'onnx', 'model_quantized.onnx'))).size, 8)
		assert.equal(await modelPresent(FAKE_MODEL, dir), true)

		// 再跑一次：两个文件都已完整，直接完成且不重复计数
		await downloader.start({ model: 'test-model', mirror: server.url, modelsDir: dir })
		await downloader.whenDone()
		assert.equal(downloader.state().status, 'done')
		assert.equal(downloader.state().bytes, 12)
	} finally {
		await server.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('下载器拒绝并发、把 HTTP 错误报进状态，并能取消', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evr-download-'))
	const slow = await fakeModelServer({ delayMs: 120 })
	const missing = await fakeModelServer({ delayMs: 0 })
	try {
		const downloader = new ModelDownloader({ models: [FAKE_MODEL] })
		await downloader.start({ model: 'test-model', mirror: slow.url, modelsDir: dir })
		await assert.rejects(() => downloader.start({ model: 'test-model', mirror: slow.url, modelsDir: dir }), /正在进行/)
		downloader.cancel()
		await downloader.whenDone()
		assert.equal(downloader.state().status, 'cancelled')

		// 404 的模型：换成只认识一个文件的服务器，另一个文件会 404
		const brokenModel = { ...FAKE_MODEL, files: [{ path: 'missing.bin', bytes: 3 }], bytes: 3 }
		const broken = new ModelDownloader({ models: [brokenModel] })
		await broken.start({ model: 'test-model', mirror: missing.url, modelsDir: join(dir, 'broken') })
		await broken.whenDone()
		assert.equal(broken.state().status, 'error')
		assert.match(broken.state().error, /HTTP 404/)

		await assert.rejects(() => downloader.start({ model: 'unknown', mirror: slow.url, modelsDir: dir }), /未知模型/)
	} finally {
		await slow.close()
		await missing.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('embeddingConfig 解析默认目录与模型前缀', () => {
	const config = embeddingConfig({
		provider: 'model',
		model: 'bge-small-zh-v1.5',
		runtimePath: '',
		baseURL: '',
		apiKey: '',
	}, { dataDir: '/data/evolver', dshHome: '/home/test' })
	assert.equal(config.modelPath, join('/data/evolver', 'models'))
	assert.equal(config.runtimePath, join('/home/test', 'embedding-runtime'))
	assert.equal(config.modelName, 'bge-small-zh-v1.5')
	assert.equal(config.dimensions, 512)
	assert.match(config.queryPrefix, /检索/)
	assert.equal(config.passagePrefix, '')

	const e5 = embeddingConfig({ provider: 'local', model: 'multilingual-e5-small', runtimePath: '/data/runtime' }, { dataDir: '/data/evolver', dshHome: '/home/test' })
	assert.equal(e5.modelPath, join('/data/evolver', 'models'))
	assert.equal(e5.runtimePath, '/data/runtime')
	assert.equal(e5.dimensions, undefined)
	assert.equal(e5.queryPrefix, 'query: ')
	assert.equal(e5.passagePrefix, 'passage: ')
})

test('测试后端：本地哈希返回固定维度，none 明确报错', async () => {
	const local = await probeEmbedding({ provider: 'local' })
	assert.equal(local.backend, 'local')
	assert.equal(local.dimensions, 256)
	assert.equal(local.configured, 'local')
	await assert.rejects(() => probeEmbedding({ provider: 'none' }), /没有向量能力/)
})

test('旧权重目录在启动时迁入数据目录，不重复下载', async () => {
	const home = await mkdtemp(join(tmpdir(), 'evr-home-'))
	const data = await mkdtemp(join(tmpdir(), 'evr-data-'))
	try {
		const legacy = join(home, 'evolver-models', 'test-model')
		await mkdir(join(legacy, 'onnx'), { recursive: true })
		await writeFile(join(legacy, 'config.json'), '{}')
		await writeFile(join(legacy, 'onnx', 'model_quantized.onnx'), 'weights')
		assert.equal((await legacyModelState(home)).bytes > 0, true)

		const result = await migrateLegacyModels({ dataDir: data, dshHome: home })
		assert.deepEqual(result.migrated, ['test-model'])
		assert.equal(await readFile(join(data, 'models', 'test-model', 'config.json'), 'utf8'), '{}')
		assert.equal(await readFile(join(data, 'models', 'test-model', 'onnx', 'model_quantized.onnx'), 'utf8'), 'weights')
		assert.equal((await legacyModelState(home)).dirs.length, 0)
	} finally {
		await rm(home, { recursive: true, force: true })
		await rm(data, { recursive: true, force: true })
	}
})

test('新目录已有同名模型时旧目录保留并报告', async () => {
	const home = await mkdtemp(join(tmpdir(), 'evr-home-'))
	const data = await mkdtemp(join(tmpdir(), 'evr-data-'))
	try {
		await mkdir(join(home, 'evolver-models', 'test-model'), { recursive: true })
		await writeFile(join(home, 'evolver-models', 'test-model', 'config.json'), 'old')
		await mkdir(join(data, 'models', 'test-model'), { recursive: true })
		await writeFile(join(data, 'models', 'test-model', 'config.json'), 'new')

		const result = await migrateLegacyModels({ dataDir: data, dshHome: home })
		assert.deepEqual(result.migrated, [])
		assert.deepEqual(result.blocked, ['test-model'])
		assert.equal(await readFile(join(data, 'models', 'test-model', 'config.json'), 'utf8'), 'new')
	} finally {
		await rm(home, { recursive: true, force: true })
		await rm(data, { recursive: true, force: true })
	}
})

test('清理旧权重只删模型目录，不动其它文件', async () => {
	const home = await mkdtemp(join(tmpdir(), 'evr-home-'))
	try {
		await mkdir(join(home, 'evolver-models', 'test-model'), { recursive: true })
		await writeFile(join(home, 'evolver-models', 'test-model', 'config.json'), '{}')
		await writeFile(join(home, 'evolver-models', 'notes.txt'), 'keep me')

		const removed = await removeLegacyModels(home)
		assert.equal(removed.removed, 1)
		assert.equal(removed.bytes > 0, true)
		assert.equal(await readFile(join(home, 'evolver-models', 'notes.txt'), 'utf8'), 'keep me')
		assert.equal((await legacyModelState(home)).dirs.length, 0)
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})
