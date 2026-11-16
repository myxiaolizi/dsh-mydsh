/**
 * Remote access tab.
 *
 * The tunnel is an *outbound* WebSocket: DSH serves its GUI on loopback, the
 * plugin dials the relay, and the relay forwards browser requests back down that
 * socket. Nothing is opened inbound on this machine, which is why this page can
 * be honest about deployment instead of pretending a checkbox is enough.
 *
 * Four things this page refuses to blur:
 *
 * - The password is never written to the settings document. It lives in this
 *   component for the duration of one register/login call; only the token the
 *   relay hands back is persisted, and the Host writes that itself.
 * - Free-text fields are drafts committed by 保存. Every `patch` is a POST, so
 *   writing per keystroke would send one request per character — and the Host's
 *   probe reads the *stored* URL, so a test must follow a committed save.
 * - "Switched on" and "connected" are separate states. `relay.enabled` is a
 *   preference; the status pill reports what the tunnel is actually doing.
 * - The deployment section is written as instructions, not as a sales pitch: the
 *   plugin forwards nothing to a third party, so the relay has to be the user's.
 */

/** Human wording for one tunnel status. */
const RELAY_STATUS_TEXT = {
  off: '未连接',
  connecting: '连接中…',
  online: '在线',
  error: '连接失败',
}

/** Tone for the status badge, so the colour is decided in one place. */
function relayTone(status) {
  if (status === 'online') return 'ok'
  if (status === 'error') return 'error'
  if (status === 'connecting') return 'warn'
  return undefined
}

/**
 * The live tunnel state: status, public address, traffic counters, uptime.
 *
 * `since` is a timestamp, not a duration, so the online time is recomputed on
 * every poll instead of frozen at connect time.
 */
function RelayStatus({ state, status }) {
  const [copied, setCopied] = useState(false)
  const publicUrl = state?.publicUrl ?? ''
  const online = status === 'online'
  const since = Number(state?.since ?? 0)
  const uptime = online && since > 0 ? Date.now() - since : 0

  const copy = () => {
    if (publicUrl === '') return
    try {
      navigator.clipboard.writeText(publicUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // A browser without the clipboard permission simply does not copy.
    }
  }

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        { className: 'mydsh-inline', style: { minWidth: 0 } },
        h('span', { className: 'mydsh-dot', 'data-tone': relayTone(status) }),
        h(Badge, { tone: relayTone(status) }, RELAY_STATUS_TEXT[status] ?? status ?? t().unknown),
        publicUrl === ''
          ? h('span', { className: 'mydsh-muted' }, '尚未分配公网地址')
          : h(
              'span',
              { className: 'mydsh-inline', style: { minWidth: 0 } },
              h('span', { className: 'mydsh-mono mydsh-truncate', title: publicUrl }, publicUrl),
              h(Button, { size: 'sm', variant: 'ghost', onClick: copy }, copied ? t().copied : t().copy),
            ),
      ),
      h('span', { className: 'mydsh-muted' }, online ? `已在线 ${duration(uptime)}` : ''),
    ),
    state?.message === undefined || state.message === ''
      ? null
      : h(Note, { tone: status === 'error' ? 'error' : 'warn' }, state.message),
    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '4' },
      h(Stat, {
        label: '上行',
        value: bytes(state?.bytesUp ?? 0),
        foot: `${exact(state?.bytesUp ?? 0)} B`,
        accent: 'var(--dsw-alias-state-warn-primary)',
      }),
      h(Stat, {
        label: '下行',
        value: bytes(state?.bytesDown ?? 0),
        foot: `${exact(state?.bytesDown ?? 0)} B`,
        accent: 'var(--dsw-alias-brand-primary)',
      }),
      h(Stat, {
        label: '请求数',
        value: exact(state?.requests ?? 0),
        foot: '经隧道转发的请求',
        accent: 'var(--dsw-alias-state-success-primary)',
      }),
      h(Stat, {
        label: '在线时长',
        value: online ? duration(uptime) : '—',
        foot: online && since > 0 ? `自 ${when(since)}` : '未连接',
        accent: 'var(--dsw-alias-state-error-primary)',
      }),
    ),
  )
}

