// Write outcomes are three-state. The distinction that matters: a REST write
// can be committed by SQLite and still never reach us, so "we don't know" is a
// real outcome and must not be retried blindly.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ACKNOWLEDGED, REJECTED, UNKNOWN, RestProjectGateway
} from '../src/gateway.js'

import {
  PORT, PROJECT_PATH, ROOT, SCOPED,
  identity, jsonResponse, recorder, shimProbe, silentLogger, textResponse
} from './helpers.mjs'

function gateway (fetch) {
  return new RestProjectGateway({
    projectPath: PROJECT_PATH, port: PORT, logger: silentLogger, fetch
  })
}

// Resolves identity, then delegates writes to `onWrite`.
function writing (onWrite) {
  return recorder((url, init) => {
    if (url === SCOPED && (init.method || 'GET') === 'GET') return identity(PROJECT_PATH)
    return onWrite(url, init)
  })
}

test('a 2xx write is acknowledged', async () => {
  const { fetch } = writing(() => jsonResponse({ id: 77 }))
  const outcome = await gateway(fetch).saveMetadata(1049, { title: 'x' })

  assert.equal(outcome.status, ACKNOWLEDGED)
})

test('an HTTP error is rejected — the server definitely said no', async () => {
  const { fetch } = writing(() => textResponse('Bad Request', 400))
  const outcome = await gateway(fetch).saveMetadata(1049, { title: 'x' })

  assert.equal(outcome.status, REJECTED)
  assert.match(outcome.detail, /400/)
})

test('a dropped connection is unknown, not rejected', async () => {
  const { fetch } = writing(() => { throw new Error('socket hang up') })
  const outcome = await gateway(fetch).saveMetadata(1049, { title: 'x' })

  assert.equal(outcome.status, UNKNOWN,
    'a thrown fetch cannot distinguish "never arrived" from "committed then lost"')
})

test('a timed-out write is unknown', async () => {
  const { fetch } = writing(() => {
    const err = new Error('The operation was aborted due to timeout')
    err.name = 'TimeoutError'
    throw err
  })

  const outcome = await gateway(fetch).createNote(1050, '<p>x</p>')
  assert.equal(outcome.status, UNKNOWN)
})

test('notes are flagged non-idempotent and carry their id when acknowledged', async () => {
  const { fetch } = writing(() => jsonResponse({ id: 884 }))
  const outcome = await gateway(fetch).createNote(1050, '<p>x</p>')

  assert.equal(outcome.status, ACKNOWLEDGED)
  assert.equal(outcome.noteId, 884)
  assert.equal(outcome.idempotent, false,
    'the note id is the only evidence distinguishing a written note from an unknown one')
})

test('an acknowledged write with no JSON body still counts as written', async () => {
  const { fetch } = writing(() => ({
    ok: true,
    status: 204,
    headers: { get: () => null },
    json: async () => { throw new Error('no body') },
    text: async () => ''
  }))

  const outcome = await gateway(fetch).saveMetadata(1049, { title: 'x' })
  assert.equal(outcome.status, ACKNOWLEDGED)
})

test('saveMetadata skips the request entirely when nothing maps to a DC field', async () => {
  const { fetch, calls } = writing(() => { throw new Error('should not write') })
  const gw = gateway(fetch)

  assert.equal(await gw.saveMetadata(1049, { nonsense: 'x' }), null)
  assert.equal(await gw.saveMetadata(1049, {}), null)
  assert.ok(calls.every(c => c.method === 'GET'))
})

test('an existing tag is applied by id without creating a duplicate', async () => {
  const existing = [{ id: 21, name: 'Passport' }]

  const { fetch, calls } = writing((url, init) => {
    assert.equal(url, `${SCOPED}/items/1049/tags`, 'must not POST /tags for an existing name')
    assert.equal(JSON.parse(init.body).tag, 21)
    return jsonResponse({ ok: true })
  })

  // Case differences must still match: Tropy treats them as the same tag.
  const outcome = await gateway(fetch).applyTag(1049, 'passport', existing)

  assert.equal(outcome.status, ACKNOWLEDGED)
  assert.equal(calls.filter(c => c.method === 'POST').length, 1)
})

test('a new tag is created, then attached by the returned id', async () => {
  const { fetch } = writing((url, init) => {
    if (url === `${SCOPED}/tags`) {
      assert.match(init.body, /name=New\+Tag/)
      return jsonResponse({ id: 99, name: 'New Tag' })
    }

    if (url === `${SCOPED}/items/1049/tags`) {
      assert.equal(JSON.parse(init.body).tag, 99)
      return jsonResponse({ ok: true })
    }

    throw new Error(`unexpected ${url}`)
  })

  const outcome = await gateway(fetch).applyTag(1049, 'New Tag', [])
  assert.equal(outcome.status, ACKNOWLEDGED)
})

