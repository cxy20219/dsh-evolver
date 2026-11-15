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

import { descriptionAdvice } from '../meta.js'
import { LAYERS, OVERVIEW, REFERENCED_LAYERS, REQUIRED_INDEX_TEXT, TOOL_LAYER, catalog, indexRefs, renderIndex } from './store.js'
import { sidecarRelative } from './sidecar.js'

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

/** How long probing for an interpreter may take. */
const PYTHON_PROBE_TIMEOUT_MS = 20_000

/**
 * How long one file's syntax check may take.
 *
 * A syntax check is a compile in memory: it either finishes in tens of
 * milliseconds or the interpreter is wedged. Waiting the probe's 20s for every
 * file turns one stuck interpreter into a minute-long `file_write`
 * (stability audit P3), so a per-file check gets a much shorter deadline and
 * reports itself as skipped instead of failing the write.
 */
export const PYTHON_CHECK_TIMEOUT_MS = 5_000

/** How many Python checks may run at once. */
export const PYTHON_CONCURRENCY = 4

/** How much a single check's stderr/stdout may hold before it is dropped. */
export const PYTHON_MAX_OUTPUT_BYTES = 64 * 1024

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
			await run(candidate, ['-c', 'pass'], { timeout: PYTHON_PROBE_TIMEOUT_MS, windowsHide: true })
			detectedPython = candidate
			break
		} catch {
			// The next candidate may be the one this host has.
		}
	}
	return detectedPython
}

/**
 * Run async workers over a list with a concurrency ceiling.
 *
 * Results are written by index, so callers keep a deterministic report order
 * even though the work runs in parallel.
 *
 * @template T, R
 * @param {T[]} items - The work items.
 * @param {number} limit - The most workers allowed at once.
 * @param {(item: T, index: number) => Promise<R>} worker - The work.
 * @returns {Promise<R[]>} Results in input order.
 */
async function pooled(items, limit, worker) {
	const results = new Array(items.length)
	let cursor = 0
	const lanes = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
		for (;;) {
			const index = cursor
			cursor += 1
			if (index >= items.length) return
			results[index] = await worker(items[index], index)
		}
	})
	await Promise.all(lanes)
	return results
}

/**
 * Whether a child-process failure is a deadline, not a result.
 *
 * `execFile` reports a timeout by killing the child: the error carries
 * `killed`/`signal` and no usable exit code, which must not be read as "the
 * syntax is wrong".
 *
 * @param {unknown} error - The thrown value.
 * @returns {boolean} True when the check ran out of time.
 */
function isTimeout(error) {
	// A normal non-zero exit also carries `signal: null`, so only a real
	// signal name counts; a deadline kills the child, which is `killed`.
	return error?.killed === true || typeof error?.signal === 'string' || error?.code === 'ETIMEDOUT'
}

/**
 * Check one Python file's syntax without letting the failure mode be silent.
 *
 * @param {(command: string, args: string[], options: object) => Promise<unknown>} runner - The child-process runner.
 * @param {string} interpreter - The interpreter command.
 * @param {string} relative - The project-relative path (for the report).
 * @param {string} absolute - The absolute path to compile.
 * @returns {Promise<{skipped?: string, error?: string}>} What to report.
 */
async function checkPython(runner, interpreter, relative, absolute) {
	try {
		await runner(interpreter, ['-c', PYTHON_COMPILE, absolute], {
			timeout: PYTHON_CHECK_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: PYTHON_MAX_OUTPUT_BYTES,
		})
		return {}
	} catch (error) {
		if (error?.code === 'ENOENT') {
			return { skipped: `Python 解释器 ${interpreter} 不可用，已跳过语法校验。` }
		}
		if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
			return { skipped: `Python 语法校验输出超过 ${PYTHON_MAX_OUTPUT_BYTES} 字节上限，已跳过。` }
		}
		if (isTimeout(error)) {
			return { skipped: `Python 语法校验超时（${PYTHON_CHECK_TIMEOUT_MS}ms），已跳过。` }
		}
		const message = error instanceof Error ? error.message : String(error)
		return { error: `${relative} 的 Python 语法不通过：${message.split('\n').slice(0, 3).join(' ')}` }
	}
}

