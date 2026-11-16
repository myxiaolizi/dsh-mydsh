/**
 * Prices, currency and cost.
 *
 * Three rules shape this file:
 *
 * 1. Lookup never fails. Model → provider default → `'*'` default → generic
 *    estimate, in that order. A model that shipped last week must not turn a
 *    summary into `NaN`.
 * 2. Currency follows the provider, not the reader. A DeepSeek user thinks in
 *    CNY and an OpenAI user thinks in USD, so each price row publishes the
 *    vendor's own currency and cost is summed per currency before display.
 * 3. Settings win over the built-in table. `usage.priceOverrides[]` is the only
 *    way to correct a number without shipping a new plugin build, so it is
 *    consulted first and reported as `source: 'override'`.
 *
 * The built-in table is USD list prices per 1M tokens. Providers that publish
 * in CNY carry a CNY column derived at the fixed display rate, because the
 * number a user checks against their bill is the CNY one; `priceOverrides` is
 * the correct place to put an exact CNY list price.
 */

import { CNY_PROVIDERS, USD_CNY, countOf, isCnyProvider } from './support.js'

/**
 * Raw vendor prices, USD per 1M tokens.
 *
 * Kept as plain data so the table below can be built once at load. `default` is
 * the per-provider fallback for models the table does not name; `'*'` is the
 * fallback for providers we do not know at all.
 */
const RAW_PRICES = Object.freeze({
  deepseek: Object.freeze({
    'deepseek-chat': Object.freeze({ input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 }),
    'deepseek-reasoner': Object.freeze({ input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 }),
    default: Object.freeze({ input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 }),
  }),
  openai: Object.freeze({ default: Object.freeze({ input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 }) }),
  anthropic: Object.freeze({ default: Object.freeze({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }) }),
  google: Object.freeze({ default: Object.freeze({ input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.25 }) }),
  moonshot: Object.freeze({ default: Object.freeze({ input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0.6 }) }),
  zhipu: Object.freeze({ default: Object.freeze({ input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0.6 }) }),
  qwen: Object.freeze({ default: Object.freeze({ input: 0.4, output: 1.2, cacheRead: 0.08, cacheWrite: 0.4 }) }),
  xai: Object.freeze({ default: Object.freeze({ input: 3, output: 15, cacheRead: 0.75, cacheWrite: 3 }) }),
  mistral: Object.freeze({ default: Object.freeze({ input: 2, output: 6, cacheRead: 0.4, cacheWrite: 2 }) }),
  '*': Object.freeze({ default: Object.freeze({ input: 1, output: 3, cacheRead: 1, cacheWrite: 1 }) }),
})

/** Price per 1M tokens of an unnamed model on a known provider, USD. */
const GENERIC_PRICE = Object.freeze({ input: 1, output: 3, cacheRead: 1, cacheWrite: 1 })

/**
 * Row label for a provider's catch-all rate.
 *
 * The price table's `default` entry is the rate every unnamed model on that
 * vendor is charged, so the list shows it under one honest name instead of
 * hiding it or pretending it belongs to a specific model.
 */
const DEFAULT_MODEL_LABEL = '*'

/**
 * Live pricing state.
 *
 * Module-level on purpose: `priceFor()` is part of the engine's public surface
 * and is imported by other host modules, so it must answer without a settings
 * object in hand. The engine refreshes this state from `settings.usage` before
 * it aggregates anything.
 */
const PRICING_STATE = {
  /** `provider::model` → normalized override row. */
  overrides: new Map(),
  /** Overrides that name a model but no provider, matched by model alone. */
  looseOverrides: new Map(),
  /** When false, a model with no price is reported as unpriced instead of estimated. */
  estimateUnknown: true,
  /**
   * A list installed by `setPriceOverrides()`, kept for a few seconds.
   *
   * `POST /usage/prices` persists and then answers; the settings document the
   * Host reads on the very next call may still be the previous snapshot. The pin
   * covers that window so the response describes what the write changed. It
   * expires, because settings are the authority and a stale pin that outlived a
   * settings edit would silently ignore the user.
   * @type {{ at: number, overrides: Map, looseOverrides: Map } | undefined}
   */
  pin: undefined,
}

