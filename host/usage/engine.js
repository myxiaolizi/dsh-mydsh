/**
 * Usage engine — V2.
 *
 * Turns DSH session logs into every number the usage surface shows: windowed
 * totals in four dimensions, per-session rows, context composition, the geek
 * request pool, balance, budgets and the price list.
 *
 * Design in one paragraph. Nothing here subscribes to anything; every method is
 * a pull. The only expensive call is reading a session log, so `session-fold.js`
 * reduces each log once to plain numbers and caches that fold by a cheap
 * freshness key. Aggregation above it is arithmetic over cached arrays. Every
 * DSH service is looked up on demand and may be absent: absence degrades a
 * field, never throws out of a route. Every arithmetic path ends in a finite
 * number, because a chart that renders `NaN` is worse than a chart that renders
 * zero.
 *
 * Files in this directory:
 *   engine.js        — this file: aggregation, budgets, dispatch, pause gate
 *   support.js       — numbers, windows, series, LRU, token estimate, money
 *   pricing.js       — price table, overrides, dual currency, price rows
 *   session-fold.js  — log folding and its caches
 *   context.js       — seven-bucket context model, trend, browser
 *   geek.js          — per-request TTFT/speed/token pool and the live frame
 *   balance.js       — the only network access, opt-in and TTL cached
 */

import {
  CACHE_LIMIT,
  MAX_SERIES_POINTS,
  SEP,
  UNKNOWN,
  addMoney,
  buildSeries,
  countOf,
  convertMoney,
  describe,
  forEachBatch,
  hitRateOf,
  lruGet,
  lruSet,
  moneyResult,
  newMoney,
  periodWindow,
  resolveWindow,
  round6,
  sessionRowLabel,
  warnOnce,
  workspaceKey,
} from './support.js'
import { configurePricing, costOf, pinOverrides, priceFor, priceRows, PRICE_TABLE } from './pricing.js'
import { clearFoldCache, freshnessKey, liveFrame, loadFold, readLog } from './session-fold.js'
import { contextEventPage, contextPayload, foldContext, staticContextWindow } from './context.js'
import { geekPayload, mergeGeek } from './geek.js'
import { balancePayload, clearBalanceCache } from './balance.js'

export { priceFor, PRICE_TABLE }

/** Sessions read per event-loop batch. Re-declared so the value lives with its use. */
const READ_BATCH = 4

/** Sessions a budget period scan may read; beyond this the older ones are skipped. */
const SCAN_LIMIT = 2000

/**
 * Context model cache: one folded model per session, judged fresh by the same
 * cheap key the fold cache uses.
 * @type {Map<string, { key?: string, model: object, validatedAt: number }>}
 */
const CONTEXT_CACHE = new Map()

/**
 * Create the usage engine.
 * @param ctx - Cordis plugin context; supplies `sessionQuery`, `llm`, `sessions`
 *   and `tokenMeter` through `ctx.get()`, all optional.
 * @param getSettings - returns the live settings document. Read on every call,
 *   never captured, so a settings change applies without rebuilding the engine.
 * @param dshHome - part of the shared engine signature. This engine reads all of
 *   its data through DSH services and owns no files, so it is not used here.
 * @returns the engine methods bound to this plugin lifetime.
 */
