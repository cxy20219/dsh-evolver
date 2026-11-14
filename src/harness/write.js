/**
 * Writing one harness resource.
 *
 * Three things happen together, which is the whole reason this is a function
 * and not an instruction: the file lands, the index is rebuilt from the folder
 * it now contains, and the structure is validated. A write that cannot produce
 * a consistent folder is undone rather than reported as done.
 *
 * The tool layer that calls this passes a project root it already resolved;
 * the path helpers below are also what `project_harness_promote` uses to turn a
 * relative path into the one file it is allowed to import into the library.
 *
 * Ported from dsh-evolver 1.0.0. The one host adaptation is containment: the
 * old `src/workspace.js` is gone, and the real-path check moved into
 * `harness/store.js`, so both write and promote read the same rule.
 */

import { lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { writeFileAtomic } from '../atomic.js'

import {
	LAYERS,
	RESOURCE_LAYER,
	TOOL_LAYER,
	catalog,
	inspectIndex,
	isReallyInside,
	renderIndex,
	withFrontmatter,
	withIndexBlock,
} from './store.js'
import { validate } from './validate.js'

/** The name a resource file may have: one segment, no traversal. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,80}$/

/**
 * Turn a title into a file name.
 *
 * @param {unknown} value - The proposed slug or title.
 * @returns {string} The slug, or an empty string when nothing safe is left.
 * @internal exported for tests
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
 * The project-relative POSIX spelling of an absolute path.
 *
 * @param {string} root - The project root.
 * @param {string} path - An absolute path.
 * @returns {string | undefined} The relative path, or undefined when outside.
 */
function relativeTo(root, path) {
	const base = resolve(root)
	const probe = resolve(base, path)
	const rel = relative(base, probe)
	if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
	return rel.split(sep).join('/')
}

/**
 * Resolve one existing harness resource inside a project.
 *
 * A promoted resource has to be read, so the input may be a project-relative
 * path (`harness/experience/x.md`) or an absolute one; both are normalised the
 * same way and must stay inside `harness/`, following symlinks, before a byte
 * is read.
 *
 * @param {string} root - The project root.
 * @param {unknown} path - The caller's path.
 * @returns {Promise<{absolute: string, relative: string}>} The resolved resource.
 */
export async function resolveResourcePath(root, path) {
	const raw = String(path ?? '').trim()
	if (raw === '') throw new Error('需要 path：项目内 harness 资源的相对路径。')
	const absolute = resolve(root, raw)
	const rel = relativeTo(root, absolute)
	if (rel === undefined) throw new Error(`路径不合法（越过了项目根）：${raw}`)
	if (!rel.startsWith('harness/')) throw new Error(`只能操作 harness/ 下的资源：${raw}`)
	if (!(await isReallyInside(join(root, 'harness'), absolute))) {
		throw new Error(`路径不合法（越过了 harness/ 的真实目录）：${raw}`)
	}
	const info = await lstat(absolute).catch(() => undefined)
	if (info === undefined || !info.isFile()) throw new Error(`没有这个资源：${rel}`)
	return { absolute, relative: rel }
}

/**
 * Work out which file a write targets.
 *
 * @param {{root: string, layer?: string, slug?: string, path?: string}} options - The write.
 * @returns {Promise<string>} The absolute path.
 */
async function resolveTarget({ root, layer, slug, path }) {
	if (typeof path === 'string' && path.trim() !== '') {
		return (await resolveResourcePath(root, path)).absolute
	}
	if (!LAYERS.includes(String(layer))) {
		throw new Error(`layer 必须是 ${LAYERS.join(' / ')} 之一。`)
	}
	const name = slugOf(slug)
	if (name === '') throw new Error(`文件名不合法：${String(slug ?? '')}（只能用小写英文、数字、. _ -）`)
	// A workflow or an experience is a document; a tool or a resource is
	// whatever the file is, extension included.
	const extension = layer === TOOL_LAYER || layer === RESOURCE_LAYER ? '' : '.md'
	// A document layer names its files itself: `foo.md` as a slug would have
	// produced `foo.md.md`, which then looks like a different resource.
	const stem = extension === '.md' ? name.replace(/\.md$/i, '') : name
	const file = extension === '' ? stem : `${stem}${extension}`
	return join(root, 'harness', String(layer), file)
}

/**
 * Put one file back the way it was before a failed write.
 *
 * @param {string} path - The file.
 * @param {string | undefined} previous - Its text, or undefined when it did not exist.
 * @returns {Promise<void>} Resolves once restored.
 */
async function restore(path, previous) {
	if (previous === undefined) await rm(path, { force: true }).catch(() => {})
	else await writeFileAtomic(path, previous).catch(() => {})
}

/**
 * Write or update one resource and leave the folder consistent.
 *
 * @param {object} options - The write.
 * @param {string} options.root - The project root.
 * @param {string} [options.layer] - One of the four layers.
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
	const agentsPath = join(root, 'AGENTS.md')
	const agentsPrevious = await readFile(agentsPath, 'utf8').catch(() => undefined)
	// Preflight the index before anything is written. Only a broken marker pair
	// is refused: hand-written prose is normal, and the block is appended after
	// it rather than replacing it.
	if (agentsPrevious !== undefined && inspectIndex(agentsPrevious).mode === 'broken') {
		throw new Error('AGENTS.md 的 harness 受管块标记不完整（缺 begin 或 end），没有写入；请手工补全或删掉残留标记后重试。')
	}

	await mkdir(dirname(target), { recursive: true, mode: 0o700 })
	await writeFileAtomic(target, `${document.trimEnd()}\n`)

	// The index is rebuilt from the folder, never edited by hand: that is what
	// makes "every resource is indexed" a property instead of a hope. Read the
	// file again just before patching so prose appended by another writer is
	// kept, not overwritten from a stale copy.
	const state = await catalog(root)
	const agentsNow = await readFile(agentsPath, 'utf8').catch(() => undefined)
	if (agentsNow !== undefined && inspectIndex(agentsNow).mode === 'broken') {
		// Another writer left a half block between our checks. Nothing is kept:
		// guessing where the index ends could delete their content.
		await restore(target, previous)
		throw new Error('AGENTS.md 的 harness 受管块标记不完整（缺 begin 或 end），没有写入；请手工补全或删掉残留标记后重试。')
	}
	await writeFileAtomic(agentsPath, withIndexBlock(agentsNow ?? '', renderIndex(state)))

	const report = await validate(root)
	if (!report.ok) {
		await restore(target, previous)
		// Restore the index byte-for-byte too: a failed write must leave the
		// document exactly as it was, prose included.
		if (agentsPrevious === undefined) await rm(agentsPath, { force: true }).catch(() => {})
		else await restore(agentsPath, agentsPrevious)
		throw new Error(`校验未通过，已回滚：${report.errors.slice(0, 3).join('；')}`)
	}

	return {
		path: target.slice(root.length + 1).split('\\').join('/'),
		created: previous === undefined,
		errors: report.errors,
		warnings: report.warnings,
		skipped: report.skipped,
		indexed: (await catalog(root)).resources.length,
	}
}
