/**
 * Check the concatenated Client artifact the way the loader will see it.
 *
 * `client-src/*.js` are fragments of one function body, so two files declaring
 * the same name is a syntax error — but a silent one until the browser loads the
 * page. This script parses the built artifact, lists every top-level binding
 * inside the factory, and reports duplicates and unresolved references.
 *
 * Run: node scripts/check-client.mjs
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(join(root, 'client.js'), 'utf8')

const errors = []
const warnings = []

// --- shape ---------------------------------------------------------------

if (!source.includes("window.__ModuleLoader__.load({")) errors.push('factory registration is missing')
if (!source.includes("id: 'dsh-mydsh'")) errors.push('factory id is not dsh-mydsh')
if (/\bimport\s+[\w{*]/.test(source)) errors.push('an import statement survived the bundle')
if (/\bexport\s+(default|const|function|class|\{)/.test(source)) errors.push('an export statement survived the bundle')

// --- top-level declarations ----------------------------------------------

/**
 * Names declared at the fragment top level.
 *
 * The build concatenates fragments verbatim inside the factory body, so a
 * top-level declaration there sits at column 0 — exactly as it did in its own
 * file. Matching `^` instead of an indented prefix is what separates these from
 * the locals inside a component.
 */
const declared = new Map()

const patterns = [
  { kind: 'function', re: /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'const', re: /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'class', re: /^class\s+([A-Za-z_$][\w$]*)/gm },
]

for (const { kind, re } of patterns) {
  for (const match of source.matchAll(re)) {
    const name = match[1]
    const line = source.slice(0, match.index).split('\n').length
    const previous = declared.get(name)
    if (previous !== undefined) {
      errors.push(`duplicate top-level ${kind} "${name}" at line ${line} (first at line ${previous.line})`)
    } else {
      declared.set(name, { kind, line })
    }
  }
}

// --- component coverage ---------------------------------------------------

/**
 * Functions the mounting code calls by name. A missing one surfaces as a
 * `ReferenceError` only when that slot renders, which is the least convenient
 * moment to discover it.
 */
const required = [
  'Page',
  'UsagePanel',
  'PanelIcon',
  'NewSessionVeil',
  'Blank',
  'FooterUsage',
  'AccountBubble',
  'TitlebarContext',
  'ComposerMetrics',
  'AutoContinueMenu',
  'InterfaceTab',
  'OverviewTab',
  'AboutTab',
  'UsageSettingsTab',
  'BackupTab',
  'RetryTab',
  'PersonalizeTab',
  'ModulesTab',
  'RelayTab',
  'UsageView',
  'ContextView',
  'TeamView',
  'Styles',
  'Row',
  'Switch',
  'Card',
  'Stat',
  'Note',
  'Badge',
  'TextField',
  'TextArea',
  'Select',
  'Segmented',
  'Button',
  'Bar',
  'Empty',
  'LineChart',
  'BarChart',
  'HeatMap',
  'Donut',
  'Legend',
  'Modal',
  'Popover',
  'usePoll',
  'useAction',
  'RangeBar',
  'usageQuery',
  'useMeta',
]

for (const name of required) {
  if (!declared.has(name)) errors.push(`required binding "${name}" is not declared at the top level`)
}

// --- unresolved-looking references ---------------------------------------

/**
 * A cheap sanity net for typos in helper calls: every `letter(` identifier that
 * is neither declared here, nor a JS keyword, nor a known local, is reported as
 * a warning rather than an error, because property calls and parameters look the
 * same to a regex.
 */
const keywords = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'throw', 'else', 'do',
  'async', 'await', 'of', 'in', 'delete', 'void', 'yield', 'super', 'this', 'case', 'default', 'try',
])

const calledNames = new Set()
for (const match of source.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) calledNames.add(match[1])

for (const name of calledNames) {
  if (declared.has(name) || keywords.has(name)) continue
  warnings.push(`unresolved identifier "${name}" (may be a parameter or a property call)`)
}

// --- report ---------------------------------------------------------------

console.log(`declared bindings: ${declared.size}`)
console.log(`distinct call names: ${calledNames.size}`)

if (warnings.length > 0) {
  console.log(`\nwarnings (${warnings.length}):`)
  for (const line of warnings.slice(0, 60)) console.log(`  ${line}`)
}

if (errors.length > 0) {
  console.log(`\nERRORS (${errors.length}):`)
  for (const line of errors) console.log(`  ${line}`)
  process.exitCode = 1
} else {
  console.log('\nclient bundle passed structural checks')
}
