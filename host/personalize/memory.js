/**
 * Long-term memory: storage-free CRUD over an in-memory list, plus the
 * deterministic recall that decides which entries reach the prompt.
 *
 * WHY NO MODEL AND NO NETWORK
 * Recall runs on every assembly, which means every step of every turn. A call
 * to a model there would add latency, cost and nondeterminism to the one place
 * that must be reproducible: the same settings and the same directory must
 * always produce the same injected block, or `preview()` would disagree with
 * what a session actually received. So recall is a fixed scoring function —
 * keyword overlap, a recency decay, and a pinned bonus — that a reader can
 * recompute by hand.
 *
 * WHY THE STORE IS THE CALLER'S PROBLEM
 * `settings.personalize.memory.entries` is the durable copy and the settings
 * store owns persistence. This module keeps a live copy only so mutations are
 * visible immediately; the engine hands the resulting list back to the caller,
 * which writes it through the normal settings path. That keeps one writer for
 * the document and lets the settings page edit the same array it reads.
 *
 * WHY WORKSPACE ISOLATION IS A HARD FILTER
 * A memory that says "this repo uses pnpm" is wrong in every other repo. It is
 * filtered out before scoring, never down-weighted, because a low-ranked wrong
 * fact is still a wrong fact.
 */

/** Cap on one entry, matching the normalization contract. */
export const ENTRY_TEXT_MAX = 4000

/** Default number of recalled entries injected per assembly. */
export const MEMORY_RECALL_DEFAULT = 6

/** Characters ignored when tokenizing, so punctuation does not become a term. */
const SEPARATORS = /[^a-z0-9\u4e00-\u9fff\u3040-\u30ff]+/

/** Words carried by nearly every sentence; they score nothing. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'to', 'of', 'in', 'on', 'at', 'for',
  'with', 'without', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its',
  'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they', 'he', 'she', 'my', 'your', 'our', 'their',
  'do', 'does', 'did', 'done', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'not', 'no', 'yes', 'all', 'any', 'some', 'each', 'every', 'more', 'most', 'less', 'least', 'how', 'what',
  'when', 'where', 'which', 'who', 'why', 'use', 'using', 'used', 'get', 'got', 'make', 'made', 'need',
  '的', '了', '是', '在', '和', '与', '或', '就', '都', '也', '我', '你', '他', '她', '它', '这', '那',
  '们', '个', '有', '不', '要', '会', '把', '被', '为', '对', '到', '从', '以', '及', '等', '着', '过',
  '吗', '呢', '吧', '啊', '用', '做', '好', '一', '上', '下', '中',
])

/**
 * Split text into comparable terms.
 *
 * Latin words are lowercased whole; a CJK run is split into character bigrams
 * because Chinese has no spaces and whole-run matching would miss every partial
 * overlap. Single CJK characters fall back to themselves so a one-character
 * query still matches.
 * @param text - any user or memory text.
 * @returns a term array, possibly with duplicates (they carry TF weight).
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text === '') return []
  const normalized = text.toLowerCase()
  const out = []
  for (const chunk of normalized.split(SEPARATORS)) {
    if (chunk === '') continue
    if (STOPWORDS.has(chunk)) continue
    const isCjk = /[\u4e00-\u9fff\u3040-\u30ff]/.test(chunk)
    if (isCjk && chunk.length > 1) {
      for (let index = 0; index + 1 < chunk.length; index += 1) {
        const bigram = chunk.slice(index, index + 2)
        if (!STOPWORDS.has(bigram)) out.push(bigram)
      }
      continue
    }
    out.push(chunk)
  }
  return out
}

/** Term-frequency map for one text. */
function termCounts(text) {
  const counts = new Map()
  for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1)
  return counts
}

/** Days elapsed, never negative, for a stored millisecond timestamp. */
function ageInDays(at, now) {
  const value = typeof at === 'number' && Number.isFinite(at) ? at : now
  const days = (now - value) / 86400000
  return days > 0 ? days : 0
}

/**
 * Recency factor in `(0, 1]`: 1.0 today, 0.5 after the half-life.
 * @param at - entry timestamp in milliseconds.
 * @param now - reference time.
 * @param halfLifeDays - days until the factor halves.
 */
