/**
 * Shared helpers for the usage engine: numbers, time windows, series buckets,
 * money, LRU caches, and the fixed-density token estimate.
 *
 * Everything here is pure or module-level. The engine files import these so the
 * same rounding, the same local-midnight arithmetic and the same token density
 * are used by the summary, the context panel and the price list. Three copies of
 * "how big is this message" would drift apart within a week.
 */

export const DAY_MS = 86400000

/** Rows the usage page can render; a wider window widens the stride. */
export const MAX_SERIES_POINTS = 120

/** Points a context trend may carry before it is subsampled. */
export const MAX_CONTEXT_POINTS = 200

/** Entries one fold or context cache keeps before LRU eviction. */
export const CACHE_LIMIT = 120

/** Sessions read per event-loop batch, so a long scan cannot starve routes. */
export const READ_BATCH = 4

/**
 * Freshness grace window.
 *
 * A page refresh fires summary + sessions + budgets almost together. Within one
 * second the log cannot have changed in a way the page could observe, so the
 * second and third call reuse the first call's validation instead of paying for
 * three `listEvents()` per session.
 */
export const FRESHNESS_TTL_MS = 1000

/** Composite dimension keys are `provider::model` and travel to the client. */
export const SEP = '::'

/** Bucket of last resort for sessions we cannot attribute. */
export const UNKNOWN = '(unknown)'

/**
 * The seven context buckets, in the order the panel stacks them.
 *
 * Order is deliberate: the prompt parts that are fixed before the turn (system
 * prompt, tool schemas) sit at the bottom of the bar, the parts that grow as the
 * conversation proceeds sit above them.
 */
export const BUCKET_KEYS = Object.freeze([
  'systemPrompt',
  'toolDefinitions',
  'userMessages',
  'injected',
  'skills',
  'assistantMessages',
  'toolResults',
])

/** Human labels for the seven buckets, kept here so both halves agree. */
export const BUCKET_LABELS = Object.freeze({
  systemPrompt: 'System prompt',
  toolDefinitions: 'Tool definitions',
  userMessages: 'User messages',
  injected: 'Injected context',
  skills: 'Skills',
  assistantMessages: 'Assistant messages',
  toolResults: 'Tool results',
})

/* ------------------------------------------------------------------ *
 * Numbers
 * ------------------------------------------------------------------ */

