// The item summary is the deliverable, and the page summaries exist so that it
// can exist. Two consequences are tested here:
//
//   1. A page is no longer read cold. It is given the summaries of the pages
//      just before it, so a letter that continues across pages is read as one
//      document — and a page summary is therefore no longer an independent
//      reading of that page, which the note it becomes has to say.
//   2. The item summary is written in the same pass, under the same approval,
//      and is declined by emptying its box — exactly like a page summary.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { CONTEXT_WINDOW, buildContextBlock, buildPrompt } from '../src/prompt.js'
import { noteStrings } from '../src/i18n.js'
import {
  SYNTHESIS,
  collectWrites,
  createRun,
  digest,
  setResult,
  setSynthesis,
  synthesisKey
} from '../src/run.js'

const PLUGIN_SOURCE = fileURLToPath(new URL('../src/plugin.js', import.meta.url))
const source = () => readFileSync(PLUGIN_SOURCE, 'utf8')

const pages = n => Array.from({ length: n }, (_, i) => ({
  page: i + 1, text: `summary of page ${i + 1}`
}))

// ── the rolling window ─────────────────────────────────────────────────────

test('no preceding pages means no block at all', () => {
  assert.equal(buildContextBlock(null), '')
  assert.equal(buildContextBlock([]), '')
  assert.equal(buildContextBlock('not an array'), '')
})

test('the window is capped, and keeps the pages nearest this one', () => {
  const block = buildContextBlock(pages(8))

  assert.equal(CONTEXT_WINDOW, 3)
  assert.match(block, /\[page 6\]/)
  assert.match(block, /\[page 7\]/)
  assert.match(block, /\[page 8\]/)
  assert.doesNotMatch(block, /\[page 5\]/,
    'an uncapped window would put a whole 111-page item in every prompt')
})

test('the model is told these are machine readings, not transcriptions', () => {
  // Presenting Autropy's own output to the model as though it were source text
  // is the same provenance error as telling it a researcher's transcription is
  // OCR — it invites the model to treat a guess as evidence.
  const block = buildContextBlock(pages(2))

  assert.match(block, /machine readings, not transcriptions/)
  assert.match(block, /may be wrong/)
  assert.match(block, /describe THIS page/)
})

// ── the prompt, and therefore the cache ────────────────────────────────────

test('context reaches the assembled prompt', () => {
  const prompt = buildPrompt('', [], null, '', null, pages(2))

  assert.match(prompt, /PRECEDING PAGES OF THIS SAME ITEM/)
  assert.match(prompt, /summary of page 2/)
})

test('a changed preceding page is a different prompt, so a different cache key', () => {
  // This is what makes the cost dialog honest. A page whose predecessors
  // changed cannot replay a cached analysis: the analysis it would replay was
  // made in a context that no longer exists.
  const before = buildPrompt('', [], null, '', null, pages(2))
  const after = buildPrompt('', [], null, '', null,
    [{ page: 1, text: 'summary of page 1' }, { page: 2, text: 'corrected by hand' }])

  assert.notEqual(digest(before), digest(after))
})

test('a page with no preceding pages is unchanged by the feature', () => {
  const withNone = buildPrompt('', [], null, '', null, [])
  const withNull = buildPrompt('', [], null, '', null)

  assert.equal(withNone, withNull)
  assert.doesNotMatch(withNone, /PRECEDING PAGES/)
})

// ── orchestration ──────────────────────────────────────────────────────────

test('the cost dialog states the item summary before it is billed', () => {
  // It is one more request. Folding it into the first pass without saying so
  // would be spending money the researcher did not approve.
  assert.match(source(), /One further request then writes the item summary/)
  assert.match(source(), /synthesis: siblings\.length > 1/)
})

test('the item summary is written in the same pass, and is what the panel opens on', () => {
  const src = source()

  assert.match(src, /await this\.#synthesize\(run, \{ controller, runId \}\)/)
  assert.match(src, /const landing = run\.synthesis \? SYNTHESIS : done\[0\]\.photoId/)
})

test('a failed item summary does not discard the pages that succeeded', () => {
  assert.match(source(), /The page summaries are ready to review; use Generate again to retry/)
})

test('the cache replay stops at the first miss', () => {
  // Once one page is a new call, every page after it is too: its context would
  // contain a summary that does not exist yet.
  const src = source()

  assert.match(src, /else broken = true/)
  assert.match(src, /const wouldBill = siblings\.filter\(id => !plan\.get\(id\)\.cached\)/)
})

// ── what the note says ─────────────────────────────────────────────────────

test('a page note says what the reading was built from', () => {
  // The wording lives in the translation table now — see i18n.test.mjs — so
  // this checks the note actually asks for it.
  const src = source()

  assert.match(src, /entry\?\.hadTranscription \? t\.withTranscription : t\.withoutTranscription/)
  assert.match(src, /entry\?\.contextPages > 0 \? t\.withContext\(entry\.contextPages\)/)
  assert.match(noteStrings('en').withContext(3), /not an independent reading of this page alone/)
})

test('the machine-readable footer survives the new header', () => {
  // The header is for a person; the footer is what lets a write whose outcome
  // is UNKNOWN be found by hand. Replacing one with the other would lose that.
  const src = source()

  assert.match(src, /\$\{AUTROPY_NOTE_MARKER\} model: \$\{run\.model\}\$\{served\}/)
  assert.match(src, /run \$\{run\.id\}/)
})

// ── the item summary is the first note on the item ─────────────────────────

test('the item summary is emitted before the page notes', () => {
  // Notes are created in the order collectWrites returns them and Tropy lists
  // them in creation order, so emitting it last put the description of the
  // whole item second, below a description of page one. On a 20-page item it
  // was note 2 of 21.
  const run = createRun({
    projectPath: '/p.tropy', itemId: 1, model: 'claude-opus-5', photoIds: [10, 11]
  })
  setResult(run, 10, { result: { summary: 'page one' } })
  setResult(run, 11, { result: { summary: 'page two' } })
  setSynthesis(run, {
    result: { item_summary: 'the whole dossier' },
    sourceKey: synthesisKey(run)
  })

  const { notes } = collectWrites(run)

  assert.equal(notes[0].kind, SYNTHESIS, 'first, so it is the item\'s first note')
  assert.equal(notes[0].text, 'the whole dossier')
  assert.equal(notes.length, 3)
})

// ── feedback outside the item view ─────────────────────────────────────────

test('progress is reported somewhere the project view can show it', () => {
  // The toolbar icon only exists in the item view, and File > Export > Autropy
  // is invoked from the project view — so a whole multi-page run reported
  // itself into the tooltip of a button that was not on screen.
  const src = source()

  assert.match(src, /#setBusyBadge \(text\)/)
  assert.match(src, /document\.body\.appendChild\(el\)/)
  assert.match(src, /Autropy — analyzing page \$\{page\} of/)
})

test('the item view opens when the run starts, not when the first page lands', () => {
  const src = source()
  const start = src.indexOf('starting analysis — run')
  const loop = src.indexOf('for (const id of photoIds)')

  const enter = src.indexOf('this.#enterItemMode()', start)

  assert.ok(enter > start && enter < loop,
    'a researcher left on the project grid cannot tell a slow run from a failed one')
})

test('the model picker is gone from the panel', () => {
  // One API key. A list in the panel invited choosing a model whose provider
  // had never been given one; Preferences is where both live.
  const src = source()

  assert.doesNotMatch(src, /autropy-model/)
  assert.doesNotMatch(src, /listModels/)
})
