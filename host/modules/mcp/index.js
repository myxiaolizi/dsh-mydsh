/**
 * MCP connector: list, register and probe Model Context Protocol servers.
 *
 * The host already ships a first-party MCP manager (`ctx.mcpManager`) and client.
 * Re-implementing the protocol stack here would duplicate a maintained component
 * and drift from it, so this module has two clearly separated halves:
 *
 *  - Registration and status go through `ctx.mcpManager` when it exists. The
 *    manager owns entry validation, instance lifecycle and the status registry;
 *    this module only translates one settings row into one manager entry.
 *  - Probing falls back to a *minimal* JSON-RPC handshake written here. That is
 *    deliberate: `mcpManager.probe()` only accepts a *configured* entry, and the
 *    settings page must be able to test a server the user has not applied yet.
 *    The fallback does exactly two things — `initialize` then `tools/list` —
 *    against a transport this file owns, and it never registers anything.
 *
 * Why no `@modelcontextprotocol/sdk`: the SDK would be a third-party dependency
 * for a plugin that promises to be self-contained. `initialize` + `tools/list`
 * is a hundred lines of newline-delimited JSON-RPC, and the two transports are
 * a child process and `fetch`.
 */

import { spawn as spawnProcess } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'

import {
  LIMITS,
  budget,
  describe,
  failure,
  hasMethod,
  moduleSettings,
  parseEnvText,
  parseHeaderText,
  record,
  serviceOf,
  text,
} from '../shared.js'

/** Whole-probe budget. Interactive surfaces need a bounded answer. */
const PROBE_TIMEOUT_MS = 15000

/** Protocol revision this client claims. Servers may answer with their own. */
const PROTOCOL_VERSION = '2025-06-18'

/** Manager-enforced server-name grammar; a name is also the tool namespace. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** Same cap the manager applies when it lists tools. */
const MAX_TOOL_NAMES = 256

/** Pages of `tools/list` a probe follows before reporting truncation. */
const MAX_LIST_PAGES = 8

/** Largest response body a probe will buffer. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * Turn one settings row into a manager-safe server name.
 *
 * The settings page accepts a display-ish `name`, but the manager rejects
 * anything outside {@link SERVER_NAME} because the name becomes a tool prefix.
 * Rather than rejecting the row at apply time — which would let a typo silently
 * disable a server — the name is normalised, and `list()` reports the name that
 * was actually used.
 * @param raw - the configured name.
 * @param taken - names already assigned in this pass.
 * @returns a unique, grammar-conforming name.
 */
