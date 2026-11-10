/**
 * The evolver's data layer.
 *
 * One folder holds everything the agent is expected to carry across sessions:
 *
 *   <root>/
 *     practice/          实践：经过验证、可复用的知识与工具
 *       INDEX.md         自动生成的顶层索引（注入的就是它的投影）
 *       ARCHIVE.md       注入放不下的条目
 *       docs/<topic>/…   文档：经验、流程、验证方法
 *       tools/<topic>/…  工具：脚本与 CLI
 *       resources/…      资源：模板、示例、静态资源
 *       agents/…         子智能体定义
 *     sight/             见闻：agent 自己的记忆
 *       soul.md          灵魂：注入的人格与边界
 *       memory/          记忆存储（JSONL + 向量）
 *     preferences/
 *       AGENTS.md        全局偏好（链到 ~/.dsh/AGENTS.md）
 *
 * The folder is the unit of migration and backup: copy it and everything moves.
 */

import { cp, lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
	DEFAULT_INDEX_BYTES,
	KINDS,
	buildProjection,
	findSecret,
	readPracticeEntry,
	regenerate,
	scanPractice,
	searchPractice,
	splitEntry,
	validatePractice,
} from './practice.js'

/** The soul document, seeded when the folder is new. */
const STARTER_SOUL = `# 灵魂（soul）

> 这份文档定义 Agent 的人格与边界，每个会话都会被读到。
> 这里只写"永远成立"的东西；一次性的经历属于见闻，不属于这里。

## 我是谁

- 一个先验证再断言的工程助手。
- 面向长期收益，而不是一次交付。

## 说话方式

- 中文优先，简洁优先。
- 代码给完整可运行版本，不给伪代码。

## 边界

- 不确定就说不确定，并给出验证方式。
- 不替用户做不可逆的决定。

## 记忆纪律

- 过往经历存在「见闻」里，用记忆工具按需召回，不要凭印象编造。
- 可复用的结论应该沉淀进「实践」，而不是只留在记忆里。
`

/** The global preferences file, seeded when the folder is new. */
const STARTER_PREFS = `# 个人偏好

- 回答用中文，简洁优先。
- 代码给完整可运行版本。
`