export function recencyFactor(at, now, halfLifeDays = 45) {
  return 0.5 ** (ageInDays(at, now) / halfLifeDays)
}

/**
 * Keyword score of one entry against a query, in `[0, 1)`.
 *
 * The denominator is the entry's own term budget, so a short entry that
 * matches one query term is not buried under a long entry that matches three
 * of its hundred. This is TF without IDF: with at most a few hundred entries,
 * an IDF table would drift every time an entry is added and break the
 * "recompute by hand" property.
 * @param entry - memory entry with `text`.
 * @param queryCounts - query term frequencies, or `null` for no query.
 * @returns a score in `[0, 1)`.
 */
export function keywordScore(entry, queryCounts) {
  const counts = termCounts(entry.text)
  if (counts.size === 0) return 0
  if (queryCounts === null || queryCounts.size === 0) return 0
  let matched = 0
  for (const [term, weight] of queryCounts) {
    const hit = counts.get(term)
    if (hit === undefined) continue
    // Saturation: repeating a term five times is not five times as relevant.
    matched += Math.log2(1 + Math.min(hit, 4)) * Math.log2(1 + Math.min(weight, 4))
  }
  return matched / (matched + Math.sqrt(counts.size) + 1)
}

/**
 * One entry's total recall score.
 *
 * Pinned entries get a bonus that lifts them above ordinary matches but cannot
 * beat an exact keyword hit, so pinning means "usually show this", not "always
 * show this in place of what was asked for".
 * @param entry - memory entry.
 * @param queryCounts - query term frequencies, or `null`.
 * @param now - reference time in milliseconds.
 * @returns a non-negative score.
 */
export function scoreEntry(entry, queryCounts, now) {
  const keywords = keywordScore(entry, queryCounts)
  const recency = recencyFactor(entry.at, now)
  const hits = typeof entry.hits === 'number' && entry.hits > 0 ? Math.log2(1 + entry.hits) * 0.02 : 0
  const pinned = entry.pinned === true ? 0.25 : 0
  return keywords + recency * 0.15 + hits + pinned
}

/**
 * Normalize a raw entry into the contract shape.
 * @param raw - candidate entry from settings or from an API call.
 * @param fallback - id used when the candidate carries none.
 * @param now - timestamp for an entry that carries none.
 * @returns a complete entry, or `undefined` when the text is empty.
 */
export function normalizeEntry(raw, fallback, now) {
  if (raw === null || typeof raw !== 'object') return undefined
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, ENTRY_TEXT_MAX) : ''
  if (text === '') return undefined
  return {
    id: typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim().slice(0, 64) : fallback,
    text,
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? Math.round(raw.at) : now,
    source: typeof raw.source === 'string' && raw.source.trim() !== '' ? raw.source.trim().slice(0, 32) : 'manual',
    workspace: typeof raw.workspace === 'string' ? raw.workspace.trim().slice(0, 1024) : '',
    pinned: raw.pinned === true,
    hits: typeof raw.hits === 'number' && Number.isFinite(raw.hits) && raw.hits > 0 ? Math.round(raw.hits) : 0,
  }
}

