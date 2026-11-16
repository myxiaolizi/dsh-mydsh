/**
 * Build `client.js` from `client-src/`.
 *
 * The Client half is one browser artifact loaded through
 * `window.__ModuleLoader__`, which takes a single script. Writing six thousand
 * lines in one file is not reviewable, so the sources are split by concern and
 * concatenated here in a fixed order. They therefore share one function scope:
 * they are fragments of the same module body, not separate modules, and none of
 * them may declare an `import`/`export`.
 *
 * Run: node scripts/build-client.mjs
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const sourceDir = join(root, 'client-src')
const output = join(root, 'client.js')

const files = (await readdir(sourceDir)).filter((name) => name.endsWith('.js')).sort()
if (files.length === 0) {
  console.error('client-src/ has no sources')
  process.exit(1)
}

const parts = []
for (const name of files) {
  const text = await readFile(join(sourceDir, name), 'utf8')
  parts.push(`    // ===== ${name} =====\n${text.trimEnd()}\n`)
}

const banner = `/**
 * dsh-mydsh — Client half (generated).
 *
 * Built from client-src/ by scripts/build-client.mjs. Edit the sources, not
 * this file: a rebuild overwrites it.
 */
`

const body = `${banner}window.__ModuleLoader__.load({
  id: 'dsh-mydsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React

${parts.join('\n')}  },
})
`

await writeFile(output, body, 'utf8')
console.log(`client.js written from ${files.length} sources, ${body.split('\n').length} lines, ${Buffer.byteLength(body)} bytes`)
