import { randomUUID } from 'node:crypto'
import { createEmbedder } from './embed.js'
import { MemoryDatabase } from './db.js'
import { hybridRetrieve } from './hybrid.js'
import { suggestedTier } from './lifecycle.js'
import { parseScope, scopeVisible } from './scopes.js'

/**
 * The memory store the rest of the plugin talks to.
 *
 * It presents one flat table of memories — the shape the reference
 * implementation uses — and keeps the distinctions the rest of the plugin
 * still needs:
 *
 *   - `kind`      our own taxonomy (fact, preference, constraint, …)
 *   - `category`  theirs (fact, preference, decision, entity, other)
 *   - `scope`     their scope grammar (global, user:<id>, project:<id>, …)
 *   - `tier`      their lifecycle tiers (core, working, peripheral)
 *
 * The old five-table layout (entries / nodes / edges / spans / standing) is
 * projected from that one table, so the tools and the panel keep working
 * while the storage underneath is the new one.
 */

/** The kinds that are long-term entries. */
export const ENTRY_KINDS = ['fact', 'preference', 'convention', 'correction', 'failure', 'tool-quirk']

/** The kinds that are skeleton nodes. */
export const NODE_KINDS = ['constraint', 'decision', 'artifact', 'progress']

/** The category each of our kinds maps onto. */
const CATEGORY_OF = {
	fact: 'fact',
	preference: 'preference',
	convention: 'other',
	correction: 'other',
	failure: 'other',
	'tool-quirk': 'other',
	constraint: 'other',
	decision: 'decision',
	artifact: 'other',
	progress: 'other',
	standing: 'instruction',
}

/**
 * The memory store.
 */
export class MemoryStore {
	/**
	 * @param {{dataDir: string, embedding?: object, logger?: object}} deps - Store dependencies.
	 */
	constructor({ dataDir, embedding, logger }) {
		this.dataDir = dataDir
		this.logger = logger
		this.embedder = embedding === undefined ? createEmbedder({ provider: 'local' }) : embedding
		this.db = new MemoryDatabase({ dataDir, embedder: this.embedder, logger })
	}

	/**
	 * Open the store.
	 *
	 * @returns {Promise<void>} Resolves once the store is ready.
	 */
	async init() {
		await this.db.init()
		await this.reembedIfNeeded()
	}

	/**
	 * Re-embed every memory when the embedding backend changed.
	 *
	 * Vectors from two different backends live in different spaces: a model
	 * vector cannot be compared with a hashing vector. Re-embedding is cheap
	 * (a few milliseconds per memory), so the store simply does it.
	 *
	 * @returns {Promise<void>} Resolves once the vectors are consistent.
	 */
	async reembedIfNeeded() {
		if (this.embedder === undefined || this.embedder.id === 'none') return
		const backend = this.db.vectorBackend
		const model = this.db.vectorModel
		const sameBackend = backend === this.embedder.id
		// A backend without a model name (the hashing one) has nothing to
		// compare; a named backend has to match exactly, or the stored
		// vectors belong to another model and cannot be compared with it.
		const sameModel = this.embedder.modelName === undefined
			? true
			: model === this.embedder.modelName
		if (sameBackend && sameModel) return
		this.logger?.info?.(`dsh-panel: embedding changed (${backend ?? 'none'}/${model ?? 'none'} → ${this.embedder.id}/${this.embedder.modelName}), re-embedding ${this.db.memories.size} memories`)
		for (const memory of this.db.all()) {
			await this.db.embedMemory(memory)
		}
		await this.db.flush()
	}

	/** ISO timestamp for now. */
	stamp() {
		return new Date().toISOString()
	}

	//#region records

	/**
	 * Every memory.
	 *
	 * @returns {object[]} The memories.
	 */
	all() {
		return this.db.all()
	}

	/**
	 * The long-term entries.
	 *
	 * @returns {object[]} The entries.
	 */
	entries() {
		return this.db.all().filter(memory => ENTRY_KINDS.includes(memory.kind))
	}

	/**
	 * The skeleton nodes.
	 *
	 * @returns {object[]} The nodes.
	 */
	nodes() {
		return this.db.all().filter(memory => NODE_KINDS.includes(memory.kind))
	}

	/**
	 * The standing content: always injected.
	 *
	 * @returns {object[]} The standing entries.
	 */
	standing() {
		return this.db.all().filter(memory => memory.kind === 'standing')
	}

	/**
	 * The edges between memories.
	 *
	 * @returns {object[]} The edges.
	 */
	edges() {
		return this.db.allEdges()
	}

	/**
	 * The archived conversation spans.
	 *
	 * @returns {object[]} The spans.
	 */
	spans() {
		return this.db.allReflections()
			.filter(reflection => reflection.kind === 'event')
			.map(reflection => ({
				id: reflection.id,
				sessionId: reflection.sessionId ?? '',
				projectKey: reflection.projectKey,
				title: reflection.title ?? '',
				text: reflection.text ?? '',
				keywords: reflection.keywords ?? [],
				alpha: reflection.alpha ?? 1,
				beta: reflection.beta ?? 0,
				createdAt: reflection.createdAt,
			}))
	}

