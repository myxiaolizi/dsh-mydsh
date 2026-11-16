/**
 * Path safety, bounded-concurrency traversal and naming helpers.
 *
 * Everything the backup engine writes is derived from two untrusted sources: a
 * directory listing of the user's home (which may hold odd names) and the member
 * names inside an archive (which may have been produced by any tool). Both are
 * normalised through this module before they touch the file system, so a crafted
 * `../..` member or a relative target can never escape the directory the caller
 * asked for.
 *
 * The walker yields instead of returning an array: a workspace with 200k files
 * would otherwise be materialised twice (once as file records, once as archive
 * entries), and the caller wants to stream the manifest straight into a writer.
 */

import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { listDir } from '../core/store.js'

/** True when the string is an absolute path on this platform. */
export function isPlainAbsolute(value) {
  return typeof value === 'string' && value !== '' && isAbsolute(value)
}

/**
 * True when a path contains a `..` segment.
 *
 * Checked on the raw text as well as after `resolve`: `resolve` would happily
 * collapse `a/../../b` into a legal path, which hides an attempt to walk out of
 * a directory instead of refusing it.
 */
export function hasTraversal(value) {
  if (typeof value !== 'string') return false
  return value.split(/[\\/]+/).some((segment) => segment === '..')
}

/** True when a path contains a NUL byte, which truncates native calls. */
function hasNul(value) {
  return typeof value === 'string' && value.includes('\u0000')
}

/**
 * Assert that a value is a usable absolute path we may write under.
 * @param value - candidate path.
 * @param label - name used in the error message.
 * @returns the resolved absolute path.
 */
export function assertSafeAbsolute(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is empty.`)
  }
  if (hasNul(value) || !isPlainAbsolute(value)) {
    throw new Error(`${label} must be an absolute path: ${value}`)
  }
  if (hasTraversal(value)) {
    throw new Error(`${label} must not contain ".." segments: ${value}`)
  }
  return resolve(value)
}

/** True when `candidate` is `root` or lies below it. */
export function inside(root, candidate) {
  const base = resolve(root)
  const target = resolve(candidate)
  if (target === base) return true
  const withSep = base.endsWith(sep) ? base : `${base}${sep}`
  if (process.platform === 'win32') {
    return target.toLowerCase().startsWith(withSep.toLowerCase())
  }
  return target.startsWith(withSep)
}

/**
 * Validate one archive member name and resolve it below `destinationRoot`.
 *
 * Rejects absolute names, drive letters, UNC paths, `..` segments, empty
 * segments and NUL bytes. The returned path is proven to be inside the root.
 *
 * @param destinationRoot - absolute extraction root.
 * @param memberName - name as stored in the archive, `/` separated.
 * @returns the absolute path to write.
 */
export function resolveMember(destinationRoot, memberName) {
  if (typeof memberName !== 'string' || memberName === '') {
    throw new Error('The archive contains an entry with an empty name.')
  }
  if (hasNul(memberName)) throw new Error('The archive contains an entry with a NUL byte in its name.')
  const normalised = memberName.replace(/\\/g, '/')
  if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised) || normalised.startsWith('//')) {
    throw new Error(`The archive contains an absolute entry name: ${memberName}`)
  }
  const segments = normalised.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) throw new Error(`The archive contains an unusable entry name: ${memberName}`)
  for (const segment of segments) {
    if (segment === '..') throw new Error(`The archive entry escapes the extraction folder: ${memberName}`)
    if (hasNul(segment)) throw new Error('The archive contains an entry with a NUL byte in its name.')
  }
  const target = resolve(destinationRoot, ...segments)
  if (!inside(destinationRoot, target)) {
    throw new Error(`The archive entry escapes the extraction folder: ${memberName}`)
  }
  return target
}

/**
 * Run `worker` over `items` with at most `limit` calls in flight, preserving
 * input order in the result.
 *
 * The traversal uses this for `stat` calls: on Windows a serial `stat` over a
 * large tree dominates the run time, while unbounded concurrency exhausts file
 * handles.
 */
export async function mapLimit(items, limit, worker) {
  if (items.length === 0) return []
  const width = Math.max(1, Math.min(items.length, Math.max(1, Math.trunc(limit) || 1)))
  const out = new Array(items.length)
  let cursor = 0
  const runners = new Array(width).fill(0).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      out[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return out
}

/**
 * Walk a directory tree and yield regular files.
 *
 * Directories are read in small batches (so `readdir` itself is concurrent) and
 * the `stat` calls for a batch run at the configured concurrency. Symlinks are
 * skipped rather than followed: a link into a network share or a cycle would
 * otherwise turn one backup into an unbounded copy.
 *
 * @param root - absolute directory to walk.
 * @param options - `skipDirs` (names), `maxEntries`, `maxDepth`, `concurrency`.
 * @yields `{ absolute, bytes, mtimeMs }` for each regular file.
 */
export async function* walkFiles(root, options = {}) {
  const skipDirs = options.skipDirs ?? new Set()
  const maxEntries = options.maxEntries ?? 200000
  const maxDepth = options.maxDepth ?? 32
  const concurrency = Math.min(8, Math.max(1, options.concurrency ?? 4))
  /** @type {{ dir: string, depth: number }[]} */
  const queue = [{ dir: root, depth: 0 }]
  let emitted = 0

  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency)
    const listings = await mapLimit(batch, concurrency, async (item) => ({
      item,
      entries: await listDir(item.dir),
    }))
    /** @type {string[]} */
    const files = []
    for (const { item, entries } of listings) {
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const full = join(item.dir, entry.name)
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) continue
          if (item.depth + 1 <= maxDepth) queue.push({ dir: full, depth: item.depth + 1 })
          continue
        }
        if (!entry.isFile()) continue
        files.push(full)
      }
    }
    const stats = await mapLimit(files, concurrency, async (absolute) => {
      try {
        const info = await stat(absolute)
        return { absolute, bytes: info.size, mtimeMs: info.mtimeMs }
      } catch {
        // A file that disappears mid-walk is simply not archived.
        return undefined
      }
    })
    for (const record of stats) {
      if (record === undefined) continue
      yield record
      emitted += 1
      if (emitted >= maxEntries) return
    }
  }
}

/** A file-name-safe timestamp usable in an archive name, in local time. */
export function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** Reduce an arbitrary id to something safe as a single directory name. */
export function safeId(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'unknown'
}

/** Short stable digest of `mtime:size`, used as the incremental baseline key. */
export function statDigest(mtimeMs, bytes) {
  return createHash('md5').update(`${Math.trunc(mtimeMs)}:${Math.trunc(bytes)}`).digest('hex').slice(0, 20)
}

/** Short stable digest of an in-memory payload (synthesised entries). */
export function contentDigest(buffer) {
  return createHash('md5').update(buffer).digest('hex').slice(0, 20)
}
