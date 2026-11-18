#!/usr/bin/env node
/**
 * `ziyan` — the library from a shell.
 *
 * This is the same four verbs the panel and MCP already had, exposed where an
 * agent can reach them without any host integration: one command, one exit
 * code, compact text out. The tool objects in `src/tools.js` do the work; this
 * file only parses arguments and formats what comes back, so behaviour cannot
 * drift between the CLI, the panel and MCP.
 *
 * Text is the default because an agent pays for every token it reads. `--json`
 * exists for the caller that needs to parse, not for the caller that needs to
 * understand.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { projectRootOf } from '../src/project.js'
import { FileStore } from '../src/store.js'
import { createTools } from '../src/tools.js'

/** Where the library lives when nothing says otherwise, in priority order. */
const DATA_DIR_CANDIDATES = [
	join(homedir(), '.ziyan'),
	join(homedir(), '.dsh', 'ziyan'),
]

/**
 * Split argv into a subcommand, positionals and `--flags`.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{command: string, args: string[], flags: Record<string, string | boolean>}} The parse.
 */
function parseArgv(argv) {
	const command = argv[0] ?? ''
	const args = []
	const flags = {}
	for (let index = 1; index < argv.length; index += 1) {
		const token = argv[index]
		if (token.startsWith('--')) {
			const [name, inline] = token.slice(2).split('=', 2)
			if (inline !== undefined) {
				flags[name] = inline
			} else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
				flags[name] = argv[index + 1]
				index += 1
			} else {
				flags[name] = true
			}
		} else {
			args.push(token)
		}
	}
	return { command, args, flags }
}

/**
 * Which library to open.
 *
 * An explicit flag or environment variable wins; otherwise the first existing
 * candidate. The standalone app uses `~/.ziyan`, the DSH plugin `~/.dsh/ziyan`,
 * and both are reachable without configuration.
 *
 * @param {Record<string, string | boolean>} flags - Parsed flags.
 * @returns {string} The directory (may not exist yet; the store creates it).
 */
async function resolveDataDir(flags) {
	const explicit = typeof flags['data-dir'] === 'string' ? flags['data-dir'] : process.env.ZIYAN_DATA_DIR
	if (typeof explicit === 'string' && explicit.trim() !== '') {
		if (!isAbsolute(explicit)) throw new Error(`--data-dir 必须是绝对路径：${explicit}`)
		return resolve(explicit)
	}
	const { stat } = await import('node:fs/promises')
	for (const candidate of DATA_DIR_CANDIDATES) {
		const info = await stat(join(candidate, 'files')).catch(() => undefined)
		if (info?.isDirectory()) return candidate
	}
	return DATA_DIR_CANDIDATES[0]
}

/**
 * Open the library and hand back the tools bound to this process's cwd.
 *
 * The CLI knows where it is, so project paths work here even though they do
 * not over MCP (which carries no session).
 *
 * @param {string} dataDir - The library root.
 * @returns {Promise<{store: object, tools: Map<string, object>}>} The opened library.
 */
async function openLibrary(dataDir) {
	const store = new FileStore({ dataDir })
	await store.open()
	const cwd = process.cwd()
	const root = (await projectRootOf(cwd)) ?? cwd
	const tools = new Map(createTools({
		store,
		paths: async () => ({ cwd, root }),
	}).map((tool) => [tool.name, tool]))
	return { store, tools }
}

/**
 * Format one search result for a reader, not a parser.
 *
 * @param {object} result - What `file_search` returned.
 * @returns {string} The text.
 */
function formatSearch(result) {
	if (result.total === 0) return '没有匹配的文件。'
	const lines = [`共 ${result.total} 个`]
	for (const file of result.files ?? []) {
		const tags = (file.tags ?? []).map((tag) => `#${tag}`).join(' ') || '无标签'
		lines.push(
			`${file.short ?? file.id}  ${file.name}  ${file.bytes}B  ${tags}`,
			`  ${file.description}`,
			`  id=${file.id}${file.degree ? `  ↳${file.degree.in}/↰${file.degree.out}` : ''}`,
		)
	}
	if (result.next !== undefined && result.next !== '') lines.push(`  ${result.next}`)
	return lines.join('\n')
}

