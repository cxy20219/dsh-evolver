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

	// The static contract (no `rebuild` call, no `refresh: true`, no snapshot /
	// index copy, no injection budget) is asserted with rendered coverage in
	// test/panel.test.mjs; this file only keeps the loader/registration smoke.
})

test('文件页左侧标签树：两栏布局、逐分支收起、文案齐全', async () => {
	const source = await readFile(join(ROOT, 'client.js'), 'utf8')
	// The tree lives in its own column; the list is placed against that column
	// rather than sharing the grid row, because two in-flow columns inflate each
	// other and the tree could then never make the row shorter.
	assert.match(source, /\.ysFilesLayout\{[^}]*display:grid/, '文件页是两栏 grid')
	assert.match(source, /\.ysFilesLayout\{[^}]*min-height:100%/, '不足一屏时撑满，不留空白')
	assert.match(source, /\.ysFilesMain\{position:absolute;left:208px;right:0;top:0;bottom:0/, '右栏脱离文档流，跟随左栏高度')
	assert.match(source, /@media\(max-width:900px\)\{\.ysFilesLayout\{[^}]*\}\.ysFilesMain\{left:162px\}\}/, '窄屏同时收窄两栏')
	// A toggle per branch, with the expand state exposed to assistive tech.
	assert.match(source, /function TagTree\(props\)/, '存在标签树组件')
	assert.match(source, /className: 'ysFileTagToggle'/, '每个分支有自己的收起按钮')
	assert.match(source, /'aria-expanded': isCollapsed \? 'false' : 'true'/, '收起状态反映在 aria-expanded 上')
	assert.match(source, /className: 'ysFileTagBtn' \+ \(active \? ' ysFileTagBtnActive' : ''\)/, '当前标签高亮')
	// The tree is fed by the same aggregation the overview and graph use.
	assert.match(source, /tags: overview === null \|\| overview === undefined \? \[\] : buildTagTree\(overview\.tags\)/, '文件页复用 buildTagTree 的聚合结果')
	// Both languages carry the new strings; a missing key renders the raw id.
	for (const key of ['files.tags', 'files.tagClear', 'files.tagEmpty']) {
		const hits = source.split(`'${key}':`).length - 1
		assert.equal(hits, 2, `${key} 中英文各一条`)
	}
})
