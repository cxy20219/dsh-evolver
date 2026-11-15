/**
 * Resource metadata: the sidecar next to every harness file.
 *
 * The library keeps a file's metadata in `meta.json` beside its payload; the
 * harness keeps the same shape. Every resource under `harness/` owns a
 * `<file>.meta.json` holding its title and the one-line description the
 * project's `AGENTS.md` index shows.
 *
 * The sidecar is the fact and the index is derived from it. That is what lets
 * `AGENTS.md` be a generated file: rebuilding it cannot lose anything,
 * because the words live next to the file they describe — and it is also what
 * makes a non-document resource (a script, a template, a fixture) describable
 * at all, since there is nowhere inside a `.py` or a `.png` to put a sentence.
 *
 * The description contract is the library's own: one line saying what the file
 * is and which situations will need it, length-capped, never a placeholder.
 * A harness resource and a library file are therefore retrieved the same way.
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeFileAtomic } from '../atomic.js'
import { assertDescription, descriptionAdvice, normalizeDescription } from '../meta.js'

/** The suffix a resource's metadata file carries. */
export const SIDECAR_SUFFIX = '.meta.json'

/** The sidecar schema version. */
export const SIDECAR_SCHEMA = 1

/** The longest a title may be. */
export const MAX_TITLE_CHARS = 80

/**
 * Whether a file name is a sidecar rather than a resource.
 *
 * @param {string} name - The file name.
 * @returns {boolean} True when it is metadata.
 */
export function isSidecarName(name) {
	return String(name ?? '').endsWith(SIDECAR_SUFFIX)
}

/**
 * The project-relative path of a resource's sidecar.
 *
 * @param {string} relative - The resource's path, e.g. `harness/tool/x.mjs`.
 * @returns {string} The sidecar's path.
 */
export function sidecarRelative(relative) {
	return `${String(relative ?? '')}${SIDECAR_SUFFIX}`
}

/**
 * The absolute path of a resource's sidecar.
 *
 * @param {string} root - The project root.
 * @param {string} relative - The resource's path.
 * @returns {string} The absolute sidecar path.
 */
export function sidecarPath(root, relative) {
	return join(root, ...sidecarRelative(relative).split('/'))
}

/**
 * Collapse a title to the single line a sidecar can carry.
 *
 * @param {unknown} value - The proposed title.
 * @returns {string} The clean title.
 */
export function normalizeTitle(value) {
	const clean = String(value ?? '').replace(/[\r\n\u0000]+/g, ' ').replace(/\s+/g, ' ').trim()
	return [...clean].slice(0, MAX_TITLE_CHARS).join('')
}

/**
 * Normalise a sidecar document.
 *
 * @param {unknown} value - The parsed JSON.
 * @returns {{title: string, description: string}} The fields.
 */
export function sidecarMeta(value) {
	const source = value !== null && typeof value === 'object' ? value : {}
	return {
		title: normalizeTitle(source.title),
		description: normalizeDescription(source.description),
	}
}

/**
 * Read one resource's sidecar.
 *
 * A missing sidecar is not an error: it is the state of a resource that has
 * not been described yet, and the caller decides what to do about it.
 *
 * @param {string} root - The project root.
 * @param {string} relative - The resource's path.
 * @returns {Promise<{title: string, description: string} | undefined>} The metadata.
 */
export async function readSidecar(root, relative) {
	const text = await readFile(sidecarPath(root, relative), 'utf8').catch(() => undefined)
	if (text === undefined) return undefined
	try {
		return sidecarMeta(JSON.parse(text))
	} catch {
		return undefined
	}
}

/**
 * Write one resource's sidecar.
 *
 * @param {string} root - The project root.
 * @param {string} relative - The resource's path.
 * @param {{title?: string, description?: string}} meta - The metadata.
 * @returns {Promise<string>} The absolute sidecar path.
 */
export async function writeSidecar(root, relative, meta) {
	const path = sidecarPath(root, relative)
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	const document = { schema: SIDECAR_SCHEMA, ...sidecarMeta(meta) }
	await writeFileAtomic(path, `${JSON.stringify(document, null, '\t')}\n`)
	return path
}

/**
 * Remove one resource's sidecar.
 *
 * @param {string} root - The project root.
 * @param {string} relative - The resource's path.
 * @returns {Promise<boolean>} True when a file was removed.
 */
export async function removeSidecar(root, relative) {
	const path = sidecarPath(root, relative)
	const removed = await rm(path, { force: true }).then(() => true, () => false)
	return removed
}

/**
 * Validate the description a harness resource is written with.
 *
 * The library's contract, unchanged: it is a sentence, not a summary, and it
 * has to say when the resource will be useful.
 *
 * @param {unknown} value - The proposed description.
 * @param {number} [maxChars] - The cap.
 * @returns {string} The clean description.
 */
export function assertResourceDescription(value, maxChars = undefined) {
	try {
		return assertDescription(value, maxChars)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(message.replace(/^文件必须写 description/, 'harness 资源必须写 meta.description'))
	}
}

/**
 * The advice a description earns when it does not say when it will be used.
 *
 * @param {unknown} value - The description.
 * @returns {string} The advice, or an empty string.
 */
export function resourceAdvice(value) {
	return descriptionAdvice(value)
}