	/**
	 * The memories a session may be injected.
	 *
	 * @param {{cwd?: string, includeUser?: boolean, projectEnabled?: boolean, agentId?: string}} options - Scope filter.
	 * @returns {object[]} The injectable memories.
	 */
	injectableEntries({ cwd, includeUser = true, projectEnabled = true, agentId } = {}) {
		return this.db.all()
			.filter(memory => {
				if (memory.kind === 'standing') return false
				if (!ENTRY_KINDS.includes(memory.kind) && !NODE_KINDS.includes(memory.kind)) return false
				if (memory.supersededBy !== undefined && memory.supersededBy !== '') return false
				const scope = parseScope(memory.scope)
				if (scope.kind === 'failure') return false
				if (scope.kind === 'user' && !includeUser) return false
				if (scope.kind === 'project' && !projectEnabled) return false
				return scopeVisible(memory.scope, { cwd, agentId })
			})
			.sort((left, right) => {
				const scopeOrder = { standing: 0, constraint: 1, decision: 2, project: 3, user: 4, global: 5 }
				const leftOrder = scopeOrder[left.kind] ?? 6
				const rightOrder = scopeOrder[right.kind] ?? 6
				return leftOrder - rightOrder
					|| (right.importance ?? 0) - (left.importance ?? 0)
					|| String(right.updatedAt).localeCompare(String(left.updatedAt))
					|| String(left.id).localeCompare(String(right.id))
			})
	}

	/**
	 * The skeleton nodes a session may be injected.
	 *
	 * @param {{cwd?: string, agentId?: string}} options - Scope filter.
	 * @returns {object[]} The nodes.
	 */
	injectableNodes({ cwd, agentId } = {}) {
		return this.db.all()
			.filter(memory => NODE_KINDS.includes(memory.kind))
			.filter(memory => memory.supersededBy === undefined || memory.supersededBy === '')
			.filter(memory => scopeVisible(memory.scope, { cwd, agentId }))
			.sort((left, right) => (right.seq ?? 0) - (left.seq ?? 0))
	}

	/**
	 * The ids of memories that a newer memory has superseded.
	 *
	 * @returns {Set<string>} The superseded ids.
	 */
	supersededIds() {
		const ids = new Set()
		for (const edge of this.db.allEdges()) {
			if (edge.kind === 'supersedes' && typeof edge.to === 'string') ids.add(edge.to)
		}
		return ids
	}

	//#endregion

	//#region writes

	/**
	 * Store a memory and its embedding.
	 *
	 * @param {object} memory - The memory record.
	 * @returns {Promise<object>} The stored memory.
	 */
	async putMemory(memory) {
		await this.db.put(memory)
		await this.db.embedMemory(memory)
		return memory
	}

	/**
	 * Store a long-term entry, building the record from its parts.
	 *
	 * @param {object} input - The entry fields.
	 * @returns {Promise<object>} The stored memory.
	 */
	async putEntry(input) {
		const timestamp = this.stamp()
		const text = String(input.content ?? input.text ?? '')
		const memory = {
			id: input.id ?? `mem-${randomUUID().slice(0, 8)}`,
			kind: input.kind ?? 'fact',
			category: input.category ?? CATEGORY_OF[input.kind ?? 'fact'] ?? 'other',
			scope: input.scope ?? 'global',
			text,
			// `content` is the alias the rest of the plugin has always read.
			content: text,
			l0Abstract: input.l0Abstract ?? firstSentence(text),
			l1Overview: input.l1Overview ?? '',
			tags: input.tags ?? [],
			importance: Number.isFinite(Number(input.importance)) ? Number(input.importance) : 0.6,
			confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0.7,
			tier: input.tier ?? 'working',
			accessCount: Number(input.accessCount ?? 0),
			lastAccessedAt: input.lastAccessedAt,
			pinned: input.pinned === true,
			seq: input.seq,
			source: input.source ?? 'explicit',
			supersededBy: input.supersededBy,
			createdAt: input.createdAt ?? timestamp,
			updatedAt: input.updatedAt ?? timestamp,
			metadata: input.metadata ?? {},
		}
		return this.putMemory(memory)
	}

	/**
	 * Store a skeleton node.
	 *
	 * @param {object} node - The node fields.
	 * @returns {Promise<object>} The stored memory.
	 */
	async putNode(node) {
		return this.putEntry({ ...node, kind: node.kind, text: node.text, category: CATEGORY_OF[node.kind] ?? 'other' })
	}

