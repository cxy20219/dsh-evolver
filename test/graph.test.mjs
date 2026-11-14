/**
 * The canvas graph's pure math: dot size, mass, and the two force layouts.
 *
 * These run through `module.__graph` (see `loadClient`): the browser half has no
 * import surface, so this is the seam that keeps the layout testable without a
 * canvas. Every expectation below was measured on the live library — 2121
 * files, 2820 links, busiest file 17 — and on the same-shaped fixtures built
 * here. The live numbers, before → after this physics change:
 *
 *  - globe: 1141 pairs whose drawn circles intersect on the sphere (582 of them
 *    penetrating over 1 px) → 6 and 1; nearest screen pair median 5.71 → 6.66
 *    px; between-cluster mean distance 3.01× → 2.93× the within-cluster one;
 *    the lighter end of a community link moved farther in 52% → 74% of links;
 *    86 frames to settle, ~1.5 ms/tick;
 *  - network: 8507 overlapping pairs (6463 deeper than 1 px) → 8 and 0; nearest
 *    pair median 3.75 → 9.23 px; between-cluster mean distance 1.00× → 3.40×
 *    the within-cluster one; 82 frames, ~1.3 ms/tick.
 *
 * The globe's stacking check is in chord space on purpose: perspective puts
 * dots on the back of the ball on the same pixels as dots on the front, which
 * is occlusion, not stacking — 2121 dots cannot avoid that on a 900×560 canvas.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { loadClient } from './helpers.mjs'

const { module } = await loadClient()
const graph = module.__graph

/** The reference canvas the globe's collision distances are defined on. */
const GLOBE_PX = graph.GLOBE_REFERENCE_PX
/** `alpha` below this means the layout has settled and `tick()` is a no-op. */
const SETTLED = 5e-3

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

/**
 * A graph of equal-sized clusters wired with same-cluster links plus one bridge.
 *
 * @param {string[]} roots - One tag root per cluster.
 * @param {number} size - Files per cluster.
 * @param {number[]} degrees - Out-degree per node, in file order.
 * @returns {{nodes: object[], edges: object[]}} Host-shaped graph data.
 */
function clusteredGraph(roots, size, degrees) {
	const tags = []
	for (const root of roots) {
		for (let index = 0; index < size; index += 1) tags.push(root + '/工作流')
	}
	const edges = []
	for (let group = 0; group < roots.length; group += 1) {
		for (let local = 0; local < size; local += 1) {
			const from = group * size + local
			edges.push({ from: 'file-' + from, to: 'file-' + (group * size + (local + 1) % size), w: 1 })
			edges.push({ from: 'file-' + from, to: 'file-' + (group * size + (local + 3) % size), w: 1 })
		}
	}
	edges.push({ from: 'file-0', to: 'file-' + size, w: 1 })
	return { nodes: nodesOf(degrees, tags), edges }
}

/** Chord distance between two globe particles. */
function chord(left, right) {
	return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)
}

/** Planar distance between two network particles. */
function plane(left, right) {
	return Math.hypot(left.x - right.x, left.y - right.y)
}

/**
 * Overlap pairs of drawn circles, counted in the layout's own distance space.
 *
 * A particle's `clearance` is its collision radius, which already includes half
 * the layout's empty gap; the drawn circle is smaller. `deep` is the subset
 * that penetrates more than one pixel past the drawn circle — those are the
 * pairs the eye would read as stacked.
 *
 * @param {object[]} particles - Layout particles with `clearance`.
 * @param {(left: object, right: object) => number} distance - Layout distance.
 * @param {{gap: number, pixel: number}} units - The pair gap and one pixel, in the layout's distance units.
 * @returns {{overlaps: number, deep: number}} The counts.
 */
function overlapPairs(particles, distance, units) {
	let overlaps = 0
	let deep = 0
	for (let left = 0; left < particles.length; left += 1) {
		for (let right = left + 1; right < particles.length; right += 1) {
			const apart = distance(particles[left], particles[right])
			const drawn = particles[left].clearance + particles[right].clearance - units.gap
			if (apart < drawn) overlaps += 1
			if (apart < drawn - units.pixel) deep += 1
		}
	}
	return { overlaps, deep }
}