/** The relay tab. */
function RelayTab({ settings, patch, meta }) {
  const relay = settings.relay ?? {}
  const live = usePoll('/relay/state', 8000, [])
  const [test, testState] = useAction()
  const [connect, connectState] = useAction()
  const [auth, authState] = useAction()
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState(undefined)
  const [showDeploy, setShowDeploy] = useState(false)
  const [saved, setSaved] = useState(false)

  // Drafts for the free-text fields; committed by 保存 (or by the actions that
  // need the value on the Host side).
  const [draft, setDraft] = useState(() => ({
    serverUrl: relay.serverUrl ?? '',
    publicDomain: relay.publicDomain ?? '',
    tunnelName: relay.tunnelName ?? '',
    account: relay.account ?? '',
  }))
  const set = (partial) => {
    setDraft((value) => ({ ...value, ...partial }))
    setSaved(false)
  }

  const state = live.data?.state ?? {}
  const status = state.status ?? 'off'
  const pending = connectState.pending === true || authState.pending === true
  const configured = String(draft.serverUrl ?? '').trim() !== ''
  const savedUrl = String(relay.serverUrl ?? '') !== ''
  const signedIn = String(relay.token ?? '') !== ''
  const canAuth = savedUrl && String(draft.account ?? '').trim() !== '' && password !== ''

  const setRelay = (partial) => {
    patch({ relay: partial }).catch(() => undefined)
  }

  /** Persist the four text fields. Resolves with the accepted document. */
  const commit = () =>
    patch({
      relay: {
        serverUrl: String(draft.serverUrl ?? '').trim().replace(/\/+$/, ''),
        publicDomain: String(draft.publicDomain ?? '').trim(),
        tunnelName: String(draft.tunnelName ?? '').trim(),
        account: String(draft.account ?? '').trim(),
      },
    })
      .then(() => {
        setSaved(true)
        return true
      })
      .catch(() => false)

  /**
   * Test reachability.
   *
   * The Host's probe reads `relay.serverUrl` from its own document, so the draft
   * is committed first; testing against an unsaved address would silently probe
   * the previous one.
   */
  const runTest = () => {
    if (!configured) {
      setNotice({ tone: 'warn', message: '请先填写服务端地址' })
      return
    }
    commit().then((ok) => {
      if (!ok) {
        setNotice({ tone: 'error', message: '服务端地址保存失败' })
        return
      }
      test('/relay/test', {})
        .then((value) => {
          if (value === undefined) return
          setNotice(
            value.ok === false
              ? { tone: 'error', message: value.message ?? '无法连通中转服务端' }
              : {
                  tone: 'ok',
                  message: `连通正常${value.latencyMs === undefined ? '' : ` · ${value.latencyMs} ms`}${value.message === undefined || value.message === '' ? '' : ` · ${value.message}`}`,
                },
          )
        })
        .catch(() => undefined)
    })
  }

  const runConnect = () => {
    connect('/relay/connect', {})
      .then((value) => {
        if (value === undefined) return
        live.reload()
        const next = value.state?.status
        setNotice({
          tone: next === 'online' ? 'ok' : 'warn',
          message: `当前状态：${RELAY_STATUS_TEXT[next] ?? next ?? '—'}${value.state?.message === undefined || value.state.message === '' ? '' : ` · ${value.state.message}`}`,
        })
      })
      .catch(() => undefined)
  }

  const runDisconnect = () => {
    connect('/relay/disconnect', {})
      .then(() => {
        live.reload()
        setNotice({ tone: 'ok', message: '已断开隧道' })
      })
      .catch(() => undefined)
  }

  /**
   * Register or sign in.
   *
   * The account is committed first so the Host's login handler writes the token
   * back against the same name it authenticated. The password is only ever an
   * argument to this one call and is cleared from state on success.
   */
  const runAuth = (mode) => {
    commit().then((ok) => {
      if (!ok) {
        setNotice({ tone: 'error', message: '账号保存失败' })
        return
      }
      auth(mode === 'register' ? '/relay/register' : '/relay/login', {
        account: String(draft.account ?? '').trim(),
        password,
      })
        .then((value) => {
          if (value === undefined) return
          if (mode === 'register') {
            setNotice(
              value.ok === false
                ? { tone: 'error', message: value.message ?? '注册失败' }
                : { tone: 'ok', message: value.message === '' || value.message === undefined ? '注册成功，请用同一账号登录' : value.message },
            )
            return
          }
          setPassword('')
          setNotice(
            value.token === '' || value.token === undefined
              ? { tone: 'warn', message: '登录没有返回 token，请检查服务端配置' }
              : { tone: 'ok', message: '登录成功，token 已由宿主写回设置；点「连接」建立隧道' },
          )
          live.reload()
        })
        .catch(() => undefined)
    })
  }

  const deployLines = [
    ['DNS', '为 mdsh.zhengl.vip 添加一条 A 记录，指向服务器公网 IP；等解析生效后再申请证书，否则签发会失败。'],
    ['站点', '宝塔里新建站点绑定该域名，开启 Let\'s Encrypt 证书并强制 HTTPS。'],
    ['反代', '在站点配置里加一段反向代理转发到本机中转服务端口（例如 http://127.0.0.1:8787），并透传 Upgrade 与 Connection 头，否则隧道握手会被挡掉。'],
    ['服务', '把中转服务端注册成 systemd 单元：ExecStart 指向你的 node 与入口文件，设置 Restart=always，再用 systemctl enable --now 拉起。'],
    ['变量', '在单元里配置 RELAY_SECRET（签发 token 用，务必长且随机）与 RELAY_ADMIN_TOKEN（管理接口用）。这两个值不要写进仓库。'],
    ['验证', 'curl https://mdsh.zhengl.vip/healthz 返回 200 即通；再在插件里点「测试连通」，然后注册账号并登录。'],
  ]

  return h(
    'div',
    { className: 'mydsh-page' },
    h(Note, null, '本插件不会把任何数据转发给第三方：远程访问必须由你自己部署中转服务端，插件只负责拨打你的地址。'),

    h(
      Card,
      {
        title: '总开关',
        sub: '关闭时隧道不会建立，也不产生任何后台请求',
        actions: h(Badge, { tone: relayTone(status) }, RELAY_STATUS_TEXT[status] ?? status),
      },
      h(SwitchRow, {
        title: '启用远程访问',
        hint: '允许插件建立到中转服务端的隧道',
        checked: relay.enabled === true,
        onChange: (value) => setRelay({ enabled: value }),
      }),
      h(SwitchRow, {
        title: '启动后自动连接',
        hint: 'DSH 启动且开关为开时自动建立隧道',
        checked: relay.autoConnect === true,
        onChange: (value) => setRelay({ autoConnect: value }),
        disabled: relay.enabled !== true,
      }),
      relay.enabled === true
        ? null
        : h(Note, { tone: 'warn' }, '总开关当前关闭，下面的连接按钮不会生效。'),
    ),

    h(
      Card,
      { title: '服务端', sub: '你部署的中转服务地址；没有它，账号与连接都无从谈起' },
      h(Row, { title: '服务端地址', hint: '形如 https://你的域名，结尾斜杠会自动去掉' },
        h(TextField, {
          value: draft.serverUrl,
          onChange: (value) => set({ serverUrl: value }),
          width: 'xl',
          mono: true,
          placeholder: 'https://mdsh.zhengl.vip',
          onEnter: commit,
        }),
      ),
      h(Row, { title: '公网域名', hint: '给用户看的访问地址；留空则用服务端地址' },
        h(TextField, {
          value: draft.publicDomain,
          onChange: (value) => set({ publicDomain: value }),
          width: 'lg',
          mono: true,
          placeholder: 'mdsh.zhengl.vip',
          onEnter: commit,
        }),
      ),
      h(Row, { title: '隧道名称', hint: '同一账号跑多条隧道时用于区分，可留空' },
        h(TextField, {
          value: draft.tunnelName,
          onChange: (value) => set({ tunnelName: value }),
          width: 'md',
          mono: true,
          onEnter: commit,
        }),
      ),
      h(
        Row,
        { title: '地址设置', hint: saved ? '已保存' : '改完先保存，再测试连通' },
        h(
          'div',
          { className: 'mydsh-inline' },
          h(Button, { size: 'sm', onClick: commit }, t().save),
          h(
            Button,
            { size: 'sm', variant: 'primary', onClick: runTest, disabled: testState.pending === true },
            testState.pending === true ? '测试中…' : '测试连通',
          ),
        ),
      ),
      testState.error === undefined ? null : h(Note, { tone: 'error' }, testState.error),
    ),

    // One notice channel for the whole page: a login result must not be shown
    // under the server-address card, where it reads as an address error.
    notice === undefined ? null : h(Note, { tone: notice.tone }, notice.message),

    h(
      Card,
      { title: '账号', sub: '账号存在你自己的中转服务端上；密码不会写入设置文件' },
      h(Row, { title: '账号', hint: '注册与登录都用它' },
        h(TextField, {
          value: draft.account,
          onChange: (value) => set({ account: value }),
          width: 'md',
          mono: true,
          placeholder: 'your-name',
        }),
      ),
      h(
        Row,
        { title: '密码', hint: '仅本次操作使用，不落盘；注册至少 8 位', stack: true },
        h(
          'div',
          { className: 'mydsh-inline' },
          h(TextField, {
            value: password,
            onChange: setPassword,
            width: 'md',
            type: 'password',
            placeholder: signedIn ? '已登录（重登需重新输入）' : '••••••••',
          }),
          h(Button, { size: 'sm', disabled: pending || !canAuth, onClick: () => runAuth('register') }, '注册'),
          h(Button, { size: 'sm', variant: 'primary', disabled: pending || !canAuth, onClick: () => runAuth('login') }, '登录'),
        ),
      ),
      h(
        'div',
        { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
        h(Badge, { tone: signedIn ? 'ok' : undefined }, signedIn ? '已有 token' : '未登录'),
        h('span', { className: 'mydsh-muted' }, '登录成功后 token 由宿主写回设置，本页不显示 token 内容'),
      ),
      !savedUrl
        ? h(Note, { tone: 'warn' }, '请先保存服务端地址，否则注册与登录无法发起。')
        : null,
      authState.error === undefined ? null : h(Note, { tone: 'error' }, authState.error),
    ),

    h(
      Card,
      {
        title: '连接控制',
        sub: '建立或断开隧道；状态每 8 秒刷新一次',
        actions: h(Button, { size: 'sm', variant: 'ghost', onClick: () => live.reload() }, `⟳ ${t().refresh}`),
      },
      h(
        'div',
        { className: 'mydsh-inline' },
        h(
          Button,
          {
            variant: 'primary',
            disabled: pending || relay.enabled !== true || status === 'online' || status === 'connecting',
            onClick: runConnect,
          },
          connectState.pending === true ? '连接中…' : '连接',
        ),
        h(Button, { variant: 'danger', disabled: pending || status === 'off', onClick: runDisconnect }, '断开'),
        h(
          'span',
          { className: 'mydsh-muted' },
          live.loading === true
            ? t().loading
            : meta.dshVersion === undefined || meta.dshVersion === ''
              ? ''
              : `DSH ${meta.dshVersion}`,
        ),
      ),
      connectState.error === undefined ? null : h(Note, { tone: 'error' }, connectState.error),
      live.error === undefined ? null : h(Note, { tone: 'error' }, live.error),
      h(RelayStatus, { state, status }),
    ),

    h(
      Card,
      {
        title: '部署说明',
        sub: '宝塔 + nginx + systemd 的最小可用路径',
        actions: h(
          Button,
          { size: 'sm', variant: 'ghost', onClick: () => setShowDeploy((value) => !value) },
          showDeploy ? '收起' : '展开',
        ),
      },
      showDeploy
        ? h(
            'div',
            { className: 'mydsh-list' },
            deployLines.map(([label, text]) =>
              h(
                'div',
                { key: label, style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
                h('span', { style: { flexShrink: 0 } }, h(Badge, null, label)),
                h('span', { className: 'mydsh-muted' }, text),
              ),
            ),
            h(
              'div',
              { className: 'mydsh-muted mydsh-mono', style: { whiteSpace: 'pre-wrap', paddingTop: 6 } },
              'curl https://mdsh.zhengl.vip/healthz\nsystemctl status <中转服务单元名>\njournalctl -u <中转服务单元名> -n 100 --no-pager',
            ),
            h(Note, { tone: 'warn' }, '反向代理必须透传 Upgrade 与 Connection 头，否则 WebSocket 握手会以 400/426 失败；HTTPS 站点请用 wss。'),
          )
        : h('div', { className: 'mydsh-muted' }, '点「展开」查看 DNS、证书、反代、systemd 与环境变量六项要点。'),
    ),
  )
}
