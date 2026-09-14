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

// Claude answers via a forced tool call, not free text — see api.js on why.
// `input` arrives already parsed; most tests only need a successful call, so
// this takes the same JSON-string shape the free-text providers use and
// parses it once here, rather than making every call site write out an object.
function claudeToolUse (jsonText, { stopReason = 'tool_use', name = 'submit_analysis' } = {}) {
  return {
    stop_reason: stopReason,
    content: [{ type: 'tool_use', name, input: JSON.parse(jsonText) }]
  }
}

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
    () => json(claudeToolUse(GOOD_JSON)),
    () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k'))

  assert.equal(result.summary, 'A letter.')
})

test('the request forces the one tool on offer, rather than naming it', async () => {
  // Only one tool exists, so `{ type: 'any' }` and naming it produce the same
  // outcome — the wider instruction is used because it has, at times, been
  // documented as more compatible with extended thinking than forcing one
  // specific named tool.
  const { calls } = await withFetch(
    () => json(claudeToolUse(GOOD_JSON)),
    () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k'))

  const body = calls[0].body
  assert.equal(body.tools.length, 1)
  assert.equal(body.tools[0].name, 'submit_analysis')
  assert.deepEqual(body.tool_choice, { type: 'any' })
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
    () => json(claudeToolUse(GOOD_JSON)),
    () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k', { mediaType: 'image/png' }))

  assert.equal(calls[0].body.messages[0].content[0].source.media_type, 'image/png')
})

test('media type defaults to JPEG when Tropy reports none', async () => {
  const { calls } = await withFetch(
    () => json(claudeToolUse(GOOD_JSON)),
    () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k', { mediaType: undefined }))

  assert.equal(calls[0].body.messages[0].content[0].source.media_type, 'image/jpeg')
})

test('every supported type is actually accepted', async () => {
  for (const mediaType of SUPPORTED_MEDIA_TYPES) {
    const { result } = await withFetch(
      () => json(claudeToolUse(GOOD_JSON)),
      () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k', { mediaType }))

    assert.equal(result.summary, 'A letter.', `${mediaType} should be usable`)
  }
})

// ── truncation and refusal ─────────────────────────────────────────────────

test('a truncated Claude response is reported as a token limit, not a parse error', async () => {
  // On current Claude models max_tokens covers reasoning as well as output, so
  // a low budget yields an empty or clipped answer. Saying "invalid JSON" here
  // would send the researcher after a phantom bug. A genuinely truncated tool
  // call may have no complete tool_use block at all — this is checked before
  // content is ever inspected, so an empty array is the honest shape to test.
  await assert.rejects(
    () => withFetch(
      () => json({ content: [], stop_reason: 'max_tokens' }),
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

test('an API error says what went wrong before quoting the provider', async () => {
  // A raw JSON body in a modal dialog is how a typo in the Model ID arrives as
  // forty lines of NOT_FOUND. The provider's own words are still there, just no
  // longer first.
  await assert.rejects(
    () => withFetch(
      () => json({ error: { message: 'bad key' } }, 401),
      () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k')),
    /the API key was refused by Anthropic.*Anthropic said: bad key/s)
})

test('a mistyped model id points at Preferences, not at the JSON', async () => {
  await assert.rejects(
    () => withFetch(
      () => json({ error: { message: 'models/gemini-2.5-flahs is not found' } }, 404),
      () => analyzeImage(IMAGE, PROMPT, 'gemini-2.5-flash', 'k')),
    /the Model ID was not recognized by Gemini.*Preferences/s)
})

test('a rate limit is named as one', async () => {
  await assert.rejects(
    () => withFetch(
      () => json({ error: { message: 'slow down' } }, 429),
      () => analyzeImage(IMAGE, PROMPT, 'gpt-4o', 'k')),
    /rate-limiting this key/)
})

// ── cancellation ───────────────────────────────────────────────────────────

test('the abort signal is handed to the provider request', async () => {
  // This is what lets navigating away cancel an in-flight, billed analysis.
  const controller = new AbortController()

  const { calls } = await withFetch(
    () => json(claudeToolUse(GOOD_JSON)),
    () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k', { signal: controller.signal }))

  assert.equal(calls[0].init.signal, controller.signal)
})

// ── output validation reaches the caller ───────────────────────────────────

test('a tool call missing a required field is rejected rather than handed to the panel', async () => {
  // Tool use guarantees the RESPONSE is syntactically valid JSON — it says
  // nothing about whether the content is complete. Semantic validation still
  // runs on whatever `input` the model actually filled in.
  await assert.rejects(
    () => withFetch(
      () => json(claudeToolUse('{"document_type":"letter"}')),
      () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k')),
    /no "summary" field/)
})

// ── free-text JSON parsing (Gemini, OpenAI) ─────────────────────────────────
//
// Claude no longer goes through any of this: a forced tool call means
// Anthropic hands back an already-parsed object, not text to re-parse — see
// the regression test below, "quote-dense source material no longer needs
// repairing on Claude". Gemini's responseMimeType and OpenAI's response_format
// both constrain output to syntactically valid JSON too, but — unlike tool
// use — that JSON still arrives as a TEXT field we parse ourselves, so
// parseResult's markdown-fence stripping and quote repair remain real,
// exercised code paths for these two providers.

test('an unescaped quote inside a string value is repaired, not rejected', async () => {
  // The signature failure on quote-dense source material: the model quotes a
  // phrase from the document with a literal " instead of escaping it or using
  // single quotes. This is the one case worth repairing rather than rejecting —
  // it is a structural ambiguity (was this " a delimiter or content?), not a
  // guess about what the model meant, and a real closing quote is always
  // followed by a JSON separator or the end of the response.
  const broken = '{"summary":"Mentions the firm "Lusitana" here.","document_type":"letter"}'

  const { result } = await withFetch(
    () => json({ choices: [{ message: { content: broken } }] }),
    () => analyzeImage(IMAGE, PROMPT, 'gpt-4o', 'k'))

  assert.equal(result.summary, 'Mentions the firm "Lusitana" here.')
  assert.equal(result.document_type, 'letter')
})

test('an already-escaped quote elsewhere in the response is left alone', async () => {
  // The repair must not re-escape what the model already escaped correctly —
  // only two fields deep, to make sure the walk survives leaving a string and
  // re-entering one.
  const text = '{"summary":"Fine.","document_type":"letter",' +
    '"metadata_suggestions":{"title":"Says \\"Lusitana\\" once"}}'

  const { result } = await withFetch(
    () => json({ choices: [{ message: { content: text } }] }),
    () => analyzeImage(IMAGE, PROMPT, 'gpt-4o', 'k'))

  assert.equal(result.metadata_suggestions.title, 'Says "Lusitana" once')
})

test('a structural error the quote repair cannot fix still fails honestly', async () => {
  // Not every malformed response is a misplaced quote. A missing comma is
  // repaired by nothing here, and the researcher should see the model's actual
  // text and the real parser error — not a message implying a fix was tried
  // and silently failed.
  const broken = '{"summary":"A letter." "document_type":"letter"}'

  await assert.rejects(
    () => withFetch(
      () => json({ choices: [{ message: { content: broken } }] }),
      () => analyzeImage(IMAGE, PROMPT, 'gpt-4o', 'k')),
    /could not read the model's response as JSON[\s\S]*Response began: \{"summary"/)
})

test('JSON wrapped in markdown fences is still read', async () => {
  const { result } = await withFetch(
    () => json({ choices: [{ message: { content: '```json\n' + GOOD_JSON + '\n```' } }] }),
    () => analyzeImage(IMAGE, PROMPT, 'gpt-4o', 'k'))

  assert.equal(result.summary, 'A letter.')
})

// ── the actual fix: Claude no longer produces text to parse at all ─────────

test('quote-dense source material no longer needs repairing on Claude', async () => {
  // This is the real failure, reproduced exactly: a literal " inside a
  // summary. Under tool use this is not a parsing hazard in the first place —
  // `input` arrives from Anthropic as an already-parsed value, so the quote is
  // just a character in a JS string, not a JSON token to get right. No repair
  // logic runs here; there is nothing for it to fix.
  const { result } = await withFetch(
    () => json(claudeToolUse(JSON.stringify({
      summary: 'Mentions the firm "Lusitana" and the salutation "Hochverehrter Herr Graf!".',
      document_type: 'letter'
    }))),
    () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k'))

  assert.equal(
    result.summary,
    'Mentions the firm "Lusitana" and the salutation "Hochverehrter Herr Graf!".')
})

test('the per-photo tool schema asks for a page summary, not an item one', async () => {
  // Which schema Claude is offered is chosen by the same `validate` function
  // parseResult already uses to pick a response shape. The synthesis half of
  // that choice is tested in models.test.mjs, where analyze() is already
  // called directly with an explicit validate function.
  const { calls } = await withFetch(
    () => json(claudeToolUse(GOOD_JSON)),
    () => analyzeImage(IMAGE, PROMPT, 'claude-sonnet-5', 'k'))

  const props = calls[0].body.tools[0].input_schema.properties
  assert.ok('summary' in props)
  assert.ok(!('item_summary' in props))
})
