/**
 * Capability modules tab.
 *
 * One plugin, many capabilities: this page is the only place where every module
 * this build ships is visible at once, each one switchable on its own, with the
 * cost of switching it on stated next to it. Three rules shape the layout:
 *
 * - State comes from the Host (`/modules/overview`), never from a local table of
 *   assumptions, so "not supported on this machine" is reported rather than
 *   guessed. `enabled` and `available` stay separate: "on but unusable" and
 *   "usable but off" need different advice.
 * - A high-risk module asks for confirmation the first time it is switched on.
 *   When a preset turns several on at once the dialog drains them one at a time,
 *   so a bulk action cannot quietly widen local permissions.
 * - Every switch writes through `patch`, which applies optimistically and
 *   persists the accepted document. This file keeps no copy of the settings.
 */

/** One line about what a module actually does, for its summary card. */
const MODULE_BLURB = {
  recentMetrics: '输入区状态栏显示首字时间、速度与本会话消耗，点击展开最近请求',
  contextInsight: '标题栏与会话标签的上下文占用、构成与变化趋势',
  balance: '查询 DeepSeek 与自定义供应商的余额和配额',
  tokenAggregate: '把本机会话日志聚合成按日、模型、工作区的用量看板',
  memory: '长期记忆：保存确认过的信息，并在后续会话按作用域注入',
  discipline: '行为纪律：纠偏、防作弊与验收提示，源自 PUA 的思路',
  desktop: 'Windows 桌面自动化：读屏、截图、键鼠与窗口操作',
  mcpConnector: '接入外部 MCP 服务器，把它们提供的工具交给模型',
  configManager: '在设置页里启停插件、查看与编辑各插件的配置',
  skills: '列出本机可用技能及其来源，可在侧栏保留常驻入口',
  roles: '角色专家库：内置与自定义专家，可按需注入到会话',
  imageGen: '用 OpenAI 兼容接口生成图片，保存到本机目录',
  teams: '读取 DSH 内置编队数据（成员、任务、消息），只读展示',
  browserView: '接管真实浏览器并实时投屏（本版本未实现）',
}

/** The concrete cost of a high-risk switch, shown in the confirmation dialog. */
const MODULE_RISK_NOTE = {
  desktop: '放宽本机权限：可以截取屏幕内容、模拟键盘与鼠标、切换窗口焦点。',
  mcpConnector: '放宽工具面：外部 MCP 服务器提供的工具会对模型可见并可被调用。',
  browserView: '放宽工具面：会接入真实浏览器并读取其页面内容（本版本未实现）。',
}

/**
 * The three one-click presets.
 *
 * A preset only ever turns modules ON; it never switches anything off, because a
 * bulk action that silently disables a capability the user chose earlier is the
 * kind of surprise that makes a settings page untrustworthy. `keys: null` means
 * "every module the Host reports".
 */
const MODULE_PRESETS = [
  {
    id: 'light',
    label: '轻量',
    sub: '只开用量类，零额外权限',
    keys: ['recentMetrics', 'contextInsight', 'balance', 'tokenAggregate'],
  },
  {
    id: 'daily',
    label: '日常',
    sub: '用量 + 个性化（记忆/纪律）+ 技能与配置管理',
    keys: [
      'recentMetrics',
      'contextInsight',
      'balance',
      'tokenAggregate',
      'memory',
      'discipline',
      'skills',
      'configManager',
      'teams',
    ],
  },
  {
    id: 'full',
    label: '全量',
    sub: '全部打开，高风险仍逐个确认',
    keys: null,
  },
]

/** Risk chip for one module row. */
function ModuleRisk({ risk }) {
  if (risk === 'high') return h(Badge, { tone: 'error' }, t().riskHigh)
  if (risk === 'medium') return h(Badge, { tone: 'warn' }, t().riskMid)
  return h(Badge, null, t().riskLow)
}

/**
 * One module summary card: label, one-line purpose, risk, status and switch.
 * An unavailable module keeps its switch visible but disabled, and explains why
 * underneath — the row is the answer to "why can I not turn this on".
 */
function ModuleCard({ row, onToggle }) {
  const available = row.available !== false
  return h(
    'section',
    { className: 'mydsh-card' },
    h(
      'header',
      { className: 'mydsh-card-head' },
      h(
        'div',
        { style: { minWidth: 0 } },
        h(
          'div',
          { className: 'mydsh-card-title' },
          h('span', { className: 'mydsh-truncate' }, row.label),
          h(ModuleRisk, { risk: row.risk }),
        ),
        h('div', { className: 'mydsh-card-sub' }, MODULE_BLURB[row.key] ?? ''),
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(
          Badge,
          { tone: available === false ? 'warn' : row.enabled === true ? 'ok' : undefined },
          available === false ? t().unavailable : row.enabled === true ? t().enabled : t().disabled,
        ),
        h(Switch, {
          checked: row.enabled === true,
          onChange: (next) => onToggle(row, next),
          label: row.label,
          disabled: available !== true,
        }),
      ),
    ),
    available === false
      ? h(Note, { tone: 'warn' }, row.reason === '' || row.reason === undefined ? '当前环境不支持该能力。' : row.reason)
      : null,
    (row.dependsOn ?? []).length === 0
      ? null
      : h('div', { className: 'mydsh-muted' }, `依赖服务：${(row.dependsOn ?? []).join('、')}`),
  )
}

/** A collapsible card holding one module's detailed settings. */
function ModuleSection({ title, sub, row, open, onToggle, children }) {
  return h(
    'section',
    { className: 'mydsh-card' },
    h(
      'header',
      { className: 'mydsh-card-head', onClick: onToggle, style: { cursor: 'pointer' } },
      h(
        'div',
        { style: { minWidth: 0 } },
        h(
          'div',
          { className: 'mydsh-card-title' },
          h('span', { className: 'mydsh-muted' }, open ? '▾' : '▸'),
          h('span', null, title),
          row === undefined ? null : h(ModuleRisk, { risk: row.risk }),
          row === undefined
            ? null
            : h(
                Badge,
                { tone: row.available === false ? 'warn' : row.enabled === true ? 'ok' : undefined },
                row.available === false ? t().unavailable : row.enabled === true ? t().enabled : t().disabled,
              ),
        ),
        h('div', { className: 'mydsh-card-sub' }, sub),
      ),
      h(
        Button,
        {
          variant: 'ghost',
          size: 'sm',
          onClick: (event) => {
            event.stopPropagation()
            onToggle()
          },
        },
        open ? '收起' : '展开',
      ),
    ),
    open ? children : null,
  )
}

/**
 * The high-risk confirmation dialog.
 *
 * `queue` holds every module still waiting for a confirmation, so a preset that
 * enables three high-risk modules asks three times rather than once. Confirming
 * acknowledges one module and advances the queue; cancelling drops the rest.
 */
