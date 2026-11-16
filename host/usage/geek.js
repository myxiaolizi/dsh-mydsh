/**
 * Geek metrics: the per-request numbers behind the composer bubble.
 *
 * Two different things live here and they have different sources on purpose:
 *
 *  - The request pool (`requests[]`) is folded from the durable session log, so
 *    it survives a page reload, works after a Host restart, and answers for a
 *    session nobody is watching. A browser-only implementation loses all of
 *    that, which is why the durable log is the primary source here.
 *  - The live frame (`stream`) is the one figure the log cannot hold yet: a
 *    request in flight has written `step/start` but no settlement. It is derived
 *    from that start time, and it is `null` the moment the request settles.
 *
 * Speed is `outputTokens / decodeMs`, where decode is measured from the first
 * recorded token chunk to the settlement — not from the step start. Including
 * TTFT in the denominator would report a slow number for a fast model on a slow
 * network, which is exactly the confusion the two separate figures exist to
 * avoid.
 */

import { countOf, round6 } from './support.js'
import { costOf, priceFor } from './pricing.js'
import { liveFrame, lastMeteredRequest } from './session-fold.js'

/** Requests the pool may hold, whatever the caller asks for. */
const POOL_MAX = 200

/** Requests the pool shows when the caller is silent. */
const POOL_DEFAULT = 20

/**
 * Build one geek request row from a folded request record.
 * @param request - one record from `fold.requests`.
 * @param sessionId - owning session.
 * @returns a `GeekRequest`.
 */
export function geekRow(request, sessionId) {
  const output = countOf(request.outputTokens)
  const decodeMs = Math.max(0, countOf(request.durationMs) - countOf(request.ttftMs))
  const speed = decodeMs > 0 && output > 0 ? round6((output / decodeMs) * 1000) : 0
  const price = priceFor(request.provider, request.model)
  const cost = costOf(price, {
    input: request.inputTokens,
    output: request.outputTokens,
    cacheRead: request.cacheReadTokens,
    cacheWrite: request.cacheWriteTokens,
  })
  return {
    at: countOf(request.at),
    sessionId,
    source: typeof request.source === 'string' ? request.source : 'chat',
    status: typeof request.status === 'string' ? request.status : 'ok',
    model: typeof request.model === 'string' ? request.model : '',
    provider: typeof request.provider === 'string' ? request.provider : '',
    ttftMs: countOf(request.ttftMs),
    durationMs: countOf(request.durationMs),
    inputTokens: countOf(request.inputTokens),
    outputTokens: output,
    cacheReadTokens: countOf(request.cacheReadTokens),
    speed,
    cost: cost.amount,
    currency: cost.currency,
    turn: typeof request.turn === 'number' ? request.turn : -1,
    step: typeof request.step === 'number' ? request.step : -1,
  }
}

/**
 * Build the `/usage/geek` payload for one session.
 *
 * Averages ignore requests with no timing data: a request whose step start is
 * missing (a resumed log, a failed attempt) would drag every average toward
 * zero for no reason. Failed attempts are still listed, because the drawer is
 * where a user goes to see why a request burned tokens and returned nothing.
 * @param fold - the session fold.
 * @param options - `{ sessionId, pool, now }`.
 * @returns `{ requests, stream, avg }`.
 */
