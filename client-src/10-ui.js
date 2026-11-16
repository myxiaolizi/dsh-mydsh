/**
 * UI kit: text, controls, cards, charts.
 *
 * These are hand-written equivalents of the Host's own controls, not imports.
 * A Client plugin may not load `@deepseek-ai/dsh-client-ui-primitives` as a
 * module, and copying the markup while referencing only `--dsw-alias-*` tokens
 * is what keeps the page inside the Host's visual language without depending on
 * another package's internals.
 *
 * Nothing here renders a portal into `document.body` except the modal and the
 * popover, which the Host's own controls also portal for the same reason: the
 * conversation column clips overflow.
 */

// --- text ------------------------------------------------------------------

const TEXT = {
  zh: {
    appTitle: '我的 DSH',
    appSubtitle: '界面、用量、备份与能力，一处可管',
    saved: '已保存',
    saving: '保存中…',
    saveFailed: '保存失败',
    refresh: '刷新',
    loading: '加载中…',
    empty: '暂无数据',
    unknown: '未知',
    cancel: '取消',
    confirm: '确定',
    close: '关闭',
    add: '添加',
    remove: '删除',
    edit: '编辑',
    test: '测试',
    run: '立即执行',
    enable: '启用',
    disable: '停用',
    on: '开',
    off: '关',
    advanced: '高级',
    reset: '恢复默认',
    copy: '复制',
    copied: '已复制',
    more: '更多',
    today: '今日',
    week: '本周',
    month: '本月',
    total: '累计',
    range3d: '近 3 天',
    range7d: '近 7 天',
    range30d: '近 1 月',
    range90d: '近 3 月',
    rangeCustom: '自定义',
    rangeToday: '今日',
    save: '保存',
    tabOverview: '总览',
    tabInterface: '界面',
    tabUsage: '用量与计费',
    tabBackup: '备份',
    tabRetry: '重试',
    tabPersonalize: '个性化',
    tabModules: '能力模块',
    tabRelay: '远程访问',
    tabAbout: '关于',
    riskLow: '低风险',
    riskMid: '中风险',
    riskHigh: '高风险',
    riskHighConfirm: '这是高风险能力，会放宽本机权限。确定启用？',
    enabled: '已启用',
    disabled: '未启用',
    unavailable: '不可用',
    unverified: '未验证',
  },
  en: {
    appTitle: 'My DSH',
    appSubtitle: 'Interface, usage, backups and capabilities in one place',
    saved: 'Saved',
    saving: 'Saving…',
    saveFailed: 'Save failed',
    refresh: 'Refresh',
    loading: 'Loading…',
    empty: 'Nothing here yet',
    unknown: 'Unknown',
    cancel: 'Cancel',
    confirm: 'Confirm',
    close: 'Close',
    add: 'Add',
    remove: 'Remove',
    edit: 'Edit',
    test: 'Test',
    run: 'Run now',
    enable: 'Enable',
    disable: 'Disable',
    on: 'On',
    off: 'Off',
    advanced: 'Advanced',
    reset: 'Reset',
    copy: 'Copy',
    copied: 'Copied',
    more: 'More',
    today: 'Today',
    week: 'This week',
    month: 'This month',
    total: 'All time',
    range3d: 'Last 3 days',
    range7d: 'Last 7 days',
    range30d: 'Last month',
    range90d: 'Last 3 months',
    rangeCustom: 'Custom',
    rangeToday: 'Today',
    save: 'Save',
    tabOverview: 'Overview',
    tabInterface: 'Interface',
    tabUsage: 'Usage & billing',
    tabBackup: 'Backups',
    tabRetry: 'Retry',
    tabPersonalize: 'Personalize',
    tabModules: 'Capabilities',
    tabRelay: 'Remote access',
    tabAbout: 'About',
    riskLow: 'Low risk',
    riskMid: 'Medium risk',
    riskHigh: 'High risk',
    riskHighConfirm: 'This is a high-risk capability that widens local permissions. Enable it?',
    enabled: 'On',
    disabled: 'Off',
    unavailable: 'Unavailable',
    unverified: 'Unverified',
  },
}

/** The dictionary for one locale. */
function t() {
  return TEXT[activeLocale()]
}

// --- styles ----------------------------------------------------------------

