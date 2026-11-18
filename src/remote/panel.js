/**
 * The panel endpoints: overview, graph, settings, logs and the organize page.
 *
 * Editing `~/.dsh/AGENTS.md` used to live here too; it belongs to the manager
 * plugin now, which owns the global instruction file for the whole profile.
 *
 * These read the store's aggregate views and the host-side settings; the
 * organize page gets its own data from the organize endpoints, not from here.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { dshHome } from './support.js'

/**
 * The settings the panel reads: the three limits, plus the data root it
 * shows in the header. The stored `schema`, `organize` block and settings
 * file path stay host-side — the organize page gets what it needs from
 * `organize-status`, not from here.
 *
 * @param {object} settings - The settings store.
 * @returns {{descriptionMaxChars: number, maxFileBytes: number, readTextBytes: number, dataDir: string}} The panel view.
 */
function panelSettings(settings) {
	const view = settings.publicView()
	return {
		descriptionMaxChars: view.descriptionMaxChars,
		maxFileBytes: view.maxFileBytes,
		readTextBytes: view.readTextBytes,
		// The token is deliberately absent: it is handed out by `mcp-status`,
		// the one place that also says whether the endpoint is actually up.
		mcp: { enabled: view.mcp.enabled === true, port: view.mcp.port },
		// The key never leaves the machine: the panel needs to know whether one
		// is set (to show "已配置") but never what it is.
		llm: {
			baseUrl: view.llm.baseUrl,
			model: view.llm.model,
			hasKey: view.llm.apiKey !== '',
		},
		dataDir: view.dataDir,
	}
}

/**
 * Read the tail of the plugin log.
 *
 * @param {string} root - The data root.
 * @param {number} [limit] - Maximum lines.
 * @returns {Promise<{path: string, lines: string[]}>} The tail.
 */
async function logTail(root, limit = 300) {
	const path = join(root, 'system', 'logs', 'plugin.log')
	const content = await readFile(path, 'utf8').catch(() => '')
	const lines = content.split('\n').filter((line) => line !== '')
	return { path, lines: lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 300))) }
}

/** The endpoints this module owns. */
export const panelHandlers = {
	overview: async (_payload, { store, version }) => {
		// Only what the overview tab draws: stats, year, heatmap, tags
		// and the suffix matrix. The graph tab has its own endpoint, and
		// the old recent-files/settings copies had no reader.
		const activity = store.activity()
		const stats = store.stats()
		return {
			version,
			stats: { ...stats, days: activity.days },
			tags: store.tagCounts(1000),
			activity: activity.activity,
			year: {
				notes: activity.notes,
				activeDays: activity.activeDays,
				days: activity.activity.length,
			},
			suffixes: store.suffixCounts(),
		}
	},

	graph: async (_payload, { store }) => {
		const graph = store.libraryGraph({ limit: 3000 })
		const stats = store.stats()
		return {
			...graph,
			totals: {
				files: stats.files,
				links: stats.links,
				shown: graph.nodes.length,
				hidden: Math.max(0, stats.files - graph.nodes.length),
			},
		}
	},

	settings: async (_payload, { settings }) => panelSettings(settings),

	'settings-save': async (payload, { store, settings, mcp }) => {
		const patch = {}
		for (const field of ['descriptionMaxChars', 'maxFileBytes', 'readTextBytes']) {
			if (payload?.[field] !== undefined) patch[field] = Number(payload[field])
		}
		const wantedMcp = {}
		if (payload?.mcp !== undefined && payload.mcp !== null && typeof payload.mcp === 'object') {
			if (payload.mcp.enabled !== undefined) wantedMcp.enabled = payload.mcp.enabled === true
			if (payload.mcp.port !== undefined) wantedMcp.port = Number(payload.mcp.port)
			if (typeof payload.mcp.token === 'string' && payload.mcp.token.trim() !== '') {
				wantedMcp.token = payload.mcp.token.trim()
			}
			patch.mcp = wantedMcp
		}
		if (payload?.llm !== undefined && payload.llm !== null && typeof payload.llm === 'object') {
			const wanted = {}
			if (typeof payload.llm.baseUrl === 'string' && payload.llm.baseUrl.trim() !== '') wanted.baseUrl = payload.llm.baseUrl.trim()
			if (typeof payload.llm.model === 'string') wanted.model = payload.llm.model.trim()
			// An empty string clears the key; an absent key leaves it alone.
			if (typeof payload.llm.apiKey === 'string') wanted.apiKey = payload.llm.apiKey
			patch.llm = wanted
		}
		const saved = await settings.save(patch)
		store.setLimits({
			maxBytes: saved.maxFileBytes,
			readTextBytes: saved.readTextBytes,
			descriptionMaxChars: saved.descriptionMaxChars,
		})
		// Apply the switch in the same request that stores it: a toggle that only
		// took effect on the next host start would look broken.
		if (patch.mcp !== undefined) {
			try {
				const service = mcp()
				await service.stop()
				if (saved.mcp.enabled) await service.start({ port: saved.mcp.port, token: saved.mcp.token })
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				logs?.warn?.(`自衍中枢：MCP 开关切换失败：${message}`)
			}
		}
		return panelSettings(settings)
	},

	/**
	 * Try the configured model route once, so a person can tell "wrong key" from
	 * "wrong model" without running a whole organize job.
	 *
	 * The key is read from the saved settings, never from the payload: a probe
	 * must not be a way to send a credential through the panel API.
	 */
	'llm-probe': async (_payload, { settings }) => {
		const block = settings.get().llm
		if (block.model === '') return { ok: false, message: '还没有填模型名。' }
		const verdict = await probeOpenAi({ baseUrl: block.baseUrl, apiKey: block.apiKey, model: block.model })
		return { ok: verdict.ok === true, message: verdict.message, model: block.model, baseUrl: block.baseUrl }
	},

	'mcp-status': async (_payload, { settings, mcp }) => {
		const block = settings.get().mcp
		const service = mcp()
		const state = service.status()
		return {
			enabled: block.enabled === true,
			port: block.port,
			running: state.running,
			url: state.url,
			token: block.token,
			tools: state.tools,
			tokens: state.tokens,
			problem: state.problem,
			hint: block.enabled && !state.running ? '已开启但未能监听：端口可能被占用，换一个端口再试。' : '',
		}
	},

	logs: async (payload, { root }) => logTail(root, payload?.limit),

}
