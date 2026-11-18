/**
 * The four tools: search, read, write and edit.
 *
 * Two stores share the verbs — the file library and ordinary project files —
 * so the cases below pin the dispatch (where does a target land), the
 * contracts of each branch (required metadata, text replacement), and the
 * library-only paths that must keep working when no session cwd is available
 * (an organize job). A project's `harness/` is just a folder now: no sidecar,
 * no generated index, no validation.
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { fileId } from '../src/ids.js'
import { FileStore } from '../src/store.js'
import { createTools } from '../src/tools.js'
import { removeDir, tempDir } from './helpers.mjs'

/**
 * A library store, a project with a git marker, and the four tools.
 *
 * @param {{cwd?: string, root?: string, paths?: Function}} [options] - Where the session is; omit `paths` to get the real resolver.
 * @returns {Promise<object>} The fixture.
 */
async function fixture(options = {}) {
	const lib = await tempDir()
	const project = await tempDir()
	await mkdir(join(project, '.git'), { recursive: true })
	const store = new FileStore({ dataDir: lib })
	await store.open()
	const paths = options.paths ?? (async () => ({ cwd: options.cwd ?? project, root: options.root ?? project }))
	const tools = new Map(createTools({ store, paths }).map((tool) => [tool.name, tool]))
	return {
		store,
		tools,
		lib,
		project,
		async cleanup() {
			store.close()
			await removeDir(lib)
			await rm(project, { recursive: true, force: true })
		},
	}
}

/**
 * Create one library file through the tool and return its result.
 *
 * @param {Map<string, object>} tools - The tool map.
 * @param {object} fields - `name`, `description`, `content`, `tags`, `links`.
 * @returns {Promise<object>} The write result.
 */
async function createLibraryFile(tools, { name, description, content, tags, links }) {
	return tools.get('file_write').execute({ content, meta: { name, description, tags, links } })
}

