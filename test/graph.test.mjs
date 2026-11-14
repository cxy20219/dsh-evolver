/**
 * The canvas graph's pure math: dot size, mass, and the globe's forces.
 *
 * These run through `module.__graph` (see `loadClient`): the browser half has no
 * import surface, so this is the seam that keeps the layout testable without a
 * canvas. Every expectation below was measured on the live library — 2200 files,
 * 3035 links, busiest file 17 — where the old log-curve sizing put 2089 dots
 * inside 0.6 px of each other.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { loadClient } from './helpers.mjs'

const { module } = await loadClient()
const graph = module.__graph

/**
 * Host-shaped graph nodes with the given out-degrees.
 *
 * @param {number[]} degrees - One out-degree per node.
 * @param {string[]} [tags] - Tag root per node, defaults to one cluster.
 * @returns {object[]} The nodes.
 */
function nodesOf(degrees, tags = []) {
	return degrees.map((degree, index) => ({
		id: 'file-' + index,
		name: 'file-' + index + '.md',
		description: '一个测试文件',
		mime: 'text/markdown',
		tags: [tags[index] ?? '践行/工作流'],
		degree: { in: 0, out: degree },
	}))
}

test('节点半径与质量随连线数单调增长，且跨度看得见', () => {
	const degrees = [0, 1, 2, 3, 4, 6, 10, 17]
	const data = graph.canvasGraphData({ nodes: nodesOf(degrees), edges: [] })
	assert.equal(data.nodes.length, degrees.length)

	for (let index = 1; index < data.nodes.length; index += 1) {
		const previous = data.nodes[index - 1]
		const node = data.nodes[index]
		assert.ok(node.radius > previous.radius, `度数 ${node.degree} 的半径应大于 ${previous.degree}`)
		assert.ok(node.mass > previous.mass, `度数 ${node.degree} 的质量应大于 ${previous.degree}`)
	}

	const leaf = data.nodes[0]
	const hub = data.nodes[data.nodes.length - 1]
	// The old curve ran 2.3–4.6 px, so the busiest dot was barely twice a leaf.
	// The point of the change is that a hub is now a different thing to look at.
	assert.ok(hub.radius / leaf.radius > 2.5, `枢纽/叶子的半径比只有 ${(hub.radius / leaf.radius).toFixed(2)}`)
	assert.ok(Math.abs(leaf.radius - graph.radiusOf(0)) < 1e-9, '无连线的文件就是最小半径')
	assert.ok(Math.abs(hub.radius - graph.radiusOf(1)) < 1e-9, '最忙的文件就是最大半径')
	// 质量留在 0.6–1.5：这是力的分母，太大会让整张图僵住。
	assert.ok(leaf.mass >= 0.6 - 1e-9 && hub.mass <= 1.5 + 1e-9, '质量应落在 0.6–1.5')
	// 分布中段也要拉开距离，否则"连接越多越大"只对少数枢纽成立。
	assert.ok(data.nodes[4].radius - data.nodes[2].radius > 0.5, '中段（度数 2→4）的差值应可见')
})

test('图数据把度数换成权重：最忙的文件权重为 1，孤岛为 0', () => {
	const degrees = [0, 3, 17]
	const data = graph.canvasGraphData({ nodes: nodesOf(degrees), edges: [] })
	assert.deepEqual(data.nodes.map((node) => node.weight), [0, 3 / 17, 1])
	assert.deepEqual(data.nodes.map((node) => node.degree), degrees)
})

test('星球图松弛后仍留在单位球面，收敛且确定', () => {
	const nodes = nodesOf([...Array(60).keys()].map((index) => index % 12), [
		...Array(20).fill('践行/工作流'),
		...Array(20).fill('见闻/网络'),
		...Array(20).fill('复盘/踩坑'),
	])
	const edges = []
	for (let index = 0; index < 60; index += 1) {
		edges.push({ s: 'file-' + index, t: 'file-' + ((index + 1) % 60), w: 1 })
		edges.push({ s: 'file-' + index, t: 'file-' + ((index + 7) % 60), w: 1 })
	}
	const data = graph.canvasGraphData({ nodes, edges })
	const first = new graph.SphereLayout(data.nodes, data.edges)
	const second = new graph.SphereLayout(data.nodes, data.edges)
	for (let tick = 0; tick < 200; tick += 1) {
		first.tick()
		second.tick()
	}

	for (const particle of first.particles) {
		const length = Math.hypot(particle.x, particle.y, particle.z)
		assert.ok(Math.abs(length - 1) < 1e-6, `节点应落在单位球面上，实际 ${length}`)
		assert.ok(Number.isFinite(particle.x) && Number.isFinite(particle.y) && Number.isFinite(particle.z))
	}
	assert.ok(first.alpha < 5e-3, `alpha 应收敛，实际 ${first.alpha}`)
	// Deterministic: no clock and no random numbers, so two runs agree exactly.
	assert.deepEqual(
		first.particles.map((particle) => [particle.x, particle.y, particle.z]),
		second.particles.map((particle) => [particle.x, particle.y, particle.z]),
	)
})

