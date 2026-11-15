/**
 * Writing one harness resource.
 *
 * Four things happen together, which is the whole reason this is a function
 * and not an instruction: the file lands, its sidecar lands beside it, the
 * index is rebuilt from the folder it now contains, and the structure is
 * validated. A write that cannot produce a consistent folder is undone rather
 * than reported as done.
 *
 * The sidecar carries the title and the description the index shows, so the
 * same contract as the library applies to every resource — a script, a
 * template, a note. The description is required: an entry the reader cannot
 * search by is an entry that does not exist.
 *
 * The tool layer that calls this passes a project root it already resolved;
 * the path helpers below are also what `file_write({from})` uses to turn a
 * relative path into the one file it is allowed to import into the library.
 */

import { lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeFileAtomic } from '../atomic.js'

import {
	CATALOG_LIMITS,
	backupAgents,
	catalog,
	initHarness,
	inspectAgents,
	isReallyInside,
	renderIndex,
	withPathLock,
	writeAgentsIndex,
} from './store.js'
import { assertResourceDescription, removeSidecar, sidecarPath, writeSidecar } from './sidecar.js'
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
 * Put one file back only while it still holds what this write put there.
 *
 * A rollback must not become a second clobber: if a user (or another process)
 * edited the file after this write, their version wins and ours is not put
 * back over it (stability audit P2-5).
 *
 * @param {string} path - The file.
 * @param {string} written - The exact text this write put there.
 * @param {string | undefined} previous - The text before the write, or undefined when the file did not exist.
 * @returns {Promise<boolean>} True when the file was restored.
 */
async function restoreIfUnchanged(path, written, previous) {
	const current = await readFile(path, 'utf8').catch(() => undefined)
	if (current !== written) return false
	if (previous === undefined) await rm(path, { force: true }).catch(() => {})
	else await writeFileAtomic(path, previous).catch(() => {})
	return true
}

/**
 * Put the index back to the text it had before a failed write.
 *
 * The restore target is the snapshot the index write actually merged into, not
 * the preflight read: an editor may have changed the document between the two,
 * and their text is part of the snapshot, so restoring it keeps what they
 * wrote. Only when the document still is exactly what this write left there is
 * anything restored at all — an `AGENTS.md` that changed afterwards belongs to
 * whoever changed it.
 *
 * @param {string} agentsPath - The document.
 * @param {{changed: boolean, text: string, previous: string | undefined}} applied - What the index write produced.
 * @returns {Promise<boolean>} True when the document was restored.
 */
async function restoreAgents(agentsPath, applied) {
	if (applied.changed !== true) return false
	const current = await readFile(agentsPath, 'utf8').catch(() => undefined)
	if (current !== applied.text) return false
	if (applied.previous === undefined) await rm(agentsPath, { force: true }).catch(() => {})
	else await writeFileAtomic(agentsPath, applied.previous).catch(() => {})
	return true
}

/**
 * Give every resource that has a description in the index a sidecar.
 *
 * An index written before this plugin owned the project already carries the
 * one-line purposes; copying them into sidecars is what turns an old project
 * into a described one without inventing a word. Resources the old index never
 * mentioned are left alone: they get a warning until somebody says what they
 * are.
 *
 * @param {string} root - The project root.
 * @param {object} state - The catalog.
 * @returns {Promise<string[]>} The resources that gained a sidecar.
 */
async function adoptDescriptions(root, state) {
	const adopted = []
	for (const resource of state.resources) {
		if (resource.sidecar === true) continue
		if (resource.description === '') continue
		await writeSidecar(root, resource.path, { title: resource.label || resource.title, description: resource.description })
		adopted.push(resource.path)
	}
	return adopted
}

/**
 * Write or update one resource and leave the folder consistent.
 *
 * The whole target → sidecar → index → validate cycle runs under one
 * per-project lock, because every step reads the folder and the index is
 * rebuilt from what it read: two writes interleaving would each render an index
 * missing the other's file (stability audit P2-5). Within the cycle,
 * `writeAgentsIndex` re-reads `AGENTS.md` before every write and retries if it
 * changed, so an editor outside this process is never overwritten either.
 *
 * @param {object} options - The write.
 * @param {string} options.root - The project root.
 * @param {string} options.relative - The resource's project-relative path.
 * @param {string} options.content - The file's text.
 * @param {string} [options.title] - The title the index shows.
 * @param {string} options.description - The one-line purpose the index shows.
 * @param {object} [options.hooks] - Test seam for the read→write and validate→rollback windows.
 * @returns {Promise<object>} What happened.
 */
export async function writeHarnessResource({ root, relative: relativePath, content, title, description, hooks }) {
	if (typeof content !== 'string') throw new Error('写 harness 资源需要 content（文本正文）。')
	if (!relativePath.startsWith('harness/')) throw new Error(`只能写 harness/ 下的资源：${relativePath}`)
	// The skeleton, the overview's sidecar and a retired layout are settled
	// before the path is checked: the folder has to exist before "inside it"
	// can be decided. The migration takes the same lock, and a lock that waits
	// for itself never comes back.
	await initHarness(root)
	const target = join(root, ...relativePath.split('/'))
	if (!(await isReallyInside(join(root, 'harness'), target))) {
		throw new Error(`路径越界（真实路径不在 harness/ 内）：${relativePath}`)
	}
	const clean = assertResourceDescription(description)
	const agentsPath = join(root, 'AGENTS.md')
	return withPathLock(agentsPath, () => writeResourceLocked({
		root,
		agentsPath,
		target,
		relativePath,
		content,
		title,
		description: clean,
		hooks,
	}))
}

