/**
 * Structural checks for a `harness/` folder.
 *
 * These are the same rules the old evolver skill enforced with a Python script,
 * ported so the plugin does not need a second runtime. They are deliberately
 * mechanical: whether a resource is *good* is a judgement, whether the index
 * matches the folder is not.
 *
 * Python syntax is the only check that needs an external interpreter. A host
 * without one is normal (Windows ships none), so a missing interpreter skips
 * the check and says so in `skipped` instead of failing a write that is
 * otherwise fine.
 */

import { execFile } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { LAYERS, OVERVIEW, REFERENCED_LAYERS, REQUIRED_INDEX_TEXT, TOOL_LAYER, catalog, indexRefs, inspectIndex } from './store.js'

const run = promisify(execFile)

/**
 * The interpreters to try, in order.
 *
 * Windows ships the `py` launcher, not `python3`; probing `py` first also
 * avoids the Microsoft Store `python.exe` stub, which is not an interpreter.
 */
const PYTHON_CANDIDATES = process.platform === 'win32'
	? ['py', 'python', 'python3']
	: ['python3', 'python']

/** Compile in memory: `-m py_compile` would write a `__pycache__` folder. */
const PYTHON_COMPILE = 'import sys; compile(open(sys.argv[1], "rb").read(), sys.argv[1], "exec")'

/** How long one Python probe may take. */
const PYTHON_TIMEOUT_MS = 20_000

