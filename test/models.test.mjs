// Model choice: which models the panel may offer, and what it says about the
// fields a model did not answer.
//
// The provider check here is a security boundary, not a convenience. There is
// exactly one apiKey option, so a list mixing Claude and GPT would send the
// Anthropic key to OpenAI as a bearer token.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { analyze, describeModelProblem, providerFor } from '../src/api.js'
import {
  ABSENT,
  DECLINED,
  UNWRITABLE,
  validateResult
} from '../src/result-schema.js'
import { buildPanelHTML } from '../src/panel-template.js'
import { createRun, setResult } from '../src/run.js'

// ── provider routing ───────────────────────────────────────────────────────

test('provider is derived from the model id', () => {
  assert.equal(providerFor('claude-opus-5'), 'anthropic')
  assert.equal(providerFor('gemini-2.5-flash'), 'gemini')
  assert.equal(providerFor('gpt-4o'), 'openai')
  assert.equal(providerFor('o3-mini'), 'openai')
  assert.equal(providerFor('llama3'), null)
  assert.equal(providerFor(''), null)
  assert.equal(providerFor(undefined), null)
})

// ── a Model ID that cannot work ────────────────────────────────────────────
//
// The picker is gone: the model comes from Preferences, where the researcher
// also puts the one API key it must match. Offering a list of models in the
// panel invited picking one whose provider had never been given a key.

test('a display name is caught at load, not as a failed request', () => {
  // "Claude Opus 5" routes to Anthropic on its prefix but is not an API
  // identifier — the exact mistake that broke this plugin once before.
  assert.match(describeModelProblem('Claude Opus 5'), /display name/)
  assert.match(describeModelProblem('llama3'), /not a recognized hosted model ID/)
  assert.match(describeModelProblem(''), /no Model ID is set/)
})

test('a usable model id reports no problem', () => {
  assert.equal(describeModelProblem('claude-opus-5'), null)
  assert.equal(describeModelProblem('gemini-2.5-flash'), null)
  assert.equal(describeModelProblem('gpt-4o'), null)
})

// ── analyze() ──────────────────────────────────────────────────────────────

function stubFetch (body, capture) {
  return async (url, init) => {
    capture.url = url
    capture.body = JSON.parse(init.body)
    return {
      ok: true,
      status: 200,
      json: async () => body
    }
  }
}

const VALID_JSON = JSON.stringify({
  summary: 'A letter.',
  document_type: 'letter',
  possible_tags: ['letter'],
  metadata_suggestions: { title: 'A letter', date: '1940', description: 'A letter.' },
  confidence: 0.8
})

test('a text-only call sends no image block', async () => {
  // The item synthesis reads per-photo summaries, not pictures. Forcing it
  // through the image path would mean paying to re-send a scan that has nothing
  // to do with the question.
  const capture = {}
  const original = globalThis.fetch
  globalThis.fetch = stubFetch({
    model: 'claude-opus-5-20260101',
    content: [{ type: 'text', text: VALID_JSON }]
  }, capture)

  try {
    const { result, servedModel } = await analyze({
      model: 'claude-opus-5', prompt: 'summarize', apiKey: 'k'
    })

    const content = capture.body.messages[0].content

    assert.equal(content.length, 1)
    assert.equal(content[0].type, 'text')
    assert.equal(result.summary, 'A letter.')

    // What ran, not what was asked for: the configured id can be an alias.
    assert.equal(servedModel, 'claude-opus-5-20260101')
  } finally {
    globalThis.fetch = original
  }
})

test('an image call still sends the image', async () => {
  const capture = {}
  const original = globalThis.fetch
  globalThis.fetch = stubFetch({ content: [{ type: 'text', text: VALID_JSON }] }, capture)

  try {
    await analyze({
      model: 'claude-opus-5',
      prompt: 'describe',
      apiKey: 'k',
      image: { base64: 'AAAA', mediaType: 'image/jpeg' }
    })

    const content = capture.body.messages[0].content

    assert.equal(content[0].type, 'image')
    assert.equal(content[0].source.data, 'AAAA')
  } finally {
    globalThis.fetch = original
  }
})

