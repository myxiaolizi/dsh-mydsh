/**
 * Self-test for the personalize engine.
 *
 * Run with the bundled runtime:
 *   node host/personalize/selftest.mjs
 *
 * It uses fake contexts and fake agents — nothing here touches DSH, a live
 * session, or the file system — so it can assert the parts that are easy to get
 * subtly wrong: scope matching on Windows paths, the fixed section order,
 * deterministic recall scoring and workspace isolation, the eviction rule, and
 * the per-turn nudge cap.
 *
 * Every case prints PASS/FAIL with the observed value; the process exits
 * non-zero if any case fails.
 */

import assert from 'node:assert/strict'

import { createPersonalizeEngine, registerAgentPersonalize, registerDiscipline, registerPersonalizePrompt } from '../../host/personalize/index.js'
import { normalize } from '../../host/core/settings.js'

let passed = 0
let failed = 0

/** Run one named case, printing its outcome. */
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error?.message ?? error}`)
  }
}

/** Run an async case with the same reporting. */
async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error?.message ?? error}`)
  }
}

/** Build a full settings document from a partial `personalize` patch. */
function settingsWith(personalizePatch) {
  return normalize({ personalize: personalizePatch })
}

/** A settings reader over one fixed document. */
function reader(document) {
  return () => document
}

/** A fake `ctx` that records `clipboard`-style registrations. */
function fakeCtx() {
  const calls = { on: [], sections: [] }
  const ctx = {
    get(name) {
      if (name !== 'systemPrompt') return undefined
      return {
        section(section) {
          calls.sections.push(section)
          return () => undefined
        },
      }
    },
    on(event, listener) {
      calls.on.push({ event, listener })
      return () => undefined
    },
  }
  return { ctx, calls }
}

/** A fake agent whose prompt API and inbox are recorded. */
function fakeAgent({ messages = [] } = {}) {
  const injected = []
  const sections = []
  const agent = {
    id: 'fake-session',
    injected,
    sections,
    inject(message) {
      injected.push(message)
    },
    session: {
      deriveMessages() {
        return messages
      },
    },
    ctx: {
      get(name) {
        if (name !== 'systemPrompt') return undefined
        return {
          section(section) {
            sections.push(section)
            return () => undefined
          },
        }
      },
    },
  }
  return agent
}

