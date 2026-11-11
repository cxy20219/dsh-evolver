/**
 * Card resources: documents, scripts and other files attached to a card.
 *
 * A resource lives under `knowledge/resources/<card-id>/<name>`. The name is
 * sanitised to one path segment and the real path is computed from the card
 * id, never read from card metadata — a card cannot point the store outside
 * its own folder. Symbolic links are refused, files are written through a
 * temporary file and renamed, and reads are size-capped.
 */

import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { isCardId } from './ids.js'
import { isInsidePath, isReallyInside } from '../workspace.js'

/** One resource may not exceed this size. */
export const MAX_RESOURCE_BYTES = 10 * 1024 * 1024

/** A text resource larger than this is returned as metadata, not text. */
export const MAX_TEXT_READ_BYTES = 512 * 1024

/** The resource name pattern: no separators, no leading dot-dot. */
const RESOURCE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,119}$/u

/**
 * How many bytes one resource name may take.
 *
 * The backup writer emits ustar, whose name field is 100 bytes; with the card
 * folder in the prefix that leaves ~90 for the file name. A longer name is
 * accepted by the filesystem and then makes every export and every cloud
 * backup fail — for the whole library, not just that card.
 */
const MAX_RESOURCE_NAME_BYTES = 88

/**
 * Shorten a name to a byte budget, keeping a short extension.
 *
 * Truncating by characters is not enough: a Chinese name is three bytes per
 * character, so 120 characters can be 360 bytes.
 *
 * @param {string} name - The sanitised name.
 * @param {number} budget - Maximum UTF-8 bytes.
 * @returns {string} A name that fits.
 */
function clipToBytes(name, budget) {
	const dot = name.lastIndexOf('.')
	const suffix = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : ''
	const stemBudget = budget - Buffer.byteLength(suffix)
	let stem = suffix === '' ? name : name.slice(0, dot)
	while (Buffer.byteLength(stem) > stemBudget) stem = stem.slice(0, -1)
	return stem === '' ? 'file' + suffix : stem + suffix
}

/**
 * Turn an arbitrary file name into one safe path segment.
 *
 * @param {unknown} value - The raw name.
 * @returns {string} A safe name, or an empty string.
 */
export function safeResourceName(value) {
	const raw = String(value ?? '').replace(/\\/g, '/')
	let name = basename(raw)
		.normalize('NFC')
		.replace(/[^\p{L}\p{N}._-]+/gu, '-')
		.replace(/-+/g, '-')
		.replace(/^[-_]+|[-_]+$/g, '')
		.slice(0, 120)
	if (Buffer.byteLength(name) > MAX_RESOURCE_NAME_BYTES) name = clipToBytes(name, MAX_RESOURCE_NAME_BYTES)
	if (name === '' || name === '.' || name === '..') return ''
	if (!RESOURCE_NAME.test(name)) return ''
	return name
}


/** Names whose content is meant to be run directly. */
const EXECUTABLE_NAME = /\.(?:sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|lua|ps1)$/i

/**
 * Whether a payload looks like a native executable.
 *
 * @param {Buffer} content - The file head.
 * @returns {boolean} True for ELF, PE, Mach-O or a universal binary.
 */
function isNativeExecutable(content) {
	const head = content.subarray(0, 4)
	if (head.length < 2) return false
	if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return true
	if (head[0] === 0x4d && head[1] === 0x5a) return true
	if (head[0] === 0xcf && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe) return true
	if (head[0] === 0xfe && head[1] === 0xed && head[2] === 0xfa && (head[3] === 0xce || head[3] === 0xcf)) return true
	if (head[0] === 0xca && head[1] === 0xfe && head[2] === 0xba && head[3] === 0xbe) return true
	return false
}

/**
 * The path a card body should use to refer to one resource.
 *
 * It is relative to the data directory, so a card body is portable while the
 * absolute path stays available from `card_read`.
 *
 * @param {string} cardId - Card id.
 * @param {string} name - The raw file name.
 * @returns {string} `knowledge/resources/<card-id>/<safe-name>`.
 */
export function resourceRelativePath(cardId, name) {
	if (!isCardId(cardId)) throw new Error('卡片 id 不合法。')
	const safe = safeResourceName(name)
	if (safe === '') throw new Error(`资源文件名不合法：${String(name)}`)
	return `knowledge/resources/${cardId}/${safe}`
}

/**
 * The resources of one data folder.
 */
export class ResourceStore {
	/**
	 * @param {{root: string}} options - The data folder.
	 */
	constructor({ root }) {
		this.root = join(root, 'knowledge', 'resources')
	}

