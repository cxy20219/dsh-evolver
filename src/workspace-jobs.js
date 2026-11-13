/**
 * Data-folder operations: move, export, list, import.
 *
 * The data folder is the migration unit. These four operations are the only
 * ones that close and reopen the card store, and two of them at once would
 * leave the store pointing at a folder the evolver no longer uses — so they
 * share one exclusivity gate.
 *
 * The gate lives here rather than in `index.js` because the plugin assembly is
 * long enough already and because the timer jobs (`consolidate`, `ingest`,
 * `health`) have to ask the same question: `busy()` is what they are injected
 * with, so a job never writes into a folder that is being copied away.
 */

import { lstat, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { MAX_IMPORT_BYTES, extractArchiveFile, writeArchiveFile } from './backup/archive.js'
import { canonicalPath, copyTree, countEntries, isDirectory, isInsidePath, pathsOverlap } from './workspace.js'

/** How many archives one folder listing may return. */
const MAX_ARCHIVES = 200

/**
 * Validate one absolute path a workspace action was given.
 *
 * @param {unknown} value - The path from the request.
 * @returns {string} The resolved path.
 */
function requestPath(value) {
	const text = String(value ?? '').trim()
	if (text === '') throw new Error('请填写路径。')
	if (text.includes('\u0000') || /[\r\n]/.test(text)) throw new Error('路径不合法。')
	if (!isAbsolute(text)) throw new Error(`必须是绝对路径：${text}`)
	const resolved = resolve(text)
	// `dirname('/') === '/'`: a root folder would turn a copy into a system
	// write, however the user got there.
	if (resolved === dirname(resolved)) throw new Error('不能把文件系统根目录当作目标。')
	return resolved
}

/**
 * Refuse a copy whose destination overlaps its source.
 *
 * @param {string} current - The data folder.
 * @param {string} target - The requested destination.
 * @param {string} label - What the destination is for.
 * @returns {void}
 */
function assertSeparate(current, target, label) {
	if (pathsOverlap(current, target)) throw new Error(`${label}不能与数据目录相同或互相包含。`)
}

/**
 * Create the data-folder operations of one plugin instance.
 *
 * @param {object} deps - The services the operations use.
 * @param {object} deps.evolver - The evolver document layer (root, switchRoot).
 * @param {object} deps.settings - The settings store.
 * @param {{source: string, warning: string}} deps.rootState - Where the data folder came from.
 * @param {string} deps.defaultRoot - The default data folder, for the panel.
 * @param {object} [deps.logger] - Logger.
 * @param {() => object} deps.currentStore - The card store currently in use.
 * @param {(root: string) => Promise<object>} deps.openCards - Build the store of another folder.
 * @param {() => boolean} [deps.backupRunning] - Whether a cloud backup is in flight.
 * @returns {object} The operations plus the exclusivity gate.
 */
export function createWorkspaceJobs({
	evolver,
	settings,
	rootState,
	defaultRoot,
	logger,
	currentStore,
	openCards,
	backupRunning = () => false,
}) {
	/**
	 * The data operation currently holding the folder, if any.
	 *
	 * @type {string | undefined}
	 */
	let operation

	/**
	 * Run one data-folder operation while no other one is in flight.
	 *
	 * @param {string} label - What the operation is, for the refusal message.
	 * @param {() => Promise<unknown>} action - The operation.
	 * @returns {Promise<unknown>} Its result.
	 */
	async function exclusive(label, action) {
		const blocked = blockedMessage()
		if (blocked !== undefined) throw new Error(blocked)
		// A backup reads the folder while these operations rewrite it: a
		// snapshot taken across an import can upload a half-migrated library
		// and, with `keep` set to one, replace the last good copy.
		if (backupRunning() === true) throw new Error('云备份正在进行，请等它结束后再试。')
		operation = label
		try {
			return await action()
		} finally {
			operation = undefined
		}
	}

	/** The refusal a write or a display would get, if the folder is busy. */
	function blockedMessage() {
		return operation === undefined ? undefined : `${operation}正在进行，请稍后再试。`
	}

	const jobs = {
		/**
		 * The current folder, for the settings page.
		 *
		 * @returns {object} The state.
		 */
		state() {
			return {
				root: evolver.root,
				source: rootState.source,
				warning: rootState.warning,
				defaultRoot,
				settingsPath: settings.path,
				backupRunning: backupRunning() === true,
			}
		},

		/**
		 * Copy the data folder to a new place and continue there.
		 *
		 * @param {unknown} dir - The new folder.
		 * @param {{force?: boolean}} [options] - Overwrite behaviour.
		 * @returns {Promise<object>} What happened.
		 */
		async migrate(dir, { force = false } = {}) {
			// The requested spelling is what the user sees and what the settings
			// store; the canonical path is only used for the safety checks, so
			// two spellings of the same folder cannot slip past them.
			const requested = requestPath(dir)
			const target = await canonicalPath(requested)
			const current = await canonicalPath(evolver.root)
			if (target === current) {
				throw new Error('这就是当前数据目录，不需要迁移；请选择另一个目录。')
			}
			assertSeparate(current, target, '新数据目录')
			if (await isDirectory(requested)) {
				const entries = await countEntries(requested)
				if (entries > 0 && !force) throw new Error(`目标目录不是空的（${entries} 项）；确认覆盖后重试。`)
			} else if (!(await isDirectory(dirname(requested)))) {
				throw new Error(`目标目录的上级不存在：${dirname(requested)}`)
			}
			const previousRoot = evolver.root
			const previousSetting = settings.get().dataDir
			// Flush first: the copy has to see the newest card writes. A close
			// that fails means the log is behind memory, and the copy would be
			// missing exactly the writes the user was just told were saved.
			try {
				await currentStore()?.close()
			} catch (error) {
				await openCards(previousRoot).catch(() => {})
				throw new Error(`当前数据无法落盘，迁移已取消：${error instanceof Error ? error.message : String(error)}`)
			}
			let copied
			try {
				copied = await copyTree(previousRoot, requested, { force })
			} catch (error) {
				// The old folder is untouched; reopen it so the plugin keeps
				// answering with the data it had before the attempt.
				await openCards(previousRoot).catch(() => {})
				throw error
			}
			// Persist the new location *before* switching: if the switch fails,
			// the next start still lands on the folder that already holds the
			// copy, instead of silently drifting back to the old one.
			try {
				await settings.update({ dataDir: requested })
				await evolver.switchRoot(requested)
				await openCards(requested)
			} catch (error) {
				// Half a migration is worse than none: the setting and the
				// evolver root can already point at the new folder while the
				// store still serves the old one. Put all three back.
				await settings.update({ dataDir: previousSetting }).catch(() => {})
				await evolver.switchRoot(previousRoot).catch(() => {})
				await openCards(previousRoot).catch(() => {})
				throw new Error(`迁移未完成，已回到原数据目录：${error instanceof Error ? error.message : String(error)}`)
			}
			rootState.source = 'settings'
			rootState.warning = ''
			logger?.info?.(`dsh-evolver: data folder moved to ${requested}`)
			return { root: requested, ...copied }
		},

		/**
		 * Copy the data folder out, leaving the current one in use.
		 *
		 * @param {{dir?: string, name?: string, force?: boolean}} [options] - Where to write.
		 * @returns {Promise<object>} What happened.
		 */
		async exportTo({ dir = '', name = '', force = false } = {}) {
			// A folder and a name, never a whole path: the panel only ever sends
			// these two, and accepting a free path would let one request write
			// the archive bytes over any file the process can reach.
			let target
			{
				const folder = requestPath(dir)
				if (!(await isDirectory(folder))) throw new Error(`导出目录不存在：${folder}`)
				let fileName = String(name ?? '').trim()
				if (fileName === '' || fileName.length > 128 || /[\\/\u0000\r\n]/.test(fileName) || /^\.+$/.test(fileName)) {
					throw new Error(`文件名不合法：${fileName === '' ? '（空）' : fileName}`)
				}
				// Always end with an archive suffix, otherwise the import
				// browser would not find the file it just wrote.
				if (!/\.(tar\.gz|tgz|tar)$/i.test(fileName)) fileName += '.tar.gz'
				target = join(folder, fileName)
			}
			const current = await canonicalPath(evolver.root)
			if (isInsidePath(current, await canonicalPath(target))) {
				throw new Error('导出文件不能放在数据目录里面。')
			}
			const existing = await lstat(target).catch(() => undefined)
			if (existing !== undefined) {
				if (!existing.isFile()) throw new Error(`导出目标必须是文件：${target}`)
				if (!force) throw new Error(`文件已存在：${target}；确认覆盖后重试。`)
			} else if (!(await isDirectory(dirname(target)))) {
				throw new Error(`导出目录的上级不存在：${dirname(target)}`)
			}
			// Flush first so the archive contains the newest card writes. The
			// store is reopened afterwards: an export must not leave the plugin
			// without its read path. A failed close means the archive would be
			// missing debounced writes, so it cancels the export instead.
			try {
				await currentStore()?.close()
			} catch (error) {
				await openCards(evolver.root).catch(() => {})
				throw new Error(`当前数据无法落盘，导出已取消：${error instanceof Error ? error.message : String(error)}`)
			}
			try {
				const packed = await writeArchiveFile(evolver.root, target)
				return { file: target, bytes: packed.bytes, files: packed.files }
			} finally {
				await openCards(evolver.root)
			}
		},

		/**
		 * List the archives in one folder.
		 *
		 * The client has a folder picker but no file picker, so the flow is
		 * "pick a folder, choose one of its archives"; this is that second
		 * step. Only our three archive suffixes are returned.
		 *
		 * @param {unknown} dir - The folder.
		 * @returns {Promise<object>} The folder and its archives, newest first.
		 */
		async listArchives(dir) {
			const folder = requestPath(dir)
			if (!(await isDirectory(folder))) throw new Error(`目录不存在：${folder}`)
			const names = await readdir(folder).catch(() => [])
			const files = []
			for (const name of names) {
				if (!/\.(tar\.gz|tgz|tar)$/i.test(name)) continue
				const path = join(folder, name)
				const info = await lstat(path).catch(() => undefined)
				if (info === undefined || !info.isFile()) continue
				files.push({ name, path, size: info.size, updatedAt: info.mtime.toISOString() })
			}
			files.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.name.localeCompare(right.name))
			return { dir: folder, files: files.slice(0, MAX_ARCHIVES) }
		},

		/**
		 * Extract one archive over the data folder and reopen the store.
		 *
		 * @param {unknown} file - The archive.
		 * @param {{force?: boolean}} [options] - Overwrite behaviour.
		 * @returns {Promise<object>} What was written.
		 */
		async importFrom(file, { force = false } = {}) {
			const source = requestPath(file)
			const info = await lstat(source).catch(() => undefined)
			if (info === undefined || !info.isFile()) throw new Error(`导入文件不存在：${source}`)
			if (info.size > MAX_IMPORT_BYTES) {
				throw new Error(`压缩包超过 ${MAX_IMPORT_BYTES / 1024 / 1024 / 1024} GB，拒绝导入。`)
			}
			const current = await canonicalPath(evolver.root)
			if (isInsidePath(current, await canonicalPath(source))) {
				throw new Error('导入文件不能是数据目录里的文件。')
			}
			try {
				await currentStore()?.close()
			} catch (error) {
				await openCards(evolver.root).catch(() => {})
				throw new Error(`当前数据无法落盘，导入已取消：${error instanceof Error ? error.message : String(error)}`)
			}
			let restored
			try {
				restored = await extractArchiveFile(source, evolver.root, { force })
			} catch (error) {
				// A half-finished import must not leave the in-memory store out
				// of sync with the files that did land.
				await openCards(evolver.root).catch(() => {})
				const message = error instanceof Error ? error.message : String(error)
				throw new Error(message.includes('压缩包') ? message : `不能读取压缩包：${message}`)
			}
			// The folder did not move; only the store has to be reopened over
			// the files that just landed.
			await openCards(evolver.root)
			return restored
		},
	}

	// Moving, exporting and importing all copy the folder and reopen the memory
	// store, so they share the one gate.
	for (const [method, label] of Object.entries({ migrate: '迁移', exportTo: '导出', importFrom: '导入' })) {
		const original = jobs[method]
		jobs[method] = function runExclusively(...args) {
			return exclusive(label, () => original.apply(jobs, args))
		}
	}

	return {
		...jobs,
		/** Whether one of the folder operations is in flight. */
		busy: () => operation !== undefined,
		/** The refusal a write would get, or undefined when the folder is free. */
		blockedMessage,
	}
}
