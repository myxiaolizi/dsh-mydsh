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
