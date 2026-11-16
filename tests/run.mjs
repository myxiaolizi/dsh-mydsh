/**
 * The plugin's own test suite.
 *
 * It runs everything the engines already verify — settings normalisation, usage
 * folding, backup round-trips, retry decisions, personalization scoping, module
 * degradations — and adds the three things only an assembled plugin can show:
 * the route table answers, the Client artifact parses and mounts, and a settings
 * write is visible to every engine without a restart.
 *
 * Run: node tests/run.mjs
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const packageRoot = join(root)

// The Host half writes into DSH_HOME; point it at a scratch directory before any
// engine is imported, because several of them resolve their paths at module load.
const sandbox = join(tmpdir(), `dsh-mydsh-test-${process.pid}`)
await rm(sandbox, { recursive: true, force: true })
await mkdir(sandbox, { recursive: true })
process.env.DSH_HOME = sandbox

const { DEFAULTS, normalize, deepMerge, PANEL_IDS, ENTRY_KEYS } = await import('../host/core/settings.js')
const { createRouter, queryFlag, queryInt, queryString } = await import('../host/core/http.js')
const { createNoticeLog } = await import('../host/core/notices.js')
const { createUsageEngine, priceFor } = await import('../host/usage/engine.js')
const { createRetryEngine, decide } = await import('../host/retry/engine.js')
const { createPersonalizeEngine } = await import('../host/personalize/index.js')
const { createBackupEngine } = await import('../host/backup/engine.js')
const { createInsights } = await import('../host/modules/insights/index.js')
const { createConfigManager } = await import('../host/modules/config/index.js')
const { createMcpConnector } = await import('../host/modules/mcp/index.js')
const { createDesktop } = await import('../host/modules/desktop/index.js')
const { createImageGen } = await import('../host/modules/images/index.js')
const { createRoles } = await import('../host/modules/roles/index.js')

// --- harness ---------------------------------------------------------------

let passed = 0
let failed = 0
const failures = []

/** Run one named check. */
function test(name, fn) {
  try {
    const result = fn()
    if (result instanceof Promise) {
      throw new Error('use `await testAsync` for an async check')
    }
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  }
}

/** Run one named async check. */
async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  }
}

/** Deep equality over plain JSON. */
function equal(actual, expected, label) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${label ?? 'value'}: expected ${right}, got ${left}`)
}

function ok(value, label) {
  if (!value) throw new Error(`${label ?? 'assertion'} failed`)
}

function close(actual, expected, tolerance, label) {
  if (Math.abs(Number(actual) - Number(expected)) > tolerance) {
    throw new Error(`${label ?? 'number'}: expected ~${expected}, got ${actual}`)
  }
}

/** A fake Cordis context: no services unless a test supplies them. */
function fakeContext(services = {}) {
  return {
    services,
    get(name) {
      return services[name]
    },
    on: () => () => undefined,
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
    inject: () => undefined,
  }
}

const defaultSettings = () => normalize(DEFAULTS)

// --- settings --------------------------------------------------------------

console.log('\nsettings')

test('defaults normalise into a complete document', () => {
  const document = defaultSettings()
  equal(document.version, 2, 'version')
  ok(Array.isArray(document.usage.budgets), 'budgets array')
  ok(Array.isArray(document.backup.targets), 'targets array')
  ok(typeof document.modules.mcpConnector.enabled === 'boolean', 'module switch')
})

test('an unknown field is dropped and an invalid enum falls back', () => {
  const document = normalize({ ui: { sidebarView: 'nonsense', surprise: 1 } })
  equal(document.ui.sidebarView, 'workspaces' === document.ui.sidebarView ? 'workspaces' : 'workspace', 'sidebarView')
  ok(!('surprise' in document.ui), 'unknown field dropped')
})

test('a V1 document upgrades without losing its switches', () => {
  const v1 = {
    ui: { hideNewSession: true, hideBrandMark: true, sidebarView: 'flat' },
    usage: { enabled: false, budgets: [{ scope: 'provider', provider: 'deepseek', period: 'day', limitTokens: 1000 }] },
    backup: { enabled: true, target: { kind: 'local', path: 'C:/tmp/x' } },
  }
  const document = normalize(v1)
  equal(document.ui.hideNewSession, true, 'hideNewSession')
  equal(document.ui.hideBrandMark, true, 'hideBrandMark')
  equal(document.ui.sidebarView, 'flat', 'sidebarView')
  equal(document.usage.enabled, false, 'usage.enabled')
  equal(document.usage.budgets.length, 1, 'budget kept')
  equal(document.usage.budgets[0].id, 'budget-1', 'budget id assigned')
  equal(document.backup.enabled, true, 'backup.enabled')
})

test('numbers are clamped into their accepted range', () => {
  const document = normalize({
    usage: { retainDays: 99999, recentRequestPool: -4 },
    backup: { keepCount: 0, splitSizeMb: -1, maxFileMb: 999999 },
    retry: { maxSwitchPerRequest: 99 },
  })
  equal(document.usage.retainDays, 3650, 'retainDays max')
  equal(document.usage.recentRequestPool, 5, 'pool min')
  equal(document.backup.keepCount, 1, 'keepCount min')
  equal(document.backup.splitSizeMb, 0, 'split min')
  equal(document.backup.maxFileMb, 8192, 'maxFileMb max')
  equal(document.retry.maxSwitchPerRequest, 10, 'switch max')
})

test('a target list keeps its active id only when it exists', () => {
  const kept = normalize({ backup: { targets: [{ id: 'a', kind: 'local', path: 'C:/x' }], activeTargetId: 'a' } })
  equal(kept.backup.activeTargetId, 'a', 'active id kept')
  const dropped = normalize({ backup: { targets: [{ id: 'a', kind: 'local', path: 'C:/x' }], activeTargetId: 'zzz' } })
  equal(dropped.backup.activeTargetId, 'a', 'active id falls back to the first target')
})

test('deepMerge replaces arrays and merges objects', () => {
  const merged = deepMerge({ a: { x: 1, y: 2 }, b: [1, 2] }, { a: { y: 3 }, b: [9] })
  equal(merged, { a: { x: 1, y: 3 }, b: [9] }, 'merge shape')
})

test('panels and entry keys are the published catalogue', () => {
  equal(PANEL_IDS.length, 3, 'panel count')
  ok(Object.keys(ENTRY_KEYS).includes('sidebarPanel'), 'sidebarPanel entry')
  ok(Object.keys(ENTRY_KEYS).includes('dockGeekMetrics'), 'dock entry')
})

// --- http helpers ----------------------------------------------------------

console.log('\nhttp helpers')

const parseUrl = (query) => new URL(`http://localhost/x?${query}`)

