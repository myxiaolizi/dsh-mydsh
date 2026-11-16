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
