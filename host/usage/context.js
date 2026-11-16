/**
 * Context insight: what the model window is made of, how it grew, and where the
 * bytes came from.
 *
 * The whole file answers one question honestly: "what is in my context right
 * now?" Everything is derived from the durable session log, in one pass, and
 * bucketed into the seven categories the panel stacks:
 *
 *   systemPrompt · toolDefinitions · userMessages · injected · skills ·
 *   assistantMessages · toolResults
 *
 * Three deliberate choices:
 *
 *  - `usedTokens` prefers the provider's own prompt size when it reported one.
 *    The buckets are then scaled to that figure, so the ring chart and the
 *    provider's bill never disagree. When no provider figure exists (a fresh
 *    session, a local adapter) the estimate stands on its own.
 *  - Injected context and skills are separated from real user messages, because
 *    a user who sees 40k tokens of "user" content needs to know that 35k of it
 *    was time/sandbox/skill injection rather than their own words.
 *  - Previews are short. A tool result can be a hundred kilobytes; the browser
 *    shows one line and the detail view re-reads the log on demand.
 */

import {
  BUCKET_KEYS,
  BUCKET_LABELS,
  MAX_CONTEXT_POINTS,
  UNKNOWN,
  countOf,
  estimateMessage,
  estimateToolsTokens,
  previewOf,
  scaleBuckets,
  sumBuckets,
} from './support.js'

/** Browser rows kept per category, and previews kept short. */
const BROWSER_ITEMS_PER_CATEGORY = 40
const PREVIEW_CHARS = 140

/** Context events carried in one payload; the rest are paged through the route. */
const EVENTS_PER_PAYLOAD = 400

/** Static windows, used only when neither the log nor the catalogue reports one. */
const STATIC_WINDOWS = Object.freeze({
  'deepseek-chat': 128000,
  'deepseek-reasoner': 128000,
  deepseek: 128000,
  anthropic: 200000,
  google: 1000000,
  openai: 128000,
})

/**
 * Context windows a browser page may report, without a catalogue round trip.
 * Anything absent reports 0 ("unknown") instead of guessing, because a wrong
 * window makes the pressure bar lie.
 */
export function staticContextWindow(provider, model) {
  const name = typeof model === 'string' ? model : ''
  const id = typeof provider === 'string' ? provider : ''
  return countOf(STATIC_WINDOWS[name]) || countOf(STATIC_WINDOWS[id])
}

/**
 * Which bucket one surface event belongs to.
 * @returns `{ category, reason }`, or `undefined` when the event is not
 *   model-visible.
 */
function classify(event) {
  const type = event?.type
  if (type === 'system/message') return { category: 'systemPrompt', reason: 'system prompt' }
  if (type === 'assistant/message' || type === 'assistant/attempt') {
    return { category: 'assistantMessages', reason: 'assistant reply' }
  }
  if (type === 'tool/result') return { category: 'toolResults', reason: 'tool result' }
  if (type === 'user/message') {
    const source = event?.data?.source
    const kind = typeof source?.kind === 'string' ? source.kind : 'user'
    if (kind === 'user') return { category: 'userMessages', reason: 'user message' }
    if (kind === 'skill-catalog') return { category: 'skills', reason: 'skill catalogue' }
    // Every other source is harness-injected: time context, sandbox policy,
    // approval policy, subagent identity, settled-subagent notices, and any
    // future kind. Reporting them as user text would be a lie.
    return { category: 'injected', reason: `injected · ${kind}` }
  }
  return undefined
}

/** The message an event carries, wherever the envelope puts it. */
function messageOf(event) {
  const data = event?.data
  if (data === null || typeof data !== 'object') return undefined
  if (data.message !== null && typeof data.message === 'object') return data.message
  if (Array.isArray(data.content)) return { role: 'user', content: data.content }
  return undefined
}

/**
 * Fold one event log into the current context model.
 *
 * Surface replacements are honoured: an event carrying `surfaceOp` other than
 * `append` shadows the range it names, which is what compaction does. Ignoring
 * that would double-count a summarised history and show a context far larger
 * than the model actually holds.
 * @param events - raw events in log order.
 * @returns the model `{ nodes, buckets, browsers, series, events, reported, ... }`.
 */
