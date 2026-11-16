/**
 * Contract conformance check.
 *
 * `Tasks/2026-11-16_dsh-mydsh-v2/notes/api-contract.md` names every field the
 * client reads. This script asserts each one is present, with the right kind of
 * value, on payloads produced from a synthetic corpus — so a renamed or dropped
 * field fails here instead of rendering as `undefined` in the panel.
 *
 * It is stricter than the self-test: the self-test proves behaviour, this proves
 * shape. Both are needed because a correct number under the wrong key is still a
 * broken page.
 */

import assert from 'node:assert'

import { createUsageEngine, resetUsageCaches } from '../../host/usage/engine.js'

const NOW = Date.now()
const MINUTE = 60000

const TYPES = {
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => typeof value === 'number' && Number.isInteger(value),
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  array: (value) => Array.isArray(value),
}

/** Assert one object carries exactly the declared fields, each of the right kind. */
function shape(name, value, spec, options = {}) {
  assert.ok(value !== null && typeof value === 'object', `${name} must be an object`)
  for (const [field, kind] of Object.entries(spec)) {
    assert.ok(field in value, `${name}.${field} is missing`)
    const check = TYPES[kind]
    assert.ok(check(value[field]), `${name}.${field} should be ${kind}, saw ${JSON.stringify(value[field])}`)
  }
  if (options.exact === true) {
    for (const field of Object.keys(value)) {
      assert.ok(field in spec, `${name}.${field} is not in the contract`)
    }
  }
  return value
}

const SPECS = {
  Totals: {
    exact: true,
    fields: {
      inputTokens: 'number',
      outputTokens: 'number',
      cacheReadTokens: 'number',
      cacheWriteTokens: 'number',
      totalTokens: 'number',
      requests: 'number',
      failedRequests: 'number',
      turns: 'number',
      durationMs: 'number',
      cost: 'number',
      currency: 'string',
    },
  },
  Point: {
    exact: true,
    fields: {
      t: 'number',
      label: 'string',
      inputTokens: 'number',
      outputTokens: 'number',
      cacheReadTokens: 'number',
      totalTokens: 'number',
      requests: 'number',
      cost: 'number',
    },
  },
  Row: {
    fields: {
      key: 'string',
      label: 'string',
      inputTokens: 'number',
      outputTokens: 'number',
      cacheReadTokens: 'number',
      totalTokens: 'number',
      requests: 'number',
      durationMs: 'number',
      cost: 'number',
      hitRate: 'number',
      sub: 'array',
    },
  },
  /**
   * One level of drill-down below a `Row`. The contract names `sub` but not its
   * element, so this is the shape the panel expands into: the same measures
   * without a further `sub`, because a second level would have no UI to show it.
   */
  SubRow: {
    fields: {
      key: 'string',
      label: 'string',
      inputTokens: 'number',
      outputTokens: 'number',
      cacheReadTokens: 'number',
      totalTokens: 'number',
      requests: 'number',
      durationMs: 'number',
      cost: 'number',
      hitRate: 'number',
    },
  },
  SessionRow: {
    fields: {
      id: 'string',
      label: 'string',
      workspace: 'string',
      provider: 'string',
      model: 'string',
      firstAt: 'number',
      lastAt: 'number',
      turns: 'number',
      requests: 'number',
      inputTokens: 'number',
      outputTokens: 'number',
      cacheReadTokens: 'number',
      totalTokens: 'number',
      durationMs: 'number',
      cost: 'number',
      hitRate: 'number',
    },
  },
  BalanceRow: {
    fields: {
      id: 'string',
      label: 'string',
      ok: 'boolean',
      currency: 'string',
      total: 'number',
      granted: 'number',
      toppedUp: 'number',
      expiresAt: 'number',
      message: 'string',
      at: 'number',
      source: 'string',
    },
  },
  BudgetStatus: {
    fields: {
      id: 'string',
      label: 'string',
      scope: 'string',
      period: 'string',
      state: 'string',
      usedTokens: 'number',
      usedCost: 'number',
      limitTokens: 'number',
      limitCost: 'number',
      ratio: 'number',
      windowFrom: 'number',
      windowTo: 'number',
    },
  },
  GeekRequest: {
    fields: {
      at: 'number',
      sessionId: 'string',
      source: 'string',
      status: 'string',
      model: 'string',
      provider: 'string',
      ttftMs: 'number',
      durationMs: 'number',
      inputTokens: 'number',
      outputTokens: 'number',
      cacheReadTokens: 'number',
      speed: 'number',
      cost: 'number',
    },
  },
  GeekLive: {
    fields: {
      at: 'number',
      ttftMs: 'number',
      streamMs: 'number',
      inputTokens: 'number',
      outputTokens: 'number',
      speed: 'number',
    },
  },
  PriceRow: {
    exact: true,
    fields: {
      provider: 'string',
      model: 'string',
      input: 'number',
      output: 'number',
      cacheRead: 'number',
      cacheWrite: 'number',
      currency: 'string',
      source: 'string',
    },
  },
  ContextEvent: {
    fields: {
      at: 'number',
      seq: 'number',
      category: 'string',
      description: 'string',
      tokens: 'number',
      delta: 'number',
      turn: 'number',
    },
  },
}