/** How long an installed override list outranks the settings snapshot. */
const PIN_MS = 5000

/**
 * Normalise one override list into lookup maps.
 *
 * A row naming a provider and a model is an exact match; a row naming only a
 * model follows that model across providers, which is what a user means when
 * they paste a price for a model they reach through two relays.
 * @param list - `usage.priceOverrides[]` or a caller-supplied replacement.
 * @returns `{ overrides, looseOverrides }`.
 */
export function normalizeOverrides(list) {
  const overrides = new Map()
  const looseOverrides = new Map()
  const rows = Array.isArray(list) ? list : []
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const provider = typeof row.provider === 'string' ? row.provider.trim().toLowerCase() : ''
    const model = typeof row.model === 'string' ? row.model.trim() : ''
    if (provider === '' && model === '') continue
    const entry = Object.freeze({
      provider,
      model,
      input: countOf(row.input),
      output: countOf(row.output),
      // A blank cache rate means "same as input" for providers that do not
      // discount cache traffic; keeping `undefined` here preserves that meaning.
      cacheRead: row.cacheRead === undefined || row.cacheRead === null ? undefined : countOf(row.cacheRead),
      cacheWrite: row.cacheWrite === undefined || row.cacheWrite === null ? undefined : countOf(row.cacheWrite),
      currency: row.currency === 'USD' ? 'USD' : 'CNY',
      id: typeof row.id === 'string' ? row.id : '',
    })
    if (provider === '') looseOverrides.set(model.toLowerCase(), entry)
    else overrides.set(`${provider}::${model}`.toLowerCase(), entry)
  }
  return { overrides, looseOverrides }
}

/**
 * Install one override list as the effective pricing.
 *
 * Settings are re-read on every engine call and therefore win again on the next
 * read; this entry point exists for a caller that has just persisted a new list
 * and wants the change visible before the next settings refresh.
 * @param list - the authoritative override list.
 */
export function installOverrides(list) {
  const next = normalizeOverrides(list)
  PRICING_STATE.overrides = next.overrides
  PRICING_STATE.looseOverrides = next.looseOverrides
}

/**
 * Install one override list with a short pin, so a write's own response and the
 * next few calls see it even while the settings snapshot catches up.
 * @param list - the authoritative override list.
 */
export function pinOverrides(list) {
  installOverrides(list)
  PRICING_STATE.pin = {
    at: Date.now(),
    overrides: PRICING_STATE.overrides,
    looseOverrides: PRICING_STATE.looseOverrides,
  }
}

/**
 * Normalise and install `settings.usage.priceOverrides` + `estimateUnknown`.
 *
 * Called on every engine read (the settings document is live), so this must stay
 * cheap: two maps and a flag, at most 200 rows.
 * @param usage - the `usage` settings slice.
 */
export function configurePricing(usage) {
  const pin = PRICING_STATE.pin
  if (pin !== undefined && Date.now() - pin.at < PIN_MS) {
    // The write is still settling: keep the installed maps and only take the
    // flag, which the writer cannot have changed in the same operation.
    PRICING_STATE.estimateUnknown = usage?.estimateUnknown !== false
    return
  }
  if (pin !== undefined) PRICING_STATE.pin = undefined
  installOverrides(usage?.priceOverrides)
  PRICING_STATE.estimateUnknown = usage?.estimateUnknown !== false
}

/** Provider name normalised for table lookup. */
function providerKey(provider) {
  return typeof provider === 'string' ? provider.trim().toLowerCase() : ''
}

/**
 * Attach a currency to one USD price row.
 *
 * CNY vendors get the same list price converted at the fixed display rate. This
 * is a display conversion, not a billing one: a user who needs exact CNY
 * numbers sets `priceOverrides`, which is reported as `source: 'override'`.
 */
