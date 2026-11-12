/**
 * Moving the data folder around.
 *
 * The data folder is the migration unit, so the operations here are deliberately
 * boring: walk it, count it, copy it. Nothing is deleted — a migration copies
 * to the new place and leaves the old one in place, so a wrong path is always
 * recoverable.
 */

import { cp, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** Files that are never part of a backup, a copy or an archive. */
const SKIP_SUFFIXES = ['.tmp', '.part']

/**
 * Whether `child` is strictly inside `parent`.
 *
 * Both sides are resolved first, so `../` and trailing slashes cannot hide a
 * relationship between two paths.
 *
 * @param {string} parent - The containing path.
 * @param {string} child - The candidate path.
 * @returns {boolean} True when the child is inside.
 */
export function isInsidePath(parent, child) {
	const base = resolve(parent)
	const target = resolve(child)
	if (base === target) return false
	return target.startsWith(base + sep)
}

/**
 * Whether two paths are the same or contain each other.
 *
 * Copying in either direction would either recurse into a growing tree or
 * overwrite the source while it is being read, so both are refused.
 *
 * @param {string} first - One path.
 * @param {string} second - The other path.
 * @returns {boolean} True when they overlap.
 */
export function pathsOverlap(first, second) {
	const a = resolve(first)
	const b = resolve(second)
	return a === b || a.startsWith(b + sep) || b.startsWith(a + sep)
}

/**
 * Resolve a path to the directory it physically names.
 *
 * Two spellings of the same folder (a symlinked parent, for example) must be
 * recognised as the same folder before anything is copied; a missing target
 * falls back to its parent's real path plus the requested name.
 *
 * @param {string} path - The absolute path.
 * @returns {Promise<string>} The canonical path.
 */
export async function canonicalPath(path) {
	try {
		return await realpath(path)
	} catch {
		const parent = await realpath(dirname(path)).catch(() => undefined)
		return parent === undefined ? path : join(parent, basename(path))
	}
}

/**
 * Whether a path resolves to something inside `root`, following every link.
 *
 * The lexical helpers above cannot see a symlinked parent; anything that
 * writes files has to use this one before touching the disk.
 *
 * @param {string} root - The folder that must contain the target.
 * @param {string} target - The path to test.
 * @returns {Promise<boolean>} True when the target really stays inside.
 */
export async function isReallyInside(root, target) {
	const base = await realpath(root).catch(() => undefined)
	if (base === undefined) return false
	const probe = await canonicalPath(target)
	return probe === base || probe.startsWith(base + sep)
}

/**
 * Whether a path is an existing directory.
 *
 * @param {string} path - The path.
 * @returns {Promise<boolean>} True when it is a directory.
 */
export async function isDirectory(path) {
	try {
		const info = await lstat(path)
		return info.isDirectory()
	} catch {
		return false
	}
}

/**
 * How many entries a folder holds, if it exists.
 *
 * @param {string} path - The folder.
 * @returns {Promise<number>} The entry count.
 */
export async function countEntries(path) {
	try {
		return (await readdir(path)).length
	} catch {
		return 0
	}
}

/**
 * Whether a file name should be skipped by a copy, a backup or an archive.
 *
 * One list for all three on purpose: a half-written import temp (`.part`) or
 * the copy an overwriting import keeps (`.before-import-*`) must never travel
 * into the next archive or get copied into a new data folder.
 *
 * @param {string} name - The file name.
 * @returns {boolean} True when it is transient.
 */
export function isTransient(name) {
	if (name === '.DS_Store') return true
	if (name.includes('.before-import-')) return true
	return SKIP_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/**
 * Count and measure a tree.
 *
 * Symbolic links are skipped, not followed: the folder must be self-contained,
 * and a link could point into another disk (or back into the tree).
 *
 * @param {string} root - The folder.
 * @returns {Promise<{files: number, bytes: number, skippedLinks: number}>} The totals.
 */
export async function describeTree(root) {
	const totals = { files: 0, bytes: 0, skippedLinks: 0 }
	/**
	 * Walk one folder.
	 *
	 * @param {string} folder - The folder to walk.
	 * @returns {Promise<void>} Resolves when it was walked.
	 */
	async function walk(folder) {
		const names = await readdir(folder).catch(() => [])
		for (const name of names) {
			if (isTransient(name)) continue
			const path = join(folder, name)
			const info = await lstat(path).catch(() => undefined)
			if (info === undefined) continue
			if (info.isSymbolicLink()) {
				totals.skippedLinks += 1
				continue
			}
			if (info.isDirectory()) {
				await walk(path)
				continue
			}
			if (!info.isFile()) continue
			totals.files += 1
			totals.bytes += info.size
		}
	}
	await walk(root)
	return totals
}

/**
 * Copy one tree into another.
 *
 * Existing files are overwritten when `force` is set; otherwise they are left
 * alone, which makes an import additive by default.
 *
 * @param {string} source - The folder to copy from.
 * @param {string} target - The folder to copy into.
 * @param {{force?: boolean}} [options] - Overwrite behaviour.
 * @returns {Promise<{files: number, bytes: number, skippedLinks: number}>} What the source holds.
 */
export async function copyTree(source, target, { force = false } = {}) {
	await mkdir(target, { recursive: true, mode: 0o700 })
	const totals = { files: 0, bytes: 0, skippedLinks: 0 }
	/**
	 * Walk and copy one folder.
	 *
	 * @param {string} from - Source folder.
	 * @param {string} to - Destination folder.
	 * @returns {Promise<void>} Resolves when it was copied.
	 */
	async function walk(from, to) {
		const names = await readdir(from).catch(() => [])
		for (const name of names) {
			if (isTransient(name)) continue
			const fromPath = join(from, name)
			const info = await lstat(fromPath).catch(() => undefined)
			if (info === undefined) continue
			if (info.isSymbolicLink()) {
				totals.skippedLinks += 1
				continue
			}
			const toPath = join(to, name)
			if (info.isDirectory()) {
				await mkdir(toPath, { recursive: true, mode: 0o700 })
				await walk(fromPath, toPath)
				continue
			}
			if (!info.isFile()) continue
			// The totals describe what the source holds, whether or not this run
			// overwrites the destination.
			totals.files += 1
			totals.bytes += info.size
			await cp(fromPath, toPath, {
				force,
				errorOnExist: false,
				preserveTimestamps: true,
			})
		}
	}
	// One walk for both the copy and the report; a separate pre-scan doubled
	// the I/O of the one operation that touches every byte of the folder.
	await walk(source, target)
	return totals
}
