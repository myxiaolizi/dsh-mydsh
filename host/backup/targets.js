/**
 * Backup destinations: a local directory, WebDAV, OSS, S3 and GitHub Gist.
 *
 * All five implement one small interface so the engine never branches on the
 * medium:
 *
 *   kind, label
 *   probe()                 -> { ok, message, latencyMs }
 *   put(name, localPath)    -> remote reference (string)
 *   get(name, localPath)    -> local path
 *   list()                  -> [{ name, bytes, at }]
 *   remove(name)            -> void
 *   getText(name)           -> string | undefined
 *   putText(name, text)     -> void
 *   maxObjectBytes          -> number | undefined
 *
 * Credentials live in the settings document and are supplied per call, so a
 * failed test never leaves a stale client behind.
 *
 * Both object-storage flavours sign with SigV4 derived from `node:crypto`. The
 * AWS SDK is deliberately not used: it is tens of megabytes, it would have to be
 * a runtime dependency of a plugin that otherwise has none, and the four
 * operations this engine needs are a hundred lines of canonicalisation each.
 *
 * `maxObjectBytes` exists because one medium is not like the others: a Gist is a
 * text document with a hard per-file ceiling, so the engine must be told to
 * refuse rather than let GitHub truncate a backup silently.
 */

import { createHash, createHmac } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ensureDir, listDir } from '../core/store.js'
import { inside } from './paths.js'

/** Files this engine may create or delete at a destination. */
const OWN_PREFIX = 'dsh-mydsh-'

/** The name of the sync index every target can carry. */
export const MANIFEST_NAME = 'manifest.json'

/** The Gist per-file ceiling, in bytes of the payload before base64. */
const GIST_LIMIT_BYTES = 10 * 1024 * 1024

/** Encode one path segment the way SigV4 canonicalisation expects. */
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** Encode a whole key, keeping the separators. */
function encodeKey(key) {
  return key.split('/').map(encodeRfc3986).join('/')
}

/** Join path segments into a normalised remote path. */
function joinRemote(...parts) {
  return parts
    .filter((part) => typeof part === 'string' && part !== '')
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter((part) => part !== '')
    .join('/')
}

/** SHA-256 of a string, lowercase hex. */
function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** SHA-256 of a file, read as a stream so a 4 GiB part never enters memory. */
export async function sha256File(path) {
  const digest = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    digest.update(chunk)
    bytes += chunk.length
  }
  return { sha256: digest.digest('hex'), bytes }
}

/** Strip a run id prefix check: only files this engine named are managed. */
export function isOwnFile(name) {
  return typeof name === 'string' && name.startsWith(OWN_PREFIX)
}

/**
 * A local directory target.
 *
 * `put` renames when it can: a backup on the same volume should not be copied
 * byte by byte. When the rename crosses a volume boundary the copy fallback is
 * used, and either way the source is left for the engine to clean up so the byte
 * count can be measured before delivery.
 *
 * @param root - absolute directory to hold backup files.
 */
export function localTarget(root) {
  if (typeof root !== 'string' || root.trim() === '') throw new Error('Choose a backup folder.')
  const base = root.trim()
  return {
    kind: 'local',
    label: base,
    maxObjectBytes: undefined,
    async probe() {
      const started = Date.now()
      await ensureDir(base)
      const probe = join(base, `.dsh-mydsh-probe-${process.pid}-${Date.now()}`)
      await writeFile(probe, 'ok')
      await rm(probe, { force: true })
      return { ok: true, message: base, latencyMs: Date.now() - started }
    },
    async put(name, path) {
      await ensureDir(base)
      const target = join(base, name)
      if (!inside(base, target)) throw new Error(`Refusing to write outside the backup folder: ${name}`)
      try {
        await rename(path, target)
      } catch {
        await copyFile(path, target)
      }
      return target
    },
    async get(name, destination) {
      const source = join(base, name)
      if (!inside(base, source)) throw new Error(`Refusing to read outside the backup folder: ${name}`)
      await ensureDir(dirname(destination))
      await copyFile(source, destination)
      return destination
    },
    async list() {
      const out = []
      for (const entry of await listDir(base)) {
        if (!entry.isFile()) continue
        const info = await stat(join(base, entry.name)).catch(() => undefined)
        if (info === undefined) continue
        out.push({ name: entry.name, bytes: info.size, at: info.mtimeMs })
      }
      return out
    },
    async remove(name) {
      const target = join(base, name)
      if (!inside(base, target)) throw new Error(`Refusing to delete outside the backup folder: ${name}`)
      await rm(target, { force: true })
    },
    async getText(name) {
      try {
        return await readFile(join(base, name), 'utf8')
      } catch {
        return undefined
      }
    },
    async putText(name, text) {
      await ensureDir(base)
      await writeFile(join(base, name), text, 'utf8')
    },
  }
}

