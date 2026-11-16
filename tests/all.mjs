/**
 * Run every engine's own test file, then the assembled suite.
 *
 * The engines each shipped with a focused test file while they were written in
 * parallel; this runner keeps them as separate entry points instead of merging
 * their thousands of lines into one file, and adds the checks that only make
 * sense once the plugin is assembled.
 *
 * Run: node tests/all.mjs
 */

import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const engineDir = join(here, 'engines')

/** Run one file and relay its exit status. */
function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit', cwd: here })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

const files = (await readdir(engineDir)).filter((name) => name.endsWith('.mjs')).sort()
const results = []

for (const name of [...files.map((entry) => join(engineDir, entry)), join(here, 'run.mjs')]) {
  console.log(`\n${'='.repeat(70)}\n${name}\n${'='.repeat(70)}`)
  const code = await run(name)
  results.push({ name, code })
  if (code !== 0) console.log(`\n!! ${name} exited with ${code}`)
}

const failed = results.filter((entry) => entry.code !== 0)
console.log(`\n${results.length - failed.length}/${results.length} test files green`)
for (const entry of failed) console.log(`  failed: ${entry.name}`)
process.exit(failed.length === 0 ? 0 : 1)