/** One synthesized assistant message carrying plain text. */
function assistantMessage(text) {
  return { id: `a-${text.length}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } }
}

/** One synthesized user message. */
function userMessage(text, kind = 'user') {
  return { id: `u-${text.length}`, role: 'user', content: [{ type: 'text', text }], source: { kind } }
}

// --- ① scope ---------------------------------------------------------------

test('scope=workspaces: cwd inside a listed workspace is active', () => {
  const settings = settingsWith({
    enabled: true,
    scope: 'workspaces',
    workspaces: ['C:\\Data\\DSH\\mydsh'],
    nickname: '磊哥',
    replyStyle: 'efficient',
  })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '' })
  const direct = engine.preview({ cwd: 'C:\\Data\\DSH\\mydsh' })
  const sub = engine.preview({ cwd: 'C:\\Data\\DSH\\mydsh\\APP\\code\\repo' })
  const separator = engine.preview({ cwd: 'C:/Data/DSH/mydsh/' })
  assert.equal(direct.active, true, 'exact cwd must be active')
  assert.equal(sub.active, true, 'subdirectory must be active')
  assert.equal(separator.active, true, 'slash form and trailing separator must normalize')
  console.log(`     exact=${direct.active} sub=${sub.active} slash=${separator.active}`)
})

test('scope=workspaces: cwd outside the list is inactive', () => {
  const settings = settingsWith({
    enabled: true,
    scope: 'workspaces',
    workspaces: ['C:\\Data\\DSH\\mydsh'],
    nickname: '磊哥',
  })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '' })
  const sibling = engine.preview({ cwd: 'C:\\Data\\DSH\\mydsh-other' })
  const outside = engine.preview({ cwd: 'C:\\Users\\郑磊\\Desktop' })
  const empty = engine.preview({ cwd: '' })
  assert.equal(sibling.active, false, 'a name-prefix sibling must not match')
  assert.equal(outside.active, false, 'unlisted directory must not match')
  assert.equal(empty.active, false, 'unknown cwd must not match')
  assert.equal(sibling.text, '', 'inactive preview must carry no text')
  console.log(`     sibling=${sibling.active} outside=${outside.active} empty=${empty.active}`)
})

test('scope=workspaces with an empty list never activates', () => {
  const settings = settingsWith({ enabled: true, scope: 'workspaces', workspaces: [], nickname: '磊哥' })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '' })
  assert.equal(engine.preview({ cwd: 'C:\\Data\\DSH\\mydsh' }).active, false)
})

test('scope=all ignores cwd', () => {
  const settings = settingsWith({ enabled: true, scope: 'all', nickname: '磊哥' })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '' })
  assert.equal(engine.preview({ cwd: undefined }).active, true)
  assert.equal(engine.preview({ cwd: 'C:\\anywhere' }).active, true)
})

test('global section stays empty under workspace scoping', () => {
  const settings = settingsWith({ enabled: true, scope: 'workspaces', workspaces: ['C:\\x'], nickname: '磊哥' })
  const { ctx, calls } = fakeCtx()
  registerPersonalizePrompt(ctx, reader(settings))
  assert.equal(calls.sections.length, 1, 'one global section must be registered')
  assert.equal(calls.sections[0].text(), '', 'workspace scoping must leave the global slot empty')
  assert.equal(calls.sections[0].name, 'mydsh-personalize')
  assert.equal(calls.sections[0].interpolate, false)
})

// --- ② ordering and composition -------------------------------------------

test('five sections assemble in the fixed order', () => {
  const settings = settingsWith({
    enabled: true,
    scope: 'all',
    nickname: '磊哥',
    assistantName: '小深',
    replyStyle: 'concise',
    persona: '你是一位严谨的 Windows 平台工程师。',
    instructions: '提交前必须跑一遍语法检查。',
    memory: {
      enabled: true,
      inject: true,
      maxEntries: 200,
      reviewBeforeWrite: false,
      entries: [
        { id: 'm1', text: '这个项目用 pnpm 管理依赖', at: Date.now(), workspace: '', pinned: true, hits: 2 },
      ],
    },
  })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '' })
  const preview = engine.preview({ cwd: 'C:\\Data\\DSH\\mydsh' })
  const keys = preview.sections.map((section) => section.key)
  assert.deepEqual(keys, ['identity', 'style', 'persona', 'instructions', 'memory'])
  const titles = preview.sections.map((section) => section.title)
  assert.deepEqual(titles, ['身份与称呼', '回复风格', '人设设定', '长期指令', '长期记忆'])
  // Each block must be an H2 heading so the model can segment them.
  for (const title of titles) assert.ok(preview.text.includes(`## ${title}\n`), `missing H2 for ${title}`)
  // Order in the rendered text, not only in the array.
  const positions = titles.map((title) => preview.text.indexOf(`## ${title}`))
  const sorted = [...positions].sort((left, right) => left - right)
  assert.deepEqual(positions, sorted, 'rendered order must match the declared order')
  assert.ok(preview.tokens > 0)
  console.log(`     order=${keys.join(' > ')} tokens=${preview.tokens}`)
})

test('disabled personalization yields the empty string', () => {
  const settings = settingsWith({ enabled: false, scope: 'all', nickname: '磊哥' })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '' })
  assert.equal(engine.textFor('C:\\x'), '')
  assert.equal(engine.preview({ cwd: 'C:\\x' }).active, false)
})

test('empty fields contribute no section', () => {
  const settings = settingsWith({ enabled: true, scope: 'all', nickname: '', persona: '', instructions: '' })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '' })
  const keys = engine.preview({ cwd: 'C:\\x' }).sections.map((section) => section.key)
  // Reply style always has a value, so only that section survives.
  assert.deepEqual(keys, ['style'])
})

test('every reply style maps to a short Chinese rule', () => {
  for (const style of ['efficient', 'detailed', 'friendly', 'formal', 'concise']) {
    const settings = settingsWith({ enabled: true, scope: 'all', replyStyle: style })
    const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '' })
    const section = engine.preview({ cwd: 'C:\\x' }).sections.find((entry) => entry.key === 'style')
    assert.ok(section !== undefined, `style ${style} must produce a section`)
    assert.ok(section.text.length > 4, `style ${style} rule must be non-trivial`)
    assert.ok(/[\u4e00-\u9fff]/.test(section.text), `style ${style} rule must be Chinese`)
  }
})

