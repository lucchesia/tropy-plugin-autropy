// tropy.js — Tropy Beta REST API read and write operations
//
// CONFIRMED: base URL is http://localhost:<port> (default port 2029).
// CONFIRMED: GET /project/tags returns [{id, name, color, created, modified}, ...]
// CONFIRMED: POST /project/notes accepts form-urlencoded: photo=<id>&html=<html>
// CONFIRMED: GET /project/data/<id> returns metadata keyed by DC URI strings.
//
// TAG WRITE — resolved contradiction (2026-04-12):
//   Name-based tag application (form-urlencoded tag=<name>) returns 500.
//   Correct approach: create tag → get numeric ID from response → apply via JSON {"tag": id}.
//   Confirmed from tropy-mmllm notebook reference implementation.
//
// METADATA WRITE — confirmed endpoint (2026-04-12):
//   POST /project/data/<id> with JSON body, DC URI strings as keys.
//   Confirmed from tropy-mmllm notebook reference implementation.

const AUTROPY_NOTE_MARKER = '[AUTROPY]'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function base (port) {
  return `http://localhost:${port}`
}

async function requireOk (res, context) {
  if (!res.ok) {
    const detail = await res.text().catch(() => '(no body)')
    throw new Error(`[AUTROPY] ${context} — HTTP ${res.status}: ${detail}`)
  }
  return res
}

function formBody (params) {
  return new URLSearchParams(params).toString()
}

// ---------------------------------------------------------------------------
// fetchExistingTags(port)
// ---------------------------------------------------------------------------
// CONFIRMED: GET /project/tags returns an array of tag objects.
// CONFIRMED: each tag has at minimum { id, name }.
export async function fetchExistingTags (port) {
  const res = await fetch(`${base(port)}/project/tags`)
  await requireOk(res, 'GET /project/tags failed')
  const tags = await res.json()
  // UNVERIFIED ASSUMPTION: response is always a JSON array (not wrapped in an object).
  if (!Array.isArray(tags)) {
    throw new Error(`[AUTROPY] GET /project/tags returned unexpected shape: ${JSON.stringify(tags).slice(0, 200)}`)
  }
  return tags
}

// ---------------------------------------------------------------------------
// applyTag(port, itemId, tagName, existingTags)
// ---------------------------------------------------------------------------
// Finds or creates a tag by name, then applies it to the item using numeric ID.
//
// CONFIRMED (2026-04-12): name-based tag application returns 500.
//   Must use numeric tag ID in JSON body: {"tag": <id>}.
// CONFIRMED: POST /project/tags with form-urlencoded name=... creates a tag
//   and returns the new tag object including its numeric id.
// CONFIRMED: existing tag lookup prevents duplicate creation.
export async function applyTag (port, itemId, tagName, existingTags) {
  if (!tagName || typeof tagName !== 'string') {
    throw new Error('[AUTROPY] applyTag called with invalid tagName')
  }

  // Find existing tag by name (case-insensitive) to get its numeric ID
  const existing = Array.isArray(existingTags)
    ? existingTags.find(t => t.name.toLowerCase() === tagName.toLowerCase())
    : null

  let tagId = existing?.id

  if (!tagId) {
    // Create new tag — form-urlencoded, returns tag object with numeric id
    const createRes = await fetch(`${base(port)}/project/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ name: tagName })
    })
    await requireOk(createRes, `POST /project/tags (create "${tagName}") failed`)
    const created = await createRes.json()
    tagId = created?.id
    if (!tagId) {
      throw new Error(`[AUTROPY] POST /project/tags returned no id for "${tagName}"`)
    }
  }

  // Apply tag to item using numeric ID via JSON body
  // CONFIRMED: name-based returns 500; numeric ID via JSON is the correct approach
  const applyRes = await fetch(`${base(port)}/project/items/${itemId}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag: tagId })
  })
  await requireOk(applyRes, `POST /project/items/${itemId}/tags (tag id ${tagId}) failed`)
}

