/**
 * Configuration and plugin management.
 *
 * The reference plugin edits `cordis.patch.yml` as text and backs the whole file
 * up before every write. This module refuses to do that, for a concrete reason:
 * the Host already owns that file through `ctx.configEditor`, which serialises
 * edits against Loader hot-reload, validates the resulting composition, and
 * rolls the file back when the reload fails. A second writer would race it and
 * could leave a profile that no longer boots.
 *
 * So the rule here is: **this module never opens the patch file**. It talks to
 * `pluginManager` for enable/disable (the maintained path, which also knows which
 * rows are manageable at all) and falls back to `configEditor.edit` with an
 * updater function. When neither exists, it says so plainly instead of guessing.
 *
 * Secret handling is the second concern. A settings page must not receive an API
 * key it can echo back, so every credential-shaped field is masked on read and
 * the literal `***` on write means "unchanged". The sentinel is documented in the
 * API contract and is the only value that means "keep what is stored".
 */

import { describe, failure, hasMethod, localized, maskSecrets, mergeSecretPatch, moduleSettings, record, serviceOf, text } from '../shared.js'

/** The value a masked field carries on read, and the "do not change" sentinel. */
const SECRET_SENTINEL = '***'

/** Largest patch this module accepts, in top-level keys. */
const MAX_PATCH_KEYS = 64

/**
 * Flatten a loader entry tree the way `configEditor` addresses rows.
 * Group entries hold their children in `config`; only leaf rows are addressable.
 * @param rows - entries as the service returns them.
 * @returns every addressable row.
 */
function flattenEntries(rows) {
  const out = []
  const seen = new Set()
  const walk = (list) => {
    for (const row of list) {
      if (seen.has(row)) continue
      seen.add(row)
      out.push(row)
      if (Array.isArray(row?.options?.group) && Array.isArray(row?.options?.config)) walk(row.options.config)
    }
  }
  walk(Array.isArray(rows) ? rows : [])
  return out
}

/** The id a loader entry is addressed by. */
function idOfEntry(entry) {
  const options = entry?.options
  return text(options?.id, 128)
}

/** Whether a row is a group (and therefore not a leaf configuration). */
function isGroup(entry) {
  return Array.isArray(entry?.options?.group)
}

/**
 * Create the configuration manager.
 * @param options.ctx - plugin context; `configEditor` and `pluginManager` are optional.
 * @param options.getSettings - synchronous settings reader.
 * @returns the module surface used by `/config/*`.
 */
