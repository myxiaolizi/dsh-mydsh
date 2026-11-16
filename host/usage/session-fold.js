/**
 * Session-log folding and its caches.
 *
 * `readSession()` / `listEvents()` are the only expensive calls in this feature:
 * a long session log holds tens of thousands of events, while every aggregation
 * further down needs a handful of numbers per model request. So one read is
 * reduced to a lean fold and cached, and nothing downstream ever touches a raw
 * event again.
 *
 * Two invariants:
 *
 *  - The fold holds plain numbers and short strings, never event objects. A
 *    retained tool result can be hundreds of kilobytes; 400 cached sessions of
 *    those would be gigabytes.
 *  - A session that cannot be read is skipped, and a *cached* fold is served
 *    instead of an empty one. One corrupt log must not blank the whole page, and
 *    a transient read failure must not rewrite the charts.
 *
 * Freshness is `listEvents().length` plus the last `seq`: cheap, and the only
 * thing that changes when a turn appends events.
 */

import { CACHE_LIMIT, FRESHNESS_TTL_MS, countOf, describe, lruSet, warnOnce } from './support.js'

/** Providers/models are inherited from the latest request header per log. */
const UNKNOWN = '(unknown)'

/** A step in flight longer than this is not shown as a live frame any more. */
const LIVE_WINDOW_MS = 15 * 60 * 1000

/**
 * Module-level fold cache, shared by every engine instance and route closure.
 *
 * Capped by LRU because a long-lived Host outlives thousands of sessions.
 * @type {Map<string, object>}
 */
const FOLD_CACHE = new Map()

/** Read one session log as raw events; `undefined` when unreadable. */
export async function readLog(sessionQuery, sessionId) {
  if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') return undefined
  try {
    const snapshot = await sessionQuery.readSession(sessionId)
    return {
      events: Array.isArray(snapshot?.events) ? snapshot.events : [],
      header: snapshot?.session ?? snapshot?.header,
      inheritedEventCount: countOf(snapshot?.inheritedEventCount),
    }
  } catch (error) {
    warnOnce('read-session', `readSession() failed; some sessions are missing from usage: ${describe(error)}`)
    return undefined
  }
}

/**
 * The cheap freshness key: record count and last sequence number.
 * @returns `"<count>:<lastSeq>"`, or `undefined` when the listing is unavailable.
 */
export async function freshnessKey(sessionQuery, sessionId) {
  if (sessionQuery === undefined || typeof sessionQuery.listEvents !== 'function') return undefined
  try {
    const records = await sessionQuery.listEvents(sessionId)
    if (!Array.isArray(records)) return undefined
    const last = records.length === 0 ? 0 : countOf(records[records.length - 1]?.seq)
    return `${records.length}:${last}`
  } catch {
    return undefined
  }
}

/**
 * Get one session's fold, from the cache while it is still fresh.
 * @param sessionQuery - the `sessionQuery` service.
 * @param sessionId - session to fold.
 * @param options - `force` skips the cache read and never serves a stale fold.
 * @returns the fold, or `undefined` when the session cannot be read at all.
 */
export async function loadFold(sessionQuery, sessionId, options = {}) {
  const force = options.force === true
  const cached = FOLD_CACHE.get(sessionId)
  const now = Date.now()

  if (!force && cached !== undefined && now - cached.validatedAt < FRESHNESS_TTL_MS) {
    lruSet(FOLD_CACHE, sessionId, cached)
    return cached
  }

  const key = await freshnessKey(sessionQuery, sessionId)
  if (!force && cached !== undefined && key !== undefined && key === cached.key) {
    cached.validatedAt = now
    lruSet(FOLD_CACHE, sessionId, cached)
    return cached
  }

  const log = await readLog(sessionQuery, sessionId)
  if (log === undefined) return force ? undefined : cached

  const fold = foldEvents(log.events)
  fold.key = key
  fold.validatedAt = now
  lruSet(FOLD_CACHE, sessionId, fold, CACHE_LIMIT)
  return fold
}

/** Drop every cached fold, used by `reindex`. */
export function clearFoldCache() {
  FOLD_CACHE.clear()
}

/**
 * How many folds are held right now.
 *
 * Exposed for the soak test and for the usage page's own diagnostics: an
 * unbounded cache is invisible in a latency measurement and only shows up as
 * memory pressure after days of use, so the size has to be observable without a
 * heap snapshot.
 */
export function foldCacheSize() {
  return FOLD_CACHE.size
}

