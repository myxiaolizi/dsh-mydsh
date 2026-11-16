/**
 * Image generation through an OpenAI-compatible endpoint.
 *
 * Only one protocol is implemented — `POST /v1/images/generations` — because
 * that is the only shape every gateway, relay and local server agrees on. The
 * module never guesses an endpoint for a provider that does not publish one:
 * `deepseek` is a first-class value in the settings document, and the honest
 * answer for it is that DeepSeek's public API has no image endpoint yet. Saying
 * so is better than inventing a URL, which would produce a confusing 404 at
 * generation time and a support ticket.
 *
 * Files land on disk rather than being returned as base64 to the browser: a
 * 1024x1024 PNG is roughly 1.5 MB of base64 per image and four of those in one
 * JSON envelope is a visible stall in the settings page. The route layer serves
 * them back by name through `/api/mydsh/images/file`.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { LIMITS, budget, describe, failure, intIn, moduleSettings, record, text, withinDir } from '../shared.js'

/** One request budget. An image endpoint is slower than a chat endpoint. */
const GENERATE_TIMEOUT_MS = 120000

/** Hard ceiling on images per call, matching the contract. */
const MAX_COUNT = 4

/**
 * Accepted `size` values.
 *
 * A whitelist rather than a pattern: the upstream API rejects an unusual size
 * with an opaque 400, so the useful behaviour is to refuse it locally with a
 * message that names the accepted set.
 */
const SIZES = Object.freeze(['256x256', '512x512', '768x768', '1024x1024', '1024x1536', '1536x1024', '1792x1024', '1024x1792', 'auto'])

/** Largest single image this module will buffer from a remote URL. */
const MAX_IMAGE_BYTES = 24 * 1024 * 1024

/** Content types it will accept for an image body. */
const MIME_EXTENSION = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
})

/**
 * Trim a configured base URL to the part before `/v1`, then rebuild one path.
 *
 * Users paste either `https://host/v1`, `https://host/v1/` or `https://host`,
 * and all three mean the same endpoint. Normalising here keeps the request
 * builder a single expression.
 * @param baseUrl - configured base.
 * @returns an absolute URL, or `''` when the value is not usable.
 */
function endpointOf(baseUrl, suffix) {
  const raw = text(baseUrl, LIMITS.url)
  if (raw === '') return ''
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
  let path = parsed.pathname.replace(/\/+$/, '')
  // Accept both a bare host and a host that already carries the API prefix.
  path = path.replace(/\/v1$/i, '')
  return `${parsed.origin}${path}/v1/${suffix}`
}

/**
 * Create the image generator.
 * @param options.ctx - plugin context; unused services degrade silently.
 * @param options.getSettings - synchronous settings reader.
 * @param options.dshHome - the plugin's private directory.
 * @returns the module surface used by `/images/*`.
 */