function ModuleConfirm({ queue, onConfirm, onCancel }) {
  const head = queue[0]
  if (head === undefined) return null
  const remaining = queue.length - 1
  return h(
    Modal,
    {
      title: '启用高风险能力',
      onClose: onCancel,
      footer: [
        h(Button, { key: 'cancel', onClick: onCancel }, t().cancel),
        h(
          Button,
          { key: 'ok', variant: 'primary', onClick: onConfirm },
          remaining > 0 ? `确认启用（还有 ${remaining} 项待确认）` : '确认启用',
        ),
      ],
    },
    h(Note, { tone: 'error' }, t().riskHighConfirm),
    h(
      'div',
      { className: 'mydsh-inline' },
      h(Badge, { tone: 'error' }, t().riskHigh),
      h('strong', null, head.label),
    ),
    h('div', { className: 'mydsh-muted' }, MODULE_RISK_NOTE[head.key] ?? '会放宽本机权限。'),
    h(
      'div',
      { className: 'mydsh-muted' },
      '确认后该能力立即生效；随时可以在本页关闭，关闭后不注册任何组件、也不产生轮询。',
    ),
  )
}

/** Desktop automation: four separate capability gates plus a read-only probe. */
function ModuleDesktop({ slice, row, setModule }) {
  const [state, setState] = useState(undefined)
  const [stateError, setStateError] = useState(undefined)
  const [capture, captureState] = useAction()

  const loadState = useCallback(() => {
    setStateError(undefined)
    api('/desktop/state')
      .then((value) => setState(value))
      .catch((failure) => setStateError(failure?.message ?? String(failure)))
  }, [])

  useEffect(() => {
    loadState()
  }, [loadState])

  const capabilities = state?.capabilities ?? {}
  const screen = state?.screenSize
  const shot = captureState.result
  const unsupported = row !== undefined && row.available === false

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    unsupported
      ? h(Note, { tone: 'warn' }, `本机不可用：${row.reason === '' || row.reason === undefined ? '只支持 Windows' : row.reason}`)
      : h(Note, null, '四项能力分开放行。读屏是截图与屏幕尺寸的前提；键鼠默认关闭，改动前请确认你确实需要模型操作本机。'),
    h(SwitchRow, {
      title: '允许读屏',
      hint: '截图与读取屏幕尺寸；关闭后测试按钮会直接拒绝',
      checked: slice.allowScreen === true,
      onChange: (value) => setModule('desktop', { allowScreen: value }),
    }),
    h(SwitchRow, {
      title: '允许键盘输入',
      hint: '模拟按键与文本输入，可把内容敲进任何获得焦点的窗口',
      checked: slice.allowKeyboard === true,
      onChange: (value) => setModule('desktop', { allowKeyboard: value }),
    }),
    h(SwitchRow, {
      title: '允许鼠标操作',
      hint: '移动、点击、滚轮；与键盘一起构成完整的本机操作面',
      checked: slice.allowMouse === true,
      onChange: (value) => setModule('desktop', { allowMouse: value }),
    }),
    h(SwitchRow, {
      title: '每次动作都二次确认',
      hint: '建议保持开启：每次改动本机状态前宿主都会要求确认',
      checked: slice.confirmEach === true,
      onChange: (value) => setModule('desktop', { confirmEach: value }),
    }),
    h(
      Row,
      { title: '本机能力与屏幕', hint: stateError === undefined ? '由宿主实测，不是静态声明' : stateError, stack: true },
      h(
        'div',
        { className: 'mydsh-inline', style: { flexWrap: 'wrap' } },
        h(Badge, { tone: capabilities.capture === true ? 'ok' : undefined }, `截图 ${capabilities.capture === true ? '可用' : '不可用'}`),
        h(Badge, { tone: capabilities.keyboard === true ? 'ok' : undefined }, `键盘 ${capabilities.keyboard === true ? '可用' : '不可用'}`),
        h(Badge, { tone: capabilities.mouse === true ? 'ok' : undefined }, `鼠标 ${capabilities.mouse === true ? '可用' : '不可用'}`),
        h(Badge, { tone: capabilities.windows === true ? 'ok' : undefined }, `窗口 ${capabilities.windows === true ? '可用' : '不可用'}`),
        h('span', { className: 'mydsh-muted' }, screen === null || screen === undefined ? '屏幕尺寸未读取到' : `屏幕 ${screen.width}×${screen.height}`),
        h(Button, { size: 'sm', onClick: loadState }, '重新读取'),
        h(
          Button,
          {
            size: 'sm',
            variant: 'primary',
            disabled: captureState.pending === true || slice.allowScreen !== true,
            onClick: () => capture('/desktop/capture', {}),
          },
          captureState.pending === true ? '截屏中…' : '测试截屏',
        ),
      ),
    ),
    state?.reason === undefined || state.reason === '' ? null : h(Note, { tone: 'warn' }, state.reason),
    shot === undefined
      ? null
      : shot.ok === false
        ? h(Note, { tone: 'error' }, shot.message ?? '截屏失败')
        : h(
            Note,
            { tone: 'ok' },
            `已截屏：${shot.width ?? '?'}×${shot.height ?? '?'}，保存到 ${shot.path ?? '（未返回路径）'}`,
          ),
  )
}

/**
 * One MCP server row.
 *
 * The fields are edited on a local draft and written on 保存, so a half-typed
 * command never reaches the Host and a 32-server document is not rewritten on
 * every keystroke. The switch, however, writes immediately: enabling a server is
 * a single decision, not a text edit.
 */