/** A document entry that names the script, quotes a command and says 验证. */
const VALIDATION_MARKER = /(?:^|\n)\s*(?:#{1,6}\s*)?验证(?:\s|$|[:：])/
const FENCED_BLOCK = /```[^\n]*\n([\s\S]*?)```/g

/**
 * Which interpreter this host has, detected once per process.
 *
 * `undefined` means "not asked yet", `null` means "none of the candidates ran".
 *
 * @returns {Promise<string | null>} The command, or null.
 */
let detectedPython
async function detectPython() {
	if (detectedPython !== undefined) return detectedPython
	detectedPython = null
	for (const candidate of PYTHON_CANDIDATES) {
		try {
			await run(candidate, ['-c', 'pass'], { timeout: PYTHON_TIMEOUT_MS, windowsHide: true })
			detectedPython = candidate
			break
		} catch {
			// The next candidate may be the one this host has.
		}
	}
	return detectedPython
}

/**
 * Check one harness folder.
 *
 * @param {string} root - The project root.
 * @param {{python?: string | null}} [options] - `python` overrides interpreter detection (`null` forces skip; for tests).
 * @returns {Promise<{ok: boolean, errors: string[], warnings: string[], checked: number, skipped: {path: string, reason: string}[]}>} The report.
 */
export async function validate(root, { python } = {}) {
	const errors = []
	const warnings = []
	const skipped = []
	const state = await catalog(root)

	if (!state.present) {
		errors.push('缺少 harness/ 目录。')
		return { ok: false, errors, warnings, checked: 0, skipped }
	}
	for (const name of state.unexpected) errors.push(`harness/ 下有多余的顶层条目：harness/${name}`)
	if (!state.overview) errors.push(`缺少 harness/${OVERVIEW}。`)
	for (const layer of LAYERS) {
		if (!state.layers[layer] || state.layers[layer].length === 0) {
			const missing = state.missing.includes(layer)
			if (missing) errors.push(`缺少 harness/${layer}/ 目录。`)
		}
	}

	if (!state.agents) {
		errors.push('缺少 AGENTS.md。')
	} else {
		const text = await readFile(join(root, 'AGENTS.md'), 'utf8').catch(() => '')
		const mode = state.index.mode
		if (mode === 'broken') {
			errors.push('AGENTS.md 的 harness 受管块标记不完整（缺 begin 或 end）；请手工补全或删掉残留标记，工具不会猜测覆盖。')
		} else if (mode === 'absent') {
			errors.push('AGENTS.md 里还没有受管索引块；运行 project_harness_catalog({init:true}) 或写入资源时会自动补上，块外内容不动。')
		} else {
			if (mode === 'legacy') {
				warnings.push('AGENTS.md 还是旧式裸索引（没有受管块）；下次写入会自动改造成受管块。')
			}
			// `legacy` means the whole file is the old index; `block` means only
			// the managed part is. Prose outside the block is never checked as
			// an index.
			const indexText = mode === 'block' ? inspectIndex(text).inner : text
			for (const required of REQUIRED_INDEX_TEXT) {
				if (!indexText.includes(required)) {
					errors.push(`AGENTS.md 的索引块不符合 harness 模板，缺少：${required}`)
				}
			}
			for (const ref of state.index.stale) errors.push(`AGENTS.md 索引了不存在的资源：${ref}`)
			for (const ref of state.index.missing) errors.push(`AGENTS.md 没有索引已有资源：${ref}`)
			if (indexText.includes('/xxx')) errors.push('AGENTS.md 里还留着 harness/xxx 占位索引。')
		}
	}

	for (const resource of state.resources) {
		if (resource.summary === '') {
			warnings.push(`${resource.path} 缺少 summary: frontmatter，索引里会显示占位符。`)
		}
	}

	// Every `harness/...` path a document names has to exist. A workflow that
	// says `python3 harness/tool/x.py` after `x.py` moved is worse than no
	// workflow at all: it looks authoritative and fails.
	const documents = [`harness/${OVERVIEW}`, ...(state.layers.workflow ?? []), ...(state.layers.experience ?? [])]
	const documentsInResources = (state.layers.resources ?? []).filter((path) => path.endsWith('.md'))
	for (const path of [...documents, ...documentsInResources]) {
		const text = await readFile(join(root, path), 'utf8').catch(() => '')
		for (const ref of indexRefs(text)) {
			if (ref === `harness/${OVERVIEW}`) continue
			if (!(await exists(join(root, ref)))) errors.push(`${path} 引用了不存在的资源：${ref}`)
		}
	}

	for (const layer of REFERENCED_LAYERS) {
		for (const path of state.layers[layer] ?? []) {
			const documented = await documentedBy(root, state, path)
			if (documented === undefined) {
				errors.push(`${path} 没有被任何 harness/{workflow,experience}/*.md 文档覆盖。`)
			} else if (documented.command === false) {
				errors.push(`${path} 在文档条目里没有围栏代码块中的代表性命令。`)
			} else if (documented.marker === false) {
				errors.push(`${path} 在文档条目里没有“验证”标记。`)
			}
		}
	}

	const interpreter = python === undefined ? await detectPython() : python
	for (const path of state.layers[TOOL_LAYER] ?? []) {
		if (!path.endsWith('.py')) continue
		if (interpreter === null || interpreter === '') {
			skipped.push({ path, reason: '找不到可用的 Python 解释器（python3/python/py），已跳过语法校验。' })
			continue
		}
		try {
			await run(interpreter, ['-c', PYTHON_COMPILE, join(root, path)], { timeout: PYTHON_TIMEOUT_MS, windowsHide: true })
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (error?.code === 'ENOENT') {
				skipped.push({ path, reason: `Python 解释器 ${interpreter} 不可用，已跳过语法校验。` })
				continue
			}
			errors.push(`${path} 的 Python 语法不通过：${message.split('\n').slice(0, 3).join(' ')}`)
		}
	}

	return { ok: errors.length === 0, errors, warnings, checked: state.resources.length, skipped }
}

/**
 * Whether a path is an existing file.
 *
 * @param {string} path - The path.
 * @returns {Promise<boolean>} True when it is a readable file.
 */
async function exists(path) {
	const info = await lstat(path).catch(() => undefined)
	return info !== undefined && info.isFile()
}

/**
 * Find the document that covers one script or asset.
 *
 * @param {string} root - The project root.
 * @param {object} state - The catalog.
 * @param {string} path - The resource path.
 * @returns {Promise<{command: boolean, marker: boolean} | undefined>} What the entry carries.
 */
async function documentedBy(root, state, path) {
	let mentioned = false
	let sawCommand = false
	let sawMarker = false
	for (const layer of ['workflow', 'experience']) {
		for (const doc of state.layers[layer] ?? []) {
			const text = await readFile(join(root, doc), 'utf8').catch(() => '')
			if (!text.includes(path)) continue
			mentioned = true
			const blocks = [...text.matchAll(FENCED_BLOCK)].map((match) => match[1])
			if (blocks.some((block) => block.includes(path))) sawCommand = true
			if (VALIDATION_MARKER.test(text)) sawMarker = true
			// One entry that carries both is all the contract asks for; every
			// other document mentioning the script does not weaken it.
			if (sawCommand && sawMarker) return { command: true, marker: true }
		}
	}
	if (!mentioned) return undefined
	return { command: sawCommand, marker: sawMarker }
}
