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
