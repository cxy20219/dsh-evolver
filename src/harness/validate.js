/**
 * Structural checks for a `harness/` folder.
 *
 * These are the same rules the skill enforced with a Python script, ported so
 * the plugin does not need a second runtime. They are deliberately mechanical:
 * whether a resource is *good* is a judgement, whether the index matches the
 * folder is not.
 */

import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

import { LAYERS, OVERVIEW, REFERENCED_LAYERS, REQUIRED_INDEX_TEXT, TOOL_LAYER, catalog, indexRefs } from './store.js'

const run = promisify(execFile)

/** A document entry that names the script, quotes a command and says 验证. */
const VALIDATION_MARKER = /(?:^|\n)\s*(?:#{1,6}\s*)?验证(?:\s|$|[:：])/
const FENCED_BLOCK = /```[^\n]*\n([\s\S]*?)```/g

/**
 * Check one harness folder.
 *
 * @param {string} root - The project root.
 * @returns {Promise<{ok: boolean, errors: string[], warnings: string[], checked: number}>} The report.
 */
export async function validate(root) {
	const errors = []
	const warnings = []
	const state = await catalog(root)

	if (!state.present) {
		errors.push('missing harness/')
		return { ok: false, errors, warnings, checked: 0 }
	}
	for (const name of state.unexpected) errors.push(`unexpected harness top-level entry: harness/${name}`)
	if (!state.overview) errors.push(`missing harness/${OVERVIEW}`)
	for (const layer of LAYERS) {
		if (!state.layers[layer] || state.layers[layer].length === 0) {
			const missing = state.missing.includes(layer)
			if (missing) errors.push(`missing harness/${layer}/`)
		}
	}

	if (!state.agents) {
		errors.push('missing AGENTS.md')
	} else {
		const text = await readFile(join(root, 'AGENTS.md'), 'utf8').catch(() => '')
		for (const required of REQUIRED_INDEX_TEXT) {
			if (!text.includes(required)) {
				errors.push(`AGENTS.md does not follow required harness template; missing: ${required}`)
			}
		}
		for (const ref of state.index.stale) errors.push(`AGENTS.md indexes missing resource: ${ref}`)
		for (const ref of state.index.missing) errors.push(`AGENTS.md does not index existing resource: ${ref}`)
		if (text.includes('/xxx')) errors.push('AGENTS.md still contains placeholder harness/xxx index entries')
	}

	for (const resource of state.resources) {
		if (resource.summary === '') {
			warnings.push(`${resource.path} has no summary: frontmatter; the index will show a placeholder`)
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
			if (!(await exists(join(root, ref)))) errors.push(`${path} references missing resource: ${ref}`)
		}
	}

	for (const layer of REFERENCED_LAYERS) {
		for (const path of state.layers[layer] ?? []) {
			const documented = await documentedBy(root, state, path)
			if (documented === undefined) {
				errors.push(`${path} is not documented by any harness/{workflow,experience}/*.md`)
			} else if (documented.command === false) {
				errors.push(`${path} has no fenced representative command in its harness/{workflow,experience}/*.md entry`)
			} else if (documented.marker === false) {
				errors.push(`${path} has no 验证 marker in its harness/{workflow,experience}/*.md entry`)
			}
		}
	}

	for (const path of state.layers[TOOL_LAYER] ?? []) {
		if (!path.endsWith('.py')) continue
		try {
			// Compile in memory: `-m py_compile` writes a __pycache__ folder
			// into the project, which is a side effect a validator must not have.
			await run('python3', ['-c', 'import sys; compile(open(sys.argv[1], "rb").read(), sys.argv[1], "exec")', join(root, path)], { timeout: 20_000 })
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			errors.push(`${path} does not compile: ${message.split('\n').slice(0, 3).join(' ')}`)
		}
	}

	return { ok: errors.length === 0, errors, warnings, checked: state.resources.length }
}

/**
 * Whether a path exists.
 *
 * @param {string} path - The path.
 * @returns {Promise<boolean>} True when it does.
 */
async function exists(path) {
	try {
		await readFile(path)
		return true
	} catch {
		return false
	}
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

/**
 * List every file under one folder, relative to the project.
 *
 * @param {string} root - The project root.
 * @param {string} folder - The absolute folder.
 * @returns {Promise<string[]>} The relative paths.
 */
export async function listFiles(root, folder) {
	const entries = await readdir(folder, { recursive: true }).catch(() => [])
	return entries.map((entry) => join(folder, String(entry)).slice(root.length + 1).split('\\').join('/')).sort()
}