/**
 * The ratio between mean distance of different-cluster pairs and same-cluster
 * pairs. Higher means the communities are visibly apart.
 *
 * @param {object[]} particles - Layout particles with `cluster`.
 * @param {(left: object, right: object) => number} distance - Layout distance.
 * @returns {number} Between over within.
 */
function clusterSeparation(particles, distance) {
	const groups = new Map()
	for (const particle of particles) {
		const list = groups.get(particle.cluster) || []
		list.push(particle)
		groups.set(particle.cluster, list)
	}
	const list = [...groups.values()]
	let within = 0
	let withinCount = 0
	let between = 0
	let betweenCount = 0
	for (let left = 0; left < list.length; left += 1) {
		for (let a = 0; a < list[left].length; a += 1) {
			for (let b = a + 1; b < list[left].length; b += 1) {
				within += distance(list[left][a], list[left][b])
				withinCount += 1
			}
			for (let right = left + 1; right < list.length; right += 1) {
				for (let b = 0; b < list[right].length; b += 1) {
					between += distance(list[left][a], list[right][b])
					betweenCount += 1
				}
			}
		}
	}
	return (between / betweenCount) / (within / withinCount)
}

/** Snapshot of a layout's seeded positions, for drift measurements. */
function seedsOf(layout) {
	return layout.particles.map((particle) => ({ x: particle.x, y: particle.y, z: particle.z }))
}

/** Median of an array of numbers. */
function median(values) {
	const sorted = values.slice().sort((left, right) => left - right)
	return sorted[Math.floor(sorted.length / 2)]
}

/** Tick until `alpha` settles, returning the frame count. */
function tickToSettle(layout, limit = 200) {
	let frames = 0
	while (layout.alpha >= SETTLED && frames < limit) {
		layout.tick()
		frames += 1
	}
	return frames
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
		edges.push({ from: 'file-' + index, to: 'file-' + ((index + 1) % 60), w: 1 })
		edges.push({ from: 'file-' + index, to: 'file-' + ((index + 7) % 60), w: 1 })
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
	assert.ok(first.alpha < SETTLED, `alpha 应收敛，实际 ${first.alpha}`)
	// Deterministic: no clock and no random numbers, so two runs agree exactly.
	assert.deepEqual(
		first.particles.map((particle) => [particle.x, particle.y, particle.z]),
		second.particles.map((particle) => [particle.x, particle.y, particle.z]),
	)
})

test('星球图：真实占位，球面上没有叠在一起的两个点', () => {
	const degrees = [...Array(120).keys()].map((index) => index % 12)
	const data = graph.canvasGraphData(clusteredGraph(['践行', '见闻', '复盘'], 40, degrees))
	const sim = new graph.SphereLayout(data.nodes, data.edges)
	const frames = tickToSettle(sim)

	assert.ok(frames < 150, `应在 150 帧内收敛，实际 ${frames}`)
	for (const particle of sim.particles) {
		assert.ok(Math.abs(Math.hypot(particle.x, particle.y, particle.z) - 1) < 1e-6, '松弛后仍应贴住球面')
	}
	const { overlaps, deep } = overlapPairs(sim.particles, chord, {
		gap: graph.GLOBE_DOT_GAP / GLOBE_PX,
		pixel: 1 / GLOBE_PX,
	})
	// "No two dots stacked": zero pairs penetrate more than a pixel of the gap,
	// and the handful left are sub-pixel rounding at exactly-contact pairs.
	assert.equal(deep, 0, `有 ${deep} 对点穿透超过 1px`)
	assert.ok(overlaps <= 2, `画圆相交的邻里对 ${overlaps}（容差 2 对）`)
})

test('星球图：同团节点明显比跨团节点近', () => {
	const degrees = [...Array(120).keys()].map((index) => index % 12)
	const data = graph.canvasGraphData(clusteredGraph(['践行', '见闻', '复盘'], 40, degrees))
	const sim = new graph.SphereLayout(data.nodes, data.edges)
	tickToSettle(sim)
	const ratio = clusterSeparation(sim.particles, chord)
	assert.ok(ratio > 2, `同团/跨团距离比只有 ${ratio.toFixed(2)}：社区没有分开`)
})

