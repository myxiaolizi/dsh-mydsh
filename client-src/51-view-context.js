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
