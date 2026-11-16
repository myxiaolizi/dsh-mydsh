/**
 * Interface tab.
 *
 * Every switch here writes straight through `patch`, which applies the value
 * optimistically and persists it; the decorations live in this same page and
 * subscribe to the same store, so a switch toggles its effect on the next frame
 * instead of after a reload. That is the whole reason the settings document is
 * the single source of truth rather than React state.
 */

/** One switch row bound to a settings path. */
function SwitchRow({ title, hint, checked, onChange, disabled }) {
  return h(
    Row,
    { title, hint },
    h(Switch, { checked: checked === true, onChange, label: title, disabled }),
  )
}

/** The interface tab. */
function InterfaceTab({ settings, patch }) {
  const ui = settings.ui
  const entries = ui.entries

  const setUi = (partial) => patch({ ui: partial })
  const setEntry = (key, value) => patch({ ui: { entries: { [key]: value } } })

  const entryRows = [
    ['sidebarPanel', '侧栏面板图标', '在侧栏面板列表里增加「我的 DSH」图标，点击打开独立页面'],
    ['footerUsage', '侧栏底部用量条', '在侧栏底部显示一行用量，点击打开用量页'],
    ['tabContext', '标签栏：上下文', '在会话标签栏增加「上下文」视图'],
    ['tabTeam', '标签栏：编队', '在会话标签栏增加「编队」视图'],
    ['tabUsage', '标签栏：用量', '在会话标签栏增加「用量」视图'],
    ['inputAutoContinue', '输入框：自动续跑方式', '在输入框工具行增加续跑策略菜单'],
    ['dockGeekMetrics', '输入区状态栏：极客请求指标', '显示首字时间、速度、token，点击展开最近请求'],
    ['dockSessionCost', '输入区状态栏：本会话消耗估算', '显示本会话累计 token 与预估费用'],
    ['dockSessionTokens', '输入区状态栏：本会话 token 计数', '只显示一个 token 计数，样式更克制'],
    ['titlebarContext', '标题栏：上下文压力', '在标题栏显示上下文占用胶囊'],
  ]

  const settingsRows = [
    ['settingsUsage', '用量与计费分页'],
    ['settingsBackup', '备份分页'],
    ['settingsRetry', '重试分页'],
    ['settingsPersonalize', '个性化分页'],
    ['settingsModules', '能力模块分页'],
    ['settingsRelay', '远程访问分页'],
  ]

  return h(
    'div',
    { className: 'mydsh-page' },
    h(
      Card,
      { title: '品牌与外壳', sub: '隐藏原生元素来把空间还给内容；每项独立生效' },
      h(SwitchRow, {
        title: '隐藏「新会话」按钮',
        hint: '侧栏顶部的新建会话行整行隐藏',
        checked: ui.hideNewSession,
        onChange: (value) => setUi({ hideNewSession: value }),
      }),
      h(SwitchRow, {
        title: '隐藏侧栏图标',
        hint: '`deepseek HARNESS` 前的图形标志',
        checked: ui.hideBrandMark,
        onChange: (value) => setUi({ hideBrandMark: value }),
      }),
      h(SwitchRow, {
        title: '隐藏侧栏文字',
        hint: '`deepseek HARNESS` 字样，与图标分开控制',
        checked: ui.hideBrandName,
        onChange: (value) => setUi({ hideBrandName: value }),
      }),
      h(SwitchRow, {
        title: '隐藏侧栏折叠按钮',
        hint: '收起/展开侧栏的控制',
        checked: ui.hideSidebarToggle,
        onChange: (value) => setUi({ hideSidebarToggle: value }),
      }),
      h(SwitchRow, {
        title: '账户入口移到标题栏',
        hint: '侧栏底部的用户区改为标题栏左侧的头像，腾出侧栏底部空间',
        checked: ui.accountToTitlebar,
        onChange: (value) => setUi({ accountToTitlebar: value }),
      }),
      h(SwitchRow, {
        title: '标题栏只显示头像',
        hint: '点击头像弹出 设置 / 退出 / 反馈，不显示用户名',
        checked: ui.accountAvatarOnly,
        onChange: (value) => setUi({ accountAvatarOnly: value }),
        disabled: ui.accountToTitlebar !== true,
      }),
    ),
    h(
      Card,
      { title: '列表与密度', sub: '会话列表的分组方式和整体密度' },
      h(
        Row,
        { title: '点击切换分组', hint: '点击侧栏的「工作区 / 会话」按钮时，下方列表随之切换分组' },
        h(Switch, {
          checked: ui.sidebarViewClickToggle === true,
          onChange: (value) => setUi({ sidebarViewClickToggle: value }),
          label: '点击切换分组',
        }),
      ),
      h(
        Row,
        { title: '默认分组', hint: '进入 DSH 时列表按什么分组' },
        h(Segmented, {
          value: ui.sidebarView,
          onChange: (value) => setUi({ sidebarView: value }),
          options: [
            { value: 'workspace', label: '按工作区' },
            { value: 'flat', label: '按会话' },
          ],
        }),
      ),
      h(
        Row,
        { title: '密度', hint: '紧凑会缩小行高与卡片内边距' },
        h(Segmented, {
          value: ui.density,
          onChange: (value) => setUi({ density: value, compact: value === 'compact' }),
          options: [
            { value: 'cozy', label: '标准' },
            { value: 'compact', label: '紧凑' },
            { value: 'spacious', label: '宽松' },
          ],
        }),
      ),
    ),
    h(
      Card,
      { title: '侧栏底部用量条', sub: '显示哪个区间的用量' },
      h(
        Row,
        { title: '指标', hint: '点用量条会打开用量页，并选中同一区间' },
        h(Segmented, {
          value: ui.footerUsageMetric,
          onChange: (value) => setUi({ footerUsageMetric: value }),
          options: [
            { value: 'today', label: t().today },
            { value: 'week', label: t().week },
            { value: 'month', label: t().month },
            { value: 'total', label: t().total },
          ],
        }),
      ),
      ui.entries.footerUsage === true
        ? null
        : h(Note, null, '侧栏底部用量条当前已关闭，打开上面的「侧栏底部用量条」后此设置才可见。'),
    ),
    h(
      Card,
      { title: '功能入口', sub: '关掉的入口不注册任何组件，不产生渲染与轮询开销' },
      entryRows.map(([key, title, hint]) =>
        h(SwitchRow, {
          key,
          title,
          hint,
          checked: entries[key] === true,
          onChange: (value) => setEntry(key, value),
        }),
      ),
    ),
    h(
      Card,
      { title: '设置页分页', sub: '不需要的分页可以直接隐藏，页面会少加载一块' },
      settingsRows.map(([key, title]) =>
        h(SwitchRow, {
          key,
          title,
          checked: entries[key] === true,
          onChange: (value) => setEntry(key, value),
        }),
      ),
    ),
    h(
      Card,
      { title: '全部恢复默认', sub: '只重置界面设置，不影响用量、备份与个性化' },
      h(
        Row,
        { title: '恢复界面默认值', hint: '开关全部回到出厂状态' },
        h(
          Button,
          {
            variant: 'danger',
            onClick: () => setUi(clone(DEFAULT_UI())),
          },
          '恢复默认',
        ),
      ),
    ),
  )
}

/** The interface defaults, mirrored from the Host document for the reset button. */
function DEFAULT_UI() {
  return {
    hideNewSession: false,
    hideBrandMark: false,
    hideBrandName: false,
    hideSidebarToggle: false,
    accountToTitlebar: false,
    accountAvatarOnly: true,
    sidebarView: 'workspace',
    sidebarViewClickToggle: true,
    compact: false,
    density: 'cozy',
    footerUsageMetric: 'today',
    entries: {
      sidebarPanel: false,
      footerUsage: true,
      settingsSection: true,
      tabContext: true,
      tabTeam: true,
      tabUsage: true,
      inputAutoContinue: true,
      dockGeekMetrics: true,
      dockSessionCost: true,
      dockSessionTokens: false,
      titlebarContext: false,
      settingsUsage: true,
      settingsBackup: true,
      settingsRetry: true,
      settingsPersonalize: true,
      settingsModules: true,
      settingsRelay: true,
    },
  }
}
