/**
 * The evolver's document layer.
 *
 * The live knowledge store is the card log (`src/cards/store.js`). This class
 * keeps the one document that is not a card — the global preferences.
 *
 *   <root>/
 *     knowledge/          cards and resources (CardStore)
 *     preferences/AGENTS.md
 *
 * The folder is the unit of migration and backup: copy it and everything moves.
 */

import { lstat, mkdir, open, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The global preferences, seeded when the folder is new. */
const STARTER_PREFS = `# 个人偏好

> 这里写跨项目、长期稳定的工作偏好；一次性经历放卡片，不放这里。
`

/**
 * The DeepSeek Harness home, resolved the same way the host resolves it.
 *
 * @param {Record<string, string | undefined>} env - The environment.
 * @returns {string} The absolute harness home path.
 */
export function resolveDshHome(env = process.env) {
	const configured = env.DSH_HOME
	if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
	return join(homedir(), '.dsh')
}

/** The largest global preferences file (matches the loader's 64 KB cap). */
export const MAX_PREFERENCES_BYTES = 64 * 1024

/**
 * The evolver's document layer.
 */
export class Evolver {
	/**
	 * @param {{root: string, logger?: object, dshHome?: string, version?: string}} deps - The options.
	 */
	constructor({ root, logger, dshHome, version }) {
		this.root = root
		this.logger = logger
		this.dshHome = dshHome ?? resolveDshHome()
		// The version is read from package.json by the caller; the evolver
		// itself must not reach for its own package.
		this.version = typeof version === 'string' ? version : ''
		/** Counts temp files so two writes in one millisecond cannot collide. */
		this.writeSequence = 0
	}

	/** The global preferences file's path. */
	get preferencesPath() {
		return join(this.root, 'preferences', 'AGENTS.md')
	}

	/** The global instruction file the harness reads. */
	get globalPath() {
		return join(this.dshHome, 'AGENTS.md')
	}

	/**
	 * Create the folder skeleton and the seed documents.
	 *
	 * The preferences are never overwritten.
	 *
	 * @returns {Promise<void>} Resolves once the folder is ready.
	 */
	async ensure() {
		await mkdir(this.root, { recursive: true, mode: 0o700 })
		await mkdir(join(this.root, 'preferences'), { recursive: true, mode: 0o700 })
		await this.writeIfMissing(this.preferencesPath, STARTER_PREFS)
	}

	/**
	 * Point the evolver at another data folder.
	 *
	 * @param {string} root - The new data folder.
	 * @returns {Promise<void>} Resolves once the new folder is in use.
	 */
	async switchRoot(root) {
		const previous = this.root
		this.root = root
		try {
			await this.ensure()
		} catch (error) {
			this.root = previous
			throw error
		}
		await this.relinkAfterMove(previous)
	}

	/**
	 * Move the harness-home preferences link to the new data folder.
	 *
	 * @param {string} previousRoot - The folder the evolver used before.
	 * @returns {Promise<void>} Resolves once the link was checked.
	 */
	async relinkAfterMove(previousRoot) {
		if (previousRoot === this.root) return
		try {
			const info = await lstat(this.globalPath)
			if (!info.isSymbolicLink()) return
			const target = resolve(dirname(this.globalPath), await readlink(this.globalPath))
			const previousPreferences = resolve(join(previousRoot, 'preferences', 'AGENTS.md'))
			if (target !== previousPreferences) return
			await rm(this.globalPath, { force: true })
			await symlink(this.preferencesPath, this.globalPath)
			this.logger?.info?.('dsh-evolver: the global preferences link followed the data folder')
		} catch {
			// No link yet: nothing to move.
		}
	}

	/**
	 * Link the harness-home preferences file when nobody else owns it.
	 *
	 * @returns {Promise<void>} Resolves once the link was checked.
	 */
	async linkGlobalIfNeeded() {
		try {
			const state = await this.globalLinkState()
			if (state.kind === 'missing') await this.linkGlobal()
		} catch (error) {
			this.logger?.warn?.(`dsh-evolver: global preferences link failed: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/**
	 * Write a file only when it does not exist yet.
	 *
	 * @param {string} path - The target.
	 * @param {string} content - The content.
	 * @returns {Promise<void>} Resolves after the attempt.
	 */
	async writeIfMissing(path, content) {
		const info = await lstat(path).catch(() => undefined)
		if (info !== undefined) return
		await mkdir(dirname(path), { recursive: true, mode: 0o700 })
		await writeFile(path, content, { encoding: 'utf8', mode: 0o600 })
	}

	/**
	 * Replace a document through a uniquely named temporary file.
	 *
	 * @param {string} path - Absolute target.
	 * @param {string} text - File content.
	 * @returns {Promise<void>} Resolves once the rename is committed.
	 */
	async writeDocument(path, text) {
		this.writeSequence += 1
		const temp = `${path}.${process.pid}.${this.writeSequence}.tmp`
		try {
			await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
			await rename(temp, path)
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {})
			throw error
		}
	}

	/**
	 * Read the global preferences and the state of the harness link.
	 *
	 * @returns {Promise<object>} The preferences state.
	 */
	async preferencesRead() {
		let content = ''
		let truncated = false
		let fullBytes = 0
		try {
			const info = await lstat(this.preferencesPath)
			fullBytes = info.size
			truncated = info.size > MAX_PREFERENCES_BYTES
			content = truncated ? await readHead(this.preferencesPath, MAX_PREFERENCES_BYTES) : await readFile(this.preferencesPath, 'utf8')
		} catch {
			content = ''
		}
		return {
			path: 'preferences/AGENTS.md',
			globalPath: this.globalPath,
			content,
			bytes: Buffer.byteLength(content, 'utf8'),
			fullBytes,
			truncated: truncated || undefined,
			link: await this.globalLinkState(),
		}
	}

	/**
	 * Write the global preferences.
	 *
	 * @param {string} content - The new content.
	 * @returns {Promise<object>} The preferences state.
	 */
	async preferencesWrite(content) {
		const text = String(content ?? '')
		if (Buffer.byteLength(text, 'utf8') > MAX_PREFERENCES_BYTES) {
			throw new Error(`全局偏好超过 ${MAX_PREFERENCES_BYTES} 字节，DSH 的加载器会截断，请精简。`)
		}
		await mkdir(dirname(this.preferencesPath), { recursive: true, mode: 0o700 })
		await this.writeDocument(this.preferencesPath, text)
		return this.preferencesRead()
	}

	/**
	 * The state of the harness home's `AGENTS.md`.
	 *
	 * @returns {Promise<{kind: string, target?: string}>} The link state.
	 */
	async globalLinkState() {
		try {
			const info = await lstat(this.globalPath)
			if (info.isSymbolicLink()) {
				const target = await readlink(this.globalPath)
				const resolved = resolve(dirname(this.globalPath), target)
				return { kind: 'link', target, ours: resolved === resolve(this.preferencesPath) }
			}
			if (info.isFile()) return { kind: 'file' }
			return { kind: 'other' }
		} catch {
			return { kind: 'missing' }
		}
	}

	/**
	 * Point the harness home's `AGENTS.md` at the evolver's preferences file.
	 *
	 * @returns {Promise<{linked: boolean, message: string}>} What happened.
	 */
	async linkGlobal() {
		const state = await this.globalLinkState()
		if (state.kind === 'link' && state.ours) {
			return { linked: true, message: `已链接，DSH 全局加载 ${this.globalPath}。` }
		}
		if (state.kind === 'other') {
			throw new Error(`${this.globalPath} 存在但不是普通文件，无法替换，请先手动处理。`)
		}
		if (state.kind === 'file' || state.kind === 'link') {
			const original = await readFile(this.globalPath, 'utf8').catch(() => undefined)
			if (original !== undefined) {
				await this.writeIfMissing(join(this.root, 'preferences', 'AGENTS.md.imported'), original)
			}
		}
		await rm(this.globalPath, { force: true })
		await mkdir(dirname(this.globalPath), { recursive: true })
		await symlink(this.preferencesPath, this.globalPath)
		return { linked: true, message: `已链接，DSH 全局加载 ${this.globalPath}。` }
	}

	/**
	 * Remove the harness home's link, leaving the preferences file untouched.
	 *
	 * @returns {Promise<{linked: boolean, message: string}>} What happened.
	 */
	async unlinkGlobal() {
		const state = await this.globalLinkState()
		if (state.kind !== 'link') return { linked: false, message: '全局链接本来就不存在。' }
		if (!state.ours) {
			return {
				linked: false,
				foreign: true,
				message: `${this.globalPath} 的链接不是本插件建立的（指向 ${state.target}），没有移除。`,
			}
		}
		await rm(this.globalPath, { force: true })
		return { linked: false, message: '已移除全局链接。' }
	}

	/**
	 * The preferences block, exactly as it is injected.
	 *
	 * The card projection is supplied by the card API; this method only owns
	 * the global preferences.
	 *
	 * @returns {Promise<object>} The injection preview.
	 */
	async injectionPreview() {
		const preferences = await this.preferencesRead()
		return {
			preferences: {
				path: preferences.path,
				globalPath: preferences.globalPath,
				text: preferences.content,
				bytes: preferences.bytes,
				link: preferences.link,
				truncated: preferences.truncated === true ? true : undefined,
				note: '全局偏好由 DSH 的 AGENTS.md 加载器注入，不占用演化器自己的预算。',
			},
			totalBytes: preferences.bytes,
		}
	}

	/**
	 * The document part of the panel overview.
	 *
	 * @returns {Promise<object>} Version, root and preferences.
	 */
	async overview() {
		const preferences = await this.preferencesRead()
		return {
			version: this.version,
			root: this.root,
			preferences: {
				bytes: preferences.bytes,
				globalPath: preferences.globalPath,
				link: preferences.link,
			},
			suggestions: [],
		}
	}
}

/**
 * Read the first bytes of a file as UTF-8.
 *
 * @param {string} path - The file.
 * @param {number} limit - The byte limit.
 * @returns {Promise<string>} The decoded head.
 */
async function readHead(path, limit) {
	const handle = await open(path, 'r')
	try {
		const buffer = Buffer.alloc(limit)
		const { bytesRead } = await handle.read(buffer, 0, limit, 0)
		return buffer.subarray(0, bytesRead).toString('utf8')
	} finally {
		await handle.close()
	}
}
