/**
 * Backup tab.
 *
 * WHY THE PAGE KEEPS A DRAFT FOR THE TWO LISTS
 * `backup.targets` and `backup.schedules` are edited as whole arrays, and every
 * keystroke in a long path or password field must not become its own settings
 * write: the store patches optimistically and each patch is one HTTP round trip,
 * so a typed password would produce a dozen writes and a dozen revisions for
 * every client polling `/settings/revision`. Both lists therefore live in local
 * draft state and are written through `patch` on the explicit save button — the
 * same shape the reference page uses, and the shape that makes "unsaved" visible
 * instead of guessed.
 *
 * WHY THE RUN HISTORY IS A SECOND POLL
 * `/backup/state` answers the question "what is happening now" and is polled at
 * 20 s because a running backup is the interesting case. The history table only
 * changes when a run finishes, so it is polled much more slowly; after any action
 * this page takes, both are reloaded by hand instead of waiting for a tick.
 */

/** The seven item groups, in the order the Host normalises them. */
const BACKUP_ITEM_ROWS = [
  ['conversations', '会话记录', '会话日志与元数据，恢复后可以接着聊'],
  ['systemConfig', '系统配置', 'profile 下的 cordis 配置与 package 清单'],
  ['plugins', '插件', '已安装插件的代码与清单'],
  ['models', '模型文件', 'models.json 与本地模型目录'],
  ['workspaceFiles', '工作区文件', '已注册工作区的源码，体积最大的一组'],
  ['other', '其他数据', '<DSH_HOME> 下没有被上面几类认领的内容'],
  ['credentials', '凭据文件', '.credentials.yaml 等密钥文件，未加密时宿主会跳过'],
]

/** Destination kinds the Host accepts. */
const BACKUP_TARGET_KINDS = [
  { value: 'local', label: '本地目录' },
  { value: 'webdav', label: 'WebDAV' },
  { value: 'oss', label: '阿里云 OSS' },
  { value: 's3', label: 'S3 兼容' },
  { value: 'gist', label: 'GitHub Gist' },
]

/** Object-storage fields, shared by `oss` and `s3`. */
const BACKUP_CLOUD_FIELDS = [
  ['endpoint', '服务地址', { width: 'xl', hint: '例如 https://oss-cn-hangzhou.aliyuncs.com' }],
  ['region', '区域', { hint: '留空按地址推断' }],
  ['bucket', 'Bucket', {}],
  ['accessKeyId', 'AccessKey ID', {}],
  ['accessKeySecret', 'AccessKey Secret', { secret: true }],
  ['publicBaseUrl', '公开访问前缀', { width: 'xl', hint: '仅用于生成下载链接' }],
]

/** Fields per destination kind; the Host keeps only the ones that apply. */
const BACKUP_TARGET_FIELDS = {
  local: [['path', '备份目录', { width: 'xl', hint: '留空则使用插件默认备份目录' }]],
  webdav: [
    ['url', '地址', { width: 'xl' }],
    ['username', '用户名', {}],
    ['password', '密码', { secret: true }],
    ['remotePath', '远端目录', { hint: '不存在会自动创建' }],
  ],
  oss: BACKUP_CLOUD_FIELDS,
  s3: BACKUP_CLOUD_FIELDS,
  gist: [
    ['token', '个人访问令牌', { secret: true, width: 'xl' }],
    ['gistId', 'Gist ID', { hint: '留空表示新建一个私有 Gist' }],
  ],
}

/** Trigger kinds, matching the Host's scheduler. */
const BACKUP_TRIGGERS = [
  { value: 'daily', label: '每天定时' },
  { value: 'weekly', label: '每周定时' },
  { value: 'interval', label: '按间隔' },
  { value: 'startup', label: 'DSH 启动时' },
  { value: 'after-session', label: '每轮对话结束后' },
  { value: 'manual', label: '仅手动' },
]

/** Weekday labels; the Host stores 0 = Sunday. */
const BACKUP_WEEKDAYS = [
  { value: '0', label: '周日' },
  { value: '1', label: '周一' },
  { value: '2', label: '周二' },
  { value: '3', label: '周三' },
  { value: '4', label: '周四' },
  { value: '5', label: '周五' },
  { value: '6', label: '周六' },
]

