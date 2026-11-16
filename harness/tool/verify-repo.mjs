#!/usr/bin/env node
/**
 * The repository's self-check gate.
 *
 * Three questions have to be answered before a change may be called done:
 * does every source file still parse, does the harness folder still agree with
 * the index the plugin generates from it, and do the tests still pass. Each
 * answer is cheap; forgetting the third is how a broken build reaches a commit.
 *
 * The harness step reuses the plugin's own `validate()` instead of a second
 * implementation of the rules: the plugin decides what a valid harness folder
 * is, so a copy of that rule would drift away from it the moment the plugin
 * changes.
 *
 * Three environment facts shape the implementation, all of them learned the
 * hard way:
 *
 * - A sandboxed host cannot open the named pipes a piped stdio needs, so
 *   `spawnSync` fails with EPERM. Every child here runs with `stdio: 'inherit'`
 *   or with file descriptors — never with a pipe.
 * - Node refuses to launch `npm.cmd` without a shell (EINVAL), so the tests are
 *   called as `node <file>` instead of through npm.
 * - The test runner spawns a child per test file, which the sandbox also
 *   blocks. The files are therefore run one by one, each in its own process.
 *
 * Two tests depend on creating a symbolic link, which a hardened Windows host
 * refuses. They are reported as environment failures, not regressions, and
 * only while the host really cannot create a link.
 *
 * Usage:
 *   node harness/tool/verify-repo.mjs
 *
 * Exit code: 0 when nothing regressed, 1 when something did.
 */

import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validate } from '../../src/harness/validate.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Directories that hold nothing this gate should parse. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.scratch'])

/** The extensions worth a syntax check. */
const CHECKED_EXTENSIONS = new Set(['.js', '.mjs'])

/**
 * Tests that cannot pass on a host which refuses to create symbolic links.
 *
 * The preferences migration needs one for the DSH entry file, and the rebuild
 * report needs one to notice that a link is not followed.
 */
const LINK_DEPENDENT_TESTS = new Set([
	'偏好：迁移现有 AGENTS.md 全文，只删旧受管段标记、内容保留',
	'符号链接不被跟随：读取标 unsafe，重建报告问题',
])

/**
 * Every source file under a directory.
 *
 * @param {string} dir - The directory to walk.
 * @param {string[]} [found] - The accumulator.
 * @returns {Promise<string[]>} Absolute paths.
 */
async function sourceFiles(dir, found = []) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue
			await sourceFiles(join(dir, entry.name), found)
			continue
		}
		if (!entry.isFile()) continue
		const dot = entry.name.lastIndexOf('.')
		if (dot < 0) continue
		if (!CHECKED_EXTENSIONS.has(entry.name.slice(dot))) continue
		found.push(join(dir, entry.name))
	}
	return found
}

/**
 * Whether this host can create a symbolic link.
 *
 * @returns {boolean} True when a link can be created.
 */
function canCreateSymlink() {
	const dir = mkdtempSync(join(tmpdir(), 'ziyan-symlink-probe-'))
	try {
		const source = join(dir, 'source.txt')
		writeFileSync(source, 'probe')
		const result = spawnSync(process.execPath, ['-e', `require('node:fs').symlinkSync(${JSON.stringify(source)}, ${JSON.stringify(join(dir, 'link.txt'))})`], { stdio: 'ignore' })
		return result.status === 0
	} catch {
		return false
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

/**
 * Run one test file and read its TAP output.
 *
 * @param {string} file - The test file.
 * @returns {{status: number|null, output: string}} What it said.
 */
function runTestFile(file) {
	const dir = mkdtempSync(join(tmpdir(), 'ziyan-gate-'))
	const log = join(dir, 'tap.txt')
	try {
		const fd = openSync(log, 'w')
		const result = spawnSync(process.execPath, [file], { cwd: root, stdio: ['ignore', fd, fd] })
		closeSync(fd)
		return { status: result.status, output: readFileSync(log, 'utf8') }
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

const files = await sourceFiles(root)
let broken = 0
for (const file of files) {
	const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
	if (result.status === 0) continue
	broken += 1
	process.stderr.write(`语法错误：${relative(root, file)}\n`)
}
console.log(`语法检查：${files.length - broken}/${files.length} 个文件通过`)

const report = await validate(root)
for (const warning of report.warnings) console.log(`  警告：${warning}`)
for (const skip of report.skipped) console.log(`  跳过：${skip.path} — ${skip.reason}`)
if (!report.ok) {
	for (const error of report.errors) console.error(`harness 校验失败：${error}`)
}

const symlinks = canCreateSymlink()
if (!symlinks) console.log('  注意：本机不能创建软链（Windows 未开开发者模式或宿主受限），依赖软链的测试按环境失败计。')

const testFiles = (await readdir(join(root, 'test'))).filter((name) => name.endsWith('.test.mjs')).sort()
let total = 0
let passed = 0
let failed = 0
let skipped = 0
const regressions = []
for (const name of testFiles) {
	const { status, output } = runTestFile(join(root, 'test', name))
	// TAP on Windows ends its lines with CRLF; the summary lines are matched
	// without it.
	const text = output.replace(/\r/g, '')
	const count = (pattern) => Number((text.match(pattern) ?? [])[1] ?? 0)
	const tests = count(/^# tests (\d+)$/m)
	const ok = count(/^# pass (\d+)$/m)
	const bad = count(/^# fail (\d+)$/m)
	total += tests
	passed += ok
	if (status === 0) continue
	const titles = [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1].trim())
	const environmental = !symlinks && titles.length > 0 && titles.every((title) => LINK_DEPENDENT_TESTS.has(title))
	if (environmental) {
		skipped += bad
		console.log(`  环境失败：${name} — ${titles.join('；')}`)
		continue
	}
	failed += bad
	regressions.push(...titles.map((title) => `${name} — ${title}`))
}
console.log(`测试：${total} 个用例，${passed} 通过，${failed} 失败，${skipped} 条因环境（无软链权限）跳过`)
for (const line of regressions) console.error(`  失败：${line}`)

const ok = broken === 0 && report.ok && failed === 0
console.log(ok ? '自检通过：语法、harness 结构、测试都没有回归。' : '自检未通过。')
process.exit(ok ? 0 : 1)
