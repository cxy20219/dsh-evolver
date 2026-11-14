/**
 * The P4 importer: one evolver card library → one 自衍中枢 file library.
 *
 * The source is the append-only `knowledge/cards/cards.jsonl`; the importer
 * reads the last record per id, skips tombstones, and keeps the old `card-`
 * id as `legacy_id` so a re-run is idempotent. Every attachment becomes its
 * own file entity linked to its card; the card body's resource path is
 * rewritten to the new `files/<id>/<name>` path.
 *
 * Dry-run is the default at the CLI; this module never writes unless `apply`
 * is true. It never opens the old library through the old store: the JSONL and
 * resource files are read directly, so the live evolver is not mutated.
 */

import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { refreshIndex } from './injection.js'
import { clipDescription } from './meta.js'
import { FileStore } from './store.js'

/**
 * Whether one tag is an old archive marker.
 *
 * @param {string} tag - The tag.
 * @returns {boolean} True for `归档` or `…/归档`.
 */
function isArchiveTag(tag) {
	return tag === '归档' || tag.endsWith('/归档')
}

/**
 * Read one old library without writing it.
 *
 * @param {string} dataDir - The old data directory (`…/.dsh/evolver`).
 * @returns {Promise<object>} `{cards, attachments, orphans, stats}`.
 */
export async function readEvolverLibrary(dataDir) {
	const cardsPath = join(dataDir, 'knowledge', 'cards', 'cards.jsonl')
	const text = await readFile(cardsPath, 'utf8')
	const lines = text.split('\n').filter((line) => line.trim() !== '')
	const last = new Map()
	let duplicates = 0
	let invalidLines = 0
	for (const [index, line] of lines.entries()) {
		let row
		try {
			row = JSON.parse(line)
		} catch {
			invalidLines += 1
			continue
		}
		if (row === null || typeof row !== 'object' || typeof row.id !== 'string' || row.id === '') {
			invalidLines += 1
			continue
		}
		void index
		if (last.has(row.id)) duplicates += 1
		last.set(row.id, row)
	}

	let deleted = 0
	const cards = []
	for (const row of last.values()) {
		if (row.deleted === true) {
			deleted += 1
			continue
		}
		const legacyTags = Array.isArray(row.tags) ? row.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '') : []
		const archived = legacyTags.some(isArchiveTag)
		const tags = archived ? legacyTags.filter((tag) => !isArchiveTag(tag)) : legacyTags
		const body = typeof row.body === 'string' ? row.body : ''
		const description = typeof row.description === 'string' ? row.description.trim() : ''
		cards.push({
			legacyId: row.id,
			body,
			description,
			tags: tags.length > 0 ? tags : (archived ? ['迁移/归档'] : ['迁移/未分类']),
			links: Array.isArray(row.links) ? row.links.filter((id) => typeof id === 'string' && id !== '') : [],
			source: row.source,
			updated: typeof row.updated === 'string' ? row.updated : undefined,
			archived,
			legacyTags,
		})
	}

	const resourcesRoot = join(dataDir, 'knowledge', 'resources')
	const activeIds = new Set(cards.map((card) => card.legacyId))
	const attachments = []
	const orphans = []
	for (const card of cards) {
		const folder = join(resourcesRoot, card.legacyId)
		const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
		for (const entry of entries) {
			if (!entry.isFile()) continue
			const path = join(folder, entry.name)
			const info = await lstat(path).catch(() => undefined)
			if (info === undefined || !info.isFile()) continue
			attachments.push({
				legacyId: `${card.legacyId}/${entry.name}`,
				cardLegacyId: card.legacyId,
				name: entry.name,
				path,
				bytes: info.size,
			})
		}
	}
	const folders = await readdir(resourcesRoot, { withFileTypes: true }).catch(() => [])
	for (const folder of folders) {
		if (!folder.isDirectory() || activeIds.has(folder.name)) continue
		const entries = await readdir(join(resourcesRoot, folder.name), { withFileTypes: true }).catch(() => [])
		for (const entry of entries) {
			if (entry.isFile()) orphans.push(`${folder.name}/${entry.name}`)
		}
	}

	return {
		cards,
		attachments,
		orphans,
		stats: {
			lines: lines.length,
			unique: last.size,
			duplicates,
			invalidLines,
			deleted,
			active: cards.filter((card) => !card.archived).length,
			archived: cards.filter((card) => card.archived).length,
		},
	}
}

/**
 * Read the legacy ids already present in a target library without opening it.
 *
 * @param {string} dataDir - The target data directory.
 * @returns {Promise<Map<string, {id: string, name: string}>>} Legacy id → file.
 */
async function scanExisting(dataDir) {
	const filesDir = join(dataDir, 'files')
	const entries = await readdir(filesDir, { withFileTypes: true }).catch(() => [])
	const found = new Map()
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const text = await readFile(join(filesDir, entry.name, 'meta.json'), 'utf8').catch(() => undefined)
		if (text === undefined) continue
		let meta
		try {
			meta = JSON.parse(text)
		} catch {
			continue
		}
		if (typeof meta?.legacyId === 'string' && meta.legacyId !== '' && typeof meta.id === 'string') {
			found.set(meta.legacyId, { id: meta.id, name: String(meta.name ?? '') })
		}
	}
	return found
}