export function createConfigManager({ ctx, getSettings }) {
  const settingsOf = () => moduleSettings(getSettings, 'configManager')

  const editor = () => serviceOf(ctx, 'configEditor')
  const plugins = () => serviceOf(ctx, 'pluginManager')

  /** Preferred display language for manifest titles. */
  function language() {
    try {
      const locale = serviceOf(ctx, 'locale')
      const value = text(locale?.preference, 16)
      if (value !== '') return value
    } catch {
      // A locale service that throws is the same as no locale service.
    }
    return 'zh'
  }

  /**
   * Every addressable configuration row.
   *
   * Two sources are merged because they know different things: `configEditor`
   * knows the live Loader entries and their inherited/overridden config, while
   * `pluginManager` knows which rows are manageable and why one is not. A row
   * present only in the editor is still listed, with `readOnly` derived from
   * whether the editor can address it at all.
   * @returns `ConfigRow[]` plus a per-row `why` for the UI's tooltip.
   */
  function list() {
    const configEditor = editor()
    const manager = plugins()
    const lang = language()

    /** Plugin-manager rows keyed by entry id, for the read-only verdict. */
    const managed = new Map()
    if (hasMethod(manager, 'listPlugins')) {
      try {
        const rows = manager.listPlugins()
        // `listPlugins` may answer a promise on some builds; only a settled
        // synchronous array is usable here, and the async variant is handled by
        // `listAsync` below when the route can await.
        if (Array.isArray(rows)) {
          for (const row of rows) {
            const id = text(record(row)?.entryId, 128)
            if (id !== '') managed.set(id, row)
          }
        }
      } catch {
        // A disposed manager simply contributes nothing.
      }
    }

    /** Inherited config per row, for the "has children" and value reads. */
    const configuration = hasMethod(configEditor, 'configuration') ? safeConfiguration(configEditor) : []

    const rows = []
    for (const entry of hasMethod(configEditor, 'entries') ? safeEntries(configEditor) : []) {
      const id = idOfEntry(entry)
      if (id === '') continue
      const name = text(entry?.options?.name, 200)
      const info = managed.get(id)
      const meta = record(info?.meta)
      const title = localized(meta?.title, lang) || name || id
      const description = localized(meta?.description, lang) || text(meta?.error, 300)
      const config = record(entry?.options?.config)
      const row = configuration.find((item) => idOfEntry(item?.entry) === id)
      const effective = record(row?.inherited) ?? config ?? {}

      const readOnlyReason = text(info?.readOnlyReason, 32)
      // A row the plugin manager calls unmanageable, or one a plain editor
      // cannot address (no patch id), is read-only for toggling.
      const toggleReadOnly = readOnlyReason !== '' || (info !== undefined && text(info?.patchId, 128) === '')
      // `disabled` is a Loader Entry getter; the raw option is the fallback for a
      // detached row snapshot that carries only its options.
      const disabled = entry?.disabled === true || entry?.options?.disabled === true
      rows.push({
        id,
        name: name || id,
        title,
        description,
        enabled: !disabled,
        readOnly: toggleReadOnly,
        hasChildren: isGroup(entry) || Object.keys(effective).length > 0,
        why: readOnlyReason === 'management-required' ? '该插件由管理端维护，不能在此启停' : readOnlyReason === 'unaddressable' ? '该行无法在 profile 补丁中定位' : '',
      })
    }

    // A plugin the manager knows but the editor does not list is still worth
    // showing: it is installed and its state is real, just not addressable.
    for (const [id, info] of managed) {
      if (rows.some((row) => row.id === id)) continue
      const meta = record(info.meta)
      rows.push({
        id,
        name: text(info.moduleName, 200) || id,
        title: localized(meta?.title, lang) || text(info.moduleName, 200) || id,
        description: localized(meta?.description, lang),
        enabled: info.enabled === true,
        readOnly: true,
        hasChildren: false,
        why: text(info.readOnlyReason, 32) === 'management-required' ? '该插件由管理端维护，不能在此启停' : '该行无法在 profile 补丁中定位',
      })
    }

    rows.sort((left, right) => left.title.localeCompare(right.title, 'zh'))
    return rows
  }

  /** `configEditor.entries()` with a throwing service contained. */
  function safeEntries(configEditor) {
    try {
      const rows = configEditor.entries()
      return flattenEntries(rows)
    } catch {
      return []
    }
  }

  /** `configEditor.configuration()` with a throwing service contained. */
  function safeConfiguration(configEditor) {
    try {
      const rows = configEditor.configuration()
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  /** Find the live Loader entry addressed by `id`. */
  function entryOf(id) {
    const configEditor = editor()
    if (!hasMethod(configEditor, 'entries')) return undefined
    return safeEntries(configEditor).find((entry) => idOfEntry(entry) === id)
  }

  /**
   * Enable or disable one plugin row.
   *
   * `pluginManager` is preferred because it validates the row, knows about
   * overrides and reloads through the Loader's own path. `configEditor.edit` is
   * the fallback: it writes the patch row's `disabled` flag through the same
   * serialised writer the Host uses for its own configuration.
   * @param options.id - loader entry id.
   * @param options.enabled - desired state.
   * @returns `{ ok, entry }` or a structured failure.
   */
  async function toggle({ id, enabled } = {}) {
    const slice = settingsOf()
    if (slice.enabled !== true) return failure('配置管理模块未启用')
    if (slice.allowPluginToggle !== true) return failure('已在设置中关闭“允许启停插件”')
    const wanted = text(id, 128)
    if (wanted === '') return failure('缺少插件 id')
    if (typeof enabled !== 'boolean') return failure('enabled 必须是布尔值')

    const manager = plugins()
    if (hasMethod(manager, 'setPluginEnabled')) {
      try {
        const result = await manager.setPluginEnabled(wanted, enabled)
        const value = record(result) ?? {}
        return {
          ok: true,
          entry: list().find((row) => row.id === wanted) ?? null,
          restartRequired: value.restartRequired === true,
          message: text(value.message, 300),
        }
      } catch (error) {
        const message = describe(error)
        // "unknown plugin" means the manager does not own this row; the editor
        // may still address it, so fall through instead of failing the request.
        if (!/unknown-plugin|unknown plugin/i.test(message)) {
          return failure(`启停失败：${message}`)
        }
      }
    }

    const configEditor = editor()
    if (!hasMethod(configEditor, 'edit')) {
      return failure('当前版本没有可用的插件启停接口')
    }
    const entry = entryOf(wanted)
    if (entry === undefined) return failure('找不到该插件配置行')

    try {
      await configEditor.edit(entry, (current) => ({
        ...(record(current) ?? {}),
        disabled: enabled !== true,
      }))
      return { ok: true, entry: list().find((row) => row.id === wanted) ?? null, restartRequired: false, message: '' }
    } catch (error) {
      // This fallback writes the enablement flag through the config updater,
      // which is the only write channel available without touching the patch
      // text. A plugin whose schema has no `disabled` field refuses it, and that
      // refusal is reported rather than retried through a text edit.
      return failure(`启停失败：${describe(error)}`)
    }
  }

  /**
   * Read one row's schema and current value, with secrets masked.
   * @param options.id - loader entry id.
   * @returns `{ entry, schema, value }` or a structured failure.
   */
  function values({ id } = {}) {
    const slice = settingsOf()
    if (slice.enabled !== true) return failure('配置管理模块未启用')
    const wanted = text(id, 128)
    if (wanted === '') return failure('缺少插件 id')
    const entry = entryOf(wanted)
    if (entry === undefined) return failure('找不到该插件配置行')

    const configEditor = editor()
    const configuration = hasMethod(configEditor, 'configuration') ? safeConfiguration(configEditor) : []
    const row = configuration.find((item) => idOfEntry(item?.entry) === wanted)
    const value = record(row?.inherited) ?? record(entry?.options?.config) ?? {}
    const schemaSource = entry?.options?.schema ?? entry?.schema
    return {
      entry: {
        id: wanted,
        name: text(entry?.options?.name, 200),
        enabled: entry?.disabled !== true,
      },
      // A schema is a function/object with no safe JSON projection, so it is
      // reported as "present" plus its own textual description when it has one.
      schema: schemaSource === undefined ? null : { present: true, description: text(schemaSource?.toString?.(), 4000) || '' },
      value: maskSecrets(value),
      masked: true,
    }
  }

  /**
   * Write a partial configuration back, honouring the secret sentinel.
   * @param options.id - loader entry id.
   * @param options.patch - partial config; `***` means "keep the stored value".
   * @returns `{ ok, entry, changed }` or a structured failure.
   */
  async function edit({ id, patch } = {}) {
    const slice = settingsOf()
    if (slice.enabled !== true) return failure('配置管理模块未启用')
    if (slice.allowConfigEdit !== true) return failure('已在设置中关闭“允许编辑配置”')
    const wanted = text(id, 128)
    if (wanted === '') return failure('缺少插件 id')
    const incoming = record(patch)
    if (incoming === undefined) return failure('patch 必须是一个对象')
    const keys = Object.keys(incoming)
    if (keys.length === 0) return failure('patch 是空的，没有要写入的内容')
    if (keys.length > MAX_PATCH_KEYS) return failure(`单次最多修改 ${String(MAX_PATCH_KEYS)} 个字段`)

    const entry = entryOf(wanted)
    if (entry === undefined) return failure('找不到该插件配置行')

    const configEditor = editor()
    if (!hasMethod(configEditor, 'edit')) return failure('当前版本没有可用的配置编辑接口')

    let changed = false
    try {
      await configEditor.edit(entry, (current, inherited) => {
        const base = record(current) ?? {}
        const fallback = record(inherited) ?? {}
        // An empty stored config means "inherit"; merging over the inherited
        // layer keeps the write a delta instead of a full snapshot, which is
        // what makes a partial patch safe.
        const source = Object.keys(base).length === 0 ? fallback : base
        const merged = mergeSecretPatch(source, incoming)
        changed = merged.changed
        return merged.value
      })
    } catch (error) {
      return failure(`写入失败：${describe(error)}`)
    }
    if (!changed) {
      return { ok: true, entry: list().find((row) => row.id === wanted) ?? null, changed: false, message: '没有实际变化（密钥字段保持原值）' }
    }
    return { ok: true, entry: list().find((row) => row.id === wanted) ?? null, changed: true, message: '' }
  }

  return { list, toggle, values, edit }
}

/** Exported for the self-test: the sentinel and the masking entry points. */
export const CONFIG_CONTRACT = Object.freeze({ SECRET_SENTINEL, maskSecrets, mergeSecretPatch })