/** Path form used to compare an entry's workspace with a session directory. */
function comparablePath(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Whether an entry may be recalled into the given directory.
 *
 * An entry stored without a workspace is global and always eligible; one
 * stored with a workspace is eligible only inside it, including subdirectories
 * — the same rule personalization scope uses, so the two cannot disagree about
 * what "this workspace" means.
 * @param entry - memory entry.
 * @param cwd - session directory, may be `undefined`.
 * @returns whether the entry is eligible.
 */
export function workspaceMatches(entry, cwd) {
  const stored = comparablePath(entry.workspace)
  if (stored === '') return true
  const target = comparablePath(cwd)
  if (target === '') return false
  return target === stored || target.startsWith(`${stored}/`)
}

/**
 * Create the memory store facade.
 * @param options.getSettings - synchronous settings reader.
 * @param options.commit - `(entries) => Promise<void> | void`, called after
 *   every mutation so the caller can persist. Failures are swallowed because a
 *   failed persist must not lose the in-memory change the user just made.
 * @param options.now - clock, injectable for tests.
 */
export function createMemoryStore({ getSettings, commit, now = () => Date.now() }) {
  /** Monotonic counter so ids are unique even when two adds land in one ms. */
  let sequence = 0

  /** Read the current settings section, defensively. */
  function section() {
    const settings = getSettings()
    const memory = settings?.personalize?.memory
    return memory !== null && typeof memory === 'object' ? memory : { enabled: false, inject: false, maxEntries: 200, entries: [] }
  }

  /** The live entries, normalized and de-duplicated by id. */
  function entries() {
    const raw = Array.isArray(section().entries) ? section().entries : []
    const at = now()
    const seen = new Set()
    const out = []
    for (const candidate of raw) {
      const entry = normalizeEntry(candidate, `memory-${out.length + 1}`, at)
      if (entry === undefined) continue
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      out.push(entry)
    }
    return out
  }

  /** Persist a new list through the caller's writer. */
  async function save(next) {
    try {
      await commit(next)
    } catch {
      // The caller's writer is the settings store; a rejected write means the
      // document was reloaded underneath us. Keeping the in-memory list is
      // still the better outcome than throwing into an HTTP handler.
    }
    return next
  }

  /**
   * Trim a list to `maxEntries`.
   *
   * Eviction order is oldest non-pinned entry with the lowest hit count. Pinned
   * entries are only evicted when every other entry is pinned, and then also by
   * the same rule — a hard cap must hold, or the prompt grows without bound.
   * @param list - entries to trim.
   * @param max - the cap.
   * @returns the trimmed list, preserving the original order of survivors.
   */
  function trim(list, max) {
    const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 200
    if (list.length <= cap) return list
    const removable = list.filter((entry) => entry.pinned !== true)
    const pool = removable.length > 0 ? removable : list
    const ranked = [...pool].sort((left, right) => {
      if (left.hits !== right.hits) return left.hits - right.hits
      if (left.at !== right.at) return left.at - right.at
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    })
    const drop = new Set(ranked.slice(0, list.length - cap).map((entry) => entry.id))
    return list.filter((entry) => !drop.has(entry.id))
  }

  /**
   * List entries for the settings page.
   * @param options.q - substring filter over the entry text (case-insensitive).
   * @param options.scope - `'all'`, `'global'` (stored without a workspace), or
   *   a workspace path prefix.
   * @returns `{ entries, total }` with the newest first.
   */
  function list({ q, scope } = {}) {
    const query = typeof q === 'string' ? q.trim().toLowerCase() : ''
    const filter = typeof scope === 'string' ? scope.trim() : ''
    const all = entries()
    const matched = all.filter((entry) => {
      if (query !== '' && !entry.text.toLowerCase().includes(query)) return false
      if (filter === '' || filter === 'all') return true
      if (filter === 'global') return entry.workspace === ''
      return workspaceMatches({ workspace: entry.workspace }, filter) && entry.workspace !== ''
    })
    matched.sort((left, right) => right.at - left.at || (left.id < right.id ? -1 : 1))
    return { entries: matched, total: matched.length }
  }

  /**
   * Add one entry.
   * @param options.text - the fact to remember.
   * @param options.workspace - directory the fact belongs to; `''` means global.
   * @param options.source - who wrote it, e.g. `manual` or `session`.
   * @returns `{ entry, entries }`, or `{ entry: null, entries }` when the text
   *   is empty (an empty memory is a UI mistake, not an error worth a 500).
   */
  async function add({ text, workspace, source } = {}) {
    const current = entries()
    const body = typeof text === 'string' ? text.trim().slice(0, ENTRY_TEXT_MAX) : ''
    if (body === '') return { entry: null, entries: current }
    const at = now()
    sequence += 1
    const entry = normalizeEntry(
      { text: body, workspace, source, at, pinned: false, hits: 0 },
      `memory-${at.toString(36)}-${sequence.toString(36)}`,
      at,
    )
    // An entry that normalizes to nothing can only be one whose text is empty,
    // which the guard above already removed.
    const next = trim([...current, entry], section().maxEntries)
    const saved = await save(next)
    return { entry: saved.find((candidate) => candidate.id === entry.id) ?? null, entries: saved }
  }

  /**
   * Update one entry's text and/or pin state.
   * @param options.id - entry identity.
   * @param options.text - replacement text; omitted leaves it unchanged.
   * @param options.pinned - replacement pin state; omitted leaves it unchanged.
   * @returns `{ entry, entries }`; `entry` is `null` when no such id exists.
   */
  async function update({ id, text, pinned } = {}) {
    const current = entries()
    const index = current.findIndex((entry) => entry.id === id)
    if (index < 0) return { entry: null, entries: current }
    const existing = current[index]
    const body = typeof text === 'string' ? text.trim().slice(0, ENTRY_TEXT_MAX) : existing.text
    if (body === '') return { entry: null, entries: current }
    const next = [...current]
    next[index] = {
      ...existing,
      text: body,
      pinned: typeof pinned === 'boolean' ? pinned : existing.pinned,
    }
    const saved = await save(trim(next, section().maxEntries))
    return { entry: saved[index] ?? null, entries: saved }
  }

  /**
   * Remove one entry.
   * @param options.id - entry identity.
   * @returns `{ removed, entries }`.
   */
  async function remove({ id } = {}) {
    const current = entries()
    const next = current.filter((entry) => entry.id !== id)
    if (next.length === current.length) return { removed: 0, entries: current }
    const saved = await save(next)
    return { removed: 1, entries: saved }
  }

  /**
   * Clear entries by scope.
   *
   * `global` removes only entries stored without a workspace, a path removes
   * that workspace's entries, and anything else removes everything — the
   * settings page always sends an explicit scope, so the permissive default is
   * only reachable through a direct API call.
   * @param options.scope - `'all'`, `'global'`, or a workspace path.
   * @returns `{ removed, entries }`.
   */
  async function clear({ scope } = {}) {
    const current = entries()
    const filter = typeof scope === 'string' ? scope.trim() : 'all'
    let keep
    if (filter === '' || filter === 'all') keep = []
    else if (filter === 'global') keep = current.filter((entry) => entry.workspace !== '')
    else keep = current.filter((entry) => entry.workspace === '' || !workspaceMatches({ workspace: entry.workspace }, filter))
    const removed = current.length - keep.length
    if (removed === 0) return { removed: 0, entries: current }
    const saved = await save(keep)
    return { removed, entries: saved }
  }

  /**
   * Record one recall hit, so frequently useful entries rank higher next time.
   * @param options.id - entry identity.
   * @returns the accepted entries.
   */
  async function touch({ id } = {}) {
    const current = entries()
    const index = current.findIndex((entry) => entry.id === id)
    if (index < 0) return current
    const next = [...current]
    next[index] = { ...current[index], hits: current[index].hits + 1 }
    return save(next)
  }

  /**
   * Choose the entries to inject for one directory.
   *
   * Order: pinned entries first (a pin is the user saying "always tell the
   * model this"), then by score. Ties break on id so two runs over the same
   * data always produce the same block.
   * @param options.cwd - session directory.
   * @param options.query - optional text to score against; `''` means recency
   *   and pinning only, which is what a plain session start has.
   * @param options.limit - maximum entries returned.
   * @returns scored entries, each carrying its `score`.
   */
  function recall({ cwd, query, limit } = {}) {
    const config = section()
    if (config.enabled !== true) return []
    const at = now()
    const eligible = entries().filter((entry) => workspaceMatches(entry, cwd))
    if (eligible.length === 0) return []
    const queryCounts = typeof query === 'string' && query.trim() !== '' ? termCounts(query) : null
    const scored = eligible.map((entry) => ({ ...entry, score: scoreEntry(entry, queryCounts, at) }))
    scored.sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
      if (right.score !== left.score) return right.score - left.score
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    })
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MEMORY_RECALL_DEFAULT
    return scored.slice(0, cap)
  }

  return { list, add, update, remove, clear, touch, recall, entries }
}
