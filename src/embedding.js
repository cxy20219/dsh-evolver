/**
 * The local embedding catalogue and the weight downloader.
 *
 * The plugin ships no runtime: the ONNX model *weights* are data managed here,
 * while transformers.js and its ONNX runtime are a program the user installs
 * once. Weights live in `<dataDir>/models`, so a backup, an import, an export
 * or a move carries them along; the archive streams, so a large model does not
 * have to fit in memory. The runtime stays outside the data folder.
 *
 * Everything in this module is dependency-free and testable with a plain
 * http server; the actual inference happens in `memory/embed.js`.
 */

import { createRequire } from 'node:module'
import { cp, lstat, mkdir, open, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { createEmbedder } from './memory/embed.js'

/** Where weights are downloaded from by default. */
export const DEFAULT_EMBEDDING_MIRROR = 'https://hf-mirror.com'

/** The models the panel offers, with the exact files transformers.js reads. */
export const EMBEDDING_MODELS = [
	{
		id: 'multilingual-e5-small',
		repo: 'Xenova/multilingual-e5-small',
		label: 'Multilingual E5 Small',
		languages: '中文 + 英文 + 多语',
		dimensions: 384,
		bytes: 135392183,
		note: '中英均衡，默认推荐',
		queryPrefix: 'query: ',
		passagePrefix: 'passage: ',
		files: [
			{ path: 'config.json', bytes: 658 },
			{ path: 'tokenizer.json', bytes: 17082730 },
			{ path: 'tokenizer_config.json', bytes: 443 },
			{ path: 'special_tokens_map.json', bytes: 167 },
			{ path: 'onnx/model_quantized.onnx', bytes: 118308185 },
		],
	},
	{
		id: 'bge-small-zh-v1.5',
		repo: 'Xenova/bge-small-zh-v1.5',
		label: 'BGE Small 中文',
		languages: '中文为主，英文可用',
		dimensions: 512,
		bytes: 24451175,
		note: '体积最小，中文记忆优先',
		queryPrefix: '为这个句子生成表示以用于检索相关文章：',
		passagePrefix: '',
		files: [
			{ path: 'config.json', bytes: 716 },
			{ path: 'tokenizer.json', bytes: 439125 },
			{ path: 'tokenizer_config.json', bytes: 367 },
			{ path: 'special_tokens_map.json', bytes: 125 },
			{ path: 'onnx/model_quantized.onnx', bytes: 24010842 },
		],
	},
	{
		id: 'bge-m3',
		repo: 'Xenova/bge-m3',
		label: 'BGE M3',
		languages: '中英 + 多语',
		dimensions: 1024,
		bytes: 586780258,
		note: '质量最高，体积大、加载慢',
		queryPrefix: '',
		passagePrefix: '',
		files: [
			{ path: 'config.json', bytes: 770 },
			{ path: 'tokenizer.json', bytes: 17082821 },
			{ path: 'tokenizer_config.json', bytes: 1173 },
			{ path: 'special_tokens_map.json', bytes: 964 },
			{ path: 'onnx/model_quantized.onnx', bytes: 569694530 },
		],
	},
]

/**
 * Look one model up by id.
 *
 * @param {unknown} id - The model id.
 * @returns {object | undefined} The catalogue entry.
 */
export function findEmbeddingModel(id) {
	return EMBEDDING_MODELS.find((model) => model.id === String(id ?? ''))
}

/**
 * The files a model needs before it can be loaded.
 *
 * @param {object} model - A catalogue entry.
 * @returns {Array<{path: string, bytes: number}>} The required files.
 */
export function requiredModelFiles(model) {
	return model.files.filter((file) => file.path === 'config.json'
		|| file.path === 'tokenizer.json'
		|| file.path === 'onnx/model_quantized.onnx')
}

/**
 * Check whether a path exists.
 *
 * @param {string} path - Absolute path.
 * @returns {Promise<boolean>} True when it exists.
 */
async function exists(path) {
	return lstat(path).then(() => true, () => false)
}

/**
 * Sum the regular files under one folder, without following links.
 *
 * @param {string} root - The folder.
 * @returns {Promise<number>} The total size in bytes.
 */
async function folderBytes(root) {
	let total = 0
	/**
	 * Walk one folder.
	 *
	 * @param {string} folder - The folder.
	 * @returns {Promise<void>} Resolves when walked.
	 */
	async function walk(folder) {
		for (const name of await readdir(folder).catch(() => [])) {
			const path = join(folder, name)
			const info = await lstat(path).catch(() => undefined)
			if (info === undefined || info.isSymbolicLink()) continue
			if (info.isDirectory()) {
				await walk(path)
				continue
			}
			if (info.isFile()) total += info.size
		}
	}
	await walk(root)
	return total
}

/** A folder name that came from the model catalogue. */
const MODEL_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Describe the pre-`models/` weights folder, if it still exists.
 *
 * Older versions kept weights in `<dshHome>/evolver-models`, outside the data
 * folder. They are moved into `<dataDir>/models` on startup; whatever remains
 * (usually because the new folder already has that model) is reported so the
 * panel can offer to remove it.
 *
 * @param {string} dshHome - The harness home.
 * @returns {Promise<{root: string, dirs: Array<{name: string, path: string, bytes: number}>, bytes: number}>} The legacy state.
 */
export async function legacyModelState(dshHome) {
	const root = join(dshHome, 'evolver-models')
	const info = await lstat(root).catch(() => undefined)
	if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) {
		return { root, dirs: [], bytes: 0 }
	}
	const dirs = []
	let bytes = 0
	for (const name of (await readdir(root).catch(() => [])).sort()) {
		if (!MODEL_FOLDER_PATTERN.test(name)) continue
		const path = join(root, name)
		const child = await lstat(path).catch(() => undefined)
		if (child === undefined || !child.isDirectory() || child.isSymbolicLink()) continue
		const size = await folderBytes(path)
		dirs.push({ name, path, bytes: size })
		bytes += size
	}
	return { root, dirs, bytes }
}