function McpServerRow({ server, statusRow, onSave, onRemove, onTest, pending }) {
  const [draft, setDraft] = useState(() => ({
    ...server,
    argsText: Array.isArray(server.args) ? server.args.join('\n') : '',
  }))
  const [testResult, setTestResult] = useState(undefined)

  const set = (partial) => setDraft((value) => ({ ...value, ...partial }))
  const transport = draft.transport === 'streamable-http' ? 'streamable-http' : 'stdio'

  /**
   * The row as the Host should store it.
   *
   * Built from the draft rather than from `server`, so flipping the switch does
   * not silently discard text the user already typed on an unsaved row.
   */
  const payload = (overrides) => {
    const source = { ...draft, ...overrides }
    const mode = source.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
    return {
      id: source.id,
      name: String(source.name ?? '').trim(),
      label: String(source.label ?? '').trim(),
      enabled: source.enabled === true,
      transport: mode,
      command: mode === 'stdio' ? String(source.command ?? '').trim() : '',
      args: String(source.argsText ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== ''),
      url: mode === 'streamable-http' ? String(source.url ?? '').trim() : '',
      cwd: String(source.cwd ?? '').trim(),
      env: String(source.env ?? ''),
      headers: String(source.headers ?? ''),
      toolPrefix: String(source.toolPrefix ?? '').trim(),
    }
  }

  const save = () => onSave(payload({}))

  const runTest = () => {
    onTest(payload({}))
      .then((value) => setTestResult(value))
      .catch(() => undefined)
  }

  const status = statusRow?.status ?? 'unknown'

  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
    },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        { className: 'mydsh-inline', style: { minWidth: 0 } },
        h('span', { className: 'mydsh-dot', 'data-tone': status === 'connected' ? 'ok' : status === 'failed' ? 'error' : undefined }),
        h('strong', { className: 'mydsh-truncate' }, draft.label === '' ? draft.name || '(未命名)' : draft.label),
        h(Badge, null, transport === 'stdio' ? 'stdio' : 'http'),
        statusRow === undefined
          ? null
          : h(Badge, { tone: status === 'connected' ? 'ok' : status === 'failed' ? 'error' : undefined }, statusRow.status),
        statusRow === undefined ? null : h('span', { className: 'mydsh-muted' }, `${exact(statusRow.toolCount)} 个工具`),
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Switch, {
          checked: draft.enabled === true,
          onChange: (value) => {
            set({ enabled: value })
            onSave(payload({ enabled: value }))
          },
          label: '启用该服务器',
        }),
        h(Button, { size: 'sm', onClick: save }, t().save),
        h(Button, { size: 'sm', onClick: runTest, disabled: pending === true }, pending === true ? '测试中…' : '测试'),
        h(Button, { size: 'sm', variant: 'danger', onClick: () => onRemove(server.id) }, t().remove),
      ),
    ),
    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '2' },
      h(Row, { title: '标识 id', hint: '行内唯一，删改不影响其他行' }, h(TextField, {
        value: draft.id,
        onChange: (value) => set({ id: value }),
        width: 'md',
        mono: true,
      })),
      h(Row, { title: '注册名 name', hint: '工具前缀与状态都按这个名字对应' }, h(TextField, {
        value: draft.name,
        onChange: (value) => set({ name: value }),
        width: 'md',
        mono: true,
      })),
      h(Row, { title: '显示名 label' }, h(TextField, {
        value: draft.label,
        onChange: (value) => set({ label: value }),
        width: 'md',
      })),
      h(
        Row,
        { title: '传输方式', hint: '填了命令走 stdio，填了地址走 http' },
        h(Segmented, {
          value: transport,
          onChange: (value) => set({ transport: value }),
          options: [
            { value: 'stdio', label: 'stdio' },
            { value: 'streamable-http', label: 'http' },
          ],
        }),
      ),
    ),
    transport === 'stdio'
      ? h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h(Row, { title: '命令', hint: '可执行文件名或绝对路径' }, h(TextField, {
            value: draft.command,
            onChange: (value) => set({ command: value }),
            width: 'lg',
            mono: true,
          })),
          h(Row, { title: '参数', hint: '一行一个，空行忽略' }, h(TextField, {
            value: draft.argsText,
            onChange: (value) => set({ argsText: value }),
            width: 'xl',
            mono: true,
            placeholder: '--root\\nD:\\\\data',
          })),
          h(Row, { title: '工作目录', hint: '可选，留空用宿主当前目录' }, h(TextField, {
            value: draft.cwd,
            onChange: (value) => set({ cwd: value }),
            width: 'xl',
            mono: true,
          })),
          h(Row, { title: '环境变量', hint: 'KEY=VALUE 一行一个，或直接粘 JSON 对象', stack: true },
            h(TextArea, {
              value: draft.env,
              onChange: (value) => set({ env: value }),
              rows: 3,
              placeholder: 'API_KEY=sk-…',
            }),
          ),
        )
      : h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h(Row, { title: '服务地址', hint: 'streamable-http 的完整 URL' }, h(TextField, {
            value: draft.url,
            onChange: (value) => set({ url: value }),
            width: 'xl',
            mono: true,
            placeholder: 'https://example.com/mcp',
          })),
          h(Row, { title: '请求头', hint: 'Name: value 一行一个，或直接粘 JSON 对象', stack: true },
            h(TextArea, {
              value: draft.headers,
              onChange: (value) => set({ headers: value }),
              rows: 3,
              placeholder: 'Authorization: Bearer …',
            }),
          ),
        ),
    h(Row, { title: '工具名前缀', hint: '可选，避免与其他服务器重名' }, h(TextField, {
      value: draft.toolPrefix,
      onChange: (value) => set({ toolPrefix: value }),
      width: 'md',
      mono: true,
    })),
    statusRow?.lastError === undefined || statusRow.lastError === ''
      ? null
      : h(Note, { tone: 'error' }, statusRow.lastError),
    testResult === undefined
      ? null
      : testResult.ok === false
        ? h(Note, { tone: 'error' }, testResult.message ?? '测试失败')
        : h(
            Note,
            { tone: 'ok' },
            `连接成功：${(testResult.toolNames ?? []).length} 个工具` +
              `${(testResult.toolNames ?? []).length === 0 ? '' : `（${testResult.toolNames.slice(0, 8).join('、')}）`}` +
              `${testResult.durationMs === undefined ? '' : ` · ${testResult.durationMs} ms`}`,
          ),
  )
}

/** MCP connector: server list, apply, and the live per-server state. */
function ModuleMcp({ slice, row, setModule }) {
  const state = usePoll('/mcp/state', 15000, [])
  const [apply, applyState] = useAction()
  const [test, testState] = useAction()
  const [notice, setNotice] = useState(undefined)

  const servers = Array.isArray(slice.servers) ? slice.servers : []
  const liveRows = state.data?.servers ?? []

  const write = (rows) => setModule('mcpConnector', { servers: rows })

  const saveRow = (next) => {
    if (next.id === undefined || next.id === '') return
    write(servers.map((entry) => (entry.id === next.id ? next : entry)))
    setNotice({ tone: 'ok', message: '已保存，点「应用」后生效' })
  }

  const addRow = () => {
    write([
      ...servers,
      {
        id: newId('mcp'),
        name: `server-${servers.length + 1}`,
        label: '',
        enabled: false,
        transport: 'stdio',
        command: '',
        args: [],
        url: '',
        cwd: '',
        env: '',
        headers: '',
        toolPrefix: '',
      },
    ])
    setNotice(undefined)
  }

  const removeRow = (id) => {
    write(servers.filter((entry) => entry.id !== id))
    setNotice({ tone: 'ok', message: '已删除，点「应用」后生效' })
  }

  /**
   * Apply the settings to the Host.
   *
   * The route answers `{ servers }` (the live rows after re-registration), so the
   * count comes from those rows rather than from a status field this build may
   * not send.
   */
  const runApply = () => {
    apply('/mcp/apply', {})
      .then((value) => {
        if (value === undefined) return
        const live = Array.isArray(value.servers) ? value.servers : []
        const connected = live.filter((entry) => entry.status === 'connected').length
        const failed = live.filter((entry) => entry.status === 'failed')
        setNotice(
          failed.length === 0
            ? { tone: 'ok', message: `已应用：${connected} / ${live.length} 个服务器已连接` }
            : {
                tone: 'error',
                message: `${failed.length} 个服务器连接失败：${failed.map((entry) => `${entry.label === '' ? entry.name : entry.label}（${entry.lastError}）`).join('、')}`,
              },
        )
        state.reload()
      })
      .catch(() => undefined)
  }

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    row !== undefined && row.available === false
      ? h(Note, { tone: 'warn' }, `本机不可用：${row.reason === '' || row.reason === undefined ? '缺少 mcpManager 服务' : row.reason}`)
      : h(Note, null, '启用一个服务器只是把它写进设置；改动后需要点「应用」才会注册到宿主。禁用的服务器不会被注册。'),
    h(SwitchRow, {
      title: '随宿主启动自动应用',
      hint: '宿主启动后按设置里的启用列表注册一次',
      checked: slice.autoStart === true,
      onChange: (value) => setModule('mcpConnector', { autoStart: value }),
    }),
    h(SwitchRow, {
      title: '每会话独立工具集',
      hint: '按会话注册服务器，断开后回收；关闭则为全局可用',
      checked: slice.perSessionTools === true,
      onChange: (value) => setModule('mcpConnector', { perSessionTools: value }),
    }),
    h(
      Row,
      { title: '服务器', hint: `${servers.length} 条配置，${liveRows.filter((entry) => entry.status === 'connected').length} 个已连接` },
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Button, { size: 'sm', onClick: addRow }, `＋ ${t().add}`),
        h(Button, { size: 'sm', variant: 'primary', onClick: runApply, disabled: applyState.pending === true },
          applyState.pending === true ? '应用中…' : '应用'),
        h(Button, { size: 'sm', variant: 'ghost', onClick: () => state.reload() }, `⟳ ${t().refresh}`),
      ),
    ),
    notice === undefined ? null : h(Note, { tone: notice.tone }, notice.message),
    applyState.error === undefined ? null : h(Note, { tone: 'error' }, applyState.error),
    state.error === undefined ? null : h(Note, { tone: 'error' }, state.error),
    servers.length === 0
      ? h(Empty, null, '还没有配置 MCP 服务器')
      : h(
          'div',
          { className: 'mydsh-list' },
          servers.map((entry) =>
            h(McpServerRow, {
              key: entry.id === undefined || entry.id === '' ? entry.name : entry.id,
              server: entry,
              statusRow: liveRows.find((live) => live.name === entry.name),
              onSave: saveRow,
              onRemove: removeRow,
              onTest: (draft) => test('/mcp/test', { server: draft }),
              pending: testState.pending,
            }),
          ),
        ),
    liveRows.length === 0
      ? null
      : h(
          'table',
          { className: 'mydsh-table' },
          h('thead', null,
            h('tr', null,
              h('th', null, '服务器'),
              h('th', null, '传输'),
              h('th', null, '状态'),
              h('th', { 'data-num': 'true' }, '工具数'),
              h('th', null, '错误'),
            ),
          ),
          h('tbody', null,
            liveRows.map((entry) =>
              h('tr', { key: entry.name },
                h('td', null, entry.label === '' ? entry.name : entry.label),
                h('td', { className: 'mydsh-muted' }, entry.transport),
                h('td', null, h(Badge, { tone: entry.status === 'connected' ? 'ok' : entry.status === 'failed' ? 'error' : undefined }, entry.status)),
                h('td', { 'data-num': 'true' }, exact(entry.toolCount)),
                h('td', { className: 'mydsh-muted mydsh-truncate', title: entry.lastError }, entry.lastError ?? ''),
              ),
            ),
          ),
        ),
  )
}

