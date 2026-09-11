// gateway.js — project-aware access to Tropy's local REST API.
//
// ROUTE SHAPES (verified against installed builds, 2026-09-10)
//
// Tropy Beta 1.18.0-beta.5 namespaces every route under a project id:
//   GET /project/:project/data/:id
// Tropy 1.17.3 has flat routes and no project scoping at all:
//   GET /project/data/:id
//
// beta.5 ships a 308 redirect shim for the old flat URLs, but it is BROKEN:
// it calls `ctx.params.rest.join('/')` while @koa/router hands that param back
// as an already-joined string, so every URL with a trailing segment throws and
// returns HTTP 500. Verified: `/project/tags` → 308 (fine), `/project/data/1049`
// → 500. That is why alpha.2 stopped working.
//
// WHY IDENTITY COMES FIRST
//
// The literal project id `current` resolves to `wm.current('project')`, which is
// `this.windows.project[0]` — the FRONTMOST project window, not the window this
// plugin instance runs in, and it is resolved at request time. Checking it first
// does not help: the researcher can focus another window between the check and
// the request, at which point another project's metadata would be read and sent
// to an external AI provider. So `current` is never used here.
//
// The id-scoped route binds to a specific window by comparing full paths, which
// is deterministic. But the id is only the filename without its extension, so
// projects sharing a basename collide; Tropy then picks the most recent and sets
// a `Warning: 199 … ambiguous` header. We fail closed on that.
//
// On 1.17.3 no scoped route exists, so the race is unavoidable. Flat operations
// are therefore bracketed — verified before and after — which lets a read be
// discarded before it reaches the provider, and a write be reported loudly.

import { basename, extname } from 'node:path'
import { flattenMetadata, toMetadataPayload } from './dc.js'

// Write outcomes. A write is not success/failure: a network failure can happen
// after the server commits and before the client sees the response, and that
// third state cannot be retried blindly.
export const ACKNOWLEDGED = 'acknowledged'
export const REJECTED = 'rejected'
export const UNKNOWN = 'unknown'

const PROBE_TIMEOUT_MS = 3000
// Reads get their own, looser budget: a project with thousands of tags is slower
// to serve than an identity probe, and a read timing out means no analysis.
const READ_TIMEOUT_MS = 10000
const WRITE_TIMEOUT_MS = 30000

// Raised whenever the project Autropy is talking to cannot be proven to be the
// project it belongs to. Always fatal for writes.
export class ProjectIdentityError extends Error {
  constructor (message) {
    super(`[AUTROPY] ${message}`)
    this.name = 'ProjectIdentityError'
  }
}

// Mirrors Tropy's own `urlId` exactly (app.asar): the basename without its
// extension, normalized and URI-encoded.
export function urlId (path) {
  const file = String(path ?? '')
  const stem = basename(file, extname(file))
  const normalized = typeof stem.toWellFormed === 'function'
    ? stem.toWellFormed().normalize()
    : stem.normalize()
  return encodeURIComponent(normalized)
}

// The same id as a URL path segment — encoded a SECOND time.
//
// This looks wrong and is not. Tropy's `urlId` already percent-encodes, and the
// result is the value it compares `ctx.params.project` against. @koa/router
// decodes that param once, so a singly-encoded segment arrives as
// "Field Notes 1940" and never matches the stored id "Field%20Notes%201940".
// Verified live: /project/Field%20Notes%201940 → 404,
//                /project/Field%2520Notes%25201940 → 200.
export function projectSegment (path) {
  return encodeURIComponent(urlId(path))
}

function formBody (params) {
  return new URLSearchParams(params).toString()
}

function isAmbiguous (res) {
  const warning = res.headers?.get?.('warning')
  return typeof warning === 'string' && warning.toLowerCase().includes('ambiguous')
}

export class RestProjectGateway {
  // Everything is injected — no module-level mutable state, and tests can pass
  // their own `fetch` without a live Tropy.
  constructor ({ projectPath, port, logger, fetch: fetchImpl } = {}) {
    this.projectPath = projectPath || null
    this.port = port
    this.logger = logger || { warn () {}, error () {} }

    // `.bind(globalThis)` is load-bearing, not decoration. Storing the bare
    // reference and calling `this.fetch(…)` invokes it with the gateway as
    // receiver, and the browser rejects that:
    //   Failed to execute 'fetch' on 'Window': Illegal invocation
    // Which degraded every read to its fallback and made writes refuse.
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis)
    this.root = `http://localhost:${port}`