const CSS = `
.mydsh-root { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.55; }
.mydsh-page { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 28px; }
.mydsh-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.mydsh-head h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: .2px; }
.mydsh-head p { margin: 2px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mydsh-tabs { display: flex; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mydsh-tabs::-webkit-scrollbar { height: 0; }
.mydsh-tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 13px; padding: 8px 12px; border-radius: 8px 8px 0 0; cursor: pointer; white-space: nowrap;
  border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color .12s, background .12s; }
.mydsh-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.mydsh-tab[data-active="true"] { color: var(--dsw-alias-brand-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }

.mydsh-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.mydsh-card[data-flat="true"] { background: transparent; }
.mydsh-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.mydsh-card-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.mydsh-card-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); }

.mydsh-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mydsh-row:last-child { border-bottom: 0; }
.mydsh-row[data-stack="true"] { flex-direction: column; align-items: stretch; gap: 6px; }
.mydsh-row-label { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.mydsh-row-title { font-size: 13px; }
.mydsh-row-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.mydsh-row-control { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.mydsh-grid { display: grid; gap: 10px; }
.mydsh-grid[data-cols="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.mydsh-grid[data-cols="3"] { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.mydsh-grid[data-cols="4"] { grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (max-width: 900px) { .mydsh-grid[data-cols="3"], .mydsh-grid[data-cols="4"] { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 620px) { .mydsh-grid[data-cols="2"], .mydsh-grid[data-cols="3"], .mydsh-grid[data-cols="4"] { grid-template-columns: minmax(0, 1fr); } }

.mydsh-stat { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; position: relative; overflow: hidden; }
.mydsh-stat::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--mydsh-accent, var(--dsw-alias-brand-primary)); }
.mydsh-stat-label { font-size: 11px; color: var(--dsw-alias-label-secondary); display: flex; align-items: center; gap: 4px; }
.mydsh-stat-value { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: .2px; }
.mydsh-stat-foot { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }

.mydsh-switch { appearance: none; width: 34px; height: 20px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); position: relative; cursor: pointer; transition: background .15s, border-color .15s; flex-shrink: 0; }
.mydsh-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--dsw-alias-label-secondary); transition: transform .15s, background .15s; }
.mydsh-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.mydsh-switch[aria-checked="true"]::after { transform: translateX(14px); background: #fff; }
.mydsh-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.mydsh-switch:disabled { opacity: .45; cursor: not-allowed; }

.mydsh-input, .mydsh-select, .mydsh-area { appearance: none; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  padding: 6px 9px; min-width: 0; transition: border-color .12s, background .12s; }
.mydsh-input:hover, .mydsh-select:hover, .mydsh-area:hover { border-color: var(--dsw-alias-border-l2); }
.mydsh-input:focus, .mydsh-select:focus, .mydsh-area:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.mydsh-area { resize: vertical; min-height: 76px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.5; }
.mydsh-input[data-width="sm"] { width: 76px; }
.mydsh-input[data-width="md"] { width: 140px; }
.mydsh-input[data-width="lg"] { width: 220px; }
.mydsh-input[data-width="xl"] { width: 100%; }

.mydsh-btn { appearance: none; font: inherit; font-size: 12px; padding: 6px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  display: inline-flex; align-items: center; gap: 5px; transition: background .12s, border-color .12s, opacity .12s; white-space: nowrap; }
.mydsh-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l2); }
.mydsh-btn:disabled { opacity: .5; cursor: not-allowed; }
.mydsh-btn[data-variant="primary"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.mydsh-btn[data-variant="primary"]:hover:not(:disabled) { filter: brightness(1.08); }
.mydsh-btn[data-variant="ghost"] { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.mydsh-btn[data-variant="ghost"]:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.mydsh-btn[data-variant="danger"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-border-l1); }
.mydsh-btn[data-variant="danger"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.mydsh-btn[data-size="sm"] { padding: 3px 8px; font-size: 11px; }

.mydsh-seg { display: inline-flex; padding: 2px; gap: 2px; background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; }
.mydsh-seg button { appearance: none; border: 0; background: transparent; font: inherit; font-size: 11px; padding: 3px 9px;
  border-radius: 7px; color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; }
.mydsh-seg button[data-active="true"] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600;
  box-shadow: 0 1px 2px rgb(0 0 0 / .12); }

.mydsh-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.mydsh-table th { text-align: left; font-weight: 600; font-size: 11px; color: var(--dsw-alias-label-secondary);
  padding: 4px 8px 6px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.mydsh-table td { padding: 5px 8px 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-variant-numeric: tabular-nums; vertical-align: middle; }
.mydsh-table tr:last-child td { border-bottom: 0; }
.mydsh-table td[data-num="true"], .mydsh-table th[data-num="true"] { text-align: right; }
.mydsh-table tr:hover td { background: var(--dsw-alias-bg-layer-2); }

.mydsh-bar { position: relative; height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.mydsh-bar > span { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--mydsh-accent, var(--dsw-alias-brand-primary)); }

.mydsh-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.mydsh-badge[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); }
.mydsh-badge[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); }
.mydsh-badge[data-tone="error"] { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); }

.mydsh-note { font-size: 11.5px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.mydsh-note[data-tone="ok"] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); color: var(--dsw-alias-state-success-primary); }
.mydsh-note[data-tone="warn"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); color: var(--dsw-alias-state-warn-primary); }
.mydsh-note[data-tone="error"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); color: var(--dsw-alias-state-error-primary); }

.mydsh-pill { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  font-size: 11px; font-variant-numeric: tabular-nums; cursor: default; }
.mydsh-pill[data-clickable="true"] { cursor: pointer; }
.mydsh-pill[data-clickable="true"]:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }

.mydsh-pop { position: fixed; z-index: 90; min-width: 240px; max-width: min(460px, calc(100vw - 24px)); max-height: 70vh; overflow: auto;
  background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  box-shadow: 0 12px 32px rgb(0 0 0 / .28); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.mydsh-pop-title { font-size: 12px; font-weight: 600; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mydsh-pop-foot { font-size: 11px; color: var(--dsw-alias-label-secondary); border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 7px; }

.mydsh-modal-mask { position: fixed; inset: 0; z-index: 100; background: rgb(0 0 0 / .38); display: flex;
  align-items: center; justify-content: center; padding: 20px; }
.mydsh-modal { background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px;
  box-shadow: 0 20px 60px rgb(0 0 0 / .34); width: min(720px, 100%); max-height: 84vh; display: flex; flex-direction: column; }
.mydsh-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mydsh-modal-body { padding: 14px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.mydsh-modal-foot { padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex;
  justify-content: flex-end; gap: 8px; }

.mydsh-chart { width: 100%; height: 148px; display: block; overflow: visible; }
.mydsh-chart-grid { stroke: var(--dsw-alias-border-l1); stroke-width: 1; }
.mydsh-chart-axis { fill: var(--dsw-alias-label-secondary); font-size: 9.5px; }
.mydsh-chart-line { fill: none; stroke: var(--dsw-alias-brand-primary); stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; }
.mydsh-chart-area { fill: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); }
.mydsh-chart-bar { fill: var(--dsw-alias-brand-primary); opacity: .85; }
.mydsh-chart-bar:hover { opacity: 1; }

.mydsh-heat { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 11px); gap: 2px; overflow-x: auto; }
.mydsh-heat span { width: 11px; height: 11px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2); }
.mydsh-heat span[data-level="1"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent); }
.mydsh-heat span[data-level="2"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, transparent); }
.mydsh-heat span[data-level="3"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 64%, transparent); }
.mydsh-heat span[data-level="4"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 88%, transparent); }

.mydsh-list { display: flex; flex-direction: column; gap: 6px; }
.mydsh-scroll { max-height: 320px; overflow: auto; }
.mydsh-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
@media (max-width: 820px) { .mydsh-split { grid-template-columns: minmax(0, 1fr); } }
.mydsh-inline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mydsh-grow { flex: 1 1 auto; min-width: 0; }
.mydsh-muted { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.mydsh-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.mydsh-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mydsh-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-secondary); flex-shrink: 0; }
.mydsh-dot[data-tone="ok"] { background: var(--dsw-alias-state-success-primary); }
.mydsh-dot[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.mydsh-dot[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }
.mydsh-compact .mydsh-row { padding: 4px 0; }
.mydsh-compact .mydsh-card { padding: 10px; gap: 7px; }

.mydsh-sidebar-meter { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: 8px;
  cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 11px; border: 1px solid transparent; }
.mydsh-sidebar-meter:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.mydsh-sidebar-meter-rail { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px;
  border-radius: 8px; cursor: pointer; color: var(--dsw-alias-label-secondary); }
.mydsh-sidebar-meter-rail:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }

.mydsh-tabbar-entry { display: inline-flex; align-items: center; gap: 4px; }
.mydsh-avatar { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-brand-primary); color: #fff; font-size: 11px; font-weight: 600; cursor: pointer;
  border: 0; padding: 0; flex-shrink: 0; }
.mydsh-avatar:hover { filter: brightness(1.08); }
.mydsh-avatar[data-size="sm"] { width: 22px; height: 22px; font-size: 10px; }

.mydsh-menu { display: flex; flex-direction: column; gap: 1px; }
.mydsh-menu button { appearance: none; border: 0; background: transparent; font: inherit; font-size: 12px; text-align: left;
  padding: 6px 9px; border-radius: 7px; color: var(--dsw-alias-label-primary); cursor: pointer; display: flex;
  align-items: center; gap: 7px; }
.mydsh-menu button:hover { background: var(--dsw-alias-bg-layer-2); }
.mydsh-menu button[data-active="true"] { color: var(--dsw-alias-brand-primary); font-weight: 600; }
`

