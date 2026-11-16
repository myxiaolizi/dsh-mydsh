/**
 * Core: constants, formatting, the settings subscription, and the HTTP client.
 *
 * Everything in this file runs once when the module factory is invoked, so it
 * must stay free of side effects: no fetch, no timer, no DOM write. The
 * subscription below is created lazily on first use and disposed with the
 * plugin's effect, which is what keeps a page that never shows a mydsh entry
 * from paying for one.
 */

const NS = 'dsh-mydsh'
const API = '/api/mydsh'
const VIEW_STORE_KEY = 'dsh.workspace.view.v5'
const DAY_MS = 86400000

// --- numbers ---------------------------------------------------------------

/** 12345 → "1.2万". Chinese convention for magnitudes the user asked for. */
function cn(value, digits = 1) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0'
  const abs = Math.abs(number)
  if (abs >= 1e8) return `${(number / 1e8).toFixed(digits)}亿`
  if (abs >= 1e4) return `${(number / 1e4).toFixed(digits)}万`
  return String(Math.round(number))
}

/** Compact token count: 1234567 → "1.2M" (Latin) / "123.5万" (Chinese). */
function tokens(value, locale) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number) || number === 0) return '0'
  if (locale === 'zh') {
    if (Math.abs(number) >= 1e8) return `${(number / 1e8).toFixed(2)}亿`
    if (Math.abs(number) >= 1e4) return `${(number / 1e4).toFixed(1)}万`
    return String(Math.round(number))
  }
  if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(2)}M`
  if (Math.abs(number) >= 1e3) return `${(number / 1e3).toFixed(1)}K`
  return String(Math.round(number))
}

/** Exact token count for tooltips: 12345 → "12,345". */
function exact(value) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number)) return '0'
  return Math.round(number).toLocaleString('en-US')
}

/** Currency amount with two decimals and the right symbol. */
function money(value, currency) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number)) return '—'
  const symbol = currency === 'USD' ? '$' : '¥'
  if (number === 0) return `${symbol}0`
  if (Math.abs(number) < 0.01) return `${symbol}<0.01`
  if (Math.abs(number) >= 1e4) return `${symbol}${cn(number, 2)}`
  return `${symbol}${number.toFixed(2)}`
}

/** Milliseconds as a short human duration: 95000 → "1分35秒". */
function duration(ms, locale) {
  const value = Math.max(0, Number(ms ?? 0))
  if (!Number.isFinite(value) || value === 0) return '—'
  const totalSeconds = Math.round(value / 1000)
  if (totalSeconds < 60) return `${(value / 1000).toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return locale === 'zh' ? `${minutes}分${seconds}秒` : `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  return locale === 'zh' ? `${hours}时${minutes % 60}分` : `${hours}h ${minutes % 60}m`
}

/** Epoch ms as a clock time, or a date when it is not today. */
function when(epochMs, locale) {
  const value = Number(epochMs ?? 0)
  if (!Number.isFinite(value) || value <= 0) return '—'
  const date = new Date(value)
  const pad = (part) => String(part).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return clock
  return `${date.getMonth() + 1}/${date.getDate()} ${clock}`
}

/** Byte sizes with binary units. */
function bytes(value) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number) || number <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let size = number
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
}

/** Percentage with one decimal, clamped for display. */
function percent(ratio, digits = 1) {
  const value = Number(ratio)
  if (!Number.isFinite(value)) return '0%'
  return `${(value * 100).toFixed(digits)}%`
}

// --- locale ----------------------------------------------------------------

let cachedLocale
/** The active DSH locale, falling back to the browser's language. */
function activeLocale() {
  if (cachedLocale !== undefined) return cachedLocale
  let id = ''
  try {
    const localeService = ctxRef.get('locale')
    const snapshot = localeService?.getLocale?.() ?? localeService?.getSnapshot?.()
    id = String(snapshot?.id ?? snapshot?.locale ?? '')
  } catch {
    id = ''
  }
  if (id === '') id = String(navigator.language ?? 'zh')
  cachedLocale = id.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  return cachedLocale
}

// --- context reference -----------------------------------------------------

/**
 * The Client Cordis context, captured in `apply`.
 *
 * Utility functions above run outside React and outside the component tree, so
 * they read the locale through this reference instead of threading a context
 * argument through every call site.
 */
const ctxRef = { get: () => undefined }

// --- HTTP ------------------------------------------------------------------

/** One call to the Host half. Throws an Error carrying the Host's message. */
async function api(path, options = {}) {
  const hasBody = options.body !== undefined
  const response = await fetch(`${API}${path}`, {
    method: hasBody ? 'POST' : 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: hasBody ? { 'content-type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  })
  const text = await response.text()
  let payload
  try {
    payload = text === '' ? undefined : JSON.parse(text)
  } catch {
    throw new Error(`Host returned non-JSON (${response.status})`)
  }
  if (payload === undefined) throw new Error(`Empty response (${response.status})`)
  if (payload.ok !== true) throw new Error(payload.error?.message ?? `Request failed (${response.status})`)
  return payload.value
}

// --- settings store --------------------------------------------------------

/**
 * One shared settings cache for the whole page.
 *
 * Every entry needs the document to decide whether it should exist at all, and
 * there are up to a dozen entries. A single poller with one fetch per revision
 * change is the difference between twelve overlapping requests every two
 * seconds and none.
 */
const settingsStore = (() => {
  let value
  let revision = -1
  let error
  let loading = false
  let started = false
  let timer
  let lastFetchAt = 0
  const listeners = new Set()

  const emit = () => {
    for (const listener of listeners) {
      try {
        listener()
      } catch (failure) {
        console.error(`[${NS}] settings listener failed`, failure)
      }
    }
  }

  const refresh = async (force) => {
    if (loading && !force) return
    loading = true
    try {
      if (value === undefined) {
        const full = await api('/settings')
        value = full.settings
        revision = Number(full.meta?.revision ?? 0)
        error = undefined
        emit()
      } else {
        const head = await api('/settings/revision')
        const remote = Number(head.revision ?? 0)
        if (remote !== revision) {
          const full = await api('/settings')
          value = full.settings
          revision = Number(full.meta?.revision ?? remote)
          error = undefined
          emit()
        }
      }
      lastFetchAt = Date.now()
    } catch (failure) {
      error = failure
      emit()
    } finally {
      loading = false
    }
  }

  const tick = () => {
    // A hidden tab costs nothing; becoming visible refreshes immediately.
    if (typeof document !== 'undefined' && document.hidden) return
    refresh(false)
  }

  const start = () => {
    if (started) return () => undefined
    started = true
    refresh(false)
    timer = setInterval(tick, 2000)
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastFetchAt > 1500) refresh(false)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      started = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }

  /** Apply a patch locally first so a switch flips on the same frame. */
  const patch = async (partial) => {
    if (value !== undefined) {
      value = deepPatch(value, partial)
      emit()
    }
    const result = await api('/settings', { body: { patch: partial } })
    value = result.settings
    revision = Number(result.meta?.revision ?? revision + 1)
    emit()
    return value
  }

  return {
    start,
    refresh,
    patch,
    get: () => value,
    getError: () => error,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
})()

/** Merge a partial document over the current one for optimistic updates. */
function deepPatch(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = Array.isArray(base) ? [...base] : { ...(base ?? {}) }
  for (const [key, entry] of Object.entries(patch)) {
    if (entry === undefined) continue
    const current = base?.[key]
    if (
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      out[key] = deepPatch(current, entry)
    } else {
      out[key] = entry
    }
  }
  return out
}

/** Subscribe one component to the shared settings document. */
function useSettings() {
  const snapshot = useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get)
  return snapshot
}

/** Read the document, returning defaults-shaped emptiness while it loads. */
function useSettingsOr(empty) {
  const settings = useSettings()
  return settings ?? empty
}

// --- misc ------------------------------------------------------------------

/** Stable id for a row added from the settings page. */
function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** Deep-clone plain JSON data (settings rows are always plain). */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** Debounce a function; the returned function exposes `cancel`. */
function debounce(fn, delay) {
  let timer
  const wrapped = (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
  wrapped.cancel = () => clearTimeout(timer)
  return wrapped
}

/** Pick the longest of several candidate paths in a JSON answer. */
function pickPath(source, path) {
  if (path === '' || source === undefined || source === null) return undefined
  let cursor = source
  for (const part of String(path).split('.')) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = cursor[part]
  }
  return cursor
}