/**
 * Move weights from the legacy folder into the data folder.
 *
 * A model already present in `<dataDir>/models` is left alone; moving it would
 * overwrite a newer download. The move is a rename when both folders share a
 * filesystem, and a copy plus delete otherwise.
 *
 * @param {{dataDir: string, dshHome: string, logger?: object}} options - The folders.
 * @returns {Promise<{migrated: string[], blocked: string[], legacy: object}>} What happened.
 */
export async function migrateLegacyModels({ dataDir, dshHome, logger }) {
	const legacy = await legacyModelState(dshHome)
	const modelsDir = join(dataDir, 'models')
	const migrated = []
	const blocked = []
	for (const dir of legacy.dirs) {
		const target = join(modelsDir, dir.name)
		if (await exists(target)) {
			blocked.push(dir.name)
			continue
		}
		await mkdir(modelsDir, { recursive: true, mode: 0o700 })
		try {
			await rename(dir.path, target)
		} catch (error) {
			if (error?.code !== 'EXDEV') throw error
			await cp(dir.path, target, { recursive: true, force: false, errorOnExist: true })
			await rm(dir.path, { recursive: true, force: true })
		}
		migrated.push(dir.name)
		logger?.info?.(`dsh-evolver: moved legacy embedding weights ${dir.name} into the data folder`)
	}
	return { migrated, blocked, legacy }
}

/**
 * Delete the legacy weights folder after the user confirms.
 *
 * Only catalogue-shaped model directories are removed; any other file the
 * user kept there is left alone, and the root is removed only when empty.
 *
 * @param {string} dshHome - The harness home.
 * @returns {Promise<{removed: number, bytes: number}>} What was removed.
 */
export async function removeLegacyModels(dshHome) {
	const legacy = await legacyModelState(dshHome)
	let removed = 0
	let bytes = 0
	for (const dir of legacy.dirs) {
		await rm(dir.path, { recursive: true, force: true })
		removed += 1
		bytes += dir.bytes
	}
	const left = await readdir(legacy.root).catch(() => null)
	if (left !== null && left.length === 0) await rmdir(legacy.root).catch(() => {})
	return { removed, bytes }
}

/**
 * Whether every required file of a model is already on disk.
 *
 * @param {object} model - A catalogue entry.
 * @param {string} modelsDir - The root that holds one folder per model.
 * @returns {Promise<boolean>} True when the model can be loaded.
 */
export async function modelPresent(model, modelsDir) {
	for (const file of requiredModelFiles(model)) {
		const info = await stat(join(modelsDir, model.id, ...file.path.split('/'))).catch(() => undefined)
		if (info === undefined || info.size === 0) return false
	}
	return true
}

