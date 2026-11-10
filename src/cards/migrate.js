/**
 * One-way migration from the two old stores into the card store.
 *
 * Practice entries become permanent cards; their long body or script moves
 * into a resource and the card keeps a one-line summary. Memories become
 * fleeting memo cards. The old folders are never modified, so a failed or
 * partial migration can be retried and the old data still works.
 *
 * `sourceId` makes the migration idempotent: a practice path or memory id is
 * converted once even if the process dies halfway.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readPracticeEntry, scanPractice } from '../practice.js'
import { cardId } from './ids.js'
import { labelOf, CARD_CATEGORIES, charCount } from './store.js'
import { normalizeTag, normalizeTags } from './tags.js'
import { safeResourceName } from './resources.js'

/** Where the migration marker lives. */
const MARKER = 'migration.json'

/**
 * Read the old memory log, last write wins.
 *
 * @param {string} dataDir - The data folder.
 * @returns {Promise<object[]>} The live memory records.
 */
async function readOldMemories(dataDir) {
	const path = join(dataDir, 'sight', 'memory', 'memories.jsonl')
	const raw = await readFile(path, 'utf8').catch(() => null)
	if (raw === null) return []
	const records = new Map()
	for (const line of raw.split('\n')) {
		const trimmed = line.trim()
		if (trimmed === '') continue
		try {
			const record = JSON.parse(trimmed)
			if (record === null || typeof record !== 'object' || typeof record.id !== 'string') continue
			if (record.deleted === true) records.delete(record.id)
			else records.set(record.id, record)
		} catch {
			// A broken line is skipped; the rest still migrates.
		}
	}
	return [...records.values()]
}

/**
 * Migrate the old practice and memory stores into cards.
 *
 * @param {{dataDir: string, store: object, logger?: object, now?: () => number}} options - The migration context.
 * @returns {Promise<object>} What was migrated.
 */
export async function migrateToCards({ dataDir, store, logger, now = () => Date.now() }) {
	const markerPath = join(dataDir, 'knowledge', MARKER)
	const marker = await readFile(markerPath, 'utf8').catch(() => null)
	if (marker !== null) return { skipped: true, practice: 0, memory: 0 }
	await mkdir(join(dataDir, 'knowledge'), { recursive: true, mode: 0o700 })

	const existing = new Map()
	for (const card of store.all()) {
		if (typeof card.sourceId === 'string' && card.sourceId !== '') existing.set(card.sourceId, card)
	}

	const practiceRoot = join(dataDir, 'practice')
	const scan = await scanPractice(practiceRoot).catch(() => ({ entries: [], problems: [] }))
	const stamp = now()
	const ids = new Map()
	const aliases = new Map()
	let practiceCount = 0
	for (const [index, meta] of scan.entries.entries()) {
		const sourceId = `practice:${meta.relPath}`
		const known = existing.get(sourceId)
		const id = known?.id ?? cardId(stamp + index)
		ids.set(meta.relPath, id)
		if (known === undefined) {
			for (const alias of [meta.slug, meta.relPath, meta.relPath.replace(/\.[^.]+$/, ''), meta.name, meta.name.replace(/\.[^.]+$/, '')]) {
				if (typeof alias === 'string' && alias !== '') aliases.set(alias, id)
			}
		}
	}

	for (const meta of scan.entries) {
		const sourceId = `practice:${meta.relPath}`
		if (existing.has(sourceId)) continue
		let entry
		try {
			entry = await readPracticeEntry(practiceRoot, meta.relPath)
		} catch (error) {
			logger?.warn?.(`dsh-evolver: 迁移实践条目失败 ${meta.relPath}: ${error instanceof Error ? error.message : String(error)}`)
			continue
		}
		const shape = ['doc', 'tool', 'resource'].includes(meta.kind) ? meta.kind : 'doc'
		const content = String(entry.content ?? '')
		const summary = String(meta.purpose || entry.title || labelOf(content)).slice(0, 200)
		const resourceName = safeResourceName(meta.name) || safeResourceName(`${meta.slug}.md`) || 'body.md'
		const card = {
			id: ids.get(meta.relPath),
			type: 'permanent',
			shape,
			status: 'verified',
			category: '',
			label: String(meta.title || entry.title || labelOf(content)).slice(0, 80),
			summary,
			// The card body is the one-line purpose; the full text is the resource.
			body: summary,
			topic: normalizeTag(meta.topic),
			tags: normalizeTags([meta.topic, ...(meta.tags ?? [])]),
			links: [],
			scope: 'global',
			source: 'migration:practice',
			sourceId,
			created: meta.updatedAt || new Date(stamp).toISOString(),
			verified: meta.verified || String(meta.updatedAt || '').slice(0, 10),
		}
		try {
			await store.put(card, { resourceInputs: content === '' ? [] : [{ name: resourceName, data: content }] })
			practiceCount += 1
			existing.set(sourceId, { id: card.id, links: [] })
		} catch (error) {
			logger?.warn?.(`dsh-evolver: 迁移实践条目失败 ${meta.relPath}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	// Second pass: resolve old slug links to new card ids.
	for (const meta of scan.entries) {
		if (!Array.isArray(meta.links) || meta.links.length === 0) continue
		const id = ids.get(meta.relPath)
		const card = store.get(id)
		if (card === undefined) continue
		const links = []
		for (const link of meta.links) {
			const target = aliases.get(String(link).replace(/\.md$/, '')) ?? aliases.get(String(link))
			if (target !== undefined && target !== id) links.push(target)
		}
		if (links.length === 0) continue
		try {
			await store.put({ ...card, id, links: [...new Set(links)] })
		} catch (error) {
			logger?.warn?.(`dsh-evolver: 迁移链接失败 ${meta.relPath}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	let memoryCount = 0
	const oldMemories = await readOldMemories(dataDir)
	for (const [index, record] of oldMemories.entries()) {
		const sourceId = `memory:${record.id}`
		if (existing.has(sourceId)) continue
		const text = String(record.text ?? record.content ?? '')
		const category = CARD_CATEGORIES.includes(record.kind) ? record.kind : 'fact'
		const card = {
			id: cardId(stamp + scan.entries.length + index),
			type: 'fleeting',
			shape: 'memo',
			status: 'inbox',
			category,
			label: labelOf(text),
			summary: '',
			body: text,
			tags: normalizeTags(record.tags ?? []),
			links: [],
			scope: typeof record.scope === 'string' ? record.scope : 'global',
			source: 'migration:memory',
			sourceId,
			created: record.createdAt ?? new Date(stamp).toISOString(),
			importance: Number.isFinite(Number(record.importance)) ? Number(record.importance) : 0.5,
			tier: typeof record.tier === 'string' ? record.tier : 'working',
			overCap: charCount(text) > store.cardMaxChars,
		}
		try {
			await store.put(card)
			memoryCount += 1
		} catch (error) {
			logger?.warn?.(`dsh-evolver: 迁移记忆失败 ${record.id}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	const result = { skipped: false, practice: practiceCount, memory: memoryCount }
	const temp = `${markerPath}.${process.pid}.tmp`
	await writeFile(temp, `${JSON.stringify({ version: 1, at: new Date(stamp).toISOString(), ...result }, null, 2)}\n`, { mode: 0o600 })
	await rename(temp, markerPath)
	logger?.info?.(`dsh-evolver: 已迁移 ${practiceCount} 条实践、${memoryCount} 条记忆到卡片库`)
	return result
}