test('四个动词：名字、参数与描述', async () => {
	const { tools, cleanup } = await fixture()
	try {
		assert.deepEqual([...tools.keys()], ['file_search', 'file_read', 'file_write', 'file_edit'])

		// describeTools 随面板的工具页一起删了：分类与 token 估算只是那个页面的
		// 展示物，动词本身仍是这里定义的四份 schema。
		const byName = Object.fromEntries(tools)
		for (const [name, tool] of Object.entries(byName)) {
			assert.ok(tool.description.trim() !== '', `${name} 的描述非空`)
			assert.equal(tool.parameters.type, 'object', `${name} 的参数是 JSON schema`)
			for (const [field, spec] of Object.entries(tool.parameters.properties ?? {})) {
				assert.equal(typeof spec.description, 'string', `${name}.${field} 有参数说明`)
				assert.ok(spec.description.trim() !== '', `${name}.${field} 的参数说明非空`)
			}
		}
		assert.deepEqual(Object.keys(byName.file_search.parameters.properties).sort(), ['graph', 'limit', 'query', 'tags'])
		assert.deepEqual(Object.keys(byName.file_read.parameters.properties), ['target'])
		assert.deepEqual(byName.file_read.parameters.required, ['target'])
		assert.deepEqual(Object.keys(byName.file_write.parameters.properties).sort(), ['content', 'from', 'meta', 'target'])
		assert.deepEqual(Object.keys(byName.file_edit.parameters.properties).sort(), ['meta', 'new', 'old', 'target'])
		assert.deepEqual(byName.file_edit.parameters.required, ['target'])
		assert.match(byName.file_edit.description, /remove/, 'file_edit 描述说明 remove')
		assert.match(byName.file_edit.description, /归档|删除/, 'remove 是归档后的删除动作')
		// 描述是模型唯一能看见的能力面：项目文件也吃 old+new，这句必须写在描述里，
		// 否则模型会以为项目文件只能整篇重写，转而绕道 bash/python（能力在，描述没露出来等于不存在）。
		assert.match(byName.file_edit.description, /库文件与项目文件都适用/, 'file_edit 描述要露出项目文件也支持 old+new')
		assert.doesNotMatch(byName.file_write.description, /harness/, '库不再托管项目 harness')
		assert.match(byName.file_write.description, /file_edit 的 old\+new/, 'file_write 描述要指向 file_edit 的增量写法')
		// meta 是自由对象，但它的核心字段必须声明类型：不声明 tags 是数组，
		// 部分路由会输出自己的列表编码（{"item": ["来源/harness"]}），
		// 每次写入都撞上 Array.isArray 检查。声明类型是治本，解包只是兼容层。
		const metaSchema = byName.file_write.parameters.properties.meta
		assert.equal(metaSchema.properties.tags.type, 'array', 'meta.tags 必须声明为 array')
		assert.equal(metaSchema.properties.tags.items.type, 'string')
		assert.equal(metaSchema.properties.links.type, 'array')
		assert.equal(metaSchema.properties.description.type, 'string')
		assert.equal(metaSchema.additionalProperties, true, '未声明字段仍然允许，保持自由对象')
		assert.match(metaSchema.properties.tags.description, /\{"item"/, '描述里点名不要用 {item:[...]} 形态')
		assert.equal(metaSchema.properties.title, undefined, 'title 是 harness 专用字段，已移除')
		assert.equal(metaSchema.properties.layer, undefined, 'layer 已移除')
	} finally {
		await cleanup()
	}
})

test('file_read：库文件给元数据、正文与邻居，短 id 与死链都认', async () => {
	const { tools, cleanup } = await fixture()
	try {
		const script = await createLibraryFile(tools, {
			name: 'deploy.sh',
			description: '发布脚本：本地一键部署到预发环境，出问题时用它复现',
			content: '#!/bin/sh\necho ok\n',
			tags: ['工作/发布', '类型/脚本'],
		})
		const doc = await createLibraryFile(tools, {
			name: 'runbook.md',
			description: '发布手册：调用发布脚本的顺序与回滚步骤，下次发版前先读',
			content: '# 发布手册\n\n先看脚本。\n',
			tags: ['工作/发布'],
			links: [script.id, fileId(0)],
		})
		assert.deepEqual(doc.links, [script.id], '死链被丢弃')
		assert.equal(doc.warnings.length, 1)
		assert.match(doc.warnings[0], /不存在或不唯一/)

		const read = await tools.get('file_read').execute({ target: doc.id })
		assert.equal(read.id, doc.id)
		assert.match(read.text, /先看脚本/)
		assert.equal(read.executable, false)
		assert.match(read.path, /runbook\.md$/)
		assert.deepEqual(read.neighbors.out.map((file) => file.id), [script.id])
		assert.equal(read.neighbors.out[0].description, '发布脚本：本地一键部署到预发环境，出问题时用它复现')

		const byShort = await tools.get('file_read').execute({ target: doc.short })
		assert.equal(byShort.id, doc.id)
		assert.match(byShort.text, /先看脚本/)
		const missing = await tools.get('file_read').execute({ target: fileId(1) })
		assert.equal(missing.found, false)
		await assert.rejects(() => tools.get('file_read').execute({ target: 'ZZZZZZ' }), /没有这个文件/, '短 id 解析不到时当项目路径')
		await assert.rejects(() => tools.get('file_read').execute({}), /需要 target/)
	} finally {
		await cleanup()
	}
})

test('file_read：项目内路径按会话 cwd 解析，相对/绝对路径、二进制与超限、越界都覆盖', async () => {
	const { tools, project, cleanup } = await fixture()
	try {
		await mkdir(join(project, 'src'), { recursive: true })
		await writeFile(join(project, 'src', 'note.md'), '# 笔记\n\n内容在正文里。\n')
		const relative = await tools.get('file_read').execute({ target: 'src/note.md' })
		assert.equal(relative.target, 'src/note.md')
		assert.equal(relative.text, '# 笔记\n\n内容在正文里。\n')
		assert.equal(relative.bytes > 0, true)
		assert.ok(relative.path.endsWith('note.md'))

		const absolute = await tools.get('file_read').execute({ target: join(project, 'src', 'note.md') })
		assert.match(absolute.text, /内容在正文里/)

		await writeFile(join(project, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 5]))
		const binary = await tools.get('file_read').execute({ target: 'bin.dat' })
		assert.equal(binary.binary, true)
		assert.equal(binary.text, undefined, '二进制不读正文')
		assert.equal(binary.bytes, 6)

		await writeFile(join(project, 'big.txt'), 'x'.repeat(300 * 1024))
		const big = await tools.get('file_read').execute({ target: 'big.txt' })
		assert.equal(big.truncated, true)
		assert.equal(big.text, undefined, '超限只给大小与 path')
		assert.equal(big.bytes, 300 * 1024)

		await assert.rejects(() => tools.get('file_read').execute({ target: '../outside.md' }), /路径越界/)
		await assert.rejects(() => tools.get('file_read').execute({ target: join(project, '..', 'outside.md') }), /路径越界/)
		await assert.rejects(() => tools.get('file_read').execute({ target: 'src/none.md' }), /没有这个文件/)
	} finally {
		await cleanup()
	}
})