export function foldContext(events) {
  /** Live surface nodes, in order: `{ seq, category, tokens, preview, turn, at, label }`. */
  let nodes = []
  /** Latest tool-schema price, from the newest `request/header`. */
  let toolsTokens = 0
  let toolsCount = 0
  let toolsSeq = -1
  let provider = UNKNOWN
  let model = UNKNOWN
  let contextWindow = 0
  /** Cumulative pressure after each settled request, for the trend. */
  const series = []
  /** Every context event, for the browser's drill-down and the panels' markers. */
  const eventsOut = []
  let reported = 0
  let reportedAt = 0
  let lastTurn = -1
  let lastStep = -1

  const push = (node) => {
    nodes.push(node)
  }

  /** Apply a surface replacement: drop the shadowed range, then append. */
  const replace = (op) => {
    const start = countOf(op?.startSeq)
    const end = countOf(op?.endSeq)
    nodes = nodes.filter((node) => node.seq < start || node.seq > end)
  }

  for (const event of events) {
    const type = event?.type
    const seq = countOf(event?.seq)
    const at = countOf(event?.time)

    if (type === 'request/header') {
      const config = event?.data?.header?.config
      if (typeof config?.provider === 'string' && config.provider !== '') provider = config.provider
      if (typeof config?.model === 'string' && config.model !== '') model = config.model
      const tools = event?.data?.header?.tools
      toolsTokens = estimateToolsTokens(tools)
      toolsCount = Array.isArray(tools) ? tools.length : 0
      toolsSeq = seq
      continue
    }

    if (type === 'request/context') {
      if (typeof event?.data?.provider === 'string' && event.data.provider !== '') provider = event.data.provider
      if (typeof event?.data?.model === 'string' && event.data.model !== '') model = event.data.model
      const window = countOf(event?.data?.contextWindow)
      if (window > 0) contextWindow = window
      continue
    }

    const classified = classify(event)
    if (classified === undefined) continue

    const message = messageOf(event)
    const tokens = estimateMessage(message)
    const turn = typeof event?.data?.turn === 'number' ? event.data.turn : lastTurn
    if (typeof event?.data?.turn === 'number') lastTurn = event.data.turn
    if (typeof event?.data?.step === 'number') lastStep = event.data.step

    const op = event?.surfaceOp
    if (op !== undefined && op !== 'append' && typeof op === 'object') replace(op)

    const node = {
      seq,
      at,
      turn,
      step: lastStep,
      category: classified.category,
      tokens,
      label: classified.reason,
      preview: previewOf(message?.content ?? '', PREVIEW_CHARS),
    }
    push(node)
    eventsOut.push({
      at,
      seq,
      category: classified.category,
      description: classified.reason,
      tokens,
      delta: 0,
      turn,
    })

    // Only a settled assistant message carries a provider prompt size; that is
    // the sample the pressure bar is anchored to.
    if (type === 'assistant/message') {
      const usage = event?.data?.usage
      if (usage !== undefined && usage !== null) {
        const pressure =
          countOf(usage.inputTokens) + countOf(usage.cacheReadTokens) + countOf(usage.cacheWriteTokens)
        if (pressure > 0) {
          reported = pressure
          reportedAt = at
        }
        const snapshot = bucketCounts(nodes, toolsTokens)
        const cumulative = sumBuckets(snapshot)
        series.push({
          t: at,
          label: `T${turn}/S${lastStep}`,
          turn,
          step: lastStep,
          usedTokens: Math.max(pressure, cumulative),
          buckets: scaleBuckets(snapshot, Math.max(pressure, cumulative)),
          outputTokens: countOf(usage.outputTokens),
        })
      }
    }
  }

  const bucketsRaw = bucketCounts(nodes, toolsTokens)
  const estimate = sumBuckets(bucketsRaw)

  return {
    provider,
    model,
    contextWindow,
    bucketsRaw,
    estimate,
    reported,
    reportedAt,
    series,
    events: eventsOut,
    nodes,
    nodesTotal: nodes.length,
    toolsCount,
    toolsSeq,
  }
}

/** Sum one node list into the seven-bucket record. */
function bucketCounts(nodes, toolsTokens) {
  const buckets = {}
  for (const key of BUCKET_KEYS) buckets[key] = 0
  for (const node of nodes) {
    if (buckets[node.category] === undefined) continue
    buckets[node.category] += countOf(node.tokens)
  }
  // Tool schemas are priced from the latest request envelope, not per event:
  // they are one block repeated in every request.
  buckets.toolDefinitions = countOf(toolsTokens)
  return buckets
}

/**
 * Build the `/usage/context` payload from a folded model.
 *
 * @param model - the model from `foldContext()`.
 * @param options - `{ sessionId, mode, windowTokens }`.
 * @returns the contract payload.
 */