export function createUsageEngine({ ctx, getSettings, dshHome }) {
  /**
   * Look up one DSH service. An absent service and a throwing getter both yield
   * `undefined` so callers can stay branch-free about degradation.
   */
  function service(name) {
    try {
      const value = ctx.get(name)
      return value === undefined || value === null ? undefined : value
    } catch {
      return undefined
    }
  }

  /** The whole settings document, never throwing. */
  function settingsDocument() {
    try {
      const document = typeof getSettings === 'function' ? getSettings() : undefined
      return document !== null && typeof document === 'object' ? document : {}
    } catch {
      return {}
    }
  }

  /** The `usage` slice of the settings document, never throwing. */
  function usageSettings() {
    const usage = settingsDocument().usage
    return usage !== null && typeof usage === 'object' ? usage : {}
  }

  /** True when the usage feature is switched on. */
  function enabled() {
    return usageSettings().enabled !== false
  }

  /** Refresh the effective price table from settings before any cost is computed. */
  function refreshPricing() {
    configurePricing(usageSettings())
  }

  /** Days of history the user wants to keep, 0 when unbounded. */
  function retainDays() {
    return Math.round(countOf(usageSettings().retainDays))
  }

  /* ---------------------------------------------------------------- *
   * Session scan
   * ---------------------------------------------------------------- */

  /**
   * Read every session once and reduce it to the part of its fold that lands in
   * `[fromMs, toMs)`.
   *
   * The slice keeps only fold items and turn spans inside the window, so the
   * aggregation above is pure arithmetic over cached arrays. A turn that
   * straddles a boundary is clipped rather than dropped: a 23:58 turn finishing
   * at 00:01 did happen, and reporting zero wall time for it would make "today"
   * undercount every night.
   * @param fromMs - inclusive window start (epoch ms).
   * @param toMs - exclusive window end (epoch ms).
   * @param options - `force` bypasses the fold cache.
   * @returns `{ scans, read }`; `read` counts sessions that produced a fold.
   */
  async function scanWindow(fromMs, toMs, options = {}) {
    const sessionQuery = service('sessionQuery')
    if (sessionQuery === undefined || typeof sessionQuery.listSessions !== 'function') {
      warnOnce('no-session-query', 'ctx.sessionQuery is unavailable; usage will read as empty.')
      return { scans: [], read: 0 }
    }

    let records
    try {
      records = await sessionQuery.listSessions()
    } catch (error) {
      warnOnce('list-sessions', `listSessions() failed: ${describe(error)}`)
      return { scans: [], read: 0 }
    }
    if (!Array.isArray(records)) return { scans: [], read: 0 }

    const scans = []
    let read = 0
    const budget = records.slice(0, SCAN_LIMIT)
    await forEachBatch(budget, READ_BATCH, async (record) => {
      const header = record?.header
      const sessionId = typeof header?.id === 'string' ? header.id : ''
      if (sessionId === '') return
      const fold = await loadFold(sessionQuery, sessionId, options)
      if (fold === undefined) return
      read += 1

      const items = []
      for (const item of fold.items) {
        if (item.t >= fromMs && item.t < toMs) items.push(item)
      }
      const spans = []
      for (const span of fold.spans.values()) {
        if (span.end === undefined) continue
        if (span.start >= toMs || span.end <= fromMs) continue
        spans.push({
          turn: span.turn,
          from: Math.max(span.start, fromMs),
          to: Math.min(span.end, toMs),
        })
      }
      const failures = []
      for (const attempt of fold.attempts) {
        if (attempt.t < fromMs || attempt.t >= toMs) continue
        failures.push(attempt)
      }
      if (items.length === 0 && spans.length === 0 && failures.length === 0) return

      scans.push({
        sessionId,
        header,
        workspace: workspaceKey(header),
        label: sessionRowLabel(header, sessionId),
        items,
        spans,
        failures,
        fold,
      })
    })
    return { scans, read }
  }

  /* ---------------------------------------------------------------- *
   * Summary
   * ---------------------------------------------------------------- */

  /**
   * Windowed totals, a bucketed series, four dimensions and the model list.
   *
   * All four dimensions are always computed: the page lets the user switch
   * between them without a second round trip, and a scan that produced one of
   * them already paid for the rest.
   *
   * Deliberately not memoised. A previous attempt cached the built report for a
   * second to collapse three concurrent pollers into one build; measured, it cost
   * 500 KB of retained heap per call against 5 KB without it, because the report
   * itself is large and the fold cache underneath already makes a rebuild cheap.
   * The memo was removed rather than tuned.
   *
   * @param options - `{ range, from, to, dim }`.
   * @returns the summary payload.
   */
  async function summary(options = {}) {
    refreshPricing()
    const window = resolveWindow(options, retainDays())
    if (!enabled()) return emptySummary(window)

    const { scans } = await scanWindow(window.fromMs, window.toMs)
    const series = buildSeries(window)
    // Cost is accumulated per currency per bucket, then converted once at render
    // time: converting on every request would compound rounding 400 times.
    const bucketMoney = series.points.map(() => newMoney())
    const totals = zeroTotals()
    const totalsMoney = newMoney()
    const allTurns = new Set()
    const models = new Map()
    const dims = {
      provider: new Map(),
      model: new Map(),
      workspace: new Map(),
      session: new Map(),
    }
    let hint = ''

    for (const scan of scans) {
      const workspace = scan.workspace
      /** First provider/model credited for each turn; wall time follows it. */
      const owners = new Map()

      for (const item of scan.items) {
        const price = priceFor(item.provider, item.model)
        const cost = costOf(price, item)
        if (hint === '') hint = cost.currency
        const turnKey = item.turn >= 0 ? `t${item.turn}` : `u${item.t}`
        const uniqueTurn = `${scan.sessionId}${SEP}${turnKey}`

        totals.inputTokens += item.input
        totals.outputTokens += item.output
        totals.totalTokens += item.input + item.output
        totals.cacheReadTokens += item.cacheRead
        totals.cacheWriteTokens += item.cacheWrite
        totals.requests += 1
        if (item.interrupted === true) totals.failedRequests += 1
        addMoney(totalsMoney, cost.amount, cost.currency)
        allTurns.add(uniqueTurn)
        models.set(`${item.provider}${SEP}${item.model}`, { provider: item.provider, model: item.model })
        if (!owners.has(turnKey)) owners.set(turnKey, { provider: item.provider, model: item.model })

        creditDim(dims.provider, item.provider, item.provider, item, cost, {
          subKey: `${item.provider}${SEP}${item.model}`,
          subLabel: item.model,
        })
        creditDim(dims.model, `${item.provider}${SEP}${item.model}`, item.model, item, cost, {
          subKey: item.provider,
          subLabel: item.provider,
        })
        creditDim(dims.workspace, workspace.key, workspace.label, item, cost, {
          subKey: scan.sessionId,
          subLabel: scan.label,
        })
        creditDim(dims.session, scan.sessionId, scan.label, item, cost, {
          subKey: `${item.provider}${SEP}${item.model}`,
          subLabel: item.model,
        })

        const index = series.index(item.t)
        if (index < 0) continue
        const point = series.points[index]
        point.inputTokens += item.input
        point.outputTokens += item.output
        point.cacheReadTokens += item.cacheRead
        point.totalTokens += item.input + item.output
        point.requests += 1
        addMoney(bucketMoney[index], cost.amount, cost.currency)
      }

      // A failed attempt spent provider time and, on most providers, prompt
      // tokens too. It is counted as a request that produced no output so the
      // failure rate is visible and the request count matches what the provider
      // will bill for.
      for (const attempt of scan.failures) {
        totals.failedRequests += 1
        totals.requests += 1
        const turnKey = attempt.turn >= 0 ? `t${attempt.turn}` : `u${attempt.t}`
        allTurns.add(`${scan.sessionId}${SEP}${turnKey}`)
        creditDim(
          dims.provider,
          attempt.provider,
          attempt.provider,
          zeroItem(attempt),
          { amount: 0, currency: 'USD' },
          { subKey: `${attempt.provider}${SEP}${attempt.model}`, subLabel: attempt.model },
        )
        creditDim(
          dims.session,
          scan.sessionId,
          scan.label,
          zeroItem(attempt),
          { amount: 0, currency: 'USD' },
          { subKey: `${attempt.provider}${SEP}${attempt.model}`, subLabel: attempt.model },
        )
        const index = series.index(attempt.t)
        if (index >= 0) series.points[index].requests += 1
      }

      for (const span of scan.spans) {
        const duration = Math.max(0, span.to - span.from)
        if (duration === 0) continue
        const turnKey = `t${span.turn}`
        totals.durationMs += duration
        creditDuration(dims.session, scan.sessionId, scan.label, duration, scan.sessionId, scan.label)
        creditDuration(dims.workspace, workspace.key, workspace.label, duration, scan.sessionId, scan.label)
        const owner = owners.get(turnKey)
        if (owner !== undefined) {
          creditDuration(dims.provider, owner.provider, owner.provider, duration, `${owner.provider}${SEP}${owner.model}`, owner.model)
          creditDuration(dims.model, `${owner.provider}${SEP}${owner.model}`, owner.model, duration, owner.provider, owner.provider)
        }
        const index = series.index(span.from)
        if (index >= 0) series.points[index].durationMs = (series.points[index].durationMs ?? 0) + duration
      }
    }

    totals.turns = allTurns.size
    const report = moneyResult(totalsMoney, hint === '' ? 'USD' : hint)
    totals.cost = report.cost
    totals.currency = report.currency

    // `Point` is exactly the contract's seven fields. Turns and wall time are
    // real numbers, but nothing in the contract reads them per bucket and a
    // payload that grows fields nobody consumes is a payload that will drift.
    const points = series.points.map((point, index) => ({
      t: point.t,
      label: point.label,
      inputTokens: point.inputTokens,
      outputTokens: point.outputTokens,
      cacheReadTokens: point.cacheReadTokens,
      totalTokens: point.totalTokens,
      requests: point.requests,
      cost: reportCost(bucketMoney[index], report.currency),
    }))

    const payload = {
      range: window.range,
      from: window.fromMs,
      to: window.toMs,
      label: window.label,
      totals,
      series: points,
      dims: {
        provider: sortRows(dims.provider, report.currency),
        model: sortRows(dims.model, report.currency),
        workspace: sortRows(dims.workspace, report.currency),
        session: sortRows(dims.session, report.currency),
      },
      models: [...models.values()].sort(
        (left, right) =>
          left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model),
      ),
      dim: normaliseDim(options?.dim),
      updatedAt: Date.now(),
    }
    return payload
  }

  /** A summary with no data, for a disabled feature or an unreadable corpus. */
  function emptySummary(window) {
    const series = buildSeries(window)
    return {
      range: window.range,
      from: window.fromMs,
      to: window.toMs,
      label: window.label,
      totals: zeroTotals(),
      series: series.points.map((point) => ({
        t: point.t,
        label: point.label,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        requests: 0,
        turns: 0,
        durationMs: 0,
        cost: 0,
      })),
      dims: { provider: [], model: [], workspace: [], session: [] },
      models: [],
      dim: 'provider',
      updatedAt: Date.now(),
    }
  }

  /* ---------------------------------------------------------------- *
   * Sessions
   * ---------------------------------------------------------------- */

  /**
   * One row per session with activity in the window, newest activity first.
   * @param options - `{ range, from, to }`.
   * @returns `{ sessions }`.
   */
  async function sessions(options = {}) {
    refreshPricing()
    const window = resolveWindow(options, retainDays())
    if (!enabled()) return { sessions: [] }
    const { scans } = await scanWindow(window.fromMs, window.toMs)

    const rows = []
    let hint = ''
    for (const scan of scans) {
      const providers = new Map()
      const models = new Map()
      const turns = new Set()
      const money = newMoney()
      let firstAt = 0
      let lastAt = 0
      const row = {
        id: scan.sessionId,
        label: scan.label,
        workspace: scan.workspace.key,
        workspaceLabel: scan.workspace.label,
        cwd: typeof scan.header?.cwd === 'string' ? scan.header.cwd : '',
        createdAt: countOf(scan.header?.createdAt),
        provider: '',
        model: '',
        firstAt: 0,
        lastAt: 0,
        turns: 0,
        requests: 0,
        failedRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        durationMs: 0,
        cost: 0,
        currency: '',
        hitRate: 0,
        providers: [],
        models: [],
      }

      for (const item of scan.items) {
        const price = priceFor(item.provider, item.model)
        const cost = costOf(price, item)
        if (hint === '') hint = cost.currency
        row.inputTokens += item.input
        row.outputTokens += item.output
        row.cacheReadTokens += item.cacheRead
        row.cacheWriteTokens += item.cacheWrite
        row.totalTokens += item.input + item.output
        row.requests += 1
        addMoney(money, cost.amount, cost.currency)
        providers.set(item.provider, (providers.get(item.provider) ?? 0) + item.input + item.output)
        models.set(item.model, (models.get(item.model) ?? 0) + item.input + item.output)
        if (item.turn >= 0) turns.add(`t${item.turn}`)
        else turns.add(`u${item.t}`)
        if (firstAt === 0 || item.t < firstAt) firstAt = item.t
        if (item.t > lastAt) lastAt = item.t
      }
      // A failed attempt spent provider time and, on most providers, prompt
      // tokens too. It is counted as a request that produced no output so the
      // failure rate is visible and the request count matches what the provider
      // will bill for. Its turn is credited as well: a turn that only ever
      // failed is still a turn the user asked for.
      for (const attempt of scan.failures) {
        row.failedRequests += 1
        row.requests += 1
        if (attempt.turn >= 0) turns.add(`t${attempt.turn}`)
        else turns.add(`u${attempt.t}`)
        if (firstAt === 0 || attempt.t < firstAt) firstAt = attempt.t
        if (attempt.t > lastAt) lastAt = attempt.t
      }
      for (const span of scan.spans) {
        row.durationMs += Math.max(0, span.to - span.from)
        if (firstAt === 0 || span.from < firstAt) firstAt = span.from
        if (span.to > lastAt) lastAt = span.to
      }

      row.turns = turns.size
      row.firstAt = firstAt
      row.lastAt = lastAt
      row.providers = [...providers.keys()].sort()
      row.models = [...models.keys()].sort()
      row.provider = topKey(providers)
      row.model = topKey(models)
      row.hitRate = hitRateOf(row.cacheReadTokens, row.inputTokens)
      row.money = money
      rows.push(row)
    }

    const report = moneyResult(
      rows.reduce((bucket, row) => {
        addMoney(bucket, row.money.cny, 'CNY')
        addMoney(bucket, row.money.usd, 'USD')
        return bucket
      }, newMoney()),
      hint === '' ? 'USD' : hint,
    )
    for (const row of rows) {
      row.cost = reportCost(row.money, report.currency)
      row.currency = report.currency
      delete row.money
    }

    rows.sort((left, right) => right.lastAt - left.lastAt)
    return { sessions: rows }
  }

  /* ---------------------------------------------------------------- *
   * Context insight
   * ---------------------------------------------------------------- */

  /**
   * Load one session's context model, from the cache while it is still fresh.
   *
   * The model is mode-independent (it carries both the provider figure and the
   * estimate), so `current` and `next` share one fold and one cache entry.
   * @returns the model, or `undefined` when the log cannot be read.
   */
  async function contextModel(sessionId, options = {}) {
    const sessionQuery = service('sessionQuery')
    if (sessionQuery === undefined) return undefined
    const force = options.force === true
    const cached = lruGet(CONTEXT_CACHE, sessionId)
    const now = Date.now()
    if (!force && cached !== undefined && now - cached.validatedAt < 1000) return cached.model

    const key = await freshnessKey(sessionQuery, sessionId)
    if (!force && cached !== undefined && key !== undefined && key === cached.key) {
      cached.validatedAt = now
      return cached.model
    }

    const log = await readLog(sessionQuery, sessionId)
    if (log === undefined) return cached?.model
    const model = foldContext(log.events)
    // The log's own `request/context` is authoritative for the window when the
    // provider catalogue is unavailable; `context()` still prefers the catalogue.
    if (model.contextWindow === 0) {
      model.contextWindow = await resolveContextWindow(model.provider, model.model, 0)
    }
    lruSet(CONTEXT_CACHE, sessionId, { key, model, validatedAt: now }, CACHE_LIMIT)
    return model
  }

  /**
   * Context occupancy for one session.
   * @param request - `{ sessionId, mode }`; `mode` is `'current'` (provider
   *   figure) or `'next'` (our own estimate of the next request).
   * @returns the `/usage/context` payload; `available: false` when nothing
   *   usable exists.
   */
  async function context(request = {}) {
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId.trim() : ''
    const empty = {
      available: false,
      sessionId,
      provider: '',
      model: '',
      usedTokens: 0,
      windowTokens: 0,
      ratio: 0,
      estimateTokens: 0,
      reportedTokens: 0,
      mode: request?.mode === 'next' ? 'next' : 'current',
      buckets: [],
      series: [],
      browsers: [],
      events: [],
    }
    if (sessionId === '' || !enabled()) return empty

    const model = await contextModel(sessionId)
    if (model === undefined) return empty
    const windowTokens = await resolveContextWindow(model.provider, model.model, model.contextWindow)
    return contextPayload(model, { sessionId, mode: request?.mode, windowTokens })
  }

  /**
   * One page of context events for the browser's drill-down.
   * @param request - `{ sessionId, category, offset, limit }`.
   * @returns `{ total, items }`.
   */
  async function contextEvents(request = {}) {
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId.trim() : ''
    if (sessionId === '' || !enabled()) return { total: 0, items: [] }
    const model = await contextModel(sessionId)
    if (model === undefined) return { total: 0, items: [] }
    return contextEventPage(model, request)
  }

  /**
   * Context window for one provider/model pair: the catalogue first, the log's
   * own reading second, the static fallback third, 0 ("unknown") last.
   */
  async function resolveContextWindow(provider, model, logWindow = 0) {
    const llm = service('llm')
    if (llm !== undefined && typeof llm.listModels === 'function') {
      try {
        const models = await llm.listModels(provider)
        if (Array.isArray(models)) {
          for (const entry of models) {
            const id = typeof entry?.id === 'string' ? entry.id : ''
            const name = typeof entry?.name === 'string' ? entry.name : ''
            if (id !== model && name !== model) continue
            const window = contextWindowOf(entry)
            if (window > 0) return window
          }
        }
      } catch (error) {
        warnOnce('context-models', `listModels() failed: ${describe(error)}`)
      }
    }
    return countOf(logWindow) || staticContextWindow(provider, model)
  }

  /* ---------------------------------------------------------------- *
   * Geek metrics
   * ---------------------------------------------------------------- */

  /**
   * Recent requests and the live frame.
   *
   * One session when `sessionId` is named, otherwise every session that logged
   * activity in the last week, merged by time. The tree view matters because a
   * subagent's spend is still spend, and its requests are the ones a user is
   * least likely to find anywhere else.
   * @param request - `{ sessionId, pool }`.
   * @returns `{ requests, stream, avg }`.
   */
  async function geek(request = {}) {
    const usage = usageSettings()
    refreshPricing()
    const defaultPool = Math.round(countOf(usage.geekMetrics?.pool) || countOf(usage.recentRequestPool) || 20)
    const pool = Math.max(1, Math.min(200, Math.round(countOf(request?.pool) || defaultPool)))
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId.trim() : ''
    const now = Date.now()
    if (!enabled()) return { requests: [], stream: null, avg: emptyAvg() }

    if (sessionId !== '') {
      const sessionQuery = service('sessionQuery')
      if (sessionQuery === undefined) return { requests: [], stream: null, avg: emptyAvg() }
      const fold = await loadFold(sessionQuery, sessionId)
      if (fold === undefined) return { requests: [], stream: null, avg: emptyAvg() }
      return geekPayload(fold, { sessionId, pool, now })
    }

    const { scans } = await scanWindow(now - 7 * 86400000, now + 1)
    if (scans.length === 0) return { requests: [], stream: null, avg: emptyAvg() }
    return mergeGeek(
      scans.map((scan) => ({ sessionId: scan.sessionId, fold: scan.fold })),
      { pool, now },
    )
  }

  /* ---------------------------------------------------------------- *
   * Balance
   * ---------------------------------------------------------------- */

  /**
   * Balance for the official endpoint and every configured provider.
   * @param request - `{ force }` bypasses the TTL cache.
   * @returns `{ deepseek, providers, at }`.
   */
  async function balance(request = {}) {
    const usage = usageSettings()
    if (!enabled()) {
      return {
        deepseek: { ...emptyBalanceRow('deepseek', 'DeepSeek', 'deepseek'), message: 'disabled' },
        providers: [],
        at: Date.now(),
      }
    }
    const config = usage.balance !== null && typeof usage.balance === 'object' ? usage.balance : {}
    return balancePayload(config, { force: request?.force === true })
  }

  /* ---------------------------------------------------------------- *
   * Budgets
   * ---------------------------------------------------------------- */

  /**
   * Evaluate every configured budget against its current period.
   *
   * Budgets share at most three period windows, so the window scan is memoised
   * per window inside one call: sixty budgets cost three scans, not sixty.
   * @returns `{ budgets, evaluation, over }`.
   */
  async function budgets() {
    refreshPricing()
    const usage = usageSettings()
    const list = Array.isArray(usage.budgets) ? usage.budgets : []
    const now = Date.now()
    const windows = new Map()
    const evaluation = []
    const kept = []

    for (const entry of list) {
      // A hand-edited settings file can carry a null slot or a stray scalar. An
      // entry we cannot evaluate is dropped from both halves of the answer, so
      // the page never renders a budget row with no numbers behind it.
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      if (entry.enabled === false) continue
      const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : 'budget'
      const label = typeof entry.label === 'string' && entry.label !== '' ? entry.label : id
      const scope =
        entry.scope === 'provider' || entry.scope === 'model' || entry.scope === 'workspace'
          ? entry.scope
          : 'global'
      const period = entry.period === 'week' || entry.period === 'month' ? entry.period : 'day'
      const limitTokens = countOf(entry.limitTokens)
      const limitCost = countOf(entry.limitCost)
      // A budget with neither cap can never fire; skipping it here also means an
      // unfinished budget costs no session scan at all.
      if (limitTokens <= 0 && limitCost <= 0) continue

      const window = periodWindow(period, now)
      const windowKey = `${window.fromMs}:${window.toMs}`
      let scans = windows.get(windowKey)
      if (scans === undefined) {
        scans = (await scanWindow(window.fromMs, window.toMs)).scans
        windows.set(windowKey, scans)
      }

      const provider = typeof entry.provider === 'string' ? entry.provider : ''
      const model = typeof entry.model === 'string' ? entry.model : ''
      const workspace = typeof entry.workspace === 'string' ? entry.workspace : ''
      const money = newMoney()
      let usedTokens = 0
      let hint = ''

      for (const scan of scans) {
        if (scope === 'workspace' && scan.workspace.key !== workspace) continue
        for (const item of scan.items) {
          if (scope === 'provider' && item.provider !== provider) continue
          if (scope === 'model') {
            if (item.model !== model) continue
            if (provider !== '' && item.provider !== provider) continue
          }
          const cost = costOf(priceFor(item.provider, item.model), item)
          if (hint === '') hint = cost.currency
          usedTokens += item.input + item.output
          addMoney(money, cost.amount, cost.currency)
        }
      }

      const report = moneyResult(money, hint === '' ? 'USD' : hint)
      const usedCost = report.cost
      const thresholdRatio = thresholdOf(entry.threshold)

      // A budget may cap tokens, cost, or both; a zero cap is "no cap", so it
      // must not drag the ratio down to zero.
      const tokenRatio = limitTokens > 0 ? usedTokens / limitTokens : 0
      const costRatio = limitCost > 0 ? usedCost / limitCost : 0
      const ratio = Math.max(tokenRatio, costRatio)
      const state = ratio >= 1 ? 'over' : ratio >= thresholdRatio ? 'warn' : 'ok'

      kept.push(entry)
      evaluation.push({
        id,
        label,
        scope,
        period,
        state,
        usedTokens,
        usedCost,
        limitTokens,
        limitCost,
        ratio: round6(Number.isFinite(ratio) ? ratio : 0),
        windowFrom: window.fromMs,
        windowTo: window.toMs,
        currency: report.currency,
        threshold: thresholdRatio,
        action: entry.action === 'pause' ? 'pause' : 'notify',
        notifyOnce: entry.notifyOnce !== false,
        provider: scope === 'provider' || scope === 'model' ? provider : '',
        model: scope === 'model' ? model : '',
        workspace: scope === 'workspace' ? workspace : '',
      })
    }

    return { budgets: kept, evaluation, over: evaluation.some((row) => row.state === 'over') }
  }

  /**
   * Budgets in the `'over'` state, for the pre-step guard.
   * @returns `{ over, pause }`; `pause` is true when any offender asks for it.
   */
  async function overBudgetContext() {
    try {
      const { evaluation } = await budgets()
      const over = evaluation.filter((row) => row.state === 'over')
      return { over, pause: over.some((row) => row.action === 'pause') }
    } catch (error) {
      warnOnce('budget-guard', `budget evaluation failed; the step is allowed: ${describe(error)}`)
      return { over: [], pause: false }
    }
  }

  /**
   * Whether a `pause` budget is currently over.
   *
   * Called from `agent/pre-step`, so it must never throw: a broken budget must
   * degrade into "let the turn run", never into an agent that cannot start.
   * @param scopeInfo - optional `{ provider, model, workspace }` of the request
   *   about to start. When given, only budgets that apply to it are considered.
   * @returns true when the next model request should be refused.
   */
  async function isPaused(scopeInfo) {
    if (!enabled()) return false
    const { over } = await overBudgetContext()
    const pauses = over.filter((row) => row.action === 'pause')
    if (pauses.length === 0) return false
    const scope = scopeInfo !== null && typeof scopeInfo === 'object' ? scopeInfo : undefined
    if (scope === undefined) return true
    return pauses.some((row) => budgetApplies(row, scope))
  }

  /* ---------------------------------------------------------------- *
   * Prices
   * ---------------------------------------------------------------- */

  /**
   * The effective price list.
   * @param request - `{ q }` filters by provider or model substring.
   * @returns `{ rows, source }`.
   */
  async function prices(request = {}) {
    refreshPricing()
    const query = typeof request?.q === 'string' ? request.q : ''
    return priceRows(query)
  }

  /**
   * Install a caller-supplied override list.
   *
   * The list is normalised and applied immediately so the next `prices()` call
   * sees it; persisting it is the route's job, because only the settings store
   * owns the document. The normalised list is returned so the route can write
   * exactly what the engine will read back.
   * @param overrides - `usage.priceOverrides[]` shaped rows.
   * @returns `{ overrides, source }`.
   */
  async function setPriceOverrides(overrides) {
    const list = Array.isArray(overrides) ? overrides : []
    pinOverrides(list)
    const { rows, source } = priceRows('')
    return { overrides: list, source, count: rows.length }
  }

  /* ---------------------------------------------------------------- *
   * Reindex
   * ---------------------------------------------------------------- */

  /**
   * Drop every cache and read the corpus again.
   *
   * This is the only path that pays for a full re-read, which is why it is an
   * explicit action rather than something a timer does.
   * @param request - `{ from, to }`; absent means "everything".
   * @returns `{ indexed, at }`.
   */
  async function reindex(request = {}) {
    clearFoldCache()
    clearBalanceCache()
    CONTEXT_CACHE.clear()
    const from = countOf(request?.from)
    const to = countOf(request?.to) || Number.MAX_SAFE_INTEGER
    const { read } = await scanWindow(from, to, { force: true })
    return { indexed: read, at: Date.now() }
  }

  return {
    summary,
    sessions,
    context,
    contextEvents,
    balance,
    budgets,
    reindex,
    geek,
    prices,
    setPriceOverrides,
    overBudgetContext,
    isPaused,
    priceFor,
    PRICE_TABLE,
  }
}