/** A brand-new destination with the fields its kind needs. */
function freshBackupTarget(kind) {
  const base = { id: newId('target'), kind, label: '', remotePath: 'dsh-mydsh' }
  if (kind === 'local') return { ...base, path: '' }
  if (kind === 'webdav') return { ...base, url: '', username: '', password: '' }
  if (kind === 'oss' || kind === 's3') {
    return {
      ...base,
      endpoint: '',
      region: '',
      bucket: '',
      accessKeyId: '',
      accessKeySecret: '',
      publicBaseUrl: '',
      pathStyle: kind === 's3',
    }
  }
  return { ...base, token: '', gistId: '' }
}

/** A brand-new schedule: daily at 03:00 with nothing selected yet. */
function freshBackupSchedule() {
  return {
    id: newId('schedule'),
    enabled: true,
    trigger: 'daily',
    time: '03:00',
    weekday: 1,
    intervalMinutes: 180,
    type: 'full',
    items: freshBackupItems(),
  }
}

/** The seven item flags, all off, for a schedule that has none yet. */
function freshBackupItems() {
  const out = {}
  for (const [key] of BACKUP_ITEM_ROWS) out[key] = false
  return out
}

/**
 * A numeric input that writes once, on blur or Enter.
 *
 * A controlled number field patched on every keystroke turns "512" into three
 * settings writes and three revisions, and every other open settings page
 * re-fetches the whole document on a revision change. It is a raw `input` with the
 * shipped `mydsh-input` class because the shared `TextField` has no blur hook.
 */
function BackupNumberField({ value, onChange, min, max, width }) {
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

/** A secret field: local draft, written only when the user presses 保存. */
function BackupSecretField({ value, onSave, placeholder, width }) {
  const [draft, setDraft] = useState(value ?? '')
  const saved = useRef(value ?? '')

  useEffect(() => {
    const next = value ?? ''
    if (next !== saved.current) {
      saved.current = next
      setDraft(next)
    }
  }, [value])

  const dirty = draft !== saved.current
  return h(
    'div',
    { className: 'mydsh-inline' },
    h(TextField, { value: draft, onChange: setDraft, type: 'password', placeholder, width: width ?? 'md' }),
    h(
      Button,
      {
        size: 'sm',
        disabled: dirty !== true,
        onClick: () => {
          saved.current = draft
          onSave(draft)
        },
      },
      t().save,
    ),
    dirty ? h(Badge, { tone: 'warn' }, '未保存') : null,
  )
}

/** One labelled control inside a destination block. */
function BackupField({ label, hint, children }) {
  return h(
    'div',
    { className: 'mydsh-row-label' },
    h('span', { className: 'mydsh-muted' }, label),
    children,
    hint === undefined ? null : h('span', { className: 'mydsh-row-hint' }, hint),
  )
}

/**
 * One destination block: identity, kind, its fields, and its own test button.
 *
 * The probe is self-contained on purpose: it POSTs the block's current draft
 * (not the saved one) so a user can test a destination before saving it, and its
 * answer is local state because nothing outside this block changes.
 */
function BackupTargetRow({ target, active, onChange, onRemove, onActivate }) {
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState(undefined)
  const fields = BACKUP_TARGET_FIELDS[target.kind] ?? BACKUP_TARGET_FIELDS.local
  const set = (partial) => onChange({ ...target, ...partial })

  const test = async () => {
    setProbing(true)
    setProbe(undefined)
    try {
      const answer = await api('/backup/test', { body: { target } })
      setProbe(answer)
    } catch (failure) {
      setProbe({ ok: false, message: failure?.message ?? String(failure), latencyMs: 0 })
    } finally {
      setProbing(false)
    }
  }

  return h(
    'div',
    { className: 'mydsh-card', 'data-flat': 'true', style: { gap: 8 } },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        { className: 'mydsh-inline' },
        h(TextField, { value: target.label ?? '', onChange: (next) => set({ label: next }), placeholder: '名称', width: 'md' }),
        active ? h(Badge, { tone: 'ok' }, '当前使用') : null,
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        active
          ? null
          : h(Button, { size: 'sm', onClick: () => onActivate(target.id) }, '设为当前'),
        h(Button, { size: 'sm', disabled: probing, onClick: test }, probing ? t().loading : t().test),
        h(Button, { size: 'sm', variant: 'danger', onClick: () => onRemove(target.id) }, t().remove),
      ),
    ),
    h(
      'div',
      { className: 'mydsh-inline' },
      h('span', { className: 'mydsh-muted' }, '类型'),
      h(Select, {
        value: target.kind,
        width: 'md',
        options: BACKUP_TARGET_KINDS,
        onChange: (kind) => onChange({ ...freshBackupTarget(kind), id: target.id, label: target.label, remotePath: target.remotePath }),
      }),
    ),
    h(
      'div',
      { className: 'mydsh-grid', 'data-cols': '2' },
      fields.map(([key, label, options]) =>
        h(
          BackupField,
          { key, label, hint: options?.hint },
          options?.secret === true
            ? h(TextField, {
                value: target[key] ?? '',
                onChange: (next) => set({ [key]: next }),
                type: 'password',
                width: options?.width ?? 'md',
              })
            : h(TextField, {
                value: target[key] ?? '',
                onChange: (next) => set({ [key]: next }),
                width: options?.width ?? 'md',
              }),
        ),
      ),
      target.kind === 'oss' || target.kind === 's3'
        ? h(
            BackupField,
            { label: 'Path-style 寻址' },
            h(Switch, {
              checked: target.pathStyle === true,
              label: 'Path-style 寻址',
              onChange: (next) => set({ pathStyle: next }),
            }),
          )
        : null,
    ),
    probe === undefined
      ? null
      : h(
          Note,
          { tone: probe.ok === true ? 'ok' : 'error' },
          `${probe.ok === true ? '可达' : '不可达'} · ${duration(probe.latencyMs)}${probe.message === '' ? '' : ` · ${probe.message}`}`,
        ),
  )
}