/**
 * Image generation over an OpenAI-compatible endpoint.
 *
 * Free-text fields are edited on a draft and written with 保存: the settings
 * document is persisted through a POST, so writing on every keystroke would send
 * one request per character. Single-click controls (provider, size, count) write
 * immediately because they are one decision, not a text edit.
 */
function ModuleImageGen({ slice, setModule }) {
  const [generate, generateState] = useAction()
  const [keyDraft, setKeyDraft] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [draft, setDraft] = useState(() => ({
    baseUrl: slice.baseUrl ?? '',
    model: slice.model ?? '',
    saveDir: slice.saveDir ?? '',
  }))
  const [saved, setSaved] = useState(false)

  const set = (partial) => {
    setDraft((value) => ({ ...value, ...partial }))
    setSaved(false)
  }
  const commit = () => {
    setModule('imageGen', {
      baseUrl: String(draft.baseUrl ?? '').trim(),
      model: String(draft.model ?? '').trim(),
      saveDir: String(draft.saveDir ?? '').trim(),
    })
    setSaved(true)
  }

  const images = Array.isArray(generateState.result?.images) ? generateState.result.images : []
  const failure = generateState.result !== undefined && generateState.result.ok === false ? generateState.result.message : undefined
  const hasKey = slice.apiKey !== undefined && slice.apiKey !== ''
  const hasEndpoint = String(slice.baseUrl ?? '') !== ''

  const saveKey = () => {
    setModule('imageGen', { apiKey: keyDraft.trim() })
    setKeyDraft('')
    setKeySaved(true)
  }

  const runTest = () => {
    // Commit the endpoint first: the Host reads it from the settings document, so
    // a test against an unsaved draft would probe the previous address.
    commit()
    generate('/images/generate', {
      prompt: '一只橘猫坐在窗台上看雨，扁平插画风格，纯色背景',
      count: 1,
      size: slice.size ?? '1024x1024',
    })
  }

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    !hasEndpoint
      ? h(Note, { tone: 'warn' }, '还没有配置 Base URL，先填写接口地址并保存，才能测试生成。')
      : !hasKey
        ? h(Note, { tone: 'warn' }, '还没有配置 API Key。若你的接口不需要鉴权可以留空，否则请先填入。')
        : h(Note, null, `接口就绪：${slice.baseUrl} · 默认 ${slice.size ?? '1024x1024'}`),
    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '2' },
      h(
        Row,
        { title: '接口类型' },
        h(Select, {
          value: slice.provider ?? 'openai-compatible',
          onChange: (value) => setModule('imageGen', { provider: value }),
          options: [
            { value: 'openai-compatible', label: 'OpenAI 兼容' },
            { value: 'custom', label: '自定义' },
            { value: 'deepseek', label: 'DeepSeek（暂不支持）' },
          ],
        }),
      ),
      h(
        Row,
        { title: '尺寸' },
        h(Select, {
          value: slice.size ?? '1024x1024',
          onChange: (value) => setModule('imageGen', { size: value }),
          options: ['256x256', '512x512', '768x768', '1024x1024', '1024x1536', '1536x1024', '1792x1024', '1024x1792', 'auto'].map(
            (value) => ({ value, label: value }),
          ),
        }),
      ),
      h(
        Row,
        { title: '张数', hint: '单次最多 4 张' },
        h(Select, {
          value: String(slice.count ?? 1),
          onChange: (value) => setModule('imageGen', { count: Number(value) }),
          options: ['1', '2', '3', '4'].map((value) => ({ value, label: value })),
        }),
      ),
    ),
    h(Row, { title: 'Base URL', hint: '会拼成 /images/generations' }, h(TextField, {
      value: draft.baseUrl,
      onChange: (value) => set({ baseUrl: value }),
      width: 'xl',
      mono: true,
      placeholder: 'https://api.openai.com/v1',
      onEnter: commit,
    })),
    h(Row, { title: '模型', hint: '留空则用接口默认值' }, h(TextField, {
      value: draft.model,
      onChange: (value) => set({ model: value }),
      width: 'lg',
      mono: true,
      placeholder: 'gpt-image-1',
      onEnter: commit,
    })),
    h(Row, { title: '保存目录', hint: '留空则存到 DSH 数据目录下的 images' }, h(TextField, {
      value: draft.saveDir,
      onChange: (value) => set({ saveDir: value }),
      width: 'xl',
      mono: true,
      placeholder: 'C:\\Data\\images',
      onEnter: commit,
    })),
    h(
      Row,
      { title: '接口设置', hint: saved ? '已保存' : '改完点这里写入设置' },
      h(Button, { size: 'sm', onClick: commit }, t().save),
    ),
    h(
      Row,
      { title: 'API Key', hint: hasKey ? '已配置，重填会覆盖' : '只保存在本机设置文件里', stack: true },
      h(
        'div',
        { className: 'mydsh-inline' },
        h(TextField, {
          value: keyDraft,
          onChange: (value) => {
            setKeyDraft(value)
            setKeySaved(false)
          },
          width: 'xl',
          mono: true,
          type: 'password',
          placeholder: hasKey ? '已配置（留空保持不变）' : 'sk-…',
        }),
        h(Button, { size: 'sm', onClick: saveKey, disabled: keyDraft.trim() === '' }, '保存密钥'),
        keySaved ? h('span', { className: 'mydsh-muted' }, '已保存') : null,
      ),
    ),
    h(
      Row,
      { title: '测试生成', hint: '用一个固定短句跑一次，只验证链路' },
      h(Button, {
        variant: 'primary',
        size: 'sm',
        disabled: generateState.pending === true,
        onClick: runTest,
      }, generateState.pending === true ? '生成中…' : '测试生成'),
    ),
    generateState.error === undefined ? null : h(Note, { tone: 'error' }, generateState.error),
    failure === undefined ? null : h(Note, { tone: 'error' }, failure),
    images.length === 0
      ? null
      : h(
          Note,
          { tone: 'ok' },
          `已生成 ${images.length} 张：${images.map((entry) => entry.path ?? entry.url ?? '（无路径）').join('、')}`,
        ),
  )
}

