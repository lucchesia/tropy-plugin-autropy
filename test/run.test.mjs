// The run model: what the researcher decided, and what was actually written.
//
// These are the tests for the bug that prompted this release. After a
// successful Apply the panel was removed but the cached analysis was not, and
// nothing recorded that it had been applied — so clicking the toolbar icon
// replayed it as a fresh editable panel and a second Apply wrote a SECOND note.
// Notes are the one non-idempotent write Autropy makes.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  ACKNOWLEDGED,
  COMPLETE,
  DRAFT,
  PARTIAL,
  PENDING,
  REJECTED,
  UNCERTAIN,
  UNKNOWN,
  acceptedFields,
  acceptedTags,
  appliedSummary,
  collectWrites,
  createRun,
  imageFingerprint,
  isFieldAccepted,
  isLocked,
  isTagAccepted,
  ledgerState,
  metadataOp,
  noteOp,
  photoCacheKey,
  recordOperation,
  retryableOperations,
  runCacheKey,
  setResult,
  setSummaryDraft,
  tagOp,
  toggleField,
  toggleTag
} from '../src/run.js'

import { buildPanelHTML } from '../src/panel-template.js'

const PLUGIN_SOURCE = fileURLToPath(new URL('../src/plugin.js', import.meta.url))
const PANEL_SOURCE = fileURLToPath(new URL('../src/panel-template.js', import.meta.url))

const RESULT = {
  summary: 'A death record.',
  document_type: 'administrative_document',
  possible_tags: ['Passport', 'Visa'],
  metadata_suggestions: { title: 'Óbito', description: 'A registry entry.' },
  confidence: 0.9
}

function run (photoIds = [819]) {
  const r = createRun({
    projectPath: '/Users/a/sample.tropy',
    itemId: 818,
    model: 'claude-sonnet-5',
    photoIds
  })
  for (const id of photoIds) setResult(r, id, { result: RESULT })
  return r
}

// ── decisions ──────────────────────────────────────────────────────────────

test('tags arrive accepted and metadata arrives un-accepted', () => {
  // Writing a field is a heavier act than adding a tag: it replaces something
  // the researcher may have written by hand.
  const r = run()

  assert.equal(isTagAccepted(r, 819, 'Passport'), true)
  assert.equal(isFieldAccepted(r, 819, 'title'), false)
})

test('toggling writes into the run, not into markup', () => {
  const r = run()

  toggleField(r, 819, 'title')
  assert.equal(isFieldAccepted(r, 819, 'title'), true)

  toggleField(r, 819, 'title')
  assert.equal(isFieldAccepted(r, 819, 'title'), false)

  toggleTag(r, 819, 'Passport')
  assert.equal(isTagAccepted(r, 819, 'Passport'), false)
})

test('a re-rendered panel shows the decisions that were made', () => {
  // The regression this replaces: re-rendering reset every metadata row to
  // un-accepted and re-accepted every tag chip, so a researcher who reopened
  // the panel saw decisions they had not made.
  const r = run()

  toggleField(r, 819, 'title')
  toggleTag(r, 819, 'Visa')

  const html = buildPanelHTML({
    run: r, photoId: 819, existingTagNames: [], suggestMetadata: true
  })

  assert.match(html, /data-field="title" data-accepted="true"/)
  assert.match(html, /data-tag="Visa"\s+data-accepted="false"/)
  assert.match(html, /data-tag="Passport"\s+data-accepted="true"/)
})

test('an edited summary survives a re-render', () => {
  const r = run()

  setSummaryDraft(r, 819, 'My own words.')

  const html = buildPanelHTML({
    run: r, photoId: 819, existingTagNames: [], suggestMetadata: true
  })

  assert.match(html, />My own words\.</)
  assert.doesNotMatch(html, /A death record\./)
})

test('accepted tags are unioned across photos, first spelling wins', () => {
  // Tropy treats "Passport" and "passport" as one tag, so two photos suggesting
  // different casings must not become two creation attempts.
  const r = run([1, 2])
  r.photos[1].accept.tags = ['passport', 'Ship manifest']

  assert.deepEqual(acceptedTags(r), ['Passport', 'Visa', 'Ship manifest'])
})

