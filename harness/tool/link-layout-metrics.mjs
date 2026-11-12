#!/usr/bin/env node
/**
 * Link-graph layout probe.
 *
 * Pulls computeLinkLayout straight out of client.js (no copy to drift) and prints
 * the numbers that decide whether the picture reads as communities: overlaps,
 * span, radii by degree and branchCohesion — how much closer a card sits to its
 * own branch centroid than to the other branches'. The layout groups cards by
 * branch, so cohesion is the number that catches a regression back to one cloud.
 *
 * The default run lays out the real card library the old way: one argument, only
 * linked cards. `--graph` takes a saved `graph` endpoint payload instead, so the
 * derived tag/branch ties (drawn dashed) can be inspected too.
 *
 * ```bash
 * node harness/tool/link-layout-metrics.mjs
 * node harness/tool/link-layout-metrics.mjs --cards /tmp/cards.jsonl --svg /tmp/graph.svg
 * node harness/tool/link-layout-metrics.mjs --graph /tmp/graph.json --svg /tmp/graph.svg
 * ```
 *
 * Output: one JSON object on stdout. Exit code 1 when the layout throws or a
 * coordinate comes back non-finite, which is how a blown-up simulation shows up.
 *
 * 验证：跑一次应看到 `overlaps: 0`、`minGap > 0`、`radiiByDegree` 随度数单调不减，
 * 且多枝干时 `branchCohesion > 1.2`（同枝干向自己枝干质心聚拢）。任何一项不满足就是布局回退。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** One colour per branch, so the preview reads like the panel. */
const BRANCH_COLORS = {
	践行: '#4f8a6e',
	见闻: '#657ea6',
	即兴: '#a77b55',
	复盘: '#87679a',
	觉察: '#4f8794',
	试错: '#9b6b6b',
}

/**
 * Read `--name value` pairs.
 *
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {object} The flags.
 */
function parseArgs(argv) {
	const flags = {}
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]
		if (!arg.startsWith('--')) continue
		const next = argv[i + 1]
		if (next === undefined || next.startsWith('--')) {
			flags[arg.slice(2)] = true
		} else {
			flags[arg.slice(2)] = next
			i += 1
		}
	}
	return flags
}

/**
 * Cut one function out of a source file by matching its braces.
 *
 * @param {string} source - The file text.
 * @param {string} signature - Start of the function declaration.
 * @returns {string} The function source.
 */
function extractFunction(source, signature) {
	const start = source.indexOf(signature)
	if (start < 0) throw new Error(`not found: ${signature}`)
	let depth = 0
	for (let i = source.indexOf('{', start); i < source.length; i += 1) {
		if (source[i] === '{') depth += 1
		if (source[i] === '}') {
			depth -= 1
			if (depth === 0) return source.slice(start, i + 1)
		}
	}
	throw new Error(`unbalanced braces after: ${signature}`)
}

const flags = parseArgs(process.argv.slice(2))
const root = path.resolve(import.meta.dirname, '../..')
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const body = extractFunction(source, 'function computeLinkLayout(cards, edges) {')
const linkColorOf = (card) => {
	const branch = typeof card.branch === 'string' ? card.branch : String((card.tags ?? [])[0] ?? '').split('/')[0]
	return BRANCH_COLORS[branch] ?? '#8a8f98'
}
const computeLinkLayout = new Function('linkColorOf', `${body}; return computeLinkLayout`)(linkColorOf)

let payload = null
let cards = []
if (flags.graph !== undefined && flags.graph !== true) {
	payload = JSON.parse(fs.readFileSync(String(flags.graph), 'utf8'))
	cards = Array.isArray(payload.nodes) ? payload.nodes : []
} else {
	const cardFile = flags.cards ?? path.join(os.homedir(), '.dsh/evolver/knowledge/cards/cards.jsonl')
	const merged = new Map()
	for (const line of fs.readFileSync(cardFile, 'utf8').split('\n')) {
		if (line.trim() === '') continue
		const card = JSON.parse(line)
		merged.set(card.id, { ...(merged.get(card.id) ?? {}), ...card })
	}
	cards = [...merged.values()]
}

