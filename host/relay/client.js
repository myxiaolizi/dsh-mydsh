/**
 * The outbound tunnel client for the remote-access relay.
 *
 * DSH serves its GUI on a loopback address for this machine. Reaching it from
 * elsewhere needs an inbound connection, which a home network rarely allows, so
 * this client opens an *outbound* WebSocket to the relay and answers requests
 * that arrive over it. The relay never needs a port here.
 *
 * Every forwarded request is handled by sending it to the local DSH listener
 * with the browser cookie DSH itself minted, so the relay's traffic passes the
 * same trust and authentication fence as a local browser. The cookie is read
 * from `connection` on the Host side rather than forged here.
 */

import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 60000
const PING_INTERVAL_MS = 25000
const MAX_BODY_BYTES = 32 * 1024 * 1024

/**
 * Minimal RFC 6455 client frame writer.
 *
 * The handshake is plain HTTP, and only client-to-server frames are written
 * (servers must not be masked), so a full WebSocket library is unnecessary.
 */
class FrameWriter {
  /** @param socket - the upgraded duplex socket. */
  constructor(socket) {
    this.socket = socket
  }

  /**
   * Write one frame.
   * @param opcode - 0x1 text, 0x2 binary, 0x8 close, 0x9 ping, 0xA pong.
   * @param payload - frame body.
   */
  write(opcode, payload = Buffer.alloc(0)) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
    const length = body.length
    let header
    if (length < 126) {
      header = Buffer.alloc(6)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | length
      const mask = randomBytes(4)
      mask.copy(header, 2)
      for (let index = 0; index < length; index++) body[index] ^= mask[index & 3]
      this.socket.write(Buffer.concat([header, body]))
      return
    }
    if (length < 65536) {
      header = Buffer.alloc(8)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(length, 2)
      const mask = randomBytes(4)
      mask.copy(header, 4)
      for (let index = 0; index < length; index++) body[index] ^= mask[index & 3]
      this.socket.write(Buffer.concat([header, body]))
      return
    }
    header = Buffer.alloc(14)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
    const mask = randomBytes(4)
    mask.copy(header, 10)
    for (let index = 0; index < length; index++) body[index] ^= mask[index & 3]
    this.socket.write(Buffer.concat([header, body]))
  }

  /** Send a JSON text frame. */
  json(value) {
    this.write(0x1, Buffer.from(JSON.stringify(value), 'utf8'))
  }

  /** Send a close frame. */
  close(code = 1000) {
    const body = Buffer.alloc(2)
    body.writeUInt16BE(code, 0)
    this.write(0x8, body)
  }
}

/**
 * Incremental frame reader.
 *
 * TCP does not preserve message boundaries, so a frame may arrive in pieces.
 * Bytes are accumulated until one whole frame is available, then handed back.
 */
class FrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0)
  }

  /**
   * Feed bytes and drain every complete frame.
   * @param chunk - newly received bytes.
   * @returns complete frames as `{ opcode, payload }`.
   */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames = []
    for (;;) {
      const frame = this.#take()
      if (frame === undefined) break
      frames.push(frame)
    }
    return frames
  }

  /** Read one frame from the head of the buffer, or `undefined`. */
  #take() {
    const buffer = this.buffer
    if (buffer.length < 2) return undefined
    const opcode = buffer[0] & 0x0f
    const masked = (buffer[1] & 0x80) !== 0
    let length = buffer[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return undefined
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return undefined
      const big = buffer.readBigUInt64BE(2)
      if (big > BigInt(MAX_BODY_BYTES)) throw new Error('The relay sent an oversized frame.')
      length = Number(big)
      offset = 10
    }
    const maskBytes = masked ? 4 : 0
    const total = offset + maskBytes + length
    if (buffer.length < total) return undefined
    const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
    const payload = Buffer.from(buffer.subarray(offset + maskBytes, total))
    if (mask !== undefined) {
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3]
    }
    this.buffer = buffer.subarray(total)
    return { opcode, payload }
  }
}

/**
 * Open one WebSocket connection to the relay.
 * @param url - `wss://host/tunnel?token=...` (or `ws://` for local testing).
 * @returns `{ socket, writer, reader, rest }` after a successful upgrade.
 */