test('agent registration gives the full block including memory', () => {
  const settings = settingsWith({
    enabled: true,
    scope: 'all',
    nickname: '磊哥',
    instructions: '回复用简体中文。',
    memory: {
      enabled: true,
      inject: true,
      maxEntries: 200,
      entries: [{ id: 'm1', text: '偏好使用 V1/V2 版本目录', at: Date.now(), workspace: '', pinned: true, hits: 0 }],
    },
  })
  const agent = fakeAgent({ messages: [userMessage('版本目录怎么命名')] })
  const disposer = registerAgentPersonalize(agent, reader(settings), () => 'C:\\Data\\DSH\\mydsh')
  assert.equal(typeof disposer, 'function')
  assert.equal(agent.sections.length, 1)
  const text = agent.sections[0].text()
  assert.ok(text.includes('## 身份与称呼'), 'identity section missing')
  assert.ok(text.includes('## 长期记忆'), 'memory section missing')
  assert.ok(text.includes('V1/V2'), 'memory content missing')
})

test('preview is deterministic across repeated calls', () => {
  const settings = settingsWith({
    enabled: true,
    scope: 'all',
    nickname: '磊哥',
    replyStyle: 'formal',
    instructions: '先说结论。',
    memory: {
      enabled: true,
      maxEntries: 10,
      entries: [
        { id: 'm1', text: '项目偏好 pnpm', at: 1_700_000_000_000, pinned: false, hits: 1 },
        { id: 'm2', text: '项目使用 V2 契约', at: 1_700_000_100_000, pinned: true, hits: 0 },
      ],
    },
  })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '', now: () => 1_700_000_200_000 })
  assert.equal(engine.preview({ cwd: 'C:\\x' }).text, engine.preview({ cwd: 'C:\\x' }).text)
})

// --- ③ recall scoring and isolation ---------------------------------------

test('recall ranks a keyword match above an unrelated entry', () => {
  const now = 1_700_000_000_000
  const settings = settingsWith({
    enabled: true,
    memory: {
      enabled: true,
      maxEntries: 50,
      entries: [
        { id: 'pnpm', text: '这个仓库的包管理统一用 pnpm', at: now, workspace: '', pinned: false, hits: 0 },
        { id: 'color', text: '配色偏好深色主题', at: now, workspace: '', pinned: false, hits: 0 },
      ],
    },
  })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '', now: () => now })
  const hits = engine.memory.recall({ cwd: 'C:\\x', query: 'pnpm 装依赖失败', limit: 5 })
  assert.equal(hits[0].id, 'pnpm', 'the keyword match must rank first')
  assert.ok(hits[0].score > hits[1].score, 'score must order the results')
  console.log(`     order=${hits.map((entry) => `${entry.id}:${entry.score.toFixed(3)}`).join(' ')}`)
})

test('recall applies time decay', () => {
  const now = 1_700_000_000_000
  const day = 86_400_000
  const settings = settingsWith({
    enabled: true,
    memory: {
      enabled: true,
      maxEntries: 50,
      entries: [
        { id: 'fresh', text: '同一句事实', at: now, pinned: false, hits: 0 },
        { id: 'stale', text: '同一句事实', at: now - 400 * day, pinned: false, hits: 0 },
      ],
    },
  })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '', now: () => now })
  const hits = engine.memory.recall({ cwd: 'C:\\x', limit: 5 })
  assert.equal(hits[0].id, 'fresh', 'the newer entry must win at equal text')
  assert.ok(hits[0].score > hits[1].score)
  console.log(`     fresh=${hits[0].score.toFixed(3)} stale=${hits[1].score.toFixed(3)}`)
})

test('pinned entries outrank unpinned ones at equal text', () => {
  const now = 1_700_000_000_000
  const settings = settingsWith({
    enabled: true,
    memory: {
      enabled: true,
      maxEntries: 50,
      entries: [
        { id: 'plain', text: '提交前跑语法检查', at: now, pinned: false, hits: 0 },
        { id: 'pinned', text: '提交前跑语法检查', at: now, pinned: true, hits: 0 },
      ],
    },
  })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '', now: () => now })
  const hits = engine.memory.recall({ cwd: 'C:\\x', query: '语法检查', limit: 5 })
  assert.equal(hits[0].id, 'pinned')
})

