/**
 * The retry engine: policy decisions shared by two composable layers.
 *
 * ## Why two layers, and what each one may do
 *
 * DSH's own retry executor (`@deepseek-ai/dsh-llm-retry`) recovers failures on
 * the `agent/request-error` waterfall, and its README states the constraint
 * that shapes this file: a raw `llm/stream` wrapper "cannot separate
 * already-emitted chunks durably, while the loop can re-run the failed step
 * inside the same open turn". So:
 *
 * - **Retry** belongs to `agent/request-error` only. Returning `{ kind:'retry' }`
 *   makes the loop re-run the failed step over the same durable history. Our
 *   listener delegates to `next()` whenever it has nothing to add, so the
 *   shipped policy keeps working when this plugin is neutral.
 * - **Switching route** is the one thing the loop cannot do: it re-runs the step
 *   with the step's captured model selection. Only `llm/stream` sees
 *   `GenerateOptions`, so failover lives there — and it switches *only before
 *   the first chunk reaches the consumer*, because splicing two providers'
 *   output into one assistant message would corrupt the log.
 *
 * A failure after content has already streamed is therefore handed back: the
 * wrapper yields the terminal error chunk unchanged and the `agent/request-error`
 * layer decides whether the whole step is retried.
 */

import { appendJsonLine, dataDir, readJsonLines } from '../core/store.js'

const LEDGER = () => dataDir('retry-events.jsonl')
const MAX_EVENTS = 500

/** Marks a `GenerateOptions` this wrapper created for a failover re-issue. */
const REISSUED = Symbol.for('dsh-mydsh.reissued')

/** Normalise the numeric status a failure may carry. */
function statusOf(failure) {
  const status = failure?.status
  return typeof status === 'number' ? status : undefined
}

/**
 * Decide how one failure should be treated.
 * @param failure - `{ message, code, status?, providerRetryAfterMs? }`.
 * @param config - the `retry` settings section.
 * @param attempts - attempts already made for this request.
 * @returns `{action:'retry', delayMs}` | `{action:'switch'}` | `{action:'delegate'}`.
 */
export function decide(failure, config, attempts) {
  if (config.enabled !== true) return { action: 'delegate' }
  const code = typeof failure?.code === 'string' ? failure.code : ''
  const status = statusOf(failure)

  let rule
  for (const candidate of config.policies ?? []) {
    if (candidate.match === 'any') {
      rule = candidate
      break
    }
    if (candidate.match === 'status' && status !== undefined && candidate.values.includes(String(status))) {
      rule = candidate
      break
    }
    if (candidate.match === 'code' && code !== '' && candidate.values.includes(code)) {
      rule = candidate
      break
    }
  }
  // No rule matched: stay out of the way so the shipped policy still applies.
  if (rule === undefined) return { action: 'delegate' }

  if (rule.action === 'fail') return { action: 'delegate' }
  if (attempts >= (rule.maxAttempts ?? 1)) return { action: 'delegate' }
  if (rule.action === 'switch') return { action: 'switch' }

  const base = Math.max(0, rule.delayMs ?? 0)
  const grown = rule.backoff === 'exponential' ? base * 2 ** Math.max(0, attempts - 1) : base
  const hinted =
    rule.respectRetryAfter === true && typeof failure?.providerRetryAfterMs === 'number'
      ? Math.max(grown, failure.providerRetryAfterMs)
      : grown
  return { action: 'retry', delayMs: Math.min(hinted, 60000) }
}

/**
 * Resolve the next route to try after a failure.
 * @param current - `{ provider, model }` in use.
 * @param config - the `retry` settings section.
 * @param used - routes already attempted for this request.
 * @returns the next route, or `undefined` when the chain is exhausted.
 */
export function nextRoute(current, config, used) {
  const key = (route) => `${route.provider}\u0000${route.model}`
  const taken = new Set(used.map(key))
  taken.add(key(current))
  for (const candidate of config.chain ?? []) {
    if (taken.has(key(candidate))) continue
    const changesProvider = candidate.provider !== current.provider
    const changesModel = candidate.model !== current.model
    if (changesProvider && config.allowSwitchProvider !== true) continue
    if (!changesProvider && changesModel && config.allowSwitchModel !== true) continue
    return candidate
  }
  return undefined
}

/**
 * Create the retry engine.
 * @param options - `getSettings()` and an optional `onEvent` observer.
 */
