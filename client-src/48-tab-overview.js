/**
 * Overview and About tabs.
 *
 * Overview is the landing tab: it answers "is anything broken, and what am I
 * spending" in one screen, because those are the two questions that actually
 * send someone into a settings page. About carries the environment report — the
 * place a user looks when a switch does nothing and they need to know whether
 * the Host exposed the service the switch depends on.
 */

/** Overview: status of every subsystem in one screen. */
function OverviewTab({ settings, patch, meta }) {
  const [range, setRange] = useState('7d')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const summary = usePoll(`/usage/summary?${usageQuery(range, from, to)}&dim=model`, 15000, [range, from, to])
  const budgets = usePoll('/usage/budgets', 30000, [])
  const backupState = usePoll('/backup/state', 30000, [])
  const relayState = usePoll('/relay/state', 15000, [])
  const modules = usePoll('/modules/overview', 30000, [])

  const totals = summary.data?.totals ?? {}
  const over = (budgets.data?.evaluation ?? []).filter((entry) => entry.state === 'over')
  const warn = (budgets.data?.evaluation ?? []).filter((entry) => entry.state === 'warn')
  const enabledModules = (modules.data?.modules ?? []).filter((row) => row.enabled === true && row.available === true)
  const unavailable = (modules.data?.modules ?? []).filter((row) => row.available === false)
  const lastRun = backupState.data?.lastRunAt ?? 0

  return h(
    'div',
    { className: 'mydsh-page' },
    over.length > 0
      ? h(Note, { tone: 'error' },
          `有 ${over.length} 条预算已超限：${over.map((entry) => entry.label === '' ? entry.scope : entry.label).join('、')}。` +
            (over.some((entry) => entry.action !== 'notify') ? '暂停类预算正在阻断新的模型请求。' : ''))
      : warn.length > 0
        ? h(Note, { tone: 'warn' }, `有 ${warn.length} 条预算接近上限（≥ 90%）。`)
        : null,

    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(RangeBar, { value: range, onChange: setRange, from, to, onFrom: setFrom, onTo: setTo }),
      h('span', { className: 'mydsh-muted' }, summary.data?.updatedAt === undefined ? '' : `更新于 ${when(summary.data.updatedAt)}`),
    ),

    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '4' },
      h(Stat, { label: t().tabUsage, value: tokens(totals.totalTokens), foot: `${exact(totals.totalTokens)} tokens`, accent: 'var(--dsw-alias-brand-primary)' }),
      h(Stat, { label: '输入', value: tokens(totals.inputTokens), foot: `缓存读 ${tokens(totals.cacheReadTokens)}`, accent: 'var(--dsw-alias-state-success-primary)' }),
      h(Stat, { label: '输出', value: tokens(totals.outputTokens), foot: `${exact(totals.requests)} 次请求`, accent: 'var(--dsw-alias-state-warn-primary)' }),
      h(Stat, {
        label: '预估费用',
        value: money(totals.cost, totals.currency),
        foot: totals.cost === 0 ? '未配置价格时按内置价目表' : '按内置/自定义价目表',
        accent: 'var(--dsw-alias-state-error-primary)',
      }),
    ),

    h(
      'div',
      { className: 'mydsh-split' },
      h(
        Card,
        { title: '用量趋势', sub: '按时间桶展示 token 消耗' },
        summary.data === undefined
          ? h(Empty, null, summary.loading ? t().loading : t().empty)
          : h(BarChart, { points: (summary.data.series ?? []).map((point) => ({ label: point.label, value: point.totalTokens })) }),
      ),
      h(
        Card,
        { title: '系统状态', sub: '各子系统的当前状态，点击分页查看详情' },
        h(
          'div',
          { className: 'mydsh-list' },
          statusLine('用量统计', settings.usage.enabled === true, summary.error === undefined ? `${exact(totals.requests)} 次请求已索引` : summary.error),
          statusLine('备份', settings.backup.enabled === true, lastRun === 0 ? '尚未执行过备份' : `上次备份 ${when(lastRun)}`),
          statusLine('重试策略', settings.retry.enabled === true, `${(settings.retry.policies ?? []).length} 条规则`),
          statusLine('个性化', settings.personalize.enabled === true, settings.personalize.memory.enabled === true ? `长期记忆 ${(settings.personalize.memory.entries ?? []).length} 条` : '未启用长期记忆'),
          statusLine('远程访问', relayState.data?.state?.status === 'online', relayState.data?.state?.status ?? settings.relay.enabled === true ? (relayState.data?.state?.publicUrl ?? '未连接') : '未启用'),
        ),
      ),
    ),

    h(
      Card,
      { title: '能力模块', sub: `已启用 ${enabledModules.length} 项${unavailable.length === 0 ? '' : `，${unavailable.length} 项在当前环境不可用`}` },
      enabledModules.length === 0
        ? h(Empty, null, '还没有启用任何能力模块，可在「能力模块」分页打开。')
        : h(
            'div',
            { className: 'mydsh-inline', style: { flexWrap: 'wrap' } },
            enabledModules.map((row) => h(Badge, { key: row.key, tone: 'ok' }, row.label)),
          ),
      unavailable.length === 0
        ? null
        : h(
            'div',
            { className: 'mydsh-inline', style: { flexWrap: 'wrap' } },
            unavailable.map((row) => h(Badge, { key: row.key, tone: 'warn', title: row.reason }, `${row.label}·不可用`)),
          ),
    ),

    h(
      Card,
      { title: '快速入口', sub: '一键跳到最常用的三件事' },
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Button, { onClick: () => settingsStore.refresh(true) }, '刷新状态'),
        h(Button, { variant: 'primary', onClick: () => api('/backup/run', { body: {} }).catch(() => undefined) }, '立即备份'),
        h(Button, { onClick: () => api('/usage/reindex', { body: {} }).catch(() => undefined) }, '重建用量索引'),
      ),
    ),
  )
}

