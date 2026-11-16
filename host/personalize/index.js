/**
 * Personalize engine: identity, reply style, persona, long-lived instructions,
 * recalled long-term memory, and the three behaviour-discipline checks.
 *
 * This module owns the *personalization* half of what V1's `host/prompt`
 * contributed. Budget enforcement deliberately stayed behind: pausing work is a
 * usage-engine concern that needs the usage service, and burying it in a text
 * assembler would couple two unrelated failures.
 *
 * ASSEMBLY ORDER (fixed, see `prompt.js` for why):
 *   ① identity and address  → ② reply style  → ③ persona
 *   → ④ long-lived instructions → ⑤ recalled long-term memory
 *
 * Two registration paths, because scoping needs different information:
 *   - `registerPersonalizePrompt` registers one *global* section. The assembly
 *     context carries a scope key but no session directory, so a global section
 *     can only serve `scope: 'all'`. It returns `''` for workspace scoping.
 *   - `registerAgentPersonalize` registers the same section *name* on the
 *     agent's own context. A scoped section shadows the global one, so in `all`
 *     mode the two agree and nothing is duplicated, while workspace scoping gets
 *     access to the session's directory.
 *
 * Everything here degrades instead of throwing: a missing service, a malformed
 * settings document, or a missing memory module yields "emit nothing", never a
 * failed assembly or a broken turn.
 */

import { createDiscipline } from './discipline.js'
import { createMemoryStore, MEMORY_RECALL_DEFAULT } from './memory.js'
import { buildSections, composeText, estimateTokens, inScope } from './prompt.js'

export { estimateTokens, inScope, normalizeCwd, SECTION_KEYS, SECTION_TITLES, STYLE_RULES } from './prompt.js'
export { createMemoryStore, normalizeEntry, recencyFactor, scoreEntry, tokenize, workspaceMatches } from './memory.js'
export { canonicalArguments, claimsCompletion, createDiscipline, hasEvidence } from './discipline.js'

/** Prompt section name owned by this plugin. */
export const SECTION_NAME = 'mydsh-personalize'

/**
 * Section order. 900 places it after the harness's own guidance and before the
 * deployment persona suffix, which is where a user's personalization belongs:
 * last enough to override defaults, first enough that persona templates still
 * wrap it.
 */
const SECTION_ORDER = 900

/** Bound on the query text harvested from the conversation for recall. */
const QUERY_MAX_CHARS = 400

/**
 * Read the last user-authored text of a session, for recall scoring.
 *
 * A recall query has to come from somewhere, and the most recent thing the user
 * said is the only signal available at assembly time. It is read from the
 * model-visible surface (not the raw log) so a superseded attempt does not
 * drive what gets recalled.
 *
 * @param agent - live agent, or anything with a session.
 * @returns the text, or `''` when unavailable.
 */
