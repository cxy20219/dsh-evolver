import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { dayKey, indexText, readIndex, refreshIndex } from '../src/injection.js'
import { FileStore } from '../src/store.js'
import { tempDir } from './helpers.mjs'

/**
 * Run one test against a fresh store.
 *
 * @param {(store: FileStore, dir: string) => Promise<void>} body - The test.
 * @returns {Promise<void>} Resolves when done.
 */
async function withStore(body) {
	const dir = await tempDir()
	const store = new FileStore({ dataDir: dir })
	await store.open()
	try {
		await body(store, dir)
	} finally {
		store.close()
		await rm(dir, { recursive: true, force: true })
	}
}

test('快照：12 个文件、当天、写在数据目录内；写文件不改注入，重建后才改', async () => {
	await withStore(async (store, dir) => {
		const ids = []
		for (let index = 0; index < 13; index += 1) {
			const file = await store.create({
				name: `note-${index}.md`,
				description: `第 ${index} 份笔记：注入快照测试`,
				content: '正文',
				tags: ['测试/注入'],
				links: index > 0 ? [ids[index - 1]] : [],
			})
			ids.push(file.id)
		}

		const first = await refreshIndex(store)
		assert.equal(first.wrote, true)
		const snapshot = await readIndex(store)
		assert.equal(snapshot.day, dayKey())
		assert.equal(snapshot.top.length, 12)
		assert.equal(snapshot.summary.files, 13)
		assert.equal(snapshot.summary.links, 12)
		assert.equal((await readFile(join(dir, 'system', 'index.json'), 'utf8')).length > 0, true)

		const before = await indexText(store)
		assert.ok(before.includes('共 13 个文件'))
		assert.ok(Buffer.byteLength(before, 'utf8') <= 4096)

		await store.create({
			name: 'new.md',
			description: '新写入的文件，不该立刻出现在注入里',
			content: '正文',
			tags: ['测试/注入'],
		})
		assert.equal(await indexText(store), before)
		assert.ok((await readIndex(store)).summary.files === 13)

		const second = await refreshIndex(store)
		assert.equal(second.wrote, true)
		const after = await indexText(store)
		assert.ok(after.includes('共 14 个文件'))
		assert.notEqual(after, before)

		const third = await refreshIndex(store)
		assert.equal(third.wrote, false)
	})
})

test('快照超预算时先丢描述，再减行，摘要保留', async () => {
	await withStore(async (store) => {
		for (let index = 0; index < 12; index += 1) {
			await store.create({
				name: `note-${index}.md`,
				description: `${'很长的描述'.repeat(20)} ${index}`,
				content: '正文',
				tags: ['测试/预算'],
			})
		}
		await refreshIndex(store)
		const tight = await indexText(store, 300)
		assert.ok(Buffer.byteLength(tight, 'utf8') <= 300)
		assert.match(tight, /共 12 个文件/)
		assert.ok(!tight.includes('很长的描述'))
	})
})

test('空库给出可执行的下一步', async () => {
	await withStore(async (store) => {
		const text = await indexText(store)
		assert.match(text, /库是空的/)
		assert.match(text, /file_write/)
	})
})