test('recall isolates by workspace and keeps subdirectories', () => {
  const now = 1_700_000_000_000
  const settings = settingsWith({
    enabled: true,
    memory: {
      enabled: true,
      maxEntries: 50,
      entries: [
        { id: 'global', text: '回答用简体中文', at: now, workspace: '', pinned: false, hits: 0 },
        { id: 'proj', text: '本项目用 pnpm', at: now, workspace: 'C:\\Data\\DSH\\mydsh', pinned: false, hits: 0 },
        { id: 'other', text: '另一个项目用 yarn', at: now, workspace: 'C:\\Data\\Other', pinned: false, hits: 0 },
      ],
    },
  })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '', now: () => now })
  const inside = engine.memory.recall({ cwd: 'C:\\Data\\DSH\\mydsh\\APP', limit: 10 }).map((entry) => entry.id)
  const outside = engine.memory.recall({ cwd: 'C:\\Data\\Other', limit: 10 }).map((entry) => entry.id)
  assert.ok(inside.includes('global'), 'a workspace-less entry must be recalled everywhere')
  assert.ok(inside.includes('proj'), 'subdirectory must see the workspace entry')
  assert.ok(!inside.includes('other'), 'another workspace entry must not leak in')
  assert.ok(outside.includes('other'))
  assert.ok(!outside.includes('proj'), 'the project entry must not leak out')
  console.log(`     inside=${inside.join(',')} outside=${outside.join(',')}`)
})

test('recall returns nothing when memory is disabled', () => {
  const settings = settingsWith({ enabled: true, memory: { enabled: false, entries: [{ id: 'x', text: 'a', at: 1 }] } })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '' })
  assert.deepEqual(engine.memory.recall({ cwd: 'C:\\x' }), [])
})

test('recall never mutates the hit counter', () => {
  const now = 1_700_000_000_000
  const settings = settingsWith({
    enabled: true,
    memory: { enabled: true, maxEntries: 50, entries: [{ id: 'a', text: '记忆', at: now, hits: 0 }] },
  })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '', now: () => now })
  engine.memory.recall({ cwd: 'C:\\x' })
  engine.memory.recall({ cwd: 'C:\\x' })
  assert.equal(engine.memory.recall({ cwd: 'C:\\x' })[0].hits, 0, 'recall must be a pure read')
})

// --- ④ maxEntries trimming ------------------------------------------------

await testAsync('maxEntries evicts the oldest low-hit non-pinned entry', async () => {
  const base = 1_700_000_000_000
  const entries = [
    { id: 'keep-pinned', text: '置顶事实', at: base, pinned: true, hits: 0 },
    { id: 'old-cold', text: '最旧最冷', at: base + 1, pinned: false, hits: 0 },
    { id: 'new-warm', text: '较新较热', at: base + 3, pinned: false, hits: 5 },
    { id: 'new-cold', text: '较新较冷', at: base + 2, pinned: false, hits: 0 },
  ]
  let current = settingsWith({ enabled: true, memory: { enabled: true, maxEntries: 3, entries } })
  let written
  const engine = createPersonalizeEngine({
    getSettings: () => current,
    dshHome: '',
    now: () => base + 10,
    onMemoryChange: async (next) => {
      written = next
      current = normalize({ ...current, personalize: { ...current.personalize, memory: { ...current.personalize.memory, entries: next } } })
    },
  })
  const result = await engine.memory.add({ text: '一条新记忆', source: 'selftest' })
  const ids = result.entries.map((entry) => entry.id)
  assert.equal(result.entries.length, 3, `cap must be 3, got ${result.entries.length}`)
  assert.ok(ids.includes('keep-pinned'), 'pinned entry must survive')
  assert.ok(!ids.includes('old-cold'), 'the oldest zero-hit entry must be evicted first')
  assert.ok(ids.includes('new-warm'), 'a high-hit entry must survive')
  assert.ok(written !== undefined, 'the caller must be asked to persist')
  console.log(`     kept=${ids.join(',')} evicted=old-cold total=${result.entries.length}`)
})

await testAsync('maxEntries still holds when every entry is pinned', async () => {
  const base = 1_700_000_000_000
  const entries = [
    { id: 'p1', text: '一', at: base, pinned: true, hits: 0 },
    { id: 'p2', text: '二', at: base + 1, pinned: true, hits: 4 },
  ]
  let current = settingsWith({ enabled: true, memory: { enabled: true, maxEntries: 2, entries } })
  const engine = createPersonalizeEngine({
    getSettings: () => current,
    dshHome: '',
    now: () => base + 10,
    onMemoryChange: async (next) => {
      current = normalize({ ...current, personalize: { ...current.personalize, memory: { ...current.personalize.memory, entries: next } } })
    },
  })
  const result = await engine.memory.add({ text: '三' })
  assert.equal(result.entries.length, 2, 'the hard cap must hold even when all entries are pinned')
  const ids = result.entries.map((entry) => entry.id)
  assert.ok(ids.includes('p2'), 'the higher-hit pinned entry must be kept')
  console.log(`     kept=${ids.join(',')}`)
})

