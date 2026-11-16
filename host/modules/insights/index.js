/**
 * Read-only insights: skill catalogue, team board, and the module overview.
 *
 * All three are *views*. Nothing here mutates a session, a team or a plugin, and
 * that is a deliberate boundary rather than an unfinished one: DSH already owns
 * the authoritative writers for every one of these (the skill registry, the team
 * task board, the plugin manager), and a second writer would have to guess at
 * their invariants. The value this module adds is aggregation — one request that
 * answers "what can this installation actually do right now, and why not".
 *
 * `teams.readOnly` is honoured as a hard gate: any future write entry point
 * refuses through {@link createInsights}'s `assertWritable` before touching
 * anything.
 */

import {
  LIMITS,
  describe,
  failure,
  flag,
  hasMethod,
  intIn,
  moduleSettings,
  record,
  serviceOf,
  text,
} from '../shared.js'

/** Cap on rows any single view returns; a UI list never needs more. */
const MAX_ROWS = 500

/** Cap on messages scanned from one session log. */
const MAX_MESSAGES = 100

/**
 * The module catalogue the overview reports.
 *
 * Kept here rather than derived from `DEFAULTS.modules` because the overview
 * needs three things the settings document does not carry: a human label, a risk
 * rating, and the services/platform each module depends on. Those are facts about
 * this build, so they live beside the code that implements them.
 */
const CATALOG = Object.freeze([
  { key: 'recentMetrics', label: '极客请求指标', risk: 'low', dependsOn: [], available: () => ({ ok: true, reason: '' }) },
  { key: 'contextInsight', label: '上下文洞察', risk: 'low', dependsOn: ['sessionQuery'], available: () => ({ ok: true, reason: '' }) },
  { key: 'balance', label: '余额与配额', risk: 'low', dependsOn: [], available: () => ({ ok: true, reason: '' }) },
  { key: 'tokenAggregate', label: 'Token 聚合看板', risk: 'low', dependsOn: ['sessionQuery'], available: () => ({ ok: true, reason: '' }) },
  { key: 'memory', label: '长期记忆', risk: 'medium', dependsOn: [], available: () => ({ ok: true, reason: '' }) },
  { key: 'discipline', label: '行为纪律', risk: 'medium', dependsOn: [], available: () => ({ ok: true, reason: '' }) },
  {
    key: 'desktop',
    label: '桌面自动化',
    risk: 'high',
    dependsOn: [],
    available: () =>
      process.platform === 'win32'
        ? { ok: true, reason: '' }
        : { ok: false, reason: `只支持 Windows（当前平台 ${process.platform}）` },
  },
  {
    key: 'mcpConnector',
    label: 'MCP 连接器',
    risk: 'high',
    dependsOn: ['mcpManager'],
    available: (ctx) => ({ ok: hasMethod(serviceOf(ctx, 'mcpManager'), 'register'), reason: '缺少 mcpManager 服务' }),
  },
  {
    key: 'configManager',
    label: '配置与插件管理',
    risk: 'medium',
    dependsOn: ['configEditor'],
    available: (ctx) => ({
      ok: hasMethod(serviceOf(ctx, 'configEditor'), 'entries'),
      reason: '缺少 configEditor 服务',
    }),
  },
  {
    key: 'skills',
    label: '技能中心',
    risk: 'low',
    dependsOn: ['skills'],
    available: (ctx) => ({ ok: hasMethod(serviceOf(ctx, 'skills'), 'list'), reason: '缺少 skills 服务' }),
  },
  {
    key: 'roles',
    label: '角色专家库',
    risk: 'medium',
    dependsOn: ['agents', 'systemPrompt'],
    available: (ctx) => ({ ok: hasMethod(serviceOf(ctx, 'agents'), 'get'), reason: '缺少 agents 服务' }),
  },
  {
    key: 'imageGen',
    label: '图像生成',
    risk: 'medium',
    dependsOn: [],
    available: () => (typeof fetch === 'function' ? { ok: true, reason: '' } : { ok: false, reason: '当前运行时不提供 fetch' }),
  },
  {
    key: 'teams',
    label: '编队视图',
    risk: 'low',
    dependsOn: ['agentTeams', 'subagents'],
    available: (ctx) => ({
      ok: hasMethod(serviceOf(ctx, 'agentTeams'), 'listTasks') || hasMethod(serviceOf(ctx, 'subagents'), 'listDescendants'),
      reason: '缺少 agentTeams 与 subagents 服务',
    }),
  },
  {
    key: 'browserView',
    label: '浏览器实时视图',
    risk: 'high',
    dependsOn: [],
    // Not implemented in this build: the CDP screencast needs a page-side
    // transport this plugin does not ship, and half a browser view is worse than
    // none. Reported honestly instead of hiding the row.
    available: () => ({ ok: false, reason: '本版本未实现（需要 CDP 投屏通道）' }),
  },
])

/**
 * Create the insights module.
 * @param options.ctx - plugin context; every service is optional.
 * @param options.getSettings - synchronous settings reader.
 * @returns the module surface used by `/skills/*`, `/teams/state` and `/modules/overview`.
 */
