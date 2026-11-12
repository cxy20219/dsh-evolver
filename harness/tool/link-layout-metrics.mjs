#!/usr/bin/env node
/**
 * Link-graph layout probe.
 *
 * Pulls computeLinkLayout straight out of client.js (no copy to drift), runs it
 * against a card library and prints the numbers that decide whether the picture
 * reads as a core and a periphery: overlaps, span, radii by degree, and how far
 * the hubs sit from the middle compared with the leaves.
 *
 * ```bash
 * node harness/tool/link-layout-metrics.mjs
 * node harness/tool/link-layout-metrics.mjs --cards /tmp/cards.jsonl --svg /tmp/graph.svg
 * ```
 *
 * Output: one JSON object on stdout. Exit code 1 when the layout throws or a
 * coordinate comes back non-finite, which is how a blown-up simulation shows up.
 *
 * 验证：跑一次应看到 `overlaps: 0`、`minGap > 0`、`radiiByDegree` 随度数单调不减，
 * 且 `hubRadial < leafRadial`（枢纽比叶子更靠中心）。任何一项不满足就是布局回退。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
const linkColorOf = () => '#8a8f98'
const computeLinkLayout = new Function('linkColorOf', `${body}; return computeLinkLayout`)(linkColorOf)

const cardFile = flags.cards ?? path.join(os.homedir(), '.dsh/evolver/knowledge/cards/cards.jsonl')
const merged = new Map()
for (const line of fs.readFileSync(cardFile, 'utf8').split('\n')) {
	if (line.trim() === '') continue
	const card = JSON.parse(line)
	merged.set(card.id, { ...(merged.get(card.id) ?? {}), ...card })
}
const cards = [...merged.values()]

const started = performance.now()
const layout = computeLinkLayout(cards)
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
const centreX = meanOf(nodes.map((node) => node.x))
const centreY = meanOf(nodes.map((node) => node.y))
const radial = nodes.map((node) => Math.hypot(node.x - centreX, node.y - centreY))
const maxRadial = Math.max(...radial)
const radialOf = (filter) => {
	const picked = nodes.map((node, index) => [node, radial[index]]).filter(([node]) => filter(node))
	return +(meanOf(picked.map(([, value]) => value)) / maxRadial).toFixed(2)
}
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
	cards: cards.length,
	nodes: nodes.length,
	edges: edges.length,
	overlaps,
	minGap: +minGap.toFixed(2),
	span: `${Math.round(Math.max(...nodes.map((node) => node.x)) - Math.min(...nodes.map((node) => node.x)))}x`
		+ `${Math.round(Math.max(...nodes.map((node) => node.y)) - Math.min(...nodes.map((node) => node.y)))}`,
	radiiByDegree: radii,
	hubRadial: radialOf((node) => node.degree >= 4),
	leafRadial: radialOf((node) => node.degree === 1),
	layoutMs: +elapsed.toFixed(1),
}))

if (flags.svg !== undefined) {
	const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width * 2}" height="${layout.height * 2}">`,
		`<rect width="100%" height="100%" fill="#fff"/>`]
	for (const edge of edges) {
		parts.push(`<path d="${edge.d}" fill="none" stroke="#9aa0a6" stroke-opacity="0.6"/>`)
	}
	for (const node of nodes) {
		parts.push(`<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${node.r.toFixed(1)}" fill="${node.color}" stroke="#fff"/>`)
	}
	parts.push('</svg>')
	fs.writeFileSync(flags.svg, parts.join('\n'))
}
