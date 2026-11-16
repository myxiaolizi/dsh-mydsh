/**
 * Host half — V2 assembly.
 *
 * One plugin that groups the adjustments a user commonly wants on DeepSeek
 * Harness: interface tweaks, usage accounting, backups, request retry policy, a
 * personalization block, per-capability modules, and remote access through a
 * relay. Every capability is self-contained: this plugin never depends on, reads
 * data from, or changes the configuration of another plugin, so installing it
 * alone is enough.
 *
 * The Host half owns everything that touches the file system, the network, or
 * model requests. The browser half only renders and calls the routes this file
 * registers, so no logic is duplicated across the two halves.
 *
 * Activation is defensive on purpose: every service this plugin uses is
 * resolved with `ctx.get()` and treated as optional, so a profile that mounts
 * none of them still loads the plugin and shows a settings page explaining what
 * is unavailable, instead of failing the whole profile.
 */

import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { SettingsStore } from './host/core/settings-store.js'
import { createRouter, queryFlag, queryInt, queryString } from './host/core/http.js'
import { dataDir, ensureDir } from './host/core/store.js'
import { DEFAULTS, ENTRY_KEYS, PANEL_IDS } from './host/core/settings.js'
import { createNoticeLog } from './host/core/notices.js'
import { createBackupEngine, needsSevenZip } from './host/backup/engine.js'
import { sevenZipBinary } from './host/backup/archive.js'
import { createRetryEngine } from './host/retry/engine.js'
import {
  createPersonalizeEngine,
  registerAgentPersonalize,
  registerDiscipline,
  registerPersonalizePrompt,
} from './host/personalize/index.js'
import { createBudgetGuard } from './host/prompt/index.js'
import { RelayClient } from './host/relay/client.js'
import { createUsageEngine } from './host/usage/engine.js'
import { createConfigManager } from './host/modules/config/index.js'
import { createDesktop } from './host/modules/desktop/index.js'
import { createImageGen } from './host/modules/images/index.js'
import { createInsights } from './host/modules/insights/index.js'
import { createMcpConnector } from './host/modules/mcp/index.js'
import { createRoles } from './host/modules/roles/index.js'

// `index.js` sits at the package root, so one `dirname` of its own file URL is
// the directory that holds `bin/`, `host/` and the rest.
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const LOG_PREFIX = '[dsh-mydsh]'

/** Services this plugin can use; all optional. */
export const inject = []

/** Report one degraded path without flooding the console. */
function warn(message, error) {
  console.warn(`${LOG_PREFIX} ${message}${error === undefined ? '' : `: ${error?.message ?? error}`}`)
}

/**
 * Run a callback on an interval and return a disposer.
 *
 * A plain Node timer is used rather than `ctx.interval`: that helper comes from
 * the timer plugin, and reading it without declaring `timer` in `inject` throws
 * during activation. The handle is unref'd so a pending tick never keeps the
 * process alive on its own.
 *
 * @param callback - invoked each tick.
 * @param delayMs - interval length.
 * @returns a disposer.
 */
function every(callback, delayMs) {
  const handle = setInterval(callback, delayMs)
  handle.unref?.()
  return () => clearInterval(handle)
}

/**
 * The plugin entry.
 * @param ctx - Cordis plugin context.
 */
