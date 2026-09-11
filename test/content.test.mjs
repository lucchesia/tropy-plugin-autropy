// Content handling: what gets written into notes, and what the panel is allowed
// to assume about model output.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { escapeAttr, escapeHtml, textToParagraphs } from '../src/html.js'
import { normalizeTags, validateResult } from '../src/result-schema.js'
import { flattenMetadata, toMetadataPayload } from '../src/dc.js'
import { PANEL_STYLES, buildPanelHTML, renderStatusLines } from '../src/panel-template.js'

// ── escaping ───────────────────────────────────────────────────────────────

test('escapeHtml neutralizes markup in AI and researcher text', () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')

  assert.equal(escapeHtml('Fish & Chips'), 'Fish &amp; Chips')
  assert.equal(escapeHtml("it's"), 'it&#39;s')
})

test('escapeHtml escapes the ampersand before anything else', () => {
  // Escaping < first would turn "&lt;" into "&amp;lt;" on a second pass.
  assert.equal(escapeHtml('&lt;'), '&amp;lt;')
})

test('escapeAttr closes out attribute breakouts', () => {
  assert.equal(
    escapeAttr('" onclick="evil()'),
    '&quot; onclick=&quot;evil()')
})

// ── note body ──────────────────────────────────────────────────────────────

test('textToParagraphs preserves paragraph breaks', () => {
  // The summary comes from a multi-line textarea. Escaping alone would collapse
  // the researcher's paragraphs into one run of text.
  assert.equal(
    textToParagraphs('First para.\n\nSecond para.'),
    '<p>First para.</p><p>Second para.</p>')
})

test('textToParagraphs preserves single line breaks within a paragraph', () => {
  assert.equal(
    textToParagraphs('Line one\nLine two'),
    '<p>Line one<br>Line two</p>')
})

test('textToParagraphs escapes while preserving structure', () => {
  assert.equal(
    textToParagraphs('A & B\n\n<b>C</b>'),
    '<p>A &amp; B</p><p>&lt;b&gt;C&lt;/b&gt;</p>')
})

test('textToParagraphs collapses runs of blank lines and normalizes CRLF', () => {
  assert.equal(
    textToParagraphs('A\r\n\r\n\r\nB'),
    '<p>A</p><p>B</p>')
})

test('textToParagraphs returns empty for blank input, so no empty note is written', () => {
  assert.equal(textToParagraphs(''), '')
  assert.equal(textToParagraphs('   \n\n  '), '')
  assert.equal(textToParagraphs(null), '')
})

// ── model output ───────────────────────────────────────────────────────────

test('validateResult accepts a well-formed response', () => {
  const result = validateResult({
    summary: '  A letter.  ',
    document_type: 'letter',
    possible_tags: ['Passport', 'Visa'],
    metadata_suggestions: { title: 'Letter', date: '1940' },
    confidence: 0.82
  })

  assert.equal(result.summary, 'A letter.')
  assert.deepEqual(result.possible_tags, ['Passport', 'Visa'])
  assert.deepEqual(result.metadata_suggestions, { title: 'Letter', date: '1940' })
  assert.equal(result.confidence, 0.82)
})

test('validateResult rejects a non-object with an actionable message', () => {
  assert.throws(() => validateResult('nope'), /did not return a JSON object/)
  assert.throws(() => validateResult(null), /did not return a JSON object/)
  assert.throws(() => validateResult([1, 2]), /did not return a JSON object/)
})

test('validateResult rejects a response with no summary, naming what came back', () => {
  assert.throws(
    () => validateResult({ document_type: 'letter', tags: [] }),
    err => /no "summary" field/.test(err.message) &&
      /document_type, tags/.test(err.message))
})

test('possible_tags is always an array, whatever the model sent', () => {
  // The panel maps over this directly; before validation a string here was a
  // TypeError in the renderer rather than a readable message.
  assert.deepEqual(validateResult({ summary: 'x', possible_tags: 'passport' }).possible_tags, [])
  assert.deepEqual(validateResult({ summary: 'x' }).possible_tags, [])
})

test('tags are trimmed and deduplicated case-insensitively, first spelling wins', () => {
  // Otherwise "Passport" and "passport" become two creation attempts for what
  // Tropy considers one tag.
  assert.deepEqual(
    normalizeTags(['Passport', ' passport ', 'PASSPORT', 'Visa']),
    ['Passport', 'Visa'])
})

test('normalizeTags drops empties and non-strings', () => {
  assert.deepEqual(normalizeTags(['a', '', '   ', null, 7, {}, 'b']), ['a', 'b'])
  assert.deepEqual(normalizeTags(null), [])
})

test('metadata suggestions are limited to writable DC fields', () => {
  // A field Autropy cannot write would render an Accept row that silently
  // does nothing.
  const result = validateResult({
    summary: 'x',
    metadata_suggestions: { title: 'T', nonsense: 'y', date: '  ' }
  })

  assert.deepEqual(result.metadata_suggestions, { title: 'T' })
})

test('metadata suggestions collapse to null when nothing is usable', () => {
  assert.equal(validateResult({ summary: 'x', metadata_suggestions: {} }).metadata_suggestions, null)
  assert.equal(validateResult({ summary: 'x', metadata_suggestions: 'no' }).metadata_suggestions, null)
})

test('confidence is clamped, and null when not a number', () => {
  const c = v => validateResult({ summary: 'x', confidence: v }).confidence

  assert.equal(c(1.5), 1)
  assert.equal(c(-2), 0)
  assert.equal(c('0.5'), 0.5)
  assert.equal(c('high'), null, 'null so the panel omits it rather than showing NaN%')
  assert.equal(c(undefined), null)
})

