import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ENDPOINTS } from '../src/remote.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('接口三处对齐：ENDPOINTS、switch、client 调用同集合', async () => {
	const remote = await readFile(join(ROOT, 'src', 'remote.js'), 'utf8')
	const client = await readFile(join(ROOT, 'client.js'), 'utf8')
	const cases = [...remote.matchAll(/case '([a-z-]+)':/g)].map((match) => match[1])
	const calls = [...client.matchAll(/\bcall\(\s*'([a-z-]+)'/g)].map((match) => match[1])
	assert.deepEqual([...new Set(cases)].sort(), [...ENDPOINTS].sort(), 'switch 与 ENDPOINTS')
	assert.deepEqual([...new Set(calls)].sort(), [...ENDPOINTS].sort(), 'client 调用与 ENDPOINTS')
})

test('客户端注册 id、前缀与注入依赖一致', async () => {
	const client = await readFile(join(ROOT, 'client.js'), 'utf8')
	assert.match(client, /id: 'dsh-yuanshi'/)
	assert.match(client, /var API_PREFIX = '\/api\/yuanshi'/)
	assert.match(client, /var inject = \['slots', 'locale', 'connection'\]/)
})
