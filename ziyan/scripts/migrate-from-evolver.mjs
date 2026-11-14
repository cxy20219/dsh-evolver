#!/usr/bin/env node
/**
 * Migrate an evolver 1.0 card library into a 自衍中枢 data directory.
 *
 * Dry-run is the default. `--apply` writes; the source is never modified.
 * Re-running is idempotent: records are matched by the old `card-` id kept in
 * `legacy_id`, and an existing card is only touched again when this run adds
 * an attachment to it.
 *
 *   node scripts/migrate-from-evolver.mjs
 *   node scripts/migrate-from-evolver.mjs --apply
 *   node scripts/migrate-from-evolver.mjs --from ~/.dsh/evolver --to ~/.dsh/ziyan --apply
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { migrateEvolver } from '../src/migrate.js'

/**
 * Read a `--name value` or `--name=value` option.
 *
 * @param {string[]} argv - Process arguments.
 * @param {string} name - Option name without dashes.
 * @returns {string | undefined} The value.
 */
function option(argv, name) {
	const index = argv.indexOf(`--${name}`)
	if (index >= 0) return argv[index + 1]
	const prefixed = argv.find((arg) => arg.startsWith(`--${name}=`))
	return prefixed === undefined ? undefined : prefixed.slice(name.length + 3)
}

/**
 * Print the human summary.
 *
 * @param {object} result - The migration summary.
 * @returns {void}
 */
function printSummary(result) {
	const source = result.source
	console.log(`迁移${result.mode === 'apply' ? '已写入' : '预演（未写盘）'}`)
	console.log(`  来源：${result.from}`)
	console.log(`  目标：${result.to}`)
	console.log(`  源记录：${source.lines} 行 / ${source.unique} 唯一 / ${source.deleted} 删除 / ${source.active} 活跃 + ${source.archived} 归档`)
	console.log(`  卡片：新建 ${result.cards.created} / 已存在 ${result.cards.skippedExisting} / 失败 ${result.cards.failed}`)
	console.log(`  附件：新建 ${result.attachments.created} / 已存在 ${result.attachments.skippedExisting}`)
	console.log(`  链接：解析 ${result.links.resolved} / 丢弃 ${result.links.dropped}`)
	console.log(`  正文路径改写：${result.bodiesRewritten}；卡片更新：${result.cardsUpdated}`)
	console.log(`  耗时：${result.elapsedMs} ms`)
	if (result.warnings.length > 0) {
		console.log(`  警告 ${result.warnings.length} 条：`)
		for (const warning of result.warnings.slice(0, 20)) console.log(`    - ${warning}`)
		if (result.warnings.length > 20) console.log(`    …还有 ${result.warnings.length - 20} 条`)
	}
	if (result.mode !== 'apply') console.log('\n预演没有写任何文件；确认后加 --apply。')
}

async function main() {
	const argv = process.argv.slice(2)
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(`用法：node scripts/migrate-from-evolver.mjs [选项]

  --from <dir>   老 evolver 数据目录（默认 ~/.dsh/evolver）
  --to <dir>     自衍中枢数据目录（默认 ~/.dsh/ziyan）
  --apply        真正写入；默认只预演
  --json         只输出 JSON 摘要
  -h, --help     显示帮助

旧 id 会写进 legacy_id；重复执行会跳过已迁移卡片，不产生重复。`)
		return
	}
	const from = option(argv, 'from') ?? join(homedir(), '.dsh', 'evolver')
	const to = option(argv, 'to') ?? join(homedir(), '.dsh', 'ziyan')
	const apply = argv.includes('--apply')
	const json = argv.includes('--json')
	const result = await migrateEvolver({ from, to, apply, logger: json ? { info() {} } : console })
	if (json) {
		const { cardMap: _cardMap, ...summary } = result
		void _cardMap
		process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
	} else {
		printSummary(result)
	}
}

main().catch((error) => {
	console.error(`迁移失败：${error instanceof Error ? error.message : String(error)}`)
	process.exitCode = 1
})
