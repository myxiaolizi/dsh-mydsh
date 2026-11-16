/**
 * Client half mounting.
 *
 * One `apply` registers everything, and one disposer takes it all away. The two
 * things that make that safe:
 *
 * - Every registration goes through `contribute`, which records its disposer, so
 *   unloading the plugin cannot leave a component behind in a slot the Host has
 *   already collapsed.
 * - Switchable entries are registered and withdrawn as the settings document
 *   changes, not on load only. A disabled entry costs nothing at all: no mount,
 *   no subscription, no poll.
 *
 * The state that decides which entries exist is recomputed on every settings
 * change and diffed against what is registered, so ten switches can flip in one
 * save without tearing down the settings page itself.
 */

/** The standalone pages the sidebar icon can open. */
function UsagePanel() {
  const settings = useSettings()
  const meta = useMeta()
  if (settings === undefined) return h('div', { className: 'mydsh-root mydsh-page' }, h(Empty, null, t().loading))
  return h(
    'div',
    { className: 'mydsh-root mydsh-page', style: { padding: '18px 22px' } },
    h(Styles),
    h(UsageSettingsTab, { settings, patch: (partial) => settingsStore.patch(partial), meta }),
  )
}

function BackupPanel() {
  const settings = useSettings()
  const meta = useMeta()
  if (settings === undefined) return h('div', { className: 'mydsh-root mydsh-page' }, h(Empty, null, t().loading))
  return h(
    'div',
    { className: 'mydsh-root mydsh-page', style: { padding: '18px 22px' } },
    h(Styles),
    h(BackupTab, { settings, patch: (partial) => settingsStore.patch(partial), meta }),
  )
}

function ModulesPanel() {
  const settings = useSettings()
  const meta = useMeta()
  if (settings === undefined) return h('div', { className: 'mydsh-root mydsh-page' }, h(Empty, null, t().loading))
  return h(
    'div',
    { className: 'mydsh-root mydsh-page', style: { padding: '18px 22px' } },
    h(Styles),
    h(ModulesTab, { settings, patch: (partial) => settingsStore.patch(partial), meta }),
  )
}

