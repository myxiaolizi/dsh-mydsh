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