await testAsync('memory CRUD: add, update, pin, touch, remove, clear', async () => {
  let current = settingsWith({ enabled: true, memory: { enabled: true, maxEntries: 20, entries: [] } })
  const engine = createPersonalizeEngine({
    getSettings: () => current,
    dshHome: '',
    onMemoryChange: async (next) => {
      current = normalize({ ...current, personalize: { ...current.personalize, memory: { ...current.personalize.memory, entries: next } } })
    },
  })
  const added = await engine.memory.add({ text: '记住这条', workspace: 'C:\\Data\\DSH\\mydsh', source: 'selftest' })
  assert.equal(added.entries.length, 1)
  const id = added.entry.id
  await engine.memory.update({ id, text: '记住改过的那条', pinned: true })
  let listed = engine.memory.list({})
  assert.equal(listed.entries[0].text, '记住改过的那条')
  assert.equal(listed.entries[0].pinned, true)
  await engine.memory.touch({ id })
  listed = engine.memory.list({})
  assert.equal(listed.entries[0].hits, 1, 'touch must bump the hit counter')
  const filtered = engine.memory.list({ q: '改过' })
  assert.equal(filtered.total, 1, 'the text filter must match')
  assert.equal(engine.memory.list({ q: '不存在的词' }).total, 0)
  const removed = await engine.memory.remove({ id })
  assert.equal(removed.removed, 1)
  const addedAgain = await engine.memory.add({ text: '清空前的一条' })
  assert.equal(addedAgain.entries.length, 1)
  const cleared = await engine.memory.clear({ scope: 'all' })
  assert.equal(cleared.removed, 1)
  assert.equal(cleared.entries.length, 0)
})

await testAsync('clear with scope=global keeps workspace entries', async () => {
  let current = settingsWith({
    enabled: true,
    memory: {
      enabled: true,
      maxEntries: 20,
      entries: [
        { id: 'g', text: '全局', at: 1, workspace: '', pinned: false, hits: 0 },
        { id: 'w', text: '工作区', at: 2, workspace: 'C:\\Data\\DSH\\mydsh', pinned: false, hits: 0 },
      ],
    },
  })
  const engine = createPersonalizeEngine({
    getSettings: () => current,
    dshHome: '',
    onMemoryChange: async (next) => {
      current = normalize({ ...current, personalize: { ...current.personalize, memory: { ...current.personalize.memory, entries: next } } })
    },
  })
  const result = await engine.memory.clear({ scope: 'global' })
  assert.equal(result.removed, 1)
  assert.deepEqual(result.entries.map((entry) => entry.id), ['w'])
})

// --- ⑤ discipline ---------------------------------------------------------

test('discipline registers both listeners and honours the per-turn cap', () => {
  const settings = settingsWith({
    enabled: true,
    discipline: { enabled: true, flavor: 'plain', antiFake: true, acceptance: true, loopGuard: true, maxNudges: 1 },
  })
  const notices = []
  const { ctx, calls } = fakeCtx()
  registerDiscipline(ctx, () => settings, (notice) => notices.push(notice))
  assert.equal(calls.on.length, 2)
  assert.deepEqual(calls.on.map((entry) => entry.event).sort(), ['agent/turn-stopping', 'tools/result'])

  const agent = fakeAgent({ messages: [assistantMessage('已经完成，全部搞定。')] })
  const turnStopping = calls.on.find((entry) => entry.event === 'agent/turn-stopping').listener
  const toolResult = calls.on.find((entry) => entry.event === 'tools/result').listener

  // A failing identical call, three times, must fire the loop guard once.
  for (let index = 0; index < 3; index += 1) {
    toolResult({ agent, name: 'pwsh', arguments: { command: 'node --check x.js' } }, { isError: true })
  }
  assert.equal(agent.injected.length, 1, `loop guard must fire exactly once, got ${agent.injected.length}`)
  assert.ok(agent.injected[0].content[0].text.includes('重复失败'))

  // maxNudges = 1 means the next correction in this turn is suppressed.
  turnStopping({ agent, turn: 1 })
  assert.equal(agent.injected.length, 1, 'the cap must suppress the second nudge in one turn')
  assert.equal(notices.length, 1, 'the notice sink must have seen exactly one nudge')
  console.log(`     injected=${agent.injected.length} notices=${notices.length}`)
})