/**
 * The shortest spelling of a link or neighbour: a bare id, or an object's short id.
 *
 * @param {string | {id?: string, short?: string}} link - The reference.
 * @returns {string} The label.
 */
function labelOf(link) {
	if (typeof link === 'string') return link.slice(-5)
	return link?.short ?? link?.id ?? ''
}

/**
 * Format one file for a reader: metadata first, body after.
 *
 * @param {object} result - What `file_read` returned.
 * @param {boolean} raw - Whether to print only the body.
 * @returns {string} The text.
 */
function formatRead(result, raw, target) {
	if (result.found === false) return `没有这个文件：${result.target ?? target ?? ''}`
	if (raw) return result.text ?? ''
	const head = [
		`${result.name}  ${result.mime}  ${result.bytes}B  ${result.id}`,
		`描述：${result.description ?? ''}`,
	]
	const tags = (result.tags ?? []).map((tag) => `#${tag}`).join(' ')
	if (tags !== '') head.push(`标签：${tags}`)
	const links = (result.links ?? []).map(labelOf).filter((label) => label !== '')
	if (links.length > 0) head.push(`关联：${links.join(' ')}`)
	const backlinks = (result.backlinks ?? []).map(labelOf).filter((label) => label !== '')
	if (backlinks.length > 0) head.push(`被引用：${backlinks.join(' ')}`)
	if (result.truncated === true) head.push(`正文已截断，完整文件在：${result.path}`)
	return `${head.join('\n')}\n\n${result.text ?? ''}`
}

/**
 * Print to stdout and exit non-zero on refusal.
 *
 * @param {() => Promise<string>} run - The work.
 * @returns {Promise<void>} Resolves after printing.
 */
async function main(run) {
	try {
		const text = await run()
		process.stdout.write(`${text}\n`)
	} catch (error) {
		process.stderr.write(`ziyan: ${String(error?.message ?? error)}\n`)
		process.exitCode = 1
	}
}

const { command, args, flags } = parseArgv(process.argv.slice(2))

