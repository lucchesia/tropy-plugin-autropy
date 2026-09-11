// The item summary: one description for a multi-page item, written from the
// page summaries as the researcher left them.
//
// The rule these tests exist to protect: an item description must never be
// derived from text its author has already corrected. That is why the synthesis
// is keyed on its sources rather than merely timestamped.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { buildSynthesisPrompt } from '../src/prompt.js'
import { validateSynthesis } from '../src/result-schema.js'
import { buildPanelHTML } from '../src/panel-template.js'
import {
  ACKNOWLEDGED,
  SYNTHESIS,
  UNKNOWN,
  canSynthesize,
  collectWrites,
  createRun,
  isSynthesisStale,
  recordOperation,
  setFailed,
  setResult,
  setSummaryDraft,
  setSynthesis,
  synthesisKey,
  synthesisNoteOp,
  synthesisNotePhoto,
  synthesisSources,
  toggleSynthesisField,
  toggleSynthesisNote
} from '../src/run.js'

const SYNTH = {
  item_summary: 'A six-page Vatican dossier concerning Charlotte Falkenstein.',
  metadata_suggestions: {
    title: 'Dossier Falkenstein',
    description: 'A 1940 dossier of the Secretariat of State.'
  },
  confidence: 0.7
}

function item (pages = 6, done = pages) {
  const ids = Array.from({ length: pages }, (_, i) => 100 + i)
  const run = createRun({
    projectPath: '/a.tropy', itemId: 1, model: 'claude-opus-5', photoIds: ids
  })

  ids.forEach((id, i) => {
    if (i < done) setResult(run, id, { result: { summary: `Page ${i + 1}.` } })
    else setFailed(run, id, new Error('too large'))
  })

  return run
}

function synthesized (run) {
  setSynthesis(run, {
    result: validateSynthesis(SYNTH),
    sourceKey: synthesisKey(run),
    incomplete: synthesisSources(run).length < run.photos.length
  })
  return run
}

// ── when it is possible ────────────────────────────────────────────────────

test('a single-page item is not synthesized — its page IS the item', () => {
  const run = createRun({ projectPath: '/a', itemId: 1, model: 'm', photoIds: [2] })
  setResult(run, 2, { result: { summary: 'One page.' } })

  assert.equal(canSynthesize(run), false)
})

test('one analyzed page out of six is not a synthesis of anything', () => {
  assert.equal(canSynthesize(item(6, 1)), false)
  assert.equal(canSynthesize(item(6, 2)), true)
})

test('only analyzed pages with text are sources', () => {
  const run = item(6, 4)
  setSummaryDraft(run, 102, '   ')

  assert.deepEqual(synthesisSources(run).map(s => s.photoId), [100, 101, 103])
})

// ── staleness: the rule that matters ───────────────────────────────────────

test('editing a page summary makes the item summary stale', () => {
  // Otherwise the item description would still be the one derived from text the
  // researcher has since rejected, with nothing on screen to say so.
  const run = synthesized(item(4))

  assert.equal(isSynthesisStale(run), false)

  setSummaryDraft(run, 101, 'Actually this page is a cover sheet.')

  assert.equal(isSynthesisStale(run), true)
})

test('a stale item summary is not written, even if it was accepted', () => {
  const run = synthesized(item(4))
  toggleSynthesisNote(run)
  toggleSynthesisField(run, 'title')

  const synthNotes = r => collectWrites(r).notes.filter(n => n.kind === SYNTHESIS)

  assert.equal(synthNotes(run).length, 1)
  assert.deepEqual(collectWrites(run).fields, { title: 'Dossier Falkenstein' })

  setSummaryDraft(run, 101, 'Corrected.')

  assert.deepEqual(synthNotes(run), [])
  assert.deepEqual(collectWrites(run).fields, {},
    'and neither is the metadata it proposed')

  // The page notes are untouched — only the thing derived from them is.
  assert.equal(collectWrites(run).notes.length, 4)
})

test('analyzing another page also makes it stale', () => {
  const run = synthesized(item(6, 4))

  setResult(run, 104, { result: { summary: 'Page 5.' } })

  assert.equal(isSynthesisStale(run), true)
})

test('a different model is a different synthesis', () => {
  const run = item(4)
  const before = synthesisKey(run)
  run.model = 'claude-sonnet-5'

  assert.notEqual(synthesisKey(run), before)
})

// ── what it writes ─────────────────────────────────────────────────────────

test('the item summary note is opt-in', () => {
  // Per-page notes record the analysis; an item summary is an interpretation,
  // and writing one unasked puts a machine reading of the whole dossier into
  // the project.
  const run = synthesized(item(4))

  assert.equal(collectWrites(run).notes.some(n => n.kind === SYNTHESIS), false)

  toggleSynthesisNote(run)

  assert.equal(collectWrites(run).notes.some(n => n.kind === SYNTHESIS), true)
})