/**
 * A WebDAV target using plain HTTP verbs.
 * @param config - `{ url, username, password, remotePath }`.
 */
export function webdavTarget(config) {
  const baseUrl = config.url?.trim().replace(/\/+$/, '')
  if (baseUrl === undefined || baseUrl === '') throw new Error('Enter the WebDAV server URL.')
  const remoteRoot = joinRemote(config.remotePath || 'dsh-mydsh')
  const auth =
    config.username || config.password
      ? `Basic ${Buffer.from(`${config.username ?? ''}:${config.password ?? ''}`).toString('base64')}`
      : undefined

  /** Absolute URL of one remote file. */
  const urlOf = (name) => {
    const segments = joinRemote(remoteRoot, name).split('/').map(encodeRfc3986)
    return `${baseUrl}/${segments.join('/')}`
  }

  /** Absolute URL of the remote collection. */
  const collectionUrl = () => `${baseUrl}/${joinRemote(remoteRoot).split('/').map(encodeRfc3986).join('/')}/`

  /** Perform one WebDAV request with the configured credentials. */
  async function request(method, url, body, headers = {}, timeoutMs = 60000) {
    return fetch(url, {
      method,
      headers: { ...(auth === undefined ? {} : { authorization: auth }), ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
  }

  /** Treat a 401/403 as the credential message a user can act on. */
  function rejectIfUnauthorised(status) {
    if (status === 401 || status === 403) throw new Error('The WebDAV server rejected these credentials.')
  }

  /** Create one remote collection, tolerating "already exists". */
  async function ensureCollection(url) {
    const response = await request('MKCOL', url)
    if (response.status === 201 || response.status === 200 || response.status === 301) return
    if (response.status === 405 || response.status === 409) return
    rejectIfUnauthorised(response.status)
  }

  /** Create the remote directory chain below the server root. */
  async function ensureRemoteTree() {
    let current = baseUrl
    for (const segment of joinRemote(remoteRoot).split('/').filter((part) => part !== '')) {
      current = `${current}/${encodeRfc3986(segment)}`
      await ensureCollection(current)
    }
  }

  /** Decode one XML entity so an escaped name still matches. */
  function unescapeXml(value) {
    return value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
  }

  return {
    kind: 'webdav',
    label: baseUrl,
    maxObjectBytes: undefined,
    async probe() {
      const started = Date.now()
      const response = await request('PROPFIND', baseUrl, undefined, { depth: '0' }, 20000)
      rejectIfUnauthorised(response.status)
      if (response.status >= 400 && response.status !== 405) {
        throw new Error(`The WebDAV server answered ${response.status}.`)
      }
      await ensureRemoteTree()
      return { ok: true, message: baseUrl, latencyMs: Date.now() - started }
    },
    async put(name, path) {
      await ensureRemoteTree()
      const info = await stat(path)
      const response = await request(
        'PUT',
        urlOf(name),
        createReadStream(path),
        { 'content-length': String(info.size), 'content-type': 'application/octet-stream' },
        30 * 60 * 1000,
      )
      rejectIfUnauthorised(response.status)
      if (response.status >= 400) throw new Error(`WebDAV upload of ${name} failed with ${response.status}.`)
      return urlOf(name)
    },
    async get(name, destination) {
      const response = await request('GET', urlOf(name), undefined, {}, 30 * 60 * 1000)
      rejectIfUnauthorised(response.status)
      if (!response.ok) throw new Error(`WebDAV download of ${name} failed with ${response.status}.`)
      if (response.body === null) throw new Error('The WebDAV download returned no body.')
      await ensureDir(dirname(destination))
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
      return destination
    },
    async list() {
      const response = await request('PROPFIND', collectionUrl(), undefined, { depth: '1' }, 30000)
      if (response.status === 404) return []
      rejectIfUnauthorised(response.status)
      if (response.status >= 400) return []
      const text = await response.text()
      const out = []
      for (const block of text.split(/<[^>]*:?response[\s>]/i).slice(1)) {
        const href = /<[^>]*:?href[^>]*>([^<]+)</i.exec(block)?.[1]
        if (href === undefined) continue
        const decoded = unescapeXml(href)
        const name = decodeURIComponent(decoded.split('/').filter(Boolean).pop() ?? '')
        if (name === '' || decoded.endsWith('/')) continue
        if (!isOwnFile(name) && name !== MANIFEST_NAME) continue
        const sizeText = /<[^>]*:?getcontentlength[^>]*>(\d+)</i.exec(block)?.[1]
        const dateText = /<[^>]*:?getlastmodified[^>]*>([^<]+)</i.exec(block)?.[1]
        out.push({
          name,
          bytes: sizeText === undefined ? 0 : Number(sizeText),
          at: dateText === undefined ? 0 : Date.parse(dateText) || 0,
        })
      }
      return out
    },
    async remove(name) {
      const response = await request('DELETE', urlOf(name)).catch(() => undefined)
      if (response !== undefined) rejectIfUnauthorised(response.status)
    },
    async getText(name) {
      const response = await request('GET', urlOf(name), undefined, {}, 30000).catch(() => undefined)
      if (response === undefined || !response.ok) return undefined
      return response.text()
    },
    async putText(name, text) {
      await ensureRemoteTree()
      const body = Buffer.from(text, 'utf8')
      const response = await request(
        'PUT',
        urlOf(name),
        body,
        { 'content-length': String(body.length), 'content-type': 'application/json' },
        60000,
      )
      rejectIfUnauthorised(response.status)
      if (response.status >= 400) throw new Error(`WebDAV upload of ${name} failed with ${response.status}.`)
    },
  }
}

/**
 * One SigV4 signer covering both AWS S3 and Alibaba Cloud OSS.
 *
 * The two differ in three details, which is why they share code:
 *
 * - The algorithm label and the key prefix: `AWS4` / `s3` versus `aliyun_v4` /
 *   `oss`, with OSS also sending `x-oss-date` and `x-oss-content-sha256`.
 * - The service component of the credential scope.
 * - Whether an optional session token is sent.
 *
 * Everything else — the canonical request, the signed-header list, the string to
 * sign, the four-step key derivation — is identical, so one implementation with
 * a family switch is less likely to drift than two copies.
 */
function sigV4Signer(config, family) {
  const isOss = family === 'oss'
  const algorithm = isOss ? 'OSS4-HMAC-SHA256' : 'AWS4-HMAC-SHA256'
  const keyPrefix = isOss ? 'aliyun_v4' : 'AWS4'
  const service = isOss ? 'oss' : 's3'
  const terminator = isOss ? 'aliyun_v4_request' : 'aws4_request'
  const dateHeaderName = isOss ? 'x-oss-date' : 'x-amz-date'
  const hashHeaderName = isOss ? 'x-oss-content-sha256' : 'x-amz-content-sha256'

  /**
   * Sign one request.
   * @param options - method, host, canonicalPath (encoded), query (sorted pairs),
   *   region, payloadHash, extraHeaders (lowercase name -> value).
   * @returns the header map to send, including `authorization`.
   */
  return function sign(options) {
    const now = new Date()
    const amzDate = `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`
    const dateStamp = amzDate.slice(0, 8)
    const region = options.region !== undefined && options.region !== '' ? options.region : isOss ? 'cn-hangzhou' : 'us-east-1'

    /** @type {Record<string, string>} */
    const headers = {
      host: options.host,
      [dateHeaderName]: amzDate,
      [hashHeaderName]: options.payloadHash,
      ...(isOss ? { 'x-oss-version': '1' } : {}),
      ...(options.extraHeaders ?? {}),
    }
    if (config.sessionToken !== undefined && config.sessionToken !== '') {
      headers[isOss ? 'x-oss-security-token' : 'x-amz-security-token'] = config.sessionToken
    }

    const headerNames = Object.keys(headers).map((name) => name.toLowerCase()).sort()
    const canonicalHeaders = headerNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('')
    const signedHeaders = headerNames.join(';')

    const canonicalQuery = (options.query ?? [])
      .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)])
      .sort((left, right) => (left[0] === right[0] ? (left[1] < right[1] ? -1 : 1) : left[0] < right[0] ? -1 : 1))
      .map(([key, value]) => `${key}=${value}`)
      .join('&')

    const canonicalRequest = [
      options.method,
      options.canonicalPath,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      options.payloadHash,
    ].join('\n')

    const scope = `${dateStamp}/${region}/${service}/${terminator}`
    const stringToSign = [algorithm, amzDate, scope, sha256Hex(canonicalRequest)].join('\n')

    let signingKey = createHmac('sha256', `${keyPrefix}${config.accessKeySecret}`).update(dateStamp).digest()
    signingKey = createHmac('sha256', signingKey).update(region).digest()
    signingKey = createHmac('sha256', signingKey).update(service).digest()
    signingKey = createHmac('sha256', signingKey).update(terminator).digest()
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

    return {
      ...headers,
      authorization: `${algorithm} Credential=${config.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
    }
  }
}

/**
 * An object-storage target for AWS S3 and Alibaba Cloud OSS.
 *
 * Addressing: `pathStyle` puts the bucket in the path
 * (`https://endpoint/bucket/key`), otherwise in the host
 * (`https://bucket.endpoint/key`). S3-compatible services frequently only
 * accept one of the two, which is why the switch exists rather than being
 * inferred.
 *
 * @param config - `{ endpoint, region, bucket, accessKeyId, accessKeySecret, remotePath, pathStyle, publicBaseUrl }`.
 * @param family - `'s3'` or `'oss'`.
 */
export function objectStorageTarget(config, family) {
  const isOss = family === 'oss'
  const rawEndpoint = config.endpoint?.trim().replace(/\/+$/, '')
  if (rawEndpoint === undefined || rawEndpoint === '') {
    throw new Error(isOss ? 'Enter the OSS endpoint, for example oss-cn-hangzhou.aliyuncs.com.' : 'Enter the S3 endpoint.')
  }
  if (!config.bucket) throw new Error('Enter the bucket name.')
  if (!config.accessKeyId || !config.accessKeySecret) throw new Error('Enter the access key id and secret.')

  const withScheme = /^https?:\/\//.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`
  const parsed = new URL(withScheme)
  const endpointHost = parsed.host.replace(/\/+$/, '')
  const scheme = parsed.protocol.replace(':', '')
  const bucket = String(config.bucket).trim()
  const pathStyle = config.pathStyle === true
  const host = pathStyle ? endpointHost : `${bucket}.${endpointHost}`
  const base = `${scheme}://${host}`
  const prefix = joinRemote(config.remotePath || 'dsh-mydsh')
  const sign = sigV4Signer(
    {
      accessKeyId: String(config.accessKeyId).trim(),
      accessKeySecret: String(config.accessKeySecret),
      sessionToken: config.sessionToken,
    },
    family,
  )

  /** Object key for one backup file. */
  const keyOf = (name) => joinRemote(prefix, name)

  /** Canonical (encoded) path for a key, including the bucket when path-style. */
  const canonicalPathOf = (key) => (pathStyle ? `/${encodeRfc3986(bucket)}/${encodeKey(key)}` : `/${encodeKey(key)}`)

  /** Absolute URL for a key. */
  const urlOf = (key) => `${base}${canonicalPathOf(key)}`

  /** Build the signed header map for one request. */
  const headersFor = (method, key, payloadHash, extraHeaders, query) =>
    sign({ method, host, canonicalPath: canonicalPathOf(key), query, region: config.region, payloadHash, extraHeaders })

  /** The empty-payload hash, used by every read and delete. */
  const EMPTY_HASH = sha256Hex('')

  return {
    kind: family,
    label: config.publicBaseUrl !== '' && config.publicBaseUrl !== undefined ? config.publicBaseUrl : `${bucket} @ ${endpointHost}`,
    maxObjectBytes: undefined,
    async probe() {
      const started = Date.now()
      const key = keyOf('.dsh-mydsh-probe')
      const body = Buffer.from('ok', 'utf8')
      const payloadHash = sha256Hex(body)
      const headers = headersFor('PUT', key, payloadHash, {
        'content-length': String(body.length),
        'content-type': 'text/plain',
      })
      const response = await fetch(urlOf(key), {
        method: 'PUT',
        headers,
        body,
        signal: AbortSignal.timeout(20000),
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`The bucket rejected the check (${response.status}): ${text.slice(0, 200)}`)
      }
      // Leave no trace of the probe.
      await fetch(urlOf(key), {
        method: 'DELETE',
        headers: headersFor('DELETE', key, EMPTY_HASH),
        signal: AbortSignal.timeout(10000),
      }).catch(() => undefined)
      return { ok: true, message: `${bucket} @ ${endpointHost}`, latencyMs: Date.now() - started }
    },
    async put(name, path) {
      const key = keyOf(name)
      const { sha256, bytes } = await sha256File(path)
      const headers = headersFor('PUT', key, sha256, {
        'content-length': String(bytes),
        'content-type': 'application/octet-stream',
      })
      const response = await fetch(urlOf(key), {
        method: 'PUT',
        headers,
        body: createReadStream(path),
        duplex: 'half',
        signal: AbortSignal.timeout(30 * 60 * 1000),
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`${family.toUpperCase()} upload of ${name} failed with ${response.status}: ${text.slice(0, 200)}`)
      }
      return urlOf(key)
    },
    async get(name, destination) {
      const key = keyOf(name)
      const response = await fetch(urlOf(key), {
        method: 'GET',
        headers: headersFor('GET', key, EMPTY_HASH),
        signal: AbortSignal.timeout(30 * 60 * 1000),
      })
      if (!response.ok || response.body === null) {
        throw new Error(`${family.toUpperCase()} download of ${name} failed with ${response.status}.`)
      }
      await ensureDir(dirname(destination))
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
      return destination
    },
    async list() {
      const listPrefix = `${prefix}/`
      // S3 speaks ListObjectsV2; OSS speaks the V1 form. Both answer XML with the
      // same `<Key>`/`<Size>` element pair, so only the request differs.
      const query = isOss
        ? [['prefix', listPrefix], ['max-keys', '1000']]
        : [['list-type', '2'], ['prefix', listPrefix], ['max-keys', '1000']]
      const key = pathStyle ? '' : ''
      const response = await fetch(urlOf(key), {
        method: 'GET',
        headers: headersFor('GET', key, EMPTY_HASH, undefined, query),
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok) return []
      const text = await response.text()
      const out = []
      for (const match of text.matchAll(/<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g)) {
        const name = unescapeXmlText(match[1]).split('/').pop() ?? ''
        const lastModified = /<LastModified>([^<]+)<\/LastModified>/.exec(match[0])?.[1]
        if (name === '') continue
        if (!isOwnFile(name) && name !== MANIFEST_NAME) continue
        out.push({ name, bytes: Number(match[2]), at: lastModified === undefined ? 0 : Date.parse(lastModified) || 0 })
      }
      return out
    },
    async remove(name) {
      const key = keyOf(name)
      await fetch(urlOf(key), {
        method: 'DELETE',
        headers: headersFor('DELETE', key, EMPTY_HASH),
        signal: AbortSignal.timeout(30000),
      }).catch(() => undefined)
    },
    async getText(name) {
      const key = keyOf(name)
      const response = await fetch(urlOf(key), {
        method: 'GET',
        headers: headersFor('GET', key, EMPTY_HASH),
        signal: AbortSignal.timeout(30000),
      }).catch(() => undefined)
      if (response === undefined || !response.ok) return undefined
      return response.text()
    },
    async putText(name, text) {
      const key = keyOf(name)
      const body = Buffer.from(text, 'utf8')
      const payloadHash = sha256Hex(body)
      const response = await fetch(urlOf(key), {
        method: 'PUT',
        headers: headersFor('PUT', key, payloadHash, {
          'content-length': String(body.length),
          'content-type': 'application/json',
        }),
        body,
        signal: AbortSignal.timeout(60000),
      })
      if (!response.ok) throw new Error(`${family.toUpperCase()} upload of ${name} failed with ${response.status}.`)
    },
  }
}

/** Decode the handful of XML entities an object key can contain. */
function unescapeXmlText(value) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

/**
 * A GitHub Gist target.
 *
 * A Gist is a text document, not an object store. Two consequences shape this
 * adapter:
 *
 * - A binary part cannot be stored as text, so it is base64-encoded and kept as
 *   `<name>.b64`. `list()` strips the suffix so the engine keeps seeing the
 *   plain name; `get()` decodes on the way out. Base64 costs a third more space
 *   on wire, and the ceiling below is enforced on the *raw* size so a part that
 *   fits at 9 MB is refused at 11 MB even though the encoded form would fit.
 * - The per-file ceiling is hard. GitHub truncates or rejects oversized files
 *   depending on the endpoint, and a silently truncated backup is worse than no
 *   backup, so `maxObjectBytes` is published for the engine to check up front.
 *
 * @param config - `{ token, gistId, remotePath }`.
 */
export function gistTarget(config) {
  const token = typeof config.token === 'string' ? config.token.trim() : ''
  if (token === '') throw new Error('Enter a GitHub token with the gist scope.')
  const apiBase = 'https://api.github.com'
  let gistId = typeof config.gistId === 'string' ? config.gistId.trim() : ''
  let createdId = ''

  /** The gist this target resolved to, which the caller may want to save. */
  const currentId = () => gistId

  /** One REST call against the Gist API. */
  async function rest(method, path, body) {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })
    return response
  }

  /** Read the gist's file map, or an empty one when the gist is absent. */
  async function readFiles() {
    const id = currentId()
    if (id === '') return {}
    const response = await rest('GET', `/gists/${encodeURIComponent(id)}`)
    if (response.status === 404) return {}
    if (!response.ok) throw new Error(`GitHub rejected the gist request with ${response.status}.`)
    const body = await response.json()
    return body?.files ?? {}
  }

  /** Create the gist when none is configured, remembering the id for the run. */
  async function ensureGist() {
    if (currentId() !== '') return
    const response = await rest('POST', '/gists', {
      description: 'dsh-mydsh backup',
      public: false,
      files: { 'README.txt': { content: 'Backups written by dsh-mydsh. Do not edit these files by hand.\n' } },
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Could not create the gist (${response.status}): ${text.slice(0, 200)}`)
    }
    const body = await response.json()
    if (typeof body?.id !== 'string') throw new Error('GitHub did not return a gist id.')
    gistId = body.id
    createdId = body.id
  }

  /** Write one file into the gist. */
  async function writeFile(fileName, content) {
    await ensureGist()
    const response = await rest('PATCH', `/gists/${encodeURIComponent(currentId())}`, {
      files: { [fileName]: { content } },
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`GitHub rejected the gist update (${response.status}): ${text.slice(0, 200)}`)
    }
  }

  return {
    kind: 'gist',
    label: currentId() === '' ? 'a new private gist' : `gist ${currentId()}`,
    maxObjectBytes: GIST_LIMIT_BYTES,
    /** The id GitHub assigned, so the settings page can offer to save it. */
    createdGistId: () => createdId,
    async probe() {
      const started = Date.now()
      if (currentId() === '') {
        // Creating a gist is the only proof the token has the `gist` scope; a
        // plain user lookup would pass with a token that cannot write.
        await ensureGist()
        return {
          ok: true,
          message: `A private gist was created: ${currentId()}. Save that id in the target so later backups reuse it.`,
          latencyMs: Date.now() - started,
        }
      }
      const response = await rest('GET', `/gists/${encodeURIComponent(currentId())}`)
      if (response.status === 401 || response.status === 403) throw new Error('GitHub rejected this token.')
      if (response.status === 404) throw new Error('That gist id does not exist, or this token cannot see it.')
      if (!response.ok) throw new Error(`GitHub answered ${response.status}.`)
      return { ok: true, message: `gist ${currentId()}`, latencyMs: Date.now() - started }
    },
    async put(name, path) {
      const info = await stat(path)
      if (info.size > GIST_LIMIT_BYTES) {
        throw new Error(
          `A gist cannot hold ${name}: it is ${(info.size / 1024 / 1024).toFixed(1)} MB and the limit is 10.0 MB. Choose another target, or turn on splitting with a size below 10 MB.`,
        )
      }
      const encoded = (await readFile(path)).toString('base64')
      await writeFile(`${name}.b64`, encoded)
      return `gist:${currentId()}/${name}.b64`
    },
    async get(name, destination) {
      const files = await readFiles()
      const base64Name = `${name}.b64`
      const encoded = files[base64Name]
      const plain = files[name]
      let content
      let isBase64 = false
      const record = encoded ?? plain
      if (record === undefined) throw new Error(`The gist does not hold ${name}.`)
      if (record.content !== undefined && record.truncated !== true) content = record.content
      else {
        const raw = record.raw_url
        if (typeof raw !== 'string') throw new Error(`The gist does not hold ${name}.`)
        const response = await fetch(raw, { signal: AbortSignal.timeout(120000) })
        if (!response.ok) throw new Error(`Could not download ${name} from the gist (${response.status}).`)
        content = await response.text()
      }
      isBase64 = encoded !== undefined
      const bytes = isBase64 ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8')
      await ensureDir(dirname(destination))
      await writeFile(destination, bytes)
      return destination
    },
    async list() {
      const files = await readFiles()
      const out = []
      for (const [fileName, record] of Object.entries(files)) {
        const name = fileName.endsWith('.b64') ? fileName.slice(0, -4) : fileName
        if (!isOwnFile(name) && name !== MANIFEST_NAME) continue
        out.push({ name, bytes: Number(record?.size ?? 0), at: 0 })
      }
      return out
    },
    async remove(name) {
      const id = currentId()
      if (id === '') return
      // Deleting a file from a gist is spelled as a null entry.
      const response = await rest('PATCH', `/gists/${encodeURIComponent(id)}`, {
        files: { [`${name}.b64`]: null, [name]: null },
      }).catch(() => undefined)
      if (response !== undefined && !response.ok) {
        throw new Error(`Could not remove ${name} from the gist (${response.status}).`)
      }
    },
    async getText(name) {
      const files = await readFiles()
      const record = files[name]
      if (record === undefined) return undefined
      if (record.content !== undefined && record.truncated !== true) return record.content
      if (typeof record.raw_url === 'string') {
        const response = await fetch(record.raw_url, { signal: AbortSignal.timeout(60000) }).catch(() => undefined)
        if (response !== undefined && response.ok) return response.text()
      }
      return undefined
    },
    async putText(name, text) {
      await writeFile(name, text)
    },
  }
}

/**
 * Build the target described by one `backup.targets[]` entry.
 * @param target - a normalised settings target, or `undefined`.
 */
export function createTarget(target) {
  if (target === undefined || target === null) throw new Error('Choose a backup destination first.')
  const kind = target.kind ?? 'local'
  if (kind === 'webdav') return webdavTarget(target)
  if (kind === 'oss') return objectStorageTarget(target, 'oss')
  if (kind === 's3') return objectStorageTarget(target, 's3')
  if (kind === 'gist') return gistTarget(target)
  return localTarget(target.path)
}

/**
 * Resolve the target a request means: an explicit id, else the active one.
 * @param config - `backup` from the settings document.
 * @param targetId - optional explicit id.
 */
export function resolveTarget(config, targetId) {
  const list = Array.isArray(config?.targets) ? config.targets : []
  if (list.length === 0) throw new Error('No backup destination is configured yet.')
  const wanted = typeof targetId === 'string' && targetId !== '' ? targetId : config.activeTargetId
  const found = list.find((entry) => entry.id === wanted) ?? list[0]
  if (found === undefined) throw new Error('That backup destination no longer exists in Settings.')
  return found
}

/** A short, credential-free description of a target for the run ledger. */
export function describeTarget(target) {
  if (target === undefined || target === null) return { kind: 'none', label: '' }
  const kind = target.kind ?? 'local'
  if (kind === 'local') return { kind, label: target.label || target.path || '', path: target.path ?? '' }
  if (kind === 'webdav') return { kind, label: target.label || redactUrl(target.url), url: redactUrl(target.url) }
  if (kind === 'gist') return { kind, label: target.label || 'gist', gistId: target.gistId ?? '' }
  return {
    kind,
    label: target.label || `${target.bucket ?? ''} @ ${target.endpoint ?? ''}`,
    bucket: target.bucket ?? '',
    endpoint: target.endpoint ?? '',
  }
}

/** Keep credentials out of anything the settings page renders. */
export function redactUrl(url) {
  if (typeof url !== 'string') return ''
  try {
    const parsed = new URL(url)
    if (parsed.username !== '' || parsed.password !== '') {
      parsed.username = '***'
      parsed.password = ''
    }
    return parsed.toString()
  } catch {
    return url
  }
}

/** Read a file into a buffer for restore tests. */
export async function readSmall(path) {
  return readFile(path)
}
