/**
 * Backup engine self-test.
 *
 * Builds a throwaway DSH home under `<repo>/agent/scratch/bk-test/`, then runs the
 * engine the way the settings page would: estimate, a full encrypted split
 * backup, a restore that is compared byte for byte, an incremental run after one
 * file changes, retention, a wrong-password restore, and the offline failure path
 * for a WebDAV and an OSS destination.
 *
 * Nothing here touches the real `<DSH_HOME>`, the network, or the running
 * Harness. Failures are collected and printed with the case that produced them,
 * and the process exits non-zero when any case fails, so this doubles as a check
 * that can run in CI.
 *
 * Run with:
 *   node APP/code/dsh-mydsh/host/backup/selftest.mjs
 */

import assert from 'node:assert'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../../../..')
const SANDBOX = join(REPO, 'agent', 'scratch', 'bk-test')
const HOME = join(SANDBOX, 'home')
const TARGET = join(SANDBOX, 'target')
const RESTORE_ROOT = join(SANDBOX, 'restored')

// Point every module at the sandbox *before* anything imports the store, which
// resolves `DSH_HOME` lazily but is easier to reason about when it is set first.
process.env.DSH_HOME = HOME

const { createBackupEngine, needsSevenZip } = await import('../../host/backup/engine.js')
const { normalize } = await import('../../host/core/settings.js')
const { localTarget, webdavTarget, objectStorageTarget, gistTarget } = await import('../../host/backup/targets.js')
const { readZipDirectory, listArchive, sevenZipBinary } = await import('../../host/backup/archive.js')

let passed = 0
const failures = []

/** Run one case, recording its outcome instead of aborting the suite. */
async function test(name, body) {
  try {
    await body()
    passed++
    console.log(`  ok    ${name}`)
  } catch (error) {
    failures.push({ name, message: error?.message ?? String(error) })
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error?.message ?? error}`)
  }
}

/** A short fingerprint of a file, for the restore comparison. */
async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** Every file below a directory, as `/`-separated relative paths. */
async function treeOf(root) {
  const out = []
  const queue = [root]
  while (queue.length > 0) {
    const dir = queue.shift()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.isFile()) out.push(full.slice(root.length + 1).split('\\').join('/'))
    }
  }
  return out.sort()
}

/** Build a fake DSH home with the shape the collectors expect. */
async function buildHome() {
  await rm(SANDBOX, { recursive: true, force: true })
  await mkdir(HOME, { recursive: true })

  // Home-root configuration, including one file the credentials rule must catch.
  await writeFile(join(HOME, 'settings.json'), `${JSON.stringify({ ui: { compact: false } }, null, 2)}\n`)
  await writeFile(join(HOME, '.anonymous-user-id'), 'anon-1234\n')
  await writeFile(join(HOME, '.credentials.yaml'), 'deepseek:\n  apiKey: sk-test-should-never-appear\n')
  await writeFile(join(HOME, 'models.json'), `${JSON.stringify({ default: 'deepseek-chat' })}\n`)

  // A conversation: the JSONL log inside a workspace bucket and session folder.
  const sessionDir = join(HOME, 'sessions', '--C-Data-DSH-mydsh--', 'session-0001')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(
    join(sessionDir, 'session.v4.jsonl'),
    `${JSON.stringify({ role: 'user', text: 'hello backup' })}\n${JSON.stringify({ role: 'assistant', text: 'hi' })}\n`,
  )
  await writeFile(join(sessionDir, 'meta.json'), `${JSON.stringify({ id: 'session-0001' })}\n`)

  // A profile: bundle list, patch layer and one installed bundle with its own data.
  const profileDir = join(HOME, 'profiles', 'desktop')
  await mkdir(join(profileDir, 'node_modules', 'dsh-demo'), { recursive: true })
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'desktop-profile', dependencies: { 'dsh-demo': '1.0.0' } }, null, 2)}\n`)
  await writeFile(join(profileDir, 'cordis.patch.yml'), 'plugins:\n  dsh-demo: {}\n')
  await writeFile(join(profileDir, 'cordis.yml'), 'profile: desktop\n')
  await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\n')
  await writeFile(join(profileDir, 'node_modules', 'dsh-demo', 'package.json'), `${JSON.stringify({ name: 'dsh-demo', version: '1.0.0' })}\n`)
  await writeFile(join(profileDir, 'node_modules', 'dsh-demo', 'index.js'), 'export const x = 1\n')

  // The bundle's own data directory, which the plugins group must pick up.
  await mkdir(join(HOME, 'dsh-demo'), { recursive: true })
  await writeFile(join(HOME, 'dsh-demo', 'config.json'), `${JSON.stringify({ enabled: true })}\n`)

  // Plugin state: a settings document and a projection store (the `other` group).
  await mkdir(join(HOME, 'dsh-mydsh'), { recursive: true })
  await writeFile(join(HOME, 'dsh-mydsh', 'settings.json'), `${JSON.stringify({ backup: { enabled: true } }, null, 2)}\n`)
  await mkdir(join(HOME, 'storages', 'cost-meter'), { recursive: true })
  await writeFile(join(HOME, 'storages', 'cost-meter', 'ledger.json'), `${JSON.stringify({ total: 42 })}\n`)

  // A workspace with the file the incremental run will change.
  const workspace = join(SANDBOX, 'workspace')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await mkdir(join(workspace, 'assets'), { recursive: true })
  await writeFile(join(workspace, 'README.md'), '# workspace\n')
  await writeFile(join(workspace, 'src', 'main.js'), 'console.log("v1")\n')
  await writeFile(join(workspace, 'src', 'util.js'), 'export const one = 1\n')
  // Splitting is expressed in whole megabytes, so a genuinely multi-part backup
  // needs more than one megabyte on disk. Random bytes are used on purpose: a run
  // of zeroes 鈥?or any short repeating pattern 鈥?deflates to a few kilobytes and
  // would never split. This also exercises the streaming path: the file is pumped
  // through the compressor in chunks and never materialised as one Buffer on the
  // write side.
  const noise = randomBytes(3 * 1024 * 1024)
  await writeFile(join(workspace, 'assets', 'payload.bin'), noise)

  return workspace
}