export function createInsights({ ctx, getSettings }) {
  const settingsOf = (key) => moduleSettings(getSettings, key)

  /**
   * `ModuleRow[]` for every module this build knows about.
   *
   * `enabled` comes from the settings document, `available` from the live
   * process. Both are reported separately on purpose: "switched on but
   * unavailable" and "available but switched off" are different states, and a UI
   * that conflates them cannot tell a user what to do next.
   * @returns rows in catalogue order.
   */
  function overview() {
    return CATALOG.map((entry) => {
      const slice = settingsOf(entry.key)
      const enabled = slice.enabled === true
      let probe
      try {
        probe = entry.available(ctx)
      } catch (error) {
        probe = { ok: false, reason: describe(error) }
      }
      return {
        key: entry.key,
        label: entry.label,
        enabled,
        available: probe.ok === true,
        reason: probe.ok === true ? '' : probe.reason,
        risk: entry.risk,
        dependsOn: [...entry.dependsOn],
      }
    })
  }

  /**
   * The skill catalogue.
   *
   * `ctx.skills` is the maintained registry; `sessionSkillCatalog` is the older
   * projection some builds expose, read as a fallback so an installation that
   * predates the registry still shows its skills. A failure in either is an empty
   * list, never an exception: the skills page is informational.
   * @param options.q - case-insensitive filter over name and description.
   * @returns `{ skills: [{ name, description, source, path }] }`.
   */
  async function skills({ q } = {}) {
    if (settingsOf('skills').enabled !== true) return { skills: [], reason: '技能中心模块未启用' }
    const needle = text(q, 200).toLowerCase()

    /** Reduce one raw entry to the four public fields. */
    const toRow = (raw) => {
      const entry = record(raw)
      if (entry === undefined) return undefined
      const name = text(entry.name ?? entry.skill ?? entry.id, LIMITS.id)
      if (name === '') return undefined
      return {
        name,
        description: text(entry.description ?? entry.summary, LIMITS.summary),
        source: text(entry.source ?? entry.origin ?? entry.provider, 64),
        path: text(entry.path ?? entry.file ?? entry.resourceBase?.path, LIMITS.command),
      }
    }

    const collect = (rows) => {
      const out = []
      const seen = new Set()
      for (const raw of Array.isArray(rows) ? rows : []) {
        const row = toRow(raw)
        if (row === undefined || seen.has(row.name)) continue
        seen.add(row.name)
        if (needle !== '' && !`${row.name} ${row.description}`.toLowerCase().includes(needle)) continue
        out.push(row)
        if (out.length >= MAX_ROWS) break
      }
      return out
    }

    const registry = serviceOf(ctx, 'skills')
    if (hasMethod(registry, 'list')) {
      try {
        const rows = await registry.list()
        const skills = collect(rows)
        if (skills.length > 0 || Array.isArray(rows)) return { skills, source: 'skills' }
      } catch {
        // Fall through to the legacy projection.
      }
    }

    const legacy = serviceOf(ctx, 'sessionSkillCatalog')
    if (hasMethod(legacy, 'list')) {
      try {
        const rows = await legacy.list()
        return { skills: collect(rows), source: 'sessionSkillCatalog' }
      } catch (error) {
        return { skills: [], reason: describe(error) }
      }
    }
    if (hasMethod(legacy, 'entries')) {
      try {
        return { skills: collect(legacy.entries()), source: 'sessionSkillCatalog' }
      } catch (error) {
        return { skills: [], reason: describe(error) }
      }
    }
    return { skills: [], reason: '当前版本没有可用的技能目录服务' }
  }

  /**
   * Refuse a write when the module is configured read-only.
   *
   * Nothing in this module writes today; the gate exists so that adding one
   * cannot accidentally bypass the setting.
   * @returns `undefined` when writing is allowed, else a structured failure.
   */
  function assertWritable() {
    const slice = settingsOf('teams')
    if (slice.enabled !== true) return failure('编队视图模块未启用')
    if (flag(slice.readOnly, true)) return failure('编队视图配置为只读，写操作已拒绝')
    return undefined
  }

  /**
   * Read-only team state for one lead session.
   *
   * Three independent sources, each optional: the team service owns the task
   * board, the subagent runtime owns the member tree, and the lead session's own
   * log holds the message history. A missing source degrades one array and the
   * other two still answer.
   * @param options.sessionId - the lead session.
   * @returns `{ enabled, members, tasks, messages, totals }`.
   */
  async function teams({ sessionId } = {}) {
    const slice = settingsOf('teams')
    const wanted = text(sessionId, 128)
    const empty = { enabled: false, members: [], tasks: [], messages: [], totals: { members: 0, tasks: 0, messages: 0, pending: 0, completed: 0 } }
    if (slice.enabled !== true) return { ...empty, reason: '编队视图模块未启用' }
    if (wanted === '') return { ...empty, reason: '缺少会话 ID' }

    const agents = serviceOf(ctx, 'agents')
    let agent
    if (hasMethod(agents, 'get')) {
      try {
        agent = agents.get(wanted)
      } catch {
        agent = undefined
      }
    }

    // --- members ------------------------------------------------------------
    const members = []
    const subagents = serviceOf(ctx, 'subagents')
    if (hasMethod(subagents, 'listDescendants')) {
      try {
        const rows = await subagents.listDescendants(wanted)
        for (const raw of Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : []) {
          const entry = record(raw)
          if (entry === undefined) continue
          if (text(entry.kind, 16) === 'diagnostic') {
            members.push({
              id: text(entry.id, 128),
              name: text(entry.path, 128) || text(entry.id, 128),
              status: 'unavailable',
              depth: 0,
              usage: null,
              message: `子代理目录不可读：${text(entry.reason, 32)}`,
            })
            continue
          }
          members.push({
            id: text(entry.id, 128),
            name: text(entry.path, 128) || text(entry.name, 128) || text(entry.id, 128),
            status: text(entry.activity, 32) === 'running' ? 'running' : 'inactive',
            depth: intIn(entry.depth, 1, 0, 32),
            hasChildren: entry.hasChildren === true,
            usage: usageOf(entry.usage ?? entry.tokens),
          })
        }
      } catch (error) {
        members.push({ id: '', name: '(成员读取失败)', status: 'error', depth: 0, usage: null, message: describe(error) })
      }
    }

    // --- tasks --------------------------------------------------------------
    const tasks = []
    const team = serviceOf(ctx, 'agentTeams')
    if (agent !== undefined && hasMethod(team, 'listTasks')) {
      try {
        const rows = team.listTasks(agent)
        for (const raw of Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : []) {
          const entry = record(raw)
          if (entry === undefined) continue
          tasks.push({
            id: text(entry.id, 128),
            subject: text(entry.subject, 200),
            status: text(entry.status, 32),
            revision: intIn(entry.revision, 0, 0, 1e9),
            blockedBy: Array.isArray(entry.blockedBy) ? entry.blockedBy.map((id) => text(id, 128)).filter(Boolean).slice(0, 32) : [],
            owner: text(entry.ownerName, 128) || text(entry.ownerId, 128),
            writeScopes: Array.isArray(entry.writeScopes) ? entry.writeScopes.map((scope) => text(scope, 300)).filter(Boolean).slice(0, 32) : [],
          })
        }
      } catch (error) {
        tasks.push({ id: '', subject: '(任务读取失败)', status: 'error', revision: 0, blockedBy: [], owner: '', writeScopes: [], message: describe(error) })
      }
    }

    // --- messages -----------------------------------------------------------
    const messages = []
    const sessions = serviceOf(ctx, 'sessions')
    if (hasMethod(sessions, 'get')) {
      try {
        const session = sessions.get(wanted)
        const events = session?.snapshotEvents?.() ?? session?.ownEvents?.() ?? []
        for (const event of Array.isArray(events) ? events : []) {
          const type = text(event?.type, 64)
          if (type !== 'team/message/queued' && type !== 'team/message/delivered') continue
          const data = record(event?.data)
          const message = record(data?.message)
          if (message === undefined) {
            messages.push({
              at: 0,
              direction: 'out',
              summary: `消息已投递（${text(data?.targetId, 64)}）`,
            })
            continue
          }
          messages.push({
            at: 0,
            direction: 'out',
            from: text(message.senderName, 128),
            to: text(message.targetId, 128),
            summary: summarizeContent(message.content),
          })
          if (messages.length >= MAX_MESSAGES) break
        }
      } catch {
        // The lead session may have no readable log; an empty list is honest.
      }
    }

    const completed = tasks.filter((task) => task.status === 'completed').length
    return {
      enabled: true,
      sessionId: wanted,
      readOnly: flag(slice.readOnly, true),
      members,
      tasks,
      messages,
      totals: {
        members: members.length,
        tasks: tasks.length,
        messages: messages.length,
        pending: tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress').length,
        completed,
      },
    }
  }

  return { overview, skills, teams, assertWritable, catalog: CATALOG }
}

/** Reduce a token accounting record into the three numbers a member row shows. */
function usageOf(raw) {
  const value = record(raw)
  if (value === undefined) return null
  const input = intIn(value.inputTokens ?? value.input, 0, 0, 1e12)
  const output = intIn(value.outputTokens ?? value.output, 0, 0, 1e12)
  const total = intIn(value.totalTokens ?? value.total, input + output, 0, 1e12)
  if (input === 0 && output === 0 && total === 0) return null
  return { inputTokens: input, outputTokens: output, totalTokens: total }
}

/** One-line summary of a message body without dumping the whole payload. */
function summarizeContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content.slice(0, 3)) {
    const value = record(block)
    if (value === undefined) continue
    if (value.type === 'text') parts.push(text(value.text, 160))
    else parts.push(`[${text(value.type, 24)}]`)
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim()
  return joined.length > 240 ? `${joined.slice(0, 239)}…` : joined
}

/** Exported for the self-test: the catalogue keys the overview must cover. */
export const INSIGHT_CATALOG = Object.freeze(CATALOG.map((entry) => entry.key))
