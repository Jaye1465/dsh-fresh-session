/**
 * Host half of the fresh-session bundle.
 *
 * The behavior lives in the Client half; this row exists so the bundle has a
 * Loader entry to hang the Client module on. While `diagnostics` is true it also
 * owns a loopback report route the Client half posts interception results to.
 */

/** Largest accepted report body, in bytes. */
const MAX_BODY = 256 * 1024

/** Retained reports; older entries are dropped first. */
const MAX_ENTRIES = 200

/** Required Host services. */
export const inject = ['webServer']

/**
 * Answer one request with JSON.
 * @param res - response owner.
 * @param status - HTTP status.
 * @param value - JSON-serializable body.
 */
function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Read a bounded request body as UTF-8 text.
 * @param req - request owner.
 * @returns the body text.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error(`body exceeds ${MAX_BODY} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/**
 * Mount the optional diagnostics route.
 * @param ctx - Host plugin context.
 * @param config - row config; `path` selects the prefix, `diagnostics` gates the route.
 */
export function apply(ctx, config = {}) {
  if (config.diagnostics !== true) return
  const base = typeof config.path === 'string' && config.path.startsWith('/')
    ? config.path.replace(/\/+$/u, '')
    : '/__fresh-session'
  const store = { startedAt: Date.now(), entries: [] }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${base}/probe`,
    handler: async (req, res) => {
      if (req.method === 'POST') {
        try {
          const parsed = JSON.parse(await readBody(req))
          store.entries.push(parsed)
          if (store.entries.length > MAX_ENTRIES) store.entries.shift()
          json(res, 202, { ok: true, kept: store.entries.length })
        } catch (error) {
          json(res, 400, { ok: false, error: String(error) })
        }
        return
      }
      if (req.method === 'DELETE') {
        store.entries.length = 0
        json(res, 200, { ok: true, cleared: true })
        return
      }
      json(res, 200, { ok: true, startedAt: store.startedAt, now: Date.now(), entries: store.entries })
    },
  }), 'fresh-session: diagnostics route')
}