    this.resolved = null      // { shape, base, version, projectPath }
    this.resolving = null     // in-flight promise, so concurrent callers share one probe
  }

  // ── identity ─────────────────────────────────────────────────────────────

  // Reads an identity probe and confirms it names our project.
  async #probeIdentity (url) {
    let res
    try {
      res = await this.fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    } catch (err) {
      return { ok: false, unreachable: true, detail: err.message }
    }

    if (!res.ok) return { ok: false, status: res.status }

    let body = null
    try {
      body = await res.json()
    } catch {
      return { ok: false, detail: 'response was not JSON' }
    }

    if (!body || typeof body !== 'object' || typeof body.project !== 'string') {
      return { ok: false, detail: 'response did not name a project' }
    }

    return {
      ok: true,
      matches: body.project === this.projectPath,
      reportedPath: body.project,
      reportedId: body.id ?? null,
      version: body.version || null,
      ambiguous: isAmbiguous(res)
    }
  }

  // Whether this Tropy has the project-scoped API at all.
  //
  // A bare collection URL cannot be told apart by status: `/project/tags`
  // answers 200 on both shapes, because beta.5's compatibility shim redirects
  // it. But only a namespaced Tropy redirects, so `redirected` is the signal.
  //
  // This matters because the flat shape is a TRAP on beta.5: `GET /` still names
  // the project, so an identity check passes, and then every id-addressed read
  // fails with HTTP 500 from the broken shim. Better to say so than to degrade
  // into something that cannot work.
  async #hasRedirectShim () {
    try {
      const res = await this.fetch(`${this.root}/project/tags`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      })
      return res.redirected === true
    } catch {
      return false
    }
  }

  // Establishes identity and route shape. Memoized; a rejection is never cached,
  // so a probe that failed while Tropy was starting up can be retried.
  async resolve () {
    if (this.resolved) return this.resolved
    if (this.resolving) return this.resolving

    this.resolving = this.#resolve()
      .then(result => {
        this.resolved = result
        return result
      })
      .finally(() => { this.resolving = null })

    return this.resolving
  }

  async #resolve () {
    if (!this.projectPath) {
      throw new ProjectIdentityError(
        'cannot determine which project this window has open, so Tropy data ' +
        'cannot be read or written safely. Open a project and try again.')
    }

    const id = urlId(this.projectPath)
    const name = decodeURIComponent(id)
    const scopedBase = `${this.root}/project/${projectSegment(this.projectPath)}`

    // Preferred: the id-scoped route (beta.5+), which targets a window directly.
    const scoped = await this.#probeIdentity(scopedBase)

    if (scoped.ok && scoped.matches) {
      if (scoped.ambiguous) {
        throw new ProjectIdentityError(
          `several open projects are named "${name}", so Tropy cannot tell them ` +
          'apart by URL. Rename one of them, or close the others, before running ' +
          'Autropy.')
      }

      return this.#record('scoped', scopedBase, scoped.version)
    }

    if (scoped.ok && !scoped.matches) {
      throw new ProjectIdentityError(
        `Tropy resolved "${name}" to a different project (${scoped.reportedPath}). ` +
        'Refusing to read or write to avoid touching the wrong project.')
    }

    // A namespaced Tropy that did not answer the scoped probe is a fault, not a
    // reason to fall back — the flat routes it still exposes are the broken shim.
    if (await this.#hasRedirectShim()) {
      throw new ProjectIdentityError(
        `this Tropy uses project-scoped API routes, but would not resolve this ` +
        `project by name ("${name}"). Autropy will not fall back to the older ` +
        'routes, because on this version they fail for anything addressed by id. ' +
        'Close and reopen the project, or report this with the Tropy version.')
    }

    // Fallback: 1.17.3's flat routes. No scoping exists there, so this is only
    // safe when the frontmost project is ours — re-checked around every call.
    const flat = await this.#probeIdentity(`${this.root}/`)

    if (flat.ok && flat.matches) {
      this.logger.warn(
        '[AUTROPY] this Tropy has no project-scoped API; falling back to flat ' +
        'routes. Keep a single project window open while analyzing.')
      return this.#record('flat', `${this.root}/project`, flat.version)
    }

    if (flat.ok && !flat.matches) {
      throw new ProjectIdentityError(
        `this Tropy serves a different project (${flat.reportedPath}) than the ` +
        `one this window has open (${this.projectPath}). If you have more than ` +
        'one project window open, bring this one to the front and try again.')
    }

    throw new ProjectIdentityError(
      `could not reach Tropy's API on port ${this.port}` +
      `${flat.detail ? ` (${flat.detail})` : ''}. Check the Tropy API Port ` +
      'setting in Preferences → Plugins → Autropy.')
  }

  #record (shape, base, version) {
    const resolved = { shape, base, version, projectPath: this.projectPath }
    this.logger.warn(
      `[AUTROPY] Tropy ${version || '(version unknown)'} on port ${this.port} — ` +
      `route shape "${shape}", project verified: ${this.projectPath}`)
    return resolved
  }

  // Re-verifies identity from scratch, ignoring the memo.
  //
  // Called immediately before Apply. A result cached during analysis proves
  // nothing by then: Apply happens whenever the researcher finishes editing the
  // summary, which may be minutes later and after the project or port changed.
  async assertWriteTarget () {
    const { shape, base } = await this.resolve()
    // The scoped base is itself the identity endpoint, so it doubles as the probe.
    const url = shape === 'scoped' ? base : `${this.root}/`
    const probe = await this.#probeIdentity(url)

    if (!probe.ok) {
      throw new ProjectIdentityError(
        `lost contact with Tropy's API before writing${probe.detail ? ` (${probe.detail})` : ''}. ` +
        'Nothing was written.')
    }

    if (!probe.matches) {
      throw new ProjectIdentityError(
        `the project Tropy would write to has changed (${probe.reportedPath}) and ` +
        `is no longer the one this window has open (${this.projectPath}). ` +
        'Nothing was written.')
    }

    if (probe.ambiguous) {
      throw new ProjectIdentityError(
        'Tropy can no longer tell this project apart from another with the same ' +
        'filename. Nothing was written.')
    }

    return true
  }

  // On flat routes only, confirm the target did not move during an operation.
  async #flatTargetHeld () {
    if (this.resolved?.shape !== 'flat') return true
    const probe = await this.#probeIdentity(`${this.root}/`)
    return probe.ok && probe.matches && !probe.ambiguous
  }

  // ── requests ─────────────────────────────────────────────────────────────

  async #request (path, init, timeoutMs) {
    const { base } = await this.resolve()
    return this.fetch(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs)
    })
  }

  // Reads bracket the flat case so data from another project is discarded
  // BEFORE it can be folded into a prompt and sent to an AI provider.
  async #read (path, describe) {
    const res = await this.#request(path, {}, READ_TIMEOUT_MS)

    if (!res.ok) {
      const detail = await res.text().catch(() => '(no body)')
      throw new Error(`[AUTROPY] ${describe} failed — HTTP ${res.status}: ${detail}`)
    }

    const body = await res.json()

    if (!(await this.#flatTargetHeld())) {
      throw new ProjectIdentityError(
        `the frontmost project changed while reading (${describe}); the data was ` +
        'discarded rather than used.')
    }

    return body
  }

  // Writes classify their own outcome. Only a real HTTP response counts as
  // rejected; a thrown fetch means we genuinely do not know.
  async #write (path, init, describe) {
    let res
    try {
      res = await this.#request(path, init, WRITE_TIMEOUT_MS)
    } catch (err) {
      if (err instanceof ProjectIdentityError) throw err
      return { status: UNKNOWN, describe, detail: err.message }
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '(no body)')
      return { status: REJECTED, describe, detail: `HTTP ${res.status}: ${detail}` }
    }

    let body = null
    try {
      body = await res.json()
    } catch {
      // A write that returns no JSON body still committed — not an error.
    }

    const targetChanged = !(await this.#flatTargetHeld())
    return { status: ACKNOWLEDGED, describe, body, targetChanged }
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async getTags () {
    const tags = await this.#read('/tags', 'reading project tags')
    if (!Array.isArray(tags)) {
      throw new Error('[AUTROPY] project tags came back in an unexpected shape')
    }
    return tags
  }

  async getMetadata (itemId) {
    const raw = await this.#read(`/data/${itemId}`, `reading metadata for item ${itemId}`)
    return flattenMetadata(raw)
  }

  // The plain text of one transcription.
  //
  // Only `text` is read. The response also carries `data` — the full ALTO XML,
  // which for a dense page is tens of kilobytes of coordinates and would be
  // billed as input tokens for no analytical gain.
  async getTranscription (id) {
    const raw = await this.#read(
      `/transcriptions/${id}`, `reading transcription ${id}`)

    const text = typeof raw?.text === 'string' ? raw.text.trim() : ''
    return text ? { id, text } : null
  }

  // ── writes ───────────────────────────────────────────────────────────────

  // Tags are addressed by numeric id: name-based application returns 500.
  // Creation is a separate call, and is itself a write whose outcome matters —
  // a created-but-unattached tag is a visible side effect worth reporting.
  async applyTag (itemId, tagName, existingTags) {
    const existing = Array.isArray(existingTags)
      ? existingTags.find(t => t?.name?.toLowerCase() === tagName.toLowerCase())
      : null

    let tagId = existing?.id

    if (!tagId) {
      const created = await this.#write('/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ name: tagName })
      }, `creating tag "${tagName}"`)

      if (created.status !== ACKNOWLEDGED) return created

      tagId = created.body?.id
      if (!tagId) {
        return {
          status: REJECTED,
          describe: `creating tag "${tagName}"`,
          detail: 'Tropy did not return an id for the new tag'
        }
      }
    }

    return this.#write(`/items/${itemId}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: tagId })
    }, `applying tag "${tagName}"`)
  }

  // Notes are the one non-idempotent write here, so the returned id is kept:
  // it is the only evidence that distinguishes a completed write from an
  // unknown one after the fact.
  async createNote (photoId, html) {
    const outcome = await this.#write('/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ photo: photoId, html })
    }, `writing the analysis note to photo ${photoId}`)

    if (outcome.status === ACKNOWLEDGED) {
      outcome.noteId = outcome.body?.id ?? outcome.body?.note?.id ?? null
    }
    outcome.idempotent = false

    return outcome
  }

  async saveMetadata (itemId, fields) {
    const payload = toMetadataPayload(fields)
    if (Object.keys(payload).length === 0) return null

    return this.#write(`/data/${itemId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, `saving metadata on item ${itemId}`)
  }
}