/* ------------------------------------------------------------------ *
 * Aggregation helpers
 * ------------------------------------------------------------------ */

/** A totals object with every field the routes promise. */
function zeroTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    requests: 0,
    failedRequests: 0,
    turns: 0,
    durationMs: 0,
    cost: 0,
    currency: 'USD',
  }
}

/** A fold item with no usage, for a failed attempt that never got measured. */
function zeroItem(record) {
  return {
    t: countOf(record?.t),
    provider: typeof record?.provider === 'string' ? record.provider : UNKNOWN,
    model: typeof record?.model === 'string' ? record.model : UNKNOWN,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    turn: typeof record?.turn === 'number' ? record.turn : -1,
  }
}

/** Get or create one dimension row plus its per-sub-key children. */
function dimEntry(store, key, label) {
  let entry = store.get(key)
  if (entry === undefined) {
    entry = {
      key,
      label,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      requests: 0,
      durationMs: 0,
      money: newMoney(),
      subs: new Map(),
    }
    store.set(key, entry)
  }
  return entry
}

/** Get or create one child row under a dimension row. */
function subEntry(entry, key, label) {
  let child = entry.subs.get(key)
  if (child === undefined) {
    child = {
      key,
      label,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      requests: 0,
      durationMs: 0,
      money: newMoney(),
    }
    entry.subs.set(key, child)
  }
  return child
}

