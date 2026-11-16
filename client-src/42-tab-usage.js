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
