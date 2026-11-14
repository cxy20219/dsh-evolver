/**
 * A quantitative comparison: dsh-evolver 1.0.0 vs 自衍中枢 (dsh-yuanshi).
 *
 * It copies the live evolver library into a temporary folder, migrates it into
 * a temporary 自衍中枢 store, then runs the same scenarios against both:
 *
 *   - description queries (hit overlap, payload bytes, latency)
 *   - body-only queries (the old plugin indexes bodies; 自衍中枢 does not, by design)
 *   - tag filtering
 *   - graph retrieval
 *   - write/read/startup/rebuild timing
 *   - injection size and storage footprint
 *
 * Everything is measured on copies; the live data folder is never written.
 *
 * Run from `yuanshi/`: `node scripts/compare.mjs`
 */

import { cp, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { indexText, refreshIndex } from '../src/injection.js'
import { clipDescription } from '../src/meta.js'
import { staticSection } from '../src/prompt.js'
import { FileStore } from '../src/store.js'

/** Where the archived evolver lives. */
const OLD_ROOT = process.env.OLD_EVOLVER_ROOT ?? '/Users/chengxinyu/Desktop/AI-work/dsh-evolver'

/** The live evolver data folder; copied, never written. */
const OLD_DATA = process.env.OLD_EVOLVER_DATA ?? join(homedir(), '.dsh', 'evolver')

/** The report is written next to this script. */
const REPORT_DIR = new URL('..', import.meta.url).pathname

const now = () => performance.now()
const round = (value) => Number(Number(value).toFixed(2))
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')

/** Common body words that would make a boring body-only sample. */
const STOPWORDS = new Set([
	'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'when', 'then', 'than',
	'were', 'been', 'they', 'their', 'which', 'would', 'could', 'should', 'about', 'after',
	'before', 'into', 'over', 'under', 'such', 'only', 'also', 'just', 'more', 'most', 'some',
	'other', 'these', 'those', 'there', 'where', 'while', 'because', 'being', 'using', 'user',
	'users', 'file', 'files', 'card', 'cards', 'code', 'test', 'tests', 'value', 'values',
])

/**
 * Whether a card carries an archive tag.
 *
 * @param {string[]} tags - The tags.
 * @returns {boolean} True for archived cards.
 */
function isArchived(tags) {
	return (tags ?? []).some((tag) => tag === '归档' || tag.endsWith('/归档'))
}

/**
 * The old card id behind a migrated file's `legacyId`.
 *
 * @param {unknown} value - `card-…` for a card, `card-…/file` for an attachment.
 * @returns {string} The old card id, or an empty string.
 */
function legacyCardId(value) {
	const text = String(value ?? '')
	if (/^card-[0-9A-HJKMNP-TV-Z]{26}$/.test(text)) return text
	const slash = text.indexOf('/')
	return slash > 0 ? text.slice(0, slash) : ''
}

/**
 * Run one async operation several times and average the wall time.
 *
 * @param {() => Promise<any>} fn - The operation.
 * @param {number} [rounds] - Repetitions.
 * @returns {Promise<{result: any, avgMs: number}>} The last result and the average.
 */
async function timed(fn, rounds = 3) {
	let result
	let total = 0
	for (let index = 0; index < rounds; index += 1) {
		const start = now()
		result = await fn()
		total += now() - start
	}
	return { result, avgMs: total / rounds }
}

/**
 * Count files and bytes under one folder.
 *
 * @param {string} root - The root.
 * @returns {Promise<{files: number, bytes: number}>} The totals.
 */
async function treeStats(root) {
	let files = 0
	let bytes = 0
	async function walk(dir) {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
		for (const entry of entries) {
			const path = join(dir, entry.name)
			if (entry.isSymbolicLink()) continue
			if (entry.isDirectory()) {
				await walk(path)
				continue
			}
			if (!entry.isFile()) continue
			const info = await stat(path).catch(() => undefined)
			if (info === undefined) continue
			files += 1
			bytes += info.size
		}
	}
	await walk(root)
	return { files, bytes }
}

/**
 * A description for a migrated attachment, from the card's reference line.
 *
 * @param {object} card - The old card.
 * @param {string} name - The attachment name.
 * @returns {string} The description.
 */
function attachmentDescription(card, name) {
	const body = String(card.body ?? '')
	const marker = `knowledge/resources/${card.id}/${name}`
	const at = body.indexOf(marker)
	if (at >= 0) {
		const start = body.lastIndexOf('[', at)
		const end = body.indexOf('\n', at)
		const line = body.slice(start >= 0 ? start : at, end >= 0 ? end : undefined)
		const cleaned = line.replace(/\[[^\]]+\]\([^)]*\)[：:]\s*/, '').trim()
		if (cleaned !== '') {
			const clipped = clipDescription(`${name}：${cleaned}`, 160)
			if (clipped !== '') return clipped
		}
	}
	const fallback = clipDescription(`附件 ${name}：${card.description ?? ''}`, 160)
	return fallback === '' ? `附件：${name}` : fallback
}

