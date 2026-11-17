/**
 * Path facts the project verbs need: where a project starts, and whether a
 * path stays inside it.
 *
 * These are the only pieces of the retired harness system worth keeping. The
 * harness folder itself is now an ordinary folder — written by whatever tool
 * the project uses, with no sidecar, no generated index and no validation — but
 * a path still has to resolve against something stable, and writes still have
 * to stay inside the project the session belongs to.
 */

import { realpathSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * Whether a path exists, without caring why it might not.
 *
 * @param {string} path - The path.
 * @returns {Promise<boolean>} True when something is there.
 */
async function exists(path) {
	return lstat(path).then(() => true, () => false)
}

/**
 * The on-disk identity of a path, resolving whatever prefix actually exists.
 *
 * @param {string} path - An absolute path, possibly with missing tail segments.
 * @returns {string | undefined} The physical path, or undefined when nothing resolves.
 */
function physicalPath(path) {
	const resolved = resolve(path)
	const tail = []
	let current = resolved
	for (;;) {
		try {
			const real = realpathSync.native(current)
			return tail.length === 0 ? real : join(real, ...tail.reverse())
		} catch {
			const parent = dirname(current)
			// Nothing on this path resolves (a nonexistent drive, a UNC root
			// the process cannot see): the lexical spelling is all we have.
			if (parent === current) return undefined
			tail.push(basename(current))
			current = parent
		}
	}
}

/**
 * Whether one absolute path is the same as, or below, another.
 *
 * Containment is decided on the *physical* path whenever both sides resolve:
 * a junction or symlink is followed, so a folder that only looks like a
 * descendant is not treated as one, and two spellings of the same folder
 * (case on Windows, a linked parent) are recognised as the same folder. When
 * resolution fails even for the existing prefix, the lexical spelling is the
 * only evidence there is and is used as a fallback; a caller that must not be
 * fooled refuses in that case itself.
 *
 * @param {string} parent - The candidate container.
 * @param {string} child - The candidate contained path.
 * @returns {boolean} True when `child` is `parent` or below it.
 */
export function isWithin(parent, child) {
	if (typeof parent !== 'string' || typeof child !== 'string') return false
	if (!isAbsolute(parent) || !isAbsolute(child)) return false
	const fold = (value) => {
		const resolved = resolve(value)
		const trimmed = resolved !== sep && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved
		return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
	}
	const contains = (base, probe) => probe === base || probe.startsWith(base + sep)
	const physicalParent = physicalPath(parent)
	const physicalChild = physicalPath(child)
	if (physicalParent !== undefined && physicalChild !== undefined) {
		return contains(fold(physicalParent), fold(physicalChild))
	}
	return contains(fold(parent), fold(child))
}

/**
 * The project root that contains a path.
 *
 * Markers, in the order a person would recognise them: a repository, the
 * injected instructions file, and the `harness/` folder the older layout used.
 * The harness marker stays because six projects on this machine have one and
 * it predates the repository in some of them; it says where the project
 * starts, and nothing more.
 *
 * The start has to exist. Walking up from a path that is gone would eventually
 * find an unrelated marker (a home directory that happens to be a repository)
 * and point a write there; a path that names nothing is not evidence of any
 * project, so the caller gets `undefined` and has to ask for an explicit one.
 *
 * @param {string} start - A file or directory inside the project.
 * @returns {Promise<string | undefined>} The absolute root, or undefined.
 */
export async function projectRootOf(start) {
	if (typeof start !== 'string' || start === '' || !isAbsolute(start)) return undefined
	const resolved = resolve(start)
	const info = await lstat(resolved).catch(() => undefined)
	if (info === undefined) return undefined
	let current = info.isDirectory() ? resolved : dirname(resolved)
	for (;;) {
		for (const marker of ['.git', 'harness', 'AGENTS.md']) {
			if (await exists(join(current, marker))) return current
		}
		const parent = dirname(current)
		if (parent === current) return undefined
		current = parent
	}
}