/** One session with metered usage, an attempt, tool traffic and a live tail. */
function corpus() {
  const start = NOW - 45 * MINUTE
  const events = [
    { type: 'session', seq: 0, time: start, data: { id: 'conformance', cwd: '/work/gamma' } },
    { type: 'turn/start', seq: 1, time: start + 1000, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: start + 1000, data: { turn: 1, step: 1 } },
    {
      type: 'request/header',
      seq: 3,
      time: start + 1000,
      data: {
        header: {
          config: { provider: 'zhipu', model: 'glm-4.6' },
          tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
        },
      },
    },
    { type: 'request/context', seq: 4, time: start + 1000, data: { provider: 'zhipu', model: 'glm-4.6', contextWindow: 200000 } },
    {
      type: 'system/message',
      seq: 5,
      time: start + 1000,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'You are a careful assistant. '.repeat(30) }] } },
    },
    {
      type: 'user/message',
      seq: 6,
      time: start + 1100,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'text', text: 'Explain the build pipeline.' }] }, source: { kind: 'user' } },
    },
    {
      type: 'user/message',
      seq: 7,
      time: start + 1100,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing step 1.' }] }, source: { kind: 'time-context' } },
    },
    {
      type: 'user/message',
      seq: 8,
      time: start + 1100,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'text', text: '- `office`: build documents.' }] }, source: { kind: 'skill-catalog' } },
    },
    {
      type: 'assistant/message',
      seq: 9,
      time: start + 3200,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a.md"}' }], source: { kind: 'model', provider: 'zhipu', model: 'glm-4.6' } },
        usage: { inputTokens: 1500, outputTokens: 240, cacheReadTokens: 400, cacheWriteTokens: 0 },
        stream: [{ type: 'chunk', time: start + 2000, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } }],
      },
    },
    {
      type: 'tool/result',
      seq: 10,
      time: start + 3300,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '# Build pipeline'.repeat(20) }] } },
    },
    { type: 'step/end', seq: 11, time: start + 3400, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 12, time: start + 3500, data: { turn: 1 } },
    { type: 'turn/start', seq: 13, time: start + 4000, data: { turn: 2 } },
    { type: 'step/start', seq: 14, time: start + 4000, data: { turn: 2, step: 1 } },
    { type: 'assistant/attempt', seq: 15, time: start + 6000, data: { turn: 2, step: 1, stream: [] } },
    // Still running: a live frame must appear.
    { type: 'turn/start', seq: 16, time: Date.now() - 2500, data: { turn: 3 } },
    { type: 'step/start', seq: 17, time: Date.now() - 2500, data: { turn: 3, step: 1 } },
  ]
  return [{ header: { id: 'conformance', cwd: '/work/gamma', createdAt: start }, events }]
}

function engine() {
  resetUsageCaches()
  const data = corpus()
  const sessionQuery = {
    async listSessions() {
      return data.map((entry) => ({ header: entry.header, live: false, persisted: true }))
    },
    async readSession(id) {
      const entry = data.find((candidate) => candidate.header.id === id)
      if (entry === undefined) throw new Error('not found')
      return { session: entry.header, inheritedEventCount: 0, events: entry.events.map((event) => ({ ...event })) }
    },
    async listEvents(id) {
      const entry = data.find((candidate) => candidate.header.id === id)
      if (entry === undefined) throw new Error('not found')
      return entry.events.map((event) => ({ seq: event.seq, type: event.type, time: event.time }))
    },
  }
  const settings = {
    usage: {
      enabled: true,
      source: 'auto',
      retainDays: 400,
      recentRequestPool: 20,
      geekMetrics: { showTtft: true, showSpeed: true, showTokens: true, pool: 20 },
      contextInsight: { showComposition: true, showTrend: true, showBrowser: true },
      balance: { deepseek: { enabled: false, apiKey: '', baseUrl: 'https://api.deepseek.com' }, providers: [], ttlSeconds: 120 },
      budgets: [
        { id: 'b1', label: 'Daily', enabled: true, scope: 'global', period: 'day', action: 'notify', limitTokens: 1000, limitCost: 0, threshold: 0.8, notifyOnce: true },
      ],
      priceOverrides: [],
      estimateUnknown: true,
    },
  }
  return createUsageEngine({
    ctx: { get: (name) => (name === 'sessionQuery' ? sessionQuery : undefined) },
    getSettings: () => settings,
    dshHome: 'C:/tmp/unused',
  })
}

let checks = 0
function verify(name, value, spec) {
  shape(name, value, spec.fields, { exact: spec.exact === true })
  checks += 1
}

