/**
 * Self-test for the capability modules.
 *
 * Scope: the degradation contract and the pure logic of each module. Nothing
 * here touches the network, the desktop, a real DOM or a real DSH profile — every
 * external edge is a fake object shaped like the service it replaces, so the suite
 * runs under `node` alone and cannot disturb the running Host.
 *
 * The two service states the contract cares about are covered explicitly:
 *  - *absent*: `ctx.get()` returns `undefined`. Every module must return a
 *    degraded result, and must not throw.
 *  - *present*: a fake with just the methods the module calls. The module must
 *    use it and produce the documented shape.
 *
 * Run with: node host/modules/selftest.mjs
 */

import assert from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDesktop, DESKTOP_CONTRACT } from '../../host/modules/desktop/index.js'
import { createImageGen, IMAGE_CONTRACT } from '../../host/modules/images/index.js'
import { createInsights, INSIGHT_CATALOG } from '../../host/modules/insights/index.js'
import { createConfigManager, CONFIG_CONTRACT } from '../../host/modules/config/index.js'
import { createMcpConnector, buildInitializeRequest, buildToolsListRequest, parseToolListResult, readJsonRpcResponse } from '../../host/modules/mcp/index.js'
import { createRoles, BUILT_IN_ROLES } from '../../host/modules/roles/index.js'
import { maskSecrets, mergeSecretPatch, safeSegment, withinDir, parseEnvText, parseHeaderText } from '../../host/modules/shared.js'

/**
 * One configuration-shaped value with every kind of field the masking rule has
 * to distinguish: a plain value, an empty secret, and a nested secret. The
 * credential-shaped values are obvious placeholders, not credentials.
 */
const MASK_SAMPLE = Object.freeze({
  apiKey: 'placeholder-not-a-real-key',
  token: 'placeholder',
  plain: 'kept',
  emptySecret: '',
  nested: { password: 'placeholder', model: 'm' },
})

/** The stored and typed credential placeholders used by the config tests. */
const STORED = 'placeholder-stored'
const TYPED = 'placeholder-typed'

let passed = 0
const failures = []