test('file_write：新建库文件（默认 note.md、描述 advice、死链警告）与按 id 更新', async () => {
	const { tools, cleanup } = await fixture()
	try {
		const created = await createLibraryFile(tools, {
			description: '带死链的文件',
			content: 'x',
			tags: ['测试/描述'],
		})
		assert.match(created.id, /^file-/)
		assert.equal(created.name, 'note.md', '新建库文件默认 note.md')
		assert.equal(created.text, undefined, '写入结果不带正文')
		assert.ok(created.warnings.some((hint) => hint.includes('以后什么时候')), '短描述收到 advice')

		const clear = await createLibraryFile(tools, {
			name: 'clear.md',
			description: '排查 Windows EBUSY 删除失败时，验证句柄与杀毒软件影响的可复现步骤',
			content: 'x',
			tags: ['测试/描述'],
		})
		assert.equal(clear.warnings, undefined, '写清场景的描述不再提示')

		const updated = await tools.get('file_write').execute({
			target: clear.short,
			content: '新的正文',
			meta: {
				description: '排查 Windows EBUSY 删除失败时，验证句柄与杀毒软件影响的可复现步骤（已更新）',
				tags: ['测试/描述', '工作/排错'],
			},
		})
		assert.equal(updated.id, clear.id)
		assert.deepEqual(updated.tags, ['测试/描述', '工作/排错'])
		const reread = await tools.get('file_read').execute({ target: clear.id })
		assert.equal(reread.text, '新的正文')

		await assert.rejects(() => createLibraryFile(tools, { content: 'x', tags: ['测试/缺少描述'] }), /description/)
		await assert.rejects(() => createLibraryFile(tools, { description: '一句话描述', content: 'x', tags: [] }), /tags/)
		await assert.rejects(() => tools.get('file_write').execute({ target: clear.id }), /需要 content/)
	} finally {
		await cleanup()
	}
})