/** Inject the stylesheet once per page, disposed with the plugin. */
function Styles() {
  return h('style', { 'data-mydsh': '', dangerouslySetInnerHTML: { __html: CSS } })
}

// --- primitives ------------------------------------------------------------

/** One labelled control row. */
function Row({ title, hint, children, stack }) {
  return h(
    'div',
    { className: 'mydsh-row', 'data-stack': stack === true ? 'true' : 'false' },
    h(
      'div',
      { className: 'mydsh-row-label' },
      h('span', { className: 'mydsh-row-title' }, title),
      hint === undefined ? null : h('span', { className: 'mydsh-row-hint' }, hint),
    ),
    h('div', { className: 'mydsh-row-control' }, children),
  )
}

/** A switch that behaves like the Host's own: `role="switch"`, keyboard aware. */
function Switch({ checked, onChange, label, disabled }) {
  return h('button', {
    type: 'button',
    role: 'switch',
    className: 'mydsh-switch',
    'aria-checked': checked === true,
    'aria-label': label,
    disabled: disabled === true,
    onClick: () => {
      if (disabled === true) return
      onChange(checked !== true)
    },
  })
}

/** A titled surface. */
function Card({ title, sub, actions, children, flat }) {
  return h(
    'section',
    { className: 'mydsh-card', 'data-flat': flat === true ? 'true' : 'false' },
    title === undefined && actions === undefined
      ? null
      : h(
          'header',
          { className: 'mydsh-card-head' },
          h(
            'div',
            null,
            h('div', { className: 'mydsh-card-title' }, title),
            sub === undefined ? null : h('div', { className: 'mydsh-card-sub' }, sub),
          ),
          actions === undefined ? null : h('div', { className: 'mydsh-inline' }, actions),
        ),
    children,
  )
}