test('关系图：真实占位，且内容盒不超过适配边界', () => {
	const degrees = [...Array(120).keys()].map((index) => index % 12)
	const data = graph.canvasGraphData(clusteredGraph(['践行', '见闻', '复盘'], 40, degrees))
	const sim = new graph.NetworkLayout(data.nodes, data.edges)
	const frames = tickToSettle(sim)

	assert.ok(frames < 150, `应在 150 帧内收敛，实际 ${frames}`)
	const { overlaps, deep } = overlapPairs(sim.particles, plane, {
		gap: graph.NETWORK_DOT_GAP,
		pixel: 1,
	})
	assert.equal(deep, 0, `有 ${deep} 对点穿透超过 1px`)
	assert.ok(overlaps <= 2, `画圆相交的邻里对 ${overlaps}（容差 2 对）`)

	// 布局按内容盒播种；跑完后仍要装得下，否则初始适配会缩小间距、把碰撞间隙吃掉。
	const minX = Math.min(...sim.particles.map((particle) => particle.x))
	const maxX = Math.max(...sim.particles.map((particle) => particle.x))
	const minY = Math.min(...sim.particles.map((particle) => particle.y))
	const maxY = Math.max(...sim.particles.map((particle) => particle.y))
	assert.ok(maxX - minX <= sim.box.x, `宽度 ${(maxX - minX).toFixed(0)} 应不超过内容盒 ${sim.box.x}`)
	assert.ok(maxY - minY <= sim.box.y, `高度 ${(maxY - minY).toFixed(0)} 应不超过内容盒 ${sim.box.y}`)
})

test('关系图：同团节点明显比跨团节点近', () => {
	const degrees = [...Array(120).keys()].map((index) => index % 12)
	const data = graph.canvasGraphData(clusteredGraph(['践行', '见闻', '复盘'], 40, degrees))
	const sim = new graph.NetworkLayout(data.nodes, data.edges)
	tickToSettle(sim)
	const ratio = clusterSeparation(sim.particles, plane)
	assert.ok(ratio > 2, `同团/跨团距离比只有 ${ratio.toFixed(2)}：社区没有分开`)
})

test('两个布局：大质量节点几乎不动，叶子被拉向有链接的枢纽', () => {
	// One cluster: a degree-8 hub with eight linked leaves. Another cluster:
	// twelve files the hub does not link to.
	const specs = [{ degree: 8, tag: '践行/工作流' }]
	for (let leaf = 0; leaf < 8; leaf += 1) specs.push({ degree: 1, tag: '践行/工作流' })
	for (let extra = 0; extra < 12; extra += 1) specs.push({ degree: extra % 3, tag: '见闻/网络' })
	const edges = []
	for (let leaf = 1; leaf <= 8; leaf += 1) edges.push({ from: 'file-0', to: 'file-' + leaf, w: 1 })
	edges.push({ from: 'file-9', to: 'file-10', w: 1 }, { from: 'file-10', to: 'file-11', w: 1 })
	const data = graph.canvasGraphData({ nodes: nodesOf(specs.map((spec) => spec.degree), specs.map((spec) => spec.tag)), edges })

	for (const [name, layout, distance] of [
		['星球图', new graph.SphereLayout(data.nodes, data.edges), chord],
		['关系图', new graph.NetworkLayout(data.nodes, data.edges), plane],
	]) {
		const seeded = seedsOf(layout)
		tickToSettle(layout)
		const hub = layout.byId.get('file-0')
		const hubDrift = distance(hub, seeded[0])
		const leafDrifts = []
		for (let leaf = 1; leaf <= 8; leaf += 1) {
			leafDrifts.push(distance(layout.byId.get('file-' + leaf), seeded[leaf]))
		}
		const leafDrift = median(leafDrifts)
		assert.ok(hubDrift < leafDrift, `${name}：枢纽位移 ${hubDrift.toFixed(4)} 应小于叶子中位 ${leafDrift.toFixed(4)}`)

		// 有链接的叶子贴着枢纽，无关节点留在自己的团里。
		const linked = []
		const unrelated = []
		for (let index = 1; index <= 8; index += 1) linked.push(distance(layout.byId.get('file-' + index), hub))
		for (let index = 9; index < 21; index += 1) unrelated.push(distance(layout.byId.get('file-' + index), hub))
		assert.ok(median(linked) < median(unrelated) / 2, `${name}：有链接的叶子应明显更靠近枢纽`)
	}
})