/** The example entries, seeded when the folder is new. */
const STARTER_ENTRIES = [
	{
		path: 'practice/docs/verify/plugin-effective.md',
		content: `---
title: 确认插件改动是否生效
purpose: 装完插件后用槽查询确认它真的注册上了
kind: doc
topic: 验证方法
verified: ${new Date().toISOString().slice(0, 10)}
---

## 现象

插件装上之后，页面里看不到入口，或者接口报 404。

## 做法

1. 确认插件行状态：用插件管理列出该行，看 fiberPhase 是 active。
2. 确认槽注册：查询客户端槽，看 sidebar 面板列表和主面板里都有没有自己的 id。
3. 确认产物是最新的：看服务下发的浏览器产物版本号是否随文件改动变化。

## 边界

槽注册成功只说明"挂上了"，不代表"用户看到的样子是对的"，后者需要真的打开页面看。
`,
	},
	{
		path: 'practice/docs/evolver/sinking.md',
		content: `---
title: 沉淀纪律与脚本优先
purpose: 判断什么该沉淀、写到哪里、怎么验证（原 harness-evolver 技能的内化版）
kind: doc
topic: 演化器
verified: ${new Date().toISOString().slice(0, 10)}
---

## 什么时候沉淀

完成多步工具调用（≥3 步）的任务后，如果出现已验证且可复用的判断、稳定流程、验证方法或工具，就沉淀；
没有高信号内容时安静跳过，不要为了"有产出"硬凑。

## 不写什么

流水账、一次性命令、临时猜测、废弃方案、密钥与令牌、完整日志、完整对话转录。

## 写到哪里

- \`doc\`：经验、流程、验证方法、外部规则与版本差异。
- \`tool\`：能重复运行的脚本或 CLI。先按下面的脚本优先协议判断。
- \`resource\`：模板、示例输入、静态资源。
- \`agent\`：子智能体定义。

## 脚本优先协议

满足任一条件时必须写成 \`tool\`，不能只写文档：

- 稳定流程需要两个及以上固定命令；
- 同类任务会重复做参数、文件或数据转换；
- 人工解析结构化输出容易出错；
- 需要产出一致结果，或需要能重复运行的验证。

脚本契约：

- 实现本次要复用的真实动作，禁止空壳、伪代码或只打印说明的模板；
- 可复用 CLI 提供 \`--help\`，明确输入、输出和非零失败退出码；
- 写操作显式指定目标，能安全预览时提供 \`--dry-run\`；
- 文档里写清适用条件、依赖、代表性调用、成功信号和常见失败信号。

## 闭环

1. 写前用 \`practice_query\` 查重、\`practice_read\` 读相关条目；能更新已有条目就不新建。
2. 写后读返回的 \`problems\`：必填字段、kind 一致、链接闭环、verified 过期。
3. 结构问题未清零时，不要宣称沉淀完成；在最终答复里说明剩余问题。
`,
	},
	{
		path: 'practice/docs/verify/index-drift.md',
		content: `---
title: 索引会随内容腐化
purpose: 手写的索引一定会和文件对不上，所以索引必须生成
kind: doc
topic: 验证方法
verified: ${new Date().toISOString().slice(0, 10)}
---

## 现象

条目改了标题或删了文件，索引里还留着旧的路由。

## 做法

索引由条目前言生成，不手写；改完条目重新生成一次，并让校验器检查链接闭环。

## 边界

生成式索引保证"有条目就有路由"，但保证不了"条目的内容是对的"——那要靠 verified 字段和人工复查。
`,
	},
]

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

/**
 * The evolver's data layer.
 */
export class Evolver {
	/**
	 * @param {{root: string, logger?: object, dshHome?: string, indexBytes?: number}} deps - The options.
	 */
	constructor({ root, logger, dshHome, indexBytes }) {
		this.root = root
		this.logger = logger
		this.dshHome = dshHome ?? resolveDshHome()
		this.indexBytes = indexBytes ?? DEFAULT_INDEX_BYTES
		this.panelDir = join(this.dshHome, 'panel')
		/**
		 * The injected text, cached.
		 *
		 * The prompt sections are assembled synchronously, so the two blocks
		 * the agent sees live here. They change only when the content changes,
		 * which keeps the prompt prefix stable.
		 *
		 * @type {{practice: string, soul: string, updatedAt: string | null}}
		 */
		this.cache = { practice: '', soul: '', updatedAt: null }
	}

	/**
	 * Refresh the cached injection text.
	 *
	 * @returns {Promise<{practice: string, soul: string}>} The cached text.
	 */
	async refresh() {
		try {
			const practice = await this.practice()
			this.cache.practice = practice.projection.text
		} catch (error) {
			this.logger?.warn?.(`dsh-evolver: index refresh failed: ${error instanceof Error ? error.message : String(error)}`)
		}
		try {
			const soul = await this.soulRead()
			this.cache.soul = soul.content
		} catch (error) {
			this.logger?.warn?.(`dsh-evolver: soul refresh failed: ${error instanceof Error ? error.message : String(error)}`)
		}
		this.cache.updatedAt = new Date().toISOString()
		return { practice: this.cache.practice, soul: this.cache.soul }
	}

	/** The practice folder. */
	get practiceDir() {
		return join(this.root, 'practice')
	}

	/** The soul document's path. */
	get soulPath() {
		return join(this.root, 'sight', 'soul.md')
	}