function priceEntry(price, currency, source, extra = {}) {
  const entry = {
    input: countOf(price.input),
    output: countOf(price.output),
    cacheRead: price.cacheRead === undefined ? countOf(price.input) : countOf(price.cacheRead),
    cacheWrite: price.cacheWrite === undefined ? countOf(price.input) : countOf(price.cacheWrite),
    currency,
    source,
    ...extra,
  }
  if (currency === 'CNY') {
    return {
      ...entry,
      input: round2(entry.input * USD_CNY),
      output: round2(entry.output * USD_CNY),
      cacheRead: round2(entry.cacheRead * USD_CNY),
      cacheWrite: round2(entry.cacheWrite * USD_CNY),
    }
  }
  return entry
}

/** Two decimals: a per-1M-token rate never needs more, and it reads cleaner. */
function round2(value) {
  return Math.round(countOf(value) * 100) / 100
}

/** Freeze the built-in table once, in the currency of each provider. */
function buildTable() {
  const table = {}
  for (const [provider, models] of Object.entries(RAW_PRICES)) {
    const currency = isCnyProvider(provider) ? 'CNY' : 'USD'
    const bucket = {}
    for (const [model, price] of Object.entries(models)) {
      bucket[model] = Object.freeze(priceEntry(price, currency, 'builtin'))
    }
    table[provider] = Object.freeze(bucket)
  }
  return Object.freeze(table)
}

/** The built-in price table, per provider and per model, in each vendor's currency. */
export const PRICE_TABLE = buildTable()

/**
 * Resolve a price entry for one provider/model pair.
 *
 * Lookup order is override (exact) → override (model only) → model → provider
 * default → generic default. The returned entry always carries a `currency` and
 * a `source` so a row can say both what it cost and where the number came from.
 * @param provider - provider id as reported by the session log.
 * @param model - model id as reported by the session log.
 * @returns the price entry, or `undefined` when the provider is not a usable string.
 */
export function priceFor(provider, model) {
  const providerId = providerKey(provider)
  if (providerId === '') return undefined
  const name = typeof model === 'string' ? model.trim() : ''
  const lowerModel = name.toLowerCase()

  if (lowerModel !== '') {
    const exact = PRICING_STATE.overrides.get(`${providerId}::${lowerModel}`)
    if (exact !== undefined) return overrideEntry(exact)
    const loose = PRICING_STATE.looseOverrides.get(lowerModel)
    if (loose !== undefined) return overrideEntry(loose)
  }

  const bucket = PRICE_TABLE[providerId] ?? undefined
  if (bucket !== undefined && lowerModel !== '') {
    for (const [tableModel, entry] of Object.entries(bucket)) {
      if (tableModel.toLowerCase() === lowerModel) return entry
    }
  }
  if (bucket !== undefined && bucket.default !== undefined) return bucket.default

  // The provider is unknown. Attribute its price to the provider's own currency
  // rules so a Chinese vendor relay is still read as CNY.
  if (PRICING_STATE.estimateUnknown !== true) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      currency: isCnyProvider(providerId) ? 'CNY' : 'USD',
      source: 'unpriced',
    }
  }
  const currency = isCnyProvider(providerId) ? 'CNY' : 'USD'
  return Object.freeze(priceEntry(GENERIC_PRICE, currency, 'estimated'))
}

/** Materialise one override row into the same shape the table uses. */
function overrideEntry(row) {
  const input = countOf(row.input)
  return {
    input,
    output: countOf(row.output),
    cacheRead: row.cacheRead === undefined ? input : countOf(row.cacheRead),
    cacheWrite: row.cacheWrite === undefined ? input : countOf(row.cacheWrite),
    currency: row.currency,
    source: 'override',
  }
}

