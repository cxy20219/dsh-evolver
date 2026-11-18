/**
 * The `ziyan` command, run as a real process.
 *
 * The point of shelling out instead of importing the module is that the parts
 * an agent actually depends on are the ones a unit test cannot see: the exit
 * code, where the error went, and whether stdout is still parseable when the
 * call failed. Each case therefore runs `node bin/ziyan.mjs` and reads back
 * stdout, stderr and the status.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = resolve(fileURLToPath(new URL('..', import.meta.url)), 'bin/ziyan.mjs')

/**
 * Run the CLI and collect everything the caller would see.
 *
 * @param {string[]} args - Arguments after the script name.
 * @param {{cwd?: string, stdin?: string}} [options] - Process options.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} The run.
 */
function run(args, { cwd, stdin } = {}) {
	return new Promise((done) => {
		const child = execFile(process.execPath, [CLI, ...args], { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			done({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
		})
		if (stdin !== undefined) child.stdin.end(stdin)
		else child.stdin.end()
	})
}

/**
 * A throwaway library directory.
 *
 * @param {(dir: string) => Promise<void>} body - The test body.
 * @returns {Promise<void>} Resolves after cleanup.
 */
async function withLibrary(body) {
	const dir = await mkdtemp(join(tmpdir(), 'ziyan-cli-'))
	try {
		await body(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

test('ziyan：没有子命令时打印用法且退出码为 0', async () => {
	const result = await run([])
	assert.equal(result.code, 0)
	assert.match(result.stdout, /ziyan search/)
	assert.match(result.stdout, /--data-dir/)
})

test('ziyan：未知子命令打印用法到 stdout，但退出码为 1', async () => {
	const result = await run(['nope'])
	assert.equal(result.code, 1, '退出码区分「没给命令」与「给错了命令」')
	assert.match(result.stdout, /ziyan search/, '用法仍可读')
})

test('ziyan stats：自动识别库，报告路径与计数', async () => {
	await withLibrary(async (dir) => {
		const result = await run(['stats', '--data-dir', dir])
		assert.equal(result.code, 0)
		assert.match(result.stdout, new RegExp(`库：${dir}`))
		assert.match(result.stdout, /文件 0 个/)
	})
})

test('ziyan write：从文件写入并采用源文件名，返回可读摘要', async () => {
	await withLibrary(async (dir) => {
		const source = join(dir, 'from-cli.md')
		await writeFile(source, '紫电协议只在正文里出现。\n')
		const written = await run([
			'write', source,
			'--data-dir', join(dir, 'lib'),
			'--desc', '验证 CLI 能写能搜：以后排查命令行行为时看',
			'--tags', '测试/命令行',
		])
		assert.equal(written.code, 0)
		assert.match(written.stdout, /已创建/)
		assert.match(written.stdout, /from-cli\.md/, '没给 --name 时用源文件名')
	})
})

test('ziyan write：标准输入与 --json 可被解析', async () => {
	await withLibrary(async (dir) => {
		const lib = join(dir, 'lib')
		const written = await run([
			'write', '-',
			'--data-dir', lib,
			'--name', 'stdin.md',
			'--desc', '从标准输入写入的验证文件：以后测管道时看',
			'--tags', '测试',
			'--json',
		], { stdin: '青鸟协议正文。\n' })
		assert.equal(written.code, 0)
		const parsed = JSON.parse(written.stdout)
		assert.match(parsed.id, /^file-/)

		const found = await run(['search', '青鸟', '--data-dir', lib, '--json'])
		const hits = JSON.parse(found.stdout)
		assert.equal(hits.total, 1, '正文进索引，CLI 同样能搜到')
		assert.equal(hits.files[0].id, parsed.id)
	})
})

test('ziyan write：缺 description 时退出码 1 且不写文件', async () => {
	await withLibrary(async (dir) => {
		const source = join(dir, 'x.md')
		await writeFile(source, '内容\n')
		const failed = await run(['write', source, '--data-dir', join(dir, 'lib')])
		assert.equal(failed.code, 1)
		assert.match(failed.stderr, /description/)
		const stats = await run(['stats', '--data-dir', join(dir, 'lib')])
		assert.match(stats.stdout, /文件 0 个/, '拒绝之后库里没有留下半成品')
	})
})

test('ziyan edit：正文精确替换，只报实际发生的改动', async () => {
	await withLibrary(async (dir) => {
		const lib = join(dir, 'lib')
		const source = join(dir, 'edit.md')
		await writeFile(source, '旧内容在这里。\n')
		const written = await run(['write', source, '--data-dir', lib, '--desc', '编辑测试：以后验证替换语义时看', '--tags', '测试', '--json'])
		const id = JSON.parse(written.stdout).id

		const edited = await run(['edit', id, '--data-dir', lib, '--old', '旧内容', '--new', '新内容'])
		assert.equal(edited.code, 0)
		assert.match(edited.stdout, /正文已改/)
		assert.doesNotMatch(edited.stdout, /描述已改/, '没改描述就不该这么说')

		const read = await run(['read', id, '--data-dir', lib, '--raw'])
		assert.equal(read.stdout.trim(), '新内容在这里。')
	})
})

test('ziyan edit：old 不匹配时退出码 1', async () => {
	await withLibrary(async (dir) => {
		const lib = join(dir, 'lib')
		const source = join(dir, 'm.md')
		await writeFile(source, '原文。\n')
		const written = await run(['write', source, '--data-dir', lib, '--desc', '匹配失败测试：以后排查替换错误时看', '--tags', '测试', '--json'])
		const id = JSON.parse(written.stdout).id
		const failed = await run(['edit', id, '--data-dir', lib, '--old', '不存在的文字', '--new', 'x'])
		assert.equal(failed.code, 1)
		assert.match(failed.stderr, /未找到|没有找到|不匹配/)
	})
})

test('ziyan read：不存在时退出码为 0 但明确说没有', async () => {
	await withLibrary(async (dir) => {
		// 格式合法的 id 才会被当成库文件；不合法的会被当项目路径。
		const result = await run(['read', 'file-01ABCDEFGHJKMNPQRSTVWXYZ12', '--data-dir', join(dir, 'lib')])
		// 读不到不是命令出错，是「这里没有这个文件」——agent 需要能区分二者。
		assert.match(result.stdout, /没有这个文件/)
	})
})

test('ziyan search：无结果时给出可读结论而不是空输出', async () => {
	await withLibrary(async (dir) => {
		const result = await run(['search', '绝不存在的词', '--data-dir', join(dir, 'lib')])
		assert.equal(result.code, 0)
		assert.match(result.stdout, /没有匹配/)
	})
})

test('ziyan：相对 --data-dir 被拒绝', async () => {
	await withLibrary(async (dir) => {
		const result = await run(['stats', '--data-dir', 'relative/lib'], { cwd: dir })
		assert.equal(result.code, 1)
		assert.match(result.stderr, /绝对路径/)
	})
})