test('a failed tag creation is reported and never attached', async () => {
  const { fetch, calls } = writing(url => {
    if (url === `${SCOPED}/tags`) return textResponse('Server Error', 500)
    throw new Error('must not attempt to attach a tag that was not created')
  })

  const outcome = await gateway(fetch).applyTag(1049, 'New Tag', [])

  assert.equal(outcome.status, REJECTED)
  assert.equal(calls.filter(c => c.method === 'POST').length, 1)
})

test('a created tag with no id is rejected rather than attached as undefined', async () => {
  const { fetch } = writing(url => {
    if (url === `${SCOPED}/tags`) return jsonResponse({ name: 'New Tag' })
    throw new Error('must not attach without an id')
  })

  const outcome = await gateway(fetch).applyTag(1049, 'New Tag', [])

  assert.equal(outcome.status, REJECTED)
  assert.match(outcome.detail, /did not return an id/)
})

test('a flat write whose target moved is acknowledged but flagged', async () => {
  // Detection, not prevention: the write already landed. The researcher has to
  // be told, because we cannot undo it.
  let identityProbes = 0

  const { fetch } = recorder((url, init) => {
    if (url === SCOPED) return textResponse('Not Found', 404)
    if (url === `${ROOT}/project/tags`) return shimProbe.flat()

    if (url === `${ROOT}/` && (init.method || 'GET') === 'GET') {
      identityProbes += 1
      return identityProbes === 1
        ? identity(PROJECT_PATH)
        : identity('/Users/x/Other.tropy')
    }

    return jsonResponse({ id: 1 })
  })

  const gw = gateway(fetch)
  await gw.resolve()

  const outcome = await gw.saveMetadata(1049, { title: 'x' })

  assert.equal(outcome.status, ACKNOWLEDGED)
  assert.equal(outcome.targetChanged, true)
})

// ── undoing a write ────────────────────────────────────────────────────────
//
// Each of these reverses one recorded write. The guards are the point: Tropy's
// own delete routes are wider than what Autropy is allowed to do with them.

test('a note is deleted by the id the ledger recorded', async () => {
  const { fetch, calls } = writing(() => jsonResponse({}))
  const outcome = await gateway(fetch).deleteNote(4711)

  assert.equal(outcome.status, ACKNOWLEDGED)

  const del = calls.find(c => c.method === 'DELETE')
  assert.match(del.url, /\/notes\/4711$/)
})

test('a note with no recorded id is refused, not guessed at', async () => {
  const { fetch, calls } = writing(() => jsonResponse({}))
  const outcome = await gateway(fetch).deleteNote(null)

  assert.equal(outcome.status, REJECTED)
  assert.equal(calls.filter(c => c.method === 'DELETE').length, 0)
})

test('a tag is detached from one item, by id', async () => {
  const { fetch, calls } = writing(() => jsonResponse({}))
  const outcome = await gateway(fetch).removeTag(1049, 33, 'passport')

  assert.equal(outcome.status, ACKNOWLEDGED)

  const del = calls.find(c => c.method === 'DELETE')
  assert.match(del.url, /\/items\/1049\/tags$/,
    'never /tags, which deletes the tag from every item in the project')
  assert.deepEqual(JSON.parse(del.body), { tag: 33 })
})

test('a tag with no id never becomes a request', async () => {
  // Verified in Tropy Beta 1.18.0-beta.5: DELETE /items/:id/tags with no tag in
  // the body falls through to tag.clear and strips every tag off the item.
  const { fetch, calls } = writing(() => jsonResponse({}))
  const outcome = await gateway(fetch).removeTag(1049, undefined, 'passport')

  assert.equal(outcome.status, REJECTED)
  assert.equal(calls.filter(c => c.method === 'DELETE').length, 0,
    'a DELETE missing the tag id would clear the item')
})

test('restoring metadata writes empty values back, rather than skipping them', async () => {
  // The asymmetry with saveMetadata: an empty value is dropped from a write and
  // is the whole substance of an undo. Tropy deletes every property named in
  // the payload and re-inserts only the non-blank ones, so '' clears the field.
  const { fetch, calls } = writing(() => jsonResponse({}))
  const outcome = await gateway(fetch)
    .restoreMetadata(1049, { title: 'Original title', description: '' })

  assert.equal(outcome.status, ACKNOWLEDGED)

  const post = calls.find(c => c.method === 'POST')
  const body = JSON.parse(post.body)

  assert.equal(body['http://purl.org/dc/elements/1.1/title'], 'Original title')
  assert.equal(body['http://purl.org/dc/elements/1.1/description'], '',
    'the field was empty before the analysis, so undoing means emptying it')
})
