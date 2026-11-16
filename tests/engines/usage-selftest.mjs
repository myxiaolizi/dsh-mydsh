/**
 * Usage engine self-test.
 *
 * Runs against synthetic session events, so it needs neither a live Host nor a
 * real profile. Every case below is a claim the engine makes in production:
 * four-dimension aggregation, the context buckets summing to the reported
 * total, a failing balance endpoint degrading instead of throwing, the
 * warn/over budget transition, and the speed arithmetic the composer shows.
 *
 * Run with:
 *   node host/usage/selftest.mjs
 */

import assert from 'node:assert'

import { createUsageEngine, priceFor, resetUsageCaches } from '../../host/usage/engine.js'
import { configurePricing } from '../../host/usage/pricing.js'
import { foldEvents } from '../../host/usage/session-fold.js'
import { foldContext } from '../../host/usage/context.js'

let passed = 0
const failures = []

async function test(name, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`FAIL  ${name}\n      ${error?.message ?? error}`)
  }
}

/* ------------------------------------------------------------------ *
 * Synthetic sessions
 * ------------------------------------------------------------------ */

/** A fixed clock, so a bucket boundary cannot move under the assertions. */
const NOW = Date.now()
const MINUTE = 60000

/**
 * One session log with two turns, two metered requests, one failed attempt and
 * cache traffic on the second request.
 *
 * Totals this fixture is built to produce, so every assertion below is
 * checkable by hand:
 *   turn 1 / step 1 — 900 in, 100 out, no cache
 *   turn 1 / step 2 — 1200 in, 400 out, 600 cache read
 *   turn 2 / step 1 — a failed attempt, no usage
 *   totals          — 2100 in, 500 out, 600 cache read, 2600 total, 3 requests
 *
 * Timings are chosen so the geek arithmetic is checkable too:
 *   request 2 — step started at 0, first chunk 400 ms later, settled at 2400 ms,
 *               so TTFT = 400 ms, decode = 2000 ms, 400 output tokens → 200 tok/s.
 */
function sessionA(startAt) {
  return [
    {
      type: 'session',
      seq: 0,
      time: startAt,
      data: { id: 'session-a', cwd: '/work/alpha', createdAt: startAt },
    },
    { type: 'turn/start', seq: 1, time: startAt + 1000, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: startAt + 1000, data: { turn: 1, step: 1 } },
    {
      type: 'request/header',
      seq: 3,
      time: startAt + 1000,
      data: {
        header: {
          config: { provider: 'deepseek', model: 'deepseek-chat' },
          tools: [
            { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
            { name: 'grep', description: 'Search text', parameters: { type: 'object' } },
          ],
        },
      },
    },
    { type: 'request/context', seq: 4, time: startAt + 1000, data: { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 128000 } },
    {
      type: 'system/message',
      seq: 5,
      time: startAt + 1000,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'system', content: [{ type: 'text', text: 'You are a careful assistant. '.repeat(40) }] },
      },
    },
    {
      type: 'user/message',
      seq: 6,
      time: startAt + 1100,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'user', content: [{ type: 'text', text: 'Summarise the repository layout for me.' }] },
        source: { kind: 'user' },
      },
    },
    {
      type: 'user/message',
      seq: 7,
      time: startAt + 1100,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1.' }] },
        source: { kind: 'time-context', sections: [{ name: 'time-context', text: 'time' }] },
      },
    },
    {
      type: 'user/message',
      seq: 8,
      time: startAt + 1100,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'user', content: [{ type: 'text', text: '- `read`: Read a file. - `grep`: Search text.' }] },
        source: { kind: 'skill-catalog' },
      },
    },
    {
      type: 'assistant/message',
      seq: 9,
      time: startAt + 2000,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a.js"}' }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
        usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stream: [
          { type: 'chunk', time: startAt + 1500, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } },
          { type: 'chunk', time: startAt + 1900, chunk: { type: 'usage' } },
        ],
      },
    },
    {
      type: 'tool/result',
      seq: 10,
      time: startAt + 2100,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'module.exports = {}'.repeat(30) }],
        },
      },
    },
    { type: 'step/end', seq: 11, time: startAt + 2200, data: { turn: 1, step: 1 } },

    { type: 'step/start', seq: 12, time: startAt + 2400, data: { turn: 1, step: 2 } },
    {
      type: 'assistant/message',
      seq: 19,
      time: startAt + 4800,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 2,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The repository is a single plugin package.' }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
        usage: { inputTokens: 1200, outputTokens: 400, cacheReadTokens: 600, cacheWriteTokens: 0 },
        stream: [
          { type: 'chunk', time: startAt + 2800, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
          { type: 'chunk', time: startAt + 4700, chunk: { type: 'finish' } },
        ],
      },
    },
    { type: 'step/end', seq: 20, time: startAt + 4900, data: { turn: 1, step: 2 } },
    { type: 'turn/end', seq: 21, time: startAt + 5000, data: { turn: 1, reason: { kind: 'completed' } } },

    { type: 'turn/start', seq: 22, time: startAt + 6000, data: { turn: 2 } },
    { type: 'step/start', seq: 23, time: startAt + 6000, data: { turn: 2, step: 1 } },
    // A failed attempt: the request died, so there is no assistant/message.
    { type: 'assistant/attempt', seq: 24, time: startAt + 9000, data: { turn: 2, step: 1, stream: [] } },
    { type: 'turn/end', seq: 25, time: startAt + 9100, data: { turn: 2, reason: { kind: 'failed' } } },
  ]
}

