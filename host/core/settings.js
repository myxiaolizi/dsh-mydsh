/**
 * dsh-mydsh settings document 鈥?V2.
 *
 * One JSON document under `<DSH_HOME>/dsh-mydsh/settings.json` owns every
 * preference this plugin has. Nothing here touches Cordis Config, so installing,
 * upgrading or reinstalling the plugin never rewrites the profile patch, and
 * every switch can be flipped at runtime without a Host restart.
 *
 * The document is the contract between the two halves: the Client reads it to
 * draw controls and entries, the Host reads it before each operation. It is
 * normalised on every load, so a document written by an older version 鈥?or a
 * hand-edited one 鈥?still yields a complete, in-range value set.
 */

/**
 * Panel ids the Client registers in `sidebar.panellist` and `main`.
 *
 * One entry, because one switch adds one icon: the icon addresses the panel by
 * id, and a list here that names panels nobody registers makes `meta.panels`
 * describe something that does not exist. Backups and capabilities already have
 * their own settings tabs, so a second entry point would be a second copy of the
 * same pages.
 */
export const PANEL_IDS = Object.freeze(['mydsh-usage'])

/** Where the plugin's own entries may appear. */
export const ENTRY_KEYS = Object.freeze({
  sidebarPanel: 'Sidebar panel icon',
  footerUsage: 'Usage line at the sidebar foot',
  settingsSection: 'Settings page',
  tabContext: 'Context tab',
  tabTeam: 'Team tab',
  tabUsage: 'Usage tab',
  inputAutoContinue: 'Composer auto-continue menu',
  dockGeekMetrics: 'Geek request metrics in the composer dock',
  dockSessionCost: 'Session spend estimate in the composer dock',
  dockSessionTokens: 'Session token counter in the composer dock',
  titlebarContext: 'Context pressure pill in the title bar',
  settingsUsage: 'Usage tab on the settings page',
  settingsBackup: 'Backup tab on the settings page',
  settingsRetry: 'Retry tab on the settings page',
  settingsPersonalize: 'Personalize tab on the settings page',
  settingsModules: 'Capabilities tab on the settings page',
  settingsRelay: 'Remote access tab on the settings page',
})

