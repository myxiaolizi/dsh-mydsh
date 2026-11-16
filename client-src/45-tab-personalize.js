/**
 * Personalize tab.
 *
 * WHY THE TWO LONG FIELDS ARE READ-ONLY UNTIL "编辑"
 * `instructions` and `persona` are the two fields a user actually types paragraphs
 * into. Writing through `patch` on every keystroke would spend one HTTP round trip
 * and one settings revision per character, and the revision bump makes every
 * other open settings page re-fetch the whole document. A read-only preview plus
 * a modal editor gives one write per editing session, and it also gives the long
 * text the room it needs — which is what the reference page does.
 *
 * WHY THE PREVIEW IS EXPLICIT ABOUT "NOTHING WILL BE ATTACHED"
 * The most common confusion about personalization is a form full of text and a
 * session that receives none of it: `scope: 'workspaces'` with an unmatched
 * directory applies nowhere, by design. Saying so in the preview, with the
 * reason, is the difference between a bug report and a five-second fix.
 *
 * WHY MEMORY MUTATIONS GO THROUGH THE MEMORY API ONLY
 * The memory list is its own resource on the Host (`/personalize/memory`), and
 * the Host's memory store already writes every change back into the settings
 * document through `onMemoryChange`. The API therefore computes the trimmed,
 * de-duped list (including `maxEntries` eviction) and persists it; the page only
 * re-reads. Echoing the answer back through `patch` would write stale data — two
 * adds a second apart would race and the later write could restore the list from
 * before the first landed.
 */

/** Reply styles, with the one-line rule the Host actually injects. */
const PERSONALIZE_STYLES = [
  { value: 'efficient', label: '高效务实', rule: '先给结论，再给必要的步骤；省略寒暄、铺垫和自我评价。' },
  { value: 'detailed', label: '详尽', rule: '先给结论，再补充依据、边界条件与验证方式；关键步骤写出具体命令或文件路径。' },
  { value: 'friendly', label: '亲切', rule: '语气亲切自然，用短句和日常说法；信息仍需准确，不用表情堆积情绪。' },
  { value: 'formal', label: '正式', rule: '使用正式书面语，措辞严谨克制，避免口语、玩笑和情绪化表达。' },
  { value: 'concise', label: '极简', rule: '能用一句说清就不写第二句，只保留结论与关键参数。' },
]

/** Discipline flavours, quoting how each one phrases the same reminder. */
const PERSONALIZE_FLAVORS = [
  { value: 'plain', label: '平直', hint: '只陈述事实，不加语气词' },
  { value: 'coach', label: '教练', hint: '「提醒一下：… 先把证据补齐，再下结论」' },
  { value: 'strict', label: '严格', hint: '「注意：口头结论不算交付，请立刻补齐证据」' },
  { value: 'warm', label: '温和', hint: '「别急，补一句证据就好」' },
]

/**
 * A numeric field that writes once, on blur or Enter.
 *
 * Same reasoning as the other tabs: a controlled number field patched per
 * keystroke turns "200" into three writes and three revisions, and every open
 * settings page re-fetches the document on a revision change.
 */
function PersonalizeNumberField({ value, onChange, min, max, width }) {
  const [draft, setDraft] = useState(String(value ?? 0))
  const saved = useRef(String(value ?? 0))

  useEffect(() => {
    const next = String(value ?? 0)
    if (next !== saved.current) {
      saved.current = next
      setDraft(next)
    }
  }, [value])

  const commit = () => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(saved.current)
      return
    }
    const clamped = Math.round(Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min ?? 0, parsed)))
    const next = String(clamped)
    const changed = next !== saved.current
    saved.current = next
    setDraft(next)
    if (changed) onChange(clamped)
  }

  return h('input', {
    className: 'mydsh-input mydsh-mono',
    'data-width': width ?? 'sm',
    inputMode: 'numeric',
    value: draft,
    onChange: (event) => setDraft(event.target.value),
    onBlur: commit,
    onKeyDown: (event) => {
      if (event.key === 'Enter') commit()
    },
  })
}