/** A second session: another workspace, another provider, one request. */
function sessionB(startAt) {
  return [
    { type: 'session', seq: 0, time: startAt, data: { id: 'session-b', cwd: '/work/beta', createdAt: startAt } },
    { type: 'turn/start', seq: 1, time: startAt + 1000, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: startAt + 1000, data: { turn: 1, step: 1 } },
    {
      type: 'request/header',
      seq: 3,
      time: startAt + 1000,
      data: { header: { config: { provider: 'openai', model: 'gpt-4o' }, tools: [] } },
    },
    {
      type: 'assistant/message',
      seq: 4,
      time: startAt + 3000,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
          source: { kind: 'model', provider: 'openai', model: 'gpt-4o' },
        },
        usage: { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 0 },
        stream: [{ type: 'chunk', time: startAt + 1500, chunk: { type: 'block-start', index: 0, blockType: 'text' } }],
      },
    },
    { type: 'step/end', seq: 5, time: startAt + 3100, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: startAt + 3200, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** A fake `sessionQuery` service over a `{ id, header, events }` corpus. */
function fakeSessionQuery(corpus) {
  return {
    async listSessions() {
      return corpus.map((entry) => ({
        header: { ...entry.header, id: entry.header.id },
        live: false,
        persisted: true,
      }))
    },
    async readSession(sessionId) {
      const entry = corpus.find((candidate) => candidate.header.id === sessionId)
      if (entry === undefined) throw new Error(`session "${sessionId}" not found`)
      return {
        session: entry.header,
        inheritedEventCount: 0,
        events: entry.events.map((event) => ({ ...event })),
      }
    },
    async listEvents(sessionId) {
      const entry = corpus.find((candidate) => candidate.header.id === sessionId)
      if (entry === undefined) throw new Error(`session "${sessionId}" not found`)
      return entry.events.map((event) => ({ seq: event.seq, type: event.type, time: event.time }))
    },
  }
}

/** A settings document shaped like `normalize()`'s output. */
function fakeSettings(patch = {}) {
  return {
    ui: {},
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
      ...patch.usage,
    },
    ...patch,
  }
}

/** Build an engine over a synthetic corpus. */
function makeEngine(options = {}) {
  // The fold, context and balance caches are module-level on purpose, so a test
  // that reuses a session id must drop them or it would read a previous case's
  // fold. Production never rebuilds engines over the same id, so this reset is
  // the test's obligation, not the engine's.
  resetUsageCaches()
  configurePricing({ priceOverrides: [], estimateUnknown: true })
  const services = new Map()
  services.set('sessionQuery', fakeSessionQuery(options.corpus ?? []))
  const settings = options.settings ?? fakeSettings()
  return createUsageEngine({
    ctx: {
      get(name) {
        return services.get(name)
      },
    },
    getSettings: () => settings,
    dshHome: 'C:/tmp/unused',
  })
}

/* ------------------------------------------------------------------ *
 * Cases
 * ------------------------------------------------------------------ */

