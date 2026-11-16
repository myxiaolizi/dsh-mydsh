/**
 * Balance and quota lookups.
 *
 * This is the only place in the usage engine that touches the network, and it
 * only does so when the user turned it on:
 *
 *  - `usage.balance.deepseek` talks to the official endpoint with the standard
 *    `{baseUrl}/user/balance` shape.
 *  - `usage.balance.providers[]` is a generic HTTP probe: method, headers, body
 *    and two dotted paths into the JSON answer. That covers every vendor that
 *    publishes a balance endpoint without adding a client per vendor.
 *
 * Every failure mode returns a row with `ok: false` and a short `message`, never
 * a thrown error: a provider being down, a key expiring and a missing network
 * must all look like "no number right now", because the page renders the rest of
 * the usage tab around this figure. The check itself is cached for
 * `ttlSeconds` so a polling page cannot burn the vendor's rate limit.
 */

import { countOf, describe, finiteOf, warnOnce } from './support.js'

/** Hard ceiling on one lookup; a balance check must never hold a route open. */
const TIMEOUT_MS = 10000

/** Requests this module allows itself, even if settings ask for more. */
const MAX_PROVIDERS = 16

/**
 * Cached lookup results, keyed by provider id.
 * Module-level so the cache survives engine rebuilds during a Host reload.
 * @type {Map<string, { at: number, expiresAt: number, value: object }>}
 */
const BALANCE_CACHE = new Map()

/** An empty row for a provider that is configured but has not answered yet. */
function emptyRow(id, label, source) {
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

/**
 * Read a dotted path out of a JSON answer.
 *
 * Settings carry a path as text (`data.balance`, `result.0.total`), so numeric
 * segments index into arrays. A path that does not resolve returns `undefined`
 * and the caller decides what "missing" means; this never throws.
 */
export function readPath(value, path) {
  const text = typeof path === 'string' ? path.trim() : ''
  if (text === '') return undefined
  let current = value
  for (const segment of text.split('.')) {
    if (current === null || current === undefined) return undefined
    if (segment === '') continue
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10)
      if (!Number.isFinite(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
      continue
    }
    if (typeof current !== 'object') return undefined
    current = current[segment]
  }
  return current
}

/**
 * Parse the settings' `headers` field into a request header map.
 *
 * The field is one text box, so three shapes are accepted: a JSON object (the
 * documented form), `key: value` lines (what people paste from curl), and an
 * empty string. A malformed value yields an empty map instead of failing the
 * lookup, because a broken header is worth a degraded row and not a 500.
 */
export function parseHeaders(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw === '') return {}
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out = {}
        for (const [key, value] of Object.entries(parsed)) {
          if (value === undefined || value === null) continue
          out[String(key)] = String(value)
        }
        return out
      }
    } catch {
      // Fall through to the line format.
    }
  }
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const at = trimmed.indexOf(':')
    if (at <= 0) continue
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return out
}

