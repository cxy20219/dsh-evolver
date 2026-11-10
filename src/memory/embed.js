import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Pluggable embeddings.
 *
 * Three backends, one interface:
 *
 *   - `local`  — feature hashing over the same tokens the keyword index uses.
 *     No model, no network, deterministic, and the cosine of two such vectors
 *     tracks lexical (and, for CJK, character-bigram) similarity. It is not a
 *     language model, but for a memory store whose contents are mostly
 *     technical statements, it is a good enough stand-in to make the hybrid
 *     pipeline meaningful offline.
 *   - `http`   — any OpenAI-compatible `/embeddings` endpoint (MiniMax,
 *     OpenAI, DashScope, Ollama, …). Configured in the panel's settings.
 *   - `none`   — no vectors at all; retrieval degrades to BM25.
 */

/** Dimensions of the local hashing space. */
export const LOCAL_DIMENSIONS = 256

const LATIN = /[a-z0-9][a-z0-9_.-]*/gi
const CJK_RUN = /[一-鿿]+/g

/**
 * The tokens a text is hashed over.
 *
 * Latin words and CJK bigrams, exactly like the keyword index, so the vector
 * space and the keyword space agree on what a word is.
 *
 * @param {string} text - Source text.
 * @returns {string[]} Tokens.
 */
export function embeddingTokens(text) {
	const value = String(text ?? '')
	const tokens = []
	for (const match of value.matchAll(LATIN)) tokens.push(match[0].toLowerCase())
	for (const match of value.matchAll(CJK_RUN)) {
		const run = match[0]
		if (run.length === 1) {
			tokens.push(run)
			continue
		}
		for (let index = 0; index + 2 <= run.length; index += 1) tokens.push(run.slice(index, index + 2))
	}
	return tokens
}

/**
 * Hash a token to a bucket and a sign.
 *
 * The sign keeps unrelated tokens from all piling into the same direction,
 * which is what makes the inner product approximate a set overlap instead of
 * a count.
 *
 * @param {string} token - Token.
 * @returns {{bucket: number, sign: number}} The bucket and its sign.
 */
export function hashToken(token) {
	const digest = createHash('sha1').update(token).digest()
	const bucket = digest.readUInt16BE(0) % LOCAL_DIMENSIONS
	const sign = digest[2] & 1 ? 1 : -1
	return { bucket, sign }
}

/**
 * A deterministic local embedding of a text.
 *
 * @param {string} text - Source text.
 * @param {{dimensions?: number}} [options] - Vector width.
 * @returns {Float32Array} The unit-length vector.
 */
export function localEmbedding(text, { dimensions = LOCAL_DIMENSIONS } = {}) {
	const vector = new Float32Array(dimensions)
	const counts = new Map()
	for (const token of embeddingTokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1)
	for (const [token, count] of counts) {
		const { bucket, sign } = hashToken(token)
		// Sub-linear term weighting: a word repeated ten times is not ten
		// times as important.
		vector[bucket] += sign * (1 + Math.log(count))
	}
	return normalize(vector)
}

/**
 * Scale a vector to unit length.
 *
 * @param {Float32Array | number[]} vector - The vector.
 * @returns {Float32Array} The normalised vector.
 */
export function normalize(vector) {
	let norm = 0
	for (let index = 0; index < vector.length; index += 1) norm += vector[index] * vector[index]
	if (norm === 0) return vector instanceof Float32Array ? vector : new Float32Array(vector)
	const scale = 1 / Math.sqrt(norm)
	const out = vector instanceof Float32Array ? vector : new Float32Array(vector.length)
	for (let index = 0; index < vector.length; index += 1) out[index] = vector[index] * scale
	return out
}

/**
 * The cosine similarity of two vectors.
 *
 * @param {Float32Array | number[]} left - First vector.
 * @param {Float32Array | number[]} right - Second vector.
 * @returns {number} The similarity in [-1, 1].
 */