async function main() {
  console.log('pricing')

  await test('a built-in model resolves to its vendor currency', () => {
    configurePricing({ priceOverrides: [], estimateUnknown: true })
    const deepseek = priceFor('deepseek', 'deepseek-chat')
    assert.equal(deepseek.currency, 'CNY', 'a DeepSeek model must price in CNY')
    assert.ok(deepseek.input > 0)
    const openai = priceFor('openai', 'gpt-4o')
    assert.equal(openai.currency, 'USD')
  })

  await test('an unknown model falls back and says so', () => {
    configurePricing({ priceOverrides: [], estimateUnknown: true })
    const estimated = priceFor('some-relay', 'model-that-shipped-yesterday')
    assert.equal(estimated.source, 'estimated')
    assert.ok(estimated.input > 0, 'estimateUnknown means a real number, not zero')

    configurePricing({ priceOverrides: [], estimateUnknown: false })
    const unpriced = priceFor('some-relay', 'model-that-shipped-yesterday')
    assert.equal(unpriced.source, 'unpriced')
    assert.equal(unpriced.input, 0)
    configurePricing({ priceOverrides: [], estimateUnknown: true })
  })

  await test('an override wins over the built-in row', () => {
    configurePricing({
      estimateUnknown: true,
      priceOverrides: [{ id: 'p1', provider: 'deepseek', model: 'deepseek-chat', input: 2, output: 8, cacheRead: 0.5, cacheWrite: 1, currency: 'CNY' }],
    })
    const row = priceFor('deepseek', 'deepseek-chat')
    assert.equal(row.source, 'override')
    assert.equal(row.input, 2)
    assert.equal(row.currency, 'CNY')
    configurePricing({ priceOverrides: [], estimateUnknown: true })
  })

  console.log('fold')

  await test('a fold captures requests, attempts, turns and TTFT', () => {
    const fold = foldEvents(sessionA(NOW - 60 * MINUTE))
    assert.equal(fold.items.length, 2, 'two metered settlements')
    assert.equal(fold.attempts.length, 1, 'one failed attempt')
    assert.equal(fold.requests.length, 3, 'every request appears in the geek pool')
    assert.equal(fold.spans.size, 2, 'two closed turns')
    assert.equal(fold.pending, undefined, 'nothing is in flight in this log')

    const second = fold.requests.find((request) => request.turn === 1 && request.step === 2)
    assert.equal(second.ttftMs, 400, 'TTFT is step start → first chunk')
    assert.equal(second.durationMs, 2400, 'duration is step start → settlement')
  })

  await test('an unsettled step is reported as in flight', () => {
    const events = sessionA(NOW - 60 * MINUTE)
    // Drop the settlement of turn 2 so the log ends mid-request.
    const truncated = events.filter((event) => event.seq < 24)
    truncated.push({ type: 'step/start', seq: 24, time: Date.now() - 2000, data: { turn: 3, step: 1 } })
    const fold = foldEvents(truncated)
    assert.ok(fold.pending !== undefined, 'a start with no settlement is in flight')
    assert.equal(fold.pending.turn, 3)
  })

  console.log('summary')

  await test('summary aggregates four dimensions and their sub-rows', async () => {
    const engine = makeEngine({
      corpus: [
        { header: { id: 'session-a', cwd: '/work/alpha', createdAt: NOW - 70 * MINUTE }, events: sessionA(NOW - 60 * MINUTE) },
        { header: { id: 'session-b', cwd: '/work/beta', createdAt: NOW - 70 * MINUTE }, events: sessionB(NOW - 30 * MINUTE) },
      ],
    })
    const result = await engine.summary({ range: 'today' })

    assert.equal(result.totals.inputTokens, 900 + 1200 + 2000)
    assert.equal(result.totals.outputTokens, 100 + 400 + 200)
    assert.equal(result.totals.cacheReadTokens, 600)
    assert.equal(result.totals.totalTokens, 900 + 100 + 1200 + 400 + 2000 + 200)
    assert.equal(result.totals.requests, 4, 'two settlements + one attempt + session B')
    assert.equal(result.totals.failedRequests, 1)
    assert.equal(result.totals.turns, 3, 'two turns in A, one in B')

    for (const dim of ['provider', 'model', 'workspace', 'session']) {
      assert.ok(Array.isArray(result.dims[dim]), `${dim} rows must be an array`)
      assert.ok(result.dims[dim].length > 0, `${dim} rows must not be empty`)
      for (const row of result.dims[dim]) {
        assert.ok(Array.isArray(row.sub), `${dim} row.sub must always be an array`)
        assert.equal(typeof row.hitRate, 'number')
      }
    }
    // Provider totals must add up to the window totals: the four dimensions are
    // four views of one set of requests, not four different measurements.
    const providerTokens = result.dims.provider.reduce((sum, row) => sum + row.totalTokens, 0)
    assert.equal(providerTokens, result.totals.totalTokens)
    const providerRequests = result.dims.provider.reduce((sum, row) => sum + row.requests, 0)
    assert.equal(providerRequests, result.totals.requests)

    const deepseek = result.dims.provider.find((row) => row.key === 'deepseek')
    assert.ok(deepseek !== undefined, 'the deepseek provider row exists')
    assert.equal(deepseek.sub.length, 1, 'one model under deepseek')
    assert.equal(deepseek.sub[0].label, 'deepseek-chat')

    const workspaces = result.dims.workspace.map((row) => row.label).sort()
    assert.deepEqual(workspaces, ['alpha', 'beta'])

    assert.ok(result.totals.cost > 0, 'cost is computed')
    assert.ok(['CNY', 'USD'].includes(result.totals.currency))
    assert.equal(result.series.length, 24, 'today is 24 hourly points')
    assert.equal(
      result.series.reduce((sum, point) => sum + point.requests, 0),
      4,
      'series requests add up to the window total',
    )
    assert.equal(result.dim, 'provider')
  })

  await test('summary survives a corpus that cannot be read', async () => {
    const broken = {
      async listSessions() {
        throw new Error('persistence is offline')
      },
      async readSession() {
        throw new Error('nope')
      },
      async listEvents() {
        throw new Error('nope')
      },
    }
    const engine = createUsageEngine({
      ctx: { get: (name) => (name === 'sessionQuery' ? broken : undefined) },
      getSettings: () => fakeSettings(),
      dshHome: 'C:/tmp/unused',
    })
    const result = await engine.summary({ range: '7d' })
    assert.equal(result.totals.totalTokens, 0)
    assert.equal(result.totals.cost, 0)
    assert.equal(result.dims.provider.length, 0)
    assert.ok(result.series.length > 0, 'the chart still gets its buckets')
  })

  console.log('sessions')

  await test('the session list is newest-first with hit rate and provider', async () => {
    const engine = makeEngine({
      corpus: [
        { header: { id: 'session-a', cwd: '/work/alpha', createdAt: NOW - 70 * MINUTE }, events: sessionA(NOW - 60 * MINUTE) },
        { header: { id: 'session-b', cwd: '/work/beta', createdAt: NOW - 70 * MINUTE }, events: sessionB(NOW - 30 * MINUTE) },
      ],
    })
    const { sessions } = await engine.sessions({ range: 'today' })
    assert.equal(sessions.length, 2)
    assert.equal(sessions[0].id, 'session-b', 'the more recent session comes first')
    const alpha = sessions.find((row) => row.id === 'session-a')
    assert.equal(alpha.provider, 'deepseek')
    assert.equal(alpha.model, 'deepseek-chat')
    assert.equal(alpha.failedRequests, 1)
    assert.equal(alpha.requests, 3, 'two settlements plus the failed attempt')
    assert.equal(alpha.totalTokens, 2600)
    assert.ok(alpha.hitRate > 0, 'the cache read must show up as a hit rate')
    assert.equal(alpha.hitRate, 600 / (600 + 2100), 'cache reads over all prompt tokens')
    assert.equal(alpha.turns, 2, 'the failed turn still counts as a turn')
    assert.equal(typeof alpha.firstAt, 'number')
    assert.equal(typeof alpha.lastAt, 'number')
  })

  console.log('context')

  await test('context buckets sum to the reported total and cover seven classes', async () => {
    const engine = makeEngine({
      corpus: [{ header: { id: 'session-a', cwd: '/work/alpha', createdAt: NOW - 70 * MINUTE }, events: sessionA(NOW - 60 * MINUTE) }],
    })
    const payload = await engine.context({ sessionId: 'session-a' })
    assert.equal(payload.available, true)
    assert.equal(payload.buckets.length, 7, 'exactly the seven contract buckets')
    const keys = payload.buckets.map((bucket) => bucket.key)
    assert.deepEqual(keys, [
      'systemPrompt',
      'toolDefinitions',
      'userMessages',
      'injected',
      'skills',
      'assistantMessages',
      'toolResults',
    ])
    const sum = payload.buckets.reduce((total, bucket) => total + bucket.tokens, 0)
    assert.equal(sum, payload.usedTokens, 'the parts must add up to the whole')
    for (const bucket of payload.buckets) {
      assert.equal(typeof bucket.label, 'string')
      assert.equal(typeof bucket.ratio, 'number')
    }

    // The three user messages must land in three different buckets, otherwise
    // the injection/skill split is decoration rather than information.
    const byKey = Object.fromEntries(payload.buckets.map((bucket) => [bucket.key, bucket.tokens]))
    assert.ok(byKey.systemPrompt > 0, 'the system prompt is its own bucket')
    assert.ok(byKey.toolDefinitions > 0, 'the tool schemas are priced')
    assert.ok(byKey.userMessages > 0, 'the real user message is its own bucket')
    assert.ok(byKey.injected > 0, 'the time context is injected, not user text')
    assert.ok(byKey.skills > 0, 'the skill catalogue is its own bucket')
    assert.ok(byKey.assistantMessages > 0)
    assert.ok(byKey.toolResults > 0)

    assert.equal(payload.windowTokens, 128000, 'the log reported the window')
    assert.ok(payload.ratio > 0 && payload.ratio <= 1)
    assert.ok(payload.series.length >= 1, 'the trend has points')
    const last = payload.series[payload.series.length - 1]
    assert.equal(
      Object.values(last.buckets).reduce((total, value) => total + value, 0),
      last.usedTokens,
      'every series point is internally consistent too',
    )
    assert.ok(payload.browsers.length > 0, 'the browser has categories')
    for (const row of payload.browsers) {
      assert.equal(typeof row.category, 'string')
      assert.equal(typeof row.tokens, 'number')
      assert.equal(typeof row.count, 'number')
      assert.equal(typeof row.preview, 'string')
      assert.ok(Array.isArray(row.items))
    }
    assert.ok(payload.events.length > 0)
    for (const event of payload.events) {
      assert.equal(typeof event.at, 'number')
      assert.equal(typeof event.seq, 'number')
      assert.equal(typeof event.category, 'string')
      assert.equal(typeof event.description, 'string')
      assert.equal(typeof event.tokens, 'number')
      assert.equal(typeof event.delta, 'number')
      assert.equal(typeof event.turn, 'number')
    }
  })

  await test('mode=next estimates, mode=current reports the provider figure', async () => {
    const engine = makeEngine({
      corpus: [{ header: { id: 'session-a', cwd: '/work/alpha', createdAt: NOW - 70 * MINUTE }, events: sessionA(NOW - 60 * MINUTE) }],
    })
    const current = await engine.context({ sessionId: 'session-a', mode: 'current' })
    const next = await engine.context({ sessionId: 'session-a', mode: 'next' })
    assert.equal(current.mode, 'current')
    assert.equal(next.mode, 'next')
    assert.equal(current.reportedTokens, 1200 + 600, 'the last prompt size the provider reported')
    assert.equal(current.usedTokens, current.reportedTokens)
    assert.equal(next.usedTokens, next.estimateTokens, '"next" is our own estimate')
    assert.notEqual(current.usedTokens, next.usedTokens)
  })

  await test('context events page newest-first and filter by category', async () => {
    const engine = makeEngine({
      corpus: [{ header: { id: 'session-a', cwd: '/work/alpha', createdAt: NOW - 70 * MINUTE }, events: sessionA(NOW - 60 * MINUTE) }],
    })
    const page = await engine.contextEvents({ sessionId: 'session-a', limit: 3 })
    assert.equal(page.items.length, 3)
    assert.ok(page.total >= 3)
    assert.ok(page.items[0].seq > page.items[1].seq, 'newest first')

    const skills = await engine.contextEvents({ sessionId: 'session-a', category: 'skills', limit: 10 })
    assert.ok(skills.total >= 1)
    for (const event of skills.items) assert.equal(event.category, 'skills')

    const empty = await engine.contextEvents({ sessionId: '', limit: 3 })
    assert.deepEqual(empty, { total: 0, items: [] })
  })

  await test('an unknown session degrades to unavailable', async () => {
    const engine = makeEngine({ corpus: [] })
    const payload = await engine.context({ sessionId: 'not-a-session' })
    assert.equal(payload.available, false)
    assert.equal(payload.usedTokens, 0)
    assert.deepEqual(payload.buckets, [])
  })

  await test('a surface replacement shadows the range it replaces', () => {
    const events = [
      {
        type: 'system/message',
        seq: 0,
        time: 1000,
        surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'S'.repeat(400) }] } },
      },
      {
        type: 'user/message',
        seq: 1,
        time: 1100,
        surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'text', text: 'U'.repeat(400) }] }, source: { kind: 'user' } },
      },
      {
        type: 'user/message',
        seq: 2,
        time: 1200,
        surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
        data: { turn: 1, step: 2, message: { role: 'user', content: [{ type: 'text', text: 'summary' }] }, source: { kind: 'user' } },
      },
    ]
    const model = foldContext(events)
    assert.equal(model.nodesTotal, 2, 'the replaced message is gone, the replacement remains')
    assert.equal(model.bucketsRaw.userMessages > 0, true)
    assert.equal(model.bucketsRaw.userMessages, estimateOf('summary'))
  })

  console.log('balance')

  await test('balance degrades when nothing is configured', async () => {
    const engine = makeEngine()
    const result = await engine.balance()
    assert.equal(result.deepseek.ok, false)
    assert.equal(result.deepseek.message, 'disabled')
    assert.equal(result.deepseek.total, 0)
    assert.equal(typeof result.deepseek.at, 'number')
    assert.deepEqual(result.providers, [])
    assert.equal(typeof result.at, 'number')
  })

  await test('a failing endpoint yields ok:false and never throws', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.example.com')
    }
    try {
      const engine = makeEngine({
        settings: fakeSettings({
          usage: {
            balance: {
              deepseek: { enabled: true, apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' },
              providers: [
                {
                  id: 'custom',
                  enabled: true,
                  label: 'Other',
                  provider: 'other',
                  url: 'https://api.example.com/balance',
                  method: 'GET',
                  headers: '',
                  body: '',
                  totalPath: 'data.total',
                  currencyPath: 'data.currency',
                  currency: 'CNY',
                },
              ],
              ttlSeconds: 60,
            },
          },
        }),
      })
      const result = await engine.balance({ force: true })
      assert.equal(result.deepseek.ok, false)
      assert.match(result.deepseek.message, /ENOTFOUND/)
      assert.equal(result.providers.length, 1)
      assert.equal(result.providers[0].ok, false)
      assert.match(result.providers[0].message, /ENOTFOUND/)
      assert.equal(result.providers[0].total, 0)
      assert.ok(result.providers[0].expiresAt > 0, 'even a failure carries its retry bound')
    } finally {
      globalThis.fetch = original
    }
  })

  await test('a healthy endpoint reads its dotted paths and caches', async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: { total: '12.5', currency: 'USD' } }
        },
      }
    }
    try {
      const engine = makeEngine({
        settings: fakeSettings({
          usage: {
            balance: {
              deepseek: { enabled: false, apiKey: '', baseUrl: 'https://api.deepseek.com' },
              providers: [
                {
                  id: 'custom',
                  enabled: true,
                  label: 'Other',
                  provider: 'other',
                  url: 'https://api.example.com/balance',
                  method: 'GET',
                  headers: '{"x-api-key":"k"}',
                  body: '',
                  totalPath: 'data.total',
                  currencyPath: 'data.currency',
                  currency: 'CNY',
                },
              ],
              ttlSeconds: 60,
            },
          },
        }),
      })
      const first = await engine.balance({ force: true })
      assert.equal(first.providers[0].ok, true)
      assert.equal(first.providers[0].total, 12.5)
      assert.equal(first.providers[0].currency, 'USD', 'the path wins over the configured default')
      const after = calls
      await engine.balance()
      await engine.balance()
      assert.equal(calls, after, 'the TTL cache answers the next two calls')
    } finally {
      globalThis.fetch = original
    }
  })

  console.log('budgets')

  await test('budgets cross warn and over at the configured threshold', async () => {
    const corpus = [
      { header: { id: 'session-a', cwd: '/work/alpha', createdAt: NOW - 70 * MINUTE }, events: sessionA(NOW - 60 * MINUTE) },
    ]
    // Session A is 2100 input + 500 output = 2600 tokens today.
    const engine = makeEngine({
      corpus,
      settings: fakeSettings({
        usage: {
          budgets: [
            { id: 'b-over', label: 'Hard cap', enabled: true, scope: 'global', period: 'day', action: 'pause', limitTokens: 2000, limitCost: 0, threshold: 0.8, notifyOnce: true },
            { id: 'b-warn', label: 'Soft cap', enabled: true, scope: 'global', period: 'day', action: 'notify', limitTokens: 5000, limitCost: 0, threshold: 0.5, notifyOnce: true },
            { id: 'b-ok', label: 'Room', enabled: true, scope: 'global', period: 'day', action: 'notify', limitTokens: 100000, limitCost: 0, threshold: 0.9, notifyOnce: true },
            { id: 'b-off', label: 'Disabled', enabled: false, scope: 'global', period: 'day', action: 'pause', limitTokens: 1, limitCost: 0, threshold: 0.9, notifyOnce: true },
            { id: 'b-empty', label: 'No cap', enabled: true, scope: 'global', period: 'day', action: 'notify', limitTokens: 0, limitCost: 0, threshold: 0.9, notifyOnce: true },
          ],
        },
      }),
    })

    const result = await engine.budgets()
    assert.equal(result.evaluation.length, 3, 'disabled and cappable budgets are dropped')
    const byId = Object.fromEntries(result.evaluation.map((row) => [row.id, row]))

    assert.equal(byId['b-over'].state, 'over')
    assert.equal(byId['b-over'].usedTokens, 2600)
    assert.equal(byId['b-over'].ratio, 1.3)
    assert.equal(byId['b-warn'].state, 'warn', '52% is past a 50% threshold but under the cap')
    assert.equal(byId['b-ok'].state, 'ok')
    assert.equal(result.over, true)

    for (const row of result.evaluation) {
      assert.equal(typeof row.windowFrom, 'number')
      assert.equal(typeof row.windowTo, 'number')
      assert.ok(['ok', 'warn', 'over'].includes(row.state))
      assert.ok(['day', 'week', 'month'].includes(row.period))
      assert.ok(['notify', 'pause'].includes(row.action))
    }

    const gate = await engine.overBudgetContext()
    assert.equal(gate.pause, true, 'one over budget asks for a pause')
    assert.equal(gate.over.length, 1)
    assert.equal(await engine.isPaused(), true)
  })

  await test('a notify-only budget never pauses the agent', async () => {
    const engine = makeEngine({
      corpus: [{ header: { id: 'session-a', cwd: '/work/alpha', createdAt: NOW - 70 * MINUTE }, events: sessionA(NOW - 60 * MINUTE) }],
      settings: fakeSettings({
        usage: {
          budgets: [
            { id: 'b1', label: 'Notify only', enabled: true, scope: 'global', period: 'day', action: 'notify', limitTokens: 10, limitCost: 0, threshold: 0.9, notifyOnce: true },
          ],
        },
      }),
    })
    const result = await engine.budgets()
    assert.equal(result.evaluation[0].state, 'over')
    assert.equal(await engine.isPaused(), false, 'notify means tell me, not block me')
    assert.equal((await engine.overBudgetContext()).pause, false)
  })

  await test('a workspace budget only counts its own workspace', async () => {
    const engine = makeEngine({
      corpus: [
        { header: { id: 'session-a', cwd: '/work/alpha', createdAt: NOW - 70 * MINUTE }, events: sessionA(NOW - 60 * MINUTE) },
        { header: { id: 'session-b', cwd: '/work/beta', createdAt: NOW - 70 * MINUTE }, events: sessionB(NOW - 30 * MINUTE) },
      ],
      settings: fakeSettings({
        usage: {
          budgets: [
            { id: 'wa', label: 'alpha', enabled: true, scope: 'workspace', period: 'day', action: 'notify', workspace: '/work/alpha', limitTokens: 1, limitCost: 0, threshold: 0.9 },
          ],
        },
      }),
    })
    const result = await engine.budgets()
    assert.equal(result.evaluation[0].usedTokens, 2600, 'only session A is in /work/alpha')
  })

  await test('isPaused only blocks the scope it covers', async () => {
    const engine = makeEngine({
      corpus: [{ header: { id: 'session-a', cwd: '/work/alpha', createdAt: NOW - 70 * MINUTE }, events: sessionA(NOW - 60 * MINUTE) }],
      settings: fakeSettings({
        usage: {
          budgets: [
            { id: 'p1', label: 'DeepSeek cap', enabled: true, scope: 'provider', period: 'day', action: 'pause', provider: 'deepseek', limitTokens: 10, limitCost: 0, threshold: 0.9 },
          ],
        },
      }),
    })
    assert.equal(await engine.isPaused({ provider: 'deepseek', model: 'deepseek-chat' }), true)
    assert.equal(await engine.isPaused({ provider: 'openai', model: 'gpt-4o' }), false)
  })

  console.log('geek')

  await test('geek speed is decoder throughput, not wall throughput', async () => {
    const engine = makeEngine({
      corpus: [{ header: { id: 'session-a', cwd: '/work/alpha', createdAt: NOW - 70 * MINUTE }, events: sessionA(NOW - 60 * MINUTE) }],
    })
    const result = await engine.geek({ sessionId: 'session-a', pool: 20 })
    assert.equal(result.requests.length, 3, 'two settlements plus the failed attempt')
    assert.equal(result.stream, null, 'nothing is in flight in this log')

    // turn 1 step 2: 400 output tokens, 2400 ms total, 400 ms TTFT.
    const second = result.requests.find((row) => row.turn === 1 && row.step === 2)
    assert.equal(second.ttftMs, 400)
    assert.equal(second.durationMs, 2400)
    assert.equal(second.outputTokens, 400)
    assert.equal(second.speed, 200, '400 tokens over 2000 ms of decode is 200 tok/s')
    assert.equal(second.status, 'ok')
    assert.equal(second.sessionId, 'session-a')
    assert.ok(second.cost > 0)
    assert.equal(typeof second.provider, 'string')
    assert.equal(typeof second.model, 'string')

    const failed = result.requests.find((row) => row.status === 'failed')
    assert.ok(failed !== undefined, 'the failed attempt is listed')
    assert.equal(failed.source, 'attempt')
    assert.equal(failed.outputTokens, 0)

    assert.equal(result.avg.requests, 3)
    assert.ok(result.avg.ttftMs > 0)
    assert.ok(result.avg.speed > 0)

    for (const field of [
      'at',
      'sessionId',
      'source',
      'status',
      'model',
      'provider',
      'ttftMs',
      'durationMs',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'speed',
      'cost',
    ]) {
      assert.ok(second[field] !== undefined, `GeekRequest.${field} must be present`)
    }
  })

  await test('geek reports a live frame while a request is in flight', async () => {
    const events = sessionA(NOW - 60 * MINUTE)
    events.push({ type: 'turn/start', seq: 26, time: Date.now() - 3000, data: { turn: 3 } })
    events.push({ type: 'step/start', seq: 27, time: Date.now() - 3000, data: { turn: 3, step: 1 } })
    const engine = makeEngine({
      corpus: [{ header: { id: 'session-a', cwd: '/work/alpha', createdAt: NOW - 70 * MINUTE }, events }],
    })
    const result = await engine.geek({ sessionId: 'session-a' })
    assert.ok(result.stream !== null, 'the in-flight request must produce a frame')
    assert.ok(result.stream.streamMs >= 2000, 'the frame counts from the step start')
    assert.equal(result.stream.turn, 3)
    assert.equal(result.stream.speed, 0, 'nothing has been counted yet')
    assert.ok(result.stream.inputTokens > 0, 'the previous prompt is the best available proxy')
  })

  await test('an empty pool degrades to zeroes rather than NaN', async () => {
    const engine = makeEngine({ corpus: [] })
    const result = await engine.geek({})
    assert.deepEqual(result.requests, [])
    assert.equal(result.stream, null)
    assert.equal(result.avg.ttftMs, 0)
    assert.equal(result.avg.speed, 0)
    assert.ok(Number.isFinite(result.avg.durationMs))
  })

  console.log('prices and reindex')

  await test('the price list merges overrides and answers a query', async () => {
    const engine = makeEngine()
    const all = await engine.prices({})
    assert.ok(all.rows.length > 0)
    const deepseekRow = all.rows.find((row) => row.provider === 'deepseek' && row.model === 'deepseek-chat')
    assert.ok(deepseekRow !== undefined)
    assert.equal(deepseekRow.currency, 'CNY')
    assert.equal(deepseekRow.source, 'builtin')

    const filtered = await engine.prices({ q: 'gpt' })
    assert.ok(filtered.rows.length < all.rows.length, 'the query narrows the list')

    await engine.setPriceOverrides([
      { id: 'x', provider: 'deepseek', model: 'deepseek-chat', input: 3, output: 9, cacheRead: 1, cacheWrite: 3, currency: 'CNY' },
    ])
    const after = await engine.prices({ q: 'deepseek-chat' })
    assert.equal(after.source, 'overrides')
    assert.equal(after.rows[0].source, 'override')
    assert.equal(after.rows[0].input, 3)
    await engine.setPriceOverrides([])
  })

  await test('reindex rebuilds every cache and counts readable sessions', async () => {
    const engine = makeEngine({
      corpus: [
        { header: { id: 'session-a', cwd: '/work/alpha', createdAt: NOW - 70 * MINUTE }, events: sessionA(NOW - 60 * MINUTE) },
        { header: { id: 'session-b', cwd: '/work/beta', createdAt: NOW - 70 * MINUTE }, events: sessionB(NOW - 30 * MINUTE) },
      ],
    })
    await engine.summary({ range: 'today' })
    const result = await engine.reindex({})
    assert.equal(result.indexed, 2)
    assert.equal(typeof result.at, 'number')
  })

  await test('the feature switch empties every surface', async () => {
    const engine = makeEngine({
      corpus: [{ header: { id: 'session-a', cwd: '/work/alpha', createdAt: NOW - 70 * MINUTE }, events: sessionA(NOW - 60 * MINUTE) }],
      settings: fakeSettings({ usage: { enabled: false } }),
    })
    assert.equal((await engine.summary({ range: 'today' })).totals.totalTokens, 0)
    assert.deepEqual((await engine.sessions({ range: 'today' })).sessions, [])
    assert.equal((await engine.context({ sessionId: 'session-a' })).available, false)
    assert.equal((await engine.geek({ sessionId: 'session-a' })).stream, null)
    assert.equal(await engine.isPaused(), false)
  })

  await test('nothing throws when every service is missing', async () => {
    const engine = createUsageEngine({
      ctx: { get: () => undefined },
      getSettings: () => fakeSettings(),
      dshHome: 'C:/tmp/unused',
    })
    const summary = await engine.summary({ range: 'today' })
    assert.equal(summary.totals.totalTokens, 0)
    assert.deepEqual((await engine.sessions({})).sessions, [])
    assert.equal((await engine.context({ sessionId: 'x' })).available, false)
    assert.deepEqual(await engine.contextEvents({ sessionId: 'x' }), { total: 0, items: [] })
    assert.equal((await engine.geek({})).stream, null)
    assert.deepEqual((await engine.budgets()).evaluation, [])
    assert.equal(await engine.isPaused(), false)
    assert.equal((await engine.balance()).deepseek.ok, false)
    assert.ok((await engine.prices({})).rows.length > 0, 'the price list needs no service at all')
  })

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) process.exitCode = 1
}

/** Local copy of the text-density estimate, so the assertion is independent. */
function estimateOf(text) {
  // ceil(chars / 4) for the text, plus the per-block framing and the role framing.
  return Math.ceil(text.length / 4) + 4 + 4
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