/**
 * Fold one request into one dimension row and its child.
 *
 * No turn set is kept per row: the contract's `Row` has no turn count, and the
 * window's turn total is tracked once in `summary()` rather than per dimension.
 * A per-row `Set` of turn keys would be the single largest allocation in this
 * function for a number nothing reads.
 */
function creditDim(store, key, label, item, cost, sub) {
  const entry = dimEntry(store, key, label)
  entry.inputTokens += item.input
  entry.outputTokens += item.output
  entry.cacheReadTokens += item.cacheRead
  entry.cacheWriteTokens += item.cacheWrite
  entry.totalTokens += item.input + item.output
  entry.requests += 1
  addMoney(entry.money, cost.amount, cost.currency)

  if (sub !== undefined) {
    const child = subEntry(entry, sub.subKey, sub.subLabel)
    child.inputTokens += item.input
    child.outputTokens += item.output
    child.cacheReadTokens += item.cacheRead
    child.totalTokens += item.input + item.output
    child.requests += 1
    addMoney(child.money, cost.amount, cost.currency)
  }
}

/** Add a completed turn's wall time to one dimension row and its child. */
function creditDuration(store, key, label, durationMs, subKey, subLabel) {
  const entry = dimEntry(store, key, label)
  entry.durationMs += durationMs
  if (subKey !== undefined) subEntry(entry, subKey, subLabel).durationMs += durationMs
}