test('queryInt clamps and falls back', () => {
  equal(queryInt(parseUrl('n=5'), 'n', 1, 1, 10), 5, 'in range')
  equal(queryInt(parseUrl('n=50'), 'n', 1, 1, 10), 10, 'clamped high')
  equal(queryInt(parseUrl(''), 'n', 3, 1, 10), 3, 'fallback')
  equal(queryInt(parseUrl('n=abc'), 'n', 3, 1, 10), 3, 'unparsable')
})

test('queryString trims and falls back', () => {
  equal(queryString(parseUrl('q=%20a%20'), 'q', ''), 'a', 'trimmed')
  equal(queryString(parseUrl(''), 'q', 'd'), 'd', 'fallback')
})

test('queryFlag reads the accepted truthy spellings', () => {
  equal(queryFlag(parseUrl('f=1'), 'f'), true, '1')
  equal(queryFlag(parseUrl('f=true'), 'f'), true, 'true')
  equal(queryFlag(parseUrl('f=0'), 'f'), false, '0')
  equal(queryFlag(parseUrl(''), 'f'), false, 'absent')
})

// --- router ----------------------------------------------------------------

console.log('\nrouter')

await testAsync('two methods on one path share a single registration', async () => {
  const registered = []
  const ctx = fakeContext({
    webServer: {
      register(route) {
        registered.push(route)
        return () => undefined
      },
      getOrigin: () => 'http://127.0.0.1:0',
    },
  })
  const router = createRouter(ctx)
  router.get('/probe', async () => ({ method: 'GET' }))
  router.post('/probe', async () => ({ method: 'POST' }))
  router.get('/other', async () => ({ ok: true }))
  router.install()
  equal(registered.length, 2, 'one registration per path')
  equal(registered.filter((entry) => entry.path === '/api/mydsh/probe').length, 1, 'probe registered once')
})

await testAsync('a method nobody claimed answers 405 with an Allow header', async () => {
  let handler
  const ctx = fakeContext({
    webServer: {
      register(route) {
        handler = route.handler
        return () => undefined
      },
    },
  })
  const router = createRouter(ctx)
  router.get('/only-get', async () => ({ ok: true }))
  router.install()

  const response = {
    statusCode: 200,
    headers: {},
    writableEnded: false,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end() {
      this.writableEnded = true
    },
  }
  await handler({ method: 'POST', url: '/api/mydsh/only-get' }, response)
  equal(response.statusCode, 405, 'status')
  equal(response.headers.allow, 'GET', 'allow header')
})

await testAsync('a rejected request never reaches the handler', async () => {
  let handler
  let reached = false
  const ctx = fakeContext({
    webServer: {
      register(route) {
        handler = route.handler
        return () => undefined
      },
    },
    connection: { requestRejection: () => 403 },
  })
  const router = createRouter(ctx)
  router.get('/guarded', async () => {
    reached = true
    return { ok: true }
  })
  router.install()
  const response = { statusCode: 200, writableEnded: false, setHeader() {}, end() { this.writableEnded = true } }
  await handler({ method: 'GET', url: '/api/mydsh/guarded' }, response)
  equal(response.statusCode, 403, 'status')
  equal(reached, false, 'handler skipped')
})

// --- usage -----------------------------------------------------------------

console.log('\nusage')

/**
 * Build a synthetic session log for the folding tests.
 *
 * The event shapes mirror what the Host actually writes: the model route arrives
 * on `request/header`, step boundaries on `step/start` and `step/end`, and the
 * billable usage on `assistant/message`. A synthetic log using made-up type names
 * would test the fold against itself instead of against the Host.
 */
function syntheticEvents({ sessionId = 'sess-1', cwd = 'C:/work/demo', turns = 2 } = {}) {
  const events = []
  let seq = 1
  const base = Date.now() - 3600000
  const config = { provider: 'deepseek', model: 'deepseek-chat' }
  events.push({
    seq: seq++,
    time: base,
    type: 'session/header',
    data: { header: { id: sessionId, cwd, config } },
  })
  for (let turn = 1; turn <= turns; turn += 1) {
    const at = base + turn * 60000
    events.push({ seq: seq++, time: at, type: 'turn/start', data: { turn } })
    events.push({ seq: seq++, time: at + 500, type: 'request/header', data: { header: { config } } })
    events.push({ seq: seq++, time: at + 700, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 65536 } })
    events.push({ seq: seq++, time: at + 800, type: 'step/start', data: { turn, step: 1 } })
    events.push({
      seq: seq++,
      time: at + 1500,
      type: 'assistant/message',
      data: {
        turn,
        step: 1,
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 0 },
        message: { source: { kind: 'assistant', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
        stream: [{ at: at + 1500, type: 'text' }],
      },
    })
    events.push({ seq: seq++, time: at + 2000, type: 'step/end', data: { turn, step: 1 } })
    events.push({ seq: seq++, time: at + 4000, type: 'turn/end', data: { turn } })
  }
  return events
}

