/**
 * dsh-mydsh — Client half (generated).
 *
 * Built from client-src/ by scripts/build-client.mjs. Edit the sources, not
 * this file: a rebuild overwrites it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mydsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React

    // ===== 00-core.js =====
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

    // ===== 10-ui.js =====
/**
 * UI kit: text, controls, cards, charts.
 *
 * These are hand-written equivalents of the Host's own controls, not imports.
 * A Client plugin may not load `@deepseek-ai/dsh-client-ui-primitives` as a
 * module, and copying the markup while referencing only `--dsw-alias-*` tokens
 * is what keeps the page inside the Host's visual language without depending on
 * another package's internals.
 *
 * Nothing here renders a portal into `document.body` except the modal and the
 * popover, which the Host's own controls also portal for the same reason: the
 * conversation column clips overflow.
 */

// --- text ------------------------------------------------------------------

const TEXT = {
  zh: {
    appTitle: '我的 DSH',
    appSubtitle: '界面、用量、备份与能力，一处可管',
    saved: '已保存',
    saving: '保存中…',
    saveFailed: '保存失败',
    refresh: '刷新',
    loading: '加载中…',
    empty: '暂无数据',
    unknown: '未知',
    cancel: '取消',
    confirm: '确定',
    close: '关闭',
    add: '添加',
    remove: '删除',
    edit: '编辑',
    test: '测试',
    run: '立即执行',
    enable: '启用',
    disable: '停用',
    on: '开',
    off: '关',
    advanced: '高级',
    reset: '恢复默认',
    copy: '复制',
    copied: '已复制',
    more: '更多',
    today: '今日',
    week: '本周',
    month: '本月',
    total: '累计',
    range3d: '近 3 天',
    range7d: '近 7 天',
    range30d: '近 1 月',
    range90d: '近 3 月',
    rangeCustom: '自定义',
    rangeToday: '今日',
    save: '保存',
    tabOverview: '总览',
    tabInterface: '界面',
    tabUsage: '用量与计费',
    tabBackup: '备份',
    tabRetry: '重试',
    tabPersonalize: '个性化',
    tabModules: '能力模块',
    tabRelay: '远程访问',
    tabAbout: '关于',
    riskLow: '低风险',
    riskMid: '中风险',
    riskHigh: '高风险',
    riskHighConfirm: '这是高风险能力，会放宽本机权限。确定启用？',
    enabled: '已启用',
    disabled: '未启用',
    unavailable: '不可用',
    unverified: '未验证',
  },
  en: {
    appTitle: 'My DSH',
    appSubtitle: 'Interface, usage, backups and capabilities in one place',
    saved: 'Saved',
    saving: 'Saving…',
    saveFailed: 'Save failed',
    refresh: 'Refresh',
    loading: 'Loading…',
    empty: 'Nothing here yet',
    unknown: 'Unknown',
    cancel: 'Cancel',
    confirm: 'Confirm',
    close: 'Close',
    add: 'Add',
    remove: 'Remove',
    edit: 'Edit',
    test: 'Test',
    run: 'Run now',
    enable: 'Enable',
    disable: 'Disable',
    on: 'On',
    off: 'Off',
    advanced: 'Advanced',
    reset: 'Reset',
    copy: 'Copy',
    copied: 'Copied',
    more: 'More',
    today: 'Today',
    week: 'This week',
    month: 'This month',
    total: 'All time',
    range3d: 'Last 3 days',
    range7d: 'Last 7 days',
    range30d: 'Last month',
    range90d: 'Last 3 months',
    rangeCustom: 'Custom',
    rangeToday: 'Today',
    save: 'Save',
    tabOverview: 'Overview',
    tabInterface: 'Interface',
    tabUsage: 'Usage & billing',
    tabBackup: 'Backups',
    tabRetry: 'Retry',
    tabPersonalize: 'Personalize',
    tabModules: 'Capabilities',
    tabRelay: 'Remote access',
    tabAbout: 'About',
    riskLow: 'Low risk',
    riskMid: 'Medium risk',
    riskHigh: 'High risk',
    riskHighConfirm: 'This is a high-risk capability that widens local permissions. Enable it?',
    enabled: 'On',
    disabled: 'Off',
    unavailable: 'Unavailable',
    unverified: 'Unverified',
  },
}

/** The dictionary for one locale. */
function t() {
  return TEXT[activeLocale()]
}

// --- styles ----------------------------------------------------------------

const CSS = `
.mydsh-root { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.55; }
.mydsh-page { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 28px; }
.mydsh-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.mydsh-head h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: .2px; }
.mydsh-head p { margin: 2px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mydsh-tabs { display: flex; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mydsh-tabs::-webkit-scrollbar { height: 0; }
.mydsh-tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 13px; padding: 8px 12px; border-radius: 8px 8px 0 0; cursor: pointer; white-space: nowrap;
  border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color .12s, background .12s; }
.mydsh-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.mydsh-tab[data-active="true"] { color: var(--dsw-alias-brand-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }

.mydsh-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.mydsh-card[data-flat="true"] { background: transparent; }
.mydsh-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.mydsh-card-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.mydsh-card-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); }

.mydsh-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mydsh-row:last-child { border-bottom: 0; }
.mydsh-row[data-stack="true"] { flex-direction: column; align-items: stretch; gap: 6px; }
.mydsh-row-label { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.mydsh-row-title { font-size: 13px; }
.mydsh-row-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.mydsh-row-control { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.mydsh-grid { display: grid; gap: 10px; }
.mydsh-grid[data-cols="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.mydsh-grid[data-cols="3"] { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.mydsh-grid[data-cols="4"] { grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (max-width: 900px) { .mydsh-grid[data-cols="3"], .mydsh-grid[data-cols="4"] { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 620px) { .mydsh-grid[data-cols="2"], .mydsh-grid[data-cols="3"], .mydsh-grid[data-cols="4"] { grid-template-columns: minmax(0, 1fr); } }

.mydsh-stat { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; position: relative; overflow: hidden; }
.mydsh-stat::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--mydsh-accent, var(--dsw-alias-brand-primary)); }
.mydsh-stat-label { font-size: 11px; color: var(--dsw-alias-label-secondary); display: flex; align-items: center; gap: 4px; }
.mydsh-stat-value { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: .2px; }
.mydsh-stat-foot { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }

.mydsh-switch { appearance: none; width: 34px; height: 20px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); position: relative; cursor: pointer; transition: background .15s, border-color .15s; flex-shrink: 0; }
.mydsh-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--dsw-alias-label-secondary); transition: transform .15s, background .15s; }
.mydsh-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.mydsh-switch[aria-checked="true"]::after { transform: translateX(14px); background: #fff; }
.mydsh-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.mydsh-switch:disabled { opacity: .45; cursor: not-allowed; }

.mydsh-input, .mydsh-select, .mydsh-area { appearance: none; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  padding: 6px 9px; min-width: 0; transition: border-color .12s, background .12s; }
.mydsh-input:hover, .mydsh-select:hover, .mydsh-area:hover { border-color: var(--dsw-alias-border-l2); }
.mydsh-input:focus, .mydsh-select:focus, .mydsh-area:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.mydsh-area { resize: vertical; min-height: 76px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.5; }
.mydsh-input[data-width="sm"] { width: 76px; }
.mydsh-input[data-width="md"] { width: 140px; }
.mydsh-input[data-width="lg"] { width: 220px; }
.mydsh-input[data-width="xl"] { width: 100%; }

.mydsh-btn { appearance: none; font: inherit; font-size: 12px; padding: 6px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  display: inline-flex; align-items: center; gap: 5px; transition: background .12s, border-color .12s, opacity .12s; white-space: nowrap; }
.mydsh-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l2); }
.mydsh-btn:disabled { opacity: .5; cursor: not-allowed; }
.mydsh-btn[data-variant="primary"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.mydsh-btn[data-variant="primary"]:hover:not(:disabled) { filter: brightness(1.08); }
.mydsh-btn[data-variant="ghost"] { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.mydsh-btn[data-variant="ghost"]:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.mydsh-btn[data-variant="danger"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-border-l1); }
.mydsh-btn[data-variant="danger"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.mydsh-btn[data-size="sm"] { padding: 3px 8px; font-size: 11px; }

.mydsh-seg { display: inline-flex; padding: 2px; gap: 2px; background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; }
.mydsh-seg button { appearance: none; border: 0; background: transparent; font: inherit; font-size: 11px; padding: 3px 9px;
  border-radius: 7px; color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; }
.mydsh-seg button[data-active="true"] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600;
  box-shadow: 0 1px 2px rgb(0 0 0 / .12); }

.mydsh-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.mydsh-table th { text-align: left; font-weight: 600; font-size: 11px; color: var(--dsw-alias-label-secondary);
  padding: 4px 8px 6px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.mydsh-table td { padding: 5px 8px 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-variant-numeric: tabular-nums; vertical-align: middle; }
.mydsh-table tr:last-child td { border-bottom: 0; }
.mydsh-table td[data-num="true"], .mydsh-table th[data-num="true"] { text-align: right; }
.mydsh-table tr:hover td { background: var(--dsw-alias-bg-layer-2); }

.mydsh-bar { position: relative; height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.mydsh-bar > span { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--mydsh-accent, var(--dsw-alias-brand-primary)); }

.mydsh-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.mydsh-badge[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); }
.mydsh-badge[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); }
.mydsh-badge[data-tone="error"] { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); }

.mydsh-note { font-size: 11.5px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.mydsh-note[data-tone="ok"] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); color: var(--dsw-alias-state-success-primary); }
.mydsh-note[data-tone="warn"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); color: var(--dsw-alias-state-warn-primary); }
.mydsh-note[data-tone="error"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); color: var(--dsw-alias-state-error-primary); }

.mydsh-pill { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  font-size: 11px; font-variant-numeric: tabular-nums; cursor: default; }
.mydsh-pill[data-clickable="true"] { cursor: pointer; }
.mydsh-pill[data-clickable="true"]:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }

.mydsh-pop { position: fixed; z-index: 90; min-width: 240px; max-width: min(460px, calc(100vw - 24px)); max-height: 70vh; overflow: auto;
  background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  box-shadow: 0 12px 32px rgb(0 0 0 / .28); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.mydsh-pop-title { font-size: 12px; font-weight: 600; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mydsh-pop-foot { font-size: 11px; color: var(--dsw-alias-label-secondary); border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 7px; }

.mydsh-modal-mask { position: fixed; inset: 0; z-index: 100; background: rgb(0 0 0 / .38); display: flex;
  align-items: center; justify-content: center; padding: 20px; }
.mydsh-modal { background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px;
  box-shadow: 0 20px 60px rgb(0 0 0 / .34); width: min(720px, 100%); max-height: 84vh; display: flex; flex-direction: column; }
.mydsh-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mydsh-modal-body { padding: 14px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.mydsh-modal-foot { padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex;
  justify-content: flex-end; gap: 8px; }

.mydsh-chart { width: 100%; height: 148px; display: block; overflow: visible; }
.mydsh-chart-grid { stroke: var(--dsw-alias-border-l1); stroke-width: 1; }
.mydsh-chart-axis { fill: var(--dsw-alias-label-secondary); font-size: 9.5px; }
.mydsh-chart-line { fill: none; stroke: var(--dsw-alias-brand-primary); stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; }
.mydsh-chart-area { fill: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); }
.mydsh-chart-bar { fill: var(--dsw-alias-brand-primary); opacity: .85; }
.mydsh-chart-bar:hover { opacity: 1; }

.mydsh-heat { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 11px); gap: 2px; overflow-x: auto; }
.mydsh-heat span { width: 11px; height: 11px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2); }
.mydsh-heat span[data-level="1"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent); }
.mydsh-heat span[data-level="2"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, transparent); }
.mydsh-heat span[data-level="3"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 64%, transparent); }
.mydsh-heat span[data-level="4"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 88%, transparent); }

.mydsh-list { display: flex; flex-direction: column; gap: 6px; }
.mydsh-scroll { max-height: 320px; overflow: auto; }
.mydsh-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
@media (max-width: 820px) { .mydsh-split { grid-template-columns: minmax(0, 1fr); } }
.mydsh-inline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mydsh-grow { flex: 1 1 auto; min-width: 0; }
.mydsh-muted { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.mydsh-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.mydsh-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mydsh-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-secondary); flex-shrink: 0; }
.mydsh-dot[data-tone="ok"] { background: var(--dsw-alias-state-success-primary); }
.mydsh-dot[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.mydsh-dot[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }
.mydsh-compact .mydsh-row { padding: 4px 0; }
.mydsh-compact .mydsh-card { padding: 10px; gap: 7px; }

.mydsh-sidebar-meter { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: 8px;
  cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 11px; border: 1px solid transparent; }
.mydsh-sidebar-meter:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.mydsh-sidebar-meter-rail { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px;
  border-radius: 8px; cursor: pointer; color: var(--dsw-alias-label-secondary); }
.mydsh-sidebar-meter-rail:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }

.mydsh-tabbar-entry { display: inline-flex; align-items: center; gap: 4px; }
.mydsh-avatar { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-brand-primary); color: #fff; font-size: 11px; font-weight: 600; cursor: pointer;
  border: 0; padding: 0; flex-shrink: 0; }
.mydsh-avatar:hover { filter: brightness(1.08); }
.mydsh-avatar[data-size="sm"] { width: 22px; height: 22px; font-size: 10px; }

.mydsh-menu { display: flex; flex-direction: column; gap: 1px; }
.mydsh-menu button { appearance: none; border: 0; background: transparent; font: inherit; font-size: 12px; text-align: left;
  padding: 6px 9px; border-radius: 7px; color: var(--dsw-alias-label-primary); cursor: pointer; display: flex;
  align-items: center; gap: 7px; }
.mydsh-menu button:hover { background: var(--dsw-alias-bg-layer-2); }
.mydsh-menu button[data-active="true"] { color: var(--dsw-alias-brand-primary); font-weight: 600; }
`

/** Inject the stylesheet once per page, disposed with the plugin. */
function Styles() {
  return h('style', { 'data-mydsh': '', dangerouslySetInnerHTML: { __html: CSS } })
}

// --- primitives ------------------------------------------------------------

/** One labelled control row. */
function Row({ title, hint, children, stack }) {
  return h(
    'div',
    { className: 'mydsh-row', 'data-stack': stack === true ? 'true' : 'false' },
    h(
      'div',
      { className: 'mydsh-row-label' },
      h('span', { className: 'mydsh-row-title' }, title),
      hint === undefined ? null : h('span', { className: 'mydsh-row-hint' }, hint),
    ),
    h('div', { className: 'mydsh-row-control' }, children),
  )
}

/** A switch that behaves like the Host's own: `role="switch"`, keyboard aware. */
function Switch({ checked, onChange, label, disabled }) {
  return h('button', {
    type: 'button',
    role: 'switch',
    className: 'mydsh-switch',
    'aria-checked': checked === true,
    'aria-label': label,
    disabled: disabled === true,
    onClick: () => {
      if (disabled === true) return
      onChange(checked !== true)
    },
  })
}

/** A titled surface. */
function Card({ title, sub, actions, children, flat }) {
  return h(
    'section',
    { className: 'mydsh-card', 'data-flat': flat === true ? 'true' : 'false' },
    title === undefined && actions === undefined
      ? null
      : h(
          'header',
          { className: 'mydsh-card-head' },
          h(
            'div',
            null,
            h('div', { className: 'mydsh-card-title' }, title),
            sub === undefined ? null : h('div', { className: 'mydsh-card-sub' }, sub),
          ),
          actions === undefined ? null : h('div', { className: 'mydsh-inline' }, actions),
        ),
    children,
  )
}

/** One headline number. */
function Stat({ label, value, foot, accent, title }) {
  return h(
    'div',
    { className: 'mydsh-stat', title, style: accent === undefined ? undefined : { '--mydsh-accent': accent } },
    h('span', { className: 'mydsh-stat-label' }, label),
    h('span', { className: 'mydsh-stat-value' }, value),
    foot === undefined ? null : h('span', { className: 'mydsh-stat-foot' }, foot),
  )
}

/** A short inline message. */
function Note({ tone, children }) {
  return h('div', { className: 'mydsh-note', 'data-tone': tone }, children)
}

/** A small status chip. */
function Badge({ tone, children }) {
  return h('span', { className: 'mydsh-badge', 'data-tone': tone }, children)
}

/** A text input with an optional width preset. */
function TextField({ value, onChange, placeholder, type, width, disabled, mono, onEnter }) {
  return h('input', {
    className: mono === true ? 'mydsh-input mydsh-mono' : 'mydsh-input',
    'data-width': width ?? 'md',
    type: type ?? 'text',
    value: value ?? '',
    placeholder,
    disabled,
    spellCheck: false,
    onChange: (event) => onChange(event.target.value),
    onKeyDown: (event) => {
      if (event.key === 'Enter' && typeof onEnter === 'function') onEnter()
    },
  })
}

/** A multiline input. */
function TextArea({ value, onChange, placeholder, rows, mono = true }) {
  return h('textarea', {
    className: mono === true ? 'mydsh-area mydsh-mono' : 'mydsh-area',
    rows: rows ?? 5,
    value: value ?? '',
    placeholder,
    spellCheck: false,
    onChange: (event) => onChange(event.target.value),
  })
}

/** A select box over `[{ value, label }]`. */
function Select({ value, onChange, options, width, disabled }) {
  return h(
    'select',
    {
      className: 'mydsh-select',
      'data-width': width ?? 'md',
      value: value ?? '',
      disabled,
      onChange: (event) => onChange(event.target.value),
    },
    options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
  )
}

/** A segmented control over `[{ value, label }]`. */
function Segmented({ value, onChange, options }) {
  return h(
    'div',
    { className: 'mydsh-seg', role: 'tablist' },
    options.map((option) =>
      h(
        'button',
        {
          key: option.value,
          type: 'button',
          role: 'tab',
          'data-active': value === option.value,
          'aria-selected': value === option.value,
          onClick: () => onChange(option.value),
        },
        option.label,
      ),
    ),
  )
}

/** A button with a variant and a pending state. */
function Button({ children, onClick, variant, size, disabled, title, type }) {
  return h(
    'button',
    {
      type: type ?? 'button',
      className: 'mydsh-btn',
      'data-variant': variant,
      'data-size': size,
      disabled: disabled === true,
      title,
      onClick,
    },
    children,
  )
}

/** A horizontal meter. */
function Bar({ ratio, accent, height }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(Number(ratio)) ? Number(ratio) : 0))
  return h(
    'div',
    { className: 'mydsh-bar', style: { height: height ?? 6 } },
    h('span', {
      style: {
        width: `${clamped * 100}%`,
        '--mydsh-accent': accent,
      },
    }),
  )
}

/** An empty state. */
function Empty({ children }) {
  return h('div', { className: 'mydsh-muted', style: { padding: '14px 0', textAlign: 'center' } }, children ?? t().empty)
}

// --- charts ----------------------------------------------------------------

/**
 * A line chart drawn as plain SVG.
 *
 * SVG keeps the whole chart inside the theme tokens and costs no dependency; at
 * ~120 points the DOM is smaller than the payload of a chart library would be.
 */
function LineChart({ points, height = 148, format }) {
  const list = Array.isArray(points) ? points : []
  if (list.length === 0) return h(Empty)
  const width = 600
  const padLeft = 38
  const padRight = 8
  const padTop = 8
  const padBottom = 18
  const plotW = width - padLeft - padRight
  const plotH = height - padTop - padBottom
  const peak = Math.max(1, ...list.map((point) => Number(point.value ?? 0)))
  const stepX = list.length === 1 ? 0 : plotW / (list.length - 1)
  const x = (index) => padLeft + index * stepX
  const y = (value) => padTop + plotH - (Math.max(0, Number(value) || 0) / peak) * plotH
  const line = list.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')
  const area = `${line} L${x(list.length - 1).toFixed(1)},${padTop + plotH} L${padLeft},${padTop + plotH} Z`
  const ticks = [0, 0.5, 1].map((ratio) => ({
    y: padTop + plotH - ratio * plotH,
    label: format === undefined ? tokens(peak * ratio) : format(peak * ratio),
  }))
  const labelIndexes = list.length <= 4 ? list.map((_, index) => index) : [0, Math.floor((list.length - 1) / 2), list.length - 1]
  return h(
    'svg',
    { className: 'mydsh-chart', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img' },
    ticks.map((tick, index) =>
      h('g', { key: `t${index}` },
        h('line', { className: 'mydsh-chart-grid', x1: padLeft, x2: width - padRight, y1: tick.y, y2: tick.y }),
        h('text', { className: 'mydsh-chart-axis', x: 2, y: tick.y + 3 }, tick.label),
      ),
    ),
    h('path', { className: 'mydsh-chart-area', d: area }),
    h('path', { className: 'mydsh-chart-line', d: line }),
    labelIndexes.map((index) =>
      h(
        'text',
        {
          key: `x${index}`,
          className: 'mydsh-chart-axis',
          x: x(index),
          y: height - 4,
          textAnchor: index === 0 ? 'start' : index === list.length - 1 ? 'end' : 'middle',
        },
        list[index]?.label ?? '',
      ),
    ),
  )
}

/** A stacked vertical bar chart, one bar per point. */
function BarChart({ points, height = 148, format }) {
  const list = Array.isArray(points) ? points : []
  if (list.length === 0) return h(Empty)
  const width = 600
  const padLeft = 34
  const padRight = 6
  const padTop = 8
  const padBottom = 18
  const plotW = width - padLeft - padRight
  const plotH = height - padTop - padBottom
  const peak = Math.max(1, ...list.map((point) => Number(point.value ?? 0)))
  const slot = plotW / list.length
  const barW = Math.max(1, Math.min(18, slot * 0.62))
  const ticks = [0, 0.5, 1].map((ratio) => ({
    y: padTop + plotH - ratio * plotH,
    label: format === undefined ? tokens(peak * ratio) : format(peak * ratio),
  }))
  return h(
    'svg',
    { className: 'mydsh-chart', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img' },
    ticks.map((tick, index) =>
      h('g', { key: `t${index}` },
        h('line', { className: 'mydsh-chart-grid', x1: padLeft, x2: width - padRight, y1: tick.y, y2: tick.y }),
        h('text', { className: 'mydsh-chart-axis', x: 2, y: tick.y + 3 }, tick.label),
      ),
    ),
    list.map((point, index) => {
      const value = Math.max(0, Number(point.value ?? 0))
      const barH = (value / peak) * plotH
      return h('rect', {
        key: `b${index}`,
        className: 'mydsh-chart-bar',
        x: padLeft + index * slot + (slot - barW) / 2,
        y: padTop + plotH - barH,
        width: barW,
        height: Math.max(value > 0 ? 1 : 0, barH),
        rx: Math.min(2, barW / 2),
      })
    }),
    [0, Math.floor((list.length - 1) / 2), list.length - 1]
      .filter((value, index, self) => self.indexOf(value) === index)
      .map((index) =>
        h(
          'text',
          {
            key: `x${index}`,
            className: 'mydsh-chart-axis',
            x: padLeft + index * slot + slot / 2,
            y: height - 4,
            textAnchor: index === 0 ? 'start' : index === list.length - 1 ? 'end' : 'middle',
          },
          list[index]?.label ?? '',
        ),
      ),
  )
}

/** A 7 × N activity heat map, most recent column on the right. */
function HeatMap({ days }) {
  const list = Array.isArray(days) ? days : []
  if (list.length === 0) return h(Empty)
  const peak = Math.max(1, ...list.map((day) => Number(day.value ?? 0)))
  return h(
    'div',
    { className: 'mydsh-heat', role: 'img' },
    list.map((day, index) => {
      const ratio = Number(day.value ?? 0) / peak
      const level = ratio === 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.8 ? 3 : 4
      return h('span', {
        key: `${day.t ?? index}`,
        'data-level': level,
        title: `${day.label ?? ''} ${exact(day.value)}`,
      })
    }),
  )
}

/** A donut for category shares. */
function Donut({ slices, size = 96, label, sub }) {
  const list = (Array.isArray(slices) ? slices : []).filter((slice) => Number(slice.value) > 0)
  const total = list.reduce((sum, slice) => sum + Number(slice.value), 0)
  if (total <= 0) return h(Empty)
  const radius = size / 2 - 7
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return h(
    'svg',
    { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', style: { flexShrink: 0 } },
    h('circle', {
      cx: size / 2,
      cy: size / 2,
      r: radius,
      fill: 'none',
      stroke: 'var(--dsw-alias-bg-layer-2)',
      strokeWidth: 11,
    }),
    list.map((slice, index) => {
      const length = (Number(slice.value) / total) * circumference
      const dash = `${length} ${circumference - length}`
      const element = h('circle', {
        key: index,
        cx: size / 2,
        cy: size / 2,
        r: radius,
        fill: 'none',
        stroke: slice.color ?? 'var(--dsw-alias-brand-primary)',
        strokeWidth: 11,
        strokeDasharray: dash,
        strokeDashoffset: -offset,
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      })
      offset += length
      return element
    }),
    label === undefined
      ? null
      : h('text', {
          x: size / 2,
          y: size / 2 + (sub === undefined ? 4 : -1),
          textAnchor: 'middle',
          fill: 'var(--dsw-alias-label-primary)',
          fontSize: 12,
          fontWeight: 600,
        }, label),
    sub === undefined
      ? null
      : h('text', {
          x: size / 2,
          y: size / 2 + 12,
          textAnchor: 'middle',
          fill: 'var(--dsw-alias-label-secondary)',
          fontSize: 9,
        }, sub),
  )
}

/** A legend for a donut or stacked chart. */
function Legend({ items }) {
  return h(
    'div',
    { className: 'mydsh-list', style: { fontSize: 11.5 } },
    (items ?? []).map((item, index) =>
      h(
        'div',
        { key: index, className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
        h('span', { className: 'mydsh-inline', style: { minWidth: 0 } },
          h('span', { className: 'mydsh-dot', style: { background: item.color } }),
          h('span', { className: 'mydsh-truncate' }, item.label),
        ),
        h('span', { className: 'mydsh-muted', style: { fontVariantNumeric: 'tabular-nums' } },
          item.percent === undefined ? item.value : `${item.percent} · ${percent(item.ratio, 1)}`),
      ),
    ),
  )
}

// --- overlays --------------------------------------------------------------

/** A modal rendered into the document body so column clipping cannot cut it. */
function Modal({ title, children, footer, onClose }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return ReactDOM.createPortal(
    h(
      'div',
      {
        className: 'mydsh-modal-mask',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      },
      h(
        'div',
        { className: 'mydsh-modal', role: 'dialog', 'aria-modal': 'true' },
        h(
          'header',
          { className: 'mydsh-modal-head' },
          h('div', { className: 'mydsh-card-title' }, title),
          h(Button, { variant: 'ghost', size: 'sm', onClick: onClose, title: t().close }, '✕'),
        ),
        h('div', { className: 'mydsh-modal-body' }, children),
        footer === undefined ? null : h('div', { className: 'mydsh-modal-foot' }, footer),
      ),
    ),
    document.body,
  )
}

/**
 * A popover anchored to an element, rendered into the body.
 *
 * The anchor rect is measured on open and re-measured on scroll so a menu that
 * is opened from a clipped row still lands in the right place.
 */
function Popover({ anchor, open, onClose, children, align }) {
  const [rect, setRect] = useState(undefined)
  useEffect(() => {
    if (!open || anchor === null || anchor === undefined) return undefined
    const measure = () => {
      const element = typeof anchor === 'function' ? anchor() : anchor.current ?? anchor
      if (element === null || element === undefined) return
      const box = element.getBoundingClientRect()
      setRect({ top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, anchor])
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (event.target.closest?.('.mydsh-pop') !== null) return
      onClose()
    }
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])
  if (!open || rect === undefined) return null
  const style = { top: Math.min(rect.bottom + 6, window.innerHeight - 120) }
  if (align === 'end') style.right = Math.max(8, window.innerWidth - rect.right)
  else style.left = Math.min(Math.max(8, rect.left), window.innerWidth - 260)
  return ReactDOM.createPortal(h('div', { className: 'mydsh-pop', style }, children), document.body)
}

/**
 * `createPortal` with a graceful fallback.
 *
 * The browser module table provides `react-dom`, and both the shipped statistics
 * dialog and the installed usage plugin portal through it. It is still resolved
 * lazily and defensively: this plugin must keep rendering if a future Host drops
 * the entry from the table, and an overlay drawn inline is usable even when it
 * is clipped by the column that contains it.
 */
const ReactDOM = (() => {
  let resolved
  let failed = false
  const portal = (children, container) => {
    if (!failed && resolved === undefined) {
      try {
        resolved = require('react-dom')
      } catch {
        failed = true
      }
    }
    if (failed || typeof resolved?.createPortal !== 'function') return children
    try {
      return resolved.createPortal(children, container)
    } catch {
      failed = true
      return children
    }
  }
  return { createPortal: portal }
})()

    // ===== 20-data.js =====
/**
 * Data hooks.
 *
 * Every tab needs the same three things from the Host — a one-shot fetch, a
 * periodic refresh, and a way to fire an action and see the result — so they are
 * written once here instead of per tab. Two rules make the polling safe:
 *
 * - A hidden tab does not poll. `document.hidden` is checked before every tick,
 *   which is what keeps ten open entries from costing anything while the user is
 *   working in another window.
 * - A slow answer does not stack. Each hook keeps an in-flight flag and skips a
 *   tick while the previous request is still running, so a 90-day usage scan
 *   cannot queue eight more scans behind it.
 */

/**
 * Fetch `path` on mount and every `intervalMs`, re-fetching when any dependency
 * changes. Returns `{ data, error, loading, reload }`.
 *
 * @param path - path below `/api/mydsh`, or `null` to stay idle.
 * @param intervalMs - poll period; 0 disables the timer.
 * @param deps - values that force an immediate re-fetch when they change.
 */
function usePoll(path, intervalMs, deps) {
  const [data, setData] = useState(undefined)
  const [error, setError] = useState(undefined)
  const [loading, setLoading] = useState(path !== null)
  const generation = useRef(0)
  const inflight = useRef(false)
  const signature = JSON.stringify(deps ?? [])

  const load = useCallback(
    (quiet) => {
      if (path === null) {
        setLoading(false)
        return Promise.resolve(undefined)
      }
      if (inflight.current) return Promise.resolve(undefined)
      inflight.current = true
      const mine = generation.current
      if (quiet !== true) setLoading(true)
      return api(path)
        .then((value) => {
          if (generation.current !== mine) return value
          setData(value)
          setError(undefined)
          return value
        })
        .catch((failure) => {
          if (generation.current === mine) setError(failure?.message ?? String(failure))
          return undefined
        })
        .finally(() => {
          inflight.current = false
          if (generation.current === mine) setLoading(false)
        })
    },
    // `signature` is the stringified dependency list, which is what actually
    // makes the callback change when a query parameter changes.
    [path, signature],
  )

  useEffect(() => {
    generation.current += 1
    load(false)
    return () => {
      generation.current += 1
    }
  }, [load])

  useEffect(() => {
    if (intervalMs === 0 || path === null) return undefined
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      load(true)
    }, intervalMs)
    const onVisible = () => {
      if (!document.hidden) load(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load, intervalMs, path])

  return { data, error, loading, reload: () => load(false) }
}

/**
 * Run one action against the Host and expose its pending and error state.
 * Returns `[run, state]` so a caller can `await run()` in a click handler.
 */
function useAction() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(undefined)
  const [result, setResult] = useState(undefined)

  const run = useCallback(async (path, body) => {
    setPending(true)
    setError(undefined)
    try {
      const value = await api(path, { body })
      setResult(value)
      return value
    } catch (failure) {
      setError(failure?.message ?? String(failure))
      return undefined
    } finally {
      setPending(false)
    }
  }, [])

  return [run, { pending, error, result, setError }]
}

/** Today's start in local time, matching the Host's window logic. */
function startOfToday() {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** One time range as the Host expects it. */
const RANGE_PRESETS = [
  { value: 'today', key: 'rangeToday', days: 1 },
  { value: '3d', key: 'range3d', days: 3 },
  { value: '7d', key: 'range7d', days: 7 },
  { value: '30d', key: 'range30d', days: 30 },
  { value: '90d', key: 'range90d', days: 90 },
  { value: 'custom', key: 'rangeCustom', days: 0 },
]

/** A range picker that yields the query string fragment the Host parses. */
function RangeBar({ value, onChange, from, to, onFrom, onTo }) {
  const locale = activeLocale()
  const options = RANGE_PRESETS.map((preset) => ({ value: preset.value, label: t()[preset.key] }))
  return h(
    'div',
    { className: 'mydsh-inline' },
    h(Segmented, { value, onChange, options }),
    value !== 'custom'
      ? null
      : h(
          'div',
          { className: 'mydsh-inline' },
          h('input', {
            className: 'mydsh-input',
            type: 'date',
            value: from,
            onChange: (event) => onFrom(event.target.value),
          }),
          h('span', { className: 'mydsh-muted' }, locale === 'zh' ? '至' : 'to'),
          h('input', {
            className: 'mydsh-input',
            type: 'date',
            value: to,
            onChange: (event) => onTo(event.target.value),
          }),
        ),
  )
}

/** Build the `/usage/...` query for one range selection. */
function usageQuery(range, from, to) {
  if (range !== 'custom') return `range=${encodeURIComponent(range)}`
  const fromMs = from === '' ? 0 : new Date(`${from}T00:00:00`).getTime()
  const toMs = to === '' ? 0 : new Date(`${to}T23:59:59`).getTime()
  return `range=custom&from=${fromMs}&to=${toMs}`
}

/** Format a byte pair as "x / y" for estimate rows. */
function estimateLine(estimate) {
  if (estimate === undefined) return '—'
  return `${bytes(estimate.bytes)} · ${exact(estimate.files)}`
}

    // ===== 40-settings-shell.js =====
/**
 * Settings page shell.
 *
 * One `settings.section` entry draws a header, a tab strip, and whichever tab
 * body is selected. Each tab lives in its own source file and receives the same
 * three props — `settings`, `patch`, `meta` — so a tab can be reviewed on its
 * own and a failure in one tab cannot take down the others.
 *
 * Tabs are declared twice on purpose: `TAB_TABS` is the ordered list of every
 * tab this plugin can show, and `visibleTabs` drops the ones the user switched
 * off in Interface. `Overview` and `About` are never dropped: the page needs at
 * least one tab, and About is where an unsupported-environment explanation
 * lives.
 */

/** Static metadata the Host reports once: providers, models, workspaces. */
const metaStore = (() => {
  let value
  let pending
  const listeners = new Set()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  const load = () => {
    if (value !== undefined) return Promise.resolve(value)
    if (pending !== undefined) return pending
    pending = api('/settings')
      .then((result) => {
        value = result.meta ?? {}
        pending = undefined
        emit()
        return value
      })
      .catch(() => {
        pending = undefined
        return {}
      })
    return pending
  }
  return {
    load,
    get: () => value ?? {},
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
})()

/** Subscribe to the Host metadata, loading it on first use. */
function useMeta() {
  const meta = useSyncExternalStore(metaStore.subscribe, metaStore.get, metaStore.get)
  useEffect(() => {
    metaStore.load()
  }, [])
  return meta
}

/** Provider/model options for a picker, with an "any" row first. */
function providerOptions(meta, anyLabel) {
  const list = Array.isArray(meta?.providers) ? meta.providers : []
  return [{ value: '', label: anyLabel ?? '—' }].concat(
    list.map((entry) => ({ value: entry.provider, label: entry.provider })),
  )
}

/** Model options for one provider, or every model when `provider` is empty. */
function modelOptions(meta, provider, anyLabel) {
  const list = Array.isArray(meta?.providers) ? meta.providers : []
  const rows = []
  for (const entry of list) {
    if (provider !== '' && entry.provider !== provider) continue
    for (const model of entry.models ?? []) {
      rows.push({
        value: `${entry.provider}::${model.id}`,
        label: provider === '' ? `${entry.provider} · ${model.name ?? model.id}` : (model.name ?? model.id),
      })
    }
  }
  return [{ value: '', label: anyLabel ?? '—' }].concat(rows)
}

/** Workspace options for a picker. */
function workspaceOptions(meta, anyLabel) {
  const list = Array.isArray(meta?.workspaces) ? meta.workspaces : []
  return [{ value: '', label: anyLabel ?? '—' }].concat(
    list.map((entry) => ({ value: entry.path, label: entry.title === '' ? entry.path : entry.title })),
  )
}

/** The order every tab is declared in. */
const TAB_ORDER = ['overview', 'interface', 'usage', 'backup', 'retry', 'personalize', 'modules', 'relay', 'about']

/** Tab metadata: label key into `t()`, and whether a switch can hide it. */
const TAB_META = {
  overview: { key: 'tabOverview', closable: false },
  interface: { key: 'tabInterface', closable: false },
  usage: { key: 'tabUsage', closable: true, entry: 'settingsUsage' },
  backup: { key: 'tabBackup', closable: true, entry: 'settingsBackup' },
  retry: { key: 'tabRetry', closable: true, entry: 'settingsRetry' },
  personalize: { key: 'tabPersonalize', closable: true, entry: 'settingsPersonalize' },
  modules: { key: 'tabModules', closable: true, entry: 'settingsModules' },
  relay: { key: 'tabRelay', closable: true, entry: 'settingsRelay' },
  about: { key: 'tabAbout', closable: false },
}

/**
 * The settings page.
 *
 * `patch` merges into the settings document and resolves with the accepted
 * document. Every control calls it, so a switch takes effect on the next frame
 * (the store applies the patch optimistically) and is confirmed by the Host's
 * answer.
 */
function Page() {
  const settings = useSettings()
  const meta = useMeta()
  const [tab, setTab] = useState('overview')
  const [error, setError] = useState(undefined)
  const [pending, setPending] = useState(false)
  const locale = activeLocale()

  const patch = useCallback(
    async (partial) => {
      setPending(true)
      try {
        const next = await settingsStore.patch(partial)
        setError(undefined)
        return next
      } catch (failure) {
        setError(failure?.message ?? String(failure))
        throw failure
      } finally {
        setPending(false)
      }
    },
    [],
  )

  if (settings === undefined) {
    return h(Styles, null, h('div', { className: 'mydsh-root mydsh-page' }, h(Empty, null, t().loading)))
  }

  const entries = settings.ui?.entries ?? {}
  const visible = TAB_ORDER.filter((key) => {
    const info = TAB_META[key]
    if (info.closable !== true) return true
    // A hidden tab falls back to nothing: the strip keeps Overview either way.
    return entries[info.entry] !== false
  })
  const active = visible.includes(tab) ? tab : 'overview'

  const body = (() => {
    switch (active) {
      case 'interface':
        return h(InterfaceTab, { settings, patch, meta })
      case 'usage':
        return h(UsageSettingsTab, { settings, patch, meta })
      case 'backup':
        return h(BackupTab, { settings, patch, meta })
      case 'retry':
        return h(RetryTab, { settings, patch, meta })
      case 'personalize':
        return h(PersonalizeTab, { settings, patch, meta })
      case 'modules':
        return h(ModulesTab, { settings, patch, meta })
      case 'relay':
        return h(RelayTab, { settings, patch, meta })
      case 'about':
        return h(AboutTab, { settings, patch, meta })
      default:
        return h(OverviewTab, { settings, patch, meta })
    }
  })()

  return h(
    'div',
    { className: `mydsh-root mydsh-page${settings.ui?.compact === true ? ' mydsh-compact' : ''}` },
    h(Styles),
    h(
      'header',
      { className: 'mydsh-head' },
      h(
        'div',
        null,
        h('h2', null, t().appTitle),
        h('p', null, t().appSubtitle),
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        pending ? h('span', { className: 'mydsh-muted' }, t().saving) : null,
        h(Button, { variant: 'ghost', size: 'sm', onClick: () => settingsStore.refresh(true) }, `⟳ ${t().refresh}`),
      ),
    ),
    error === undefined ? null : h(Note, { tone: 'error' }, error),
    h(
      'nav',
      { className: 'mydsh-tabs', role: 'tablist' },
      visible.map((key) =>
        h(
          'button',
          {
            key,
            type: 'button',
            role: 'tab',
            className: 'mydsh-tab',
            'data-active': key === active,
            'aria-selected': key === active,
            onClick: () => setTab(key),
          },
          t()[TAB_META[key].key],
        ),
      ),
    ),
    h('div', { key: active }, body),
    h('div', { className: 'mydsh-muted', style: { textAlign: 'right', fontSize: 10.5 } },
      `${meta.dshVersion ?? ''} · ${locale === 'zh' ? '设置保存在本机' : 'Settings are local'}`),
  )
}

    // ===== 41-tab-interface.js =====
/**
 * Interface tab.
 *
 * Every switch here writes straight through `patch`, which applies the value
 * optimistically and persists it; the decorations live in this same page and
 * subscribe to the same store, so a switch toggles its effect on the next frame
 * instead of after a reload. That is the whole reason the settings document is
 * the single source of truth rather than React state.
 */

/** One switch row bound to a settings path. */
function SwitchRow({ title, hint, checked, onChange, disabled }) {
  return h(
    Row,
    { title, hint },
    h(Switch, { checked: checked === true, onChange, label: title, disabled }),
  )
}

/** The interface tab. */
function InterfaceTab({ settings, patch }) {
  const ui = settings.ui
  const entries = ui.entries

  const setUi = (partial) => patch({ ui: partial })
  const setEntry = (key, value) => patch({ ui: { entries: { [key]: value } } })

  const entryRows = [
    ['sidebarPanel', '侧栏面板图标', '在侧栏面板列表里增加「我的 DSH」图标，点击打开独立页面'],
    ['footerUsage', '侧栏底部用量条', '在侧栏底部显示一行用量，点击打开用量页'],
    ['tabContext', '标签栏：上下文', '在会话标签栏增加「上下文」视图'],
    ['tabTeam', '标签栏：编队', '在会话标签栏增加「编队」视图'],
    ['tabUsage', '标签栏：用量', '在会话标签栏增加「用量」视图'],
    ['inputAutoContinue', '输入框：自动续跑方式', '在输入框工具行增加续跑策略菜单'],
    ['dockGeekMetrics', '输入区状态栏：极客请求指标', '显示首字时间、速度、token，点击展开最近请求'],
    ['dockSessionCost', '输入区状态栏：本会话消耗估算', '显示本会话累计 token 与预估费用'],
    ['dockSessionTokens', '输入区状态栏：本会话 token 计数', '只显示一个 token 计数，样式更克制'],
    ['titlebarContext', '标题栏：上下文压力', '在标题栏显示上下文占用胶囊'],
  ]

  const settingsRows = [
    ['settingsUsage', '用量与计费分页'],
    ['settingsBackup', '备份分页'],
    ['settingsRetry', '重试分页'],
    ['settingsPersonalize', '个性化分页'],
    ['settingsModules', '能力模块分页'],
    ['settingsRelay', '远程访问分页'],
  ]

  return h(
    'div',
    { className: 'mydsh-page' },
    h(
      Card,
      { title: '品牌与外壳', sub: '隐藏原生元素来把空间还给内容；每项独立生效' },
      h(SwitchRow, {
        title: '隐藏「新会话」按钮',
        hint: '侧栏顶部的新建会话行整行隐藏',
        checked: ui.hideNewSession,
        onChange: (value) => setUi({ hideNewSession: value }),
      }),
      h(SwitchRow, {
        title: '隐藏侧栏图标',
        hint: '`deepseek HARNESS` 前的图形标志',
        checked: ui.hideBrandMark,
        onChange: (value) => setUi({ hideBrandMark: value }),
      }),
      h(SwitchRow, {
        title: '隐藏侧栏文字',
        hint: '`deepseek HARNESS` 字样，与图标分开控制',
        checked: ui.hideBrandName,
        onChange: (value) => setUi({ hideBrandName: value }),
      }),
      h(SwitchRow, {
        title: '隐藏侧栏折叠按钮',
        hint: '收起/展开侧栏的控制',
        checked: ui.hideSidebarToggle,
        onChange: (value) => setUi({ hideSidebarToggle: value }),
      }),
      h(SwitchRow, {
        title: '账户入口移到标题栏',
        hint: '侧栏底部的用户区改为标题栏左侧的头像，腾出侧栏底部空间',
        checked: ui.accountToTitlebar,
        onChange: (value) => setUi({ accountToTitlebar: value }),
      }),
      h(SwitchRow, {
        title: '标题栏只显示头像',
        hint: '点击头像弹出 设置 / 退出 / 反馈，不显示用户名',
        checked: ui.accountAvatarOnly,
        onChange: (value) => setUi({ accountAvatarOnly: value }),
        disabled: ui.accountToTitlebar !== true,
      }),
    ),
    h(
      Card,
      { title: '列表与密度', sub: '会话列表的分组方式和整体密度' },
      h(
        Row,
        { title: '点击切换分组', hint: '点击侧栏的「工作区 / 会话」按钮时，下方列表随之切换分组' },
        h(Switch, {
          checked: ui.sidebarViewClickToggle === true,
          onChange: (value) => setUi({ sidebarViewClickToggle: value }),
          label: '点击切换分组',
        }),
      ),
      h(
        Row,
        { title: '默认分组', hint: '进入 DSH 时列表按什么分组' },
        h(Segmented, {
          value: ui.sidebarView,
          onChange: (value) => setUi({ sidebarView: value }),
          options: [
            { value: 'workspace', label: '按工作区' },
            { value: 'flat', label: '按会话' },
          ],
        }),
      ),
      h(
        Row,
        { title: '密度', hint: '紧凑会缩小行高与卡片内边距' },
        h(Segmented, {
          value: ui.density,
          onChange: (value) => setUi({ density: value, compact: value === 'compact' }),
          options: [
            { value: 'cozy', label: '标准' },
            { value: 'compact', label: '紧凑' },
            { value: 'spacious', label: '宽松' },
          ],
        }),
      ),
    ),
    h(
      Card,
      { title: '侧栏底部用量条', sub: '显示哪个区间的用量' },
      h(
        Row,
        { title: '指标', hint: '点用量条会打开用量页，并选中同一区间' },
        h(Segmented, {
          value: ui.footerUsageMetric,
          onChange: (value) => setUi({ footerUsageMetric: value }),
          options: [
            { value: 'today', label: t().today },
            { value: 'week', label: t().week },
            { value: 'month', label: t().month },
            { value: 'total', label: t().total },
          ],
        }),
      ),
      ui.entries.footerUsage === true
        ? null
        : h(Note, null, '侧栏底部用量条当前已关闭，打开上面的「侧栏底部用量条」后此设置才可见。'),
    ),
    h(
      Card,
      { title: '功能入口', sub: '关掉的入口不注册任何组件，不产生渲染与轮询开销' },
      entryRows.map(([key, title, hint]) =>
        h(SwitchRow, {
          key,
          title,
          hint,
          checked: entries[key] === true,
          onChange: (value) => setEntry(key, value),
        }),
      ),
    ),
    h(
      Card,
      { title: '设置页分页', sub: '不需要的分页可以直接隐藏，页面会少加载一块' },
      settingsRows.map(([key, title]) =>
        h(SwitchRow, {
          key,
          title,
          checked: entries[key] === true,
          onChange: (value) => setEntry(key, value),
        }),
      ),
    ),
    h(
      Card,
      { title: '全部恢复默认', sub: '只重置界面设置，不影响用量、备份与个性化' },
      h(
        Row,
        { title: '恢复界面默认值', hint: '开关全部回到出厂状态' },
        h(
          Button,
          {
            variant: 'danger',
            onClick: () => setUi(clone(DEFAULT_UI())),
          },
          '恢复默认',
        ),
      ),
    ),
  )
}

/** The interface defaults, mirrored from the Host document for the reset button. */
function DEFAULT_UI() {
  return {
    hideNewSession: false,
    hideBrandMark: false,
    hideBrandName: false,
    hideSidebarToggle: false,
    accountToTitlebar: false,
    accountAvatarOnly: true,
    sidebarView: 'workspace',
    sidebarViewClickToggle: true,
    compact: false,
    density: 'cozy',
    footerUsageMetric: 'today',
    entries: {
      sidebarPanel: false,
      footerUsage: true,
      settingsSection: true,
      tabContext: true,
      tabTeam: true,
      tabUsage: true,
      inputAutoContinue: true,
      dockGeekMetrics: true,
      dockSessionCost: true,
      dockSessionTokens: false,
      titlebarContext: false,
      settingsUsage: true,
      settingsBackup: true,
      settingsRetry: true,
      settingsPersonalize: true,
      settingsModules: true,
      settingsRelay: true,
    },
  }
}

    // ===== 42-tab-usage.js =====
/**
 * Usage & billing tab.
 *
 * The controls and the numbers they produce live on one screen on purpose: a
 * limit only means something next to the figure it caps, and the four surfaces
 * that read this doc (settings page, sidebar meter, composer dock, usage view)
 * all answer the same questions. Layout is grouped by the question, not by the
 * shape of the settings document:
 *
 *   what is counted  →  what it cost  →  what geek stats to show  →
 *   where the money is read  →  what may not be spent  →  what a token costs
 *
 * Two mechanics are deliberate:
 *
 * - Every write goes through `patch`, which applies optimistically and persists,
 *   so a switch flips on the same frame instead of after a save button.
 * - Read-only figures come from `usePoll` on the same routes the rest of the
 *   plugin uses. A read table therefore never disagrees with the panels.
 *
 * Text and number fields do *not* patch per keystroke: `UsageDraftField` keeps
 * the keystrokes local and commits once on blur or Enter. Patching per character
 * would POST the whole 40 KB document for every letter typed.
 */

// --- fixed choices ---------------------------------------------------------

/** Data sources the engine can read; `auto` prefers the DSH session log. */
const USAGE_SOURCE_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'local', label: '仅本机日志' },
  { value: 'provider', label: '供应商用量' },
]

/** The four dimensions `/usage/summary` always returns. */
const USAGE_DIM_OPTIONS = [
  { value: 'model', label: '按模型' },
  { value: 'provider', label: '按供应商' },
  { value: 'workspace', label: '按工作区' },
  { value: 'session', label: '按会话' },
]

const USAGE_BUDGET_SCOPES = [
  { value: 'global', label: '全局' },
  { value: 'provider', label: '供应商' },
  { value: 'model', label: '模型' },
  { value: 'workspace', label: '工作区' },
]

const USAGE_BUDGET_PERIODS = [
  { value: 'day', label: '每日' },
  { value: 'week', label: '每周' },
  { value: 'month', label: '每月' },
]

const USAGE_BUDGET_ACTIONS = [
  { value: 'notify', label: '仅提示' },
  { value: 'pause', label: '暂停请求' },
]

// --- small helpers ---------------------------------------------------------

/** Cache hit share over every prompt token, matching the host's own maths. */
function usageHitRate(cacheRead, input) {
  const cached = Number(cacheRead ?? 0) || 0
  const uncached = Number(input ?? 0) || 0
  const total = cached + uncached
  return total > 0 ? cached / total : 0
}

/**
 * Seconds with one decimal, or `—`.
 *
 * The host reports 0 for "never measured" as well as for "instant", and a 0 ms
 * first token is not a real reading: showing "0.0s" would claim a measurement
 * that did not happen.
 */
function usageSecondsText(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return '—'
  return `${(number / 1000).toFixed(1)}s`
}

/**
 * One request's outcome, as a label and a badge tone.
 *
 * `GeekRequest.status` is tri-state, not a success flag: `interrupted` is a
 * request the user stopped, which still carried usage and is not a failure. It
 * therefore gets its own label and a warning tone rather than being counted
 * against the session's failure rate.
 */
function usageRequestLabel(status) {
  if (status === 'ok') return '已完成'
  if (status === 'interrupted') return '已中断'
  if (status === 'failed') return '失败'
  return '未知'
}

function usageRequestTone(status) {
  if (status === 'ok') return 'ok'
  if (status === 'interrupted') return 'warn'
  return 'error'
}

/** True only for an outcome the user should read as a failure. */
function usageRequestFailed(status) {
  return status !== 'ok' && status !== 'interrupted'
}

/** The host's balance failure codes, in words a user can act on. */
function usageBalanceMessage(row) {
  const code = String(row?.message ?? '')
  if (code === '' || code === 'ok') return '正常'
  if (code === 'not-configured') return '未配置密钥或地址'
  if (code === 'disabled') return '已停用'
  if (code === 'no-url') return '未填写接口地址'
  if (code === 'timeout') return '请求超时'
  if (code === 'bad-json') return '返回不是 JSON'
  if (code === 'no-balance') return '返回里没有余额字段，检查路径'
  if (code === 'fetch-unavailable') return '宿主没有 fetch'
  if (code.startsWith('http-')) return `HTTP ${code.slice(5)}`
  return code
}

/** Clamp a typed number, or `undefined` when it is not a number at all. */
function usageNumber(text, min, max, integer) {
  const raw = String(text).replace(/[\s,]/g, '')
  if (raw === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return undefined
  const clamped = Math.min(max, Math.max(min, parsed))
  return integer === true ? Math.round(clamped) : clamped
}

/**
 * A field that holds keystrokes locally and commits on blur or Enter.
 *
 * The commit compares against the value the host accepted rather than against
 * the last keystroke, so tabbing through a field without changing it writes
 * nothing. While the field is idle it re-syncs from `value`, which is how a
 * normalised answer (a clamped number, a trimmed string) reaches the screen.
 */
function UsageDraftField({ value, onCommit, parse, type, width, mono, placeholder, disabled }) {
  const shown = value === undefined || value === null ? '' : String(value)
  const [text, setText] = useState(shown)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (dirty !== true) setText(shown)
  }, [shown, dirty])

  const commit = () => {
    if (dirty !== true) return
    setDirty(false)
    const next = parse === undefined ? text : parse(text)
    if (next === undefined) return
    if (String(next) === shown) return
    onCommit(next)
  }

  // The blur handler sits on a wrapper because `TextField` owns no blur prop;
  // React's onBlur bubbles from the input, so the wrapper sees the same event.
  return h(
    'span',
    { onBlur: commit, style: { display: 'inline-flex', minWidth: 0 } },
    h(TextField, {
      value: text,
      type: type ?? 'text',
      width,
      mono,
      placeholder,
      disabled,
      onChange: (next) => {
        setDirty(true)
        setText(next)
      },
      onEnter: commit,
    }),
  )
}

/** A number field: commits a clamped finite value and ignores half-typed text. */
function UsageNumberField({ value, onCommit, min, max, integer, width, placeholder }) {
  return h(UsageDraftField, {
    value,
    width: width ?? 'sm',
    placeholder,
    type: 'number',
    parse: (text) => usageNumber(text, min ?? 0, max ?? 1e9, integer),
    onCommit,
  })
}

/** A blank balance probe. Ids are stable so a saved row keeps its readings. */
function usageNewBalanceProvider() {
  return {
    id: newId('balance'),
    enabled: true,
    label: '',
    provider: '',
    url: '',
    method: 'GET',
    headers: '',
    body: '',
    totalPath: '',
    currencyPath: '',
    currency: 'CNY',
  }
}

/** A blank budget at the defaults the host would normalise it to anyway. */
function usageNewBudget() {
  return {
    id: newId('budget'),
    label: '',
    enabled: true,
    scope: 'global',
    period: 'day',
    action: 'notify',
    limitTokens: 0,
    limitCost: 0,
    threshold: 0.9,
    notifyOnce: true,
  }
}

/** A blank price override. Blank rows are dropped by the host, hence the draft. */
function usageNewPriceOverride() {
  return {
    id: newId('price'),
    provider: '',
    model: '',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    currency: 'CNY',
  }
}

// --- the tab ---------------------------------------------------------------

/** The usage tab: switches, live numbers, and the billing policy. */
function UsageSettingsTab({ settings, patch, meta }) {
  const usage = settings?.usage ?? {}
  const geek = usage.geekMetrics ?? {}
  const insight = usage.contextInsight ?? {}
  const balance = usage.balance ?? {}
  const deepseek = balance.deepseek ?? {}
  const providers = Array.isArray(balance.providers) ? balance.providers : []
  const budgets = Array.isArray(usage.budgets) ? usage.budgets : []
  const priceOverrides = Array.isArray(usage.priceOverrides) ? usage.priceOverrides : []

  const [range, setRange] = useState('7d')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [dim, setDim] = useState('model')

  const [priceSearch, setPriceSearch] = useState('')
  const [priceQuery, setPriceQuery] = useState('')

  const [runBalance, balanceAction] = useAction()
  /** Latest probe result per source id; only the test button ever fills it. */
  const [balanceRows, setBalanceRows] = useState({})

  /** Every write is fire-and-forget here; the page shell already reports errors. */
  const write = useCallback((partial) => Promise.resolve(patch(partial)).catch(() => undefined), [patch])

  // The response carries all four dimensions at once, so the ranking selector is
  // a pure view concern and does not need its own round trip.
  const query = usageQuery(range, from, to)
  const poolOption = Number(usage.recentRequestPool)
  const pool = Number.isFinite(poolOption) && poolOption > 0 ? Math.round(poolOption) : 20
  const summary = usePoll(`/usage/summary?${query}&dim=model`, 20000, [query])
  const recent = usePoll(`/usage/geek?pool=${pool}`, 20000, [pool])
  const budgetStatus = usePoll('/usage/budgets', 30000, [])
  const prices = usePoll(`/usage/prices?q=${encodeURIComponent(priceQuery)}`, 0, [priceQuery])

  // Typing in the price search must not fire one price scan per character.
  const pushPriceQuery = useMemo(() => debounce((value) => setPriceQuery(value), 320), [])
  useEffect(() => () => pushPriceQuery.cancel(), [pushPriceQuery])

  // The overrides editor is a draft, because the host drops a row whose provider
  // and model are both empty: patching each keystroke would make the row the
  // user just added disappear from under the cursor.
  const priceSignature = JSON.stringify(priceOverrides)
  const [priceDraft, setPriceDraft] = useState(() => clone(priceOverrides))
  const [priceDirty, setPriceDirty] = useState(false)
  useEffect(() => {
    if (priceDirty === true) return
    setPriceDraft(clone(priceOverrides))
  }, [priceSignature, priceDirty])

  // --- derived figures -----------------------------------------------------

  const totals = summary.data?.totals ?? {}
  const hasSummary = summary.data !== undefined
  const series = Array.isArray(summary.data?.series) ? summary.data.series : []
  const points = series.map((point) => ({ t: point.t, label: point.label, value: point.totalTokens }))
  const heatDays = series.map((point) => ({ t: point.t, label: point.label, value: point.totalTokens }))
  const rankRows = (summary.data?.dims?.[dim] ?? []).slice(0, 12)
  const rankTotal = Math.max(1, Number(totals.totalTokens ?? 0))
  const currency = totals.currency ?? 'CNY'
  const hitRate = usageHitRate(totals.cacheReadTokens, totals.inputTokens)
  const avgSpeed = Number(recent.data?.avg?.speed ?? 0)
  const totalDuration = Number(totals.durationMs ?? 0)
  const avgDuration = Number(totals.requests ?? 0) > 0 ? totalDuration / Number(totals.requests) : 0
  const evaluation = Array.isArray(budgetStatus.data?.evaluation) ? budgetStatus.data.evaluation : []

  // --- write helpers -------------------------------------------------------

  const setUsage = (partial) => write({ usage: partial })

  const setProvider = (index, partial) =>
    write({
      usage: {
        balance: {
          providers: providers.map((row, at) => (at === index ? { ...row, ...partial } : row)),
        },
      },
    })

  const addProvider = () => write({ usage: { balance: { providers: providers.concat([usageNewBalanceProvider()]) } } })

  const removeProvider = (index) =>
    write({ usage: { balance: { providers: providers.filter((_, at) => at !== index) } } })

  const setBudgets = (rows) => write({ usage: { budgets: rows } })

  const setBudget = (id, partial) =>
    setBudgets(budgets.map((row) => (row.id === id ? { ...row, ...partial } : row)))

  const addBudget = () => setBudgets(budgets.concat([usageNewBudget()]))

  const removeBudget = (id) => setBudgets(budgets.filter((row) => row.id !== id))

  const setPriceRow = (id, partial) => {
    setPriceDirty(true)
    setPriceDraft((rows) => rows.map((row) => (row.id === id ? { ...row, ...partial } : row)))
  }

  const addPriceRow = () => {
    setPriceDirty(true)
    setPriceDraft((rows) => rows.concat([usageNewPriceOverride()]))
  }

  const removePriceRow = (id) => {
    setPriceDirty(true)
    setPriceDraft((rows) => rows.filter((row) => row.id !== id))
  }

  const savePrices = () => {
    write({ usage: { priceOverrides: priceDraft } }).then((accepted) => {
      // When the host refused the write the draft must stay dirty, otherwise the
      // editor silently reverts to the stored list and the user loses the edit.
      if (accepted === undefined) return
      setPriceDirty(false)
      prices.reload()
    })
  }

  /** Probe one source, then keep its row so the badge is not overwritten. */
  const testBalance = async (source, id) => {
    const value = await runBalance('/usage/balance?force=1')
    if (value === undefined) return
    const row =
      source === 'deepseek'
        ? value.deepseek
        : (Array.isArray(value.providers) ? value.providers : []).find((entry) => entry.id === id)
    setBalanceRows((prev) => ({ ...prev, [id]: row ?? { ok: false, message: 'not-found' } }))
  }

  const modelRows = (provider) => modelOptions(meta, provider ?? '', '不限模型')

  // --- render --------------------------------------------------------------

  return h(
    'div',
    { className: 'mydsh-page' },
    usage.enabled === false
      ? h(Note, { tone: 'warn' }, '用量统计当前已关闭：下面的看板、预算进度与请求预览都不会有新数据，打开后由宿主重新扫描会话日志。')
      : null,

    // 1 — what is counted ---------------------------------------------------
    h(
      Card,
      { title: '总开关与数据源', sub: '计数口径决定下面所有数字从哪里来' },
      h(
        Row,
        { title: '启用用量统计', hint: '关闭后不扫描会话日志，标签栏「用量」与侧栏用量条也不出数' },
        h(Switch, {
          checked: usage.enabled === true,
          onChange: (value) => setUsage({ enabled: value }),
          label: '启用用量统计',
        }),
      ),
      h(
        Row,
        { title: '数据源', hint: '自动：优先本机日志，供应商回传的用量作为补充' },
        h(Segmented, {
          value: usage.source ?? 'auto',
          onChange: (value) => setUsage({ source: value }),
          options: USAGE_SOURCE_OPTIONS,
        }),
      ),
      h(
        Row,
        { title: '保留天数', hint: '早于这个天数的引用不再出现在任何区间里（7–3650 天）' },
        h(UsageNumberField, {
          value: usage.retainDays ?? 400,
          min: 7,
          max: 3650,
          integer: true,
          onCommit: (value) => setUsage({ retainDays: value }),
        }),
      ),
      h(
        Row,
        { title: '最近请求池', hint: '输入区状态栏与「最近请求」表保留多少条请求（5–200）' },
        h(UsageNumberField, {
          value: usage.recentRequestPool ?? 20,
          min: 5,
          max: 200,
          integer: true,
          onCommit: (value) => setUsage({ recentRequestPool: value }),
        }),
      ),
    ),

    // 2 — what it cost ------------------------------------------------------
    h(
      Card,
      {
        title: '本期用量看板',
        sub: summary.data?.updatedAt === undefined ? '读本机会话日志聚合' : `统计截至 ${when(summary.data.updatedAt)}`,
        actions: h(Button, { size: 'sm', variant: 'ghost', onClick: () => summary.reload() }, `⟳ ${t().refresh}`),
      },
      h(RangeBar, { value: range, onChange: setRange, from, to, onFrom: setFrom, onTo: setTo }),

      h(
        'div',
        { className: 'mydsh-grid', 'data-cols': '3' },
        h(Stat, {
          label: '请求数',
          value: hasSummary ? exact(totals.requests) : '—',
          foot: `失败 ${exact(totals.failedRequests)} · ${exact(totals.turns)} 轮`,
          accent: 'var(--dsw-alias-brand-primary)',
          title: `${exact(totals.requests)} 次请求`,
        }),
        h(Stat, {
          label: '总 Tokens',
          value: hasSummary ? tokens(totals.totalTokens) : '—',
          foot: `${exact(totals.totalTokens)} tokens`,
          accent: 'var(--dsw-alias-brand-primary)',
        }),
        h(Stat, {
          label: '输入',
          value: hasSummary ? tokens(totals.inputTokens) : '—',
          foot: `缓存写 ${tokens(totals.cacheWriteTokens)}`,
          accent: 'var(--dsw-alias-state-success-primary)',
          title: `${exact(totals.inputTokens)} tokens`,
        }),
        h(Stat, {
          label: '输出',
          value: hasSummary ? tokens(totals.outputTokens) : '—',
          foot: `${exact(totals.outputTokens)} tokens`,
          accent: 'var(--dsw-alias-state-warn-primary)',
        }),
        h(Stat, {
          label: '缓存命中率',
          value: hasSummary ? percent(hitRate) : '—',
          foot: `缓存读 ${tokens(totals.cacheReadTokens)}`,
          accent: 'var(--dsw-alias-state-success-primary)',
          title: '缓存读 ÷（缓存读 + 输入）',
        }),
        h(Stat, {
          label: 'Token 速度',
          value: avgSpeed > 0 ? `${Math.round(avgSpeed)} tok/s` : '—',
          foot: `平均耗时 ${duration(avgDuration)}`,
          accent: 'var(--dsw-alias-state-error-primary)',
          title: '取最近请求池里有速度数据的请求平均',
        }),
      ),

      summary.data === undefined
        ? h(Empty, null, summary.loading ? t().loading : summary.error ?? t().empty)
        : h(
            'div',
            { className: 'mydsh-split' },
            h(
              Card,
              { title: '活跃热力图', sub: '越深表示这一格消耗越多', flat: true },
              h(HeatMap, { days: heatDays }),
            ),
            h(
              Card,
              { title: 'Tokens 趋势', sub: '按时间桶展示总 token', flat: true },
              h(BarChart, {
                points,
                format: (value) => tokens(value),
              }),
            ),
          ),

      h(
        'div',
        { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
        h(Segmented, { value: dim, onChange: setDim, options: USAGE_DIM_OPTIONS }),
        h('span', { className: 'mydsh-muted' }, `费用按内置/自定义价目表估算 · ${currency}`),
      ),
      rankRows.length === 0
        ? h(Empty, null, summary.loading ? t().loading : '这个区间还没有用量记录')
        : h(
            'div',
            { className: 'mydsh-scroll' },
            h(
              'table',
              { className: 'mydsh-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, '名称'),
                  h('th', { 'data-num': 'true' }, '请求数'),
                  h('th', null, 'tokens 占比'),
                  h('th', { 'data-num': 'true' }, '命中率'),
                  h('th', { 'data-num': 'true' }, '费用'),
                ),
              ),
              h(
                'tbody',
                null,
                rankRows.map((row) =>
                  h(
                    'tr',
                    { key: row.key },
                    h(
                      'td',
                      null,
                      h(
                        'div',
                        { className: 'mydsh-inline', style: { gap: 5 } },
                        h('span', { className: 'mydsh-dot', style: { background: 'var(--dsw-alias-brand-primary)' } }),
                        h(
                          'span',
                          { className: 'mydsh-truncate', style: { maxWidth: 220 }, title: `${row.label}${row.key === row.label ? '' : ` · ${row.key}`}` },
                          row.label === '' ? row.key : row.label,
                        ),
                      ),
                    ),
                    h('td', { 'data-num': 'true' }, exact(row.requests)),
                    h(
                      'td',
                      null,
                      h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 160 } },
                        h(Bar, { ratio: Number(row.totalTokens ?? 0) / rankTotal, height: 4 }),
                        h(
                          'span',
                          { className: 'mydsh-muted' },
                          `${tokens(row.totalTokens)} · ${percent(Number(row.totalTokens ?? 0) / rankTotal)}`,
                        ),
                      ),
                    ),
                    h('td', { 'data-num': 'true' }, percent(row.hitRate)),
                    h('td', { 'data-num': 'true' }, money(row.cost, currency)),
                  ),
                ),
              ),
            ),
            h('div', { className: 'mydsh-muted', style: { paddingTop: 6 } },
              dim === 'session' ? '会话维度按会话 ID 聚合；标签取会话标题，重命名前是首条消息。' : ''),
          ),
    ),

    // 3 — geek request stats ------------------------------------------------
    h(
      Card,
      { title: '极客请求指标', sub: '输入区状态栏与「最近请求」抽屉显示哪些数字' },
      h(
        Row,
        { title: '首字时间（TTFT）', hint: '从发出请求到第一个 token 的时间' },
        h(Switch, {
          checked: geek.showTtft !== false,
          onChange: (value) => setUsage({ geekMetrics: { showTtft: value } }),
          label: '首字时间',
        }),
      ),
      h(
        Row,
        { title: '输出速度', hint: '输出 token ÷ 解码耗时，不含首字等待' },
        h(Switch, {
          checked: geek.showSpeed !== false,
          onChange: (value) => setUsage({ geekMetrics: { showSpeed: value } }),
          label: '输出速度',
        }),
      ),
      h(
        Row,
        { title: 'token 数', hint: '单次请求的输入/输出 token' },
        h(Switch, {
          checked: geek.showTokens !== false,
          onChange: (value) => setUsage({ geekMetrics: { showTokens: value } }),
          label: 'token 数',
        }),
      ),
      h(
        Row,
        { title: '抽屉里保留几条', hint: '与上面的「最近请求池」共用同一个上限（5–200）' },
        h(UsageNumberField, {
          value: geek.pool ?? 20,
          min: 5,
          max: 200,
          integer: true,
          onCommit: (value) => setUsage({ geekMetrics: { pool: value } }),
        }),
      ),
      h(
        'div',
        { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
        h('span', { className: 'mydsh-card-sub' }, `最近请求预览 · 近 7 天全部会话，最多 ${pool} 条`),
        h(Button, { size: 'sm', variant: 'ghost', onClick: () => recent.reload() }, `⟳ ${t().refresh}`),
      ),
      (recent.data?.requests ?? []).length === 0
        ? h(Empty, null, recent.loading ? t().loading : recent.error ?? '还没有请求记录')
        : h(
            'div',
            { className: 'mydsh-scroll' },
            h(
              'table',
              { className: 'mydsh-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, '时间'),
                  h('th', null, '状态'),
                  h('th', null, '模型'),
                  h('th', { 'data-num': 'true' }, '首字'),
                  h('th', { 'data-num': 'true' }, '耗时'),
                  h('th', { 'data-num': 'true' }, '速度'),
                  h('th', { 'data-num': 'true' }, '入'),
                  h('th', { 'data-num': 'true' }, '出'),
                ),
              ),
              h(
                'tbody',
                null,
                (recent.data.requests ?? []).slice(0, pool).map((row, index) =>
                  h(
                    'tr',
                    { key: `${row.at}-${index}` },
                    h('td', null, when(row.at)),
                    h(
                      'td',
                      null,
                      h(
                        Badge,
                        { tone: usageRequestTone(row.status) },
                        usageRequestLabel(row.status),
                      ),
                    ),
                    h('td', { className: 'mydsh-truncate', style: { maxWidth: 180 }, title: `${row.provider} · ${row.model}` }, row.model === '' ? '—' : row.model),
                    h('td', { 'data-num': 'true' }, usageSecondsText(row.ttftMs)),
                    h('td', { 'data-num': 'true' }, duration(row.durationMs)),
                    h('td', { 'data-num': 'true' }, Number(row.speed ?? 0) > 0 ? `${Math.round(row.speed)} tok/s` : '—'),
                    h('td', { 'data-num': 'true' }, tokens(row.inputTokens)),
                    h('td', { 'data-num': 'true' }, tokens(row.outputTokens)),
                  ),
                ),
              ),
            ),
          ),
      h(
        'div',
        { className: 'mydsh-muted' },
        recent.data?.avg === undefined
          ? ''
          : `平均首字 ${(Number(recent.data.avg.ttftMs ?? 0) / 1000).toFixed(1)}s · 平均速度 ${Math.round(Number(recent.data.avg.speed ?? 0))} tok/s`,
      ),
    ),

    // 4 — context insight switches -----------------------------------------
    h(
      Card,
      { title: '上下文洞察', sub: '「上下文」标签页里显示哪几块' },
      h(
        Row,
        { title: 'Token 构成环图', hint: '七类上下文来源的占比' },
        h(Switch, {
          checked: insight.showComposition !== false,
          onChange: (value) => setUsage({ contextInsight: { showComposition: value } }),
          label: 'Token 构成',
        }),
      ),
      h(
        Row,
        { title: '上下文趋势', hint: '按轮次/步展开的上下文增长曲线' },
        h(Switch, {
          checked: insight.showTrend !== false,
          onChange: (value) => setUsage({ contextInsight: { showTrend: value } }),
          label: '上下文趋势',
        }),
      ),
      h(
        Row,
        { title: '上下文本浏览器', hint: '按类别展开当前上下文里的具体条目' },
        h(Switch, {
          checked: insight.showBrowser !== false,
          onChange: (value) => setUsage({ contextInsight: { showBrowser: value } }),
          label: '上下文本浏览器',
        }),
      ),
    ),

    // 5 — where the money is read ------------------------------------------
    h(
      Card,
      { title: '余额查询', sub: '只有点「测试」时才联网；其余时间页面读缓存或内置价目表' },
      h(
        Row,
        { title: 'DeepSeek 官方余额', hint: '读 {baseUrl}/user/balance，需要带余额权限的 API Key' },
        h(
          'div',
          { className: 'mydsh-inline' },
          balanceRows.deepseek === undefined
            ? null
            : h(
                Badge,
                { tone: balanceRows.deepseek.ok === true ? 'ok' : 'warn' },
                balanceRows.deepseek.ok === true
                  ? `${money(balanceRows.deepseek.total, balanceRows.deepseek.currency)}`
                  : usageBalanceMessage(balanceRows.deepseek),
              ),
          h(Button, { size: 'sm', disabled: balanceAction.pending, onClick: () => testBalance('deepseek', 'deepseek') }, '测试'),
          h(Switch, {
            checked: deepseek.enabled === true,
            onChange: (value) => write({ usage: { balance: { deepseek: { enabled: value } } } }),
            label: 'DeepSeek 余额',
          }),
        ),
      ),
      h(
        Row,
        { title: 'API Key', hint: '只存在本机设置文档里，不写入源码' },
        h(UsageDraftField, {
          value: deepseek.apiKey ?? '',
          type: 'password',
          width: 'lg',
          placeholder: 'sk-…',
          onCommit: (value) => write({ usage: { balance: { deepseek: { apiKey: value } } } }),
        }),
      ),
      h(
        Row,
        { title: '接口地址', hint: '可指向代理或镜像，末尾斜杠会去掉' },
        h(UsageDraftField, {
          value: deepseek.baseUrl ?? '',
          width: 'lg',
          mono: true,
          placeholder: 'https://api.deepseek.com',
          onCommit: (value) => write({ usage: { balance: { deepseek: { baseUrl: value } } } }),
        }),
      ),
      h(
        Row,
        { title: '缓存秒数', hint: '一次查询结果复用多久，避免打爆供应商限流（15–3600）' },
        h(UsageNumberField, {
          value: balance.ttlSeconds ?? 120,
          min: 15,
          max: 3600,
          integer: true,
          onCommit: (value) => write({ usage: { balance: { ttlSeconds: value } } }),
        }),
      ),

      h('div', { className: 'mydsh-card-sub' }, '其他供应商：一个 GET/POST 探针加两个取值路径，覆盖任何返回 JSON 的余额接口'),
      providers.length === 0
        ? h(Empty, null, '还没有配置其他供应商的余额接口')
        : providers.map((row, index) =>
            h(
              Card,
              {
                key: row.id,
                flat: true,
                title: row.label === '' ? row.id : row.label,
                actions: h(
                  'div',
                  { className: 'mydsh-inline' },
                  balanceRows[row.id] === undefined
                    ? null
                    : h(
                        Badge,
                        { tone: balanceRows[row.id].ok === true ? 'ok' : 'warn' },
                        balanceRows[row.id].ok === true
                          ? money(balanceRows[row.id].total, balanceRows[row.id].currency)
                          : usageBalanceMessage(balanceRows[row.id]),
                      ),
                  h(Button, { size: 'sm', disabled: balanceAction.pending, onClick: () => testBalance('provider', row.id) }, '测试'),
                  h(Button, { size: 'sm', variant: 'danger', onClick: () => removeProvider(index) }, '删除'),
                ),
              },
              h(
                Row,
                { title: '启用', hint: `${row.id}` },
                h(Switch, {
                  checked: row.enabled === true,
                  onChange: (value) => setProvider(index, { enabled: value }),
                  label: '启用该供应商',
                }),
              ),
              h(
                Row,
                { title: '显示名称', hint: '表格与徽标上显示的名字' },
                h(UsageDraftField, {
                  value: row.label,
                  width: 'md',
                  placeholder: '例如 Moonshot',
                  onCommit: (value) => setProvider(index, { label: value }),
                }),
              ),
              h(
                Row,
                { title: '对应供应商', hint: '与 DSH 的 provider id 一致时，价目表与配额也能对上' },
                h(UsageDraftField, {
                  value: row.provider,
                  width: 'md',
                  mono: true,
                  placeholder: 'openai',
                  onCommit: (value) => setProvider(index, { provider: value }),
                }),
              ),
              h(
                Row,
                { title: '接口地址', hint: '形如 https://api.example.com/v1/balance' },
                h(UsageDraftField, {
                  value: row.url,
                  width: 'xl',
                  mono: true,
                  onCommit: (value) => setProvider(index, { url: value }),
                }),
              ),
              h(
                Row,
                { title: '请求方法', hint: 'POST 时下面的正文会作为 JSON 发出' },
                h(Select, {
                  value: row.method ?? 'GET',
                  onChange: (value) => setProvider(index, { method: value }),
                  options: [
                    { value: 'GET', label: 'GET' },
                    { value: 'POST', label: 'POST' },
                  ],
                  width: 'sm',
                }),
              ),
              h(
                Row,
                { title: '请求头', hint: 'JSON 对象，或 curl 那种 key: value 行', stack: true },
                h(UsageDraftField, {
                  value: row.headers,
                  width: 'xl',
                  mono: true,
                  placeholder: '{"authorization":"Bearer sk-…"}',
                  onCommit: (value) => setProvider(index, { headers: value }),
                }),
              ),
              h(
                Row,
                { title: '请求正文', hint: '仅 POST 使用，必须是 JSON', stack: true },
                h(UsageDraftField, {
                  value: row.body,
                  width: 'xl',
                  mono: true,
                  placeholder: '{}',
                  onCommit: (value) => setProvider(index, { body: value }),
                }),
              ),
              h(
                Row,
                { title: '余额字段路径', hint: '点号路径，数字下标可读数组，例如 data.balance', stack: true },
                h(UsageDraftField, {
                  value: row.totalPath,
                  width: 'md',
                  mono: true,
                  placeholder: 'data.balance',
                  onCommit: (value) => setProvider(index, { totalPath: value }),
                }),
              ),
              h(
                Row,
                { title: '币种字段路径', hint: '返回里没有币种时用下面的固定币种', stack: true },
                h(UsageDraftField, {
                  value: row.currencyPath,
                  width: 'md',
                  mono: true,
                  placeholder: 'data.currency',
                  onCommit: (value) => setProvider(index, { currencyPath: value }),
                }),
              ),
              h(
                Row,
                { title: '固定币种', hint: 'CNY 或 USD' },
                h(Select, {
                  value: row.currency ?? 'CNY',
                  onChange: (value) => setProvider(index, { currency: value }),
                  options: [
                    { value: 'CNY', label: 'CNY' },
                    { value: 'USD', label: 'USD' },
                  ],
                  width: 'sm',
                }),
              ),
            ),
          ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Button, { onClick: addProvider }, '添加供应商'),
        balanceAction.error === undefined ? null : h(Note, { tone: 'error' }, balanceAction.error),
      ),
    ),

    // 6 — what may not be spent --------------------------------------------
    h(
      Card,
      { title: '预算', sub: '超限只提示或挡住下一次模型请求；已经开始的一步不会被中断' },
      budgets.length === 0
        ? h(Empty, null, '还没有预算。加一条「每日 token 上限」是最划算的第一条。')
        : budgets.map((row) => {
            const status = evaluation.find((entry) => entry.id === row.id)
            const ratio = Number(status?.ratio ?? 0)
            const tone = status?.state === 'over' ? 'error' : status?.state === 'warn' ? 'warn' : undefined
            return h(
              Card,
              {
                key: row.id,
                flat: true,
                title: row.label === '' ? row.id : row.label,
                actions: h(
                  'div',
                  { className: 'mydsh-inline' },
                  status === undefined
                    ? h(Badge, null, '暂无进度')
                    : h(
                        Badge,
                        { tone },
                        status.state === 'over' ? '已超限' : status.state === 'warn' ? '接近上限' : '正常',
                      ),
                  h(Button, { size: 'sm', variant: 'danger', onClick: () => removeBudget(row.id) }, '删除'),
                ),
              },
              h(
                Row,
                { title: '启用' },
                h(Switch, {
                  checked: row.enabled !== false,
                  onChange: (value) => setBudget(row.id, { enabled: value }),
                  label: '启用该预算',
                }),
              ),
              h(
                Row,
                { title: '名称', hint: '留空时用 id 显示' },
                h(UsageDraftField, {
                  value: row.label,
                  width: 'md',
                  placeholder: '每日上限',
                  onCommit: (value) => setBudget(row.id, { label: value }),
                }),
              ),
              h(
                Row,
                { title: '范围', hint: '供应商/模型/工作区按各自口径分别累计' },
                h(Select, {
                  value: row.scope ?? 'global',
                  onChange: (value) => setBudget(row.id, { scope: value }),
                  options: USAGE_BUDGET_SCOPES,
                  width: 'sm',
                }),
              ),
              row.scope === 'provider'
                ? h(
                    Row,
                    { title: '供应商', hint: '留空表示不限' },
                    h(Select, {
                      value: row.provider ?? '',
                      onChange: (value) => setBudget(row.id, { provider: value }),
                      options: providerOptions(meta, '不限'),
                      width: 'md',
                    }),
                  )
                : null,
              row.scope === 'model'
                ? h(
                    Row,
                    { title: '供应商 / 模型', hint: '模型项带供应商前缀，切换供应商时清空模型' },
                    h(
                      'div',
                      { className: 'mydsh-inline' },
                      h(Select, {
                        value: row.provider ?? '',
                        onChange: (value) => setBudget(row.id, { provider: value, model: '' }),
                        options: providerOptions(meta, '不限供应商'),
                        width: 'sm',
                      }),
                      h(Select, {
                        value: (row.provider ?? '') === '' ? '' : `${row.provider}::${row.model ?? ''}`,
                        onChange: (value) => {
                          const at = value.lastIndexOf('::')
                          setBudget(row.id, at < 0 ? { model: '' } : { provider: value.slice(0, at), model: value.slice(at + 2) })
                        },
                        options: modelRows(row.provider ?? ''),
                        width: 'md',
                      }),
                    ),
                  )
                : null,
              row.scope === 'workspace'
                ? h(
                    Row,
                    { title: '工作区', hint: '按会话所在的目录累计' },
                    h(Select, {
                      value: row.workspace ?? '',
                      onChange: (value) => setBudget(row.id, { workspace: value }),
                      options: workspaceOptions(meta, '不限工作区'),
                      width: 'md',
                    }),
                  )
                : null,
              h(
                Row,
                { title: '周期', hint: '窗口从本地零点/周一/月初起算' },
                h(Segmented, {
                  value: row.period ?? 'day',
                  onChange: (value) => setBudget(row.id, { period: value }),
                  options: USAGE_BUDGET_PERIODS,
                }),
              ),
              h(
                Row,
                { title: '超限动作', hint: '暂停只影响下一次请求，不打断当前这一轮' },
                h(Segmented, {
                  value: row.action ?? 'notify',
                  onChange: (value) => setBudget(row.id, { action: value }),
                  options: USAGE_BUDGET_ACTIONS,
                }),
              ),
              h(
                Row,
                { title: 'token 上限', hint: '输入+输出；0 表示不限制这一项' },
                h(UsageNumberField, {
                  value: row.limitTokens ?? 0,
                  min: 0,
                  max: 1e12,
                  integer: true,
                  onCommit: (value) => setBudget(row.id, { limitTokens: value }),
                }),
              ),
              h(
                Row,
                { title: '费用上限', hint: '按价目表估算；0 表示不限制这一项' },
                h(UsageNumberField, {
                  value: row.limitCost ?? 0,
                  min: 0,
                  max: 1e9,
                  onCommit: (value) => setBudget(row.id, { limitCost: value }),
                }),
              ),
              h(
                Row,
                { title: '预警阈值', hint: '到达上限的百分之多少开始提示（10–100）' },
                h(UsageDraftField, {
                  // The stored value is a ratio; the field shows percent. Parsing
                  // back to an integer percentage is what keeps the "unchanged"
                  // comparison exact, so tabbing through writes nothing.
                  value: Math.round(Number(row.threshold ?? 0.9) * 100),
                  type: 'number',
                  width: 'sm',
                  parse: (text) => usageNumber(text, 10, 100, true),
                  onCommit: (value) => setBudget(row.id, { threshold: value / 100 }),
                }),
              ),
              status === undefined
                ? h('div', { className: 'mydsh-muted' }, '这条预算没有上限或已停用，宿主不会为它扫描日志。')
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
                    h(Bar, {
                      ratio,
                      height: 6,
                      accent: tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : tone === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : undefined,
                    }),
                    h(
                      'div',
                      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
                      h(
                        'span',
                        { className: 'mydsh-muted' },
                        `token ${exact(status.usedTokens)} / ${status.limitTokens > 0 ? exact(status.limitTokens) : '不限'} · 费用 ${money(status.usedCost, status.currency)} / ${status.limitCost > 0 ? money(status.limitCost, status.currency) : '不限'}`,
                      ),
                      h('span', { className: 'mydsh-muted' }, `${percent(ratio)} · ${when(status.windowFrom)} 起`),
                    ),
                  ),
            )
          }),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Button, { onClick: addBudget }, '添加预算'),
        h(Button, { variant: 'ghost', size: 'sm', onClick: () => budgetStatus.reload() }, `⟳ 刷新进度`),
      ),
    ),

    // 7 — what a token costs -----------------------------------------------
    h(
      Card,
      {
        title: '价目表',
        sub: `内置表按供应商给出每百万 token 单价，自定义条目覆盖同名列 · ${prices.data?.source === 'overrides' ? '当前含自定义条目' : '当前用内置表'}`,
        actions: h(Button, { size: 'sm', variant: 'ghost', onClick: () => prices.reload() }, `⟳ ${t().refresh}`),
      },
      h(
        Row,
        { title: '未知模型按中位价估算', hint: '关闭后，价目表里没有的模型费用记为 0，不再猜' },
        h(Switch, {
          checked: usage.estimateUnknown !== false,
          onChange: (value) => setUsage({ estimateUnknown: value }),
          label: '估算未知模型',
        }),
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(TextField, {
          value: priceSearch,
          width: 'md',
          placeholder: '搜索供应商或模型',
          onChange: (value) => {
            setPriceSearch(value)
            pushPriceQuery(value)
          },
        }),
        h('span', { className: 'mydsh-muted' }, `单价：每百万 token，${prices.data?.rows?.length ?? 0} 条`),
      ),
      (prices.data?.rows ?? []).length === 0
        ? h(Empty, null, prices.loading ? t().loading : prices.error ?? '没有匹配的价目行')
        : h(
            'div',
            { className: 'mydsh-scroll' },
            h(
              'table',
              { className: 'mydsh-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, '供应商'),
                  h('th', null, '模型'),
                  h('th', { 'data-num': 'true' }, '入'),
                  h('th', { 'data-num': 'true' }, '出'),
                  h('th', { 'data-num': 'true' }, '缓读'),
                  h('th', { 'data-num': 'true' }, '缓写'),
                  h('th', null, '来源'),
                ),
              ),
              h(
                'tbody',
                null,
                (prices.data.rows ?? []).slice(0, 60).map((row) =>
                  h(
                    'tr',
                    { key: `${row.provider}::${row.model}` },
                    h('td', null, row.provider),
                    h('td', { className: 'mydsh-truncate', style: { maxWidth: 200 }, title: row.model }, row.model),
                    h('td', { 'data-num': 'true' }, money(row.input, row.currency)),
                    h('td', { 'data-num': 'true' }, money(row.output, row.currency)),
                    h('td', { 'data-num': 'true' }, money(row.cacheRead, row.currency)),
                    h('td', { 'data-num': 'true' }, money(row.cacheWrite, row.currency)),
                    h('td', null, h(Badge, { tone: row.source === 'override' ? 'warn' : undefined }, row.source === 'override' ? '自定义' : '内置')),
                  ),
                ),
              ),
            ),
          ),

      h('div', { className: 'mydsh-card-sub' }, '自定义价目：保存后立即用于新请求的费用估算'),
      priceDraft.length === 0
        ? h(Empty, null, '还没有自定义价目')
        : priceDraft.map((row, index) =>
            h(
              Card,
              {
                key: row.id,
                flat: true,
                title: row.model === '' ? '新条目' : `${row.provider} · ${row.model}`,
                actions: h(
                  'div',
                  { className: 'mydsh-inline' },
                  h(Select, {
                    value: row.currency ?? 'CNY',
                    onChange: (value) => setPriceRow(row.id, { currency: value }),
                    options: [
                      { value: 'CNY', label: 'CNY' },
                      { value: 'USD', label: 'USD' },
                    ],
                    width: 'sm',
                  }),
                  h(Button, { size: 'sm', variant: 'danger', onClick: () => removePriceRow(row.id) }, '删除'),
                ),
              },
              h(
                Row,
                { title: '供应商', hint: '与 DSH 的 provider id 一致；与模型一起构成匹配键' },
                h(UsageDraftField, {
                  value: row.provider,
                  width: 'md',
                  mono: true,
                  placeholder: 'deepseek',
                  onCommit: (value) => setPriceRow(row.id, { provider: value }),
                }),
              ),
              h(
                Row,
                { title: '模型', hint: '留空的模型名按供应商默认价处理' },
                h(UsageDraftField, {
                  value: row.model,
                  width: 'md',
                  mono: true,
                  placeholder: 'deepseek-chat',
                  onCommit: (value) => setPriceRow(row.id, { model: value }),
                }),
              ),
              h(
                Row,
                { title: '输入 / 输出单价', hint: '每百万 token' },
                h(
                  'div',
                  { className: 'mydsh-inline' },
                  h(UsageNumberField, {
                    value: row.input,
                    min: 0,
                    max: 1e6,
                    onCommit: (value) => setPriceRow(row.id, { input: value }),
                  }),
                  h(UsageNumberField, {
                    value: row.output,
                    min: 0,
                    max: 1e6,
                    onCommit: (value) => setPriceRow(row.id, { output: value }),
                  }),
                ),
              ),
              h(
                Row,
                { title: '缓存读 / 写单价', hint: '每百万 token；为 0 表示没有缓存计价' },
                h(
                  'div',
                  { className: 'mydsh-inline' },
                  h(UsageNumberField, {
                    value: row.cacheRead,
                    min: 0,
                    max: 1e6,
                    onCommit: (value) => setPriceRow(row.id, { cacheRead: value }),
                  }),
                  h(UsageNumberField, {
                    value: row.cacheWrite,
                    min: 0,
                    max: 1e6,
                    onCommit: (value) => setPriceRow(row.id, { cacheWrite: value }),
                  }),
                ),
              ),
              index === priceDraft.length - 1 ? h('div', { className: 'mydsh-muted' }, '改完点下面的「保存价目」一次写入') : null,
            ),
          ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Button, { onClick: addPriceRow }, '添加自定义价目'),
        h(Button, { variant: 'primary', disabled: priceDirty !== true, onClick: savePrices }, '保存价目'),
        priceDirty === true ? h('span', { className: 'mydsh-muted' }, '有未保存的修改') : null,
      ),
    ),
  )
}

    // ===== 43-tab-backup.js =====
/**
 * Backup tab.
 *
 * WHY THE PAGE KEEPS A DRAFT FOR THE TWO LISTS
 * `backup.targets` and `backup.schedules` are edited as whole arrays, and every
 * keystroke in a long path or password field must not become its own settings
 * write: the store patches optimistically and each patch is one HTTP round trip,
 * so a typed password would produce a dozen writes and a dozen revisions for
 * every client polling `/settings/revision`. Both lists therefore live in local
 * draft state and are written through `patch` on the explicit save button — the
 * same shape the reference page uses, and the shape that makes "unsaved" visible
 * instead of guessed.
 *
 * WHY THE RUN HISTORY IS A SECOND POLL
 * `/backup/state` answers the question "what is happening now" and is polled at
 * 20 s because a running backup is the interesting case. The history table only
 * changes when a run finishes, so it is polled much more slowly; after any action
 * this page takes, both are reloaded by hand instead of waiting for a tick.
 */

/** The seven item groups, in the order the Host normalises them. */
const BACKUP_ITEM_ROWS = [
  ['conversations', '会话记录', '会话日志与元数据，恢复后可以接着聊'],
  ['systemConfig', '系统配置', 'profile 下的 cordis 配置与 package 清单'],
  ['plugins', '插件', '已安装插件的代码与清单'],
  ['models', '模型文件', 'models.json 与本地模型目录'],
  ['workspaceFiles', '工作区文件', '已注册工作区的源码，体积最大的一组'],
  ['other', '其他数据', '<DSH_HOME> 下没有被上面几类认领的内容'],
  ['credentials', '凭据文件', '.credentials.yaml 等密钥文件，未加密时宿主会跳过'],
]

/** Destination kinds the Host accepts. */
const BACKUP_TARGET_KINDS = [
  { value: 'local', label: '本地目录' },
  { value: 'webdav', label: 'WebDAV' },
  { value: 'oss', label: '阿里云 OSS' },
  { value: 's3', label: 'S3 兼容' },
  { value: 'gist', label: 'GitHub Gist' },
]

/** Object-storage fields, shared by `oss` and `s3`. */
const BACKUP_CLOUD_FIELDS = [
  ['endpoint', '服务地址', { width: 'xl', hint: '例如 https://oss-cn-hangzhou.aliyuncs.com' }],
  ['region', '区域', { hint: '留空按地址推断' }],
  ['bucket', 'Bucket', {}],
  ['accessKeyId', 'AccessKey ID', {}],
  ['accessKeySecret', 'AccessKey Secret', { secret: true }],
  ['publicBaseUrl', '公开访问前缀', { width: 'xl', hint: '仅用于生成下载链接' }],
]

/** Fields per destination kind; the Host keeps only the ones that apply. */
const BACKUP_TARGET_FIELDS = {
  local: [['path', '备份目录', { width: 'xl', hint: '留空则使用插件默认备份目录' }]],
  webdav: [
    ['url', '地址', { width: 'xl' }],
    ['username', '用户名', {}],
    ['password', '密码', { secret: true }],
    ['remotePath', '远端目录', { hint: '不存在会自动创建' }],
  ],
  oss: BACKUP_CLOUD_FIELDS,
  s3: BACKUP_CLOUD_FIELDS,
  gist: [
    ['token', '个人访问令牌', { secret: true, width: 'xl' }],
    ['gistId', 'Gist ID', { hint: '留空表示新建一个私有 Gist' }],
  ],
}

/** Trigger kinds, matching the Host's scheduler. */
const BACKUP_TRIGGERS = [
  { value: 'daily', label: '每天定时' },
  { value: 'weekly', label: '每周定时' },
  { value: 'interval', label: '按间隔' },
  { value: 'startup', label: 'DSH 启动时' },
  { value: 'after-session', label: '每轮对话结束后' },
  { value: 'manual', label: '仅手动' },
]

/** Weekday labels; the Host stores 0 = Sunday. */
const BACKUP_WEEKDAYS = [
  { value: '0', label: '周日' },
  { value: '1', label: '周一' },
  { value: '2', label: '周二' },
  { value: '3', label: '周三' },
  { value: '4', label: '周四' },
  { value: '5', label: '周五' },
  { value: '6', label: '周六' },
]

/** A brand-new destination with the fields its kind needs. */
function freshBackupTarget(kind) {
  const base = { id: newId('target'), kind, label: '', remotePath: 'dsh-mydsh' }
  if (kind === 'local') return { ...base, path: '' }
  if (kind === 'webdav') return { ...base, url: '', username: '', password: '' }
  if (kind === 'oss' || kind === 's3') {
    return {
      ...base,
      endpoint: '',
      region: '',
      bucket: '',
      accessKeyId: '',
      accessKeySecret: '',
      publicBaseUrl: '',
      pathStyle: kind === 's3',
    }
  }
  return { ...base, token: '', gistId: '' }
}

/** A brand-new schedule: daily at 03:00 with nothing selected yet. */
function freshBackupSchedule() {
  return {
    id: newId('schedule'),
    enabled: true,
    trigger: 'daily',
    time: '03:00',
    weekday: 1,
    intervalMinutes: 180,
    type: 'full',
    items: freshBackupItems(),
  }
}

/** The seven item flags, all off, for a schedule that has none yet. */
function freshBackupItems() {
  const out = {}
  for (const [key] of BACKUP_ITEM_ROWS) out[key] = false
  return out
}

/**
 * A numeric input that writes once, on blur or Enter.
 *
 * A controlled number field patched on every keystroke turns "512" into three
 * settings writes and three revisions, and every other open settings page
 * re-fetches the whole document on a revision change. It is a raw `input` with the
 * shipped `mydsh-input` class because the shared `TextField` has no blur hook.
 */
function BackupNumberField({ value, onChange, min, max, width }) {
  const [draft, setDraft] = useState(String(value ?? 0))
  const saved = useRef(String(value ?? 0))

  useEffect(() => {
    const next = String(value ?? 0)
    if (next !== saved.current) {
      saved.current = next
      setDraft(next)
    }
  }, [value])

  const commit = () => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(saved.current)
      return
    }
    const clamped = Math.round(Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min ?? 0, parsed)))
    const next = String(clamped)
    const changed = next !== saved.current
    saved.current = next
    setDraft(next)
    if (changed) onChange(clamped)
  }

  return h('input', {
    className: 'mydsh-input mydsh-mono',
    'data-width': width ?? 'sm',
    inputMode: 'numeric',
    value: draft,
    onChange: (event) => setDraft(event.target.value),
    onBlur: commit,
    onKeyDown: (event) => {
      if (event.key === 'Enter') commit()
    },
  })
}

/** A secret field: local draft, written only when the user presses 保存. */
function BackupSecretField({ value, onSave, placeholder, width }) {
  const [draft, setDraft] = useState(value ?? '')
  const saved = useRef(value ?? '')

  useEffect(() => {
    const next = value ?? ''
    if (next !== saved.current) {
      saved.current = next
      setDraft(next)
    }
  }, [value])

  const dirty = draft !== saved.current
  return h(
    'div',
    { className: 'mydsh-inline' },
    h(TextField, { value: draft, onChange: setDraft, type: 'password', placeholder, width: width ?? 'md' }),
    h(
      Button,
      {
        size: 'sm',
        disabled: dirty !== true,
        onClick: () => {
          saved.current = draft
          onSave(draft)
        },
      },
      t().save,
    ),
    dirty ? h(Badge, { tone: 'warn' }, '未保存') : null,
  )
}

/** One labelled control inside a destination block. */
function BackupField({ label, hint, children }) {
  return h(
    'div',
    { className: 'mydsh-row-label' },
    h('span', { className: 'mydsh-muted' }, label),
    children,
    hint === undefined ? null : h('span', { className: 'mydsh-row-hint' }, hint),
  )
}

/**
 * One destination block: identity, kind, its fields, and its own test button.
 *
 * The probe is self-contained on purpose: it POSTs the block's current draft
 * (not the saved one) so a user can test a destination before saving it, and its
 * answer is local state because nothing outside this block changes.
 */
function BackupTargetRow({ target, active, onChange, onRemove, onActivate }) {
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState(undefined)
  const fields = BACKUP_TARGET_FIELDS[target.kind] ?? BACKUP_TARGET_FIELDS.local
  const set = (partial) => onChange({ ...target, ...partial })

  const test = async () => {
    setProbing(true)
    setProbe(undefined)
    try {
      const answer = await api('/backup/test', { body: { target } })
      setProbe(answer)
    } catch (failure) {
      setProbe({ ok: false, message: failure?.message ?? String(failure), latencyMs: 0 })
    } finally {
      setProbing(false)
    }
  }

  return h(
    'div',
    { className: 'mydsh-card', 'data-flat': 'true', style: { gap: 8 } },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        { className: 'mydsh-inline' },
        h(TextField, { value: target.label ?? '', onChange: (next) => set({ label: next }), placeholder: '名称', width: 'md' }),
        active ? h(Badge, { tone: 'ok' }, '当前使用') : null,
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        active
          ? null
          : h(Button, { size: 'sm', onClick: () => onActivate(target.id) }, '设为当前'),
        h(Button, { size: 'sm', disabled: probing, onClick: test }, probing ? t().loading : t().test),
        h(Button, { size: 'sm', variant: 'danger', onClick: () => onRemove(target.id) }, t().remove),
      ),
    ),
    h(
      'div',
      { className: 'mydsh-inline' },
      h('span', { className: 'mydsh-muted' }, '类型'),
      h(Select, {
        value: target.kind,
        width: 'md',
        options: BACKUP_TARGET_KINDS,
        onChange: (kind) => onChange({ ...freshBackupTarget(kind), id: target.id, label: target.label, remotePath: target.remotePath }),
      }),
    ),
    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '2' },
      fields.map(([key, label, options]) =>
        h(
          BackupField,
          { key, label, hint: options?.hint },
          options?.secret === true
            ? h(TextField, {
                value: target[key] ?? '',
                onChange: (next) => set({ [key]: next }),
                type: 'password',
                width: options?.width ?? 'md',
              })
            : h(TextField, {
                value: target[key] ?? '',
                onChange: (next) => set({ [key]: next }),
                width: options?.width ?? 'md',
              }),
        ),
      ),
      target.kind === 'oss' || target.kind === 's3'
        ? h(
            BackupField,
            { label: 'Path-style 寻址' },
            h(Switch, {
              checked: target.pathStyle === true,
              label: 'Path-style 寻址',
              onChange: (next) => set({ pathStyle: next }),
            }),
          )
        : null,
    ),
    probe === undefined
      ? null
      : h(
          Note,
          { tone: probe.ok === true ? 'ok' : 'error' },
          `${probe.ok === true ? '可达' : '不可达'} · ${duration(probe.latencyMs)}${probe.message === '' ? '' : ` · ${probe.message}`}`,
        ),
  )
}

/**
 * One schedule block.
 *
 * Only the fields the chosen trigger actually reads are shown, because the Host
 * reads exactly those: a `time` for a startup trigger is dead input, and dead
 * inputs are what make a settings page feel untrustworthy.
 */
function BackupScheduleRow({ schedule, index, count, onChange, onRemove, onMove }) {
  const [openItems, setOpenItems] = useState(false)
  const set = (partial) => onChange({ ...schedule, ...partial })
  const trigger = schedule.trigger
  const itemKeys = BACKUP_ITEM_ROWS.filter(([key]) => schedule.items?.[key] === true)

  return h(
    'div',
    { className: 'mydsh-card', 'data-flat': 'true', style: { gap: 8 } },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Select, {
          value: trigger,
          width: 'md',
          options: BACKUP_TRIGGERS,
          onChange: (next) => set({ trigger: next }),
        }),
        h(Select, {
          value: schedule.type,
          width: 'sm',
          options: [
            { value: 'full', label: '全量' },
            { value: 'incremental', label: '增量' },
          ],
          onChange: (next) => set({ type: next }),
        }),
        h(Switch, {
          checked: schedule.enabled === true,
          label: '启用这条计划',
          onChange: (next) => set({ enabled: next }),
        }),
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Button, { size: 'sm', disabled: index === 0, onClick: () => onMove(index, -1) }, '↑'),
        h(Button, { size: 'sm', disabled: index === count - 1, onClick: () => onMove(index, 1) }, '↓'),
        h(Button, { size: 'sm', variant: 'danger', onClick: () => onRemove(schedule.id) }, t().remove),
      ),
    ),
    trigger === 'daily' || trigger === 'weekly'
      ? h(
          'div',
          { className: 'mydsh-inline' },
          trigger === 'weekly'
            ? h(Select, {
                value: String(schedule.weekday),
                options: BACKUP_WEEKDAYS,
                onChange: (next) => set({ weekday: Number(next) }),
              })
            : null,
          h(TextField, { value: schedule.time, onChange: (next) => set({ time: next }), width: 'sm', mono: true, placeholder: '03:00' }),
          h('span', { className: 'mydsh-muted' }, '本机时间，精确到分钟'),
        )
      : null,
    trigger === 'interval'
      ? h(
          'div',
          { className: 'mydsh-inline' },
          h(BackupNumberField, {
            value: schedule.intervalMinutes,
            min: 5,
            max: 10080,
            onChange: (next) => set({ intervalMinutes: next }),
          }),
          h('span', { className: 'mydsh-muted' }, '分钟一次（5 分钟 ~ 7 天）'),
        )
      : null,
    h(
      'div',
      { className: 'mydsh-inline' },
      h(
        Button,
        { size: 'sm', variant: 'ghost', onClick: () => setOpenItems((open) => !open) },
        `内容：${itemKeys.length === 0 ? '未选择' : `${itemKeys.length} 项`}${openItems ? ' ▴' : ' ▾'}`,
      ),
      h('span', { className: 'mydsh-muted' }, itemKeys.length === 0 ? '这条计划不会产生任何备份' : ''),
    ),
    openItems
      ? h(
          'div',
          { className: 'mydsh-grid', 'data-cols': '2' },
          BACKUP_ITEM_ROWS.map(([key, title]) =>
            h(
              BackupField,
              { key, label: title },
              h(Switch, {
                checked: schedule.items?.[key] === true,
                label: title,
                onChange: (next) => set({ items: { ...(schedule.items ?? freshBackupItems()), [key]: next } }),
              }),
            ),
          ),
        )
      : null,
  )
}

/** The restore dialog: pick one run, optionally unpack somewhere else. */
function BackupRestoreModal({ runs, initialRunId, onClose, onDone }) {
  const [runId, setRunId] = useState(initialRunId ?? '')
  const [toDir, setToDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(undefined)
  const candidates = (runs ?? []).filter((row) => row.kind === undefined || row.kind === 'backup')

  const submit = async () => {
    if (runId === '') {
      setError('先选一条备份记录')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const value = await api('/backup/restore', { body: toDir === '' ? { runId } : { runId, toDir } })
      onDone(value)
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }

  return h(
    Modal,
    {
      title: '从备份恢复',
      onClose,
      footer: [
        h(Button, { key: 'cancel', onClick: onClose }, t().cancel),
        h(Button, { key: 'ok', variant: 'primary', disabled: busy, onClick: submit }, busy ? t().loading : '开始恢复'),
      ],
    },
    h(Note, null, '恢复只解包到独立目录，不会覆盖正在运行的会话与配置；核对无误后由你手动替换。'),
    h(
      'div',
      { className: 'mydsh-row-label' },
      h('span', { className: 'mydsh-muted' }, '选择记录'),
      h(Select, {
        value: runId,
        width: 'xl',
        options: [{ value: '', label: '— 未选择 —' }].concat(
          candidates.map((row) => ({
            value: row.id,
            label: `${when(row.finishedAt || row.startedAt)} · ${row.type === 'incremental' ? '增量' : '全量'} · ${bytes(row.bytes)}${row.ok === false ? ' · 失败' : ''}`,
          })),
        ),
        onChange: setRunId,
      }),
    ),
    h(
      'div',
      { className: 'mydsh-row-label' },
      h('span', { className: 'mydsh-muted' }, '解包到（留空使用插件默认恢复目录）'),
      h(TextField, { value: toDir, onChange: setToDir, width: 'xl', placeholder: 'D:\\restore' }),
    ),
    error === undefined ? null : h(Note, { tone: 'error' }, error),
  )
}

/** A yes/no dialog, used for the one action that deletes files. */
function BackupConfirmModal({ title, message, confirmLabel, onClose, onConfirm, busy }) {
  return h(
    Modal,
    {
      title,
      onClose,
      footer: [
        h(Button, { key: 'cancel', onClick: onClose }, t().cancel),
        h(Button, { key: 'ok', variant: 'danger', disabled: busy === true, onClick: onConfirm }, busy === true ? t().loading : confirmLabel),
      ],
    },
    h(Note, { tone: 'warn' }, message),
  )
}

/** The backup tab. */
function BackupTab({ settings, patch, meta }) {
  const backup = settings.backup
  const state = usePoll('/backup/state', 20000, [])
  const runsPoll = usePoll('/backup/runs', 60000, [])
  const [runAction, runState] = useAction()

  const [targetsDraft, setTargetsDraft] = useState(() => clone(backup.targets ?? []))
  const [activeDraft, setActiveDraft] = useState(backup.activeTargetId ?? '')
  const [schedulesDraft, setSchedulesDraft] = useState(() => clone(backup.schedules ?? []))
  const [saveError, setSaveError] = useState(undefined)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [restorePreset, setRestorePreset] = useState('')
  const [restoreResult, setRestoreResult] = useState(undefined)
  const [pendingDelete, setPendingDelete] = useState(undefined)
  const [playing, setPlaying] = useState(false)

  // External writes are authoritative: a reset, a restore of settings, or another
  // window's save must replace the drafts, or the page would keep showing a list
  // the Host no longer has.
  const targetsSignature = JSON.stringify([backup.targets, backup.activeTargetId])
  useEffect(() => {
    setTargetsDraft(clone(backup.targets ?? []))
    setActiveDraft(backup.activeTargetId ?? '')
  }, [targetsSignature])
  const schedulesSignature = JSON.stringify(backup.schedules)
  useEffect(() => {
    setSchedulesDraft(clone(backup.schedules ?? []))
  }, [schedulesSignature])

  const targetsDirty =
    JSON.stringify(targetsDraft) !== JSON.stringify(backup.targets ?? []) || activeDraft !== (backup.activeTargetId ?? '')
  const schedulesDirty = JSON.stringify(schedulesDraft) !== JSON.stringify(backup.schedules ?? [])

  const reload = () => {
    state.reload()
    runsPoll.reload()
  }

  const saveTargets = async () => {
    setSaveError(undefined)
    try {
      await patch({ backup: { targets: targetsDraft, activeTargetId: activeDraft } })
    } catch (failure) {
      setSaveError(failure?.message ?? String(failure))
    }
  }
  const saveSchedules = async () => {
    setSaveError(undefined)
    try {
      await patch({ backup: { schedules: schedulesDraft } })
    } catch (failure) {
      setSaveError(failure?.message ?? String(failure))
    }
  }

  const play = async (body) => {
    setPlaying(true)
    try {
      const value = await runAction('/backup/run', body)
      reload()
      return value
    } finally {
      setPlaying(false)
    }
  }

  const runs = runsPoll.data?.runs ?? state.data?.runs ?? []
  const currentTarget = (backup.targets ?? []).find((row) => row.id === backup.activeTargetId)
  const estimate = state.data?.estimate
  const sevenZip = state.data?.sevenZip === true
  const needsSevenZip = state.data?.needsSevenZip === true || backup.compression === '7z'
  const encryptionOn = backup.encryption?.enabled === true
  const credentialsOn = backup.items?.credentials === true

  return h(
    'div',
    { className: 'mydsh-page' },

    h(
      Card,
      {
        title: '备份',
        sub: '把常用状态打成一个包，放在本地磁盘或你自己的云上',
        actions: [
          h(
            Button,
            { key: 'run', variant: 'primary', disabled: state.data?.running === true || playing, onClick: () => play({}) },
            state.data?.running === true || playing ? t().loading : `▶ ${t().run}`,
          ),
          h(
            Button,
            {
              key: 'test',
              disabled: runState.pending,
              onClick: async () => {
                await runAction('/backup/test', {})
              },
            },
            '测试目标',
          ),
          h(
            Button,
            {
              key: 'restore',
              onClick: () => {
                setRestorePreset('')
                setRestoreResult(undefined)
                setRestoreOpen(true)
              },
            },
            '恢复…',
          ),
        ],
      },
      h(SwitchRow, {
        title: '启用备份',
        hint: '关闭后定时计划与「每轮对话结束后」触发都不会执行，手动备份仍可用',
        checked: backup.enabled === true,
        onChange: (next) => patch({ backup: { enabled: next } }),
      }),
      h(
        'div',
        { className: 'mydsh-list' },
        statusLine('运行状态', state.data?.running !== true, state.data?.running === true ? '正在备份…' : '空闲'),
        statusLine('上次备份', (state.data?.lastRunAt ?? 0) > 0, (state.data?.lastRunAt ?? 0) > 0 ? when(state.data.lastRunAt) : '还没有执行过'),
        statusLine('7z 压缩', sevenZip !== false, sevenZip ? '随包提供' : '缺失，7z 会自动降级为 zip'),
        statusLine('估算体积', estimate !== undefined, estimate === undefined ? t().loading : estimateLine(estimate)),
        statusLine('当前目标', currentTarget !== undefined, currentTarget === undefined ? '未配置，使用插件默认目录' : (currentTarget.label || currentTarget.kind)),
      ),
      runState.error === undefined ? null : h(Note, { tone: 'error' }, runState.error),
      runState.result !== undefined && runState.result?.ok !== undefined
        ? h(Note, { tone: runState.result.ok === true ? 'ok' : 'error' },
            `${runState.result.ok === true ? '目标可达' : '目标不可达'} · ${duration(runState.result.latencyMs)}${runState.result.message === '' ? '' : ` · ${runState.result.message}`}`)
        : null,
      needsSevenZip && sevenZip !== true
        ? h(Note, { tone: 'warn' }, '当前压缩方式选了 7z，但本机没有可用的 7zr；实际执行时会自动改用 zip-deflate。')
        : null,
      restoreResult === undefined
        ? null
        : h(
            Note,
            { tone: 'ok' },
            `已恢复 ${exact(restoreResult.restored)} 个文件到 ${restoreResult.toDir}` +
              (restoreResult.message === undefined || restoreResult.message === '' ? '' : ` · ${restoreResult.message}`),
          ),
      saveError === undefined ? null : h(Note, { tone: 'error' }, saveError),
    ),

    h(
      Card,
      { title: '备份内容', sub: '按组勾选；没有勾选任何一组时备份会因为「没有匹配到内容」而失败' },
      BACKUP_ITEM_ROWS.map(([key, title, hint]) =>
        h(SwitchRow, {
          key,
          title,
          hint,
          checked: backup.items?.[key] === true,
          onChange: (next) => patch({ backup: { items: { [key]: next } } }),
        }),
      ),
      credentialsOn && encryptionOn !== true
        ? h(
            Note,
            { tone: 'error' },
            '凭据文件已勾选，但加密没开：宿主会把这一组整体跳过，并在备份记录里写明原因。' +
              '要真正包含 .credentials.yaml，请打开下面的「加密」并设置至少 6 位密码。',
          )
        : null,
      h(
        Row,
        { title: '加密状态', hint: '凭据文件与加密是同一个决定的两面' },
        h(Badge, { tone: encryptionOn ? 'ok' : 'warn' }, encryptionOn ? '已开启 AES-256-GCM' : '未开启，凭据不会进包'),
      ),
    ),

    h(
      Card,
      {
        title: '存放位置',
        sub: `可以配置多个目标，备份与恢复都用「当前」那一个${meta?.dataDir === undefined ? '' : ` · 插件数据目录 ${meta.dataDir}`}`,
        actions: [
          targetsDirty ? h(Badge, { key: 'dirty', tone: 'warn' }, '未保存') : null,
          h(Button, { key: 'add', size: 'sm', onClick: () => setTargetsDraft((list) => [...list, freshBackupTarget('local')]) }, `+ ${t().add}`),
          h(
            Button,
            { key: 'save', size: 'sm', variant: 'primary', disabled: targetsDirty !== true, onClick: saveTargets },
            t().save,
          ),
        ],
      },
      targetsDraft.length === 0
        ? h(Empty, null, '还没有配置存放位置；点「添加」选一个本地目录就能开始。')
        : h(
            'div',
            { className: 'mydsh-list' },
            targetsDraft.map((target) =>
              h(BackupTargetRow, {
                key: target.id,
                target,
                active: target.id === activeDraft,
                onChange: (next) => setTargetsDraft((list) => list.map((row) => (row.id === next.id ? next : row))),
                onRemove: (id) => {
                  setTargetsDraft((list) => list.filter((row) => row.id !== id))
                  if (activeDraft === id) setActiveDraft('')
                },
                onActivate: (id) => setActiveDraft(id),
              }),
            ),
          ),
      h(Note, null, '「测试」用的是当前这一行里还没保存的内容，所以可以先验证连通性再保存。'),
    ),

    h(
      Card,
      {
        title: '触发方式',
        sub: '可以同时存在多条；「仅手动」只用来记录一条计划，不会自己跑',
        actions: [
          schedulesDirty ? h(Badge, { key: 'dirty', tone: 'warn' }, '未保存') : null,
          h(Button, { key: 'add', size: 'sm', onClick: () => setSchedulesDraft((list) => [...list, freshBackupSchedule()]) }, `+ ${t().add}`),
          h(
            Button,
            { key: 'save', size: 'sm', variant: 'primary', disabled: schedulesDirty !== true, onClick: saveSchedules },
            t().save,
          ),
        ],
      },
      schedulesDraft.length === 0
        ? h(Empty, null, '没有定时计划，备份只会手动执行。')
        : h(
            'div',
            { className: 'mydsh-list' },
            schedulesDraft.map((schedule, index) =>
              h(BackupScheduleRow, {
                key: schedule.id,
                schedule,
                index,
                count: schedulesDraft.length,
                onChange: (next) => setSchedulesDraft((list) => list.map((row) => (row.id === next.id ? next : row))),
                onRemove: (id) => setSchedulesDraft((list) => list.filter((row) => row.id !== id)),
                onMove: (from, delta) =>
                  setSchedulesDraft((list) => {
                    const to = from + delta
                    if (to < 0 || to >= list.length) return list
                    const next = list.slice()
                    const [moved] = next.splice(from, 1)
                    next.splice(to, 0, moved)
                    return next
                  }),
              }),
            ),
          ),
    ),

    h(
      Card,
      { title: '备份类型与压缩', sub: '增量只写与上一次相比变化的文件，依赖同一个目标上的基线' },
      h(
        Row,
        { title: '类型', hint: '目标上没有上一次的记录时，增量会自动退化成全量' },
        h(Segmented, {
          value: backup.type,
          onChange: (next) => patch({ backup: { type: next } }),
          options: [
            { value: 'full', label: '全量' },
            { value: 'incremental', label: '增量' },
          ],
        }),
      ),
      h(
        Row,
        { title: '压缩方式', hint: '7z 需要随包的 7zr；zip-deflate 是折中，zip 只打包不压缩' },
        h(Select, {
          value: backup.compression,
          options: [
            { value: 'zip-deflate', label: 'zip（deflate）' },
            { value: 'zip', label: 'zip（仅打包）' },
            { value: '7z', label: '7z' },
            { value: 'none', label: '不压缩' },
          ],
          onChange: (next) => patch({ backup: { compression: next } }),
        }),
      ),
      h(
        Row,
        { title: '分卷大小', hint: '0 表示不分卷；大于 0 时按此上限切成多个文件' },
        h(BackupNumberField, { value: backup.splitSizeMb, min: 0, max: 10240, onChange: (next) => patch({ backup: { splitSizeMb: next } }) }),
      ),
      h(
        Row,
        { title: '保留份数', hint: '只统计本插件写出的归档，多卷归档算作一份' },
        h(BackupNumberField, { value: backup.keepCount, min: 1, max: 500, onChange: (next) => patch({ backup: { keepCount: next } }) }),
      ),
      h(
        Row,
        { title: '单文件上限', hint: '超过这个大小的文件会被跳过，并在记录里列出前三个' },
        h(BackupNumberField, { value: backup.maxFileMb, min: 1, max: 8192, onChange: (next) => patch({ backup: { maxFileMb: next } }) }),
      ),
    ),

    h(
      Card,
      {
        title: '加密',
        sub: 'AES-256-GCM，密钥由密码经 scrypt 派生；密码不进归档，所以丢了就打不开',
        actions: [
          h(Switch, {
            checked: encryptionOn,
            label: '启用加密',
            onChange: (next) => patch({ backup: { encryption: { enabled: next } } }),
          }),
        ],
      },
      h(
        Row,
        { title: '密码', hint: '至少 6 位；选 7z 时由 7zr 自己加密，密码同样必须设置' },
        h(BackupSecretField, {
          value: backup.encryption?.password ?? '',
          placeholder: '备份密码',
          width: 'lg',
          onSave: (next) => patch({ backup: { encryption: { password: next } } }),
        }),
      ),
      h(Row, { title: '算法', hint: '宿主固定为 AES-256-GCM，不提供选项以免出现弱算法' },
        h('span', { className: 'mydsh-mono' }, 'AES-256-GCM'),
      ),
    ),

    h(
      Card,
      { title: '跨机同步', sub: '两台机器指向同一个目标时，用它决定谁覆盖谁' },
      h(SwitchRow, {
        title: '启用跨机同步',
        hint: '打开后备份记录会带上机器标识，冲突按下面的规则处理',
        checked: backup.sync?.enabled === true,
        onChange: (next) => patch({ backup: { sync: { enabled: next } } }),
      }),
      h(
        Row,
        { title: '方向', hint: '只上传的机器不会把远端的归档拉回来' },
        h(Select, {
          value: backup.sync?.direction ?? 'both',
          options: [
            { value: 'both', label: '双向' },
            { value: 'push', label: '仅上传' },
            { value: 'pull', label: '仅下载' },
          ],
          disabled: backup.sync?.enabled !== true,
          onChange: (next) => patch({ backup: { sync: { direction: next } } }),
        }),
      ),
      h(
        Row,
        { title: '冲突处理', hint: '「新的覆盖」比较归档时间，另外两项无条件偏向一侧' },
        h(Select, {
          value: backup.sync?.conflict ?? 'newer',
          options: [
            { value: 'newer', label: '新的覆盖旧的' },
            { value: 'local', label: '以本机为准' },
            { value: 'remote', label: '以远端为准' },
          ],
          disabled: backup.sync?.enabled !== true,
          onChange: (next) => patch({ backup: { sync: { conflict: next } } }),
        }),
      ),
    ),

    h(
      Card,
      {
        title: '历史记录',
        sub: `最近 ${runs.length} 条，含恢复与删除动作`,
        actions: [h(Button, { key: 'reload', size: 'sm', variant: 'ghost', onClick: reload }, `⟳ ${t().refresh}`)],
      },
      runs.length === 0
        ? h(Empty, null, runsPoll.loading ? t().loading : '还没有备份记录')
        : h(
            'table',
            { className: 'mydsh-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, '时间'),
                h('th', null, '类型'),
                h('th', { 'data-num': 'true' }, '大小'),
                h('th', null, '加密'),
                h('th', null, '结果'),
                h('th', null, '路径'),
                h('th', null, '操作'),
              ),
            ),
            h(
              'tbody',
              null,
              runs.map((row) =>
                h(
                  'tr',
                  { key: row.id },
                  h('td', { title: row.id }, when(row.finishedAt || row.startedAt)),
                  h('td', null, backupRunType(row)),
                  h('td', { 'data-num': 'true' }, row.bytes === undefined ? '—' : bytes(row.bytes)),
                  h('td', null, row.encrypted === true ? h(Badge, { tone: 'ok' }, '加密') : h(Badge, null, '明文')),
                  h('td', null, row.ok === true ? h(Badge, { tone: 'ok' }, '成功') : h(Badge, { tone: 'error' }, '失败')),
                  h(
                    'td',
                    { className: 'mydsh-muted mydsh-truncate', title: `${row.path ?? ''} ${row.message ?? ''}`, style: { maxWidth: 220 } },
                    row.deletedAt !== undefined ? '已删除' : (row.path || row.toDir || row.message || '—'),
                  ),
                  h(
                    'td',
                    null,
                    h(
                      'div',
                      { className: 'mydsh-inline' },
                      row.deletedAt !== undefined
                        ? null
                        : h(
                            Button,
                            {
                              size: 'sm',
                              variant: 'ghost',
                              onClick: () => {
                                setRestoreResult(undefined)
                                setRestorePreset(row.id)
                                setRestoreOpen(true)
                              },
                            },
                            '恢复',
                          ),
                      row.deletedAt !== undefined
                        ? null
                        : h(Button, { size: 'sm', variant: 'danger', onClick: () => setPendingDelete(row) }, t().remove),
                      row.ok !== true && row.message !== undefined && row.message !== ''
                        ? h('span', { title: row.message }, h(Badge, { tone: 'error' }, '原因'))
                        : null,
                    ),
                  ),
                ),
              ),
            ),
          ),
      runsPoll.error === undefined ? null : h(Note, { tone: 'error' }, runsPoll.error),
    ),

    restoreOpen
      ? h(BackupRestoreModal, {
          runs,
          initialRunId: restorePreset,
          onClose: () => setRestoreOpen(false),
          onDone: (value) => {
            setRestoreOpen(false)
            setRestoreResult(value)
            reload()
          },
        })
      : null,
    pendingDelete === undefined
      ? null
      : h(BackupConfirmModal, {
          title: '删除这次备份',
          message: `将删除目标 ${pendingDelete.path || pendingDelete.targetId || ''} 上的归档文件。记录会保留并标记为已删除，但文件无法找回。`,
          confirmLabel: '删除文件',
          busy: runState.pending,
          onClose: () => setPendingDelete(undefined),
          onConfirm: async () => {
            await runAction('/backup/delete', { runId: pendingDelete.id })
            setPendingDelete(undefined)
            reload()
          },
        }),
  )
}

/** Human label for one history row, which may be a backup, restore or delete. */
function backupRunType(row) {
  if (row.kind === 'restore') return '恢复'
  if (row.kind === 'delete') return '删除'
  if (row.kind === 'prune') return '清理'
  return row.type === 'incremental' ? '增量' : '全量'
}

    // ===== 44-tab-retry.js =====
/**
 * Retry tab.
 *
 * WHY THE POLICY LIST IS THE WHOLE PAGE
 * The Host's `decide()` walks `retry.policies` in order and takes the first rule
 * whose match fires, so order is behaviour: moving a rule up is a different
 * product than moving a value inside it. That is why every row carries an
 * explicit move control instead of a numeric "priority" field — the list *is*
 * the priority, and the UI says so.
 *
 * WHY A "TRY IT" PROBE EXISTS
 * A rule set is nearly impossible to review by reading: 429 → switch, 5xx →
 * retry with exponential backoff and a cap, auth failure → fail. The dry-run
 * endpoint answers the only question a user has ("what would happen to *this*
 * failure") without waiting for a real outage, so it is wired to per-row and
 * page-level probes alike.
 *
 * WHY THE POLICIES ARE A DRAFT
 * Same reason as the backup lists: each keystroke in `values` would otherwise be
 * its own POST plus revision bump, and every other open settings page would
 * re-fetch the whole document for it.
 */

/** How a failure is matched against the rule's `values`. */
const RETRY_MATCHES = [
  { value: 'status', label: 'HTTP 状态码' },
  { value: 'code', label: '错误码' },
  { value: 'any', label: '任意失败' },
]

/** What the Host does when a rule matches. */
const RETRY_ACTIONS = [
  { value: 'retry', label: '原路由重试' },
  { value: 'switch', label: '切换到下一条路由' },
  { value: 'fail', label: '交回宿主' },
]

/** Backoff shapes understood by `decide()`. */
const RETRY_BACKOFFS = [
  { value: 'fixed', label: '固定间隔' },
  { value: 'exponential', label: '指数退避' },
]

/**
 * The one-click preset.
 *
 * These four rows mirror the classification the reference page uses, ordered
 * so the specific statuses are tried before the broad 5xx range: `decide()`
 * stops at the first match, so a `5xx` prefix rule would otherwise swallow
 * every 503 that a dedicated rule wanted to handle differently.
 */
const RETRY_PRESETS = [
  {
    id: 'preset-429',
    label: '限流（429）',
    enabled: true,
    match: 'status',
    values: ['429'],
    action: 'switch',
    maxAttempts: 2,
    delayMs: 2000,
    backoff: 'fixed',
    respectRetryAfter: true,
  },
  {
    id: 'preset-auth',
    label: '认证/余额失败（401 402 403）',
    enabled: true,
    match: 'status',
    values: ['401', '402', '403'],
    action: 'fail',
    maxAttempts: 1,
    delayMs: 0,
    backoff: 'fixed',
    respectRetryAfter: false,
  },
  {
    id: 'preset-timeout',
    label: '超时与网络中断',
    enabled: true,
    match: 'code',
    values: ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET'],
    action: 'retry',
    maxAttempts: 4,
    delayMs: 1000,
    backoff: 'exponential',
    respectRetryAfter: false,
  },
  {
    id: 'preset-5xx',
    label: '服务端错误（5xx）',
    enabled: true,
    match: 'status',
    values: ['500', '502', '503', '504'],
    action: 'retry',
    maxAttempts: 3,
    delayMs: 1500,
    backoff: 'exponential',
    respectRetryAfter: true,
  },
]

/** A blank rule. `any` with `fail` is the least surprising placeholder. */
function freshRetryPolicy() {
  return {
    id: newId('rule'),
    label: '',
    enabled: true,
    match: 'status',
    values: [],
    action: 'retry',
    maxAttempts: 3,
    delayMs: 1000,
    backoff: 'exponential',
    respectRetryAfter: true,
  }
}

/** One labelled control inside a rule block. */
function RetryField({ label, hint, children }) {
  return h(
    'div',
    { className: 'mydsh-row-label' },
    h('span', { className: 'mydsh-muted' }, label),
    children,
    hint === undefined ? null : h('span', { className: 'mydsh-row-hint' }, hint),
  )
}

/**
 * A numeric field that writes once, on blur or Enter.
 *
 * Patching on every keystroke would turn "1500" into four settings writes and
 * four revisions, and every other open settings page re-fetches the document on
 * a revision change. A raw `input` is used because the shared `TextField` has no
 * blur hook.
 */
function RetryNumberField({ value, onChange, min, max, width }) {
  const [draft, setDraft] = useState(String(value ?? 0))
  const saved = useRef(String(value ?? 0))

  useEffect(() => {
    const next = String(value ?? 0)
    if (next !== saved.current) {
      saved.current = next
      setDraft(next)
    }
  }, [value])

  const commit = () => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(saved.current)
      return
    }
    const clamped = Math.round(Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min ?? 0, parsed)))
    const next = String(clamped)
    const changed = next !== saved.current
    saved.current = next
    setDraft(next)
    if (changed) onChange(clamped)
  }

  return h('input', {
    className: 'mydsh-input mydsh-mono',
    'data-width': width ?? 'sm',
    inputMode: 'numeric',
    value: draft,
    onChange: (event) => setDraft(event.target.value),
    onBlur: commit,
    onKeyDown: (event) => {
      if (event.key === 'Enter') commit()
    },
  })
}

/** Parse the comma/space separated value box into the array the Host stores. */
function retryValuesToText(values) {
  return Array.isArray(values) ? values.join(', ') : ''
}

/** Inverse of {@link retryValuesToText}; keeps the user's order, drops blanks. */
function retryTextToValues(text) {
  const seen = new Set()
  const out = []
  for (const part of String(text ?? '').split(/[,，\s]+/)) {
    const trimmed = part.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed.slice(0, 128))
  }
  return out
}

/** One rule row: identity, match, action, timing, order and probe. */
function RetryPolicyRow({ policy, index, count, onChange, onRemove, onMove }) {
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState(undefined)
  const set = (partial) => onChange({ ...policy, ...partial })

  const probeOnce = async () => {
    const first = Array.isArray(policy.values) && policy.values.length > 0 ? policy.values[0] : ''
    const numeric = Number(first)
    const failure =
      policy.match === 'status' && Number.isFinite(numeric) && first !== ''
        ? { status: numeric, message: `synthetic ${numeric}` }
        : policy.match === 'code' && first !== ''
          ? { code: first, message: `synthetic ${first}` }
          : { message: 'synthetic failure' }
    setProbing(true)
    try {
      const answer = await api('/retry/test', { body: { failure } })
      setProbe(answer?.decision ?? answer)
    } catch (failureThrown) {
      setProbe({ action: 'error', reason: failureThrown?.message ?? String(failureThrown) })
    } finally {
      setProbing(false)
    }
  }
  const timingDisabled = policy.action !== 'retry'

  return h(
    'div',
    { className: 'mydsh-card', 'data-flat': 'true', style: { gap: 8 } },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Switch, { checked: policy.enabled === true, label: '启用这条规则', onChange: (next) => set({ enabled: next }) }),
        h(TextField, { value: policy.label ?? '', onChange: (next) => set({ label: next }), placeholder: '规则名称（可留空）', width: 'lg' }),
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Button, { size: 'sm', disabled: index === 0, onClick: () => onMove(index, -1), title: '上移：更早匹配' }, '↑'),
        h(Button, { size: 'sm', disabled: index === count - 1, onClick: () => onMove(index, 1), title: '下移：更晚匹配' }, '↓'),
        h(Button, { size: 'sm', disabled: probing, onClick: probeOnce }, probing ? t().loading : '试用'),
        h(Button, { size: 'sm', variant: 'danger', onClick: () => onRemove(policy.id) }, t().remove),
      ),
    ),
    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '2' },
      h(
        RetryField,
        { label: '匹配方式', hint: '顺序匹配，命中第一条就停' },
        h(Select, { value: policy.match, options: RETRY_MATCHES, onChange: (next) => set({ match: next }) }),
      ),
      h(
        RetryField,
        { label: '命中后', hint: '「交回宿主」等于我不处理，让宿主自己的策略继续' },
        h(Select, { value: policy.action, options: RETRY_ACTIONS, onChange: (next) => set({ action: next }) }),
      ),
    ),
    policy.match === 'any'
      ? null
      : h(
          'div',
          { className: 'mydsh-row-label' },
          h('span', { className: 'mydsh-muted' }, policy.match === 'status' ? '状态码（逗号分隔）' : '错误码（逗号分隔）'),
          h(TextField, {
            value: retryValuesToText(policy.values),
            onChange: (next) => set({ values: retryTextToValues(next) }),
            width: 'xl',
            mono: true,
            placeholder: policy.match === 'status' ? '429, 503' : 'ETIMEDOUT, ECONNRESET',
          }),
        ),
    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '3' },
      h(
        RetryField,
        { label: '最大尝试次数', hint: '含第一次请求' },
        h(RetryNumberField, { value: policy.maxAttempts, min: 1, max: 20, onChange: (next) => set({ maxAttempts: next }) }),
      ),
      h(
        RetryField,
        { label: '首次等待（ms）', hint: timingDisabled ? '这条规则不重试，等待时间无效' : '0 表示立即重试' },
        h(RetryNumberField, {
          value: policy.delayMs,
          min: 0,
          max: 300000,
          onChange: (next) => set({ delayMs: next }),
        }),
      ),
      h(
        RetryField,
        { label: '退避方式', hint: '指数退避每次翻倍，宿主上限 60 秒' },
        h(Select, {
          value: policy.backoff,
          options: RETRY_BACKOFFS,
          disabled: timingDisabled,
          onChange: (next) => set({ backoff: next }),
        }),
      ),
    ),
    h(
      Row,
      { title: '尊重 Retry-After', hint: '供应商给了等待时长时，取它与退避结果的较大值' },
      h(Switch, {
        checked: policy.respectRetryAfter === true,
        disabled: timingDisabled,
        label: '尊重 Retry-After',
        onChange: (next) => set({ respectRetryAfter: next }),
      }),
    ),
    probe === undefined
      ? null
      : h(
          Note,
          { tone: probe.action === 'retry' || probe.action === 'switch' ? 'ok' : probe.action === 'error' ? 'error' : undefined },
          `决策：${retryActionLabel(probe.action)}` +
            (probe.delayMs === undefined ? '' : ` · 等待 ${duration(probe.delayMs)}`) +
            (probe.reason === undefined ? '' : ` · ${probe.reason}`),
        ),
  )
}

/** Human label for one decision action, including the engine's `delegate`. */
function retryActionLabel(action) {
  if (action === 'retry') return '原路由重试'
  if (action === 'switch') return '切换路由'
  if (action === 'delegate') return '交回宿主（我不介入）'
  if (action === 'error') return '请求失败'
  return String(action ?? '未决')
}

/** One failover route: provider + model, with order controls. */
function RetryChainRow({ route, index, count, meta, onChange, onRemove, onMove }) {
  const providers = providerOptions(meta, '— 选择供应商 —').filter((option) => option.value !== '')
  const models = (Array.isArray(meta?.providers) ? meta.providers : [])
    .filter((entry) => entry.provider === route.provider)
    .flatMap((entry) => (entry.models ?? []).map((model) => ({ value: model.id, label: model.name ?? model.id })))

  return h(
    'div',
    { className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
    h(
      'div',
      { className: 'mydsh-inline' },
      h('span', { className: 'mydsh-muted' }, `${index + 1}.`),
      h(Select, {
        value: route.provider,
        width: 'md',
        options: providers.length === 0 ? [{ value: route.provider, label: route.provider || '—' }] : providers,
        onChange: (next) => onChange({ ...route, provider: next, model: '' }),
      }),
      models.length === 0
        ? h(TextField, {
            value: route.model,
            onChange: (next) => onChange({ ...route, model: next }),
            placeholder: '模型 ID',
            width: 'md',
            mono: true,
          })
        : h(Select, {
            value: route.model,
            width: 'lg',
            options: [{ value: '', label: '— 选择模型 —' }].concat(models),
            onChange: (next) => onChange({ ...route, model: next }),
          }),
    ),
    h(
      'div',
      { className: 'mydsh-inline' },
      h(Button, { size: 'sm', disabled: index === 0, onClick: () => onMove(index, -1) }, '↑'),
      h(Button, { size: 'sm', disabled: index === count - 1, onClick: () => onMove(index, 1) }, '↓'),
      h(Button, { size: 'sm', variant: 'danger', onClick: () => onRemove(index) }, t().remove),
    ),
  )
}

/** The retry tab. */
function RetryTab({ settings, patch, meta }) {
  const retry = settings.retry
  const state = usePoll('/retry/state', 8000, [])
  const [runAction, runState] = useAction()

  const [policiesDraft, setPoliciesDraft] = useState(() => clone(retry.policies ?? []))
  const [saveError, setSaveError] = useState(undefined)
  const [failureDraft, setFailureDraft] = useState('{"status":429,"message":"rate limited"}')
  const [probeResult, setProbeResult] = useState(undefined)
  const [probing, setProbing] = useState(false)

  const policiesSignature = JSON.stringify(retry.policies)
  useEffect(() => {
    setPoliciesDraft(clone(retry.policies ?? []))
  }, [policiesSignature])

  const policiesDirty = JSON.stringify(policiesDraft) !== JSON.stringify(retry.policies ?? [])

  const savePolicies = async () => {
    setSaveError(undefined)
    try {
      await patch({ retry: { policies: policiesDraft } })
    } catch (failure) {
      setSaveError(failure?.message ?? String(failure))
    }
  }

  const applyPresets = () => {
    // Merge instead of replace: a user who already tuned a rule should not lose
    // it to a preset click, so only ids that are absent get added.
    const existing = new Set(policiesDraft.map((row) => row.id))
    const additions = RETRY_PRESETS.filter((row) => existing.has(row.id) !== true).map((row) => clone(row))
    setPoliciesDraft((list) => [...list, ...additions])
  }

  const probe = async () => {
    setProbing(true)
    setProbeResult(undefined)
    try {
      let failure
      try {
        failure = JSON.parse(failureDraft)
      } catch {
        setProbeResult({ error: '这段 JSON 解析不了，需要一个对象，例如 {"status":429}' })
        return
      }
      const answer = await api('/retry/test', { body: { failure } })
      setProbeResult({ decision: answer?.decision ?? answer })
    } catch (thrown) {
      setProbeResult({ error: thrown?.message ?? String(thrown) })
    } finally {
      setProbing(false)
    }
  }

  const stats = state.data?.stats ?? {}
  const events = Array.isArray(state.data?.events) ? state.data.events : []
  const chain = Array.isArray(retry.chain) ? retry.chain : []

  return h(
    'div',
    { className: 'mydsh-page' },

    h(
      Card,
      {
        title: '重试',
        sub: '先按规则判断能不能重试，再决定要不要换一条路由继续',
        actions: [
          h(Switch, {
            key: 'switch',
            checked: retry.enabled === true,
            label: '启用重试',
            onChange: (next) => patch({ retry: { enabled: next } }),
          }),
        ],
      },
      h(SwitchRow, {
        title: '全局启用重试',
        hint: '关闭后本插件完全不介入：不判断、不等待、不切换，宿主自己的策略照旧',
        checked: retry.enabled === true,
        onChange: (next) => patch({ retry: { enabled: next } }),
      }),
      retry.enabled === true
        ? h(Note, { tone: 'ok' }, `当前有 ${(retry.policies ?? []).length} 条规则、${chain.length} 条备用路由；规则按从上到下的顺序匹配。`)
        : h(Note, { tone: 'warn' }, '重试未启用，下面的规则与路由只被保存，不会被使用。'),
      h(
        'div',
        { className: 'mydsh-grid', 'data-cols': '4' },
        h(Stat, { label: '已观察', value: exact(stats.seen), foot: '进入本插件判断的失败数' }),
        h(Stat, { label: '已重试', value: exact(stats.retried), accent: 'var(--dsw-alias-state-success-primary)', foot: '同一路由再试' }),
        h(Stat, { label: '已切换', value: exact(stats.switched), accent: 'var(--dsw-alias-brand-primary)', foot: '换路由后继续' }),
        h(Stat, { label: '交回宿主', value: exact(stats.delegated), foot: '本插件未介入' }),
      ),
      state.error === undefined ? null : h(Note, { tone: 'error' }, state.error),
    ),

    h(
      Card,
      {
        title: '策略列表',
        sub: '从上往下匹配，命中第一条即停；把最特殊的规则放最上面',
        actions: [
          policiesDirty ? h(Badge, { key: 'dirty', tone: 'warn' }, '未保存') : null,
          h(Button, { key: 'preset', size: 'sm', onClick: applyPresets }, '一键预置'),
          h(Button, { key: 'add', size: 'sm', onClick: () => setPoliciesDraft((list) => [...list, freshRetryPolicy()]) }, `+ ${t().add}`),
          h(
            Button,
            { key: 'save', size: 'sm', variant: 'primary', disabled: policiesDirty !== true, onClick: savePolicies },
            t().save,
          ),
        ],
      },
      policiesDraft.length === 0
        ? h(Empty, null, '还没有规则：所有失败都交回宿主。可以先点「一键预置」拿一组常用规则再改。')
        : h(
            'div',
            { className: 'mydsh-list' },
            policiesDraft.map((policy, index) =>
              h(RetryPolicyRow, {
                key: policy.id,
                policy,
                index,
                count: policiesDraft.length,
                onChange: (next) => setPoliciesDraft((list) => list.map((row) => (row.id === next.id ? next : row))),
                onRemove: (id) => setPoliciesDraft((list) => list.filter((row) => row.id !== id)),
                onMove: (from, delta) =>
                  setPoliciesDraft((list) => {
                    const to = from + delta
                    if (to < 0 || to >= list.length) return list
                    const next = list.slice()
                    const [moved] = next.splice(from, 1)
                    next.splice(to, 0, moved)
                    return next
                  }),
              }),
            ),
          ),
      h(Note, null, '「一键预置」只补充缺失的规则，不会覆盖你已经改过的同名规则。预置顺序为：认证失败 → 限流 → 超时 → 5xx。'),
      policiesDraft.some((row) => row.enabled === false)
        ? h(
            Note,
            { tone: 'warn' },
            '注意：当前宿主的匹配逻辑不看每条规则自己的开关，关掉的规则仍会参与匹配。' +
              '真要停用一条规则，请删除它，或把「命中后」改成「交回宿主」——后者保留规则但不改变行为。',
          )
        : null,
      saveError === undefined ? null : h(Note, { tone: 'error' }, saveError),
    ),

    h(
      Card,
      { title: '试算一次失败', sub: '把一条失败喂给当前规则，看宿主会怎么处理；不会真的发请求' },
      h(TextArea, { value: failureDraft, onChange: setFailureDraft, rows: 3, placeholder: '{"status":503,"message":"upstream"} 或 {"code":"ETIMEDOUT"}' }),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Button, { variant: 'primary', disabled: probing, onClick: probe }, probing ? t().loading : '试算'),
        h('span', { className: 'mydsh-muted' }, '字段：status（数字）、code（错误码）、message（说明）'),
      ),
      probeResult === undefined
        ? null
        : probeResult.error === undefined
          ? h(
              Note,
              { tone: probeResult.decision?.action === 'retry' || probeResult.decision?.action === 'switch' ? 'ok' : undefined },
              `决策：${retryActionLabel(probeResult.decision?.action)}` +
                (probeResult.decision?.delayMs === undefined ? '' : ` · 等待 ${duration(probeResult.decision.delayMs)}`),
            )
          : h(Note, { tone: 'error' }, probeResult.error),
    ),

    h(
      Card,
      { title: '故障切换顺序', sub: '当前路由失败后按这个顺序找下一条；到末尾仍未成功就交回宿主' },
      chain.length === 0
        ? h(Empty, null, '没有备用路由：策略里的「切换到下一条路由」会因为没有路由可用而交回宿主。')
        : h(
            'div',
            { className: 'mydsh-list' },
            chain.map((route, index) =>
              h(RetryChainRow, {
                key: `${route.provider}::${route.model}::${index}`,
                route,
                index,
                count: chain.length,
                meta,
                onChange: (next) => patch({ retry: { chain: chain.map((row, at) => (at === index ? next : row)) } }),
                onRemove: (at) => patch({ retry: { chain: chain.filter((_, position) => position !== at) } }),
                onMove: (from, delta) => {
                  const to = from + delta
                  if (to < 0 || to >= chain.length) return
                  const next = chain.slice()
                  const [moved] = next.splice(from, 1)
                  next.splice(to, 0, moved)
                  patch({ retry: { chain: next } })
                },
              }),
            ),
          ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(
          Button,
          {
            size: 'sm',
            onClick: () => {
              const first = Array.isArray(meta?.providers) ? meta.providers[0] : undefined
              const model = first?.models?.[0]?.id ?? ''
              patch({ retry: { chain: [...chain, { provider: first?.provider ?? '', model }] } })
            },
          },
          `+ ${t().add}`,
        ),
        h('span', { className: 'mydsh-muted' }, '路由与模型目录来自宿主上报，改完立即保存'),
      ),
      h(SwitchRow, {
        title: '允许切换模型',
        hint: '同一供应商内换模型；关掉后只剩同模型的路由可用',
        checked: retry.allowSwitchModel === true,
        onChange: (next) => patch({ retry: { allowSwitchModel: next } }),
      }),
      h(SwitchRow, {
        title: '允许切换供应商',
        hint: '跨供应商切换是最有效的一步，也是最需要你确认的一步',
        checked: retry.allowSwitchProvider === true,
        onChange: (next) => patch({ retry: { allowSwitchProvider: next } }),
      }),
      h(
        Row,
        { title: '单次请求最多切换', hint: '0 表示不限制路由切换，但请求仍受规则的最大尝试次数约束' },
        h(RetryNumberField, {
          value: retry.maxSwitchPerRequest,
          min: 0,
          max: 10,
          onChange: (next) => patch({ retry: { maxSwitchPerRequest: next } }),
        }),
      ),
      h(
        Row,
        { title: '事件记录上限', hint: '只影响下面的表格与落盘条数，不影响判断' },
        h(RetryNumberField, {
          value: retry.recordLimit,
          min: 20,
          max: 2000,
          width: 'sm',
          onChange: (next) => patch({ retry: { recordLimit: next } }),
        }),
      ),
    ),

    h(
      Card,
      {
        title: '最近事件',
        sub: `运行态来自 /retry/state，每 8 秒刷新一次；共 ${events.length} 条`,
        actions: [
          h(Button, {
            key: 'reload',
            size: 'sm',
            variant: 'ghost',
            onClick: () => state.reload(),
          }, `⟳ ${t().refresh}`),
          h(
            Button,
            {
              key: 'clear',
              size: 'sm',
              variant: 'danger',
              disabled: runState.pending,
              onClick: async () => {
                await runAction('/retry/clear', {})
                state.reload()
              },
            },
            '清空记录',
          ),
        ],
      },
      runState.error === undefined ? null : h(Note, { tone: 'error' }, runState.error),
      events.length === 0
        ? h(Empty, null, state.loading ? t().loading : '还没有事件；开关打开后，失败会记录在这里')
        : h(
            'div',
            { className: 'mydsh-scroll' },
            h(
              'table',
              { className: 'mydsh-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, '时间'),
                  h('th', null, '动作'),
                  h('th', null, '状态'),
                  h('th', null, '错误码'),
                  h('th', null, '路由'),
                  h('th', { 'data-num': 'true' }, '第几次'),
                  h('th', { 'data-num': 'true' }, '等待'),
                ),
              ),
              h(
                'tbody',
                null,
                events.map((event, index) =>
                  h(
                    'tr',
                    { key: `${event.at ?? index}-${index}` },
                    h('td', null, when(event.at)),
                    h(
                      'td',
                      null,
                      h(
                        Badge,
                        { tone: event.action === 'retry' ? 'ok' : event.action === 'switch' ? 'warn' : undefined },
                        retryActionLabel(event.action),
                      ),
                    ),
                    h('td', null, event.status === undefined || event.status === 0 ? '—' : String(event.status)),
                    h('td', { className: 'mydsh-mono' }, event.code === '' || event.code === undefined ? '—' : event.code),
                    h(
                      'td',
                      { className: 'mydsh-muted mydsh-truncate', style: { maxWidth: 200 } },
                      event.nextProvider === undefined
                        ? `${event.provider ?? ''}${event.model === undefined ? '' : ` · ${event.model}`}`
                        : `→ ${event.nextProvider} · ${event.nextModel ?? ''}`,
                    ),
                    h('td', { 'data-num': 'true' }, exact(event.attempt)),
                    h('td', { 'data-num': 'true' }, event.delayMs === undefined ? '—' : duration(event.delayMs)),
                  ),
                ),
              ),
            ),
          ),
      h(Note, null, '「清空记录」只清空内存与落盘的事件，不改动上面的规则与路由。'),
    ),
  )
}

    // ===== 45-tab-personalize.js =====
/**
 * Personalize tab.
 *
 * WHY THE TWO LONG FIELDS ARE READ-ONLY UNTIL "编辑"
 * `instructions` and `persona` are the two fields a user actually types paragraphs
 * into. Writing through `patch` on every keystroke would spend one HTTP round trip
 * and one settings revision per character, and the revision bump makes every
 * other open settings page re-fetch the whole document. A read-only preview plus
 * a modal editor gives one write per editing session, and it also gives the long
 * text the room it needs — which is what the reference page does.
 *
 * WHY THE PREVIEW IS EXPLICIT ABOUT "NOTHING WILL BE ATTACHED"
 * The most common confusion about personalization is a form full of text and a
 * session that receives none of it: `scope: 'workspaces'` with an unmatched
 * directory applies nowhere, by design. Saying so in the preview, with the
 * reason, is the difference between a bug report and a five-second fix.
 *
 * WHY MEMORY MUTATIONS GO THROUGH THE MEMORY API ONLY
 * The memory list is its own resource on the Host (`/personalize/memory`), and
 * the Host's memory store already writes every change back into the settings
 * document through `onMemoryChange`. The API therefore computes the trimmed,
 * de-duped list (including `maxEntries` eviction) and persists it; the page only
 * re-reads. Echoing the answer back through `patch` would write stale data — two
 * adds a second apart would race and the later write could restore the list from
 * before the first landed.
 */

/** Reply styles, with the one-line rule the Host actually injects. */
const PERSONALIZE_STYLES = [
  { value: 'efficient', label: '高效务实', rule: '先给结论，再给必要的步骤；省略寒暄、铺垫和自我评价。' },
  { value: 'detailed', label: '详尽', rule: '先给结论，再补充依据、边界条件与验证方式；关键步骤写出具体命令或文件路径。' },
  { value: 'friendly', label: '亲切', rule: '语气亲切自然，用短句和日常说法；信息仍需准确，不用表情堆积情绪。' },
  { value: 'formal', label: '正式', rule: '使用正式书面语，措辞严谨克制，避免口语、玩笑和情绪化表达。' },
  { value: 'concise', label: '极简', rule: '能用一句说清就不写第二句，只保留结论与关键参数。' },
]

/** Discipline flavours, quoting how each one phrases the same reminder. */
const PERSONALIZE_FLAVORS = [
  { value: 'plain', label: '平直', hint: '只陈述事实，不加语气词' },
  { value: 'coach', label: '教练', hint: '「提醒一下：… 先把证据补齐，再下结论」' },
  { value: 'strict', label: '严格', hint: '「注意：口头结论不算交付，请立刻补齐证据」' },
  { value: 'warm', label: '温和', hint: '「别急，补一句证据就好」' },
]

/**
 * A numeric field that writes once, on blur or Enter.
 *
 * Same reasoning as the other tabs: a controlled number field patched per
 * keystroke turns "200" into three writes and three revisions, and every open
 * settings page re-fetches the document on a revision change.
 */
function PersonalizeNumberField({ value, onChange, min, max, width }) {
  const [draft, setDraft] = useState(String(value ?? 0))
  const saved = useRef(String(value ?? 0))

  useEffect(() => {
    const next = String(value ?? 0)
    if (next !== saved.current) {
      saved.current = next
      setDraft(next)
    }
  }, [value])

  const commit = () => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(saved.current)
      return
    }
    const clamped = Math.round(Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min ?? 0, parsed)))
    const next = String(clamped)
    const changed = next !== saved.current
    saved.current = next
    setDraft(next)
    if (changed) onChange(clamped)
  }

  return h('input', {
    className: 'mydsh-input mydsh-mono',
    'data-width': width ?? 'sm',
    inputMode: 'numeric',
    value: draft,
    onChange: (event) => setDraft(event.target.value),
    onBlur: commit,
    onKeyDown: (event) => {
      if (event.key === 'Enter') commit()
    },
  })
}

/** A long text block, shown read-only with an 编辑 button and a modal editor. */
function PersonalizeLongField({ title, hint, value, placeholder, rows, onSave }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value ?? '')

  useEffect(() => {
    if (!open) setDraft(value ?? '')
  }, [value, open])

  const count = (value ?? '').length
  return h(
    'div',
    { className: 'mydsh-row-label', style: { gap: 6 } },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        null,
        h('span', { className: 'mydsh-row-title' }, title),
        hint === undefined ? null : h('div', { className: 'mydsh-row-hint' }, hint),
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h('span', { className: 'mydsh-muted' }, `${exact(count)} 字`),
        h(Button, { size: 'sm', onClick: () => setOpen(true) }, t().edit),
      ),
    ),
    (value ?? '') === ''
      ? h(Note, null, placeholder)
      : h(
          'pre',
          {
            className: 'mydsh-mono',
            style: {
              margin: 0,
              maxHeight: 220,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              padding: '8px 10px',
              borderRadius: 8,
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l1)',
            },
          },
          value,
        ),
    open
      ? h(
          Modal,
          {
            title,
            onClose: () => setOpen(false),
            footer: [
              h(Button, { key: 'cancel', onClick: () => setOpen(false) }, t().cancel),
              h(
                Button,
                {
                  key: 'save',
                  variant: 'primary',
                  onClick: () => {
                    onSave(draft)
                    setOpen(false)
                  },
                },
                t().save,
              ),
            ],
          },
          hint === undefined ? null : h('div', { className: 'mydsh-muted' }, hint),
          h(TextArea, { value: draft, onChange: setDraft, rows: rows ?? 14, placeholder }),
          h('div', { className: 'mydsh-muted' }, `${exact(draft.length)} 字 · 保存后立即生效，作用于下一次模型请求`),
        )
      : null,
  )
}

/**
 * The workspace picker.
 *
 * Hand-rolled checkboxes instead of a multi-select: the Host's `Select` is single
 * value, and a broken multi-select is worse than no multi-select. Order is the
 * registry order so two windows cannot disagree about what the list says.
 */
function PersonalizeWorkspacePicker({ workspaces, selected, onChange, disabled }) {
  const list = Array.isArray(workspaces) ? workspaces : []
  const chosen = new Set(Array.isArray(selected) ? selected : [])

  if (list.length === 0) {
    return h(Note, { tone: 'warn' }, '宿主没有上报任何工作区，所以「仅指定工作区」现在等于哪里都不生效；换回「全部会话」或手动填写路径。')
  }

  const toggle = (path, on) => {
    const next = on ? [...chosen, path] : [...chosen].filter((entry) => entry !== path)
    onChange(next)
  }

  return h(
    'div',
    { className: 'mydsh-list', style: { opacity: disabled === true ? 0.5 : 1 } },
    list.map((workspace) =>
      h(
        'label',
        {
          key: workspace.path,
          className: 'mydsh-inline',
          style: { justifyContent: 'space-between', gap: 8, cursor: disabled === true ? 'not-allowed' : 'pointer' },
        },
        h(
          'span',
          { className: 'mydsh-inline', style: { minWidth: 0 } },
          h('input', {
            type: 'checkbox',
            checked: chosen.has(workspace.path),
            disabled: disabled === true,
            onChange: (event) => toggle(workspace.path, event.target.checked),
          }),
          h('span', { className: 'mydsh-truncate' }, workspace.title === '' ? workspace.path : workspace.title),
        ),
        h('span', { className: 'mydsh-muted mydsh-truncate', style: { maxWidth: '55%' } }, workspace.path),
      ),
    ),
    chosen.size === 0 ? h(Note, { tone: 'warn' }, '一个工作区都没选：个性化不会附加到任何会话。') : null,
  )
}

/** One memory entry row: text, metadata, pin toggle, delete. */
function PersonalizeMemoryRow({ entry, busy, onPin, onRemove }) {
  return h(
    'div',
    { className: 'mydsh-row', 'data-stack': 'true' },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
      h(
        'div',
        { className: 'mydsh-inline', style: { minWidth: 0 } },
        entry.pinned === true ? h(Badge, { tone: 'ok' }, '置顶') : null,
        entry.workspace === '' || entry.workspace === undefined
          ? h(Badge, null, '全局')
          : h(Badge, null, '工作区'),
        h('span', { className: 'mydsh-muted' }, `${entry.source ?? 'manual'} · ${when(entry.at)}`),
        entry.hits > 0 ? h('span', { className: 'mydsh-muted' }, `召回 ${exact(entry.hits)} 次`) : null,
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Button, { size: 'sm', disabled: busy, onClick: () => onPin(entry) }, entry.pinned === true ? '取消置顶' : '置顶'),
        h(Button, { size: 'sm', variant: 'danger', disabled: busy, onClick: () => onRemove(entry) }, t().remove),
      ),
    ),
    h('div', { style: { fontSize: 12, whiteSpace: 'pre-wrap' } }, entry.text),
    entry.workspace === '' || entry.workspace === undefined
      ? null
      : h('div', { className: 'mydsh-muted mydsh-truncate', title: entry.workspace }, entry.workspace),
  )
}

/**
 * The memory manager: search, add, pin, delete, clear.
 *
 * Search runs on the Host (`q`) rather than filtering locally: the Host also
 * applies the scope rule, and two filters that can disagree is how a user ends up
 * believing an entry was deleted when it was only hidden.
 *
 * WHY NOTHING HERE PATCHES THE SETTINGS DOCUMENT
 * The Host's memory store already persists every mutation through the settings
 * store (`onMemoryChange`), so the list the API returns is the list on disk.
 * Echoing that same list back through `patch` would be a second write of stale
 * data: two adds a second apart would race, and the second write could put back
 * the list from before the first one landed. The page therefore only asks the
 * settings store to re-read, which it does on its own 2 s revision poll anyway.
 */
function PersonalizeMemoryList({ workspaces, enabled, onChanged }) {
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [addText, setAddText] = useState('')
  const [addWorkspace, setAddWorkspace] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(undefined)

  // Debounced so typing a word is one request, not one per character.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchDraft.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchDraft])

  const path = enabled === true ? `/personalize/memory?q=${encodeURIComponent(search)}` : null
  const poll = usePoll(path, 0, [search, enabled])

  /** Ask the settings store to catch up with the write the memory API just made. */
  const persist = () => {
    if (typeof onChanged === 'function') onChanged()
  }

  const mutate = async (body, note) => {
    setBusy(true)
    setMessage(undefined)
    try {
      const value = await api('/personalize/memory', { body })
      persist()
      setMessage(note)
      poll.reload()
      return value
    } catch (failure) {
      setMessage(failure?.message ?? String(failure))
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const entries = Array.isArray(poll.data?.entries) ? poll.data.entries : []
  const total = Number(poll.data?.total ?? entries.length)

  const add = async () => {
    const text = addText.trim()
    if (text === '') {
      setMessage('先写一条要记住的内容')
      return
    }
    const value = await mutate({ add: { text, workspace: addWorkspace, source: 'manual' } }, '已新增一条记忆')
    // Keep the text on a failure so a rejected entry is not silently lost.
    if (value !== undefined) setAddText('')
  }

  return h(
    'div',
    { className: 'mydsh-list' },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(TextField, {
        value: searchDraft,
        onChange: setSearchDraft,
        placeholder: '搜索记忆内容',
        width: 'lg',
      }),
      h(
        'div',
        { className: 'mydsh-inline' },
        h('span', { className: 'mydsh-muted' }, `${exact(entries.length)} / ${exact(total)} 条`),
        h(Button, { size: 'sm', variant: 'ghost', onClick: () => poll.reload() }, `⟳ ${t().refresh}`),
        h(
          Button,
          {
            size: 'sm',
            variant: 'danger',
            disabled: busy,
            onClick: async () => {
              setBusy(true)
              setMessage(undefined)
              try {
                const value = await api('/personalize/memory/clear', { body: { scope: 'all' } })
                persist()
                setMessage(`已清空 ${exact(value?.removed)} 条记忆`)
                poll.reload()
              } catch (failure) {
                setMessage(failure?.message ?? String(failure))
              } finally {
                setBusy(false)
              }
            },
          },
          '清空全部',
        ),
      ),
    ),
    h(
      'div',
      { className: 'mydsh-inline', style: { alignItems: 'flex-end' } },
      h(
        'div',
        { className: 'mydsh-grow mydsh-row-label' },
        h('span', { className: 'mydsh-muted' }, '新增一条记忆'),
        h(TextArea, { value: addText, onChange: setAddText, rows: 2, placeholder: '例如：这个项目所有文件都要用 V1/V2 版本后缀，禁止覆盖旧版。' }),
      ),
    ),
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        { className: 'mydsh-inline' },
        h('span', { className: 'mydsh-muted' }, '归属'),
        h(Select, {
          value: addWorkspace,
          width: 'md',
          options: [{ value: '', label: '全局（所有会话）' }].concat(
            (Array.isArray(workspaces) ? workspaces : []).map((workspace) => ({
              value: workspace.path,
              label: workspace.title === '' ? workspace.path : workspace.title,
            })),
          ),
          onChange: setAddWorkspace,
        }),
      ),
      h(Button, { variant: 'primary', disabled: busy, onClick: add }, busy ? t().loading : '新增'),
    ),
    message === undefined ? null : h(Note, { tone: /失败|不能|无效/.test(String(message)) ? 'error' : 'ok' }, message),
    poll.error === undefined ? null : h(Note, { tone: 'error' }, poll.error),
    entries.length === 0
      ? h(Empty, null, poll.loading ? t().loading : search === '' ? '还没有记忆条目' : '没有匹配的条目')
      : h(
          'div',
          { className: 'mydsh-scroll mydsh-list' },
          entries.map((entry) =>
            h(PersonalizeMemoryRow, {
              key: entry.id,
              entry,
              busy,
              onPin: (row) => mutate({ pin: { id: row.id, pinned: row.pinned !== true } }, row.pinned === true ? '已取消置顶' : '已置顶'),
              onRemove: (row) => mutate({ remove: row.id }, '已删除一条记忆'),
            }),
          ),
        ),
  )
}

/** The personalize tab. */
function PersonalizeTab({ settings, patch, meta }) {
  const personalize = settings.personalize
  const discipline = personalize.discipline ?? {}
  const memory = personalize.memory ?? {}
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewCwd, setPreviewCwd] = useState(() => {
    const list = Array.isArray(meta?.workspaces) ? meta.workspaces : []
    return list[0]?.path ?? ''
  })

  // The preview is keyed on what actually changes the assembled text. Editing a
  // long field goes through a modal save, so this signature is stable while the
  // user types and changes exactly when a save lands.
  const previewSignature = JSON.stringify([
    personalize.enabled,
    personalize.nickname,
    personalize.assistantName,
    personalize.replyStyle,
    personalize.scope,
    personalize.workspaces,
    personalize.instructions,
    personalize.persona,
    memory.enabled,
    memory.inject,
  ])
  const preview = usePoll(
    `/personalize/preview?cwd=${encodeURIComponent(previewCwd)}`,
    0,
    [previewCwd, previewSignature],
  )

  const setPersonalize = (partial) => patch({ personalize: partial })
  const setMemory = (partial) => patch({ personalize: { memory: partial } })
  const setDiscipline = (partial) => patch({ personalize: { discipline: partial } })

  const styleRule = PERSONALIZE_STYLES.find((row) => row.value === personalize.replyStyle) ?? PERSONALIZE_STYLES[0]
  const workspaces = Array.isArray(meta?.workspaces) ? meta.workspaces : []
  const selectedWorkspaces = Array.isArray(personalize.workspaces) ? personalize.workspaces : []
  const memoryEnabled = memory.enabled === true
  const previewData = preview.data
  const previewActive = previewData?.active === true

  return h(
    'div',
    { className: 'mydsh-page' },

    h(
      Card,
      {
        title: '个性化',
        sub: '这里写的东西会作为一段系统提示注入，作用于每一次模型请求',
        actions: [
          h(Switch, {
            key: 'switch',
            checked: personalize.enabled === true,
            label: '启用个性化',
            onChange: (next) => setPersonalize({ enabled: next }),
          }),
        ],
      },
      h(SwitchRow, {
        title: '启用个性化',
        hint: '关闭后所有字段照旧保存，但不会附加任何内容到会话',
        checked: personalize.enabled === true,
        onChange: (next) => setPersonalize({ enabled: next }),
      }),
      personalize.enabled === true
        ? h(Note, { tone: 'ok' }, '已启用：下面的内容会按 身份 → 风格 → 人设 → 指令 → 记忆 的固定顺序注入。')
        : h(Note, { tone: 'warn' }, '未启用：字段仍然保存，但会话不会收到任何附加内容。'),
      h(
        'div',
        { className: 'mydsh-grid', 'data-cols': '2' },
        h(
          'div',
          { className: 'mydsh-row-label' },
          h('span', { className: 'mydsh-row-title' }, '对你的称呼'),
          h('span', { className: 'mydsh-row-hint' }, '助手在回复里怎么叫你；留空则不强调称呼'),
          h(TextField, {
            value: personalize.nickname ?? '',
            onChange: (next) => setPersonalize({ nickname: next }),
            width: 'lg',
            placeholder: '例如：郑磊',
          }),
        ),
        h(
          'div',
          { className: 'mydsh-row-label' },
          h('span', { className: 'mydsh-row-title' }, '助手名字'),
          h('span', { className: 'mydsh-row-hint' }, '助手用什么名字自称；留空则用供应商默认'),
          h(TextField, {
            value: personalize.assistantName ?? '',
            onChange: (next) => setPersonalize({ assistantName: next }),
            width: 'lg',
            placeholder: '例如：小马哥',
          }),
        ),
      ),
      h(
        Row,
        { title: '回复风格', hint: styleRule.rule, stack: true },
        h(Segmented, {
          value: personalize.replyStyle,
          onChange: (next) => setPersonalize({ replyStyle: next }),
          options: PERSONALIZE_STYLES.map((row) => ({ value: row.value, label: row.label })),
        }),
      ),
    ),

    h(
      Card,
      { title: '长期指令与人设', sub: '每次对话都会生效，所以只写长期成立的规则，不写一次性要求' },
      h(PersonalizeLongField, {
        title: '给助手的指令',
        hint: '你希望助手一直遵守的要求，例如版本管理、文案风格、交付格式',
        value: personalize.instructions ?? '',
        placeholder: '还没有写长期指令。点「编辑」开始写，例如：所有文件都按 V1、V2 递增，禁止覆盖旧版。',
        rows: 16,
        onSave: (next) => setPersonalize({ instructions: next }),
      }),
      h(PersonalizeLongField, {
        title: '人设设定',
        hint: '助手是什么身份、什么性格、怎么表达；对人设的描述越具体，语气越稳定',
        value: personalize.persona ?? '',
        placeholder: '暂无人设 / 人格描述，点「编辑」添加。',
        rows: 12,
        onSave: (next) => setPersonalize({ persona: next }),
      }),
    ),

    h(
      Card,
      { title: '生效范围', sub: '决定这段内容出现在哪些会话里' },
      h(
        Row,
        { title: '范围', hint: '选定「仅指定工作区」后，没有列出的目录不会收到任何内容' },
        h(Segmented, {
          value: personalize.scope,
          onChange: (next) => setPersonalize({ scope: next }),
          options: [
            { value: 'all', label: '全部会话' },
            { value: 'workspaces', label: '仅指定工作区' },
          ],
        }),
      ),
      personalize.scope === 'workspaces'
        ? h(PersonalizeWorkspacePicker, {
            workspaces,
            selected: selectedWorkspaces,
            disabled: personalize.enabled !== true,
            onChange: (next) => setPersonalize({ workspaces: next }),
          })
        : h(Note, null, `当前作用于所有会话${workspaces.length === 0 ? '' : `；宿主已上报 ${workspaces.length} 个工作区`}。`),
      h(
        Row,
        {
          title: '手动填写路径',
          hint: '不在工作区列表里的目录（例如临时克隆）也可以直接写进来，一行一个',
          stack: true,
        },
        h(TextArea, {
          value: selectedWorkspaces.filter((entry) => workspaces.every((workspace) => workspace.path !== entry)).join('\n'),
          rows: 3,
          placeholder: 'D:\\Projects\\example',
          onChange: (text) => {
            const manual = text
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== '')
            const fromList = selectedWorkspaces.filter((entry) => workspaces.some((workspace) => workspace.path === entry))
            setPersonalize({ workspaces: [...fromList, ...manual] })
          },
        }),
      ),
    ),

    h(
      Card,
      { title: '长期记忆', sub: '跨会话保存的事实与结论；开启注入后按相关度挑几条写进提示' },
      h(SwitchRow, {
        title: '启用长期记忆',
        hint: '关闭后条目仍在，只有下面的记忆管理会被收起',
        checked: memoryEnabled,
        onChange: (next) => setMemory({ enabled: next }),
      }),
      memoryEnabled
        ? h(SwitchRow, {
            title: '注入到提示',
            hint: '关闭后只保存不注入：适合先攒一批再统一审阅',
            checked: memory.inject === true,
            onChange: (next) => setMemory({ inject: next }),
          })
        : null,
      memoryEnabled
        ? h(SwitchRow, {
            title: '写入前先审阅',
            hint: '打开后由你确认才落盘，避免助手把猜测写成事实',
            checked: memory.reviewBeforeWrite === true,
            onChange: (next) => setMemory({ reviewBeforeWrite: next }),
          })
        : null,
      memoryEnabled
        ? h(
            Row,
            { title: '最多保留条目', hint: '超出后按「命中次数低、时间旧」的顺序淘汰，置顶条目最后才动' },
            h(PersonalizeNumberField, {
              value: memory.maxEntries,
              min: 1,
              max: 2000,
              onChange: (next) => setMemory({ maxEntries: next }),
            }),
          )
        : null,
      memoryEnabled
        ? h(PersonalizeMemoryList, {
            workspaces,
            enabled: memoryEnabled,
            onChanged: () => settingsStore.refresh(true),
          })
        : h(Empty, null, '长期记忆未启用。启用后可以在这里搜索、置顶、删除和手动新增条目。'),
    ),

    h(
      Card,
      { title: '行为纪律', sub: '在回合结束时检查「说完成」这件事有没有依据；每次提醒都写进会话日志' },
      h(SwitchRow, {
        title: '启用行为纪律',
        hint: '关闭后三项检查全部停下，不注入任何提醒',
        checked: discipline.enabled === true,
        onChange: (next) => setDiscipline({ enabled: next }),
      }),
      h(
        Row,
        { title: '提醒语气', hint: PERSONALIZE_FLAVORS.find((row) => row.value === discipline.flavor)?.hint },
        h(Select, {
          value: discipline.flavor ?? 'plain',
          options: PERSONALIZE_FLAVORS.map((row) => ({ value: row.value, label: row.label })),
          disabled: discipline.enabled !== true,
          onChange: (next) => setDiscipline({ flavor: next }),
        }),
      ),
      h(SwitchRow, {
        title: '反虚假完成',
        hint: '这一回合一次工具都没调用却宣布完成时提醒',
        checked: discipline.antiFake !== false,
        disabled: discipline.enabled !== true,
        onChange: (next) => setDiscipline({ antiFake: next }),
      }),
      h(SwitchRow, {
        title: '要求可验证的交付',
        hint: '结论里没有路径、命令、输出块或退出码时提醒',
        checked: discipline.acceptance !== false,
        disabled: discipline.enabled !== true,
        onChange: (next) => setDiscipline({ acceptance: next }),
      }),
      h(SwitchRow, {
        title: '循环守卫',
        hint: '同一个工具、同样的参数连续失败时打断并提示换法子',
        checked: discipline.loopGuard !== false,
        disabled: discipline.enabled !== true,
        onChange: (next) => setDiscipline({ loopGuard: next }),
      }),
      h(
        Row,
        { title: '每回合最多提醒', hint: '0 表示不提醒；上限保证纪律层不会变成第二个对话方' },
        h(PersonalizeNumberField, {
          value: discipline.maxNudges,
          min: 0,
          max: 20,
          onChange: (next) => setDiscipline({ maxNudges: next }),
        }),
      ),
    ),

    h(
      Card,
      {
        title: '实时预览',
        sub: '看着的是宿主现在真正会注入的文本，不是浏览器里的拼装',
        actions: [
          h(Button, { key: 'reload', size: 'sm', variant: 'ghost', onClick: () => preview.reload() }, `⟳ ${t().refresh}`),
          h(Button, { key: 'open', size: 'sm', onClick: () => setPreviewOpen(true) }, '全屏查看'),
        ],
      },
      h(
        'div',
        { className: 'mydsh-inline' },
        h('span', { className: 'mydsh-muted' }, '按哪个目录预览'),
        h(Select, {
          value: previewCwd,
          width: 'lg',
          options: [{ value: '', label: '（不分目录 / 全局）' }].concat(
            workspaces.map((workspace) => ({
              value: workspace.path,
              label: workspace.title === '' ? workspace.path : workspace.title,
            })),
          ),
          onChange: setPreviewCwd,
        }),
        h(TextField, { value: previewCwd, onChange: setPreviewCwd, width: 'lg', mono: true, placeholder: '也可以直接填一个目录路径' }),
      ),
      preview.error === undefined ? null : h(Note, { tone: 'error' }, preview.error),
      previewActive
        ? h(
            Note,
            { tone: 'ok' },
            `当前会附加 ${previewData?.sections?.length ?? 0} 段内容，约 ${tokens(previewData?.tokens, activeLocale())} tokens（${exact(previewData?.tokens)}）。`,
          )
        : h(
            Note,
            { tone: 'warn' },
            personalize.enabled !== true
              ? '当前不会附加任何内容：个性化总开关是关的。'
              : personalize.scope === 'workspaces' && selectedWorkspaces.length === 0
                ? '当前不会附加任何内容：范围是「仅指定工作区」，但一个工作区都没选，所以任何会话都命中不了。'
                : personalize.scope === 'workspaces'
                  ? `当前不会附加任何内容：这个目录不在已选的工作区里（已选 ${selectedWorkspaces.length} 个）。把它加进「生效范围」即可。`
                  : '当前不会附加任何内容：字段都是空的，或者宿主还没读到设置。',
          ),
      (previewData?.sections ?? []).length === 0
        ? null
        : h(
            'div',
            { className: 'mydsh-inline', style: { flexWrap: 'wrap' } },
            previewData.sections.map((section) =>
              h(Badge, { key: section.key, tone: 'ok' }, `${section.title} · ${tokens(section.tokens, activeLocale())}`),
            ),
          ),
      previewActive
        ? h(
            'pre',
            {
              className: 'mydsh-mono',
              style: {
                margin: 0,
                maxHeight: 260,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                padding: '8px 10px',
                borderRadius: 8,
                background: 'var(--dsw-alias-bg-layer-2)',
                border: '1px solid var(--dsw-alias-border-l1)',
              },
            },
            previewData?.text ?? '',
          )
        : null,
      preview.loading ? h('div', { className: 'mydsh-muted' }, t().loading) : null,
    ),

    previewOpen
      ? h(
          Modal,
          {
            title: '最终注入文本',
            onClose: () => setPreviewOpen(false),
            footer: [h(Button, { key: 'close', variant: 'primary', onClick: () => setPreviewOpen(false) }, t().close)],
          },
          h(
            'div',
            { className: 'mydsh-inline' },
            h(Badge, { tone: previewActive ? 'ok' : 'warn' }, previewActive ? '会附加' : '不会附加'),
            h('span', { className: 'mydsh-muted' }, `${exact(previewData?.tokens)} tokens · 目录 ${previewCwd === '' ? '（全局）' : previewCwd}`),
          ),
          h(
            'pre',
            { className: 'mydsh-mono', style: { margin: 0, whiteSpace: 'pre-wrap', padding: '10px 12px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)' } },
            previewActive ? (previewData?.text ?? '') : '当前没有任何内容会被注入。',
          ),
        )
      : null,
  )
}

    // ===== 46-tab-modules.js =====
/**
 * Capability modules tab.
 *
 * One plugin, many capabilities: this page is the only place where every module
 * this build ships is visible at once, each one switchable on its own, with the
 * cost of switching it on stated next to it. Three rules shape the layout:
 *
 * - State comes from the Host (`/modules/overview`), never from a local table of
 *   assumptions, so "not supported on this machine" is reported rather than
 *   guessed. `enabled` and `available` stay separate: "on but unusable" and
 *   "usable but off" need different advice.
 * - A high-risk module asks for confirmation the first time it is switched on.
 *   When a preset turns several on at once the dialog drains them one at a time,
 *   so a bulk action cannot quietly widen local permissions.
 * - Every switch writes through `patch`, which applies optimistically and
 *   persists the accepted document. This file keeps no copy of the settings.
 */

/** One line about what a module actually does, for its summary card. */
const MODULE_BLURB = {
  recentMetrics: '输入区状态栏显示首字时间、速度与本会话消耗，点击展开最近请求',
  contextInsight: '标题栏与会话标签的上下文占用、构成与变化趋势',
  balance: '查询 DeepSeek 与自定义供应商的余额和配额',
  tokenAggregate: '把本机会话日志聚合成按日、模型、工作区的用量看板',
  memory: '长期记忆：保存确认过的信息，并在后续会话按作用域注入',
  discipline: '行为纪律：纠偏、防作弊与验收提示，源自 PUA 的思路',
  desktop: 'Windows 桌面自动化：读屏、截图、键鼠与窗口操作',
  mcpConnector: '接入外部 MCP 服务器，把它们提供的工具交给模型',
  configManager: '在设置页里启停插件、查看与编辑各插件的配置',
  skills: '列出本机可用技能及其来源，可在侧栏保留常驻入口',
  roles: '角色专家库：内置与自定义专家，可按需注入到会话',
  imageGen: '用 OpenAI 兼容接口生成图片，保存到本机目录',
  teams: '读取 DSH 内置编队数据（成员、任务、消息），只读展示',
  browserView: '接管真实浏览器并实时投屏（本版本未实现）',
}

/** The concrete cost of a high-risk switch, shown in the confirmation dialog. */
const MODULE_RISK_NOTE = {
  desktop: '放宽本机权限：可以截取屏幕内容、模拟键盘与鼠标、切换窗口焦点。',
  mcpConnector: '放宽工具面：外部 MCP 服务器提供的工具会对模型可见并可被调用。',
  browserView: '放宽工具面：会接入真实浏览器并读取其页面内容（本版本未实现）。',
}

/**
 * The three one-click presets.
 *
 * A preset only ever turns modules ON; it never switches anything off, because a
 * bulk action that silently disables a capability the user chose earlier is the
 * kind of surprise that makes a settings page untrustworthy. `keys: null` means
 * "every module the Host reports".
 */
const MODULE_PRESETS = [
  {
    id: 'light',
    label: '轻量',
    sub: '只开用量类，零额外权限',
    keys: ['recentMetrics', 'contextInsight', 'balance', 'tokenAggregate'],
  },
  {
    id: 'daily',
    label: '日常',
    sub: '用量 + 个性化（记忆/纪律）+ 技能与配置管理',
    keys: [
      'recentMetrics',
      'contextInsight',
      'balance',
      'tokenAggregate',
      'memory',
      'discipline',
      'skills',
      'configManager',
      'teams',
    ],
  },
  {
    id: 'full',
    label: '全量',
    sub: '全部打开，高风险仍逐个确认',
    keys: null,
  },
]

/** Risk chip for one module row. */
function ModuleRisk({ risk }) {
  if (risk === 'high') return h(Badge, { tone: 'error' }, t().riskHigh)
  if (risk === 'medium') return h(Badge, { tone: 'warn' }, t().riskMid)
  return h(Badge, null, t().riskLow)
}

/**
 * One module summary card: label, one-line purpose, risk, status and switch.
 * An unavailable module keeps its switch visible but disabled, and explains why
 * underneath — the row is the answer to "why can I not turn this on".
 */
function ModuleCard({ row, onToggle }) {
  const available = row.available !== false
  return h(
    'section',
    { className: 'mydsh-card' },
    h(
      'header',
      { className: 'mydsh-card-head' },
      h(
        'div',
        { style: { minWidth: 0 } },
        h(
          'div',
          { className: 'mydsh-card-title' },
          h('span', { className: 'mydsh-truncate' }, row.label),
          h(ModuleRisk, { risk: row.risk }),
        ),
        h('div', { className: 'mydsh-card-sub' }, MODULE_BLURB[row.key] ?? ''),
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(
          Badge,
          { tone: available === false ? 'warn' : row.enabled === true ? 'ok' : undefined },
          available === false ? t().unavailable : row.enabled === true ? t().enabled : t().disabled,
        ),
        h(Switch, {
          checked: row.enabled === true,
          onChange: (next) => onToggle(row, next),
          label: row.label,
          disabled: available !== true,
        }),
      ),
    ),
    available === false
      ? h(Note, { tone: 'warn' }, row.reason === '' || row.reason === undefined ? '当前环境不支持该能力。' : row.reason)
      : null,
    (row.dependsOn ?? []).length === 0
      ? null
      : h('div', { className: 'mydsh-muted' }, `依赖服务：${(row.dependsOn ?? []).join('、')}`),
  )
}

/** A collapsible card holding one module's detailed settings. */
function ModuleSection({ title, sub, row, open, onToggle, children }) {
  return h(
    'section',
    { className: 'mydsh-card' },
    h(
      'header',
      { className: 'mydsh-card-head', onClick: onToggle, style: { cursor: 'pointer' } },
      h(
        'div',
        { style: { minWidth: 0 } },
        h(
          'div',
          { className: 'mydsh-card-title' },
          h('span', { className: 'mydsh-muted' }, open ? '▾' : '▸'),
          h('span', null, title),
          row === undefined ? null : h(ModuleRisk, { risk: row.risk }),
          row === undefined
            ? null
            : h(
                Badge,
                { tone: row.available === false ? 'warn' : row.enabled === true ? 'ok' : undefined },
                row.available === false ? t().unavailable : row.enabled === true ? t().enabled : t().disabled,
              ),
        ),
        h('div', { className: 'mydsh-card-sub' }, sub),
      ),
      h(
        Button,
        {
          variant: 'ghost',
          size: 'sm',
          onClick: (event) => {
            event.stopPropagation()
            onToggle()
          },
        },
        open ? '收起' : '展开',
      ),
    ),
    open ? children : null,
  )
}

/**
 * The high-risk confirmation dialog.
 *
 * `queue` holds every module still waiting for a confirmation, so a preset that
 * enables three high-risk modules asks three times rather than once. Confirming
 * acknowledges one module and advances the queue; cancelling drops the rest.
 */
function ModuleConfirm({ queue, onConfirm, onCancel }) {
  const head = queue[0]
  if (head === undefined) return null
  const remaining = queue.length - 1
  return h(
    Modal,
    {
      title: '启用高风险能力',
      onClose: onCancel,
      footer: [
        h(Button, { key: 'cancel', onClick: onCancel }, t().cancel),
        h(
          Button,
          { key: 'ok', variant: 'primary', onClick: onConfirm },
          remaining > 0 ? `确认启用（还有 ${remaining} 项待确认）` : '确认启用',
        ),
      ],
    },
    h(Note, { tone: 'error' }, t().riskHighConfirm),
    h(
      'div',
      { className: 'mydsh-inline' },
      h(Badge, { tone: 'error' }, t().riskHigh),
      h('strong', null, head.label),
    ),
    h('div', { className: 'mydsh-muted' }, MODULE_RISK_NOTE[head.key] ?? '会放宽本机权限。'),
    h(
      'div',
      { className: 'mydsh-muted' },
      '确认后该能力立即生效；随时可以在本页关闭，关闭后不注册任何组件、也不产生轮询。',
    ),
  )
}

/** Desktop automation: four separate capability gates plus a read-only probe. */
function ModuleDesktop({ slice, row, setModule }) {
  const [state, setState] = useState(undefined)
  const [stateError, setStateError] = useState(undefined)
  const [capture, captureState] = useAction()

  const loadState = useCallback(() => {
    setStateError(undefined)
    api('/desktop/state')
      .then((value) => setState(value))
      .catch((failure) => setStateError(failure?.message ?? String(failure)))
  }, [])

  useEffect(() => {
    loadState()
  }, [loadState])

  const capabilities = state?.capabilities ?? {}
  const screen = state?.screenSize
  const shot = captureState.result
  const unsupported = row !== undefined && row.available === false

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    unsupported
      ? h(Note, { tone: 'warn' }, `本机不可用：${row.reason === '' || row.reason === undefined ? '只支持 Windows' : row.reason}`)
      : h(Note, null, '四项能力分开放行。读屏是截图与屏幕尺寸的前提；键鼠默认关闭，改动前请确认你确实需要模型操作本机。'),
    h(SwitchRow, {
      title: '允许读屏',
      hint: '截图与读取屏幕尺寸；关闭后测试按钮会直接拒绝',
      checked: slice.allowScreen === true,
      onChange: (value) => setModule('desktop', { allowScreen: value }),
    }),
    h(SwitchRow, {
      title: '允许键盘输入',
      hint: '模拟按键与文本输入，可把内容敲进任何获得焦点的窗口',
      checked: slice.allowKeyboard === true,
      onChange: (value) => setModule('desktop', { allowKeyboard: value }),
    }),
    h(SwitchRow, {
      title: '允许鼠标操作',
      hint: '移动、点击、滚轮；与键盘一起构成完整的本机操作面',
      checked: slice.allowMouse === true,
      onChange: (value) => setModule('desktop', { allowMouse: value }),
    }),
    h(SwitchRow, {
      title: '每次动作都二次确认',
      hint: '建议保持开启：每次改动本机状态前宿主都会要求确认',
      checked: slice.confirmEach === true,
      onChange: (value) => setModule('desktop', { confirmEach: value }),
    }),
    h(
      Row,
      { title: '本机能力与屏幕', hint: stateError === undefined ? '由宿主实测，不是静态声明' : stateError, stack: true },
      h(
        'div',
        { className: 'mydsh-inline', style: { flexWrap: 'wrap' } },
        h(Badge, { tone: capabilities.capture === true ? 'ok' : undefined }, `截图 ${capabilities.capture === true ? '可用' : '不可用'}`),
        h(Badge, { tone: capabilities.keyboard === true ? 'ok' : undefined }, `键盘 ${capabilities.keyboard === true ? '可用' : '不可用'}`),
        h(Badge, { tone: capabilities.mouse === true ? 'ok' : undefined }, `鼠标 ${capabilities.mouse === true ? '可用' : '不可用'}`),
        h(Badge, { tone: capabilities.windows === true ? 'ok' : undefined }, `窗口 ${capabilities.windows === true ? '可用' : '不可用'}`),
        h('span', { className: 'mydsh-muted' }, screen === null || screen === undefined ? '屏幕尺寸未读取到' : `屏幕 ${screen.width}×${screen.height}`),
        h(Button, { size: 'sm', onClick: loadState }, '重新读取'),
        h(
          Button,
          {
            size: 'sm',
            variant: 'primary',
            disabled: captureState.pending === true || slice.allowScreen !== true,
            onClick: () => capture('/desktop/capture', {}),
          },
          captureState.pending === true ? '截屏中…' : '测试截屏',
        ),
      ),
    ),
    state?.reason === undefined || state.reason === '' ? null : h(Note, { tone: 'warn' }, state.reason),
    shot === undefined
      ? null
      : shot.ok === false
        ? h(Note, { tone: 'error' }, shot.message ?? '截屏失败')
        : h(
            Note,
            { tone: 'ok' },
            `已截屏：${shot.width ?? '?'}×${shot.height ?? '?'}，保存到 ${shot.path ?? '（未返回路径）'}`,
          ),
  )
}

/**
 * One MCP server row.
 *
 * The fields are edited on a local draft and written on 保存, so a half-typed
 * command never reaches the Host and a 32-server document is not rewritten on
 * every keystroke. The switch, however, writes immediately: enabling a server is
 * a single decision, not a text edit.
 */
function McpServerRow({ server, statusRow, onSave, onRemove, onTest, pending }) {
  const [draft, setDraft] = useState(() => ({
    ...server,
    argsText: Array.isArray(server.args) ? server.args.join('\n') : '',
  }))
  const [testResult, setTestResult] = useState(undefined)

  const set = (partial) => setDraft((value) => ({ ...value, ...partial }))
  const transport = draft.transport === 'streamable-http' ? 'streamable-http' : 'stdio'

  /**
   * The row as the Host should store it.
   *
   * Built from the draft rather than from `server`, so flipping the switch does
   * not silently discard text the user already typed on an unsaved row.
   */
  const payload = (overrides) => {
    const source = { ...draft, ...overrides }
    const mode = source.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
    return {
      id: source.id,
      name: String(source.name ?? '').trim(),
      label: String(source.label ?? '').trim(),
      enabled: source.enabled === true,
      transport: mode,
      command: mode === 'stdio' ? String(source.command ?? '').trim() : '',
      args: String(source.argsText ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== ''),
      url: mode === 'streamable-http' ? String(source.url ?? '').trim() : '',
      cwd: String(source.cwd ?? '').trim(),
      env: String(source.env ?? ''),
      headers: String(source.headers ?? ''),
      toolPrefix: String(source.toolPrefix ?? '').trim(),
    }
  }

  const save = () => onSave(payload({}))

  const runTest = () => {
    onTest(payload({}))
      .then((value) => setTestResult(value))
      .catch(() => undefined)
  }

  const status = statusRow?.status ?? 'unknown'

  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
    },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        { className: 'mydsh-inline', style: { minWidth: 0 } },
        h('span', { className: 'mydsh-dot', 'data-tone': status === 'connected' ? 'ok' : status === 'failed' ? 'error' : undefined }),
        h('strong', { className: 'mydsh-truncate' }, draft.label === '' ? draft.name || '(未命名)' : draft.label),
        h(Badge, null, transport === 'stdio' ? 'stdio' : 'http'),
        statusRow === undefined
          ? null
          : h(Badge, { tone: status === 'connected' ? 'ok' : status === 'failed' ? 'error' : undefined }, statusRow.status),
        statusRow === undefined ? null : h('span', { className: 'mydsh-muted' }, `${exact(statusRow.toolCount)} 个工具`),
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Switch, {
          checked: draft.enabled === true,
          onChange: (value) => {
            set({ enabled: value })
            onSave(payload({ enabled: value }))
          },
          label: '启用该服务器',
        }),
        h(Button, { size: 'sm', onClick: save }, t().save),
        h(Button, { size: 'sm', onClick: runTest, disabled: pending === true }, pending === true ? '测试中…' : '测试'),
        h(Button, { size: 'sm', variant: 'danger', onClick: () => onRemove(server.id) }, t().remove),
      ),
    ),
    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '2' },
      h(Row, { title: '标识 id', hint: '行内唯一，删改不影响其他行' }, h(TextField, {
        value: draft.id,
        onChange: (value) => set({ id: value }),
        width: 'md',
        mono: true,
      })),
      h(Row, { title: '注册名 name', hint: '工具前缀与状态都按这个名字对应' }, h(TextField, {
        value: draft.name,
        onChange: (value) => set({ name: value }),
        width: 'md',
        mono: true,
      })),
      h(Row, { title: '显示名 label' }, h(TextField, {
        value: draft.label,
        onChange: (value) => set({ label: value }),
        width: 'md',
      })),
      h(
        Row,
        { title: '传输方式', hint: '填了命令走 stdio，填了地址走 http' },
        h(Segmented, {
          value: transport,
          onChange: (value) => set({ transport: value }),
          options: [
            { value: 'stdio', label: 'stdio' },
            { value: 'streamable-http', label: 'http' },
          ],
        }),
      ),
    ),
    transport === 'stdio'
      ? h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h(Row, { title: '命令', hint: '可执行文件名或绝对路径' }, h(TextField, {
            value: draft.command,
            onChange: (value) => set({ command: value }),
            width: 'lg',
            mono: true,
          })),
          h(Row, { title: '参数', hint: '一行一个，空行忽略' }, h(TextField, {
            value: draft.argsText,
            onChange: (value) => set({ argsText: value }),
            width: 'xl',
            mono: true,
            placeholder: '--root\\nD:\\\\data',
          })),
          h(Row, { title: '工作目录', hint: '可选，留空用宿主当前目录' }, h(TextField, {
            value: draft.cwd,
            onChange: (value) => set({ cwd: value }),
            width: 'xl',
            mono: true,
          })),
          h(Row, { title: '环境变量', hint: 'KEY=VALUE 一行一个，或直接粘 JSON 对象', stack: true },
            h(TextArea, {
              value: draft.env,
              onChange: (value) => set({ env: value }),
              rows: 3,
              placeholder: 'API_KEY=sk-…',
            }),
          ),
        )
      : h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h(Row, { title: '服务地址', hint: 'streamable-http 的完整 URL' }, h(TextField, {
            value: draft.url,
            onChange: (value) => set({ url: value }),
            width: 'xl',
            mono: true,
            placeholder: 'https://example.com/mcp',
          })),
          h(Row, { title: '请求头', hint: 'Name: value 一行一个，或直接粘 JSON 对象', stack: true },
            h(TextArea, {
              value: draft.headers,
              onChange: (value) => set({ headers: value }),
              rows: 3,
              placeholder: 'Authorization: Bearer …',
            }),
          ),
        ),
    h(Row, { title: '工具名前缀', hint: '可选，避免与其他服务器重名' }, h(TextField, {
      value: draft.toolPrefix,
      onChange: (value) => set({ toolPrefix: value }),
      width: 'md',
      mono: true,
    })),
    statusRow?.lastError === undefined || statusRow.lastError === ''
      ? null
      : h(Note, { tone: 'error' }, statusRow.lastError),
    testResult === undefined
      ? null
      : testResult.ok === false
        ? h(Note, { tone: 'error' }, testResult.message ?? '测试失败')
        : h(
            Note,
            { tone: 'ok' },
            `连接成功：${(testResult.toolNames ?? []).length} 个工具` +
              `${(testResult.toolNames ?? []).length === 0 ? '' : `（${testResult.toolNames.slice(0, 8).join('、')}）`}` +
              `${testResult.durationMs === undefined ? '' : ` · ${testResult.durationMs} ms`}`,
          ),
  )
}

/** MCP connector: server list, apply, and the live per-server state. */
function ModuleMcp({ slice, row, setModule }) {
  const state = usePoll('/mcp/state', 15000, [])
  const [apply, applyState] = useAction()
  const [test, testState] = useAction()
  const [notice, setNotice] = useState(undefined)

  const servers = Array.isArray(slice.servers) ? slice.servers : []
  const liveRows = state.data?.servers ?? []

  const write = (rows) => setModule('mcpConnector', { servers: rows })

  const saveRow = (next) => {
    if (next.id === undefined || next.id === '') return
    write(servers.map((entry) => (entry.id === next.id ? next : entry)))
    setNotice({ tone: 'ok', message: '已保存，点「应用」后生效' })
  }

  const addRow = () => {
    write([
      ...servers,
      {
        id: newId('mcp'),
        name: `server-${servers.length + 1}`,
        label: '',
        enabled: false,
        transport: 'stdio',
        command: '',
        args: [],
        url: '',
        cwd: '',
        env: '',
        headers: '',
        toolPrefix: '',
      },
    ])
    setNotice(undefined)
  }

  const removeRow = (id) => {
    write(servers.filter((entry) => entry.id !== id))
    setNotice({ tone: 'ok', message: '已删除，点「应用」后生效' })
  }

  /**
   * Apply the settings to the Host.
   *
   * The route answers `{ servers }` (the live rows after re-registration), so the
   * count comes from those rows rather than from a status field this build may
   * not send.
   */
  const runApply = () => {
    apply('/mcp/apply', {})
      .then((value) => {
        if (value === undefined) return
        const live = Array.isArray(value.servers) ? value.servers : []
        const connected = live.filter((entry) => entry.status === 'connected').length
        const failed = live.filter((entry) => entry.status === 'failed')
        setNotice(
          failed.length === 0
            ? { tone: 'ok', message: `已应用：${connected} / ${live.length} 个服务器已连接` }
            : {
                tone: 'error',
                message: `${failed.length} 个服务器连接失败：${failed.map((entry) => `${entry.label === '' ? entry.name : entry.label}（${entry.lastError}）`).join('、')}`,
              },
        )
        state.reload()
      })
      .catch(() => undefined)
  }

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    row !== undefined && row.available === false
      ? h(Note, { tone: 'warn' }, `本机不可用：${row.reason === '' || row.reason === undefined ? '缺少 mcpManager 服务' : row.reason}`)
      : h(Note, null, '启用一个服务器只是把它写进设置；改动后需要点「应用」才会注册到宿主。禁用的服务器不会被注册。'),
    h(SwitchRow, {
      title: '随宿主启动自动应用',
      hint: '宿主启动后按设置里的启用列表注册一次',
      checked: slice.autoStart === true,
      onChange: (value) => setModule('mcpConnector', { autoStart: value }),
    }),
    h(SwitchRow, {
      title: '每会话独立工具集',
      hint: '按会话注册服务器，断开后回收；关闭则为全局可用',
      checked: slice.perSessionTools === true,
      onChange: (value) => setModule('mcpConnector', { perSessionTools: value }),
    }),
    h(
      Row,
      { title: '服务器', hint: `${servers.length} 条配置，${liveRows.filter((entry) => entry.status === 'connected').length} 个已连接` },
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Button, { size: 'sm', onClick: addRow }, `＋ ${t().add}`),
        h(Button, { size: 'sm', variant: 'primary', onClick: runApply, disabled: applyState.pending === true },
          applyState.pending === true ? '应用中…' : '应用'),
        h(Button, { size: 'sm', variant: 'ghost', onClick: () => state.reload() }, `⟳ ${t().refresh}`),
      ),
    ),
    notice === undefined ? null : h(Note, { tone: notice.tone }, notice.message),
    applyState.error === undefined ? null : h(Note, { tone: 'error' }, applyState.error),
    state.error === undefined ? null : h(Note, { tone: 'error' }, state.error),
    servers.length === 0
      ? h(Empty, null, '还没有配置 MCP 服务器')
      : h(
          'div',
          { className: 'mydsh-list' },
          servers.map((entry) =>
            h(McpServerRow, {
              key: entry.id === undefined || entry.id === '' ? entry.name : entry.id,
              server: entry,
              statusRow: liveRows.find((live) => live.name === entry.name),
              onSave: saveRow,
              onRemove: removeRow,
              onTest: (draft) => test('/mcp/test', { server: draft }),
              pending: testState.pending,
            }),
          ),
        ),
    liveRows.length === 0
      ? null
      : h(
          'table',
          { className: 'mydsh-table' },
          h('thead', null,
            h('tr', null,
              h('th', null, '服务器'),
              h('th', null, '传输'),
              h('th', null, '状态'),
              h('th', { 'data-num': 'true' }, '工具数'),
              h('th', null, '错误'),
            ),
          ),
          h('tbody', null,
            liveRows.map((entry) =>
              h('tr', { key: entry.name },
                h('td', null, entry.label === '' ? entry.name : entry.label),
                h('td', { className: 'mydsh-muted' }, entry.transport),
                h('td', null, h(Badge, { tone: entry.status === 'connected' ? 'ok' : entry.status === 'failed' ? 'error' : undefined }, entry.status)),
                h('td', { 'data-num': 'true' }, exact(entry.toolCount)),
                h('td', { className: 'mydsh-muted mydsh-truncate', title: entry.lastError }, entry.lastError ?? ''),
              ),
            ),
          ),
        ),
  )
}

/**
 * Image generation over an OpenAI-compatible endpoint.
 *
 * Free-text fields are edited on a draft and written with 保存: the settings
 * document is persisted through a POST, so writing on every keystroke would send
 * one request per character. Single-click controls (provider, size, count) write
 * immediately because they are one decision, not a text edit.
 */
function ModuleImageGen({ slice, setModule }) {
  const [generate, generateState] = useAction()
  const [keyDraft, setKeyDraft] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [draft, setDraft] = useState(() => ({
    baseUrl: slice.baseUrl ?? '',
    model: slice.model ?? '',
    saveDir: slice.saveDir ?? '',
  }))
  const [saved, setSaved] = useState(false)

  const set = (partial) => {
    setDraft((value) => ({ ...value, ...partial }))
    setSaved(false)
  }
  const commit = () => {
    setModule('imageGen', {
      baseUrl: String(draft.baseUrl ?? '').trim(),
      model: String(draft.model ?? '').trim(),
      saveDir: String(draft.saveDir ?? '').trim(),
    })
    setSaved(true)
  }

  const images = Array.isArray(generateState.result?.images) ? generateState.result.images : []
  const failure = generateState.result !== undefined && generateState.result.ok === false ? generateState.result.message : undefined
  const hasKey = slice.apiKey !== undefined && slice.apiKey !== ''
  const hasEndpoint = String(slice.baseUrl ?? '') !== ''

  const saveKey = () => {
    setModule('imageGen', { apiKey: keyDraft.trim() })
    setKeyDraft('')
    setKeySaved(true)
  }

  const runTest = () => {
    // Commit the endpoint first: the Host reads it from the settings document, so
    // a test against an unsaved draft would probe the previous address.
    commit()
    generate('/images/generate', {
      prompt: '一只橘猫坐在窗台上看雨，扁平插画风格，纯色背景',
      count: 1,
      size: slice.size ?? '1024x1024',
    })
  }

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    !hasEndpoint
      ? h(Note, { tone: 'warn' }, '还没有配置 Base URL，先填写接口地址并保存，才能测试生成。')
      : !hasKey
        ? h(Note, { tone: 'warn' }, '还没有配置 API Key。若你的接口不需要鉴权可以留空，否则请先填入。')
        : h(Note, null, `接口就绪：${slice.baseUrl} · 默认 ${slice.size ?? '1024x1024'}`),
    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '2' },
      h(
        Row,
        { title: '接口类型' },
        h(Select, {
          value: slice.provider ?? 'openai-compatible',
          onChange: (value) => setModule('imageGen', { provider: value }),
          options: [
            { value: 'openai-compatible', label: 'OpenAI 兼容' },
            { value: 'custom', label: '自定义' },
            { value: 'deepseek', label: 'DeepSeek（暂不支持）' },
          ],
        }),
      ),
      h(
        Row,
        { title: '尺寸' },
        h(Select, {
          value: slice.size ?? '1024x1024',
          onChange: (value) => setModule('imageGen', { size: value }),
          options: ['256x256', '512x512', '768x768', '1024x1024', '1024x1536', '1536x1024', '1792x1024', '1024x1792', 'auto'].map(
            (value) => ({ value, label: value }),
          ),
        }),
      ),
      h(
        Row,
        { title: '张数', hint: '单次最多 4 张' },
        h(Select, {
          value: String(slice.count ?? 1),
          onChange: (value) => setModule('imageGen', { count: Number(value) }),
          options: ['1', '2', '3', '4'].map((value) => ({ value, label: value })),
        }),
      ),
    ),
    h(Row, { title: 'Base URL', hint: '会拼成 /images/generations' }, h(TextField, {
      value: draft.baseUrl,
      onChange: (value) => set({ baseUrl: value }),
      width: 'xl',
      mono: true,
      placeholder: 'https://api.openai.com/v1',
      onEnter: commit,
    })),
    h(Row, { title: '模型', hint: '留空则用接口默认值' }, h(TextField, {
      value: draft.model,
      onChange: (value) => set({ model: value }),
      width: 'lg',
      mono: true,
      placeholder: 'gpt-image-1',
      onEnter: commit,
    })),
    h(Row, { title: '保存目录', hint: '留空则存到 DSH 数据目录下的 images' }, h(TextField, {
      value: draft.saveDir,
      onChange: (value) => set({ saveDir: value }),
      width: 'xl',
      mono: true,
      placeholder: 'C:\\Data\\images',
      onEnter: commit,
    })),
    h(
      Row,
      { title: '接口设置', hint: saved ? '已保存' : '改完点这里写入设置' },
      h(Button, { size: 'sm', onClick: commit }, t().save),
    ),
    h(
      Row,
      { title: 'API Key', hint: hasKey ? '已配置，重填会覆盖' : '只保存在本机设置文件里', stack: true },
      h(
        'div',
        { className: 'mydsh-inline' },
        h(TextField, {
          value: keyDraft,
          onChange: (value) => {
            setKeyDraft(value)
            setKeySaved(false)
          },
          width: 'xl',
          mono: true,
          type: 'password',
          placeholder: hasKey ? '已配置（留空保持不变）' : 'sk-…',
        }),
        h(Button, { size: 'sm', onClick: saveKey, disabled: keyDraft.trim() === '' }, '保存密钥'),
        keySaved ? h('span', { className: 'mydsh-muted' }, '已保存') : null,
      ),
    ),
    h(
      Row,
      { title: '测试生成', hint: '用一个固定短句跑一次，只验证链路' },
      h(Button, {
        variant: 'primary',
        size: 'sm',
        disabled: generateState.pending === true,
        onClick: runTest,
      }, generateState.pending === true ? '生成中…' : '测试生成'),
    ),
    generateState.error === undefined ? null : h(Note, { tone: 'error' }, generateState.error),
    failure === undefined ? null : h(Note, { tone: 'error' }, failure),
    images.length === 0
      ? null
      : h(
          Note,
          { tone: 'ok' },
          `已生成 ${images.length} 张：${images.map((entry) => entry.path ?? entry.url ?? '（无路径）').join('、')}`,
        ),
  )
}

/** One custom role row: name, department, summary and the injected prompt. */
function RoleRow({ role, onSave, onRemove }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(() => ({ ...role }))
  const set = (partial) => setDraft((value) => ({ ...value, ...partial }))

  const save = () => {
    onSave({
      id: draft.id,
      name: String(draft.name ?? '').trim(),
      department: String(draft.department ?? '').trim() || '通用',
      summary: String(draft.summary ?? '').trim(),
      prompt: String(draft.prompt ?? ''),
      enabled: draft.enabled === true,
    })
    setOpen(false)
  }

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        { className: 'mydsh-inline', style: { minWidth: 0 } },
        h(Badge, null, draft.department === '' ? '通用' : draft.department),
        h('strong', { className: 'mydsh-truncate' }, draft.name === '' ? '(未命名)' : draft.name),
        draft.enabled === true ? null : h(Badge, { tone: 'warn' }, t().disabled),
        draft.summary === '' ? null : h('span', { className: 'mydsh-muted mydsh-truncate', title: draft.summary }, draft.summary),
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Switch, {
          checked: draft.enabled === true,
          onChange: (value) => {
            set({ enabled: value })
            onSave({ ...role, enabled: value })
          },
          label: '启用该专家',
        }),
        h(Button, { size: 'sm', onClick: () => setOpen((value) => !value) }, open ? '收起' : t().edit),
        h(Button, { size: 'sm', variant: 'danger', onClick: () => onRemove(role.id) }, t().remove),
      ),
    ),
    open
      ? h(
          'div',
          { className: 'mydsh-list' },
          h(
            'div',
            { className: 'mydsh-grid', 'data-cols': '2' },
            h(Row, { title: '名称' }, h(TextField, { value: draft.name, onChange: (value) => set({ name: value }), width: 'md' })),
            h(Row, { title: '部门', hint: '用于分组，可自定' }, h(TextField, { value: draft.department, onChange: (value) => set({ department: value }), width: 'md' })),
          ),
          h(Row, { title: '一句话简介' }, h(TextField, { value: draft.summary, onChange: (value) => set({ summary: value }), width: 'xl' })),
          h(Row, { title: '提示词', hint: '注入到会话的角色说明', stack: true },
            h(TextArea, { value: draft.prompt, onChange: (value) => set({ prompt: value }), rows: 5 }),
          ),
          h(
            'div',
            { className: 'mydsh-inline', style: { justifyContent: 'flex-end' } },
            h(Button, { size: 'sm', onClick: () => setDraft({ ...role }) }, t().reset),
            h(Button, { size: 'sm', variant: 'primary', onClick: save }, t().save),
          ),
        )
      : null,
  )
}

/** Role expert library: custom role editing plus the read-only catalogue. */
function ModuleRoles({ slice, setModule }) {
  const [query, setQuery] = useState('')
  const catalogue = usePoll('/roles/list', 30000, [])

  const customRoles = Array.isArray(slice.customRoles) ? slice.customRoles : []
  const write = (rows) => setModule('roles', { customRoles: rows })

  const saveRole = (next) => {
    if (next.id === undefined || next.id === '') return
    write(customRoles.map((entry) => (entry.id === next.id ? next : entry)))
  }
  const addRole = () => {
    write([
      ...customRoles,
      { id: newId('role'), name: '新专家', department: '通用', summary: '', prompt: '', enabled: true },
    ])
  }
  const removeRole = (id) => write(customRoles.filter((entry) => entry.id !== id))

  const roles = Array.isArray(catalogue.data?.roles) ? catalogue.data.roles : []
  const keyword = query.trim().toLowerCase()
  const filtered = keyword === ''
    ? roles
    : roles.filter((entry) =>
        [entry.name, entry.department, entry.summary].some((field) => String(field ?? '').toLowerCase().includes(keyword)),
      )
  const groups = useMemo(() => {
    const map = new Map()
    for (const entry of filtered) {
      const key = String(entry.department ?? '通用')
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(entry)
    }
    return [...map.entries()]
  }, [filtered])

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h(Note, null, '内置专家随插件提供，只读；自定义专家会写进设置，可在下方编辑提示词。'),
    h(SwitchRow, {
      title: '把专家目录注入会话',
      hint: '开启后模型能看到专家清单，可主动点名调用',
      checked: slice.injectCatalog === true,
      onChange: (value) => setModule('roles', { injectCatalog: value }),
    }),
    h(
      Row,
      { title: '自定义专家', hint: `${customRoles.length} 位` },
      h(Button, { size: 'sm', onClick: addRole }, `＋ ${t().add}`),
    ),
    customRoles.length === 0
      ? h(Empty, null, '还没有自定义专家')
      : h(
          'div',
          { className: 'mydsh-list' },
          customRoles.map((entry) =>
            h(RoleRow, { key: entry.id, role: entry, onSave: saveRole, onRemove: removeRole }),
          ),
        ),
    h(
      Row,
      { title: '专家目录', hint: `${filtered.length} / ${roles.length} 位`, stack: true },
      h(TextField, {
        value: query,
        onChange: setQuery,
        width: 'xl',
        placeholder: '按名称、部门或简介搜索',
      }),
    ),
    catalogue.error === undefined ? null : h(Note, { tone: 'error' }, catalogue.error),
    catalogue.data?.reason === undefined ? null : h(Note, { tone: 'warn' }, catalogue.data.reason),
    groups.length === 0
      ? h(Empty, null, catalogue.loading === true ? t().loading : '没有匹配的专家')
      : h(
          'div',
          { className: 'mydsh-list' },
          groups.map(([department, rows]) =>
            h(
              'div',
              { key: department, className: 'mydsh-list' },
              h('div', { className: 'mydsh-muted' }, `${department} · ${rows.length}`),
              rows.map((entry) =>
                h(
                  'div',
                  { key: entry.id, className: 'mydsh-inline', style: { justifyContent: 'space-between', padding: '3px 0' } },
                  h(
                    'div',
                    { className: 'mydsh-inline', style: { minWidth: 0 } },
                    h('span', { className: 'mydsh-truncate' }, entry.name),
                    h(Badge, { tone: entry.custom === true ? 'warn' : undefined }, entry.custom === true ? '自定义' : '内置'),
                  ),
                  h('span', { className: 'mydsh-muted mydsh-truncate', title: entry.summary, style: { maxWidth: '52%' } }, entry.summary ?? ''),
                ),
              ),
            ),
          ),
        ),
  )
}

/**
 * The configuration editor dialog: current values as JSON, secrets masked.
 *
 * The Host answers `***` for a field that looks like a credential and keeps the
 * stored value when the same sentinel comes back, so leaving a masked field
 * untouched is a no-op rather than a wipe. The write route wraps its module
 * result one level deep (`{ entry: { ok, message } }`), which is unwrapped here.
 */
function ModuleConfigEditModal({ id, title, onClose, onSaved }) {
  const [value, setValue] = useState(undefined)
  const [text, setText] = useState('')
  const [error, setError] = useState(undefined)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState(undefined)

  useEffect(() => {
    let alive = true
    api(`/config/values?id=${encodeURIComponent(id)}`)
      .then((result) => {
        if (!alive) return
        if (result?.ok === false) {
          setError(result.message ?? '读取配置失败')
          return
        }
        setValue(result?.value ?? {})
        setText(JSON.stringify(result?.value ?? {}, null, 2))
      })
      .catch((failure) => {
        if (alive) setError(failure?.message ?? String(failure))
      })
    return () => {
      alive = false
    }
  }, [id])

  const save = () => {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (failure) {
      setError(`不是合法的 JSON：${failure?.message ?? failure}`)
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError('顶层必须是一个 JSON 对象')
      return
    }
    setError(undefined)
    setSaving(true)
    api('/config/edit', { body: { id, patch: parsed } })
      .then((response) => {
        const result = response?.entry ?? {}
        if (result.ok === false) {
          setError(result.message ?? '写入失败')
          return
        }
        setNotice(result.message === '' || result.message === undefined ? '已写入' : result.message)
        if (typeof onSaved === 'function') onSaved()
      })
      .catch((failure) => setError(failure?.message ?? String(failure)))
      .finally(() => setSaving(false))
  }

  return h(
    Modal,
    {
      title: `编辑配置 · ${title}`,
      onClose,
      footer: [
        h(Button, { key: 'cancel', onClick: onClose }, t().close),
        h(Button, { key: 'save', variant: 'primary', onClick: save, disabled: saving || value === undefined }, saving ? '写入中…' : t().save),
      ],
    },
    h(Note, null, '密钥类字段显示为 ***，保持原样即保留已存的值；改成新值才会覆盖。'),
    error === undefined ? null : h(Note, { tone: 'error' }, error),
    notice === undefined ? null : h(Note, { tone: 'ok' }, notice),
    value === undefined && error === undefined
      ? h(Empty, null, t().loading)
      : h(TextArea, { value: text, onChange: setText, rows: 14 }),
  )
}

/** One plugin row in the configuration manager. */
function ConfigEntryRow({ entry, allowToggle, onToggle, onEdit, pending }) {
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
    h(
      'div',
      { style: { minWidth: 0, display: 'flex', flexDirection: 'column' } },
      h('span', { className: 'mydsh-truncate' }, entry.title === '' || entry.title === undefined ? entry.name ?? entry.id : entry.title),
      h(
        'span',
        { className: 'mydsh-muted mydsh-truncate', title: entry.why === '' ? entry.id : `${entry.id} · ${entry.why}` },
        entry.why === undefined || entry.why === '' ? entry.id : `${entry.id} · ${entry.why}`,
      ),
    ),
    h(
      'div',
      { className: 'mydsh-inline' },
      entry.readOnly === true ? h(Badge, { tone: 'warn' }, '只读') : null,
      h(Badge, { tone: entry.enabled === true ? 'ok' : undefined }, entry.enabled === true ? t().enabled : t().disabled),
      h(Switch, {
        checked: entry.enabled === true,
        onChange: (value) => onToggle(entry, value),
        label: entry.name ?? entry.id,
        disabled: entry.readOnly === true || allowToggle !== true || pending === true,
      }),
      h(Button, { size: 'sm', onClick: () => onEdit(entry) }, t().edit),
    ),
  )
}

/** Configuration and plugin management. */
function ModuleConfig({ slice, setModule }) {
  const [entries, setEntries] = useState(undefined)
  const [error, setError] = useState(undefined)
  const [notice, setNotice] = useState(undefined)
  const [editing, setEditing] = useState(undefined)
  const [running, setRunning] = useState(false)

  const loadRows = useCallback(() => {
    api('/config/list', { body: {} })
      .then((result) => {
        if (result?.ok === false) {
          setError(result.message ?? '读取插件列表失败')
          setEntries([])
          return
        }
        setError(undefined)
        setEntries(Array.isArray(result?.entries) ? result.entries : [])
      })
      .catch((failure) => {
        setError(failure?.message ?? String(failure))
        setEntries([])
      })
  }, [])

  useEffect(() => {
    loadRows()
  }, [loadRows])

  const toggle = (entry, enabled) => {
    setRunning(true)
    api('/config/toggle', { body: { id: entry.id, enabled } })
      .then((response) => {
        // The route wraps the module result: `{ entry: { ok, entry, restartRequired, message } }`.
        const result = response?.entry ?? {}
        if (result.ok === false) {
          setNotice({ tone: 'error', message: result.message ?? '启停失败' })
          return
        }
        setNotice(
          result.restartRequired === true
            ? { tone: 'warn', message: '已写入，重启 DSH 后生效' }
            : { tone: 'ok', message: result.message === '' || result.message === undefined ? '已切换' : result.message },
        )
        loadRows()
      })
      .catch((failure) => setNotice({ tone: 'error', message: failure?.message ?? String(failure) }))
      .finally(() => setRunning(false))
  }

  const rows = entries ?? []

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h(Note, null, '这里只读写各插件自己的配置层，不直接改动 profile 补丁文本。标为只读的行由管理端维护。'),
    h(SwitchRow, {
      title: '允许在此启停插件',
      hint: '关掉后开关全部禁用，只能查看',
      checked: slice.allowPluginToggle === true,
      onChange: (value) => setModule('configManager', { allowPluginToggle: value }),
    }),
    h(SwitchRow, {
      title: '允许编辑插件配置',
      hint: '关掉后「编辑」按钮仍然可见但会拒绝写入',
      checked: slice.allowConfigEdit === true,
      onChange: (value) => setModule('configManager', { allowConfigEdit: value }),
    }),
    h(
      Row,
      { title: '插件列表', hint: `${rows.length} 行` },
      h(Button, { size: 'sm', variant: 'ghost', onClick: loadRows }, `⟳ ${t().refresh}`),
    ),
    notice === undefined ? null : h(Note, { tone: notice.tone }, notice.message),
    error === undefined ? null : h(Note, { tone: 'error' }, error),
    entries === undefined
      ? h(Empty, null, t().loading)
      : rows.length === 0
        ? h(Empty, null, '宿主没有上报任何可管理的插件行')
        : h(
            'div',
            { className: 'mydsh-list mydsh-scroll' },
            rows.map((entry) =>
              h(ConfigEntryRow, {
                key: entry.id,
                entry,
                allowToggle: slice.allowPluginToggle === true,
                pending: running,
                onToggle: toggle,
                onEdit: (row) => setEditing(row),
              }),
            ),
          ),
    editing === undefined
      ? null
      : h(ModuleConfigEditModal, {
          id: editing.id,
          title: editing.title === '' || editing.title === undefined ? editing.name ?? editing.id : editing.title,
          onClose: () => setEditing(undefined),
          onSaved: () => {
            loadRows()
            settingsStore.refresh(true)
          },
        }),
  )
}

/**
 * Skill catalogue plus the sidebar entry switch.
 *
 * The search filters the already-loaded list instead of re-querying per
 * keystroke: the catalogue is small and a GET per character would be noise on the
 * Host for no benefit.
 */
function ModuleSkills({ slice, setModule }) {
  const [query, setQuery] = useState('')
  const poll = usePoll('/skills/list', 30000, [])
  const all = Array.isArray(poll.data?.skills) ? poll.data.skills : []
  const keyword = query.trim().toLowerCase()
  const skills = keyword === ''
    ? all
    : all.filter((entry) =>
        [entry.name, entry.description, entry.source].some((field) => String(field ?? '').toLowerCase().includes(keyword)),
      )

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h(SwitchRow, {
      title: '在侧栏显示技能入口',
      hint: '常驻一个技能列表入口，便于随时查看与调用',
      checked: slice.showInSidebar === true,
      onChange: (value) => setModule('skills', { showInSidebar: value }),
    }),
    h(Row, { title: '搜索技能', hint: `${skills.length} / ${all.length} 项` }, h(TextField, {
      value: query,
      onChange: setQuery,
      width: 'xl',
      placeholder: '按名称或描述搜索',
    })),
    poll.data?.reason === undefined ? null : h(Note, { tone: 'warn' }, poll.data.reason),
    poll.error === undefined ? null : h(Note, { tone: 'error' }, poll.error),
    skills.length === 0
      ? h(Empty, null, poll.loading === true ? t().loading : '没有可用的技能')
      : h(
          'table',
          { className: 'mydsh-table' },
          h('thead', null,
            h('tr', null,
              h('th', null, '技能'),
              h('th', null, '说明'),
              h('th', null, '来源'),
            ),
          ),
          h('tbody', null,
            skills.map((entry, index) =>
              h('tr', { key: `${entry.name}-${index}` },
                h('td', null, entry.name),
                h('td', { className: 'mydsh-muted' }, entry.description ?? ''),
                h('td', { className: 'mydsh-muted' }, entry.source ?? ''),
              ),
            ),
          ),
        ),
  )
}

/**
 * Team data, read-only.
 *
 * The member tree, the task board and the message log come from DSH's own team
 * runtime; nothing here writes. The session id is read from the live session
 * service because the team view is per lead session.
 */
function ModuleTeams({ slice, setModule }) {
  const [sessionId, setSessionId] = useState('')

  useEffect(() => {
    const read = () => {
      try {
        const sessions = ctxRef.get('sessions')
        const current = sessions?.current?.() ?? sessions?.active?.()
        const id = String(current?.id ?? current?.sessionId ?? '')
        if (id !== '') setSessionId(id)
      } catch {
        // No session service: the view stays empty with an explanation.
      }
    }
    read()
    const timer = setInterval(read, 5000)
    return () => clearInterval(timer)
  }, [])

  const poll = usePoll(sessionId === '' ? null : `/teams/state?sessionId=${encodeURIComponent(sessionId)}`, 15000, [sessionId])
  const members = Array.isArray(poll.data?.members) ? poll.data.members : []
  const tasks = Array.isArray(poll.data?.tasks) ? poll.data.tasks : []
  const messages = Array.isArray(poll.data?.messages) ? poll.data.messages : []
  const totals = poll.data?.totals ?? {}

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h(Note, null, '读取 DSH 内置编队数据，只读。这里不会创建任务、不会给成员发消息。'),
    h(SwitchRow, {
      title: '只读模式',
      hint: '关闭后本插件也不会写入编队数据；宿主写操作仍由编队工具负责',
      checked: slice.readOnly === true,
      onChange: (value) => setModule('teams', { readOnly: value }),
    }),
    sessionId === ''
      ? h(Note, { tone: 'warn' }, '请先打开一个会话：编队数据按主会话读取。')
      : h('div', { className: 'mydsh-muted' }, `当前会话：${sessionId}`),
    poll.data?.reason === undefined ? null : h(Note, { tone: 'warn' }, poll.data.reason),
    poll.error === undefined ? null : h(Note, { tone: 'error' }, poll.error),
    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '3' },
      h(Stat, { label: '成员', value: exact(totals.members ?? members.length), foot: `${members.filter((row) => row.status === 'running').length} 个执行中` }),
      h(Stat, { label: '任务', value: exact(totals.tasks ?? tasks.length), foot: `${exact(totals.completed ?? tasks.filter((row) => row.status === 'completed').length)} 已完成` }),
      h(Stat, { label: '消息', value: exact(totals.messages ?? messages.length), foot: '按投递记录统计' }),
    ),
    h(
      Card,
      { title: '成员', sub: '来自子代理树' },
      members.length === 0
        ? h(Empty, null, '当前会话没有子代理成员')
        : h(
            'table',
            { className: 'mydsh-table' },
            h('thead', null, h('tr', null, h('th', null, '名称'), h('th', null, '状态'), h('th', { 'data-num': 'true' }, '深度'), h('th', { 'data-num': 'true' }, 'token'))),
            h('tbody', null,
              members.map((row, index) =>
                h('tr', { key: `${row.id}-${index}` },
                  h('td', { className: 'mydsh-truncate' }, row.name ?? '(未命名)'),
                  h('td', null, h(Badge, { tone: row.status === 'running' ? 'ok' : row.status === 'error' ? 'error' : undefined }, row.status ?? 'unknown')),
                  h('td', { 'data-num': 'true' }, exact(row.depth)),
                  h('td', { 'data-num': 'true' }, tokens(row.usage?.totalTokens ?? 0)),
                ),
              ),
            ),
          ),
    ),
    h(
      Card,
      { title: '任务', sub: '来自编队任务板' },
      tasks.length === 0
        ? h(Empty, null, '当前会话没有编队任务')
        : h(
            'table',
            { className: 'mydsh-table' },
            h('thead', null, h('tr', null, h('th', null, '任务'), h('th', null, '状态'), h('th', null, '负责人'), h('th', { 'data-num': 'true' }, '修订'))),
            h('tbody', null,
              tasks.map((row, index) =>
                h('tr', { key: `${row.id}-${index}` },
                  h('td', { className: 'mydsh-truncate', title: row.subject }, row.subject ?? ''),
                  h('td', null, h(Badge, { tone: row.status === 'completed' ? 'ok' : row.status === 'error' ? 'error' : undefined }, row.status ?? '')),
                  h('td', { className: 'mydsh-muted' }, row.owner === '' ? '未认领' : row.owner),
                  h('td', { 'data-num': 'true' }, exact(row.revision)),
                ),
              ),
            ),
          ),
    ),
    h(
      Card,
      { title: '消息', sub: '最近投递记录' },
      messages.length === 0
        ? h(Empty, null, '还没有消息记录')
        : h(
            'div',
            { className: 'mydsh-list mydsh-scroll' },
            messages.map((row, index) =>
              h(
                'div',
                { key: index, className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
                h('span', { className: 'mydsh-muted', style: { flexShrink: 0 } }, row.at === 0 ? '—' : when(row.at)),
                h('span', { className: 'mydsh-truncate mydsh-grow', title: row.summary }, row.summary ?? ''),
                h('span', { className: 'mydsh-muted' }, (row.from ?? '') + (row.to === undefined ? '' : ` → ${row.to}`)),
              ),
            ),
          ),
    ),
  )
}

/** The capability modules tab. */
function ModulesTab({ settings, patch, meta }) {
  const overview = usePoll('/modules/overview', 30000, [])
  const [openKey, setOpenKey] = useState(undefined)
  const [queue, setQueue] = useState([])
  const [notice, setNotice] = useState(undefined)
  const acknowledged = useRef(new Set())

  const modules = settings.modules ?? {}
  const rows = Array.isArray(overview.data?.modules) ? overview.data.modules : []
  const byKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows])

  const write = (partial) => {
    patch(partial).catch(() => undefined)
  }
  const setModule = (key, partial) => write({ modules: { [key]: partial } })
  const enable = (key) => setModule(key, { enabled: true })

  /**
   * Route one switch change.
   *
   * Turning a module off never asks: reducing access is always allowed. Turning
   * a high-risk module on asks once per page load; after acknowledgement the
   * switch behaves like any other. A new request is appended to the queue rather
   * than replacing it, so an unanswered preset confirmation is not silently lost.
   */
  const requestToggle = (row, next) => {
    if (next !== true) {
      setModule(row.key, { enabled: false })
      return
    }
    if (row.risk === 'high' && acknowledged.current.has(row.key) !== true) {
      setQueue((items) =>
        items.some((entry) => entry.key === row.key) ? items : [...items, { key: row.key, label: row.label }],
      )
      return
    }
    enable(row.key)
  }

  const confirmNext = () => {
    const head = queue[0]
    if (head === undefined) return
    acknowledged.current.add(head.key)
    enable(head.key)
    setQueue((items) => items.slice(1))
  }

  /**
   * Enable one preset.
   *
   * Unavailable modules are skipped (a switch that cannot work should not be
   * turned on), and high-risk ones join the confirmation queue instead of being
   * enabled outright. The queue is merged rather than replaced so a preset never
   * discards a confirmation the user has not answered yet.
   */
  const applyPreset = (preset) => {
    const keys = preset.keys ?? rows.map((row) => row.key)
    const batch = {}
    const pending = []
    for (const key of keys) {
      const row = byKey.get(key)
      if (row !== undefined && row.available === false) continue
      if (row !== undefined && row.risk === 'high' && acknowledged.current.has(key) !== true) {
        pending.push({ key, label: row.label })
        continue
      }
      batch[key] = { enabled: true }
    }
    const count = Object.keys(batch).length
    if (count > 0) write({ modules: batch })
    setNotice(
      pending.length === 0
        ? { tone: 'ok', message: `已打开 ${count} 项能力` }
        : { tone: 'warn', message: `已打开 ${count} 项，另有 ${pending.length} 项高风险能力待逐个确认` },
    )
    setQueue((items) => {
      const known = new Set(items.map((entry) => entry.key))
      return [...items, ...pending.filter((entry) => known.has(entry.key) !== true)]
    })
  }

  const sections = [
    { key: 'desktop', title: '桌面自动化', sub: '仅 Windows；读屏、键盘、鼠标分开放行', body: ModuleDesktop },
    { key: 'mcpConnector', title: 'MCP 连接器', sub: '服务器列表增删改、按行测试、应用到宿主', body: ModuleMcp },
    { key: 'imageGen', title: '图像生成', sub: 'OpenAI 兼容接口，可用固定短句测试链路', body: ModuleImageGen },
    { key: 'roles', title: '角色专家库', sub: '自定义专家增删改，内置目录只读可搜索', body: ModuleRoles },
    { key: 'configManager', title: '配置与插件管理', sub: '插件启停与配置编辑，只读行不给写', body: ModuleConfig },
    { key: 'skills', title: '技能中心', sub: '技能列表与侧栏入口', body: ModuleSkills },
    { key: 'teams', title: '编队视图', sub: '读取内置编队数据，只读', body: ModuleTeams },
  ].filter((section) => modules[section.key] !== undefined)

  return h(
    'div',
    { className: 'mydsh-page' },
    h(
      Card,
      {
        title: '能力总览',
        sub: `${rows.filter((row) => row.enabled === true && row.available !== false).length} 项已启用 · ${rows.filter((row) => row.available === false).length} 项在当前环境不可用`,
        actions: h(Button, { size: 'sm', variant: 'ghost', onClick: () => overview.reload() }, `⟳ ${t().refresh}`),
      },
      overview.error === undefined ? null : h(Note, { tone: 'error' }, overview.error),
      overview.data?.reason === undefined ? null : h(Note, { tone: 'warn' }, overview.data.reason),
      rows.length === 0
        ? h(Empty, null, overview.loading === true ? t().loading : '宿主没有上报任何能力模块')
        : h(
            'div',
            { className: 'mydsh-grid', 'data-cols': '3' },
            rows.map((row) => h(ModuleCard, { key: row.key, row, onToggle: requestToggle })),
          ),
      h(
        'div',
        { className: 'mydsh-muted' },
        '强耦合提示：上下文洞察与用量看板共用数据源；余额与价目表共用供应商适配；备份与跨机同步共用打包引擎。',
      ),
    ),

    h(
      Card,
      { title: '一键预置', sub: '只打开、不关闭；三档都保留你已有的选择' },
      h(
        'div',
        { className: 'mydsh-inline' },
        MODULE_PRESETS.map((preset) =>
          h(
            Button,
            { key: preset.id, variant: preset.id === 'daily' ? 'primary' : undefined, onClick: () => applyPreset(preset) },
            preset.label,
          ),
        ),
      ),
      h(
        'div',
        { className: 'mydsh-list' },
        MODULE_PRESETS.map((preset) =>
          h(
            'div',
            { key: preset.id, className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 10 } },
            h('span', null, preset.label),
            h('span', { className: 'mydsh-muted mydsh-truncate' }, preset.sub),
          ),
        ),
      ),
      notice === undefined ? null : h(Note, { tone: notice.tone }, notice.message),
    ),

    sections.map((section) => {
      const slice = modules[section.key] ?? {}
      const row = byKey.get(section.key)
      const open = openKey === section.key
      const Body = section.body
      return h(
        ModuleSection,
        {
          key: section.key,
          title: section.title,
          sub: section.sub,
          row,
          open,
          onToggle: () => setOpenKey(open ? undefined : section.key),
        },
        open
          ? h(Body, { slice, row, setModule, settings, meta })
          : null,
      )
    }),

    h(ModuleConfirm, {
      queue,
      onConfirm: confirmNext,
      onCancel: () => setQueue([]),
    }),
  )
}

    // ===== 47-tab-relay.js =====
/**
 * Remote access tab.
 *
 * The tunnel is an *outbound* WebSocket: DSH serves its GUI on loopback, the
 * plugin dials the relay, and the relay forwards browser requests back down that
 * socket. Nothing is opened inbound on this machine, which is why this page can
 * be honest about deployment instead of pretending a checkbox is enough.
 *
 * Four things this page refuses to blur:
 *
 * - The password is never written to the settings document. It lives in this
 *   component for the duration of one register/login call; only the token the
 *   relay hands back is persisted, and the Host writes that itself.
 * - Free-text fields are drafts committed by 保存. Every `patch` is a POST, so
 *   writing per keystroke would send one request per character — and the Host's
 *   probe reads the *stored* URL, so a test must follow a committed save.
 * - "Switched on" and "connected" are separate states. `relay.enabled` is a
 *   preference; the status pill reports what the tunnel is actually doing.
 * - The deployment section is written as instructions, not as a sales pitch: the
 *   plugin forwards nothing to a third party, so the relay has to be the user's.
 */

/** Human wording for one tunnel status. */
const RELAY_STATUS_TEXT = {
  off: '未连接',
  connecting: '连接中…',
  online: '在线',
  error: '连接失败',
}

/** Tone for the status badge, so the colour is decided in one place. */
function relayTone(status) {
  if (status === 'online') return 'ok'
  if (status === 'error') return 'error'
  if (status === 'connecting') return 'warn'
  return undefined
}

/**
 * The live tunnel state: status, public address, traffic counters, uptime.
 *
 * `since` is a timestamp, not a duration, so the online time is recomputed on
 * every poll instead of frozen at connect time.
 */
function RelayStatus({ state, status }) {
  const [copied, setCopied] = useState(false)
  const publicUrl = state?.publicUrl ?? ''
  const online = status === 'online'
  const since = Number(state?.since ?? 0)
  const uptime = online && since > 0 ? Date.now() - since : 0

  const copy = () => {
    if (publicUrl === '') return
    try {
      navigator.clipboard.writeText(publicUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // A browser without the clipboard permission simply does not copy.
    }
  }

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        { className: 'mydsh-inline', style: { minWidth: 0 } },
        h('span', { className: 'mydsh-dot', 'data-tone': relayTone(status) }),
        h(Badge, { tone: relayTone(status) }, RELAY_STATUS_TEXT[status] ?? status ?? t().unknown),
        publicUrl === ''
          ? h('span', { className: 'mydsh-muted' }, '尚未分配公网地址')
          : h(
              'span',
              { className: 'mydsh-inline', style: { minWidth: 0 } },
              h('span', { className: 'mydsh-mono mydsh-truncate', title: publicUrl }, publicUrl),
              h(Button, { size: 'sm', variant: 'ghost', onClick: copy }, copied ? t().copied : t().copy),
            ),
      ),
      h('span', { className: 'mydsh-muted' }, online ? `已在线 ${duration(uptime)}` : ''),
    ),
    state?.message === undefined || state.message === ''
      ? null
      : h(Note, { tone: status === 'error' ? 'error' : 'warn' }, state.message),
    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '4' },
      h(Stat, {
        label: '上行',
        value: bytes(state?.bytesUp ?? 0),
        foot: `${exact(state?.bytesUp ?? 0)} B`,
        accent: 'var(--dsw-alias-state-warn-primary)',
      }),
      h(Stat, {
        label: '下行',
        value: bytes(state?.bytesDown ?? 0),
        foot: `${exact(state?.bytesDown ?? 0)} B`,
        accent: 'var(--dsw-alias-brand-primary)',
      }),
      h(Stat, {
        label: '请求数',
        value: exact(state?.requests ?? 0),
        foot: '经隧道转发的请求',
        accent: 'var(--dsw-alias-state-success-primary)',
      }),
      h(Stat, {
        label: '在线时长',
        value: online ? duration(uptime) : '—',
        foot: online && since > 0 ? `自 ${when(since)}` : '未连接',
        accent: 'var(--dsw-alias-state-error-primary)',
      }),
    ),
  )
}

/** The relay tab. */
function RelayTab({ settings, patch, meta }) {
  const relay = settings.relay ?? {}
  const live = usePoll('/relay/state', 8000, [])
  const [test, testState] = useAction()
  const [connect, connectState] = useAction()
  const [auth, authState] = useAction()
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState(undefined)
  const [showDeploy, setShowDeploy] = useState(false)
  const [saved, setSaved] = useState(false)

  // Drafts for the free-text fields; committed by 保存 (or by the actions that
  // need the value on the Host side).
  const [draft, setDraft] = useState(() => ({
    serverUrl: relay.serverUrl ?? '',
    publicDomain: relay.publicDomain ?? '',
    tunnelName: relay.tunnelName ?? '',
    account: relay.account ?? '',
  }))
  const set = (partial) => {
    setDraft((value) => ({ ...value, ...partial }))
    setSaved(false)
  }

  const state = live.data?.state ?? {}
  const status = state.status ?? 'off'
  const pending = connectState.pending === true || authState.pending === true
  const configured = String(draft.serverUrl ?? '').trim() !== ''
  const savedUrl = String(relay.serverUrl ?? '') !== ''
  const signedIn = String(relay.token ?? '') !== ''
  const canAuth = savedUrl && String(draft.account ?? '').trim() !== '' && password !== ''

  const setRelay = (partial) => {
    patch({ relay: partial }).catch(() => undefined)
  }

  /** Persist the four text fields. Resolves with the accepted document. */
  const commit = () =>
    patch({
      relay: {
        serverUrl: String(draft.serverUrl ?? '').trim().replace(/\/+$/, ''),
        publicDomain: String(draft.publicDomain ?? '').trim(),
        tunnelName: String(draft.tunnelName ?? '').trim(),
        account: String(draft.account ?? '').trim(),
      },
    })
      .then(() => {
        setSaved(true)
        return true
      })
      .catch(() => false)

  /**
   * Test reachability.
   *
   * The Host's probe reads `relay.serverUrl` from its own document, so the draft
   * is committed first; testing against an unsaved address would silently probe
   * the previous one.
   */
  const runTest = () => {
    if (!configured) {
      setNotice({ tone: 'warn', message: '请先填写服务端地址' })
      return
    }
    commit().then((ok) => {
      if (!ok) {
        setNotice({ tone: 'error', message: '服务端地址保存失败' })
        return
      }
      test('/relay/test', {})
        .then((value) => {
          if (value === undefined) return
          setNotice(
            value.ok === false
              ? { tone: 'error', message: value.message ?? '无法连通中转服务端' }
              : {
                  tone: 'ok',
                  message: `连通正常${value.latencyMs === undefined ? '' : ` · ${value.latencyMs} ms`}${value.message === undefined || value.message === '' ? '' : ` · ${value.message}`}`,
                },
          )
        })
        .catch(() => undefined)
    })
  }

  const runConnect = () => {
    connect('/relay/connect', {})
      .then((value) => {
        if (value === undefined) return
        live.reload()
        const next = value.state?.status
        setNotice({
          tone: next === 'online' ? 'ok' : 'warn',
          message: `当前状态：${RELAY_STATUS_TEXT[next] ?? next ?? '—'}${value.state?.message === undefined || value.state.message === '' ? '' : ` · ${value.state.message}`}`,
        })
      })
      .catch(() => undefined)
  }

  const runDisconnect = () => {
    connect('/relay/disconnect', {})
      .then(() => {
        live.reload()
        setNotice({ tone: 'ok', message: '已断开隧道' })
      })
      .catch(() => undefined)
  }

  /**
   * Register or sign in.
   *
   * The account is committed first so the Host's login handler writes the token
   * back against the same name it authenticated. The password is only ever an
   * argument to this one call and is cleared from state on success.
   */
  const runAuth = (mode) => {
    commit().then((ok) => {
      if (!ok) {
        setNotice({ tone: 'error', message: '账号保存失败' })
        return
      }
      auth(mode === 'register' ? '/relay/register' : '/relay/login', {
        account: String(draft.account ?? '').trim(),
        password,
      })
        .then((value) => {
          if (value === undefined) return
          if (mode === 'register') {
            setNotice(
              value.ok === false
                ? { tone: 'error', message: value.message ?? '注册失败' }
                : { tone: 'ok', message: value.message === '' || value.message === undefined ? '注册成功，请用同一账号登录' : value.message },
            )
            return
          }
          setPassword('')
          setNotice(
            value.token === '' || value.token === undefined
              ? { tone: 'warn', message: '登录没有返回 token，请检查服务端配置' }
              : { tone: 'ok', message: '登录成功，token 已由宿主写回设置；点「连接」建立隧道' },
          )
          live.reload()
        })
        .catch(() => undefined)
    })
  }

  const deployLines = [
    ['DNS', '为 mdsh.zhengl.vip 添加一条 A 记录，指向服务器公网 IP；等解析生效后再申请证书，否则签发会失败。'],
    ['站点', '宝塔里新建站点绑定该域名，开启 Let\'s Encrypt 证书并强制 HTTPS。'],
    ['反代', '在站点配置里加一段反向代理转发到本机中转服务端口（例如 http://127.0.0.1:8787），并透传 Upgrade 与 Connection 头，否则隧道握手会被挡掉。'],
    ['服务', '把中转服务端注册成 systemd 单元：ExecStart 指向你的 node 与入口文件，设置 Restart=always，再用 systemctl enable --now 拉起。'],
    ['变量', '在单元里配置 RELAY_SECRET（签发 token 用，务必长且随机）与 RELAY_ADMIN_TOKEN（管理接口用）。这两个值不要写进仓库。'],
    ['验证', 'curl https://mdsh.zhengl.vip/healthz 返回 200 即通；再在插件里点「测试连通」，然后注册账号并登录。'],
  ]

  return h(
    'div',
    { className: 'mydsh-page' },
    h(Note, null, '本插件不会把任何数据转发给第三方：远程访问必须由你自己部署中转服务端，插件只负责拨打你的地址。'),

    h(
      Card,
      {
        title: '总开关',
        sub: '关闭时隧道不会建立，也不产生任何后台请求',
        actions: h(Badge, { tone: relayTone(status) }, RELAY_STATUS_TEXT[status] ?? status),
      },
      h(SwitchRow, {
        title: '启用远程访问',
        hint: '允许插件建立到中转服务端的隧道',
        checked: relay.enabled === true,
        onChange: (value) => setRelay({ enabled: value }),
      }),
      h(SwitchRow, {
        title: '启动后自动连接',
        hint: 'DSH 启动且开关为开时自动建立隧道',
        checked: relay.autoConnect === true,
        onChange: (value) => setRelay({ autoConnect: value }),
        disabled: relay.enabled !== true,
      }),
      relay.enabled === true
        ? null
        : h(Note, { tone: 'warn' }, '总开关当前关闭，下面的连接按钮不会生效。'),
    ),

    h(
      Card,
      { title: '服务端', sub: '你部署的中转服务地址；没有它，账号与连接都无从谈起' },
      h(Row, { title: '服务端地址', hint: '形如 https://你的域名，结尾斜杠会自动去掉' },
        h(TextField, {
          value: draft.serverUrl,
          onChange: (value) => set({ serverUrl: value }),
          width: 'xl',
          mono: true,
          placeholder: 'https://mdsh.zhengl.vip',
          onEnter: commit,
        }),
      ),
      h(Row, { title: '公网域名', hint: '给用户看的访问地址；留空则用服务端地址' },
        h(TextField, {
          value: draft.publicDomain,
          onChange: (value) => set({ publicDomain: value }),
          width: 'lg',
          mono: true,
          placeholder: 'mdsh.zhengl.vip',
          onEnter: commit,
        }),
      ),
      h(Row, { title: '隧道名称', hint: '同一账号跑多条隧道时用于区分，可留空' },
        h(TextField, {
          value: draft.tunnelName,
          onChange: (value) => set({ tunnelName: value }),
          width: 'md',
          mono: true,
          onEnter: commit,
        }),
      ),
      h(
        Row,
        { title: '地址设置', hint: saved ? '已保存' : '改完先保存，再测试连通' },
        h(
          'div',
          { className: 'mydsh-inline' },
          h(Button, { size: 'sm', onClick: commit }, t().save),
          h(
            Button,
            { size: 'sm', variant: 'primary', onClick: runTest, disabled: testState.pending === true },
            testState.pending === true ? '测试中…' : '测试连通',
          ),
        ),
      ),
      testState.error === undefined ? null : h(Note, { tone: 'error' }, testState.error),
    ),

    // One notice channel for the whole page: a login result must not be shown
    // under the server-address card, where it reads as an address error.
    notice === undefined ? null : h(Note, { tone: notice.tone }, notice.message),

    h(
      Card,
      { title: '账号', sub: '账号存在你自己的中转服务端上；密码不会写入设置文件' },
      h(Row, { title: '账号', hint: '注册与登录都用它' },
        h(TextField, {
          value: draft.account,
          onChange: (value) => set({ account: value }),
          width: 'md',
          mono: true,
          placeholder: 'your-name',
        }),
      ),
      h(
        Row,
        { title: '密码', hint: '仅本次操作使用，不落盘；注册至少 8 位', stack: true },
        h(
          'div',
          { className: 'mydsh-inline' },
          h(TextField, {
            value: password,
            onChange: setPassword,
            width: 'md',
            type: 'password',
            placeholder: signedIn ? '已登录（重登需重新输入）' : '••••••••',
          }),
          h(Button, { size: 'sm', disabled: pending || !canAuth, onClick: () => runAuth('register') }, '注册'),
          h(Button, { size: 'sm', variant: 'primary', disabled: pending || !canAuth, onClick: () => runAuth('login') }, '登录'),
        ),
      ),
      h(
        'div',
        { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
        h(Badge, { tone: signedIn ? 'ok' : undefined }, signedIn ? '已有 token' : '未登录'),
        h('span', { className: 'mydsh-muted' }, '登录成功后 token 由宿主写回设置，本页不显示 token 内容'),
      ),
      !savedUrl
        ? h(Note, { tone: 'warn' }, '请先保存服务端地址，否则注册与登录无法发起。')
        : null,
      authState.error === undefined ? null : h(Note, { tone: 'error' }, authState.error),
    ),

    h(
      Card,
      {
        title: '连接控制',
        sub: '建立或断开隧道；状态每 8 秒刷新一次',
        actions: h(Button, { size: 'sm', variant: 'ghost', onClick: () => live.reload() }, `⟳ ${t().refresh}`),
      },
      h(
        'div',
        { className: 'mydsh-inline' },
        h(
          Button,
          {
            variant: 'primary',
            disabled: pending || relay.enabled !== true || status === 'online' || status === 'connecting',
            onClick: runConnect,
          },
          connectState.pending === true ? '连接中…' : '连接',
        ),
        h(Button, { variant: 'danger', disabled: pending || status === 'off', onClick: runDisconnect }, '断开'),
        h(
          'span',
          { className: 'mydsh-muted' },
          live.loading === true
            ? t().loading
            : meta.dshVersion === undefined || meta.dshVersion === ''
              ? ''
              : `DSH ${meta.dshVersion}`,
        ),
      ),
      connectState.error === undefined ? null : h(Note, { tone: 'error' }, connectState.error),
      live.error === undefined ? null : h(Note, { tone: 'error' }, live.error),
      h(RelayStatus, { state, status }),
    ),

    h(
      Card,
      {
        title: '部署说明',
        sub: '宝塔 + nginx + systemd 的最小可用路径',
        actions: h(
          Button,
          { size: 'sm', variant: 'ghost', onClick: () => setShowDeploy((value) => !value) },
          showDeploy ? '收起' : '展开',
        ),
      },
      showDeploy
        ? h(
            'div',
            { className: 'mydsh-list' },
            deployLines.map(([label, text]) =>
              h(
                'div',
                { key: label, style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
                h('span', { style: { flexShrink: 0 } }, h(Badge, null, label)),
                h('span', { className: 'mydsh-muted' }, text),
              ),
            ),
            h(
              'div',
              { className: 'mydsh-muted mydsh-mono', style: { whiteSpace: 'pre-wrap', paddingTop: 6 } },
              'curl https://mdsh.zhengl.vip/healthz\nsystemctl status <中转服务单元名>\njournalctl -u <中转服务单元名> -n 100 --no-pager',
            ),
            h(Note, { tone: 'warn' }, '反向代理必须透传 Upgrade 与 Connection 头，否则 WebSocket 握手会以 400/426 失败；HTTPS 站点请用 wss。'),
          )
        : h('div', { className: 'mydsh-muted' }, '点「展开」查看 DNS、证书、反代、systemd 与环境变量六项要点。'),
    ),
  )
}

    // ===== 48-tab-overview.js =====
/**
 * Overview and About tabs.
 *
 * Overview is the landing tab: it answers "is anything broken, and what am I
 * spending" in one screen, because those are the two questions that actually
 * send someone into a settings page. About carries the environment report — the
 * place a user looks when a switch does nothing and they need to know whether
 * the Host exposed the service the switch depends on.
 */

/** Overview: status of every subsystem in one screen. */
function OverviewTab({ settings, patch, meta }) {
  const [range, setRange] = useState('7d')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const summary = usePoll(`/usage/summary?${usageQuery(range, from, to)}&dim=model`, 15000, [range, from, to])
  const budgets = usePoll('/usage/budgets', 30000, [])
  const backupState = usePoll('/backup/state', 30000, [])
  const relayState = usePoll('/relay/state', 15000, [])
  const modules = usePoll('/modules/overview', 30000, [])

  const totals = summary.data?.totals ?? {}
  const over = (budgets.data?.evaluation ?? []).filter((entry) => entry.state === 'over')
  const warn = (budgets.data?.evaluation ?? []).filter((entry) => entry.state === 'warn')
  const enabledModules = (modules.data?.modules ?? []).filter((row) => row.enabled === true && row.available === true)
  const unavailable = (modules.data?.modules ?? []).filter((row) => row.available === false)
  const lastRun = backupState.data?.lastRunAt ?? 0

  return h(
    'div',
    { className: 'mydsh-page' },
    over.length > 0
      ? h(Note, { tone: 'error' },
          `有 ${over.length} 条预算已超限：${over.map((entry) => entry.label === '' ? entry.scope : entry.label).join('、')}。` +
            (over.some((entry) => entry.action !== 'notify') ? '暂停类预算正在阻断新的模型请求。' : ''))
      : warn.length > 0
        ? h(Note, { tone: 'warn' }, `有 ${warn.length} 条预算接近上限（≥ 90%）。`)
        : null,

    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(RangeBar, { value: range, onChange: setRange, from, to, onFrom: setFrom, onTo: setTo }),
      h('span', { className: 'mydsh-muted' }, summary.data?.updatedAt === undefined ? '' : `更新于 ${when(summary.data.updatedAt)}`),
    ),

    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '4' },
      h(Stat, { label: t().tabUsage, value: tokens(totals.totalTokens), foot: `${exact(totals.totalTokens)} tokens`, accent: 'var(--dsw-alias-brand-primary)' }),
      h(Stat, { label: '输入', value: tokens(totals.inputTokens), foot: `缓存读 ${tokens(totals.cacheReadTokens)}`, accent: 'var(--dsw-alias-state-success-primary)' }),
      h(Stat, { label: '输出', value: tokens(totals.outputTokens), foot: `${exact(totals.requests)} 次请求`, accent: 'var(--dsw-alias-state-warn-primary)' }),
      h(Stat, {
        label: '预估费用',
        value: money(totals.cost, totals.currency),
        foot: totals.cost === 0 ? '未配置价格时按内置价目表' : '按内置/自定义价目表',
        accent: 'var(--dsw-alias-state-error-primary)',
      }),
    ),

    h(
      'div',
      { className: 'mydsh-split' },
      h(
        Card,
        { title: '用量趋势', sub: '按时间桶展示 token 消耗' },
        summary.data === undefined
          ? h(Empty, null, summary.loading ? t().loading : t().empty)
          : h(BarChart, { points: (summary.data.series ?? []).map((point) => ({ label: point.label, value: point.totalTokens })) }),
      ),
      h(
        Card,
        { title: '系统状态', sub: '各子系统的当前状态，点击分页查看详情' },
        h(
          'div',
          { className: 'mydsh-list' },
          statusLine('用量统计', settings.usage.enabled === true, summary.error === undefined ? `${exact(totals.requests)} 次请求已索引` : summary.error),
          statusLine('备份', settings.backup.enabled === true, lastRun === 0 ? '尚未执行过备份' : `上次备份 ${when(lastRun)}`),
          statusLine('重试策略', settings.retry.enabled === true, `${(settings.retry.policies ?? []).length} 条规则`),
          statusLine('个性化', settings.personalize.enabled === true, settings.personalize.memory.enabled === true ? `长期记忆 ${(settings.personalize.memory.entries ?? []).length} 条` : '未启用长期记忆'),
          statusLine('远程访问', relayState.data?.state?.status === 'online', relayState.data?.state?.status ?? settings.relay.enabled === true ? (relayState.data?.state?.publicUrl ?? '未连接') : '未启用'),
        ),
      ),
    ),

    h(
      Card,
      { title: '能力模块', sub: `已启用 ${enabledModules.length} 项${unavailable.length === 0 ? '' : `，${unavailable.length} 项在当前环境不可用`}` },
      enabledModules.length === 0
        ? h(Empty, null, '还没有启用任何能力模块，可在「能力模块」分页打开。')
        : h(
            'div',
            { className: 'mydsh-inline', style: { flexWrap: 'wrap' } },
            enabledModules.map((row) => h(Badge, { key: row.key, tone: 'ok' }, row.label)),
          ),
      unavailable.length === 0
        ? null
        : h(
            'div',
            { className: 'mydsh-inline', style: { flexWrap: 'wrap' } },
            unavailable.map((row) => h(Badge, { key: row.key, tone: 'warn', title: row.reason }, `${row.label}·不可用`)),
          ),
    ),

    h(
      Card,
      { title: '快速入口', sub: '一键跳到最常用的三件事' },
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Button, { onClick: () => settingsStore.refresh(true) }, '刷新状态'),
        h(Button, { variant: 'primary', onClick: () => api('/backup/run', { body: {} }).catch(() => undefined) }, '立即备份'),
        h(Button, { onClick: () => api('/usage/reindex', { body: {} }).catch(() => undefined) }, '重建用量索引'),
      ),
    ),
  )
}

/** One status row with a coloured dot. */
function statusLine(label, ok, detail) {
  return h(
    'div',
    { className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
    h('span', { className: 'mydsh-inline' },
      h('span', { className: 'mydsh-dot', 'data-tone': ok === true ? 'ok' : undefined }),
      h('span', null, label),
    ),
    h('span', { className: 'mydsh-muted mydsh-truncate', title: String(detail ?? ''), style: { maxWidth: '60%' } }, String(detail ?? '')),
  )
}

/** About: environment report and the limits worth stating up front. */
function AboutTab({ settings, meta }) {
  const modules = usePoll('/modules/overview', 0, [])
  const rows = [
    ['插件版本', '2.0.0'],
    ['DSH 版本', meta.dshVersion === '' ? '未上报' : meta.dshVersion],
    ['数据目录', meta.dataDir ?? '—'],
    ['7z 支持', meta.sevenZip === true ? '已随包提供' : '缺失，压缩自动降级为 zip'],
    ['设置存储', '本机 JSON 文档，不写入 profile 补丁层'],
    ['供应商', (meta.providers ?? []).map((entry) => entry.provider).join('、') || '未读取到'],
    ['工作区', String((meta.workspaces ?? []).length)],
  ]

  return h(
    'div',
    { className: 'mydsh-page' },
    h(
      Card,
      { title: '环境', sub: '插件读取到的运行环境' },
      rows.map(([label, value]) =>
        h(Row, { key: label, title: label },
          h('span', { className: 'mydsh-muted mydsh-truncate', title: String(value), style: { maxWidth: 360, textAlign: 'right' } }, String(value)),
        ),
      ),
    ),
    h(
      Card,
      { title: '能力可用性', sub: '某项开关无效时，先看这里判断是不是宿主没有提供对应服务' },
      (modules.data?.modules ?? []).length === 0
        ? h(Empty, null, modules.loading ? t().loading : t().empty)
        : h(
            'table',
            { className: 'mydsh-table' },
            h('thead', null,
              h('tr', null,
                h('th', null, '模块'),
                h('th', null, '状态'),
                h('th', null, '说明'),
              ),
            ),
            h('tbody', null,
              (modules.data.modules ?? []).map((row) =>
                h('tr', { key: row.key },
                  h('td', null, row.label),
                  h('td', null, h(Badge, { tone: row.available === false ? 'warn' : row.enabled === true ? 'ok' : undefined },
                    row.available === false ? '不可用' : row.enabled === true ? '启用' : '停用')),
                  h('td', { className: 'mydsh-muted' }, row.reason ?? ''),
                ),
              ),
            ),
          ),
    ),
    h(
      Card,
      { title: '已知限制', sub: '这些是设计上的边界，不是缺陷' },
      h(
        'ul',
        { style: { margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.8 } },
        h('li', null, '备份的恢复只解包到独立目录，不覆盖正在运行的会话与配置；确认无误后由你手动替换。'),
        h('li', null, '余额查询只对填写了接口地址的供应商生效；不可查询的供应商用内置价目表估算费用。'),
        h('li', null, '浏览器实时投屏（接管真实浏览器）未实现：它需要独立的 Chromium 通道，风险与体积都不适合放在本插件里。'),
        h('li', null, '桌面自动化只在 Windows 上可用，且每次动作都按开关与二次确认放行。'),
        h('li', null, '远程访问依赖你自行部署的中转服务端；插件本身不转发任何数据到第三方。'),
      ),
    ),
  )
}

    // ===== 50-entries.js =====
/**
 * Entry decorations.
 *
 * Each piece here registers into a slot only while its switch is on, and
 * withdraws its registration when the switch turns off. That is deliberate: a
 * hidden entry that stays registered still mounts a component, still subscribes
 * to the settings store and still runs its poll, which is exactly the cost the
 * user is trying to avoid by turning it off.
 *
 * Slot shapes matter and are not interchangeable:
 *
 * - `single` seats accept no registration options at all; passing an `id` is
 *   rejected by the registry, so `contribute` omits `options` for them.
 * - `sidebar.session.action` is an HOC around the shipped New-session row, so
 *   it can be registered unconditionally and return `children` untouched when
 *   the switch is off. Registering and withdrawing an HOC on every toggle would
 *   remount the row and lose its focus ring.
 * - `conversation.view` takes a `label` thunk, which is re-read on every
 *   projection, so a locale change does not need a re-registration.
 */

/** HOC that hides the New-session row when the switch is on. */
function NewSessionVeil({ children }) {
  const settings = useSettings()
  if (settings === undefined) return children
  if (settings.ui?.hideNewSession !== true) return children
  // Occupying the seat with nothing is what "hidden" means for an HOC; keeping
  // the space would leave a gap where the row used to be.
  return null
}

/** Renders nothing; occupies a `single` seat to blank it out. */
function Blank() {
  return null
}

/** The sidebar foot usage line: one metric, one bar, one click target. */
function FooterUsage({ wide }) {
  const settings = useSettings()
  const metric = settings?.ui?.footerUsageMetric ?? 'today'
  const range = metric === 'today' ? 'today' : metric === 'week' ? '7d' : metric === 'month' ? '30d' : '90d'
  const poll = usePoll(`/usage/summary?range=${range}&dim=model`, 30000, [range])
  const totals = poll.data?.totals
  const label = metric === 'today' ? t().today : metric === 'week' ? t().week : metric === 'month' ? t().month : t().total
  const value = totals === undefined ? '—' : tokens(totals.totalTokens)

  const open = () => {
    try {
      const layout = ctxRef.get('layout')
      layout?.selectPanel?.('mydsh-usage')
    } catch {
      // A Host without the layout service still shows the number.
    }
  }

  if (wide === false) {
    return h(
      'button',
      {
        type: 'button',
        className: 'mydsh-sidebar-meter-rail',
        title: `${label} ${value} tokens`,
        onClick: open,
        'aria-label': `${t().appTitle} ${label} ${value}`,
      },
      h('span', { style: { fontSize: 10, fontVariantNumeric: 'tabular-nums' } }, totals === undefined ? '—' : tokens(totals.totalTokens)),
    )
  }

  return h(
    'div',
    {
      className: 'mydsh-sidebar-meter',
      role: 'button',
      tabIndex: 0,
      title: `${label}：${exact(totals?.totalTokens)} tokens · ${t().tabUsage}`,
      onClick: open,
      onKeyDown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') open()
      },
    },
    h(
      'span',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h('span', null, label),
      h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, value),
    ),
    h(Bar, {
      ratio: poll.data === undefined ? 0 : Math.min(1, Number(totals?.totalTokens ?? 0) / Math.max(1, Number(totals?.totalTokens ?? 1))),
      height: 3,
    }),
  )
}

/** The title-bar avatar: opens a menu with the account actions. */
function AccountBubble() {
  const settings = useSettings()
  const [open, setOpen] = useState(false)
  const anchor = useRef(undefined)
  const locale = activeLocale()
  const avatarOnly = settings?.ui?.accountAvatarOnly !== false

  const initials = (() => {
    if (avatarOnly !== true) return ''
    return locale === 'zh' ? '我' : 'Me'
  })()

  const openSettings = () => {
    try {
      ctxRef.get('layout')?.openSettings?.()
    } catch {
      // Without the layout service the menu items simply do nothing.
    }
  }

  return h(
    'div',
    { className: 'mydsh-inline', ref: anchor, style: { marginLeft: 2 } },
    h(
      'button',
      {
        type: 'button',
        className: 'mydsh-avatar',
        'data-size': 'sm',
        title: t().appTitle,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        onClick: () => setOpen((value) => !value),
      },
      initials,
    ),
    h(
      Popover,
      { anchor, open, onClose: () => setOpen(false) },
      h(
        'div',
        { className: 'mydsh-menu' },
        h('button', { type: 'button', onClick: () => { setOpen(false); openSettings() } }, `⚙ ${locale === 'zh' ? '设置' : 'Settings'}`),
        h('button', { type: 'button', onClick: () => { setOpen(false); openSettings() } }, `✦ ${t().appTitle}`),
      ),
      h('div', { className: 'mydsh-pop-foot' }, locale === 'zh' ? '账户、退出与反馈由 DSH 内置设置页提供' : 'Account, sign-out and feedback live in the Host settings page'),
    ),
  )
}

/** A compact context-pressure pill for the title bar. */
function TitlebarContext() {
  const settings = useSettings()
  const [sessionId, setSessionId] = useState('')
  useEffect(() => {
    let alive = true
    const read = () => {
      try {
        const sessions = ctxRef.get('sessions')
        const current = sessions?.current?.() ?? sessions?.active?.()
        const id = String(current?.id ?? current?.sessionId ?? '')
        if (alive && id !== '') setSessionId(id)
      } catch {
        // No session service: the pill stays hidden.
      }
    }
    read()
    const timer = setInterval(read, 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  const poll = usePoll(sessionId === '' ? null : `/usage/context?sessionId=${encodeURIComponent(sessionId)}`, 15000, [sessionId])
  const data = poll.data
  if (sessionId === '' || data?.available !== true) return null
  const ratio = Number(data.ratio ?? 0)
  const tone = ratio >= 0.95 ? 'error' : ratio >= 0.8 ? 'warn' : undefined
  return h(
    'span',
    { className: 'mydsh-pill', title: `${exact(data.usedTokens)} / ${exact(data.windowTokens)} tokens` },
    h('span', { className: 'mydsh-dot', 'data-tone': tone }),
    `${percent(ratio)} ${settings === undefined ? '' : ''}`,
  )
}

/** The composer-dock metrics: geek request stats and session spend. */
function ComposerMetrics({ sessionId }) {
  const settings = useSettings()
  const entries = settings?.ui?.entries ?? {}
  const geekOn = entries.dockGeekMetrics === true
  const costOn = entries.dockSessionCost === true
  const tokensOn = entries.dockSessionTokens === true
  const pool = settings?.usage?.geekMetrics?.pool ?? 20
  const [open, setOpen] = useState(false)
  const anchor = useRef(undefined)
  const geek = usePoll(geekOn && sessionId !== '' ? `/usage/geek?sessionId=${encodeURIComponent(sessionId)}&pool=${pool}` : null, 20000, [sessionId, pool, geekOn])
  const summary = usePoll(costOn || tokensOn ? `/usage/sessions?range=90d` : null, 60000, [sessionId, costOn, tokensOn])

  if (geekOn !== true && costOn !== true && tokensOn !== true) return null

  const session = (summary.data?.sessions ?? []).find((row) => row.id === sessionId)
  const live = geek.data?.stream
  const latest = (geek.data?.requests ?? [])[0]
  const shown = live ?? latest

  return h(
    'div',
    { className: 'mydsh-inline', style: { justifyContent: 'flex-end', gap: 6, padding: '0 2px' }, ref: anchor },
    tokensOn === true
      ? h('span', { className: 'mydsh-pill', title: session === undefined ? '' : `${exact(session.totalTokens)} tokens` },
          `${tokens(session?.totalTokens)} tok`)
      : null,
    costOn === true && session !== undefined
      ? h('span', { className: 'mydsh-pill', title: `${exact(session.totalTokens)} tokens · ${exact(session.requests)} 次请求` },
          `${money(session.cost, 'CNY')} · ${tokens(session.totalTokens)}`)
      : null,
    geekOn === true && shown !== undefined
      ? h(
          'button',
          {
            type: 'button',
            className: 'mydsh-pill',
            'data-clickable': 'true',
            title: '极客请求指标',
            onClick: () => setOpen((value) => !value),
          },
          h('span', null, '⚡'),
          settings?.usage?.geekMetrics?.showTtft !== false && shown.ttftMs !== undefined
            ? h('span', null, `${(Number(shown.ttftMs) / 1000).toFixed(1)}s`)
            : null,
          settings?.usage?.geekMetrics?.showSpeed !== false && shown.speed !== undefined
            ? h('span', null, `${Math.round(Number(shown.speed))} tok/s`)
            : null,
          settings?.usage?.geekMetrics?.showTokens !== false && shown.outputTokens !== undefined
            ? h('span', null, `${tokens(shown.outputTokens)} tok`)
            : null,
        )
      : null,
    h(
      Popover,
      { anchor, open, onClose: () => setOpen(false), align: 'end' },
      h(
        'div',
        { className: 'mydsh-pop-title' },
        h('span', null, '最近请求指标'),
        h('span', { className: 'mydsh-muted' }, live === undefined ? '最近完成' : '进行中'),
      ),
      (geek.data?.requests ?? []).length === 0
        ? h(Empty, null, '本会话还没有请求记录')
        : h(
            'table',
            { className: 'mydsh-table' },
            h('thead', null,
              h('tr', null,
                h('th', null, '#'),
                h('th', null, '时间'),
                h('th', { 'data-num': 'true' }, '首字'),
                h('th', { 'data-num': 'true' }, '速度'),
                h('th', { 'data-num': 'true' }, '输出'),
                h('th', { 'data-num': 'true' }, '耗时'),
              ),
            ),
            h('tbody', null,
              (geek.data.requests ?? []).slice(0, pool).map((row, index) =>
                h('tr', { key: `${row.at}-${index}` },
                  h('td', null, String(index + 1)),
                  h('td', null, when(row.at)),
                  h('td', { 'data-num': 'true' }, row.ttftMs === undefined ? '—' : `${(row.ttftMs / 1000).toFixed(1)}s`),
                  h('td', { 'data-num': 'true' }, row.speed === undefined ? '—' : `${Math.round(row.speed)} tok/s`),
                  h('td', { 'data-num': 'true' }, tokens(row.outputTokens)),
                  h('td', { 'data-num': 'true' }, duration(row.durationMs)),
                ),
              ),
            ),
          ),
      h('div', { className: 'mydsh-pop-foot' }, geek.data?.avg === undefined ? '' : `平均 ${Math.round(geek.data.avg.speed ?? 0)} tok/s`),
    ),
  )
}

/** The composer's auto-continue mode menu. */
function AutoContinueMenu({ sessionId }) {
  const settings = useSettings()
  const [open, setOpen] = useState(false)
  const anchor = useRef(undefined)
  const mode = settings?.ui?.autoContinueMode ?? 'follow'
  const modes = [
    ['follow', '跟随默认（仅故障恢复）'],
    ['off', '关闭'],
    ['recover', '仅故障恢复'],
    ['loop', '自主循环'],
  ]
  return h(
    'div',
    { className: 'mydsh-inline', ref: anchor },
    h(
      'button',
      {
        type: 'button',
        className: 'mydsh-btn',
        'data-size': 'sm',
        'data-variant': 'ghost',
        title: '自动续跑方式',
        onClick: () => setOpen((value) => !value),
      },
      `∞ ${(modes.find(([value]) => value === mode) ?? modes[0])[1]}`,
    ),
    h(
      Popover,
      { anchor, open, onClose: () => setOpen(false) },
      h(
        'div',
        { className: 'mydsh-menu' },
        modes.map(([value, label]) =>
          h(
            'button',
            {
              key: value,
              type: 'button',
              'data-active': value === mode,
              onClick: () => {
                setOpen(false)
                settingsStore.patch({ ui: { autoContinueMode: value } }).catch(() => undefined)
              },
            },
            `${value === mode ? '✓' : '\u00a0'} ${label}`,
          ),
        ),
      ),
      h('div', { className: 'mydsh-pop-foot' }, '本设置只影响本插件自己的续跑策略，不改动其他插件'),
    ),
  )
}

    // ===== 51-view-context.js =====
/**
 * Context insight view (`conversation.view`, props `{ sessionId }`).
 *
 * The Host folds the session log into seven buckets and hands the browser one
 * payload (`GET /usage/context`). Nothing below re-derives a token count: every
 * number is either a Host figure or plain arithmetic over Host figures (a
 * share, a difference, a maximum inside one turn), so a bar can never tell a
 * story the log does not support.
 *
 * Three degradations are visible on purpose rather than papered over:
 *
 *  - A trend branch with no samples renders `Empty` with the reason instead of a
 *    flat zero line, which would read as "the context stopped growing".
 *  - The Host projects no post-compaction window, so the panel says so instead
 *    of inventing a third state beside 当前 / 下一次请求.
 *  - Per-event `delta` is whatever the Host reports; when it reports none the
 *    column shows a dash and the card explains why.
 */

/** The seven context buckets: display order, Chinese label, theme token. */
const CONTEXT_BUCKETS = [
  { key: 'systemPrompt', label: '系统提示词', color: 'var(--dsw-alias-chart-system)' },
  { key: 'toolDefinitions', label: '工具定义', color: 'var(--dsw-alias-chart-tools)' },
  { key: 'userMessages', label: '用户消息', color: 'var(--dsw-alias-brand-primary)' },
  { key: 'injected', label: '注入内容', color: 'var(--dsw-alias-state-business-primary)' },
  { key: 'skills', label: '技能注入', color: 'var(--dsw-alias-state-warn-primary)' },
  { key: 'assistantMessages', label: '助手消息', color: 'var(--dsw-alias-chart-messages)' },
  { key: 'toolResults', label: '工具结果', color: 'var(--dsw-alias-state-success-primary)' },
]

/** Rows kept in one trend sample list; the Host already subsamples, this is a guard. */
const CONTEXT_TREND_LIMIT = 240

/** Events revealed per "load more" click in the flow table. */
const CONTEXT_EVENT_PAGE = 20

/** Rows fetched per page in the drill-down modal. */
const CONTEXT_DRILL_PAGE = 20

/** Metadata for one bucket key, with a neutral row for anything unknown. */
function contextBucketMeta(key) {
  const found = CONTEXT_BUCKETS.find((row) => row.key === key)
  if (found !== undefined) return found
  return { key: String(key ?? ''), label: String(key ?? '未知类目'), color: 'var(--dsw-alias-label-secondary)' }
}

/** Chinese label for one bucket key. */
function contextBucketLabel(key) {
  return contextBucketMeta(key).label
}

/** Warn above 80% of the window, danger above 95%. */
function contextTone(ratio) {
  const value = Number(ratio ?? 0)
  if (!Number.isFinite(value)) return undefined
  if (value >= 0.95) return 'error'
  if (value >= 0.8) return 'warn'
  return undefined
}

/** The accent that matches `contextTone`. */
function contextAccent(ratio) {
  const tone = contextTone(ratio)
  if (tone === 'error') return 'var(--dsw-alias-state-error-primary)'
  if (tone === 'warn') return 'var(--dsw-alias-state-warn-primary)'
  return 'var(--dsw-alias-brand-primary)'
}

/** `+1,234` / `−56` for a signed token delta. */
function contextDelta(value) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number) || number === 0) return '0'
  return `${number > 0 ? '+' : '−'}${exact(Math.abs(number))}`
}

/** `第 3 轮`, or a dash when the Host never reported a turn number. */
function contextTurnLabel(turn) {
  const value = Number(turn ?? -1)
  if (!Number.isFinite(value) || value < 0) return '—'
  return `第 ${value} 轮`
}

/** Trim a description so a table row cannot be pushed around by a long label. */
function contextClip(text, max) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(1, max - 1))}…`
}

/**
 * Trend samples for one scope/measure pair.
 *
 * @param series - `series[]` from the payload: one point per settled request.
 * @param scope - `turn` (this turn only) | `round` (one row per turn) | `all` (every request).
 * @param measure - `abs` (occupancy) | `delta` (change between neighbouring samples).
 * @param currentTurn - turn number of the newest sample, or -1.
 * @returns `{ points, note, reason }`; `points` empty means "explain `reason`".
 */
function contextTrend(series, scope, measure, currentTurn) {
  const samples = (Array.isArray(series) ? series : []).filter((row) => row !== null && typeof row === 'object')
  if (samples.length === 0) {
    return { points: [], note: '', reason: '本会话还没有已结算的模型请求，因此没有可画的上下文样本。' }
  }

  let rows
  if (scope === 'turn') {
    if (currentTurn < 0) return { points: [], note: '', reason: '宿主没有上报轮次号，无法只取当前轮。' }
    const mine = samples.filter((row) => Number(row.turn ?? -1) === currentTurn)
    if (mine.length === 0) {
      return { points: [], note: '', reason: `第 ${currentTurn} 轮还没有已结算的请求，换到「轮次」或「全文」可以看到历史。` }
    }
    rows = mine.map((row) => ({ label: String(row.label ?? ''), value: Number(row.usedTokens ?? 0) }))
  } else if (scope === 'round') {
    // One bar per turn: the peak occupancy during it. The peak is used rather
    // than the last sample because a compaction inside the turn would otherwise
    // make the turn look smaller than it was.
    const byTurn = new Map()
    for (const row of samples) {
      const turn = Number(row.turn ?? -1)
      const used = Number(row.usedTokens ?? 0)
      const kept = byTurn.get(turn)
      if (kept === undefined) byTurn.set(turn, { label: contextTurnLabel(turn), value: used })
      else if (used > kept.value) kept.value = used
    }
    rows = [...byTurn.values()]
  } else {
    rows = samples.map((row) => ({ label: String(row.label ?? ''), value: Number(row.usedTokens ?? 0) }))
  }

  let note = ''
  if (measure === 'delta') {
    let previous = 0
    rows = rows.map((row, index) => {
      const change = index === 0 ? row.value : row.value - previous
      previous = row.value
      return { label: row.label, value: Math.max(0, change) }
    })
    note = '增量取相邻样本之差；上下文压缩造成的收缩按 0 显示。'
  }
  if (scope === 'round') note = `${note}${note === '' ? '' : ' '}同一轮有多次请求时取该轮峰值。`

  return { points: rows.slice(-CONTEXT_TREND_LIMIT), note, reason: '' }
}

/**
 * One collapsible category row of the context browser.
 *
 * Collapsed it shows the category, its item count and its share; expanded it
 * lists the largest members the payload already carries. The drill-down button
 * opens real paging against `/usage/context/events`, which is the only place
 * the full history exists.
 */
function ContextBucketRow({ row, totalTokens, onDrill }) {
  const [open, setOpen] = useState(false)
  const meta = contextBucketMeta(row.category)
  const rowTokens = Number(row.tokens ?? 0)
  const ratio = totalTokens > 0 ? rowTokens / totalTokens : 0
  const items = Array.isArray(row.items) ? row.items : []
  const count = Number(row.count ?? items.length)

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 3, padding: '3px 0' } },
    h(
      'div',
      {
        className: 'mydsh-inline',
        style: { justifyContent: 'space-between', cursor: 'pointer' },
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        onClick: () => setOpen((value) => !value),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen((value) => !value)
          }
        },
      },
      h(
        'span',
        { className: 'mydsh-inline', style: { minWidth: 0 } },
        h('span', { className: 'mydsh-muted', style: { width: 10 } }, open ? '▾' : '▸'),
        h('span', { className: 'mydsh-dot', style: { background: meta.color } }),
        h('span', { className: 'mydsh-truncate', title: row.preview ?? '' }, meta.label),
        h(Badge, null, `${exact(count)} 项`),
      ),
      h(
        'span',
        { className: 'mydsh-inline', style: { flexShrink: 0 } },
        h(
          'span',
          {
            className: 'mydsh-muted',
            title: `${exact(rowTokens)} tokens · 占已用 ${percent(ratio)}`,
            style: { fontVariantNumeric: 'tabular-nums' },
          },
          `${tokens(rowTokens, 'zh')} · ${percent(ratio)}`,
        ),
        h(Button, {
          size: 'sm',
          variant: 'ghost',
          title: `分页查看「${meta.label}」的全部事件`,
          onClick: (event) => {
            event.stopPropagation()
            onDrill(row.category)
          },
        }, '明细'),
      ),
    ),
    h(Bar, { ratio, accent: meta.color, height: 3 }),
    open === true && items.length === 0
      ? h('div', { className: 'mydsh-muted', style: { paddingLeft: 16 } }, '这一类没有可展开的成员，用「明细」分页查看全部事件。')
      : null,
    open === true && items.length > 0
      ? h(
          'div',
          { className: 'mydsh-list mydsh-scroll', style: { marginTop: 4, paddingLeft: 16 } },
          items.map((item, index) =>
            h(
              'div',
              { key: `${item.seq ?? index}`, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h(
                'div',
                { className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
                h(
                  'span',
                  { className: 'mydsh-truncate mydsh-muted', title: item.preview ?? '' },
                  contextClip(item.preview ?? '（无内容预览）', 96),
                ),
                h(
                  'span',
                  { className: 'mydsh-muted', style: { flexShrink: 0, fontVariantNumeric: 'tabular-nums' }, title: `${exact(item.tokens)} tokens · ${contextTurnLabel(item.turn)}` },
                  tokens(item.tokens, 'zh'),
                ),
              ),
              h(Bar, { ratio: rowTokens > 0 ? Number(item.tokens ?? 0) / rowTokens : 0, accent: meta.color, height: 2 }),
            ),
          ),
        )
      : null,
  )
}

/**
 * Paged drill-down for one category.
 *
 * The payload ships only the newest 400 events, so anything deeper has to come
 * from `GET /usage/context/events`. This modal is that route and nothing else:
 * one page at a time, previous/next, no client-side guessing at the total.
 */
function ContextDrill({ sessionId, category, onClose }) {
  const [page, setPage] = useState(0)
  const path = `/usage/context/events?sessionId=${encodeURIComponent(sessionId)}&category=${encodeURIComponent(category)}&offset=${page * CONTEXT_DRILL_PAGE}&limit=${CONTEXT_DRILL_PAGE}`
  const poll = usePoll(path, 0, [sessionId, category])
  const total = Number(poll.data?.total ?? 0)
  const items = Array.isArray(poll.data?.items) ? poll.data.items : []
  const pages = Math.max(1, Math.ceil(total / CONTEXT_DRILL_PAGE))
  const label = contextBucketLabel(category)

  const body = (() => {
    if (poll.error !== undefined) return h(Note, { tone: 'error' }, `读取明细失败：${poll.error}`)
    if (poll.data === undefined) return h(Empty, null, poll.loading ? t().loading : t().empty)
    if (items.length === 0) return h(Empty, null, '这一类还没有事件记录。')
    return h(
      'div',
      { className: 'mydsh-list mydsh-scroll', style: { maxHeight: 420 } },
      items.map((item, index) =>
        h(
          'div',
          { key: `${item.seq ?? index}`, className: 'mydsh-row', style: { alignItems: 'flex-start' } },
          h('span', { className: 'mydsh-muted mydsh-mono', style: { flexShrink: 0 } }, when(item.at, activeLocale())),
          h(
            'div',
            { className: 'mydsh-grow' },
            h(
              'div',
              { className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
              h('span', { className: 'mydsh-truncate', title: item.description ?? '' }, item.description ?? label),
              h(
                'span',
                { className: 'mydsh-muted', style: { flexShrink: 0, fontVariantNumeric: 'tabular-nums' } },
                `${tokens(item.tokens, 'zh')} · ${contextTurnLabel(item.turn)}`,
              ),
            ),
            h('div', { className: 'mydsh-muted mydsh-mono' }, `#${exact(item.seq)}`),
          ),
        ),
      ),
    )
  })()

  return h(
    Modal,
    {
      title: `上下文明细 · ${label}`,
      onClose,
      footer: h(
        'div',
        { className: 'mydsh-inline', style: { justifyContent: 'space-between', width: '100%' } },
        h(
          'span',
          { className: 'mydsh-muted' },
          total === 0 ? '共 0 条' : `共 ${exact(total)} 条 · 第 ${page + 1} / ${pages} 页`,
        ),
        h(
          'span',
          { className: 'mydsh-inline' },
          h(Button, { size: 'sm', disabled: page <= 0, onClick: () => setPage((value) => Math.max(0, value - 1)) }, '上一页'),
          h(Button, { size: 'sm', disabled: page + 1 >= pages, onClick: () => setPage((value) => value + 1) }, '下一页'),
          h(Button, { size: 'sm', variant: 'ghost', onClick: onClose }, t().close),
        ),
      ),
    },
    body,
  )
}

/**
 * The event flow: newest first, filterable by category, revealed page by page.
 *
 * `loadMore` only widens the window on the events already in hand. The payload
 * carries the newest slice of the log; deeper history is the drill-down's job,
 * and saying so is more useful than a button that silently stops working.
 */
function ContextEventList({ events }) {
  const [category, setCategory] = useState('')
  const [visible, setVisible] = useState(CONTEXT_EVENT_PAGE)
  const rows = (Array.isArray(events) ? events : []).filter((row) => row !== null && typeof row === 'object')

  useEffect(() => {
    setVisible(CONTEXT_EVENT_PAGE)
  }, [category])

  const filtered = rows.slice().reverse().filter((row) => category === '' || row.category === category)
  const shown = filtered.slice(0, visible)
  const options = [{ value: '', label: '全部类目' }].concat(
    CONTEXT_BUCKETS.map((row) => ({ value: row.key, label: row.label })),
  )

  if (rows.length === 0) return h(Empty, null, '本会话还没有上下文事件。')

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
      h(Select, { value: category, onChange: setCategory, options, width: 'md' }),
      h('span', { className: 'mydsh-muted' }, `${exact(shown.length)} / ${exact(filtered.length)} 条`),
    ),
    shown.length === 0
      ? h(Empty, null, '这个类目在已载入的事件里没有记录。')
      : h(
          'div',
          { className: 'mydsh-scroll' },
          h(
            'table',
            { className: 'mydsh-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, '时间'),
                h('th', null, '类目'),
                h('th', null, '描述'),
                h('th', { 'data-num': 'true' }, 'tokens'),
                h('th', { 'data-num': 'true' }, 'delta'),
                h('th', null, '轮次'),
              ),
            ),
            h(
              'tbody',
              null,
              shown.map((row, index) =>
                h(
                  'tr',
                  { key: `${row.seq ?? index}` },
                  h('td', { className: 'mydsh-muted', style: { whiteSpace: 'nowrap' } }, when(row.at, activeLocale())),
                  h('td', null, h(Badge, null, contextBucketLabel(row.category))),
                  h(
                    'td',
                    { className: 'mydsh-muted', title: row.description ?? '' },
                    h('div', { className: 'mydsh-truncate', style: { maxWidth: 260 } }, row.description ?? '—'),
                  ),
                  h('td', { 'data-num': 'true', title: `${exact(row.tokens)} tokens` }, tokens(row.tokens, 'zh')),
                  h(
                    'td',
                    { 'data-num': 'true', className: 'mydsh-muted' },
                    Number(row.delta ?? 0) === 0 ? '—' : contextDelta(row.delta),
                  ),
                  h('td', { className: 'mydsh-muted', style: { whiteSpace: 'nowrap' } }, contextTurnLabel(row.turn)),
                ),
              ),
            ),
          ),
        ),
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
      h(
        Button,
        {
          size: 'sm',
          disabled: visible >= filtered.length,
          onClick: () => setVisible((value) => value + CONTEXT_EVENT_PAGE * 2),
        },
        visible >= filtered.length ? '已全部显示' : '加载更多',
      ),
      h('span', { className: 'mydsh-muted' }, '只覆盖本次载入的事件；更早的历史在「上下文本浏览器」按类目下钻查看。'),
    ),
  )
}

/** The context insight tab. */
function ContextView(props) {
  const settings = useSettings()
  const compact = settings?.ui?.compact === true
  const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
  const [mode, setMode] = useState('current')
  const [scope, setScope] = useState('round')
  const [measure, setMeasure] = useState('abs')
  const [drill, setDrill] = useState(undefined)

  const path = sessionId === '' ? null : `/usage/context?sessionId=${encodeURIComponent(sessionId)}&mode=${mode}`
  const poll = usePoll(path, 10000, [sessionId, mode])
  const data = poll.data

  // Variadic on purpose: the body below passes one argument per section, and a
  // single-parameter version would silently render only the first one.
  const page = (...children) =>
    h(
      'div',
      { className: `mydsh-root mydsh-page${compact ? ' mydsh-compact' : ''}`, style: { padding: '12px 16px 24px' } },
      h(Styles),
      h(
        'header',
        { className: 'mydsh-head' },
        h(
          'div',
          null,
          h('h2', null, '上下文'),
          h('p', null, '按供应商上报的口径，拆开本会话占用的上下文窗口'),
        ),
        h(
          'div',
          { className: 'mydsh-inline' },
          h(Segmented, {
            value: mode,
            onChange: setMode,
            options: [
              { value: 'current', label: '当前占压' },
              { value: 'next', label: '下一次请求' },
            ],
          }),
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => poll.reload() }, `⟳ ${t().refresh}`),
        ),
      ),
      // Spread as siblings: each section is an independent child, so React does
      // not require keys on a bare array and the order stays the source order.
      ...children,
    )

  if (sessionId === '') {
    return page(h(Note, null, '没有会话标识：这个视图需要挂在某个会话上才能读到上下文。'))
  }
  if (poll.error !== undefined && data === undefined) {
    return page(
      h(
        Card,
        { title: '上下文占用' },
        h(Note, { tone: 'error' }, `读取上下文失败：${poll.error}`),
        h(Button, { onClick: () => poll.reload() }, '重试'),
      ),
    )
  }
  if (data === undefined) {
    return page(h(Card, { title: '上下文占用' }, h(Empty, null, poll.loading ? t().loading : t().empty)))
  }

  const available = data.available === true
  const usedTokens = Number(data.usedTokens ?? 0)
  const windowTokens = Number(data.windowTokens ?? 0)
  const ratio = Number(data.ratio ?? 0)
  const tone = contextTone(ratio)
  const accent = contextAccent(ratio)
  const provider = typeof data.provider === 'string' ? data.provider : ''
  const model = typeof data.model === 'string' ? data.model : ''
  const events = Array.isArray(data.events) ? data.events : []
  const browsers = (Array.isArray(data.browsers) ? data.browsers : []).slice().sort((left, right) => {
    const order = (row) => {
      const index = CONTEXT_BUCKETS.findIndex((entry) => entry.key === row?.category)
      return index < 0 ? CONTEXT_BUCKETS.length : index
    }
    return order(left) - order(right)
  })
  const injectedCount = events.filter((row) => row?.category === 'injected').length

  const known = new Map((Array.isArray(data.buckets) ? data.buckets : []).map((row) => [row?.key, row]))
  const bucketRows = CONTEXT_BUCKETS.map((meta) => {
    const row = known.get(meta.key)
    return {
      meta,
      tokens: Number(row?.tokens ?? 0),
      ratio: Number(row?.ratio ?? 0),
    }
  })

  const series = Array.isArray(data.series) ? data.series : []
  const lastPoint = series.length > 0 ? series[series.length - 1] : undefined
  const currentTurn = Number(lastPoint?.turn ?? -1)
  const currentStep = Number(lastPoint?.step ?? -1)
  const trend = contextTrend(series, scope, measure, currentTurn)

  return page(
    !available
      ? h(
          Note,
          { tone: 'warn' },
          '本会话还没有用量记录：宿主没有读到供应商上报的 prompt 大小，也没有可估算的会话日志。发一条消息后再回来。',
        )
      : null,

    h(
      Card,
      {
        title: '上下文占用',
        sub: `${provider === '' ? '供应商未上报' : provider} / ${model === '' ? '模型未上报' : model}`,
        actions: h(
          'span',
          { className: 'mydsh-muted' },
          data.mode === 'next' ? '口径：我们的估算' : '口径：供应商上报',
        ),
      },
      h(
        'div',
        { className: 'mydsh-grid', 'data-cols': '4' },
        h(Stat, {
          label: '已用 tokens',
          value: tokens(usedTokens, 'zh'),
          foot: `${exact(usedTokens)} tokens`,
          accent: 'var(--dsw-alias-brand-primary)',
          title: `${exact(usedTokens)} tokens`,
        }),
        h(Stat, {
          label: '上下文窗口',
          value: windowTokens > 0 ? tokens(windowTokens, 'zh') : '未知',
          foot: windowTokens > 0 ? `${exact(windowTokens)} tokens` : '宿主没有上报窗口大小',
          accent: 'var(--dsw-alias-state-business-primary)',
          title: windowTokens > 0 ? `${exact(windowTokens)} tokens` : undefined,
        }),
        h(Stat, {
          label: '占用占比',
          value: windowTokens > 0 ? percent(ratio) : '—',
          foot: '> 80% 警告 · > 95% 危险',
          accent,
          title: `${exact(usedTokens)} / ${windowTokens > 0 ? exact(windowTokens) : '未知'}`,
        }),
        h(Stat, {
          label: '上下文事件',
          value: exact(events.length),
          foot: `注入 ${exact(injectedCount)} 项`,
          accent: 'var(--dsw-alias-state-success-primary)',
        }),
      ),
      h(Bar, { ratio: windowTokens > 0 ? ratio : 0, accent, height: 8 }),
      h(
        'div',
        { className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
        h('span', { className: 'mydsh-mono mydsh-muted' }, `${exact(usedTokens)} / ${windowTokens > 0 ? exact(windowTokens) : '—'} tokens`),
        h(Badge, { tone }, windowTokens > 0 ? percent(ratio) : '窗口未知'),
      ),
      h(
        'div',
        { className: 'mydsh-muted' },
        '下一次请求的实际占用会包含系统提示与工具定义，通常大于这里的数字；',
        `宿主给出的下一次请求估算为 ${tokens(data.estimateTokens, 'zh')}，供应商上报值为 ${tokens(data.reportedTokens, 'zh')}。`,
        '压缩后的上下文窗口宿主暂未提供预估。',
      ),
      tone === undefined
        ? null
        : h(
            Note,
            { tone },
            tone === 'error'
              ? '上下文已超过窗口的 95%，下一步很可能触发压缩或截断。'
              : '上下文已超过窗口的 80%，建议先收尾当前话题。',
          ),
    ),

    h(
      'div',
      { className: 'mydsh-split' },
      h(
        Card,
        { title: 'Token 构成', sub: '七类构成；点击下面的类目可下钻到事件明细' },
        available === false || bucketRows.every((row) => row.tokens === 0)
          ? h(Empty, null, '没有可拆开的构成：宿主还读不到这个会话的上下文。')
          : h(
              'div',
              null,
              h(
                'div',
                { className: 'mydsh-inline', style: { alignItems: 'flex-start', gap: 14 } },
                h(Donut, {
                  slices: bucketRows.filter((row) => row.tokens > 0).map((row) => ({ value: row.tokens, color: row.meta.color })),
                  size: 108,
                  label: tokens(usedTokens, 'zh'),
                  sub: windowTokens > 0 ? percent(ratio) : '占窗口',
                }),
                h(
                  'div',
                  { className: 'mydsh-grow' },
                  h(
                    Legend,
                    {
                      items: bucketRows.map((row) => ({
                        label: row.meta.label,
                        color: row.meta.color,
                        percent: tokens(row.tokens, 'zh'),
                        ratio: row.tokens > 0 ? row.tokens / Math.max(1, usedTokens) : 0,
                      })),
                    },
                  ),
                ),
              ),
              h(
                'div',
                { className: 'mydsh-inline', style: { flexWrap: 'wrap', gap: 4, marginTop: 6 } },
                bucketRows
                  .filter((row) => row.tokens > 0)
                  .map((row) =>
                    h(
                      Button,
                      {
                        key: row.meta.key,
                        size: 'sm',
                        variant: 'ghost',
                        title: `查看「${row.meta.label}」的 ${exact(row.tokens)} tokens 明细`,
                        onClick: () => setDrill(row.meta.key),
                      },
                      `${row.meta.label} ›`,
                    ),
                  ),
              ),
            ),
      ),
      h(
        Card,
        {
          title: '上下文趋势',
          sub:
            scope === 'turn'
              ? '当前轮内每次请求的上下文占用'
              : scope === 'round'
                ? '每轮一项'
                : '本会话每次已结算请求',
          actions: h(
            'div',
            { className: 'mydsh-inline' },
            h(Segmented, {
              value: scope,
              onChange: setScope,
              options: [
                { value: 'turn', label: '本轮' },
                { value: 'round', label: '轮次' },
                { value: 'all', label: '全文' },
              ],
            }),
            h(Segmented, {
              value: measure,
              onChange: setMeasure,
              options: [
                { value: 'abs', label: '绝对值' },
                { value: 'delta', label: '增量' },
              ],
            }),
          ),
        },
        trend.points.length === 0
          ? h(Empty, null, trend.reason)
          : scope === 'all'
            ? h(LineChart, { points: trend.points, height: 160, format: (value) => tokens(value, 'zh') })
            : h(BarChart, { points: trend.points, height: 160, format: (value) => tokens(value, 'zh') }),
        h(
          'div',
          { className: 'mydsh-muted' },
          trend.note === '' ? '样本来自每次已结算请求；压缩会让曲线掉下来，这是真实变化而不是缺口。' : trend.note,
        ),
      ),
    ),

    h(
      Card,
      {
        title: '上下文本浏览器',
        sub: `按类目折叠，共 ${exact(browsers.length)} 个类目；每项是进入模型的一条消息或一次工具结果`,
      },
      h(
        'div',
        { className: 'mydsh-muted' },
        `三项口径：当前占压 ${tokens(usedTokens, 'zh')}（本页数字）、下一次请求 ${tokens(data.estimateTokens, 'zh')}（宿主估算）、压缩后 宿主未提供。`,
      ),
      browsers.length === 0
        ? h(Empty, null, available ? '宿主没有给出可浏览的类目。' : '本会话还没有可浏览的上下文明细。')
        : h(
            'div',
            { className: 'mydsh-list mydsh-scroll', style: { maxHeight: 360 } },
            browsers.map((row) =>
              h(ContextBucketRow, {
                key: String(row.category ?? 'unknown'),
                row,
                totalTokens: usedTokens,
                onDrill: setDrill,
              }),
            ),
          ),
    ),

    h(
      Card,
      {
        title: '上下文事件流水',
        sub: `本会话最近 ${exact(events.length)} 条事件，按时间倒序`,
      },
      h(ContextEventList, { events }),
      h(
        'div',
        { className: 'mydsh-muted' },
        'delta 是宿主随事件给出的增量字段；当前宿主每个事件都上报 0，所以这一列显示 —，不用 0 冒充增长。',
      ),
    ),

    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h('span', { className: 'mydsh-muted' }, `当前轮 ${currentTurn < 0 ? '—' : currentTurn} · 当前步 ${currentStep < 0 ? '—' : currentStep}`),
      h('span', { className: 'mydsh-muted' }, '数据每 10 秒刷新一次，页面隐藏时不请求'),
    ),

    drill === undefined
      ? null
      : h(ContextDrill, { sessionId, category: drill, onClose: () => setDrill(undefined) }),
  )
}

    // ===== 52-view-usage.js =====
/**
 * The conversation's "用量" view.
 *
 * Everything here is read-only: this seat is a projection of what the Host has
 * already folded from the session log, and a tab that also wrote settings would
 * make "open the tab" a mutating action. Three sources, each answering one
 * question and nothing else:
 *
 *   /usage/sessions     — one row per session: request/token/cost totals, first
 *                         and last activity, dominant provider and model.
 *   /usage/summary      — the same window, dimensioned by session; the row for
 *                         this session carries its per-model children, which is
 *                         exactly the "按模型" table.
 *   /usage/geek         — the recent request pool with TTFT/speed and the one
 *                         live frame for a request that has not settled.
 *   /usage/context      — the current context composition and its trend.
 *
 * Degradation is explicit rather than accidental: every figure is read through
 * a `—` fallback, the range falls back to "today" while the session's first
 * activity is still unknown, and a missing `sessionId` renders an explanation
 * instead of an empty chart grid. The tab must never be the thing that breaks a
 * conversation.
 */

/** The seven context buckets, in the order the host stacks them. */
const USAGE_BUCKET_COLORS = [
  'var(--dsw-alias-brand-primary)',
  'var(--dsw-alias-state-success-primary)',
  'var(--dsw-alias-state-warn-primary)',
  'var(--dsw-alias-state-error-primary)',
  'color-mix(in srgb, var(--dsw-alias-brand-primary) 56%, var(--dsw-alias-state-success-primary))',
  'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 58%, var(--dsw-alias-brand-primary))',
  'color-mix(in srgb, var(--dsw-alias-label-secondary) 72%, transparent)',
]

/** The bucket labels the host sends are English; these are the panel's own. */
const USAGE_BUCKET_NAMES = {
  systemPrompt: '系统提示词',
  toolDefinitions: '工具定义',
  userMessages: '用户消息',
  injected: '注入内容',
  skills: '技能注入',
  assistantMessages: '助手消息',
  toolResults: '工具结果',
}

/** Range choices for this view. "会话" needs the first-activity time, which is
 * why it is only offered once the session row is known. */
const USAGE_VIEW_RANGES = [
  { value: 'session', label: '本次会话' },
  { value: 'today', label: '今日' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
]

/** A finite number or `undefined`, so "missing" and "zero" stay apart. */
function usageFinite(value) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/** A percentage that shows `—` instead of inventing 0% for missing input. */
function usageRatioText(value) {
  const number = usageFinite(value)
  return number === undefined ? '—' : percent(number)
}

/** Speed in tok/s, or `—`; the host sends 0 for "not measured". */
function usageSpeed(value) {
  const number = usageFinite(value)
  return number === undefined || number <= 0 ? '—' : `${Math.round(number)} tok/s`
}

/** Seconds with one decimal, or `—`. */
function usageSeconds(value) {
  const number = usageFinite(value)
  return number === undefined || number <= 0 ? '—' : `${(number / 1000).toFixed(1)}s`
}

/** A collapsed-by-default disclosure row, used by the per-turn log. */
function UsageDisclosure({ title, meta, children }) {
  const [open, setOpen] = useState(false)
  return h(
    'div',
    { style: { borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
    h(
      'button',
      {
        type: 'button',
        onClick: () => setOpen((value) => !value),
        style: {
          appearance: 'none',
          border: 0,
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          font: 'inherit',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 0',
          cursor: 'pointer',
          textAlign: 'left',
        },
      },
      h('span', { className: 'mydsh-muted', style: { width: 12, flexShrink: 0 } }, open ? '▾' : '▸'),
      h('span', { className: 'mydsh-grow mydsh-truncate' }, title),
      h('span', { className: 'mydsh-muted', style: { flexShrink: 0, fontVariantNumeric: 'tabular-nums' } }, meta),
    ),
    open ? h('div', { style: { padding: '0 0 8px 20px' } }, children) : null,
  )
}

/** The usage view registered on `conversation.view`. */
function UsageView(props) {
  const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
  const locale = activeLocale()
  const [range, setRange] = useState('session')
  const [trend, setTrend] = useState(false)
  const [at, setAt] = useState(0)

  // The session row is the only place `firstAt` comes from, and "本次会话" cannot
  // be expressed until it is known. It is therefore polled over the widest
  // preset, which is also what makes the per-session price list complete.
  const sessionsWide = usePoll(`/usage/sessions?range=90d`, 30000, [])
  const sessionRow = (sessionsWide.data?.sessions ?? []).find((row) => row.id === sessionId)

  // Until the first activity is known, "会话" degrades to "today": a wrong window
  // that is small is better than waiting on a spinner to show any number.
  const firstAt = usageFinite(sessionRow?.firstAt)
  const effectiveRange = range === 'session' && firstAt === undefined ? 'today' : range
  // `to` is rounded up to the next minute, never taken from `Date.now()` raw:
  // the poll hook re-fetches whenever its path changes, so a per-render clock
  // would mean a fetch per render. The window still advances on its own, once a
  // minute, which is finer than the 20 s poll needs to look current.
  const toMs = Math.ceil(Date.now() / 60000) * 60000
  const query =
    effectiveRange === 'session'
      ? `range=custom&from=${firstAt ?? 0}&to=${toMs}`
      : usageQuery(effectiveRange, '', '')

  const geekPool = 50
  const summary = usePoll(`/usage/summary?${query}&dim=session`, 20000, [query])
  const geek = usePoll(
    sessionId === '' ? null : `/usage/geek?sessionId=${encodeURIComponent(sessionId)}&pool=${geekPool}`,
    15000,
    [sessionId, geekPool],
  )
  const context = usePoll(
    sessionId === '' ? null : `/usage/context?sessionId=${encodeURIComponent(sessionId)}`,
    15000,
    [sessionId],
  )

  // "统计截至" is when the page last received a number, not the host's clock: a
  // stale tab must not claim to be current.
  useEffect(() => {
    if (sessionsWide.data !== undefined || summary.data !== undefined) setAt(Date.now())
  }, [sessionsWide.data, summary.data])

  const reloadAll = () => {
    sessionsWide.reload()
    summary.reload()
    geek.reload()
    context.reload()
  }

  // --- derived figures -----------------------------------------------------

  const dimRow = (summary.data?.dims?.session ?? []).find((row) => row.key === sessionId)
  const requestCount = usageFinite(sessionRow?.requests) ?? usageFinite(dimRow?.requests)
  const failed = usageFinite(sessionRow?.failedRequests)
  const totalTokens = usageFinite(sessionRow?.totalTokens) ?? usageFinite(dimRow?.totalTokens)
  const inputTokens = usageFinite(sessionRow?.inputTokens)
  const outputTokens = usageFinite(sessionRow?.outputTokens)
  const cacheRead = usageFinite(sessionRow?.cacheReadTokens)
  // `hitRate` is the host's own figure; recomputing is only a fallback for a row
  // that predates it, and `usageHitRate` is the shared helper from this module.
  const hitRate =
    usageFinite(sessionRow?.hitRate) ??
    (cacheRead !== undefined && inputTokens !== undefined ? usageHitRate(cacheRead, inputTokens) : undefined)
  const currency = sessionRow?.currency ?? 'CNY'
  const cost = usageFinite(sessionRow?.cost)
  const avgSpeed = usageFinite(geek.data?.avg?.speed)
  const poolRows = (geek.data?.requests ?? []).slice(0, geekPool)
  const live = geek.data?.stream ?? null
  const failedInPool = poolRows.filter((row) => usageRequestFailed(row.status)).length

  const ctx = context.data
  const ctxBuckets = (ctx?.buckets ?? []).map((bucket, index) => ({
    key: bucket.key,
    label: USAGE_BUCKET_NAMES[bucket.key] ?? bucket.label ?? bucket.key,
    tokens: usageFinite(bucket.tokens) ?? 0,
    ratio: usageFinite(bucket.ratio) ?? 0,
    color: USAGE_BUCKET_COLORS[index % USAGE_BUCKET_COLORS.length],
  }))
  const ctxSeries = (ctx?.series ?? []).map((point) => ({
    label: point.label ?? '',
    value: usageFinite(point.usedTokens) ?? 0,
  }))

  // Per-turn grouping: the geek pool carries `turn` per request, which is the
  // only request-level grouping the contract exposes. Turns are newest first,
  // matching the request table.
  const turns = (() => {
    const map = new Map()
    for (const row of poolRows) {
      const key = typeof row.turn === 'number' && row.turn >= 0 ? row.turn : -1
      const entry = map.get(key) ?? { turn: key, requests: [], tokens: 0, cacheRead: 0 }
      entry.requests.push(row)
      entry.tokens += (usageFinite(row.inputTokens) ?? 0) + (usageFinite(row.outputTokens) ?? 0)
      entry.cacheRead += usageFinite(row.cacheReadTokens) ?? 0
      map.set(key, entry)
    }
    return [...map.values()].sort((left, right) => right.turn - left.turn)
  })()

  // --- render --------------------------------------------------------------

  if (sessionId === '') {
    return h(
      'div',
      { className: 'mydsh-root mydsh-page', style: { padding: '16px 18px' } },
      h(Styles),
      h(Note, null, locale === 'zh' ? '还没有选中会话：打开或新建一个会话后，这里会显示它的用量。' : 'No session selected yet.'),
    )
  }

  return h(
    'div',
    { className: 'mydsh-root mydsh-page', style: { padding: '12px 16px 24px' } },
    h(Styles),

    // toolbar -------------------------------------------------------------
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 10 } },
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Segmented, { value: range, onChange: setRange, options: USAGE_VIEW_RANGES }),
        range === 'session' && firstAt === undefined
          ? h('span', { className: 'mydsh-muted' }, '会话起点未知，暂按今日统计')
          : null,
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(
          'span',
          { className: 'mydsh-muted' },
          at === 0 ? '统计读取中…' : `统计截至 ${new Date(at).toTimeString().slice(0, 5)}`,
        ),
        h(Button, { size: 'sm', variant: 'ghost', onClick: reloadAll }, `⟳ ${t().refresh}`),
      ),
    ),

    sessionsWide.error === undefined ? null : h(Note, { tone: 'error' }, `会话用量读取失败：${sessionsWide.error}`),
    summary.error === undefined || summary.error === sessionsWide.error
      ? null
      : h(Note, { tone: 'error' }, `区间用量读取失败：${summary.error}`),

    // 6 headline figures ---------------------------------------------------
    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '6' },
      h(Stat, {
        label: '请求数',
        value: requestCount === undefined ? '—' : exact(requestCount),
        foot: failed === undefined ? '失败 —' : `失败 ${exact(failed)}`,
        accent: 'var(--dsw-alias-brand-primary)',
      }),
      h(Stat, {
        label: '总 tokens',
        value: totalTokens === undefined ? '—' : tokens(totalTokens),
        foot: totalTokens === undefined ? '' : `${exact(totalTokens)} tokens`,
        accent: 'var(--dsw-alias-brand-primary)',
        title: `${exact(totalTokens)} tokens`,
      }),
      h(Stat, {
        label: '输入',
        value: inputTokens === undefined ? '—' : tokens(inputTokens),
        foot: inputTokens === undefined ? '' : exact(inputTokens),
        accent: 'var(--dsw-alias-state-success-primary)',
      }),
      h(Stat, {
        label: '输出',
        value: outputTokens === undefined ? '—' : tokens(outputTokens),
        foot: outputTokens === undefined ? '' : exact(outputTokens),
        accent: 'var(--dsw-alias-state-warn-primary)',
      }),
      h(Stat, {
        label: '缓存命中率',
        value: usageRatioText(hitRate),
        foot: cacheRead === undefined ? '缓存读 —' : `缓存读 ${tokens(cacheRead)}`,
        accent: 'var(--dsw-alias-state-success-primary)',
      }),
      h(Stat, {
        label: 'Token 速度',
        value: usageSpeed(avgSpeed),
        foot: cost === undefined ? '费用 —' : `${money(cost, currency)} · 近 ${poolRows.length} 次平均`,
        accent: 'var(--dsw-alias-state-error-primary)',
        title: '取最近请求池里有速度数据的请求平均',
      }),
    ),

    // per-model table ------------------------------------------------------
    h(
      Card,
      { title: '按模型', sub: '本会话在当前区间内的模型分布' },
      (dimRow?.sub ?? []).length === 0
        ? h(Empty, null, sessionRow === undefined ? (sessionsWide.loading ? t().loading : '本次会话还没有用量记录') : '这个区间内没有模型用量')
        : h(
            'div',
            { className: 'mydsh-scroll' },
            h(
              'table',
              { className: 'mydsh-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, '模型'),
                  h('th', { 'data-num': 'true' }, '请求数'),
                  h('th', { 'data-num': 'true' }, '入'),
                  h('th', { 'data-num': 'true' }, '出'),
                  h('th', { 'data-num': 'true' }, '缓读'),
                  h('th', { 'data-num': 'true' }, '命中率'),
                  h('th', { 'data-num': 'true' }, '费用'),
                ),
              ),
              h(
                'tbody',
                null,
                (dimRow.sub ?? []).map((row) =>
                  h(
                    'tr',
                    { key: row.key, title: row.key },
                    h('td', { className: 'mydsh-truncate', style: { maxWidth: 240 } }, row.label === '' ? row.key : row.label),
                    h('td', { 'data-num': 'true' }, exact(row.requests)),
                    h('td', { 'data-num': 'true' }, tokens(row.inputTokens)),
                    h('td', { 'data-num': 'true' }, tokens(row.outputTokens)),
                    h('td', { 'data-num': 'true' }, tokens(row.cacheReadTokens)),
                    h('td', { 'data-num': 'true' }, usageRatioText(row.hitRate)),
                    h('td', { 'data-num': 'true' }, money(row.cost, currency)),
                  ),
                ),
              ),
            ),
          ),
      sessionRow === undefined
        ? null
        : h(
            'div',
            { className: 'mydsh-muted' },
            `会话 ${sessionRow.id} · ${sessionRow.provider || '—'} · 首次 ${when(sessionRow.firstAt)} · 最近 ${when(sessionRow.lastAt)} · ${exact(sessionRow.turns)} 轮`,
          ),
    ),

    // current context ------------------------------------------------------
    h(
      Card,
      {
        title: '当前上下文',
        sub: ctx?.available === true ? `${ctx.provider || '—'} · ${ctx.model || '—'}` : '宿主还没有本会话的上下文读数',
        actions: h(
          Button,
          { size: 'sm', variant: 'ghost', disabled: ctxSeries.length === 0, onClick: () => setTrend((value) => !value) },
          trend ? '收起趋势' : '打开上下文趋势',
        ),
      },
      ctx?.available !== true
        ? h(Empty, null, context.loading ? t().loading : context.error ?? '暂时读不到上下文占用')
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h(
              'div',
              { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
              h(
                'span',
                { style: { fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } },
                `${tokens(ctx.usedTokens)} / ${tokens(ctx.windowTokens)} tokens`,
              ),
              h('span', { className: 'mydsh-muted' }, `${usageRatioText(ctx.ratio)} 上下文已用`),
            ),
            h(Bar, { ratio: Number(ctx.ratio ?? 0), height: 8 }),
            ctxBuckets.length === 0
              ? h(Empty, null, '这个会话还没有可拆分的上下文构成')
              : h(
                  'div',
                  { className: 'mydsh-split' },
                  h(Donut, {
                    slices: ctxBuckets.map((bucket) => ({ value: bucket.tokens, color: bucket.color })),
                    label: tokens(ctx.usedTokens),
                    sub: '上下文',
                  }),
                  h(Legend, {
                    items: ctxBuckets.map((bucket) => ({
                      label: bucket.label,
                      color: bucket.color,
                      value: tokens(bucket.tokens),
                      ratio: bucket.ratio,
                    })),
                  }),
                ),
            trend === true && ctxSeries.length > 0
              ? h(BarChart, { points: ctxSeries, height: 132, format: (value) => tokens(value) })
              : null,
          ),
    ),

    // latest request + live table -----------------------------------------
    h(
      Card,
      { title: '最新请求', sub: '单次请求的耗时与 token，不是会话均值' },
      live !== null
        ? h(
            'div',
            { className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
            h(Badge, { tone: 'warn' }, '进行中'),
            h('span', { className: 'mydsh-muted' }, `${when(live.at)} · ${live.model || '—'} · 已等待 ${usageSeconds(live.streamMs)}`),
          )
        : poolRows.length === 0
          ? h(Empty, null, geek.loading ? t().loading : geek.error ?? '本次会话还没有请求记录')
          : h(
              'div',
              { className: 'mydsh-grid', 'data-cols': '3' },
              h(Stat, {
                label: '输入',
                value: tokens(poolRows[0].inputTokens),
                foot: exact(poolRows[0].inputTokens),
                accent: 'var(--dsw-alias-state-success-primary)',
              }),
              h(Stat, {
                label: '输出',
                value: tokens(poolRows[0].outputTokens),
                foot: exact(poolRows[0].outputTokens),
                accent: 'var(--dsw-alias-state-warn-primary)',
              }),
              h(Stat, {
                label: '缓存命中',
                value: usageRatioText(
                  usageHitRate(poolRows[0].cacheReadTokens, poolRows[0].inputTokens),
                ),
                foot: `缓读 ${tokens(poolRows[0].cacheReadTokens)}`,
                accent: 'var(--dsw-alias-brand-primary)',
              }),
              h(Stat, { label: '首字', value: usageSeconds(poolRows[0].ttftMs), accent: 'var(--dsw-alias-brand-primary)' }),
              h(Stat, { label: '耗时', value: duration(poolRows[0].durationMs), accent: 'var(--dsw-alias-state-warn-primary)' }),
              h(Stat, {
                label: '速度',
                value: usageSpeed(poolRows[0].speed),
                foot: money(poolRows[0].cost, currency),
                accent: 'var(--dsw-alias-state-error-primary)',
              }),
            ),
      poolRows.length === 0
        ? null
        : h(
            'div',
            { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
            h('span', { className: 'mydsh-card-sub' }, `实时请求历史 ${poolRows.length} 条 · 最新优先`),
            failedInPool > 0 ? h(Badge, { tone: 'error' }, `失败 ${failedInPool}`) : null,
          ),
      poolRows.length === 0
        ? null
        : h(
            'div',
            { className: 'mydsh-scroll' },
            h(
              'table',
              { className: 'mydsh-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, '时间'),
                  h('th', null, '状态'),
                  h('th', null, '模型'),
                  h('th', { 'data-num': 'true' }, '首字'),
                  h('th', { 'data-num': 'true' }, '耗时'),
                  h('th', { 'data-num': 'true' }, '速度'),
                  h('th', { 'data-num': 'true' }, '入'),
                  h('th', { 'data-num': 'true' }, '出'),
                  h('th', { 'data-num': 'true' }, '缓读'),
                  h('th', { 'data-num': 'true' }, '费用'),
                ),
              ),
              h(
                'tbody',
                null,
                live !== null
                  ? h(
                      'tr',
                      { key: 'live' },
                      h('td', null, when(live.at)),
                      h('td', null, h(Badge, { tone: 'warn' }, '进行中')),
                      h('td', { className: 'mydsh-truncate', style: { maxWidth: 180 } }, live.model === '' ? '—' : live.model),
                      h('td', { 'data-num': 'true' }, '—'),
                      h('td', { 'data-num': 'true' }, usageSeconds(live.streamMs)),
                      h('td', { 'data-num': 'true' }, '—'),
                      h('td', { 'data-num': 'true' }, live.inputTokens > 0 ? tokens(live.inputTokens) : '—'),
                      h('td', { 'data-num': 'true' }, '—'),
                      h('td', { 'data-num': 'true' }, '—'),
                      h('td', { 'data-num': 'true' }, '—'),
                    )
                  : null,
                poolRows.map((row, index) =>
                  h(
                    'tr',
                    { key: `${row.at}-${index}` },
                    h('td', null, when(row.at)),
                    h(
                      'td',
                      null,
                      h(Badge, { tone: usageRequestTone(row.status) }, usageRequestLabel(row.status)),
                    ),
                    h(
                      'td',
                      { className: 'mydsh-truncate', style: { maxWidth: 180 }, title: `${row.provider || ''} ${row.model || ''}` },
                      row.model === '' ? '—' : row.model,
                    ),
                    h('td', { 'data-num': 'true' }, usageSeconds(row.ttftMs)),
                    h('td', { 'data-num': 'true' }, duration(row.durationMs)),
                    h('td', { 'data-num': 'true' }, usageSpeed(row.speed)),
                    h('td', { 'data-num': 'true' }, tokens(row.inputTokens)),
                    h('td', { 'data-num': 'true' }, tokens(row.outputTokens)),
                    h('td', { 'data-num': 'true' }, tokens(row.cacheReadTokens)),
                    h('td', { 'data-num': 'true' }, money(row.cost, currency)),
                  ),
                ),
              ),
            ),
          ),
    ),

    // per-turn log ---------------------------------------------------------
    h(
      Card,
      {
        title: '请求记录',
        sub: `按轮聚合 · 最近 ${poolRows.length} 次请求里共 ${turns.length} 轮`,
      },
      turns.length === 0
        ? h(Empty, null, geek.loading ? t().loading : geek.error ?? '没有可聚合的请求记录')
        : turns.map((entry) =>
            h(
              UsageDisclosure,
              {
                key: entry.turn,
                title: entry.turn < 0 ? '未归属轮次' : `第 ${entry.turn} 轮`,
                meta: `${entry.requests.length} 个请求 · ${tokens(entry.tokens)} token · 缓读 ${tokens(entry.cacheRead)}`,
              },
              h(
                'table',
                { className: 'mydsh-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, '时间'),
                    h('th', null, '模型'),
                    h('th', { 'data-num': 'true' }, '入'),
                    h('th', { 'data-num': 'true' }, '出'),
                    h('th', { 'data-num': 'true' }, '耗时'),
                    h('th', { 'data-num': 'true' }, '费用'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  entry.requests.map((row, index) =>
                    h(
                      'tr',
                      { key: `${row.at}-${index}` },
                      h('td', null, when(row.at)),
                      h('td', { className: 'mydsh-truncate', style: { maxWidth: 160 } }, row.model === '' ? '—' : row.model),
                      h('td', { 'data-num': 'true' }, tokens(row.inputTokens)),
                      h('td', { 'data-num': 'true' }, tokens(row.outputTokens)),
                      h('td', { 'data-num': 'true' }, duration(row.durationMs)),
                      h('td', { 'data-num': 'true' }, money(row.cost, currency)),
                    ),
                  ),
                ),
              ),
            ),
          ),
    ),

    h(
      'div',
      { className: 'mydsh-muted', style: { fontSize: 10.5 } },
      'token 与费用来自本插件的请求记录；上下文占用来自宿主的会话日志与会话投影。',
    ),
  )
}

    // ===== 53-view-team.js =====
/**
 * Team view (`conversation.view`, props `{ sessionId }`).
 *
 * Read-only on purpose: DSH itself owns the team runtime (`agentTeam` service,
 * sub-agent sessions, the task board), so this page never offers a write
 * control. It draws what `GET /teams/state` reports and nothing else — no
 * optimistic state, no invented member, no local task mutation.
 *
 * Field names are read through small tolerant accessors. The Host's team
 * projection has room to grow (`phase` vs `status`, `ownerName` vs `owner`,
 * `channel` vs `transport`), and a page that only reads one spelling renders
 * dashes on a Host that uses the other. Every accessor still returns
 * `undefined` when nothing matches, so a missing field shows "—" rather than a
 * number nobody measured.
 */

/** Status filter options for members, in the order the strip shows them. */
const TEAM_MEMBER_FILTERS = [
  { value: '', label: '全部' },
  { value: 'running', label: '运行中' },
  { value: 'completed', label: '已完成' },
  { value: 'idle', label: '空闲' },
]

/** Status filter options for tasks. */
const TEAM_TASK_FILTERS = [
  { value: '', label: '全部' },
  { value: 'pending', label: '待处理' },
  { value: 'in_progress', label: '进行中' },
  { value: 'completed', label: '已完成' },
]

/** How many characters of a summary a card shows before clipping. */
const TEAM_SUMMARY_CHARS = 120

/** How many characters of a message the timeline shows when collapsed. */
const TEAM_MESSAGE_CHARS = 220

/** First defined, non-empty value among the candidate fields. */
function teamField(source, keys) {
  if (source === null || typeof source !== 'object') return undefined
  for (const key of keys) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    return value
  }
  return undefined
}

/** A display string from the first field that holds one. */
function teamText(source, keys, fallback) {
  const value = teamField(source, keys)
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback ?? ''
}

/** A finite number from the first numeric field, or `undefined`. */
function teamNumber(source, keys) {
  const value = teamField(source, keys)
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Flatten a DSH `ContentBlock[]` into one plain string.
 *
 * The Host's mailbox records carry `content` as blocks (`{ type: 'text', text }`
 * and friends), not as a string. Rendering the raw array would print
 * `[object Object]`, so every block that carries text is joined and everything
 * else is described by its type instead of being dropped silently.
 */
function teamContentText(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts = []
  for (const block of value) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
    else if (typeof block.content === 'string') parts.push(block.content)
    else if (typeof block.type === 'string') parts.push(`[${block.type}]`)
  }
  return parts.join('\n').trim()
}

/** Read one message body from a string field or from `ContentBlock[]`. */
function teamBodyText(message) {
  const direct = teamField(message, ['summary', 'text', 'message', 'body'])
  if (typeof direct === 'string') return direct
  const blocks = teamField(message, ['content', 'blocks'])
  return teamContentText(blocks)
}

/** Clip a string for a card, keeping the full text in a `title`. */
function teamClip(value, max) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1))}…`
}

/**
 * One member's normalised lifecycle state.
 *
 * The Host may spell it `phase` (`provisioning | active | failed`) or `status`
 * (`running | completed | idle | …`). Both collapse onto the three states the
 * filter strip offers, and an unrecognised value stays `unknown` rather than
 * being rounded into "idle".
 */
function teamMemberState(member) {
  const raw = String(teamField(member, ['status', 'phase', 'state']) ?? '').toLowerCase()
  if (raw === '') return { key: 'unknown', label: '未上报', tone: undefined }
  if (raw === 'running' || raw === 'active' || raw === 'working' || raw === 'busy') {
    return { key: 'running', label: '运行中', tone: 'warn' }
  }
  if (raw === 'completed' || raw === 'done' || raw === 'finished' || raw === 'closed') {
    return { key: 'completed', label: '已完成', tone: 'ok' }
  }
  if (raw === 'idle' || raw === 'waiting' || raw === 'pending' || raw === 'ready') {
    return { key: 'idle', label: '空闲', tone: undefined }
  }
  if (raw === 'failed' || raw === 'error') return { key: 'failed', label: '失败', tone: 'error' }
  if (raw === 'provisioning' || raw === 'starting') return { key: 'running', label: '启动中', tone: 'warn' }
  return { key: 'unknown', label: raw, tone: undefined }
}

/** One task's normalised status. */
function teamTaskState(task) {
  const raw = String(teamField(task, ['status', 'state']) ?? '').toLowerCase()
  if (raw === 'pending' || raw === 'ready' || raw === 'blocked') {
    return { key: 'pending', label: raw === 'blocked' ? '等待依赖' : '待处理', tone: undefined }
  }
  if (raw === 'in_progress' || raw === 'running' || raw === 'active' || raw === 'claimed') {
    return { key: 'in_progress', label: '进行中', tone: 'warn' }
  }
  if (raw === 'completed' || raw === 'done') return { key: 'completed', label: '已完成', tone: 'ok' }
  if (raw === 'deleted') return { key: 'deleted', label: '已删除', tone: undefined }
  if (raw === 'failed' || raw === 'error') return { key: 'failed', label: '失败', tone: 'error' }
  if (raw === '') return { key: 'unknown', label: '未上报', tone: undefined }
  return { key: 'unknown', label: raw, tone: undefined }
}

/** A member's token usage, preferring a pre-summed field. */
function teamMemberTokens(member) {
  const direct = teamNumber(member, ['tokens', 'totalTokens', 'tokenCount'])
  if (direct !== undefined) return direct
  const nested = teamNumber(member.usage, ['totalTokens', 'tokens'])
  if (nested !== undefined) return nested
  const input = teamNumber(member, ['inputTokens'])
  const output = teamNumber(member, ['outputTokens'])
  if (input === undefined && output === undefined) return undefined
  return (input ?? 0) + (output ?? 0)
}

/** A member's wall-clock duration in milliseconds. */
function teamMemberDuration(member) {
  return teamNumber(member, ['durationMs', 'elapsedMs', 'ms', 'totalMs'])
}

/** How many steps a member has taken. */
function teamMemberSteps(member) {
  return teamNumber(member, ['steps', 'stepCount', 'stepsUsed', 'turns'])
}

/** A member's context occupancy as a ratio, when it can be derived. */
function teamMemberRatio(member) {
  const direct = teamNumber(member, ['contextRatio', 'ratio', 'pressureRatio'])
  if (direct !== undefined) return Math.max(0, Math.min(1, direct))
  const used = teamNumber(member, ['usedTokens', 'contextTokens', 'pressureTokens'])
  const window = teamNumber(member, ['windowTokens', 'contextWindow'])
  if (used === undefined || window === undefined || window <= 0) return undefined
  return Math.max(0, Math.min(1, used / window))
}

/**
 * Sum one numeric field across a list, reporting whether anything was measured.
 *
 * `known === 0` is why this returns an object instead of a number: a sum of
 * unknown fields is 0, and printing "0 tokens" for "the Host did not report"
 * would be a fabricated figure.
 */
function teamSum(list, reader) {
  let sum = 0
  let known = 0
  for (const row of list) {
    const value = reader(row)
    if (value === undefined) continue
    sum += value
    known += 1
  }
  return { sum, known }
}

/** Total token usage across members, from `totals` first, then the roster. */
function teamTotalsOf(data) {
  const members = Array.isArray(data?.members) ? data.members : []
  const totals = data?.totals !== null && typeof data?.totals === 'object' ? data.totals : {}
  const membersTotal = teamNumber(totals, ['members', 'memberCount'])
  const runningTotal = teamNumber(totals, ['running', 'active', 'runningMembers'])
  const completedTotal = teamNumber(totals, ['completed', 'done', 'completedMembers'])
  const tokensTotal = teamNumber(totals, ['tokens', 'totalTokens', 'tokenCount'])
  const durationTotal = teamNumber(totals, ['durationMs', 'elapsedMs', 'totalMs'])

  const states = members.map((member) => teamMemberState(member).key)
  const tokens = teamSum(members, teamMemberTokens)
  const durations = teamSum(members, teamMemberDuration)
  const tasks = Array.isArray(data?.tasks) ? data.tasks : []
  const messages = Array.isArray(data?.messages) ? data.messages : []

  return {
    members: membersTotal ?? members.length,
    running: runningTotal ?? states.filter((key) => key === 'running').length,
    completed: completedTotal ?? states.filter((key) => key === 'completed').length,
    tokens: tokensTotal ?? (tokens.known > 0 ? tokens.sum : undefined),
    tokensKnown: tokensTotal !== undefined || tokens.known > 0,
    durationMs: durationTotal ?? (durations.known > 0 ? durations.sum : undefined),
    durationKnown: durationTotal !== undefined || durations.known > 0,
    tasks: tasks.length,
    messages: messages.length,
  }
}

/** One member card: identity, lifecycle, usage, context share, summary. */
function TeamMemberCard({ member, index }) {
  const state = teamMemberState(member)
  const name = teamText(member, ['name', 'label', 'title', 'memberName', 'agentName'], `成员 ${index + 1}`)
  const role = teamText(member, ['role', 'description', 'purpose'], '')
  const summary = teamText(member, ['summary', 'description', 'report', 'lastMessage', 'role'], '')
  const tokensValue = teamMemberTokens(member)
  const durationValue = teamMemberDuration(member)
  const steps = teamMemberSteps(member)
  const ratio = teamMemberRatio(member)
  const model = teamText(member, ['model', 'modelName'], '')
  const provider = teamText(member, ['provider'], '')
  const route = provider !== '' && model !== '' ? `${provider} / ${model}` : model !== '' ? model : ''

  return h(
    Card,
    {
      title: h(
        'span',
        { className: 'mydsh-inline', style: { gap: 6 } },
        h('span', { className: 'mydsh-dot', 'data-tone': state.tone }),
        h('span', { className: 'mydsh-truncate', title: name }, name),
      ),
      sub: route === '' ? '模型未上报' : route,
      actions: h(Badge, { tone: state.tone }, state.label),
    },
    role === '' || role === summary
      ? null
      : h('div', { className: 'mydsh-muted' }, teamClip(role, TEAM_SUMMARY_CHARS)),
    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '3', style: { gap: 6 } },
      h(Stat, {
        label: '用量',
        value: tokensValue === undefined ? '—' : tokens(tokensValue, 'zh'),
        foot: tokensValue === undefined ? '未上报' : `${exact(tokensValue)} tokens`,
        accent: 'var(--dsw-alias-brand-primary)',
      }),
      h(Stat, {
        label: '时长',
        value: durationValue === undefined ? '—' : duration(durationValue, activeLocale()),
        foot: durationValue === undefined ? '未上报' : `${exact(Math.round(durationValue / 1000))} s`,
        accent: 'var(--dsw-alias-state-business-primary)',
      }),
      h(Stat, {
        label: '步数',
        value: steps === undefined ? '—' : exact(steps),
        foot: steps === undefined ? '未上报' : '累计步',
        accent: 'var(--dsw-alias-state-success-primary)',
      }),
    ),
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
      h(
        'div',
        { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
        h('span', { className: 'mydsh-muted' }, '上下文占比'),
        h(
          'span',
          { className: 'mydsh-muted', style: { fontVariantNumeric: 'tabular-nums' } },
          ratio === undefined ? '未上报' : percent(ratio),
        ),
      ),
      h(Bar, {
        ratio: ratio ?? 0,
        accent: ratio !== undefined && ratio >= 0.8 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-brand-primary)',
        height: 4,
      }),
    ),
    h(
      'div',
      { className: 'mydsh-muted', title: summary === '' ? undefined : summary },
      summary === '' ? '（该成员还没有摘要）' : teamClip(summary, TEAM_SUMMARY_CHARS),
    ),
  )
}

/**
 * The task board: one row per task, filterable by status.
 *
 * Dependencies render as the ids the board uses, because those ids are what the
 * Lead and the members see in their own tool output; a resolved title would be
 * prettier and harder to match against a claim message.
 */
function TeamTaskTable({ tasks, filter, onFilter }) {
  const rows = (Array.isArray(tasks) ? tasks : []).filter((task) => {
    if (task === null || typeof task !== 'object') return false
    if (filter === '') return teamTaskState(task).key !== 'deleted'
    return teamTaskState(task).key === filter
  })
  const all = (Array.isArray(tasks) ? tasks : []).filter((task) => task !== null && typeof task === 'object')
  const counts = {
    '': all.filter((task) => teamTaskState(task).key !== 'deleted').length,
    pending: all.filter((task) => teamTaskState(task).key === 'pending').length,
    in_progress: all.filter((task) => teamTaskState(task).key === 'in_progress').length,
    completed: all.filter((task) => teamTaskState(task).key === 'completed').length,
  }

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
      h(Segmented, {
        value: filter,
        onChange: onFilter,
        options: TEAM_TASK_FILTERS.map((option) => ({
          value: option.value,
          label: `${option.label} ${exact(counts[option.value] ?? 0)}`,
        })),
      }),
      h('span', { className: 'mydsh-muted' }, `共 ${exact(all.length)} 个任务`),
    ),
    rows.length === 0
      ? h(Empty, null, filter === '' ? '这个编队还没有任务。' : '当前筛选下没有任务。')
      : h(
          'div',
          { className: 'mydsh-scroll' },
          h(
            'table',
            { className: 'mydsh-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, '标题'),
                h('th', null, '状态'),
                h('th', null, '依赖'),
                h('th', null, '负责人'),
                h('th', null, '更新时间'),
              ),
            ),
            h(
              'tbody',
              null,
              rows.map((task, index) => {
                const state = teamTaskState(task)
                const title = teamText(task, ['subject', 'title', 'name'], `任务 ${index + 1}`)
                const description = teamText(task, ['description', 'detail', 'summary'], '')
                const blockedBy = Array.isArray(task.blockedBy)
                  ? task.blockedBy
                  : Array.isArray(task.dependsOn)
                    ? task.dependsOn
                    : Array.isArray(task.dependencies)
                      ? task.dependencies
                      : []
                const owner = teamText(task, ['ownerName', 'owner', 'assignee', 'assigneeName', 'memberName'], '')
                const updated = teamNumber(task, ['updatedAt', 'updatedAtMs', 'at', 'mtime'])
                const warnings = Array.isArray(task.writeScopeWarnings) ? task.writeScopeWarnings : []
                const ready = task.ready
                return h(
                  'tr',
                  { key: String(task.id ?? index) },
                  h(
                    'td',
                    null,
                    h('div', { className: 'mydsh-truncate', style: { maxWidth: 260 }, title: description === '' ? title : `${title}\n${description}` }, title),
                    warnings.length === 0
                      ? null
                      : h(
                          'div',
                          { style: { marginTop: 2 } },
                          h(Badge, { tone: 'warn', title: warnings.join('\n') }, `写区冲突 ${exact(warnings.length)} 处`),
                        ),
                  ),
                  h(
                    'td',
                    null,
                    h(Badge, { tone: state.tone }, state.label),
                    ready === false ? h('span', { className: 'mydsh-muted', style: { marginLeft: 4 }, title: '依赖尚未全部完成' }, '·等待') : null,
                  ),
                  h(
                    'td',
                    { className: 'mydsh-muted' },
                    blockedBy.length === 0
                      ? '无'
                      : h(
                          'span',
                          { className: 'mydsh-inline', style: { gap: 4, flexWrap: 'wrap' } },
                          blockedBy.slice(0, 3).map((id) => h(Badge, { key: String(id) }, teamClip(String(id), 14))),
                          blockedBy.length > 3 ? h(Badge, null, `+${blockedBy.length - 3}`) : null,
                        ),
                  ),
                  h('td', { className: 'mydsh-muted' }, owner === '' ? '未指派' : teamClip(owner, 24)),
                  h(
                    'td',
                    { className: 'mydsh-muted', style: { whiteSpace: 'nowrap' } },
                    updated === undefined ? '—' : when(updated, activeLocale()),
                  ),
                )
              }),
            ),
          ),
        ),
  )
}

/**
 * The message timeline: newest first, expandable per entry.
 *
 * Expansion is local and keyed by index, so a poll that returns the same list
 * keeps whatever the user had open instead of collapsing it every ten seconds.
 */
function TeamMessageList({ messages }) {
  const [expanded, setExpanded] = useState({})
  const rows = (Array.isArray(messages) ? messages : []).filter((row) => row !== null && typeof row === 'object')

  if (rows.length === 0) return h(Empty, null, '还没有成员间消息。')

  const ordered = rows.slice().reverse()

  return h(
    'div',
    { className: 'mydsh-list mydsh-scroll', style: { maxHeight: 380 } },
    ordered.map((message, index) => {
      const key = String(message.id ?? index)
      const open = expanded[key] === true
      const from = teamText(message, ['senderName', 'fromName', 'from', 'sender', 'sourceName'], '未知成员')
      const to = teamText(message, ['targetName', 'toName', 'to', 'target', 'recipientName'], '')
      const channel = teamText(message, ['channel', 'transport', 'route', 'topic'], '')
      const at = teamNumber(message, ['at', 'time', 'createdAt', 'timestamp'])
      const body = teamBodyText(message)
      const full = body === '' ? '' : body
      const shown = open ? full : teamClip(full, TEAM_MESSAGE_CHARS)
      const long = full.length > TEAM_MESSAGE_CHARS

      return h(
        'div',
        {
          key,
          style: {
            display: 'flex',
            gap: 8,
            padding: '6px 0 6px 10px',
            borderLeft: '2px solid var(--dsw-alias-border-l1)',
          },
        },
        h(
          'div',
          { className: 'mydsh-grow', style: { display: 'flex', flexDirection: 'column', gap: 3 } },
          h(
            'div',
            { className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
            h(
              'span',
              { className: 'mydsh-inline', style: { gap: 5, minWidth: 0 } },
              h('span', { className: 'mydsh-muted' }, from),
              h('span', { className: 'mydsh-muted' }, '→'),
              h('span', { className: 'mydsh-truncate', title: to }, to === '' ? '（未指明接收方）' : to),
              channel === '' ? null : h(Badge, null, channel),
            ),
            h('span', { className: 'mydsh-muted', style: { flexShrink: 0, fontVariantNumeric: 'tabular-nums' } }, at === undefined ? '—' : when(at, activeLocale())),
          ),
          h(
            'div',
            {
              className: 'mydsh-muted',
              style: { whiteSpace: open ? 'pre-wrap' : 'normal', fontSize: 12, color: open ? 'var(--dsw-alias-label-primary)' : undefined },
            },
            shown === '' ? '（没有正文）' : shown,
          ),
          long
            ? h(
                Button,
                {
                  size: 'sm',
                  variant: 'ghost',
                  onClick: () => setExpanded((current) => ({ ...current, [key]: current[key] !== true })),
                },
                open ? '收起' : '展开全文',
              )
            : null,
        ),
      )
    }),
  )
}

/** The team tab: a read-only mirror of the Host's team runtime. */
function TeamView(props) {
  const settings = useSettings()
  const compact = settings?.ui?.compact === true
  const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
  const [memberFilter, setMemberFilter] = useState('')
  const [taskFilter, setTaskFilter] = useState('')

  const path = sessionId === '' ? null : `/teams/state?sessionId=${encodeURIComponent(sessionId)}`
  const poll = usePoll(path, 10000, [sessionId])
  const data = poll.data

  // Variadic on purpose: the body below passes one argument per section, and a
  // single-parameter version would silently render only the first one.
  const page = (...children) =>
    h(
      'div',
      { className: `mydsh-root mydsh-page${compact ? ' mydsh-compact' : ''}`, style: { padding: '12px 16px 24px' } },
      h(Styles),
      h(
        'header',
        { className: 'mydsh-head' },
        h(
          'div',
          null,
          h('h2', null, '编队'),
          h('p', null, 'DSH 内置编队与子代理的实时状态，只读展示'),
        ),
        h(
          'div',
          { className: 'mydsh-inline' },
          h(Badge, null, '只读'),
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => poll.reload() }, `⟳ ${t().refresh}`),
        ),
      ),
      // Spread as siblings: each section is an independent child, so React does
      // not require keys on a bare array and the order stays the source order.
      ...children,
    )

  if (sessionId === '') {
    return page(h(Note, null, '没有会话标识：这个视图需要挂在某个会话上才能读到编队状态。'))
  }
  if (poll.error !== undefined && data === undefined) {
    return page(
      h(
        Card,
        { title: '编队状态' },
        h(Note, { tone: 'error' }, `读取编队状态失败：${poll.error}`),
        h(Button, { onClick: () => poll.reload() }, '重试'),
      ),
    )
  }
  if (data === undefined) {
    return page(h(Card, { title: '编队状态' }, h(Empty, null, poll.loading ? t().loading : t().empty)))
  }

  const enabled = data.enabled === true
  const members = (Array.isArray(data.members) ? data.members : []).filter((row) => row !== null && typeof row === 'object')
  const tasks = (Array.isArray(data.tasks) ? data.tasks : []).filter((row) => row !== null && typeof row === 'object')
  const messages = (Array.isArray(data.messages) ? data.messages : []).filter((row) => row !== null && typeof row === 'object')
  const totals = teamTotalsOf(data)
  const tokensFromTotals = teamNumber(data.totals, ['tokens', 'totalTokens']) !== undefined
  const durationFromTotals = teamNumber(data.totals, ['durationMs', 'elapsedMs']) !== undefined

  const visibleMembers = members.filter((member) => memberFilter === '' || teamMemberState(member).key === memberFilter)
  const memberCounts = {
    running: members.filter((member) => teamMemberState(member).key === 'running').length,
    completed: members.filter((member) => teamMemberState(member).key === 'completed').length,
    idle: members.filter((member) => teamMemberState(member).key === 'idle').length,
  }

  return page(
    enabled ? null : h(Note, null, '本会话未启用编队。下面显示的是宿主上报的历史记录，可能为空。'),

    h(
      Card,
      { title: '摘要', sub: enabled ? '成员、任务与通讯的合计' : '宿主未上报启用的编队，合计可能为空' },
      h(
        'div',
        { className: 'mydsh-grid', 'data-cols': '4' },
        h(Stat, {
          label: '成员数',
          value: exact(totals.members),
          foot: `运行中 ${exact(totals.running)} · 已完成 ${exact(totals.completed)}`,
          accent: 'var(--dsw-alias-brand-primary)',
        }),
        h(Stat, {
          label: '合计 token',
          value: totals.tokensKnown ? tokens(totals.tokens, 'zh') : '—',
          foot: totals.tokensKnown
            ? `${exact(totals.tokens)} tokens · ${tokensFromTotals ? '宿主合计' : '按成员合计'}`
            : '宿主未上报用量',
          accent: 'var(--dsw-alias-state-success-primary)',
          title: totals.tokensKnown ? `${exact(totals.tokens)} tokens` : undefined,
        }),
        h(Stat, {
          label: '合计时长',
          value: totals.durationKnown ? duration(totals.durationMs, activeLocale()) : '—',
          foot: totals.durationKnown ? (durationFromTotals ? '宿主合计' : '按成员合计') : '宿主未上报时长',
          accent: 'var(--dsw-alias-state-business-primary)',
        }),
        h(Stat, {
          label: '任务 / 消息',
          value: `${exact(totals.tasks)} / ${exact(totals.messages)}`,
          foot: `成员 ${exact(memberCounts.running)} 个运行中`,
          accent: 'var(--dsw-alias-state-warn-primary)',
        }),
      ),
      h(
        'div',
        { className: 'mydsh-muted' },
        '这是 DSH 内置编队的数据镜像，本页没有任何写操作；task 的认领、完成与消息投递都在会话里由智能体自己完成。',
      ),
    ),

    h(
      Card,
      {
        title: '编队成员',
        sub: `${exact(members.length)} 个成员 · 运行中 ${exact(memberCounts.running)} · 已完成 ${exact(memberCounts.completed)} · 空闲 ${exact(memberCounts.idle)}`,
        actions: h(Segmented, { value: memberFilter, onChange: setMemberFilter, options: TEAM_MEMBER_FILTERS }),
      },
      members.length === 0
        ? h(Empty, null, enabled ? '这个会话还没有编队成员。' : '未启用编队，没有成员。')
        : visibleMembers.length === 0
          ? h(Empty, null, '当前筛选下没有成员。')
          : h(
              'div',
              { className: 'mydsh-grid', 'data-cols': '2' },
              visibleMembers.map((member, index) =>
                h(TeamMemberCard, { key: String(member.id ?? index), member, index }),
              ),
            ),
    ),

    h(
      Card,
      {
        title: '任务',
        sub: '任务板来自宿主的编队投影；依赖用任务 id 表示，与智能体在工具里看到的一致',
      },
      h(TeamTaskTable, { tasks, filter: taskFilter, onFilter: setTaskFilter }),
    ),

    h(
      Card,
      { title: '通讯记录', sub: `成员间消息 ${exact(messages.length)} 条，最新的在最上面` },
      h(TeamMessageList, { messages }),
    ),

    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h('span', { className: 'mydsh-muted' }, '数据每 10 秒刷新一次，页面隐藏时不请求'),
      h('span', { className: 'mydsh-muted' }, `会话 ${sessionId}`),
    ),
  )
}

    // ===== 90-apply.js =====
/**
 * Client half mounting.
 *
 * One `apply` registers everything, and one disposer takes it all away. The two
 * things that make that safe:
 *
 * - Every registration goes through `contribute`, which records its disposer, so
 *   unloading the plugin cannot leave a component behind in a slot the Host has
 *   already collapsed.
 * - Switchable entries are registered and withdrawn as the settings document
 *   changes, not on load only. A disabled entry costs nothing at all: no mount,
 *   no subscription, no poll.
 *
 * The state that decides which entries exist is recomputed on every settings
 * change and diffed against what is registered, so ten switches can flip in one
 * save without tearing down the settings page itself.
 */

/** The standalone pages the sidebar icon can open. */
function UsagePanel() {
  const settings = useSettings()
  const meta = useMeta()
  if (settings === undefined) return h('div', { className: 'mydsh-root mydsh-page' }, h(Empty, null, t().loading))
  return h(
    'div',
    { className: 'mydsh-root mydsh-page', style: { padding: '18px 22px' } },
    h(Styles),
    h(UsageSettingsTab, { settings, patch: (partial) => settingsStore.patch(partial), meta }),
  )
}

function BackupPanel() {
  const settings = useSettings()
  const meta = useMeta()
  if (settings === undefined) return h('div', { className: 'mydsh-root mydsh-page' }, h(Empty, null, t().loading))
  return h(
    'div',
    { className: 'mydsh-root mydsh-page', style: { padding: '18px 22px' } },
    h(Styles),
    h(BackupTab, { settings, patch: (partial) => settingsStore.patch(partial), meta }),
  )
}

function ModulesPanel() {
  const settings = useSettings()
  const meta = useMeta()
  if (settings === undefined) return h('div', { className: 'mydsh-root mydsh-page' }, h(Empty, null, t().loading))
  return h(
    'div',
    { className: 'mydsh-root mydsh-page', style: { padding: '18px 22px' } },
    h(Styles),
    h(ModulesTab, { settings, patch: (partial) => settingsStore.patch(partial), meta }),
  )
}

/** The sidebar panel icon: a small gauge, drawn with theme tokens. */
function PanelIcon({ size, active }) {
  const edge = Number(size ?? 20)
  return h(
    'svg',
    {
      width: edge,
      height: edge,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: active === true ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    h('path', { d: 'M4 17a8 8 0 1 1 16 0' }),
    h('path', { d: 'M12 17l4.2-5' }),
    h('circle', { cx: 12, cy: 17, r: 1.4, fill: 'currentColor', stroke: 'none' }),
  )
}

/**
 * Which entries the current document asks for.
 *
 * A tab also depends on its module: showing a Usage tab whose engine the user
 * switched off would open an empty page, so the module switch gates the tab.
 *
 * `settingsSection` is deliberately not switchable. It is the only door back to
 * this page: if a user could hide it and also hide every other entry, the plugin
 * would become invisible with no way to undo that from the interface.
 */
function entryPlan(settings) {
  const entries = settings?.ui?.entries ?? {}
  const modules = settings?.modules ?? {}
  return {
    settingsSection: true,
    sidebarPanel: entries.sidebarPanel === true,
    footerUsage: entries.footerUsage === true,
    tabContext: entries.tabContext === true && modules.contextInsight?.enabled !== false,
    tabTeam: entries.tabTeam === true && modules.teams?.enabled !== false,
    tabUsage: entries.tabUsage === true && settings?.usage?.enabled !== false,
    accountToTitlebar: settings?.ui?.accountToTitlebar === true,
    hideBrandMark: settings?.ui?.hideBrandMark === true,
    hideBrandName: settings?.ui?.hideBrandName === true,
  }
}

/**
 * Restore the preferred grouping into the Host's own persisted view state.
 *
 * The Host stores the Workspaces list view in `localStorage`; writing that
 * record is what makes the sidebar's own switching UI agree with this setting
 * instead of fighting it. A storage that refuses writes is not an error: the
 * Host's own choice simply stays in place.
 */
function applySidebarView(ui) {
  if (ui === undefined) return
  try {
    const raw = window.localStorage.getItem(VIEW_STORE_KEY)
    const parsed = raw === null ? undefined : JSON.parse(raw)
    const state = parsed?.state ?? parsed ?? {}
    const wanted = ui.sidebarView
    if (wanted === undefined || state.groupBy === wanted) return
    const next =
      parsed?.state === undefined
        ? { state: { ...state, groupBy: wanted }, version: 0 }
        : { ...parsed, state: { ...state, groupBy: wanted } }
    window.localStorage.setItem(VIEW_STORE_KEY, JSON.stringify(next))
  } catch {
    // Ignored on purpose; see the comment above.
  }
}

return {
  name: NS,
  inject: ['slots'],

  /**
   * Register the settings page, the panels, and the entry decorations.
   * @param ctx - the Client Cordis context.
   */
  apply(ctx) {
    // Utility functions read the locale through this reference; capture it once.
    ctxRef.get = (name) => ctx.get(name)

    /** Every disposer created here, run on unload. */
    const disposers = []

    /**
     * Register one slot contribution and keep its disposer.
     * @param slot - slot key.
     * @param options - registration options, or `undefined` for a bare seat.
     * @param component - React component.
     */
    const contribute = (slot, options, component) => {
      const disposer = ctx.slots.inject(slot, () =>
        ctx.slots.register(options === undefined ? { name: slot } : { name: slot, ...options }, component),
      )
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    }

    // The New-session row is a HOC: registering it always is safe, because while
    // the switch is off it returns `children` unchanged. Registering and
    // withdrawing it on every toggle would remount the row and lose its focus.
    contribute('sidebar.session.action', { id: `${NS}-new-session` }, NewSessionVeil)

    // The settings page is always present. Hiding it is not offered as a switch:
    // combined with hiding every other entry it would leave no way back into
    // this page, and the only fix would be editing the settings file by hand.
    contribute('settings.section', { id: NS, order: 40, label: t().appTitle }, Page)

    /** Live entries, keyed by plan name. */
    const registered = new Map()

    /**
     * Entry specs. A spec without `options` targets a `single` seat, which
     * rejects registration options outright.
     */
    const entrySpecs = {
      // `settingsSection` is registered below, unconditionally: it is the door back.
      sidebarPanel: () => ({ slot: 'sidebar.panellist', options: { id: 'mydsh-usage', order: 30, label: t().appTitle }, component: PanelIcon }),
      footerUsage: () => ({ slot: 'sidebar.footer.action', options: { id: `${NS}-usage`, order: 20, label: t().tabUsage }, component: FooterUsage }),
      tabUsage: () => ({ slot: 'conversation.view', options: { id: 'mydsh-usage', order: 40, label: () => t().tabUsage }, component: UsageView }),
      tabContext: () => ({ slot: 'conversation.view', options: { id: 'mydsh-context', order: 20, label: () => (activeLocale() === 'zh' ? '上下文' : 'Context') }, component: ContextView }),
      tabTeam: () => ({ slot: 'conversation.view', options: { id: 'mydsh-team', order: 30, label: () => (activeLocale() === 'zh' ? '编队' : 'Team') }, component: TeamView }),
      accountToTitlebar: () => ({ slot: 'conversation.header.leading', component: AccountBubble }),
      hideBrandMark: () => ({ slot: 'sidebar.brand.mark', component: Blank }),
      hideBrandName: () => ({ slot: 'sidebar.brand.name', component: Blank }),
    }

    /**
     * Add or remove one entry to match `wanted`.
     *
     * Withdrawing uses the recorded disposer rather than the one `contribute`
     * returned into the shared list, because that list is only drained on unload;
     * a withdrawn entry must not be disposed twice.
     */
    /**
     * Add or remove one entry to match `wanted`.
     *
     * Withdrawing uses the recorded disposer rather than the one `contribute`
     * returned into the shared list, because that list is only drained on unload;
     * a withdrawn entry must not be disposed twice.
     *
     * A plan key without a spec is an always-on entry that `apply` registered
     * directly; it is skipped here rather than treated as an error, so adding a
     * permanent seat cannot break the diff.
     */
    const syncEntry = (name, wanted) => {
      const existing = registered.get(name)
      if (wanted && existing === undefined) {
        const spec = entrySpecs[name]?.()
        if (spec === undefined) return
        const disposer = spec.options === undefined
          ? contribute(spec.slot, undefined, spec.component)
          : contribute(spec.slot, spec.options, spec.component)
        registered.set(name, disposer)
        return
      }
      if (!wanted && existing !== undefined) {
        try {
          existing?.()
        } catch {
          // The seat may already have collapsed with its owner.
        }
        registered.delete(name)
      }
    }

    /** Apply the document's entry plan. */
    const reconcile = (settings) => {
      const plan = entryPlan(settings)
      for (const [name, wanted] of Object.entries(plan)) syncEntry(name, wanted)
      applySidebarView(settings?.ui)
    }

    // --- subscription ------------------------------------------------------

    disposers.push(settingsStore.start())

    let lastPlan = ''
    const onStore = () => {
      const settings = settingsStore.get()
      if (settings === undefined) return
      const plan = JSON.stringify(entryPlan(settings))
      if (plan === lastPlan) return
      lastPlan = plan
      reconcile(settings)
    }
    disposers.push(settingsStore.subscribe(onStore))
    // The first snapshot may already be loaded by another entry.
    onStore()

    ctx.effect(
      () => () => {
        for (const disposer of disposers.splice(0, disposers.length)) {
          try {
            disposer()
          } catch {
            // A seat that already collapsed disposes itself.
          }
        }
        registered.clear()
      },
      'dsh-mydsh: client contributions',
    )
  },
}
  },
})