	/**
	 * The folder of one card's resources.
	 *
	 * @param {string} cardId - Card id.
	 * @returns {string} The absolute folder.
	 */
	folderOf(cardId) {
		if (!isCardId(cardId)) throw new Error('卡片 id 不合法。')
		return join(this.root, cardId)
	}

	/**
	 * Write one resource.
	 *
	 * @param {string} cardId - Card id.
	 * @param {string} name - The raw file name.
	 * @param {Buffer | string} data - The content.
	 * @returns {Promise<{name: string, bytes: number, sha256: string}>} The stored metadata.
	 */
	async put(cardId, name, data) {
		const safe = safeResourceName(name)
		if (safe === '') throw new Error(`资源文件名不合法：${String(name)}`)
		const content = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8')
		if (content.length > MAX_RESOURCE_BYTES) throw new Error(`资源超过 ${MAX_RESOURCE_BYTES / 1024 / 1024} MB 上限。`)
		const folder = this.folderOf(cardId)
		await mkdir(folder, { recursive: true, mode: 0o700 })
		if (!(await isReallyInside(this.root, folder))) throw new Error('资源目录不在数据目录内。')
		const target = join(folder, safe)
		if (!isInsidePath(folder, target)) throw new Error('资源路径不安全。')
		const temp = `${target}.${process.pid}.${Date.now()}.tmp`
		const executable = EXECUTABLE_NAME.test(safe) || content.subarray(0, 2).toString('utf8') === '#!' || isNativeExecutable(content)
		try {
			await writeFile(temp, content, { mode: executable ? 0o700 : 0o600 })
			await rename(temp, target)
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {})
			throw error
		}
		return { name: safe, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }
	}

	/**
	 * Read one resource as text when it looks like text.
	 *
	 * @param {string} cardId - Card id.
	 * @param {string} name - The resource name.
	 * @returns {Promise<{name: string, bytes: number, sha256: string, text?: string, binary?: true, path: string}>} The content or metadata.
	 */
	async read(cardId, name) {
		const safe = safeResourceName(name)
		if (safe === '') throw new Error('资源文件名不合法。')
		const path = join(this.folderOf(cardId), safe)
		const info = await lstat(path).catch(() => undefined)
		if (info === undefined || !info.isFile() || info.isSymbolicLink()) throw new Error(`找不到资源：${safe}`)
		if (info.size > MAX_RESOURCE_BYTES) throw new Error('资源过大，无法读取。')
		const buffer = await readFile(path)
		const executable = (info.mode & 0o111) !== 0
		const metadata = { name: safe, bytes: info.size, sha256: createHash('sha256').update(buffer).digest('hex'), path, executable }
		if (buffer.length > MAX_TEXT_READ_BYTES || buffer.includes(0)) return { ...metadata, binary: true }
		const text = buffer.toString('utf8')
		if (text.includes('\uFFFD')) return { ...metadata, binary: true }
		return { ...metadata, text }
	}

	/**
	 * List one card's resources.
	 *
	 * @param {string} cardId - Card id.
	 * @returns {Promise<Array<{name: string, bytes: number, sha256?: string}>>} The metadata.
	 */
	async list(cardId) {
		const folder = this.folderOf(cardId)
		const names = await readdir(folder).catch(() => [])
		const resources = []
		for (const name of names.sort()) {
			if (name.endsWith('.tmp')) continue
			const info = await lstat(join(folder, name)).catch(() => undefined)
			if (info === undefined || !info.isFile() || info.isSymbolicLink()) continue
			resources.push({ name, bytes: info.size, executable: (info.mode & 0o111) !== 0 })
		}
		return resources
	}

	/**
	 * Delete every resource of one card.
	 *
	 * @param {string} cardId - Card id.
	 * @returns {Promise<void>} Resolves after the folder is gone.
	 */
	async removeCard(cardId) {
		await rm(this.folderOf(cardId), { recursive: true, force: true }).catch(() => {})
	}

	/**
	 * Move one card's resources into a trash folder instead of deleting them.
	 *
	 * A card's body can be recovered from the trash log; its attachments
	 * cannot, and an attachment may be a script the tool description invites
	 * the agent to run. Renaming keeps one copy and is a single filesystem
	 * operation.
	 *
	 * @param {string} cardId - Card id.
	 * @param {string} trashRoot - Folder to move the card's folder into.
	 * @returns {Promise<boolean>} Whether anything was moved.
	 */
	async archiveCard(cardId, trashRoot) {
		const from = this.folderOf(cardId)
		const info = await lstat(from).catch(() => undefined)
		if (info === undefined || !info.isDirectory()) return false
		await mkdir(trashRoot, { recursive: true, mode: 0o700 })
		await rename(from, join(trashRoot, cardId))
		return true
	}

}
