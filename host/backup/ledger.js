/**
 * The run ledger, the incremental baselines and the archive index.
 *
 * Three small durable stores live here, all of them under
 * `<DSH_HOME>/dsh-mydsh/backup/`:
 *
 * - `runs.jsonl` is the auditable record of every run, restore, delete, prune and
 *   sync. It is append-only in normal operation and trimmed to a fixed cap, so a
 *   long-lived installation cannot grow it without bound. A record is never
 *   removed because its archive is gone: the point of an audit trail is that
 *   deleting a backup leaves evidence that it existed.
 * - `baselines.json` holds, per target, the digest map of the last successful
 *   full or incremental run. An incremental run diffs against this; without it
 *   the run degrades to a full backup and says so.
 * - `index.json` mirrors what the engine believes is at each target. It is a
 *   cache, never the source of truth: `sync` and `restore` still ask the target.
 *
 * All writes go through a temp-file-then-rename dance, because the Host may be
 * killed at any moment and a half-written ledger would lose the history.
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { appendJsonLine, dataDir, ensureDir, readJsonLines } from '../core/store.js'

/** Ledger paths. Kept as functions because `DSH_HOME` is read at call time. */
export const ledgerPath = () => dataDir('backup', 'runs.jsonl')
export const baselinePath = () => dataDir('backup', 'baselines.json')
export const indexPath = () => dataDir('backup', 'index.json')

/** How many audit records are retained. */
export const MAX_RUNS = 200

/** Read every retained record, oldest first. */
export async function readRuns() {
  return readJsonLines(ledgerPath())
}

/** Read the retained records, newest first, capped. */
export async function recentRuns(limit = MAX_RUNS) {
  const all = await readRuns()
  return all.slice(-limit).reverse()
}

/**
 * Append one audit record and trim the ledger to its cap.
 *
 * The trim is done by rewriting the file rather than by rotating it, so the file
 * always holds a valid JSONL sequence with no dangling archive references: a
 * reader never has to reconcile two files to answer "what happened".
 *
 * @param record - the record to append.
 * @returns the retained records, newest first.
 */
export async function appendRun(record) {
  const path = ledgerPath()
  await ensureDir(dataDir('backup'))
  await appendJsonLine(path, record)
  const all = await readRuns()
  if (all.length > MAX_RUNS) {
    const kept = all.slice(-MAX_RUNS)
    const body = kept.map((entry) => `${JSON.stringify(entry)}\n`).join('')
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, body, 'utf8')
    await rename(temp, path)
    return kept.slice().reverse()
  }
  return all.slice().reverse()
}

/** Find one record by id, or `undefined`. */
export async function findRun(runId) {
  const all = await readRuns()
  for (let index = all.length - 1; index >= 0; index--) {
    if (all[index]?.id === runId) return all[index]
  }
  return undefined
}

/**
 * Rewrite one record in place.
 *
 * Used when a run is deleted: the archive goes away, the record stays and gains
 * a `deletedAt` marker. Callers must have the current copy, which is why this
 * takes the whole record rather than a patch.
 *
 * @param record - the record with its updated fields.
 * @returns true when the record was found and replaced.
 */
export async function replaceRun(record) {
  if (typeof record?.id !== 'string') return false
  const all = await readRuns()
  let replaced = false
  const next = all.map((entry) => {
    if (entry?.id !== record.id) return entry
    replaced = true
    return record
  })
  if (!replaced) return false
  const path = ledgerPath()
  const body = next.map((entry) => `${JSON.stringify(entry)}\n`).join('')
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, body, 'utf8')
  await rename(temp, path)
  return true
}

/** Read the baseline document, tolerating absence and damage. */
export async function readBaselines() {
  try {
    const text = await readFile(baselinePath(), 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Write the baseline document atomically. */
export async function writeBaselines(value) {
  const path = baselinePath()
  await ensureDir(dataDir('backup'))
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path).catch(async (error) => {
    await rm(temp, { force: true })
    throw error
  })
}

/**
 * Record the digest map of one successful run for a target.
 * @param targetId - the target whose baseline is being replaced.
 * @param record - `{ runId, at, type, files, digests }`.
 */
export async function saveBaseline(targetId, record) {
  const all = await readBaselines()
  const next = { ...all, [targetId]: record }
  await writeBaselines(next)
  return next
}

/** The baseline for one target, or `undefined`. */
export async function loadBaseline(targetId) {
  const all = await readBaselines()
  const found = all[targetId]
  if (found === null || typeof found !== 'object') return undefined
  if (found.digests === null || typeof found.digests !== 'object') return undefined
  return found
}

/** The archive index (a cache of what each target holds). */
export async function readIndex() {
  try {
    const text = await readFile(indexPath(), 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Write the archive index atomically. */
export async function writeIndex(value) {
  const path = indexPath()
  await ensureDir(dataDir('backup'))
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path).catch(async (error) => {
    await rm(temp, { force: true })
    throw error
  })
}