/** Everything the settings page can change, with the shipping defaults. */
export const DEFAULTS = Object.freeze({
  version: 2,
  ui: {
    // Brand and shell
    hideNewSession: false,
    hideBrandMark: false,
    hideBrandName: false,
    hideSidebarToggle: false,
    accountToTitlebar: false,
    accountAvatarOnly: true,
    // List behaviour
    sidebarView: 'workspace',
    sidebarViewClickToggle: true,
    autoContinueMode: 'follow',
    compact: false,
    density: 'cozy',
    // Which entries exist at all. A disabled entry registers nothing, so it
    // costs no render, no poll and no route.
    entries: {
      sidebarPanel: false,
      footerUsage: true,
      settingsSection: true, // always on: it is the only door back
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
    footerUsageMetric: 'today',
    panelOrder: PANEL_IDS.slice(),
  },
  usage: {
    enabled: true,
    source: 'auto',
    retainDays: 400,
    recentRequestPool: 20,
    geekMetrics: { showTtft: true, showSpeed: true, showTokens: true, pool: 20 },
    contextInsight: { showComposition: true, showTrend: true, showBrowser: true },
    balance: {
      deepseek: { enabled: false, apiKey: '', baseUrl: 'https://api.deepseek.com' },
      providers: [],
      ttlSeconds: 120,
    },
    budgets: [],
    priceOverrides: [],
    estimateUnknown: true,
  },
  backup: {
    enabled: false,
    schedules: [],
    items: {
      workspaceFiles: false,
      conversations: true,
      systemConfig: true,
      plugins: true,
      other: false,
      models: true,
      credentials: false,
    },
    targets: [],
    activeTargetId: '',
    type: 'full',
    encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
    compression: 'zip-deflate',
    splitSizeMb: 0,
    keepCount: 10,
    maxFileMb: 512,
    sync: { enabled: false, direction: 'both', conflict: 'newer' },
  },
  retry: {
    enabled: false,
    policies: [],
    chain: [],
    allowSwitchModel: true,
    allowSwitchProvider: true,
    maxSwitchPerRequest: 3,
    recordLimit: 200,
  },
  personalize: {
    enabled: false,
    nickname: '',
    assistantName: '',
    replyStyle: 'efficient',
    instructions: '',
    persona: '',
    scope: 'all',
    workspaces: [],
    memory: { enabled: false, inject: true, maxEntries: 200, reviewBeforeWrite: false },
    discipline: {
      enabled: false,
      flavor: 'plain',
      antiFake: true,
      acceptance: true,
      loopGuard: true,
      maxNudges: 3,
    },
  },
  relay: {
    enabled: false,
    serverUrl: '',
    account: '',
    token: '',
    tunnelName: '',
    autoConnect: false,
    publicDomain: '',
  },
  modules: {
    recentMetrics: { enabled: true },
    contextInsight: { enabled: true },
    balance: { enabled: true },
    tokenAggregate: { enabled: true },
    memory: { enabled: false },
    discipline: { enabled: false },
    desktop: { enabled: false, allowKeyboard: false, allowMouse: false, allowScreen: true, confirmEach: true },
    mcpConnector: { enabled: false, servers: [], autoStart: true, perSessionTools: false },
    configManager: { enabled: true, allowPluginToggle: true, allowConfigEdit: true },
    skills: { enabled: true, showInSidebar: true },
    roles: { enabled: false, customRoles: [], injectCatalog: false },
    imageGen: { enabled: false, provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '', size: '1024x1024', count: 1, saveDir: '' },
    teams: { enabled: true, readOnly: true },
    browserView: { enabled: false },
  },
})

const SIDEBAR_VIEWS = new Set(['workspace', 'flat'])
const AUTO_CONTINUE_MODES = new Set(['follow', 'off', 'recover', 'loop'])
const USAGE_SOURCES = new Set(['auto', 'local', 'provider'])
const BACKUP_TYPES = new Set(['full', 'incremental'])
const COMPRESSIONS = new Set(['zip-deflate', 'zip', '7z', 'none'])
const TARGET_KINDS = new Set(['local', 'webdav', 'oss', 's3', 'gist'])
const RETRY_MATCHES = new Set(['status', 'code', 'any'])
const BACKOFFS = new Set(['fixed', 'exponential'])
const BUDGET_SCOPES = new Set(['global', 'provider', 'model', 'workspace'])
const BUDGET_PERIODS = new Set(['day', 'week', 'month'])
const BUDGET_ACTIONS = new Set(['notify', 'pause'])
const DENSITIES = new Set(['cozy', 'compact', 'spacious'])
const REPLY_STYLES = new Set(['efficient', 'detailed', 'friendly', 'formal', 'concise'])
const MEMORY_SCOPES = new Set(['all', 'workspaces'])
const FLAVORS = new Set(['plain', 'coach', 'strict', 'warm'])
const FOOTER_METRICS = new Set(['today', 'week', 'month', 'total'])
const SYNC_DIRECTIONS = new Set(['both', 'push', 'pull'])
const SYNC_CONFLICTS = new Set(['newer', 'local', 'remote'])
const IMAGE_PROVIDERS = new Set(['openai-compatible', 'deepseek', 'custom'])

/** True for a non-null, non-array object. */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function str(value, fallback = '', maxLength = 4096) {
  return typeof value === 'string' ? value.slice(0, maxLength) : fallback
}

function num(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function intIn(value, fallback, min, max) {
  return Math.round(num(value, fallback, min, max))
}

function pickEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback
}

function strArray(value, maxItems, maxLength = 1024) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim().slice(0, maxLength)
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= maxItems) break
  }
  return out
}

/** Merge one object over another without mutating either side. */
export function deepMerge(base, patch) {
  if (!isRecord(patch)) return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (isRecord(value) && isRecord(out[key])) out[key] = deepMerge(out[key], value)
    else if (Array.isArray(value)) out[key] = value.map((entry) => (isRecord(entry) ? deepMerge({}, entry) : entry))
    else out[key] = value
  }
  return out
}