/**
 * Where weights and the runtime live.
 *
 * Weights are part of the data folder (`<dataDir>/models`) so a backup, an
 * import and a move all carry them. The runtime is a program, not data, and
 * stays outside; it is the one path the user may override.
 *
 * @param {{runtimePath?: string}} embedding - The settings block.
 * @param {{dataDir: string, dshHome: string}} options - The data folder and harness home.
 * @returns {{modelsDir: string, runtimePath: string}} The resolved folders.
 */
export function embeddingLocations(embedding, { dataDir, dshHome }) {
	return {
		modelsDir: join(dataDir, 'models'),
		runtimePath: typeof embedding?.runtimePath === 'string' && embedding.runtimePath !== ''
			? embedding.runtimePath
			: join(dshHome, 'embedding-runtime'),
	}
}

/**
 * Whether the ONNX runtime is installed in one folder.
 *
 * @param {string} runtimePath - The folder that should contain node_modules.
 * @returns {{path: string, available: boolean, hint: string}} The state.
 */
export function runtimeState(runtimePath) {
	const hint = `npm install --prefix "${runtimePath}" @huggingface/transformers`
	try {
		createRequire(join(runtimePath, 'noop.js')).resolve('@huggingface/transformers')
		return { path: runtimePath, available: true, hint }
	} catch {
		return { path: runtimePath, available: false, hint }
	}
}

/**
 * The createEmbedder configuration for the current settings.
 *
 * @param {object} embedding - The settings block.
 * @param {{dshHome: string, logger?: object}} options - The harness home.
 * @returns {object} The configuration.
 */
export function embeddingConfig(embedding, { dataDir, dshHome, logger }) {
	const locations = embeddingLocations(embedding, { dataDir, dshHome })
	const model = findEmbeddingModel(embedding.model)
	const config = {
		provider: embedding.provider,
		modelName: embedding.model,
		modelPath: locations.modelsDir,
		runtimePath: locations.runtimePath,
		baseURL: embedding.baseURL,
		apiKey: embedding.apiKey,
		queryPrefix: model?.queryPrefix ?? '',
		passagePrefix: model?.passagePrefix ?? '',
		logger,
	}
	// Only the ONNX backend has a catalogue-known width. Passing it to the
	// hashing or HTTP backend would change their vectors (or break them),
	// because `dimensions` means "the size of this backend's vectors".
	if (embedding.provider === 'model' && model !== undefined) config.dimensions = model.dimensions
	return config
}

/**
 * Embed two sample strings to prove the configured backend works.
 *
 * A configured model that cannot load falls back to the hashing backend; the
 * result says which one actually answered, so the panel can warn instead of
 * pretending the model is in use.
 *
 * @param {object} config - The createEmbedder configuration.
 * @returns {Promise<{configured: string, backend: string, dimensions: number, latencyMs: number}>} The probe.
 */
export async function probeEmbedding(config) {
	const embedder = createEmbedder(config)
	if (embedder.id === 'none') throw new Error('当前后端没有向量能力（provider=none 或 HTTP 配置不完整）。')
	const started = Date.now()
	const vectors = await embedder.embedBatch(['插件结构验证', 'plugin structure check'])
	const vector = vectors[0]
	if (vector === undefined || vector.length === 0) throw new Error('后端没有返回向量。')
	return {
		configured: String(config.provider ?? ''),
		backend: embedder.id,
		dimensions: vector.length,
		latencyMs: Date.now() - started,
	}
}

/**
 * The idle download state.
 *
 * @returns {object} A fresh state object.
 */
function idleState() {
	return {
		status: 'idle',
		model: '',
		file: '',
		fileIndex: 0,
		fileCount: 0,
		bytes: 0,
		totalBytes: 0,
		startedAt: '',
		finishedAt: '',
		error: '',
	}
}

/**
 * Download one model's weights, one file at a time.
 *
 * Only one download runs at a time. Completed files are skipped on a retry,
 * and every file is written through a temporary name so a cancelled or failed
 * transfer cannot leave a half-written `.onnx` behind.
 */
