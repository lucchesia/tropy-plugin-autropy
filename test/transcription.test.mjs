// Transcriptions.
//
// The default prompt has told the model since April to treat an existing
// transcription as the primary source for textual content — and nothing ever
// supplied one. So every analysis of a page that had already been transcribed
// opened by announcing that no transcription was available, and read the
// handwriting off the scan instead of the text sitting beside it in Tropy.
//
// The fixture below is invented. Real transcription text from a research
// project does not belong in a repository: it is archival material about named
// people, and a test fixture is the last place it should end up.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { buildPrompt } from '../src/prompt.js'
import { RestProjectGateway } from '../src/gateway.js'

const PLUGIN_SOURCE = fileURLToPath(new URL('../src/plugin.js', import.meta.url))

const TRANSCRIPTION =
  'EXAMPLE REGISTRY OFFICE\nForm A-1\nSubject: sample entry\nReference: 0000/00'

// ── the prompt ─────────────────────────────────────────────────────────────

test('an existing transcription reaches the model', () => {
  const prompt = buildPrompt('', [], null, '', TRANSCRIPTION)

  assert.match(prompt, /TRANSCRIPTION OF THIS PAGE/)
  assert.match(prompt, /EXAMPLE REGISTRY OFFICE/)
  assert.match(prompt, /Reference: 0000\/00/)
})

test('the transcription is labelled machine-produced', () => {
  // It is OCR or HTR output. A model told to treat it as authoritative will
  // repeat its recognition errors with confidence.
  const prompt = buildPrompt('', [], null, '', TRANSCRIPTION)

  assert.match(prompt, /machine-produced/)
  assert.match(prompt, /recognition errors/)
  assert.match(prompt, /say so when the image contradicts it/)
})

test('no transcription means no block at all', () => {
  for (const empty of [null, undefined, '', '   ']) {
    assert.doesNotMatch(
      buildPrompt('', [], null, '', empty), /TRANSCRIPTION OF THIS PAGE/)
  }
})

test('a custom prompt still receives the transcription', () => {
  // Unlike the tag and metadata hints, which are prompt tuning the researcher
  // has taken over. A transcription is source material about the document.
  const prompt = buildPrompt('My own instructions.', [], null, '', TRANSCRIPTION)

  assert.match(prompt, /My own instructions\./)
  assert.match(prompt, /TRANSCRIPTION OF THIS PAGE/)
  assert.doesNotMatch(prompt, /EXISTING PROJECT TAGS/)
})

test('the transcription comes before the JSON format block', () => {
  // After it, the model tends to read the transcription as part of the output
  // shape being requested rather than as evidence.
  const prompt = buildPrompt('', [], null, '', TRANSCRIPTION)

  assert.ok(prompt.indexOf('TRANSCRIPTION OF THIS PAGE') < prompt.indexOf('"summary"'))
})

test('the language instruction still comes last', () => {
  const prompt = buildPrompt('', [], null, 'Portuguese', TRANSCRIPTION)

  assert.ok(prompt.indexOf('TRANSCRIPTION OF THIS PAGE') < prompt.indexOf('Portuguese'))
})

// ── the read ───────────────────────────────────────────────────────────────

function gateway (fetchImpl) {
  const g = new RestProjectGateway({
    projectPath: '/a.tropy',
    port: 2029,
    logger: { warn () {}, error () {} },
    fetch: fetchImpl
  })

  // Identity resolution has its own tests; these are about the read.
  g.resolve = async () => ({ base: 'http://localhost:2029/project/a', shape: 'scoped' })

  return g
}

function ok (body) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  })
}

test('only the text is read, never the ALTO payload', async () => {
  // The response also carries `data`: the full ALTO XML, tens of kilobytes of
  // coordinates for a dense page, which would be billed as input tokens for no
  // analytical gain.
  const g = gateway(ok({
    id: 837,
    parent: 462,
    text: TRANSCRIPTION,
    data: '<?xml version="1.0"?><alto>' + 'x'.repeat(50000) + '</alto>'
  }))

  const t = await g.getTranscription(837)

  assert.deepEqual(Object.keys(t).sort(), ['id', 'text'])
  assert.equal(t.text, TRANSCRIPTION)
})

test('an empty transcription is nothing, not an empty block', async () => {
  const g = gateway(ok({ id: 1, text: '   ', data: '<alto/>' }))

  assert.equal(await g.getTranscription(1), null)
})

// ── how the plugin uses it ─────────────────────────────────────────────────

test('the most recent transcription is the one used', () => {
  // A photo can carry several; Tropy's own viewer shows the latest.
  const source = readFileSync(PLUGIN_SOURCE, 'utf8')
  const fn = source.slice(source.indexOf('#readTranscriptions ('))

  assert.match(fn.slice(0, 1400), /ids\[ids\.length - 1\]/)
})

test('one unreadable transcription does not end the analysis', () => {
  const source = readFileSync(PLUGIN_SOURCE, 'utf8')
  const fn = source.slice(
    source.indexOf('#readTranscriptions ('), source.indexOf('#analyzePhoto ('))

  assert.match(fn, /catch/)
  assert.match(fn, /analyzed from the image alone/)
})

test('the prompt is built per photo, because transcriptions are', () => {
  // It used to be assembled once for the whole run, which would have given every
  // page of a six-page item page one's transcription.
  const source = readFileSync(PLUGIN_SOURCE, 'utf8')

  assert.match(source, /const promptFor = id => buildPrompt\(/)
  assert.match(source, /prompt: promptFor\(id\)/)
  assert.doesNotMatch(source, /const finalPrompt = buildPrompt\(/)
})

test('adding a transcription invalidates the cached analysis', () => {
  // The cache key covers the assembled prompt, and the prompt now contains the
  // transcription — so a page analyzed before it was transcribed is a miss.
  const before = buildPrompt('', [], null, '', null)
  const after = buildPrompt('', [], null, '', TRANSCRIPTION)

  assert.notEqual(before, after)
})