export async function apply(ctx) {
  const store = await SettingsStore.open()
  const getSettings = () => store.current

  /** Where this plugin writes everything it owns. */
  const home = dataDir()
  await ensureDir(home).catch(() => undefined)

  /** Notices the settings page shows on its next poll, mirrored to disk. */
  const noticeLog = createNoticeLog(home)
  const pushNotice = (notice) => noticeLog.push(notice)

  /** A session's working directory without resuming it. */
  function cwdOf(sessionId) {
    const sessions = ctx.get('sessions')
    const session = sessions?.get?.(sessionId)
    return session?.header?.cwd
  }

  /** Workspace directories, resolved only when something needs them. */
  function resolveWorkspaces() {
    const registry = ctx.get('workspaceRegistry')
    const list = registry?.list?.()
    if (!Array.isArray(list)) return []
    return list
      .map((entry) => ({
        id: String(entry?.id ?? entry?.workspaceId ?? ''),
        title: String(entry?.title ?? entry?.name ?? ''),
        path: String(entry?.path ?? entry?.directory ?? ''),
      }))
      .filter((entry) => entry.path !== '')
  }

  // --- engines -------------------------------------------------------------

  const usage = createUsageEngine({ ctx, getSettings, dshHome: home })
  const binary = sevenZipBinary(PACKAGE_ROOT)
  const backup = createBackupEngine({
    getSettings,
    binary,
    packageRoot: PACKAGE_ROOT,
    workspaces: resolveWorkspaces,
    dshHome: home,
    onNotice: pushNotice,
  })
  const retry = createRetryEngine({ getSettings, onEvent: () => undefined })
  const personalize = createPersonalizeEngine({
    ctx,
    getSettings,
    dshHome: home,
    // The only write path back into the settings document: memory is durable
    // state, and the settings file is the one place this plugin already owns.
    onMemoryChange: (entries) => {
      store.update({ personalize: { memory: { entries } } }).catch((error) => warn('memory persist failed', error))
    },
  })
  const mcp = createMcpConnector({ ctx, getSettings, home })
  const desktop = createDesktop({ ctx, getSettings, home, onNotice: pushNotice })
  const images = createImageGen({ ctx, getSettings, dshHome: home })
  const roles = createRoles({ ctx, getSettings })
  const config = createConfigManager({ ctx, getSettings })
  const insights = createInsights({ ctx, getSettings })

  const relay = new RelayClient({
    getSettings,
    localOrigin: () => {
      const server = ctx.get('webServer')
      try {
        return server?.getOrigin?.() ?? 'http://127.0.0.1:0'
      } catch {
        return 'http://127.0.0.1:0'
      }
    },
  })

  // --- retry wiring --------------------------------------------------------

  ctx.effect(() => ctx.on('agent/request-error', retry.onRequestError), 'dsh-mydsh: retry policy')
  ctx.effect(() => {
    const llm = ctx.get('llm')
    if (llm === undefined || typeof ctx.on !== 'function') return undefined
    return ctx.on('llm/stream', retry.makeStreamWrapper(llm))
  }, 'dsh-mydsh: failover')

  // --- personalization wiring ----------------------------------------------

  const promptDisposer = registerPersonalizePrompt(ctx, getSettings)
  if (promptDisposer !== undefined) ctx.effect(() => promptDisposer, 'dsh-mydsh: personalize section')

  ctx.effect(
    () =>
      ctx.on('agent/created', ({ agent }) => {
        try {
          const disposer = registerAgentPersonalize(agent, getSettings, cwdOf)
          if (disposer !== undefined) agent?.ctx?.effect?.(() => disposer)
        } catch (error) {
          warn('per-agent personalize registration failed', error)
        }
      }),
    'dsh-mydsh: per-agent personalize',
  )

  const disciplineDisposer = registerDiscipline(ctx, getSettings, pushNotice)
  if (disciplineDisposer !== undefined) ctx.effect(() => disciplineDisposer, 'dsh-mydsh: discipline')

  const budgetDisposer = createBudgetGuard(ctx, usage, getSettings, pushNotice)
  if (budgetDisposer !== undefined) ctx.effect(() => budgetDisposer, 'dsh-mydsh: budget guard')

  // --- backup schedules ----------------------------------------------------

  const scheduleState = { lastDaily: '', lastWeekly: '', startupDone: false, lastInterval: 0 }

  /** Run any schedule that is due; cheap enough to call on a timer. */
  async function tickSchedules() {
    const settings = getSettings()
    if (settings.backup.enabled !== true) return
    const now = new Date()
    const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
    const hourMinute = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

    for (const schedule of settings.backup.schedules) {
      if (schedule.enabled !== true) continue
      const items = schedule.items
      if (schedule.trigger === 'startup') {
        if (scheduleState.startupDone) continue
        scheduleState.startupDone = true
        await backup.run({ type: schedule.type, items }).catch((error) => warn('startup backup failed', error))
        continue
      }
      if (schedule.trigger === 'daily') {
        if (schedule.time !== hourMinute || scheduleState.lastDaily === today) continue
        scheduleState.lastDaily = today
        await backup.run({ type: schedule.type, items }).catch((error) => warn('daily backup failed', error))
        continue
      }
      if (schedule.trigger === 'weekly') {
        const key = `${today}#${schedule.weekday}`
        if (now.getDay() !== schedule.weekday || schedule.time !== hourMinute || scheduleState.lastWeekly === key) continue
        scheduleState.lastWeekly = key
        await backup.run({ type: schedule.type, items }).catch((error) => warn('weekly backup failed', error))
        continue
      }
      if (schedule.trigger === 'interval') {
        const due = scheduleState.lastInterval === 0 || Date.now() - scheduleState.lastInterval >= schedule.intervalMinutes * 60000
        if (!due) continue
        scheduleState.lastInterval = Date.now()
        await backup.run({ type: schedule.type, items }).catch((error) => warn('interval backup failed', error))
      }
    }
  }

  // One minute is the finest granularity an `HH:mm` schedule needs, and a timer
  // that does nothing costs less than a watcher over the whole file tree.
  ctx.effect(() => every(() => {
    tickSchedules().catch((error) => warn('backup schedule tick failed', error))
  }, 60000), 'dsh-mydsh: backup scheduler')

  // "after-session" backups fire when a turn ends, not on a clock.
  ctx.effect(
    () =>
      ctx.on('agent/turn-stopping', async () => {
        const settings = getSettings()
        if (settings.backup.enabled !== true) return
        const schedule = settings.backup.schedules.find((entry) => entry.enabled === true && entry.trigger === 'after-session')
        if (schedule === undefined || backup.isRunning()) return
        await backup.run({ type: schedule.type, items: schedule.items }).catch((error) => warn('post-session backup failed', error))
      }),
    'dsh-mydsh: post-session backup',
  )

  // --- relay lifecycle -----------------------------------------------------

  ctx.effect(() => every(() => {
    const relayConfig = getSettings().relay
    if (relayConfig.enabled === true && relayConfig.autoConnect === true && relay.state.status === 'off') {
      relay.start().catch((error) => warn('relay start failed', error))
    }
  }, 30000), 'dsh-mydsh: relay watchdog')
  ctx.effect(() => () => relay.stop(), 'dsh-mydsh: relay teardown')

  // --- MCP servers ---------------------------------------------------------

  /** Registrations currently held, so a settings change can swap them cleanly. */
  let mcpRegistrations = []

  const syncMcp = () => {
    for (const disposer of mcpRegistrations.splice(0, mcpRegistrations.length)) {
      try {
        disposer?.()
      } catch (error) {
        warn('mcp server withdrawal failed', error)
      }
    }
    const settings = getSettings()
    if (settings.modules.mcpConnector.enabled !== true) return
    try {
      mcpRegistrations = mcp.apply() ?? []
    } catch (error) {
      warn('mcp server registration failed', error)
      mcpRegistrations = []
    }
  }

  ctx.effect(
    () => () => {
      for (const disposer of mcpRegistrations.splice(0, mcpRegistrations.length)) {
        try {
          disposer?.()
        } catch {
          // A server that already failed to mount has nothing to withdraw.
        }
      }
    },
    'dsh-mydsh: mcp servers',
  )
  store.subscribe((next, previous) => {
    if (JSON.stringify(next.modules.mcpConnector) !== JSON.stringify(previous.modules.mcpConnector)) syncMcp()
  })
  syncMcp()

  // --- the model catalogue -------------------------------------------------

  /** Provider → models, read once and refreshed when the registry changes. */
  let providerCache = []

  const refreshProviders = async () => {
    const llm = ctx.get('llm')
    if (llm === undefined) return providerCache
    try {
      const providers = typeof llm.listProviders === 'function' ? await llm.listProviders() : []
      const out = []
      for (const provider of Array.isArray(providers) ? providers : []) {
        const id = String(provider?.id ?? provider?.provider ?? provider ?? '')
        if (id === '') continue
        let models = []
        try {
          models = typeof llm.listModels === 'function' ? await llm.listModels(id) : []
        } catch {
          models = []
        }
        out.push({
          provider: id,
          models: (Array.isArray(models) ? models : []).map((model) => ({
            id: String(model?.id ?? ''),
            name: String(model?.name ?? model?.id ?? ''),
            contextWindow: Number(model?.contextWindow ?? model?.contextLength ?? 0) || 0,
          })),
        })
      }
      if (out.length > 0) providerCache = out
    } catch (error) {
      warn('provider catalogue unavailable', error)
    }
    return providerCache
  }

  refreshProviders().catch(() => undefined)
  ctx.effect(
    () => ctx.on('llm/models-updated', () => refreshProviders().catch(() => undefined)),
    'dsh-mydsh: model catalogue',
  )

  // --- HTTP surface --------------------------------------------------------

  const router = createRouter(ctx, { name: 'dsh-mydsh', onError: (error) => warn('route failed', error) })

  const metaOf = () => ({
    defaults: DEFAULTS,
    sevenZip: binary !== undefined,
    dshVersion: String(ctx.get('profileContext')?.version ?? ''),
    dataDir: home,
    panels: PANEL_IDS,
    entries: Object.keys(ENTRY_KEYS),
    providers: providerCache,
    workspaces: resolveWorkspaces(),
    revision: store.revision,
  })

  router.get('/settings', async () => ({ settings: getSettings(), meta: metaOf() }))

  // The settings page polls this while visible: two integers instead of the
  // whole document, which is the difference between 200 bytes every 2 s and
  // 40 KB every 2 s.
  router.get('/settings/revision', async () => ({ revision: store.revision }))

  router.post('/settings', async ({ body }) => {
    const patch = body?.patch
    if (patch === null || typeof patch !== 'object') throw new Error('The settings patch must be an object.')
    const settings = await store.update(patch)
    const relayConfig = settings.relay
    if (relayConfig.enabled !== true) relay.stop()
    else if (relayConfig.autoConnect === true && relay.state.status === 'off') {
      relay.start().catch((error) => warn('relay start failed', error))
    }
    return { settings, meta: metaOf() }
  })

  router.get('/settings/meta', async () => {
    await refreshProviders().catch(() => undefined)
    return { meta: metaOf() }
  })

  router.get('/notices', async () => ({ notices: await noticeLog.drain() }))

  // usage -------------------------------------------------------------------

  router.get('/usage/summary', async ({ url }) =>
    usage.summary({
      range: queryString(url, 'range', '7d'),
      from: Number(url.searchParams.get('from') ?? 0) || undefined,
      to: Number(url.searchParams.get('to') ?? 0) || undefined,
      dim: queryString(url, 'dim', 'model'),
    }),
  )
  router.get('/usage/sessions', async ({ url }) =>
    usage.sessions({
      range: queryString(url, 'range', '7d'),
      from: Number(url.searchParams.get('from') ?? 0) || undefined,
      to: Number(url.searchParams.get('to') ?? 0) || undefined,
    }),
  )
  router.get('/usage/context', async ({ url }) =>
    usage.context({ sessionId: queryString(url, 'sessionId'), mode: queryString(url, 'mode', 'current') }),
  )
  router.get('/usage/context/events', async ({ url }) =>
    usage.contextEvents({
      sessionId: queryString(url, 'sessionId'),
      category: queryString(url, 'category'),
      offset: queryInt(url, 'offset', 0),
      limit: queryInt(url, 'limit', 50, 1, 200),
    }),
  )
  router.get('/usage/balance', async ({ url }) => usage.balance({ force: queryFlag(url, 'force') }))
  router.get('/usage/budgets', async () => usage.budgets())
  router.post('/usage/reindex', async ({ url }) => usage.reindex({ from: Number(url.searchParams.get('from') ?? 0) || undefined }))
  router.get('/usage/geek', async ({ url }) =>
    usage.geek({ sessionId: queryString(url, 'sessionId'), pool: queryInt(url, 'pool', 20, 5, 200) }),
  )
  router.get('/usage/prices', async ({ url }) => usage.prices({ q: queryString(url, 'q') }))
  router.post('/usage/prices', async ({ body }) => ({
    settings: await store.update({ usage: { priceOverrides: body?.overrides ?? [] } }),
  }))

  // backup ------------------------------------------------------------------

  router.get('/backup/state', async () => {
    const runs = await backup.runs()
    return {
      running: backup.isRunning(),
      sevenZip: binary !== undefined,
      needsSevenZip: needsSevenZip(getSettings().backup.compression),
      runs,
      targets: getSettings().backup.targets,
      activeTargetId: getSettings().backup.activeTargetId,
      lastRunAt: runs[0]?.finishedAt ?? 0,
      estimate: await backup.estimate(),
    }
  })
  router.get('/backup/runs', async () => ({ runs: await backup.runs() }))
  router.get('/backup/estimate', async () => backup.estimate())
  router.post('/backup/run', async ({ body }) => ({
    run: await backup.run({ type: body?.type, items: body?.items, targetId: body?.targetId }),
  }))
  router.post('/backup/test', async ({ body }) => backup.testTarget({ target: body?.target }))
  router.post('/backup/targets', async ({ body }) => ({
    settings: await store.update({ backup: { targets: body?.targets ?? [], activeTargetId: body?.activeTargetId } }),
  }))
  router.post('/backup/restore', async ({ body }) => {
    if (typeof body?.runId !== 'string') throw new Error('Name the backup run to restore.')
    return backup.restore({ runId: body.runId, toDir: body?.toDir })
  })
  router.post('/backup/delete', async ({ body }) => {
    if (typeof body?.runId !== 'string') throw new Error('Name the backup run to delete.')
    await backup.deleteRun({ runId: body.runId })
    return { runs: await backup.runs() }
  })
  router.post('/backup/sync', async ({ body }) => backup.sync({ direction: body?.direction, conflict: body?.conflict }))

  // retry -------------------------------------------------------------------

  router.get('/retry/state', async () => {
    await retry.hydrate()
    const limit = getSettings().retry.recordLimit
    return { enabled: getSettings().retry.enabled, events: retry.recent().slice(-limit).reverse(), stats: retry.stats() }
  })
  router.post('/retry/clear', async () => {
    retry.reset()
    return { ok: true }
  })
  router.post('/retry/test', async ({ body }) => retry.dryRun?.(body?.failure ?? {}) ?? { ok: false, message: 'not available' })

  // personalize -------------------------------------------------------------

  router.get('/personalize/preview', async ({ url }) => {
    const cwd = queryString(url, 'cwd')
    return personalize.preview({ cwd: cwd === '' ? undefined : cwd })
  })
  router.get('/personalize/memory', async ({ url }) =>
    personalize.memory.list({ q: queryString(url, 'q'), scope: queryString(url, 'scope') }),
  )
  router.post('/personalize/memory', async ({ body }) => {
    if (body?.add !== null && typeof body?.add === 'object') await personalize.memory.add(body.add)
    if (body?.update !== null && typeof body?.update === 'object') await personalize.memory.update(body.update)
    if (typeof body?.remove === 'string') await personalize.memory.remove({ id: body.remove })
    return personalize.memory.list({})
  })
  router.post('/personalize/memory/clear', async ({ body }) => ({ removed: await personalize.memory.clear({ scope: body?.scope }) }))

  // modules -----------------------------------------------------------------

  router.get('/modules/overview', async () => ({ modules: insights.overview(), dataDir: home }))
  router.get('/context/snapshot', async ({ url }) =>
    usage.context({ sessionId: queryString(url, 'sessionId'), mode: 'current' }),
  )
  router.get('/teams/state', async ({ url }) => insights.teams({ sessionId: queryString(url, 'sessionId') }))
  router.get('/skills/list', async ({ url }) => insights.skills({ q: queryString(url, 'q') }))

  router.get('/mcp/state', async () => ({ servers: mcp.list() }))
  router.post('/mcp/apply', async () => {
    syncMcp()
    return { servers: mcp.list() }
  })
  router.post('/mcp/test', async ({ body }) =>
    mcp.test({ server: body?.server }),
  )

  router.post('/config/list', async () => ({ entries: config.list() }))
  router.post('/config/toggle', async ({ body }) => config.toggle({ id: body?.id, enabled: body?.enabled === true }))
  router.get('/config/values', async ({ url }) => config.values({ id: queryString(url, 'id') }))
  router.post('/config/edit', async ({ body }) => config.edit({ id: body?.id, patch: body?.patch }))

  router.get('/roles/list', async () => roles.list())
  router.post('/roles/apply', async ({ body }) => roles.apply({ roleId: body?.roleId, sessionId: body?.sessionId }))

  router.post('/images/generate', async ({ body }) => images.generate({ ...body }))

  router.get('/desktop/state', async () => desktop.state())
  router.post('/desktop/capture', async ({ body }) => desktop.capture({ sessionId: body?.sessionId }))
  router.post('/desktop/action', async ({ body }) => desktop.action({ ...body }))

  // relay -------------------------------------------------------------------

  router.get('/relay/state', async () => ({ state: relay.state }))
  router.post('/relay/connect', async () => {
    await relay.start()
    return { state: relay.state }
  })
  router.post('/relay/disconnect', async () => {
    relay.stop()
    return { state: relay.state }
  })
  router.post('/relay/test', async ({ body }) => relay.probe(body?.serverUrl))
  router.post('/relay/register', async ({ body }) => {
    if (typeof body?.account !== 'string' || body.account === '') throw new Error('Enter the account name.')
    if (typeof body?.password !== 'string' || body.password.length < 8) throw new Error('The password needs at least 8 characters.')
    const result = await relay.authenticate('register', { account: body.account, password: body.password })
    return { ok: result?.ok !== false, message: result?.message ?? '' }
  })
  router.post('/relay/login', async ({ body }) => {
    if (typeof body?.account !== 'string' || body.account === '') throw new Error('Enter the account name.')
    if (typeof body?.password !== 'string' || body.password === '') throw new Error('Enter the password.')
    const result = await relay.authenticate('login', { account: body.account, password: body.password })
    const token = typeof result?.token === 'string' ? result.token : ''
    if (token !== '') await store.update({ relay: { account: body.account, token } })
    return { token, state: relay.state }
  })

  router.install()

  // A relay with auto-connect starts once the surface exists, so the tunnel's
  // rewritten URLs point at a listener that is actually serving.
  if (getSettings().relay.enabled === true && getSettings().relay.autoConnect === true) {
    relay.start().catch((error) => warn('relay start failed', error))
  }

  console.log(`${LOG_PREFIX} ready (7z: ${binary === undefined ? 'not bundled' : 'bundled'})`)
}