// ---------------------------------------------------------------------------
// writeAnalysisNote(port, photoId, summary, modelId, version)
// ---------------------------------------------------------------------------
// Writes the user-edited summary plus a machine-readable provenance footer
// as a note attached to the photo.
//
// Note format (from build spec):
//   <summary text>
//
//   ---
//   [AUTROPY] model: <modelId> | <ISO timestamp> | v<version>
//
// UNVERIFIED ASSUMPTION: POST /project/notes exists and accepts:
//   photo=<photoId>&html=<html string> (form-urlencoded).
//   Endpoint confirmed in build spec — not yet verified against live API.
//   If this call fails, confirm the endpoint path and accepted parameters
//   against the Tropy 1.18 Beta source or running instance.
export async function writeAnalysisNote (port, photoId, summary, modelId, version) {
  if (!summary || typeof summary !== 'string') {
    throw new Error('[AUTROPY] writeAnalysisNote called with empty summary')
  }

  const timestamp = new Date().toISOString()
  const provenance = `${AUTROPY_NOTE_MARKER} model: ${modelId} | ${timestamp} | v${version}`

  // CONFIRMED: /project/notes requires html= parameter with actual HTML content.
  //   Plain text is not accepted — verified empirically during API testing.
  const html = `<p>${summary.trim()}</p><p>---<br>${provenance}</p>`

  const res = await fetch(`${base(port)}/project/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({ photo: photoId, html })
  })
  await requireOk(res, `POST /project/notes (photo ${photoId}) failed`)
}

// ---------------------------------------------------------------------------
// writeItemMetadata(port, itemId, fields)
// ---------------------------------------------------------------------------
// Writes accepted metadata suggestions back to a Tropy item.
//
// CONFIRMED (2026-04-12): endpoint is POST /project/data/<id> with JSON body.
//   Keys are DC namespace URI strings. Values are plain strings.
//   Confirmed from tropy-mmllm notebook reference implementation.
//
// fields: plain object with short names, e.g. { title: "...", date: "1940" }
// DC_URIS maps those to the full namespace URIs Tropy expects.
//
// UNVERIFIED ASSUMPTION: POST /project/data/<id> is idempotent for fields that
//   already have values — i.e. it updates, not appends. Verify after first write.
const DC_WRITE_URIS = {
  title: 'http://purl.org/dc/elements/1.1/title',
  date: 'http://purl.org/dc/elements/1.1/date',
  description: 'http://purl.org/dc/elements/1.1/description',
  creator: 'http://purl.org/dc/elements/1.1/creator',
  type: 'http://purl.org/dc/elements/1.1/type',
  coverage: 'http://purl.org/dc/elements/1.1/coverage',
  rights: 'http://purl.org/dc/elements/1.1/rights'
}

export async function writeItemMetadata (port, itemId, fields) {
  if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) return

  const payload = {}
  for (const [key, value] of Object.entries(fields)) {
    const uri = DC_WRITE_URIS[key]
    if (uri && value != null && value !== '') {
      payload[uri] = value
    }
  }

  if (Object.keys(payload).length === 0) return

  const res = await fetch(`${base(port)}/project/data/${itemId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  await requireOk(res, `POST /project/data/${itemId} (metadata write) failed`)
}

// ---------------------------------------------------------------------------
// fetchItemMetadata(port, itemId)
// ---------------------------------------------------------------------------
// Returns a simplified flat object of metadata field labels → values,
// for use in building the metadata-aware prompt extension in prompt.js.
//
// CONFIRMED: GET /project/data/<id> returns DC URI keys, e.g.:
//   { "http://purl.org/dc/elements/1.1/title": { type: "...", text: "..." }, ... }
//
// UNVERIFIED ASSUMPTION: the response always includes an "id" numeric field
//   alongside the DC URI keys. Filtered out below.
// UNVERIFIED ASSUMPTION: all values of interest are in the "text" sub-field.
//   Tropy may use other sub-fields for typed values (e.g. date ranges) — alpha
//   only reads "text".
export async function fetchItemMetadata (port, itemId) {
  const res = await fetch(`${base(port)}/project/data/${itemId}`)
  await requireOk(res, `GET /project/data/${itemId} failed`)
  const raw = await res.json()

  // Map DC URIs to short human-readable labels for prompt readability.
  // Only the fields relevant to AUTROPY's metadata_suggestions output are mapped.
  const DC_LABELS = {
    'http://purl.org/dc/elements/1.1/title': 'title',
    'http://purl.org/dc/elements/1.1/date': 'date',
    'http://purl.org/dc/elements/1.1/description': 'description',
    'http://purl.org/dc/elements/1.1/creator': 'creator',
    'http://purl.org/dc/elements/1.1/type': 'type',
    'http://purl.org/dc/elements/1.1/coverage': 'coverage',
    'http://purl.org/dc/elements/1.1/rights': 'rights'
  }

  const metadata = {}
  for (const [uri, value] of Object.entries(raw)) {
    if (uri === 'id') continue // numeric id field, not a metadata field
    const label = DC_LABELS[uri] || uri // fall back to full URI if unmapped
    // UNVERIFIED ASSUMPTION: value is always { type, text } — reading .text only
    metadata[label] = value?.text ?? null
  }

  return metadata
}
