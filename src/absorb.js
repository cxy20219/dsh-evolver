/**
 * Absorb another evolver's export into this library.
 *
 * Importing an archive restores a folder: it is the right tool for a new
 * machine and the wrong one here, because it can replace what the current
 * library already has. This is the additive counterpart: read the cards out of
 * the archive and merge them into the live store, never overwriting a card
 * that already exists.
 *
 * The rules are deliberately conservative:
 *
 *   - same id → keep the local card, count it as existing;
 *   - same normalised body under a different id → skip, count it as duplicate;
 *   - everything else → add, with its tags coerced to the six branches, its
 *     links re-pointed after all cards exist, and its attachments copied;
 *   - preferences, session cursors and review/access ledgers are device state,
 *     not knowledge: they are never merged.
 *
 * An absorb writes an audit line to `knowledge/absorb.jsonl` and refreshes the
 * injected index snapshot, so the library the panel and the prompt see matches
 * the merge immediately.
 */

import { appendFile, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { extractArchiveFile } from './backup/archive.js'
import { isCardId } from './cards/ids.js'
import { refreshCardIndex } from './cards/injection-index.js'
import { CardStore, clipDescription } from './cards/store.js'
import { coerceCardTags, MAX_TAGS, normalizeTag, rootOf, sanitizeTagDescription, TOP_TAGS } from './cards/tags.js'
import { findSecret } from './secrets.js'

/** How many per-card problems the summary carries for the panel. */
const MAX_PROBLEMS = 20

/**
 * The comparison form of a body: whitespace collapsed.
 *
 * Two exports of the same note may differ only by trailing spaces or CRLF;
 * those are the same knowledge and must not become two cards.
 *
 * @param {unknown} body - The card body.
 * @returns {string} The comparable text.
 */
function comparableBody(body) {
	return String(body ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The ids this device has deleted on purpose.
 *
 * A card deleted here still exists in an archive taken on another device
 * before the deletion. Absorbing it would resurrect a note the person already
 * decided to remove, so the tombstone wins: the merge only ever adds what this
 * library has never seen.
 *
 * @param {object} store - The live store.
 * @returns {Promise<Set<string>>} Deleted ids.
 */
async function locallyDeleted(store) {
	const path = join(store.dataDir, 'knowledge', 'cards', 'cards.jsonl')
	const text = await readFile(path, 'utf8').catch(() => '')
	const deleted = new Set()
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue
		let record
		try {
			record = JSON.parse(line)
		} catch {
			continue
		}
		if (record?.deleted === true && typeof record.id === 'string') deleted.add(record.id)
	}
	return deleted
}

/**
 * A description that fits this library's rules.
 *
 * @param {unknown} description - The incoming description.
 * @param {string} body - The incoming body.
 * @param {object} store - The destination store.
 * @returns {string} The description, possibly generated from the body.
 */
function absorbableDescription(description, body, store) {
	const raw = typeof description === 'string' ? description.trim() : ''
	if (raw !== '' && findSecret(raw) === undefined) return clipDescription(raw, store.descriptionMaxChars)
	return clipDescription(body, store.descriptionMaxChars)
}

/**
 * Copy one card's attachments from the extracted archive into the live store.
 *
 * Only called for cards that do not exist locally, so the destination folder is
 * either absent or an orphan; an orphan is treated as "this id is taken" before
 * this point, not here.
 *
 * @param {object} source - The store opened on the extracted archive.
 * @param {object} target - The live store.
 * @param {string} id - The card id.
 * @param {object[]} problems - Where to record unusable files.
 * @returns {Promise<number>} How many files were copied.
 */
async function copyAttachments(source, target, id, problems) {
	const listed = await source.resources.list(id).catch(() => [])
	let copied = 0
	for (const item of listed) {
		try {
			const path = join(source.resources.folderOf(id), item.name)
			const info = await lstat(path)
			if (!info.isFile() || info.isSymbolicLink()) continue
			const data = await readFile(path)
			await target.resources.put(id, item.name, data)
			copied += 1
		} catch (error) {
			// A broken attachment must not cost the card: the body usually still
			// carries the knowledge, and the problem list says what was missing.
			if (problems.length < MAX_PROBLEMS) {
				problems.push({ id, reason: `附件 ${item.name} 没有复制：${error instanceof Error ? error.message : String(error)}` })
			}
		}
	}
	return copied
}

/**
 * Merge the archive's custom branch descriptions into the local ones.
 *
 * Local text always wins: the person absorbing may have described their own
 * branches, and an older export must not overwrite that.
 *
 * @param {string} tempRoot - The extracted archive.
 * @param {object} target - The live store.
 * @param {object[]} problems - Where to record refused descriptions.
 * @returns {Promise<number>} How many branch descriptions were added.
 */
async function mergeDescriptions(tempRoot, target, problems) {
	let incoming = {}
	try {
		const parsed = JSON.parse(await readFile(join(tempRoot, 'knowledge', 'tags.json'), 'utf8'))
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) incoming = parsed
	} catch {
		return 0
	}
	let current = {}
	try {
		const parsed = JSON.parse(await readFile(target.tagDescriptionsPath(), 'utf8'))
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed
	} catch {
		current = {}
	}
	const merged = { ...current }
	let added = 0
	for (const [rawPath, value] of Object.entries(incoming)) {
		if (typeof value !== 'string') continue
		const path = normalizeTag(rawPath)
		if (path === '' || !TOP_TAGS.includes(rootOf(path))) continue
		if (path.split('/').filter((part) => part !== '').length > 3) continue
		if (merged[path] !== undefined) continue
		const clean = sanitizeTagDescription(value)
		if (clean === '' || findSecret(clean) !== undefined) continue
		merged[path] = clean
		added += 1
	}
	if (added === 0) return 0
	try {
		await target.saveTagDescriptions(merged)
		return added
	} catch (error) {
		if (problems.length < MAX_PROBLEMS) {
			problems.push({ id: '(tags)', reason: `枝干说明没有合并：${error instanceof Error ? error.message : String(error)}` })
		}
		return 0
	}
}

/**
 * Append one audit line for the absorb.
 *
 * @param {object} target - The live store.
 * @param {object} summary - The result.
 * @param {string} at - ISO timestamp.
 * @returns {Promise<void>} Resolves when written, best effort.
 */
async function appendAudit(target, summary, at) {
	const path = join(target.dataDir, 'knowledge', 'absorb.jsonl')
	await mkdir(join(target.dataDir, 'knowledge'), { recursive: true, mode: 0o700 })
	const line = JSON.stringify({
		at,
		archive: basename(String(summary.archive ?? '')),
		incoming: summary.incoming,
		added: summary.added,
		duplicate: summary.duplicate,
		existing: summary.existing,
		skipped: summary.skipped,
		files: summary.files,
		branches: summary.branches,
	})
	await appendFile(path, `${line}\n`, { mode: 0o600 })
}

/**
 * Absorb one exported archive into the live card store.
 *
 * @param {object} store - The live card store.
 * @param {string} archivePath - A `.tar.gz`, `.tgz` or `.tar` exported by this plugin.
 * @param {{logger?: object, now?: () => number}} [options] - Logging and clock.
 * @returns {Promise<object>} The merge summary.
 */
export async function absorbArchive(store, archivePath, { logger, now = () => Date.now() } = {}) {
	if (store === undefined || store === null || typeof store.put !== 'function') {
		throw new Error('卡片库还没有打开。')
	}
	const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-evolver-absorb-'))
	const source = new CardStore({ dataDir: tempRoot, logger })
	const summary = {
		archive: archivePath,
		incoming: 0,
		added: 0,
		duplicate: 0,
		existing: 0,
		skipped: 0,
		files: 0,
		branches: 0,
		problems: [],
	}
	const problem = (id, reason) => {
		if (summary.problems.length < MAX_PROBLEMS) summary.problems.push({ id, reason })
	}
	try {
		await extractArchiveFile(archivePath, tempRoot)
		await source.init()
		const records = source.records()
		if (records.length === 0) {
			throw new Error('压缩包里没有卡片（knowledge/cards/cards.jsonl 为空或不存在）。')
		}

		const localIds = new Set(store.records().map((record) => record.id))
		const localBodies = new Set(store.records().map((record) => comparableBody(record.body)))
		const tombstones = await locallyDeleted(store)
		const additions = []
		for (const record of records) {
			summary.incoming += 1
			const id = typeof record.id === 'string' ? record.id : ''
			const body = typeof record.body === 'string' ? record.body.trim() : ''
			if (!isCardId(id)) {
				summary.skipped += 1
				problem(id === '' ? '(缺少 id)' : id, '卡片 id 不合法')
				continue
			}
			if (body === '') {
				summary.skipped += 1
				problem(id, '正文为空')
				continue
			}
			if ([...body].length > store.cardMaxChars) {
				summary.skipped += 1
				problem(id, `正文超过 ${store.cardMaxChars} 字上限`)
				continue
			}
			const secret = findSecret(body)
			if (secret !== undefined) {
				summary.skipped += 1
				problem(id, `正文里像是有${secret}`)
				continue
			}
			if (tombstones.has(id)) {
				// Deleted here on purpose; an older archive must not undo that.
				summary.existing += 1
				problem(id, '本地已删除，未恢复')
				continue
			}
			if (localIds.has(id) || (await store.resources.list(id)).length > 0) {
				// The same card, or at least the same id: the local copy stays.
				summary.existing += 1
				continue
			}
			const comparable = comparableBody(body)
			if (localBodies.has(comparable)) {
				summary.duplicate += 1
				continue
			}
			additions.push({ record, id, body })
			localIds.add(id)
			localBodies.add(comparable)
		}

		const addedIds = []
		for (const item of additions) {
			try {
				summary.files += await copyAttachments(source, store, item.id, summary.problems)
				const description = absorbableDescription(item.record.description, item.body, store)
				const tags = coerceCardTags(item.record.tags, {
					limit: MAX_TAGS,
					onDegrade: (from, to) => problem(item.id, `标签 #${from} 降级为 #${to}`),
				})
				await store.put({
					id: item.id,
					body: item.body,
					...(description === '' ? {} : { description }),
					tags,
					links: [],
					...(item.record.source !== null && typeof item.record.source === 'object' ? { source: item.record.source } : {}),
				}, { tagsLimit: MAX_TAGS + 2 })
				addedIds.push(item.id)
				summary.added += 1
			} catch (error) {
				// Roll the attachment folder back so the next attempt sees a clean
				// id rather than an orphan that would block it for ever.
				await store.resources.removeCard(item.id).catch(() => {})
				summary.skipped += 1
				problem(item.id, error instanceof Error ? error.message : String(error))
			}
		}

		// Links second: an incoming card may point at another incoming card,
		// which did not exist when the first one was written.
		if (addedIds.length > 0) {
			const live = new Set(store.records().map((record) => record.id))
			const byId = new Map(additions.map((item) => [item.id, item.record]))
			for (const id of addedIds) {
				const record = byId.get(id)
				const links = Array.isArray(record.links)
					? [...new Set(record.links.map(String))].filter((link) => link !== id && live.has(link))
					: []
				if (links.length === 0) continue
				try {
					await store.put({ id, links })
				} catch (error) {
					problem(id, `链接没有写回：${error instanceof Error ? error.message : String(error)}`)
				}
			}
		}

		summary.branches = await mergeDescriptions(tempRoot, store, summary.problems)
		await appendAudit(store, summary, new Date(now()).toISOString()).catch((error) => {
			logger?.warn?.(`dsh-evolver: absorb audit not written: ${error instanceof Error ? error.message : String(error)}`)
		})
		// The injected index is a daily snapshot; a bulk merge changes it by
		// more than a normal write, so rebase it now instead of leaving the
		// prompt with the pre-absorb picture until the next daily run.
		await refreshCardIndex(store).catch((error) => {
			logger?.warn?.(`dsh-evolver: index snapshot not refreshed after absorb: ${error instanceof Error ? error.message : String(error)}`)
		})
		logger?.info?.(
			`dsh-evolver: absorbed ${summary.archive} — incoming=${summary.incoming} added=${summary.added}`
				+ ` duplicate=${summary.duplicate} existing=${summary.existing} skipped=${summary.skipped} files=${summary.files}`,
		)
		return summary
	} finally {
		await source.close().catch(() => {})
		await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
	}
}
