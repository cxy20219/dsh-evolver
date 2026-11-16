/**
 * 全局偏好：DSH 在每个会话开始前读取 `~/.dsh/AGENTS.md`。
 *
 * 数据统一放在自衍中枢的数据目录里：权威文件是 `<dataDir>/system/AGENTS.md`，
 * DSH 读的 `~/.dsh/AGENTS.md` 通过软链指向它（不能建软链时退化为两边同步写）。
 * 于是面板里看到并编辑的是**整份 AGENTS.md**，不是某个受管段落；改这里就是
 * 改 DSH 实际注入的全文，数据仍然只落在一个指定目录。
 *
 * 迁移：第一次接管时把现有 `~/.dsh/AGENTS.md` 的全文（可能是旧 evolver 的
 * 软链目标）复制进数据目录，剔掉旧版 ziyan 偏好段的注释标记（内容保留），
 * 再把 `AGENTS.md` 重新指向数据目录。旧文件/旧目标不删除。
 *
 * 双写模式：入口文件就是 DSH 每次会话开始真正读的那份文件，所以没有软链
 * 可建时，它必须和权威文件是同一份内容——否则面板改的是一份、DSH 注入的
 * 还是另一份。指向别处的软链会被换成普通文件，它原来指向的文件留在原地。
 */

import { lstat, mkdir, readFile, readlink, rename, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { writeFileAtomic } from './atomic.js'

/** DSH 的 AGENTS.md 加载器读的文件名（位于 DSH home 下）。 */
export const PREFERENCES_FILE = 'AGENTS.md'

/** 和 DSH 的加载器一致的上限：再长就会被截断。 */
export const MAX_PREFERENCES_BYTES = 64 * 1024

/** 旧版 ziyan 的受管段标记；迁移时只删标记行，段内内容保留。 */
const LEGACY_BEGIN = '<!-- ziyan:preferences:begin -->'
const LEGACY_END = '<!-- ziyan:preferences:end -->'

/**
 * DSH 读取的偏好文件路径。
 *
 * @param {string} dshHome - DSH home 目录。
 * @returns {string} 绝对路径。
 */
export function preferencesPath(dshHome) {
	return join(dshHome, PREFERENCES_FILE)
}

/**
 * 自衍中枢数据目录里的权威偏好文件。
 *
 * @param {string} dataDir - 插件数据目录。
 * @returns {string} 绝对路径。
 */
export function preferencesDataPath(dataDir) {
	return join(dataDir, 'system', PREFERENCES_FILE)
}

/**
 * 读文件，不存在时报 `exists: false`，其它错误照抛。
 *
 * @param {string} path - 文件。
 * @returns {Promise<{exists: boolean, text: string}>} 内容。
 */
async function readOptional(path) {
	try {
		return { exists: true, text: await readFile(path, 'utf8') }
	} catch (error) {
		if (error?.code === 'ENOENT') return { exists: false, text: '' }
		throw error
	}
}

/**
 * 去掉旧版偏好段的注释标记，保留段内正文。
 *
 * @param {string} text - 文件全文。
 * @returns {string} 去掉标记行后的文本。
 */
function withoutLegacyMarkers(text) {
	const lines = String(text ?? '').split('\n')
	const kept = lines.filter((line) => {
		const trimmed = line.trim()
		return trimmed !== LEGACY_BEGIN && trimmed !== LEGACY_END
	})
	return kept.join('\n')
}

/**
 * 两条路径是否指向同一文件（Windows 大小写不敏感）。
 *
 * @param {string} a - 路径。
 * @param {string} b - 路径。
 * @returns {boolean} 是否相同。
 */
function samePath(a, b) {
	const left = resolve(a)
	const right = resolve(b)
	if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
	return left === right
}

/**
 * `AGENTS.md` 当前是什么形态。
 *
 * @param {string} agentsPath - `~/.dsh/AGENTS.md`。
 * @param {string} dataPath - 权威数据文件。
 * @returns {Promise<'missing' | 'link' | 'other' | 'file'>} 形态。
 */
async function linkState(agentsPath, dataPath) {
	let info
	try {
		info = await lstat(agentsPath)
	} catch (error) {
		if (error?.code === 'ENOENT') return 'missing'
		throw error
	}
	if (!info.isSymbolicLink()) return 'file'
	const target = resolve(dirname(agentsPath), await readlink(agentsPath))
	return samePath(target, dataPath) ? 'link' : 'other'
}

/**
 * 把 `AGENTS.md` 原子地换成指向数据文件的软链。
 *
 * @param {string} agentsPath - 链接路径。
 * @param {string} dataPath - 目标数据文件。
 * @returns {Promise<void>} 完成。
 */
async function writeSymlink(agentsPath, dataPath) {
	await mkdir(dirname(agentsPath), { recursive: true })
	const temporary = `${agentsPath}.ziyan-${process.pid}-${Date.now()}.tmp`
	await symlink(dataPath, temporary, 'file')
	try {
		await rename(temporary, agentsPath)
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {})
		throw error
	}
}

/**
 * 让入口文件在没有软链时也带着权威文件的全文。
 *
 * 入口就是 DSH 每次会话开始真正读的那份文件：没有软链可建时，它必须和权威
 * 文件是同一份内容，否则面板编辑的是一份、DSH 注入的还是另一份。指向别处
 * 的软链会被换成普通文件——它原来指向的文件留在原地，只有入口这个注入点被
 * 接管，与软链模式重新指向同一件事。
 *
 * @param {string} agentsPath - `~/.dsh/AGENTS.md`。
 * @param {string} content - 权威文件的全文。
 * @returns {Promise<void>} 完成。
 */