export function lastUserText(agent) {
  try {
    const messages = agent?.session?.deriveMessages?.()
    if (!Array.isArray(messages)) return ''
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'user') continue
      // Discipline notices are user-role messages too; recalling against our own
      // nudge would feed the correction back into the retrieval query.
      if (message?.source?.kind !== 'user') continue
      const content = Array.isArray(message.content) ? message.content : []
      const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (text !== '') return text.slice(-QUERY_MAX_CHARS)
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * Create the personalization engine.
 *
 * @param options.ctx - plugin context; used only to read services that may be
 *   absent, never to register anything (registration is explicit below).
 * @param options.getSettings - synchronous settings reader.
 * @param options.dshHome - the plugin's data directory. Accepted for signature
 *   parity with the other engines; this engine writes nothing, because the
 *   settings document is the single durable copy of every personalization fact.
 * @param options.onMemoryChange - `(entries) => Promise<void> | void`, optional.
 *   Called after every memory mutation so the caller can persist through the
 *   settings store, which stays the only writer of the document.
 * @param options.now - clock, injectable for tests.
 */
export function createPersonalizeEngine({ ctx, getSettings, dshHome, onMemoryChange, now = () => Date.now() }) {
  void ctx
  void dshHome

  const memory = createMemoryStore({
    getSettings,
    commit: async (entries) => {
      if (typeof onMemoryChange !== 'function') return
      await onMemoryChange(entries)
    },
    now,
  })

  /** Read the personalization settings section, defensively. */
  function section() {
    return getSettings()?.personalize ?? undefined
  }

  /**
   * Whether a directory receives personalization at all.
   * @param cwd - session directory.
   */
  function active(cwd) {
    return inScope(section(), cwd)
  }

  /**
   * Recall the entries that would be injected for a directory.
   *
   * Pure: no counters are bumped and nothing is written, so `preview()` and a
   * real assembly always agree. `touch()` is a separate, explicit call.
   */
  function recalledFor(cwd, query, limit) {
    const config = section()
    if (config?.enabled !== true) return []
    if (config.memory?.enabled !== true || config.memory?.inject !== true) return []
    try {
      return memory.recall({ cwd, query, limit: limit ?? MEMORY_RECALL_DEFAULT })
    } catch {
      return []
    }
  }

  /**
   * Assemble the sections for one directory.
   * @param cwd - session directory.
   * @param options.query - recall query; defaults to no query.
   * @param options.limit - recall cap.
   * @returns the ordered, non-empty sections.
   */
  function sectionsFor(cwd, { query = '', limit } = {}) {
    try {
      if (!active(cwd)) return []
      return buildSections(section(), { recalled: recalledFor(cwd, query, limit) })
    } catch {
      return []
    }
  }

  /**
   * Preview what a session in `cwd` would receive.
   *
   * `active` answers "will anything be attached here", which is the question the
   * settings page actually asks when a user switches to workspace scoping and
   * wants to know whether this project is covered.
   *
   * @param options.cwd - session directory.
   * @param options.query - optional recall query.
   * @returns `{ text, tokens, active, sections }`.
   */
  function preview({ cwd, query = '', limit } = {}) {
    try {
      const sections = sectionsFor(cwd, { query, limit })
      const text = composeText(sections)
      return { text, tokens: estimateTokens(text), active: text !== '', sections }
    } catch {
      return { text: '', tokens: 0, active: false, sections: [] }
    }
  }

  /**
   * The full text for one directory.
   * @param cwd - session directory.
   * @param options.query - optional recall query.
   * @returns the assembled text, or `''` when nothing applies.
   */
  function textFor(cwd, { query = '', limit } = {}) {
    try {
      return composeText(sectionsFor(cwd, { query, limit }))
    } catch {
      return ''
    }
  }

  return { preview, textFor, memory, sectionsFor, active }
}

/**
 * Register the global personalization section.
 *
 * Registered even when personalization is off: the text function is cheap and
 * reads settings per assembly, so flipping the switch takes effect on the next
 * model step instead of on the next reload.
 *
 * @param ctx - plugin context; `systemPrompt` may be absent.
 * @param getSettings - synchronous settings reader.
 * @returns a disposer, or `undefined` when the service is absent.
 */
export function registerPersonalizePrompt(ctx, getSettings) {
  const systemPrompt = ctx?.get?.('systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return undefined
  return systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    interpolate: false,
    text: () => {
      try {
        const config = getSettings()?.personalize
        // Two reasons to contribute nothing here:
        //  - workspace scoping needs the session directory, which only the
        //    per-agent registration has;
        //  - memory recall needs the same directory, so a global section can
        //    only ever carry sections ①..④.
        // A scoped section with the same name shadows this one, so a session
        // that does have a directory gets the full five sections from there
        // rather than a duplicate.
        if (config?.enabled !== true) return ''
        if (config?.scope === 'workspaces') return ''
        return composeText(buildSections(config, { recalled: [] }))
      } catch {
        return ''
      }
    },
  })
}

/**
 * Register the per-agent personalization section, with memory recall.
 *
 * @param agent - a live agent from the `agent/created` listener.
 * @param getSettings - synchronous settings reader.
 * @param cwdOf - `(agent) => string | undefined`.
 * @returns a disposer for the agent's own registration, or `undefined`.
 */
export function registerAgentPersonalize(agent, getSettings, cwdOf) {
  const systemPrompt = agent?.ctx?.get?.('systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return undefined
  // One read-only store per registration, not per assembly: `recall` is a pure
  // function of settings, so rebuilding the facade on every step would allocate
  // for no gain. Nothing here mutates, so the caller's writer is not needed.
  const store = createMemoryStore({ getSettings })
  return systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    interpolate: false,
    text: () => {
      try {
        const config = getSettings()?.personalize
        if (config?.enabled !== true) return ''
        let cwd
        try {
          cwd = cwdOf(agent)
        } catch {
          cwd = undefined
        }
        if (!inScope(config, cwd)) return ''
        let recalled = []
        if (config.memory?.enabled === true && config.memory?.inject === true) {
          try {
            recalled = store.recall({ cwd, query: lastUserText(agent), limit: MEMORY_RECALL_DEFAULT })
          } catch {
            recalled = []
          }
        }
        return composeText(buildSections(config, { recalled }))
      } catch {
        return ''
      }
    },
  })
}

/**
 * Wire the behaviour-discipline listeners.
 *
 * Two events: `agent/turn-stopping` (serial, awaited before the boundary
 * commits — where a completion claim can still be answered) and `tools/result`
 * (emit, observation only — where a failing call becomes countable).
 *
 * @param ctx - plugin context.
 * @param getSettings - synchronous settings reader.
 * @param onNotice - `({ tone, title, message }) => void`, for the settings page.
 * @returns a disposer.
 */
export function registerDiscipline(ctx, getSettings, onNotice = () => undefined) {
  if (typeof ctx?.on !== 'function') return () => undefined
  const discipline = createDiscipline({ getSettings, onNotice })
  const offTurn = ctx.on('agent/turn-stopping', (payload) => {
    discipline.onTurnStopping(payload)
  })
  const offTool = ctx.on('tools/result', (exec, result) => {
    discipline.onToolResult(exec, result)
  })
  return () => {
    try {
      offTurn?.()
    } catch {
      // Disposal order during plugin unload is not guaranteed to be ours.
    }
    try {
      offTool?.()
    } catch {
      // Same.
    }
  }
}
