/**
 * Behaviour discipline: three independent checks that notice when a turn is
 * about to end on a claim nobody verified.
 *
 * WHY THESE THREE AND ONLY THESE THREE
 * A model fails a task in two honest ways and one dishonest way:
 *   - it says "done" having done nothing this step   -> antiFake
 *   - it says "done" with no artifact to point at    -> acceptance
 *   - it retries one identical failing call forever   -> loopGuard
 * Everything else a "discipline plugin" might nag about (tone, effort, commit
 * messages) has no objective trigger and would just burn context. Each check
 * here is decidable from data the harness already has: the tool-result stream
 * and the final assistant text.
 *
 * WHY `agent.inject` AND NOT A PROMPT REWRITE
 * `systemPrompt.section` text is computed per assembly and cached for the
 * step; rewriting it to carry a per-turn nudge would make the prompt differ
 * between a preview and the real request, and would survive into later turns
 * where the nudge is stale. `agent.inject` queues one identified message that
 * the model sees once, on the next step, and that then stays in the log where
 * the user can audit it. That is exactly the lifetime a correction should have.
 *
 * WHY THE NUDGE IS CAPPED PER TURN
 * An uncapped adviser becomes a second conversation partner: two stubborn
 * parties arguing instead of one working. `maxNudges` bounds how much of a turn
 * the discipline layer may spend on commentary, and the cap resets only when
 * the turn number advances — so a long multi-step turn cannot accumulate ten
 * small scoldings that together dwarf the actual work.
 */

import { randomUUID } from 'node:crypto'

/** Message source tag; the settings page and the session log both key on it. */
export const NOTICE_KIND = 'mydsh-discipline'