async function writeEntryCopy(agentsPath, content) {
	let info
	try {
		info = await lstat(agentsPath)
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error
		info = undefined
	}
	if (info?.isSymbolicLink()) {
		await rm(agentsPath, { force: true })
		info = undefined
	}
	if (info !== undefined) {
		const current = await readOptional(agentsPath)
		if (current.exists && current.text === content) return
	}
	await writeFileAtomic(agentsPath, content, { mode: 0o644 })
}

/**
 * 确保「数据文件存在 + AGENTS.md 指向它」，并在需要时迁移旧内容。
 *
 * 不删除旧目标：只把内容复制进数据目录、移动链接，旧 evolver 的数据保持原样。
 *
 * @param {string} dshHome - DSH home。
 * @param {string} dataDir - 插件数据目录。
 * @param {{allowLink?: boolean}} [options] - `allowLink:false` 表示不尝试建软链（测试用）。
 * @returns {Promise<{dataPath: string, agentsPath: string, mode: 'link' | 'copy', destination: string, content: string}>} 就绪状态。
 */
async function prepare(dshHome, dataDir, { allowLink = true } = {}) {
	const dataPath = preferencesDataPath(dataDir)
	const agentsPath = preferencesPath(dshHome)
	const current = await readOptional(agentsPath)
	const stored = await readOptional(dataPath)
	let content
	let state
	if (!stored.exists) {
		content = withoutLegacyMarkers(current.text)
		await mkdir(dirname(dataPath), { recursive: true })
		await writeFileAtomic(dataPath, content, { mode: 0o644 })
	} else {
		content = stored.text
		state = await linkState(agentsPath, dataPath)
		// 外部把 AGENTS.md 换成了自己的文件：它才是 DSH 真正读的东西，以它为准迁回数据目录。
		if (state === 'file' || state === 'other') {
			const external = withoutLegacyMarkers(current.text)
			if (external !== stored.text) {
				content = external
				await writeFileAtomic(dataPath, content, { mode: 0o644 })
			}
		}
	}
	state = await linkState(agentsPath, dataPath)
	let mode = 'link'
	if (state !== 'link') {
		if (!allowLink) {
			mode = 'copy'
		} else {
			try {
				await writeSymlink(agentsPath, dataPath)
			} catch {
				// 没有建软链的权限（Windows 未开开发者模式）：退化为「数据文件 + AGENTS.md」双写。
				mode = 'copy'
			}
		}
	}
	// 入口是 DSH 真正读的那份文件：没有软链时它必须和权威文件同内容，
	// 否则面板改的是一份、DSH 注入的还是另一份。
	if (mode === 'copy') {
		await writeEntryCopy(agentsPath, content)
	}
	const destination = mode === 'link' ? dataPath : agentsPath
	return { dataPath, agentsPath, mode, destination, content }
}

/**
 * 读取偏好与文件状态。
 *
 * “文件不存在/读不出来”和“空文件”必须分得开：前端据此决定能不能保存，否则
 * 一个读失败就会把空字符串写回去，把用户的规则清空。
 *
 * @param {{dshHome: string, dataDir: string, allowLink?: boolean}} options - DSH home 与插件数据目录；`allowLink:false` 表示不建软链（测试用）。
 * @returns {Promise<object>} 偏好状态。
 */
export async function readPreferences({ dshHome, dataDir, allowLink = true }) {
	const dataPath = preferencesDataPath(dataDir)
	const agentsPath = preferencesPath(dshHome)
	let prepared
	try {
		prepared = await prepare(dshHome, dataDir, { allowLink })
	} catch {
		return {
			path: dataPath,
			agentsPath,
			mode: 'unknown',
			destination: agentsPath,
			exists: false,
			readable: false,
			content: '',
			bytes: 0,
			totalBytes: 0,
			cap: MAX_PREFERENCES_BYTES,
		}
	}
	// 面板按「用户可编辑的正文」展示：末尾换行不算内容，保存时会补回。
	const content = prepared.content.replace(/\s+$/, '')
	return {
		path: prepared.dataPath,
		agentsPath: prepared.agentsPath,
		mode: prepared.mode,
		destination: prepared.destination,
		exists: true,
		readable: true,
		content,
		bytes: Buffer.byteLength(content, 'utf8'),
		totalBytes: Buffer.byteLength(prepared.content, 'utf8'),
		cap: MAX_PREFERENCES_BYTES,
	}
}

/**
 * 写入整份偏好：先写数据目录里的权威文件，copy 模式下再同步到 AGENTS.md。
 *
 * @param {{dshHome: string, dataDir: string, allowLink?: boolean}} options - DSH home 与插件数据目录；`allowLink:false` 表示不建软链（测试用）。
 * @param {unknown} value - 新的 AGENTS.md 全文。
 * @returns {Promise<object>} 写入后的偏好状态。
 */
export async function writePreferences({ dshHome, dataDir, allowLink = true }, value) {
	const content = withoutLegacyMarkers(String(value ?? ''))
		.split(LEGACY_BEGIN).join('')
		.split(LEGACY_END).join('')
		.replace(/\s+$/, '')
	if (Buffer.byteLength(content, 'utf8') > MAX_PREFERENCES_BYTES) {
		throw new Error(`偏好超过 ${MAX_PREFERENCES_BYTES} 字节，DSH 的加载器会截断，请精简。`)
	}
	const prepared = await prepare(dshHome, dataDir, { allowLink })
	const written = content === '' ? '' : `${content}\n`
	await writeFileAtomic(prepared.dataPath, written, { mode: 0o644 })
	if (prepared.mode === 'copy') {
		await writeFileAtomic(prepared.destination, written, { mode: 0o644 })
	}
	return readPreferences({ dshHome, dataDir })
}
