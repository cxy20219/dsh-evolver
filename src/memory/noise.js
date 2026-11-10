/**
 * Noise filtering and adaptive retrieval.
 *
 * Two small rules that keep the memory store from filling up with things
 * that are not memories.
 */

/**
 * The noise categories the reference implementation ships with.
 *
 * Each is a set of patterns; a text that matches one is noise, whatever its
 * importance says.
 */
export const NOISE_CATEGORIES = [
	{
		name: 'agent-denial',
		patterns: [
			/i don'?t have (any )?information/i,
			/i wasn'?t able to (find|locate)/i,
			/没有(相关)?信息/i,
			/无法(找到|获取)/i,
			/我(不|未)知道/i,
		],
	},
	{
		name: 'meta-question',
		patterns: [
			/do you remember/i,
			/你还记得/i,
			/what did you (remember|say)/i,
		],
	},
	{
		name: 'session-boilerplate',
		patterns: [
			/^(hi|hello|hey|good (morning|afternoon|evening))[.!?。！]?$/i,
			/^(你好|您好|在吗|早上好|晚上好)[.!?。！]?$/,
			/^(ok|okay|thanks|thank you|yes|sure)[.!?。！]?$/i,
			/^(好的|好|谢谢|收到|明白|继续)[.!?。！]?$/,
		],
	},
	{
		name: 'diagnostic-artifact',
		patterns: [
			/no explicit solution/i,
			/未提供明确(的)?(方案|解决)/i,
			/\bstack trace\b/i,
		],
	},
]

/**
 * Decide whether a text is noise.
 *
 * @param {string} text - The text to check.
 * @param {{categories?: object[]}} [options] - The categories to use.
 * @returns {{noise: boolean, category?: string}} The verdict.
 */
export function classifyNoise(text, { categories = NOISE_CATEGORIES } = {}) {
	const value = String(text ?? '').trim()
	if (value === '') return { noise: true, category: 'empty' }
	for (const category of categories) {
		for (const pattern of category.patterns) {
			if (pattern.test(value)) return { noise: true, category: category.name }
		}
	}
	return { noise: false }
}

/**
 * A filter that also learns what noise looks like.
 *
 * The learned prototypes are compared by cosine against the local embedding,
 * so a phrase that kept coming back without ever being useful stops being
 * stored.
 */
export class NoiseFilter {
	/**
	 * @param {{embedder?: object, threshold?: number, bankLimit?: number}} options - Filter options.
	 */
	constructor({ embedder, threshold = 0.82, bankLimit = 200 } = {}) {
		this.embedder = embedder
		this.threshold = threshold
		this.bankLimit = bankLimit
		/** @type {Array<{text: string, vector: number[]}>} */
		this.prototypes = []
	}

	/**
	 * Whether a text is noise.
	 *
	 * @param {string} text - The text to check.
	 * @returns {Promise<{noise: boolean, category?: string}>} The verdict.
	 */
	async check(text) {
		const rule = classifyNoise(text)
		if (rule.noise) return rule
		if (this.embedder === undefined || this.embedder.id === 'none' || this.prototypes.length === 0) return rule
		try {
			const vector = await this.embedder.embed(String(text))
			for (const prototype of this.prototypes) {
				const similarity = cosineOf(vector, prototype.vector)
				if (similarity >= this.threshold) return { noise: true, category: 'prototype' }
			}
		} catch {
			// A failed embedding must not block the write.
		}
		return rule
	}

	/**
	 * Learn a new noise prototype.
	 *
	 * @param {string} text - The text that turned out to be noise.
	 * @returns {Promise<void>} Resolves once the prototype is stored.
	 */
	async learn(text) {
		if (this.embedder === undefined || this.embedder.id === 'none') return
		if (this.prototypes.length >= this.bankLimit) return
		try {
			const vector = Array.from(await this.embedder.embed(String(text)))
			for (const prototype of this.prototypes) {
				if (cosineOf(vector, prototype.vector) >= 0.95) return
			}
			this.prototypes.push({ text: String(text), vector })
		} catch {
			// A failed embedding must not block the write.
		}
	}
}

/**
 * The cosine of two plain arrays.
 *
 * @param {number[] | Float32Array} left - First vector.
 * @param {number[] | Float32Array} right - Second vector.
 * @returns {number} The similarity.
 */
function cosineOf(left, right) {
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

/** Queries that never need the memory store. */
const SKIP_PATTERNS = [
	/^(hi|hello|hey|good (morning|afternoon|evening))[.!?。！]?$/i,
	/^(你好|您好|早上好|晚上好)[.!?。！]?$/,
	/^(ok|okay|thanks|thank you|yes|sure|continue|go ahead|proceed)[.!?。！]?$/i,
	/^(好的|谢谢|继续|开始吧|来吧)[.!?。！]?$/,
	/^\/[a-z][\w-]*\s*/i,
	/^(git|npm|pnpm|yarn|docker|kubectl|make)\s+/i,
]

/** Queries that always deserve the memory store. */
const FORCE_PATTERNS = [
	/\bremember\b/i,
	/\brecall\b/i,
	/\bforgot\b/i,
	/\bmemory\b/i,
	/\blast time\b/i,
	/\bpreviously\b/i,
	/\byesterday\b/i,
	/记得/i,
	/记忆/i,
	/之前/i,
	/上次/i,
	/以前/i,
]

/**
 * Whether a query can skip the memory store.
 *
 * @param {string} query - The query text.
 * @returns {boolean} True when recalling is pointless.
 */
export function shouldSkipRecall(query) {
	const value = String(query ?? '').trim()
	if (value === '') return true
	if (FORCE_PATTERNS.some(pattern => pattern.test(value))) return false
	return SKIP_PATTERNS.some(pattern => pattern.test(value))
}

/**
 * Whether a query must reach the memory store.
 *
 * @param {string} query - The query text.
 * @returns {boolean} True when recalling is required.
 */
export function shouldForceRecall(query) {
	return FORCE_PATTERNS.some(pattern => pattern.test(String(query ?? '')))
}

/**
 * Strip the wrappers a harness puts around a user message.
 *
 * @param {string} text - The raw text.
 * @returns {string} The cleaned text.
 */
export function normalizeQuery(text) {
	return String(text ?? '')
		.replace(/^\[[^\]]*\]\s*/g, '')
		.replace(/^\[[^\]]*\]\s*/g, '')
		.trim()
}
