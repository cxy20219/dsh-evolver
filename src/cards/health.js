/**
 * A daily snapshot of the two things that make the library harder to use as
 * it grows.
 *
 *   - how much of it is still sitting in #即兴
 *   - how much of it is connected
 *
 * Neither number is visible anywhere else: the panel shows totals, but a card
 * alone in the fleeting branch looks exactly like a card that was filed
 * properly, and an unlinked card looks exactly like a linked one. Both are
 * measured here and written into one card that keeps a short history, so a
 * change to the writing rules can be read as a trend instead of a hunch.
 */

import { isArchived, rootOf } from './tags.js'

/** The tags the report card carries. */
export const REPORT_TAGS = ['践行/验证方法']

/** How many days the card keeps. */
export const MAX_ROWS = 14

/** The first line of the report card; also how it is found again. */
export const REPORT_TITLE = '卡片库健康度：即兴积压与链接率'

/**
 * Count the two problems, and the context they need to be read in.
 *
 * Archived cards are left out of every count: they are out of the way, so
 * they neither dilute the tree nor need links.
 *
 * @param {object[]} cards - Every card view.
 * @param {Record<string, string[]>} backlinks - Cards pointing at each id.
 * @returns {{cards: number, improvised: number, outbound: number, inbound: number, islands: number}} The counts.
 */
export function healthMetrics(cards, backlinks = {}) {
	const live = cards.filter((card) => !isArchived(card.tags))
	const ids = new Set(live.map((card) => card.id))
	let fleeting = 0
	let unfiled = 0
	let outbound = 0
	let inbound = 0
	let islands = 0
	for (const card of live) {
		const roots = (card.tags ?? []).map((tag) => rootOf(tag))
		// `fleeting` counts what the tag tree counts: a card still carrying
		// #即兴. Promoting drops that tag, so the number falls on its own as
		// cards get filed — but a card can carry it next to a settled branch,
		// which is why `unfiled` is counted separately. Only `unfiled` means
		// "nobody has said where this belongs".
		if (roots.includes('即兴')) {
			fleeting += 1
			if (roots.every((root) => root === '即兴')) unfiled += 1
		}
		const out = (card.links ?? []).filter((id) => ids.has(id)).length
		const into = (backlinks[card.id] ?? []).filter((id) => ids.has(id)).length
		if (out > 0) outbound += 1
		if (into > 0) inbound += 1
		if (out === 0 && into === 0) islands += 1
	}
	return { cards: live.length, fleeting, unfiled, outbound, inbound, islands }
}

/**
 * One line of the table.
 *
 * @param {{date: string} & ReturnType<typeof healthMetrics>} row - One day.
 * @returns {string} The line.
 */
export function formatRow(row) {
	const share = (value) => (row.cards === 0 ? '0%' : `${Math.round((value / row.cards) * 100)}%`)
	return [
		row.date.slice(5),
		String(row.cards).padStart(3),
		`${String(row.fleeting).padStart(3)} ${share(row.fleeting).padStart(4)}`,
		String(row.unfiled).padStart(4),
		`${String(row.outbound).padStart(3)} ${share(row.outbound).padStart(4)}`,
		`${String(row.inbound).padStart(3)} ${share(row.inbound).padStart(4)}`,
		String(row.islands).padStart(3),
	].join('  ')
}

/**
 * Render the whole card.
 *
 * The card is rewritten from the rows every time, so the history lives in the
 * ledger and the card stays a plain table that can be read at a glance.
 *
 * @param {Array<{date: string} & ReturnType<typeof healthMetrics>>} rows - Oldest first.
 * @returns {string} The card body.
 */
export function renderReport(rows) {
	if (rows.length === 0) return `${REPORT_TITLE}\n\n还没有数据。`
	const first = rows[0]
	const last = rows[rows.length - 1]
	const delta = (key) => {
		const value = last[key] - first[key]
		return value === 0 ? '持平' : `${value > 0 ? '+' : ''}${value}`
	}
	return [
		REPORT_TITLE,
		'',
		`带 #即兴 ${Math.round((last.fleeting / Math.max(1, last.cards)) * 100)}%，` +
			`有出链 ${Math.round((last.outbound / Math.max(1, last.cards)) * 100)}%，` +
			`孤岛 ${last.islands} 张。`,
		'',
		'```',
		'日期    卡  即兴     未归档  出链      入链      孤岛',
		...rows.map(formatRow),
		'```',
		'',
		`相对 ${first.date.slice(5)}：即兴 ${delta('fleeting')}，出链 ${delta('outbound')}，孤岛 ${delta('islands')}。`,
		'',
		'即兴=仍带 #即兴 的卡；未归档=其中没有归枝干的；孤岛=既无出链也无入链的卡。',
		'这三个数下降，说明写卡习惯在变好——只看总数看不出这件事。',
	].join('\n')
}