function serverName(raw, taken) {
  const base = text(raw, 64).replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'server'
  if (!taken.has(base)) {
    taken.add(base)
    return base
  }
  for (let index = 2; index < 100; index++) {
    const suffix = `-${String(index)}`
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
  // Practically unreachable: a hundred servers sharing one normalised name.
  const fallback = `s${String(taken.size + 1)}`
  taken.add(fallback)
  return fallback
}

/**
 * One settings row as the connector sees it.
 * @param raw - one entry of `modules.mcpConnector.servers`.
 * @param index - position, used for a fallback identity.
 * @returns the resolved row, or `undefined` for an unusable entry.
 */
function normalizeEntry(raw, index) {
  const source = record(raw)
  if (source === undefined) return undefined
  const command = text(source.command, LIMITS.command)
  const url = text(source.url, LIMITS.url)
  if (command === '' && url === '') return undefined
  const transport = command !== '' ? 'stdio' : 'streamable-http'
  return {
    id: text(source.id, LIMITS.id) || `mcp-${String(index + 1)}`,
    name: text(source.name, LIMITS.id),
    label: text(source.label, LIMITS.label),
    enabled: source.enabled === true,
    transport,
    command,
    args: Array.isArray(source.args) ? source.args.map((entry) => text(entry, 512)).filter((entry) => entry !== '').slice(0, 64) : [],
    cwd: text(source.cwd, LIMITS.command),
    url,
    env: parseEnvText(source.env),
    headers: parseHeaderText(source.headers),
    toolPrefix: text(source.toolPrefix, 32),
  }
}

/** Every configured server, in document order, with resolved registration names. */
function configuredServers(getSettings) {
  const slice = moduleSettings(getSettings, 'mcpConnector')
  const rows = Array.isArray(slice.servers) ? slice.servers : []
  const taken = new Set()
  const out = []
  for (const [index, raw] of rows.entries()) {
    const entry = normalizeEntry(raw, index)
    if (entry === undefined) continue
    // `toolPrefix` wins over `name` when it is usable: it is the field the user
    // edits to change the tool namespace, and the namespace *is* the server name
    // in DSH's manager.
    const preferred = SERVER_NAME.test(entry.toolPrefix) ? entry.toolPrefix : entry.name
    out.push({ ...entry, registrationName: serverName(preferred || entry.name, taken) })
  }
  return out
}

/**
 * Status of one server, reduced to the four things the UI shows.
 * @param status - a `McpManagedServerStatus` from the manager, or `undefined`.
 */
function describeStatus(status) {
  const value = record(status)
  if (value === undefined) return { status: 'unknown', toolCount: 0, lastError: '' }
  const state = text(value.state, 32)
  if (state === 'connected') {
    return { status: 'connected', toolCount: Number.isFinite(value.toolCount) ? Number(value.toolCount) : 0, lastError: '' }
  }
  if (state === 'failed') {
    const reason = text(value.reason, 32)
    const detail = reason === 'cleanup' ? 'cleanup could not be confirmed' : text(value.lastError, LIMITS.message)
    return { status: 'failed', toolCount: 0, lastError: detail || reason }
  }
  if (state === 'reconnecting' || state === 'waiting-credentials') {
    return { status: state, toolCount: 0, lastError: text(value.lastError, LIMITS.message) }
  }
  if (state === 'connecting') return { status: 'connecting', toolCount: 0, lastError: '' }
  if (state === 'closed') return { status: 'closed', toolCount: 0, lastError: '' }
  if (state === 'disabled') return { status: 'disabled', toolCount: 0, lastError: '' }
  return { status: state === '' ? 'unknown' : state, toolCount: 0, lastError: '' }
}

// --- minimal MCP JSON-RPC client -------------------------------------------

/**
 * The `initialize` request both transports send.
 *
 * Identical bytes on purpose: a server that answers one transport must behave
 * the same on the other, and keeping the request in one function is what makes
 * that true. Exported for the self-test.
 * @param id - JSON-RPC correlation id.
 * @returns the request object.
 */
export function buildInitializeRequest(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-mydsh', version: '2' },
    },
  }
}

/**
 * The `tools/list` request, with paging.
 * @param id - JSON-RPC correlation id; must be unique within one probe.
 * @param cursor - opaque cursor from the previous page, `''` for the first.
 */
export function buildToolsListRequest(id, cursor = '') {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: cursor === '' ? {} : { cursor } }
}

/** The notification a client sends once it has accepted the server's answer. */
export function buildInitializedNotification() {
  return { jsonrpc: '2.0', method: 'notifications/initialized' }
}

/**
 * Reduce a `tools/list` result to names plus the next cursor.
 * @param payload - the decoded JSON-RPC object.
 * @returns `{ toolNames, nextCursor }`.
 */
export function parseToolListResult(payload) {
  const result = record(record(payload)?.result)
  const rows = Array.isArray(result?.tools) ? result.tools : []
  const toolNames = []
  for (const row of rows) {
    const name = text(record(row)?.name, 200)
    if (name === '') continue
    toolNames.push(name)
    if (toolNames.length >= MAX_TOOL_NAMES) break
  }
  return { toolNames, nextCursor: text(result?.nextCursor, 512) }
}

/**
 * Decode one MCP JSON-RPC answer.
 *
 * Exported because the self-test exercises it with a synthetic response object:
 * the two wire shapes (plain JSON and SSE) are the part of the protocol most
 * likely to break against a real server, and they can be checked without a
 * socket.
 * @param response - an object with `headers.get`, `ok`, `status`, `statusText`
 *   and `text()`, i.e. anything shaped like a `fetch` response.
 * @returns the decoded JSON-RPC object.
 */