/** Unique id helper for list rows that arrive without one. */
function idOf(raw, fallback, maxLength = 64) {
  const value = str(raw?.id, '', maxLength).trim()
  return value === '' ? fallback : value
}

function normalizeBudget(raw, index) {
  if (!isRecord(raw)) return undefined
  const scope = pickEnum(raw.scope, BUDGET_SCOPES, 'global')
  const budget = {
    id: idOf(raw, `budget-${index + 1}`),
    label: str(raw.label, '', 64),
    enabled: bool(raw.enabled, true),
    scope,
    period: pickEnum(raw.period, BUDGET_PERIODS, 'day'),
    action: pickEnum(raw.action, BUDGET_ACTIONS, 'notify'),
    limitTokens: intIn(raw.limitTokens, 0, 0, 1e12),
    limitCost: num(raw.limitCost, 0, 0, 1e9),
    threshold: num(raw.threshold, 0.9, 0.1, 1),
    notifyOnce: bool(raw.notifyOnce, true),
  }
  if (scope === 'provider') budget.provider = str(raw.provider, '', 128)
  if (scope === 'model') {
    budget.provider = str(raw.provider, '', 128)
    budget.model = str(raw.model, '', 200)
  }
  if (scope === 'workspace') budget.workspace = str(raw.workspace, '', 1024)
  return budget
}

function normalizeSchedule(raw, index) {
  if (!isRecord(raw)) return undefined
  const trigger = pickEnum(
    raw.trigger,
    new Set(['daily', 'weekly', 'interval', 'startup', 'after-session', 'manual']),
    'daily',
  )
  return {
    id: idOf(raw, `schedule-${index + 1}`),
    enabled: bool(raw.enabled, true),
    trigger,
    time: /^\d{2}:\d{2}$/.test(str(raw.time, '')) ? str(raw.time, '', 5) : '03:00',
    weekday: intIn(raw.weekday, 1, 0, 6),
    intervalMinutes: intIn(raw.intervalMinutes, 60, 5, 10080),
    type: pickEnum(raw.type, BACKUP_TYPES, 'full'),
    items: normalizeItems(raw.items, undefined),
  }
}

function normalizeItems(raw, fallback) {
  const base = fallback ?? DEFAULTS.backup.items
  const source = isRecord(raw) ? raw : {}
  return {
    workspaceFiles: bool(source.workspaceFiles, base.workspaceFiles),
    conversations: bool(source.conversations, base.conversations),
    systemConfig: bool(source.systemConfig, base.systemConfig),
    plugins: bool(source.plugins, base.plugins),
    other: bool(source.other, base.other),
    models: bool(source.models, base.models),
    credentials: bool(source.credentials, base.credentials),
  }
}

function normalizePolicy(raw, index) {
  if (!isRecord(raw)) return undefined
  return {
    id: idOf(raw, `rule-${index + 1}`),
    label: str(raw.label, '', 64),
    enabled: bool(raw.enabled, true),
    match: pickEnum(raw.match, RETRY_MATCHES, 'any'),
    values: strArray(raw.values, 64, 128),
    action: pickEnum(raw.action, new Set(['retry', 'switch', 'fail']), 'retry'),
    maxAttempts: intIn(raw.maxAttempts, 3, 1, 20),
    delayMs: intIn(raw.delayMs, 1000, 0, 300000),
    backoff: pickEnum(raw.backoff, BACKOFFS, 'exponential'),
    respectRetryAfter: bool(raw.respectRetryAfter, true),
  }
}

function normalizeChain(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const provider = str(entry.provider, '', 128).trim()
    const model = str(entry.model, '', 200).trim()
    if (provider === '' || model === '') continue
    out.push({ provider, model })
    if (out.length >= 32) break
  }
  return out
}

/**
 * One backup destination. `kind` decides which fields matter; the rest are
 * kept so switching destination kind back and forth does not lose input.
 */