test('document_type falls back to unknown', () => {
  assert.equal(validateResult({ summary: 'x' }).document_type, 'unknown')
  assert.equal(validateResult({ summary: 'x', document_type: '  ' }).document_type, 'unknown')
})

// ── DC mapping ─────────────────────────────────────────────────────────────

test('flattenMetadata maps DC URIs to labels and drops the id', () => {
  assert.deepEqual(
    flattenMetadata({
      id: 1049,
      'http://purl.org/dc/elements/1.1/title': { type: 's', text: 'A title' },
      'http://purl.org/dc/elements/1.1/date': { type: 'd', text: '1940' }
    }),
    { title: 'A title', date: '1940' })
})

test('flattenMetadata keeps unmapped URIs visible rather than dropping them', () => {
  const out = flattenMetadata({ 'http://example.org/custom': { text: 'v' } })
  assert.deepEqual(out, { 'http://example.org/custom': 'v' })
})

test('toMetadataPayload maps short names to URIs and drops empties', () => {
  assert.deepEqual(
    toMetadataPayload({ title: 'T', date: '', creator: null, bogus: 'x' }),
    { 'http://purl.org/dc/elements/1.1/title': 'T' })
})

// ── status lines ───────────────────────────────────────────────────────────

test('renderStatusLines escapes outcome text', () => {
  const html = renderStatusLines([{ kind: 'warn', text: 'failed <b>badly</b>' }])

  assert.match(html, /failed &lt;b&gt;badly&lt;\/b&gt;/)
  assert.match(html, /autropy-status__line--warn/)
})

test('renderStatusLines is empty when there is nothing to report', () => {
  assert.equal(renderStatusLines([]), '')
  assert.equal(renderStatusLines(null), '')
})

test('an unknown outcome gets its own visual treatment', () => {
  const html = renderStatusLines([{ kind: 'unknown', text: 'may not have saved' }])
  assert.match(html, /autropy-status__line--unknown/)
})

// ── containment ────────────────────────────────────────────────────────────
//
// These assert structure rather than appearance, because the failure they guard
// against was not cosmetic: a long AI-written description widened the panel,
// overflowed Tropy's image viewer, and gave the whole window a horizontal
// scrollbar — pushing the project panel off the left of the screen so it looked
// as though Tropy had broken. It recurred once after a partial fix.

const LONG_DESCRIPTION =
  'Death registry entry (No. 58694) from a Brazilian civil registry office ' +
  'recording the death of Carlos (Karl) Chieger, aged 63, born in Austria, ' +
  'resident at Rua do Catete 156, Rio de Janeiro, who died on 11 July 1960 ' +
  'of arterial rupture, son of Bernat Theodor Chieger and Rosa Chieger.'

function panel () {
  return buildPanelHTML({
    summary: 'A death record.',
    document_type: 'administrative_document',
    possible_tags: ['Chieger Karl', 'Catalogados'],
    metadata_suggestions: { title: 'Óbito — Carlos Chieger', description: LONG_DESCRIPTION },
    confidence: 0.9
  }, ['Chieger Karl'], true)
}

test('the panel clips horizontally instead of spilling into Tropy', () => {
  assert.match(PANEL_STYLES, /#autropy-panel\s*\{[^}]*overflow:\s*hidden auto/,
    'the panel must clip on the x axis, or its content widens the host window')
  assert.match(PANEL_STYLES, /#autropy-panel\s*\{[^}]*max-width:\s*100%/)
})

test('the metadata table cannot grow past the panel', () => {
  // `width: 100%` alone loses to a long cell's intrinsic width under the
  // default `table-layout: auto`.
  assert.match(PANEL_STYLES, /\.autropy-meta-table\s*\{[^}]*table-layout:\s*fixed/)
  assert.match(PANEL_STYLES, /\.autropy-meta-col--field\s*\{[^}]*width:/)
  assert.match(PANEL_STYLES, /\.autropy-meta-col--action\s*\{[^}]*width:/)
})

test('the table declares a colgroup so fixed layout has widths to use', () => {
  const html = panel()

  assert.match(html, /<colgroup>/)
  assert.match(html, /autropy-meta-col--field/)
  assert.match(html, /autropy-meta-col--action/)
})

test('a long value wraps in full rather than getting its own scrollbar', () => {
  // Capping the cell's height was a worse cure than the disease: it put a
  // second scrollbar in the middle of the table and clipped the description
  // mid-line. Containment is the panel's job, and only the panel's.
  assert.doesNotMatch(PANEL_STYLES, /\.autropy-meta-row__(value|text)\s*\{[^}]*max-height:/)
  assert.doesNotMatch(PANEL_STYLES, /\.autropy-meta-row__(value|text)\s*\{[^}]*overflow-y:/)
  assert.match(PANEL_STYLES, /\.autropy-meta-row__value\s*\{[^}]*overflow-wrap:\s*anywhere/,
    'this, not a height cap, is what stops an unbroken string widening the table')
})

test('nothing inside the panel is a second scroll container', () => {
  // One scrollbar, on #autropy-panel. The summary textarea is the exception:
  // it is an editable field and scrolls by nature.
  const styles = PANEL_STYLES.replace(/\.autropy-summary\s*\{[^}]*\}/g, '')

  assert.doesNotMatch(styles, /#?\.?autropy-(?!panel)[\w-]*\s*\{[^}]*overflow(-y)?:\s*(auto|scroll)/)
})

test('the value text survives wrapping, so Apply still reads it', () => {
  // #applyAccepted reads .autropy-meta-row__value textContent.
  const html = panel()
  assert.ok(html.includes(LONG_DESCRIPTION), 'the description must still be present as text')
})

test('the action row is sticky so Dismiss stays reachable', () => {
  assert.match(PANEL_STYLES, /\.autropy-actions\s*\{[^}]*position:\s*sticky/)
})
