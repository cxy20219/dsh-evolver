/**
 * The small rule set that keeps obvious noise out of the card store.
 */

/** The noise categories and their patterns. */
const NOISE_CATEGORIES = [
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