/** Completion claims, matched case-insensitively against the final text. */
const CLAIM_PATTERNS = [
  /(?:^|[\s，。；：:、])(?:已经|已)(?:全部|都)?(?:完成|搞定|做好|修复|解决|实现|处理)/,
  /(?:任务|工作|修改|改动|需求)(?:已经|已)?(?:完成|结束|收尾)/,
  /(?:完成|搞定|做好)了(?:[。！\s]|$)/,
  /(?:^|\n)\s*[-*]?\s*(?:完成|done)\s*[:：]/i,
  /\b(?:all done|task complete|completed successfully|finished|it works now)\b/i,
  /\b(?:i have|i've)\s+(?:completed|finished|implemented|fixed)\b/i,
  /\bdone\.?\s*$/im,
]

/**
 * Evidence markers inside the final text: a concrete path, a command, a quoted
 * output block, or an explicit exit code. Deliberately literal — a vague
 * "verified" is the failure mode, so only things a user could re-run or open
 * count.
 */
const EVIDENCE_PATTERNS = [
  /(?:[A-Za-z]:\\|\/)[\w.\-/\\ ]+\.\w{1,8}\b/, // absolute file path
  /(?:^|[\s(（`'"])[\w.\-]+(?:\/[\w.\-]+)*\.(?:js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|md|py|ps1|sh|css|html|txt|toml|lock)\b/, // relative file path
  /```[\s\S]{8,}?```/, // fenced command or output block
  /\bexit(?:\s*code|s)?\s*[:=]?\s*([0-9]|ok|success|非零)/i,
  /\b(?:npm|pnpm|yarn|node|python|pytest|jest|vitest|pnpm run|go test|cargo)\s+\S+/,
  /(?:测试|校验|验证|检查|运行|执行)结果|输出如下|通过\s*\d+\s*(?:项|个)|failed:\s*0|0\s*(?:errors?|failures?)/i,
]

/** How a claim is phrased per flavor: the same check, different pressure. */
const FLAVORS = Object.freeze({
  plain: { prefix: '', suffix: '' },
  coach: { prefix: '提醒一下：', suffix: '先把证据补齐，再下结论，事情会推进得更快。' },
  strict: { prefix: '注意：', suffix: '口头结论不算交付，请立刻补齐证据或收回结论。' },
  warm: { prefix: '别急，', suffix: '补一句证据就好，我不会怀疑你的判断。' },
})

/** Whether a flavor value is one we know; unknown falls back to `plain`. */
function flavorOf(config) {
  return FLAVORS[config?.flavor] ?? FLAVORS.plain
}

/**
 * Normalize free text to a comparable single line.
 * @param value - any model text.
 * @returns lowercase, whitespace-collapsed text.
 */
function flatten(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Extract the plain text of a message's content blocks.
 * @param message - a derived session message, or anything message-shaped.
 * @returns concatenated text, or `''`.
 */
export function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Whether a text claims the work is finished.
 * @param text - final assistant text.
 * @returns whether any claim pattern matched.
 */
export function claimsCompletion(text) {
  const flat = flatten(text)
  if (flat === '') return false
  return CLAIM_PATTERNS.some((pattern) => pattern.test(flat))
}

/**
 * Whether a text carries something a reader could verify independently.
 * @param text - final assistant text.
 * @returns whether any evidence pattern matched.
 */
export function hasEvidence(text) {
  if (typeof text !== 'string' || text.trim() === '') return false
  return EVIDENCE_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Canonical form of tool arguments.
 *
 * Key-sorted so `{a,b}` and `{b,a}` are the same call — the model reordering
 * JSON keys is not a change of strategy and must not reset the loop chain.
 * @param value - parsed arguments, or the raw string when parsing failed.
 * @returns a stable string.
 */
export function canonicalArguments(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(sortKeys(value))
  } catch {
    return String(value)
  }
}

/** Recursively sort object keys so stringification is order-independent. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
  return out
}

/** Head-truncate a long argument string for quoting back to the model. */
function previewArguments(canonical, cap = 240) {
  return canonical.length <= cap ? canonical : `${canonical.slice(0, cap)}…(+${canonical.length - cap})`
}

/** Build one injectable user message carrying a discipline notice. */
function noticeMessage(text, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    // `form: 'notice'` is the harness vocabulary for a one-off account of
    // something that just happened; it renders as an auditable row instead of
    // looking like something the user typed.
    source: { kind: NOTICE_KIND, form: 'notice', summary: summary.slice(0, 120) },
  }
}

/** Compose the anti-fake text for one flavor. */
function antiFakeText(config, detail) {
  const { prefix, suffix } = flavorOf(config)
  return [
    `${prefix}【防作弊检查】你在本步声称已经完成，但本步没有任何工具调用，也没有产生任何产物或可核对的结果。`,
    detail === '' ? '' : `你刚才的原话：${detail}`,
    '请二选一：',
    '1) 真的去做：调用需要的工具，把改动写进文件或跑出可核对的输出；',
    '2) 明确说明未完成的部分与你无法执行的限制，不要用「已完成」的措辞掩盖。',
    suffix,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/** Compose the acceptance text for one flavor. */
function acceptanceText(config, detail) {
  const { prefix, suffix } = flavorOf(config)
  return [
    `${prefix}【验收证据检查】你声明任务已完成，但最后一轮回复里没有可独立核对的证据。`,
    detail === '' ? '' : `你刚才的原话：${detail}`,
    '请补齐至少一项：',
    '1) 实际执行的命令与其输出（包含 exit code）；',
    '2) 改动后的文件路径（必要时给出关键行）；',
    '3) 如果确实无法验证，请直接写「未验证」并说明原因，不要用确认的语气。',
    suffix,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/** Compose the loop-guard text for one flavor. */
function loopGuardText(config, toolName, count, argumentsPreview) {
  const { prefix, suffix } = flavorOf(config)
  return [
    `${prefix}【重复失败检查】工具 \`${toolName}\` 已连续 ${count} 次用相同参数失败。`,
    `参数：${argumentsPreview}`,
    '继续用同样的调用只会得到同样的失败。请先读失败原因，再换一种做法：换参数、换工具、换路径，或者先诊断环境。',
    suffix,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * Create the discipline tracker.
 *
 * State is per agent and intentionally in memory only: a nudge budget is a
 * property of the turn currently running, and a Host restart mid-turn means the
 * turn is gone anyway.
 *
 * @param options.getSettings - synchronous settings reader.
 * @param options.onNotice - `({ tone, title, message }) => void`, optional.
 * @returns `{ onTurnStopping, onToolResult, stats }`.
 */
export function createDiscipline({ getSettings, onNotice = () => undefined }) {
  /** One record per agent; the key is the live agent object. */
  const states = new WeakMap()

  /** Read the discipline settings, defensively. */
  function config() {
    const settings = getSettings()
    const discipline = settings?.personalize?.discipline
    if (discipline === null || typeof discipline !== 'object') return undefined
    if (discipline.enabled !== true) return undefined
    return discipline
  }

  /** Fetch or create the per-agent record for the given turn. */
  function stateFor(agent, turn) {
    let state = states.get(agent)
    if (state === undefined) {
      state = freshState(Number.isFinite(turn) ? turn : null)
      states.set(agent, state)
      return state
    }
    // Reconcile with an authoritative turn number.
    //
    // Tool results carry no turn, so a record created by one has `turn: null`.
    // The first `turn-stopping` then supplies the real number — and that number
    // describes the turn the counters were *already* accumulated in, so it must
    // be adopted without resetting anything. Only a genuinely later turn starts
    // a fresh budget; anything else would let one turn collect a nudge per step
    // by re-adopting its own number.
    if (!Number.isFinite(turn)) return state
    if (state.turn === null) {
      state.turn = turn
      return state
    }
    if (turn > state.turn) Object.assign(state, freshState(turn))
    return state
  }

  /**
   * A blank record for one turn.
   *
   * `closed` marks "a turn-stopping already ran"; the first tool result after
   * that belongs to a new turn, and resetting there is what keeps `maxNudges`
   * a per-turn budget. Without it, a nudge spent in turn N would still count
   * against turn N+1 — because a tool result carries no turn number of its own.
   */
  function freshState(turn) {
    return {
      turn: Number.isFinite(turn) ? turn : null,
      closed: false,
      nudges: 0,
      toolCalls: 0,
      failures: 0,
      fired: new Set(),
      chain: { key: '', count: 0 },
      loopReported: false,
    }
  }

  /**
   * Inject one nudge if the turn still has budget.
   * @returns whether the nudge was delivered.
   */
  function nudge(agent, state, discipline, { key, text, title, tone, summary }) {
    if (state.nudges >= discipline.maxNudges) return false
    if (state.fired.has(key)) return false
    try {
      agent.inject(noticeMessage(text, summary))
    } catch {
      // An injectable agent can disappear between the event and this call
      // (turn cancelled, session disposed). A failed correction must never
      // surface as a turn error, so it is dropped.
      return false
    }
    state.nudges += 1
    state.fired.add(key)
    try {
      onNotice({ tone, title, message: summary })
    } catch {
      // The notice sink belongs to the settings page; a rendering failure
      // there must not affect the session.
    }
    return true
  }

  /**
   * Read the last assistant text of the current turn.
   *
   * Derived messages are the model-visible surface, which is what the claim was
   * actually made in. Reading the log directly would also see superseded
   * attempts that were replaced by a retry.
   */
  function lastAssistantText(agent) {
    try {
      const messages = agent?.session?.deriveMessages?.()
      if (!Array.isArray(messages)) return ''
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message?.role !== 'assistant') continue
        return messageText(message)
      }
      return ''
    } catch {
      return ''
    }
  }

  /**
   * Handle `agent/turn-stopping`.
   *
   * Runs synchronously: the event is awaited before the boundary commits, and a
   * slow listener would delay every turn end.
   */
  function onTurnStopping(payload) {
    try {
      const discipline = config()
      if (discipline === undefined) return
      const agent = payload?.agent
      if (agent === undefined || agent === null) return
      const state = stateFor(agent, payload?.turn)
      // Mark the boundary as passed before any early return: the next tool
      // result then belongs to the next turn and resets the nudge budget.
      state.closed = true
      const text = lastAssistantText(agent)
      if (text === '') return
      if (!claimsCompletion(text)) return
      const flat = flatten(text)
      const quote = flat.length <= 160 ? flat : `${flat.slice(0, 160)}…`

      // antiFake: a completion claim with nothing attempted this turn.
      if (discipline.antiFake === true && state.toolCalls === 0) {
        nudge(agent, state, discipline, {
          key: 'anti-fake',
          tone: 'warn',
          title: '纠偏：声称完成但没有动作',
          summary: '声称完成，本步没有任何工具调用',
          text: antiFakeText(discipline, quote),
        })
        return
      }

      // acceptance: work happened but nothing in the answer can be checked.
      if (discipline.acceptance === true && !hasEvidence(text)) {
        nudge(agent, state, discipline, {
          key: 'acceptance',
          tone: 'info',
          title: '验收：缺少可核对证据',
          summary: '任务声称完成，但未给出命令输出或文件路径',
          text: acceptanceText(discipline, quote),
        })
      }
    } catch {
      // Discipline is advisory. Any failure here is swallowed so a turn can
      // always close.
    }
  }

  /**
   * Handle `tools/result`.
   *
   * Observe-only: this listener never vetoes or rewrites a result, it only
   * counts what happened so the next step can be corrected.
   */
  function onToolResult(exec, result) {
    try {
      const discipline = config()
      if (discipline === undefined) return
      const agent = exec?.agent
      if (agent === undefined || agent === null) return
      // A tool result carries no turn number, so the only reliable turn signal
      // available here is "a tool ran after the previous boundary closed" —
      // which means the turn advanced. Without that reset the nudge budget and
      // the loop chain would bleed across turns.
      let state = stateFor(agent, undefined)
      if (state.closed === true) {
        state = freshState(state.turn === null ? null : state.turn + 1)
        states.set(agent, state)
      }
      state.toolCalls += 1
      const failed = result?.isError === true
      if (failed) state.failures += 1
      if (discipline.loopGuard !== true) return
      const canonical = canonicalArguments(exec?.arguments)
      const key = `${exec?.name ?? 'unknown'}\u0000${canonical}`
      if (state.chain.key === key) {
        state.chain.count = failed ? state.chain.count + 1 : 0
      } else {
        state.chain = { key, count: failed ? 1 : 0 }
      }
      // Three consecutive identical failures is the point where the model is
      // demonstrably not learning from the result it just read.
      if (state.chain.count < 3) return
      if (state.loopReported) return
      const delivered = nudge(agent, state, discipline, {
        key: 'loop-guard',
        tone: 'warn',
        title: '纠偏：同一调用重复失败',
        summary: `${exec?.name ?? 'tools'} 连续 ${state.chain.count} 次相同参数失败`,
        text: loopGuardText(discipline, exec?.name ?? 'unknown', state.chain.count, previewArguments(canonical)),
      })
      if (delivered) state.loopReported = true
    } catch {
      // Same rule as above: observation never breaks tool execution.
    }
  }

  /** Read-only snapshot for the settings page and the self-test. */
  function stats(agent) {
    const state = states.get(agent)
    if (state === undefined) return { turn: 0, nudges: 0, toolCalls: 0, failures: 0 }
    return {
      turn: state.turn,
      nudges: state.nudges,
      toolCalls: state.toolCalls,
      failures: state.failures,
      loopCount: state.chain.count,
      fired: [...state.fired],
    }
  }

  return { onTurnStopping, onToolResult, stats }
}
