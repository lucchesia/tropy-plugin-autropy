// Multi-page items: which photos, in what order, and what a run over several
// pages is allowed to write.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { itemPhotoIds, photoAction } from '../src/nav.js'
import {
  SYNTHESIS,
  collectWrites,
  createRun,
  isItemTagAccepted,
  itemTags,
  isMultiPhoto,
  photoIndex,
  progressLabel,
  setFailed,
  setResult,
  setSummaryDraft,
  toggleItemTag
} from '../src/run.js'
import { buildPanelHTML } from '../src/panel-template.js'

const PLUGIN_SOURCE = fileURLToPath(new URL('../src/plugin.js', import.meta.url))

const RESULT = {
  summary: 'A page.',
  document_type: 'manuscript',
  possible_tags: ['letter'],
  metadata_suggestions: { title: 'A title' },
  confidence: 0.8
}

function sixPages () {
  const run = createRun({
    projectPath: '/a.tropy',
    itemId: 461,
    model: 'claude-opus-5',
    photoIds: [462, 463, 464, 465, 466, 467]
  })
  for (const id of run.photos.map(p => p.photoId)) {
    setResult(run, id, { result: { ...RESULT, summary: `Page ${id}.` } })
  }
  return run
}

// ── photo enumeration ──────────────────────────────────────────────────────

test('photos come from the item, in the item order', () => {
  const state = { items: { 461: { photos: [462, 463, 464] } } }

  assert.deepEqual(itemPhotoIds(state, 461), [462, 463, 464])
})