test('acceptedFields reads the document type through the type row', () => {
  const r = run()

  toggleField(r, 819, 'type')
  toggleField(r, 819, 'title')

  assert.deepEqual(acceptedFields(r, 819), {
    type: 'administrative_document',
    title: 'Óbito'
  })
})

// ── the ledger ─────────────────────────────────────────────────────────────

test('a fresh run is a draft and is editable', () => {
  const r = run()

  assert.equal(ledgerState(r), DRAFT)
  assert.equal(isLocked(r), false)
  assert.equal(appliedSummary(r), null)
})

test('the ledger reports the worst outcome it holds', () => {
  const r = run()

  recordOperation(r, { key: tagOp('Passport'), kind: 'tag', status: PENDING })
  assert.equal(ledgerState(r), 'applying')

  recordOperation(r, { key: tagOp('Passport'), kind: 'tag', status: ACKNOWLEDGED })
  assert.equal(ledgerState(r), COMPLETE)

  recordOperation(r, { key: metadataOp(818), kind: 'metadata', status: REJECTED })
  assert.equal(ledgerState(r), PARTIAL)

  // Uncertainty outranks refusal: a refused write definitely did not land, so
  // it can simply be repeated. An unknown one cannot.
  recordOperation(r, { key: noteOp(819), kind: 'note', status: UNKNOWN })
  assert.equal(ledgerState(r), UNCERTAIN)
})

test('anything written locks the run against further editing', () => {
  const r = run()

  recordOperation(r, { key: noteOp(819), kind: 'note', status: ACKNOWLEDGED })

  assert.equal(isLocked(r), true)

  toggleField(r, 819, 'title')
  assert.equal(isFieldAccepted(r, 819, 'title'), false, 'a locked run cannot be edited')

  setSummaryDraft(r, 819, 'too late')
  assert.equal(r.photos[0].summaryDraft, 'A death record.')
})

test('a locked run renders as a receipt, not a form', () => {
  const r = run()
  recordOperation(r, {
    key: noteOp(819), kind: 'note', status: ACKNOWLEDGED, describe: 'writing a note'
  })

  // Markup only: the stylesheet names every class whether or not it is used.
  const html = buildPanelHTML({
    run: r, photoId: 819, existingTagNames: [], suggestMetadata: true
  }).split('</style>')[1]

  assert.match(html, /autropy-banner/)
  assert.match(html, /id="autropy-reanalyze"/)
  assert.doesNotMatch(html, /id="autropy-apply"/,
    'an applied run must not offer the button that would write it again')
  assert.doesNotMatch(html, /autropy-meta-row__accept/)
  assert.match(html, /readonly/)
})

test('an uncertain write names itself and the run that made it', () => {
  // The one outcome Autropy refuses to resolve on the researcher's behalf, so
  // it has to leave something searchable behind.
  const r = run()
  recordOperation(r, {
    key: noteOp(819),
    kind: 'note',
    status: UNKNOWN,
    describe: 'writing a note on photo 819'
  })

  const html = buildPanelHTML({
    run: r, photoId: 819, existingTagNames: [], suggestMetadata: true
  })

  assert.match(html, /autropy-banner--uncertain/)
  assert.match(html, /writing a note on photo 819/)
  assert.match(html, new RegExp(`run ${r.id}`))
})

// ── what the next Apply may write ──────────────────────────────────────────

test('an acknowledged note is never written again', () => {
  const r = run()

  recordOperation(r, { key: noteOp(819), kind: 'note', status: ACKNOWLEDGED, noteId: 345 })

  assert.deepEqual(collectWrites(r).notes, [])
})

test('an unknown note is never written again either', () => {
  // The asymmetry that decides this: a duplicate note is something the
  // researcher has to find and delete, while a missing one is something they
  // can add in a keystroke.
  const r = run()

  recordOperation(r, { key: noteOp(819), kind: 'note', status: UNKNOWN })

  assert.deepEqual(collectWrites(r).notes, [])
})

