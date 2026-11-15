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

	'settings-save': async (payload, { store, settings }) => {
		const patch = {}
		for (const field of ['descriptionMaxChars', 'maxFileBytes', 'readTextBytes']) {
			if (payload?.[field] !== undefined) patch[field] = Number(payload[field])
		}
		const saved = await settings.save(patch)
		store.setLimits({
			maxBytes: saved.maxFileBytes,
			readTextBytes: saved.readTextBytes,
			descriptionMaxChars: saved.descriptionMaxChars,
		})
		return panelSettings(settings)
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