/**
 * Materialise dimension rows, biggest by tokens first.
 *
 * `sub` is always an array, empty for a row with a single child, so the client
 * can expand a row without checking for `undefined` first.
 */
function sortRows(store, currency) {
  const rows = []
  for (const entry of store.values()) {
    const subs = []
    for (const child of entry.subs.values()) {
      subs.push({
        key: child.key,
        label: child.label,
        inputTokens: child.inputTokens,
        outputTokens: child.outputTokens,
        cacheReadTokens: child.cacheReadTokens,
        totalTokens: child.totalTokens,
        requests: child.requests,
        durationMs: child.durationMs,
        cost: reportCost(child.money, currency),
        hitRate: hitRateOf(child.cacheReadTokens, child.inputTokens),
      })
    }
    subs.sort((left, right) => right.totalTokens - left.totalTokens || left.key.localeCompare(right.key))
    rows.push({
      key: entry.key,
      label: entry.label,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      totalTokens: entry.totalTokens,
      requests: entry.requests,
      durationMs: entry.durationMs,
      cost: reportCost(entry.money, currency),
      hitRate: hitRateOf(entry.cacheReadTokens, entry.inputTokens),
      sub: subs,
    })
  }
  rows.sort(
    (left, right) =>
      right.totalTokens - left.totalTokens ||
      right.requests - left.requests ||
      left.key.localeCompare(right.key),
  )
  return rows
}