export async function readJsonRpcResponse(response) {
  const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
  const body = await response.text()
  if (body.length > MAX_BODY_BYTES) throw new Error('the server response exceeded the size limit')
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}: ${body.slice(0, 300) || response.statusText}`)
  }
  if (contentType.includes('text/event-stream')) {
    // Each SSE event is `data: <json>` on one or more lines; take the first
    // payload that parses and carries a `result` or `error`.
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')
      if (data === '') continue
      try {
        const parsed = JSON.parse(data)
        if (record(parsed) !== undefined && (parsed.result !== undefined || parsed.error !== undefined)) return parsed
      } catch {
        // A comment or a partial frame; keep scanning.
      }
    }
    throw new Error('the server sent no JSON-RPC result in its event stream')
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(`the server did not answer with JSON: ${body.slice(0, 200)}`)
  }
  const value = record(parsed)
  if (value === undefined) throw new Error('the server answered with a non-object payload')
  if (value.error !== undefined) {
    const detail = record(value.error)
    throw new Error(`JSON-RPC error: ${text(detail?.message, 300) || JSON.stringify(value.error).slice(0, 300)}`)
  }
  return value
}

/**
 * Probe a streamable-http server: `initialize`, the `notifications/initialized`
 * courtesy notification, then `tools/list` (paged).
 * @param entry - resolved server row.
 * @param signal - whole-probe budget.
 * @returns the tool names the server advertises.
 */
async function probeHttp(entry, signal) {
  if (typeof fetch !== 'function') throw new Error('fetch is unavailable in this runtime')
  /** Session identity the server may hand out on `initialize`. */
  let sessionId = ''
  const post = async (payload) => {
    const headers = {
      'content-type': 'application/json',
      // Required by the streamable-http transport: a server may answer with
      // either media type and a client that forbids one gets a 406.
      accept: 'application/json, text/event-stream',
      ...entry.headers,
    }
    if (sessionId !== '') headers['mcp-session-id'] = sessionId
    const response = await fetch(entry.url, { method: 'POST', headers, body: JSON.stringify(payload), signal })
    const assigned = response.headers.get('mcp-session-id')
    if (assigned !== null && assigned !== '') sessionId = assigned
    return response
  }

  const initialized = await readJsonRpcResponse(await post(buildInitializeRequest(1)))
  const serverInfo = record(record(initialized.result)?.serverInfo)
  // The initialized notification carries no id, so it produces no response.
  await post(buildInitializedNotification()).catch(() => undefined)

  const tools = []
  let cursor = ''
  for (let page = 0; page < MAX_LIST_PAGES && tools.length < MAX_TOOL_NAMES; page++) {
    const answer = await readJsonRpcResponse(await post(buildToolsListRequest(page + 2, cursor)))
    const parsed = parseToolListResult(answer)
    tools.push(...parsed.toolNames)
    cursor = parsed.nextCursor
    if (cursor === '' || tools.length >= MAX_TOOL_NAMES) break
  }
  return { toolNames: tools.slice(0, MAX_TOOL_NAMES), serverInfo: serverInfo === undefined ? undefined : { name: text(serverInfo.name, 200), version: text(serverInfo.version, 64) } }
}

/**
 * A line-oriented JSON-RPC reader over a byte stream.
 * MCP's stdio transport frames one JSON object per line, so a buffered
 * newline split is the whole decoder.
 * @param stream - the child's stdout.
 * @returns `request(id)` and `dispose()`.
 */
function lineReader(stream) {
  let buffer = ''
  const pending = new Map()
  const onData = (chunk) => {
    buffer += chunk.toString('utf8')
    if (buffer.length > MAX_BODY_BYTES) {
      for (const settle of pending.values()) settle.reject(new Error('the server output exceeded the size limit'))
      pending.clear()
      buffer = ''
      return
    }
    for (;;) {
      const at = buffer.indexOf('\n')
      if (at < 0) break
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        // Servers sometimes log to stdout; a non-JSON line is not a protocol
        // violation and must not abort the handshake.
        continue
      }
      const value = record(message)
      if (value === undefined) continue
      const id = value.id
      if (typeof id !== 'number') continue
      const settle = pending.get(id)
      if (settle === undefined) continue
      pending.delete(id)
      if (value.error !== undefined) settle.reject(new Error(`JSON-RPC error: ${text(record(value.error)?.message, 300) || 'unknown'}`))
      else settle.resolve(value)
    }
  }
  stream.on('data', onData)
  return {
    request(id) {
      return new Promise((resolvePromise, rejectPromise) => {
        pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
      })
    },
    dispose() {
      stream.off('data', onData)
      for (const settle of pending.values()) settle.reject(new Error('the probe ended'))
      pending.clear()
    },
  }
}

/**
 * Probe a stdio server through `ctx.subprocess` when it exists, else through
 * `node:child_process`.
 *
 * The service is preferred because it owns the execution world (sanitised
 * environment, managed process range, guaranteed teardown). The direct spawn is
 * the fallback for a profile that mounts no subprocess provider, and it is
 * still argv-only: no shell, no interpolation.
 * @param entry - resolved server row.
 * @param ctx - plugin context, for the optional `subprocess` service.
 * @param signal - whole-probe budget.
 * @returns the tool names the server advertises.
 */
async function probeStdio(entry, ctx, signal) {
  const argv = [entry.command, ...entry.args]
  const cwd = entry.cwd === '' ? process.cwd() : resolvePath(entry.cwd)
  const subprocess = serviceOf(ctx, 'subprocess')
  const env = { ...process.env, ...entry.env }

  let write
  let read
  let cleanup = () => undefined

  if (hasMethod(subprocess, 'spawn')) {
    const handle = subprocess.spawn({
      argv,
      cwd,
      // Both directions are raw pipes: JSON-RPC needs to write requests and
      // read responses on the same live process.
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 8192 } },
      graceMs: 2000,
      signal,
      env,
    })
    write = (line) => {
      handle.stdin?.write(line)
    }
    read = handle.stdout
    cleanup = () => {
      try {
        handle.terminate()
      } catch {
        // Already gone.
      }
    }
    // A provider-level spawn failure surfaces here rather than as a silent hang.
    handle.done.catch(() => undefined)
  } else {
    const child = spawnProcess(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    write = (line) => {
      child.stdin?.write(line)
    }
    read = child.stdout
    cleanup = () => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
    child.on('error', () => undefined)
    // An unread stderr pipe can fill and block the child; drain and drop it.
    child.stderr?.resume()
  }
  if (read === undefined || read === null) {
    cleanup()
    throw new Error('the child process exposed no stdout')
  }

  const reader = lineReader(read)
  const send = (payload) => {
    write(`${JSON.stringify(payload)}\n`)
  }
  // Two independent ways a pending request can be stranded: the budget expires,
  // or the child exits before answering. Both must reject the waiters, or a
  // probe against a server that dies at startup would hang until the route
  // timeout instead of reporting the failure.
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    reader.dispose()
    cleanup()
  }
  signal?.addEventListener('abort', stop, { once: true })
  read.on?.('close', stop)
  read.on?.('end', stop)
  try {
    send(buildInitializeRequest(1))
    const initialized = await reader.request(1)
    const serverInfo = record(record(initialized.result)?.serverInfo)
    send(buildInitializedNotification())

    const tools = []
    let cursor = ''
    for (let page = 0; page < MAX_LIST_PAGES && tools.length < MAX_TOOL_NAMES; page++) {
      const id = page + 2
      // Arm the waiter before writing: a fast local server can answer inside
      // the same tick as the write, and a later registration would miss it.
      const answer = reader.request(id)
      send(buildToolsListRequest(id, cursor))
      const parsed = parseToolListResult(await answer)
      tools.push(...parsed.toolNames)
      cursor = parsed.nextCursor
      if (cursor === '') break
    }
    return { toolNames: tools.slice(0, MAX_TOOL_NAMES), serverInfo: serverInfo === undefined ? undefined : { name: text(serverInfo.name, 200), version: text(serverInfo.version, 64) } }
  } finally {
    signal?.removeEventListener('abort', stop)
    stop()
  }
}

/**
 * Build the connector.
 * @param options.ctx - Cordis plugin context.
 * @param options.getSettings - synchronous settings reader.
 * @returns the connector surface used by the `/mcp/*` routes.
 */