test('a refused note is offered again, because it definitely did not land', () => {
  const r = run()

  recordOperation(r, { key: noteOp(819), kind: 'note', status: REJECTED })

  assert.deepEqual(collectWrites(r).notes, [{ photoId: 819, text: 'A death record.' }])
})

test('a partial apply re-emits only what was refused', () => {
  const r = run()
  toggleField(r, 819, 'title')

  recordOperation(r, { key: noteOp(819), kind: 'note', status: ACKNOWLEDGED })
  recordOperation(r, { key: tagOp('Passport'), kind: 'tag', status: ACKNOWLEDGED })
  recordOperation(r, { key: tagOp('Visa'), kind: 'tag', status: REJECTED })

  const writes = collectWrites(r)

  assert.deepEqual(writes.notes, [])
  assert.deepEqual(writes.tags, ['Visa'])
  assert.deepEqual(writes.fields, { title: 'Óbito' })
})

test('an empty summary writes no note at all', () => {
  const r = run()
  r.photos[0].summaryDraft = '   '

  assert.deepEqual(collectWrites(r).notes, [])
})

test('only refused operations are offered for retry', () => {
  const r = run()

  recordOperation(r, { key: noteOp(819), kind: 'note', status: UNKNOWN })
  recordOperation(r, { key: tagOp('Visa'), kind: 'tag', status: REJECTED })
  recordOperation(r, { key: tagOp('Passport'), kind: 'tag', status: ACKNOWLEDGED })

  assert.deepEqual(retryableOperations(r).map(op => op.key), [tagOp('Visa')])
})

// ── cache identity ─────────────────────────────────────────────────────────

test('the same item id in two projects is not the same run', () => {
  // Item ids are per-project integers, so item 818 exists in every project the
  // researcher owns. A key without the project path would serve one project's
  // analysis for another project's item — silently, which is worse than the
  // refused write the gateway's identity check produces.
  const a = runCacheKey({ projectPath: '/a/sample.tropy', itemId: 818, model: 'm' })
  const b = runCacheKey({ projectPath: '/b/sample.tropy', itemId: 818, model: 'm' })

  assert.notEqual(a, b)
})

test('a different model is a different run', () => {
  const a = runCacheKey({ projectPath: '/a.tropy', itemId: 818, model: 'claude-sonnet-5' })
  const b = runCacheKey({ projectPath: '/a.tropy', itemId: 818, model: 'claude-opus-5' })

  assert.notEqual(a, b)
})

test('a cached analysis is only reused for the same prompt, model and image', () => {
  const base = {
    projectPath: '/a.tropy',
    itemId: 818,
    photoId: 819,
    model: 'claude-sonnet-5',
    promptDigest: 'p1',
    imageFingerprint: 'f1'
  }

  const key = photoCacheKey(base)

  assert.equal(photoCacheKey({ ...base }), key, 'identical inputs must hit')
  assert.notEqual(photoCacheKey({ ...base, promptDigest: 'p2' }), key)
  assert.notEqual(photoCacheKey({ ...base, imageFingerprint: 'f2' }), key)
  assert.notEqual(photoCacheKey({ ...base, model: 'claude-opus-5' }), key)
  assert.notEqual(photoCacheKey({ ...base, projectPath: '/b.tropy' }), key)
})

test('the researcher rotating a scan invalidates its cached analysis', () => {
  // renderPhoto applies angle, mirror and page before the model sees anything,
  // so a cached result for the old orientation describes a different picture.
  const photo = { path: '/scans/1.tif', page: 0, angle: 0, mirror: false }

  assert.notEqual(imageFingerprint({ ...photo, angle: 90 }), imageFingerprint(photo))
  assert.notEqual(imageFingerprint({ ...photo, mirror: true }), imageFingerprint(photo))
  assert.notEqual(imageFingerprint({ ...photo, page: 1 }), imageFingerprint(photo))
})

// ── the applied banner ─────────────────────────────────────────────────────