/** One status row with a coloured dot. */
function statusLine(label, ok, detail) {
  return h(
    'div',
    { className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
    h('span', { className: 'mydsh-inline' },
      h('span', { className: 'mydsh-dot', 'data-tone': ok === true ? 'ok' : undefined }),
      h('span', null, label),
    ),
    h('span', { className: 'mydsh-muted mydsh-truncate', title: String(detail ?? ''), style: { maxWidth: '60%' } }, String(detail ?? '')),
  )
}

/** About: environment report and the limits worth stating up front. */
function AboutTab({ settings, meta }) {
  const modules = usePoll('/modules/overview', 0, [])
  const rows = [
    ['插件版本', '2.0.0'],
    ['DSH 版本', meta.dshVersion === '' ? '未上报' : meta.dshVersion],
    ['数据目录', meta.dataDir ?? '—'],
    ['7z 支持', meta.sevenZip === true ? '已随包提供' : '缺失，压缩自动降级为 zip'],
    ['设置存储', '本机 JSON 文档，不写入 profile 补丁层'],
    ['供应商', (meta.providers ?? []).map((entry) => entry.provider).join('、') || '未读取到'],
    ['工作区', String((meta.workspaces ?? []).length)],
  ]

  return h(
    'div',
    { className: 'mydsh-page' },
    h(
      Card,
      { title: '环境', sub: '插件读取到的运行环境' },
      rows.map(([label, value]) =>
        h(Row, { key: label, title: label },
          h('span', { className: 'mydsh-muted mydsh-truncate', title: String(value), style: { maxWidth: 360, textAlign: 'right' } }, String(value)),
        ),
      ),
    ),
    h(
      Card,
      { title: '能力可用性', sub: '某项开关无效时，先看这里判断是不是宿主没有提供对应服务' },
      (modules.data?.modules ?? []).length === 0
        ? h(Empty, null, modules.loading ? t().loading : t().empty)
        : h(
            'table',
            { className: 'mydsh-table' },
            h('thead', null,
              h('tr', null,
                h('th', null, '模块'),
                h('th', null, '状态'),
                h('th', null, '说明'),
              ),
            ),
            h('tbody', null,
              (modules.data.modules ?? []).map((row) =>
                h('tr', { key: row.key },
                  h('td', null, row.label),
                  h('td', null, h(Badge, { tone: row.available === false ? 'warn' : row.enabled === true ? 'ok' : undefined },
                    row.available === false ? '不可用' : row.enabled === true ? '启用' : '停用')),
                  h('td', { className: 'mydsh-muted' }, row.reason ?? ''),
                ),
              ),
            ),
          ),
    ),
    h(
      Card,
      { title: '已知限制', sub: '这些是设计上的边界，不是缺陷' },
      h(
        'ul',
        { style: { margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.8 } },
        h('li', null, '备份的恢复只解包到独立目录，不覆盖正在运行的会话与配置；确认无误后由你手动替换。'),
        h('li', null, '余额查询只对填写了接口地址的供应商生效；不可查询的供应商用内置价目表估算费用。'),
        h('li', null, '浏览器实时投屏（接管真实浏览器）未实现：它需要独立的 Chromium 通道，风险与体积都不适合放在本插件里。'),
        h('li', null, '桌面自动化只在 Windows 上可用，且每次动作都按开关与二次确认放行。'),
        h('li', null, '远程访问依赖你自行部署的中转服务端；插件本身不转发任何数据到第三方。'),
      ),
    ),
  )
}
