/**
 * Settings page shell.
 *
 * One `settings.section` entry draws a header, a tab strip, and whichever tab
 * body is selected. Each tab lives in its own source file and receives the same
 * three props — `settings`, `patch`, `meta` — so a tab can be reviewed on its
 * own and a failure in one tab cannot take down the others.
 *
 * Tabs are declared twice on purpose: `TAB_TABS` is the ordered list of every
 * tab this plugin can show, and `visibleTabs` drops the ones the user switched
 * off in Interface. `Overview` and `About` are never dropped: the page needs at
 * least one tab, and About is where an unsupported-environment explanation
 * lives.
 */

/** Static metadata the Host reports once: providers, models, workspaces. */
const metaStore = (() => {
  let value
  let pending
  const listeners = new Set()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  const load = () => {
    if (value !== undefined) return Promise.resolve(value)
    if (pending !== undefined) return pending
    pending = api('/settings')
      .then((result) => {
        value = result.meta ?? {}
        pending = undefined
        emit()
        return value
      })
      .catch(() => {
        pending = undefined
        return {}
      })
    return pending
  }
  return {
    load,
    get: () => value ?? {},
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
})()

/** Subscribe to the Host metadata, loading it on first use. */
function useMeta() {
  const meta = useSyncExternalStore(metaStore.subscribe, metaStore.get, metaStore.get)
  useEffect(() => {
    metaStore.load()
  }, [])
  return meta
}

/** Provider/model options for a picker, with an "any" row first. */
function providerOptions(meta, anyLabel) {
  const list = Array.isArray(meta?.providers) ? meta.providers : []
  return [{ value: '', label: anyLabel ?? '—' }].concat(
    list.map((entry) => ({ value: entry.provider, label: entry.provider })),
  )
}

/** Model options for one provider, or every model when `provider` is empty. */
function modelOptions(meta, provider, anyLabel) {
  const list = Array.isArray(meta?.providers) ? meta.providers : []
  const rows = []
  for (const entry of list) {
    if (provider !== '' && entry.provider !== provider) continue
    for (const model of entry.models ?? []) {
      rows.push({
        value: `${entry.provider}::${model.id}`,
        label: provider === '' ? `${entry.provider} · ${model.name ?? model.id}` : (model.name ?? model.id),
      })
    }
  }
  return [{ value: '', label: anyLabel ?? '—' }].concat(rows)
}

/** Workspace options for a picker. */
function workspaceOptions(meta, anyLabel) {
  const list = Array.isArray(meta?.workspaces) ? meta.workspaces : []
  return [{ value: '', label: anyLabel ?? '—' }].concat(
    list.map((entry) => ({ value: entry.path, label: entry.title === '' ? entry.path : entry.title })),
  )
}

/** The order every tab is declared in. */
const TAB_ORDER = ['overview', 'interface', 'usage', 'backup', 'retry', 'personalize', 'modules', 'relay', 'about']

/** Tab metadata: label key into `t()`, and whether a switch can hide it. */
const TAB_META = {
  overview: { key: 'tabOverview', closable: false },
  interface: { key: 'tabInterface', closable: false },
  usage: { key: 'tabUsage', closable: true, entry: 'settingsUsage' },
  backup: { key: 'tabBackup', closable: true, entry: 'settingsBackup' },
  retry: { key: 'tabRetry', closable: true, entry: 'settingsRetry' },
  personalize: { key: 'tabPersonalize', closable: true, entry: 'settingsPersonalize' },
  modules: { key: 'tabModules', closable: true, entry: 'settingsModules' },
  relay: { key: 'tabRelay', closable: true, entry: 'settingsRelay' },
  about: { key: 'tabAbout', closable: false },
}

/**
 * The settings page.
 *
 * `patch` merges into the settings document and resolves with the accepted
 * document. Every control calls it, so a switch takes effect on the next frame
 * (the store applies the patch optimistically) and is confirmed by the Host's
 * answer.
 */
function Page() {
  const settings = useSettings()
  const meta = useMeta()
  const [tab, setTab] = useState('overview')
  const [error, setError] = useState(undefined)
  const [pending, setPending] = useState(false)
  const locale = activeLocale()

  const patch = useCallback(
    async (partial) => {
      setPending(true)
      try {
        const next = await settingsStore.patch(partial)
        setError(undefined)
        return next
      } catch (failure) {
        setError(failure?.message ?? String(failure))
        throw failure
      } finally {
        setPending(false)
      }
    },
    [],
  )

  if (settings === undefined) {
    return h(Styles, null, h('div', { className: 'mydsh-root mydsh-page' }, h(Empty, null, t().loading)))
  }

  const entries = settings.ui?.entries ?? {}
  const visible = TAB_ORDER.filter((key) => {
    const info = TAB_META[key]
    if (info.closable !== true) return true
    // A hidden tab falls back to nothing: the strip keeps Overview either way.
    return entries[info.entry] !== false
  })
  const active = visible.includes(tab) ? tab : 'overview'

  const body = (() => {
    switch (active) {
      case 'interface':
        return h(InterfaceTab, { settings, patch, meta })
      case 'usage':
        return h(UsageSettingsTab, { settings, patch, meta })
      case 'backup':
        return h(BackupTab, { settings, patch, meta })
      case 'retry':
        return h(RetryTab, { settings, patch, meta })
      case 'personalize':
        return h(PersonalizeTab, { settings, patch, meta })
      case 'modules':
        return h(ModulesTab, { settings, patch, meta })
      case 'relay':
        return h(RelayTab, { settings, patch, meta })
      case 'about':
        return h(AboutTab, { settings, patch, meta })
      default:
        return h(OverviewTab, { settings, patch, meta })
    }
  })()

  return h(
    'div',
    { className: `mydsh-root mydsh-page${settings.ui?.compact === true ? ' mydsh-compact' : ''}` },
    h(Styles),
    h(
      'header',
      { className: 'mydsh-head' },
      h(
        'div',
        null,
        h('h2', null, t().appTitle),
        h('p', null, t().appSubtitle),
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        pending ? h('span', { className: 'mydsh-muted' }, t().saving) : null,
        h(Button, { variant: 'ghost', size: 'sm', onClick: () => settingsStore.refresh(true) }, `⟳ ${t().refresh}`),
      ),
    ),
    error === undefined ? null : h(Note, { tone: 'error' }, error),
    h(
      'nav',
      { className: 'mydsh-tabs', role: 'tablist' },
      visible.map((key) =>
        h(
          'button',
          {
            key,
            type: 'button',
            role: 'tab',
            className: 'mydsh-tab',
            'data-active': key === active,
            'aria-selected': key === active,
            onClick: () => setTab(key),
          },
          t()[TAB_META[key].key],
        ),
      ),
    ),
    h('div', { key: active }, body),
    h('div', { className: 'mydsh-muted', style: { textAlign: 'right', fontSize: 10.5 } },
      `${meta.dshVersion ?? ''} · ${locale === 'zh' ? '设置保存在本机' : 'Settings are local'}`),
  )
}