/** Parse a settings `body` field into the request payload, if there is one. */
function parseBody(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * Perform one bounded lookup and normalise it into a BalanceRow.
 * @param probe - `{ id, label, url, method, headers, body, totalPath, currencyPath, currency, source }`.
 * @returns a BalanceRow; never throws.
 */
async function probeBalance(probe) {
  const at = Date.now()
  const row = emptyRow(probe.id, probe.label, probe.source)
  row.currency = probe.currency
  row.at = at

  if (typeof probe.url !== 'string' || probe.url.trim() === '') {
    row.message = 'no-url'
    return row
  }
  if (typeof fetch !== 'function') {
    row.message = 'fetch-unavailable'
    return row
  }

  const started = Date.now()
  try {
    const init = {
      method: probe.method === 'POST' ? 'POST' : 'GET',
      headers: { accept: 'application/json', ...probe.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
    if (init.method === 'POST') {
      init.headers['content-type'] = init.headers['content-type'] ?? 'application/json'
      init.body = JSON.stringify(probe.body ?? {})
    }
    const response = await fetch(probe.url, init)
    row.latencyMs = Date.now() - started
    if (!response.ok) {
      row.message = `http-${response.status}`
      return row
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      row.message = 'bad-json'
      return row
    }

    const total = readPath(payload, probe.totalPath)
    if (total === undefined || total === null) {
      row.message = 'no-balance'
      return row
    }
    const currencyValue = readPath(payload, probe.currencyPath)
    row.ok = true
    row.total = finiteOf(total)
    row.currency = typeof currencyValue === 'string' && currencyValue !== '' ? currencyValue : probe.currency
    row.granted = finiteOf(readPath(payload, probe.grantedPath))
    row.toppedUp = finiteOf(readPath(payload, probe.toppedUpPath))
    row.message = ''
    row.at = Date.now()
    return row
  } catch (error) {
    row.latencyMs = Date.now() - started
    row.message = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : describe(error)
    warnOnce(`balance-${probe.id}`, `balance lookup "${probe.id}" failed: ${row.message}`)
    return row
  }
}

/**
 * Official DeepSeek balance.
 *
 * The endpoint answers `{ is_available, balance_infos: [{ currency,
 * total_balance, granted_balance, topped_up_balance }] }`. Only the first entry
 * is read: an account bills in one currency, and showing a list would need a
 * currency switcher the panel does not have.
 */
async function deepseekBalance(config) {
  const at = Date.now()
  if (config?.enabled !== true) {
    return { ...emptyRow('deepseek', 'DeepSeek', 'deepseek'), message: 'disabled', at }
  }
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  if (apiKey === '') {
    return { ...emptyRow('deepseek', 'DeepSeek', 'deepseek'), message: 'not-configured', at }
  }
  const base =
    typeof config.baseUrl === 'string' && config.baseUrl.trim() !== ''
      ? config.baseUrl.trim().replace(/\/+$/, '')
      : 'https://api.deepseek.com'

  const row = await probeBalance({
    id: 'deepseek',
    label: 'DeepSeek',
    url: `${base}/user/balance`,
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}` },
    totalPath: 'balance_infos.0.total_balance',
    currencyPath: 'balance_infos.0.currency',
    grantedPath: 'balance_infos.0.granted_balance',
    toppedUpPath: 'balance_infos.0.topped_up_balance',
    currency: 'CNY',
    source: 'deepseek',
  })
  // `is_available` tells the user whether the account can still pay, which is a
  // different fact from the balance figure and worth carrying separately.
  if (row.ok === true) row.available = true
  return row
}

/**
 * Every configured balance source, with TTL caching and failure degradation.
 * @param settings - the `usage.balance` slice.
 * @param options - `{ force }` bypasses the cache.
 * @returns `{ deepseek, providers, at }`.
 */
export async function balancePayload(settings, options = {}) {
  const force = options.force === true
  const now = Date.now()
  const ttlMs = Math.max(15, Math.min(3600, Math.round(countOf(settings?.ttlSeconds) || 120))) * 1000

  const probes = [{ id: 'deepseek', kind: 'deepseek', config: settings?.deepseek ?? {} }]
  const list = Array.isArray(settings?.providers) ? settings.providers.slice(0, MAX_PROVIDERS) : []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    probes.push({ id: typeof entry.id === 'string' ? entry.id : '', kind: 'provider', config: entry })
  }

  const rows = await Promise.all(
    probes.map(async (probe) => {
      const key = `${probe.kind}:${probe.id}`
      if (!force) {
        const cached = BALANCE_CACHE.get(key)
        if (cached !== undefined && now < cached.expiresAt) return cached.value
      }
      const value =
        probe.kind === 'deepseek'
          ? await deepseekBalance(probe.config)
          : probe.config.enabled !== true
            ? {
                ...emptyRow(
                  typeof probe.config.id === 'string' ? probe.config.id : 'provider',
                  typeof probe.config.label === 'string' && probe.config.label !== '' ? probe.config.label : probe.id,
                  'provider',
                ),
                message: 'disabled',
              }
            : await probeBalance({
                id: typeof probe.config.id === 'string' ? probe.config.id : 'provider',
                label:
                  typeof probe.config.label === 'string' && probe.config.label !== ''
                    ? probe.config.label
                    : typeof probe.config.provider === 'string' && probe.config.provider !== ''
                      ? probe.config.provider
                      : probe.id,
                url: probe.config.url,
                method: probe.config.method,
                headers: parseHeaders(probe.config.headers),
                body: parseBody(probe.config.body),
                totalPath: probe.config.totalPath,
                currencyPath: probe.config.currencyPath,
                grantedPath: typeof probe.config.grantedPath === 'string' ? probe.config.grantedPath : '',
                toppedUpPath: typeof probe.config.toppedUpPath === 'string' ? probe.config.toppedUpPath : '',
                currency:
                  typeof probe.config.currency === 'string' && probe.config.currency !== ''
                    ? probe.config.currency
                    : 'CNY',
                source: 'provider',
              })
      const expiresAt = Date.now() + ttlMs
      // A failed lookup is cached too, but for a fraction of the TTL: retrying a
      // dead endpoint on every poll helps nobody, while a five-minute penalty for
      // a transient timeout is too long.
      const holdMs = value.ok === true ? ttlMs : Math.min(ttlMs, 15000)
      BALANCE_CACHE.set(key, { at: Date.now(), expiresAt: Date.now() + holdMs, value: { ...value, expiresAt: Date.now() + holdMs } })
      return { ...value, expiresAt: Date.now() + holdMs }
    }),
  )

  const deepseek = rows.find((row) => row.source === 'deepseek') ?? emptyRow('deepseek', 'DeepSeek', 'deepseek')
  const providers = rows.filter((row) => row.source !== 'deepseek')
  for (const row of providers) {
    if (row.expiresAt === 0) row.expiresAt = Date.now() + ttlMs
  }
  return { deepseek, providers, at: Date.now() }
}

/** Drop every cached reading; used by the settings page's "refresh" action. */
export function clearBalanceCache() {
  BALANCE_CACHE.clear()
}

/**
 * A balance row for a source that is not configured at all.
 *
 * The panel still renders a row per known source so the user can see what is
 * available to turn on, rather than an empty section with no explanation.
 */
export function unconfiguredRow(id, label, source = 'provider') {
  return emptyRow(id, label, source)
}
