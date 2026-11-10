/**
 * The card section the card store injects.
 *
 * The discipline stays short because it shares the 2 KB budget with the
 * permanent-card routing table. Fleeting cards are never injected; they are
 * reached through card_query or the card panel.
 */

/** The fixed discipline text. */
export const CARD_DISCIPLINE = [
	'[卡片] 卡片库是统一知识层：只有 permanent+verified 进入下面的路由表；fleeting 只按需检索。',
	'- 动身前用 card_query 查重；写入用 card_write（doc/tool/resource 的正文自动进资源附件）。',
	'- 临时结论用 card_write type=fleeting，一条一句；提升为永久卡用 card_promote。',
	'- 不写流水账、一次性命令、猜测、密钥；没有高信号就跳过。',
].join('\n')

/**
 * Build the injected card section.
 *
 * @param {object} cards - The card store.
 * @param {number} [budget] - Total section budget.
 * @returns {string} The section text.
 */
export function cardPrompt(cards, budget = 2048) {
	const reserve = Buffer.byteLength(CARD_DISCIPLINE, 'utf8') + 1
	return `${CARD_DISCIPLINE}\n${cards.projection({ budget: Math.max(256, budget - reserve) })}`
}
