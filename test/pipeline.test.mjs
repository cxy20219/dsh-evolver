/**
 * The memory pipeline end to end: one daily run leaves behind the two things
 * the injection layer needs — a repaired link graph and an importance
 * snapshot — and the prompt then reads that snapshot.
 *
 * The pieces are unit-tested on their own; this file pins that they are
 * actually wired together in `performRun`, which is the part no single module
 * can promise.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readCardIndex } from '../src/cards/injection-index.js'
import { CardStore } from '../src/cards/store.js'
import { cardIndexText } from '../src/cards/prompt.js'
import { createConsolidationController } from '../src/consolidate.js'
import { defaultConsolidate, defaultSettings } from '../src/settings.js'

/** A fixed clock, so the snapshot day is reproducible. */
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0)

/** How many cards the fixture puts in one branch. */
const BRANCH_CARDS = 6

const modelSelection = { currentSelection: () => ({ provider: 'p', model: 'm' }) }

/**
 * A model stub that never proposes an action.
 *
 * The pipeline must build repairs and the snapshot without the model doing
 * anything: those are bookkeeping, not judgement.
 *
 * @returns {object} The `llm` service.
 */
function silentModel() {
	return {
		async *stream() {
			yield { type: 'text-delta', text: '{"actions":[]}' }
			yield { type: 'finish', reason: { kind: 'stop' } }
		},
	}
}

/**
 * A store with one branch big enough to enter the hot index.
 *
 * @returns {Promise<{dir: string, store: CardStore}>} The fixture.
 */
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), 'evr-pipeline-'))
	const store = new CardStore({ dataDir: dir })
	await store.init()
	const ids = []
	for (let index = 0; index < BRANCH_CARDS; index += 1) {
		const card = await store.put({ body: `行动卡片 ${index}`, tags: ['践行/工作流'] })
		ids.push(card.id)
	}
	// A link gives the branch score something to rank by in-degree.
	await store.put({ ...store.get(ids[0]), links: [ids[2]] })
	await store.put({ body: '一张即兴卡', tags: ['即兴'] })
	// A few more branches so the documented map no longer fits a tight budget;
	// that is what switches injection to the importance index.
	for (const tag of ['见闻/git', '见闻/网络', '见闻/事实', '复盘/踩坑', '复盘/纠正', '觉察/偏好', '试错/踩坑', '践行/经验']) {
		await store.put({ body: `${tag} 的一条记录`, tags: [tag] })
	}
	return { dir, store, ids }
}

test('一次整理运行同时留下修复和索引快照，注入用得上', async () => {
	const { dir, store } = await fixture()
	try {
		const state = { ...defaultSettings(), consolidate: { ...defaultConsolidate(), enabled: true } }
		const settings = {
			get: () => state,
			update: async (patch) => {
				if (patch.consolidate !== undefined) state.consolidate = { ...state.consolidate, ...patch.consolidate }
				return state
			},
		}
		const controller = createConsolidationController({
			settings,
			store: () => store,
			llm: silentModel(),
			modelSelection,
			logger: { warn() {}, info() {} },
			now: () => NOW,
		})
		const result = await controller.run()
		assert.equal(result.success, true)
		assert.equal(typeof result.repairs.repaired, 'number')

		// 1. 快照：关系最多的卡与结构摘要在快照里，当天有效。
		const index = await readCardIndex(store, NOW)
		assert.notEqual(index, null)
		assert.ok(index.topCards.length > 0)
		assert.match(index.summary, /共 \d+ 张卡/)
		assert.match(index.summary, /践行/)

		// 2. 注入：紧预算下卡片索引与结构摘要都在。
		const injected = cardIndexText(store, 700)
		assert.match(injected, /\[卡片索引\]/)
		assert.match(injected, /\[知识结构\]/)
		assert.match(injected, /践行/)

		// 3. 再跑一次不会丢快照，也不会让内容漂移。
		const again = await controller.run()
		assert.equal(again.success, true)
		assert.deepEqual((await readCardIndex(store, NOW)).topCards, index.topCards)
	} finally {
		await store.close()
		await rm(dir, { recursive: true, force: true })
	}
})