export function createRetryEngine(options) {
  const getSettings = options.getSettings
  const onEvent = options.onEvent ?? (() => undefined)

  /** Per step, how many times this plugin has already intervened. */
  const attempts = new Map()

  /** Newest-first mirror of the ledger for the settings page. */
  const recent = []
  const stats = { seen: 0, retried: 0, switched: 0, delegated: 0 }

  /** Load the ledger once, on the first page read. */
  async function hydrate() {
    if (recent.length > 0) return
    for (const entry of (await readJsonLines(LEDGER())).slice(-MAX_EVENTS)) recent.push(entry)
  }

  /** Append one decision to the mirror and the durable ledger. */
  function record(event) {
    recent.push(event)
    if (recent.length > MAX_EVENTS) recent.splice(0, recent.length - MAX_EVENTS)
    if (event.action === 'retry') stats.retried++
    else if (event.action === 'switch') stats.switched++
    else stats.delegated++
    appendJsonLine(LEDGER(), event).catch(() => undefined)
    onEvent(event)
  }

  /** Wait out a backoff, resolving early when the turn is cancelled. */
  function waitFor(delayMs, signal) {
    if (delayMs <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(finish, delayMs)
      function finish() {
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  /**
   * The `agent/request-error` listener.
   *
   * Returns `{ kind:'retry' }` only when this plugin's own rule asks for
   * another attempt; every other outcome calls `next()` so a mounted
   * `dsh-llm-retry` keeps its provider-policy behaviour.
   *
   * @param payload - `{ agent, turn, step, provider, failure, retryPolicy, signal }`.
   * @param next - the rest of the waterfall.
   */
  async function onRequestError(payload, next) {
    const config = getSettings().retry
    if (config.enabled !== true) return next()

    stats.seen++
    const sessionId = String(payload?.agent?.id ?? '')
    const stepKey = `${sessionId}:${payload?.turn ?? 0}:${payload?.step ?? 0}`
    const made = (attempts.get(stepKey) ?? 0) + 1
    const decision = decide(payload?.failure, config, made)
    const base = {
      at: Date.now(),
      sessionId,
      provider: payload?.provider ?? '',
      model: payload?.model ?? '',
      code: payload?.failure?.code ?? '',
      status: statusOf(payload?.failure) ?? 0,
      attempt: made,
      layer: 'agent/request-error',
    }

    if (decision.action === 'delegate') {
      attempts.delete(stepKey)
      record({ ...base, action: 'delegate' })
      return next()
    }

    if (decision.action === 'switch') {
      // The step re-runs with the same model selection, so a switch is only
      // actionable through llm/stream. Authorising the retry here lets that
      // wrapper perform the failover on the next attempt.
      const target = payload?.provider === undefined ? undefined : planSwitch(sessionId, config)
      if (target === undefined) {
        attempts.delete(stepKey)
        record({ ...base, action: 'delegate', reason: 'no-route-left' })
        return next()
      }
      attempts.set(stepKey, made)
      record({ ...base, action: 'switch', nextProvider: target.provider, nextModel: target.model })
      return { kind: 'retry' }
    }

    attempts.set(stepKey, made)
    record({ ...base, action: 'retry', delayMs: decision.delayMs })
    await waitFor(decision.delayMs, payload?.signal)
    return { kind: 'retry' }
  }

  /** Remember the route a session's next request should start on. */
  const plannedSwitch = new Map()

  /** Record and return the next route for one session. */
  function planSwitch(sessionId, config) {
    const current = plannedSwitch.get(sessionId)
    if (current === undefined) return undefined
    const target = nextRoute(current, config, current.used ?? [])
    if (target === undefined) return undefined
    plannedSwitch.set(sessionId, {
      provider: target.provider,
      model: target.model,
      used: [...(current.used ?? []), current],
    })
    return target
  }

  /**
   * Tell the engine which route a request started on, so `switch` can plan.
   * Called from the `llm/stream` wrapper before it dispatches.
   * @param sessionId - owning session, or `''` for a direct call.
   * @param route - `{ provider, model }`.
   */
  function observeRoute(sessionId, route) {
    if (!plannedSwitch.has(sessionId)) plannedSwitch.set(sessionId, { ...route, used: [] })
  }

  /**
   * The `llm/stream` wrapper that performs failover.
   *
   * It re-issues the request through a fresh waterfall run against the next
   * route, with two hard limits: it never switches after a chunk has reached
   * the consumer, and it never exceeds `maxSwitchPerRequest`. Re-dispatch goes
   * through `llm.stream()` under a re-entry flag, because the waterfall's
   * `next()` cannot change the request.
   *
   * @param llm - the `llm` service (`this` inside the listener).
   * @param options - the `GenerateOptions` for this call.
   * @param next - the remaining waterfall.
   */
  function makeStreamWrapper(llm) {
    return function onLlmStream(options, next) {
      const config = getSettings().retry
      // A failover re-issues through `llm.stream()`, which re-enters this very
      // listener. The marker rides on the options object we created, so the
      // guard holds for the whole lifetime of that call instead of a scope we
      // might leave too early.
      if (options !== null && typeof options === 'object' && options[REISSUED] === true) return next()
      if (config.enabled !== true || (config.chain ?? []).length === 0) return next()

      return {
        async *[Symbol.asyncIterator]() {
          let current = { provider: options.provider, model: options.model }
          let dispatch = next
          const used = []

          for (;;) {
            const outcome = yield* pump(dispatch(), config)
            if (outcome.failure === undefined) return
            // An abort is the user stopping the turn, never a failover cue.
            if (outcome.aborted) return
            // Content already reached the consumer; splicing a second provider
            // onto it would put two answers in one assistant message.
            if (outcome.emitted) return
            if (used.length >= (config.maxSwitchPerRequest ?? 3)) return
            if (decide(outcome.failure, config, used.length + 1).action !== 'switch') return

            used.push(current)
            const target = nextRoute(current, config, used)
            if (target === undefined) return

            record({
              at: Date.now(),
              sessionId: '',
              provider: current.provider,
              model: current.model,
              code: outcome.failure.code ?? '',
              status: statusOf(outcome.failure) ?? 0,
              attempt: used.length,
              action: 'switch',
              nextProvider: target.provider,
              nextModel: target.model,
              layer: 'llm/stream',
            })

            current = target
            const reissued = { ...options, provider: target.provider, model: target.model }
            reissued[REISSUED] = true
            dispatch = () => llm.stream(reissued)
          }
        },
      }
    }
  }

  /**
   * Run one attempt, forwarding its chunks.
   *
   * A terminal `error` finish chunk is held back rather than forwarded: the
   * caller may switch routes and must not leak a failure it is about to mask.
   * An `aborted` finish is forwarded, because the turn really did stop.
   *
   * @param stream - the chunk stream for this attempt.
   * @param config - the `retry` settings section.
   * @returns `{ failure, emitted, aborted }` describing how the attempt ended.
   */
  async function* pump(stream, config) {
    let emitted = false
    let failure
    for await (const chunk of stream) {
      if (chunk?.type === 'finish') {
        if (chunk.reason?.kind === 'error') {
          failure = chunk.reason.failure
          continue
        }
        if (chunk.reason?.kind === 'aborted') {
          yield chunk
          return { failure: chunk.reason.failure, emitted, aborted: true }
        }
        if (chunk.reason?.kind === 'stop' || chunk.reason?.kind === 'tool-calls' || chunk.reason?.kind === 'max-tokens') {
          yield chunk
          return { failure: undefined, emitted: true, aborted: false }
        }
      }
      emitted = true
      yield chunk
    }
    return { failure, emitted, aborted: false }
  }

  return {
    onRequestError,
    makeStreamWrapper,
    observeRoute,
    recent: () => recent,
    stats: () => ({ ...stats }),
    hydrate,
    /**
     * Evaluate one synthetic failure against the current rules without doing
     * anything about it.
     *
     * The settings page needs this to answer "what would happen if a 429 arrived
     * now" — the alternative is to make the user wait for a real failure to find
     * out their rules do not match. It reports the same decision the live path
     * would take, plus the ordered route that a switch would move to.
     *
     * @param failure - `{ status?, code?, message? }` from the page.
     * @returns `{ ok, decision, rule, nextRoute, plan }`.
     */
    dryRun(failure) {
      const config = getSettings()?.retry ?? {}
      const input = failure !== null && typeof failure === 'object' ? failure : {}
      const normalized = {
        message: typeof input.message === 'string' ? input.message : `synthetic ${input.status ?? input.code ?? ''}`.trim(),
        code: typeof input.code === 'string' ? input.code : undefined,
        status: Number.isFinite(Number(input.status)) ? Number(input.status) : undefined,
      }
      const decision = decide(normalized, config, 0)
      const matched = (config.policies ?? []).find((candidate) => {
        if (candidate.enabled === false) return false
        if (candidate.match === 'any') return true
        if (candidate.match === 'status') {
          return normalized.status !== undefined && candidate.values.includes(String(normalized.status))
        }
        if (candidate.match === 'code') {
          return normalized.code !== undefined && candidate.values.includes(normalized.code)
        }
        return false
      })
      const planned = decision.action === 'switch'
        ? nextRoute(normalized, config, [])
        : undefined
      return {
        ok: true,
        enabled: config.enabled === true,
        decision,
        rule: matched === undefined
          ? null
          : { id: matched.id, label: matched.label, match: matched.match, values: matched.values, action: matched.action },
        nextRoute: planned ?? null,
        plan: (config.chain ?? []).map((entry) => `${entry.provider} / ${entry.model}`),
      }
    },
    reset() {
      recent.length = 0
      attempts.clear()
      plannedSwitch.clear()
      stats.seen = 0
      stats.retried = 0
      stats.switched = 0
      stats.delegated = 0
    },
  }
}
