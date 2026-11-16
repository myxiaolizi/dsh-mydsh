/**
 * Durable storage helpers: the plugin's own directory, atomic JSON files,
 * small JSONL ledgers, and DSH home discovery.
 */

import { mkdir, readFile, rename, rm, writeFile, appendFile, stat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** `<DSH_HOME>` as the running Host resolves it. */
export function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  if (configured !== undefined && configured !== '') return resolve(configured)
  return join(homedir(), '.dsh')
}

/** The plugin's private data directory (created on demand). */
export function dataDir(...parts) {
  return join(dshHome(), 'dsh-mydsh', ...parts)
}

/** Create a directory tree; resolves to the same path. */
export async function ensureDir(path) {
  await mkdir(path, { recursive: true })
  return path
}

/** Read a JSON file, returning `undefined` when it is absent or malformed. */
export async function readJson(path) {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Write JSON atomically: temp file in the same directory, then rename. */
export async function writeJsonAtomic(path, value) {
  await ensureDir(dirname(path))
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Append one JSON line to a ledger file. */
export async function appendJsonLine(path, value) {
  await ensureDir(dirname(path))
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}

/** Read a JSONL ledger, skipping malformed lines; absent file reads as empty. */
export async function readJsonLines(path, limit = Infinity) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // A partially written trailing line is expected after a hard exit.
    }
    if (out.length >= limit) break
  }
  return out
}

/** Rewrite a JSONL ledger, dropping entries the predicate rejects. */
export async function filterJsonLines(path, keep) {
  const entries = await readJsonLines(path)
  const kept = entries.filter(keep)
  if (kept.length === entries.length) return entries.length
  await ensureDir(dirname(path))
  const body = kept.map((entry) => `${JSON.stringify(entry)}\n`).join('')
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, body, 'utf8')
  await rename(temp, path)
  return kept.length
}

/** Size in bytes of a file, or 0 when it does not exist. */
export async function sizeOf(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

/** Entries of a directory, or an empty list when it does not exist. */
export async function listDir(path) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Remove a path, ignoring absence. */
export async function removeQuietly(path) {
  await rm(path, { recursive: true, force: true })
}

/** Copy a directory tree record-by-record without following symlinks out. */
export async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