/**
 * One schedule block.
 *
 * Only the fields the chosen trigger actually reads are shown, because the Host
 * reads exactly those: a `time` for a startup trigger is dead input, and dead
 * inputs are what make a settings page feel untrustworthy.
 */
function BackupScheduleRow({ schedule, index, count, onChange, onRemove, onMove }) {
  const [openItems, setOpenItems] = useState(false)
  const set = (partial) => onChange({ ...schedule, ...partial })
  const trigger = schedule.trigger
  const itemKeys = BACKUP_ITEM_ROWS.filter(([key]) => schedule.items?.[key] === true)

  return h(
    'div',
    { className: 'mydsh-card', 'data-flat': 'true', style: { gap: 8 } },
    h(
      'div',
      { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Select, {
          value: trigger,
          width: 'md',
          options: BACKUP_TRIGGERS,
          onChange: (next) => set({ trigger: next }),
        }),
        h(Select, {
          value: schedule.type,
          width: 'sm',
          options: [
            { value: 'full', label: '全量' },
            { value: 'incremental', label: '增量' },
          ],
          onChange: (next) => set({ type: next }),
        }),
        h(Switch, {
          checked: schedule.enabled === true,
          label: '启用这条计划',
          onChange: (next) => set({ enabled: next }),
        }),
      ),
      h(
        'div',
        { className: 'mydsh-inline' },
        h(Button, { size: 'sm', disabled: index === 0, onClick: () => onMove(index, -1) }, '↑'),
        h(Button, { size: 'sm', disabled: index === count - 1, onClick: () => onMove(index, 1) }, '↓'),
        h(Button, { size: 'sm', variant: 'danger', onClick: () => onRemove(schedule.id) }, t().remove),
      ),
    ),
    trigger === 'daily' || trigger === 'weekly'
      ? h(
          'div',
          { className: 'mydsh-inline' },
          trigger === 'weekly'
            ? h(Select, {
                value: String(schedule.weekday),
                options: BACKUP_WEEKDAYS,
                onChange: (next) => set({ weekday: Number(next) }),
              })
            : null,
          h(TextField, { value: schedule.time, onChange: (next) => set({ time: next }), width: 'sm', mono: true, placeholder: '03:00' }),
          h('span', { className: 'mydsh-muted' }, '本机时间，精确到分钟'),
        )
      : null,
    trigger === 'interval'
      ? h(
          'div',
          { className: 'mydsh-inline' },
          h(BackupNumberField, {
            value: schedule.intervalMinutes,
            min: 5,
            max: 10080,
            onChange: (next) => set({ intervalMinutes: next }),
          }),
          h('span', { className: 'mydsh-muted' }, '分钟一次（5 分钟 ~ 7 天）'),
        )
      : null,
    h(
      'div',
      { className: 'mydsh-inline' },
      h(
        Button,
        { size: 'sm', variant: 'ghost', onClick: () => setOpenItems((open) => !open) },
        `内容：${itemKeys.length === 0 ? '未选择' : `${itemKeys.length} 项`}${openItems ? ' ▴' : ' ▾'}`,
      ),
      h('span', { className: 'mydsh-muted' }, itemKeys.length === 0 ? '这条计划不会产生任何备份' : ''),
    ),
    openItems
      ? h(
          'div',
          { className: 'mydsh-grid', 'data-cols': '2' },
          BACKUP_ITEM_ROWS.map(([key, title]) =>
            h(
              BackupField,
              { key, label: title },
              h(Switch, {
                checked: schedule.items?.[key] === true,
                label: title,
                onChange: (next) => set({ items: { ...(schedule.items ?? freshBackupItems()), [key]: next } }),
              }),
            ),
          ),
        )
      : null,
  )
}