/** A non-negative finite number, or 0. Keeps every total free of `NaN`. */
export function countOf(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** A signed finite number, or 0. Used where a delta may legitimately be negative. */
export function finiteOf(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** A balance figure; providers send decimal strings, so accept both shapes. */
export function moneyOf(value) {
  return finiteOf(value)
}

/** Round to six decimals: enough for a fraction of a cent, no float noise. */
export function round6(value) {
  const parsed = finiteOf(value)
  return Math.round(parsed * 1e6) / 1e6
}

/** A ratio in `[0, 1]`, or 0 when the denominator is unusable. */
export function ratioOf(part, whole) {
  const top = countOf(part)
  const bottom = countOf(whole)
  return bottom > 0 && top > 0 ? Math.min(1, top / bottom) : 0
}

/**
 * Cache hit rate: cache reads over all prompt tokens.
 *
 * Providers that report no cache traffic return 0 rather than `NaN`, and a
 * provider that already folds cache reads into `inputTokens` still yields a
 * sensible share because both sides of the division agree.
 */
export function hitRateOf(cacheRead, input) {
  const cached = countOf(cacheRead)
  const uncached = countOf(input)
  const total = cached + uncached
  return total > 0 ? cached / total : 0
}

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

/** Keys already warned about, so a degraded path logs once instead of per call. */
const WARNED = new Set()

/** Warn once per key. A degraded read should not flood the Host log. */
export function warnOnce(key, message) {
  if (WARNED.has(key)) return
  if (WARNED.size >= 32) WARNED.clear()
  WARNED.add(key)
  console.warn(`[dsh-mydsh] ${message}`)
}

/** Error text without assuming the thrown value is an `Error`. */
export function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run `work` over `items` one at a time, in batches of `size`.
 *
 * Why sequential: a single session log can hold tens of thousands of events, so
 * two concurrent `readSession()` calls would double peak memory for no gain on a
 * warm cache. The batch boundary exists only to hand the event loop back, so a
 * 200-session scan cannot starve the other routes for the whole scan.
 */
export async function forEachBatch(items, size, work) {
  const stride = Math.max(1, size)
  for (let index = 0; index < items.length; index += stride) {
    const batch = items.slice(index, index + stride)
    for (const item of batch) {
      try {
        await work(item)
      } catch (error) {
        warnOnce('batch', `one session failed: ${describe(error)}`)
      }
    }
    if (index + stride < items.length) await new Promise((resolve) => setImmediate(resolve))
  }
}

/* ------------------------------------------------------------------ *
 * LRU maps
 * ------------------------------------------------------------------ */

/**
 * Insert into a `Map` used as an LRU list, then evict past `limit`.
 *
 * Re-inserting moves the key to the young end, because `Map` keeps insertion
 * order and eviction always pops the oldest key.
 */
export function lruSet(map, key, value, limit = CACHE_LIMIT) {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) {
    const oldest = map.keys().next()
    if (oldest.done === true) break
    map.delete(oldest.value)
  }
  return value
}

/** Read from an LRU map and mark the entry as freshly used. */
export function lruGet(map, key) {
  const value = map.get(key)
  if (value === undefined) return undefined
  map.delete(key)
  map.set(key, value)
  return value
}

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */

/** Conversion used for the display-only cross-currency merge, not for billing. */
export const USD_CNY = 7.25

/** Vendors that publish CNY prices; only these mirror and report CNY. */
export const CNY_PROVIDERS = Object.freeze(['deepseek', 'moonshot', 'zhipu', 'qwen'])

/** True when this provider prices in CNY. */
export function isCnyProvider(provider) {
  const key = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
  return key !== '' && CNY_PROVIDERS.includes(key)
}

/**
 * A two-currency accumulator.
 *
 * Cost is computed in the currency its price row publishes, so a DeepSeek user
 * reads CNY and an OpenAI user reads USD. Only at render time is a single
 * currency chosen (the larger bucket) and the minority converted, which keeps
 * every row internally consistent and every total free of invisible conversion.
 * @returns a fresh accumulator.
 */
export function newMoney() {
  return { cny: 0, usd: 0 }
}

/** Add one amount in its own currency. Non-finite amounts are ignored. */
export function addMoney(bucket, amount, currency) {
  const parsed = finiteOf(amount)
  if (parsed === 0) return bucket
  if (currency === 'CNY') bucket.cny += parsed
  else bucket.usd += parsed
  return bucket
}

/**
 * Materialise an accumulator.
 * @param bucket - the accumulator.
 * @param hint - currency to report when nothing has been added yet.
 * @returns `{ cost, currency }` with the minority converted into the major one.
 */
export function moneyResult(bucket, hint = 'USD') {
  const cny = finiteOf(bucket?.cny)
  const usd = finiteOf(bucket?.usd)
  if (cny === 0 && usd === 0) return { cost: 0, currency: hint === 'CNY' ? 'CNY' : 'USD' }
  if (cny >= usd * USD_CNY) {
    return { cost: round6(cny + usd * USD_CNY), currency: 'CNY' }
  }
  return { cost: round6(usd + cny / USD_CNY), currency: 'USD' }
}

/** Convert one amount into the requested currency for comparisons. */
export function convertMoney(amount, from, to) {
  const parsed = finiteOf(amount)
  if (from === to) return parsed
  if (from === 'CNY' && to === 'USD') return parsed / USD_CNY
  if (from === 'USD' && to === 'CNY') return parsed * USD_CNY
  return parsed
}

/* ------------------------------------------------------------------ *
 * Time windows
 * ------------------------------------------------------------------ */

/** Human labels for the preset ranges, used as the `range.label` fallback. */
const RANGE_LABELS = Object.freeze({
  today: 'Today',
  '3d': 'Last 3 days',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
})

/** Preset ranges that span N calendar days including today. */
const RANGE_DAYS = Object.freeze({ '3d': 3, '7d': 7, '30d': 30, '90d': 90 })

/**
 * Resolve a range selector into a concrete local-time window.
 *
 * Everything is anchored to local midnight, because "today" means the user's
 * today, not UTC's. An unusable custom pair degrades to `today` rather than
 * throwing: the values come straight from user-editable query parameters.
 * @param options - `{ range, from, to }`.
 * @param retainDays - oldest day the caller wants to see; 0 keeps everything.
 * @returns `{ range, fromMs, toMs, label }`.
 */
export function resolveWindow(options = {}, retainDays = 0) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const requested = typeof source.range === 'string' ? source.range : 'today'
  const now = Date.now()
  const floor = retainDays > 0 ? now - retainDays * DAY_MS : 0

  if (requested === 'custom') {
    const fromMs = countOf(source.from)
    const toMs = countOf(source.to)
    if (fromMs > 0 && toMs > fromMs && fromMs < now + DAY_MS) {
      return {
        range: 'custom',
        fromMs: Math.max(fromMs, floor),
        toMs,
        label: `${monthDay(fromMs)} 鈥?${monthDay(toMs - 1)}`,
      }
    }
  }

  const days = RANGE_DAYS[requested] ?? 1
  const fromMs = days === 1 ? dayStartMs(now) : addDays(dayStartMs(now), -(days - 1))
  return {
    range: days === 1 ? 'today' : requested,
    fromMs: Math.max(fromMs, floor),
    toMs: now,
    label: RANGE_LABELS[days === 1 ? 'today' : requested] ?? `${monthDay(fromMs)} 鈥?${monthDay(now)}`,
  }
}

