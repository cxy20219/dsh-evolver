/**
 * Data-directory operations for the settings panel.
 *
 * Move/copy, export and import all operate on canonical content only. The
 * current store is never closed or swapped: every operation that changes the
 * active root only writes `yuanshi.home.json`, and the next start opens the
 * new root. That is why a failed copy can leave the old library completely
 * untouched.
 */

import { randomUUID } from 'node:crypto'
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { MAX_ARCHIVE_BYTES, readArchiveFile, writeArchiveFile } from './archive.js'
import { readDataDirPointer, writeDataDirPointer } from './home.js'
import { isFileId } from './ids.js'
import { safeName } from './names.js'

/**
 * Whether one path is inside another.
 *
 * @param {string} parent - The possible parent.
 * @param {string} child - The possible child.
 * @returns {boolean} True when child is strictly below parent.
 */
function isInside(parent, child) {
	return child.startsWith(parent + sep)
}

/**
 * Validate the canonical files in one library.
 *
 * This checks structure, ids, names and payload presence; the next real start
 * still rebuilds SQLite from the sidecars. It is deliberately strict enough
 * to reject a directory that is not a 自衍中枢 library.
 *
 * @param {string} root - The data root.
 * @returns {Promise<{files: number, bytes: number}>} Entity counts.
 */
export async function validateLibrary(root) {
	const filesDir = join(root, 'files')
	const entries = await readdir(filesDir, { withFileTypes: true }).catch(() => undefined)
	if (entries === undefined) throw new Error(`目标目录没有 files/，不像是自衍中枢库：${root}`)
	let files = 0
	let bytes = 0
	for (const entry of entries) {
		if (!entry.isDirectory() || !isFileId(entry.name)) continue
		const metaPath = join(filesDir, entry.name, 'meta.json')
		const text = await readFile(metaPath, 'utf8').catch(() => undefined)
		if (text === undefined) throw new Error(`文件缺少 meta.json：${entry.name}`)
		let meta
		try {
			meta = JSON.parse(text)
		} catch {
			throw new Error(`meta.json 不是合法 JSON：${entry.name}`)
		}
		if (meta?.id !== entry.name) throw new Error(`meta.id 与目录不一致：${entry.name}`)
		if (typeof meta.name !== 'string' || safeName(meta.name) !== meta.name) throw new Error(`文件名不安全：${entry.name}`)
		const payloadPath = join(filesDir, entry.name, meta.name)
		const info = await lstat(payloadPath).catch(() => undefined)
		if (info === undefined || !info.isFile() || info.isSymbolicLink()) throw new Error(`文件本体缺失或是符号链接：${entry.name}`)
		if (Number(meta.bytes) !== info.size) throw new Error(`文件大小与边车不一致：${entry.name}`)
		files += 1
		bytes += info.size
	}
	const settingsPath = join(root, 'system', 'settings.json')
	const settings = await readFile(settingsPath, 'utf8').catch(() => undefined)
	if (settings !== undefined) {
		try {
			JSON.parse(settings)
		} catch {
			throw new Error('system/settings.json 不是合法 JSON。')
		}
	}
	return { files, bytes }
}

/**
 * Create the data-directory operations.
 *
 * @param {{root: string, pointerPath: string, settings: object, logger?: object, version?: string}} deps - The current root and satellites.
 * @returns {object} Operations used by the panel.
 */