/**
 * Check one harness folder.
 *
 * @param {string} root - The project root.
 * @param {{python?: string | null, runner?: (command: string, args: string[], options: object) => Promise<unknown>}} [options] - `python` overrides interpreter detection (`null` forces skip; for tests); `runner` replaces the child-process call (for tests).
 * @returns {Promise<{ok: boolean, errors: string[], warnings: string[], checked: number, skipped: {path: string, reason: string}[]}>} The report.
 */
export async function validate(root, { python, runner } = {}) {
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
		if (mode === 'handwritten') {
			errors.push('AGENTS.md 是手写文档，不是 harness 索引；把里面的内容搬进 harness/harness.md 后重新写一次 harness 资源，插件会按目录重建索引（手写版本会先被备份）。')
		} else {
			for (const required of REQUIRED_INDEX_TEXT) {
				if (!text.includes(required)) {
					errors.push(`AGENTS.md 的索引不符合 harness 模板，缺少：${required}`)
				}
			}
			// The index is derived from the folder: if the two disagree, the
			// file was edited by hand or the folder changed without a write.
			const expected = `${renderIndex(state).trimEnd()}\n`
			if (text.replace(/\r\n/g, '\n') !== expected) {
				errors.push('AGENTS.md 与 harness/ 不一致：索引必须由目录生成（再写一次 harness 资源即可重建）。')
			}
			for (const ref of state.index.stale) errors.push(`AGENTS.md 索引了不存在的资源：${ref}`)
			for (const ref of state.index.missing) errors.push(`AGENTS.md 没有索引已有资源：${ref}`)
			if (text.includes('/xxx')) errors.push('AGENTS.md 里还留着 harness/xxx 占位索引。')
		}
	}

	for (const resource of state.resources) {
		// A resource without a description is still indexed — the folder is
		// the truth — but the reader has nothing to search by, so it is
		// reported. The write path requires a description for the resource it
		// writes; this check catches the ones that were already there.
		if (resource.description === '') {
			warnings.push(`${resource.path} 缺少描述：写一句「它是什么 + 以后哪些场景/任务会用到它」到 ${sidecarRelative(resource.path)}。`)
			continue
		}
		const advice = descriptionAdvice(resource.description)
		if (advice !== '') warnings.push(`${resource.path} 的描述 ${advice}`)
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

	// Every tool or resource is described, so the index already says what it
	// is for. The old evolver demanded more — a workflow document naming the
	// file, with a representative command and a 验证 marker — because the index
	// of that day could not describe a script at all. That demand is kept, but
	// as a warning: a resource whose description says when it is needed is
	// reachable, and a script that cannot be written before its document
	// exists is a rule about order, not about correctness.
	for (const layer of REFERENCED_LAYERS) {
		for (const path of state.layers[layer] ?? []) {
			const documented = await documentedBy(root, state, path)
			if (documented === undefined) {
				warnings.push(`${path} 没有被任何 harness/{workflow,experience}/*.md 文档覆盖；它的描述已经进索引，但一篇说明它的文档更好用。`)
			} else if (documented.command === false) {
				warnings.push(`${path} 在文档条目里没有围栏代码块中的代表性命令。`)
			} else if (documented.marker === false) {
				warnings.push(`${path} 在文档条目里没有“验证”标记。`)
			}
		}
	}

	// Python syntax is the only check that needs a child process. It runs as a
	// bounded pool: a project with many scripts would otherwise pay one
	// sequential process per file (10 scripts ≈ 1.3s on Windows; stability
	// audit P3), and one wedged interpreter must not be able to hold the whole
	// write past its deadline.
	const interpreter = python === undefined ? await detectPython() : python
	const pythonFiles = (state.layers[TOOL_LAYER] ?? []).filter((path) => path.endsWith('.py'))
	if (interpreter === null || interpreter === '') {
		for (const path of pythonFiles) {
			skipped.push({ path, reason: '找不到可用的 Python 解释器（python3/python/py），已跳过语法校验。' })
		}
	} else {
		const runPython = runner ?? run
		const outcomes = await pooled(pythonFiles, PYTHON_CONCURRENCY, (path) => (
			checkPython(runPython, interpreter, path, join(root, path))
		))
		for (const [index, outcome] of outcomes.entries()) {
			const path = pythonFiles[index]
			if (outcome.skipped !== undefined) skipped.push({ path, reason: outcome.skipped })
			else if (outcome.error !== undefined) errors.push(outcome.error)
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