/** The sidebar panel icon: a small gauge, drawn with theme tokens. */
function PanelIcon({ size, active }) {
  const edge = Number(size ?? 20)
  return h(
    'svg',
    {
      width: edge,
      height: edge,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: active === true ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    h('path', { d: 'M4 17a8 8 0 1 1 16 0' }),
    h('path', { d: 'M12 17l4.2-5' }),
    h('circle', { cx: 12, cy: 17, r: 1.4, fill: 'currentColor', stroke: 'none' }),
  )
}

/**
 * Which entries the current document asks for.
 *
 * A tab also depends on its module: showing a Usage tab whose engine the user
 * switched off would open an empty page, so the module switch gates the tab.
 *
 * `settingsSection` is deliberately not switchable. It is the only door back to
 * this page: if a user could hide it and also hide every other entry, the plugin
 * would become invisible with no way to undo that from the interface.
 */
function entryPlan(settings) {
  const entries = settings?.ui?.entries ?? {}
  const modules = settings?.modules ?? {}
  return {
    settingsSection: true,
    sidebarPanel: entries.sidebarPanel === true,
    footerUsage: entries.footerUsage === true,
    tabContext: entries.tabContext === true && modules.contextInsight?.enabled !== false,
    tabTeam: entries.tabTeam === true && modules.teams?.enabled !== false,
    tabUsage: entries.tabUsage === true && settings?.usage?.enabled !== false,
    accountToTitlebar: settings?.ui?.accountToTitlebar === true,
    hideBrandMark: settings?.ui?.hideBrandMark === true,
    hideBrandName: settings?.ui?.hideBrandName === true,
  }
}

/**
 * Restore the preferred grouping into the Host's own persisted view state.
 *
 * The Host stores the Workspaces list view in `localStorage`; writing that
 * record is what makes the sidebar's own switching UI agree with this setting
 * instead of fighting it. A storage that refuses writes is not an error: the
 * Host's own choice simply stays in place.
 */
function applySidebarView(ui) {
  if (ui === undefined) return
  try {
    const raw = window.localStorage.getItem(VIEW_STORE_KEY)
    const parsed = raw === null ? undefined : JSON.parse(raw)
    const state = parsed?.state ?? parsed ?? {}
    const wanted = ui.sidebarView
    if (wanted === undefined || state.groupBy === wanted) return
    const next =
      parsed?.state === undefined
        ? { state: { ...state, groupBy: wanted }, version: 0 }
        : { ...parsed, state: { ...state, groupBy: wanted } }
    window.localStorage.setItem(VIEW_STORE_KEY, JSON.stringify(next))
  } catch {
    // Ignored on purpose; see the comment above.
  }
}

return {
  name: NS,
  inject: ['slots'],

  /**
   * Register the settings page, the panels, and the entry decorations.
   * @param ctx - the Client Cordis context.
   */
  apply(ctx) {
    // Utility functions read the locale through this reference; capture it once.
    ctxRef.get = (name) => ctx.get(name)

    /** Every disposer created here, run on unload. */
    const disposers = []

    /**
     * Register one slot contribution and keep its disposer.
     * @param slot - slot key.
     * @param options - registration options, or `undefined` for a bare seat.
     * @param component - React component.
     */
    const contribute = (slot, options, component) => {
      const disposer = ctx.slots.inject(slot, () =>
        ctx.slots.register(options === undefined ? { name: slot } : { name: slot, ...options }, component),
      )
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    }

    // The New-session row is a HOC: registering it always is safe, because while
    // the switch is off it returns `children` unchanged. Registering and
    // withdrawing it on every toggle would remount the row and lose its focus.
    contribute('sidebar.session.action', { id: `${NS}-new-session` }, NewSessionVeil)

    // The settings page is always present. Hiding it is not offered as a switch:
    // combined with hiding every other entry it would leave no way back into
    // this page, and the only fix would be editing the settings file by hand.
    contribute('settings.section', { id: NS, order: 40, label: t().appTitle }, Page)

    /** Live entries, keyed by plan name. */
    const registered = new Map()

    /**
     * Entry specs. A spec without `options` targets a `single` seat, which
     * rejects registration options outright.
     */
    const entrySpecs = {
      // `settingsSection` is registered below, unconditionally: it is the door back.
      sidebarPanel: () => ({ slot: 'sidebar.panellist', options: { id: 'mydsh-usage', order: 30, label: t().appTitle }, component: PanelIcon }),
      footerUsage: () => ({ slot: 'sidebar.footer.action', options: { id: `${NS}-usage`, order: 20, label: t().tabUsage }, component: FooterUsage }),
      tabUsage: () => ({ slot: 'conversation.view', options: { id: 'mydsh-usage', order: 40, label: () => t().tabUsage }, component: UsageView }),
      tabContext: () => ({ slot: 'conversation.view', options: { id: 'mydsh-context', order: 20, label: () => (activeLocale() === 'zh' ? '上下文' : 'Context') }, component: ContextView }),
      tabTeam: () => ({ slot: 'conversation.view', options: { id: 'mydsh-team', order: 30, label: () => (activeLocale() === 'zh' ? '编队' : 'Team') }, component: TeamView }),
      accountToTitlebar: () => ({ slot: 'conversation.header.leading', component: AccountBubble }),
      hideBrandMark: () => ({ slot: 'sidebar.brand.mark', component: Blank }),
      hideBrandName: () => ({ slot: 'sidebar.brand.name', component: Blank }),
    }

    /**
     * Add or remove one entry to match `wanted`.
     *
     * Withdrawing uses the recorded disposer rather than the one `contribute`
     * returned into the shared list, because that list is only drained on unload;
     * a withdrawn entry must not be disposed twice.
     */
    /**
     * Add or remove one entry to match `wanted`.
     *
     * Withdrawing uses the recorded disposer rather than the one `contribute`
     * returned into the shared list, because that list is only drained on unload;
     * a withdrawn entry must not be disposed twice.
     *
     * A plan key without a spec is an always-on entry that `apply` registered
     * directly; it is skipped here rather than treated as an error, so adding a
     * permanent seat cannot break the diff.
     */
    const syncEntry = (name, wanted) => {
      const existing = registered.get(name)
      if (wanted && existing === undefined) {
        const spec = entrySpecs[name]?.()
        if (spec === undefined) return
        const disposer = spec.options === undefined
          ? contribute(spec.slot, undefined, spec.component)
          : contribute(spec.slot, spec.options, spec.component)
        registered.set(name, disposer)
        return
      }
      if (!wanted && existing !== undefined) {
        try {
          existing?.()
        } catch {
          // The seat may already have collapsed with its owner.
        }
        registered.delete(name)
      }
    }

    /** Apply the document's entry plan. */
    const reconcile = (settings) => {
      const plan = entryPlan(settings)
      for (const [name, wanted] of Object.entries(plan)) syncEntry(name, wanted)
      applySidebarView(settings?.ui)
    }

    // --- subscription ------------------------------------------------------

    disposers.push(settingsStore.start())

    let lastPlan = ''
    const onStore = () => {
      const settings = settingsStore.get()
      if (settings === undefined) return
      const plan = JSON.stringify(entryPlan(settings))
      if (plan === lastPlan) return
      lastPlan = plan
      reconcile(settings)
    }
    disposers.push(settingsStore.subscribe(onStore))
    // The first snapshot may already be loaded by another entry.
    onStore()

    ctx.effect(
      () => () => {
        for (const disposer of disposers.splice(0, disposers.length)) {
          try {
            disposer()
          } catch {
            // A seat that already collapsed disposes itself.
          }
        }
        registered.clear()
      },
      'dsh-mydsh: client contributions',
    )
  },
}
