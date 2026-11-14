import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('客户端文件可加载：注册字典、样式、主面板与侧边栏', async () => {
	const source = await readFile(join(ROOT, 'client.js'), 'utf8')
	let registration
	const appended = []
	const window = {
		__ModuleLoader__: {
			load(config) {
				registration = config
			},
		},
	}
	const document = {
		createElement() {
			return { dataset: {}, textContent: '', remove() {} }
		},
		head: {
			appendChild(node) {
				appended.push(node)
			},
		},
	}
	const evaluate = new Function('window', 'document', source)
	evaluate(window, document)
	assert.ok(registration, 'client 调用了 __ModuleLoader__.load')
	assert.equal(registration.id, 'dsh-ziyan')

	const react = {
		createElement() {
			return null
		},
		Component: function Component() {},
		useState(value) {
			return [value, function () {}]
		},
		useEffect() {},
		useCallback(fn) {
			return fn
		},
		useMemo(fn) {
			return fn()
		},
		useRef(value) {
			return { current: value }
		},
	}
	const module = registration.factory(function (name) {
		assert.equal(name, 'react')
		return react
	})
	assert.deepEqual(module.inject, ['slots', 'locale', 'connection'])

	const registered = []
	const ctx = {
		effect(effect) {
			effect()
			return function () {}
		},
		locale: {
			register(namespace, dictionaries) {
				registered.push(['locale', namespace, dictionaries])
				return function () {}
			},
			bind() {
				return function (key) {
					return key
				}
			},
		},
		slots: {
			inject(name, callback) {
				callback()
				return function () {}
			},
			register(spec) {
				registered.push(['register', spec.name, spec.id || spec.key])
				return function () {}
			},
		},
	}
	module.apply(ctx)
	assert.equal(appended.length, 1, '注入了一份样式')
	const panel = registered.find((item) => item[0] === 'register' && item[1] === 'main')
	const sidebar = registered.find((item) => item[0] === 'register' && item[1] === 'sidebar.panellist')
	assert.deepEqual(panel, ['register', 'main', 'ziyan'])
	assert.deepEqual(sidebar, ['register', 'sidebar.panellist', 'ziyan'])
	const dictionary = registered.find((item) => item[0] === 'locale')
	assert.equal(dictionary[1], 'dsh-ziyan')
	assert.ok(dictionary[2].zh && dictionary[2].zh.panel)
	assert.ok(dictionary[2].en && dictionary[2].en.panel)

	// The panel no longer performs manual maintenance and no longer renders a
	// runtime index at all. Nothing may call `rebuild`, and the injection read
	// never asks for a refresh.
	assert.doesNotMatch(source, /call\(\s*'rebuild'/, '不再调用 rebuild')
	assert.doesNotMatch(source, /refresh\s*:\s*true/, '不再请求重建快照')
	assert.doesNotMatch(source, /重建索引|重建快照/, '不再有手动维护按钮文案')
	assert.doesNotMatch(source, /injectionBudget/, '不再有注入预算设置')
})
