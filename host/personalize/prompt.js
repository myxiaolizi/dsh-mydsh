/**
 * Personalize prompt assembly: scope matching, the fixed five-section order,
 * and a deterministic token estimate.
 *
 * WHY THE ORDER IS FIXED AND NUMBERED
 * Five independent personalization inputs can contribute text, and they must
 * always appear in the same sequence:
 *   1. identity and address   (nickname / assistant name)
 *   2. reply style            (efficient / detailed / friendly / formal / concise)
 *   3. persona                (persona)
 *   4. long-lived instructions (instructions)
 *   5. recalled long-term memory
 * The order is structural, not the order the user happened to fill fields in:
 * a model that reads the same skeleton every session recognizes the block as
 * one thing; and a later section may legitimately narrow an earlier one (a
 * reply style sets the voice, a recalled memory may override a specific fact),
 * which only reads correctly when the narrower section comes last.
 *
 * The assembly is a pure function of the settings document plus a recalled
 * memory list, so `preview()` can show exactly what a session would receive
 * without touching a live agent, and the self-test can assert the order.
 */

/** Section keys in their fixed assembly order. Nothing else may be appended. */
export const SECTION_KEYS = Object.freeze(['identity', 'style', 'persona', 'instructions', 'memory'])

/** Markdown H2 titles, one per section, so the model can tell blocks apart. */
export const SECTION_TITLES = Object.freeze({
  identity: '身份与称呼',
  style: '回复风格',
  persona: '人设设定',
  instructions: '长期指令',
  memory: '长期记忆',
})

/**
 * One short behavioural constraint per style. Deliberately 1-2 sentences: a
 * style prompt that lists abstractions ("be professional, be helpful") is
 * noise the model already defaults to, and it dilutes the sections that carry
 * actual user content.
 */
export const STYLE_RULES = Object.freeze({
  efficient: '先给结论，再给必要的步骤；省略寒暄、铺垫和自我评价。',
  detailed: '先给结论，再补充依据、边界条件与验证方式；关键步骤写出具体命令或文件路径。',
  friendly: '语气亲切自然，用短句和日常说法；信息仍需准确，不用表情堆积情绪。',
  formal: '使用正式书面语，措辞严谨克制，避免口语、玩笑和情绪化表达。',
  concise: '能用一句说清就不写第二句，只保留结论与关键参数。',
})

/** Hard caps, so one long field cannot eat a session's context window. */
export const INSTRUCTIONS_MAX_CHARS = 12000
export const PERSONA_MAX_CHARS = 6000
export const MEMORY_SECTION_MAX_ENTRIES = 12
export const MEMORY_SECTION_MAX_CHARS = 2000

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/**
 * Normalize a filesystem path for scope comparison.
 *
 * Windows separates with `\`, compares case-insensitively, and may carry a
 * trailing separator; all three would otherwise make the same directory look
 * like two different workspaces.
 * @param value - path from settings or from a session header.
 * @returns a comparable form, or `''` when the input is not a usable path.
 */
