// result-schema.js — validates and normalizes the model's JSON output.
//
// The prompt asks for:
//   { summary, document_type, possible_tags, metadata_suggestions, confidence }
//
// but a model can return anything. Previously the parsed JSON went straight to
// the panel, which assumed `possible_tags` was an array — so a malformed
// response surfaced as a TypeError in the renderer rather than a readable
// message. Everything downstream now consumes the validated shape.

import { DC_WRITE_URIS } from './dc.js'

// Tags are compared case- and whitespace-insensitively, but the first spelling
// the model used is the one kept — it is the one the researcher will see on the
// chip, and the one created in Tropy if accepted.
//
// Deduplicating here matters beyond tidiness: a model returning "Passport" and
// "passport" would otherwise become two tag-creation attempts for what Tropy
// will treat as the same tag.
export function normalizeTags (tags) {
  if (!Array.isArray(tags)) return []

  const seen = new Set()
  const out = []

  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const trimmed = tag.trim()
    if (!trimmed) continue

    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue

    seen.add(key)
    out.push(trimmed)
  }

  return out
}

// Only fields Autropy can actually write are kept — anything else would render
// as an accept row that silently does nothing on apply.
function normalizeMetadataSuggestions (suggestions) {
  if (!suggestions || typeof suggestions !== 'object' || Array.isArray(suggestions)) {
    return null
  }

  const out = {}
  for (const [field, value] of Object.entries(suggestions)) {
    if (!(field in DC_WRITE_URIS)) continue
    if (value == null) continue

    const text = String(value).trim()
    if (text) out[field] = text
  }

  return Object.keys(out).length > 0 ? out : null
}

// `confidence` is displayed as a percentage. A non-number or out-of-range value
// returns null so the panel can omit the figure rather than render "NaN%".
function normalizeConfidence (value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, n))
}

// Throws with a message naming what was wrong; returns the normalized result.
export function validateResult (parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      '[AUTROPY] the model did not return a JSON object. Try re-running, or ' +
      'check that the model supports image input and JSON output.')
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  if (!summary) {
    throw new Error(
      '[AUTROPY] the model response contained no "summary" field. ' +
      `Keys returned: ${Object.keys(parsed).join(', ') || '(none)'}`)
  }

  const docType = typeof parsed.document_type === 'string' && parsed.document_type.trim()
    ? parsed.document_type.trim()
    : 'unknown'

  return {
    summary,
    document_type: docType,
    possible_tags: normalizeTags(parsed.possible_tags),
    metadata_suggestions: normalizeMetadataSuggestions(parsed.metadata_suggestions),
    confidence: normalizeConfidence(parsed.confidence)
  }
}