export class ModelDownloader {
	/**
	 * @param {{models?: object[], logger?: object, fetchImpl?: Function, now?: () => Date, onDone?: Function}} [deps] - Dependencies.
	 */
	constructor({ models = EMBEDDING_MODELS, logger, fetchImpl, now = () => new Date(), onDone } = {}) {
		this.models = models
		this.logger = logger
		this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args))
		this.now = now
		this.onDone = onDone
		this.running = false
		this.controller = undefined
		this.task = undefined
		this.value = idleState()
	}

	/**
	 * A copy of the current state.
	 *
	 * @returns {object} The state.
	 */
	state() {
		return { ...this.value }
	}

	/**
	 * Start one download.
	 *
	 * @param {{model?: unknown, mirror?: unknown, modelsDir?: unknown}} request - What to download and where.
	 * @returns {Promise<object>} The initial state.
	 */
	async start({ model, mirror, modelsDir } = {}) {
		if (this.running) throw new Error('模型下载正在进行中，请等它结束。')
		const entry = this.models.find((item) => item.id === String(model ?? ''))
		if (entry === undefined) throw new Error(`未知模型：${String(model ?? '')}`)
		if (typeof modelsDir !== 'string' || !isAbsolute(modelsDir) || modelsDir === dirname(modelsDir)) {
			throw new Error('模型目录必须是绝对路径。')
		}
		const base = String(mirror ?? DEFAULT_EMBEDDING_MIRROR).trim().replace(/\/+$/, '')
		if (!/^https?:\/\//i.test(base)) throw new Error('下载源必须是 http(s) 地址。')

		this.running = true
		this.controller = new AbortController()
		const signal = this.controller.signal
		this.value = {
			...idleState(),
			status: 'downloading',
			model: entry.id,
			fileCount: entry.files.length,
			totalBytes: entry.bytes,
			startedAt: this.now().toISOString(),
		}
		this.task = this.run({ entry, base, modelsDir, signal })
			.then(async () => {
				if (this.value.status !== 'done' || typeof this.onDone !== 'function') return
				try {
					await this.onDone({ model: entry.id })
				} catch (error) {
					this.logger?.warn?.(`dsh-evolver: post-download reopen failed: ${error instanceof Error ? error.message : String(error)}`)
				}
			})
			.catch((error) => {
				if (signal.aborted) {
					this.value.status = 'cancelled'
					this.value.error = ''
				} else {
					this.value.status = 'error'
					this.value.error = error instanceof Error ? error.message : String(error)
					this.logger?.warn?.(`dsh-evolver: model download failed: ${this.value.error}`)
				}
			})
			.finally(() => {
				this.value.finishedAt = this.now().toISOString()
				this.running = false
				this.controller = undefined
			})
		return this.state()
	}

	/**
	 * Wait for the running download.
	 *
	 * @returns {Promise<void>} Resolves when it ends.
	 */
	async whenDone() {
		await this.task
	}

	/**
	 * Abort the running download.
	 *
	 * @returns {object} The state after asking for cancellation.
	 */
	cancel() {
		if (this.running && this.controller !== undefined) this.controller.abort()
		return this.state()
	}

	/**
	 * Download every file.
	 *
	 * @param {{entry: object, base: string, modelsDir: string, signal: AbortSignal}} request - The task.
	 * @returns {Promise<void>} Resolves when all files are in place.
	 */
	async run({ entry, base, modelsDir, signal }) {
		const root = join(modelsDir, entry.id)
		let bytes = 0
		for (let index = 0; index < entry.files.length; index += 1) {
			if (signal.aborted) throw new Error('cancelled')
			const file = entry.files[index]
			this.value.file = file.path
			this.value.fileIndex = index + 1
			const target = join(root, ...file.path.split('/'))
			const existing = await stat(target).catch(() => undefined)
			if (existing !== undefined && existing.size === file.bytes) {
				// A previous attempt already completed this file.
				bytes += file.bytes
				this.value.bytes = bytes
				continue
			}
			await mkdir(dirname(target), { recursive: true, mode: 0o700 })
			const url = `${base}/${entry.repo}/resolve/main/${file.path}`
			const response = await this.fetchImpl(url, { signal })
			if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${file.path}`)
			const temp = `${target}.${process.pid}.${Date.now()}.part`
			const handle = await open(temp, 'w', 0o600)
			try {
				const reader = response.body.getReader()
				for (;;) {
					const { done, value } = await reader.read()
					if (done) break
					await handle.write(value)
					bytes += value.length
					this.value.bytes = bytes
				}
			} catch (error) {
				await handle.close().catch(() => {})
				await rm(temp, { force: true }).catch(() => {})
				throw error
			}
			await handle.close()
			await rename(temp, target)
		}
		if (signal.aborted) throw new Error('cancelled')
		this.value.status = 'done'
		this.value.file = ''
		this.value.bytes = bytes
		this.logger?.info?.(`dsh-evolver: model ${entry.id} downloaded (${bytes} bytes)`)
	}
}