const started = performance.now()
const layout = payload === null ? computeLinkLayout(cards) : computeLinkLayout(payload.nodes, payload.edges)
const elapsed = performance.now() - started
if (layout === null) {
	console.log(JSON.stringify({ cards: cards.length, layout: null }))
	process.exit(1)
}

const { nodes, edges } = layout
const bad = nodes.find((node) => !Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.r))
if (bad !== undefined) {
	console.log(JSON.stringify({ layout: 'not finite', node: bad }))
	process.exit(1)
}

let minGap = Infinity
let overlaps = 0
for (let i = 0; i < nodes.length; i += 1) {
	for (let j = i + 1; j < nodes.length; j += 1) {
		const gap = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) - nodes[i].r - nodes[j].r
		minGap = Math.min(minGap, gap)
		if (gap < 0) overlaps += 1
	}
}
const meanOf = (list) => (list.length === 0 ? 0 : list.reduce((sum, value) => sum + value, 0) / list.length)

// Branch cohesion: own-branch distance over other-branch distance. Above 1
// means a card sits closer to its own branch's centroid; below 1 means the
// communities have bled into one cloud.
const branchNames = [...new Set(nodes.map((node) => node.branch))]
const centroids = {}
for (const branch of branchNames) {
	const members = nodes.filter((node) => node.branch === branch)
	centroids[branch] = {
		x: meanOf(members.map((node) => node.x)),
		y: meanOf(members.map((node) => node.y)),
	}
}
const ownDistances = []
const otherDistances = []
for (const node of nodes) {
	ownDistances.push(Math.hypot(node.x - centroids[node.branch].x, node.y - centroids[node.branch].y))
	for (const branch of branchNames) {
		if (branch === node.branch) continue
		otherDistances.push(Math.hypot(node.x - centroids[branch].x, node.y - centroids[branch].y))
	}
}
const branchCohesion = otherDistances.length === 0
	? null
	: +(meanOf(otherDistances) / meanOf(ownDistances)).toFixed(2)

const byDegree = {}
for (const node of nodes) {
	const bucket = (byDegree[node.degree] ?? (byDegree[node.degree] = []))
	bucket.push(+node.r.toFixed(1))
}
const radii = {}
for (const degree of Object.keys(byDegree).map(Number).sort((a, b) => a - b)) {
	radii[degree] = byDegree[degree][0]
}

console.log(JSON.stringify({
	cards: payload !== null && Number.isFinite(payload?.totals?.cards) ? payload.totals.cards : cards.length,
	nodes: nodes.length,
	edges: edges.length,
	overlaps,
	minGap: +minGap.toFixed(2),
	span: `${Math.round(Math.max(...nodes.map((node) => node.x)) - Math.min(...nodes.map((node) => node.x)))}x`
		+ `${Math.round(Math.max(...nodes.map((node) => node.y)) - Math.min(...nodes.map((node) => node.y)))}`,
	radiiByDegree: radii,
	branchCohesion,
	layoutMs: +elapsed.toFixed(1),
}))

if (flags.svg !== undefined) {
	const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width * 2}" height="${layout.height * 2}">`,
		'<rect width="100%" height="100%" fill="#fff"/>']
	// The branch names are the region labels the panel draws under the dots.
	for (const region of layout.branches ?? []) {
		parts.push(`<text x="${region.x.toFixed(1)}" y="${region.y.toFixed(1)}" text-anchor="middle" font-size="10" font-family="sans-serif" font-weight="500" fill="${region.color}" fill-opacity="0.35" stroke="#fff" stroke-width="2" paint-order="stroke">${region.branch}</text>`)
	}
	// The panel draws no arrowheads at rest (direction appears on hover), so the
	// preview matches it; weak ties are the faint dashed layer.
	for (const edge of edges) {
		parts.push(edge.kind === 'link'
			? `<path d="${edge.d}" fill="none" stroke="#9aa0a6" stroke-opacity="0.45" stroke-width="1"/>`
			: `<path d="${edge.d}" fill="none" stroke="#c3c8ce" stroke-opacity="0.22" stroke-dasharray="2 4" stroke-width=".75"/>`)
	}
	for (const node of nodes) {
		parts.push(`<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${node.r.toFixed(1)}" fill="${node.color}" stroke="#fff"/>`)
	}
	parts.push('</svg>')
	fs.writeFileSync(flags.svg, parts.join('\n'))
}