/** The window of one budget period, anchored to local midnight. */
export function periodWindow(period, now) {
  if (period === 'week') return { fromMs: weekStartMs(now), toMs: now }
  if (period === 'month') return { fromMs: monthStartMs(now), toMs: now }
  return { fromMs: dayStartMs(now), toMs: now }
}

/**
 * Build the empty series for a window plus a function mapping an event time to
 * its point index.
 *
 * `today` gets 24 hourly points so the day reads as a clock; every other range
 * gets whole days, and a custom range wider than `MAX_SERIES_POINTS` widens the
 * day stride instead of dropping days or falling back to hours.
 */
export function buildSeries(window) {
  const { range, fromMs, toMs } = window

  if (range === 'today') {
    const start = dayStartMs(fromMs)
    const points = []
    for (let hour = 0; hour < 24; hour += 1) {
      const mark = new Date(start)
      mark.setHours(hour, 0, 0, 0)
      points.push({ t: mark.getTime(), label: `${pad2(hour)}:00`, ...zeroPoint() })
    }
    return { points, index: (t) => new Date(t).getHours() }
  }

  const base = dayStartMs(fromMs)
  const baseDay = dayNumber(base)
  const totalDays = Math.max(1, dayNumber(Math.max(base, toMs - 1)) - baseDay + 1)
  const stride = Math.max(1, Math.ceil(totalDays / MAX_SERIES_POINTS))
  const count = Math.max(1, Math.ceil(totalDays / stride))
  const points = []
  for (let index = 0; index < count; index += 1) {
    const t = addDays(base, index * stride)
    points.push({ t, label: monthDay(t), ...zeroPoint() })
  }
  return {
    points,
    index: (t) => {
      const offset = dayNumber(t) - baseDay
      if (offset < 0) return -1
      const index = Math.floor(offset / stride)
      return index < points.length ? index : -1
    },
  }
}

/** A series point with every field the usage trend needs. */
export function zeroPoint() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, requests: 0, cost: 0 }
}

