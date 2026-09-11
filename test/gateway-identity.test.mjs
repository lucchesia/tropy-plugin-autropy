// Identity resolution is where a silent wrong-project bug would hide: every
// read and write is addressed through whatever this returns.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ProjectIdentityError,
  RestProjectGateway,
  urlId
} from '../src/gateway.js'

import {
  PORT, PROJECT_ID, PROJECT_PATH, ROOT, SCOPED,
  identity, jsonResponse, recorder, shimProbe, silentLogger, textResponse
} from './helpers.mjs'

function gateway (fetch, { projectPath = PROJECT_PATH } = {}) {
  return new RestProjectGateway({ projectPath, port: PORT, logger: silentLogger, fetch })
}

test('urlId matches Tropy: basename without extension, URI-encoded', () => {
  assert.equal(urlId(PROJECT_PATH), PROJECT_ID)
  assert.equal(urlId('/a/b/Anita_Pele.tropy'), 'Anita_Pele')
  assert.equal(urlId(''), '')
  assert.equal(urlId(null), '')
})

test('prefers the id-scoped route when it names our project', async () => {
  const { fetch } = recorder(url => {
    if (url === SCOPED) return identity(PROJECT_PATH)
    throw new Error(`unexpected ${url}`)
  })

  const resolved = await gateway(fetch).resolve()

  assert.equal(resolved.shape, 'scoped')
  assert.equal(resolved.base, SCOPED)
  assert.equal(resolved.version, '1.18.0-beta.5')
})

test('never addresses /project/current', async () => {
  const { fetch, calls } = recorder(url => {
    if (url === SCOPED) return identity(PROJECT_PATH)
    throw new Error(`unexpected ${url}`)
  })

  const gw = gateway(fetch)
  await gw.resolve()
  await gw.getTags().catch(() => {})

  assert.ok(
    calls.every(c => !c.url.includes('/project/current')),
    `no request may target /project/current, saw: ${calls.map(c => c.url).join(', ')}`)
})

test('fails closed when the id resolves to a different project', async () => {
  // Tropy resolves a colliding basename to the most recent match, so an id that
  // looks right can name someone else's project.
  const { fetch } = recorder(() =>
    identity('/Users/x/Backups/Field Notes 1940.tropy'))

  await assert.rejects(
    () => gateway(fetch).resolve(),
    err => err instanceof ProjectIdentityError &&
      /different project/.test(err.message))
})

test('fails closed when Tropy reports the project URL is ambiguous', async () => {
  const { fetch } = recorder(() => identity(PROJECT_PATH, {
    headers: {
      Warning: '199 - "ambiguous project URL \'Field Notes 1940\'; opened the most recent match"'
    }
  }))

  await assert.rejects(
    () => gateway(fetch).resolve(),
    err => err instanceof ProjectIdentityError && /tell them apart/.test(err.message))
})

test('falls back to flat routes on 1.17.3, but only when GET / matches', async () => {
  const { fetch } = recorder(url => {
    if (url === SCOPED) return textResponse('Not Found', 404)
    if (url === `${ROOT}/project/tags`) return shimProbe.flat()
    if (url === `${ROOT}/`) return identity(PROJECT_PATH)
    throw new Error(`unexpected ${url}`)
  })

  const resolved = await gateway(fetch).resolve()

  assert.equal(resolved.shape, 'flat')
  assert.equal(resolved.base, `${ROOT}/project`)
})

test('refuses flat routes when the frontmost project is a different one', async () => {
  const { fetch } = recorder(url => {
    if (url === SCOPED) return textResponse('Not Found', 404)
    if (url === `${ROOT}/project/tags`) return shimProbe.flat()
    if (url === `${ROOT}/`) return identity('/Users/x/Other.tropy')
    throw new Error(`unexpected ${url}`)
  })

  await assert.rejects(
    () => gateway(fetch).resolve(),
    err => err instanceof ProjectIdentityError && /different project/.test(err.message))
})

test('will not degrade to flat routes on a namespaced Tropy', async () => {
  // The trap this guards: on beta.5 `GET /` still names the project, so an
  // identity check on the flat shape PASSES — and then every id-addressed read
  // dies with HTTP 500 from the broken redirect shim. Falling back here would
  // look like it worked and then fail on the first real read, which is exactly
  // the failure this release exists to fix.
  const { fetch, calls } = recorder(url => {
    if (url === SCOPED) return textResponse('Not Found', 404)
    if (url === `${ROOT}/project/tags`) return shimProbe.namespaced()
    if (url === `${ROOT}/`) return identity(PROJECT_PATH)
    throw new Error(`unexpected ${url}`)
  })

  await assert.rejects(
    () => gateway(fetch).resolve(),
    err => err instanceof ProjectIdentityError &&
      /project-scoped API routes/.test(err.message) &&
      /will not fall back/.test(err.message))

  assert.ok(
    !calls.some(c => c.url === `${ROOT}/`),
    'should refuse on the shim signal alone, without consulting GET /')
})

test('a redirected collection URL is the only signal distinguishing the shapes', async () => {
  // Both Tropys answer GET /project/tags with 200, so status is useless here.
  const shapeFor = async probe => {
    const { fetch } = recorder(url => {
      if (url === SCOPED) return textResponse('Not Found', 404)
      if (url === `${ROOT}/project/tags`) return probe()
      if (url === `${ROOT}/`) return identity(PROJECT_PATH)
      throw new Error(`unexpected ${url}`)
    })

    return gateway(fetch).resolve().then(r => r.shape, () => 'refused')
  }

  assert.equal(await shapeFor(shimProbe.flat), 'flat')
  assert.equal(await shapeFor(shimProbe.namespaced), 'refused')
})