/** Convert one money bucket into the report currency. */
function reportCost(bucket, currency) {
  const cny = countOf(bucket?.cny)
  const usd = countOf(bucket?.usd)
  if (cny === 0 && usd === 0) return 0
  return round6(convertMoney(cny, 'CNY', currency) + convertMoney(usd, 'USD', currency))
}

/** Top key of a `Map<key, weight>`, or an empty string. */
function topKey(map) {
  let best = ''
  let weight = -1
  for (const [key, value] of map) {
    if (value > weight) {
      best = key
      weight = value
    }
  }
  return best
}

/** A budget's warn threshold, clamped so a hand-edited value cannot invert it. */
function thresholdOf(value) {
  const parsed = countOf(value)
  if (parsed <= 0) return 0.9
  return Math.min(1, Math.max(0.1, parsed))
}

/**
 * Whether one budget's scope covers the request described by `scopeInfo`.
 *
 * Ambiguity fails open. When the caller cannot say which provider, model or
 * workspace it is about to use, a `pause` budget is treated as not applying:
 * refusing a turn we might be wrong about is far worse than letting one request
 * past a spend cap that the period window will still report.
 */
function budgetApplies(row, scopeInfo) {
  if (scopeInfo === undefined) return true
  const provider = typeof scopeInfo.provider === 'string' ? scopeInfo.provider : ''
  const model = typeof scopeInfo.model === 'string' ? scopeInfo.model : ''
  const workspace = typeof scopeInfo.workspace === 'string' ? scopeInfo.workspace : ''
  if (row.scope === 'global') return true
  if (row.scope === 'provider') {
    return provider !== '' && row.provider !== '' && provider === row.provider
  }
  if (row.scope === 'model') {
    if (model === '' || row.model === '' || row.model !== model) return false
    return row.provider === '' || provider === '' ? row.provider === '' : provider === row.provider
  }
  if (row.scope === 'workspace') {
    return workspace !== '' && row.workspace !== '' && workspace === row.workspace
  }
  return true
}