/** Local midnight of the day containing `ms`. */
export function dayStartMs(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Calendar day number (local date flattened to UTC midnight) for diffing. */
export function dayNumber(ms) {
  const date = new Date(ms)
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

/** Add whole calendar days, so DST days still land on the right date. */
export function addDays(ms, days) {
  const date = new Date(ms)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/** Local midnight of the ISO week that contains `ms` (Monday first). */
export function weekStartMs(ms) {
  const date = new Date(dayStartMs(ms))
  const offset = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - offset)
  return date.getTime()
}

/** Local midnight of the first day of the month containing `ms`. */
export function monthStartMs(ms) {
  const date = new Date(ms)
  date.setDate(1)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** `M/D` in local time. */
export function monthDay(ms) {
  const date = new Date(ms)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** Two-digit zero padding for hour labels. */
export function pad2(value) {
  return value < 10 ? `0${value}` : String(value)
}

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

/** Workspace identity for one session: the cwd, or an explicit unknown bucket. */
export function workspaceKey(header) {
  const cwd = typeof header?.cwd === 'string' && header.cwd.trim() !== '' ? header.cwd.trim() : ''
  if (cwd === '') return { key: UNKNOWN, label: UNKNOWN }
  return { key: cwd, label: baseName(cwd) }
}

/** Last path segment of a workspace path, for compact labels. */
export function baseName(path) {
  const trimmed = String(path).replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  const last = parts[parts.length - 1]
  return last === undefined || last === '' ? String(path) : last
}

/** Session row label: workspace basename plus enough of the id to tell rows apart. */
export function sessionRowLabel(header, sessionId) {
  const cwd = typeof header?.cwd === 'string' && header.cwd.trim() !== '' ? header.cwd.trim() : ''
  return `${cwd === '' ? UNKNOWN : baseName(cwd)} 路 ${shortId(sessionId)}`
}

/** Trailing six characters of an id: enough to disambiguate, short enough to read. */
export function shortId(sessionId) {
  const text = String(sessionId)
  return text.length <= 6 ? text : text.slice(-6)
}

/* ------------------------------------------------------------------ *
 * Token estimate
 * ------------------------------------------------------------------ */

/**
 * Fixed text density, matching `@deepseek-ai/dsh-token-meter`'s heuristic.
 *
 * Deliberately the same constants: the context panel shows an estimate on one
 * line and the Host's own meter shows the provider's figure on another, so an
 * estimator that disagreed with the Host's would look like a bug in this
 * plugin. `4` characters per token is the documented density there.
 */
const CHARS_PER_TOKEN = 4

/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every priced message. */
const ROLE_OVERHEAD = 4

/** Heuristic tokens for one plain string. */
export function estimateText(text) {
  if (typeof text !== 'string' || text === '') return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Price one content-block array under the fixed heuristic.
 * @param content - message content blocks.
 * @returns heuristic tokens including per-block structural overhead.
 */
export function estimateContent(content) {
  if (!Array.isArray(content)) return estimateText(typeof content === 'string' ? content : '')
  let tokens = 0
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const type = block.type
    if (type === 'text' || type === 'reasoning') {
      tokens += estimateText(block.text) + BLOCK_OVERHEAD
      continue
    }
    if (type === 'tool-call') {
      tokens += estimateText(block.name) + estimateText(block.arguments) + BLOCK_OVERHEAD
      continue
    }
    // Unknown blocks keep a conservative structural price rather than 0.
    try {
      tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    } catch {
      tokens += BLOCK_OVERHEAD
    }
  }
  return tokens
}

/**
 * Price one model-visible message.
 *
 * A system prompt is serialised by the adapter as one plain string, so it is
 * priced at text density plus role framing with no per-block overhead 鈥?the
 * same split the Host's meter makes.
 */
export function estimateMessage(message) {
  if (message === null || typeof message !== 'object') return 0
  const content = message.content
  if (message.role === 'system') {
    if (!Array.isArray(content)) return estimateText(typeof content === 'string' ? content : '') + ROLE_OVERHEAD
    let characters = 0
    for (const block of content) {
      if (block?.type === 'text') characters += String(block.text ?? '').length
      else {
        try {
          characters += JSON.stringify(block).length
        } catch {
          characters += 0
        }
      }
    }
    return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD
  }
  return estimateContent(content) + ROLE_OVERHEAD
}

/**
 * Price the tool-schema part of one request envelope.
 * @param tools - the `request/header.header.tools` array.
 * @returns heuristic tool-schema tokens; 0 when absent or empty.
 */
export function estimateToolsTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0
  try {
    return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  } catch {
    return 0
  }
}

/**
 * Scale bucket counts so they sum exactly to `target`.
 *
 * The panel shows one absolute number (provider pressure when the provider
 * reported it) and a composition beneath it. Scaling the composition instead of
 * showing two unrelated numbers keeps "the parts add up to the whole" true even
 * when the provider's tokenizer and our density heuristic disagree.
 *
 * Largest-remainder rounding is used, so the sum is exact rather than
 * approximately exact, and an all-zero input yields an even split.
 * @param buckets - `{ key: tokens }`.
 * @param target - wanted total.
 * @returns a new `{ key: tokens }` with integer values summing to `target`.
 */
export function scaleBuckets(buckets, target) {
  const wanted = Math.max(0, Math.round(countOf(target)))
  const keys = Object.keys(buckets)
  const total = keys.reduce((sum, key) => sum + countOf(buckets[key]), 0)
  const out = {}
  if (wanted === 0) {
    for (const key of keys) out[key] = 0
    return out
  }
  if (total === 0) {
    // Nothing measured: the split is unknown, so report it all as one bucket
    // rather than inventing a composition nobody can explain.
    for (const key of keys) out[key] = 0
    out[keys.includes('injected') ? 'injected' : keys[0]] = wanted
    return out
  }
  const remainders = []
  let assigned = 0
  for (const key of keys) {
    const exact = (countOf(buckets[key]) / total) * wanted
    const base = Math.floor(exact)
    out[key] = base
    assigned += base
    remainders.push({ key, rest: exact - base })
  }
  remainders.sort((left, right) => right.rest - left.rest || left.key.localeCompare(right.key))
  let index = 0
  while (assigned < wanted && index < remainders.length) {
    out[remainders[index].key] += 1
    assigned += 1
    index += 1
  }
  return out
}

/** Sum of a `{ key: tokens }` record. */
export function sumBuckets(buckets) {
  let total = 0
  for (const value of Object.values(buckets ?? {})) total += countOf(value)
  return total
}

/**
 * One-line preview of a message, for the context browser.
 * Collapses whitespace because a tool result is usually a wall of JSON and the
 * browser row shows one line of it.
 */
export function previewOf(content, limit = 140) {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (parts.length >= 3) break
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      else if (block?.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
      else if (block?.type === 'tool-call') parts.push(`${block.name ?? 'tool'}(${block.arguments ?? ''})`)
      else if (block !== null && typeof block === 'object') {
        try {
          parts.push(JSON.stringify(block))
        } catch {
          parts.push('')
        }
      }
    }
    text = parts.join(' ')
  }
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= limit) return collapsed
  // U+2026 HORIZONTAL ELLIPSIS, written as an escape so a re-encode of this file
  // cannot truncate a multi-byte character mid-sequence again.
  return `${collapsed.slice(0, limit - 1)}\u2026`
}