/** One headline number. */
function Stat({ label, value, foot, accent, title }) {
  return h(
    'div',
    { className: 'mydsh-stat', title, style: accent === undefined ? undefined : { '--mydsh-accent': accent } },
    h('span', { className: 'mydsh-stat-label' }, label),
    h('span', { className: 'mydsh-stat-value' }, value),
    foot === undefined ? null : h('span', { className: 'mydsh-stat-foot' }, foot),
  )
}

/** A short inline message. */
function Note({ tone, children }) {
  return h('div', { className: 'mydsh-note', 'data-tone': tone }, children)
}

/** A small status chip. */
function Badge({ tone, children }) {
  return h('span', { className: 'mydsh-badge', 'data-tone': tone }, children)
}

/** A text input with an optional width preset. */
function TextField({ value, onChange, placeholder, type, width, disabled, mono, onEnter }) {
  return h('input', {
    className: mono === true ? 'mydsh-input mydsh-mono' : 'mydsh-input',
    'data-width': width ?? 'md',
    type: type ?? 'text',
    value: value ?? '',
    placeholder,
    disabled,
    spellCheck: false,
    onChange: (event) => onChange(event.target.value),
    onKeyDown: (event) => {
      if (event.key === 'Enter' && typeof onEnter === 'function') onEnter()
    },
  })
}