/** The four dimension names the summary can be asked to focus. */
function normaliseDim(value) {
  return value === 'model' || value === 'workspace' || value === 'session' ? value : 'provider'
}

/** Context window reported by one catalogue entry, or 0. */
function contextWindowOf(entry) {
  const candidates = [
    entry?.contextWindow,
    entry?.contextTokens,
    entry?.maxContextTokens,
    entry?.limits?.contextTokens,
    entry?.limits?.contextWindow,
    entry?.maxInputTokens,
  ]
  for (const candidate of candidates) {
    const window = countOf(candidate)
    if (window > 0) return window
  }
  return 0
}

/** An average row with every field present, for an empty geek payload. */
function emptyAvg() {
  return { requests: 0, ttftMs: 0, speed: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 }
}

/** A balance row that could not be produced at all. */
function emptyBalanceRow(id, label, source) {
  return {
    id,
    label,
    ok: false,
    currency: source === 'deepseek' ? 'CNY' : '',
    total: 0,
    granted: 0,
    toppedUp: 0,
    expiresAt: 0,
    message: 'not-configured',
    at: Date.now(),
    source,
    latencyMs: 0,
  }
}

/** Re-exported so a route can bound its own series without importing support.js. */
export { MAX_SERIES_POINTS, liveFrame }

/**
 * Drop every module-level cache this feature owns.
 *
 * Three caches live at module scope on purpose (folds, context models, balance
 * readings), so they survive an engine rebuild — a Host reload must not pay for
 * the whole corpus twice. The cost of that choice is that a test which builds
 * two engines over the same session ids would read the first engine's fold, so
 * the coupling is exposed here as one deliberate reset instead of being worked
 * around with unique ids.
 */
export function resetUsageCaches() {
  clearFoldCache()
  clearBalanceCache()
  CONTEXT_CACHE.clear()
}