/**
 * Build the markdown report.
 *
 * @param {object} report - The collected data.
 * @returns {string} Markdown.
 */
function renderReport(report) {
	const lines = []
	const table = (headers, rows) => {
		lines.push(`| ${headers.join(' | ')} |`)
		lines.push(`| ${headers.map(() => '---').join(' | ')} |`)
		for (const row of rows) lines.push(`| ${row.join(' | ')} |`)
		lines.push('')
	}
	lines.push('# 自衍中枢 vs dsh-evolver 1.0.0：分场景量化对比')
	lines.push('')
	lines.push(`生成时间：${report.generatedAt}。老库复制自 \`${report.oldData}\`，只读；新库在临时目录迁移后测量。`)
	lines.push('')
	lines.push('## 0. 环境与库')
	lines.push('')
	table(['项', '值'], [
		['Node', report.node],
		['老插件卡（活跃）', report.library.oldCards],
		['老附件', report.library.oldAttachments],
		['迁移后新文件', report.library.newFiles],
		['其中卡片文件', report.library.newCardFiles],
		['其中附件文件', report.library.newAttachmentFiles],
		['迁移耗时', `${round(report.migrationMs)} ms`],
		['迁移后链接', report.library.newLinks],
		['迁移后标签', report.library.newTags],
	])
	lines.push('## 1. 注入体积')
	lines.push('')
	table(['部分', '老插件', '自衍中枢'], [
		['静态纪律 + 主动性协议', `${report.injection.oldStatic} B`, `${report.injection.newStatic} B`],
		['运行时候选（12 个 + 摘要）', `${report.injection.oldIndex} B`, `${report.injection.newIndex} B`],
		['合计', `${report.injection.oldTotal} B`, `${report.injection.newTotal} B`],
	])
	lines.push('## 2. 存储占用')
	lines.push('')
	table(['项', '老插件', '自衍中枢'], [
		['文件数', report.storage.oldFiles, report.storage.newFiles],
		['字节', `${report.storage.oldBytes} B`, `${report.storage.newBytes} B`],
		['相对老库', '—', `${round(report.storage.ratio * 100)}%`],
	])
	lines.push('## 3. 描述检索（老库描述基线 vs 自衍中枢；默认列显示正文额外命中）')
	lines.push('')
	table(['查询', '老描述基线 top5', '老默认命中', '新 top5', '描述基线/新重叠', '老 ms', '新 ms', '老返回 B', '新返回 B'], report.queries.map((row) => [
		row.query, row.oldDescriptionCount, row.oldCount, row.newCount, `${row.overlap}/${row.oldDescriptionCount}`, round(row.oldMs), round(row.newMs), row.oldBytes, row.newBytes,
	]))
	lines.push('## 4. 正文词检索（老库索引正文；自衍中枢只靠描述，可能 0 也可能被附件描述命中）')
	lines.push('')
	table(['只出现在正文的词', '老命中', '新命中', '说明'], report.bodyOnly.map((row) => [
		row.term, row.oldHits, row.newHits, row.newHits === 0 ? '描述没写就搜不到（代价）' : '新库通过附件/迁移描述也命中（收益）',
	]))
	lines.push('## 5. 标签过滤与图')
	lines.push('')
	table(['场景', '老插件', '自衍中枢'], [
		['标签 复盘 命中数', report.tag.oldCount, report.tag.newCount],
		['图查询 审计：节点', report.graph.oldNodes, report.graph.newNodes],
		['图查询 审计：边', report.graph.oldEdges, report.graph.newEdges],
		['图里附件节点', '0（附件不是节点）', report.graph.newAttachmentNodes],
	])
	lines.push('## 6. 写入与启动')
	lines.push('')
	table(['操作', '老插件', '自衍中枢'], [
		['写 100 个文件/卡片', `${round(report.write.oldMs)} ms`, `${round(report.write.newMs)} ms`],
		['单次写', `${round(report.write.oldPer)} ms`, `${round(report.write.newPer)} ms`],
		['老库首次加载（135 卡）', `${round(report.startup.oldInitMs)} ms`, '—'],
		['新库空库首次打开', '—', `${round(report.startup.newColdMs)} ms`],
		['重开（有数据 / 索引已存在）', `${round(report.startup.oldReloadMs)} ms`, `${round(report.startup.newWarmMs)} ms`],
		['新库全量重建索引', '—', `${round(report.startup.newRebuildMs)} ms`],
	])
	lines.push('## 7. 口径与限制')
	lines.push('')
	for (const line of [
		'老库默认 `query` 同时索引正文与描述；自衍中枢只索引 name/description/tags。第 3 节的“老描述基线”用 description+tags 的 token 重叠做对照，避免把“少了正文索引”误读成“描述检索变差”。',
		'老库存储统计只复制了 `knowledge/`；自衍中枢包含 `files/` 与 `system/`（DB、快照、设置、日志）。文件数差异主要来自每实体一个目录 + meta.json + SQLite。',
		'写入计时是 API 路径（不含 fsync）；启动计时是热缓存下的单次调用；Node 26 环境，桌面端 Node 24 的绝对数值会更高，两侧同环境对比仍成立。',
		'迁移把老附件变成了独立文件实体，并补了卡片 ↔ 附件的 links；所以自衍中枢的图比老图多节点/边，这是模型差异，不是排序 bug。',
		'样本是 135 张卡 / 10 个附件的真实库；延迟绝对值很小，受机器负载影响；大库趋势需另测。',
	]) lines.push(`- ${line}`)
	lines.push('')
	lines.push('## 8. 结论')
	lines.push('')
	for (const line of report.conclusions) lines.push(`- ${line}`)
	lines.push('')
	return lines.join('\n')
}