test('the default fetch is bound to the global, not to the gateway', async () => {
  // Browsers require window.fetch to be invoked with the global as receiver.
  // Storing the bare reference and calling `this.fetch(...)` gives it the
  // gateway instead, and Chromium rejects that with
  //   Failed to execute 'fetch' on 'Window': Illegal invocation
  // which degraded every read to its fallback and made writes refuse. Node's
  // fetch does not care, so only an explicit receiver check catches it.
  const original = globalThis.fetch
  let receiverWasGlobal = null

  globalThis.fetch = function (url) {
    receiverWasGlobal = this === globalThis
    if (!receiverWasGlobal) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
    }
    return identity(PROJECT_PATH)
  }

  try {
    // No fetch injected — this is the path the plugin actually uses.
    const gw = new RestProjectGateway({
      projectPath: PROJECT_PATH, port: PORT, logger: silentLogger
    })

    const resolved = await gw.resolve()

    assert.equal(receiverWasGlobal, true)
    assert.equal(resolved.shape, 'scoped')
  } finally {
    globalThis.fetch = original
  }
})

test('refuses to act at all when the window has no project path', async () => {
  const { fetch, calls } = recorder(() => identity(PROJECT_PATH))

  await assert.rejects(
    () => gateway(fetch, { projectPath: null }).resolve(),
    err => err instanceof ProjectIdentityError &&
      /which project this window has open/.test(err.message))

  assert.equal(calls.length, 0, 'must not probe without knowing what to compare against')
})

test('reports an unreachable API with the port named', async () => {
  const { fetch } = recorder(() => { throw new Error('ECONNREFUSED') })

  await assert.rejects(
    () => gateway(fetch).resolve(),
    err => err instanceof ProjectIdentityError &&
      err.message.includes(String(PORT)))
})

test('a failed probe is not cached, so a later retry can succeed', async () => {
  let attempt = 0

  const { fetch } = recorder(url => {
    attempt += 1
    if (attempt <= 2) throw new Error('ECONNREFUSED')  // scoped probe, then shim probe
    if (url === SCOPED) return identity(PROJECT_PATH)
    throw new Error(`unexpected ${url}`)
  })

  const gw = gateway(fetch)
  await assert.rejects(() => gw.resolve())

  const resolved = await gw.resolve()
  assert.equal(resolved.shape, 'scoped')
})

test('concurrent callers share a single probe', async () => {
  const { fetch, calls } = recorder(() => identity(PROJECT_PATH))
  const gw = gateway(fetch)

  await Promise.all([gw.resolve(), gw.resolve(), gw.resolve()])

  assert.equal(calls.length, 1)
})

test('assertWriteTarget re-probes instead of trusting the memo', async () => {
  // The panel can sit open for minutes while the summary is edited, so the
  // resolve-time result proves nothing by the time Apply runs.
  let probes = 0

  const { fetch } = recorder(url => {
    if (url === SCOPED) {
      probes += 1
      return identity(PROJECT_PATH)
    }
    throw new Error(`unexpected ${url}`)
  })

  const gw = gateway(fetch)
  await gw.resolve()
  assert.equal(probes, 1)

  await gw.assertWriteTarget()
  assert.equal(probes, 2, 'assertWriteTarget must issue a fresh probe')
})

test('assertWriteTarget refuses once the project has changed underneath', async () => {
  let first = true

  const { fetch } = recorder(() => {
    if (first) {
      first = false
      return identity(PROJECT_PATH)
    }
    return identity('/Users/x/Somewhere Else.tropy')
  })

  const gw = gateway(fetch)
  await gw.resolve()

  await assert.rejects(
    () => gw.assertWriteTarget(),
    err => err instanceof ProjectIdentityError && /Nothing was written/.test(err.message))
})

test('reads are discarded when the flat target moved during the read', async () => {
  // On 1.17.3 there is no scoped route, so this is the only protection against
  // another project's metadata reaching an AI provider.
  let identityProbes = 0

  const { fetch } = recorder(url => {
    if (url === SCOPED) return textResponse('Not Found', 404)
    if (url === `${ROOT}/project/tags`) return shimProbe.flat()

    if (url === `${ROOT}/`) {
      identityProbes += 1
      // First probe resolves; the check after the read sees another project.
      return identityProbes === 1
        ? identity(PROJECT_PATH)
        : identity('/Users/x/Other.tropy')
    }

    if (url === `${ROOT}/project/data/1049`) {
      return jsonResponse({ id: 1049, 'http://purl.org/dc/elements/1.1/title': { text: 'secret' } })
    }

    throw new Error(`unexpected ${url}`)
  })

  const gw = gateway(fetch)
  await gw.resolve()

  await assert.rejects(
    () => gw.getMetadata(1049),
    err => err instanceof ProjectIdentityError && /discarded/.test(err.message))
})

test('scoped reads need no bracketing probe', async () => {
  const { fetch, calls } = recorder(url => {
    if (url === SCOPED) return identity(PROJECT_PATH)
    if (url === `${SCOPED}/tags`) return jsonResponse([{ id: 1, name: 'a' }])
    throw new Error(`unexpected ${url}`)
  })

  const gw = gateway(fetch)
  await gw.resolve()
  await gw.getTags()

  assert.equal(calls.length, 2, 'one identity probe, one read — no re-verification')
})

test('rejects project tags that come back in an unexpected shape', async () => {
  const { fetch } = recorder(url => {
    if (url === SCOPED) return identity(PROJECT_PATH)
    if (url === `${SCOPED}/tags`) return jsonResponse({ oops: true })
    throw new Error(`unexpected ${url}`)
  })

  await assert.rejects(() => gateway(fetch).getTags(), /unexpected shape/)
})