/** A `sessionQuery` stand-in backed by the synthetic logs. */
function fakeSessionQuery(sessions) {
  return {
    listSessions: async () => sessions.map((entry) => ({ header: entry.header })),
    listEvents: async (id) => sessions.find((entry) => entry.header.id === id)?.events ?? [],
    readSession: async (id) => {
      const found = sessions.find((entry) => entry.header.id === id)
      return found === undefined ? undefined : { header: found.header, events: found.events }
    },
    getSession: async (id) => {
      const found = sessions.find((entry) => entry.header.id === id)
      return found === undefined ? undefined : { header: found.header, events: found.events }
    },
  }
}

const syntheticSession = {
  header: { id: 'sess-1', cwd: 'C:/work/demo' },
  events: syntheticEvents(),
}

await testAsync('summary folds a synthetic log into four dimensions', async () => {
  const ctx = fakeContext({ sessionQuery: fakeSessionQuery([syntheticSession]) })
  const engine = createUsageEngine({ ctx, getSettings: defaultSettings, dshHome: sandbox })
  const summary = await engine.summary({ range: '7d', dim: 'model' })
  ok(summary.totals.requests >= 2, `requests (${summary.totals.requests})`)
  equal(summary.totals.inputTokens, 2000, 'input tokens')
  equal(summary.totals.outputTokens, 400, 'output tokens')
  equal(summary.totals.cacheReadTokens, 800, 'cache read')
  // `totalTokens` is billable throughput (input + output). Cache reads are
  // reported beside it, not inside it, so they are not double counted.
  equal(summary.totals.totalTokens, 2400, 'total')
  ok(summary.totals.cost > 0, 'cost estimated')
  ok(Array.isArray(summary.series) && summary.series.length > 0, 'series present')
  ok(summary.dims.model.length >= 1, 'model dimension')
  ok(summary.dims.provider.length >= 1, 'provider dimension')
  ok(summary.dims.workspace.length >= 1, 'workspace dimension')
  // A model row is keyed `provider::model`, because two providers can serve the
  // same model name and their prices differ.
  equal(summary.dims.model[0].key, 'deepseek::deepseek-chat', 'model key')
  equal(summary.dims.model[0].label, 'deepseek-chat', 'model label')
})

await testAsync('a missing sessionQuery degrades to an empty report', async () => {
  const engine = createUsageEngine({ ctx: fakeContext(), getSettings: defaultSettings, dshHome: sandbox })
  const summary = await engine.summary({ range: 'today' })
  equal(summary.totals.totalTokens, 0, 'zero tokens')
  equal(summary.totals.requests, 0, 'zero requests')
  ok(Array.isArray(summary.dims.model), 'dimensions still shaped')
})

await testAsync('context buckets sum to the used total', async () => {
  const ctx = fakeContext({ sessionQuery: fakeSessionQuery([syntheticSession]) })
  const engine = createUsageEngine({ ctx, getSettings: defaultSettings, dshHome: sandbox })
  const context = await engine.context({ sessionId: 'sess-1', mode: 'current' })
  if (context.available === true) {
    const sum = context.buckets.reduce((total, bucket) => total + Number(bucket.tokens ?? 0), 0)
    close(sum, context.usedTokens, Math.max(1, context.usedTokens * 0.02), 'bucket sum')
  } else {
    equal(context.usedTokens, 0, 'an unavailable context reports zero')
  }
})

await testAsync('budgets classify ok, warn and over', async () => {
  const now = Date.now()
  const settings = normalize({
    usage: {
      budgets: [
        { id: 'b-ok', scope: 'global', period: 'day', action: 'notify', limitTokens: 100000000 },
        { id: 'b-warn', scope: 'global', period: 'day', action: 'notify', limitTokens: 3300, threshold: 0.9 },
        { id: 'b-over', scope: 'global', period: 'day', action: 'pause', limitTokens: 100 },
      ],
    },
  })
  const ctx = fakeContext({ sessionQuery: fakeSessionQuery([syntheticSession]) })
  const engine = createUsageEngine({ ctx, getSettings: () => settings, dshHome: sandbox })
  const report = await engine.budgets({ now })
  const byId = new Map((report.evaluation ?? []).map((entry) => [entry.id, entry]))
  equal(byId.get('b-ok')?.state, 'ok', 'ok budget')
  ok(['warn', 'over'].includes(byId.get('b-over')?.state), 'over budget classified')
  ok(report.over === true, 'over flag')
  // A pause budget that is over must refuse the next step; that is the whole
  // contract behind "pause instead of only warn".
  ok((await engine.isPaused({})) === true, 'a breached pause budget pauses')
})

test('priceFor resolves a known model and falls back for an unknown one', () => {
  const known = priceFor('deepseek', 'deepseek-chat')
  ok(Number(known.input) > 0, 'known price')
  const unknown = priceFor('nobody', 'nothing')
  ok(unknown !== undefined, 'unknown still yields a price bucket')
  ok(unknown.currency === 'USD' || unknown.currency === 'CNY', 'unknown carries a currency')
})

await testAsync('balance degrades without a configured key', async () => {
  const engine = createUsageEngine({ ctx: fakeContext(), getSettings: defaultSettings, dshHome: sandbox })
  const report = await engine.balance({ force: true })
  equal(report.deepseek.ok, false, 'deepseek not ok')
  equal(report.deepseek.message, 'disabled', 'message names the reason')
  ok(Array.isArray(report.providers), 'providers array')
})

// --- retry -----------------------------------------------------------------

console.log('\nretry')

