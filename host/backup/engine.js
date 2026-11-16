/**
 * The backup engine.
 *
 * One run is: collect a manifest, build an archive in a private temporary
 * directory, optionally seal it, optionally split it, deliver every file to the
 * configured target, publish the index the sync feature reads, then prune to the
 * retention count. Runs never overlap; a second request joins the one in flight.
 *
 * Every run, restore, delete, prune and sync appends to an audit ledger so the
 * settings page can show history and offer a restore, and so a deleted backup
 * still leaves a trace.
 *
 * Design decisions worth stating once, because they are visible everywhere:
 *
 * - **A run never throws.** A destination that is offline, a password that is
 *   wrong, a disk that is full 鈥?all of them come back as `ok: false` with a
 *   message the settings page can show. Throwing would turn a background tick
 *   into an unhandled rejection, and the user would see nothing at all.
 * - **Restore never writes into a live location.** The unpacked tree lands under
 *   `<DSH_HOME>/dsh-mydsh/restore/<runId>/` (or an explicit `toDir`), and the
 *   caller is told where it is. Overwriting an open session or the running
 *   profile's configuration would corrupt the Harness mid-conversation.
 * - **The archive is built before the target is touched.** A destination is only
 *   contacted once there is something worth sending, so an offline target costs
 *   no local work beyond the archive that was going to be written anyway.
 */

import { copyFile, readFile, rm, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataDir, ensureDir } from '../core/store.js'
import { collectBackup, digestOf, summarizeManifest } from './collect.js'
import {
  decryptFile,
  encryptFile,
  extractArchive,
  joinParts,
  listArchive,
  sevenZipBinary,
  sortParts,
  splitFile,
  write7z,
  writeZip,
} from './archive.js'
import { createTarget, describeTarget, MANIFEST_NAME, resolveTarget } from './targets.js'
import { appendRun, findRun, loadBaseline, recentRuns, replaceRun, saveBaseline } from './ledger.js'
import { assertSafeAbsolute, hasTraversal, safeId, stamp } from './paths.js'

// Re-exported so `index.js` can keep asking the engine module whether a
// compression choice needs the external binary.
export { sevenZipBinary } from './archive.js'

/** True when this run needs the 7z binary. */
/**
 * Resolve the workspace list however the caller supplies it.
 *
 * The two halves disagree on the cheap cases: the Host computes the list
 * synchronously from `workspaceRegistry.list()`, while a test or an embedding may
 * hand in an async function. Accepting both removes a call-site assumption that
 * only surfaces as `catch is not a function` on the one path nobody exercised.
 *
 * @param source - a function returning an array or a promise of one.
 * @returns a workspace array, or `[]` when the source fails.
 */