export function createDataJobs({ root, pointerPath, settings, logger, version = '' }) {
	const currentRoot = resolve(root)

	/**
	 * Current root, pointer target and pending restart.
	 *
	 * @returns {Promise<object>} The status.
	 */
	async function status() {
		const pointer = await readDataDirPointer(pointerPath)
		const pending = pointer !== undefined && resolve(pointer.dataDir) !== currentRoot ? pointer.dataDir : ''
		const counts = await validateLibrary(currentRoot).catch(() => ({ files: 0, bytes: 0 }))
		return {
			current: currentRoot,
			pointerPath,
			pending,
			pendingExists: pending === '' ? false : await stat(pending).then((info) => info.isDirectory(), () => false),
			files: counts.files,
			bytes: counts.bytes,
			settings: settings.publicView(),
		}
	}

	/**
	 * Copy the canonical part of the current library into a new directory.
	 *
	 * @param {string} target - A non-existent target.
	 * @returns {Promise<{files: number, bytes: number}>} Copied counts.
	 */
	async function copyTo(target) {
		const parent = dirname(target)
		const parentInfo = await stat(parent).catch(() => undefined)
		if (parentInfo === undefined || !parentInfo.isDirectory()) throw new Error(`目标目录的上级不存在：${parent}`)
		const staging = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}`)
		await mkdir(staging, { recursive: false, mode: 0o700 })
		try {
			await cp(join(currentRoot, 'files'), join(staging, 'files'), {
				recursive: true,
				dereference: false,
				errorOnExist: true,
				filter: (source) => !basename(source).startsWith('.tmp-'),
			})
			const settingsPath = join(currentRoot, 'system', 'settings.json')
			const settingsInfo = await stat(settingsPath).catch(() => undefined)
			if (settingsInfo?.isFile()) {
				await mkdir(join(staging, 'system'), { recursive: true, mode: 0o700 })
				await copyFile(settingsPath, join(staging, 'system', 'settings.json'))
			}
			const counts = await validateLibrary(staging)
			await rename(staging, target)
			return counts
		} catch (error) {
			await rm(staging, { recursive: true, force: true }).catch(() => {})
			throw error
		}
	}

	/**
	 * Choose a new root and write the pointer. The caller restarts.
	 *
	 * @param {{dir?: string, mode?: 'copy' | 'attach'}} input - Destination and mode.
	 * @returns {Promise<object>} What changed.
	 */
	async function saveDir({ dir, mode = 'copy' } = {}) {
		const requested = String(dir ?? '').trim()
		if (!isAbsolute(requested)) throw new Error('数据目录必须是绝对路径。')
		const target = resolve(requested)
		if (target === currentRoot) throw new Error('这就是当前数据目录。')
		if (isInside(currentRoot, target) || isInside(target, currentRoot)) {
			throw new Error('新旧数据目录不能互相包含。')
		}
		let counts
		if (mode === 'attach') {
			const info = await stat(target).catch(() => undefined)
			if (info === undefined || !info.isDirectory()) throw new Error(`目标目录不存在：${target}`)
			counts = await validateLibrary(target)
		} else {
			const exists = await stat(target).then(() => true, () => false)
			if (exists) throw new Error('复制模式要求目标目录不存在；要使用已有库请选择“使用已有自衍中枢库”。')
			counts = await copyTo(target)
		}
		try {
			await writeDataDirPointer(pointerPath, target)
		} catch (error) {
			throw new Error(`数据已复制到 ${target}，但指针写入失败：${error instanceof Error ? error.message : String(error)}`)
		}
		logger?.info?.(`自衍中枢：数据目录将在下次启动切到 ${target}`)
		return { dir: target, mode, files: counts.files, bytes: counts.bytes, restartRequired: true }
	}

	/**
	 * Write a portable snapshot to a temporary file and return it as base64.
	 *
	 * @returns {Promise<object>} The download payload.
	 */
	async function exportLibrary() {
		const folder = await mkdtemp(join(tmpdir(), 'yuanshi-export-'))
		const archive = join(folder, 'yuanshi.tar.gz')
		try {
			const packed = await writeArchiveFile(currentRoot, archive, { version })
			if (packed.archiveBytes > MAX_ARCHIVE_BYTES) {
				throw new Error(`归档 ${Math.round(packed.archiveBytes / 1024 / 1024)} MB，超过浏览器导出上限 ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB。`)
			}
			const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
			return {
				name: `yuanshi-${stamp}.tar.gz`,
				files: packed.files,
				bytes: packed.bytes,
				archiveBytes: packed.archiveBytes,
				base64: (await readFile(archive)).toString('base64'),
			}
		} finally {
			await rm(folder, { recursive: true, force: true }).catch(() => {})
		}
	}

	/**
	 * Extract an uploaded snapshot into a new library and switch the pointer.
	 *
	 * @param {{data?: string, dir?: string}} input - Base64 archive and optional target.
	 * @returns {Promise<object>} What was imported.
	 */
	async function importLibrary({ data, dir } = {}) {
		const raw = String(data ?? '')
		const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
		if (base64 === '') throw new Error('导入内容为空。')
		const archive = Buffer.from(base64, 'base64')
		if (archive.length === 0) throw new Error('导入内容无法解码。')
		if (archive.length > MAX_ARCHIVE_BYTES) throw new Error(`压缩包超过 ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB 上限。`)
		const requested = String(dir ?? '').trim()
		let target
		if (requested !== '') {
			if (!isAbsolute(requested)) throw new Error('导入目录必须是绝对路径。')
			target = resolve(requested)
		} else {
			const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
			target = join(dirname(currentRoot), `yuanshi-import-${stamp}`)
			let index = 1
			while (await stat(target).then(() => true, () => false)) target = join(dirname(currentRoot), `yuanshi-import-${stamp}-${index++}`)
		}
		if (target === currentRoot || isInside(currentRoot, target) || isInside(target, currentRoot)) {
			throw new Error('导入目录不能与当前数据目录相同或互相包含。')
		}
		if (await stat(target).then(() => true, () => false)) throw new Error(`导入目录已存在：${target}`)
		const tempDir = await mkdtemp(join(tmpdir(), 'yuanshi-import-'))
		const source = join(tempDir, 'upload.tar.gz')
		try {
			await writeFile(source, archive, { mode: 0o600 })
			const imported = await readArchiveFile(source, target)
			await mkdir(join(target, 'files'), { recursive: true, mode: 0o700 })
			const counts = await validateLibrary(target)
			await writeDataDirPointer(pointerPath, target)
			logger?.info?.(`自衍中枢：已导入到 ${target}（${counts.files} 文件），下次启动切换`)
			return {
				dir: target,
				files: counts.files,
				bytes: counts.bytes,
				archiveBytes: archive.length,
				manifest: imported.manifest,
				restartRequired: true,
			}
		} catch (error) {
			await rm(target, { recursive: true, force: true }).catch(() => {})
			throw new Error(`导入失败：${error instanceof Error ? error.message : String(error)}`)
		} finally {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {})
		}
	}

	return { status, saveDir, exportLibrary, importLibrary }
}