export function cosine(left, right) {
	if (!left || !right || left.length === 0 || left.length !== right.length) return 0
	let dot = 0
	let leftNorm = 0
	let rightNorm = 0
	for (let index = 0; index < left.length; index += 1) {
		dot += left[index] * right[index]
		leftNorm += left[index] * left[index]
		rightNorm += right[index] * right[index]
	}
	if (leftNorm === 0 || rightNorm === 0) return 0
	return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

/** How long one embedding request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * An embedder backed by an OpenAI-compatible endpoint.
 */
class HttpEmbedder {
	/**
	 * @param {{baseURL: string, apiKey: string, model: string, dimensions?: number}} config - Endpoint configuration.
	 */
	constructor(config) {
		this.id = 'http'
		this.baseURL = String(config.baseURL ?? '').replace(/\/+$/, '')
		this.apiKey = config.apiKey ?? ''
		this.model = config.model ?? ''
		this.dimensions = config.dimensions ?? 0
	}

	/**
	 * Embed a batch of texts.
	 *
	 * A request without a deadline used to be able to hold the whole plugin
	 * (and the panel's recall button) open for as long as the endpoint stayed
	 * silent, so every request now carries a timeout and every response is
	 * checked against what was asked for.
	 *
	 * @param {string[]} texts - Texts to embed.
	 * @returns {Promise<Float32Array[]>} One vector per text.
	 */
	async embedBatch(texts) {
		if (texts.length === 0) return []
		const signal = typeof AbortSignal.timeout === 'function'
			? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			: undefined
		let response
		try {
			response = await fetch(`${this.baseURL}/embeddings`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(this.apiKey === '' ? {} : { authorization: `Bearer ${this.apiKey}` }),
				},
				body: JSON.stringify({
					model: this.model,
					input: texts,
					...(this.dimensions > 0 ? { dimensions: this.dimensions } : {}),
				}),
				...(signal === undefined ? {} : { signal }),
			})
		} catch (error) {
			throw new Error(`embedding 请求失败：${error instanceof Error ? error.message : String(error)}`)
		}
		if (!response.ok) throw new Error(`embedding 请求失败：HTTP ${response.status}`)
		const payload = await response.json()
		const data = Array.isArray(payload?.data) ? payload.data : []
		if (data.length !== texts.length) {
			throw new Error(`embedding 返回 ${data.length} 条向量，请求的是 ${texts.length} 条`)
		}
		return data.map((item) => {
			const values = Array.isArray(item?.embedding) ? item.embedding : undefined
			if (values === undefined || values.length === 0) throw new Error('embedding 返回的数据缺少向量')
			if (this.dimensions > 0 && values.length !== this.dimensions) {
				throw new Error(`embedding 向量维度是 ${values.length}，配置的是 ${this.dimensions}`)
			}
			return normalize(Float32Array.from(values))
		})
	}

	/**
	 * Embed one document.
	 *
	 * @param {string} text - Text to embed.
	 * @returns {Promise<Float32Array>} The vector.
	 */
	async embed(text) {
		const [vector] = await this.embedBatch([text])
		return vector ?? new Float32Array(0)
	}

	/**
	 * Embed a query.
	 *
	 * Some models are trained with a prefix that tells the query and the
	 * document apart; without it their scores are worse.
	 *
	 * @param {string} text - The query text.
	 * @returns {Promise<Float32Array>} The vector.
	 */
	async embedQuery(text) {
		return this.embed(text)
	}

	/**
	 * Embed a document.
	 *
	 * @param {string} text - The document text.
	 * @returns {Promise<Float32Array>} The vector.
	 */
	async embedDocument(text) {
		return this.embed(text)
	}
}

/**
 * An embedder that produces no vectors.
 */
class NoneEmbedder {
	constructor() {
		this.id = 'none'
		this.dimensions = 0
	}

	async embedBatch() {
		return []
	}

	async embed() {
		return new Float32Array(0)
	}

	async embedQuery() {
		return new Float32Array(0)
	}

	async embedDocument() {
		return new Float32Array(0)
	}
}

/**
 * An embedder backed by a local ONNX model.
 *
 * The *weights* are data and live in the panel's own folder
 * (`<dataDir>/models/<name>/`), so they travel with a backup. The *runtime*
 * (transformers.js plus an ONNX runtime) is a program and stays outside, in a
 * tools folder: the native part is platform-specific, while the model is not.
 *
 * The model is loaded lazily — a panel that never asks a semantic question
 * never pays for it — and every failure degrades to the hashing backend
 * instead of breaking the plugin.
 */
export class ModelEmbedder {
	/**
	 * @param {{modelPath?: string, runtimePath?: string, modelName?: string, logger?: object}} config - Model configuration.
	 */
	constructor(config = {}) {
		this.modelPath = config.modelPath ?? ''
		this.runtimePath = config.runtimePath ?? ''
		this.modelName = config.modelName ?? 'multilingual-e5-small'
		this.logger = config.logger
		this.id = 'model'
		this.dimensions = 0
		this.extractor = undefined
		this.loading = undefined
		this.failed = false
		// Models trained with a query/document distinction need the prefixes.
		const e5 = /e5/i.test(this.modelName)
		this.queryPrefix = config.queryPrefix ?? (e5 ? 'query: ' : '')
		this.passagePrefix = config.passagePrefix ?? (e5 ? 'passage: ' : '')
	}

	/**
	 * Whether the model and the runtime are both present.
	 *
	 * @returns {boolean} True when the model can be loaded.
	 */
	available() {
		if (this.modelPath === '' || this.runtimePath === '') return false
		const modelDir = join(this.modelPath, this.modelName)
		if (!existsSync(join(modelDir, 'config.json'))) return false
		if (!existsSync(join(modelDir, 'tokenizer.json'))) return false
		try {
			createRequire(join(this.runtimePath, 'noop.js')).resolve('@huggingface/transformers')
			return true
		} catch {
			return false
		}
	}

