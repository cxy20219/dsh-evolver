#!/usr/bin/env node
/**
 * The repository's self-check gate.
 *
 * Two questions have to be answered before a change may be called done: does
 * every source file still parse, and do the tests still pass. Each answer is
 * cheap; forgetting the second is how a broken build reaches a commit.
 *
 * There used to be a third step that validated the project's `harness/` folder
 * against the index the plugin generated for it. The plugin no longer owns
 * that folder, so there is nothing to validate: `harness/` here is an ordinary
 * directory the project maintains itself.
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
 * - The reporter is pinned to TAP because the counters below read TAP's
 *   summary lines. Node's default reporter is `spec` on some versions and
 *   TTY states, and its summary lines then do not parse: the counters read
 *   zero, a red suite still prints "自检通过", and the gate becomes a green
 *   light that means nothing.
 *
 * Two tests depend on creating a symbolic link, which a hardened Windows host
 * refuses; they guard themselves and report themselves as skipped, so a host
 * limitation never turns into a red build.
 *
 * Usage:
 *   node harness/tool/verify-repo.mjs
 *
 * Exit code: 0 when nothing regressed, 1 when something did.
 */

import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'


const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Directories that hold nothing this gate should parse. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.scratch'])

/** The extensions worth a syntax check. */
const CHECKED_EXTENSIONS = new Set(['.js', '.mjs'])

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
		const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: root, stdio: ['ignore', fd, fd] })
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
	skipped += count(/^# skipped (\d+)$/m)
	if (status === 0) continue
	const titles = [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1].trim())
	// A file that exits non-zero has failed, whatever its summary said. Counting
	// the parsed number alone would let an unreadable summary turn a red suite
	// into a green gate.
	failed += Math.max(bad, 1)
	regressions.push(...(titles.length > 0 ? titles.map((title) => `${name} — ${title}`) : [`${name}（退出码 ${status}，摘要未解析出失败用例）`]))
}
console.log(`测试：${total} 个用例，${passed} 通过，${failed} 失败，${skipped} 跳过`)
for (const line of regressions) console.error(`  失败：${line}`)

const ok = broken === 0 && failed === 0
console.log(ok ? '自检通过：语法与测试都没有回归。' : '自检未通过。')
process.exit(ok ? 0 : 1)