/** One custom role row: name, department, summary and the injected prompt. */
function RoleRow({ role, onSave, onRemove }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(() => ({ ...role }))
  const set = (partial) => setDraft((value) => ({ ...value, ...partial }))

  const save = () => {
    onSave({
      id: draft.id,
      name: String(draft.name ?? '').trim(),
      department: String(draft.department ?? '').trim() || '通用',
      summary: String(draft.summary ?? '').trim(),
      prompt: String(draft.prompt ?? ''),
      enabled: draft.enabled === true,
    })
    setOpen(false)
  }

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        { className: 'mydsh-inline', style: { minWidth: 0 } },
        h(Badge, null, draft.department === '' ? '通用' : draft.department),
        h('strong', { className: 'mydsh-truncate' }, draft.name === '' ? '(未命名)' : draft.name),
        draft.enabled === true ? null : h(Badge, { tone: 'warn' }, t().disabled),
        draft.summary === '' ? null : h('span', { className: 'mydsh-muted mydsh-truncate', title: draft.summary }, draft.summary),
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Switch, {
          checked: draft.enabled === true,
          onChange: (value) => {
            set({ enabled: value })
            onSave({ ...role, enabled: value })
          },
          label: '启用该专家',
        }),
        h(Button, { size: 'sm', onClick: () => setOpen((value) => !value) }, open ? '收起' : t().edit),
        h(Button, { size: 'sm', variant: 'danger', onClick: () => onRemove(role.id) }, t().remove),
      ),
    ),
    open
      ? h(
          'div',
          { className: 'mydsh-list' },
          h(
            'div',
            { className: 'mydsh-grid', 'data-cols': '2' },
            h(Row, { title: '名称' }, h(TextField, { value: draft.name, onChange: (value) => set({ name: value }), width: 'md' })),
            h(Row, { title: '部门', hint: '用于分组，可自定' }, h(TextField, { value: draft.department, onChange: (value) => set({ department: value }), width: 'md' })),
          ),
          h(Row, { title: '一句话简介' }, h(TextField, { value: draft.summary, onChange: (value) => set({ summary: value }), width: 'xl' })),
          h(Row, { title: '提示词', hint: '注入到会话的角色说明', stack: true },
            h(TextArea, { value: draft.prompt, onChange: (value) => set({ prompt: value }), rows: 5 }),
          ),
          h(
            'div',
            { className: 'mydsh-inline', style: { justifyContent: 'flex-end' } },
            h(Button, { size: 'sm', onClick: () => setDraft({ ...role }) }, t().reset),
            h(Button, { size: 'sm', variant: 'primary', onClick: save }, t().save),
          ),
        )
      : null,
  )
}

/** Role expert library: custom role editing plus the read-only catalogue. */
function ModuleRoles({ slice, setModule }) {
  const [query, setQuery] = useState('')
  const catalogue = usePoll('/roles/list', 30000, [])

  const customRoles = Array.isArray(slice.customRoles) ? slice.customRoles : []
  const write = (rows) => setModule('roles', { customRoles: rows })

  const saveRole = (next) => {
    if (next.id === undefined || next.id === '') return
    write(customRoles.map((entry) => (entry.id === next.id ? next : entry)))
  }
  const addRole = () => {
    write([
      ...customRoles,
      { id: newId('role'), name: '新专家', department: '通用', summary: '', prompt: '', enabled: true },
    ])
  }
  const removeRole = (id) => write(customRoles.filter((entry) => entry.id !== id))

  const roles = Array.isArray(catalogue.data?.roles) ? catalogue.data.roles : []
  const keyword = query.trim().toLowerCase()
  const filtered = keyword === ''
    ? roles
    : roles.filter((entry) =>
        [entry.name, entry.department, entry.summary].some((field) => String(field ?? '').toLowerCase().includes(keyword)),
      )
  const groups = useMemo(() => {
    const map = new Map()
    for (const entry of filtered) {
      const key = String(entry.department ?? '通用')
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(entry)
    }
    return [...map.entries()]
  }, [filtered])

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h(Note, null, '内置专家随插件提供，只读；自定义专家会写进设置，可在下方编辑提示词。'),
    h(SwitchRow, {
      title: '把专家目录注入会话',
      hint: '开启后模型能看到专家清单，可主动点名调用',
      checked: slice.injectCatalog === true,
      onChange: (value) => setModule('roles', { injectCatalog: value }),
    }),
    h(
      Row,
      { title: '自定义专家', hint: `${customRoles.length} 位` },
      h(Button, { size: 'sm', onClick: addRole }, `＋ ${t().add}`),
    ),
    customRoles.length === 0
      ? h(Empty, null, '还没有自定义专家')
      : h(
          'div',
          { className: 'mydsh-list' },
          customRoles.map((entry) =>
            h(RoleRow, { key: entry.id, role: entry, onSave: saveRole, onRemove: removeRole }),
          ),
        ),
    h(
      Row,
      { title: '专家目录', hint: `${filtered.length} / ${roles.length} 位`, stack: true },
      h(TextField, {
        value: query,
        onChange: setQuery,
        width: 'xl',
        placeholder: '按名称、部门或简介搜索',
      }),
    ),
    catalogue.error === undefined ? null : h(Note, { tone: 'error' }, catalogue.error),
    catalogue.data?.reason === undefined ? null : h(Note, { tone: 'warn' }, catalogue.data.reason),
    groups.length === 0
      ? h(Empty, null, catalogue.loading === true ? t().loading : '没有匹配的专家')
      : h(
          'div',
          { className: 'mydsh-list' },
          groups.map(([department, rows]) =>
            h(
              'div',
              { key: department, className: 'mydsh-list' },
              h('div', { className: 'mydsh-muted' }, `${department} · ${rows.length}`),
              rows.map((entry) =>
                h(
                  'div',
                  { key: entry.id, className: 'mydsh-inline', style: { justifyContent: 'space-between', padding: '3px 0' } },
                  h(
                    'div',
                    { className: 'mydsh-inline', style: { minWidth: 0 } },
                    h('span', { className: 'mydsh-truncate' }, entry.name),
                    h(Badge, { tone: entry.custom === true ? 'warn' : undefined }, entry.custom === true ? '自定义' : '内置'),
                  ),
                  h('span', { className: 'mydsh-muted mydsh-truncate', title: entry.summary, style: { maxWidth: '52%' } }, entry.summary ?? ''),
                ),
              ),
            ),
          ),
        ),
  )
}