/** A multiline input. */
function TextArea({ value, onChange, placeholder, rows, mono = true }) {
  return h('textarea', {
    className: mono === true ? 'mydsh-area mydsh-mono' : 'mydsh-area',
    rows: rows ?? 5,
    value: value ?? '',
    placeholder,
    spellCheck: false,
    onChange: (event) => onChange(event.target.value),
  })
}

/** A select box over `[{ value, label }]`. */
function Select({ value, onChange, options, width, disabled }) {
  return h(
    'select',
    {
      className: 'mydsh-select',
      'data-width': width ?? 'md',
      value: value ?? '',
      disabled,
      onChange: (event) => onChange(event.target.value),
    },
    options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
  )
}

/** A segmented control over `[{ value, label }]`. */
function Segmented({ value, onChange, options }) {
  return h(
    'div',
    { className: 'mydsh-seg', role: 'tablist' },
    options.map((option) =>
      h(
        'button',
        {
          key: option.value,
          type: 'button',
          role: 'tab',
          'data-active': value === option.value,
          'aria-selected': value === option.value,
          onClick: () => onChange(option.value),
        },
        option.label,
      ),
    ),
  )
}

/** A button with a variant and a pending state. */
function Button({ children, onClick, variant, size, disabled, title, type }) {
  return h(
    'button',
    {
      type: type ?? 'button',
      className: 'mydsh-btn',
      'data-variant': variant,
      'data-size': size,
      disabled: disabled === true,
      title,
      onClick,
    },
    children,
  )
}

/** A horizontal meter. */
function Bar({ ratio, accent, height }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(Number(ratio)) ? Number(ratio) : 0))
  return h(
    'div',
    { className: 'mydsh-bar', style: { height: height ?? 6 } },
    h('span', {
      style: {
        width: `${clamped * 100}%`,
        '--mydsh-accent': accent,
      },
    }),
  )
}

/** An empty state. */
function Empty({ children }) {
  return h('div', { className: 'mydsh-muted', style: { padding: '14px 0', textAlign: 'center' } }, children ?? t().empty)
}

// --- charts ----------------------------------------------------------------

/**
 * A line chart drawn as plain SVG.
 *
 * SVG keeps the whole chart inside the theme tokens and costs no dependency; at
 * ~120 points the DOM is smaller than the payload of a chart library would be.
 */