/**
 * The write cycle, already under the project lock.
 *
 * @param {{root: string, agentsPath: string, target: string, relativePath: string, content: string, title?: string, description: string, hooks?: object}} options - The write.
 * @returns {Promise<object>} What happened.
 */
async function writeResourceLocked({ root, agentsPath, target, relativePath, content, title, description, hooks }) {
	const previous = await readFile(target, 'utf8').catch(() => undefined)
	const sidecar = sidecarPath(root, relativePath)
	const previousSidecar = await readFile(sidecar, 'utf8').catch(() => undefined)
	const written = content.endsWith('\n') ? content : `${content}\n`
	await mkdir(dirname(target), { recursive: true, mode: 0o700 })
	await writeFileAtomic(target, written)
	const sidecarText = `${JSON.stringify({ schema: 1, title: String(title ?? '').trim(), description }, null, '\t')}\n`
	await writeFileAtomic(sidecar, sidecarText)

	let state
	let applied
	let backup
	try {
		// The index is rebuilt from the folder, never edited by hand: that is
		// what makes "every resource is indexed" a property instead of a hope.
		state = await catalog(root)
		if (state.limited === true) {
			throw new Error(`harness/ 的文件数超过单次扫描上限（${CATALOG_LIMITS.maxFiles}），catalog 清单不完整，拒绝写入并重建索引；请先精简 harness/。`)
		}
		const current = await readFile(agentsPath, 'utf8').catch(() => undefined)
		if (current !== undefined && current.trim() !== '' && inspectAgents(current).mode === 'handwritten') {
			// The index owns this file now, but the prose in it is somebody's
			// work: it is kept beside the project before it is replaced.
			backup = await backupAgents(root, current)
		}
		applied = await writeAgentsIndex(root, renderIndex(state), { hooks })
	} catch (error) {
		await restoreIfUnchanged(target, written, previous)
		await restoreIfUnchanged(sidecar, sidecarText, previousSidecar)
		throw error
	}

	const report = await validate(root)
	if (!report.ok) {
		await restoreIfUnchanged(target, written, previous)
		await restoreIfUnchanged(sidecar, sidecarText, previousSidecar)
		// The rollback of the document happens only when it is still ours; an
		// edit made in the window is kept, and the next write/tool run will
		// rebuild a consistent index around it.
		if (hooks?.beforeRollback !== undefined) await hooks.beforeRollback({ path: agentsPath })
		await restoreAgents(agentsPath, applied)
		throw new Error(`校验未通过，已回滚：${report.errors.slice(0, 3).join('；')}`)
	}

	const adopted = await adoptDescriptions(root, state)
	const warnings = [...report.warnings]
	if (backup !== undefined) {
		warnings.push(`AGENTS.md 原是手写文档，已备份为 ${backup}，并按 harness/ 重建为索引；原手写内容请搬进 harness/harness.md。`)
	}
	if (adopted.length > 0) {
		warnings.push(`已从旧索引继承 ${adopted.length} 条描述，写进对应资源的边车。`)
	}
	return {
		path: relativePath,
		created: previous === undefined,
		indexed: state.resources.length,
		warnings,
		...(backup === undefined ? {} : { backup }),
		validation: { ok: report.errors.length === 0, errors: report.errors, warnings: report.warnings, skipped: report.skipped },
	}
}

/**
 * Remove one resource, its sidecar and its index entry.
 *
 * @param {object} options - The removal.
 * @param {string} options.root - The project root.
 * @param {string} options.relative - The resource's project-relative path.
 * @returns {Promise<object>} What happened.
 */
export async function removeHarnessResource({ root, relative: relativePath }) {
	if (!relativePath.startsWith('harness/')) throw new Error(`只能删除 harness/ 下的资源：${relativePath}`)
	const target = join(root, ...relativePath.split('/'))
	if (!(await isReallyInside(join(root, 'harness'), target))) {
		throw new Error(`路径越界（真实路径不在 harness/ 内）：${relativePath}`)
	}
	const info = await lstat(target).catch(() => undefined)
	if (info === undefined) throw new Error(`没有这个资源：${relativePath}`)
	const agentsPath = join(root, 'AGENTS.md')
	return withPathLock(agentsPath, async () => {
		const previous = await readFile(target, 'utf8').catch(() => undefined)
		await rm(target, { force: true })
		await removeSidecar(root, relativePath)
		let state
		let applied
		try {
			state = await catalog(root)
			applied = await writeAgentsIndex(root, renderIndex(state))
		} catch (error) {
			if (previous !== undefined) await writeFileAtomic(target, previous).catch(() => {})
			throw error
		}
		const report = await validate(root)
		if (!report.ok) {
			if (previous !== undefined) await writeFileAtomic(target, previous).catch(() => {})
			await restoreAgents(agentsPath, applied)
			throw new Error(`校验未通过，已回滚：${report.errors.slice(0, 3).join('；')}`)
		}
		return {
			path: relativePath,
			removed: true,
			indexed: state.resources.length,
			warnings: report.warnings,
			validation: { ok: report.errors.length === 0, errors: report.errors, warnings: report.warnings, skipped: report.skipped },
		}
	})
}