test('the item summary attaches to the first analyzed page', () => {
  // Tropy has no item-level note endpoint, so this is the least arbitrary home.
  const run = item(6)
  setFailed(run, 100, new Error('nope'))

  assert.equal(synthesisNotePhoto(run), 101)
})

test('item metadata comes only from the synthesis in a multi-page run', () => {
  const run = synthesized(item(4))

  // A page accepting a field of its own changes nothing at item level.
  run.photos[0].accept.fields = ['title']

  assert.deepEqual(collectWrites(run).fields, {})

  toggleSynthesisField(run, 'description')

  assert.deepEqual(collectWrites(run).fields, {
    description: 'A 1940 dossier of the Secretariat of State.'
  })
})

test('the synthesis note has its own ledger key, not the page it lands on', () => {
  // It attaches to page 1, which already has a note of its own. Sharing a key
  // would make one suppress the other.
  const run = synthesized(item(4))
  toggleSynthesisNote(run)

  recordOperation(run, {
    key: synthesisNoteOp(), kind: 'note', status: ACKNOWLEDGED
  })

  const notes = collectWrites(run).notes

  assert.equal(notes.some(n => n.kind === SYNTHESIS), false, 'not written twice')
  assert.ok(notes.some(n => n.photoId === 100), 'the page note is unaffected')
})

test('an unknown item-summary write is never repeated', () => {
  const run = synthesized(item(4))
  toggleSynthesisNote(run)

  recordOperation(run, { key: synthesisNoteOp(), kind: 'note', status: UNKNOWN })

  assert.equal(collectWrites(run).notes.some(n => n.kind === SYNTHESIS), false)
})

// ── the prompt ─────────────────────────────────────────────────────────────

test('the synthesis prompt carries every page, in order, and no image', () => {
  const run = item(3)
  const prompt = buildSynthesisPrompt(synthesisSources(run), {})

  assert.match(prompt, /PAGE 1 of 3[\s\S]*Page 1\./)
  assert.match(prompt, /PAGE 3 of 3[\s\S]*Page 3\./)
  assert.ok(prompt.indexOf('Page 1.') < prompt.indexOf('Page 3.'))
  assert.match(prompt, /item_summary/)
  assert.doesNotMatch(prompt, /base64/)
})

test('the prompt uses the edited text, not the model original', () => {
  const run = item(3)
  setSummaryDraft(run, 101, 'My own reading of page two.')

  const prompt = buildSynthesisPrompt(synthesisSources(run), {})

  assert.match(prompt, /My own reading of page two\./)
  assert.doesNotMatch(prompt, /Page 2\./)
})

test('an incomplete set is declared to the model', () => {
  const run = item(6, 4)
  const prompt = buildSynthesisPrompt(synthesisSources(run), {
    incomplete: true, total: 6
  })

  assert.match(prompt, /only 4 of this item's 6 pages/)
  assert.match(prompt, /partially covered/)
})

test('the synthesis schema rejects a per-photo response', () => {
  assert.throws(
    () => validateSynthesis({ summary: 'wrong field' }),
    /no "item_summary" field/)
})

// ── the panel ──────────────────────────────────────────────────────────────

function panel (run) {
  return buildPanelHTML({
    run, photoId: SYNTHESIS, existingTagNames: [], suggestMetadata: true
  })
}

test('before it is written the panel offers to write it, and says what it costs', () => {
  const html = panel(item(4))

  assert.match(html, /Item summary/)
  assert.match(html, /id="autropy-synthesize"/)
  assert.match(html, /one more request to the model/)
})

test('once written it shows the text, the note toggle and the item metadata', () => {
  const html = panel(synthesized(item(4)))

  assert.match(html, /A six-page Vatican dossier/)
  assert.match(html, /id="autropy-synthesis-note"/)
  assert.match(html, /Also write this as a note on page 1/)
  assert.match(html, /Dossier Falkenstein/)
})

test('a stale summary warns and cannot be edited', () => {
  const run = synthesized(item(4))
  setSummaryDraft(run, 101, 'Corrected.')

  const html = panel(run)

  assert.match(html, /autropy-warning/)
  assert.match(html, /no longer reflects the pages/)
  assert.match(html, /readonly/)
  assert.match(html, /id="autropy-synthesis-note" disabled|disabled>/)
})

test('an incomplete synthesis says how many pages it had', () => {
  const html = panel(synthesized(item(6, 4)))

  assert.match(html, /Written from 4 of 6/)
})

test('the item summary note says it describes the whole item', () => {
  // It lands on one page, so without this it reads as a claim about that page.
  const text = readFileSync(
    fileURLToPath(new URL('../src/plugin.js', import.meta.url)), 'utf8')

  assert.match(text, /Item summary — describes all pages of this item/)
})