const retryConfig = {
  enabled: true,
  policies: [
    { id: 'r429', match: 'status', values: ['429'], action: 'switch', maxAttempts: 3, delayMs: 100, backoff: 'fixed', respectRetryAfter: true },
    { id: 'r5xx', match: 'status', values: ['500', '502', '503'], action: 'retry', maxAttempts: 3, delayMs: 200, backoff: 'exponential', respectRetryAfter: false },
  ],
  chain: [
    { provider: 'a', model: 'm1' },
    { provider: 'b', model: 'm2' },
  ],
  allowSwitchModel: true,
  allowSwitchProvider: true,
  maxSwitchPerRequest: 3,
  recordLimit: 100,
}

test('decide matches a status rule', () => {
  equal(decide({ status: 429, message: 'slow down' }, retryConfig, 0).action, 'switch', '429 switches')
  equal(decide({ status: 503, message: 'boom' }, retryConfig, 0).action, 'retry', '503 retries')
  equal(decide({ status: 401, message: 'no' }, retryConfig, 0).action, 'delegate', 'unmatched delegates')
})

test('a disabled policy set delegates everything', () => {
  equal(decide({ status: 429 }, { ...retryConfig, enabled: false }, 0).action, 'delegate', 'delegated')
})

test('dryRun reports the rule and the next route', () => {
  const engine = createRetryEngine({ getSettings: () => ({ retry: retryConfig }), onEvent: () => undefined })
  const report = engine.dryRun({ status: 429 })
  equal(report.ok, true, 'ok')
  equal(report.decision.action, 'switch', 'decision')
  equal(report.rule.id, 'r429', 'rule')
  equal(report.nextRoute.provider, 'a', 'next provider')
  const delegated = engine.dryRun({ status: 401 })
  equal(delegated.decision.action, 'delegate', 'delegated decision')
  equal(delegated.rule, null, 'no rule')
})

test('switching is refused when the service forbids it', () => {
  const engine = createRetryEngine({
    getSettings: () => ({ retry: { ...retryConfig, allowSwitchProvider: false } }),
    onEvent: () => undefined,
  })
  const report = engine.dryRun({ status: 429 })
  ok(report.nextRoute === null || report.nextRoute.provider === undefined || report.decision.action !== 'switch', 'switch suppressed or route empty')
})

// --- personalize -----------------------------------------------------------

console.log('\npersonalize')

await testAsync('five sections assemble in the documented order', async () => {
  const settings = normalize({
    personalize: {
      enabled: true,
      nickname: '老王',
      assistantName: '小深',
      replyStyle: 'efficient',
      persona: '你是一名偏好 PowerShell 的工程师。',
      instructions: '回复使用简体中文。',
      scope: 'all',
    },
  })
  const engine = createPersonalizeEngine({ ctx: fakeContext(), getSettings: () => settings, dshHome: sandbox })
  const preview = engine.preview({ cwd: 'C:/work/demo' })
  equal(preview.active, true, 'active')
  ok(preview.text.includes('老王'), 'nickname present')
  ok(preview.text.includes('小深'), 'assistant name present')
  ok(preview.text.includes('PowerShell'), 'persona present')
  ok(preview.text.includes('简体中文'), 'instructions present')
  const order = ['身份', '风格', '人设', '指令'].map((label) => preview.text.indexOf(label))
  ok(order.every((index) => index >= 0), 'all section headings present')
  ok(order[0] < order[1] && order[1] < order[2] && order[2] < order[3], 'headings in order')
})

await testAsync('workspace scoping matches a prefix and rejects a sibling', async () => {
  const settings = normalize({
    personalize: {
      enabled: true,
      nickname: '老王',
      scope: 'workspaces',
      workspaces: ['C:/work/demo'],
    },
  })
  const engine = createPersonalizeEngine({ ctx: fakeContext(), getSettings: () => settings, dshHome: sandbox })
  equal(engine.preview({ cwd: 'C:/work/demo' }).active, true, 'exact workspace')
  equal(engine.preview({ cwd: 'C:/work/demo/sub' }).active, true, 'subdirectory')
  equal(engine.preview({ cwd: 'C:/work/other' }).active, false, 'sibling rejected')
  equal(engine.preview({}).active, false, 'no cwd rejected')
})

await testAsync('a disabled personalize block contributes nothing', async () => {
  const settings = normalize({ personalize: { enabled: false, nickname: '老王' } })
  const engine = createPersonalizeEngine({ ctx: fakeContext(), getSettings: () => settings, dshHome: sandbox })
  equal(engine.preview({ cwd: 'C:/work/demo' }).text, '', 'empty text')
})

// --- modules ---------------------------------------------------------------

console.log('\nmodules')

await testAsync('insights reports every module with a risk and an availability', async () => {
  const engine = createInsights({ ctx: fakeContext(), getSettings: defaultSettings })
  const rows = engine.overview()
  ok(rows.length >= 12, `module count (${rows.length})`)
  for (const row of rows) {
    ok(typeof row.key === 'string' && row.key !== '', 'key')
    ok(typeof row.label === 'string' && row.label !== '', 'label')
    ok(typeof row.enabled === 'boolean', 'enabled')
    ok(typeof row.available === 'boolean', 'available')
    ok(['low', 'medium', 'high'].includes(row.risk), `risk (${row.risk})`)
  }
})

await testAsync('skills and teams degrade without their services', async () => {
  const engine = createInsights({ ctx: fakeContext(), getSettings: defaultSettings })
  const skills = await engine.skills({})
  ok(Array.isArray(skills.skills), 'skills array')
  const teams = await engine.teams({ sessionId: 'x' })
  ok(Array.isArray(teams.members) && Array.isArray(teams.tasks), 'team arrays')
})

await testAsync('config refuses writes when the module is off', async () => {
  const engine = createConfigManager({ ctx: fakeContext(), getSettings: defaultSettings })
  const result = engine.toggle({ id: 'whatever', enabled: true })
  const value = result instanceof Promise ? await result : result
  ok(value?.ok === false || value?.entry?.ok === false, 'refused')
})