test('两个布局收敛后停止：帧数有上限，tick 不再改动任何点', () => {
	const degrees = [...Array(90).keys()].map((index) => index % 9)
	const data = graph.canvasGraphData(clusteredGraph(['践行', '见闻', '复盘'], 30, degrees))

	for (const [name, layout] of [
		['星球图', new graph.SphereLayout(data.nodes, data.edges)],
		['关系图', new graph.NetworkLayout(data.nodes, data.edges)],
	]) {
		const frames = tickToSettle(layout)
		assert.ok(frames < 150, `${name}：应在 150 帧内收敛，实际 ${frames}`)
		const frozen = layout.particles.map((particle) => [particle.x, particle.y, particle.z])
		const alpha = layout.alpha
		for (let extra = 0; extra < 5; extra += 1) layout.tick()
		assert.equal(layout.alpha, alpha, `${name}：收敛后不应再消耗帧`)
		assert.deepEqual(layout.particles.map((particle) => [particle.x, particle.y, particle.z]), frozen, `${name}：收敛后 tick 不应移动点`)
	}
})

test('关系图与星球图的输入相同则输出逐位相同（确定性）', () => {
	const degrees = [...Array(90).keys()].map((index) => index % 9)
	const data = graph.canvasGraphData(clusteredGraph(['践行', '见闻', '复盘'], 30, degrees))
	for (const [name, create] of [
		['星球图', () => new graph.SphereLayout(data.nodes, data.edges)],
		['关系图', () => new graph.NetworkLayout(data.nodes, data.edges)],
	]) {
		const first = create()
		const second = create()
		for (let tick = 0; tick < 120; tick += 1) {
			first.tick()
			second.tick()
		}
		assert.deepEqual(
			first.particles.map((particle) => [particle.x, particle.y, particle.z]),
			second.particles.map((particle) => [particle.x, particle.y, particle.z]),
			`${name}：同输入两次布局应逐位一致`,
		)
	}
})

test('2000+ 节点：每帧的力计算留在预算内', () => {
	// Same shape as the live library: 2100 files, 3000 links, five communities.
	const count = 2100
	const linkCount = 3000
	const roots = ['践行', '见闻', '复盘', '觉察', '即兴']
	const tags = []
	for (let index = 0; index < count; index += 1) tags.push(roots[index % roots.length] + '/工作流')
	const degrees = new Array(count).fill(0)
	const edges = []
	for (let link = 0; link < linkCount; link += 1) {
		const from = (link * 17) % count
		const to = (link * 131 + 7) % count
		if (from === to) continue
		degrees[from] += 1
		edges.push({ from: 'file-' + from, to: 'file-' + to, w: 1 })
	}
	const data = graph.canvasGraphData({ nodes: nodesOf(degrees, tags), edges })
	assert.equal(data.nodes.length, count)
	assert.ok(data.edges.length >= 2900, `合成图应有约 3000 条边，实际 ${data.edges.length}`)

	for (const [name, layout] of [
		['星球图', new graph.SphereLayout(data.nodes, data.edges)],
		['关系图', new graph.NetworkLayout(data.nodes, data.edges)],
	]) {
		for (let warm = 0; warm < 5; warm += 1) layout.tick()
		const started = performance.now()
		for (let tick = 0; tick < 20; tick += 1) layout.tick()
		const perTick = (performance.now() - started) / 20
		// The live measurement is ~1.5 ms per tick; the cap leaves room for a
		// loaded CI box while still failing if the sweep goes quadratic.
		assert.ok(perTick < 12, `${name}：${count} 节点每帧 ${perTick.toFixed(2)}ms，超出预算 12ms`)
	}
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
		// 静止长度由两端的占位半径决定：链接的含义是"挨着"。
		assert.ok(link[0].clearance > 0 && link[1].clearance > 0, '每个点都带自己的占位半径')
		assert.ok(link[0].cluster === link[1].cluster, '留下的都是同团边')
	}
	const bridge = chord(sim.byId.get('file-0'), sim.byId.get('file-2'))
	assert.ok(bridge > 0.45, `这条桥在球面上确实很远，实际弦长 ${bridge.toFixed(3)}`)
})
