/**
 * Shared plumbing for the capability modules.
 *
 * Every module in this directory faces the same three facts of life, so the
 * answers live here instead of being re-derived six times:
 *
 *  1. Any DSH service may be absent, and `ctx.get()` can even throw while a
 *     fiber is recycling. Absence must degrade a feature, never fail the plugin.
 *  2. Every value a user or a model can influence needs a hard bound: a length
 *     for strings, a range for numbers, a whitelist for enumerations. An
 *     unbounded string is a memory and a prompt-injection problem at once.
 *  3. Anything written to disk needs a path that cannot climb out of the
 *     directory it was meant for (`../../..` in a file name).
 *
 * Nothing here imports a third-party package or a DSH runtime module: the whole
 * layer is ordinary Node ESM so it works on any profile that loads it.
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Length ceilings. One place to change when a limit turns out wrong. */
export const LIMITS = Object.freeze({
  /** Server, role and plugin identifiers. */
  id: 64,
  /** Display names and labels. */
  label: 128,
  /** One-line summaries. */
  summary: 400,
  /** A role prompt or an instruction block. */
  prompt: 8000,
  /** Keys pressed in one `desktop` call. */
  text: 4000,
  /** URLs and endpoints. */
  url: 2048,
  /** Executables and working directories. */
  command: 1024,
  /** Diagnostic text returned to the UI. */
  message: 600,
})

/**
 * Read one service without letting a recycled fiber throw out of a route.
 * @param ctx - Cordis plugin context.
 * @param name - service name, e.g. `mcpManager`.
 * @returns the service, or `undefined` when it is absent or unreadable.
 */
export function serviceOf(ctx, name) {
  try {
    const value = ctx?.get?.(name)
    return value === undefined || value === null ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * Whether a service exposes one callable method.
 * @param service - candidate service, possibly `undefined`.
 * @param method - method name.
 * @returns true when calling `service[method]` is safe.
 */
export function hasMethod(service, method) {
  return service !== undefined && typeof service?.[method] === 'function'
}

/**
 * Trim a settings document down to one module slice.
 *
 * `getSettings` is read on every call rather than captured, so flipping a switch
 * in the settings page applies to the next request without rebuilding anything.
 * @param getSettings - synchronous settings reader.
 * @param key - key under `settings.modules`.
 * @returns the slice, or an empty object when it is missing.
 */
export function moduleSettings(getSettings, key) {
  try {
    const document = typeof getSettings === 'function' ? getSettings() : undefined
    const slice = document?.modules?.[key]
    return slice !== null && typeof slice === 'object' && !Array.isArray(slice) ? slice : {}
  } catch {
    return {}
  }
}

/** An object (not array, not null) from an untrusted source. */
export function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** A length-bounded trimmed string. */
export function text(value, max = 512) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, Math.max(0, max))
}

/** A boolean with a fallback for a missing or non-boolean setting. */
export function flag(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

/** An integer clamped into `[min, max]`. */
export function intIn(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** An error's message without leaking a stack into a response. */
export function describe(error) {
  if (error === undefined || error === null) return 'unknown error'
  const message = typeof error === 'string' ? error : (error.message ?? String(error))
  return message.slice(0, LIMITS.message)
}

/** A structured failure. Every module answers with this shape, never a throw. */
export function failure(message, extra = {}) {
  return { ok: false, message: text(message, LIMITS.message) || 'operation failed', ...extra }
}

/**
 * Resolve `name` inside `base` and refuse anything that escapes it.
 *
 * A file name is the classic path-traversal seam: `..%2f..` arrives from a URL,
 * gets decoded, and suddenly writes outside the plugin directory. Every write
 * path in this layer goes through this check.
 * @param base - directory that must contain the result.
 * @param name - single path segment, already sanitised by the caller.
 * @returns an absolute path, or `undefined` when it would escape `base`.
 */
export function withinDir(base, name) {
  const root = resolve(base)
  const candidate = resolve(join(root, name))
  const rel = relative(root, candidate)
  if (rel === '') return candidate
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return undefined
  return candidate
}

/**
 * A conservative file-name segment: no separators, no leading dot, no control
 * characters, bounded length. Used for generated artefact names.
 * @param value - candidate segment.
 * @param fallback - used when nothing usable survives.
 */
export function safeSegment(value, fallback = 'item') {
  const cleaned = text(value, 120)
    .replace(/[\\/:*?"<>|.\u0000-\u001f]/g, '-')
    .replace(/^[-\s]+/, '')
    .replace(/[-\s]+$/, '')
  return cleaned === '' ? fallback : cleaned
}

/**
 * Parse the `env` setting of an MCP server.
 *
 * The settings page stores one textarea rather than a key/value grid, so the
 * accepted forms are `KEY=VALUE` lines and a JSON object. Values are never
 * echoed back to the browser; this parser only feeds a child process.
 * @param raw - textarea contents.
 * @returns a plain object of environment entries.
 */
export function parseEnvText(raw) {
  const source = typeof raw === 'string' ? raw.trim() : ''
  if (source === '') return {}
  if (source.startsWith('{')) {
    try {
      const parsed = JSON.parse(source)
      const out = {}
      for (const [key, value] of Object.entries(record(parsed) ?? {})) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string') out[key] = value.slice(0, LIMITS.url)
      }
      return out
    } catch {
      return {}
    }
  }
  const out = {}
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1).trim()
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value.slice(0, LIMITS.url)
  }
  return out
}

/**
 * Parse the `headers` setting of a streamable-http MCP server.
 * Accepts `Name: value` lines or a JSON object.
 * @param raw - textarea contents.
 * @returns header pairs keyed by a token-safe name.
 */
export function parseHeaderText(raw) {
  const source = typeof raw === 'string' ? raw.trim() : ''
  if (source === '') return {}
  if (source.startsWith('{')) {
    try {
      const parsed = JSON.parse(source)
      const out = {}
      for (const [key, value] of Object.entries(record(parsed) ?? {})) {
        if (/^[A-Za-z0-9-]+$/.test(key) && typeof value === 'string') out[key] = value.slice(0, LIMITS.url)
      }
      return out
    } catch {
      return {}
    }
  }
  const out = {}
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf(':')
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1).trim()
    if (/^[A-Za-z0-9-]+$/.test(key)) out[key] = value.slice(0, LIMITS.url)
  }
  return out
}