/** The restore dialog: pick one run, optionally unpack somewhere else. */
function BackupRestoreModal({ runs, initialRunId, onClose, onDone }) {
  const [runId, setRunId] = useState(initialRunId ?? '')
  const [toDir, setToDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(undefined)
  const candidates = (runs ?? []).filter((row) => row.kind === undefined || row.kind === 'backup')

  const submit = async () => {
    if (runId === '') {
      setError('先选一条备份记录')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const value = await api('/backup/restore', { body: toDir === '' ? { runId } : { runId, toDir } })
      onDone(value)
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }

  return h(
    Modal,
    {
      title: '从备份恢复',
      onClose,
      footer: [
        h(Button, { key: 'cancel', onClick: onClose }, t().cancel),
        h(Button, { key: 'ok', variant: 'primary', disabled: busy, onClick: submit }, busy ? t().loading : '开始恢复'),
      ],
    },
    h(Note, null, '恢复只解包到独立目录，不会覆盖正在运行的会话与配置；核对无误后由你手动替换。'),
    h(
      'div',
      { className: 'mydsh-row-label' },
      h('span', { className: 'mydsh-muted' }, '选择记录'),
      h(Select, {
        value: runId,
        width: 'xl',
        options: [{ value: '', label: '— 未选择 —' }].concat(
          candidates.map((row) => ({
            value: row.id,
            label: `${when(row.finishedAt || row.startedAt)} · ${row.type === 'incremental' ? '增量' : '全量'} · ${bytes(row.bytes)}${row.ok === false ? ' · 失败' : ''}`,
          })),
        ),
        onChange: setRunId,
      }),
    ),
    h(
      'div',
      { className: 'mydsh-row-label' },
      h('span', { className: 'mydsh-muted' }, '解包到（留空使用插件默认恢复目录）'),
      h(TextField, { value: toDir, onChange: setToDir, width: 'xl', placeholder: 'D:\\restore' }),
    ),
    error === undefined ? null : h(Note, { tone: 'error' }, error),
  )
}

/** A yes/no dialog, used for the one action that deletes files. */
function BackupConfirmModal({ title, message, confirmLabel, onClose, onConfirm, busy }) {
  return h(
    Modal,
    {
      title,
      onClose,
      footer: [
        h(Button, { key: 'cancel', onClick: onClose }, t().cancel),
        h(Button, { key: 'ok', variant: 'danger', disabled: busy === true, onClick: onConfirm }, busy === true ? t().loading : confirmLabel),
      ],
    },
    h(Note, { tone: 'warn' }, message),
  )
}

/** The backup tab. */
function BackupTab({ settings, patch, meta }) {
  const backup = settings.backup
  const state = usePoll('/backup/state', 20000, [])
  const runsPoll = usePoll('/backup/runs', 60000, [])
  const [runAction, runState] = useAction()

  const [targetsDraft, setTargetsDraft] = useState(() => clone(backup.targets ?? []))
  const [activeDraft, setActiveDraft] = useState(backup.activeTargetId ?? '')
  const [schedulesDraft, setSchedulesDraft] = useState(() => clone(backup.schedules ?? []))
  const [saveError, setSaveError] = useState(undefined)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [restorePreset, setRestorePreset] = useState('')
  const [restoreResult, setRestoreResult] = useState(undefined)
  const [pendingDelete, setPendingDelete] = useState(undefined)
  const [playing, setPlaying] = useState(false)

  // External writes are authoritative: a reset, a restore of settings, or another
  // window's save must replace the drafts, or the page would keep showing a list
  // the Host no longer has.
  const targetsSignature = JSON.stringify([backup.targets, backup.activeTargetId])
  useEffect(() => {
    setTargetsDraft(clone(backup.targets ?? []))
    setActiveDraft(backup.activeTargetId ?? '')
  }, [targetsSignature])
  const schedulesSignature = JSON.stringify(backup.schedules)
  useEffect(() => {
    setSchedulesDraft(clone(backup.schedules ?? []))
  }, [schedulesSignature])

  const targetsDirty =
    JSON.stringify(targetsDraft) !== JSON.stringify(backup.targets ?? []) || activeDraft !== (backup.activeTargetId ?? '')
  const schedulesDirty = JSON.stringify(schedulesDraft) !== JSON.stringify(backup.schedules ?? [])

  const reload = () => {
    state.reload()
    runsPoll.reload()
  }

  const saveTargets = async () => {
    setSaveError(undefined)
    try {
      await patch({ backup: { targets: targetsDraft, activeTargetId: activeDraft } })
    } catch (failure) {
      setSaveError(failure?.message ?? String(failure))
    }
  }
  const saveSchedules = async () => {
    setSaveError(undefined)
    try {
      await patch({ backup: { schedules: schedulesDraft } })
    } catch (failure) {
      setSaveError(failure?.message ?? String(failure))
    }
  }

  const play = async (body) => {
    setPlaying(true)
    try {
      const value = await runAction('/backup/run', body)
      reload()
      return value
    } finally {
      setPlaying(false)
    }
  }

  const runs = runsPoll.data?.runs ?? state.data?.runs ?? []
  const currentTarget = (backup.targets ?? []).find((row) => row.id === backup.activeTargetId)
  const estimate = state.data?.estimate
  const sevenZip = state.data?.sevenZip === true
  const needsSevenZip = state.data?.needsSevenZip === true || backup.compression === '7z'
  const encryptionOn = backup.encryption?.enabled === true
  const credentialsOn = backup.items?.credentials === true

  return h(
    'div',
    { className: 'mydsh-page' },

    h(
      Card,
      {
        title: '备份',
        sub: '把常用状态打成一个包，放在本地磁盘或你自己的云上',
        actions: [
          h(
            Button,
            { key: 'run', variant: 'primary', disabled: state.data?.running === true || playing, onClick: () => play({}) },
            state.data?.running === true || playing ? t().loading : `▶ ${t().run}`,
          ),
          h(
            Button,
            {
              key: 'test',
              disabled: runState.pending,
              onClick: async () => {
                await runAction('/backup/test', {})
              },
            },
            '测试目标',
          ),
          h(
            Button,
            {
              key: 'restore',
              onClick: () => {
                setRestorePreset('')
                setRestoreResult(undefined)
                setRestoreOpen(true)
              },
            },
            '恢复…',
          ),
        ],
      },
      h(SwitchRow, {
        title: '启用备份',
        hint: '关闭后定时计划与「每轮对话结束后」触发都不会执行，手动备份仍可用',
        checked: backup.enabled === true,
        onChange: (next) => patch({ backup: { enabled: next } }),
      }),
      h(
        'div',
        { className: 'mydsh-list' },
        statusLine('运行状态', state.data?.running !== true, state.data?.running === true ? '正在备份…' : '空闲'),
        statusLine('上次备份', (state.data?.lastRunAt ?? 0) > 0, (state.data?.lastRunAt ?? 0) > 0 ? when(state.data.lastRunAt) : '还没有执行过'),
        statusLine('7z 压缩', sevenZip !== false, sevenZip ? '随包提供' : '缺失，7z 会自动降级为 zip'),
        statusLine('估算体积', estimate !== undefined, estimate === undefined ? t().loading : estimateLine(estimate)),
        statusLine('当前目标', currentTarget !== undefined, currentTarget === undefined ? '未配置，使用插件默认目录' : (currentTarget.label || currentTarget.kind)),
      ),
      runState.error === undefined ? null : h(Note, { tone: 'error' }, runState.error),
      runState.result !== undefined && runState.result?.ok !== undefined
        ? h(Note, { tone: runState.result.ok === true ? 'ok' : 'error' },
            `${runState.result.ok === true ? '目标可达' : '目标不可达'} · ${duration(runState.result.latencyMs)}${runState.result.message === '' ? '' : ` · ${runState.result.message}`}`)
        : null,
      needsSevenZip && sevenZip !== true
        ? h(Note, { tone: 'warn' }, '当前压缩方式选了 7z，但本机没有可用的 7zr；实际执行时会自动改用 zip-deflate。')
        : null,
      restoreResult === undefined
        ? null
        : h(
            Note,
            { tone: 'ok' },
            `已恢复 ${exact(restoreResult.restored)} 个文件到 ${restoreResult.toDir}` +
              (restoreResult.message === undefined || restoreResult.message === '' ? '' : ` · ${restoreResult.message}`),
          ),
      saveError === undefined ? null : h(Note, { tone: 'error' }, saveError),
    ),

    h(
      Card,
      { title: '备份内容', sub: '按组勾选；没有勾选任何一组时备份会因为「没有匹配到内容」而失败' },
      BACKUP_ITEM_ROWS.map(([key, title, hint]) =>
        h(SwitchRow, {
          key,
          title,
          hint,
          checked: backup.items?.[key] === true,
          onChange: (next) => patch({ backup: { items: { [key]: next } } }),
        }),
      ),
      credentialsOn && encryptionOn !== true
        ? h(
            Note,
            { tone: 'error' },
            '凭据文件已勾选，但加密没开：宿主会把这一组整体跳过，并在备份记录里写明原因。' +
              '要真正包含 .credentials.yaml，请打开下面的「加密」并设置至少 6 位密码。',
          )
        : null,
      h(
        Row,
        { title: '加密状态', hint: '凭据文件与加密是同一个决定的两面' },
        h(Badge, { tone: encryptionOn ? 'ok' : 'warn' }, encryptionOn ? '已开启 AES-256-GCM' : '未开启，凭据不会进包'),
      ),
    ),

    h(
      Card,
      {
        title: '存放位置',
        sub: `可以配置多个目标，备份与恢复都用「当前」那一个${meta?.dataDir === undefined ? '' : ` · 插件数据目录 ${meta.dataDir}`}`,
        actions: [
          targetsDirty ? h(Badge, { key: 'dirty', tone: 'warn' }, '未保存') : null,
          h(Button, { key: 'add', size: 'sm', onClick: () => setTargetsDraft((list) => [...list, freshBackupTarget('local')]) }, `+ ${t().add}`),
          h(
            Button,
            { key: 'save', size: 'sm', variant: 'primary', disabled: targetsDirty !== true, onClick: saveTargets },
            t().save,
          ),
        ],
      },
      targetsDraft.length === 0
        ? h(Empty, null, '还没有配置存放位置；点「添加」选一个本地目录就能开始。')
        : h(
            'div',
            { className: 'mydsh-list' },
            targetsDraft.map((target) =>
              h(BackupTargetRow, {
                key: target.id,
                target,
                active: target.id === activeDraft,
                onChange: (next) => setTargetsDraft((list) => list.map((row) => (row.id === next.id ? next : row))),
                onRemove: (id) => {
                  setTargetsDraft((list) => list.filter((row) => row.id !== id))
                  if (activeDraft === id) setActiveDraft('')
                },
                onActivate: (id) => setActiveDraft(id),
              }),
            ),
          ),
      h(Note, null, '「测试」用的是当前这一行里还没保存的内容，所以可以先验证连通性再保存。'),
    ),

    h(
      Card,
      {
        title: '触发方式',
        sub: '可以同时存在多条；「仅手动」只用来记录一条计划，不会自己跑',
        actions: [
          schedulesDirty ? h(Badge, { key: 'dirty', tone: 'warn' }, '未保存') : null,
          h(Button, { key: 'add', size: 'sm', onClick: () => setSchedulesDraft((list) => [...list, freshBackupSchedule()]) }, `+ ${t().add}`),
          h(
            Button,
            { key: 'save', size: 'sm', variant: 'primary', disabled: schedulesDirty !== true, onClick: saveSchedules },
            t().save,
          ),
        ],
      },
      schedulesDraft.length === 0
        ? h(Empty, null, '没有定时计划，备份只会手动执行。')
        : h(
            'div',
            { className: 'mydsh-list' },
            schedulesDraft.map((schedule, index) =>
              h(BackupScheduleRow, {
                key: schedule.id,
                schedule,
                index,
                count: schedulesDraft.length,
                onChange: (next) => setSchedulesDraft((list) => list.map((row) => (row.id === next.id ? next : row))),
                onRemove: (id) => setSchedulesDraft((list) => list.filter((row) => row.id !== id)),
                onMove: (from, delta) =>
                  setSchedulesDraft((list) => {
                    const to = from + delta
                    if (to < 0 || to >= list.length) return list
                    const next = list.slice()
                    const [moved] = next.splice(from, 1)
                    next.splice(to, 0, moved)
                    return next
                  }),
              }),
            ),
          ),
    ),

    h(
      Card,
      { title: '备份类型与压缩', sub: '增量只写与上一次相比变化的文件，依赖同一个目标上的基线' },
      h(
        Row,
        { title: '类型', hint: '目标上没有上一次的记录时，增量会自动退化成全量' },
        h(Segmented, {
          value: backup.type,
          onChange: (next) => patch({ backup: { type: next } }),
          options: [
            { value: 'full', label: '全量' },
            { value: 'incremental', label: '增量' },
          ],
        }),
      ),
      h(
        Row,
        { title: '压缩方式', hint: '7z 需要随包的 7zr；zip-deflate 是折中，zip 只打包不压缩' },
        h(Select, {
          value: backup.compression,
          options: [
            { value: 'zip-deflate', label: 'zip（deflate）' },
            { value: 'zip', label: 'zip（仅打包）' },
            { value: '7z', label: '7z' },
            { value: 'none', label: '不压缩' },
          ],
          onChange: (next) => patch({ backup: { compression: next } }),
        }),
      ),
      h(
        Row,
        { title: '分卷大小', hint: '0 表示不分卷；大于 0 时按此上限切成多个文件' },
        h(BackupNumberField, { value: backup.splitSizeMb, min: 0, max: 10240, onChange: (next) => patch({ backup: { splitSizeMb: next } }) }),
      ),
      h(
        Row,
        { title: '保留份数', hint: '只统计本插件写出的归档，多卷归档算作一份' },
        h(BackupNumberField, { value: backup.keepCount, min: 1, max: 500, onChange: (next) => patch({ backup: { keepCount: next } }) }),
      ),
      h(
        Row,
        { title: '单文件上限', hint: '超过这个大小的文件会被跳过，并在记录里列出前三个' },
        h(BackupNumberField, { value: backup.maxFileMb, min: 1, max: 8192, onChange: (next) => patch({ backup: { maxFileMb: next } }) }),
      ),
    ),

    h(
      Card,
      {
        title: '加密',
        sub: 'AES-256-GCM，密钥由密码经 scrypt 派生；密码不进归档，所以丢了就打不开',
        actions: [
          h(Switch, {
            checked: encryptionOn,
            label: '启用加密',
            onChange: (next) => patch({ backup: { encryption: { enabled: next } } }),
          }),
        ],
      },
      h(
        Row,
        { title: '密码', hint: '至少 6 位；选 7z 时由 7zr 自己加密，密码同样必须设置' },
        h(BackupSecretField, {
          value: backup.encryption?.password ?? '',
          placeholder: '备份密码',
          width: 'lg',
          onSave: (next) => patch({ backup: { encryption: { password: next } } }),
        }),
      ),
      h(Row, { title: '算法', hint: '宿主固定为 AES-256-GCM，不提供选项以免出现弱算法' },
        h('span', { className: 'mydsh-mono' }, 'AES-256-GCM'),
      ),
    ),

    h(
      Card,
      { title: '跨机同步', sub: '两台机器指向同一个目标时，用它决定谁覆盖谁' },
      h(SwitchRow, {
        title: '启用跨机同步',
        hint: '打开后备份记录会带上机器标识，冲突按下面的规则处理',
        checked: backup.sync?.enabled === true,
        onChange: (next) => patch({ backup: { sync: { enabled: next } } }),
      }),
      h(
        Row,
        { title: '方向', hint: '只上传的机器不会把远端的归档拉回来' },
        h(Select, {
          value: backup.sync?.direction ?? 'both',
          options: [
            { value: 'both', label: '双向' },
            { value: 'push', label: '仅上传' },
            { value: 'pull', label: '仅下载' },
          ],
          disabled: backup.sync?.enabled !== true,
          onChange: (next) => patch({ backup: { sync: { direction: next } } }),
        }),
      ),
      h(
        Row,
        { title: '冲突处理', hint: '「新的覆盖」比较归档时间，另外两项无条件偏向一侧' },
        h(Select, {
          value: backup.sync?.conflict ?? 'newer',
          options: [
            { value: 'newer', label: '新的覆盖旧的' },
            { value: 'local', label: '以本机为准' },
            { value: 'remote', label: '以远端为准' },
          ],
          disabled: backup.sync?.enabled !== true,
          onChange: (next) => patch({ backup: { sync: { conflict: next } } }),
        }),
      ),
    ),

    h(
      Card,
      {
        title: '历史记录',
        sub: `最近 ${runs.length} 条，含恢复与删除动作`,
        actions: [h(Button, { key: 'reload', size: 'sm', variant: 'ghost', onClick: reload }, `⟳ ${t().refresh}`)],
      },
      runs.length === 0
        ? h(Empty, null, runsPoll.loading ? t().loading : '还没有备份记录')
        : h(
            'table',
            { className: 'mydsh-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, '时间'),
                h('th', null, '类型'),
                h('th', { 'data-num': 'true' }, '大小'),
                h('th', null, '加密'),
                h('th', null, '结果'),
                h('th', null, '路径'),
                h('th', null, '操作'),
              ),
            ),
            h(
              'tbody',
              null,
              runs.map((row) =>
                h(
                  'tr',
                  { key: row.id },
                  h('td', { title: row.id }, when(row.finishedAt || row.startedAt)),
                  h('td', null, backupRunType(row)),
                  h('td', { 'data-num': 'true' }, row.bytes === undefined ? '—' : bytes(row.bytes)),
                  h('td', null, row.encrypted === true ? h(Badge, { tone: 'ok' }, '加密') : h(Badge, null, '明文')),
                  h('td', null, row.ok === true ? h(Badge, { tone: 'ok' }, '成功') : h(Badge, { tone: 'error' }, '失败')),
                  h(
                    'td',
                    { className: 'mydsh-muted mydsh-truncate', title: `${row.path ?? ''} ${row.message ?? ''}`, style: { maxWidth: 220 } },
                    row.deletedAt !== undefined ? '已删除' : (row.path || row.toDir || row.message || '—'),
                  ),
                  h(
                    'td',
                    null,
                    h(
                      'div',
                      { className: 'mydsh-inline' },
                      row.deletedAt !== undefined
                        ? null
                        : h(
                            Button,
                            {
                              size: 'sm',
                              variant: 'ghost',
                              onClick: () => {
                                setRestoreResult(undefined)
                                setRestorePreset(row.id)
                                setRestoreOpen(true)
                              },
                            },
                            '恢复',
                          ),
                      row.deletedAt !== undefined
                        ? null
                        : h(Button, { size: 'sm', variant: 'danger', onClick: () => setPendingDelete(row) }, t().remove),
                      row.ok !== true && row.message !== undefined && row.message !== ''
                        ? h('span', { title: row.message }, h(Badge, { tone: 'error' }, '原因'))
                        : null,
                    ),
                  ),
                ),
              ),
            ),
          ),
      runsPoll.error === undefined ? null : h(Note, { tone: 'error' }, runsPoll.error),
    ),

    restoreOpen
      ? h(BackupRestoreModal, {
          runs,
          initialRunId: restorePreset,
          onClose: () => setRestoreOpen(false),
          onDone: (value) => {
            setRestoreOpen(false)
            setRestoreResult(value)
            reload()
          },
        })
      : null,
    pendingDelete === undefined
      ? null
      : h(BackupConfirmModal, {
          title: '删除这次备份',
          message: `将删除目标 ${pendingDelete.path || pendingDelete.targetId || ''} 上的归档文件。记录会保留并标记为已删除，但文件无法找回。`,
          confirmLabel: '删除文件',
          busy: runState.pending,
          onClose: () => setPendingDelete(undefined),
          onConfirm: async () => {
            await runAction('/backup/delete', { runId: pendingDelete.id })
            setPendingDelete(undefined)
            reload()
          },
        }),
  )
}

/** Human label for one history row, which may be a backup, restore or delete. */
function backupRunType(row) {
  if (row.kind === 'restore') return '恢复'
  if (row.kind === 'delete') return '删除'
  if (row.kind === 'prune') return '清理'
  return row.type === 'incremental' ? '增量' : '全量'
}
