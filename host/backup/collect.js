/**
 * Collectors: the set of things a backup can contain.
 *
 * Every collector is read-only against the user's data. It answers a manifest of
 * `{ source | data, relative, bytes, digest }` entries, plus a writer-visible
 * flag for entries that must be skipped. Collectors never materialise a tree in
 * memory: they stream through `walkFiles`, and the archive writers stream each
 * file from its source path, so peak memory is one copy buffer.
 *
 * Seven groups are supported. `other` and `credentials` are the V2 additions;
 * `other` is deliberately the catch-all, so a directory DSH grows in a future
 * release still lands in the backup instead of being silently dropped.
 *
 * Two rules shape the whole file:
 *
 * 1. Every absolute source is claimed by at most one group. The user sees a
 *    per-item size breakdown, so double counting one file would misreport both
 *    the size and the deduplicated total.
 * 2. Nothing here throws for a missing directory. An empty home is a normal
 *    state on a fresh install, and the engine distinguishes "nothing selected"
 *    from "selected but absent" with the item list, not with an exception.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { dshHome, dataDir, fileExists, listDir } from '../core/store.js'
import { contentDigest, statDigest, walkFiles } from './paths.js'

/** Directory names that never hold user state worth archiving. */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.pnpm',
  '.pnpm-store',
  '.cache',
  'cache',
  'tmp',
  'temp',
  'logs',
  'log',
  '.turbo',
  'dist',
])

/** File names that are configuration, not content, at the home root. */
const CONFIG_FILE = /\.(json|ya?ml|toml|ini|conf|properties)$/i

/** Files that are scratch output of some other writer, not configuration. */
const SCRATCH_FILE = /\.(tmp|temp|log|lock|pid|swp)$/i

/** Names that belong to the credentials group wherever they appear. */
const CREDENTIAL_FILE = /^(\.?credentials?\.(ya?ml|json)|auth\.json|tokens?\.json)$/i

/** Profile-root files that describe the bundle set and the patch layer. */
const PROFILE_CONFIG_FILES = [
  'cordis.patch.yml',
  'cordis.yml',
  'cordis.yaml',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  '.modules.yaml',
  '.npmrc',
]

/** The item keys this engine understands, in report order. */
export const ITEM_KEYS = Object.freeze([
  'conversations',
  'systemConfig',
  'plugins',
  'models',
  'workspaceFiles',
  'other',
  'credentials',
])

/**
 * Claim bookkeeping shared by every collector in one pass.
 *
 * A path is claimed by absolute source *and* by archive-relative name: two
 * different absolute files can map to the same member name (a profile bundle
 * that is a symlink into the same package under two names), and a colliding
 * member would produce an archive that extracts wrongly.
 */
class ClaimSet {
  #absolute = new Set()

  #relative = new Set()

  /** Normalised comparison key for an absolute path. */
  static key(path) {
    return process.platform === 'win32' ? path.toLowerCase() : path
  }