test('discipline resets its budget on the next turn', () => {
  const settings = settingsWith({
    enabled: true,
    discipline: { enabled: true, flavor: 'plain', antiFake: true, acceptance: true, loopGuard: true, maxNudges: 1 },
  })
  const { ctx, calls } = fakeCtx()
  registerDiscipline(ctx, () => settings)
  const agent = fakeAgent({ messages: [assistantMessage('已修复该问题。')] })
  const turnStopping = calls.on.find((entry) => entry.event === 'agent/turn-stopping').listener
  const toolResult = calls.on.find((entry) => entry.event === 'tools/result').listener
  turnStopping({ agent, turn: 1 })
  assert.equal(agent.injected.length, 1, 'turn 1 must be nudged')
  // A tool result after the boundary belongs to turn 2 and clears the budget.
  toolResult({ agent, name: 'read', arguments: {} }, { isError: false })
  turnStopping({ agent, turn: 2 })
  assert.equal(agent.injected.length, 2, 'turn 2 must get its own nudge budget')
  console.log(`     turn1+turn2=${agent.injected.length}`)
})

test('antiFake fires only when a claim has no tool call behind it', () => {
  const settings = settingsWith({
    enabled: true,
    discipline: { enabled: true, flavor: 'strict', antiFake: true, acceptance: false, loopGuard: false, maxNudges: 3 },
  })
  const { ctx, calls } = fakeCtx()
  registerDiscipline(ctx, () => settings)
  const turnStopping = calls.on.find((entry) => entry.event === 'agent/turn-stopping').listener
  const toolResult = calls.on.find((entry) => entry.event === 'tools/result').listener

  const claimOnly = fakeAgent({ messages: [assistantMessage('已经完成，全部搞定。')] })
  turnStopping({ agent: claimOnly, turn: 1 })
  assert.equal(claimOnly.injected.length, 1, 'a bare claim must be caught')
  assert.ok(claimOnly.injected[0].content[0].text.includes('防作弊'))

  const withWork = fakeAgent({ messages: [assistantMessage('已经完成，全部搞定。')] })
  toolResult({ agent: withWork, name: 'write', arguments: { path: 'a.js' } }, { isError: false })
  turnStopping({ agent: withWork, turn: 1 })
  assert.equal(withWork.injected.length, 0, 'a claim backed by a tool call must not be flagged as fake')

  const noClaim = fakeAgent({ messages: [assistantMessage('我检查了三个文件，未发现相关问题。')] })
  turnStopping({ agent: noClaim, turn: 1 })
  assert.equal(noClaim.injected.length, 0, 'a non-claim must not be nudged')
})

test('acceptance fires when a claim carries no verifiable evidence', () => {
  const settings = settingsWith({
    enabled: true,
    discipline: { enabled: true, flavor: 'coach', antiFake: true, acceptance: true, loopGuard: false, maxNudges: 3 },
  })
  const { ctx, calls } = fakeCtx()
  registerDiscipline(ctx, () => settings)
  const turnStopping = calls.on.find((entry) => entry.event === 'agent/turn-stopping').listener
  const toolResult = calls.on.find((entry) => entry.event === 'tools/result').listener

  const vague = fakeAgent({ messages: [assistantMessage('已经完成，测试也都通过了。')] })
  toolResult({ agent: vague, name: 'write', arguments: {} }, { isError: false })
  turnStopping({ agent: vague, turn: 1 })
  assert.equal(vague.injected.length, 1, 'a claim without evidence must be flagged')
  assert.ok(vague.injected[0].content[0].text.includes('验收证据'))

  const evidenced = fakeAgent({
    messages: [assistantMessage('已经完成。\n\n```\n> node --check index.js\n[exit code: 0]\n```\n改动文件：APP/code/dsh-mydsh/index.js')],
  })
  toolResult({ agent: evidenced, name: 'write', arguments: {} }, { isError: false })
  turnStopping({ agent: evidenced, turn: 1 })
  assert.equal(evidenced.injected.length, 0, 'evidence must satisfy the check')
})

