// html.js — HTML escaping shared by the UI templates and the data layer.
//
// This lives on its own because both panel-template.js (UI) and the note writer
// (data) need it, and the data layer must not import a UI template to get it.

// Escapes text for interpolation into element content.
export function escapeHtml (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Escapes text for interpolation into a double-quoted attribute value.
export function escapeAttr (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
}

// Converts plain text into escaped HTML paragraphs, preserving the line
// structure the researcher typed.
//
// Tropy notes are HTML (POST /notes rejects plain text), and the summary comes
// from a multi-line <textarea>. Escaping alone would collapse every paragraph
// break into running text, silently destroying the shape of what was written —
// so blank lines become separate <p> elements and single newlines become <br>.
//
// Returns '' for empty input so callers can decide whether there is anything to
// write, rather than writing an empty <p>.
export function textToParagraphs (text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!normalized) return ''

  return normalized
    .split(/\n{2,}/)
    .map(block => block
      .split('\n')
      .map(line => escapeHtml(line.trim()))
      .join('<br>'))
    .map(block => `<p>${block}</p>`)
    .join('')
}