	/**
	 * Store an archived span as an event reflection.
	 *
	 * @param {object} span - The span fields.
	 * @returns {Promise<object>} The stored reflection.
	 */
	async putSpan(span) {
		const reflection = {
			id: span.id ?? `span-${randomUUID().slice(0, 8)}`,
			kind: 'event',
			text: span.text ?? '',
			title: span.title ?? '',
			sessionId: span.sessionId ?? '',
			projectKey: span.projectKey,
			keywords: span.keywords ?? [],
			alpha: span.alpha ?? 1,
			beta: span.beta ?? 0,
			weight: 0.55,
			createdAt: span.createdAt ?? this.stamp(),
		}
		return this.db.putReflection(reflection)
	}

	/**
	 * Store a standing instruction.
	 *
	 * @param {object} item - The standing fields.
	 * @returns {Promise<object>} The stored memory.
	 */
	async putStanding(item) {
		return this.putEntry({
			...item,
			kind: 'standing',
			category: 'instruction',
			scope: 'global',
			importance: 1,
			pinned: true,
			tier: 'core',
		})
	}

	/**
	 * Store an edge.
	 *
	 * @param {object} edge - The edge fields.
	 * @returns {Promise<object>} The stored edge.
	 */
	async putEdge(edge) {
		return this.db.putEdge(edge)
	}

	/**
	 * Remove a memory.
	 *
	 * @param {string} id - Memory id.
	 * @returns {Promise<boolean>} Whether a memory was removed.
	 */
	async deleteMemory(id) {
		return this.db.remove(id)
	}

	/**
	 * Remove a memory, an edge or a standing entry.
	 *
	 * @param {string} id - The id.
	 * @returns {Promise<boolean>} Whether something was removed.
	 */
	async deleteRecord(id) {
		if (this.db.memories.has(id)) return this.db.remove(id)
		if (this.db.reflections.has(id)) {
			this.db.reflections.delete(id)
			this.db.scheduleFlush()
			return true
		}
		if (this.db.edges.has(id)) return this.db.removeEdge(id)
		return false
	}

	/**
	 * One memory by id.
	 *
	 * @param {string} id - Memory id.
	 * @returns {object | undefined} The memory.
	 */
	getEntry(id) {
		return this.db.get(id)
	}

	/**
	 * Mark a memory as recalled: it counts, and it keeps its freshness longer.
	 *
	 * @param {string} id - Memory id.
	 * @returns {Promise<object | undefined>} The updated memory.
	 */
	async touchEntry(id) {
		const memory = this.db.get(id)
		if (memory === undefined) return undefined
		const updated = {
			...memory,
			accessCount: (memory.accessCount ?? 0) + 1,
			lastAccessedAt: this.stamp(),
		}
		await this.db.put(updated)
		return updated
	}

	/**
	 * Move a memory to the tier its usage suggests.
	 *
	 * @param {string} id - Memory id.
	 * @returns {Promise<object | undefined>} The updated memory.
	 */
	async retier(id) {
		const memory = this.db.get(id)
		if (memory === undefined) return undefined
		const tier = suggestedTier(memory)
		if (tier === memory.tier) return memory
		const updated = { ...memory, tier, updatedAt: this.stamp() }
		await this.db.put(updated)
		return updated
	}

	/**
	 * The next sequence number for the skeleton nodes of a scope.
	 *
	 * @param {string} projectKey - The scope.
	 * @returns {number} The next sequence number.
	 */
	nextNodeSeq(projectKey) {
		return this.db.all()
			.filter(memory => NODE_KINDS.includes(memory.kind) && (memory.projectKey ?? undefined) === projectKey)
			.reduce((max, memory) => Math.max(max, memory.seq ?? 0), 0) + 1
	}

	/**
	 * Run the hybrid retrieval pipeline.
	 *
	 * @param {{query: string, limit?: number, scope?: object, minScore?: number, rerank?: Function}} options - Query options.
	 * @returns {Promise<Array<{id: string, score: number, memory: object}>>} The results.
	 */
	async retrieve({ query, limit = 8, scope = {}, minScore, rerank } = {}) {
		let queryVector
		if (this.embedder.id !== 'none') {
			try {
				const embed = this.embedder.embedQuery ?? this.embedder.embed
				queryVector = await embed.call(this.embedder, String(query ?? ''))
			} catch {
				queryVector = undefined
			}
		}
		const results = await hybridRetrieve({
			db: this.db,
			query: String(query ?? ''),
			queryVector,
			limit,
			minScore,
			floor: this.embedder.relevanceFloor,
			rerank,
		})
		const visible = results.filter(result => scopeVisible(result.memory.scope, scope))
		return visible
	}

	/** Write the store out. */
	async flush() {
		await this.db.flush()
	}
}

/**
 * The first sentence of a text, used as its abstract.
 *
 * @param {string} text - The text.
 * @returns {string} The abstract.
 */
export function firstSentence(text) {
	const value = String(text ?? '').trim()
	if (value === '') return ''
	const match = value.match(/^[^。！？.!?\n]{1,120}/)
	return (match ? match[0] : value.slice(0, 120)).trim()
}