export function geekPayload(fold, options = {}) {
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : ''
  const pool = Math.min(POOL_MAX, Math.max(1, Math.round(countOf(options.pool) || POOL_DEFAULT)))
  const now = countOf(options.now) || Date.now()

  const rows = (fold?.requests ?? [])
    .slice()
    .sort((left, right) => right.at - left.at)
    .slice(0, pool)
    .map((request) => geekRow(request, sessionId))

  const stream = livePayload(fold, sessionId, now, rows)

  const timed = rows.filter((row) => row.ttftMs > 0)
  const fast = rows.filter((row) => row.speed > 0)
  const avg = {
    requests: rows.length,
    ttftMs: timed.length === 0 ? 0 : round6(timed.reduce((sum, row) => sum + row.ttftMs, 0) / timed.length),
    speed: fast.length === 0 ? 0 : round6(fast.reduce((sum, row) => sum + row.speed, 0) / fast.length),
    durationMs:
      rows.length === 0 ? 0 : round6(rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length),
    inputTokens:
      rows.length === 0 ? 0 : Math.round(rows.reduce((sum, row) => sum + row.inputTokens, 0) / rows.length),
    outputTokens:
      rows.length === 0 ? 0 : Math.round(rows.reduce((sum, row) => sum + row.outputTokens, 0) / rows.length),
  }

  return { requests: rows, stream, avg }
}

/**
 * The live frame, or `null`.
 *
 * `inputTokens` is the previous request's prompt size, which is the only honest
 * figure available before the provider reports the current one: the prompt of an
 * in-flight request is essentially the last one plus the tokens just generated.
 * `speed` stays 0 because nothing has been counted yet — reporting a speed from
 * a zero numerator would read as "infinitely fast".
 */
function livePayload(fold, sessionId, now, rows) {
  const frame = liveFrame(fold, now)
  if (frame === undefined) return null
  const previous = lastMeteredRequest(fold)
  const model = previous?.model ?? fold?.model ?? ''
  const provider = previous?.provider ?? fold?.provider ?? ''
  return {
    at: frame.at,
    ttftMs: 0,
    streamMs: frame.streamMs,
    inputTokens: countOf(previous?.inputTokens),
    outputTokens: 0,
    speed: 0,
    sessionId,
    provider: typeof provider === 'string' ? provider : '',
    model: typeof model === 'string' ? model : '',
    turn: frame.turn,
    step: frame.step,
  }
}

/**
 * Aggregate the whole session tree's recent requests.
 *
 * The composer bubble shows one session, but the usage panel's "recent" list is
 * more useful across a tree: a subagent's spend is spend. Requests are merged by
 * time and capped, so a fan-out of forty subagents does not produce a drawer
 * with forty thousand rows.
 * @param folds - `[{ sessionId, fold }]`.
 * @param options - `{ pool, now }`.
 * @returns `{ requests, stream, avg }` in the same shape as one session.
 */
export function mergeGeek(folds, options = {}) {
  const pool = Math.min(POOL_MAX, Math.max(1, Math.round(countOf(options.pool) || POOL_DEFAULT)))
  const now = countOf(options.now) || Date.now()
  const rows = []
  let live

  for (const entry of folds) {
    const payload = geekPayload(entry.fold, { sessionId: entry.sessionId, pool, now })
    for (const row of payload.requests) rows.push(row)
    if (live === undefined && payload.stream !== null) live = payload.stream
  }
  rows.sort((left, right) => right.at - left.at)
  const kept = rows.slice(0, pool)
  const timed = kept.filter((row) => row.ttftMs > 0)
  const fast = kept.filter((row) => row.speed > 0)
  return {
    requests: kept,
    stream: live ?? null,
    avg: {
      requests: kept.length,
      ttftMs: timed.length === 0 ? 0 : round6(timed.reduce((sum, row) => sum + row.ttftMs, 0) / timed.length),
      speed: fast.length === 0 ? 0 : round6(fast.reduce((sum, row) => sum + row.speed, 0) / fast.length),
      durationMs: kept.length === 0 ? 0 : round6(kept.reduce((sum, row) => sum + row.durationMs, 0) / kept.length),
      inputTokens:
        kept.length === 0 ? 0 : Math.round(kept.reduce((sum, row) => sum + row.inputTokens, 0) / kept.length),
      outputTokens:
        kept.length === 0 ? 0 : Math.round(kept.reduce((sum, row) => sum + row.outputTokens, 0) / kept.length),
    },
  }
}