test('loop guard ignores a chain broken by a different call', () => {
  const settings = settingsWith({
    enabled: true,
    discipline: { enabled: true, flavor: 'plain', antiFake: false, acceptance: false, loopGuard: true, maxNudges: 3 },
  })
  const { ctx, calls } = fakeCtx()
  registerDiscipline(ctx, () => settings)
  const toolResult = calls.on.find((entry) => entry.event === 'tools/result').listener
  const agent = fakeAgent()
  const args = { command: 'node --check a.js' }
  toolResult({ agent, name: 'pwsh', arguments: args }, { isError: true })
  toolResult({ agent, name: 'pwsh', arguments: args }, { isError: true })
  toolResult({ agent, name: 'read', arguments: { path: 'a.js' } }, { isError: true })
  toolResult({ agent, name: 'pwsh', arguments: args }, { isError: true })
  assert.equal(agent.injected.length, 0, 'an interleaved different call must reset the chain')
})

test('discipline is silent when disabled', () => {
  const settings = settingsWith({ enabled: true, discipline: { enabled: false, maxNudges: 3 } })
  const { ctx, calls } = fakeCtx()
  registerDiscipline(ctx, () => settings)
  const agent = fakeAgent({ messages: [assistantMessage('已经完成。')] })
  calls.on.find((entry) => entry.event === 'agent/turn-stopping').listener({ agent, turn: 1 })
  assert.equal(agent.injected.length, 0)
})

// --- robustness -----------------------------------------------------------

test('no exception escapes a malformed settings document', () => {
  const engine = createPersonalizeEngine({ getSettings: () => ({ personalize: null }), dshHome: '' })
  assert.deepEqual(engine.preview({ cwd: 'C:\\x' }), { text: '', tokens: 0, active: false, sections: [] })
  assert.equal(engine.textFor('C:\\x'), '')
  assert.deepEqual(engine.memory.list({}), { entries: [], total: 0 })
})

test('a throwing settings reader degrades to empty output', () => {
  const engine = createPersonalizeEngine({
    getSettings: () => {
      throw new Error('boom')
    },
    dshHome: '',
  })
  assert.equal(engine.preview({ cwd: 'C:\\x' }).active, false)
  assert.equal(engine.textFor('C:\\x'), '')
})

test('missing systemPrompt service yields no registration', () => {
  assert.equal(registerPersonalizePrompt({ get: () => undefined }, () => settingsWith({ enabled: true })), undefined)
  assert.equal(registerPersonalizePrompt(undefined, () => settingsWith({ enabled: true })), undefined)
})

await testAsync('a failing memory writer does not throw', async () => {
  const settings = settingsWith({ enabled: true, memory: { enabled: true, maxEntries: 5, entries: [] } })
  const engine = createPersonalizeEngine({
    getSettings: () => settings,
    dshHome: '',
    onMemoryChange: async () => {
      throw new Error('disk full')
    },
  })
  const result = await engine.memory.add({ text: '仍然加进内存' })
  assert.equal(result.entries.length, 1)
})

// --- preview sample for the report ----------------------------------------

test('preview sample renders five titled sections', () => {
  const settings = settingsWith({
    enabled: true,
    scope: 'all',
    nickname: '老王',
    assistantName: '小深',
    replyStyle: 'detailed',
    persona: '你是一名偏好 Windows PowerShell 的资深工程师，先验证再下结论。',
    instructions: '回复使用简体中文；涉及命令时给出可直接复制的一段。',
    memory: {
      enabled: true,
      inject: true,
      maxEntries: 200,
      entries: [
        { id: 'm1', text: '本项目代码根目录是 APP/code/dsh-mydsh', at: Date.now(), workspace: 'C:\\Data\\DSH\\mydsh', pinned: true, hits: 3 },
        { id: 'm2', text: '版本目录用 V1/V2 命名，不使用「最终版」', at: Date.now(), workspace: '', pinned: false, hits: 1 },
      ],
    },
  })
  const engine = createPersonalizeEngine({ getSettings: reader(settings), dshHome: '' })
  const preview = engine.preview({ cwd: 'C:\\Data\\DSH\\mydsh\\APP\\code' })
  assert.equal(preview.sections.length, 5)
  console.log('--- preview().text -------------------------------')
  console.log(preview.text)
  console.log('--- end ------------------------------------------')
  console.log(`tokens=${preview.tokens} active=${preview.active}`)
})

// --- summary --------------------------------------------------------------

console.log('')
console.log(`selftest: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