  /** True when this source or member name was already taken. */
  has(absolute, relative) {
    if (typeof relative !== 'string') return true
    if (absolute !== undefined && this.#absolute.has(ClaimSet.key(absolute))) return true
    return this.#relative.has(relative.toLowerCase())
  }

  /** Record a claim. */
  add(absolute, relative) {
    if (typeof absolute === 'string' && absolute !== '') this.#absolute.add(ClaimSet.key(absolute))
    if (typeof relative === 'string' && relative !== '') this.#relative.add(relative.toLowerCase())
  }
}

/** True when a regular file should be represented as a member of an item. */
function isConfigCandidate(name) {
  if (name.startsWith('.')) return /^\.(credentials?|anonymous-user-id)/i.test(name) || /^\.[a-z0-9-]+\.(json|ya?ml)$/i.test(name)
  return CONFIG_FILE.test(name) && !SCRATCH_FILE.test(name)
}

/** Turn a walked file into a manifest entry, applying the per-file size cap. */
function entryOf(file, relative, limitBytes) {
  const tooBig = limitBytes > 0 && file.bytes > limitBytes
  return {
    source: file.absolute,
    relative,
    bytes: file.bytes,
    mtimeMs: file.mtimeMs,
    digest: statDigest(file.mtimeMs, file.bytes),
    skip: tooBig,
    reason: tooBig ? 'size' : undefined,
  }
}

/** Turn an in-memory payload into a manifest entry (synthesised config). */
function syntheticEntry(relative, payload, at = Date.now()) {
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  return {
    data: buffer,
    relative,
    bytes: buffer.length,
    mtimeMs: at,
    digest: contentDigest(buffer),
    skip: false,
  }
}

/** Join archive segments with `/`, dropping empty pieces. */
function member(...parts) {
  return parts
    .filter((part) => typeof part === 'string' && part !== '')
    .map((part) => part.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .join('/')
}

/** Reduce a path segment to something safe inside an archive. */
function label(value) {
  return String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/**
 * Conversation logs: every file below a session directory, verbatim.
 *
 * The layout is `<home>/sessions/<workspace-bucket>/<session>/<file>`. Files are
 * copied as they are on disk (older versions store `*.jsonl`, current ones
 * `session.v4.jsonl.zstd`), because re-encoding a log would change its bytes
 * and a restore would then differ from the backup.
 */
async function conversationEntries(claims, limitBytes, skipped) {
  const root = join(dshHome(), 'sessions')
  if (!(await fileExists(root))) return []
  const entries = []
  for (const bucket of await listDir(root)) {
    if (!bucket.isDirectory()) continue
    if (SKIP_DIR_NAMES.has(bucket.name)) continue
    const bucketDir = join(root, bucket.name)
    for (const session of await listDir(bucketDir)) {
      if (!session.isDirectory()) continue
      const sessionDir = join(bucketDir, session.name)
      for (const file of await listDir(sessionDir)) {
        if (!file.isFile() && !file.isSymbolicLink()) continue
        const absolute = join(sessionDir, file.name)
        const relative = member('conversations', label(bucket.name), label(session.name), label(file.name))
        if (claims.has(absolute, relative)) continue
        const info = await stat(absolute).catch(() => undefined)
        if (info === undefined || !info.isFile()) continue
        const entry = entryOf({ absolute, bytes: info.size, mtimeMs: info.mtimeMs }, relative, limitBytes)
        if (entry.skip) skipped.push({ relative, bytes: entry.bytes })
        claims.add(absolute, relative)
        entries.push(entry)
      }
    }
  }
  return entries
}

/**
 * Configuration: the home-root config files, the profile patch layer and this
 * plugin's own settings document.
 *
 * Sessions, attachments and bundle code are excluded by construction — they are
 * their own groups and would otherwise be counted twice. Credential files are
 * excluded here so the `credentials` switch alone decides whether they travel.
 */
async function systemConfigEntries(claims, limitBytes, skipped) {
  const home = dshHome()
  const entries = []

  /**
   * Add one absolute file if it is a config candidate and not claimed.
   *
   * `forceName` widens the *name* test only (so a dotfile such as
   * `.anonymous-user-id` is accepted). The credential exclusion is applied
   * unconditionally and cannot be forced: that file is only ever allowed in
   * through the `credentials` item, which has its own encryption precondition.
   */
  const addFile = async (absolute, relative, forceName = false) => {
    const name = basename(absolute)
    if (CREDENTIAL_FILE.test(name)) return
    if (!forceName && !isConfigCandidate(name)) return
    if (claims.has(absolute, relative)) return
    const info = await stat(absolute).catch(() => undefined)
    if (info === undefined || !info.isFile()) return
    const entry = entryOf({ absolute, bytes: info.size, mtimeMs: info.mtimeMs }, relative, limitBytes)
    if (entry.skip) skipped.push({ relative, bytes: entry.bytes })
    claims.add(absolute, relative)
    entries.push(entry)
  }

  // Home root: the documented settings files plus any config-class file DSH or a
  // plugin keeps beside them (balance caches, holiday tables, and so on).
  for (const item of await listDir(home)) {
    if (item.isDirectory()) continue
    if (SKIP_DIR_NAMES.has(item.name)) continue
    if (SCRATCH_FILE.test(item.name)) continue
    const absolute = join(home, item.name)
    const relative = member('system-config/home', label(item.name))
    await addFile(absolute, relative, item.name.startsWith('.'))
  }
  // The plugin's own settings document is configuration by any reading, and it
  // is the one file whose loss would reset every other feature this plugin owns.
  await addFile(dataDir('settings.json'), member('system-config/dsh-mydsh/settings.json'), true)

  // The profile patch layer: what decides which bundles are mounted.
  const profilesRoot = join(home, 'profiles')
  for (const profile of await listDir(profilesRoot)) {
    if (!profile.isDirectory()) continue
    for (const name of PROFILE_CONFIG_FILES) {
      await addFile(
        join(profilesRoot, profile.name, name),
        member('system-config/profiles', label(profile.name), name),
        true,
      )
    }
  }
  return entries
}

/**
 * Plugin bundles: the profile's bundle list plus each bundle's `package.json`
 * and its own data directory.
 *
 * `package.json` is the one file that identifies a bundle and its version, so a
 * restore can tell "same plugin, older version" from "different plugin" without
 * unpacking `node_modules`. The data directory (both `<home>/<bundle>` and
 * `<home>/storages/<bundle>` are in use) holds that plugin's own configuration.
 *
 * A bundle installed with `link:` is a symlink into a working copy. Reading
 * through the link is fine; walking through it is not, because it would wander
 * into the user's repository, so the walker refuses symlinked directories by
 * design and only the manifest file is taken from a linked bundle.
 */
async function pluginEntries(claims, limitBytes, skipped) {
  const home = dshHome()
  const profilesRoot = join(home, 'profiles')
  const entries = []
  /** Bundle directory names discovered across every profile. */
  const bundleNames = new Set()

  for (const profile of await listDir(profilesRoot)) {
    if (!profile.isDirectory()) continue
    const profileDir = join(profilesRoot, profile.name)
    const modules = join(profileDir, 'node_modules')
    if (!(await fileExists(modules))) continue

    // The bundle list itself: the profile package.json names every bundle the
    // profile owns, including linked ones, which is exactly what a restore needs.
    const listPath = join(profileDir, 'package.json')
    if (await fileExists(listPath)) {
      const relative = member('plugins', label(profile.name), 'bundle-list.json')
      if (!claims.has(listPath, relative)) {
        const info = await stat(listPath).catch(() => undefined)
        // A profile package.json is normally small; the size cap is still applied
        // so this group cannot smuggle a huge file past the limit.
        if (info !== undefined && info.isFile()) {
          const entry = entryOf({ absolute: listPath, bytes: info.size, mtimeMs: info.mtimeMs }, relative, limitBytes)
          if (entry.skip) skipped.push({ relative, bytes: entry.bytes })
          claims.add(listPath, relative)
          entries.push(entry)
        }
      }
    }

    for (const bundle of await listDir(modules)) {
      if (bundle.name.startsWith('.')) continue
      if (!bundle.isDirectory() && !bundle.isSymbolicLink()) continue
      bundleNames.add(bundle.name)
      const base = join(modules, bundle.name)
      const manifest = join(base, 'package.json')
      const relative = member('plugins', label(profile.name), label(bundle.name), 'package.json')
      if (!claims.has(manifest, relative)) {
        const info = await stat(manifest).catch(() => undefined)
        if (info !== undefined && info.isFile()) {
          const entry = entryOf({ absolute: manifest, bytes: info.size, mtimeMs: info.mtimeMs }, relative, limitBytes)
          if (entry.skip) skipped.push({ relative, bytes: entry.bytes })
          claims.add(manifest, relative)
          entries.push(entry)
        }
      }
    }
  }

  // Each bundle's own data directory, when the name matches a bundle and the
  // directory is not already covered by another group.
  const claimedDirs = []
  for (const name of bundleNames) {
    const candidates = [join(home, name), join(home, 'storages', name)]
    for (const dir of candidates) {
      if (!(await fileExists(dir))) continue
      const info = await stat(dir).catch(() => undefined)
      if (info === undefined || !info.isDirectory()) continue
      claimedDirs.push(dir)
      for await (const file of walkFiles(dir, { skipDirs: SKIP_DIR_NAMES, maxEntries: 20000, concurrency: 4 })) {
        const inner = file.absolute.slice(dir.length).replace(/^[\\/]+/, '').split(/[\\/]/).map(label).join('/')
        const relative = member('plugins', 'data', label(name), inner)
        if (claims.has(file.absolute, relative)) continue
        const entry = entryOf(file, relative, limitBytes)
        if (entry.skip) skipped.push({ relative, bytes: entry.bytes })
        claims.add(file.absolute, relative)
        entries.push(entry)
      }
    }
  }
  return { entries, claimedDirs }
}

/**
 * Model and provider selection — synthesised, because DSH keeps the effective
 * pick in memory and in the patch layer rather than in one file.
 *
 * The synthetic `selection.json` records what a restore needs to re-point the
 * model picker: the configured providers, the price overrides the user added,
 * and the failover chain. It carries no secret: API keys are reduced to a
 * boolean marker. Files the user or another plugin keeps under a
 * model-shaped name are added beside it.
 */
async function modelEntries(claims, limitBytes, skipped, settings) {
  const home = dshHome()
  const entries = []
  const usage = settings?.usage ?? {}
  const retry = settings?.retry ?? {}
  const selection = {
    generatedAt: new Date().toISOString(),
    providers: [
      {
        provider: 'deepseek',
        configured: typeof usage.balance?.deepseek?.apiKey === 'string' && usage.balance.deepseek.apiKey !== '',
        baseUrl: usage.balance?.deepseek?.baseUrl ?? '',
      },
      ...(Array.isArray(usage.balance?.providers) ? usage.balance.providers : []).map((row) => ({
        provider: row.provider,
        label: row.label,
        configured: true,
      })),
    ],
    priceOverrides: Array.isArray(usage.priceOverrides)
      ? usage.priceOverrides.map((row) => ({
          provider: row.provider,
          model: row.model,
          input: row.input,
          output: row.output,
          cacheRead: row.cacheRead,
          cacheWrite: row.cacheWrite,
          currency: row.currency,
        }))
      : [],
    failoverChain: Array.isArray(retry.chain) ? retry.chain.map((row) => ({ provider: row.provider, model: row.model })) : [],
    allowSwitchModel: retry.allowSwitchModel !== false,
    allowSwitchProvider: retry.allowSwitchProvider !== false,
  }
  const syntheticFor = 'models/selection.json'
  if (!claims.has(undefined, syntheticFor)) {
    claims.add(undefined, syntheticFor)
    entries.push(syntheticEntry(syntheticFor, `${JSON.stringify(selection, null, 2)}\n`))
  }

  /** Model-shaped files worth taking verbatim, wherever they live. */
  const candidates = []
  for (const item of await listDir(home)) {
    if (item.isDirectory()) continue
    if (SCRATCH_FILE.test(item.name)) continue
    if (!/model|provider/i.test(item.name)) continue
    if (!CONFIG_FILE.test(item.name)) continue
    candidates.push([join(home, item.name), member('models', label(item.name))])
  }
  const pluginModels = dataDir('models.json')
  if (await fileExists(pluginModels)) candidates.push([pluginModels, 'models/dsh-mydsh-models.json'])

  for (const [absolute, relative] of candidates) {
    if (claims.has(absolute, relative)) continue
    const info = await stat(absolute).catch(() => undefined)
    if (info === undefined || !info.isFile()) continue
    const entry = entryOf({ absolute, bytes: info.size, mtimeMs: info.mtimeMs }, relative, limitBytes)
    if (entry.skip) skipped.push({ relative, bytes: entry.bytes })
    claims.add(absolute, relative)
    entries.push(entry)
  }
  return entries
}

/**
 * Workspace trees, one directory per registered workspace.
 *
 * `workspaces` is supplied by the caller because only the Host knows the
 * registry; the engine resolves it lazily, so a profile with no workspace
 * service still backs everything else up.
 */
async function workspaceEntries(claims, limitBytes, skipped, workspaces) {
  const entries = []
  for (const workspace of workspaces) {
    const root = workspace.path
    if (typeof root !== 'string' || root === '') continue
    if (!(await fileExists(root))) continue
    const folder = label(workspace.title || workspace.id || basename(root))
    for await (const file of walkFiles(root, { skipDirs: SKIP_DIR_NAMES, maxEntries: 50000, concurrency: 4 })) {
      const inner = file.absolute.slice(root.length).replace(/^[\\/]+/, '')
      const relative = member('workspaces', folder, inner.split(/[\\/]/).map(label).join('/'))
      if (claims.has(file.absolute, relative)) continue
      const entry = entryOf(file, relative, limitBytes)
      if (entry.skip) skipped.push({ relative, bytes: entry.bytes })
      claims.add(file.absolute, relative)
      entries.push(entry)
    }
  }
  return entries
}

/**
 * Everything not already claimed: `storages/`, this plugin's own data, and any
 * other top-level entry of the home directory.
 *
 * This is the group that keeps a backup meaningful across DSH releases: a new
 * directory added to `<DSH_HOME>` shows up here without a code change. Two
 * subtrees are excluded on purpose:
 *
 * - `restore/` below this plugin's data directory holds unpacked archives and
 *   would make every backup contain the previous backups.
 * - the run ledger is excluded because it is the audit trail of the act of
 *   backing up; copying it into its own archive is circular.
 */
async function otherEntries(claims, limitBytes, skipped, claimedDirs) {
  const home = dshHome()
  const entries = []
  /** Directories that are their own group and must not be re-walked here. */
  const owned = new Set(['sessions', 'profiles', 'attachments', 'node_modules', 'bin', 'locale'])

  const walkInto = async (root, prefix) => {
    for await (const file of walkFiles(root, { skipDirs: SKIP_DIR_NAMES, maxEntries: 40000, concurrency: 4 })) {
      const inner = file.absolute.slice(root.length).replace(/^[\\/]+/, '')
      const relative = member(prefix, inner.split(/[\\/]/).map(label).join('/'))
      if (claims.has(file.absolute, relative)) continue
      const entry = entryOf(file, relative, limitBytes)
      if (entry.skip) skipped.push({ relative, bytes: entry.bytes })
      claims.add(file.absolute, relative)
      entries.push(entry)
    }
  }

  for (const item of await listDir(home)) {
    if (SKIP_DIR_NAMES.has(item.name)) continue
    if (owned.has(item.name)) continue
    const absolute = join(home, item.name)
    if (item.isSymbolicLink()) continue

    if (item.isFile()) {
      if (SCRATCH_FILE.test(item.name)) continue
      if (CREDENTIAL_FILE.test(item.name)) continue
      const relative = member('other/home', label(item.name))
      if (claims.has(absolute, relative)) continue
      const info = await stat(absolute).catch(() => undefined)
      if (info === undefined || !info.isFile()) continue
      const entry = entryOf({ absolute, bytes: info.size, mtimeMs: info.mtimeMs }, relative, limitBytes)
      if (entry.skip) skipped.push({ relative, bytes: entry.bytes })
      claims.add(absolute, relative)
      entries.push(entry)
      continue
    }

    if (!item.isDirectory()) continue
    if (claimedDirs.includes(absolute)) continue

    if (item.name === 'dsh-mydsh') {
      // This plugin's own state, minus the parts that are not state: the run
      // ledger, the incremental baselines and any unpacked restore tree.
      for await (const file of walkFiles(absolute, { skipDirs: SKIP_DIR_NAMES, maxEntries: 40000, concurrency: 4 })) {
        const inner = file.absolute.slice(absolute.length).replace(/^[\\/]+/, '').split(/[\\/]/)
        if (inner[0] === 'restore' || inner[0] === 'backup') continue
        if (inner.length === 1 && inner[0] === 'settings.json') continue
        const relative = member('other/dsh-mydsh', inner.map(label).join('/'))
        if (claims.has(file.absolute, relative)) continue
        const entry = entryOf(file, relative, limitBytes)
        if (entry.skip) skipped.push({ relative, bytes: entry.bytes })
        claims.add(file.absolute, relative)
        entries.push(entry)
      }
      continue
    }

    // `storages/` holds projections and per-plugin state; everything else at the
    // home root is some plugin's own directory. Both are user state.
    const prefix = item.name === 'storages' ? 'other/storages' : member('other/home', label(item.name))
    await walkInto(absolute, prefix)
  }
  return entries
}

/**
 * Credential files.
 *
 * This group is off by default, and it refuses to run unless encryption is on:
 * an unencrypted archive of `.credentials.yaml` on a shared drive or a public
 * gist is a leaked key, and the user who ticked the box did not necessarily
 * mean to publish it. The refusal is reported, not thrown, so the rest of the
 * backup still completes.
 */
async function credentialEntries(claims, limitBytes, skipped, encryptionEnabled) {
  if (encryptionEnabled !== true) return { entries: [], refused: true }
  const home = dshHome()
  const entries = []
  const consider = async (absolute, relative) => {
    if (claims.has(absolute, relative)) return
    const info = await stat(absolute).catch(() => undefined)
    if (info === undefined || !info.isFile()) return
    const entry = entryOf({ absolute, bytes: info.size, mtimeMs: info.mtimeMs }, relative, limitBytes)
    if (entry.skip) skipped.push({ relative, bytes: entry.bytes })
    claims.add(absolute, relative)
    entries.push(entry)
  }

  for (const item of await listDir(home)) {
    if (item.isDirectory()) continue
    if (!CREDENTIAL_FILE.test(item.name) && !/^\.credentials/i.test(item.name)) continue
    await consider(join(home, item.name), member('credentials', label(item.name)))
  }
  for (const profile of await listDir(join(home, 'profiles'))) {
    if (!profile.isDirectory()) continue
    for (const name of ['.credentials.yaml', '.credentials.yml', 'credentials.json']) {
      await consider(
        join(home, 'profiles', profile.name, name),
        member('credentials', 'profiles', label(profile.name), name),
      )
    }
  }
  return { entries, refused: false }
}

/**
 * Build the archive manifest for one backup.
 *
 * @param options.items - the `backup.items` switches.
 * @param options.workspaces - resolved `{ id, title, path }` records.
 * @param options.maxFileMb - per-file ceiling; 0 disables the cap.
 * @param options.encryptionEnabled - whether credentials may be included.
 * @param options.settings - the full settings document (for `models`).
 * @returns `{ entries, items, skipped, notices }`.
 */
export async function collectBackup(options = {}) {
  const items = options.items ?? {}
  const workspaces = Array.isArray(options.workspaces) ? options.workspaces : []
  const limitBytes = Math.max(0, Number(options.maxFileMb) || 0) * 1024 * 1024
  const claims = new ClaimSet()
  /** @type {{ relative: string, bytes: number }[]} */
  const skipped = []
  /** @type {{ key: string, tone: string, message: string }[]} */
  const notices = []
  const groups = []

  /** Collect one group and register it when it produced anything. */
  const take = (key, entries) => {
    if (entries.length === 0) return
    groups.push({ key, entries })
  }

  if (items.conversations === true) take('conversations', await conversationEntries(claims, limitBytes, skipped))
  if (items.systemConfig === true) take('systemConfig', await systemConfigEntries(claims, limitBytes, skipped))

  let claimedDirs = []
  if (items.plugins === true) {
    const collected = await pluginEntries(claims, limitBytes, skipped)
    claimedDirs = collected.claimedDirs
    take('plugins', collected.entries)
  }
  if (items.models === true) take('models', await modelEntries(claims, limitBytes, skipped, options.settings))
  if (items.workspaceFiles === true) take('workspaceFiles', await workspaceEntries(claims, limitBytes, skipped, workspaces))
  if (items.other === true) take('other', await otherEntries(claims, limitBytes, skipped, claimedDirs))

  if (items.credentials === true) {
    const collected = await credentialEntries(claims, limitBytes, skipped, options.encryptionEnabled)
    if (collected.refused) {
      notices.push({
        key: 'credentials',
        tone: 'warn',
        message:
          'Credentials were left out: this backup is not encrypted. Turn encryption on to include .credentials.yaml and the other credential files.',
      })
    } else {
      take('credentials', collected.entries)
    }
  }

  // Attach the owning group to every entry so the run record and the incremental
  // baseline can report per-item numbers without re-walking anything.
  const entries = []
  const itemRows = []
  for (const group of groups) {
    let bytes = 0
    for (const entry of group.entries) {
      entry.group = group.key
      bytes += entry.bytes
      entries.push(entry)
    }
    itemRows.push({ key: group.key, files: group.entries.length, bytes })
  }

  return { entries, items: itemRows, skipped, notices }
}

/**
 * Read one collected entry into memory.
 *
 * Only used for small entries and for the synthetic payloads; everything large
 * is streamed from its source by the archive writer.
 *
 * @param entry - a manifest entry.
 * @returns the bytes, or `undefined` when the entry was skipped or vanished.
 */
export async function readEntry(entry) {
  if (entry.skip === true) return undefined
  if (entry.data !== undefined) return entry.data
  try {
    return await readFile(entry.source)
  } catch {
    return undefined
  }
}

/**
 * Estimate the manifest without writing bytes.
 * @param manifest - `collectBackup` output.
 */
export function summarizeManifest(manifest) {
  const live = manifest.entries.filter((entry) => entry.skip !== true)
  return {
    files: live.length,
    bytes: live.reduce((sum, entry) => sum + entry.bytes, 0),
    items: manifest.items,
    skipped: manifest.skipped.length,
  }
}

/** The digest map an incremental run needs as its baseline. */
export function digestOf(entries) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const entry of entries) {
    if (entry.skip === true) continue
    out[entry.relative] = entry.digest
  }
  return out
}
