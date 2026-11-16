/**
 * The panel endpoints: overview, graph, settings, logs, injection, tools and
 * the global preferences block.
 *
 * These read the store's aggregate views and the host-side settings; the
 * organize page gets its own data from the organize endpoints, not from here.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readPreferences, writePreferences } from '../preferences.js'
import { staticSection } from '../prompt.js'
import { estimateTokens } from '../tokens.js'
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

	injection: async () => {
		// The panel's injection tab shows the one static section the host
		// registers, sized in estimated tokens (the unit the model budget uses).
		// There is no runtime index to size, refresh or date.
		const staticText = staticSection()
		return { static: staticText, staticTokens: estimateTokens(staticText) }
	},

	tools: async (_payload, { catalog }) => ({
		total: catalog.length,
		// The tool schemas ride on every request too; the page shows their
		// estimated token share next to the list.
		tokens: catalog.reduce((sum, tool) => sum + (Number(tool.tokens) || 0), 0),
		tools: catalog,
	}),

	preferences: async (_payload, { root }) => readPreferences({ dshHome: dshHome(), dataDir: root }),

	'preferences-save': async (payload, { root }) => writePreferences({ dshHome: dshHome(), dataDir: root }, payload?.content),
}
