// Provider adapter behaviour. The model-ID case is here because a display name
// in the Model ID field is what silently broke the live install: it routed to
// Anthropic and was rejected by the API with an opaque error.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SUPPORTED_MEDIA_TYPES, analyzeImage } from '../src/api.js'

const IMAGE = 'aGVsbG8='
const PROMPT = 'describe this'

// Stubs global fetch for one call and reports what was sent.
async function withFetch (respond, run) {
  const original = globalThis.fetch
  const calls = []

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null })
    return respond(url, init)
  }

  try {
    return { result: await run(), calls }
  } finally {
    globalThis.fetch = original
  }
}

function json (body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }
}

const GOOD_JSON = JSON.stringify({
  summary: 'A letter.',
  document_type: 'letter',
  possible_tags: ['Visa'],
  confidence: 0.8
})

// ── model IDs ──────────────────────────────────────────────────────────────

test('a Claude display name is rejected before any request is made', async () => {
  // This is the exact value found in the live plugin config.
  const { calls } = await withFetch(
    () => { throw new Error('must not call the API') },
    () => assert.rejects(
      () => analyzeImage(IMAGE, PROMPT, 'Claude Sonnet 5', 'k'),
      err => /not a valid anthropic model ID/i.test(err.message) &&
        /claude-sonnet-5/.test(err.message)))

  assert.equal(calls.length, 0, 'no billable request should be attempted')
})

test('a valid Claude model ID is accepted', async () => {
  const { result } = await withFetch(
    () => json({ content: [{ type: 'text', text: GOOD_JSON }], stop_reason: 'end_turn' }),
    () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k'))

  assert.equal(result.summary, 'A letter.')
})

test('a Gemini display name is rejected with a Gemini example', async () => {
  await assert.rejects(
    () => analyzeImage(IMAGE, PROMPT, 'Gemini 2.5 Flash', 'k'),
    err => /not a valid gemini model ID/i.test(err.message) &&
      /gemini-2\.5-flash/.test(err.message))
})

test('unrecognized models are refused as unsupported, not as badly formatted', async () => {
  // Local OpenAI-compatible models legitimately use names like `LLaVA` or
  // `hf.co/Org/Model-GGUF`. They must not be rejected for containing uppercase
  // — they are refused because this release has not tested that path.
  for (const model of ['LLaVA', 'hf.co/Org/Model-GGUF', 'llama3.2-vision']) {
    await assert.rejects(
      () => analyzeImage(IMAGE, PROMPT, model, 'k'),
      err => /not supported in this release/.test(err.message) &&
        !/display name/.test(err.message),
      `${model} should be refused as unsupported, not misformatted`)
  }
})

test('a missing model names the setting to change', async () => {
  await assert.rejects(
    () => analyzeImage(IMAGE, PROMPT, '', 'k'),
    /Preferences → Plugins → Autropy/)
})

// ── media types ────────────────────────────────────────────────────────────

test('an unsupported image format is refused before any request', async () => {
  // Archival collections are full of TIFFs, which no current vision API accepts.
  const { calls } = await withFetch(
    () => { throw new Error('must not call the API') },
    () => assert.rejects(
      () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k', { mediaType: 'image/tiff' }),
      err => /image\/tiff/.test(err.message) && /image\/jpeg/.test(err.message)))

  assert.equal(calls.length, 0)
})

test('the photo\'s real media type reaches the provider', async () => {
  // Previously hardcoded to image/jpeg for every photo, including PNGs.
  const { calls } = await withFetch(
    () => json({ content: [{ type: 'text', text: GOOD_JSON }] }),
    () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k', { mediaType: 'image/png' }))

  assert.equal(calls[0].body.messages[0].content[0].source.media_type, 'image/png')
})

test('media type defaults to JPEG when Tropy reports none', async () => {
  const { calls } = await withFetch(
    () => json({ content: [{ type: 'text', text: GOOD_JSON }] }),
    () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k', { mediaType: undefined }))

  assert.equal(calls[0].body.messages[0].content[0].source.media_type, 'image/jpeg')
})

test('every supported type is actually accepted', async () => {
  for (const mediaType of SUPPORTED_MEDIA_TYPES) {
    const { result } = await withFetch(
      () => json({ content: [{ type: 'text', text: GOOD_JSON }] }),
      () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k', { mediaType }))

    assert.equal(result.summary, 'A letter.', `${mediaType} should be usable`)
  }
})

// ── truncation and refusal ─────────────────────────────────────────────────

test('a truncated Claude response is reported as a token limit, not a parse error', async () => {
  // On current Claude models max_tokens covers reasoning as well as output, so
  // a low budget yields an empty or clipped answer. Saying "invalid JSON" here
  // would send the researcher after a phantom bug.
  await assert.rejects(
    () => withFetch(
      () => json({ content: [{ type: 'text', text: '{"summ' }], stop_reason: 'max_tokens' }),
      () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k')),
    err => /token limit/.test(err.message) && !/JSON/.test(err.message))
})

test('a refusal is reported as a refusal', async () => {
  await assert.rejects(
    () => withFetch(
      () => json({ stop_reason: 'refusal', content: [] }),
      () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k')),
    /declined to analyze/)
})

test('a truncated OpenAI response is reported the same way', async () => {
  await assert.rejects(
    () => withFetch(
      () => json({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }),
      () => analyzeImage(IMAGE, PROMPT, 'gpt-4o', 'k')),
    /token limit/)
})

test('a truncated Gemini response is reported the same way', async () => {
  await assert.rejects(
    () => withFetch(
      () => json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{' }] } }] }),
      () => analyzeImage(IMAGE, PROMPT, 'gemini-2.5-flash', 'k')),
    /token limit/)
})

test('an API error surfaces the provider status', async () => {
  await assert.rejects(
    () => withFetch(
      () => json({ error: { message: 'bad key' } }, 401),
      () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k')),
    /Anthropic API error 401/)
})

// ── cancellation ───────────────────────────────────────────────────────────

test('the abort signal is handed to the provider request', async () => {
  // This is what lets navigating away cancel an in-flight, billed analysis.
  const controller = new AbortController()

  const { calls } = await withFetch(
    () => json({ content: [{ type: 'text', text: GOOD_JSON }] }),
    () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k', { signal: controller.signal }))

  assert.equal(calls[0].init.signal, controller.signal)
})

// ── output validation reaches the caller ───────────────────────────────────

test('malformed model output is rejected rather than handed to the panel', async () => {
  await assert.rejects(
    () => withFetch(
      () => json({ content: [{ type: 'text', text: '{"document_type":"letter"}' }] }),
      () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k')),
    /no "summary" field/)
})

test('JSON wrapped in markdown fences is still read', async () => {
  const { result } = await withFetch(
    () => json({ content: [{ type: 'text', text: '```json\n' + GOOD_JSON + '\n```' }] }),
    () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k'))

  assert.equal(result.summary, 'A letter.')
})
