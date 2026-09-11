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

// The fields the JSON format block actually asks the model for. A field the
// prompt never requested is not "missing", so it is not reported as suppressed.
export const REQUESTED_METADATA_FIELDS = ['title', 'date', 'description']

// Why a requested field produced no row.
export const DECLINED = 'declined'      // the model answered null or blank
export const ABSENT = 'absent'          // the model omitted the key entirely
export const UNWRITABLE = 'unwritable'  // Autropy cannot write that field

// Only fields Autropy can actually write are kept — anything else would render
// as an accept row that silently does nothing on apply.
//
// What is dropped is now reported rather than discarded. A field the model
// declined and a field the model failed on look identical in a panel that shows
// only what came back, and they call for opposite responses: the first is the
// prompt working as designed — it tells the model not to duplicate values the
// item already holds — and the second is worth re-running.
function normalizeMetadataSuggestions (suggestions) {
  const suppressed = []

  if (!suggestions || typeof suggestions !== 'object' || Array.isArray(suggestions)) {
    return {
      suggestions: null,
      suppressed: REQUESTED_METADATA_FIELDS.map(field => ({ field, reason: ABSENT }))
    }
  }

  const out = {}

  for (const [field, value] of Object.entries(suggestions)) {
    if (!(field in DC_WRITE_URIS)) {
      suppressed.push({ field, reason: UNWRITABLE })
      continue
    }

    // Models asked for JSON null answer with the string "null" often enough to
    // matter, and a literal "null" in dc:date is worse than no suggestion.
    const text = value == null ? '' : String(value).trim()
    if (!text || text.toLowerCase() === 'null') {
      suppressed.push({ field, reason: DECLINED })
      continue
    }

    out[field] = text
  }

  for (const field of REQUESTED_METADATA_FIELDS) {
    if (field in out) continue
    if (suppressed.some(s => s.field === field)) continue
    suppressed.push({ field, reason: ABSENT })
  }

  return {
    suggestions: Object.keys(out).length > 0 ? out : null,
    suppressed
  }
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

  const metadata = normalizeMetadataSuggestions(parsed.metadata_suggestions)

  return {
    summary,
    document_type: docType,
    possible_tags: normalizeTags(parsed.possible_tags),
    metadata_suggestions: metadata.suggestions,
    suppressed: metadata.suppressed,
    confidence: normalizeConfidence(parsed.confidence)
  }
}

// ---------------------------------------------------------------------------
// Item-level synthesis
// ---------------------------------------------------------------------------

// A different shape from the per-photo result: no tags, no document type — the
// pages already supplied those — and its metadata describes the whole item.
//
// Validated separately rather than squeezed through validateResult, which would
// have demanded a "summary" field this response does not have and reported its
// absence as the model misbehaving.
export function validateSynthesis (parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      '[AUTROPY] the model did not return a JSON object for the item summary.')
  }

  const summary = typeof parsed.item_summary === 'string' ? parsed.item_summary.trim() : ''
  if (!summary) {
    throw new Error(
      '[AUTROPY] the model returned no "item_summary" field. ' +
      `Keys returned: ${Object.keys(parsed).join(', ') || '(none)'}`)
  }

  const metadata = normalizeMetadataSuggestions(parsed.metadata_suggestions)

  return {
    item_summary: summary,
    metadata_suggestions: metadata.suggestions,
    suppressed: metadata.suppressed,
    confidence: normalizeConfidence(parsed.confidence)
  }
}