/**
 * The configuration editor dialog: current values as JSON, secrets masked.
 *
 * The Host answers `***` for a field that looks like a credential and keeps the
 * stored value when the same sentinel comes back, so leaving a masked field
 * untouched is a no-op rather than a wipe. The write route wraps its module
 * result one level deep (`{ entry: { ok, message } }`), which is unwrapped here.
 */
function ModuleConfigEditModal({ id, title, onClose, onSaved }) {
  const [value, setValue] = useState(undefined)
  const [text, setText] = useState('')
  const [error, setError] = useState(undefined)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState(undefined)

  useEffect(() => {
    let alive = true
    api(`/config/values?id=${encodeURIComponent(id)}`)
      .then((result) => {
        if (!alive) return
        if (result?.ok === false) {
          setError(result.message ?? '读取配置失败')
          return
        }
        setValue(result?.value ?? {})
        setText(JSON.stringify(result?.value ?? {}, null, 2))
      })
      .catch((failure) => {
        if (alive) setError(failure?.message ?? String(failure))
      })
    return () => {
      alive = false
    }
  }, [id])

  const save = () => {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (failure) {
      setError(`不是合法的 JSON：${failure?.message ?? failure}`)
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError('顶层必须是一个 JSON 对象')
      return
    }
    setError(undefined)
    setSaving(true)
    api('/config/edit', { body: { id, patch: parsed } })
      .then((response) => {
        const result = response?.entry ?? {}
        if (result.ok === false) {
          setError(result.message ?? '写入失败')
          return
        }
        setNotice(result.message === '' || result.message === undefined ? '已写入' : result.message)
        if (typeof onSaved === 'function') onSaved()
      })
      .catch((failure) => setError(failure?.message ?? String(failure)))
      .finally(() => setSaving(false))
  }

  return h(
    Modal,
    {
      title: `编辑配置 · ${title}`,
      onClose,
      footer: [
        h(Button, { key: 'cancel', onClick: onClose }, t().close),
        h(Button, { key: 'save', variant: 'primary', onClick: save, disabled: saving || value === undefined }, saving ? '写入中…' : t().save),
      ],
    },
    h(Note, null, '密钥类字段显示为 ***，保持原样即保留已存的值；改成新值才会覆盖。'),
    error === undefined ? null : h(Note, { tone: 'error' }, error),
    notice === undefined ? null : h(Note, { tone: 'ok' }, notice),
    value === undefined && error === undefined
      ? h(Empty, null, t().loading)
      : h(TextArea, { value: text, onChange: setText, rows: 14 }),
  )
}

/** One plugin row in the configuration manager. */
function ConfigEntryRow({ entry, allowToggle, onToggle, onEdit, pending }) {
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
    h(
      'div',
      { style: { minWidth: 0, display: 'flex', flexDirection: 'column' } },
      h('span', { className: 'mydsh-truncate' }, entry.title === '' || entry.title === undefined ? entry.name ?? entry.id : entry.title),
      h(
        'span',
        { className: 'mydsh-muted mydsh-truncate', title: entry.why === '' ? entry.id : `${entry.id} · ${entry.why}` },
        entry.why === undefined || entry.why === '' ? entry.id : `${entry.id} · ${entry.why}`,
      ),
    ),
    h(
      'div',
      { className: 'mydsh-inline' },
      entry.readOnly === true ? h(Badge, { tone: 'warn' }, '只读') : null,
      h(Badge, { tone: entry.enabled === true ? 'ok' : undefined }, entry.enabled === true ? t().enabled : t().disabled),
      h(Switch, {
        checked: entry.enabled === true,
        onChange: (value) => onToggle(entry, value),
        label: entry.name ?? entry.id,
        disabled: entry.readOnly === true || allowToggle !== true || pending === true,
      }),
      h(Button, { size: 'sm', onClick: () => onEdit(entry) }, t().edit),
    ),
  )
}

/** Configuration and plugin management. */
function ModuleConfig({ slice, setModule }) {
  const [entries, setEntries] = useState(undefined)
  const [error, setError] = useState(undefined)
  const [notice, setNotice] = useState(undefined)
  const [editing, setEditing] = useState(undefined)
  const [running, setRunning] = useState(false)

  const loadRows = useCallback(() => {
    api('/config/list', { body: {} })
      .then((result) => {
        if (result?.ok === false) {
          setError(result.message ?? '读取插件列表失败')
          setEntries([])
          return
        }
        setError(undefined)
        setEntries(Array.isArray(result?.entries) ? result.entries : [])
      })
      .catch((failure) => {
        setError(failure?.message ?? String(failure))
        setEntries([])
      })
  }, [])

  useEffect(() => {
    loadRows()
  }, [loadRows])

  const toggle = (entry, enabled) => {
    setRunning(true)
    api('/config/toggle', { body: { id: entry.id, enabled } })
      .then((response) => {
        // The route wraps the module result: `{ entry: { ok, entry, restartRequired, message } }`.
        const result = response?.entry ?? {}
        if (result.ok === false) {
          setNotice({ tone: 'error', message: result.message ?? '启停失败' })
          return
        }
        setNotice(
          result.restartRequired === true
            ? { tone: 'warn', message: '已写入，重启 DSH 后生效' }
            : { tone: 'ok', message: result.message === '' || result.message === undefined ? '已切换' : result.message },
        )
        loadRows()
      })
      .catch((failure) => setNotice({ tone: 'error', message: failure?.message ?? String(failure) }))
      .finally(() => setRunning(false))
  }

  const rows = entries ?? []

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h(Note, null, '这里只读写各插件自己的配置层，不直接改动 profile 补丁文本。标为只读的行由管理端维护。'),
    h(SwitchRow, {
      title: '允许在此启停插件',
      hint: '关掉后开关全部禁用，只能查看',
      checked: slice.allowPluginToggle === true,
      onChange: (value) => setModule('configManager', { allowPluginToggle: value }),
    }),
    h(SwitchRow, {
      title: '允许编辑插件配置',
      hint: '关掉后「编辑」按钮仍然可见但会拒绝写入',
      checked: slice.allowConfigEdit === true,
      onChange: (value) => setModule('configManager', { allowConfigEdit: value }),
    }),
    h(
      Row,
      { title: '插件列表', hint: `${rows.length} 行` },
      h(Button, { size: 'sm', variant: 'ghost', onClick: loadRows }, `⟳ ${t().refresh}`),
    ),
    notice === undefined ? null : h(Note, { tone: notice.tone }, notice.message),
    error === undefined ? null : h(Note, { tone: 'error' }, error),
    entries === undefined
      ? h(Empty, null, t().loading)
      : rows.length === 0
        ? h(Empty, null, '宿主没有上报任何可管理的插件行')
        : h(
            'div',
            { className: 'mydsh-list mydsh-scroll' },
            rows.map((entry) =>
              h(ConfigEntryRow, {
                key: entry.id,
                entry,
                allowToggle: slice.allowPluginToggle === true,
                pending: running,
                onToggle: toggle,
                onEdit: (row) => setEditing(row),
              }),
            ),
          ),
    editing === undefined
      ? null
      : h(ModuleConfigEditModal, {
          id: editing.id,
          title: editing.title === '' || editing.title === undefined ? editing.name ?? editing.id : editing.title,
          onClose: () => setEditing(undefined),
          onSaved: () => {
            loadRows()
            settingsStore.refresh(true)
          },
        }),
  )
}

