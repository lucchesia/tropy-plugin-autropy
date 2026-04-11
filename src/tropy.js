// tropy.js — Tropy Beta REST API read and write operations
//
// CONFIRMED: base URL is http://localhost:<port> (default port 2029).
// CONFIRMED: all write endpoints use application/x-www-form-urlencoded bodies.
// CONFIRMED: GET /project/tags returns [{id, name, color, created, modified}, ...]
// CONFIRMED: POST /project/tags accepts form-urlencoded: name=...&color=...
// CONFIRMED: POST /project/items/<id>/tags accepts form-urlencoded: tag=<name or id>
// CONFIRMED: GET /project/data/<id> returns metadata keyed by DC URI strings.
// UNVERIFIED ASSUMPTION: POST /project/notes exists and accepts photo=<id>&html=<html>.
//   Endpoint is specified in the AUTROPY build spec but not yet confirmed against
//   a live Tropy 1.18 Beta instance. Verify before testing writeAnalysisNote.

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
// Finds the tag by name in existingTags. If not found, creates it first.
// Then POSTs the tag to the item.
//
// CONFIRMED: POST /project/items/<id>/tags accepts tag=<name or id> (form-urlencoded).
//   Using name here — simpler and confirmed equivalent to numeric ID for this endpoint.
// CONFIRMED: POST /project/tags creates a new tag (form-urlencoded: name=...).
// UNVERIFIED ASSUMPTION: creating a tag that already exists is safe (idempotent or
//   returns a useful error). If Tropy throws on duplicate, the name-existence check
//   below prevents it — but only if existingTags was fetched immediately before calling.
export async function applyTag (port, itemId, tagName, existingTags) {
  if (!tagName || typeof tagName !== 'string') {
    throw new Error('[AUTROPY] applyTag called with invalid tagName')
  }

  const exists = Array.isArray(existingTags) &&
    existingTags.some(t => t.name.toLowerCase() === tagName.toLowerCase())

  if (!exists) {
    // Create the tag — no color specified, Tropy assigns default
    const createRes = await fetch(`${base(port)}/project/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ name: tagName })
    })
    await requireOk(createRes, `POST /project/tags (create "${tagName}") failed`)
  }

  // Add tag to item — uses tag name, confirmed equivalent to numeric ID
  const applyRes = await fetch(`${base(port)}/project/items/${itemId}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({ tag: tagName })
  })
  await requireOk(applyRes, `POST /project/items/${itemId}/tags (tag "${tagName}") failed`)
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