test('file_write({from})：宿主绝对路径与项目内相对路径都能导入，越界拒绝', async () => {
	const { tools, project, cleanup } = await fixture()
	const sourceDir = await tempDir()
	try {
		const scriptPath = join(sourceDir, 'deploy.sh')
		await writeFile(scriptPath, '#!/bin/sh\necho ok\n')
		const script = await tools.get('file_write').execute({
			from: scriptPath,
			meta: { description: '部署脚本：输出 ok', tags: ['类型/脚本'] },
		})
		assert.match(script.id, /^file-/)
		assert.equal(script.name, 'deploy.sh', '默认用源文件名')
		assert.equal(script.executable, true)
		const read = await tools.get('file_read').execute({ target: script.short })
		assert.match(read.text, /^#!\/bin\/sh/)

		await writeFile(join(project, 'local.txt'), '本地文件')
		const local = await tools.get('file_write').execute({
			from: 'local.txt',
			meta: { description: '项目内相对路径导入：验证 cwd 解析与越界规则', tags: ['测试/导入'] },
		})
		assert.equal(local.name, 'local.txt')
		assert.equal((await tools.get('file_read').execute({ target: local.id })).text, '本地文件')

		await assert.rejects(
			() => tools.get('file_write').execute({ from: '../outside.txt', meta: { description: '越界导入测试', tags: ['测试/导入'] } }),
			/路径越界/,
		)
		await assert.rejects(
			() => tools.get('file_write').execute({ from: scriptPath, meta: { tags: ['测试/导入'] } }),
			/description/,
		)
		await assert.rejects(
			() => tools.get('file_write').execute({ from: scriptPath, meta: { description: '缺少标签的导入' } }),
			/tags/,
		)
		const vague = await tools.get('file_write').execute({
			from: scriptPath,
			meta: { description: '导入短描述', tags: ['测试/导入'] },
		})
		assert.ok(vague.warnings.some((hint) => hint.includes('以后什么时候')), '导入也保留 descriptionAdvice')
	} finally {
		await cleanup()
		await rm(sourceDir, { recursive: true, force: true })
	}
})

test('file_write：普通项目文件自动建父目录，越界与目录目标拒绝', async () => {
	const { tools, project, cleanup } = await fixture()
	try {
		const written = await tools.get('file_write').execute({ target: 'src/deep/note.md', content: '正文' })
		assert.equal(written.target, 'src/deep/note.md')
		assert.equal(written.created, true)
		assert.equal(written.bytes, Buffer.byteLength('正文', 'utf8'))
		assert.equal(await readFile(join(project, 'src', 'deep', 'note.md'), 'utf8'), '正文')

		const again = await tools.get('file_write').execute({ target: 'src/deep/note.md', content: '改过' })
		assert.equal(again.created, false)
		assert.equal(await readFile(join(project, 'src', 'deep', 'note.md'), 'utf8'), '改过')

		await assert.rejects(() => tools.get('file_write').execute({ target: '../outside.md', content: 'x' }), /路径越界/)
		await assert.rejects(() => tools.get('file_write').execute({ target: join(project, '..', 'outside.md'), content: 'x' }), /路径越界/)
		await assert.rejects(() => tools.get('file_write').execute({ target: 'src', content: 'x' }), /目录/)
		await assert.rejects(() => tools.get('file_write').execute({ target: 'src/no-content.md' }), /需要 content/)
	} finally {
		await cleanup()
	}
})

test('库操作在拿不到会话 cwd 时仍然可用，项目路径操作给出清晰错误', async () => {
	const { store, cleanup } = await fixture()
	try {
		const tools = new Map(createTools({ store }).map((tool) => [tool.name, tool]))
		const created = await tools.get('file_write').execute({
			content: 'x',
			meta: { description: '整理作业没有会话 cwd 时仍能写库，验证库操作与项目路径解耦', tags: ['测试/无会话'] },
		})
		assert.match(created.id, /^file-/)
		assert.equal((await tools.get('file_read').execute({ target: created.id })).id, created.id)
		assert.equal((await tools.get('file_search').execute({ query: '整理作业' })).total, 1)
		await assert.rejects(() => tools.get('file_read').execute({ target: 'harness/' }), /工作目录/)
		await assert.rejects(() => tools.get('file_read').execute({ target: 'src/x.md' }), /工作目录/)
		await assert.rejects(() => tools.get('file_write').execute({ target: 'src/x.md', content: 'x' }), /工作目录/)
		await assert.rejects(
			() => tools.get('file_write').execute({ from: 'relative.txt', meta: { description: '无 cwd 不能相对导入', tags: ['测试'] } }),
			/工作目录/,
		)
	} finally {
		await cleanup()
	}
})

test('file_edit：库文件正文精确替换，0 次/多次都报错', async () => {
	const { tools, cleanup } = await fixture()
	try {
		const created = await createLibraryFile(tools, {
			name: 'edit.md',
			description: '编辑正文测试：验证 old/new 精确命中一处的规则',
			content: '第一行\n旧内容\n第三行\n',
			tags: ['测试/编辑'],
		})
		const edited = await tools.get('file_edit').execute({
			target: created.short,
			old: '旧内容',
			new: '新内容',
		})
		assert.equal(edited.id, created.id)
		assert.equal((await tools.get('file_read').execute({ target: created.id })).text, '第一行\n新内容\n第三行\n')

		await assert.rejects(
			() => tools.get('file_edit').execute({ target: created.id, old: '不存在的原文', new: 'x' }),
			/未找到/,
		)
		const duplicate = await createLibraryFile(tools, {
			name: 'dup.md',
			description: '重复文本测试：old 命中多处时必须要求更长的 old',
			content: '重复\n重复\n',
			tags: ['测试/编辑'],
		})
		await assert.rejects(
			() => tools.get('file_edit').execute({ target: duplicate.short, old: '重复', new: 'x' }),
			/命中 2 次/,
		)
		await assert.rejects(
			() => tools.get('file_edit').execute({ target: created.id }),
			/没有可执行的操作/,
		)
		await assert.rejects(
			() => tools.get('file_edit').execute({ target: created.id, old: '旧', new: '新' }),
			/未找到/,
			'库文件正文已替换，旧文本不再存在',
		)
	} finally {
		await cleanup()
	}
})

test('file_edit：库文件改描述/标签/links/归档，meta.remove 移入回收站', async () => {
	const { tools, store, cleanup } = await fixture()
	try {
		const target = await createLibraryFile(tools, {
			name: 'life.md',
			description: '生命周期测试：描述、标签、链接、归档与删除的元数据操作',
			content: 'x',
			tags: ['测试/生命周期'],
		})
		const other = await createLibraryFile(tools, {
			name: 'other.md',
			description: '关联目标：验证 file_edit 的 meta.links 写入',
			content: 'y',
			tags: ['测试/生命周期'],
		})
		const edited = await tools.get('file_edit').execute({
			target: target.short,
			meta: {
				description: '生命周期测试（已更新）：描述、标签、链接、归档与删除的元数据操作',
				tags: ['测试/生命周期', '工作/整理'],
				links: [other.id],
			},
		})
		assert.deepEqual(edited.tags, ['测试/生命周期', '工作/整理'])
		assert.deepEqual(edited.links, [other.id])

		const archived = await tools.get('file_edit').execute({ target: target.short, meta: { archived: true } })
		assert.equal(archived.archived, true)
		assert.equal((await tools.get('file_search').execute({ query: '元数据操作' })).total, 0, '归档后默认搜不到')
		const unarchived = await tools.get('file_edit').execute({ target: target.short, meta: { archived: false } })
		assert.equal(unarchived.archived, false)
		assert.equal((await tools.get('file_search').execute({ query: '元数据操作' })).total, 1)

		const removed = await tools.get('file_edit').execute({ target: target.id, meta: { remove: true } })
		assert.equal(removed.removed, true)
		assert.equal(removed.trashed, true)
		assert.equal((await tools.get('file_read').execute({ target: target.id })).found, false)
		assert.equal((await tools.get('file_search').execute({ query: '元数据操作' })).total, 0)
		assert.equal(store.stats().files, 1)

		await assert.rejects(
			() => tools.get('file_edit').execute({ target: other.id, meta: { title: 'x' } }),
			/没有 title\/summary|没有可执行的操作/,
		)
	} finally {
		await cleanup()
	}
})

test('file_edit：项目文件只做正文替换，删除与库元数据字段都拒绝', async () => {
	const { tools, project, cleanup } = await fixture()
	try {
		await writeFile(join(project, 'run.md'), '旧步骤\n')
		const edited = await tools.get('file_edit').execute({ target: 'run.md', old: '旧步骤', new: '新步骤' })
		assert.equal(edited.changed, true)
		assert.equal(await readFile(join(project, 'run.md'), 'utf8'), '新步骤\n')
		await assert.rejects(
			() => tools.get('file_edit').execute({ target: 'run.md', old: '旧步骤', new: 'x' }),
			/未找到/,
		)
		await assert.rejects(
			() => tools.get('file_edit').execute({ target: 'run.md', meta: { remove: true } }),
			/不能删除项目文件/,
		)
		await assert.rejects(
			() => tools.get('file_edit').execute({ target: 'run.md', meta: { description: '项目文件没有库描述' } }),
			/只用于库文件/,
		)
		await assert.rejects(
			() => tools.get('file_edit').execute({ target: 'run.md', meta: { summary: '项目文件没有库元数据' } }),
			/只用于库文件/,
		)
		await assert.rejects(() => tools.get('file_edit').execute({ target: 'none.md', old: 'a', new: 'b' }), /没有这个文件/)
		await assert.rejects(() => tools.get('file_edit').execute({ target: '../outside.md', old: 'a', new: 'b' }), /路径越界/)
	} finally {
		await cleanup()
	}
})

test('file_edit：字段名传错时报错点名，模型一次重试就能自纠', async () => {
	const { tools, project, cleanup } = await fixture()
	try {
		await writeFile(join(project, 'run.md'), '旧步骤\n')
		// 内置 edit 的字段名（old_string/new_string）撞上本工具的 old/new。
		// 报错必须说出它实际发的是哪个字段，否则模型只能原样重试。
		await assert.rejects(
			() => tools.get('file_edit').execute({ target: 'run.md', old_string: '旧步骤', new_string: '新步骤' }),
			(error) => {
				assert.match(error.message, /old_string/, '报错要点名 old_string')
				assert.match(error.message, /new_string/, '报错要点名 new_string')
				assert.match(error.message, /file_edit 用 old 和 new/, '报错要给出正确字段名')
				return true
			},
		)
		// 只给一半（真实会话里的形态：old 给了，new 写成了 new_string）同样点名。
		await assert.rejects(
			() => tools.get('file_edit').execute({ target: 'run.md', old: '旧步骤', new_string: '新步骤' }),
			/new_string/,
		)
		await assert.rejects(
			() => tools.get('file_edit').execute({ target: 'run.md', old: '旧步骤' }),
			/缺少 new/,
		)
		await assert.rejects(
			() => tools.get('file_edit').execute({ target: 'run.md', new: '新步骤' }),
			/缺少 old/,
		)
		// 正常调用不受影响。
		const ok = await tools.get('file_edit').execute({ target: 'run.md', old: '旧步骤', new: '新步骤' })
		assert.equal(ok.changed, true)
	} finally {
		await cleanup()
	}
})

test('file_write / file_search 的 graph 子图与空参数统计', async () => {
	const { tools, cleanup } = await fixture()
	try {
		const script = await createLibraryFile(tools, {
			name: 'export.sh',
			description: '导出脚本：生成报表用的导出命令，出问题时用它复现',
			content: '#!/bin/sh\necho export\n',
			tags: ['项目/报表', '类型/脚本'],
		})
		const notes = await createLibraryFile(tools, {
			name: 'notes.md',
			description: '导出流程说明：脚本怎么跑、产物在哪、失败怎么排查',
			content: '说明',
			tags: ['项目/报表', '类型/文档'],
			links: [script.id],
		})
		const word = await createLibraryFile(tools, {
			name: 'spec.md',
			description: '需求规格：报表导出的验收标准与字段定义',
			content: '规格',
			tags: ['项目/报表', '类型/文档'],
			links: [notes.id],
		})

		const indexed = await tools.get('file_search').execute({})
		assert.equal(indexed.total, 3)
		assert.equal(indexed.stats.files, 3)
		assert.equal(indexed.tags.some((row) => row.tag === '项目/报表' && row.count === 3), true)
		assert.equal(indexed.files.some((file) => file.id === word.id), true, '空参数返回最近文件')

		const byQuery = await tools.get('file_search').execute({ query: '报表' })
		assert.equal(byQuery.total, 3)
		assert.equal(byQuery.stats, undefined, '有查询词时不再附规模统计')
		const byTag = await tools.get('file_search').execute({ tags: ['项目/报表', '类型'] })
		assert.equal(byTag.total, 3)
		const byBoth = await tools.get('file_search').execute({ query: '导出', tags: ['类型/脚本'] })
		assert.deepEqual(byBoth.files.map((file) => file.id), [script.id])

		const graph = await tools.get('file_search').execute({ query: '报表', graph: true })
		assert.ok(graph.graph.nodes.some((node) => node.id === script.id))
		assert.ok(graph.graph.edges.some((edge) => edge.from === word.id && edge.to === notes.id))
		assert.ok(graph.graph.edges.some((edge) => edge.from === notes.id && edge.to === script.id))

		const limited = await tools.get('file_search').execute({ limit: 1 })
		assert.equal(limited.files.length, 1)
		assert.equal(limited.total, 3, 'limit 只截页，total 是真实总数')
	} finally {
		await cleanup()
	}
})

test('descriptionAdvice：vague 描述给软提示，写清场景不提示，都不阻断写入', async () => {
	const { tools, cleanup } = await fixture()
	try {
		const vague = await createLibraryFile(tools, {
			name: 'vague.md',
			description: '带死链的文件',
			content: 'x',
			tags: ['测试/描述'],
		})
		assert.ok(Array.isArray(vague.warnings), '短描述带 warnings')
		assert.ok(vague.warnings.some((hint) => hint.includes('以后什么时候')), '提示写清适用场景')
		const clear = await createLibraryFile(tools, {
			name: 'clear.md',
			description: '排查 Windows EBUSY 删除失败时，验证句柄与杀毒软件影响的可复现步骤',
			content: 'x',
			tags: ['测试/描述'],
		})
		assert.equal(clear.warnings, undefined, '写清场景的描述不再提示')
	} finally {
		await cleanup()
	}
})