/** A long text block, shown read-only with an 编辑 button and a modal editor. */
function PersonalizeLongField({ title, hint, value, placeholder, rows, onSave }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value ?? '')

  useEffect(() => {
    if (!open) setDraft(value ?? '')
  }, [value, open])

  const count = (value ?? '').length
  return h(
    'div',
    { className: 'mydsh-row-label', style: { gap: 6 } },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        null,
        h('span', { className: 'mydsh-row-title' }, title),
        hint === undefined ? null : h('div', { className: 'mydsh-row-hint' }, hint),
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h('span', { className: 'mydsh-muted' }, `${exact(count)} 字`),
        h(Button, { size: 'sm', onClick: () => setOpen(true) }, t().edit),
      ),
    ),
    (value ?? '') === ''
      ? h(Note, null, placeholder)
      : h(
          'pre',
          {
            className: 'mydsh-mono',
            style: {
              margin: 0,
              maxHeight: 220,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              padding: '8px 10px',
              borderRadius: 8,
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l1)',
            },
          },
          value,
        ),
    open
      ? h(
          Modal,
          {
            title,
            onClose: () => setOpen(false),
            footer: [
              h(Button, { key: 'cancel', onClick: () => setOpen(false) }, t().cancel),
              h(
                Button,
                {
                  key: 'save',
                  variant: 'primary',
                  onClick: () => {
                    onSave(draft)
                    setOpen(false)
                  },
                },
                t().save,
              ),
            ],
          },
          hint === undefined ? null : h('div', { className: 'mydsh-muted' }, hint),
          h(TextArea, { value: draft, onChange: setDraft, rows: rows ?? 14, placeholder }),
          h('div', { className: 'mydsh-muted' }, `${exact(draft.length)} 字 · 保存后立即生效，作用于下一次模型请求`),
        )
      : null,
  )
}

/**
 * The workspace picker.
 *
 * Hand-rolled checkboxes instead of a multi-select: the Host's `Select` is single
 * value, and a broken multi-select is worse than no multi-select. Order is the
 * registry order so two windows cannot disagree about what the list says.
 */
function PersonalizeWorkspacePicker({ workspaces, selected, onChange, disabled }) {
  const list = Array.isArray(workspaces) ? workspaces : []
  const chosen = new Set(Array.isArray(selected) ? selected : [])

  if (list.length === 0) {
    return h(Note, { tone: 'warn' }, '宿主没有上报任何工作区，所以「仅指定工作区」现在等于哪里都不生效；换回「全部会话」或手动填写路径。')
  }

  const toggle = (path, on) => {
    const next = on ? [...chosen, path] : [...chosen].filter((entry) => entry !== path)
    onChange(next)
  }

  return h(
    'div',
    { className: 'mydsh-list', style: { opacity: disabled === true ? 0.5 : 1 } },
    list.map((workspace) =>
      h(
        'label',
        {
          key: workspace.path,
          className: 'mydsh-inline',
          style: { justifyContent: 'space-between', gap: 8, cursor: disabled === true ? 'not-allowed' : 'pointer' },
        },
        h(
          'span',
          { className: 'mydsh-inline', style: { minWidth: 0 } },
          h('input', {
            type: 'checkbox',
            checked: chosen.has(workspace.path),
            disabled: disabled === true,
            onChange: (event) => toggle(workspace.path, event.target.checked),
          }),
          h('span', { className: 'mydsh-truncate' }, workspace.title === '' ? workspace.path : workspace.title),
        ),
        h('span', { className: 'mydsh-muted mydsh-truncate', style: { maxWidth: '55%' } }, workspace.path),
      ),
    ),
    chosen.size === 0 ? h(Note, { tone: 'warn' }, '一个工作区都没选：个性化不会附加到任何会话。') : null,
  )
}