/** Register and run one check. */
async function test(name, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL  ${name}\n      ${error?.message ?? error}`)
  }
}

/** A context whose every service is missing. */
function absentCtx() {
  return { get: () => undefined }
}

/** A context that throws out of `get`, like a recycled fiber. */
function hostileCtx() {
  return {
    get() {
      throw new Error('fiber is disposed')
    },
  }
}

/** Build a context from a plain service table. */
function ctxWith(services) {
  return { get: (name) => services[name] }
}

/** Settings reader for one module slice. */
function settingsFor(key, value) {
  return () => ({ modules: { [key]: value } })
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'mydsh-modules-'))

  // ---------------------------------------------------------------- shared ---
  console.log('shared')

  await test('a path that escapes its base is refused', () => {
    const base = join(scratch, 'images')
    assert.equal(withinDir(base, 'ok.png'), join(base, 'ok.png'))
    assert.equal(withinDir(base, '../etc/passwd'), undefined)
    assert.equal(withinDir(base, 'a/../../b'), undefined)
  })

  await test('a file-name segment drops separators and control characters', () => {
    assert.equal(safeSegment('2026-11-16T12:00:00.000Z'), '2026-11-16T12-00-00-000Z')
    assert.equal(safeSegment('../../x'), 'x')
    assert.equal(safeSegment('   '), 'item')
    assert.equal(safeSegment('a/b\\c'), 'a-b-c')
  })

  await test('env and header textareas parse both accepted forms', () => {
    assert.deepEqual(parseEnvText('A=1\nB=2\n# comment\nBADLINE'), { A: '1', B: '2' })
    assert.deepEqual(parseEnvText('{"C":"3"}'), { C: '3' })
    assert.deepEqual(parseHeaderText('X-A: one\nX-B: two'), { 'X-A': 'one', 'X-B': 'two' })
    assert.deepEqual(parseHeaderText('{"X-C":"3"}'), { 'X-C': '3' })
  })

  await test('secret fields are masked, non-secret fields are not', () => {
    const masked = maskSecrets(MASK_SAMPLE)
    assert.equal(masked.apiKey, '***')
    assert.equal(masked.token, '***')
    assert.equal(masked.nested.password, '***')
    assert.equal(masked.plain, 'kept')
    assert.equal(masked.emptySecret, '')
  })

  await test('the *** sentinel keeps the stored value on write', () => {
    const merged = mergeSecretPatch({ apiKey: 'real', model: 'm1' }, { apiKey: '***', model: 'm2' })
    assert.equal(merged.value.apiKey, 'real')
    assert.equal(merged.value.model, 'm2')
    assert.equal(merged.changed, true)
    const untouched = mergeSecretPatch({ apiKey: 'real' }, { apiKey: '***' })
    assert.equal(untouched.changed, false)
    const replaced = mergeSecretPatch({ apiKey: 'real' }, { apiKey: 'new' })
    assert.equal(replaced.value.apiKey, 'new')
  })

  // ------------------------------------------------------------------ mcp ---
  console.log('mcp')

  await test('mcp: absent services degrade to rows without throwing', () => {
    for (const ctx of [absentCtx(), hostileCtx()]) {
      const mcp = createMcpConnector({ ctx, getSettings: settingsFor('mcpConnector', { enabled: true, servers: [] }) })
      assert.deepEqual(mcp.list(), [])
      // `apply()` answers the disposer list the Host keeps for its own teardown.
      assert.deepEqual(mcp.apply(), [])
      assert.equal(mcp.lastReport().ok, true)
    }
  })

  await test('mcp: rows merge settings and manager status', () => {
    const services = {
      mcpManager: {
        list: () => [{ name: 'fs', status: { state: 'connected', toolCount: 7 }, configured: true }],
        register: () => () => undefined,
      },
    }
    const settings = settingsFor('mcpConnector', {
      enabled: true,
      servers: [
        { id: 'a', name: 'fs', enabled: true, command: 'node', args: ['server.js'] },
        { id: 'b', name: 'web', enabled: true, url: 'https://example.test/mcp' },
        { id: 'c', name: 'off', enabled: false, command: 'node' },
      ],
    })
    const mcp = createMcpConnector({ ctx: ctxWith(services), getSettings: settings })
    const rows = mcp.list()
    assert.equal(rows.length, 3)
    assert.equal(rows[0].name, 'fs')
    assert.equal(rows[0].transport, 'stdio')
    assert.equal(rows[0].status, 'connected')
    assert.equal(rows[0].toolCount, 7)
    assert.equal(rows[1].transport, 'streamable-http')
    assert.equal(rows[1].status, 'unknown')
    assert.equal(rows[2].status, 'disabled')
  })

  await test('mcp: a failed status keeps its reason visible', () => {
    const services = {
      mcpManager: {
        list: () => [
          { name: 'bad', status: { state: 'failed', reason: 'reconnect-disabled', lastError: 'ECONNREFUSED' } },
          { name: 'cleanup', status: { state: 'failed', reason: 'cleanup' } },
        ],
      },
    }
    const mcp = createMcpConnector({
      ctx: ctxWith(services),
      getSettings: settingsFor('mcpConnector', {
        enabled: true,
        servers: [
          { id: 'a', name: 'bad', enabled: true, command: 'node' },
          { id: 'b', name: 'cleanup', enabled: true, command: 'node' },
        ],
      }),
    })
    const rows = mcp.list()
    assert.equal(rows[0].status, 'failed')
    assert.equal(rows[0].lastError, 'ECONNREFUSED')
    assert.match(rows[1].lastError, /cleanup/)
  })

  await test('mcp: apply registers enabled servers and withdraws on the next apply', () => {
    const registered = []
    const disposed = []
    const services = {
      mcpManager: {
        list: () => [],
        register: (name, entry) => {
          registered.push({ name, entry })
          return () => disposed.push(name)
        },
      },
    }
    const settings = settingsFor('mcpConnector', {
      enabled: true,
      servers: [
        { id: 'a', name: 'fs', enabled: true, command: 'node', args: ['x.js'], env: 'K=V' },
        { id: 'b', name: 'off', enabled: false, command: 'node' },
      ],
    })
    const mcp = createMcpConnector({ ctx: ctxWith(services), getSettings: settings })
    const disposers = mcp.apply()
    assert.equal(disposers.length, 1)
    assert.equal(mcp.lastReport().ok, true)
    assert.equal(registered.length, 1)
    assert.equal(registered[0].name, 'fs')
    assert.equal(registered[0].entry.transport, 'stdio')
    assert.deepEqual(registered[0].entry.env, { K: 'V' })
    // A cross-transport field must not be carried into the registration.
    assert.equal('url' in registered[0].entry, false)
    mcp.apply()
    assert.deepEqual(disposed, ['fs'])
  })

  await test('mcp: apply without a manager reports a structured failure', () => {
    const settings = settingsFor('mcpConnector', {
      enabled: true,
      servers: [{ id: 'a', name: 'fs', enabled: true, command: 'node' }],
    })
    const mcp = createMcpConnector({ ctx: absentCtx(), getSettings: settings })
    const disposers = mcp.apply()
    assert.deepEqual(disposers, [])
    const report = mcp.lastReport()
    assert.equal(report.ok, false)
    assert.match(report.message, /mcpManager/)
    assert.deepEqual(report.failed.map((row) => row.name), ['fs'])
    // The stored rows are still reported, with their status unknown: a failed
    // registration must not hide the configuration the user typed.
    assert.equal(report.servers.length, 1)
    assert.equal(report.servers[0].status, 'unknown')
  })

  await test('mcp: server names are normalised to the manager grammar', () => {
    const settings = settingsFor('mcpConnector', {
      enabled: true,
      servers: [
        { id: 'a', name: '我的 文件', enabled: true, command: 'node' },
        { id: 'b', name: 'x', enabled: true, command: 'node' },
        { id: 'c', name: 'x', enabled: true, command: 'node' },
      ],
    })
    const mcp = createMcpConnector({ ctx: absentCtx(), getSettings: settings })
    const names = mcp.list().map((row) => row.name)
    for (const name of names) assert.match(name, /^[A-Za-z0-9_-]{1,32}$/)
    assert.equal(new Set(names).size, names.length)
  })

  await test('mcp: initialize and tools/list payloads match the protocol', () => {
    const init = buildInitializeRequest(1)
    assert.equal(init.jsonrpc, '2.0')
    assert.equal(init.method, 'initialize')
    assert.equal(init.params.protocolVersion, '2025-06-18')
    assert.equal(init.params.clientInfo.name, 'dsh-mydsh')
    assert.deepEqual(buildToolsListRequest(2).params, {})
    assert.deepEqual(buildToolsListRequest(3, 'abc').params, { cursor: 'abc' })
  })

  await test('mcp: a tools/list result reduces to names and a cursor', () => {
    const parsed = parseToolListResult({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'read' }, { name: 'write' }, { nope: true }], nextCursor: 'page2' },
    })
    assert.deepEqual(parsed.toolNames, ['read', 'write'])
    assert.equal(parsed.nextCursor, 'page2')
    assert.deepEqual(parseToolListResult({ result: {} }).toolNames, [])
  })

  await test('mcp: a plain JSON answer decodes, and an error answer throws', async () => {
    const ok = await readJsonRpcResponse(fakeResponse({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 's' } } }))
    assert.equal(ok.result.serverInfo.name, 's')
    let message = ''
    try {
      await readJsonRpcResponse(fakeResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such method' } }))
    } catch (error) {
      message = String(error.message)
    }
    assert.match(message, /JSON-RPC error/)
    assert.match(message, /no such method/)
  })

  await test('mcp: an SSE answer decodes to the first result frame', async () => {
    const body = ['event: message', 'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a"}]}}', '', ''].join('\n')
    const decoded = await readJsonRpcResponse(fakeResponse(body, 'text/event-stream'))
    assert.equal(decoded.result.tools[0].name, 'a')
  })

  await test('mcp: an HTTP failure is reported with status and body', async () => {
    let message = ''
    try {
      await readJsonRpcResponse(fakeResponse('nope', 'text/plain', 500))
    } catch (error) {
      message = String(error.message)
    }
    assert.match(message, /HTTP 500/)
    assert.match(message, /nope/)
  })

  await test('mcp: test() against a missing server fails without throwing', async () => {
    const mcp = createMcpConnector({ ctx: absentCtx(), getSettings: settingsFor('mcpConnector', { enabled: true, servers: [] }) })
    const result = await mcp.test({ server: { name: 'nope' } })
    assert.equal(result.ok, false)
    assert.deepEqual(result.toolNames, [])
    assert.equal(typeof result.message, 'string')
  })

  await test('mcp: test() prefers the manager probe when it knows the server', async () => {
    const probed = []
    const services = {
      mcpManager: {
        register: () => () => undefined,
        probe: async (name) => {
          probed.push(name)
          return { ok: true, toolNames: ['a', 'b'], durationMs: 5, closeConfirmed: true }
        },
      },
    }
    const settingsobj = settingsFor('mcpConnector', {
      enabled: true,
      servers: [{ id: 'a', name: 'fs', enabled: true, command: 'node' }],
    })
    const mcp = createMcpConnector({ ctx: ctxWith(services), getSettings: settingsobj })
    const result = await mcp.test({ server: { name: 'fs' } })
    assert.equal(result.ok, true)
    assert.deepEqual(probed, ['fs'])
    assert.deepEqual(result.toolNames, ['a', 'b'])
  })

  // -------------------------------------------------------------- desktop ---
  console.log('desktop')

  await test('desktop: a non-Windows platform reports every capability false', () => {
    const desktop = createDesktop({
      ctx: absentCtx(),
      getSettings: settingsFor('desktop', { enabled: true, allowScreen: true, allowMouse: true, allowKeyboard: true }),
      dshHome: scratch,
      onNotice: () => undefined,
    })
    const view = desktop.capabilities()
    if (process.platform !== 'win32') {
      assert.equal(view.available, false)
      assert.match(view.reason, /Windows/)
      for (const key of ['capture', 'screenSize', 'mouse', 'keyboard', 'windows', 'focus']) {
        assert.equal(view.capabilities[key], false)
      }
    } else {
      // On Windows the same call covers the "enabled + allowed" path.
      assert.equal(view.available, true)
    }
  })

  await test('desktop: a disabled module refuses capture and every action', async () => {
    const notices = []
    const desktop = createDesktop({
      ctx: absentCtx(),
      getSettings: settingsFor('desktop', { enabled: false }),
      dshHome: scratch,
      onNotice: (notice) => notices.push(notice),
    })    // The refusal must come before any process starts, on every platform.
    const shot = await desktop.capture()
    assert.equal(shot.ok, false)
    assert.match(shot.message, /未启用|Windows/)
    const action = await desktop.action({ kind: 'click', x: 1, y: 1, confirm: true })
    assert.equal(action.ok, false)
    assert.match(action.message, /未启用|Windows/)
    // A refusal is reported to the notice sink so the UI can explain it.
    assert.ok(notices.length >= 2)
    assert.equal(notices[0].kind, 'desktop')
  })

  await test('desktop: keyboard off refuses type and key with the capability named', async () => {
    if (process.platform !== 'win32') return
    const desktop = createDesktop({
      ctx: absentCtx(),
      getSettings: settingsFor('desktop', { enabled: true, allowScreen: true, allowMouse: true, allowKeyboard: false, confirmEach: false }),
      dshHome: scratch,
      onNotice: () => undefined,
    })
    const typed = await desktop.action({ kind: 'type', text: 'hello' })
    assert.equal(typed.ok, false)
    assert.match(typed.message, /键盘/)
    const pressed = await desktop.action({ kind: 'key', key: 'ctrl+a' })
    assert.equal(pressed.ok, false)
    assert.match(pressed.message, /键盘/)
  })

  await test('desktop: mouse off refuses move, click and scroll', async () => {
    if (process.platform !== 'win32') return
    const desktop = createDesktop({
      ctx: absentCtx(),
      getSettings: settingsFor('desktop', { enabled: true, allowScreen: true, allowMouse: false, allowKeyboard: true, confirmEach: false }),
      dshHome: scratch,
      onNotice: () => undefined,
    })
    for (const kind of ['move', 'click', 'scroll']) {
      const result = await desktop.action({ kind, x: 1, y: 1, delta: 120 })
      assert.equal(result.ok, false)
      assert.match(result.message, /鼠标/)
    }
  })

  await test('desktop: confirmEach turns a mutating action into a two-step call', async () => {
    if (process.platform !== 'win32') return
    const desktop = createDesktop({
      ctx: absentCtx(),
      getSettings: settingsFor('desktop', { enabled: true, allowScreen: true, allowMouse: true, allowKeyboard: true, confirmEach: true }),
      dshHome: scratch,
      onNotice: () => undefined,
    })
    const refused = await desktop.action({ kind: 'move', x: 10, y: 20 })
    assert.equal(refused.ok, false)
    assert.match(refused.message, /确认/)
  })

  await test('desktop: unknown kinds, bad coordinates and bad keys are refused locally', async () => {
    if (process.platform !== 'win32') return
    const desktop = createDesktop({
      ctx: absentCtx(),
      getSettings: settingsFor('desktop', { enabled: true, allowScreen: true, allowMouse: true, allowKeyboard: true, confirmEach: false }),
      dshHome: scratch,
      onNotice: () => undefined,
    })
    const unknown = await desktop.action({ kind: 'powershell', command: 'rm -rf /' })
    assert.equal(unknown.ok, false)
    assert.match(unknown.message, /不支持的指令类型/)
    const badCoord = await desktop.action({ kind: 'move', x: 'left', y: 1 })
    assert.equal(badCoord.ok, false)
    assert.match(badCoord.message, /坐标必须是数字/)
    const badKey = await desktop.action({ kind: 'key', key: 'win+r' })
    assert.equal(badKey.ok, false)
    assert.match(badKey.message, /不支持的修饰键|不支持的键名/)
    const longText = await desktop.action({ kind: 'type', text: 'x'.repeat(5000) })
    assert.equal(longText.ok, false)
    assert.match(longText.message, /不能超过/)
  })

  await test('desktop: the accepted vocabulary is closed', () => {
    assert.deepEqual(DESKTOP_CONTRACT.KINDS.slice().sort(), ['capture', 'click', 'focus', 'key', 'move', 'scroll', 'type', 'windows'])
    assert.ok(DESKTOP_CONTRACT.VIRTUAL_KEYS.includes('enter'))
    // The Windows key is not reachable: Win+R/L/X leave the desktop surface.
    assert.ok(!DESKTOP_CONTRACT.VIRTUAL_KEYS.includes('win'))
    assert.ok(!DESKTOP_CONTRACT.MODIFIERS.includes('win'))
    assert.deepEqual(DESKTOP_CONTRACT.BUTTONS.slice().sort(), ['left', 'middle', 'right'])
  })

  // --------------------------------------------------------------- images ---
  console.log('images')

  await test('images: an unconfigured module refuses with a reason', async () => {
    const images = createImageGen({ ctx: absentCtx(), getSettings: () => ({ modules: { imageGen: {} } }), dshHome: scratch })
    const result = await images.generate({ prompt: 'a cat' })
    assert.equal(result.ok, false)
    assert.match(result.message, /未启用/)
  })

  await test('images: deepseek is refused without inventing an endpoint', async () => {
    const images = createImageGen({
      ctx: absentCtx(),
      getSettings: settingsFor('imageGen', { enabled: true, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'placeholder' }),
      dshHome: scratch,
    })
    assert.equal(images.availability().available, false)
    const result = await images.generate({ prompt: 'a cat' })
    assert.equal(result.ok, false)
    assert.match(result.message, /DeepSeek 官方暂未提供图像生成接口/)
  })

  await test('images: the request body is exactly the OpenAI-compatible shape', () => {
    const images = createImageGen({
      ctx: absentCtx(),
      getSettings: settingsFor('imageGen', { enabled: true, provider: 'openai-compatible', baseUrl: 'https://gw.test/v1', apiKey: 'placeholder', model: 'gpt-image-1' }),
      dshHome: scratch,
    })
    const body = images.requestBody({ prompt: 'a cat', count: 2, size: '1024x1024', model: 'gpt-image-1' })
    assert.deepEqual(Object.keys(body).sort(), ['model', 'n', 'prompt', 'response_format', 'size'])
    assert.equal(body.response_format, 'b64_json')
    assert.equal(body.n, 2)
  })

  await test('images: the endpoint builder accepts every configured base form', () => {
    assert.equal(IMAGE_CONTRACT.endpointOf('https://gw.test', 'images/generations'), 'https://gw.test/v1/images/generations')
    assert.equal(IMAGE_CONTRACT.endpointOf('https://gw.test/v1', 'images/generations'), 'https://gw.test/v1/images/generations')
    assert.equal(IMAGE_CONTRACT.endpointOf('https://gw.test/v1/', 'images/generations'), 'https://gw.test/v1/images/generations')
    assert.equal(IMAGE_CONTRACT.endpointOf('https://gw.test/openai/v1', 'images/generations'), 'https://gw.test/openai/v1/images/generations')
    // A non-http scheme is not a usable endpoint.
    assert.equal(IMAGE_CONTRACT.endpointOf('file:///c:/x', 'images/generations'), '')
    assert.equal(IMAGE_CONTRACT.endpointOf('not a url', 'images/generations'), '')
  })

  await test('images: a fake fetch receives the documented request and the file lands on disk', async () => {
    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        async text() {
          // 1x1 transparent PNG.
          return JSON.stringify({
            data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' }],
          })
        },
      }
    }
    try {
      const home = join(scratch, 'images-home')
      const images = createImageGen({
        ctx: absentCtx(),
        getSettings: settingsFor('imageGen', {
          enabled: true,
          provider: 'openai-compatible',
          baseUrl: 'https://gw.test/v1',
          apiKey: 'placeholder-api-key',
          model: 'gpt-image-1',
          size: '512x512',
          count: 1,
        }),
        dshHome: home,
      })
      const result = await images.generate({ prompt: 'a cat', count: 1 })
      assert.equal(result.ok, undefined)
      assert.equal(result.images.length, 1)
      assert.equal(result.images[0].mime, 'image/png')
      assert.match(result.images[0].url, /^\/api\/mydsh\/images\/file\?name=/)
      const bytes = await readFile(result.images[0].path)
      assert.ok(bytes.length > 0)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://gw.test/v1/images/generations')
      assert.equal(calls[0].init.headers.authorization, 'Bearer placeholder-api-key')
      const sent = JSON.parse(calls[0].init.body)
      assert.equal(sent.prompt, 'a cat')
      assert.equal(sent.n, 1)
      assert.equal(sent.size, '512x512')
      assert.equal(sent.response_format, 'b64_json')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('images: a url answer is fetched and stored, and a data: url is decoded', async () => {
    const calls = []
    const originalFetch = globalThis.fetch
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      if (String(url).includes('/v1/images/generations')) {
        return {
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          async text() {
            return JSON.stringify({ data: [{ url: 'https://cdn.test/a.png' }] })
          },
        }
      }
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/octet-stream']]),
        async arrayBuffer() {
          return png
        },
      }
    }
    try {
      const images = createImageGen({
        ctx: absentCtx(),
        getSettings: settingsFor('imageGen', { enabled: true, provider: 'openai-compatible', baseUrl: 'https://gw.test', apiKey: 'k' }),
        dshHome: join(scratch, 'images-url'),
      })
      const result = await images.generate({ prompt: 'a cat' })
      assert.equal(result.images.length, 1)
      // Sniffed from the bytes, not from the (wrong) declared content type.
      assert.equal(result.images[0].mime, 'image/png')
      assert.deepEqual(calls, ['https://gw.test/v1/images/generations', 'https://cdn.test/a.png'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('images: an empty prompt and an over-limit count are refused', async () => {
    const images = createImageGen({
      ctx: absentCtx(),
      getSettings: settingsFor('imageGen', { enabled: true, provider: 'openai-compatible', baseUrl: 'https://gw.test', count: 9 }),
      dshHome: scratch,
    })
    assert.equal((await images.generate({ prompt: '' })).ok, false)
    assert.equal((await images.generate({ prompt: 'x'.repeat(9000) })).ok, false)
  })

  await test('images: an upstream HTTP error is reported, not thrown', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Map([['content-type', 'application/json']]),
      async text() {
        return '{"error":{"message":"rate limited"}}'
      },
    })
    try {
      const images = createImageGen({
        ctx: absentCtx(),
        getSettings: settingsFor('imageGen', { enabled: true, provider: 'openai-compatible', baseUrl: 'https://gw.test', apiKey: 'placeholder' }),
        dshHome: scratch,
      })
      const result = await images.generate({ prompt: 'a cat' })
      assert.equal(result.ok, false)
      assert.match(result.message, /429/)
      assert.match(result.message, /rate limited/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  // ---------------------------------------------------------------- roles ---
  console.log('roles')

  await test('roles: the built-in library is complete and original-shaped', () => {
    assert.ok(BUILT_IN_ROLES.length >= 24, `expected >= 24 roles, got ${String(BUILT_IN_ROLES.length)}`)
    const ids = new Set()
    const departments = new Set()
    const required = [
      '前端', '后端', '架构', '数据', '安全', '测试', '运维', '产品', '设计', '文案', '法务',
      '财务', '数据分析', 'AI 工程', '移动端', '嵌入式', '游戏', '算法', '数据库', '性能',
      '可访问性', '国际化', '文档', '项目管理',
    ]
    for (const role of BUILT_IN_ROLES) {
      assert.match(role.id, /^role-[a-z0-9-]+$/)
      assert.ok(role.name.length > 0)
      assert.ok(role.department.length > 0)
      assert.ok(role.summary.length > 0)
      // The prompt is a behavioural block: 3-6 substantial lines.
      const lines = role.prompt.split('\n').filter((line) => line.trim() !== '')
      assert.ok(lines.length >= 3 && lines.length <= 6, `${role.id} has ${String(lines.length)} prompt lines`)
      assert.ok(role.prompt.length <= 8000)
      assert.ok(!ids.has(role.id), `duplicate id ${role.id}`)
      ids.add(role.id)
      departments.add(role.department)
    }
    for (const department of required) {
      assert.ok(departments.has(department), `missing department ${department}`)
    }
  })

  await test('roles: list merges built-ins with custom roles and dedupes departments', () => {
    const roles = createRoles({
      ctx: absentCtx(),
      getSettings: settingsFor('roles', {
        enabled: true,
        customRoles: [
          { id: 'custom-1', name: '我的专家', department: '前端', summary: 'x', prompt: 'p', enabled: true },
          { id: 'role-frontend', name: '冒名', department: '前端', summary: '', prompt: '', enabled: true },
          { name: '没有 id 的', department: '通用', summary: '', prompt: '', enabled: true },
        ],
      }),
    })
    const { roles: rows, departments } = roles.list()
    assert.equal(rows.length, BUILT_IN_ROLES.length + 2)
    // A custom row colliding with a built-in id is dropped, not shadowed.
    assert.equal(rows.filter((row) => row.id === 'role-frontend').length, 1)
    assert.equal(new Set(departments).size, departments.length)
    assert.ok(departments.includes('通用'))
    assert.equal(rows.filter((row) => row.custom).length, 2)
  })

  await test('roles: apply without an agents service degrades instead of throwing', () => {
    const roles = createRoles({ ctx: absentCtx(), getSettings: settingsFor('roles', { enabled: true }) })
    const result = roles.apply({ roleId: 'role-backend', sessionId: 's1' })
    assert.equal(result.ok, false)
    assert.match(result.message, /agents 服务/)
  })

  await test('roles: apply injects one user message into the live agent', () => {
    const injected = []
    const services = { agents: { get: (id) => (id === 's1' ? { id, inject: (message) => injected.push(message) } : undefined) } }
    const roles = createRoles({ ctx: ctxWith(services), getSettings: settingsFor('roles', { enabled: true }) })
    const result = roles.apply({ roleId: 'role-security', sessionId: 's1' })
    assert.equal(result.ok, true)
    assert.equal(result.injected, 'message')
    assert.equal(injected.length, 1)
    assert.equal(injected[0].role, 'user')
    assert.equal(typeof injected[0].id, 'string')
    assert.ok(injected[0].id.length > 0)
    assert.match(injected[0].content[0].text, /安全工程师/)
    assert.match(injected[0].content[0].text, /行为约束/)
  })

  await test('roles: apply refuses an unknown role and a stale session', () => {
    const services = { agents: { get: () => undefined } }
    const roles = createRoles({ ctx: ctxWith(services), getSettings: settingsFor('roles', { enabled: true }) })
    assert.match(roles.apply({ roleId: 'nope', sessionId: 's1' }).message, /没有找到角色/)
    assert.match(roles.apply({ roleId: 'role-backend', sessionId: 's9' }).message, /不在运行中/)
  })

  await test('roles: apply is refused when the module is off', () => {
    const roles = createRoles({ ctx: absentCtx(), getSettings: settingsFor('roles', { enabled: false }) })
    const result = roles.apply({ roleId: 'role-backend', sessionId: 's1' })
    assert.equal(result.ok, false)
    assert.match(result.message, /未启用/)
  })

  await test('roles: the catalogue section registers once and stays bounded', () => {
    const stored = new Map()
    const services = {
      systemPrompt: {
        section: (value) => {
          stored.set(value.name, value)
          return () => stored.delete(value.name)
        },
      },
      agents: { get: (id) => ({ id, inject: () => undefined }) },
    }
    let settings = { modules: { roles: { enabled: true, injectCatalog: true, customRoles: [] } } }
    const live = createRoles({ ctx: ctxWith(services), getSettings: () => settings })
    live.apply({ roleId: 'role-backend', sessionId: 's1' })
    assert.equal(stored.size, 1)
    const catalogue = stored.values().next().value
    assert.equal(catalogue.name, 'mydsh-role-catalog')
    const text = catalogue.text()
    assert.match(text, /role-backend/)
    assert.match(text, /部门：/)
    live.apply({ roleId: 'role-frontend', sessionId: 's1' })
    assert.equal(stored.size, 1, 'the catalogue must register once, not once per apply')
    // Turning the module off empties the section: the catalogue never lingers in
    // a prompt after the user switched the feature off.
    settings = { modules: { roles: { enabled: false, injectCatalog: true, customRoles: [] } } }
    assert.equal(catalogue.text(), '')
    // Disposing withdraws the registration entirely.
    live.dispose()
    assert.equal(stored.size, 0)
  })

  // --------------------------------------------------------------- config ---
  console.log('config')

  await test('config: absent services list nothing and refuse writes', async () => {
    const manager = createConfigManager({
      ctx: absentCtx(),
      getSettings: settingsFor('configManager', { enabled: true, allowPluginToggle: true, allowConfigEdit: true }),
    })
    assert.deepEqual(manager.list(), [])
    const toggled = await manager.toggle({ id: 'x', enabled: true })
    assert.equal(toggled.ok, false)
    assert.match(toggled.message, /启停接口/)
    const edited = await manager.edit({ id: 'x', patch: { a: 1 } })
    assert.equal(edited.ok, false)
  })

  await test('config: the module switches are enforced', async () => {
    const off = createConfigManager({
      ctx: absentCtx(),
      getSettings: settingsFor('configManager', { enabled: false }),
    })
    assert.match(off.values({ id: 'x' }).message, /未启用/)
    const readOnly = createConfigManager({
      ctx: absentCtx(),
      getSettings: settingsFor('configManager', { enabled: true, allowPluginToggle: false, allowConfigEdit: false }),
    })
    assert.match((await readOnly.toggle({ id: 'x', enabled: true })).message, /允许启停/)
    assert.match((await readOnly.edit({ id: 'x', patch: { a: 1 } })).message, /允许编辑/)
  })

  await test('config: rows come from configEditor and carry read-only reasons', () => {
    const configEditor = {
      entries: () => [
        { options: { id: 'row-a', name: 'pkg-a', config: { model: 'm' } } },
        { options: { id: 'row-b', name: 'pkg-b', config: {}, disabled: true } },
      ],
      configuration: () => [
        { entry: { options: { id: 'row-a' } }, inherited: { model: 'm' }, override: {} },
        { entry: { options: { id: 'row-b' } }, inherited: {}, override: {} },
      ],
    }
    const pluginManager = {
      listPlugins: () => [
        { entryId: 'row-a', moduleName: 'pkg-a', enabled: true, patchId: 'row-a', meta: { title: 'A 插件' } },
        { entryId: 'row-b', moduleName: 'pkg-b', enabled: false, readOnlyReason: 'management-required' },
      ],
    }
    const manager = createConfigManager({
      ctx: ctxWith({ configEditor, pluginManager }),
      getSettings: settingsFor('configManager', { enabled: true, allowPluginToggle: true, allowConfigEdit: true }),
    })
    const rows = manager.list()
    assert.equal(rows.length, 2)
    const a = rows.find((row) => row.id === 'row-a')
    const b = rows.find((row) => row.id === 'row-b')
    assert.equal(a.enabled, true)
    assert.equal(a.readOnly, false)
    assert.equal(a.title, 'A 插件')
    assert.equal(a.hasChildren, true)
    assert.equal(b.enabled, false)
    assert.equal(b.readOnly, true)
    assert.match(b.why, /管理端/)
    // The documented row shape, no extra keys.
    assert.deepEqual(Object.keys(a).sort(), ['description', 'enabled', 'hasChildren', 'id', 'name', 'readOnly', 'title', 'why'])
  })

  await test('config: values() masks every credential-shaped field', () => {
    const configEditor = {
      entries: () => [{ options: { id: 'row-a', name: 'pkg-a', config: { apiKey: STORED, model: 'm', nested: { token: 't', path: 'keep' } } } }],
      configuration: () => [
        {
          entry: { options: { id: 'row-a' } },
          inherited: { apiKey: STORED, model: 'm', nested: { token: 't', path: 'keep' } },
          override: {},
        },
      ],
    }
    const manager = createConfigManager({
      ctx: ctxWith({ configEditor }),
      getSettings: settingsFor('configManager', { enabled: true, allowPluginToggle: true, allowConfigEdit: true }),
    })
    const { value } = manager.values({ id: 'row-a' })
    assert.equal(value.apiKey, '***')
    assert.equal(value.model, 'm')
    assert.equal(value.nested.token, '***')
    // A non-secret sibling inside the same nested object survives.
    assert.equal(value.nested.path, 'keep')
  })

  await test('config: edit sends *** back as "unchanged" and a real value as a write', async () => {
    let captured
    const configEditor = {
      entries: () => [{ options: { id: 'row-a', name: 'pkg-a', config: { apiKey: STORED, model: 'm' } } }],
      configuration: () => [{ entry: { options: { id: 'row-a' } }, inherited: { apiKey: STORED }, override: {} }],
      edit: async (_entry, change) => {
        captured = change({ apiKey: STORED, model: 'm' }, { apiKey: STORED })
      },
    }
    const manager = createConfigManager({
      ctx: ctxWith({ configEditor }),
      getSettings: settingsFor('configManager', { enabled: true, allowPluginToggle: true, allowConfigEdit: true }),
    })
    const kept = await manager.edit({ id: 'row-a', patch: { apiKey: '***' } })
    assert.equal(kept.ok, true)
    assert.equal(kept.changed, false)
    assert.equal(captured.apiKey, STORED)

    const wrote = await manager.edit({ id: 'row-a', patch: { apiKey: TYPED, model: 'm2' } })
    assert.equal(wrote.ok, true)
    assert.equal(wrote.changed, true)
    assert.equal(captured.apiKey, TYPED)
    assert.equal(captured.model, 'm2')
  })

  await test('config: a malformed patch is refused before any write', async () => {
    let writes = 0
    const configEditor = {
      entries: () => [{ options: { id: 'row-a', name: 'pkg-a', config: {} } }],
      configuration: () => [],
      edit: async () => {
        writes += 1
      },
    }
    const manager = createConfigManager({
      ctx: ctxWith({ configEditor }),
      getSettings: settingsFor('configManager', { enabled: true, allowPluginToggle: true, allowConfigEdit: true }),
    })
    assert.equal((await manager.edit({ id: 'row-a', patch: {} })).ok, false)
    assert.equal((await manager.edit({ id: 'row-a', patch: null })).ok, false)
    assert.equal((await manager.edit({ id: '', patch: { a: 1 } })).ok, false)
    assert.equal(writes, 0)
  })

  await test('config: toggle prefers pluginManager and never touches the patch file', async () => {
    const calls = []
    const pluginManager = {
      setPluginEnabled: async (id, enabled) => {
        calls.push([id, enabled])
        return { restartRequired: false }
      },
      listPlugins: () => [{ entryId: 'row-a', moduleName: 'pkg-a', enabled: true, patchId: 'row-a' }],
    }
    const manager = createConfigManager({
      ctx: ctxWith({ pluginManager }),
      getSettings: settingsFor('configManager', { enabled: true, allowPluginToggle: true, allowConfigEdit: true }),
    })
    const result = await manager.toggle({ id: 'row-a', enabled: false })
    assert.equal(result.ok, true)
    assert.deepEqual(calls, [['row-a', false]])
  })

  await test('config: toggle falls back to configEditor when the manager refuses the row', async () => {
    let edited = false
    const pluginManager = {
      setPluginEnabled: async () => {
        throw new Error('unknown-plugin')
      },
    }
    const configEditor = {
      entries: () => [{ options: { id: 'row-a', name: 'pkg-a', config: {} } }],
      configuration: () => [],
      edit: async (_entry, change) => {
        edited = true
        change({}, {})
      },
    }
    const manager = createConfigManager({
      ctx: ctxWith({ pluginManager, configEditor }),
      getSettings: settingsFor('configManager', { enabled: true, allowPluginToggle: true, allowConfigEdit: true }),
    })
    const result = await manager.toggle({ id: 'row-a', enabled: false })
    assert.equal(result.ok, true)
    assert.equal(edited, true)
    assert.equal(CONFIG_CONTRACT.SECRET_SENTINEL, '***')
  })

  await test('config: a manager failure that is not about ownership is reported', async () => {
    const pluginManager = {
      setPluginEnabled: async () => {
        throw new Error('stop-profile')
      },
    }
    const manager = createConfigManager({
      ctx: ctxWith({ pluginManager }),
      getSettings: settingsFor('configManager', { enabled: true, allowPluginToggle: true, allowConfigEdit: true }),
    })
    const result = await manager.toggle({ id: 'row-a', enabled: true })
    assert.equal(result.ok, false)
    assert.match(result.message, /启停失败/)
  })

  // ------------------------------------------------------------- insights ---
  console.log('insights')

  await test('insights: overview covers the catalogue and separates enabled from available', () => {
    const insights = createInsights({
      ctx: hostileCtx(),
      getSettings: () => ({ modules: { desktop: { enabled: true }, browserView: { enabled: false }, mcpConnector: { enabled: true } } }),
    })
    const rows = insights.overview()
    assert.equal(rows.length, INSIGHT_CATALOG.length)
    for (const row of rows) {
      assert.equal(typeof row.key, 'string')
      assert.equal(typeof row.label, 'string')
      assert.equal(typeof row.enabled, 'boolean')
      assert.equal(typeof row.available, 'boolean')
      assert.equal(typeof row.reason, 'string')
      assert.ok(['low', 'medium', 'high'].includes(row.risk))
      assert.ok(Array.isArray(row.dependsOn))
    }
    const browser = rows.find((row) => row.key === 'browserView')
    assert.equal(browser.available, false)
    assert.match(browser.reason, /未实现/)
    const mcp = rows.find((row) => row.key === 'mcpConnector')
    assert.equal(mcp.available, false)
    assert.match(mcp.reason, /mcpManager/)
    const desktop = rows.find((row) => row.key === 'desktop')
    assert.equal(desktop.enabled, true)
    assert.equal(desktop.available, process.platform === 'win32')
  })

  await test('insights: overview reports the live services when present', () => {
    const insights = createInsights({
      ctx: ctxWith({
        mcpManager: { register: () => () => undefined },
        configEditor: { entries: () => [] },
        skills: { list: async () => [] },
        agents: { get: () => undefined },
        agentTeams: { listTasks: () => [] },
      }),
      getSettings: settingsFor('skills', { enabled: true }),
    })
    const rows = insights.overview()
    for (const key of ['mcpConnector', 'configManager', 'skills', 'roles', 'teams', 'imageGen']) {
      assert.equal(rows.find((row) => row.key === key).available, true, `${key} should be available`)
    }
  })

  await test('insights: skills degrade to an empty list without a registry', async () => {
    for (const ctx of [absentCtx(), hostileCtx()]) {
      const insights = createInsights({ ctx, getSettings: settingsFor('skills', { enabled: true }) })
      const result = await insights.skills({})
      assert.deepEqual(result.skills, [])
      assert.equal(typeof result.reason, 'string')
    }
  })

  await test('insights: skills read the registry and filter by query', async () => {
    const services = {
      skills: {
        list: async () => [
          { name: 'office', description: 'Office documents', source: 'bundled', path: 'C:/x/SKILL.md' },
          { name: 'dsh-doc', description: 'DSH facts', source: 'bundled', path: 'C:/y/SKILL.md' },
        ],
      },
    }
    const insights = createInsights({ ctx: ctxWith(services), getSettings: settingsFor('skills', { enabled: true }) })
    const all = await insights.skills({})
    assert.equal(all.skills.length, 2)
    assert.equal(all.skills[0].name, 'office')
    assert.equal(all.skills[0].source, 'bundled')
    assert.equal(all.skills[0].path, 'C:/x/SKILL.md')
    const filtered = await insights.skills({ q: 'dsh' })
    assert.deepEqual(filtered.skills.map((row) => row.name), ['dsh-doc'])
  })

  await test('insights: skills fall back to the legacy catalogue', async () => {
    const services = { sessionSkillCatalog: { list: async () => [{ skill: 'legacy', summary: 'old' }] } }
    const insights = createInsights({ ctx: ctxWith(services), getSettings: settingsFor('skills', { enabled: true }) })
    const result = await insights.skills({})
    assert.equal(result.skills[0].name, 'legacy')
    assert.equal(result.source, 'sessionSkillCatalog')
  })

  await test('insights: teams refuse writes and degrade without services', async () => {
    const insights = createInsights({ ctx: absentCtx(), getSettings: settingsFor('teams', { enabled: true, readOnly: true }) })
    assert.ok(insights.assertWritable() !== undefined)
    const state = await insights.teams({ sessionId: 's1' })
    assert.equal(state.enabled, true)
    assert.deepEqual(state.members, [])
    assert.deepEqual(state.tasks, [])
    assert.deepEqual(state.messages, [])
    assert.equal(state.totals.members, 0)
  })

  await test('insights: a writable team configuration passes the write gate', () => {
    const insights = createInsights({ ctx: absentCtx(), getSettings: settingsFor('teams', { enabled: true, readOnly: false }) })
    assert.equal(insights.assertWritable(), undefined)
  })

  await test('insights: teams read members and tasks from the live services', async () => {
    const services = {
      agents: { get: (id) => (id === 's1' ? { id } : undefined) },
      subagents: {
        listDescendants: async () => [
          { kind: 'child', id: 'c1', activity: 'running', depth: 1, path: 'lead/worker', hasChildren: false, usage: { inputTokens: 10, outputTokens: 5 } },
          { kind: 'diagnostic', id: 'c2', reason: 'unavailable' },
        ],
      },
      agentTeams: {
        listTasks: () => [
          { id: 't1', subject: '写模块', status: 'in_progress', revision: 2, blockedBy: [], ownerName: 'worker', writeScopes: ['a/'] },
          { id: 't2', subject: '自测', status: 'completed', revision: 1, blockedBy: ['t1'], ownerName: 'worker', writeScopes: [] },
        ],
      },
      sessions: { get: () => undefined },
    }
    const insights = createInsights({ ctx: ctxWith(services), getSettings: settingsFor('teams', { enabled: true, readOnly: true }) })
    const state = await insights.teams({ sessionId: 's1' })
    assert.equal(state.members.length, 2)
    assert.equal(state.members[0].status, 'running')
    assert.equal(state.members[0].usage.totalTokens, 15)
    assert.equal(state.members[1].status, 'unavailable')
    assert.equal(state.tasks.length, 2)
    assert.deepEqual(state.tasks[1].blockedBy, ['t1'])
    assert.equal(state.totals.pending, 1)
    assert.equal(state.totals.completed, 1)
  })

  await test('insights: teams read message history from the lead session log', async () => {
    const services = {
      agents: { get: () => undefined },
      sessions: {
        get: () => ({
          snapshotEvents: () => [
            { type: 'user/message', data: {} },
            {
              type: 'team/message/queued',
              data: {
                message: { senderName: 'lead', targetId: 'w1', content: [{ type: 'text', text: 'please review the module' }] },
              },
            },
          ],
        }),
      },
    }
    const insights = createInsights({ ctx: ctxWith(services), getSettings: settingsFor('teams', { enabled: true, readOnly: true }) })
    const state = await insights.teams({ sessionId: 's1' })
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0].from, 'lead')
    assert.match(state.messages[0].summary, /review/)
  })

  // ---------------------------------------------------------------- totals ---
  console.log('')
  console.log(`${String(passed)} passed, ${String(failures.length)} failed`)
  if (failures.length > 0) {
    for (const failure of failures) console.log(`\n${failure.name}\n${failure.error?.stack ?? failure.error}`)
  }
  await rm(scratch, { recursive: true, force: true })
  return failures.length === 0 ? 0 : 1
}

/** A minimal stand-in for a `fetch` Response. */
function fakeResponse(body, contentType = 'application/json', status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-type' ? contentType : null
      },
    },
    async text() {
      return text
    },
  }
}

const code = await main()
process.exitCode = code
