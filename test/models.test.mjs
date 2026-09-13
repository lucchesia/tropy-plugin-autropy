// Model choice: which models the panel may offer, and what it says about the
// fields a model did not answer.
//
// The provider check here is a security boundary, not a convenience. There is
// exactly one apiKey option, so a list mixing Claude and GPT would send the
// Anthropic key to OpenAI as a bearer token.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { analyze, listModels, providerFor, resolveModelChoices } from '../src/api.js'
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

// ── the offered list ───────────────────────────────────────────────────────

test('the configured model is always offered, and comes first', () => {
  const { models } = resolveModelChoices('claude-sonnet-5', 'claude-opus-5')

  assert.deepEqual(models, ['claude-sonnet-5', 'claude-opus-5'])
})

test('a model from another provider is refused, because there is one API key', () => {
  // The failure this prevents: the Anthropic key going to api.openai.com as a
  // bearer token, because the researcher listed a model they also use elsewhere.
  const { models, rejected } = resolveModelChoices(
    'claude-sonnet-5', 'gpt-4o, gemini-2.5-flash, claude-haiku-4-5')

  assert.deepEqual(models, ['claude-sonnet-5', 'claude-haiku-4-5'])
  assert.deepEqual(rejected.map(r => r.model), ['gpt-4o', 'gemini-2.5-flash'])
  assert.match(rejected[0].reason, /only one API key/)
  assert.match(rejected[0].reason, /anthropic/)
})

test('one bad entry does not discard the good ones', () => {
  const { models, rejected } = resolveModelChoices(
    'claude-sonnet-5', 'Claude Opus 5, claude-opus-5')

  assert.deepEqual(models, ['claude-sonnet-5', 'claude-opus-5'])
  assert.equal(rejected.length, 1)
  assert.match(rejected[0].reason, /display name/)
})

test('duplicates and blanks are dropped, case-insensitively', () => {
  const { models } = resolveModelChoices(
    'claude-sonnet-5', ' , claude-sonnet-5 ,CLAUDE-SONNET-5, claude-opus-5,')

  assert.deepEqual(models, ['claude-sonnet-5', 'claude-opus-5'])
})

test('no configured model means nothing is offered', () => {
  assert.deepEqual(resolveModelChoices('', 'claude-opus-5').models, [])
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

// ── the picker ─────────────────────────────────────────────────────────────

test('one model means no picker', () => {
  const html = panelFor({}, {}, [{ model: 'claude-opus-5', cached: true }])

  assert.doesNotMatch(html, /id="autropy-model"/)
})

test('the picker marks which models have already been run', () => {
  const html = panelFor({}, {}, [
    { model: 'claude-opus-5', cached: true },
    { model: 'claude-sonnet-5', cached: true },
    { model: 'claude-haiku-4-5', cached: false }
  ])

  assert.match(html, /id="autropy-model"/)
  assert.match(html, /<option value="claude-opus-5" selected>claude-opus-5<\/option>/)
  assert.match(html, /claude-sonnet-5 · already run/)
  assert.doesNotMatch(html, /claude-haiku-4-5 · already run/)
})

// ── asking the provider what this key can reach ────────────────────────────

function listStub (handler) {
  const calls = []
  const real = globalThis.fetch

  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }

  return { calls, restore: () => { globalThis.fetch = real } }
}

const listOk = body => ({ ok: true, json: async () => body })

//
// Hardcoding "the latest models" guarantees the list is wrong within months and
// fails as a 404 the researcher has already waited for. Asking is current — and
// it must ask only the one provider the key belongs to.

test('an Anthropic key is never used to ask another provider for its catalogue', async () => {
  // The whole point of the same-provider rule: one apiKey, so a stray request
  // to another host is a credential leak, not a failed feature.
  const f = listStub(url => {
    assert.match(url, /^https:\/\/api\.anthropic\.com\//, `contacted ${url}`)
    return listOk({ data: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }] })
  })

  try {
    const models = await listModels({ model: 'claude-opus-5', apiKey: 'sk-test' })

    assert.deepEqual(models, ['claude-opus-5', 'claude-sonnet-5'])
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].init.headers['x-api-key'], 'sk-test')
    assert.ok(!('Authorization' in f.calls[0].init.headers))
  } finally {
    f.restore()
  }
})

test('an unrecognized model id asks nobody', async () => {
  const f = listStub(() => { throw new Error('should not be called') })

  try {
    assert.deepEqual(await listModels({ model: 'llama3', apiKey: 'k' }), [])
    assert.deepEqual(await listModels({ model: 'claude-opus-5', apiKey: '' }), [])
    assert.equal(f.calls.length, 0)
  } finally {
    f.restore()
  }
})

test('Gemini offers only models that can answer a generateContent call', async () => {
  const f = listStub(() => listOk({
    models: [
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
    ]
  }))

  try {
    assert.deepEqual(
      await listModels({ model: 'gemini-2.5-flash', apiKey: 'k' }),
      ['gemini-2.5-flash'])
  } finally {
    f.restore()
  }
})

test('an unreachable list is not an error — it leaves the picker as it was', async () => {
  const bad = listStub(() => ({ ok: false, json: async () => ({}) }))
  try {
    assert.deepEqual(await listModels({ model: 'claude-opus-5', apiKey: 'k' }), [])
  } finally {
    bad.restore()
  }

  const offline = listStub(() => { throw new Error('ENOTFOUND') })
  try {
    assert.deepEqual(await listModels({ model: 'claude-opus-5', apiKey: 'k' }), [])
  } finally {
    offline.restore()
  }
})

test('a fetched list is still filtered by the same-provider rule', async () => {
  // Defence in depth: the boundary holds wherever the list came from. A
  // provider returning something odd must not widen what the key can reach.
  const { models, rejected } = resolveModelChoices(
    'claude-opus-5', 'claude-sonnet-5,gpt-4o,Claude Opus 5')

  assert.deepEqual(models, ['claude-opus-5', 'claude-sonnet-5'])
  assert.equal(rejected.length, 2)
})