/**
 * Read all files from an open store, including archived ones.
 *
 * @param {FileStore} store - The open store.
 * @returns {Promise<Array<object>>} Every file.
 */
async function listAll(store) {
	const all = []
	for (const archived of [false, true]) {
		let offset = 0
		while (true) {
			const page = await store.list({ limit: 500, offset, archived })
			all.push(...page.files)
			if (offset + page.files.length >= page.total || page.files.length === 0) break
			offset += page.files.length
		}
	}
	return all
}

/**
 * The description of a migrated attachment, from its reference line.
 *
 * @param {object} card - The old card.
 * @param {string} name - The attachment name.
 * @returns {string} The description.
 */
function attachmentDescription(card, name) {
	const marker = `knowledge/resources/${card.legacyId}/${name}`
	const at = card.body.indexOf(marker)
	if (at >= 0) {
		const start = card.body.lastIndexOf('\n', at) + 1
		const end = card.body.indexOf('\n', at)
		const line = card.body.slice(start, end >= 0 ? end : undefined)
		const cleaned = line.replace(/\[[^\]]+\]\([^)]*\)[：:]\s*/, '').trim()
		if (cleaned !== '') {
			const clipped = clipDescription(`${name}：${cleaned}`, 160)
			if (clipped !== '') return clipped
		}
	}
	const fallback = clipDescription(`附件 ${name}：${card.description}`, 160)
	return fallback === '' ? `附件：${name}` : fallback
}

/**
 * Rewrite the old resource paths in one card body to the new entity paths.
 *
 * @param {object} card - The old card.
 * @param {object[]} attachments - That card's attachments.
 * @param {Map<string, {id: string, name: string}>} attachmentMap - New entities.
 * @returns {{body: string, rewritten: number}} The new body and count.
 */
function rewriteBody(card, attachments, attachmentMap) {
	let body = card.body
	let rewritten = 0
	for (const attachment of attachments) {
		const next = attachmentMap.get(attachment.legacyId)
		if (next === undefined) continue
		const marker = `knowledge/resources/${card.legacyId}/${attachment.name}`
		if (!body.includes(marker)) continue
		body = body.split(marker).join(`files/${next.id}/${next.name}`)
		rewritten += 1
	}
	return { body, rewritten }
}

/**
 * Migrate one old library into one new data directory.
 *
 * @param {{from: string, to: string, apply?: boolean, logger?: object}} options - Paths and mode.
 * @returns {Promise<object>} Counts, warnings, `cardMap` and `attachmentMap`.
 */