/**
 * Run the comparison.
 *
 * @returns {Promise<void>} Resolves when the report is written.
 */
async function main() {
	const work = await mkdtemp(join(tmpdir(), 'yuanshi-compare-'))
	const oldData = join(work, 'old')
	const newData = join(work, 'new')

	const oldModules = {
		store: await import(pathToFileURL(join(OLD_ROOT, 'src/cards/store.js')).href),
		prompt: await import(pathToFileURL(join(OLD_ROOT, 'src/cards/prompt.js')).href),
		proactive: await import(pathToFileURL(join(OLD_ROOT, 'src/proactive.js')).href),
		db: await import(pathToFileURL(join(OLD_ROOT, 'src/memory/db.js')).href),
	}
	await cp(join(OLD_DATA, 'knowledge'), join(oldData, 'knowledge'), { recursive: true })
	const logger = { info() {}, warn() {}, error() {} }

	let start = now()
	const oldStore = new oldModules.store.CardStore({ dataDir: oldData, logger })
	await oldStore.init()
	const oldInitMs = now() - start
	const oldCards = oldStore.all().filter((card) => !isArchived(card.tags))
	let oldAttachments = 0
	for (const card of oldCards) oldAttachments += (await oldStore.attachments(card.id)).length

	const newStore = new FileStore({ dataDir: newData })
	start = now()
	await newStore.open()
	const newColdMs = now() - start

	const migrationStart = now()
	const map = new Map()
	const linksByOldCard = new Map()
	for (const card of oldCards) {
		const description = String(card.description ?? '').trim() === ''
			? (clipDescription(card.body ?? '', 160) || `迁移卡片 ${card.id.slice(-5)}`)
			: card.description
		const file = await newStore.create({
			name: `card-${card.id.slice(-8)}.md`,
			description,
			content: String(card.body ?? ''),
			tags: (card.tags ?? []).length > 0 ? card.tags : ['迁移/未分类'],
			source: card.source,
			legacyId: card.id,
			created: card.created,
		})
		map.set(card.id, file.id)
		linksByOldCard.set(card.id, [])
	}
	for (const card of oldCards) {
		const links = (card.links ?? []).map((id) => map.get(id)).filter((id) => id !== undefined)
		linksByOldCard.set(card.id, links)
		if (links.length > 0) await newStore.update(map.get(card.id), { links })
	}
	let newAttachmentFiles = 0
	const attachmentIds = new Set()
	for (const card of oldCards) {
		const files = await oldStore.attachments(card.id)
		for (const file of files) {
			const created = await newStore.create({
				sourcePath: join(oldData, 'knowledge', 'resources', card.id, file.name),
				name: file.name,
				description: attachmentDescription(card, file.name),
				tags: [...(card.tags ?? []), '类型/附件'],
				links: [map.get(card.id)],
				legacyId: `${card.id}/${file.name}`,
			})
			newAttachmentFiles += 1
			attachmentIds.add(created.id)
			linksByOldCard.get(card.id).push(created.id)
		}
	}
	for (const card of oldCards) {
		const links = [...new Set(linksByOldCard.get(card.id))]
		if (links.length > 0) await newStore.update(map.get(card.id), { links })
	}
	const migrationMs = now() - migrationStart
	const stats = newStore.stats()

	await refreshIndex(newStore)
	const oldIndex = oldModules.prompt.cardIndexText(oldStore)
	const oldStatic = `${oldModules.prompt.cardSection()}\n\n${oldModules.proactive.PROACTIVE_PROTOCOL}`
	const newIndex = await indexText(newStore, 4096)
	const newStatic = staticSection()

	// A description-only baseline over the old cards. The old query ranks
	// bodies too, so comparing it directly with 自衍中枢 would measure the missing
	// body index rather than the description catalogue. This baseline uses the
	// same fields 自衍中枢 indexes (description + tags) and a token-overlap score.
	const oldDescriptionTokens = oldCards.map((card) => new Set(oldModules.db.tokenize(`${card.description ?? ''} ${(card.tags ?? []).join(' ')}`)))
	const descriptionTop = (query, limit = 5) => {
		const tokens = [...new Set(oldModules.db.tokenize(query))]
		return oldCards
			.map((card, index) => {
				const present = tokens.filter((token) => oldDescriptionTokens[index].has(token)).length
				return { card, score: present }
			})
			.filter((item) => item.score > 0)
			.sort((left, right) => right.score - left.score
				|| String(right.card.updated).localeCompare(String(left.card.updated))
				|| String(left.card.id).localeCompare(String(right.card.id)))
			.slice(0, limit)
			.map((item) => item.card)
	}

	const queryTerms = ['反向代理', '审计', '链接', '标签', '索引', '插件', '面板', '缓存']
	const queries = []
	for (const query of queryTerms) {
		const oldTimed = await timed(() => oldStore.query({ text: query, limit: 5 }), 3)
		const newTimed = await timed(() => newStore.list({ query, limit: 5 }), 3)
		const oldDesc = descriptionTop(query, 5)
		const oldIds = oldDesc.map((card) => card.id)
		const newLegacy = new Set(newTimed.result.files.map((file) => legacyCardId(file.legacyId)).filter(Boolean))
		queries.push({
			query,
			oldDescriptionCount: oldDesc.length,
			oldCount: oldTimed.result.length,
			newCount: newTimed.result.files.length,
			newTotal: newTimed.result.total,
			overlap: oldIds.filter((id) => newLegacy.has(id)).length,
			oldTop: oldTimed.result.map((card) => String(card.description ?? '').slice(0, 24)),
			newTop: newTimed.result.files.map((file) => String(file.description ?? '').slice(0, 24)),
			oldMs: oldTimed.avgMs,
			newMs: newTimed.avgMs,
			oldBytes: bytesOf(oldTimed.result),
			newBytes: bytesOf(newTimed.result.files),
		})
	}

	// Body-only terms: tokens that appear in old card bodies but in no old
	// description or tag. The old index finds them; the new one should not.
	const descriptionTokens = new Set()
	for (const card of oldCards) {
		for (const token of oldModules.db.tokenize(`${card.description ?? ''} ${(card.tags ?? []).join(' ')}`)) {
			descriptionTokens.add(token)
		}
	}
	const bodyTokenCounts = new Map()
	for (const card of oldCards) {
		for (const token of new Set(oldModules.db.tokenize(String(card.body ?? '')))) {
			if (descriptionTokens.has(token)) continue
			if (!/^[a-z]{5,}$/i.test(token)) continue
			if (STOPWORDS.has(token)) continue
			bodyTokenCounts.set(token, (bodyTokenCounts.get(token) ?? 0) + 1)
		}
	}
	const bodyTerms = [...bodyTokenCounts.entries()]
		.filter(([, count]) => count >= 1 && count <= 3)
		.sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
		.map(([token]) => token)
		.slice(0, 40)
	const bodyOnly = []
	for (const term of bodyTerms) {
		if (bodyOnly.length >= 3) break
		const oldHits = await oldStore.query({ text: term, limit: 5 })
		if (oldHits.length === 0) continue
		const newHits = await newStore.list({ query: term, limit: 5 })
		bodyOnly.push({
			term,
			oldHits: oldHits.length,
			newHits: newHits.total,
			oldTop: oldHits.map((card) => String(card.description ?? '').slice(0, 24)),
			newTop: newHits.files.map((file) => String(file.description ?? '').slice(0, 24)),
		})
	}

	const oldTagHits = await oldStore.query({ tags: ['复盘'], limit: 100 })
	const newTagHits = await newStore.list({ tags: ['复盘'], limit: 100 })

	const oldGraph = await oldStore.queryGraph({ text: '审计', hops: 2, limit: 5 })
	const newGraphSeeds = await newStore.list({ query: '审计', limit: 5 })
	const newGraph = newStore.graph(newGraphSeeds.files.map((file) => file.id), { hops: 2 })
	const graph = {
		oldNodes: oldGraph.graph?.nodes?.length ?? 0,
		oldEdges: oldGraph.graph?.edges?.length ?? 0,
		oldRelated: oldGraph.related?.length ?? 0,
		newNodes: newGraph.nodes.length,
		newEdges: newGraph.edges.length,
		newAttachmentNodes: newGraph.nodes.filter((node) => attachmentIds.has(node.id)).length,
	}

	// Write benchmark on fresh stores, so neither side pays for the migrated
	// corpus. These measure the API path, not fsync.
	const oldWrite = new oldModules.store.CardStore({ dataDir: join(work, 'old-write'), logger })
	await oldWrite.init()
	start = now()
	for (let index = 0; index < 100; index += 1) {
		await oldWrite.put({
			body: `性能测试正文 ${index}`,
			description: `写入性能测试卡片 ${index}`,
			tags: ['践行/测试'],
		})
	}
	const oldWriteMs = now() - start
	await oldWrite.close()

	const newWrite = new FileStore({ dataDir: join(work, 'new-write') })
	await newWrite.open()
	start = now()
	for (let index = 0; index < 100; index += 1) {
		await newWrite.create({
			name: `write-${index}.md`,
			description: `写入性能测试文件 ${index}`,
			content: `性能测试正文 ${index}`,
			tags: ['测试/写入'],
		})
	}
	const newWriteMs = now() - start
	newWrite.close()

	await oldStore.close()
	const oldReloadStart = now()
	const oldReloaded = new oldModules.store.CardStore({ dataDir: oldData, logger })
	await oldReloaded.init()
	const oldReloadMs = now() - oldReloadStart
	await oldReloaded.close()

	newStore.close()
	const newWarmStart = now()
	const reopened = new FileStore({ dataDir: newData })
	await reopened.open()
	const newWarmMs = now() - newWarmStart
	const rebuildStart = now()
	await reopened.rebuild()
	const newRebuildMs = now() - rebuildStart
	reopened.close()

	const oldTree = await treeStats(oldData)
	const newTree = await treeStats(newData)
	const oldTotal = Buffer.byteLength(oldStatic, 'utf8') + Buffer.byteLength(oldIndex, 'utf8')
	const newTotal = Buffer.byteLength(newStatic, 'utf8') + Buffer.byteLength(newIndex, 'utf8')
	const overlap = queries.reduce((sum, row) => sum + row.overlap, 0)
	const descriptionHits = queries.reduce((sum, row) => sum + row.oldDescriptionCount, 0)
	const defaultHits = queries.reduce((sum, row) => sum + row.oldCount, 0)
	const conclusions = [
		`描述检索：新库 top5 与老库“描述基线 top5”重合 ${overlap}/${descriptionHits}；差额来自排序策略（基线是 token 重叠，自衍中枢是 BM25+新近度+度数）和附件文件进入 top5。老库默认（正文+描述）top5 共 ${defaultHits} 条，比描述基线多 ${defaultHits - descriptionHits} 条，那是正文索引的额外召回。新库返回体平均 ${round(queries.reduce((sum, row) => sum + row.newBytes, 0) / queries.length)} B，老库 ${round(queries.reduce((sum, row) => sum + row.oldBytes, 0) / queries.length)} B（老查询结果带正文）。`,
		`正文词检索：${bodyOnly.length === 0 ? '没有采到可用样本' : bodyOnly.map((row) => `${row.term} ${row.oldHits}→${row.newHits}`).join('；')}。${bodyOnly.filter((row) => row.newHits === 0).length}/${bodyOnly.length} 个新库 0 命中，说明“描述没写就搜不到”；其余是附件描述/迁移描述带来的新命中。`,
		`注入：老 ${oldTotal} B，新 ${newTotal} B，差 ${newTotal - oldTotal} B。`,
		`存储：老 ${oldTree.files} 个文件 / ${oldTree.bytes} B；新 ${newTree.files} 个文件 / ${newTree.bytes} B（${round((newTree.bytes / Math.max(1, oldTree.bytes)) * 100)}%）。新增主要是每实体的 meta.json、DB 与快照。`,
		`写入：老 ${round(oldWriteMs)} ms / 100，新 ${round(newWriteMs)} ms / 100；新库每次写字节+边车+DB 三处，老库是一次追加日志。`,
		`启动：老库首次加载 ${round(oldInitMs)} ms；新库重开 ${round(newWarmMs)} ms、全量重建 ${round(newRebuildMs)} ms（空库首次打开 ${round(newColdMs)} ms，不可比）。`,
		`图：老返回 ${graph.oldNodes} 节点 / ${graph.oldEdges} 边；新返回 ${graph.newNodes} 节点 / ${graph.newEdges} 边，新库把附件也当成节点。`,
	]
	const report = {
		generatedAt: new Date().toISOString(),
		node: process.version,
		oldRoot: OLD_ROOT,
		oldData: OLD_DATA,
		library: {
			oldCards: oldCards.length,
			oldAttachments,
			newFiles: stats.files,
			newCardFiles: oldCards.length,
			newAttachmentFiles,
			newLinks: stats.links,
			newTags: stats.tags,
		},
		migrationMs,
		injection: {
			oldStatic: Buffer.byteLength(oldStatic, 'utf8'),
			oldIndex: Buffer.byteLength(oldIndex, 'utf8'),
			oldTotal,
			newStatic: Buffer.byteLength(newStatic, 'utf8'),
			newIndex: Buffer.byteLength(newIndex, 'utf8'),
			newTotal,
		},
		storage: {
			oldFiles: oldTree.files,
			oldBytes: oldTree.bytes,
			newFiles: newTree.files,
			newBytes: newTree.bytes,
			ratio: newTree.bytes / Math.max(1, oldTree.bytes),
		},
		queries,
		bodyOnly,
		tag: { oldCount: oldTagHits.length, newCount: newTagHits.total },
		graph,
		write: { oldMs: oldWriteMs, newMs: newWriteMs, oldPer: oldWriteMs / 100, newPer: newWriteMs / 100 },
		startup: { oldInitMs, newColdMs, oldReloadMs, newWarmMs, newRebuildMs },
		conclusions,
	}

	const markdown = renderReport(report)
	await writeFile(join(REPORT_DIR, 'COMPARISON.md'), markdown)
	await writeFile(join(REPORT_DIR, 'COMPARISON.json'), `${JSON.stringify(report, null, '\t')}\n`)
	console.log(`报告：${join(REPORT_DIR, 'COMPARISON.md')}`)
	console.log(JSON.stringify({
		library: report.library,
		injection: report.injection,
		storage: report.storage,
		queryOverlap: `${overlap}/${descriptionHits}`,
		bodyOnly: bodyOnly.map((row) => `${row.term}:${row.oldHits}->${row.newHits}`),
		write: report.write,
		startup: report.startup,
		graph,
	}, null, 2))
	await rm(work, { recursive: true, force: true })
}

await main()