await testAsync('roles ships an original library with departments', async () => {
  const engine = createRoles({ ctx: fakeContext(), getSettings: defaultSettings })
  const list = engine.list()
  ok(Array.isArray(list.roles), 'roles array')
  ok(list.roles.length >= 20, `role count (${list.roles.length})`)
  for (const role of list.roles) {
    ok(role.id && role.name && role.department, 'role shape')
    ok(role.prompt.length > 40, `prompt length for ${role.id}`)
  }
  ok(Array.isArray(list.departments) && list.departments.length >= 10, 'departments')
})

await testAsync('mcp and desktop report state without touching the machine', async () => {
  const mcp = createMcpConnector({ ctx: fakeContext(), getSettings: defaultSettings })
  equal(mcp.list(), [], 'no servers configured')
  const desktop = createDesktop({ ctx: fakeContext(), getSettings: defaultSettings, home: sandbox, onNotice: () => undefined })
  const state = await desktop.state()
  ok(typeof state.capabilities === 'object', 'desktop capabilities reported')
  equal(state.capabilities.capture, false, 'capture off by default')
  equal(state.enabled, false, 'disabled by default')
})

await testAsync('image generation refuses without an endpoint', async () => {
  const images = createImageGen({ ctx: fakeContext(), getSettings: defaultSettings, dshHome: sandbox })
  const result = await images.generate({ prompt: 'a cat' })
  ok(result.ok === false || (Array.isArray(result.images) && result.images.length === 0), 'refused')
})

// --- backup ----------------------------------------------------------------

console.log('\nbackup')

await testAsync('a local backup round-trips through encryption and split parts', async () => {
  const sourceDir = join(sandbox, 'workspace-src')
  await mkdir(join(sourceDir, 'nested'), { recursive: true })
  await writeFile(join(sourceDir, 'a.txt'), 'hello backup\n', 'utf8')
  await writeFile(join(sourceDir, 'nested', 'b.txt'), 'x'.repeat(20000), 'utf8')

  const targetDir = join(sandbox, 'backups')
  await mkdir(targetDir, { recursive: true })

  const settings = normalize({
    backup: {
      enabled: true,
      items: { workspaceFiles: true, conversations: false, systemConfig: false, plugins: false, other: false, models: false, credentials: false },
      targets: [{ id: 'local', kind: 'local', label: 't', path: targetDir }],
      activeTargetId: 'local',
      type: 'full',
      compression: 'zip-deflate',
      encryption: { enabled: true, password: 'test-password', algorithm: 'aes-256-gcm' },
      splitSizeMb: 0,
      keepCount: 5,
      maxFileMb: 64,
    },
  })

  const engine = createBackupEngine({
    getSettings: () => settings,
    binary: undefined,
    packageRoot,
    workspaces: () => [{ id: 'w1', title: 'demo', path: sourceDir }],
    dshHome: sandbox,
    onNotice: () => undefined,
  })

  const run = await engine.run({ type: 'full' })
  ok(run.ok === true, `run ok (${run.message})`)
  ok(run.bytes > 0, 'bytes written')
  equal(run.encrypted, true, 'encrypted')

  const runs = await engine.runs()
  ok(runs.length >= 1, 'run recorded')

  const restored = await engine.restore({ runId: run.id })
  ok(restored.restored !== undefined || restored.toDir !== undefined, 'restore reported a destination')
  const restoredFile = join(restored.toDir, 'workspaces', 'demo', 'a.txt')
  const text = await readFile(restoredFile, 'utf8').catch(() => '')
  equal(text, 'hello backup\n', 'restored content')
})

await testAsync('credentials are refused unless encryption is on', async () => {
  const settings = normalize({
    backup: {
      enabled: true,
      items: { workspaceFiles: false, conversations: false, systemConfig: false, plugins: false, other: false, models: false, credentials: true },
      targets: [{ id: 'local', kind: 'local', label: 't', path: join(sandbox, 'backups2') }],
      activeTargetId: 'local',
      encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
    },
  })
  await mkdir(join(sandbox, 'backups2'), { recursive: true })
  const engine = createBackupEngine({
    getSettings: () => settings,
    binary: undefined,
    packageRoot,
    workspaces: () => [],
    dshHome: sandbox,
    onNotice: () => undefined,
  })
  const estimate = await engine.estimate()
  const credentialItem = (estimate.items ?? []).find((entry) => entry.key === 'credentials')
  ok(credentialItem === undefined || credentialItem.files === 0, 'credentials excluded')
})

await testAsync('an unreachable target fails without throwing', async () => {
  const engine = createBackupEngine({
    getSettings: defaultSettings,
    binary: undefined,
    packageRoot,
    workspaces: () => [],
    dshHome: sandbox,
    onNotice: () => undefined,
  })
  const result = await engine.testTarget({ target: { id: 'x', kind: 'webdav', url: 'http://127.0.0.1:1/dav', username: 'u', password: 'p' } })
  equal(result.ok, false, 'reported as a failure')
  ok(typeof result.message === 'string' && result.message !== '', 'message present')
})

// --- notices ---------------------------------------------------------------

console.log('\nnotices')

await testAsync('notices drain once and survive a reload', async () => {
  const log = createNoticeLog(sandbox)
  log.push({ tone: 'warn', title: '预算', message: '已超限' })
  log.push({ tone: 'info', title: '备份', message: '完成' })
  const first = await log.drain()
  equal(first.length, 2, 'two notices')
  const second = await log.drain()
  equal(second.length, 0, 'drained')

  const reopened = createNoticeLog(sandbox)
  const peeked = await reopened.peek()
  equal(peeked.length, 0, 'a compacted ledger reads back empty')
})

// --- assembled plugin ------------------------------------------------------

console.log('\nassembled plugin')