export async function migrateEvolver({ from, to, apply = false, logger = console }) {
	const source = resolve(from)
	const target = resolve(to)
	if (source === target) throw new Error('源目录和目标目录不能相同。')
	if (target.startsWith(source + sep) || source.startsWith(target + sep)) {
		throw new Error('源目录和目标目录不能互相包含。')
	}
	const started = Date.now()
	const library = await readEvolverLibrary(source)
	const warnings = []
	if (library.stats.invalidLines > 0) warnings.push(`跳过 ${library.stats.invalidLines} 行无法解析的 JSONL`)
	if (library.stats.duplicates > 0) warnings.push(`旧追加日志有 ${library.stats.duplicates} 条历史覆盖记录（正常，按最后一条）`)
	for (const orphan of library.orphans) warnings.push(`孤立附件（没有对应卡片）：${orphan}`)

	let store
	try {
		if (apply) {
			store = new FileStore({ dataDir: target })
			await store.open()
		}
		const existing = apply
			? new Map((await listAll(store)).filter((file) => typeof file.legacyId === 'string').map((file) => [file.legacyId, { id: file.id, name: file.name }]))
			: await scanExisting(target)
		const cardMap = new Map()
		const attachmentMap = new Map()
		for (const [legacyId, file] of existing) {
			if (legacyId.includes('/')) attachmentMap.set(legacyId, file)
			else cardMap.set(legacyId, file.id)
		}

		let cardsCreated = 0
		let cardsSkipped = 0
		let cardsFailed = 0
		const createdNow = new Set()
		for (const card of library.cards) {
			if (cardMap.has(card.legacyId)) {
				cardsSkipped += 1
				continue
			}
			const description = card.description === '' ? (clipDescription(card.body, 160) || `迁移卡片 ${card.legacyId.slice(-5)}`) : card.description
			if (!apply) {
				cardMap.set(card.legacyId, `dry:${card.legacyId}`)
				createdNow.add(card.legacyId)
				cardsCreated += 1
				continue
			}
			try {
				const file = await store.create({
					name: `card-${card.legacyId.slice(-8)}.md`,
					description,
					content: card.body,
					tags: card.tags,
					links: [],
					source: card.source,
					legacyId: card.legacyId,
					created: card.updated,
					archived: card.archived,
				})
				cardMap.set(card.legacyId, file.id)
				createdNow.add(card.legacyId)
				cardsCreated += 1
			} catch (error) {
				cardsFailed += 1
				warnings.push(`卡片 ${card.legacyId} 迁移失败：${error instanceof Error ? error.message : String(error)}`)
			}
		}

		let attachmentsCreated = 0
		let attachmentsSkipped = 0
		const attachmentsByCard = new Map()
		for (const attachment of library.attachments) {
			attachmentsByCard.set(attachment.cardLegacyId, [...(attachmentsByCard.get(attachment.cardLegacyId) ?? []), attachment])
			if (attachmentMap.has(attachment.legacyId)) {
				attachmentsSkipped += 1
				continue
			}
			const cardId = cardMap.get(attachment.cardLegacyId)
			if (cardId === undefined) {
				attachmentsSkipped += 1
				warnings.push(`附件 ${attachment.legacyId} 所属卡片未迁移，已跳过`)
				continue
			}
			if (!apply) {
				attachmentMap.set(attachment.legacyId, { id: `dry:${attachment.legacyId}`, name: attachment.name })
				attachmentsCreated += 1
				continue
			}
			const owner = library.cards.find((card) => card.legacyId === attachment.cardLegacyId)
			try {
				const file = await store.create({
					sourcePath: attachment.path,
					name: attachment.name,
					description: attachmentDescription(owner, attachment.name),
					tags: [...owner.tags, '类型/附件'],
					links: [cardId],
					legacyId: attachment.legacyId,
				})
				attachmentMap.set(attachment.legacyId, { id: file.id, name: file.name })
				attachmentsCreated += 1
			} catch (error) {
				attachmentsSkipped += 1
				warnings.push(`附件 ${attachment.legacyId} 迁移失败：${error instanceof Error ? error.message : String(error)}`)
			}
		}

		const libraryIds = new Set(library.cards.map((card) => card.legacyId))
		let linksResolved = 0
		let linksDropped = 0
		let bodiesRewritten = 0
		let cardsUpdated = 0
		for (const card of library.cards) {
			const cardId = cardMap.get(card.legacyId)
			if (cardId === undefined) continue
			const resolved = []
			for (const target of card.links) {
				if (target === card.legacyId) {
					linksDropped += 1
					warnings.push(`卡片 ${card.legacyId} 含自链，已丢弃`)
					continue
				}
				const mapped = cardMap.get(target)
				if (mapped === undefined) {
					linksDropped += 1
					if (!libraryIds.has(target)) warnings.push(`卡片 ${card.legacyId} 链接目标不存在：${target}`)
					continue
				}
				resolved.push(mapped)
				linksResolved += 1
			}
			const cardAttachments = attachmentsByCard.get(card.legacyId) ?? []
			const attached = cardAttachments
				.map((attachment) => attachmentMap.get(attachment.legacyId)?.id)
				.filter((id) => typeof id === 'string')
			const nextLinks = [...new Set([...resolved, ...attached])]
			const created = createdNow.has(card.legacyId)
			// An existing card is only touched when this run added attachments
			// to it; otherwise a re-run leaves the earlier import untouched.
			if (!created && !cardAttachments.some((attachment) => !existing.has(attachment.legacyId))) continue
			let body = card.body
			if (created) {
				const rewrite = rewriteBody(card, attachmentsByCard.get(card.legacyId) ?? [], attachmentMap)
				body = rewrite.body
				bodiesRewritten += rewrite.rewritten
			}
			if (!apply) {
				if (nextLinks.length > 0 || body !== card.body) cardsUpdated += 1
				continue
			}
			try {
				const current = await store.read(cardId, { text: false, neighbors: false })
				const links = [...new Set([...(current?.links ?? []), ...nextLinks])]
				const patch = { links }
				if (created && body !== card.body) patch.content = body
				if ((current?.links ?? []).length === links.length && !patch.content) continue
				await store.update(cardId, patch)
				cardsUpdated += 1
			} catch (error) {
				warnings.push(`卡片 ${card.legacyId} 更新链接/正文失败：${error instanceof Error ? error.message : String(error)}`)
			}
		}

		if (apply) {
			try {
				await refreshIndex(store)
			} catch (error) {
				warnings.push(`迁移后刷新注入快照失败：${error instanceof Error ? error.message : String(error)}`)
			}
		}

		const summary = {
			mode: apply ? 'apply' : 'dry-run',
			from: source,
			to: target,
			source: library.stats,
			cards: { created: cardsCreated, skippedExisting: cardsSkipped, failed: cardsFailed },
			attachments: { created: attachmentsCreated, skippedExisting: attachmentsSkipped },
			links: { resolved: linksResolved, dropped: linksDropped },
			bodiesRewritten,
			cardsUpdated,
			orphans: library.orphans.length,
			warnings,
			elapsedMs: Date.now() - started,
			cardMap,
		}
		if (logger?.info) logger.info(`迁移完成：${cardsCreated} 卡 / ${attachmentsCreated} 附件 / ${warnings.length} 警告`)
		return summary
	} finally {
		store?.close()
	}
}