test('analyze uses the schema it is given', async () => {
  const capture = {}
  const original = globalThis.fetch
  globalThis.fetch = stubFetch({
    content: [{ type: 'text', text: '{"item_summary":"Six pages."}' }]
  }, capture)

  try {
    const { result } = await analyze({
      model: 'claude-opus-5',
      prompt: 'synthesize',
      apiKey: 'k',
      validate: parsed => ({ itemSummary: parsed.item_summary })
    })

    assert.deepEqual(result, { itemSummary: 'Six pages.' })
  } finally {
    globalThis.fetch = original
  }
})

// ── suppression ────────────────────────────────────────────────────────────

test('a field the model declined is distinguished from one it omitted', () => {
  // This is the answer to a real question: switching to claude-opus-5 returned
  // no description, and the panel gave no way to tell "the model left it alone
  // because the item already has one" from "the model failed".
  const result = validateResult({
    summary: 'x',
    metadata_suggestions: { title: 'A title', date: null }
  })

  const byField = Object.fromEntries(result.suppressed.map(s => [s.field, s.reason]))

  assert.equal(byField.date, DECLINED)
  assert.equal(byField.description, ABSENT)
  assert.equal(byField.title, undefined, 'a field that produced a row is not suppressed')
})

test('the string "null" counts as declining, not as a value', () => {
  // A literal "null" written into dc:date would be worse than no suggestion.
  const result = validateResult({
    summary: 'x',
    metadata_suggestions: { date: 'null', title: 'NULL' }
  })

  assert.equal(result.metadata_suggestions, null)

  const byField = Object.fromEntries(result.suppressed.map(s => [s.field, s.reason]))

  assert.equal(byField.date, DECLINED)
  assert.equal(byField.title, DECLINED)
  assert.equal(byField.description, ABSENT, 'never asked for, so not declined')
})

test('a field Autropy cannot write is reported as unwritable', () => {
  const result = validateResult({
    summary: 'x',
    metadata_suggestions: { title: 'T', publisher: 'Aureliano Machado' }
  })

  const publisher = result.suppressed.find(s => s.field === 'publisher')

  assert.equal(publisher.reason, UNWRITABLE)
})

test('no metadata_suggestions at all means every requested field is absent', () => {
  const result = validateResult({ summary: 'x' })

  assert.deepEqual(
    result.suppressed.map(s => s.field).sort(),
    ['date', 'description', 'title'])
})

// ── how the panel says it ──────────────────────────────────────────────────

function panelFor (metadataSuggestions, itemMetadata, modelChoices = []) {
  const run = createRun({
    projectPath: '/a.tropy', itemId: 1, model: 'claude-opus-5', photoIds: [2]
  })
  run.itemMetadata = itemMetadata

  setResult(run, 2, {
    result: validateResult({
      summary: 'x',
      document_type: 'letter',
      metadata_suggestions: metadataSuggestions
    })
  })

  return buildPanelHTML({
    run, photoId: 2, existingTagNames: [], suggestMetadata: true, modelChoices
  })
}

test('a declined field on a filled item says the value was left alone', () => {
  const html = panelFor({ date: null }, { date: 'Fevereiro de 1922' })

  assert.match(html, /left alone — this item already has a value/)
})

test('a declined field on an empty item says the model had nothing', () => {
  const html = panelFor({ date: null }, {})

  assert.match(html, /the model had nothing to suggest/)
})

test('a suppressed row offers no Accept button', () => {
  const html = panelFor({ date: null }, {}).split('</style>')[1]
  const row = html.match(/<tr class="autropy-meta-row autropy-meta-row--suppressed"[\s\S]*?<\/tr>/)

  assert.ok(row, 'expected a suppressed row')
  assert.doesNotMatch(row[0], /button/)
})

test('a panel with one model shows no picker — the model lives in Preferences', () => {
  // Offering a list in the panel invited picking a model whose provider had
  // never been given an API key, and there is only ever one key.
  const run = createRun({
    projectPath: '/p.tropy', itemId: 1, model: 'claude-opus-5', photoIds: [10]
  })
  setResult(run, 10, { result: { summary: 's', possible_tags: [] } })

  const html = buildPanelHTML({
    run, photoId: 10, existingTagNames: [], suggestMetadata: true
  })

  assert.doesNotMatch(html, /id="autropy-model"/)
})