function normalizeTarget(raw, index) {
  if (!isRecord(raw)) return undefined
  const kind = pickEnum(raw.kind, TARGET_KINDS, 'local')
  const id = idOf(raw, `target-${index + 1}`)
  const common = {
    id,
    kind,
    label: str(raw.label, '', 64),
    remotePath: str(raw.remotePath, 'dsh-mydsh', 512).replace(/^\/+|\/+$/g, '') || 'dsh-mydsh',
  }
  if (kind === 'webdav') {
    return {
      ...common,
      url: str(raw.url, '', 2048).trim(),
      username: str(raw.username, '', 256),
      password: str(raw.password, '', 512),
    }
  }
  if (kind === 'oss' || kind === 's3') {
    return {
      ...common,
      endpoint: str(raw.endpoint, '', 512).trim(),
      region: str(raw.region, '', 64).trim(),
      bucket: str(raw.bucket, '', 256).trim(),
      accessKeyId: str(raw.accessKeyId, '', 512).trim(),
      accessKeySecret: str(raw.accessKeySecret, '', 512),
      publicBaseUrl: str(raw.publicBaseUrl, '', 512).trim(),
      pathStyle: bool(raw.pathStyle, kind === 's3'),
    }
  }
  if (kind === 'gist') {
    return { ...common, token: str(raw.token, '', 512), gistId: str(raw.gistId, '', 128) }
  }
  return { ...common, path: str(raw.path, '', 1024).trim() }
}

function normalizeProviderBalance(raw, index) {
  if (!isRecord(raw)) return undefined
  return {
    id: idOf(raw, `balance-${index + 1}`),
    enabled: bool(raw.enabled, true),
    label: str(raw.label, '', 64),
    provider: str(raw.provider, '', 128),
    url: str(raw.url, '', 2048).trim(),
    method: pickEnum(raw.method, new Set(['GET', 'POST']), 'GET'),
    headers: str(raw.headers, '', 4096),
    body: str(raw.body, '', 4096),
    // Dotted paths into the JSON answer, e.g. `data.balance`.
    totalPath: str(raw.totalPath, '', 200),
    currencyPath: str(raw.currencyPath, '', 200),
    currency: str(raw.currency, 'CNY', 8),
  }
}

function normalizePriceOverride(raw, index) {
  if (!isRecord(raw)) return undefined
  const provider = str(raw.provider, '', 128).trim()
  const model = str(raw.model, '', 200).trim()
  if (provider === '' && model === '') return undefined
  return {
    id: idOf(raw, `price-${index + 1}`),
    provider,
    model,
    input: num(raw.input, 0, 0, 1e6),
    output: num(raw.output, 0, 0, 1e6),
    cacheRead: num(raw.cacheRead, 0, 0, 1e6),
    cacheWrite: num(raw.cacheWrite, 0, 0, 1e6),
    currency: pickEnum(raw.currency, new Set(['CNY', 'USD']), 'CNY'),
  }
}

function normalizeMemoryEntry(raw, index) {
  if (!isRecord(raw)) return undefined
  const text = str(raw.text, '', 4000).trim()
  if (text === '') return undefined
  return {
    id: idOf(raw, `memory-${index + 1}`),
    text,
    at: intIn(raw.at, Date.now(), 0, 4102444800000),
    source: str(raw.source, 'manual', 32),
    workspace: str(raw.workspace, '', 1024),
    pinned: bool(raw.pinned, false),
    hits: intIn(raw.hits, 0, 0, 1e9),
  }
}

function normalizeMcpServer(raw, index) {
  if (!isRecord(raw)) return undefined
  const name = str(raw.name, '', 64).trim()
  const command = str(raw.command, '', 1024).trim()
  const url = str(raw.url, '', 2048).trim()
  if (name === '') return undefined
  if (command === '' && url === '') return undefined
  return {
    id: idOf(raw, `mcp-${index + 1}`),
    name,
    label: str(raw.label, '', 64),
    enabled: bool(raw.enabled, false),
    transport: command !== '' ? 'stdio' : 'streamable-http',
    command,
    args: strArray(raw.args, 64, 512),
    cwd: str(raw.cwd, '', 1024),
    url,
    env: str(raw.env, '', 4096),
    headers: str(raw.headers, '', 4096),
    toolPrefix: str(raw.toolPrefix, '', 64),
  }
}