async function connectSocket(url) {
  const target = new URL(url)
  const secure = target.protocol === 'wss:'
  const transporter = secure ? await import('node:https') : await import('node:http')
  const key = randomBytes(16).toString('base64')
  const expected = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')

  return new Promise((resolve, reject) => {
    const request = transporter.request({
      hostname: target.hostname,
      port: target.port === '' ? (secure ? 443 : 80) : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
      },
      timeout: 15000,
      rejectUnauthorized: true,
    })

    request.on('upgrade', (response, socket, head) => {
      if (response.headers['sec-websocket-accept'] !== expected) {
        socket.destroy()
        reject(new Error('The relay answered an invalid WebSocket handshake.'))
        return
      }
      resolve({ socket, rest: head, writer: new FrameWriter(socket), reader: new FrameReader() })
    })
    request.on('response', (response) => {
      reject(new Error(`The relay refused the tunnel (HTTP ${response.statusCode}).`))
      response.resume()
    })
    request.on('error', reject)
    request.on('timeout', () => {
      request.destroy()
      reject(new Error('The relay did not answer the tunnel handshake in time.'))
    })
    request.end()
  })
}

/**
 * The tunnel client.
 *
 * Emits `state` with `{ status, message, publicUrl, since, bytesUp, bytesDown, requests }`.
 */
export class RelayClient extends EventEmitter {
  #settings
  #localOrigin
  #state = { status: 'off', message: '', publicUrl: '', since: 0, bytesUp: 0, bytesDown: 0, requests: 0 }
  #socket
  #writer
  #pingTimer
  #reconnectTimer
  #attempt = 0
  #stopped = true

  /**
   * @param options - `getSettings()` and `localOrigin()` reading DSH's own origin.
   */
  constructor(options) {
    super()
    this.#settings = options.getSettings
    this.#localOrigin = options.localOrigin ?? (() => 'http://127.0.0.1:0')
  }

  /** The current status snapshot. */
  get state() {
    return { ...this.#state }
  }

  /** Publish a state change. */
  #set(patch) {
    this.#state = { ...this.#state, ...patch }
    this.emit('state', this.state)
  }

  /** Connect if configured; no-op when disabled or already running. */
  async start() {
    const config = this.#settings().relay
    if (config.enabled !== true) {
      this.#set({ status: 'off', message: 'Remote access is switched off.' })
      return
    }
    if (typeof config.serverUrl !== 'string' || config.serverUrl === '') {
      this.#set({ status: 'error', message: 'Enter the relay server URL first.' })
      return
    }
    if (typeof config.token !== 'string' || config.token === '') {
      this.#set({ status: 'error', message: 'Sign in to the relay first.' })
      return
    }
    this.#stopped = false
    await this.#connect()
  }