/**
 * Reduce one raw event log to the numbers the engine aggregates.
 *
 * One pass, no retained events. Every per-request figure the summary, the geek
 * pool and the budget guard need is produced here, because a second pass would
 * mean a second decode of the same log.
 * @param events - raw session events in log order.
 * @returns the fold `{ items, attempts, requests, spans, pending, firstAt, lastAt }`.
 */
export function foldEvents(events) {
  const items = []
  const attempts = []
  const requests = []
  const spans = new Map()
  /** Latest `request/context` reading, for the context window. */
  const route = { provider: '', model: '', contextWindow: 0 }
  /** Step start times, keyed `turn:step`, so TTFT has an anchor. */
  const stepStarts = new Map()
  /** Steps that have produced a settlement, so an in-flight step is detectable. */
  const settled = new Set()

  let provider = UNKNOWN
  let model = UNKNOWN
  let firstAt = 0
  let lastAt = 0
  let highestTurn = -1
  let highestStep = -1
  let pending

  for (const event of events) {
    const type = event?.type
    const time = countOf(event?.time)
    if (time > 0) {
      if (firstAt === 0 || time < firstAt) firstAt = time
      if (time > lastAt) lastAt = time
    }

    if (type === 'request/header') {
      const config = event?.data?.header?.config
      if (typeof config?.provider === 'string' && config.provider !== '') provider = config.provider
      if (typeof config?.model === 'string' && config.model !== '') model = config.model
      continue
    }

    if (type === 'request/context') {
      if (typeof event?.data?.provider === 'string' && event.data.provider !== '') route.provider = event.data.provider
      if (typeof event?.data?.model === 'string' && event.data.model !== '') route.model = event.data.model
      const window = countOf(event?.data?.contextWindow)
      if (window > 0) route.contextWindow = window
      continue
    }

    if (type === 'step/start') {
      const turn = intOf(event?.data?.turn)
      const step = intOf(event?.data?.step)
      if (turn >= 0 && step >= 0) {
        stepStarts.set(stepKey(turn, step), time)
        if (turn > highestTurn || (turn === highestTurn && step > highestStep)) {
          highestTurn = turn
          highestStep = step
        }
      }
      continue
    }

    if (type === 'step/end') {
      const turn = intOf(event?.data?.turn)
      const step = intOf(event?.data?.step)
      if (turn >= 0 && step >= 0) settled.add(stepKey(turn, step))
      continue
    }

    if (type === 'assistant/message') {
      const turn = intOf(event?.data?.turn)
      const step = intOf(event?.data?.step)
      if (turn >= 0 && step >= 0) settled.add(stepKey(turn, step))
      const usage = event?.data?.usage
      const message = event?.data?.message
      const source = message?.source
      const itemProvider =
        typeof source?.provider === 'string' && source.provider !== '' ? source.provider : provider
      const itemModel = typeof source?.model === 'string' && source.model !== '' ? source.model : model
      const stream = Array.isArray(event?.data?.stream) ? event.data.stream : []
      const stepStart = stepStarts.get(stepKey(turn, step))
      const firstToken = firstTokenTime(stream)
      const durationMs = stepStart === undefined ? 0 : Math.max(0, time - stepStart)
      const ttftMs =
        stepStart === undefined || firstToken === 0 ? 0 : Math.max(0, Math.min(firstToken, time) - stepStart)
      const interrupted = event?.data?.interrupted === true

      // An interrupted settlement still carries usage when the adapter reported
      // it; the message never entered the surface, so it is not part of the
      // transcript, but its tokens were still billed.
      const metered = usage !== undefined && usage !== null
      if (metered) {
        const entry = {
          t: time,
          seq: countOf(event?.seq),
          turn,
          step,
          provider: itemProvider,
          model: itemModel,
          input: countOf(usage.inputTokens),
          output: countOf(usage.outputTokens),
          cacheRead: countOf(usage.cacheReadTokens),
          cacheWrite: countOf(usage.cacheWriteTokens),
          interrupted,
        }
        items.push(entry)
        requests.push({
          at: time,
          sessionId: '',
          source: sourceOf(interrupted),
          status: interrupted ? 'interrupted' : 'ok',
          provider: itemProvider,
          model: itemModel,
          turn,
          step,
          ttftMs,
          durationMs,
          inputTokens: entry.input,
          outputTokens: entry.output,
          cacheReadTokens: entry.cacheRead,
          cacheWriteTokens: entry.cacheWrite,
        })
      }
      continue
    }

    if (type === 'assistant/attempt') {
      const turn = intOf(event?.data?.turn)
      const step = intOf(event?.data?.step)
      if (turn >= 0 && step >= 0) settled.add(stepKey(turn, step))
      const stream = Array.isArray(event?.data?.stream) ? event.data.stream : []
      const stepStart = stepStarts.get(stepKey(turn, step))
      const firstToken = firstTokenTime(stream)
      attempts.push({
        t: time,
        seq: countOf(event?.seq),
        turn,
        step,
        provider,
        model,
      })
      requests.push({
        at: time,
        sessionId: '',
        source: 'attempt',
        status: 'failed',
        provider,
        model,
        turn,
        step,
        ttftMs:
          stepStart === undefined || firstToken === 0 ? 0 : Math.max(0, Math.min(firstToken, time) - stepStart),
        durationMs: stepStart === undefined ? 0 : Math.max(0, time - stepStart),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
      continue
    }

    if (type === 'turn/start') {
      const turn = intOf(event?.data?.turn)
      if (turn >= 0 && !spans.has(turn)) spans.set(turn, { turn, start: time, end: undefined })
      continue
    }

    if (type === 'turn/end') {
      const turn = intOf(event?.data?.turn)
      const span = turn >= 0 ? spans.get(turn) : undefined
      if (span === undefined || span.end !== undefined) continue
      // A clock that moves backwards must not produce negative wall time.
      if (time >= span.start) span.end = time
    }
  }

  // An in-flight step is the highest (turn, step) with a start and no
  // settlement. This is what the composer's live frame is derived from: the
  // durable log is the only source that survives a page reload.
  if (highestTurn >= 0) {
    const key = stepKey(highestTurn, highestStep)
    if (!settled.has(key) && stepStarts.has(key)) {
      pending = { turn: highestTurn, step: highestStep, at: stepStarts.get(key) }
    }
  }

  return {
    items,
    attempts,
    requests,
    spans,
    pending,
    route,
    firstAt,
    lastAt,
    provider,
    model,
  }
}

/** `turn:step` key for the per-step maps. */
function stepKey(turn, step) {
  return `${turn}:${step}`
}

/** Integer event field, or -1 when absent or not an integer. */
function intOf(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : -1
}

/** Earliest recorded chunk time inside one settlement's stream record. */
function firstTokenTime(stream) {
  let earliest = 0
  for (const entry of stream) {
    if (entry === null || typeof entry !== 'object') continue
    const candidate = countOf(entry.time) || countOf(entry.time0)
    if (candidate === 0) continue
    if (earliest === 0 || candidate < earliest) earliest = candidate
  }
  return earliest
}

/** Where one request originated, for the geek pool's `source` column. */
function sourceOf(interrupted) {
  return interrupted ? 'interrupted' : 'chat'
}

/**
 * Detect an in-flight model request, for the composer's live frame.
 *
 * Only the durable log is consulted: the Host writes `assistant/message` or
 * `assistant/attempt` when a request settles, so a start without either means
 * the request is still running. The 15-minute ceiling stops a crashed session
 * from showing a frame that never ends.
 * @param fold - the fold from `loadFold()`.
 * @param now - current epoch ms.
 * @returns `{ turn, step, at, streamMs }`, or `undefined`.
 */
export function liveFrame(fold, now) {
  const pending = fold?.pending
  if (pending === undefined) return undefined
  const started = countOf(pending.at)
  if (started === 0) return undefined
  const streamMs = now - started
  if (streamMs < 0 || streamMs > LIVE_WINDOW_MS) return undefined
  return { turn: pending.turn, step: pending.step, at: started, streamMs }
}

/** The most recent request in a fold, used as the prompt-size proxy for a live frame. */
export function lastRequest(fold) {
  const requests = Array.isArray(fold?.requests) ? fold.requests : []
  let newest
  for (const request of requests) {
    if (newest === undefined || request.at > newest.at) newest = request
  }
  return newest
}

/**
 * The most recent request that the provider actually metered.
 *
 * This is the prompt-size proxy for a live frame. A failed attempt reports no
 * usage, so using the newest record outright would answer "the prompt is 0
 * tokens" whenever the previous request had died — which is exactly the moment a
 * user is watching the bubble.
 */
export function lastMeteredRequest(fold) {
  const requests = Array.isArray(fold?.requests) ? fold.requests : []
  let newest
  for (const request of requests) {
    if (request.inputTokens <= 0) continue
    if (newest === undefined || request.at > newest.at) newest = request
  }
  return newest
}