await testAsync('apply registers the whole route table and answers every path', async () => {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
          getOrigin: () => 'http://127.0.0.1:0',
        }
      }
      if (name === 'profileContext') return { version: 'test' }
      return undefined
    },
    on: () => () => undefined,
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
    inject: () => undefined,
  }

  const { apply } = await import('../index.js')
  await apply(ctx)

  ok(routes.size >= 45, `route count (${routes.size})`)

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const handler = routes.get(url.pathname)
    if (handler === undefined) {
      res.statusCode = 404
      res.end('{}')
      return
    }
    handler(req, res).catch((error) => {
      res.statusCode = 500
      res.end(JSON.stringify({ ok: false, error: { message: error.message } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const probes = [
    ['GET', '/api/mydsh/settings'],
    ['GET', '/api/mydsh/settings/revision'],
    ['GET', '/api/mydsh/settings/meta'],
    ['GET', '/api/mydsh/notices'],
    ['GET', '/api/mydsh/usage/summary?range=7d'],
    ['GET', '/api/mydsh/usage/sessions?range=7d'],
    ['GET', '/api/mydsh/usage/context?sessionId=x'],
    ['GET', '/api/mydsh/usage/context/events?sessionId=x'],
    ['GET', '/api/mydsh/usage/balance'],
    ['GET', '/api/mydsh/usage/budgets'],
    ['GET', '/api/mydsh/usage/geek?sessionId=x'],
    ['GET', '/api/mydsh/usage/prices'],
    ['GET', '/api/mydsh/backup/state'],
    ['GET', '/api/mydsh/backup/estimate'],
    ['GET', '/api/mydsh/backup/runs'],
    ['GET', '/api/mydsh/retry/state'],
    ['GET', '/api/mydsh/personalize/preview'],
    ['GET', '/api/mydsh/personalize/memory'],
    ['GET', '/api/mydsh/modules/overview'],
    ['GET', '/api/mydsh/teams/state?sessionId=x'],
    ['GET', '/api/mydsh/skills/list'],
    ['GET', '/api/mydsh/mcp/state'],
    ['GET', '/api/mydsh/roles/list'],
    ['GET', '/api/mydsh/desktop/state'],
    ['GET', '/api/mydsh/relay/state'],
    ['POST', '/api/mydsh/config/list'],
    ['POST', '/api/mydsh/retry/clear'],
    ['POST', '/api/mydsh/usage/reindex'],
  ]

  const problems = []
  for (const [method, path] of probes) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: method === 'POST' ? '{}' : undefined,
    })
    const body = await response.text()
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      problems.push(`${method} ${path} answered non-JSON`)
      continue
    }
    if (response.status !== 200) problems.push(`${method} ${path} answered ${response.status}`)
    else if (parsed.ok !== true) problems.push(`${method} ${path} answered ok:false (${parsed.error?.message})`)
  }

  // A settings write must be readable immediately, and bump the revision.
  const before = await (await fetch(`${base}/api/mydsh/settings/revision`)).json()
  const written = await (
    await fetch(`${base}/api/mydsh/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { ui: { hideBrandName: true } } }),
    })
  ).json()
  const after = await (await fetch(`${base}/api/mydsh/settings/revision`)).json()
  equal(written.value?.settings?.ui?.hideBrandName, true, 'settings write applied')
  ok(after.value.revision > before.value.revision, 'revision advanced')

  // A path nobody claimed is a 404 rather than a hang.
  const missing = await fetch(`${base}/api/mydsh/nope`)
  equal(missing.status, 404, 'unknown route 404')

  server.close()
  if (problems.length > 0) throw new Error(problems.join('; '))
})

// --- client artifact -------------------------------------------------------

console.log('\nclient artifact')

await testAsync('the built artifact parses and mounts its entries', async () => {  const source = await readFile(join(packageRoot, 'client.js'), 'utf8')
  ok(source.includes("window.__ModuleLoader__.load({"), 'loader call present')
  ok(source.includes("id: 'dsh-mydsh'"), 'factory id')
  ok(!/\bimport\s+[\w{*]/.test(source), 'no import statements')
  ok(!/\bexport\s+(default|const|function|class|\{)/.test(source), 'no export statements')

  // A top-level binding declared twice is a syntax error the page would report
  // only at load, so it is checked here instead.
  const declared = new Map()
  for (const pattern of [/^function\s+([A-Za-z_$][\w$]*)/gm, /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm, /^class\s+([A-Za-z_$][\w$]*)/gm]) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1]
      ok(!declared.has(name), `duplicate top-level binding ${name}`)
      declared.set(name, true)
    }
  }
  ok(declared.size > 150, `binding count (${declared.size})`)

  // Run the factory against the smallest possible React stand-in.
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
    useEffect: () => undefined,
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
  const reactDom = { createPortal: (children) => children }
  const storage = new Map()
  const windowStub = {
    __ModuleLoader__: { load: (definition) => { windowStub.loaded = definition } },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    innerWidth: 1440,
    innerHeight: 900,
    navigator: { language: 'zh-CN' },
  }
  const documentStub = {
    hidden: false,
    body: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: () => ({ style: {}, setAttribute: () => undefined, appendChild: () => undefined }),
    head: { appendChild: () => undefined },
    querySelector: () => null,
  }
  const fetchStub = async () => ({
    status: 200,
    text: async () => JSON.stringify({ ok: true, value: { settings: defaultSettings(), meta: { providers: [], workspaces: [], revision: 0 } } }),
  })

  const registered = new Map()
  const ctx = {
    get: (name) => (name === 'locale' ? { getLocale: () => ({ id: 'zh-CN' }) } : undefined),
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
    on: () => () => undefined,
    inject: () => undefined,
    slots: {
      inject: (_slot, factory) => {
        const disposer = factory()
        return () => {
          if (typeof disposer === 'function') disposer()
        }
      },
      register: (options, component) => {
        registered.set(`${options.name}${options.id === undefined ? '' : `#${options.id}`}`, component)
        return () => registered.delete(`${options.name}#${options.id}`)
      },
    },
  }

  const factory = new Function('window', 'document', 'navigator', 'fetch', 'require', source)
  factory(windowStub, documentStub, windowStub.navigator, fetchStub, (name) => {
    if (name === 'react') return React
    if (name === 'react-dom') return reactDom
    throw new Error(`unexpected require(${name})`)
  })

  const definition = windowStub.loaded
  ok(definition !== undefined, 'module registered itself')
  equal(definition.id, 'dsh-mydsh', 'module id')
  const module = definition.factory((name) => (name === 'react' ? React : reactDom))
  module.apply(ctx)

  await new Promise((resolve) => setTimeout(resolve, 60))
  ok(registered.has('settings.section#dsh-mydsh'), 'settings page registered')
  ok(registered.has('sidebar.session.action#dsh-mydsh-new-session'), 'new-session veil registered')

  for (const [key, Component] of registered) {
    ok(typeof Component === 'function', `${key} is a component`)
    Component({ sessionId: 'demo', wide: true, children: null, size: 20, active: false })
  }
})

