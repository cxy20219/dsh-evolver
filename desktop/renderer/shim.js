/*
 * Enough of the DSH client host for `client.js` to run outside DSH.
 *
 * The panel was written against four host services — a module loader, slots, a
 * locale registry and a connection — and it asks for them through `inject`,
 * exactly as any plugin does. Reimplementing those four is far cheaper than
 * rewriting 4,700 lines of UI that already work, and it keeps one panel for
 * both hosts instead of two that drift.
 *
 * What is *not* faked: the data. `callHost` reaches `/api/ziyan/<endpoint>`
 * with `fetch`, which the standalone server answers with the same handler the
 * plugin used. The shim decides where components render, never what they say.
 */
(function () {
	'use strict'

	var registry = { locale: {}, renders: [] }

	function makeTranslator(namespace) {
		return function t(key, params) {
			var dict = registry.locale[namespace] || {}
			var table = dict[navigator.language && navigator.language.indexOf('zh') === 0 ? 'zh' : 'en'] || dict.zh || {}
			var text = table[key]
			if (typeof text !== 'string') text = key
			if (params && typeof params === 'object') {
				text = text.replace(/\{(\w+)\}/g, function (match, name) {
					return params[name] === undefined ? match : String(params[name])
				})
			}
			return text
		}
	}

	/**
	 * The context handed to the panel's `apply`.
	 *
	 * `effect` runs the factory and remembers its cleanup; `slots.register`
	 * keeps the component and mounts it once the document is ready.
	 */
	function createContext() {
		var cleanups = []
		var context = {
			effect: function (factory, label) {
				var cleanup = factory()
				if (typeof cleanup === 'function') cleanups.push(cleanup)
				return function () {
					if (typeof cleanup === 'function') cleanup()
				}
			},
			locale: {
				register: function (namespace, dictionaries) {
					registry.locale[namespace] = dictionaries
					return function () { delete registry.locale[namespace] }
				},
				bind: makeTranslator,
			},
			slots: {
				// A slot injection is how a plugin says "I have something for this
				// position". Outside DSH there is one position — the whole window —
				// so the factory is simply run and whatever it registers is kept.
				inject: function (name, factory) {
					return factory() || function () {}
				},
				register: function (options, Component) {
					if (options && options.name === 'main') {
						registry.renders.push({ Component: Component, inject: options.inject })
					}
					return function () {}
				},
			},
			// `callHost` refuses to run unless a connection exists; the panel does
			// not use the object itself, it fetches the API directly.
			get: function (service) {
				return service === 'connection' ? {} : undefined
			},
			dispose: function () {
				while (cleanups.length > 0) {
					var cleanup = cleanups.pop()
					try { cleanup() } catch (_) { /* one bad cleanup must not block the rest */ }
				}
			},
		}
		return context
	}

	window.__ModuleLoader__ = {
		load: function (definition) {
			var factory = definition && definition.factory
			if (typeof factory !== 'function') throw new Error('模块缺少 factory')
			var module = factory(function require(name) {
				if (name === 'react') return window.React
				throw new Error('未知模块：' + name)
			})
			var context = createContext()
			if (Array.isArray(module.inject) === false && module.inject !== undefined) {
				// Nothing to assert: the shim provides every service the panel
				// declares, so an empty list and a full one behave the same.
			}
			module.apply(context)
			window.__ziyanPanel = {
				renders: registry.renders,
				dispose: context.dispose,
			}
		},
	}

	/**
	 * Mount the panel into `#root` once the panel registered itself.
	 *
	 * The panel mounts its own top-level cards, so this only provides the React
	 * root and the full-height container; layout belongs to the panel's CSS.
	 */
	window.__mountZiyan = function (root) {
		var renders = (window.__ziyanPanel && window.__ziyanPanel.renders) || []
		if (renders.length === 0) {
			root.textContent = '面板没有注册任何视图。'
			return
		}
		var target = renders[0]
		var props = typeof target.inject === 'function' ? target.inject() : {}
		window.ReactDOM.createRoot(root).render(window.React.createElement(target.Component, props))
	}
})()