/**
 * Cost of one metered request, in the price row's own currency.
 *
 * Missing cache rates fall back to the input rate, which is the conservative
 * reading of a provider that does not discount cache traffic. A zero price row
 * is a real answer (an unpriced model), so it is not upgraded to an estimate.
 * @param price - entry from `priceFor()`, possibly `undefined`.
 * @param tokens - `{ input, output, cacheRead, cacheWrite }`.
 * @returns `{ amount, currency }`.
 */
export function costOf(price, tokens) {
  const currency = price?.currency === 'CNY' ? 'CNY' : 'USD'
  if (price === undefined || price === null) return { amount: 0, currency }
  const input = countOf(price.input)
  const output = countOf(price.output)
  const cacheRead = price.cacheRead === undefined ? input : countOf(price.cacheRead)
  const cacheWrite = price.cacheWrite === undefined ? input : countOf(price.cacheWrite)
  const amount =
    (countOf(tokens?.input) / 1e6) * input +
    (countOf(tokens?.output) / 1e6) * output +
    (countOf(tokens?.cacheRead) / 1e6) * cacheRead +
    (countOf(tokens?.cacheWrite) / 1e6) * cacheWrite
  return { amount: Number.isFinite(amount) ? amount : 0, currency }
}

/**
 * The price list the settings page shows.
 *
 * Built-in rows and override rows are merged on `provider::model`, with the
 * override winning and keeping its own `source`. Rows are sorted so the page
 * can render without sorting again.
 * @param query - optional case-insensitive substring over provider and model.
 * @returns `{ rows, source }`.
 */
export function priceRows(query = '') {
  const search = typeof query === 'string' ? query.trim().toLowerCase() : ''
  const rows = []
  const seen = new Set()

  const put = (provider, model, entry) => {
    const key = `${provider}::${model}`
    if (seen.has(key)) return
    seen.add(key)
    rows.push({
      provider,
      model,
      input: entry.input,
      output: entry.output,
      cacheRead: entry.cacheRead,
      cacheWrite: entry.cacheWrite,
      currency: entry.currency,
      source: entry.source,
    })
  }

  for (const [provider, bucket] of Object.entries(PRICE_TABLE)) {
    if (provider === '*') continue
    let named = 0
    for (const [model, entry] of Object.entries(bucket)) {
      if (model === 'default') continue
      named += 1
      const override = PRICING_STATE.overrides.get(`${provider}::${model}`.toLowerCase())
      put(provider, model, override === undefined ? entry : overrideEntry(override))
    }
    // A provider whose table is only a fallback rate still has to appear: a user
    // checking "what does this vendor charge" needs to see the number that
    // actually applies to every model it serves, not an empty section.
    if (named === 0 && bucket.default !== undefined) {
      put(provider, DEFAULT_MODEL_LABEL, bucket.default)
    }
  }
  for (const [key, override] of PRICING_STATE.overrides) {
    const [provider, model] = key.split('::')
    put(provider, model, overrideEntry(override))
  }
  for (const [model, override] of PRICING_STATE.looseOverrides) {
    put(override.provider, model, overrideEntry(override))
  }

  const filtered =
    search === ''
      ? rows
      : rows.filter(
          (row) => row.provider.includes(search) || row.model.toLowerCase().includes(search),
        )
  filtered.sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model),
  )
  return {
    rows: filtered,
    source: PRICING_STATE.overrides.size + PRICING_STATE.looseOverrides.size > 0 ? 'overrides' : 'builtin',
  }
}

/** Providers the built-in table knows, for the settings page's picker. */
export function knownProviders() {
  return Object.keys(PRICE_TABLE).filter((provider) => provider !== '*').sort()
}

/** Vendors the display reads as CNY. Re-exported so the engine need not import twice. */
export const CNY_VENDORS = CNY_PROVIDERS

/** True when the effective override list is non-empty, for the price page's badge. */
export function hasOverrides() {
  return PRICING_STATE.overrides.size + PRICING_STATE.looseOverrides.size > 0
}