/** One memory entry row: text, metadata, pin toggle, delete. */
function PersonalizeMemoryRow({ entry, busy, onPin, onRemove }) {
  return h(
    'div',
    { className: 'mydsh-row', 'data-stack': 'true' },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between', gap: 8 } },
      h(
        'div',
        { className: 'mydsh-inline', style: { minWidth: 0 } },
        entry.pinned === true ? h(Badge, { tone: 'ok' }, '置顶') : null,
        entry.workspace === '' || entry.workspace === undefined
          ? h(Badge, null, '全局')
          : h(Badge, null, '工作区'),
        h('span', { className: 'mydsh-muted' }, `${entry.source ?? 'manual'} · ${when(entry.at)}`),
        entry.hits > 0 ? h('span', { className: 'mydsh-muted' }, `召回 ${exact(entry.hits)} 次`) : null,
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Button, { size: 'sm', disabled: busy, onClick: () => onPin(entry) }, entry.pinned === true ? '取消置顶' : '置顶'),
        h(Button, { size: 'sm', variant: 'danger', disabled: busy, onClick: () => onRemove(entry) }, t().remove),
      ),
    ),
    h('div', { style: { fontSize: 12, whiteSpace: 'pre-wrap' } }, entry.text),
    entry.workspace === '' || entry.workspace === undefined
      ? null
      : h('div', { className: 'mydsh-muted mydsh-truncate', title: entry.workspace }, entry.workspace),
  )
}

/**
 * The memory manager: search, add, pin, delete, clear.
 *
 * Search runs on the Host (`q`) rather than filtering locally: the Host also
 * applies the scope rule, and two filters that can disagree is how a user ends up
 * believing an entry was deleted when it was only hidden.
 *
 * WHY NOTHING HERE PATCHES THE SETTINGS DOCUMENT
 * The Host's memory store already persists every mutation through the settings
 * store (`onMemoryChange`), so the list the API returns is the list on disk.
 * Echoing that same list back through `patch` would be a second write of stale
 * data: two adds a second apart would race, and the second write could put back
 * the list from before the first one landed. The page therefore only asks the
 * settings store to re-read, which it does on its own 2 s revision poll anyway.
 */
function PersonalizeMemoryList({ workspaces, enabled, onChanged }) {
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [addText, setAddText] = useState('')
  const [addWorkspace, setAddWorkspace] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(undefined)

  // Debounced so typing a word is one request, not one per character.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchDraft.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchDraft])

  const path = enabled === true ? `/personalize/memory?q=${encodeURIComponent(search)}` : null
  const poll = usePoll(path, 0, [search, enabled])

  /** Ask the settings store to catch up with the write the memory API just made. */
  const persist = () => {
    if (typeof onChanged === 'function') onChanged()
  }

  const mutate = async (body, note) => {
    setBusy(true)
    setMessage(undefined)
    try {
      const value = await api('/personalize/memory', { body })
      persist()
      setMessage(note)
      poll.reload()
      return value
    } catch (failure) {
      setMessage(failure?.message ?? String(failure))
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const entries = Array.isArray(poll.data?.entries) ? poll.data.entries : []
  const total = Number(poll.data?.total ?? entries.length)

  const add = async () => {
    const text = addText.trim()
    if (text === '') {
      setMessage('先写一条要记住的内容')
      return
    }
    const value = await mutate({ add: { text, workspace: addWorkspace, source: 'manual' } }, '已新增一条记忆')
    // Keep the text on a failure so a rejected entry is not silently lost.
    if (value !== undefined) setAddText('')
  }

  return h(
    'div',
    { className: 'mydsh-list' },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(TextField, {
        value: searchDraft,
        onChange: setSearchDraft,
        placeholder: '搜索记忆内容',
        width: 'lg',
      }),
      h(
        'div',
        { className: 'mydsh-inline' },
        h('span', { className: 'mydsh-muted' }, `${exact(entries.length)} / ${exact(total)} 条`),
        h(Button, { size: 'sm', variant: 'ghost', onClick: () => poll.reload() }, `⟳ ${t().refresh}`),
        h(
          Button,
          {
            size: 'sm',
            variant: 'danger',
            disabled: busy,
            onClick: async () => {
              setBusy(true)
              setMessage(undefined)
              try {
                const value = await api('/personalize/memory/clear', { body: { scope: 'all' } })
                persist()
                setMessage(`已清空 ${exact(value?.removed)} 条记忆`)
                poll.reload()
              } catch (failure) {
                setMessage(failure?.message ?? String(failure))
              } finally {
                setBusy(false)
              }
            },
          },
          '清空全部',
        ),
      ),
    ),
    h(
      'div',
      { className: 'mydsh-inline', style: { alignItems: 'flex-end' } },
      h(
        'div',
        { className: 'mydsh-grow mydsh-row-label' },
        h('span', { className: 'mydsh-muted' }, '新增一条记忆'),
        h(TextArea, { value: addText, onChange: setAddText, rows: 2, placeholder: '例如：这个项目所有文件都要用 V1/V2 版本后缀，禁止覆盖旧版。' }),
      ),
    ),
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        { className: 'mydsh-inline' },
        h('span', { className: 'mydsh-muted' }, '归属'),
        h(Select, {
          value: addWorkspace,
          width: 'md',
          options: [{ value: '', label: '全局（所有会话）' }].concat(
            (Array.isArray(workspaces) ? workspaces : []).map((workspace) => ({
              value: workspace.path,
              label: workspace.title === '' ? workspace.path : workspace.title,
            })),
          ),
          onChange: setAddWorkspace,
        }),
      ),
      h(Button, { variant: 'primary', disabled: busy, onClick: add }, busy ? t().loading : '新增'),
    ),
    message === undefined ? null : h(Note, { tone: /失败|不能|无效/.test(String(message)) ? 'error' : 'ok' }, message),
    poll.error === undefined ? null : h(Note, { tone: 'error' }, poll.error),
    entries.length === 0
      ? h(Empty, null, poll.loading ? t().loading : search === '' ? '还没有记忆条目' : '没有匹配的条目')
      : h(
          'div',
          { className: 'mydsh-scroll mydsh-list' },
          entries.map((entry) =>
            h(PersonalizeMemoryRow, {
              key: entry.id,
              entry,
              busy,
              onPin: (row) => mutate({ pin: { id: row.id, pinned: row.pinned !== true } }, row.pinned === true ? '已取消置顶' : '已置顶'),
              onRemove: (row) => mutate({ remove: row.id }, '已删除一条记忆'),
            }),
          ),
        ),
  )
}