/**
 * Skill catalogue plus the sidebar entry switch.
 *
 * The search filters the already-loaded list instead of re-querying per
 * keystroke: the catalogue is small and a GET per character would be noise on the
 * Host for no benefit.
 */
function ModuleSkills({ slice, setModule }) {
  const [query, setQuery] = useState('')
  const poll = usePoll('/skills/list', 30000, [])
  const all = Array.isArray(poll.data?.skills) ? poll.data.skills : []
  const keyword = query.trim().toLowerCase()
  const skills = keyword === ''
    ? all
    : all.filter((entry) =>
        [entry.name, entry.description, entry.source].some((field) => String(field ?? '').toLowerCase().includes(keyword)),
      )

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h(SwitchRow, {
      title: '在侧栏显示技能入口',
      hint: '常驻一个技能列表入口，便于随时查看与调用',
      checked: slice.showInSidebar === true,
      onChange: (value) => setModule('skills', { showInSidebar: value }),
    }),
    h(Row, { title: '搜索技能', hint: `${skills.length} / ${all.length} 项` }, h(TextField, {
      value: query,
      onChange: setQuery,
      width: 'xl',
      placeholder: '按名称或描述搜索',
    })),
    poll.data?.reason === undefined ? null : h(Note, { tone: 'warn' }, poll.data.reason),
    poll.error === undefined ? null : h(Note, { tone: 'error' }, poll.error),
    skills.length === 0
      ? h(Empty, null, poll.loading === true ? t().loading : '没有可用的技能')
      : h(
          'table',
          { className: 'mydsh-table' },
          h('thead', null,
            h('tr', null,
              h('th', null, '技能'),
              h('th', null, '说明'),
              h('th', null, '来源'),
            ),
          ),
          h('tbody', null,
            skills.map((entry, index) =>
              h('tr', { key: `${entry.name}-${index}` },
                h('td', null, entry.name),
                h('td', { className: 'mydsh-muted' }, entry.description ?? ''),
                h('td', { className: 'mydsh-muted' }, entry.source ?? ''),
              ),
            ),
          ),
        ),
  )
}

/**
 * Team data, read-only.
 *
 * The member tree, the task board and the message log come from DSH's own team
 * runtime; nothing here writes. The session id is read from the live session
 * service because the team view is per lead session.
 */
function ModuleTeams({ slice, setModule }) {
  const [sessionId, setSessionId] = useState('')

  useEffect(() => {
    const read = () => {
      try {
        const sessions = ctxRef.get('sessions')
        const current = sessions?.current?.() ?? sessions?.active?.()
        const id = String(current?.id ?? current?.sessionId ?? '')
        if (id !== '') setSessionId(id)
      } catch {
        // No session service: the view stays empty with an explanation.
      }
    }
    read()
    const timer = setInterval(read, 5000)
    return () => clearInterval(timer)
  }, [])

  const poll = usePoll(sessionId === '' ? null : `/teams/state?sessionId=${encodeURIComponent(sessionId)}`, 15000, [sessionId])
  const members = Array.isArray(poll.data?.members) ? poll.data.members : []
  const tasks = Array.isArray(poll.data?.tasks) ? poll.data.tasks : []
  const messages = Array.isArray(poll.data?.messages) ? poll.data.messages : []
  const totals = poll.data?.totals ?? {}

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h(Note, null, '读取 DSH 内置编队数据，只读。这里不会创建任务、不会给成员发消息。'),
    h(SwitchRow, {
      title: '只读模式',
      hint: '关闭后本插件也不会写入编队数据；宿主写操作仍由编队工具负责',
      checked: slice.readOnly === true,
      onChange: (value) => setModule('teams', { readOnly: value }),
    }),
    sessionId === ''
      ? h(Note, { tone: 'warn' }, '请先打开一个会话：编队数据按主会话读取。')
      : h('div', { className: 'mydsh-muted' }, `当前会话：${sessionId}`),
    poll.data?.reason === undefined ? null : h(Note, { tone: 'warn' }, poll.data.reason),
    poll.error === undefined ? null : h(Note, { tone: 'error' }, poll.error),
    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '3' },
      h(Stat, { label: '成员', value: exact(totals.members ?? members.length), foot: `${members.filter((row) => row.status === 'running').length} 个执行中` }),
      h(Stat, { label: '任务', value: exact(totals.tasks ?? tasks.length), foot: `${exact(totals.completed ?? tasks.filter((row) => row.status === 'completed').length)} 已完成` }),
      h(Stat, { label: '消息', value: exact(totals.messages ?? messages.length), foot: '按投递记录统计' }),
    ),
    h(
      Card,
      { title: '成员', sub: '来自子代理树' },
      members.length === 0
        ? h(Empty, null, '当前会话没有子代理成员')
        : h(
            'table',
            { className: 'mydsh-table' },
            h('thead', null, h('tr', null, h('th', null, '名称'), h('th', null, '状态'), h('th', { 'data-num': 'true' }, '深度'), h('th', { 'data-num': 'true' }, 'token'))),
            h('tbody', null,
              members.map((row, index) =>
                h('tr', { key: `${row.id}-${index}` },
                  h('td', { className: 'mydsh-truncate' }, row.name ?? '(未命名)'),
                  h('td', null, h(Badge, { tone: row.status === 'running' ? 'ok' : row.status === 'error' ? 'error' : undefined }, row.status ?? 'unknown')),
                  h('td', { 'data-num': 'true' }, exact(row.depth)),
                  h('td', { 'data-num': 'true' }, tokens(row.usage?.totalTokens ?? 0)),
                ),
              ),
            ),
          ),
    ),
    h(
      Card,
      { title: '任务', sub: '来自编队任务板' },
      tasks.length === 0
        ? h(Empty, null, '当前会话没有编队任务')
        : h(
            'table',
            { className: 'mydsh-table' },
            h('thead', null, h('tr', null, h('th', null, '任务'), h('th', null, '状态'), h('th', null, '负责人'), h('th', { 'data-num': 'true' }, '修订'))),
            h('tbody', null,
              tasks.map((row, index) =>
                h('tr', { key: `${row.id}-${index}` },
                  h('td', { className: 'mydsh-truncate', title: row.subject }, row.subject ?? ''),
                  h('td', null, h(Badge, { tone: row.status === 'completed' ? 'ok' : row.status === 'error' ? 'error' : undefined }, row.status ?? '')),
                  h('td', { className: 'mydsh-muted' }, row.owner === '' ? '未认领' : row.owner),
                  h('td', { 'data-num': 'true' }, exact(row.revision)),
                ),
              ),
            ),
          ),
    ),
    h(
      Card,
      { title: '消息', sub: '最近投递记录' },
      messages.length === 0
        ? h(Empty, null, '还没有消息记录')
        : h(
            'div',
            { className: 'mydsh-list mydsh-scroll' },
            messages.map((row, index) =>
              h(
                'div',
                { key: index, className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
                h('span', { className: 'mydsh-muted', style: { flexShrink: 0 } }, row.at === 0 ? '—' : when(row.at)),
                h('span', { className: 'mydsh-truncate mydsh-grow', title: row.summary }, row.summary ?? ''),
                h('span', { className: 'mydsh-muted' }, (row.from ?? '') + (row.to === undefined ? '' : ` → ${row.to}`)),
              ),
            ),
          ),
    ),
  )
}