switch (command) {
	case 'search': {
		await main(async () => {
			const { tools } = await openLibrary(await resolveDataDir(flags))
			const result = await tools.get('file_search').execute({
				query: args.join(' '),
				tags: typeof flags.tags === 'string' ? flags.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
				limit: typeof flags.limit === 'string' ? Number(flags.limit) : 20,
				graph: flags.graph === true,
			})
			if (flags.json === true) return JSON.stringify(result, null, 2)
			return formatSearch(result)
		})
		break
	}
	case 'read': {
		await main(async () => {
			const { tools } = await openLibrary(await resolveDataDir(flags))
			const result = await tools.get('file_read').execute({ target: args[0] ?? '' })
			if (flags.json === true) return JSON.stringify(result, null, 2)
			return formatRead(result, flags.raw === true, args[0])
		})
		break
	}
	case 'write': {
		await main(async () => {
			const { tools } = await openLibrary(await resolveDataDir(flags))
			const meta = {}
			if (typeof flags.name === 'string') meta.name = flags.name
			if (typeof flags.desc === 'string') meta.description = flags.desc
			if (typeof flags.tags === 'string') meta.tags = flags.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
			if (typeof flags.links === 'string') meta.links = flags.links.split(',').map((link) => link.trim()).filter(Boolean)

			const input = { target: typeof flags.id === 'string' ? flags.id : undefined, meta }
			if (typeof flags.from === 'string') {
				input.from = flags.from
			} else if (args[0] === '-') {
				const chunks = []
				for await (const chunk of process.stdin) chunks.push(chunk)
				input.content = Buffer.concat(chunks).toString('utf8')
			} else if (args[0] !== undefined) {
				const { readFile } = await import('node:fs/promises')
				const { basename } = await import('node:path')
				input.content = await readFile(resolve(args[0]), 'utf8')
				if (meta.name === undefined) meta.name = basename(resolve(args[0]))
			} else {
				throw new Error('需要内容：ziyan write <文件> 或 ziyan write - 从标准输入读。')
			}

			const isUpdate = typeof flags.id === 'string'
			const result = await tools.get('file_write').execute(input)
			if (flags.json === true) return JSON.stringify(result, null, 2)
			const warnings = (result.warnings ?? []).map((warning) => `  ⚠ ${warning}`).join('\n')
			const verb = isUpdate ? '已更新' : '已创建'
			return `${verb} ${result.id}  ${result.name ?? ''}  ${result.bytes}B${warnings === '' ? '' : `\n${warnings}`}`
		})
		break
	}
	case 'edit': {
		await main(async () => {
			const { tools } = await openLibrary(await resolveDataDir(flags))
			const meta = {}
			if (typeof flags.desc === 'string') meta.description = flags.desc
			if (typeof flags.tags === 'string') meta.tags = flags.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
			if (typeof flags.links === 'string') meta.links = flags.links.split(',').map((link) => link.trim()).filter(Boolean)
			if (flags.archive === true) meta.archived = true
			if (flags.unarchive === true) meta.archived = false
			if (flags.remove === true) meta.remove = true
			const input = { target: args[0] ?? '', meta }
			if (typeof flags.old === 'string' || typeof flags.new === 'string') {
				input.old = flags.old
				input.new = flags.new
			}
			const result = await tools.get('file_edit').execute(input)
			if (flags.json === true) return JSON.stringify(result, null, 2)
			if (result.removed === true) return `已移除 ${result.id ?? args[0]}`
			// Report what was asked for, not what the returned record happens to
			// contain: a full file summary always carries description and
			// archived, so presence there says nothing about this call.
			const parts = []
			if (typeof flags.old === 'string' || typeof flags.new === 'string') parts.push('正文已改')
			if (typeof flags.desc === 'string') parts.push('描述已改')
			if (typeof flags.tags === 'string') parts.push('标签已改')
			if (typeof flags.links === 'string') parts.push('关联已改')
			if (flags.archive === true) parts.push('已归档')
			if (flags.unarchive === true) parts.push('已取消归档')
			return `${result.id ?? args[0]}  ${parts.join(' · ') || '无变化'}`
		})
		break
	}
	case 'stats': {
		await main(async () => {
			const dataDir = await resolveDataDir(flags)
			const { store } = await openLibrary(dataDir)
			const stats = store.stats()
			if (flags.json === true) return JSON.stringify({ dataDir, ...stats }, null, 2)
			return [
				`库：${dataDir}`,
				`文件 ${stats.files} 个（归档 ${stats.archived}）· 链接 ${stats.links} · 标签 ${stats.tags}`,
			].join('\n')
		})
		break
	}
	default: {
		// Usage goes to stdout even when the command is unknown: an agent that
		// reads only stdout should still get the list. The non-zero exit code is
		// what distinguishes "you asked for nothing" from "you asked wrong".
		process.stdout.write([
			'ziyan — 自衍中枢库的命令行入口',
			'',
			'  ziyan search "<查询>" [--tags a/b,c] [--limit 20] [--graph] [--json]',
			'  ziyan read <id|路径> [--raw] [--json]',
			'  ziyan write <文件|-> --desc "什么时候用" [--name x.md] [--tags a/b] [--links id] [--json]',
			'  ziyan write --from <宿主文件> --desc "..." [--json]',
			'  ziyan edit <id> [--old "旧" --new "新"] [--desc "..."] [--tags a/b] [--archive|--unarchive|--remove]',
			'  ziyan stats [--json]',
			'',
			'通用：--data-dir <绝对路径>（默认 ~/.ziyan，其次 ~/.dsh/ziyan）',
			'',
		].join('\n'))
		process.exitCode = command === '' ? 0 : 1
	}
}
