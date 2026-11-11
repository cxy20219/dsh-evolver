/**
 * Writing one harness resource.
 *
 * Three things happen together, which is the whole reason this is a function
 * and not an instruction: the file lands, the index is rebuilt from the folder
 * it now contains, and the structure is validated. A write that cannot produce
 * a consistent folder is undone rather than reported as done.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { LAYERS, OVERVIEW, RESOURCE_LAYER, TOOL_LAYER, catalog, documentOf, isBareIndex, renderIndex, withFrontmatter } from './store.js'
import { validate } from './validate.js'

/** The name a resource file may have: one segment, no traversal. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,80}$/

/**
 * Turn a title into a file name.
 *
 * @param {unknown} value - The proposed slug or title.
 * @returns {string} The slug, or an empty string when nothing safe is left.
 */
export function slugOf(value) {
	const source = String(value ?? '')
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
	return SLUG_PATTERN.test(source) ? source : ''
}

/**
 * Write one AGENTS.md without leaving a half-written file.
 *
 * @param {string} path - The file.
 * @param {string} text - The content.
 * @returns {Promise<void>} Resolves once it is in place.
 */
async function writeAtomic(path, text) {
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`
	await writeFile(temp, text, { mode: 0o600 })
	await rename(temp, path)
}

/**
 * Write or update one resource and leave the folder consistent.
 *
 * @param {object} options - The write.
 * @param {string} options.root - The project root.
 * @param {string} [options.layer] - One of the five layers.
 * @param {string} [options.slug] - File name without extension.
 * @param {string} [options.title] - The document heading.
 * @param {string} [options.summary] - The one-line purpose the index shows.
 * @param {string} [options.body] - The document text.
 * @param {string} [options.path] - An existing resource to replace.
 * @returns {Promise<object>} What happened.
 */
export async function writeResource({ root, layer, slug, title, summary, body, path }) {
	const target = await resolveTarget({ root, layer, slug, path })
	const heading = String(title ?? '').trim()
	const text = String(body ?? '').trim()
	if (text === '') throw new Error('正文不能为空。')
	if (heading === '' && !text.startsWith('#')) throw new Error('需要一个标题：给 title，或让正文以 # 开头。')

	const document = withFrontmatter(
		{
			title: heading,
			summary: String(summary ?? '').trim(),
		},
		text.startsWith('#') ? text : `# ${heading}\n\n${text}`,
	)

	const previous = await readFile(target, 'utf8').catch(() => undefined)
	await mkdir(dirname(target), { recursive: true, mode: 0o700 })
	await writeAtomic(target, `${document.trimEnd()}\n`)

	// The index is rebuilt from the folder, never edited by hand: that is what
	// makes "every resource is indexed" a property instead of a hope.
	const state = await catalog(root)
	const agentsPath = join(root, 'AGENTS.md')
	const agents = await readFile(agentsPath, 'utf8').catch(() => '')
	if (agents.trim() !== '' && !isBareIndex(agents)) {
		// Nothing is written: replacing the file would drop whatever a person
		// put in it, and rewriting it half-way would leave two indexes.
		throw new Error('AGENTS.md 里有不是索引的内容，没有写入。先把它挪到 harness/harness.md 再重试。')
	}
	await writeAtomic(agentsPath, documentOf(renderIndex(state)))

	const report = await validate(root)
	if (!report.ok) {
		if (previous === undefined) {
			await rm(target, { force: true }).catch(() => {})
		} else {
			await writeAtomic(target, previous)
		}
		const restored = await catalog(root)
		await writeAtomic(agentsPath, documentOf(renderIndex(restored)))
		throw new Error(`校验未通过，已回滚：${report.errors.slice(0, 3).join('；')}`)
	}

	return {
		path: target.slice(root.length + 1).split('\\').join('/'),
		created: previous === undefined,
		errors: report.errors,
		warnings: report.warnings,
		indexed: (await catalog(root)).resources.length,
	}
}

/**
 * Work out which file a write targets.
 *
 * @param {{root: string, layer?: string, slug?: string, path?: string}} options - The write.
 * @returns {Promise<string>} The absolute path.
 */
async function resolveTarget({ root, layer, slug, path }) {
	if (typeof path === 'string' && path.trim() !== '') {
		const clean = path.trim().replace(/^\/+/, '')
		if (!clean.startsWith('harness/')) throw new Error(`只能更新 harness/ 下的资源：${path}`)
		if (clean.includes('..')) throw new Error(`路径不合法：${path}`)
		const absolute = join(root, clean)
		if (!absolute.startsWith(join(root, 'harness'))) throw new Error(`路径不合法：${path}`)
		if ((await readFile(absolute, 'utf8').catch(() => undefined)) === undefined) {
			throw new Error(`没有这个资源：${clean}`)
		}
		return absolute
	}
	if (!LAYERS.includes(String(layer))) {
		throw new Error(`layer 必须是 ${LAYERS.join(' / ')} 之一。`)
	}
	const name = slugOf(slug)
	if (name === '') throw new Error(`文件名不合法：${String(slug ?? '')}`)
	// A workflow or an experience is a document; a tool or a resource is
	// whatever the file is, extension included.
	const extension = layer === TOOL_LAYER || layer === RESOURCE_LAYER ? '' : '.md'
	const file = extension === '' ? name : `${name}${extension}`
	return join(root, 'harness', String(layer), file)
}

export { OVERVIEW }