/** The capability modules tab. */
function ModulesTab({ settings, patch, meta }) {
  const overview = usePoll('/modules/overview', 30000, [])
  const [openKey, setOpenKey] = useState(undefined)
  const [queue, setQueue] = useState([])
  const [notice, setNotice] = useState(undefined)
  const acknowledged = useRef(new Set())

  const modules = settings.modules ?? {}
  const rows = Array.isArray(overview.data?.modules) ? overview.data.modules : []
  const byKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows])

  const write = (partial) => {
    patch(partial).catch(() => undefined)
  }
  const setModule = (key, partial) => write({ modules: { [key]: partial } })
  const enable = (key) => setModule(key, { enabled: true })

  /**
   * Route one switch change.
   *
   * Turning a module off never asks: reducing access is always allowed. Turning
   * a high-risk module on asks once per page load; after acknowledgement the
   * switch behaves like any other. A new request is appended to the queue rather
   * than replacing it, so an unanswered preset confirmation is not silently lost.
   */
  const requestToggle = (row, next) => {
    if (next !== true) {
      setModule(row.key, { enabled: false })
      return
    }
    if (row.risk === 'high' && acknowledged.current.has(row.key) !== true) {
      setQueue((items) =>
        items.some((entry) => entry.key === row.key) ? items : [...items, { key: row.key, label: row.label }],
      )
      return
    }
    enable(row.key)
  }

  const confirmNext = () => {
    const head = queue[0]
    if (head === undefined) return
    acknowledged.current.add(head.key)
    enable(head.key)
    setQueue((items) => items.slice(1))
  }

  /**
   * Enable one preset.
   *
   * Unavailable modules are skipped (a switch that cannot work should not be
   * turned on), and high-risk ones join the confirmation queue instead of being
   * enabled outright. The queue is merged rather than replaced so a preset never
   * discards a confirmation the user has not answered yet.
   */
  const applyPreset = (preset) => {
    const keys = preset.keys ?? rows.map((row) => row.key)
    const batch = {}
    const pending = []
    for (const key of keys) {
      const row = byKey.get(key)
      if (row !== undefined && row.available === false) continue
      if (row !== undefined && row.risk === 'high' && acknowledged.current.has(key) !== true) {
        pending.push({ key, label: row.label })
        continue
      }
      batch[key] = { enabled: true }
    }
    const count = Object.keys(batch).length
    if (count > 0) write({ modules: batch })
    setNotice(
      pending.length === 0
        ? { tone: 'ok', message: `已打开 ${count} 项能力` }
        : { tone: 'warn', message: `已打开 ${count} 项，另有 ${pending.length} 项高风险能力待逐个确认` },
    )
    setQueue((items) => {
      const known = new Set(items.map((entry) => entry.key))
      return [...items, ...pending.filter((entry) => known.has(entry.key) !== true)]
    })
  }

  const sections = [
    { key: 'desktop', title: '桌面自动化', sub: '仅 Windows；读屏、键盘、鼠标分开放行', body: ModuleDesktop },
    { key: 'mcpConnector', title: 'MCP 连接器', sub: '服务器列表增删改、按行测试、应用到宿主', body: ModuleMcp },
    { key: 'imageGen', title: '图像生成', sub: 'OpenAI 兼容接口，可用固定短句测试链路', body: ModuleImageGen },
    { key: 'roles', title: '角色专家库', sub: '自定义专家增删改，内置目录只读可搜索', body: ModuleRoles },
    { key: 'configManager', title: '配置与插件管理', sub: '插件启停与配置编辑，只读行不给写', body: ModuleConfig },
    { key: 'skills', title: '技能中心', sub: '技能列表与侧栏入口', body: ModuleSkills },
    { key: 'teams', title: '编队视图', sub: '读取内置编队数据，只读', body: ModuleTeams },
  ].filter((section) => modules[section.key] !== undefined)

  return h(
    'div',
    { className: 'mydsh-page' },
    h(
      Card,
      {
        title: '能力总览',
        sub: `${rows.filter((row) => row.enabled === true && row.available !== false).length} 项已启用 · ${rows.filter((row) => row.available === false).length} 项在当前环境不可用`,
        actions: h(Button, { size: 'sm', variant: 'ghost', onClick: () => overview.reload() }, `⟳ ${t().refresh}`),
      },
      overview.error === undefined ? null : h(Note, { tone: 'error' }, overview.error),
      overview.data?.reason === undefined ? null : h(Note, { tone: 'warn' }, overview.data.reason),
      rows.length === 0
        ? h(Empty, null, overview.loading === true ? t().loading : '宿主没有上报任何能力模块')
        : h(
            'div',
            { className: 'mydsh-grid', 'data-cols': '3' },
            rows.map((row) => h(ModuleCard, { key: row.key, row, onToggle: requestToggle })),
          ),
      h(
        'div',
        { className: 'mydsh-muted' },
        '强耦合提示：上下文洞察与用量看板共用数据源；余额与价目表共用供应商适配；备份与跨机同步共用打包引擎。',
      ),
    ),

    h(
      Card,
      { title: '一键预置', sub: '只打开、不关闭；三档都保留你已有的选择' },
      h(
        'div',
        { className: 'mydsh-inline' },
        MODULE_PRESETS.map((preset) =>
          h(
            Button,
            { key: preset.id, variant: preset.id === 'daily' ? 'primary' : undefined, onClick: () => applyPreset(preset) },
            preset.label,
          ),
        ),
      ),
      h(
        'div',
        { className: 'mydsh-list' },
        MODULE_PRESETS.map((preset) =>
          h(
            'div',
            { key: preset.id, className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 10 } },
            h('span', null, preset.label),
            h('span', { className: 'mydsh-muted mydsh-truncate' }, preset.sub),
          ),
        ),
      ),
      notice === undefined ? null : h(Note, { tone: notice.tone }, notice.message),
    ),

    sections.map((section) => {
      const slice = modules[section.key] ?? {}
      const row = byKey.get(section.key)
      const open = openKey === section.key
      const Body = section.body
      return h(
        ModuleSection,
        {
          key: section.key,
          title: section.title,
          sub: section.sub,
          row,
          open,
          onToggle: () => setOpenKey(open ? undefined : section.key),
        },
        open
          ? h(Body, { slice, row, setModule, settings, meta })
          : null,
      )
    }),

    h(ModuleConfirm, {
      queue,
      onConfirm: confirmNext,
      onCancel: () => setQueue([]),
    }),
  )
}