export function createImageGen({ ctx: _ctx, getSettings, dshHome }) {
  const settingsOf = () => moduleSettings(getSettings, 'imageGen')

  /**
   * Where images are written.
   * An explicit `saveDir` is honoured, but only as a directory that already
   * exists or can be created — the path itself is user configuration, not model
   * output, so it needs no traversal guard beyond a length bound.
   */
  function directoryOf(settings) {
    const configured = text(settings.saveDir, LIMITS.command)
    return configured === '' ? join(dshHome, 'images') : configured
  }

  /**
   * Whether generation can be attempted at all, and why not.
   * @returns `{ available, reason }`.
   */
  function availability() {
    const settings = settingsOf()
    if (settings.enabled !== true) return { available: false, reason: '图像生成模块未启用' }
    const provider = text(settings.provider, 32) || 'openai-compatible'
    if (provider === 'deepseek') {
      return { available: false, reason: 'DeepSeek 官方暂未提供图像生成接口' }
    }
    if (text(settings.baseUrl, LIMITS.url) === '') return { available: false, reason: '尚未配置 Base URL' }
    if (endpointOf(settings.baseUrl, 'images/generations') === '') return { available: false, reason: 'Base URL 不是合法的 http(s) 地址' }
    return { available: true, reason: '' }
  }

  /** Current default size, clamped to the whitelist. */
  function resolveSize(requested, fallback) {
    const candidate = text(requested, 32).toLowerCase()
    if (SIZES.includes(candidate)) return candidate
    const configured = text(fallback, 32).toLowerCase()
    return SIZES.includes(configured) ? configured : '1024x1024'
  }

  /**
   * Build the exact request body sent upstream.
   *
   * Exported behaviour matters for the self-test and for support: the shape is
   * `{ model, prompt, n, size, response_format }` and nothing else, because an
   * unknown field is a 400 on several gateways.
   * @param options - resolved prompt, count, size, model.
   * @returns the JSON body.
   */
  function requestBody({ prompt, count, size, model }) {
    return {
      model,
      prompt,
      n: count,
      size,
      response_format: 'b64_json',
    }
  }

  /**
   * Decode a `data:` URL or a remote `url` field into bytes.
   *
   * `b64_json` is preferred on the request so the usual answer needs no second
   * network hop, but several gateways ignore the preference and answer with a
   * URL anyway, so both are handled.
   * @param entry - one element of the upstream `data` array.
   * @param signal - the request budget.
   * @returns `{ bytes, mime }`.
   */
  async function decodeImage(entry, signal) {
    const base64 = text(entry?.b64_json, MAX_IMAGE_BYTES * 2)
    if (base64 !== '') {
      const bytes = Buffer.from(base64, 'base64')
      if (bytes.length === 0) throw new Error('上游返回了空的图像数据')
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('上游返回的图像超过大小上限')
      return { bytes, mime: sniffMime(bytes) }
    }
    const url = text(entry?.url, LIMITS.url)
    if (url === '') throw new Error('上游既没有返回 b64_json 也没有返回 url')
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',')
      if (comma < 0) throw new Error('无法解析 data: 图像')
      const header = url.slice(5, comma)
      const mime = header.split(';')[0] || 'image/png'
      const bytes = Buffer.from(url.slice(comma + 1), 'base64')
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('上游返回的图像超过大小上限')
      return { bytes, mime: MIME_EXTENSION[mime] === undefined ? sniffMime(bytes) : mime }
    }
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('上游返回的图像地址不合法')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('上游返回的图像地址协议不受支持')
    const response = await fetch(parsed, { signal })
    if (!response.ok) throw new Error(`下载图像失败：HTTP ${String(response.status)}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0) throw new Error('下载到的图像为空')
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('下载到的图像超过大小上限')
    const header = String(response.headers.get('content-type') ?? '').toLowerCase()
    const declared = Object.keys(MIME_EXTENSION).find((mime) => header.startsWith(mime))
    return { bytes: buffer, mime: declared ?? sniffMime(buffer) }
  }

  /**
   * Generate images.
   * @param options.prompt - the description.
   * @param options.count - 1..4.
   * @param options.size - one of {@link SIZES}.
   * @param options.model - overrides the configured model for this call.
   * @returns `{ images: [{ path, url, mime }] }` or a structured failure.
   */
  async function generate({ prompt, count, size, model } = {}) {
    const settings = settingsOf()
    const view = availability()
    if (!view.available) return failure(view.reason)

    const description = typeof prompt === 'string' ? prompt.trim() : ''
    if (description === '') return failure('缺少图像描述 prompt')
    if (description.length > LIMITS.prompt) return failure(`图像描述不能超过 ${String(LIMITS.prompt)} 个字符`)

    const total = intIn(count, intIn(settings.count, 1, 1, MAX_COUNT), 1, MAX_COUNT)
    const resolvedSize = resolveSize(size, settings.size)
    const resolvedModel = text(model, 128) || text(settings.model, 128) || 'gpt-image-1'
    const endpoint = endpointOf(settings.baseUrl, 'images/generations')
    const apiKey = text(settings.apiKey, 512)

    const headers = { 'content-type': 'application/json', accept: 'application/json' }
    if (apiKey !== '') headers.authorization = `Bearer ${apiKey}`

    const watch = budget(GENERATE_TIMEOUT_MS, 'the image request exceeded 120s')
    let payload
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody({ prompt: description, count: total, size: resolvedSize, model: resolvedModel })),
        signal: watch.signal,
      })
      const body = await response.text()
      if (!response.ok) {
        const hint = body.slice(0, 300).replace(/\s+/g, ' ')
        return failure(`图像接口返回 HTTP ${String(response.status)}：${hint || response.statusText}`)
      }
      try {
        payload = JSON.parse(body)
      } catch {
        return failure('图像接口返回的不是 JSON')
      }
    } catch (error) {
      return failure(watch.signal.aborted ? '图像生成超时（120 秒）' : describe(error))
    } finally {
      watch.cancel()
    }

    const rows = Array.isArray(record(payload)?.data) ? payload.data : []
    if (rows.length === 0) {
      const upstream = text(record(payload)?.error?.message, LIMITS.message)
      return failure(upstream === '' ? '图像接口没有返回任何图像' : `图像接口报错：${upstream}`)
    }

    const directory = directoryOf(settings)
    try {
      await mkdir(directory, { recursive: true })
    } catch (error) {
      return failure(`无法创建图像目录：${describe(error)}`)
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const images = []
    const failed = []
    // A partial success is reported honestly: one broken image out of four must
    // not discard the three that worked.
    for (const [index, entry] of rows.slice(0, MAX_COUNT).entries()) {
      try {
        const decoded = await decodeImage(entry, watch.signal)
        const extension = MIME_EXTENSION[decoded.mime] ?? 'png'
        const name = `${stamp}-${String(index + 1)}.${extension}`
        const path = withinDir(directory, basename(name))
        if (path === undefined) throw new Error('生成的图像文件名不合法')
        await writeFile(path, decoded.bytes)
        images.push({ path, url: `/api/mydsh/images/file?name=${encodeURIComponent(basename(path))}`, mime: decoded.mime })
      } catch (error) {
        failed.push(describe(error))
      }
    }

    if (images.length === 0) {
      return failure(failed[0] ?? '图像写入失败')
    }
    return {
      images,
      failed,
      model: resolvedModel,
      size: resolvedSize,
      requested: total,
    }
  }

  return { generate, availability, requestBody }
}

/**
 * Identify an image from its leading bytes.
 *
 * The upstream `content-type` is advisory; several gateways answer
 * `application/octet-stream` for a perfectly good PNG, and saving one as `.png`
 * when it is a JPEG breaks later thumbnailing.
 * @param bytes - the decoded body.
 */
function sniffMime(bytes) {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (b.length >= 6 && b.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  return 'image/png'
}

/** Exported for the self-test: the accepted size vocabulary and endpoint rule. */
export const IMAGE_CONTRACT = Object.freeze({ SIZES, MAX_COUNT, GENERATE_TIMEOUT_MS, endpointOf })