export function createMcpConnector({ ctx, getSettings }) {
  /** Live registrations, keyed by registration name. */
  const registrations = new Map()

  /**
   * Outcome of the most recent `apply()`, for the `/mcp/apply` route to report
   * without making `apply()` itself return two different things.
   */
  let lastApply = { ok: true, message: '', applied: 0, failed: [] }

  /**
   * The last apply's diagnostic detail.
   * @returns `{ ok, message, applied, failed, servers }`.
   */
  function lastReport() {
    return { ...lastApply, servers: list() }
  }

  /** The manager, or `undefined`. */
  const manager = () => serviceOf(ctx, 'mcpManager')

  /**
   * `McpRow[]` — one row per configured server, carrying live status when the
   * manager knows the server.
   * @returns rows in settings order.
   */
  function list() {
    const entries = configuredServers(getSettings)
    const mcp = manager()
    /** Manager views keyed by name; an absent manager means "no live state". */
    const views = new Map()
    if (hasMethod(mcp, 'list')) {
      try {
        const rows = mcp.list()
        if (Array.isArray(rows)) {
          for (const row of rows) {
            const name = text(record(row)?.name, LIMITS.id)
            if (name !== '') views.set(name, row)
          }
        }
      } catch {
        // A disposed manager reports nothing; every row then reads `unknown`.
      }
    }
    return entries.map((entry) => {
      const view = views.get(entry.registrationName)
      const status = describeStatus(view?.status)
      return {
        name: entry.registrationName,
        label: entry.label || entry.name || entry.registrationName,
        transport: entry.transport,
        target: entry.transport === 'stdio' ? [entry.command, ...entry.args].join(' ') : entry.url,
        status: entry.enabled ? status.status : 'disabled',
        toolCount: status.toolCount,
        lastError: status.lastError,
      }
    })
  }

  /**
   * Translate one resolved row into a manager registration.
   * Cross-transport fields are omitted rather than blanked: the manager rejects
   * an entry that carries a field belonging to the other transport.
   * @param entry - resolved settings row.
   */
  function registrationOf(entry) {
    if (entry.transport === 'stdio') {
      return {
        transport: 'stdio',
        command: entry.command,
        args: [...entry.args],
        env: { ...entry.env },
        cwd: entry.cwd,
        startupTimeoutMs: 30000,
      }
    }
    return {
      transport: 'streamable-http',
      url: entry.url,
      headers: { ...entry.headers },
      startupTimeoutMs: 30000,
    }
  }

  /**
   * Withdraw every live registration, then register the enabled servers again.
   * "Apply" is therefore idempotent: the settings document is the only source of
   * truth and the live set is rebuilt to match it.
   *
   * The return value is the **disposer list** the Host keeps for teardown, so one
   * call site can both rebuild the set and own its withdrawal. The diagnostic
   * detail (which servers failed and why) is kept in `lastReport()` rather than
   * mixed into the array, because a caller that only wants the disposers should
   * not have to know the report shape.
   * @returns one disposer per registered server.
   */
  function apply() {
    const disposers = []
    for (const dispose of registrations.values()) {
      try {
        dispose()
      } catch {
        // A manager already disposed this registration; nothing to withdraw.
      }
    }
    registrations.clear()

    const entries = configuredServers(getSettings)
    const failed = []
    let applied = 0
    const mcp = manager()

    if (entries.some((entry) => entry.enabled) && !hasMethod(mcp, 'register')) {
      for (const entry of entries) {
        if (entry.enabled) failed.push({ name: entry.registrationName, message: 'mcpManager is unavailable' })
      }
      lastApply = {
        ok: false,
        message: '当前版本没有可用的 MCP 管理器（ctx.mcpManager），无法注册服务器',
        applied: 0,
        failed,
      }
      return disposers
    }

    for (const entry of entries) {
      if (!entry.enabled) continue
      try {
        const dispose = mcp.register(entry.registrationName, registrationOf(entry))
        registrations.set(entry.registrationName, dispose)
        disposers.push(dispose)
        applied += 1
      } catch (error) {
        failed.push({ name: entry.registrationName, message: describe(error) })
      }
    }
    lastApply = {
      ok: failed.length === 0,
      message: failed.length === 0 ? '' : `${String(failed.length)} 个服务器注册失败`,
      applied,
      failed,
    }
    return disposers
  }

  /**
   * Resolve the server a `test` call names, preferring an explicit payload over
   * the stored settings so a row can be tested before it is saved.
   * @param server - `{ id?, name?, ...fields }` from the request body.
   */
  function resolveTarget(server) {
    const payload = record(server)
    const wanted = text(payload?.id ?? payload?.name, LIMITS.id)
    const stored = configuredServers(getSettings)
    if (payload !== undefined && (text(payload.command, LIMITS.command) !== '' || text(payload.url, LIMITS.url) !== '')) {
      const inline = normalizeEntry(payload, 0)
      if (inline !== undefined) return { ...inline, registrationName: inline.name || 'server' }
    }
    const found = stored.find((entry) => entry.id === wanted || entry.name === wanted || entry.registrationName === wanted)
    return found
  }

  /**
   * Test one server without registering it.
   *
   * Precedence is deliberate: the manager's own probe is authoritative when the
   * server is already known to it (it resolves credentials templates and reuses
   * the maintained client), and the local handshake covers everything else.
   * @param options.server - server identity or an inline row.
   * @returns `{ ok, message, toolNames, durationMs }`; never throws.
   */
  async function test({ server } = {}) {
    const startedAt = Date.now()
    const target = resolveTarget(server)
    if (target === undefined) {
      return { ...failure('找不到要测试的服务器'), toolNames: [], durationMs: 0 }
    }

    const mcp = manager()
    if (hasMethod(mcp, 'probe')) {
      const watch = budget(PROBE_TIMEOUT_MS, 'the probe exceeded 15s')
      try {
        const result = await mcp.probe(target.registrationName, { timeoutMs: PROBE_TIMEOUT_MS, signal: watch.signal })
        const value = record(result) ?? {}
        const toolNames = Array.isArray(value.toolNames) ? value.toolNames.map((name) => text(name, 200)).filter(Boolean).slice(0, MAX_TOOL_NAMES) : []
        return {
          ok: value.ok === true,
          message: value.ok === true ? '' : text(value.message, LIMITS.message) || `连接在 ${text(value.stage, 16) || 'connect'} 阶段失败`,
          toolNames,
          durationMs: Number.isFinite(value.durationMs) ? Number(value.durationMs) : Date.now() - startedAt,
        }
      } catch (error) {
        // The manager refuses unknown entry names; fall through to the local
        // handshake so an unsaved row can still be tested.
        if (!/unknown server/i.test(describe(error))) {
          return { ...failure(`探测失败：${describe(error)}`), toolNames: [], durationMs: Date.now() - startedAt }
        }
      } finally {
        watch.cancel()
      }
    }

    const watch = budget(PROBE_TIMEOUT_MS, 'the probe exceeded 15s')
    try {
      const result =
        target.transport === 'stdio' ? await probeStdio(target, ctx, watch.signal) : await probeHttp(target, watch.signal)
      return { ok: true, message: '', toolNames: result.toolNames, durationMs: Date.now() - startedAt }
    } catch (error) {
      const message = watch.signal.aborted ? '连接超时（15 秒）' : describe(error)
      return { ...failure(message), toolNames: [], durationMs: Date.now() - startedAt }
    } finally {
      watch.cancel()
    }
  }

  /** Withdraw every registration; called from the plugin's own teardown. */
  function dispose() {
    for (const disposeOne of registrations.values()) {
      try {
        disposeOne()
      } catch {
        // Already withdrawn.
      }
    }
    registrations.clear()
  }

  return { list, apply, lastReport, test, dispose }
}