/** The personalize tab. */
function PersonalizeTab({ settings, patch, meta }) {
  const personalize = settings.personalize
  const discipline = personalize.discipline ?? {}
  const memory = personalize.memory ?? {}
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewCwd, setPreviewCwd] = useState(() => {
    const list = Array.isArray(meta?.workspaces) ? meta.workspaces : []
    return list[0]?.path ?? ''
  })

  // The preview is keyed on what actually changes the assembled text. Editing a
  // long field goes through a modal save, so this signature is stable while the
  // user types and changes exactly when a save lands.
  const previewSignature = JSON.stringify([
    personalize.enabled,
    personalize.nickname,
    personalize.assistantName,
    personalize.replyStyle,
    personalize.scope,
    personalize.workspaces,
    personalize.instructions,
    personalize.persona,
    memory.enabled,
    memory.inject,
  ])
  const preview = usePoll(
    `/personalize/preview?cwd=${encodeURIComponent(previewCwd)}`,
    0,
    [previewCwd, previewSignature],
  )

  const setPersonalize = (partial) => patch({ personalize: partial })
  const setMemory = (partial) => patch({ personalize: { memory: partial } })
  const setDiscipline = (partial) => patch({ personalize: { discipline: partial } })

  const styleRule = PERSONALIZE_STYLES.find((row) => row.value === personalize.replyStyle) ?? PERSONALIZE_STYLES[0]
  const workspaces = Array.isArray(meta?.workspaces) ? meta.workspaces : []
  const selectedWorkspaces = Array.isArray(personalize.workspaces) ? personalize.workspaces : []
  const memoryEnabled = memory.enabled === true
  const previewData = preview.data
  const previewActive = previewData?.active === true

  return h(
    'div',
    { className: 'mydsh-page' },

    h(
      Card,
      {
        title: '个性化',
        sub: '这里写的东西会作为一段系统提示注入，作用于每一次模型请求',
        actions: [
          h(Switch, {
            key: 'switch',
            checked: personalize.enabled === true,
            label: '启用个性化',
            onChange: (next) => setPersonalize({ enabled: next }),
          }),
        ],
      },
      h(SwitchRow, {
        title: '启用个性化',
        hint: '关闭后所有字段照旧保存，但不会附加任何内容到会话',
        checked: personalize.enabled === true,
        onChange: (next) => setPersonalize({ enabled: next }),
      }),
      personalize.enabled === true
        ? h(Note, { tone: 'ok' }, '已启用：下面的内容会按 身份 → 风格 → 人设 → 指令 → 记忆 的固定顺序注入。')
        : h(Note, { tone: 'warn' }, '未启用：字段仍然保存，但会话不会收到任何附加内容。'),
      h(
        'div',
        { className: 'mydsh-grid', 'data-cols': '2' },
        h(
          'div',
          { className: 'mydsh-row-label' },
          h('span', { className: 'mydsh-row-title' }, '对你的称呼'),
          h('span', { className: 'mydsh-row-hint' }, '助手在回复里怎么叫你；留空则不强调称呼'),
          h(TextField, {
            value: personalize.nickname ?? '',
            onChange: (next) => setPersonalize({ nickname: next }),
            width: 'lg',
            placeholder: '例如：郑磊',
          }),
        ),
        h(
          'div',
          { className: 'mydsh-row-label' },
          h('span', { className: 'mydsh-row-title' }, '助手名字'),
          h('span', { className: 'mydsh-row-hint' }, '助手用什么名字自称；留空则用供应商默认'),
          h(TextField, {
            value: personalize.assistantName ?? '',
            onChange: (next) => setPersonalize({ assistantName: next }),
            width: 'lg',
            placeholder: '例如：小马哥',
          }),
        ),
      ),
      h(
        Row,
        { title: '回复风格', hint: styleRule.rule, stack: true },
        h(Segmented, {
          value: personalize.replyStyle,
          onChange: (next) => setPersonalize({ replyStyle: next }),
          options: PERSONALIZE_STYLES.map((row) => ({ value: row.value, label: row.label })),
        }),
      ),
    ),

    h(
      Card,
      { title: '长期指令与人设', sub: '每次对话都会生效，所以只写长期成立的规则，不写一次性要求' },
      h(PersonalizeLongField, {
        title: '给助手的指令',
        hint: '你希望助手一直遵守的要求，例如版本管理、文案风格、交付格式',
        value: personalize.instructions ?? '',
        placeholder: '还没有写长期指令。点「编辑」开始写，例如：所有文件都按 V1、V2 递增，禁止覆盖旧版。',
        rows: 16,
        onSave: (next) => setPersonalize({ instructions: next }),
      }),
      h(PersonalizeLongField, {
        title: '人设设定',
        hint: '助手是什么身份、什么性格、怎么表达；对人设的描述越具体，语气越稳定',
        value: personalize.persona ?? '',
        placeholder: '暂无人设 / 人格描述，点「编辑」添加。',
        rows: 12,
        onSave: (next) => setPersonalize({ persona: next }),
      }),
    ),

    h(
      Card,
      { title: '生效范围', sub: '决定这段内容出现在哪些会话里' },
      h(
        Row,
        { title: '范围', hint: '选定「仅指定工作区」后，没有列出的目录不会收到任何内容' },
        h(Segmented, {
          value: personalize.scope,
          onChange: (next) => setPersonalize({ scope: next }),
          options: [
            { value: 'all', label: '全部会话' },
            { value: 'workspaces', label: '仅指定工作区' },
          ],
        }),
      ),
      personalize.scope === 'workspaces'
        ? h(PersonalizeWorkspacePicker, {
            workspaces,
            selected: selectedWorkspaces,
            disabled: personalize.enabled !== true,
            onChange: (next) => setPersonalize({ workspaces: next }),
          })
        : h(Note, null, `当前作用于所有会话${workspaces.length === 0 ? '' : `；宿主已上报 ${workspaces.length} 个工作区`}。`),
      h(
        Row,
        {
          title: '手动填写路径',
          hint: '不在工作区列表里的目录（例如临时克隆）也可以直接写进来，一行一个',
          stack: true,
        },
        h(TextArea, {
          value: selectedWorkspaces.filter((entry) => workspaces.every((workspace) => workspace.path !== entry)).join('\n'),
          rows: 3,
          placeholder: 'D:\\Projects\\example',
          onChange: (text) => {
            const manual = text
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== '')
            const fromList = selectedWorkspaces.filter((entry) => workspaces.some((workspace) => workspace.path === entry))
            setPersonalize({ workspaces: [...fromList, ...manual] })
          },
        }),
      ),
    ),

    h(
      Card,
      { title: '长期记忆', sub: '跨会话保存的事实与结论；开启注入后按相关度挑几条写进提示' },
      h(SwitchRow, {
        title: '启用长期记忆',
        hint: '关闭后条目仍在，只有下面的记忆管理会被收起',
        checked: memoryEnabled,
        onChange: (next) => setMemory({ enabled: next }),
      }),
      memoryEnabled
        ? h(SwitchRow, {
            title: '注入到提示',
            hint: '关闭后只保存不注入：适合先攒一批再统一审阅',
            checked: memory.inject === true,
            onChange: (next) => setMemory({ inject: next }),
          })
        : null,
      memoryEnabled
        ? h(SwitchRow, {
            title: '写入前先审阅',
            hint: '打开后由你确认才落盘，避免助手把猜测写成事实',
            checked: memory.reviewBeforeWrite === true,
            onChange: (next) => setMemory({ reviewBeforeWrite: next }),
          })
        : null,
      memoryEnabled
        ? h(
            Row,
            { title: '最多保留条目', hint: '超出后按「命中次数低、时间旧」的顺序淘汰，置顶条目最后才动' },
            h(PersonalizeNumberField, {
              value: memory.maxEntries,
              min: 1,
              max: 2000,
              onChange: (next) => setMemory({ maxEntries: next }),
            }),
          )
        : null,
      memoryEnabled
        ? h(PersonalizeMemoryList, {
            workspaces,
            enabled: memoryEnabled,
            onChanged: () => settingsStore.refresh(true),
          })
        : h(Empty, null, '长期记忆未启用。启用后可以在这里搜索、置顶、删除和手动新增条目。'),
    ),

    h(
      Card,
      { title: '行为纪律', sub: '在回合结束时检查「说完成」这件事有没有依据；每次提醒都写进会话日志' },
      h(SwitchRow, {
        title: '启用行为纪律',
        hint: '关闭后三项检查全部停下，不注入任何提醒',
        checked: discipline.enabled === true,
        onChange: (next) => setDiscipline({ enabled: next }),
      }),
      h(
        Row,
        { title: '提醒语气', hint: PERSONALIZE_FLAVORS.find((row) => row.value === discipline.flavor)?.hint },
        h(Select, {
          value: discipline.flavor ?? 'plain',
          options: PERSONALIZE_FLAVORS.map((row) => ({ value: row.value, label: row.label })),
          disabled: discipline.enabled !== true,
          onChange: (next) => setDiscipline({ flavor: next }),
        }),
      ),
      h(SwitchRow, {
        title: '反虚假完成',
        hint: '这一回合一次工具都没调用却宣布完成时提醒',
        checked: discipline.antiFake !== false,
        disabled: discipline.enabled !== true,
        onChange: (next) => setDiscipline({ antiFake: next }),
      }),
      h(SwitchRow, {
        title: '要求可验证的交付',
        hint: '结论里没有路径、命令、输出块或退出码时提醒',
        checked: discipline.acceptance !== false,
        disabled: discipline.enabled !== true,
        onChange: (next) => setDiscipline({ acceptance: next }),
      }),
      h(SwitchRow, {
        title: '循环守卫',
        hint: '同一个工具、同样的参数连续失败时打断并提示换法子',
        checked: discipline.loopGuard !== false,
        disabled: discipline.enabled !== true,
        onChange: (next) => setDiscipline({ loopGuard: next }),
      }),
      h(
        Row,
        { title: '每回合最多提醒', hint: '0 表示不提醒；上限保证纪律层不会变成第二个对话方' },
        h(PersonalizeNumberField, {
          value: discipline.maxNudges,
          min: 0,
          max: 20,
          onChange: (next) => setDiscipline({ maxNudges: next }),
        }),
      ),
    ),

    h(
      Card,
      {
        title: '实时预览',
        sub: '看着的是宿主现在真正会注入的文本，不是浏览器里的拼装',
        actions: [
          h(Button, { key: 'reload', size: 'sm', variant: 'ghost', onClick: () => preview.reload() }, `⟳ ${t().refresh}`),
          h(Button, { key: 'open', size: 'sm', onClick: () => setPreviewOpen(true) }, '全屏查看'),
        ],
      },
      h(
        'div',
        { className: 'mydsh-inline' },
        h('span', { className: 'mydsh-muted' }, '按哪个目录预览'),
        h(Select, {
          value: previewCwd,
          width: 'lg',
          options: [{ value: '', label: '（不分目录 / 全局）' }].concat(
            workspaces.map((workspace) => ({
              value: workspace.path,
              label: workspace.title === '' ? workspace.path : workspace.title,
            })),
          ),
          onChange: setPreviewCwd,
        }),
        h(TextField, { value: previewCwd, onChange: setPreviewCwd, width: 'lg', mono: true, placeholder: '也可以直接填一个目录路径' }),
      ),
      preview.error === undefined ? null : h(Note, { tone: 'error' }, preview.error),
      previewActive
        ? h(
            Note,
            { tone: 'ok' },
            `当前会附加 ${previewData?.sections?.length ?? 0} 段内容，约 ${tokens(previewData?.tokens, activeLocale())} tokens（${exact(previewData?.tokens)}）。`,
          )
        : h(
            Note,
            { tone: 'warn' },
            personalize.enabled !== true
              ? '当前不会附加任何内容：个性化总开关是关的。'
              : personalize.scope === 'workspaces' && selectedWorkspaces.length === 0
                ? '当前不会附加任何内容：范围是「仅指定工作区」，但一个工作区都没选，所以任何会话都命中不了。'
                : personalize.scope === 'workspaces'
                  ? `当前不会附加任何内容：这个目录不在已选的工作区里（已选 ${selectedWorkspaces.length} 个）。把它加进「生效范围」即可。`
                  : '当前不会附加任何内容：字段都是空的，或者宿主还没读到设置。',
          ),
      (previewData?.sections ?? []).length === 0
        ? null
        : h(
            'div',
            { className: 'mydsh-inline', style: { flexWrap: 'wrap' } },
            previewData.sections.map((section) =>
              h(Badge, { key: section.key, tone: 'ok' }, `${section.title} · ${tokens(section.tokens, activeLocale())}`),
            ),
          ),
      previewActive
        ? h(
            'pre',
            {
              className: 'mydsh-mono',
              style: {
                margin: 0,
                maxHeight: 260,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                padding: '8px 10px',
                borderRadius: 8,
                background: 'var(--dsw-alias-bg-layer-2)',
                border: '1px solid var(--dsw-alias-border-l1)',
              },
            },
            previewData?.text ?? '',
          )
        : null,
      preview.loading ? h('div', { className: 'mydsh-muted' }, t().loading) : null,
    ),

    previewOpen
      ? h(
          Modal,
          {
            title: '最终注入文本',
            onClose: () => setPreviewOpen(false),
            footer: [h(Button, { key: 'close', variant: 'primary', onClick: () => setPreviewOpen(false) }, t().close)],
          },
          h(
            'div',
            { className: 'mydsh-inline' },
            h(Badge, { tone: previewActive ? 'ok' : 'warn' }, previewActive ? '会附加' : '不会附加'),
            h('span', { className: 'mydsh-muted' }, `${exact(previewData?.tokens)} tokens · 目录 ${previewCwd === '' ? '（全局）' : previewCwd}`),
          ),
          h(
            'pre',
            { className: 'mydsh-mono', style: { margin: 0, whiteSpace: 'pre-wrap', padding: '10px 12px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)' } },
            previewActive ? (previewData?.text ?? '') : '当前没有任何内容会被注入。',
          ),
        )
      : null,
  )
}
