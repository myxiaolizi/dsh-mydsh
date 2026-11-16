/**
 * Live-corpus sanity check.
 *
 * The synthetic suites prove arithmetic and shape. This proves the reader copes
 * with logs the Host actually wrote: real event mixes, real compaction markers,
 * real subagent sessions. It decodes the zstd-chunked JSONL the persistence
 * layer writes, builds a minimal `sessionQuery` over it, and prints what the
 * engine makes of it.
 *
 * Read-only: it never writes to the profile.
 *
 * Run with:  node host/usage/smoke-live.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

import { createUsageEngine } from '../../host/usage/engine.js'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode one session file.
 *
 * Persistence writes the log as a sequence of independent zstd frames, so the
 * file cannot be decompressed in one call: each frame is located by its magic
 * bytes and decoded on its own. A frame that fails to decode is skipped, which
 * is what a half-written tail looks like after a hard exit.
 */
function decodeLog(path) {
  const buffer = readFileSync(path)
  if (!path.endsWith('.zstd')) return buffer.toString('utf8')
  const starts = []
  let cursor = 0
  for (;;) {
    const at = buffer.indexOf(MAGIC, cursor)
    if (at < 0) break
    starts.push(at)
    cursor = at + MAGIC.length
  }
  let text = ''
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(from, to)).toString('utf8')
    } catch {
      // A truncated final frame is expected; earlier frames are intact.
    }
  }
  return text
}

/** Every `session.v*.jsonl[.zstd]` under one root, newest first. */
function findLogs(root) {
  const found = []
  const walk = (directory) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!/^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name)) continue
      try {
        found.push({ path, mtime: statSync(path).mtimeMs })
      } catch {
        // Vanished between listing and stat; nothing to read.
      }
    }
  }
  walk(root)
  found.sort((left, right) => right.mtime - left.mtime)
  return found
}

function main() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const logs = findLogs(join(home, 'sessions'))
  console.log(`corpus: ${logs.length} session logs under ${join(home, 'sessions')}`)
  if (logs.length === 0) {
    console.log('nothing to read; the synthetic suites cover behaviour instead')
    return
  }

  // Only the most recent handful: this is a smoke test, not a full reindex.
  const sample = logs.slice(0, 12)
  const corpus = []
  for (const entry of sample) {
    const events = decodeLog(entry.path)
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return undefined
        }
      })
      .filter((event) => event !== undefined)
    const header = events.find((event) => event.type === 'session') ?? {}
    const sessionHeader = { ...header, id: header.id ?? entry.path }
    corpus.push({ header: sessionHeader, events })
  }
  console.log(`decoded: ${corpus.map((entry) => entry.events.length).join(', ')} events per log`)

  const sessionQuery = {
    async listSessions() {
      return corpus.map((entry) => ({ header: entry.header, live: false, persisted: true }))
    },
    async readSession(sessionId) {
      const entry = corpus.find((candidate) => candidate.header.id === sessionId)
      if (entry === undefined) throw new Error(`session "${sessionId}" not found`)
      return { session: entry.header, inheritedEventCount: 0, events: entry.events }
    },
    async listEvents(sessionId) {
      const entry = corpus.find((candidate) => candidate.header.id === sessionId)
      if (entry === undefined) throw new Error(`session "${sessionId}" not found`)
      return entry.events.map((event) => ({ seq: event.seq, type: event.type, time: event.time }))
    },
  }

  const engine = createUsageEngine({
    ctx: { get: (name) => (name === 'sessionQuery' ? sessionQuery : undefined) },
    getSettings: () => ({
      usage: {
        enabled: true,
        source: 'auto',
        retainDays: 400,
        recentRequestPool: 20,
        geekMetrics: { showTtft: true, showSpeed: true, showTokens: true, pool: 20 },
        contextInsight: { showComposition: true, showTrend: true, showBrowser: true },
        balance: { deepseek: { enabled: false, apiKey: '', baseUrl: 'https://api.deepseek.com' }, providers: [], ttlSeconds: 120 },
        budgets: [],
        priceOverrides: [],
        estimateUnknown: true,
      },
    }),
    dshHome: join(home, 'dsh-mydsh'),
  })

  return (async () => {
    const summary = await engine.summary({ range: '30d' })
    console.log('\nsummary (30d)')
    console.log(`  totals          ${JSON.stringify(summary.totals)}`)
    console.log(`  series points   ${summary.series.length}`)
    console.log(`  dims            provider=${summary.dims.provider.length} model=${summary.dims.model.length} workspace=${summary.dims.workspace.length} session=${summary.dims.session.length}`)
    console.log(`  models          ${summary.models.map((entry) => `${entry.provider}/${entry.model}`).join(', ')}`)

    const { sessions } = await engine.sessions({ range: '30d' })
    console.log('\nsessions (30d)')
    for (const row of sessions.slice(0, 5)) {
      console.log(
        `  ${row.id.slice(-8)}  turns=${row.turns} req=${row.requests} fail=${row.failedRequests} tok=${row.totalTokens} hit=${row.hitRate.toFixed(3)} cost=${row.cost.toFixed(6)} ${row.currency} ${row.provider}/${row.model}`,
      )
    }

    const first = corpus.find((entry) => entry.events.some((event) => event.type === 'assistant/message'))
    if (first !== undefined) {
      const context = await engine.context({ sessionId: first.header.id })
      console.log('\ncontext (newest session with usage)')
      console.log(`  used=${context.usedTokens} window=${context.windowTokens} ratio=${context.ratio.toFixed(4)} estimate=${context.estimateTokens} reported=${context.reportedTokens}`)
      console.log(`  buckets  ${context.buckets.map((bucket) => `${bucket.key}=${bucket.tokens}`).join(' ')}`)
      const sum = context.buckets.reduce((total, bucket) => total + bucket.tokens, 0)
      console.log(`  buckets sum to usedTokens: ${sum === context.usedTokens ? 'yes' : `NO (${sum} != ${context.usedTokens})`}`)
      console.log(`  series=${context.series.length} browsers=${context.browsers.length} events=${context.events.length}`)

      const geek = await engine.geek({ sessionId: first.header.id, pool: 5 })
      console.log('\ngeek (same session)')
      for (const row of geek.requests.slice(0, 5)) {
        console.log(
          `  ${row.provider}/${row.model} ttft=${Math.round(row.ttftMs)}ms dur=${Math.round(row.durationMs)}ms out=${row.outputTokens} speed=${Math.round(row.speed)}/s cost=${row.cost.toFixed(6)} ${row.status}`,
        )
      }
      console.log(`  stream=${geek.stream === null ? 'null (nothing in flight)' : JSON.stringify(geek.stream)}`)
      console.log(`  avg=${JSON.stringify(geek.avg)}`)
    }

    const budgets = await engine.budgets()
    console.log(`\nbudgets: ${budgets.evaluation.length} evaluated, over=${budgets.over}`)

    const prices = await engine.prices({})
    console.log(`prices: ${prices.rows.length} rows, source=${prices.source}`)
    console.log(`isPaused: ${await engine.isPaused()}`)
  })()
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