async function safeWorkspaces(source) {
  if (typeof source !== 'function') return []
  try {
    const value = await source()
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export function needsSevenZip(compression) {
  return compression === '7z'
}

/** The archive extension for one compression choice. */
function extensionOf(compression) {
  return compression === '7z' ? '7z' : 'zip'
}

/** Human byte size for a message line. */
function humanBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * Create the backup engine.
 *
 * @param options.getSettings - returns the live settings document.
 * @param options.packageRoot - the plugin package root, used to find `bin/7zr`.
 * @param options.binary - an explicit 7z path; when absent `packageRoot` is used.
 * @param options.workspaces - async resolver of `{ id, title, path }` records.
 * @param options.onNotice - receives `{ kind, tone, title, message, ... }`.
 */
export function createBackupEngine(options = {}) {
  const getSettings = typeof options.getSettings === 'function' ? options.getSettings : () => ({ backup: {} })
  const packageRoot = typeof options.packageRoot === 'string' ? options.packageRoot : undefined
  const resolveWorkspaces = typeof options.workspaces === 'function' ? options.workspaces : async () => []
  const onNotice = typeof options.onNotice === 'function' ? options.onNotice : () => undefined

  /** Resolve the 7z binary once per call, so a later install is picked up. */
  const binaryOf = () => (typeof options.binary === 'string' && options.binary !== '' ? options.binary : packageRoot === undefined ? undefined : sevenZipBinary(packageRoot))

  /** @type {Promise<object> | undefined} */
  let running
  /** @type {Promise<object> | undefined} */
  let syncing

  /** The history, newest first. */
  async function runs() {
    return recentRuns()
  }

  /** The `backup` slice of the settings document, with defaults applied. */
  function config() {
    const settings = getSettings() ?? {}
    const backup = settings.backup ?? {}
    const items = backup.items ?? {}
    return {
      settings,
      items: {
        workspaceFiles: items.workspaceFiles === true,
        conversations: items.conversations === true,
        systemConfig: items.systemConfig === true,
        plugins: items.plugins === true,
        other: items.other === true,
        models: items.models === true,
        credentials: items.credentials === true,
      },
      type: backup.type === 'incremental' ? 'incremental' : 'full',
      compression: ['zip-deflate', 'zip', '7z', 'none'].includes(backup.compression) ? backup.compression : 'zip-deflate',
      splitSizeMb: Math.max(0, Number(backup.splitSizeMb) || 0),
      keepCount: Math.max(1, Number(backup.keepCount) || 10),
      maxFileMb: Math.max(0, Number(backup.maxFileMb) || 0),
      encryption: {
        enabled: backup.encryption?.enabled === true,
        password: typeof backup.encryption?.password === 'string' ? backup.encryption.password : '',
      },
      sync: {
        enabled: backup.sync?.enabled === true,
        direction: ['both', 'push', 'pull'].includes(backup.sync?.direction) ? backup.sync.direction : 'both',
        conflict: ['newer', 'local', 'remote'].includes(backup.sync?.conflict) ? backup.sync.conflict : 'newer',
      },
      targets: Array.isArray(backup.targets) ? backup.targets : [],
      activeTargetId: typeof backup.activeTargetId === 'string' ? backup.activeTargetId : '',
    }
  }

  /** Estimate what a backup would contain without writing anything. */
  async function estimate() {
    const current = config()
    let workspaces = []
    if (current.items.workspaceFiles) {
      workspaces = await safeWorkspaces(resolveWorkspaces)
    }
    const manifest = await collectBackup({
      items: current.items,
      workspaces,
      maxFileMb: current.maxFileMb,
      encryptionEnabled: current.encryption.enabled,
      settings: current.settings,
    })
    const summary = summarizeManifest(manifest)
    return {
      bytes: summary.bytes,
      files: summary.files,
      items: summary.items.map((row) => ({ key: row.key, bytes: row.bytes, files: row.files })),
      skipped: summary.skipped,
      notices: manifest.notices,
    }
  }

  /**
   * Perform one backup, or join the one already running.
   * @param request - optional `type`, `items`, `targetId`.
   * @returns the run record.
   */
  async function run(request = {}) {
    if (running !== undefined) return running
    const task = perform(request ?? {}).finally(() => {
      running = undefined
    })
    running = task
    return task
  }

  /** The real work of one backup run. */
  async function perform(request) {
    const current = config()
    const type = request.type === 'incremental' || request.type === 'full' ? request.type : current.type
    const items = normaliseItems(request.items, current.items)
    const selected = resolveTarget(configuredTargets(current), request.targetId)
    const startedAt = Date.now()
    const id = `dsh-mydsh-${stamp()}-${randomBytes(3).toString('hex')}`
    const workDir = join(tmpdir(), `dsh-mydsh-backup-${process.pid}-${Date.now()}-${randomBytes(2).toString('hex')}`)
    const notes = []

    const record = {
      id,
      kind: 'backup',
      startedAt,
      finishedAt: 0,
      type,
      items: [],
      targetId: selected.id,
      targetKind: selected.kind ?? 'local',
      target: describeTarget(selected),
      parts: 0,
      bytes: 0,
      rawBytes: 0,
      files: 0,
      encrypted: false,
      compression: current.compression,
      ok: false,
      message: '',
      path: '',
      incrementalBase: null,
      skipped: 0,
      durationMs: 0,
    }

    try {
      await ensureDir(workDir)

      // --- 1. collect ------------------------------------------------------
      let workspaces = []
      if (items.workspaceFiles) workspaces = await safeWorkspaces(resolveWorkspaces)
      const manifest = await collectBackup({
        items,
        workspaces,
        maxFileMb: current.maxFileMb,
        encryptionEnabled: current.encryption.enabled,
        settings: current.settings,
      })
      record.items = manifest.items.map((row) => row.key)
      record.rawBytes = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0)
      record.skipped = manifest.skipped.length
      for (const notice of manifest.notices) notes.push(notice.message)
      if (manifest.skipped.length > 0) {
        const biggest = manifest.skipped.slice(0, 3).map((entry) => entry.relative)
        notes.push(
          `${manifest.skipped.length} file(s) were skipped because they exceed the ${current.maxFileMb} MB per-file limit, for example ${biggest.join(', ')}.`,
        )
      }
      if (manifest.entries.length === 0) {
        throw new Error('Nothing matched the selected backup items, so no archive was written.')
      }

      // --- 2. incremental selection ---------------------------------------
      let entries = manifest.entries
      if (type === 'incremental') {
        const baseline = await loadBaseline(selected.id)
        if (baseline === undefined) {
          notes.push('No previous backup of this destination was recorded, so this incremental run became a full backup.')
          record.incrementalBase = null
        } else {
          record.incrementalBase = baseline.runId
          const previous = baseline.digests
          entries = manifest.entries.filter((entry) => entry.skip !== true && previous[entry.relative] !== entry.digest)
          if (entries.length === 0) {
            notes.push('Nothing changed since the last backup of this destination, so this run wrote no archive.')
            record.ok = true
            record.files = 0
            record.bytes = 0
            record.parts = 0
            record.message = notes.join(' ')
            record.finishedAt = Date.now()
            record.durationMs = record.finishedAt - startedAt
            await appendRun(record)
            onNotice({ kind: 'info', tone: 'info', title: 'Backup skipped', message: record.message, id })
            return record
          }
        }
      }

      // --- 3. archive ------------------------------------------------------
      let compression = current.compression
      const compressionNote = chooseCompression(compression, binaryOf())
      if (compressionNote.fallback === true) {
        compression = 'zip-deflate'
        notes.push(compressionNote.message)
      }
      record.compression = compression

      const extension = extensionOf(compression)
      const archiveName = `${id}.${extension}`
      const plainArchive = join(workDir, archiveName)
      let written
      if (compression === '7z') {
        written = await write7z(entries, plainArchive, {
          binary: binaryOf(),
          password: current.encryption.enabled ? current.encryption.password : undefined,
          tempRoot: workDir,
        })
      } else {
        written = await writeZip(entries, plainArchive, { level: compression === 'zip' || compression === 'none' ? 0 : 6 })
      }
      record.files = written.files
      if (written.skipped > 0) notes.push(`${written.skipped} entry(ies) could not be read and were left out of the archive.`)
      if (written.files === 0) throw new Error('None of the selected files could be read, so the archive would be empty.')

      // --- 4. seal ---------------------------------------------------------
      let deliverable = plainArchive
      let deliveredName = archiveName
      if (current.encryption.enabled) {
        if (current.encryption.password.length < 6) {
          throw new Error('Set an encryption password of at least 6 characters, or switch encryption off.')
        }
        if (compression === '7z') {
          // 7zr already encrypted its own payload with a header-encrypted archive;
          // sealing it again would make it unopenable by the tool a user reaches
          // for in an emergency. The flag still records that it travels sealed.
          record.encrypted = true
        } else {
          const sealed = `${plainArchive}.dshmy`
          await encryptFile(plainArchive, sealed, current.encryption.password)
          await rm(plainArchive, { force: true })
          deliverable = sealed
          deliveredName = `${archiveName}.dshmy`
          record.encrypted = true
        }
      }

      // --- 5. split --------------------------------------------------------
      const splitBytes = current.splitSizeMb > 0 ? Math.floor(current.splitSizeMb * 1024 * 1024) : 0
      const parts = await splitFile(deliverable, splitBytes)
      const measured = []
      for (const part of parts) {
        const info = await stat(part).catch(() => undefined)
        measured.push({ path: part, bytes: info?.size ?? 0, name: measuringName(part, deliveredName) })
      }
      const totalBytes = measured.reduce((sum, part) => sum + part.bytes, 0)

      // A destination with a hard per-object ceiling must refuse before uploading,
      // not after GitHub silently keeps the first 10 MB of a 200 MB part.
      const target = createTarget(selected)
      const ceiling = Number(target.maxObjectBytes) || 0
      if (ceiling > 0) {
        for (const part of measured) {
          if (part.bytes > ceiling) {
            throw new Error(
              `${target.kind} cannot hold ${part.name}: it is ${humanBytes(part.bytes)} and the limit is ${humanBytes(ceiling)}. Turn on splitting with a part size below that limit, or choose another destination.`,
            )
          }
        }
      }

      // --- 6. deliver ------------------------------------------------------
      const delivered = []
      for (const part of measured) {
        const remote = await target.put(part.name, part.path)
        delivered.push(remote)
        await rm(part.path, { force: true }).catch(() => undefined)
      }

      record.parts = delivered.length
      record.path = typeof delivered[0] === 'string' ? delivered[0] : ''
      record.bytes = totalBytes
      record.ok = true

      // --- 7. index, baseline, retention ----------------------------------
      await publishManifest(target, {
        id,
        at: Date.now(),
        type,
        compression,
        encrypted: record.encrypted,
        parts: delivered.map((reference, index) => ({
          name: measured[index]?.name ?? '',
          bytes: measured[index]?.bytes ?? 0,
          reference: typeof reference === 'string' ? reference : '',
        })),
        bytes: record.bytes,
        files: record.files,
        incrementalBase: record.incrementalBase,
        targetId: selected.id,
      }).catch((error) => {
        notes.push(`The destination index could not be updated: ${error?.message ?? error}`)
      })

      if (type === 'incremental' && record.incrementalBase !== null) {
        // An incremental baseline moves forward over the *union* of what the
        // previous baseline covered and what this run added, so the next diff is
        // still against the full state and not just the last delta.
        const previous = (await loadBaseline(selected.id))?.digests ?? {}
        const merged = { ...previous, ...digestOf(entries) }
        await saveBaseline(selected.id, {
          runId: id,
          at: Date.now(),
          type,
          files: Object.keys(merged).length,
          digests: merged,
        })
      } else {
        await saveBaseline(selected.id, {
          runId: id,
          at: Date.now(),
          type: 'full',
          files: entries.length,
          digests: digestOf(entries),
        })
      }

      const pruned = await pruneTarget(target, current.keepCount).catch(() => ({ removed: [], kept: 0 }))
      if (pruned.removed.length > 0) notes.push(`${pruned.removed.length} older archive(s) were removed to keep ${current.keepCount}.`)

      record.message = notes.join(' ')
      record.finishedAt = Date.now()
      record.durationMs = record.finishedAt - startedAt
      await appendRun(record)
      onNotice({
        kind: 'success',
        tone: 'success',
        title: 'Backup finished',
        message: `${record.files} file(s), ${humanBytes(record.bytes)}${record.encrypted ? ', encrypted' : ''}.`,
        id,
      })
      return record
    } catch (error) {
      record.ok = false
      const reason = error?.message ?? String(error)
      record.message = [reason, ...notes].filter((part) => typeof part === 'string' && part !== '').join(' ')
      record.finishedAt = Date.now()
      record.durationMs = record.finishedAt - startedAt
      await appendRun(record).catch(() => undefined)
      onNotice({ kind: 'error', tone: 'error', title: 'Backup failed', message: record.message, id })
      return record
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Fetch one run's archive, join and open it, and unpack it into a directory.
   *
   * Accepts either `{ runId, toDir }` or a bare run id string: the route layer
   * has passed both shapes over the life of this plugin, and refusing the plain
   * form would break a caller for no gain.
   *
   * @param request - `{ runId, toDir }` or a run id.
   * @returns `{ restored, toDir, entries }`.
   */
  async function restore(request = {}) {
    const asked = typeof request === 'string' ? { runId: request } : (request ?? {})
    const runId = typeof asked.runId === 'string' ? asked.runId.trim() : ''
    if (runId === '') throw new Error('Name the backup run to restore.')
    const entry = await findRun(runId)
    if (entry === undefined) throw new Error('That backup run is not in the history.')

    const current = config()
    const targetConfig = targetForRun(current, entry)
    const target = createTarget(targetConfig)
    const startedAt = Date.now()

    const destination = restoreRoot(asked.toDir, runId)
    const workDir = join(tmpdir(), `dsh-mydsh-restore-${process.pid}-${Date.now()}-${randomBytes(2).toString('hex')}`)
    await ensureDir(workDir)
    // The restore root is removed first so a second restore of the same run does
    // not merge into the leftovers of a failed first attempt; the path was proven
    // to be a *dedicated* root by `restoreRoot` before this line.
    await rm(destination, { recursive: true, force: true })
    await ensureDir(destination)

    const notes = []
    try {
      const listed = await target.list()
      const wanted = fileNamesFor(entry)
      const available = new Map(listed.map((item) => [item.name, item]))
      const present = wanted.filter((name) => available.has(name))
      if (present.length === 0) {
        throw new Error('No backup file for that run is present at the configured destination.')
      }
      if (present.length !== wanted.length) notes.push(`${wanted.length - present.length} of ${wanted.length} part(s) are missing at the destination; the restore may be incomplete.`)

      const downloaded = []
      for (const name of present) {
        const local = join(workDir, name)
        await target.get(name, local)
        downloaded.push({ name, path: local })
      }

      // Splitting happens after sealing and after archiving, so the join happens
      // in the reverse order: parts 鈫?sealed file 鈫?archive 鈫?files.
      let working = downloaded[0].path
      if (present.length > 1) {
        const ordered = sortParts(present.map((name) => name))
        const byName = new Map(downloaded.map((item) => [item.name, item.path]))
        const joined = join(workDir, `${runId}.joined`)
        await joinParts(ordered.map((name) => byName.get(name)), joined)
        working = joined
      }

      let archive = working
      const sealed = entry.encrypted === true && !working.toLowerCase().endsWith('.7z')
      if (sealed) {
        const password = current.encryption.password
        if (password === '') throw new Error('Enter the backup password before restoring.')
        archive = join(workDir, `${runId}.opened`)
        await decryptFile(working, archive, password)
      }

      const result = await extractArchive(archive, destination, {
        binary: binaryOf(),
        password: entry.encrypted === true && archive.toLowerCase().endsWith('.7z') ? current.encryption.password : undefined,
      })

      const names = await listArchive(archive).catch(() => [])
      const markers = restoreMarkers(names)
      for (const marker of markers) notes.push(marker)

      const restored = result.extracted
      const toDir = destination
      const record = {
        id: `restore-${stamp()}-${randomBytes(3).toString('hex')}`,
        kind: 'restore',
        runId,
        startedAt,
        finishedAt: Date.now(),
        ok: true,
        message: notes.join(' '),
        bytes: result.bytes,
        restored,
        toDir,
        targetId: targetConfig.id ?? '',
        targetKind: targetConfig.kind ?? 'local',
      }
      record.durationMs = record.finishedAt - record.startedAt
      await appendRun(record)
      return {
        restored,
        toDir,
        entries: names.sort(),
        bytes: result.bytes,
        message: notes.join(' '),
      }
    } catch (error) {
      const record = {
        id: `restore-${stamp()}-${randomBytes(3).toString('hex')}`,
        kind: 'restore',
        runId,
        startedAt,
        finishedAt: Date.now(),
        ok: false,
        message: error?.message ?? String(error),
        targetId: targetConfig.id ?? '',
        targetKind: targetConfig.kind ?? 'local',
      }
      record.durationMs = record.finishedAt - record.startedAt
      await appendRun(record).catch(() => undefined)
      throw error
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Delete one run's files at its destination.
   *
   * The audit record stays and gains a `deletedAt` marker: deleting an archive is
   * a data-loss action, and the history is the only place that can still say it
   * existed.
   *
   * @param request - `{ runId }`.
   * @returns `{ removed, run }`.
   */
  async function deleteRun(request = {}) {
    const runId = typeof request.runId === 'string' ? request.runId.trim() : ''
    if (runId === '') throw new Error('Name the backup run to delete.')
    const entry = await findRun(runId)
    if (entry === undefined) throw new Error('That backup run is not in the history.')
    if (entry.kind !== undefined && entry.kind !== 'backup') throw new Error('That record is not a backup run.')

    const current = config()
    const targetConfig = targetForRun(current, entry)
    const target = createTarget(targetConfig)
    const names = fileNamesFor(entry)
    const removed = []
    const failed = []
    for (const name of names) {
      try {
        await target.remove(name)
        removed.push(name)
      } catch (error) {
        failed.push(`${name}: ${error?.message ?? error}`)
      }
    }
    await target.remove(MANIFEST_NAME).catch(() => undefined)
    // Drop the destination baseline too: an incremental run must not diff against
    // an archive that no longer exists.
    await saveBaseline(targetConfig.id ?? 'local', {
      runId: '',
      at: Date.now(),
      type: 'none',
      files: 0,
      digests: {},
    }).catch(() => undefined)

    const updated = {
      ...entry,
      deletedAt: Date.now(),
      removedParts: removed.length,
      message: [entry.message ?? '', `${removed.length} file(s) deleted.`].filter(Boolean).join(' ').trim(),
    }
    const replaced = await replaceRun(updated)

    const record = {
      id: `delete-${stamp()}-${randomBytes(3).toString('hex')}`,
      kind: 'delete',
      runId,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      ok: failed.length === 0,
      message: failed.length === 0 ? `${removed.length} file(s) deleted.` : `Some files could not be deleted: ${failed.join('; ')}`,
      removed,
      targetId: targetConfig.id ?? '',
      targetKind: targetConfig.kind ?? 'local',
    }
    record.durationMs = 0
    await appendRun(record)
    return { removed, run: replaced ? updated : entry, runs: await runs() }
  }

  /**
   * Check one destination without touching the user's data.
   *
   * Accepts `{ target }` (a full target record), `{ targetId }`, or a bare
   * target record, and never throws: the settings page shows the result.
   *
   * @returns `{ ok, message, latencyMs }`.
   */
  async function testTarget(request = {}) {
    const started = Date.now()
    let targetConfig
    try {
      if (typeof request?.target === 'object' && request.target !== null) {
        targetConfig = request.target
      } else if (typeof request?.id === 'string' && typeof request?.kind === 'string') {
        targetConfig = request
      } else {
        targetConfig = resolveTarget(configuredTargets(config()), request?.targetId)
      }
      const target = createTarget(targetConfig)
      const answer = await target.probe()
      return {
        ok: answer.ok !== false,
        message: answer.message ?? '',
        latencyMs: Number(answer.latencyMs) || Date.now() - started,
      }
    } catch (error) {
      return { ok: false, message: error?.message ?? String(error), latencyMs: Date.now() - started }
    }
  }

  /**
   * Keep only the newest `keepCount` archives at one destination.
   *
   * Retention counts *archives*, not files: one backup can arrive as several
   * parts, and deleting a fragment while keeping its siblings would leave a
   * backup that cannot be restored. Only names this engine created are touched.
   *
   * @param request - `{ targetId, keepCount }`.
   * @returns `{ removed, kept }`.
   */
  async function prune(request = {}) {
    const startedAt = Date.now()
    const current = config()
    const targetConfig = resolveTarget(configuredTargets(current), request.targetId)
    const keepCount = Math.max(1, Number(request.keepCount) || current.keepCount)
    const target = createTarget(targetConfig)
    const started = Date.now()
    const outcome = await pruneTarget(target, keepCount)
    const record = {
      id: `prune-${stamp()}-${randomBytes(3).toString('hex')}`,
      kind: 'prune',
      startedAt,
      finishedAt: Date.now(),
      ok: true,
      keepCount,
      removed: outcome.removed,
      kept: outcome.kept,
      message: `${outcome.removed.length} archive(s) removed, ${outcome.kept} kept.`,
      targetId: targetConfig.id ?? '',
      targetKind: targetConfig.kind ?? 'local',
    }
    record.durationMs = record.finishedAt - record.startedAt
    await appendRun(record)
    return { removed: outcome.removed, kept: outcome.kept, keepCount }
  }

  /**
   * Cross-machine sync: read the destination's `manifest.json` index, compare it
   * with what this machine's ledger knows, and act on the direction.
   *
   * Conflict policy is applied per archive id, and every conflict is reported.
   * Silently overwriting one side is how a "sync" feature loses work, so the
   * default (`newer`) still names the loser in `conflicts`.
   *
   * @param request - optional `{ direction, conflict, targetId }`.
   * @returns `{ pulled, pushed, conflicts, skipped }`.
   */
  async function sync(request = {}) {
    if (syncing !== undefined) return syncing
    const task = performSync(request ?? {}).finally(() => {
      syncing = undefined
    })
    syncing = task
    return task
  }

  /** The real work of one sync. */
  async function performSync(request) {
    const current = config()
    const direction = ['both', 'push', 'pull'].includes(request.direction) ? request.direction : current.sync.direction
    const conflict = ['newer', 'local', 'remote'].includes(request.conflict) ? request.conflict : current.sync.conflict
    const targetConfig = resolveTarget(configuredTargets(current), request.targetId)
    const target = createTarget(targetConfig)
    const startedAt = Date.now()
    const pulled = []
    const pushed = []
    const conflicts = []
    const skipped = []
    const notices = []

    try {
      const remote = await readRemoteManifest(target)
      const remoteRuns = new Map((Array.isArray(remote?.runs) ? remote.runs : []).map((row) => [row.id, row]))
      const local = await recentRuns()
      const localRuns = new Map(local.filter((row) => row.kind === undefined || row.kind === 'backup').map((row) => [row.id, row]))

      const ids = new Set([...remoteRuns.keys(), ...localRuns.keys()])
      const workDir = join(tmpdir(), `dsh-mydsh-sync-${process.pid}-${Date.now()}`)
      await ensureDir(workDir)
      try {
        for (const id of ids) {
          const remoteRow = remoteRuns.get(id)
          const localRow = localRuns.get(id)
          const localState = localRow === undefined ? 'missing' : localRow.deletedAt !== undefined ? 'deleted' : 'present'
          const remoteState = remoteRow === undefined ? 'missing' : remoteRow.deletedAt !== undefined ? 'deleted' : 'present'

          if (localState === 'present' && remoteState === 'present') {
            skipped.push({ id, reason: 'both' })
            continue
          }
          if (localState === 'deleted' && remoteState === 'missing') {
            skipped.push({ id, reason: 'already-deleted' })
            continue
          }
          if (localState === 'present' && remoteState === 'missing') {
            // Push an archive the destination does not have.
            if (direction === 'pull') {
              skipped.push({ id, reason: 'direction-is-pull' })
              continue
            }
            const why = await pushRun(target, id, localRow, workDir)
            if (why === true) pushed.push({ id, bytes: localRow.bytes ?? 0 })
            else skipped.push({ id, reason: why })
            continue
          }
          if (localState === 'missing' && remoteState === 'present') {
            if (direction === 'push') {
              skipped.push({ id, reason: 'direction-is-push' })
              continue
            }
            const pulledRow = await pullRun(target, remoteRow, workDir)
            if (pulledRow !== undefined) pulled.push({ id, bytes: remoteRow.bytes ?? 0 })
            else skipped.push({ id, reason: 'parts-missing' })
            continue
          }

          // Anything else is a genuine divergence: one side deleted what the
          // other still has, or both sides changed it.
          const localAt = Number(localRow?.finishedAt ?? localRow?.startedAt ?? 0)
          const remoteAt = Number(remoteRow?.finishedAt ?? remoteRow?.startedAt ?? 0)
          const winner = conflict === 'local' ? 'local' : conflict === 'remote' ? 'remote' : remoteAt > localAt ? 'remote' : 'local'
          conflicts.push({
            id,
            localState,
            remoteState,
            localAt,
            remoteAt,
            winner,
            policy: conflict,
            message: `${winner === 'local' ? 'This machine' : 'The destination'} wins for ${id} (${localState} vs ${remoteState}).`,
          })
          notices.push({
            kind: 'conflict',
            tone: 'warn',
            title: 'Sync conflict',
            message: `${winner === 'local' ? 'This machine' : 'The destination'} was kept for ${id}.`,
          })
          if (winner === 'remote' && direction !== 'push') {
            const pulledRow = await pullRun(target, remoteRow, workDir)
            if (pulledRow !== undefined) pulled.push({ id, bytes: remoteRow.bytes ?? 0 })
          } else if (winner === 'local' && direction !== 'pull' && localRow !== undefined) {
            const why = await pushRun(target, id, localRow, workDir)
            if (why === true) pushed.push({ id, bytes: localRow.bytes ?? 0 })
            else skipped.push({ id, reason: why })
          }
        }
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      }

      for (const notice of notices) onNotice(notice)

      const record = {
        id: `sync-${stamp()}-${randomBytes(3).toString('hex')}`,
        kind: 'sync',
        startedAt,
        finishedAt: Date.now(),
        ok: true,
        direction,
        conflict,
        pulled: pulled.length,
        pushed: pushed.length,
        conflicts: conflicts.length,
        skipped: skipped.length,
        message: `pulled ${pulled.length}, pushed ${pushed.length}, conflicts ${conflicts.length}, skipped ${skipped.length}.`,
        targetId: targetConfig.id ?? '',
        targetKind: targetConfig.kind ?? 'local',
      }
      record.durationMs = record.finishedAt - record.startedAt
      await appendRun(record)
      return { pulled, pushed, conflicts, skipped, direction, conflict, targetId: targetConfig.id ?? '' }
    } catch (error) {
      const record = {
        id: `sync-${stamp()}-${randomBytes(3).toString('hex')}`,
        kind: 'sync',
        startedAt,
        finishedAt: Date.now(),
        ok: false,
        direction,
        conflict,
        message: error?.message ?? String(error),
        targetId: targetConfig.id ?? '',
        targetKind: targetConfig.kind ?? 'local',
      }
      record.durationMs = record.finishedAt - record.startedAt
      await appendRun(record).catch(() => undefined)
      throw error
    }
  }

  /** Push one archive this machine has but the destination does not. */
  async function pushRun(target, id, localRow, workDir) {
    const names = fileNamesFor(localRow)
    if (names.length === 0) return 'no-file-names'
    const listed = await target.list().catch(() => [])
    const remoteNames = new Set(listed.map((item) => item.name))
    if (names.every((name) => remoteNames.has(name))) return 'already-there'
    const localSource = await locateLocalArchive(localRow)
    if (localSource === undefined) return 'source-gone'
    for (const name of names) {
      if (remoteNames.has(name)) continue
      const staged = join(workDir, name)
      await copyFile(localSource.path, staged)
      await target.put(name, staged)
    }
    return true
  }

  /** Record a destination archive this machine's ledger does not have. */
  async function pullRun(target, remoteRow, workDir) {
    const names = Array.isArray(remoteRow.parts) ? remoteRow.parts.map((part) => part.name).filter(Boolean) : []
    if (names.length === 0) return undefined
    const listed = await target.list().catch(() => [])
    const remoteNames = new Set(listed.map((item) => item.name))
    if (!names.every((name) => remoteNames.has(name))) return undefined
    // Downloading every part would defeat the purpose: a sync is about the index,
    // and the bytes are already at the destination. Only the archive identity and
    // its metadata are recorded, so this machine knows it exists and where.
    void workDir
    const record = {
      id: remoteRow.id,
      kind: 'backup',
      startedAt: Number(remoteRow.startedAt) || Date.now(),
      finishedAt: Number(remoteRow.finishedAt) || Date.now(),
      type: remoteRow.type ?? 'full',
      items: Array.isArray(remoteRow.items) ? remoteRow.items : [],
      targetId: remoteRow.targetId ?? '',
      targetKind: remoteRow.targetKind ?? (remoteRow.kind ?? 'local'),
      target: remoteRow.target,
      parts: names.length,
      bytes: Number(remoteRow.bytes) || 0,
      rawBytes: 0,
      files: Number(remoteRow.files) || 0,
      encrypted: remoteRow.encrypted === true,
      compression: remoteRow.compression ?? 'zip-deflate',
      ok: true,
      message: 'Recorded from the destination index by sync.',
      path: names[0],
      partNames: names,
      incrementalBase: remoteRow.incrementalBase ?? null,
      skipped: 0,
      durationMs: 0,
      pulledAt: Date.now(),
    }
    const existing = await findRun(record.id)
    if (existing !== undefined) return record
    await appendRun(record)
    return record
  }

  /** Find a local archive file for a run, if this machine still has one. */
  async function locateLocalArchive(row) {
    if (typeof row?.path !== 'string' || row.path === '') return undefined
    // A local target's `path` is the absolute file; a remote target's is a URL and
    // is never a local source.
    if (!/^[a-zA-Z]:[\\/]/.test(row.path) && !row.path.startsWith('/')) return undefined
    const info = await stat(row.path).catch(() => undefined)
    if (info === undefined || !info.isFile()) return undefined
    return { path: row.path, bytes: info.size }
  }

  /**
   * Keep `keepCount` archives at a target and delete the rest of our own files.
   * @returns `{ removed, kept }`.
   */
  async function pruneTarget(target, keepCount) {
    const limit = Math.max(1, Number(keepCount) || 1)
    let listed
    try {
      listed = await target.list()
    } catch {
      // A destination that cannot be listed is left untouched rather than guessed
      // at: deleting the wrong file cannot be undone.
      return { removed: [], kept: 0 }
    }
    /** Group part files under the archive id they belong to. */
    const groups = new Map()
    for (const entry of listed) {
      if (typeof entry.name !== 'string') continue
      if (entry.name === MANIFEST_NAME) continue
      const base = baseNameOf(entry.name)
      if (!base.startsWith('dsh-mydsh-')) continue
      const list = groups.get(base) ?? []
      list.push(entry.name)
      groups.set(base, list)
    }
    const ordered = [...groups.keys()].sort()
    const drop = ordered.slice(0, Math.max(0, ordered.length - limit))
    const removed = []
    for (const key of drop) {
      for (const name of groups.get(key) ?? []) {
        try {
          await target.remove(name)
          removed.push(name)
        } catch {
          // A file that refuses to delete stays; retention is best effort.
        }
      }
    }
    return { removed, kept: Math.min(ordered.length, limit) }
  }

  /** Write the destination index so another machine can sync from it. */
  async function publishManifest(target, row) {
    const existing = await readRemoteManifest(target)
    const runs = Array.isArray(existing?.runs) ? existing.runs.slice() : []
    const filtered = runs.filter((entry) => entry?.id !== row.id)
    filtered.push(row)
    // The index keeps the newest 200 records, matching the local ledger cap, so a
    // long-lived destination does not grow an unbounded document.
    filtered.sort((left, right) => Number(left.at ?? 0) - Number(right.at ?? 0))
    const payload = {
      version: 2,
      machine: existing?.machine ?? `${process.platform}-${osHostname()}`,
      updatedAt: Date.now(),
      runs: filtered.slice(-200),
    }
    await target.putText(MANIFEST_NAME, `${JSON.stringify(payload, null, 2)}\n`)
  }

  /** Read the destination index, tolerating absence and damage. */
  async function readRemoteManifest(target) {
    let text
    try {
      text = await target.getText(MANIFEST_NAME)
    } catch {
      return undefined
    }
    if (typeof text !== 'string' || text.trim() === '') return undefined
    try {
      const parsed = JSON.parse(text)
      return parsed !== null && typeof parsed === 'object' ? parsed : undefined
    } catch {
      // A corrupt index is not a reason to fail: the archives themselves are the
      // data, and the index is rebuilt on the next successful run.
      return undefined
    }
  }

  return {
    isRunning: () => running !== undefined,
    runs,
    estimate,
    run,
    restore,
    deleteRun,
    testTarget,
    prune,
    sync,
    /** For the settings page: the file names a run is stored under. */
    partsOf: (row) => fileNamesFor(row),
  }
}

// --- module-level helpers ---------------------------------------------------

/** The host name, without importing `node:os` for one field at the top. */
function osHostname() {
  try {
    return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * The configured target list, with the local fallback V1 users already have.
 *
 * A document written before targets existed carries a single `backup.target`;
 * that shape is upgraded here so an upgrade does not silently stop backing up.
 */
function configuredTargets(current) {
  if (current.targets.length > 0) return current
  const legacy = current.settings?.backup?.target
  if (legacy !== undefined && legacy !== null) {
    const upgraded = { id: 'target-legacy', remotePath: 'dsh-mydsh', ...legacy }
    return { ...current, targets: [upgraded], activeTargetId: upgraded.id }
  }
  return current
}

/** The target a historic run was written to, falling back to the active one. */
function targetForRun(current, row) {
  const resolved = configuredTargets(current)
  const listed = resolved.targets
  if (listed.length === 0) throw new Error('No backup destination is configured yet.')
  if (typeof row?.targetId === 'string' && row.targetId !== '') {
    const found = listed.find((entry) => entry.id === row.targetId)
    if (found !== undefined) return found
  }
  // The id is gone from Settings: fall back only when the kind still matches, so a
  // restore cannot be attempted against a destination that never held the file.
  const active = listed.find((entry) => entry.id === resolved.activeTargetId) ?? listed[0]
  if (row?.targetKind !== undefined && row.targetKind !== active.kind) {
    throw new Error(
      `That backup was written to a ${row.targetKind} destination, which is no longer configured. Add it again to restore.`,
    )
  }
  return active
}

/** The file names a run is stored under, whether split or not. */
function fileNamesFor(row) {
  if (Array.isArray(row?.partNames) && row.partNames.length > 0) return row.partNames.filter(Boolean)
  if (typeof row?.path === 'string' && row.path !== '') {
    // A remote reference is a URL; only its last segment names the file.
    const name = row.path.split(/[\\/]/).pop() ?? ''
    if (name === '') return []
    const parts = Number(row.parts) || 1
    if (parts <= 1) return [name]
    // Reconstruct the part names from the first one, which already carries the
    // width the engine chose when it wrote them.
    return partNamesFrom(name, parts)
  }
  if (typeof row?.id === 'string' && row.id !== '') {
    const compression = row.compression === '7z' ? '7z' : 'zip'
    const extension = row.encrypted === true && row.compression !== '7z' ? `${compression}.dshmy` : compression
    return partNamesFrom(`${row.id}.${extension}`, Number(row.parts) || 1)
  }
  return []
}

/** Expand a first part name into the whole group. */
function partNamesFrom(first, count) {
  const total = Math.max(1, Math.trunc(count) || 1)
  const match = /\.part(\d+)$/i.exec(first) ?? /\.(\d{3,})$/.exec(first)
  if (match === null) {
    if (total === 1) return [first]
    // Legacy V1 split without an explicit part suffix: the first file kept its own
    // name and the rest were `.001`, `.002`, ... A run recorded that way is
    // reconstructed with the same convention.
    return [first, ...Array.from({ length: total - 1 }, (_, index) => `${first}.${String(index + 1).padStart(3, '0')}`)]
  }
  const digits = match[1].length
  const prefix = first.slice(0, first.length - match[0].length)
  return Array.from({ length: total }, (_, index) => `${prefix}.part${String(index + 1).padStart(Math.max(2, digits), '0')}`)
}

/** The archive id a stored file name belongs to. */
function baseNameOf(name) {
  const withoutPart = name.replace(/\.part\d+$/i, '').replace(/\.\d{3,}$/, '')
  return withoutPart.replace(/\.(zip|7z)(\.dshmy)?$/i, '')
}

/** The name a part should be delivered as, given the archive name. */
function measuringName(partPath, archiveName) {
  const name = partPath.split(/[\\/]/).pop() ?? archiveName
  if (name === archiveName) return archiveName
  const suffix = name.slice(archiveName.length)
  return `${archiveName}${suffix}`
}

/**
 * Apply the compression fallback, returning a note when it fired.
 * @returns `{ fallback, message }`.
 */
function chooseCompression(compression, binary) {
  if (compression !== '7z') return { fallback: false, message: '' }
  if (binary !== undefined) return { fallback: false, message: '' }
  return {
    fallback: true,
    message: 'The 7z binary is not available, so this run used zip-deflate instead.',
  }
}

/** Merge per-run item overrides over the configured switches. */
function normaliseItems(raw, fallback) {
  if (raw === undefined || raw === null || typeof raw !== 'object') return { ...fallback }
  const out = { ...fallback }
  for (const key of Object.keys(fallback)) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key]
  }
  return out
}

/**
 * Decide where a restore may unpack.
 *
 * Default is a dedicated directory per run. An explicit `toDir` is accepted only
 * when it is absolute and free of `..`; it is never allowed to be the user's home
 * or a profile directory itself, because a restore writes many files and the one
 * place it must not write is a live session or the running configuration.
 */
function restoreRoot(toDir, runId) {
  if (typeof toDir === 'string' && toDir.trim() !== '') {
    if (hasTraversal(toDir)) throw new Error('The restore folder must not contain ".." segments.')
    const absolute = assertSafeAbsolute(toDir.trim(), 'The restore folder')
    return absolute
  }
  return dataDir('restore', safeId(runId))
}

/** Report what an archive says about its own completeness. */
function restoreMarkers(names) {
  const notes = []
  if (names.length === 0) notes.push('The archive listing could not be read; the files were still extracted.')
  return notes
}

/** Read a small file's text, exported for route handlers that need it. */
export async function readRunText(path) {
  return readFile(path, 'utf8')
}