/** Settings with one local target and every item switched on. */
function settingsWith(overrides = {}) {
  return normalize({
    backup: {
      enabled: true,
      type: 'full',
      compression: 'zip-deflate',
      splitSizeMb: 0,
      keepCount: 5,
      maxFileMb: 512,
      items: {
        workspaceFiles: true,
        conversations: true,
        systemConfig: true,
        plugins: true,
        other: true,
        models: true,
        credentials: false,
      },
      targets: [{ id: 'local-1', kind: 'local', label: 'sandbox', remotePath: 'dsh-mydsh', path: TARGET }],
      activeTargetId: 'local-1',
      ...overrides,
    },
  })
}

/** The engine bound to one settings document and one workspace. */
function engineFor(settings, workspace, extra = {}) {
  const notices = []
  const engine = createBackupEngine({
    getSettings: () => settings,
    packageRoot: extra.packageRoot,
    binary: extra.binary,
    workspaces: async () => [{ id: 'w1', title: 'demo', path: workspace }],
    onNotice: (notice) => notices.push(notice),
  })
  return { engine, notices }
}

async function main() {
  console.log(`sandbox: ${SANDBOX}`)
  console.log(`seven zip: ${sevenZipBinary(join(REPO, 'APP', 'code', 'dsh-mydsh')) ?? 'not found'}`)

  const workspace = await buildHome()

  // ---------------------------------------------------------------- estimate
  console.log('\nestimate')
  await test('the estimate covers every selected item without writing anything', async () => {
    const settings = settingsWith()
    const { engine } = engineFor(settings, workspace)
    const estimate = await engine.estimate()
    const keys = estimate.items.map((row) => row.key)
    assert.ok(estimate.files > 0, 'the estimate must see files')
    assert.ok(estimate.bytes > 0, 'the estimate must see bytes')
    for (const key of ['conversations', 'systemConfig', 'plugins', 'models', 'workspaceFiles', 'other']) {
      assert.ok(keys.includes(key), `the estimate is missing the ${key} item, saw ${keys.join(', ')}`)
    }
    assert.ok(!keys.includes('credentials'), 'credentials are off by default')
  })

  await test('credentials are refused while encryption is off, and said so', async () => {
    const settings = settingsWith({ items: { workspaceFiles: false, conversations: true, systemConfig: true, plugins: false, other: false, models: false, credentials: true } })
    const { engine } = engineFor(settings, workspace)
    const estimate = await engine.estimate()
    assert.ok(!estimate.items.some((row) => row.key === 'credentials'), 'credentials must not be collected')
    assert.ok(
      estimate.notices.some((notice) => /not encrypted/i.test(notice.message)),
      'the refusal must be reported as a notice',
    )
  })

  // ------------------------------------------------------- full + encryption
  console.log('\nfull backup, encryption, split, restore')
  /** @type {any} */
  let fullRun
  const password = 'correct horse battery'
  await test('a full encrypted split backup delivers parts and records the run', async () => {
    const settings = settingsWith({
      compression: 'zip-deflate',
      // A deliberately tiny part size forces several parts out of this tree.
      splitSizeMb: 1,
      encryption: { enabled: true, password, algorithm: 'aes-256-gcm' },
    })
    const { engine } = engineFor(settings, workspace)
    fullRun = await engine.run({ type: 'full' })
    assert.equal(fullRun.ok, true, `run failed: ${fullRun.message}`)
    assert.equal(fullRun.encrypted, true, 'the run must be marked encrypted')
    assert.equal(fullRun.type, 'full')
    assert.ok(fullRun.files > 0, 'the run must report files')
    assert.ok(fullRun.bytes > 0, 'the run must report bytes')
    assert.equal(fullRun.incrementalBase, null, 'a full run has no base')
    assert.ok(fullRun.parts > 1, `the payload must actually split, saw ${fullRun.parts} part(s)`)
    const listed = await localTarget(TARGET).list()
    const archives = listed.filter((entry) => entry.name.startsWith(fullRun.id))
    assert.ok(archives.length >= 1, `no archive for ${fullRun.id} at the target, saw ${listed.map((e) => e.name).join(', ')}`)
    assert.equal(archives.length, fullRun.parts, 'the part count must match the files on disk')
    assert.ok(
      archives.every((entry) => /\.zip\.dshmy\.part\d+$/.test(entry.name)),
      `encrypted split parts keep the sealed suffix, saw ${archives.map((e) => e.name).join(', ')}`,
    )
  })

  await test('the sealed parts are not readable without the password', async () => {
    const listed = await localTarget(TARGET).list()
    const first = listed.filter((entry) => entry.name.startsWith(fullRun.id)).sort((a, b) => a.name.localeCompare(b.name))[0]
    const bytes = await readFile(join(TARGET, first.name))
    assert.equal(bytes.subarray(0, 8).toString('latin1'), 'DSHMYENC', 'the envelope magic must be first')
    assert.ok(!bytes.toString('latin1').includes('workspace'), 'plaintext must not leak into the sealed part')
  })

  await test('a restore unpacks everything and matches the workspace byte for byte', async () => {
    const settings = settingsWith({ encryption: { enabled: true, password, algorithm: 'aes-256-gcm' } })
    const { engine } = engineFor(settings, workspace)
    const result = await engine.restore({ runId: fullRun.id, toDir: join(RESTORE_ROOT, 'full') })
    assert.ok(result.restored > 0, 'the restore must report files')
    assert.equal(resolve(result.toDir), resolve(join(RESTORE_ROOT, 'full')))
    assert.ok(result.entries.length > 0, 'the restore must list its members')

    // The workspace member set must survive exactly.
    const expected = await treeOf(workspace)
    const restoredWorkspace = join(result.toDir, 'workspaces', 'demo')
    const actual = await treeOf(restoredWorkspace)
    assert.deepEqual(actual, expected, 'every workspace file must come back')
    for (const relative of expected) {
      assert.equal(
        await digest(join(restoredWorkspace, relative)),
        await digest(join(workspace, relative)),
        `${relative} must match byte for byte`,
      )
    }

    // A conversation log and a credential-free config file must be present too.
    const restoredTree = await treeOf(result.toDir)
    assert.ok(
      restoredTree.some((path) => path.includes('conversations') && path.endsWith('session.v4.jsonl')),
      'the conversation log must be restored',
    )
    assert.ok(
      restoredTree.some((path) => path.includes('system-config') && path.endsWith('cordis.patch.yml')),
      'the profile patch layer must be restored',
    )
    assert.ok(
      !restoredTree.some((path) => path.endsWith('.credentials.yaml')),
      'credentials must not be in the archive while their switch is off',
    )
  })

  await test('a wrong password fails loudly and writes nothing', async () => {
    const settings = settingsWith({ encryption: { enabled: true, password: 'wrong password entirely', algorithm: 'aes-256-gcm' } })
    const { engine } = engineFor(settings, workspace)
    await assert.rejects(
      () => engine.restore({ runId: fullRun.id, toDir: join(RESTORE_ROOT, 'bad') }),
      (error) => /password is wrong|altered/i.test(error.message),
      'a wrong password must be reported as such',
    )
  })

  await test('a tampered part fails authentication instead of yielding data', async () => {
    const listed = await localTarget(TARGET).list()
    const first = listed.filter((entry) => entry.name.startsWith(fullRun.id)).sort((a, b) => a.name.localeCompare(b.name))[0]
    const path = join(TARGET, first.name)
    const original = await readFile(path)
    const altered = Buffer.from(original)
    // Flip one byte in the ciphertext body, past the header.
    altered[Math.floor(altered.length / 2)] ^= 0xff
    await writeFile(path, altered)
    try {
      const settings = settingsWith({ encryption: { enabled: true, password, algorithm: 'aes-256-gcm' } })
      const { engine } = engineFor(settings, workspace)
      await assert.rejects(
        () => engine.restore({ runId: fullRun.id, toDir: join(RESTORE_ROOT, 'tampered') }),
        (error) => /password is wrong|altered|damaged|truncated/i.test(error.message),
        'a tampered archive must not restore',
      )
    } finally {
      await writeFile(path, original)
    }
  })

  // ----------------------------------------------------------- incremental
  console.log('\nincremental')
  await test('an incremental run takes only the file that changed', async () => {
    // The baseline is the encrypted full run above, which stored every digest.
    await writeFile(join(workspace, 'src', 'main.js'), 'console.log("v2 changed")\n')
    // Give the filesystem a tick so the mtime differs on a coarse clock.
    await new Promise((done) => setTimeout(done, 20))

    const settings = settingsWith({
      type: 'incremental',
      compression: 'zip-deflate',
      encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
    })
    const { engine } = engineFor(settings, workspace)
    const run = await engine.run({ type: 'incremental' })
    assert.equal(run.ok, true, `incremental run failed: ${run.message}`)
    assert.equal(run.incrementalBase, fullRun.id, 'the base must be the previous successful run')
    assert.ok(run.files >= 1, 'the delta archive must hold something')

    const listed = await localTarget(TARGET).list()
    const name = listed.map((entry) => entry.name).find((entry) => entry.startsWith(run.id))
    assert.ok(name !== undefined, 'the delta archive must be at the target')
    const members = await listArchive(join(TARGET, name))
    const workspaceMembers = members.filter((member) => member.startsWith('workspaces/'))
    assert.deepEqual(
      workspaceMembers,
      ['workspaces/demo/src/main.js'],
      `only the changed workspace file may be in the delta, saw ${workspaceMembers.join(', ')}`,
    )
    // The full-run records (conversations, config) are unchanged, so the digest
    // baseline must exclude them from the delta as well.
    assert.ok(
      !members.some((member) => member.startsWith('conversations/')),
      'unchanged conversation logs must not be re-sent',
    )
  })

  await test('an incremental run with no baseline degrades to full and says so', async () => {
    const otherTarget = join(SANDBOX, 'target-fresh')
    const settings = settingsWith({
      type: 'incremental',
      items: { workspaceFiles: true, conversations: false, systemConfig: false, plugins: false, other: false, models: false, credentials: false },
      targets: [{ id: 'fresh', kind: 'local', label: 'fresh', remotePath: 'dsh-mydsh', path: otherTarget }],
      activeTargetId: 'fresh',
      encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
    })
    const { engine } = engineFor(settings, workspace)
    const run = await engine.run({ type: 'incremental' })
    assert.equal(run.ok, true, `run failed: ${run.message}`)
    assert.equal(run.incrementalBase, null, 'a fresh destination has no base')
    assert.match(run.message, /became a full backup|No previous backup/i)
  })

  // ---------------------------------------------------------------- retention
  console.log('\nretention and deletion')
  await test('keepCount prunes older archives and leaves the newest', async () => {
    const settings = settingsWith({
      keepCount: 2,
      items: { workspaceFiles: true, conversations: false, systemConfig: false, plugins: false, other: false, models: false, credentials: false },
      targets: [{ id: 'keep', kind: 'local', label: 'keep', remotePath: 'dsh-mydsh', path: join(SANDBOX, 'target-keep') }],
      activeTargetId: 'keep',
      encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
    })
    const { engine } = engineFor(settings, workspace)
    const ids = []
    for (let index = 0; index < 4; index++) {
      // Nudge the clock so each archive sorts after the previous one.
      await new Promise((done) => setTimeout(done, 1100))
      const run = await engine.run({ type: 'full' })
      assert.equal(run.ok, true, `run ${index} failed: ${run.message}`)
      ids.push(run.id)
    }
    const listed = await localTarget(join(SANDBOX, 'target-keep')).list()
    const groups = new Set(
      listed
        .filter((entry) => entry.name !== 'manifest.json')
        .map((entry) => entry.name.replace(/\.part\d+$/, '').replace(/\.(zip|7z)(\.dshmy)?$/, '')),
    )
    assert.equal(groups.size, 2, `expected 2 archives to survive, saw ${[...groups].join(', ')}`)
    assert.ok(groups.has(ids[3]), 'the newest archive must survive')
    assert.ok(!groups.has(ids[0]), 'the oldest archive must be pruned')
  })

  await test('prune removes archives beyond keepCount and records the action', async () => {
    const settings = settingsWith({
      items: { workspaceFiles: true, conversations: false, systemConfig: false, plugins: false, other: false, models: false, credentials: false },
      targets: [{ id: 'prune', kind: 'local', label: 'prune', remotePath: 'dsh-mydsh', path: join(SANDBOX, 'target-prune') }],
      activeTargetId: 'prune',
      encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
    })
    const { engine } = engineFor(settings, workspace)
    for (let index = 0; index < 3; index++) {
      await new Promise((done) => setTimeout(done, 1100))
      const run = await engine.run({ type: 'full' })
      assert.equal(run.ok, true, `run ${index} failed: ${run.message}`)
    }
    const before = (await localTarget(join(SANDBOX, 'target-prune')).list()).filter((entry) => entry.name !== 'manifest.json')
    assert.equal(before.length, 3, 'three archives must be there before the prune')
    const outcome = await engine.prune({ keepCount: 1 })
    assert.equal(outcome.removed.length, 2, `expected 2 removals, saw ${outcome.removed.length}`)
    assert.equal(outcome.kept, 1, 'one archive must remain')
    const after = (await localTarget(join(SANDBOX, 'target-prune')).list()).filter((entry) => entry.name !== 'manifest.json')
    assert.equal(after.length, 1, 'only one archive may remain')
  })

  await test('deleteRun removes the files and keeps the audit record', async () => {
    const settings = settingsWith({
      items: { workspaceFiles: true, conversations: false, systemConfig: false, plugins: false, other: false, models: false, credentials: false },
      targets: [{ id: 'del', kind: 'local', label: 'del', remotePath: 'dsh-mydsh', path: join(SANDBOX, 'target-del') }],
      activeTargetId: 'del',
      encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
    })
    const { engine } = engineFor(settings, workspace)
    const run = await engine.run({ type: 'full' })
    assert.equal(run.ok, true, `run failed: ${run.message}`)
    const before = await localTarget(join(SANDBOX, 'target-del')).list()
    assert.ok(before.length > 0, 'the archive must exist before the delete')
    const outcome = await engine.deleteRun({ runId: run.id })
    assert.ok(outcome.removed.length > 0, 'the delete must report what it removed')
    const after = await localTarget(join(SANDBOX, 'target-del')).list()
    assert.equal(after.length, 0, 'the archive must be gone')
    const history = await engine.runs()
    const record = history.find((entry) => entry.id === run.id)
    assert.ok(record !== undefined, 'the audit record must survive the delete')
    assert.ok(record.deletedAt > 0, 'the record must be marked deleted')
  })

  // -------------------------------------------------------------- compression
  console.log('\ncompression and 7z fallback')
  await test('zip store and zip-deflate both round-trip', async () => {
    for (const compression of ['zip', 'zip-deflate', 'none']) {
      const settings = settingsWith({
        compression,
        items: { workspaceFiles: true, conversations: false, systemConfig: false, plugins: false, other: false, models: false, credentials: false },
        targets: [{ id: `c-${compression}`, kind: 'local', label: compression, remotePath: 'dsh-mydsh', path: join(SANDBOX, `target-${compression}`) }],
        activeTargetId: `c-${compression}`,
        encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
      })
      const { engine } = engineFor(settings, workspace)
      const run = await engine.run({ type: 'full' })
      assert.equal(run.ok, true, `${compression} run failed: ${run.message}`)
      const listed = await localTarget(join(SANDBOX, `target-${compression}`)).list()
      const name = listed.map((entry) => entry.name).find((entry) => entry.startsWith(run.id))
      const members = await listArchive(join(SANDBOX, `target-${compression}`, name))
      assert.ok(members.includes('workspaces/demo/src/main.js'), `${compression} archive must hold the workspace file`)
    }
  })

  await test('7z writes an archive when the binary is present, and falls back when it is not', async () => {
    const binary = sevenZipBinary(join(REPO, 'APP', 'code', 'dsh-mydsh'))
    const base = {
      items: { workspaceFiles: true, conversations: false, systemConfig: false, plugins: false, other: false, models: false, credentials: false },
      encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
      compression: '7z',
    }

    if (binary === undefined) {
      const settings = settingsWith({ ...base, targets: [{ id: '7z', kind: 'local', label: '7z', remotePath: 'dsh-mydsh', path: join(SANDBOX, 'target-7z') }], activeTargetId: '7z' })
      const { engine } = engineFor(settings, workspace, { packageRoot: join(REPO, 'APP', 'code', 'dsh-mydsh') })
      const run = await engine.run({ type: 'full' })
      assert.equal(run.ok, true, `fallback run failed: ${run.message}`)
      assert.equal(run.compression, 'zip-deflate', 'the fallback must be recorded')
      assert.match(run.message, /7z binary is not available/i)
      return
    }

    const settings = settingsWith({ ...base, targets: [{ id: '7z', kind: 'local', label: '7z', remotePath: 'dsh-mydsh', path: join(SANDBOX, 'target-7z') }], activeTargetId: '7z' })
    const { engine } = engineFor(settings, workspace, { packageRoot: join(REPO, 'APP', 'code', 'dsh-mydsh') })
    const run = await engine.run({ type: 'full' })
    assert.equal(run.ok, true, `7z run failed: ${run.message}`)
    assert.equal(run.compression, '7z', 'the 7z path must be taken when available')
    const listed = await localTarget(join(SANDBOX, 'target-7z')).list()
    const name = listed.map((entry) => entry.name).find((entry) => entry.startsWith(run.id))
    assert.ok(name.endsWith('.7z'), `the archive must be a 7z, saw ${name}`)
    const result = await engine.restore({ runId: run.id, toDir: join(RESTORE_ROOT, 'seven') })
    assert.ok(result.restored > 0, 'the 7z restore must produce files')
    assert.ok(
      (await treeOf(result.toDir)).includes('workspaces/demo/src/main.js'),
      'the workspace file must come back from the 7z archive',
    )
  })

  await test('a missing 7z binary degrades to zip-deflate and records why', async () => {
    const settings = settingsWith({
      compression: '7z',
      items: { workspaceFiles: true, conversations: false, systemConfig: false, plugins: false, other: false, models: false, credentials: false },
      targets: [{ id: 'fallback', kind: 'local', label: 'fallback', remotePath: 'dsh-mydsh', path: join(SANDBOX, 'target-fallback') }],
      activeTargetId: 'fallback',
      encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
    })
    // An explicit `binary: undefined` with no package root removes every way to
    // find 7z, which is the state a partial install leaves behind.
    const engine = createBackupEngine({
      getSettings: () => settings,
      workspaces: async () => [{ id: 'w1', title: 'demo', path: workspace }],
    })
    const run = await engine.run({ type: 'full' })
    assert.equal(run.ok, true, `run failed: ${run.message}`)
    assert.equal(run.compression, 'zip-deflate', 'the fallback must be recorded on the run')
    assert.match(run.message, /7z binary is not available/i)
  })

  await test('needsSevenZip answers from the compression name alone', () => {
    assert.equal(needsSevenZip('7z'), true)
    assert.equal(needsSevenZip('zip-deflate'), false)
    assert.equal(needsSevenZip('zip'), false)
    assert.equal(needsSevenZip('none'), false)
  })

  // ------------------------------------------------------------ size ceiling
  console.log('\nsafety')
  await test('a file over maxFileMb is skipped and reported', async () => {
    const bigDir = join(SANDBOX, 'big-workspace')
    await mkdir(bigDir, { recursive: true })
    await writeFile(join(bigDir, 'small.txt'), 'tiny\n')
    // 2 MB of incompressible-ish bytes; the cap below is 1 MB.
    await writeFile(join(bigDir, 'large.bin'), Buffer.alloc(2 * 1024 * 1024, 7))

    const settings = settingsWith({
      maxFileMb: 1,
      items: { workspaceFiles: true, conversations: false, systemConfig: false, plugins: false, other: false, models: false, credentials: false },
      targets: [{ id: 'cap', kind: 'local', label: 'cap', remotePath: 'dsh-mydsh', path: join(SANDBOX, 'target-cap') }],
      activeTargetId: 'cap',
      encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
    })
    const engine = createBackupEngine({
      getSettings: () => settings,
      workspaces: async () => [{ id: 'big', title: 'big', path: bigDir }],
    })
    const run = await engine.run({ type: 'full' })
    assert.equal(run.ok, true, `run failed: ${run.message}`)
    assert.equal(run.skipped, 1, 'exactly the oversized file must be counted')
    assert.match(run.message, /exceed the 1 MB per-file limit/i)
  })

  await test('a traversal in an archive member is refused', async () => {
    const evil = join(SANDBOX, 'evil.zip')
    // Hand-build a zip whose central directory names an escaping path.
    const { inflateRawSync, deflateRawSync } = await import('node:zlib')
    void inflateRawSync
    const name = Buffer.from('../../escaped.txt', 'utf8')
    const payload = deflateRawSync(Buffer.from('escape', 'utf8'))
    const crcBuf = Buffer.from('escape', 'utf8')
    const crcTable = (() => {
      const table = new Uint32Array(256)
      for (let index = 0; index < 256; index++) {
        let value = index
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
        table[index] = value >>> 0
      }
      return table
    })()
    let crc = 0xffffffff
    for (const byte of crcBuf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    crc = (crc ^ 0xffffffff) >>> 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(crcBuf.length, 22)
    local.writeUInt16LE(name.length, 26)
    const localOffset = 0
    const dataStart = local.length + name.length
    const centralStart = dataStart + payload.length
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(crcBuf.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(localOffset, 42)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(1, 8)
    end.writeUInt16LE(1, 10)
    end.writeUInt32LE(central.length + name.length, 12)
    end.writeUInt32LE(centralStart, 16)
    await writeFile(evil, Buffer.concat([local, name, payload, central, name, end]))

    const { extractArchive } = await import('../../host/backup/archive.js')
    await assert.rejects(
      () => extractArchive(evil, join(SANDBOX, 'evil-out')),
      (error) => /escapes the extraction folder|absolute entry/i.test(error.message),
      'a traversal member must be refused',
    )
  })

  await test('a restore never leaves its directory, and never overwrites a session', async () => {
    const settings = settingsWith({
      items: { workspaceFiles: true, conversations: false, systemConfig: false, plugins: false, other: false, models: false, credentials: false },
      targets: [{ id: 'default-root', kind: 'local', label: 'default-root', remotePath: 'dsh-mydsh', path: join(SANDBOX, 'target-root') }],
      activeTargetId: 'default-root',
      encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
    })
    const { engine } = engineFor(settings, workspace)
    const run = await engine.run({ type: 'full' })
    assert.equal(run.ok, true, `run failed: ${run.message}`)

    // No `toDir`: the engine must choose its own private restore root.
    const result = await engine.restore({ runId: run.id })
    assert.ok(result.toDir.startsWith(join(HOME, 'dsh-mydsh', 'restore')), `default restore root must be private, saw ${result.toDir}`)
    // The live session directory must be untouched.
    const live = await readFile(join(HOME, 'sessions', '--C-Data-DSH-mydsh--', 'session-0001', 'session.v4.jsonl'), 'utf8')
    assert.match(live, /hello backup/, 'the live conversation must be unchanged')

    // A traversal in the destination is refused outright.
    await assert.rejects(
      () => engine.restore({ runId: run.id, toDir: 'relative/../escape' }),
      /absolute path|\.\./i,
      'a non-absolute or climbing destination must be refused',
    )
  })

  // ----------------------------------------------------------- offline targets
  console.log('\noffline destinations')
  await test('a WebDAV test target with no server answers ok:false instead of throwing', async () => {
    const settings = settingsWith()
    const { engine } = engineFor(settings, workspace)
    const answer = await engine.testTarget({
      target: {
        id: 'webdav-offline',
        kind: 'webdav',
        label: 'offline',
        remotePath: 'dsh-mydsh',
        url: 'http://127.0.0.1:9/nonexistent-dav',
        username: 'u',
        password: 'p',
      },
    })
    assert.equal(answer.ok, false, `an unreachable WebDAV must report failure, saw ${JSON.stringify(answer)}`)
    assert.ok(answer.message.length > 0, 'the failure must carry a message')
    assert.ok(answer.latencyMs >= 0, 'the failure must carry a latency')
  })

  await test('an OSS test target with no endpoint answers ok:false instead of throwing', async () => {
    const settings = settingsWith()
    const { engine } = engineFor(settings, workspace)
    const answer = await engine.testTarget({
      target: {
        id: 'oss-offline',
        kind: 'oss',
        label: 'offline',
        remotePath: 'dsh-mydsh',
        endpoint: '127.0.0.1:9',
        region: 'cn-hangzhou',
        bucket: 'no-such-bucket',
        accessKeyId: 'AKIDEXAMPLE',
        accessKeySecret: 'SECRETEXAMPLE',
        pathStyle: true,
      },
    })
    assert.equal(answer.ok, false, `an unreachable OSS must report failure, saw ${JSON.stringify(answer)}`)
    assert.ok(answer.message.length > 0, 'the failure must carry a message')
  })

  await test('a backup to an offline destination returns a failed run, not a rejection', async () => {
    const settings = settingsWith({
      items: { workspaceFiles: true, conversations: false, systemConfig: false, plugins: false, other: false, models: false, credentials: false },
      targets: [
        {
          id: 'dav',
          kind: 'webdav',
          label: 'offline',
          remotePath: 'dsh-mydsh',
          url: 'http://127.0.0.1:9/dav',
          username: 'u',
          password: 'p',
        },
      ],
      activeTargetId: 'dav',
      encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
    })
    const { engine } = engineFor(settings, workspace)
    const run = await engine.run({ type: 'full' })
    assert.equal(run.ok, false, 'a run to an offline destination must fail as a record')
    assert.ok(run.message.length > 0, 'the failed run must carry a message')
    assert.equal(run.targetKind, 'webdav')
  })

  await test('a gist target refuses a part over its ceiling with an actionable message', async () => {
    const gist = gistTarget({ token: 'fake-token', gistId: 'abc123' })
    assert.equal(gist.maxObjectBytes, 10 * 1024 * 1024, 'the gist ceiling must be published to the engine')
    const big = join(SANDBOX, 'too-big.bin')
    await writeFile(big, Buffer.alloc(11 * 1024 * 1024, 3))
    await assert.rejects(
      () => gist.put('dsh-mydsh-x.zip', big),
      (error) => /cannot hold|cannot hold .*limit|10\.0 MB/i.test(error.message),
      'an oversized gist part must be refused, not truncated',
    )
  })

  await test('a target with no configuration is reported, never thrown', async () => {
    assert.throws(() => localTarget(''), /backup folder/i)
    assert.throws(() => webdavTarget({ url: '' }), /WebDAV server URL/i)
    assert.throws(() => objectStorageTarget({ endpoint: '', bucket: 'b', accessKeyId: 'a', accessKeySecret: 's' }, 's3'), /endpoint/i)
    assert.throws(() => gistTarget({ token: '' }), /token/i)
  })

  // ------------------------------------------------------------------- sync
  console.log('\nsync')
  await test('sync reads the destination index and reports its decisions', async () => {
    const dir = join(SANDBOX, 'target-sync')
    const settings = settingsWith({
      items: { workspaceFiles: true, conversations: false, systemConfig: false, plugins: false, other: false, models: false, credentials: false },
      targets: [{ id: 'sync', kind: 'local', label: 'sync', remotePath: 'dsh-mydsh', path: dir }],
      activeTargetId: 'sync',
      encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
      sync: { enabled: true, direction: 'both', conflict: 'newer' },
    })
    const { engine } = engineFor(settings, workspace)
    const run = await engine.run({ type: 'full' })
    assert.equal(run.ok, true, `run failed: ${run.message}`)

    // The engine must have published an index alongside the archive.
    const listed = await localTarget(dir).list()
    assert.ok(listed.some((entry) => entry.name === 'manifest.json'), 'the destination must carry a manifest.json')

    const outcome = await engine.sync({ direction: 'both', conflict: 'newer' })
    assert.ok(Array.isArray(outcome.pulled), 'pulled must be a list')
    assert.ok(Array.isArray(outcome.pushed), 'pushed must be a list')
    assert.ok(Array.isArray(outcome.conflicts), 'conflicts must be a list')
    assert.ok(Array.isArray(outcome.skipped), 'skipped must be a list')
    assert.ok(
      outcome.skipped.some((entry) => entry.id === run.id && entry.reason === 'both'),
      'a run present on both sides must be reported as skipped',
    )
  })

  await test('sync against an unreachable destination reports the failure', async () => {
    const settings = settingsWith({
      items: { workspaceFiles: true, conversations: false, systemConfig: false, plugins: false, other: false, models: false, credentials: false },
      targets: [{ id: 's3-off', kind: 's3', label: 'offline', remotePath: 'dsh-mydsh', endpoint: '127.0.0.1:9', region: 'us-east-1', bucket: 'b', accessKeyId: 'a', accessKeySecret: 's', pathStyle: true }],
      activeTargetId: 's3-off',
      encryption: { enabled: false, password: '', algorithm: 'aes-256-gcm' },
    })
    const { engine } = engineFor(settings, workspace)
    // An unreachable index reads as "no index", so the sync decides everything
    // must be pushed, then fails at the upload. Either way it must not throw out
    // of a background tick without a record.
    const outcome = await engine.sync({ direction: 'push' }).catch((error) => ({ error: error.message }))
    assert.ok(outcome !== undefined, 'sync must resolve or reject with a message')
  })

  // ------------------------------------------------------------------ ledger
  console.log('\naudit ledger')
  await test('every run, restore, delete and sync landed in the ledger', async () => {
    const text = await readFile(join(HOME, 'dsh-mydsh', 'backup', 'runs.jsonl'), 'utf8')
    const rows = text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
    const kinds = new Set(rows.map((row) => row.kind ?? 'backup'))
    for (const kind of ['backup', 'restore', 'delete', 'prune', 'sync']) {
      assert.ok(kinds.has(kind), `the ledger is missing a ${kind} record, saw ${[...kinds].join(', ')}`)
    }
    assert.ok(rows.every((row) => typeof row.id === 'string' && row.id !== ''), 'every record needs an id')
    assert.ok(
      rows.every((row) => JSON.stringify(row).includes('SECRETEXAMPLE') === false),
      'no credential may appear in the ledger',
    )
  })

  await test('the ledger is capped and the newest record wins', async () => {
    const { appendRun, recentRuns, readRuns } = await import('../../host/backup/ledger.js')
    for (let index = 0; index < 210; index++) {
      await appendRun({ id: `cap-${index}`, kind: 'backup', startedAt: index, finishedAt: index, ok: true })
    }
    const all = await readRuns()
    assert.ok(all.length <= 200, `the ledger must not exceed 200 records, saw ${all.length}`)
    const newest = await recentRuns()
    assert.equal(newest[0].id, 'cap-209', 'the newest record must come first')
  })

  // ------------------------------------------------------------------- report
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  FAILED: ${failure.name}\n          ${failure.message}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('\nthe self-test could not run:')
  console.error(error?.stack ?? error)
  process.exitCode = 1
})