  /** Stop the tunnel and cancel any pending reconnect. */
  stop() {
    this.#stopped = true
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = undefined
    }
    this.#teardown(1000)
    this.#set({ status: 'off', message: '', publicUrl: '' })
  }

  /** Close the socket and its timers without changing the desired state. */
  #teardown(code) {
    if (this.#pingTimer !== undefined) {
      clearInterval(this.#pingTimer)
      this.#pingTimer = undefined
    }
    if (this.#writer !== undefined) {
      try {
        this.#writer.close(code)
      } catch {
        // The socket may already be gone.
      }
    }
    if (this.#socket !== undefined) {
      this.#socket.destroy()
      this.#socket = undefined
      this.#writer = undefined
    }
  }

  /** Open one connection and wire its handlers. */
  async #connect() {
    if (this.#stopped) return
    const config = this.#settings().relay
    const url = new URL(config.serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/tunnel')
    url.searchParams.set('token', config.token)
    if (config.tunnelName !== '') url.searchParams.set('name', config.tunnelName)

    this.#set({ status: 'connecting', message: '' })
    try {
      const connection = await connectSocket(url.toString())
      if (this.#stopped) {
        connection.socket.destroy()
        return
      }
      this.#socket = connection.socket
      this.#writer = connection.writer
      this.#attempt = 0
      this.#set({ status: 'online', message: '', since: Date.now(), publicUrl: config.serverUrl })

      this.#pingTimer = setInterval(() => {
        try {
          this.#writer?.json({ t: 'ping' })
        } catch {
          this.#teardown(1001)
        }
      }, PING_INTERVAL_MS)

      const reader = connection.reader
      const onData = (chunk) => {
        let frames
        try {
          frames = reader.push(chunk)
        } catch (error) {
          this.#fail(error?.message ?? 'The tunnel received an unreadable frame.')
          return
        }
        for (const frame of frames) this.#onFrame(frame)
      }
      connection.socket.on('data', onData)
      connection.socket.on('error', (error) => this.#fail(error?.message ?? 'The tunnel socket failed.'))
      connection.socket.on('close', () => {
        if (this.#socket === connection.socket) this.#fail('The relay closed the tunnel.', true)
      })
      if (connection.rest.length > 0) onData(connection.rest)
    } catch (error) {
      this.#fail(error?.message ?? 'The tunnel could not connect.')
    }
  }

  /** Handle one decoded frame. */
  #onFrame(frame) {
    if (frame.opcode === 0x8) {
      this.#fail('The relay closed the tunnel.')
      return
    }
    if (frame.opcode === 0x9) {
      this.#writer?.write(0xA, frame.payload)
      return
    }
    if (frame.opcode !== 0x1 && frame.opcode !== 0x2) return
    let message
    try {
      message = JSON.parse(frame.payload.toString('utf8'))
    } catch {
      return
    }
    if (message?.t === 'ping') {
      this.#writer?.json({ t: 'pong' })
      return
    }
    if (message?.t === 'req') {
      this.#forward(message)
    }
  }

  /** Mark the tunnel failed and schedule a reconnect. */
  #fail(message, allowReconnect = true) {
    this.#teardown(1001)
    this.#set({ status: 'error', message })
    if (!this.#stopped && allowReconnect) this.#scheduleReconnect()
  }

  /** Reconnect with capped exponential backoff and jitter. */
  #scheduleReconnect() {
    if (this.#stopped) return
    if (this.#reconnectTimer !== undefined) return
    this.#attempt++
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (this.#attempt - 1))
    const delay = Math.round(base * (0.5 + Math.random() * 0.5))
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      this.#connect()
    }, delay)
  }

  /**
   * Forward one relayed request to the local DSH listener.
   * @param request - `{ id, method, path, query, headers, bodyB64 }`.
   */
  async #forward(request) {
    const id = request?.id
    const respond = (payload) => {
      try {
        this.#writer?.json({ t: 'res', id, ...payload })
      } catch {
        // The tunnel may have closed while the request was in flight.
      }
    }

    const bodyLength = typeof request?.bodyB64 === 'string' ? Buffer.byteLength(request.bodyB64, 'base64') : 0
    if (bodyLength > MAX_BODY_BYTES) {
      respond({ status: 413, headers: { 'content-type': 'text/plain' }, bodyB64: Buffer.from('Request body too large.').toString('base64') })
      return
    }

    const origin = this.#localOrigin()
    const target = new URL(`${request?.path ?? '/'}${request?.query ? `?${request.query}` : ''}`, origin)
    const headers = { ...(request?.headers ?? {}) }
    // The Host half of DSH checks the request's own Host header, so it must
    // name the local listener rather than the public relay hostname.
    headers.host = target.host
    delete headers.connection
    delete headers.upgrade
    delete headers['content-length']

    try {
      const response = await fetch(target, {
        method: request?.method ?? 'GET',
        headers,
        body: bodyLength > 0 ? Buffer.from(request.bodyB64, 'base64') : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(120000),
      })
      const buffer = Buffer.from(await response.arrayBuffer())
      const outHeaders = {}
      response.headers.forEach((value, name) => {
        if (name === 'transfer-encoding' || name === 'connection') return
        outHeaders[name] = value
      })
      this.#state.bytesDown += buffer.length
      this.#state.requests++
      respond({ status: response.status, headers: outHeaders, bodyB64: buffer.toString('base64') })
    } catch (error) {
      respond({
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        bodyB64: Buffer.from(`The local DSH listener did not answer: ${error?.message ?? error}`).toString('base64'),
      })
    }
  }

  /**
   * Register or sign in against the relay.
   * @param mode - `'register'` or `'login'`.
   * @param credentials - `{ account, password }`.
   * @returns `{ token? }` from the relay.
   */
  async authenticate(mode, credentials) {
    const config = this.#settings().relay
    if (typeof config.serverUrl !== 'string' || config.serverUrl === '') throw new Error('Enter the relay server URL first.')
    const base = config.serverUrl.replace(/\/+$/, '')
    const response = await fetch(`${base}/api/${mode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: credentials.account, password: credentials.password }),
      signal: AbortSignal.timeout(20000),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`The relay answered ${response.status} with a non-JSON body.`)
    }
    if (!response.ok) throw new Error(parsed?.error ?? `The relay answered ${response.status}.`)
    return parsed
  }

  /** Test reachability without keeping the tunnel. */
  async probe() {
    const config = this.#settings().relay
    if (typeof config.serverUrl !== 'string' || config.serverUrl === '') throw new Error('Enter the relay server URL first.')
    const response = await fetch(`${config.serverUrl.replace(/\/+$/, '')}/healthz`, {
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`The relay answered ${response.status}.`)
    return { ok: true, message: config.serverUrl }
  }
}