function LineChart({ points, height = 148, format }) {
  const list = Array.isArray(points) ? points : []
  if (list.length === 0) return h(Empty)
  const width = 600
  const padLeft = 38
  const padRight = 8
  const padTop = 8
  const padBottom = 18
  const plotW = width - padLeft - padRight
  const plotH = height - padTop - padBottom
  const peak = Math.max(1, ...list.map((point) => Number(point.value ?? 0)))
  const stepX = list.length === 1 ? 0 : plotW / (list.length - 1)
  const x = (index) => padLeft + index * stepX
  const y = (value) => padTop + plotH - (Math.max(0, Number(value) || 0) / peak) * plotH
  const line = list.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')
  const area = `${line} L${x(list.length - 1).toFixed(1)},${padTop + plotH} L${padLeft},${padTop + plotH} Z`
  const ticks = [0, 0.5, 1].map((ratio) => ({
    y: padTop + plotH - ratio * plotH,
    label: format === undefined ? tokens(peak * ratio) : format(peak * ratio),
  }))
  const labelIndexes = list.length <= 4 ? list.map((_, index) => index) : [0, Math.floor((list.length - 1) / 2), list.length - 1]
  return h(
    'svg',
    { className: 'mydsh-chart', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img' },
    ticks.map((tick, index) =>
      h('g', { key: `t${index}` },
        h('line', { className: 'mydsh-chart-grid', x1: padLeft, x2: width - padRight, y1: tick.y, y2: tick.y }),
        h('text', { className: 'mydsh-chart-axis', x: 2, y: tick.y + 3 }, tick.label),
      ),
    ),
    h('path', { className: 'mydsh-chart-area', d: area }),
    h('path', { className: 'mydsh-chart-line', d: line }),
    labelIndexes.map((index) =>
      h(
        'text',
        {
          key: `x${index}`,
          className: 'mydsh-chart-axis',
          x: x(index),
          y: height - 4,
          textAnchor: index === 0 ? 'start' : index === list.length - 1 ? 'end' : 'middle',
        },
        list[index]?.label ?? '',
      ),
    ),
  )
}

/** A stacked vertical bar chart, one bar per point. */
function BarChart({ points, height = 148, format }) {
  const list = Array.isArray(points) ? points : []
  if (list.length === 0) return h(Empty)
  const width = 600
  const padLeft = 34
  const padRight = 6
  const padTop = 8
  const padBottom = 18
  const plotW = width - padLeft - padRight
  const plotH = height - padTop - padBottom
  const peak = Math.max(1, ...list.map((point) => Number(point.value ?? 0)))
  const slot = plotW / list.length
  const barW = Math.max(1, Math.min(18, slot * 0.62))
  const ticks = [0, 0.5, 1].map((ratio) => ({
    y: padTop + plotH - ratio * plotH,
    label: format === undefined ? tokens(peak * ratio) : format(peak * ratio),
  }))
  return h(
    'svg',
    { className: 'mydsh-chart', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img' },
    ticks.map((tick, index) =>
      h('g', { key: `t${index}` },
        h('line', { className: 'mydsh-chart-grid', x1: padLeft, x2: width - padRight, y1: tick.y, y2: tick.y }),
        h('text', { className: 'mydsh-chart-axis', x: 2, y: tick.y + 3 }, tick.label),
      ),
    ),
    list.map((point, index) => {
      const value = Math.max(0, Number(point.value ?? 0))
      const barH = (value / peak) * plotH
      return h('rect', {
        key: `b${index}`,
        className: 'mydsh-chart-bar',
        x: padLeft + index * slot + (slot - barW) / 2,
        y: padTop + plotH - barH,
        width: barW,
        height: Math.max(value > 0 ? 1 : 0, barH),
        rx: Math.min(2, barW / 2),
      })
    }),
    [0, Math.floor((list.length - 1) / 2), list.length - 1]
      .filter((value, index, self) => self.indexOf(value) === index)
      .map((index) =>
        h(
          'text',
          {
            key: `x${index}`,
            className: 'mydsh-chart-axis',
            x: padLeft + index * slot + slot / 2,
            y: height - 4,
            textAnchor: index === 0 ? 'start' : index === list.length - 1 ? 'end' : 'middle',
          },
          list[index]?.label ?? '',
        ),
      ),
  )
}

/** A 7 × N activity heat map, most recent column on the right. */
function HeatMap({ days }) {
  const list = Array.isArray(days) ? days : []
  if (list.length === 0) return h(Empty)
  const peak = Math.max(1, ...list.map((day) => Number(day.value ?? 0)))
  return h(
    'div',
    { className: 'mydsh-heat', role: 'img' },
    list.map((day, index) => {
      const ratio = Number(day.value ?? 0) / peak
      const level = ratio === 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.8 ? 3 : 4
      return h('span', {
        key: `${day.t ?? index}`,
        'data-level': level,
        title: `${day.label ?? ''} ${exact(day.value)}`,
      })
    }),
  )
}

/** A donut for category shares. */
function Donut({ slices, size = 96, label, sub }) {
  const list = (Array.isArray(slices) ? slices : []).filter((slice) => Number(slice.value) > 0)
  const total = list.reduce((sum, slice) => sum + Number(slice.value), 0)
  if (total <= 0) return h(Empty)
  const radius = size / 2 - 7
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return h(
    'svg',
    { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', style: { flexShrink: 0 } },
    h('circle', {
      cx: size / 2,
      cy: size / 2,
      r: radius,
      fill: 'none',
      stroke: 'var(--dsw-alias-bg-layer-2)',
      strokeWidth: 11,
    }),
    list.map((slice, index) => {
      const length = (Number(slice.value) / total) * circumference
      const dash = `${length} ${circumference - length}`
      const element = h('circle', {
        key: index,
        cx: size / 2,
        cy: size / 2,
        r: radius,
        fill: 'none',
        stroke: slice.color ?? 'var(--dsw-alias-brand-primary)',
        strokeWidth: 11,
        strokeDasharray: dash,
        strokeDashoffset: -offset,
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      })
      offset += length
      return element
    }),
    label === undefined
      ? null
      : h('text', {
          x: size / 2,
          y: size / 2 + (sub === undefined ? 4 : -1),
          textAnchor: 'middle',
          fill: 'var(--dsw-alias-label-primary)',
          fontSize: 12,
          fontWeight: 600,
        }, label),
    sub === undefined
      ? null
      : h('text', {
          x: size / 2,
          y: size / 2 + 12,
          textAnchor: 'middle',
          fill: 'var(--dsw-alias-label-secondary)',
          fontSize: 9,
        }, sub),
  )
}

/** A legend for a donut or stacked chart. */
function Legend({ items }) {
  return h(
    'div',
    { className: 'mydsh-list', style: { fontSize: 11.5 } },
    (items ?? []).map((item, index) =>
      h(
        'div',
        { key: index, className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
        h('span', { className: 'mydsh-inline', style: { minWidth: 0 } },
          h('span', { className: 'mydsh-dot', style: { background: item.color } }),
          h('span', { className: 'mydsh-truncate' }, item.label),
        ),
        h('span', { className: 'mydsh-muted', style: { fontVariantNumeric: 'tabular-nums' } },
          item.percent === undefined ? item.value : `${item.percent} · ${percent(item.ratio, 1)}`),
      ),
    ),
  )
}

// --- overlays --------------------------------------------------------------

/** A modal rendered into the document body so column clipping cannot cut it. */
function Modal({ title, children, footer, onClose }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return ReactDOM.createPortal(
    h(
      'div',
      {
        className: 'mydsh-modal-mask',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      },
      h(
        'div',
        { className: 'mydsh-modal', role: 'dialog', 'aria-modal': 'true' },
        h(
          'header',
          { className: 'mydsh-modal-head' },
          h('div', { className: 'mydsh-card-title' }, title),
          h(Button, { variant: 'ghost', size: 'sm', onClick: onClose, title: t().close }, '✕'),
        ),
        h('div', { className: 'mydsh-modal-body' }, children),
        footer === undefined ? null : h('div', { className: 'mydsh-modal-foot' }, footer),
      ),
    ),
    document.body,
  )
}

/**
 * A popover anchored to an element, rendered into the body.
 *
 * The anchor rect is measured on open and re-measured on scroll so a menu that
 * is opened from a clipped row still lands in the right place.
 */
function Popover({ anchor, open, onClose, children, align }) {
  const [rect, setRect] = useState(undefined)
  useEffect(() => {
    if (!open || anchor === null || anchor === undefined) return undefined
    const measure = () => {
      const element = typeof anchor === 'function' ? anchor() : anchor.current ?? anchor
      if (element === null || element === undefined) return
      const box = element.getBoundingClientRect()
      setRect({ top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, anchor])
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (event.target.closest?.('.mydsh-pop') !== null) return
      onClose()
    }
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])
  if (!open || rect === undefined) return null
  const style = { top: Math.min(rect.bottom + 6, window.innerHeight - 120) }
  if (align === 'end') style.right = Math.max(8, window.innerWidth - rect.right)
  else style.left = Math.min(Math.max(8, rect.left), window.innerWidth - 260)
  return ReactDOM.createPortal(h('div', { className: 'mydsh-pop', style }, children), document.body)
}

/**
 * `createPortal` with a graceful fallback.
 *
 * The browser module table provides `react-dom`, and both the shipped statistics
 * dialog and the installed usage plugin portal through it. It is still resolved
 * lazily and defensively: this plugin must keep rendering if a future Host drops
 * the entry from the table, and an overlay drawn inline is usable even when it
 * is clipped by the column that contains it.
 */
const ReactDOM = (() => {
  let resolved
  let failed = false
  const portal = (children, container) => {
    if (!failed && resolved === undefined) {
      try {
        resolved = require('react-dom')
      } catch {
        failed = true
      }
    }
    if (failed || typeof resolved?.createPortal !== 'function') return children
    try {
      return resolved.createPortal(children, container)
    } catch {
      failed = true
      return children
    }
  }
  return { createPortal: portal }
})()