export function contextPayload(model, options = {}) {
  const mode = options.mode === 'next' ? 'next' : 'current'
  const windowTokens = countOf(options.windowTokens) || countOf(model.contextWindow)
  // `next` answers "what would the next request cost", which is the surface we
  // can price ourselves. `current` answers "what does the provider say it holds
  // right now", which is the only number a bill can be checked against.
  const usedTokens = mode === 'next' ? model.estimate : model.reported > 0 ? model.reported : model.estimate
  const scaled = scaleBuckets(model.bucketsRaw, usedTokens)

  const buckets = BUCKET_KEYS.map((key) => ({
    key,
    label: BUCKET_LABELS[key],
    tokens: scaled[key],
    ratio: usedTokens > 0 ? scaled[key] / usedTokens : 0,
  }))

  const browsers = buildBrowsers(model, scaled)
  const series = buildSeries(model, windowTokens)

  return {
    available: model.nodesTotal > 0 || model.reported > 0,
    sessionId: typeof options.sessionId === 'string' ? options.sessionId : '',
    provider: model.provider,
    model: model.model,
    usedTokens,
    windowTokens,
    ratio: windowTokens > 0 ? Math.min(1, usedTokens / windowTokens) : 0,
    estimateTokens: model.estimate,
    reportedTokens: model.reported,
    mode,
    buckets,
    series,
    browsers,
    events: model.events.slice(-EVENTS_PER_PAYLOAD),
  }
}

/**
 * One drillable row per category, plus its largest members.
 *
 * The row itself is what the browser's first level shows (category, total,
 * count, one-line preview); the members let a panel open the top few without a
 * second request. Deeper paging goes through `contextEvents()`.
 */
function buildBrowsers(model, scaled) {
  const rows = []
  for (const key of BUCKET_KEYS) {
    const members = model.nodes.filter((node) => node.category === key)
    if (members.length === 0 && countOf(scaled[key]) === 0) continue
    const total = members.reduce((sum, node) => sum + countOf(node.tokens), 0)
    const largest = members.reduce(
      (best, node) => (best === undefined || node.tokens > best.tokens ? node : best),
      undefined,
    )
    rows.push({
      category: key,
      label: BUCKET_LABELS[key],
      tokens: countOf(scaled[key]),
      count: members.length,
      preview: largest === undefined ? '' : largest.preview,
      seq: largest === undefined ? -1 : largest.seq,
      items: members
        .slice()
        .sort((left, right) => right.tokens - left.tokens)
        .slice(0, BROWSER_ITEMS_PER_CATEGORY)
        .map((node) => ({
          seq: node.seq,
          at: node.at,
          turn: node.turn,
          tokens: node.tokens,
          preview: node.preview,
        })),
    })
  }
  return rows
}

/**
 * Stacked evolution of the context, one point per settled request.
 *
 * Points carry the seven buckets so the panel can draw a stacked area without
 * re-deriving anything. Very long sessions are subsampled evenly rather than
 * truncated, so the shape of the growth is preserved.
 */
function buildSeries(model, windowTokens) {
  const source = model.series
  if (source.length === 0) return []
  const stride = Math.max(1, Math.ceil(source.length / MAX_CONTEXT_POINTS))
  const points = []
  for (let index = 0; index < source.length; index += stride) {
    const point = source[index]
    points.push({
      t: point.t,
      label: point.label,
      turn: point.turn,
      step: point.step,
      usedTokens: point.usedTokens,
      ratio: windowTokens > 0 ? Math.min(1, point.usedTokens / windowTokens) : 0,
      buckets: point.buckets,
      outputTokens: point.outputTokens,
    })
  }
  // The newest point is the current state; dropping it would make the trend end
  // before the present. It is appended when subsampling skipped it.
  const last = source[source.length - 1]
  if (points[points.length - 1]?.t !== last.t) {
    points.push({
      t: last.t,
      label: last.label,
      turn: last.turn,
      step: last.step,
      usedTokens: last.usedTokens,
      ratio: windowTokens > 0 ? Math.min(1, last.usedTokens / windowTokens) : 0,
      buckets: last.buckets,
      outputTokens: last.outputTokens,
    })
  }
  return points
}

/**
 * One page of context events, optionally filtered by category.
 *
 * Newest first, because a browser opens on what just happened rather than on
 * the system prompt from three hours ago.
 * @param model - the model from `foldContext()`.
 * @param request - `{ category, offset, limit }`.
 * @returns `{ total, items }`.
 */
export function contextEventPage(model, request = {}) {
  const category = typeof request.category === 'string' ? request.category.trim() : ''
  const offset = Math.max(0, Math.round(countOf(request.offset)))
  const limit = Math.min(200, Math.max(1, Math.round(countOf(request.limit) || 50)))
  const all = model?.events ?? []
  const filtered = category === '' ? all : all.filter((event) => event.category === category)
  const newestFirst = filtered.slice().reverse()
  const items = newestFirst.slice(offset, offset + limit)
  return { total: newestFirst.length, items }
}