	/** The memory store's folder. */
	get memoryDir() {
		return join(this.root, 'sight', 'memory')
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
	 * Create the folder skeleton and the seed files.
	 *
	 * Existing files are never overwritten.
	 */
	async ensure() {
		await mkdir(this.root, { recursive: true })
		for (const kind of KINDS) {
			await mkdir(join(this.practiceDir, kind.dir), { recursive: true })
		}
		await mkdir(join(this.root, 'sight'), { recursive: true })
		await mkdir(join(this.root, 'preferences'), { recursive: true })
		await this.writeIfMissing(this.soulPath, STARTER_SOUL)
		await this.writeIfMissing(this.preferencesPath, STARTER_PREFS)
		for (const entry of STARTER_ENTRIES) {
			await this.writeIfMissing(join(this.root, entry.path), entry.content)
		}
		await this.regenerateIndex()
	}

	/**
	 * Take over the harness home's global instruction file.
	 *
	 * The evolver owns the preferences file now, so the link has to point at
	 * it. The file that was there before is kept next to the preferences file
	 * when it was a real file.
	 *
	 * @returns {Promise<void>} Resolves once the link is in place.
	 */
	async linkGlobalIfNeeded() {
		const state = await this.globalLinkState()
		if (state.kind === 'link' && state.target === this.preferencesPath) return
		try {
			await this.linkGlobal()
			this.logger?.info?.(`dsh-evolver: ${this.globalPath} now points at the evolver's preferences`)
		} catch (error) {
			this.logger?.warn?.(`dsh-evolver: could not take over ${this.globalPath}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/**
	 * Remove a folder when it holds nothing.
	 *
	 * @param {string} path - Absolute folder path.
	 */
	async removeIfEmpty(path) {
		try {
			const names = await readdir(path)
			if (names.length > 0) return
			await rm(path, { recursive: true, force: true })
		} catch {
			// The folder is gone or unreadable; nothing to clean up.
		}
	}

	/**
	 * Write a file only when it does not exist yet.
	 *
	 * @param {string} path - Absolute file path.
	 * @param {string} content - File content.
	 */
	async writeIfMissing(path, content) {
		try {
			await lstat(path)
			return
		} catch {
			// The file is absent; write it.
		}
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, content, 'utf8')
	}

	/**
	 * Move the data the previous shape of this plugin left behind.
	 *
	 * Nothing is ever deleted: the old files stay where they are so the
	 * migration can be inspected and undone.
	 *
	 * @returns {Promise<object[]>} What was migrated.
	 */
	async migrate() {
		const moved = []
		const old = join(this.root)
		const legacy = [
			{ from: 'experience', to: 'practice/docs/legacy-experience' },
			{ from: 'workflow', to: 'practice/docs/legacy-workflow' },
			{ from: 'scripts', to: 'practice/tools/legacy-scripts' },
			{ from: 'assets', to: 'practice/resources/legacy-assets' },
			{ from: 'references', to: 'practice/resources/legacy-references' },
			{ from: 'agents', to: 'practice/agents/legacy-agents' },
		]
		for (const item of legacy) {
			const from = join(old, item.from)
			const to = join(old, item.to)
			if (!(await exists(from))) continue
			if (await exists(to)) continue
			await mkdir(dirname(to), { recursive: true })
			await cp(from, to, { recursive: true })
			moved.push({ from: item.from, to: item.to })
			// An empty source folder leaves nothing behind to look at.
			await this.removeIfEmpty(from)
		}
		const legacySoul = join(old, 'soul.md')
		if (await exists(legacySoul) && !(await exists(this.soulPath))) {
			await cp(legacySoul, this.soulPath)
			moved.push({ from: 'soul.md', to: 'sight/soul.md' })
		}
		// The panel's memory store and preferences file move in as well.
		const panelMemory = join(this.panelDir, 'memory')
		if (await exists(panelMemory) && !(await exists(this.memoryDir))) {
			await mkdir(dirname(this.memoryDir), { recursive: true })
			await cp(panelMemory, this.memoryDir, { recursive: true })
			moved.push({ from: 'panel/memory', to: 'sight/memory' })
		}
		const panelPrefs = join(this.panelDir, 'agent.md')
		if (await exists(panelPrefs) && !(await exists(this.preferencesPath))) {
			await cp(panelPrefs, this.preferencesPath)
			moved.push({ from: 'panel/agent.md', to: 'preferences/AGENTS.md' })
		}
		if (moved.length > 0) {
			await this.writeIfMissing(join(this.root, 'migrated.json'), `${JSON.stringify({ at: new Date().toISOString(), moved }, null, 2)}\n`)
			this.logger?.info?.(`dsh-evolver: migrated ${moved.length} item(s) into the new layout`)
		}
		return moved
	}

	/**
	 * Rebuild the index files and the injected projection.
	 *
	 * @returns {Promise<{entries: object[], problems: object[], projection: object}>} The result.
	 */
	async regenerateIndex() {
		return regenerate(this.practiceDir, { budget: this.indexBytes })
	}

	/**
	 * The practice tree, scanned and validated.
	 *
	 * @returns {Promise<{entries: object[], problems: object[], projection: object}>} The result.
	 */
	async practice() {
		const scan = await scanPractice(this.practiceDir)
		const problems = validatePractice(scan.entries, scan.problems)
		const projection = buildProjection(scan.entries, { budget: this.indexBytes })
		return { entries: scan.entries, problems, projection }
	}

	/**
	 * Search the practice tree.
	 *
	 * @param {string} query - The search text.
	 * @param {{kind?: string, limit?: number}} options - The filter.
	 * @returns {Promise<object[]>} The matches.
	 */
	async practiceSearch(query, options = {}) {
		const scan = await scanPractice(this.practiceDir)
		return searchPractice(this.practiceDir, scan.entries, query, options)
	}

	/**
	 * Read one practice entry.
	 *
	 * @param {string} path - The entry path, relative to the practice root.
	 * @returns {Promise<object>} The entry.
	 */
	async practiceRead(path) {
		return readPracticeEntry(this.practiceDir, path)
	}

	/**
	 * Create or update one practice entry, then rebuild the index.
	 *
	 * @param {object} input - The entry fields.
	 * @returns {Promise<object>} The saved entry.
	 */
	async practiceWrite(input = {}) {
		const kind = KINDS.find((item) => item.id === input.kind)
		if (kind === undefined) throw new Error(`未知类型：${String(input.kind)}`)
		const topic = String(input.topic ?? '').trim()
		const topicSlug = topic === '' ? '' : slugify(topic)
		const name = String(input.name ?? '').trim()
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
			throw new Error(`文件名不合法：${name}`)
		}
		const title = String(input.title ?? '').trim()
		const purpose = String(input.purpose ?? '').trim()
		if (title === '') throw new Error('标题不能为空。')
		if (purpose === '') throw new Error('用途不能为空。')
		const relPath = topicSlug === ''
			? `${kind.dir}/${name}`
			: `${kind.dir}/${topicSlug}/${name}`
		const frontmatter = [
			'---',
			`title: ${title}`,
			`purpose: ${purpose}`,
			`kind: ${kind.id}`,
			...(topic === '' ? [] : [`topic: ${topic}`]),
			`verified: ${String(input.verified ?? new Date().toISOString().slice(0, 10))}`,
			...(Array.isArray(input.links) && input.links.length > 0
				? [`links: [${input.links.map((link) => String(link)).join(', ')}]`]
				: []),
			'---',
			'',
		].join('\n')
		const body = String(input.body ?? '').replace(/^\n+/, '')
		const secret = findSecret(`${title}\n${purpose}\n${body}`)
		if (secret !== undefined) {
			throw new Error(`正文里像是${secret}：实践层不保存密钥，请删掉后重写。`)
		}
		const path = join(this.practiceDir, relPath)
		await mkdir(dirname(path), { recursive: true })
		const content = `${frontmatter}${body}\n`
		await writeFile(path, content, 'utf8')
		const rebuilt = await this.regenerateIndex()
		return {
			path: relPath,
			title,
			purpose,
			kind: kind.id,
			topic,
			bytes: Buffer.byteLength(content, 'utf8'),
			entries: rebuilt.entries.length,
			problems: rebuilt.problems,
			injectedBytes: Buffer.byteLength(rebuilt.projection.text, 'utf8'),
			dropped: rebuilt.projection.dropped.length,
		}
	}

	/**
	 * Delete one practice entry, then rebuild the index.
	 *
	 * @param {string} path - The entry path, relative to the practice root.
	 * @returns {Promise<object>} A short receipt.
	 */
	async practiceDelete(path) {
		const clean = String(path ?? '').trim()
		if (clean === '' || clean.includes('..') || clean.startsWith('/')) {
			throw new Error(`路径不合法：${path}`)
		}
		await rm(join(this.practiceDir, clean), { force: true })
		await this.regenerateIndex()
		return { ok: true, path: clean }
	}

	/**
	 * Read the soul document.
	 *
	 * @returns {Promise<object>} The document's content and metadata.
	 */
	async soulRead() {
		let content = ''
		let updatedAt = null
		try {
			content = await readFile(this.soulPath, 'utf8')
			const info = await lstat(this.soulPath)
			updatedAt = info.mtime.toISOString()
		} catch {
			content = ''
		}
		return {
			path: 'sight/soul.md',
			content,
			bytes: Buffer.byteLength(content, 'utf8'),
			updatedAt,
		}
	}

	/**
	 * Write the soul document.
	 *
	 * @param {string} content - The new content.
	 * @returns {Promise<object>} The document's metadata.
	 */
	async soulWrite(content) {
		await mkdir(dirname(this.soulPath), { recursive: true })
		await writeFile(this.soulPath, String(content ?? ''), 'utf8')
		const info = await lstat(this.soulPath)
		return { path: 'sight/soul.md', bytes: info.size, updatedAt: info.mtime.toISOString() }
	}

	/**
	 * Read the global preferences and the state of the harness link.
	 *
	 * @returns {Promise<object>} The preferences state.
	 */
	async preferencesRead() {
		let content = ''
		try {
			content = await readFile(this.preferencesPath, 'utf8')
		} catch {
			content = ''
		}
		return {
			path: 'preferences/AGENTS.md',
			globalPath: this.globalPath,
			content,
			bytes: Buffer.byteLength(content, 'utf8'),
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
		await mkdir(dirname(this.preferencesPath), { recursive: true })
		await writeFile(this.preferencesPath, String(content ?? ''), 'utf8')
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
			if (info.isSymbolicLink()) return { kind: 'link', target: await readlink(this.globalPath) }
			if (info.isFile()) return { kind: 'file' }
			return { kind: 'other' }
		} catch {
			return { kind: 'missing' }
		}
	}

	/**
	 * Point the harness home's `AGENTS.md` at the evolver's preferences file.
	 *
	 * A real file that is already there is imported next to the preferences
	 * file instead of being overwritten.
	 *
	 * @returns {Promise<{linked: boolean, message: string}>} What happened.
	 */
	async linkGlobal() {
		const state = await this.globalLinkState()
		if (state.kind === 'link' && state.target === this.preferencesPath) {
			return { linked: true, message: `已链接，DSH 全局加载 ${this.globalPath}。` }
		}
		if (state.kind === 'file') {
			const original = await readFile(this.globalPath, 'utf8')
			await writeFile(join(this.root, 'preferences', 'AGENTS.md.imported'), original, 'utf8')
		}
		await rm(this.globalPath, { force: true })
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
		await rm(this.globalPath, { force: true })
		return { linked: false, message: '已移除全局链接。' }
	}

	/**
	 * The three blocks the agent is given, exactly as they are injected.
	 *
	 * @returns {Promise<object>} The injection preview.
	 */
	async injectionPreview() {
		const practice = await this.practice()
		const soul = await this.soulRead()
		const preferences = await this.preferencesRead()
		return {
			practice: {
				text: practice.projection.text,
				bytes: Buffer.byteLength(practice.projection.text, 'utf8'),
				budget: this.indexBytes,
				entries: practice.entries.length,
				dropped: practice.projection.dropped.length,
			},
			soul: {
				text: soul.content,
				bytes: soul.bytes,
				budget: 1024,
			},
			preferences: {
				path: preferences.path,
				globalPath: preferences.globalPath,
				text: preferences.content,
				bytes: preferences.bytes,
				link: preferences.link,
				note: '全局偏好由 DSH 的 AGENTS.md 加载器注入，不占用演化器自己的预算。',
			},
			totalBytes: practice.projection.text.length + soul.bytes + preferences.bytes,
		}
	}

	/**
	 * The panel's overview: the injection, the counts and the health.
	 *
	 * @returns {Promise<object>} The overview.
	 */
	async overview() {
		const practice = await this.practice()
		const soul = await this.soulRead()
		const preferences = await this.preferencesRead()
		const byKind = KINDS.map((kind) => {
			const entries = practice.entries.filter((entry) => entry.kind === kind.id)
			return {
				id: kind.id,
				title: kind.title,
				count: entries.length,
				bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
			}
		})
		const suggestions = await this.suggestions(practice)
		return {
			root: this.root,
			practice: {
				entries: practice.entries.length,
				bytes: practice.entries.reduce((total, entry) => total + entry.bytes, 0),
				byKind,
				problems: practice.problems,
				injectedBytes: Buffer.byteLength(practice.projection.text, 'utf8'),
				injectedBudget: this.indexBytes,
				dropped: practice.projection.dropped.length,
			},
			soul: { bytes: soul.bytes, updatedAt: soul.updatedAt },
			preferences: {
				bytes: preferences.bytes,
				globalPath: preferences.globalPath,
				link: preferences.link,
			},
			suggestions,
		}
	}

	/**
	 * The evolution candidates: what could move, and what looks stale.
	 *
	 * @param {{entries: object[], problems: object[]}} practice - The scanned practice.
	 * @returns {Promise<object[]>} The suggestions.
	 */
	async suggestions(practice) {
		const suggestions = []
		for (const problem of practice.problems) {
			suggestions.push({
				kind: 'problem',
				level: problem.level,
				path: problem.path,
				message: problem.message,
			})
		}
		const stale = practice.entries.filter((entry) => {
			if (entry.verified === '') return true
			const days = (Date.now() - Date.parse(entry.verified)) / 86_400_000
			return Number.isFinite(days) && days > 180
		})
		for (const entry of stale) {
			suggestions.push({
				kind: 'stale',
				level: 'warning',
				path: entry.relPath,
				message: `上次验证是 ${entry.verified}，超过半年没有复查。`,
			})
		}
		return suggestions
	}
}

/**
 * Turn a topic title into a directory slug.
 *
 * @param {string} value - The topic title.
 * @returns {string} The slug, or the original when it is already usable.
 */
export function slugify(value) {
	const trimmed = String(value ?? '').trim()
	if (trimmed === '') return ''
	if (/^[a-z0-9][a-z0-9._-]*$/.test(trimmed)) return trimmed
	// A topic written in Chinese keeps its characters: the folder name is the
	// one the user will read in the index.
	if (/[^\x00-\x7F]/.test(trimmed)) {
		return trimmed
			.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-')
			.replace(/^\.+/, '')
			.slice(0, 64)
	}
	return trimmed
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

/**
 * Whether a path exists.
 *
 * @param {string} path - Absolute path.
 * @returns {Promise<boolean>} True when it exists.
 */
async function exists(path) {
	try {
		await lstat(path)
		return true
	} catch {
		return false
	}
}

/**
 * Read one entry's frontmatter, for callers that only need the metadata.
 *
 * @param {string} text - The file content.
 * @returns {object} The frontmatter fields.
 */
export function frontmatterOf(text) {
	return splitEntry(text).data
}
