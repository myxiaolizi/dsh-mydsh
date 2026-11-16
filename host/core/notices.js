/**
 * The notice ledger.
 *
 * Budget breaches, backup failures and discipline nudges all need to reach the
 * settings page, and none of them may be lost because the page happened to be
 * closed at the moment they fired. Notices are therefore appended to a small
 * JSONL file and drained on read: the page sees everything since its last poll,
 * including notices raised while it was not open.
 *
 * The ledger is capped so an unattended machine cannot grow it without bound.
 */

import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const MAX_ENTRIES = 500
const FILE = 'notices.jsonl'

/**
 * @param home - the plugin's data directory.
 * @returns `{ push, drain, peek }`.
 */
export function createNoticeLog(home) {
  const path = join(home, FILE)
  /** Recent entries kept in memory so repeated reads do not hit the disk. */
  let buffer = []
  let loaded = false
  let queued = 0

  const load = async () => {
    if (loaded) return
    loaded = true
    // Anything pushed before the first read is already newer than what is on
    // disk, and the append rides behind this read. Merging by id instead of
    // replacing the buffer is what keeps a notice raised during startup from
    // being swallowed by its own log file.
    const pending = buffer.slice()
    const seen = new Set(pending.map((entry) => entry.id))
    try {
      const text = await readFile(path, 'utf8')
      const rows = []
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed = JSON.parse(trimmed)
          if (!seen.has(parsed?.id)) rows.push(parsed)
        } catch {
          // A partially written trailing line is expected after a hard exit.
        }
      }
      buffer = rows.concat(pending).slice(-MAX_ENTRIES)
    } catch {
      buffer = pending
    }
  }

  /** Rewrite the ledger only when it has grown past the cap. */
  const compact = async () => {
    if (queued < MAX_ENTRIES) return
    queued = 0
    try {
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temp, buffer.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8')
      await rename(temp, path)
    } catch {
      // A ledger that cannot be compacted still holds its entries in memory.
    }
  }

  return {
    /** Record one notice. `tone` is `info`, `warn` or `error`. */
    push(notice) {
      const entry = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        at: Date.now(),
        tone: notice?.tone ?? 'info',
        title: notice?.title ?? '',
        message: notice?.message ?? '',
        href: notice?.href,
      }
      buffer.push(entry)
      if (buffer.length > MAX_ENTRIES) buffer = buffer.slice(-MAX_ENTRIES)
      queued += 1
      appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8').catch(() => undefined)
      compact().catch(() => undefined)
      return entry
    },

    /** Read and clear everything pending. */
    async drain() {
      await load()
      const out = buffer.slice()
      buffer = []
      try {
        await rm(path, { force: true })
        queued = 0
      } catch {
        // Leaving the file behind only replays the same notices once.
      }
      return out
    },

    /** Peek without clearing, for a page that redraws the same list. */
    async peek() {
      await load()
      return buffer.slice()
    },
  }
}