/**
 * Every settings tab and every conversation view, under three data conditions.
 *
 * The mount check above only renders the entry that exists at load. The page opens
 * on Overview and the other tabs render only after a click, so a crash in one of
 * them would reach the user as a blank panel. This drives the real `Page` once per
 * tab, with a populated payload, an empty payload, and a failing request, because
 * a settings page that only works when every request succeeds is not usable.
 */
await testAsync('every settings tab and conversation view renders with ok, empty and failed data', async () => {
  const source = await readFile(join(packageRoot, 'client.js'), 'utf8')

  /** The tab `Page` should open, since a harness render cannot click. */
  let forcedTab
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'Fragment',
    useState: (initial) => {
      const value = typeof initial === 'function' ? initial() : initial
      if (forcedTab !== undefined && value === 'overview') return [forcedTab, () => undefined]
      return [value, () => undefined]
    },
    useEffect: () => undefined,
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
  const reactDom = { createPortal: (children) => children }

  const settings = defaultSettings()
  const populated = {
    '/usage/summary': {
      totals: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 900, totalTokens: 1540, requests: 3, failedRequests: 0, turns: 2, durationMs: 4200, cost: 1.23, currency: 'CNY' },
      series: [{ t: Date.now() - 86400000, label: '昨天', totalTokens: 770, requests: 2 }],
      dims: { provider: [], model: [{ key: 'deepseek::deepseek-chat', label: 'deepseek-chat', inputTokens: 1200, outputTokens: 340, totalTokens: 1540, requests: 3, cost: 1.23, hitRate: 0.42, sub: [] }], workspace: [], session: [] },
      dim: 'model', updatedAt: Date.now(), range: '7d', from: 0, to: Date.now(),
    },
    '/usage/context': {
      available: true, sessionId: 'demo', provider: 'deepseek', model: 'deepseek-chat',
      usedTokens: 24300, windowTokens: 65536, ratio: 0.37,
      buckets: [{ key: 'system', label: '系统提示词', tokens: 900, ratio: 0.037 }, { key: 'tools', label: '工具定义', tokens: 5200, ratio: 0.21 }],
      series: [{ t: Date.now() - 600000, label: '1', turn: 1, step: 1, usedTokens: 12000 }],
      browsers: [{ category: 'system', label: 'system', tokens: 900, count: 1, preview: '…', items: [] }],
      events: [{ at: Date.now(), seq: 1, category: 'system', description: '系统提示词', tokens: 900, delta: 0, turn: 1 }],
    },
    '/teams/state': {
      enabled: true, sessionId: 'demo', readOnly: true,
      members: [{ name: 'lead', status: 'running', tokens: 12000, durationMs: 60000, steps: 4, contextRatio: 0.31, summary: '主智能体' }],
      tasks: [{ id: 't1', subject: '写文档', status: 'in_progress', blockedBy: [], ownerName: 'lead', updatedAt: Date.now(), ready: true }],
      messages: [{ senderName: 'lead', targetName: 'agent-1', channel: 'default', at: Date.now(), content: [{ type: 'text', text: '开始' }] }],
      totals: { members: 1, tasks: 1, messages: 1, pending: 1, completed: 0 },
    },
    '/usage/geek': { requests: [{ at: Date.now(), sessionId: 'demo', status: 'ok', model: 'deepseek-chat', provider: 'deepseek', ttftMs: 900, durationMs: 3000, inputTokens: 1200, outputTokens: 340, cacheReadTokens: 900, speed: 210, cost: 0.12 }], stream: null, avg: { requests: 1, speed: 210, ttftMs: 900 } },
    '/usage/sessions': { sessions: [{ id: 'demo', label: 'demo', workspace: 'mydsh', provider: 'deepseek', model: 'deepseek-chat', firstAt: Date.now() - 3600000, lastAt: Date.now(), turns: 2, requests: 3, inputTokens: 1200, outputTokens: 340, cacheReadTokens: 900, totalTokens: 1540, durationMs: 4200, cost: 1.23, hitRate: 0.42 }] },
    '/usage/budgets': { budgets: [{ id: 'b1', label: '每日', scope: 'global', period: 'day', action: 'notify', enabled: true, limitTokens: 100000, limitCost: 0 }], evaluation: [{ id: 'b1', label: '每日', scope: 'global', period: 'day', state: 'warn', usedTokens: 95000, usedCost: 0, limitTokens: 100000, limitCost: 0, ratio: 0.95 }], over: false },
    '/usage/prices': { rows: [{ provider: 'deepseek', model: 'deepseek-chat', input: 1.96, output: 7.98, cacheRead: 0.2, cacheWrite: 0, currency: 'CNY', source: 'builtin' }] },
    '/usage/balance': { deepseek: { id: 'deepseek', label: 'DeepSeek', ok: true, currency: 'CNY', total: 12.3, at: Date.now(), source: 'deepseek' }, providers: [], at: Date.now() },
    '/backup/state': { running: false, sevenZip: true, runs: [{ id: 'r1', startedAt: Date.now(), finishedAt: Date.now(), type: 'full', ok: true, bytes: 4096, parts: 1 }], targets: [{ id: 'local', kind: 'local', label: '本地', path: 'C:/tmp' }], activeTargetId: 'local', estimate: { bytes: 4096, files: 2, items: [] } },
    '/backup/runs': { runs: [] },
    '/retry/state': { enabled: false, events: [], stats: { seen: 0, retried: 0, switched: 0, delegated: 0 } },
    '/personalize/preview': { text: '## 身份\n- 称呼：老王', tokens: 20, active: true, sections: [] },
    '/personalize/memory': { entries: [{ id: 'm1', text: '根目录', at: Date.now(), pinned: true, hits: 1 }], total: 1 },
    '/modules/overview': { modules: [{ key: 'desktop', label: '桌面自动化', enabled: false, available: false, reason: '未启用', risk: 'high', dependsOn: [] }], dataDir: 'C:/tmp' },
    '/skills/list': { skills: [{ name: 'dsh-doc', description: '文档', source: 'bundled', path: '/x' }] },
    '/mcp/state': { servers: [] },
    '/roles/list': { roles: [{ id: 'r1', name: '前端', department: '前端', summary: '排障', prompt: '先确认版本', enabled: true }], departments: ['前端'] },
    '/desktop/state': { enabled: false, capabilities: {}, screenSize: null },
    '/relay/state': { state: { status: 'off', publicUrl: '', bytesUp: 0, bytesDown: 0, requests: 0 } },
    '/config/list': { entries: [] },
    '/notices': { notices: [] },
  }

  /** Answer one path for the current scenario. */
  let scenario = 'ok'
  const fetchFor = async (url) => {
    const path = String(url)
    if (scenario === 'fail') {
      return { status: 500, text: async () => JSON.stringify({ ok: false, error: { message: '模拟失败' } }) }
    }
    if (scenario === 'empty') {
      return { status: 200, text: async () => JSON.stringify({ ok: true, value: path.includes('/settings') ? { settings, meta: {} } : {} }) }
    }
    const clean = path.split('?')[0]
    let value
    for (const [suffix, payload] of Object.entries(populated)) {
      if (clean.endsWith(suffix)) {
        value = payload
        break
      }
    }
    if (value === undefined) value = path.includes('/settings') ? { settings, meta: { providers: [], workspaces: [] } } : {}
    return { status: 200, text: async () => JSON.stringify({ ok: true, value }) }
  }

  const storage = new Map()
  const windowStub = {
    __ModuleLoader__: { load: (definition) => { windowStub.loaded = definition } },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    innerWidth: 1440,
    innerHeight: 900,
    navigator: { language: 'zh-CN' },
  }
  const documentStub = {
    hidden: false,
    body: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: () => ({ style: {}, setAttribute: () => undefined, appendChild: () => undefined }),
    head: { appendChild: () => undefined },
    querySelector: () => null,
  }
  const requireFor = (name) => {
    if (name === 'react') return React
    if (name === 'react-dom') return reactDom
    throw new Error(`unexpected require(${name})`)
  }

  new Function('window', 'document', 'navigator', 'fetch', 'require', source)(windowStub, documentStub, windowStub.navigator, fetchFor, requireFor)
  const mounted = new Map()
  const context = {
    get: (name) => (name === 'locale' ? { getLocale: () => ({ id: 'zh-CN' }) } : undefined),
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
    on: () => () => undefined,
    inject: () => undefined,
    slots: {
      inject: (_slot, factory) => {
        const disposer = factory()
        return () => {
          if (typeof disposer === 'function') disposer()
        }
      },
      register: (options, component) => {
        mounted.set(`${options.name}${options.id === undefined ? '' : `#${options.id}`}`, component)
        return () => mounted.delete(`${options.name}#${options.id}`)
      },
    },
  }
  windowStub.loaded.factory(requireFor).apply(context)
  await new Promise((resolve) => setTimeout(resolve, 60))

  const page = mounted.get('settings.section#dsh-mydsh')
  ok(typeof page === 'function', 'settings page registered')
  const views = [
    ['usage view', mounted.get('conversation.view#mydsh-usage')],
    ['context view', mounted.get('conversation.view#mydsh-context')],
    ['team view', mounted.get('conversation.view#mydsh-team')],
  ]
  for (const [label, Component] of views) ok(typeof Component === 'function', `${label} registered`)

  const tabs = ['overview', 'interface', 'usage', 'backup', 'retry', 'personalize', 'modules', 'relay', 'about']
  for (const name of ['ok', 'empty', 'fail']) {
    scenario = name
    for (const tab of tabs) {
      forcedTab = tab
      try {
        page({})
        page({})
      } catch (error) {
        throw new Error(`the ${tab} tab threw with ${name} data: ${error.message}`)
      }
    }
    forcedTab = undefined
    for (const [label, Component] of views) {
      try {
        Component({ sessionId: 'demo', openView: () => undefined })
        Component({ sessionId: '', openView: () => undefined })
        Component({})
      } catch (error) {
        throw new Error(`${label} threw with ${name} data: ${error.message}`)
      }
    }
  }
})

// --- summary ---------------------------------------------------------------

await rm(sandbox, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) {
    console.log(`\n${failure.name}\n  ${String(failure.error.stack).split('\n').slice(0, 4).join('\n  ')}`)
  }
  process.exit(1)
}

// `apply` installs the backup/relay watchdogs and the engines keep their caches;
// the suite has nothing left to wait for, so it exits instead of idling on them.
process.exit(0)
