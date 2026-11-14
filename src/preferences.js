/**
 * 全局偏好：插件注入给每个会话的那一段。
 *
 * DSH 在会话开始前读取 `~/.dsh/AGENTS.md`，所以偏好就写在这个文件里，用一对
 * 注释标记圈出插件维护的段落。段落以外的字节一个都不动——那多半是用户自己
 * 的规则，覆盖它就是事故。
 *
 * 为什么不学旧 evolver 直接把这个路径软链到 `preferences/AGENTS.md`：软链要
 * 先把用户已有的 AGENTS.md 挪走，Windows 上还要求开发者模式；而标记段落既
 * 不破坏已有内容，也不依赖软链权限，DSH 的加载器一样会把它注入每个会话。
 */

import { lstat, readFile, readlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { writeFileAtomic } from './atomic.js'

/** DSH 的 AGENTS.md 加载器读的文件名（位于 DSH home 下）。 */
export const PREFERENCES_FILE = 'AGENTS.md'

/** 偏好段落的起始标记。 */
export const BEGIN_MARKER = '<!-- ziyan:preferences:begin -->'

/** 偏好段落的结束标记。 */
export const END_MARKER = '<!-- ziyan:preferences:end -->'

/** 和 DSH 的加载器一致的上限：再长就会被截断。 */
export const MAX_PREFERENCES_BYTES = 64 * 1024

/**
 * 偏好所在文件的绝对路径。
 *
 * @param {string} dshHome - DSH home 目录。
 * @returns {string} 绝对路径。
 */
export function preferencesPath(dshHome) {
	return join(dshHome, PREFERENCES_FILE)
}

/**
 * 拆出标记段落。
 *
 * @param {string} text - 文件全文。
 * @returns {{hasBlock: boolean, content: string}} 段落内容。
 */
function splitBlock(text) {
	const begin = text.indexOf(BEGIN_MARKER)
	const end = begin === -1 ? -1 : text.indexOf(END_MARKER, begin + BEGIN_MARKER.length)
	if (begin === -1 || end === -1) return { hasBlock: false, content: '' }
	const raw = text.slice(begin + BEGIN_MARKER.length, end)
	return { hasBlock: true, content: raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '') }
}

/**
 * 找到真正要写的文件。
 *
 * `~/.dsh/AGENTS.md` 可能是个软链（旧 evolver 就是这么接的：链到
 * `evolver/preferences/AGENTS.md`）。原子写是「临时文件 + rename」，rename 会
 * 把链接本身换掉——写一次就把链接写没了。所以先解析出真实目标，原子写落在
 * 目标上，链接原样留着。
 *
 * @param {string} path - 逻辑路径。
 * @returns {Promise<{target: string, link: string}>} 写入目标与链接值（没有链接时为空串）。
 */
async function writeTarget(path) {
	try {
		const info = await lstat(path)
		if (!info.isSymbolicLink()) return { target: path, link: '' }
		const link = await readlink(path)
		return { target: resolve(dirname(path), link), link }
	} catch (error) {
		if (error?.code === 'ENOENT') return { target: path, link: '' }
		throw error
	}
}

/**
 * 读取偏好与文件状态。
 *
 * “文件不存在”和“读不出来”必须分得开：前端据此决定能不能保存，否则一个读
 * 失败就会把空字符串写回去，把用户的规则清空。
 *
 * @param {string} dshHome - DSH home 目录。
 * @returns {Promise<object>} 偏好状态。
 */
export async function readPreferences(dshHome) {
	const path = preferencesPath(dshHome)
	let text = ''
	let exists = false
	let readable = true
	try {
		text = await readFile(path, 'utf8')
		exists = true
	} catch (error) {
		if (error?.code !== 'ENOENT') readable = false
	}
	const { hasBlock, content } = splitBlock(text)
	const resolved = await writeTarget(path)
	return {
		path,
		link: resolved.link,
		target: resolved.target,
		exists,
		readable,
		hasBlock,
		content,
		bytes: Buffer.byteLength(content, 'utf8'),
		totalBytes: Buffer.byteLength(text, 'utf8'),
		cap: MAX_PREFERENCES_BYTES,
	}
}

/**
 * 写入偏好，只替换标记段落。
 *
 * @param {string} dshHome - DSH home 目录。
 * @param {unknown} value - 新的偏好 Markdown。
 * @returns {Promise<object>} 写入后的偏好状态。
 */
export async function writePreferences(dshHome, value) {
	// 内容里若带标记，会把自己这一段的边界搅乱，先剔掉。
	const content = String(value ?? '')
		.split(BEGIN_MARKER)
		.join('')
		.split(END_MARKER)
		.join('')
		.trimEnd()
	if (Buffer.byteLength(content, 'utf8') > MAX_PREFERENCES_BYTES) {
		throw new Error(`偏好超过 ${MAX_PREFERENCES_BYTES} 字节，DSH 的加载器会截断，请精简。`)
	}
	const path = preferencesPath(dshHome)
	let existing = ''
	try {
		existing = await readFile(path, 'utf8')
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error
	}
	const begin = existing.indexOf(BEGIN_MARKER)
	const end = begin === -1 ? -1 : existing.indexOf(END_MARKER, begin + BEGIN_MARKER.length)
	const block = `${BEGIN_MARKER}\n${content}\n${END_MARKER}`
	let next
	if (begin !== -1 && end !== -1) {
		next = existing.slice(0, begin) + block + existing.slice(end + END_MARKER.length)
	} else if (existing.trim() === '') {
		next = `${block}\n`
	} else {
		// 用户已经有自己的 AGENTS.md：接在后面，不碰上面的内容。
		next = `${existing}${existing.endsWith('\n') ? '\n' : '\n\n'}${block}\n`
	}
	// 这个文件是给人读的指令文件，不是库里的私密数据，用普通权限即可。
	// 写的是链接指向的真实文件：链接本身要留着，否则 DSH 下一次就找不到它。
	const resolved = await writeTarget(path)
	await writeFileAtomic(resolved.target, next, { mode: 0o644 })
	return readPreferences(dshHome)
}