async function main() {
  const usage = engine()

  console.log('GET /usage/summary')
  const summary = await usage.summary({ range: 'today' })
  assert.equal(typeof summary.range, 'string')
  assert.equal(typeof summary.from, 'number')
  assert.equal(typeof summary.to, 'number')
  assert.equal(typeof summary.updatedAt, 'number')
  verify('Totals', summary.totals, SPECS.Totals)
  for (const point of summary.series) verify('Point', point, SPECS.Point)
  for (const dim of ['provider', 'model', 'workspace', 'session']) {
    assert.ok(Array.isArray(summary.dims[dim]), `dims.${dim}`)
    for (const row of summary.dims[dim]) {
      verify('Row', row, SPECS.Row)
      for (const child of row.sub) verify('Row.sub', child, SPECS.SubRow)
    }
  }
  console.log(`  Dims: provider=${summary.dims.provider.length} model=${summary.dims.model.length} workspace=${summary.dims.workspace.length} session=${summary.dims.session.length}`)
  console.log(`  Totals: ${JSON.stringify(summary.totals)}`)

  console.log('GET /usage/sessions')
  const sessions = await usage.sessions({ range: 'today' })
  assert.ok(Array.isArray(sessions.sessions))
  for (const row of sessions.sessions) verify('SessionRow', row, SPECS.SessionRow)

  console.log('GET /usage/context')
  const context = await usage.context({ sessionId: 'conformance', mode: 'current' })
  assert.equal(typeof context.available, 'boolean')
  assert.equal(typeof context.sessionId, 'string')
  assert.equal(typeof context.provider, 'string')
  assert.equal(typeof context.model, 'string')
  assert.equal(typeof context.usedTokens, 'number')
  assert.equal(typeof context.windowTokens, 'number')
  assert.equal(typeof context.ratio, 'number')
  assert.ok(Array.isArray(context.buckets))
  assert.ok(Array.isArray(context.series))
  assert.ok(Array.isArray(context.browsers))
  assert.ok(Array.isArray(context.events))
  for (const bucket of context.buckets) {
    verify('Bucket', bucket, { fields: { key: 'string', label: 'string', tokens: 'number', ratio: 'number' } })
  }
  for (const event of context.events) verify('ContextEvent', event, SPECS.ContextEvent)
  const bucketSum = context.buckets.reduce((sum, bucket) => sum + bucket.tokens, 0)
  assert.equal(bucketSum, context.usedTokens, 'buckets must sum to usedTokens')
  console.log(`  used=${context.usedTokens} window=${context.windowTokens} buckets=${context.buckets.length} series=${context.series.length} browsers=${context.browsers.length}`)

  console.log('GET /usage/context/events')
  const page = await usage.contextEvents({ sessionId: 'conformance', offset: 0, limit: 5 })
  assert.equal(typeof page.total, 'number')
  assert.ok(Array.isArray(page.items))
  for (const item of page.items) verify('ContextEvent', item, SPECS.ContextEvent)

  console.log('GET /usage/balance')
  const balance = await usage.balance()
  verify('BalanceRow', balance.deepseek, SPECS.BalanceRow)
  assert.ok(Array.isArray(balance.providers))
  for (const row of balance.providers) verify('BalanceRow', row, SPECS.BalanceRow)
  assert.equal(typeof balance.at, 'number')

  console.log('GET /usage/budgets')
  const budgets = await usage.budgets()
  assert.ok(Array.isArray(budgets.budgets))
  assert.ok(Array.isArray(budgets.evaluation))
  assert.equal(typeof budgets.over, 'boolean')
  for (const row of budgets.evaluation) verify('BudgetStatus', row, SPECS.BudgetStatus)

  console.log('GET /usage/geek')
  const geek = await usage.geek({ sessionId: 'conformance', pool: 20 })
  assert.ok(Array.isArray(geek.requests))
  for (const row of geek.requests) verify('GeekRequest', row, SPECS.GeekRequest)
  assert.ok(geek.stream !== null, 'the in-flight request must yield a live frame')
  verify('GeekLive', geek.stream, SPECS.GeekLive)
  assert.equal(typeof geek.avg.requests, 'number')
  console.log(`  requests=${geek.requests.length} stream=${JSON.stringify(geek.stream)}`)

  console.log('GET /usage/prices')
  const prices = await usage.prices({ q: '' })
  assert.ok(Array.isArray(prices.rows))
  assert.equal(typeof prices.source, 'string')
  for (const row of prices.rows) verify('PriceRow', row, SPECS.PriceRow)
  console.log(`  rows=${prices.rows.length} source=${prices.source}`)

  console.log('POST /usage/reindex')
  const reindex = await usage.reindex({})
  assert.equal(typeof reindex.indexed, 'number')
  assert.equal(typeof reindex.at, 'number')

  console.log(`\n${checks} shapes conform to the contract.`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
