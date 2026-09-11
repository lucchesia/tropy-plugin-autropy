// dc.js — Dublin Core URI maps.
//
// Tropy keys item metadata by full namespace URI, both in the REST API
// (GET/POST /data/<id>) and in Redux state. These maps are isolated here so the
// Release 2 store-backed reader can share them with the REST gateway.

// Short field name → DC namespace URI, for writes.
export const DC_WRITE_URIS = {
  title: 'http://purl.org/dc/elements/1.1/title',
  date: 'http://purl.org/dc/elements/1.1/date',
  description: 'http://purl.org/dc/elements/1.1/description',
  creator: 'http://purl.org/dc/elements/1.1/creator',
  type: 'http://purl.org/dc/elements/1.1/type',
  coverage: 'http://purl.org/dc/elements/1.1/coverage',
  rights: 'http://purl.org/dc/elements/1.1/rights'
}

// DC namespace URI → short label, for building the prompt's metadata hint.
export const DC_LABELS = Object.fromEntries(
  Object.entries(DC_WRITE_URIS).map(([label, uri]) => [uri, label])
)

// Flattens a Tropy metadata payload into { label: text } for prompt building.
//
// Tropy's shape is { id, "<uri>": { type, text }, ... }. Only `text` is read —
// typed values (date ranges, for instance) carry more, which this deliberately
// ignores. Unmapped URIs keep their full URI as the key rather than being
// dropped, so an unexpected field is visible instead of silently missing.
export function flattenMetadata (raw) {
  const metadata = {}
  if (!raw || typeof raw !== 'object') return metadata

  for (const [uri, value] of Object.entries(raw)) {
    if (uri === 'id') continue
    metadata[DC_LABELS[uri] || uri] = value?.text ?? null
  }

  return metadata
}

// Maps accepted short-name fields to a URI-keyed payload for POST /data/<id>.
// Unknown fields and empty values are dropped.
export function toMetadataPayload (fields) {
  const payload = {}
  if (!fields || typeof fields !== 'object') return payload

  for (const [key, value] of Object.entries(fields)) {
    const uri = DC_WRITE_URIS[key]
    if (uri && value != null && value !== '') payload[uri] = value
  }

  return payload
}