test('星球图的力把重叠的点推开，同时不搬动社区', () => {
	const degrees = [...Array(80).keys()].map((index) => index % 9)
	const tags = [
		...Array(40).fill('践行/工作流'),
		...Array(40).fill('见闻/网络'),
	]
	const nodes = nodesOf(degrees, tags)
	const edges = []
	for (let index = 0; index < 80; index += 1) {
		edges.push({ s: 'file-' + index, t: 'file-' + ((index + 3) % 80), w: 1 })
		edges.push({ s: 'file-' + index, t: 'file-' + ((index + 5) % 80), w: 1 })
	}
	const data = graph.canvasGraphData({ nodes, edges })
	const sim = new graph.SphereLayout(data.nodes, data.edges)

	const closest = (particles) => {
		let best = Infinity
		for (let left = 0; left < particles.length; left += 1) {
			for (let right = left + 1; right < particles.length; right += 1) {
				best = Math.min(best, Math.hypot(
					particles[left].x - particles[right].x,
					particles[left].y - particles[right].y,
					particles[left].z - particles[right].z,
				))
			}
		}
		return best
	}
	const seeded = sim.particles.map((particle) => ({ x: particle.sx, y: particle.sy, z: particle.sz }))
	const before = closest(seeded)
	for (let tick = 0; tick < 200; tick += 1) sim.tick()
	const after = closest(sim.particles)
	assert.ok(after > before, `松弛后最近的一对应当更远：${before} → ${after}`)
	assert.ok(after > 0.01, `松弛后不应有点贴在一起，最近的一对是 ${after}`)

	// The caps are where the communities live; the relaxation may shuffle dots
	// inside a cap but must not swap the caps.
	const drifted = sim.particles.map((particle) => Math.acos(Math.max(-1, Math.min(1,
		particle.x * particle.sx + particle.y * particle.sy + particle.z * particle.sz,
	))))
	const median = drifted.slice().sort((left, right) => left - right)[Math.floor(drifted.length / 2)]
	assert.ok(median < 0.15, `中位漂移应是小幅的，实际 ${median.toFixed(3)} rad`)
})

test('只有同一片社区内的连线才当弹簧，跨社区的长边不拽动整颗球', () => {
	// Two dots per community: one short pair inside each cap, plus one bridge
	// across the globe. Only the two short pairs may become springs, otherwise
	// the bridge drags the caps into each other — measured at 1.6 rad of median
	// drift when every link was a spring.
	const nodes = nodesOf([1, 1, 1, 1], ['践行/工作流', '践行/工作流', '见闻/网络', '见闻/网络'])
	const edges = [
		{ from: 'file-0', to: 'file-1', w: 1 },
		{ from: 'file-2', to: 'file-3', w: 1 },
		{ from: 'file-0', to: 'file-2', w: 1 },
	]
	const data = graph.canvasGraphData({ nodes, edges })
	const sim = new graph.SphereLayout(data.nodes, data.edges)
	assert.equal(sim.links.length, 2, '两条社区内的边留下，跨社区的那条被丢掉')
	for (const link of sim.links) {
		const chord = Math.hypot(link[0].sx - link[1].sx, link[0].sy - link[1].sy, link[0].sz - link[1].sz)
		assert.ok(Math.abs(link[3] - chord * 0.6) < 1e-9, `弹簧的静止长度是初始弦长的 0.6 倍，实际 ${link[3]}`)
	}
	const bridge = Math.hypot(
		sim.byId.get('file-0').sx - sim.byId.get('file-2').sx,
		sim.byId.get('file-0').sy - sim.byId.get('file-2').sy,
		sim.byId.get('file-0').sz - sim.byId.get('file-2').sz,
	)
	assert.ok(bridge > 0.45, `这条桥在球面上确实很远，实际弦长 ${bridge.toFixed(3)}`)
})
