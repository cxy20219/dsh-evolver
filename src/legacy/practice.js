/**
 * Read-only access to the pre-card practice tree.
 *
 * This module exists only for the one-time (and catch-up) card migration.
 * Nothing writes these files any more; the card store is the live layer.
 */

import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** The old practice kinds. */
const LEGACY_KINDS = [
	{ id: 'doc', dir: 'docs' },
	{ id: 'tool', dir: 'tools' },
	{ id: 'resource', dir: 'resources' },
]

/** One entry may not be larger than this. */
const MAX_ENTRY_BYTES = 256 * 1024

/** Only plain entry file names. */
const ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** A frontmatter key line. */
const KEY_LINE = /^([A-Za-z0-9_.-]+)[ \t]*:(.*)$/

/** A frontmatter list item. */
const LIST_ITEM = /^[ \t]*-[ \t]+(.*)$/

/** Fields parsed as arrays. */
const LIST_FIELDS = new Set(['links', 'tags'])

/**
 * Strip one layer of quotes.
 *
 * @param {string} value - The raw value.
 * @returns {string} The unquoted value.
 */
function stripQuotes(value) {
	if (value.length >= 2) {
		const first = value[0]
		const last = value[value.length - 1]
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
	}
	return value
}

/**
 * Parse the small YAML subset the old writer emitted.
 *
 * @param {string} text - The frontmatter text.
 * @returns {Record<string, unknown>} The parsed fields.
 */
function parseFrontmatter(text) {
	const data = {}
	let currentKey = undefined
	for (const line of String(text ?? '').split(/\r?\n/)) {
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue
		const item = LIST_ITEM.exec(line)
		if (item !== null && currentKey !== undefined) {
			const list = Array.isArray(data[currentKey]) ? data[currentKey] : []
			list.push(stripQuotes(item[1].trim()))
			data[currentKey] = list
			continue
		}
		const match = KEY_LINE.exec(line)
		if (match === null) continue
		const key = match[1].trim()
		const rest = match[2].trim()
		currentKey = undefined
		if (rest === '') {
			currentKey = key
			data[key] = []
			continue
		}
		if (LIST_FIELDS.has(key) && rest.startsWith('[') && rest.endsWith(']')) {
			data[key] = rest
				.slice(1, -1)
				.split(',')
				.map((item) => stripQuotes(item.trim()))
				.filter((item) => item !== '')
			continue
		}
		data[key] = stripQuotes(rest)
	}
	return data
}

/**
 * Split a document into frontmatter and body.
 *
 * @param {string} text - The file content.
 * @returns {{data: Record<string, unknown>, body: string}} The parts.
 */
export function splitLegacyEntry(text) {
	const source = String(text ?? '').replace(/\r\n?/g, '\n')
	const firstLineEnd = source.indexOf('\n')
	if (firstLineEnd < 0 || source.slice(0, firstLineEnd).trim() !== '---') return { data: {}, body: source }
	const closing = source.indexOf('\n---', firstLineEnd)
	if (closing < 0) return { data: {}, body: source }
	const data = parseFrontmatter(source.slice(firstLineEnd + 1, closing))
	const bodyStart = source.indexOf('\n', closing + 1)
	return { data, body: bodyStart < 0 ? '' : source.slice(bodyStart + 1).replace(/^\n+/, '') }
}

/**
 * Read one entry.
 *
 * @param {string} root - The old practice folder.
 * @param {object} kind - The kind descriptor.
 * @param {string} topicSlug - The topic directory, empty at kind root.
 * @param {string} name - The file name.
 * @returns {Promise<object | undefined>} The entry, or undefined when it is not usable.
 */
async function readEntry(root, kind, topicSlug, name) {
	if (!ENTRY_NAME.test(name)) return undefined
	const path = join(root, kind.dir, topicSlug, name)
	const info = await lstat(path).catch(() => undefined)
	if (info === undefined || !info.isFile() || info.isSymbolicLink()) return undefined
	if (info.size > MAX_ENTRY_BYTES) return undefined
	const text = await readFile(path, 'utf8')
	const { data, body } = splitLegacyEntry(text)
	const relPath = relative(root, path).split('\\').join('/')
	return {
		kind: kind.id,
		topicSlug,
		topic: typeof data.topic === 'string' && data.topic !== '' ? data.topic : (topicSlug === '' ? '通用' : topicSlug),
		name,
		slug: name.replace(/\.[^.]+$/, ''),
		relPath,
		title: typeof data.title === 'string' ? data.title : '',
		purpose: typeof data.purpose === 'string' ? data.purpose : '',
		verified: typeof data.verified === 'string' ? data.verified : '',
		links: Array.isArray(data.links) ? data.links.map(String) : [],
		tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
		body,
		updatedAt: info.mtime.toISOString(),
		bytes: info.size,
	}
}

/**
 * Collect every old practice entry.
 *
 * @param {string} root - The old practice folder.
 * @returns {Promise<object[]>} The entries, sorted by path.
 */
export async function readLegacyPractice(root) {
	const entries = []
	for (const kind of LEGACY_KINDS) {
		const dir = join(root, kind.dir)
		const names = await readdir(dir).catch(() => [])
		for (const name of names.sort()) {
			if (name.startsWith('.') || name.endsWith('.tmp') || name === 'INDEX.md') continue
			const path = join(dir, name)
			const info = await lstat(path).catch(() => undefined)
			if (info === undefined || info.isSymbolicLink()) continue
			if (info.isDirectory()) {
				const inner = await readdir(path).catch(() => [])
				for (const file of inner.sort()) {
					if (file.startsWith('.') || file.endsWith('.tmp') || file === 'INDEX.md') continue
					const entry = await readEntry(root, kind, name, file)
					if (entry !== undefined) entries.push(entry)
				}
				continue
			}
			const entry = await readEntry(root, kind, '', name)
			if (entry !== undefined) entries.push(entry)
		}
	}
	entries.sort((left, right) => left.relPath.localeCompare(right.relPath))
	return entries
}