function normalizeRole(raw, index) {
  if (!isRecord(raw)) return undefined
  const name = str(raw.name, '', 64).trim()
  if (name === '') return undefined
  return {
    id: idOf(raw, `role-${index + 1}`),
    name,
    department: str(raw.department, '閫氱敤', 64),
    summary: str(raw.summary, '', 400),
    prompt: str(raw.prompt, '', 8000),
    enabled: bool(raw.enabled, true),
  }
}

/**
 * Normalise a (possibly partial, possibly stale) settings document.
 * Unknown keys are dropped; every field is clamped into its accepted range.
 * @param raw - candidate document from disk or from the settings page.
 * @returns a complete, valid settings document.
 */
export function normalize(raw) {
  const source = isRecord(raw) ? raw : {}
  // A document from V1 carries no `version`; treating it as V2 is correct
  // because V2 renamed no field that V1 wrote into a different meaning.
  const merged = deepMerge(DEFAULTS, source)

  const ui = isRecord(merged.ui) ? merged.ui : {}
  const usage = isRecord(merged.usage) ? merged.usage : {}
  const backup = isRecord(merged.backup) ? merged.backup : {}
  const retry = isRecord(merged.retry) ? merged.retry : {}
  const personalize = isRecord(merged.personalize) ? merged.personalize : {}
  const relay = isRecord(merged.relay) ? merged.relay : {}
  const modules = isRecord(merged.modules) ? merged.modules : {}

  const entriesIn = isRecord(ui.entries) ? ui.entries : {}
  const entries = {}
  for (const key of Object.keys(DEFAULTS.ui.entries)) {
    entries[key] = bool(entriesIn[key], DEFAULTS.ui.entries[key])
  }

  const budgets = Array.isArray(usage.budgets) ? usage.budgets.map(normalizeBudget).filter(Boolean).slice(0, 64) : []
  const targets = Array.isArray(backup.targets) ? backup.targets.map(normalizeTarget).filter(Boolean).slice(0, 8) : []
  const activeTargetId = str(backup.activeTargetId, '', 64)
  const targetExists = targets.some((entry) => entry.id === activeTargetId)

  const moduleKeys = Object.keys(DEFAULTS.modules)
  const normalizedModules = {}
  for (const key of moduleKeys) {
    const incoming = isRecord(modules[key]) ? modules[key] : {}
    const base = DEFAULTS.modules[key]
    const next = { enabled: bool(incoming.enabled, base.enabled) }
    for (const [field, value] of Object.entries(base)) {
      if (field === 'enabled') continue
      if (Array.isArray(value)) {
        if (field === 'servers') next.servers = Array.isArray(incoming.servers)
          ? incoming.servers.map(normalizeMcpServer).filter(Boolean).slice(0, 32)
          : []
        else if (field === 'customRoles') next.customRoles = Array.isArray(incoming.customRoles)
          ? incoming.customRoles.map(normalizeRole).filter(Boolean).slice(0, 200)
          : []
        else next[field] = []
        continue
      }
      if (typeof value === 'boolean') next[field] = bool(incoming[field], value)
      else if (typeof value === 'number') next[field] = intIn(incoming[field], value, 0, 1e9)
      else if (typeof value === 'string') next[field] = str(incoming[field], value, 4096)
      else next[field] = incoming[field] ?? value
    }
    normalizedModules[key] = next
  }

  return {
    version: 2,
    ui: {
      hideNewSession: bool(ui.hideNewSession, DEFAULTS.ui.hideNewSession),
      hideBrandMark: bool(ui.hideBrandMark, DEFAULTS.ui.hideBrandMark),
      hideBrandName: bool(ui.hideBrandName, DEFAULTS.ui.hideBrandName),
      hideSidebarToggle: bool(ui.hideSidebarToggle, DEFAULTS.ui.hideSidebarToggle),
      accountToTitlebar: bool(ui.accountToTitlebar, DEFAULTS.ui.accountToTitlebar),
      accountAvatarOnly: bool(ui.accountAvatarOnly, DEFAULTS.ui.accountAvatarOnly),
      sidebarView: pickEnum(ui.sidebarView, SIDEBAR_VIEWS, DEFAULTS.ui.sidebarView),
      sidebarViewClickToggle: bool(ui.sidebarViewClickToggle, DEFAULTS.ui.sidebarViewClickToggle),
      autoContinueMode: pickEnum(ui.autoContinueMode, AUTO_CONTINUE_MODES, DEFAULTS.ui.autoContinueMode),
      compact: bool(ui.compact, DEFAULTS.ui.compact),
      density: pickEnum(ui.density, DENSITIES, DEFAULTS.ui.density),
      entries,
      footerUsageMetric: pickEnum(ui.footerUsageMetric, FOOTER_METRICS, DEFAULTS.ui.footerUsageMetric),
      panelOrder: Array.isArray(ui.panelOrder)
        ? strArray(ui.panelOrder, 16, 64).filter((id) => PANEL_IDS.includes(id))
        : DEFAULTS.ui.panelOrder.slice(),
    },
    usage: {
      enabled: bool(usage.enabled, DEFAULTS.usage.enabled),
      source: pickEnum(usage.source, USAGE_SOURCES, DEFAULTS.usage.source),
      retainDays: intIn(usage.retainDays, DEFAULTS.usage.retainDays, 7, 3650),
      recentRequestPool: intIn(usage.recentRequestPool, DEFAULTS.usage.recentRequestPool, 5, 200),
      geekMetrics: {
        showTtft: bool(usage.geekMetrics?.showTtft, true),
        showSpeed: bool(usage.geekMetrics?.showSpeed, true),
        showTokens: bool(usage.geekMetrics?.showTokens, true),
        pool: intIn(usage.geekMetrics?.pool, 20, 5, 200),
      },
      contextInsight: {
        showComposition: bool(usage.contextInsight?.showComposition, true),
        showTrend: bool(usage.contextInsight?.showTrend, true),
        showBrowser: bool(usage.contextInsight?.showBrowser, true),
      },
      balance: {
        deepseek: {
          enabled: bool(usage.balance?.deepseek?.enabled, false),
          apiKey: str(usage.balance?.deepseek?.apiKey, '', 512),
          baseUrl: str(usage.balance?.deepseek?.baseUrl, DEFAULTS.usage.balance.deepseek.baseUrl, 512).replace(/\/+$/, ''),
        },
        providers: Array.isArray(usage.balance?.providers)
          ? usage.balance.providers.map(normalizeProviderBalance).filter(Boolean).slice(0, 16)
          : [],
        ttlSeconds: intIn(usage.balance?.ttlSeconds, DEFAULTS.usage.balance.ttlSeconds, 15, 3600),
      },
      budgets,
      priceOverrides: Array.isArray(usage.priceOverrides)
        ? usage.priceOverrides.map(normalizePriceOverride).filter(Boolean).slice(0, 200)
        : [],
      estimateUnknown: bool(usage.estimateUnknown, DEFAULTS.usage.estimateUnknown),
    },
    backup: {
      enabled: bool(backup.enabled, DEFAULTS.backup.enabled),
      schedules: Array.isArray(backup.schedules)
        ? backup.schedules.map(normalizeSchedule).filter(Boolean).slice(0, 16)
        : [],
      items: normalizeItems(backup.items, undefined),
      targets,
      activeTargetId: targetExists ? activeTargetId : (targets[0]?.id ?? ''),
      type: pickEnum(backup.type, BACKUP_TYPES, DEFAULTS.backup.type),
      encryption: {
        enabled: bool(backup.encryption?.enabled, false),
        password: str(backup.encryption?.password, '', 512),
        algorithm: 'aes-256-gcm',
      },
      compression: pickEnum(backup.compression, COMPRESSIONS, DEFAULTS.backup.compression),
      splitSizeMb: intIn(backup.splitSizeMb, DEFAULTS.backup.splitSizeMb, 0, 10240),
      keepCount: intIn(backup.keepCount, DEFAULTS.backup.keepCount, 1, 500),
      maxFileMb: intIn(backup.maxFileMb, DEFAULTS.backup.maxFileMb, 1, 8192),
      sync: {
        enabled: bool(backup.sync?.enabled, false),
        direction: pickEnum(backup.sync?.direction, SYNC_DIRECTIONS, 'both'),
        conflict: pickEnum(backup.sync?.conflict, SYNC_CONFLICTS, 'newer'),
      },
    },
    retry: {
      enabled: bool(retry.enabled, DEFAULTS.retry.enabled),
      policies: Array.isArray(retry.policies)
        ? retry.policies.map(normalizePolicy).filter(Boolean).slice(0, 32)
        : [],
      chain: normalizeChain(retry.chain),
      allowSwitchModel: bool(retry.allowSwitchModel, DEFAULTS.retry.allowSwitchModel),
      allowSwitchProvider: bool(retry.allowSwitchProvider, DEFAULTS.retry.allowSwitchProvider),
      maxSwitchPerRequest: intIn(retry.maxSwitchPerRequest, DEFAULTS.retry.maxSwitchPerRequest, 0, 10),
      recordLimit: intIn(retry.recordLimit, DEFAULTS.retry.recordLimit, 20, 2000),
    },
    personalize: {
      enabled: bool(personalize.enabled, DEFAULTS.personalize.enabled),
      nickname: str(personalize.nickname, '', 64),
      assistantName: str(personalize.assistantName, '', 64),
      replyStyle: pickEnum(personalize.replyStyle, REPLY_STYLES, DEFAULTS.personalize.replyStyle),
      instructions: str(personalize.instructions, '', 40000),
      persona: str(personalize.persona, '', 40000),
      scope: pickEnum(personalize.scope, MEMORY_SCOPES, 'all'),
      workspaces: strArray(personalize.workspaces, 64, 1024),
      memory: {
        enabled: bool(personalize.memory?.enabled, DEFAULTS.personalize.memory.enabled),
        inject: bool(personalize.memory?.inject, DEFAULTS.personalize.memory.inject),
        maxEntries: intIn(personalize.memory?.maxEntries, DEFAULTS.personalize.memory.maxEntries, 1, 2000),
        reviewBeforeWrite: bool(personalize.memory?.reviewBeforeWrite, false),
        entries: Array.isArray(personalize.memory?.entries)
          ? personalize.memory.entries.map(normalizeMemoryEntry).filter(Boolean).slice(0, 2000)
          : [],
      },
      discipline: {
        enabled: bool(personalize.discipline?.enabled, DEFAULTS.personalize.discipline.enabled),
        flavor: pickEnum(personalize.discipline?.flavor, FLAVORS, DEFAULTS.personalize.discipline.flavor),
        antiFake: bool(personalize.discipline?.antiFake, true),
        acceptance: bool(personalize.discipline?.acceptance, true),
        loopGuard: bool(personalize.discipline?.loopGuard, true),
        maxNudges: intIn(personalize.discipline?.maxNudges, 3, 0, 20),
      },
    },
    relay: {
      enabled: bool(relay.enabled, DEFAULTS.relay.enabled),
      serverUrl: str(relay.serverUrl, '', 2048).trim().replace(/\/+$/, ''),
      account: str(relay.account, '', 256).trim(),
      token: str(relay.token, '', 1024),
      tunnelName: str(relay.tunnelName, '', 128).trim(),
      autoConnect: bool(relay.autoConnect, DEFAULTS.relay.autoConnect),
      publicDomain: str(relay.publicDomain, '', 256).trim(),
    },
    modules: normalizedModules,
  }
}

/** The Host reads the effective value of one budget for the current window. */
export function isBudgetEnabled(budget) {
  return isRecord(budget) && budget.enabled !== false
}

/**
 * Fill in the two fields the settings page cannot compute on its own: the
 * default local target and the provider list the model pickers offer.
 * Kept out of `normalize` so the stored document stays minimal.
 */
export function withRuntimeDefaults(settings, runtime) {
  const out = normalize(settings)
  if (out.backup.targets.length === 0 && typeof runtime?.defaultBackupPath === 'string') {
    out.backup.targets = [
      { id: 'local-default', kind: 'local', label: '鏈湴鐩綍', remotePath: '', path: runtime.defaultBackupPath },
    ]
    if (out.backup.activeTargetId === '') out.backup.activeTargetId = 'local-default'
  }
  return out
}
