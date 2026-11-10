/**
 * The memory operations behind the sight tools.
 *
 * The store is the one the panel used: one flat table of memories projected
 * into the views the panel showed. The evolver keeps the same file format, so
 * the data that already exists moves over without conversion.
 *
 * The evolver's memory surface is deliberately small — the agent writes what
 * it learned and recalls it on demand. Nothing is injected automatically, so
 * a stale or irrelevant memory never costs context.
 */

import { randomUUID } from 'node:crypto'

import { textSimilarity } from './importance.js'
import { ENTRY_KINDS, SCOPES } from './memory/kinds.js'
import { classifyNoise } from './memory/noise.js'
import { parseScope } from './memory/scopes.js'

/** Two memories this alike say the same thing; the newer one replaces the older. */
const MERGE_THRESHOLD = 0.85

/**
 * Create the memory operations for one store.
 *
 * @param {import('./memory/store.js').MemoryStore} store - The memory store.
 * @param {{now?: () => Date}} options - An injectable clock.
 * @returns {object} The operations.
 */
export function createMemoryActions(store, { now = () => new Date() } = {}) {
	const stamp = () => now().toISOString()

	/**
	 * The scope string a save request asks for.
	 *
	 * @param {string | undefined} scope - The requested scope.
	 * @param {string | undefined} projectKey - The project the entry belongs to.
	 * @returns {string} The scope string.
	 */
	function resolveScope(scope, projectKey) {
		if (typeof scope === 'string' && scope.includes(':')) return scope
		if (scope === 'failure') return 'failure'
		if (scope === 'project') return projectKey === undefined ? 'project' : `project:${projectKey}`
		if (scope === 'user') return 'user'
		return 'global'
	}

	/**
	 * Save one long-term memory.
	 *
	 * @param {object} request - The save request.
	 * @returns {Promise<object>} The result.
	 */
	async function save({ kind, content, scope, tags, projectKey, replaceOf, supersedes } = {}) {
		const text = String(content ?? '').trim()
		if (text === '') return { success: false, message: 'content 不能为空。' }
		const noise = classifyNoise(text)
		if (noise.noise) {
			return { success: false, message: `这条内容像噪声（${noise.category}），没有保存。` }
		}
		const timestamp = stamp()

		if (replaceOf !== undefined && replaceOf !== null && replaceOf !== '') {
			const existing = store.getEntry(replaceOf)
			if (existing === undefined) return { success: false, message: `找不到要替换的记忆：${replaceOf}` }
			const updated = { ...existing, text, content: text, updatedAt: timestamp }
			await store.putEntry(updated)
			return { success: true, id: updated.id, kind: updated.kind, scope: updated.scope, message: '已更新记忆。' }
		}

		const entryKind = ENTRY_KINDS.includes(kind) ? kind : 'fact'
		const entryScope = resolveScope(scope, projectKey)

		const twin = store.entries().find((entry) =>
			entry.kind === entryKind
			&& parseScope(entry.scope).kind === parseScope(entryScope).kind
			&& textSimilarity(entry.text, text) >= MERGE_THRESHOLD)
		if (twin !== undefined) {
			const merged = { ...twin, text, content: text, updatedAt: timestamp }
			await store.putEntry(merged)
			return {
				success: true,
				id: merged.id,
				kind: merged.kind,
				scope: merged.scope,
				merged: true,
				message: '已更新同一条记忆（内容几乎相同，未重复保存）。',
			}
		}

		const entry = {
			id: `mem-${randomUUID().slice(0, 8)}`,
			kind: entryKind,
			scope: entryScope,
			content: text,
			text,
			projectKey,
			tags: Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string').slice(0, 12) : [],
			source: 'explicit',
			importance: 0.6,
			confidence: 0.7,
			tier: 'working',
			pinned: false,
			createdAt: timestamp,
			updatedAt: timestamp,
		}
		await store.putEntry(entry)
		if (typeof supersedes === 'string' && supersedes !== '') {
			const target = store.getEntry(supersedes)
			if (target !== undefined) {
				await store.putEdge({
					id: `edge-${entry.id}-${supersedes}`,
					from: entry.id,
					to: supersedes,
					kind: 'supersedes',
				})
			}
		}
		return { success: true, id: entry.id, kind: entry.kind, scope: entry.scope, message: '已保存记忆。' }
	}

	/**
	 * Recall the memories that match one query.
	 *
	 * @param {object} request - The recall request.
	 * @returns {Promise<object>} The result.
	 */
	async function recall({ query, kinds, scopes, projectKey, limit } = {}) {
		const results = await store.retrieve({
			query: String(query ?? ''),
			limit: Math.min(Math.max(Number(limit ?? 8), 1), 40),
			scope: { cwd: projectKey },
		})
		const filtered = results.filter((result) => {
			const memory = result.memory
			if (Array.isArray(kinds) && kinds.length > 0 && !kinds.includes(memory.kind)) return false
			if (Array.isArray(scopes) && scopes.length > 0) {
				const kind = parseScope(memory.scope).kind
				if (!scopes.includes(kind) && !scopes.includes(memory.scope)) return false
			}
			return true
		})
		const superseded = store.supersededIds()
		return {
			success: true,
			total: filtered.length,
			results: filtered.map((result) => ({
				id: result.id,
				kind: result.memory.kind,
				text: result.memory.text,
				score: result.score,
				tier: result.memory.tier,
				scope: result.memory.scope,
				superseded: superseded.has(result.id) ? true : undefined,
			})),
		}
	}

	/**
	 * Delete one memory.
	 *
	 * @param {object} request - The delete request.
	 * @returns {Promise<object>} The result.
	 */
	async function forget({ id } = {}) {
		if (!id) return { success: false, message: '缺少 id。' }
		const removed = await store.deleteRecord(id)
		return removed
			? { success: true, id, message: '已删除。' }
			: { success: false, id, message: '找不到这条记忆。' }
	}

	/**
	 * List the stored memories.
	 *
	 * @param {object} request - The list request.
	 * @returns {object} The result.
	 */
	function list({ kind, scope, limit } = {}) {
		const all = store.entries()
			.filter((entry) => (kind === undefined || entry.kind === kind))
			.filter((entry) => (scope === undefined || parseScope(entry.scope).kind === scope || entry.scope === scope))
			.sort((left, right) => (right.importance ?? 0) - (left.importance ?? 0) || String(right.updatedAt).localeCompare(String(left.updatedAt)))
			.slice(0, Math.min(Math.max(Number(limit ?? 20), 1), 200))
		return { success: true, total: all.length, results: all }
	}

	/**
	 * The memory store's counters.
	 *
	 * @returns {object} The counters.
	 */
	function stats() {
		const entries = store.entries()
		const byKind = {}
		for (const entry of entries) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
		const byScope = {}
		for (const entry of entries) {
			const kind = parseScope(entry.scope).kind
			byScope[kind] = (byScope[kind] ?? 0) + 1
		}
		return {
			success: true,
			entries: entries.length,
			entriesByKind: byKind,
			entriesByScope: byScope,
		}
	}

	return { save, recall, forget, list, stats }
}

export { ENTRY_KINDS, SCOPES }