test('the banner counts what actually landed', () => {
  const r = run()

  recordOperation(r, { key: noteOp(819), kind: 'note', status: ACKNOWLEDGED })
  recordOperation(r, { key: tagOp('Passport'), kind: 'tag', status: ACKNOWLEDGED })
  recordOperation(r, { key: tagOp('Visa'), kind: 'tag', status: REJECTED })
  recordOperation(r, { key: metadataOp(818), kind: 'metadata', status: ACKNOWLEDGED })

  const applied = appliedSummary(r)

  assert.equal(applied.state, PARTIAL)
  assert.equal(applied.notes, 1)
  assert.equal(applied.tags, 1)
  assert.equal(applied.fields, 1)
  assert.equal(applied.rejected, 1)
  assert.equal(applied.model, 'claude-sonnet-5')
})

// ── overwriting an existing value ──────────────────────────────────────────

test('a suggestion that would replace an existing value says so', () => {
  // Tropy keeps one value per property, so accepting such a row is a
  // replacement. Anita applied the type row on an item whose "Tipo de Imagem"
  // read "Desenho" and it became the model's English "drawing", with nothing
  // in the panel having said that would happen.
  const r = run()
  r.itemMetadata = { type: 'Desenho', title: '' }

  const html = buildPanelHTML({
    run: r, photoId: 819, existingTagNames: [], suggestMetadata: true
  })

  assert.match(html, /replaces: Desenho/)
  assert.doesNotMatch(html, /replaces: <\/span>/, 'an empty field is not a replacement')
})

test('an identical value is not reported as a replacement', () => {
  const r = run()
  r.itemMetadata = { type: 'administrative_document' }

  const html = buildPanelHTML({
    run: r, photoId: 819, existingTagNames: [], suggestMetadata: true
  })

  assert.doesNotMatch(html, /replaces:/)
})

test('Suggest Metadata off means no metadata row can be written', () => {
  // The type row used to render unconditionally, so with the setting off,
  // accepting it still wrote dc:type.
  const r = run()

  const html = buildPanelHTML({
    run: r, photoId: 819, existingTagNames: [], suggestMetadata: false
  }).split('</style>')[1]

  assert.doesNotMatch(html, /autropy-meta-row/)
  assert.match(html, /autropy-header__type/, 'the inferred type is still shown in the header')
})

// ── source assertions ──────────────────────────────────────────────────────

test('the note stamps the model that ran, not the current preference', () => {
  // options.model can have changed since the analysis — a preference change is
  // what made Tropy rebuild the plugin in the first place — and a note naming
  // the wrong model is a provenance error in the researcher's own data.
  const source = readFileSync(PLUGIN_SOURCE, 'utf8')
  const build = source.indexOf('#buildNoteHtml (')
  const body = source
    .slice(build, source.indexOf('── teardown', build))
    .replace(/^\s*\/\/.*$/gm, '')   // the comment here names the old expression

  assert.match(body, /model: \$\{run\.model\}/)
  assert.doesNotMatch(body, /this\.options\.model/)
  assert.match(body, /run \$\{run\.id\}/, 'an unknown write has to be findable by hand')
})

test('accepting a metadata row does not render as striking it out', () => {
  // It used to be 'text-decoration: line-through', so Accept looked exactly
  // like reject — one section below chips that use dimming to mean rejected.
  const source = readFileSync(PANEL_SOURCE, 'utf8')
  const rule = source.match(
    /\.autropy-meta-row\[data-accepted="true"\] \.autropy-meta-row__value \{[^}]*\}/)

  assert.ok(rule, 'expected a rule for the accepted state')
  assert.doesNotMatch(rule[0], /line-through/)
})

test('panel queries are scoped to the panel', () => {
  const source = readFileSync(PLUGIN_SOURCE, 'utf8')
  const wire = source.indexOf('#wirePanelEvents (')
  const body = source.slice(wire, source.indexOf('── navigation watching', wire))

  assert.doesNotMatch(body, /document\.querySelectorAll/,
    'a document-wide query works only while exactly one panel exists')
  assert.doesNotMatch(body, /document\.getElementById/)
})