export function normalizeCwd(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Whether one workspace entry covers the given directory.
 *
 * A subdirectory counts as inside the workspace, which is what a user means by
 * "only in this project": sessions started in `repo/pkg-a` belong to `repo`.
 * The comparison appends a separator so `repo` never covers `repo-other`.
 * @param cwd - normalized session directory.
 * @param workspace - raw workspace entry from settings.
 * @returns whether the entry covers the directory.
 */
export function coversDirectory(cwd, workspace) {
  const target = normalizeCwd(cwd)
  if (target === '') return false
  const candidate = normalizeCwd(workspace)
  if (candidate === '') return false
  return target === candidate || target.startsWith(`${candidate}/`)
}

/**
 * Whether personalization applies to one session directory.
 *
 * `scope: 'all'` applies everywhere; `scope: 'workspaces'` applies only inside
 * the listed directories, and an empty list therefore applies nowhere — that is
 * the honest reading of "quote these workspaces" with none chosen, and it keeps
 * a half-filled form from leaking into every session.
 * @param personalize - the normalized `personalize` settings section.
 * @param cwd - the session's directory, `undefined` for a global registration.
 * @returns `true` when a section should be emitted for this directory.
 */
export function inScope(personalize, cwd) {
  if (personalize === null || typeof personalize !== 'object') return false
  if (personalize.enabled !== true) return false
  if (personalize.scope !== 'workspaces') return true
  const list = Array.isArray(personalize.workspaces) ? personalize.workspaces : []
  return list.some((entry) => coversDirectory(cwd, entry))
}

/**
 * Estimate tokens without a tokenizer.
 *
 * A CJK character is close to one token; four latin characters are close to
 * one. That is wrong by a few percent in either direction, which is enough for
 * a preview figure and cheap enough to run on every assembly, whereas loading a
 * model-specific tokenizer for a number the user only glances at is not.
 * @param text - the assembled text.
 * @returns a positive integer, or 0 for empty input.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0
  let cjk = 0
  let other = 0
  for (const character of text) {
    if (CJK_CHAR.test(character)) cjk += 1
    else other += 1
  }
  return Math.max(1, Math.round(cjk + other / 4))
}

/** Trim one free-text field and clamp it to a hard character budget. */
function field(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '') return ''
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}\n（已截断，完整内容请在设置页查看）`
}

/** Section ①: how to address the user and what to call itself. */
function identityText(personalize) {
  const nickname = field(personalize.nickname, 64)
  const assistantName = field(personalize.assistantName, 64)
  if (nickname === '' && assistantName === '') return ''
  const lines = []
  if (nickname !== '') lines.push(`- 称呼用户：${nickname}`)
  if (assistantName !== '') lines.push(`- 你的名字：${assistantName}`)
  if (nickname !== '' && assistantName !== '') {
    lines.push(`- 回复中用「${assistantName}」自称，用「${nickname}」称呼用户。`)
  } else if (nickname !== '') {
    lines.push(`- 回复中用「${nickname}」称呼用户。`)
  } else {
    lines.push(`- 回复中用「${assistantName}」自称。`)
  }
  return lines.join('\n')
}

/** Section ②: the reply style, always present because it always has a value. */
function styleText(personalize) {
  const rule = STYLE_RULES[personalize.replyStyle] ?? STYLE_RULES.efficient
  return rule
}

/** Section ⑤: recalled memory lines, bounded in both count and characters. */
function memoryText(recalled) {
  if (!Array.isArray(recalled) || recalled.length === 0) return ''
  const lines = []
  let budget = MEMORY_SECTION_MAX_CHARS
  for (const entry of recalled.slice(0, MEMORY_SECTION_MAX_ENTRIES)) {
    const text = typeof entry?.text === 'string' ? entry.text.trim() : ''
    if (text === '') continue
    const line = `- ${entry.pinned === true ? '[置顶] ' : ''}${text}`
    if (line.length > budget) break
    budget -= line.length
    lines.push(line)
  }
  if (lines.length === 0) return ''
  // One lead sentence, because stale memory is the obvious failure mode: the
  // model must treat a contradiction as new information, not as a lie.
  return `以下条目由用户确认过，回答时优先遵守；与当前会话事实冲突时以新事实为准，并说明差异。\n${lines.join('\n')}`
}

/**
 * Build the ordered section list for one directory.
 * @param personalize - the normalized `personalize` settings section.
 * @param options.recalled - memory entries chosen for injection (already
 *   ordered and workspace-filtered by the memory module).
 * @returns `[{ key, title, text, tokens }]` in the fixed order, with empty
 *   sections omitted so the caller can render an accurate preview.
 */
export function buildSections(personalize, { recalled } = {}) {
  if (personalize === null || typeof personalize !== 'object') return []
  const bodies = {
    identity: identityText(personalize),
    style: styleText(personalize),
    persona: field(personalize.persona, PERSONA_MAX_CHARS),
    instructions: field(personalize.instructions, INSTRUCTIONS_MAX_CHARS),
    memory: memoryText(recalled),
  }
  const sections = []
  for (const key of SECTION_KEYS) {
    const text = bodies[key]
    if (typeof text !== 'string' || text === '') continue
    sections.push({ key, title: SECTION_TITLES[key], text, tokens: estimateTokens(text) })
  }
  return sections
}

/**
 * Join sections into the final section body.
 * @param sections - output of {@link buildSections}.
 * @returns the text to register, or `''` when nothing applies.
 */
export function composeText(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return ''
  return sections.map((section) => `## ${section.title}\n${section.text}`).join('\n\n')
}
