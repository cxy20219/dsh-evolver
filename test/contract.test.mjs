import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ENDPOINTS } from '../src/remote.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The domain modules whose `Record<endpoint, handler>` tables make up the API. */
const DOMAIN_MODULES = ['files.js', 'panel.js', 'organize.js', 'data.js']

test('接口两处对齐：handler 表派生的 ENDPOINTS 与 client 调用同集合', async () => {
	const keys = []
	for (const name of DOMAIN_MODULES) {
		const source = await readFile(join(ROOT, 'src', 'remote', name), 'utf8')
		for (const match of source.matchAll(/^\t'?([a-z][a-z-]*)'?: async \(/gm)) keys.push(match[1])
	}
	assert.equal(keys.length, new Set(keys).size, '接口表里没有重复端点')
	const client = await readFile(join(ROOT, 'client.js'), 'utf8')
	const calls = [...client.matchAll(/\bcall\(\s*'([a-z-]+)'/g)].map((match) => match[1])
	assert.deepEqual([...new Set(keys)].sort(), [...ENDPOINTS].sort(), 'handler 表与 ENDPOINTS')
	assert.deepEqual([...new Set(calls)].sort(), [...ENDPOINTS].sort(), 'client 调用与 ENDPOINTS')
})

test('客户端注册 id、前缀与注入依赖一致', async () => {
	const client = await readFile(join(ROOT, 'client.js'), 'utf8')
	assert.match(client, /id: 'dsh-ziyan'/)
	assert.match(client, /var API_PREFIX = '\/api\/ziyan'/)
	assert.match(client, /var inject = \['slots', 'locale', 'connection'\]/)
})