/**
 * Whether a configuration field name looks like it carries a credential.
 *
 * Masking is decided by name because DSH does not ship a per-field secret
 * marker this layer can read; over-masking an innocent field is harmless, while
 * under-masking writes a key into the browser.
 * @param key - field name.
 */
export function isSecretKey(key) {
  return /key|token|secret|password|passwd|credential|authorization/i.test(String(key))
}

/** Recursively replace secret values with `***`, leaving the structure intact. */
export function maskSecrets(value, depth = 0) {
  if (depth > 6) return value
  if (Array.isArray(value)) return value.map((entry) => maskSecrets(entry, depth + 1))
  if (record(value) === undefined) return value
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key) && typeof entry === 'string' && entry !== '') out[key] = '***'
    else if (isSecretKey(key) && record(entry) !== undefined) out[key] = maskSecrets(entry, depth + 1)
    else out[key] = maskSecrets(entry, depth + 1)
  }
  return out
}

/**
 * Build the next configuration value for a write, honouring the `***` sentinel.
 *
 * The settings page shows `***` for a secret it may not read back. Sending the
 * sentinel back means "I did not retype this", so the stored value survives;
 * sending a real string replaces it.
 * @param current - value as currently stored (unmasked).
 * @param patch - value as sent by the page (masked).
 * @returns the merged document and whether anything actually changed.
 */
export function mergeSecretPatch(current, patch) {
  const base = record(current) ? current : {}
  const incoming = record(patch) ? patch : {}
  let changed = false
  const out = { ...base }
  for (const [key, value] of Object.entries(incoming)) {
    if (value === '***') continue
    if (record(value) !== undefined && record(base[key]) !== undefined) {
      const nested = mergeSecretPatch(base[key], value)
      if (nested.changed) changed = true
      out[key] = nested.value
      continue
    }
    changed = true
    out[key] = value
  }
  return { value: out, changed }
}

/**
 * A cancellation signal plus its cleanup, so no module leaks a timer.
 * @param ms - budget in milliseconds.
 * @param message - reason recorded on the signal.
 */
export function budget(ms, message) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(message)), Math.max(1, ms))
  // A pending probe must never keep the Host process alive on its own.
  timer.unref?.()
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer)
      if (!controller.signal.aborted) controller.abort(new Error(message))
    },
  }
}

/** True when an abort came from a budget rather than from upstream. */
export function aborted(signal) {
  return signal?.aborted === true
}

/**
 * A human-readable label for a language-tagged display string.
 * DSH manifests carry `LocalizedText`, which is either one string or a
 * translation table with a required English fallback.
 * @param value - the manifest value.
 * @param language - preferred language id.
 */
export function localized(value, language = 'zh') {
  if (typeof value === 'string') return text(value, LIMITS.label)
  const table = record(value)
  if (table === undefined) return ''
  return text(table[language] ?? table.zh ?? table.en ?? '', LIMITS.label)
}
