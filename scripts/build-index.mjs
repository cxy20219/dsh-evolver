#!/usr/bin/env node
/**
 * Rebuild the practice index.
 *
 * The index is generated from the entries' frontmatter, so this script never
 * has to be edited — only run. It is also the canonical way to regenerate the
 * index after files were changed outside the panel.
 *
 *   node scripts/build-index.mjs [--data-dir <path>] [--check]
 *
 * `--check` validates without writing: it exits with code 1 when the practice
 * tree has problems, which makes it usable as a guard in a script.
 */

import { join, resolve } from 'node:path'

import { regenerate, validatePractice, scanPractice, buildProjection } from '../src/practice.js'
import { resolveDshHome } from '../src/evolver.js'

/**
 * Read the command line arguments.
 *
 * @param {string[]} argv - The arguments.
 * @returns {{dataDir: string, check: boolean}} The options.
 */
function parseArgs(argv) {
	let dataDir = ''
	let check = false
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === '--data-dir' && index + 1 < argv.length) {
			dataDir = argv[index + 1]
			index += 1
			continue
		}
		if (argv[index] === '--check') check = true
	}
	return {
		dataDir: dataDir === '' ? join(resolveDshHome(), 'evolver', 'practice') : resolve(dataDir),
		check,
	}
}

const options = parseArgs(process.argv.slice(2))

if (options.check) {
	const scan = await scanPractice(options.dataDir)
	const problems = validatePractice(scan.entries, scan.problems)
	const projection = buildProjection(scan.entries)
	const errors = problems.filter((problem) => problem.level === 'error')
	for (const problem of problems) {
		process.stdout.write(`${problem.level === 'error' ? '✖' : '·'} ${problem.path}: ${problem.message}\n`)
	}
	process.stdout.write(`${scan.entries.length} entries, ${errors.length} errors, ${projection.dropped.length} left out of the index\n`)
	process.exit(errors.length > 0 ? 1 : 0)
}

const result = await regenerate(options.dataDir)
process.stdout.write(`index rebuilt: ${result.entries.length} entries, ${result.problems.length} problems, ${result.written.length} files\n`)
for (const problem of result.problems) {
	process.stdout.write(`${problem.level === 'error' ? '✖' : '·'} ${problem.path}: ${problem.message}\n`)
}
process.exit(result.problems.some((problem) => problem.level === 'error') ? 1 : 0)
