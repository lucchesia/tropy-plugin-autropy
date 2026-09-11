// Shared test doubles.
//
// The gateway takes its `fetch` by injection precisely so these tests can run
// the identity and write-outcome logic without a live Tropy.

export const PROJECT_PATH = '/Users/x/Archives/Field Notes 1940.tropy'

// The id Tropy stores — already percent-encoded by its own urlId().
export const PROJECT_ID = 'Field%20Notes%201940'

// The same id as a URL path segment, encoded again so @koa/router's single
// decode yields PROJECT_ID. Verified against a live Tropy 1.18.0-beta.5.
export const PROJECT_SEGMENT = encodeURIComponent(PROJECT_ID)

export const PORT = 2029
export const ROOT = `http://localhost:${PORT}`
export const SCOPED = `${ROOT}/project/${PROJECT_SEGMENT}`

export function jsonResponse (body, { status = 200, headers = {}, redirected = false } = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))

  return {
    ok: status >= 200 && status < 300,
    status,
    redirected,
    headers: { get: name => lower[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  }
}

// `GET /project/tags` as each Tropy answers it. Status cannot tell them apart —
// both are 200 — so `redirected` is the discriminator.
export const shimProbe = {
  // 1.18.0-beta.5+: the compatibility shim redirects to /project/current/tags.
  namespaced: () => jsonResponse([], { redirected: true }),
  // 1.17.3: flat routes serve it directly.
  flat: () => jsonResponse([], { redirected: false })
}

export function textResponse (body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => { throw new Error('not json') },
    text: async () => body
  }
}

// Identity probe response naming a project.
export function identity (path, extra = {}) {
  return jsonResponse(
    { project: path, id: PROJECT_ID, status: 'ok', version: '1.18.0-beta.5' },
    extra)
}

// Records every request so tests can assert how many probes happened — which is
// how `assertWriteTarget` freshness is proven.
export function recorder (handler) {
  const calls = []

  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body })
    return handler(url, init, calls.length)
  }

  return { fetch, calls }
}

export const silentLogger = { warn () {}, error () {} }
