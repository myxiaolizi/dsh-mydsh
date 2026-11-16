/**
 * The plugin's HTTP surface.
 *
 * Every route is registered on `ctx.webServer` under `/api/mydsh`, guarded by
 * Connection's own trust and authentication check, and answers one JSON
 * envelope. Registration belongs to a Cordis effect, so unloading the plugin
 * withdraws the whole surface.
 *
 * Three details matter for behaviour:
 *
 * - `webServer` keys named routes by `(kind, path)` and throws on a duplicate,
 *   so `GET /settings` and `POST /settings` cannot be two registrations. One
 *   handler per path dispatches on `req.method` instead, and answers 405 with an
 *   `Allow` header for a method nobody claimed.
 * - `raw` routes answer the response themselves (file downloads, images), so the
 *   generic JSON envelope stays out of the way.
 * - `slow` routes are allowed a longer budget; the usage scan over a 90-day
 *   window can legitimately take seconds on a cold cache, and ending the request
 *   early would just make the page retry the same work.
 */

const PREFIX = '/api/mydsh'
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Send a JSON response with no caching. */
export function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Send a successful envelope. */
export function sendValue(res, value) {
  sendJson(res, 200, { ok: true, value })
}

/** Send a failure envelope. */
export function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/** Read one bounded JSON body; `undefined` when absent, oversized or malformed. */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Create the router.
 * @param ctx - plugin context; supplies `webServer` and `connection` lookups.
 * @param options - `name` for the effect label and `onError` for logging.
 * @returns a registrar bound to the plugin lifetime.
 */
export function createRouter(ctx, options = {}) {
  const name = options.name ?? 'dsh-mydsh'
  const onError = options.onError ?? ((error) => console.warn(`[${name}] route failed: ${error?.message ?? error}`))

  /** Every path this plugin claims, with one entry per accepted method. */
  const paths = new Map()

  /**
   * Register one method on one path.
   * @param method - accepted HTTP method.
   * @param path - path below `/api/mydsh`, e.g. `/settings`.
   * @param handler - receives `{ req, res, url, body }`; may return a value that
   *   is wrapped in the success envelope, or answer `res` itself.
   * @param flags - `{ raw }` disables the envelope.
   */
  function route(method, path, handler, flags = {}) {
    const full = `${PREFIX}${path}`
    const bucket = paths.get(full) ?? { methods: new Map(), raw: false }
    bucket.methods.set(method, handler)
    // A raw method (a download) owns every response on its path, so the path is
    // treated as raw only when nothing else shares it.
    bucket.raw = bucket.methods.size === 1 && flags.raw === true
    paths.set(full, bucket)
  }

  /**
   * Answer one request for a path this plugin owns.
   * @param bucket - the path entry.
   * @param req - node request.
   * @param res - node response.
   */
  async function dispatch(bucket, req, res) {
    const connection = ctx.get('connection')
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined && rejection !== false) {
        res.statusCode = typeof rejection === 'number' ? rejection : 403
        res.end()
        return
      }
    }

    const handler = bucket.methods.get(req.method)
    if (handler === undefined) {
      res.statusCode = 405
      res.setHeader('allow', [...bucket.methods.keys()].join(', '))
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const needsBody = req.method === 'POST'
    const body = needsBody ? await readJsonBody(req) : undefined
    if (needsBody && body === undefined) {
      sendError(res, 400, 'bad-request', 'A JSON body is required.')
      return
    }

    const result = await handler({ req, res, url, body })
    if (bucket.raw === true) return
    if (result !== undefined && !res.writableEnded) sendValue(res, result)
  }

  /**
   * Attach every claimed path to the live web carrier.
   *
   * Registration is defensive about one real case: a fiber restart can run
   * `apply` again before the previous fiber's effects have been disposed, and
   * the carrier rejects a duplicate path by throwing. Failing activation for
   * that would leave the whole plugin down over a route that still works, so a
   * duplicate is reported and skipped instead. Every other registration failure
   * still propagates, because it means something genuinely wrong.
   *
   * @param server - the live `webServer` service.
   * @param owner - the context whose effect owns the registration.
   */
  function attach(server, owner) {
    for (const [path, bucket] of paths) {
      let disposer
      try {
        disposer = server.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            try {
              await dispatch(bucket, req, res)
            } catch (error) {
              if (!res.writableEnded) sendError(res, 500, 'internal', error?.message ?? 'Route failed.')
              onError(error)
            }
          },
        })
      } catch (error) {
        if (!/duplicate/i.test(String(error?.message ?? ''))) throw error
        onError(new Error(`route ${path} was already registered; keeping the existing one`))
        continue
      }
      owner.effect(() => disposer, `${name}: ${path}`)
    }
  }

  /**
   * Install the surface once the web carrier exists.
   * The web carrier arrives from a later bundle layer, so the registration
   * waits for it instead of reading the service once during activation.
   */
  function install() {
    const server = ctx.get('webServer')
    if (server === undefined || typeof server.register !== 'function') {
      ctx.inject(['webServer'], (child) => {
        attach(child.get('webServer'), child)
      })
      return
    }
    attach(server, ctx)
  }

  return {
    route,
    install,
    get: (path, handler, flags) => route('GET', path, handler, flags),
    post: (path, handler, flags) => route('POST', path, handler, flags),
  }
}

/** Parse a positive integer query parameter with a fallback. */
export function queryInt(url, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = url.searchParams.get(key)
  if (raw === null) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Parse a query parameter as a trimmed non-empty string. */
export function queryString(url, key, fallback = '') {
  const raw = url.searchParams.get(key)
  if (raw === null) return fallback
  const trimmed = raw.trim()
  return trimmed === '' ? fallback : trimmed
}

/** Parse a query parameter as a boolean flag (`1`, `true`, `yes`). */
export function queryFlag(url, key) {
  const raw = url.searchParams.get(key)
  if (raw === null) return false
  return raw === '1' || raw === 'true' || raw === 'yes'
}