	/**
	 * Load the model once.
	 *
	 * @returns {Promise<object | undefined>} The extractor, or `undefined` when it cannot be loaded.
	 */
	async ensure() {
		if (this.extractor !== undefined) return this.extractor
		if (this.failed) return undefined
		if (this.loading === undefined) {
			this.loading = this.load().catch(error => {
				this.failed = true
				this.logger?.warn?.(`dsh-evolver: embedding model unavailable, falling back to hashing: ${error instanceof Error ? error.message : String(error)}`)
				return undefined
			})
		}
		this.extractor = await this.loading
		return this.extractor
	}

	/**
	 * Load the pipeline from the runtime outside the plugin.
	 *
	 * @returns {Promise<object | undefined>} The extractor.
	 */
	async load() {
		if (!this.available()) throw new Error('model or runtime missing')
		const require_ = createRequire(join(this.runtimePath, 'noop.js'))
		const entry = require_.resolve('@huggingface/transformers')
		const module = await import(pathToFileURL(entry).href)
		module.env.allowRemoteModels = false
		module.env.allowLocalModels = true
		module.env.localModelPath = this.modelPath
		if (module.env.backends?.onnx?.wasm !== undefined) {
			module.env.backends.onnx.wasm.numThreads = 1
		}
		return module.pipeline('feature-extraction', this.modelName, {
			device: 'cpu',
			dtype: 'q8',
			local_files_only: true,
		})
	}

	/**
	 * Embed a batch of texts.
	 *
	 * @param {string[]} texts - Texts to embed.
	 * @returns {Promise<Float32Array[]>} One vector per text.
	 */
	async embedBatch(texts) {
		if (texts.length === 0) return []
		const extractor = await this.ensure()
		if (extractor === undefined) return []
		const output = await extractor(texts, { pooling: 'mean', normalize: true })
		const vectors = output.tolist().map(row => Float32Array.from(row))
		if (vectors.length > 0) this.dimensions = vectors[0].length
		return vectors
	}

	/**
	 * Embed one text.
	 *
	 * @param {string} text - Text to embed.
	 * @returns {Promise<Float32Array>} The vector.
	 */
	async embed(text) {
		const [vector] = await this.embedBatch([text])
		return vector ?? new Float32Array(0)
	}

	/**
	 * Embed a query with the model's query prefix.
	 *
	 * @param {string} text - The query text.
	 * @returns {Promise<Float32Array>} The vector.
	 */
	async embedQuery(text) {
		const [vector] = await this.embedBatch([this.queryPrefix + text])
		return vector ?? new Float32Array(0)
	}

	/**
	 * Embed a document with the model's passage prefix.
	 *
	 * @param {string} text - The document text.
	 * @returns {Promise<Float32Array>} The vector.
	 */
	async embedDocument(text) {
		const [vector] = await this.embedBatch([this.passagePrefix + text])
		return vector ?? new Float32Array(0)
	}
}

/**
 * Create the embedder a configuration asks for.
 *
 * @param {{provider?: string, baseURL?: string, apiKey?: string, model?: string, dimensions?: number, modelPath?: string, runtimePath?: string, modelName?: string, logger?: object}} [config] - Embedding configuration.
 * @returns {{id: string, dimensions: number, embed: (text: string) => Promise<Float32Array>, embedBatch: (texts: string[]) => Promise<Float32Array[]>}} The embedder.
 */
export function createEmbedder(config = {}) {
	const provider = String(config.provider ?? 'local').toLowerCase()
	if (provider === 'none') return new NoneEmbedder()
	if (provider === 'http') {
		if (config.baseURL === undefined || config.baseURL === '' || config.model === undefined || config.model === '') {
			return new NoneEmbedder()
		}
		return new HttpEmbedder(config)
	}
	if (provider === 'model') {
		const model = new ModelEmbedder(config)
		if (!model.available()) {
			config.logger?.warn?.('dsh-evolver: embedding model or runtime missing, falling back to hashing')
			return createEmbedder({ ...config, provider: 'local' })
		}
		return model
	}
	return {
		id: 'local',
		dimensions: LOCAL_DIMENSIONS,
		// The hashing embedder separates cleanly: a hit scores well above
		// the noise floor, so an absolute threshold works.
		relevanceFloor: 0.35,
		async embed(text) {
			return localEmbedding(text, { dimensions: config.dimensions ?? LOCAL_DIMENSIONS })
		},
		async embedBatch(texts) {
			return texts.map(text => localEmbedding(text, { dimensions: config.dimensions ?? LOCAL_DIMENSIONS }))
		},
		async embedQuery(text) {
			return localEmbedding(text, { dimensions: config.dimensions ?? LOCAL_DIMENSIONS })
		},
		async embedDocument(text) {
			return localEmbedding(text, { dimensions: config.dimensions ?? LOCAL_DIMENSIONS })
		},
	}
}