test('item order is NOT page order', () => {
  // `photo.page` is an index within a source file, so every photo of a six-scan
  // item has page 0 and a PDF's pages would interleave with loose JPEGs.
  // state.items[id].photos is the filmstrip order, which is what the researcher
  // means by "page 3".
  const source = readFileSync(
    fileURLToPath(new URL('../src/nav.js', import.meta.url)), 'utf8')
  const fn = source.slice(source.indexOf('export function itemPhotoIds'))

  assert.doesNotMatch(fn.slice(0, 300), /\.sort\(/)
  assert.match(fn.slice(0, 400), /state\?\.items\?\.\[itemId\]\?\.photos/)
})

test('an item with no photos yields an empty list rather than throwing', () => {
  assert.deepEqual(itemPhotoIds({}, 1), [])
  assert.deepEqual(itemPhotoIds({ items: { 1: {} } }, 1), [])
  assert.deepEqual(itemPhotoIds(null, 1), [])
})

test('the pager action selects a photo through Tropy itself', () => {
  assert.deepEqual(photoAction(464), {
    type: 'nav.update',
    payload: { photo: 464 }
  })
})

// ── progress ───────────────────────────────────────────────────────────────

test('a single-photo run has no progress line', () => {
  const run = createRun({ projectPath: '/a', itemId: 1, model: 'm', photoIds: [2] })

  assert.equal(isMultiPhoto(run), false)
  assert.equal(progressLabel(run), '')
})

test('progress counts what happened, including what did not', () => {
  const run = sixPages()

  setFailed(run, 465, new Error('image exceeds maximum'))
  run.photos[5].status = 'skipped'

  assert.equal(progressLabel(run), '4/6 analyzed · 1 failed · 1 not run')
})

test('a failed page does not discard the pages that worked', () => {
  const run = sixPages()
  setFailed(run, 464, new Error('nope'))

  const done = run.photos.filter(p => p.status === 'done')

  assert.equal(done.length, 5)

  // And it contributes no note of its own, even though an earlier result had
  // left a draft on it.
  const { notes } = collectWrites(run)
  assert.equal(notes.length, 5)
  assert.ok(!notes.some(n => n.photoId === 464))
})

test('a page Stop never reached writes nothing', () => {
  const run = sixPages()
  run.photos[4].status = 'skipped'
  run.photos[5].status = 'idle'

  assert.deepEqual(
    collectWrites(run).notes.map(n => n.photoId),
    [462, 463, 464, 465])
})

// ── the pager ──────────────────────────────────────────────────────────────

function panel (run, photoId) {
  return buildPanelHTML({
    run, photoId, existingTagNames: [], suggestMetadata: true
  })
}

test('the pager says where you are and is bounded at both ends', () => {
  const run = sixPages()

  // The item summary is view 0 — the whole before its parts — so page 1 can
  // still go back, and the last page is the end of the sequence.
  const summary = panel(run, SYNTHESIS)
  assert.match(summary, /Item summary/)
  assert.match(summary, /id="autropy-prev" disabled/)
  assert.doesNotMatch(summary, /id="autropy-next" disabled/)

  const first = panel(run, 462)
  assert.match(first, /Page 1 of 6/)
  assert.doesNotMatch(first, /id="autropy-prev" disabled/)

  const last = panel(run, 467)
  assert.match(last, /Page 6 of 6/)
  assert.match(last, /id="autropy-next" disabled/)
})

test('without enough analyzed pages the last page is the last step', () => {
  // Failed pages stay in the pager — you need to see which ones they are — but
  // one analyzed page is not a synthesis of anything, so there is no step past
  // the end.
  const run = sixPages()
  for (const p of run.photos.slice(1)) p.status = 'failed'

  assert.match(panel(run, 467), /id="autropy-next" disabled/)
  assert.match(panel(run, 462), /Page 1 of 6/)
})

test('a single-photo run has no pager at all', () => {
  const run = createRun({ projectPath: '/a', itemId: 1, model: 'm', photoIds: [2] })
  setResult(run, 2, { result: RESULT })

  // Markup only: the stylesheet names every class whether or not it is used.
  assert.doesNotMatch(panel(run, 2).split('</style>')[1], /autropy-pager/)
})

test('each page keeps its own summary draft', () => {
  const run = sixPages()

  setSummaryDraft(run, 463, 'My reading of page two.')

  assert.match(panel(run, 463), /My reading of page two\./)
  assert.match(panel(run, 464), /Page 464\./)
  assert.equal(photoIndex(run, 463), 1)
})

test('a page that failed says so in the pager', () => {
  const run = sixPages()
  setFailed(run, 464, new Error('image exceeds 10 MB maximum'))

  assert.match(panel(run, 464), /failed: .*10 MB maximum/)
})

// ── what a multi-page run may write ────────────────────────────────────────

test('one note per page that has text', () => {
  const run = sixPages()
  run.photos[2].summaryDraft = '   '

  const { notes } = collectWrites(run)

  assert.deepEqual(notes.map(n => n.photoId), [462, 463, 465, 466, 467])
})

test('tags are unioned across pages, not repeated per page', () => {
  const run = sixPages()
  run.photos[1].accept.tags = ['letter', 'Passport']

  assert.deepEqual(collectWrites(run).tags, ['letter', 'Passport'])
})

test('a multi-page run suggests no per-page item metadata', () => {
  // Item metadata has one value per field but six pages produce six sets of
  // suggestions. Merging them makes the last page silently win, with no sign of
  // which description was written.
  const run = sixPages()

  const html = panel(run, 462)

  assert.doesNotMatch(html.split('</style>')[1], /autropy-meta-row/)
  assert.match(html, /Metadata\s+describes the whole item/)
  assert.deepEqual(collectWrites(run).fields, {})
})

test('a single-page item still suggests metadata', () => {
  const run = createRun({ projectPath: '/a', itemId: 1, model: 'm', photoIds: [2] })
  setResult(run, 2, { result: RESULT })

  assert.match(panel(run, 2).split('</style>')[1], /autropy-meta-row/)
})

// ── lifecycle ──────────────────────────────────────────────────────────────

test('the export hook does not block Tropy on the model call', () => {
  // Tropy times this hook and already logs SLOW: item.export for one ~15 s
  // analysis. Six pages would block the menu for minutes.
  const source = readFileSync(PLUGIN_SOURCE, 'utf8')
  const hook = source.slice(source.indexOf('export (items)'), source.indexOf('── analysis'))

  assert.doesNotMatch(hook, /await this\.#runAnalysis/)
  assert.match(hook, /this\.#runAnalysis\(\)\.catch\(/,
    'a detached promise without a catch is an unhandled rejection')
})

test('a run is cancelled by changing item or project, not by changing page', () => {
  // The pager moves Tropy's own photo selection, so a photo change within the
  // item is the run working rather than the researcher leaving.
  const source = readFileSync(PLUGIN_SOURCE, 'utf8')
  const watch = source.slice(source.indexOf('#watchNav ()'), source.indexOf('── status area'))

  assert.match(watch,
    /active\.itemId !== itemId \|\| active\.projectPath !== projectPath/)
  assert.doesNotMatch(watch, /active\.photoId !== photoId/)
})

test('scope is never assumed when the question cannot be asked', () => {
  // Defaulting to "all" on a dialog failure would spend money nobody approved.
  const source = readFileSync(PLUGIN_SOURCE, 'utf8')
  const ask = source.slice(source.indexOf('#askScope ('), source.indexOf('#updateProgress ('))

  assert.match(ask, /return 'one'/)
  assert.doesNotMatch(ask.slice(ask.indexOf('catch')), /return 'all'/)
})

// ── tags belong to the item, not to each page ──────────────────────────────
//
// They were always pooled on write — one deduplicated set per item — but were
// reviewed per page, so the same chip appeared once for every page that
// suggested it, each with its own accept state that the write then ignored.

test('the item summary shows one pooled tag list, and the pages show none', () => {
  const run = sixPages()
  for (const p of run.photos) p.result = { ...p.result, possible_tags: [] }
  run.photos[0].result.possible_tags = ['vatican', 'dossier']
  run.photos[1].result.possible_tags = ['dossier', 'refugees']

  assert.deepEqual(itemTags(run), ['vatican', 'dossier', 'refugees'],
    'de-duplicated, in the order the pages proposed them')

  const summary = panel(run, SYNTHESIS)
  assert.match(summary, /data-tag="refugees"/)

  // `data-tag`, not the class name: the stylesheet mentions the class on every
  // view, which is exactly the kind of match that makes a test pass by accident.
  const page = panel(run, 462)
  assert.doesNotMatch(page, /data-tag=/,
    'deciding the same tag six times is not review, it is repetition')
})

test('one gesture decides a tag everywhere it was suggested', () => {
  const run = sixPages()
  for (const p of run.photos) p.result = { ...p.result, possible_tags: [] }
  run.photos[0].result.possible_tags = ['dossier']
  run.photos[1].result.possible_tags = ['dossier']
  for (const p of run.photos) p.accept.tags = []

  toggleItemTag(run, 'dossier')

  assert.equal(isItemTagAccepted(run, 'dossier'), true)
  assert.deepEqual(collectWrites(run).tags, ['dossier'], 'written once')
  assert.equal(run.photos[1].accept.tags.length, 1, 'and set on every page that proposed it')

  toggleItemTag(run, 'dossier')

  assert.equal(isItemTagAccepted(run, 'dossier'), false)
  assert.deepEqual(collectWrites(run).tags, [])
})

test('a tag is never set on a page that did not suggest it', () => {
  const run = sixPages()
  for (const p of run.photos) p.result = { ...p.result, possible_tags: [] }
  run.photos[0].result.possible_tags = ['vatican']
  for (const p of run.photos) p.accept.tags = []

  toggleItemTag(run, 'vatican')

  assert.deepEqual(run.photos[1].accept.tags, [])
})

test('a single-photo item keeps its chips on the photo, having nowhere else', () => {
  const run = createRun({
    projectPath: '/p.tropy', itemId: 7, model: 'claude-opus-5', photoIds: [900]
  })
  setResult(run, 900, { result: { ...RESULT, possible_tags: ['letter'] } })

  assert.match(panel(run, 900), /data-tag="letter"/)
})
