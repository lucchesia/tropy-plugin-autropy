// api.js — AI provider calls for Autropy.
//
// Provider is auto-detected from the model ID prefix:
//   gemini-*          → Google Gemini
//   gpt-*, o1/o3/o4   → OpenAI
//   claude-*          → Anthropic
//   anything else     → OpenAI-compatible endpoint (requires baseUrl)
//
// Every provider function returns a result already validated by
// result-schema.js, so callers never see raw model output.

import { validateResult, validateSynthesis } from './result-schema.js'

// Formats every current vision model accepts. Notably excludes TIFF, which is
// common in archival collections — Release 2 will transcode via context.sharp.
export const SUPPORTED_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
]

const DEFAULT_MEDIA_TYPE = 'image/jpeg'

// Generous, because on current Claude and Gemini models `max_tokens` covers
// reasoning tokens as well as the visible answer. The JSON asked for here is
// under a thousand tokens; the headroom exists so reasoning cannot consume the
// whole budget and return an empty response. Billing is on tokens actually
// produced, so a high ceiling costs nothing when unused.
const MAX_TOKENS = 8192

// ---------------------------------------------------------------------------
// Model ID validation — per adapter, never global
// ---------------------------------------------------------------------------

// Deliberately NOT a blanket "no uppercase, no spaces" rule: OpenAI-compatible
// servers legitimately serve names like `LLaVA` or `hf.co/Org/Model-GGUF`, and
// rejecting those would break local models. Each provider validates its own
// naming, and the local fallback validates nothing.
const MODEL_PATTERNS = {
  anthropic: /^claude-[a-z0-9][a-z0-9.-]*$/,
  gemini: /^gemini-[a-z0-9][a-z0-9.-]*$/
}

// True when the provider has no naming rule to check against, which is the case
// for OpenAI-compatible endpoints by design — see MODEL_PATTERNS.
function hasValidModelFormat (model, provider) {
  const pattern = MODEL_PATTERNS[provider]
  return !pattern || pattern.test(model)
}

function requireModelFormat (model, provider, example) {
  if (hasValidModelFormat(model, provider)) return

  throw new Error(
    `[AUTROPY] "${model}" is not a valid ${provider} model ID. It looks like a ` +
    `display name — use the API identifier instead, for example "${example}". ` +
    'Set it in Preferences → Plugins → Autropy → Model ID.')
}

function requireSupportedMediaType (mediaType) {
  if (SUPPORTED_MEDIA_TYPES.includes(mediaType)) return mediaType

  throw new Error(
    `[AUTROPY] this photo is ${mediaType}, which AI providers do not accept. ` +
    `Supported formats: ${SUPPORTED_MEDIA_TYPES.join(', ')}.`)
}

// Provider errors, said in a sentence.
//
// The raw body is a JSON blob in a modal dialog, which is how a typo in the
// Model ID ("gemini-2.5-flahs") arrives as forty lines of NOT_FOUND. The body is
// still appended, because a message that hides the provider's own words is
// worse than an ugly one — it just no longer comes first.
async function providerError (provider, res) {
  const body = await res.text()

  let detail = ''
  try {
    detail = JSON.parse(body)?.error?.message || ''
  } catch {
    detail = ''
  }

  const lead = res.status === 404 || /not found|does not exist|unknown model/i.test(detail)
    ? 'the Model ID was not recognized by ' + provider +
      '. Check its spelling in Tropy > Preferences > Plugins > Autropy.'
    : res.status === 401 || res.status === 403
      ? 'the API key was refused by ' + provider +
        '. Check it in Tropy > Preferences > Plugins > Autropy.'
      : res.status === 429
        ? provider + ' is rate-limiting this key. Wait a moment and try again.'
        : `${provider} returned an error (HTTP ${res.status}).`

  return new Error(
    `[AUTROPY] ${lead}${detail ? `\n\n${provider} said: ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// Provider routing
// ---------------------------------------------------------------------------

// Which provider a model ID routes to, or null if none is recognized.
//
// Exported because the model picker needs it for a reason that is not cosmetic:
// there is exactly ONE apiKey option, so a list mixing Claude and GPT would send
// the Anthropic key to OpenAI as a bearer token. A credential must never leave
// for a host the researcher did not give it to.
export function providerFor (model) {
  const m = String(model || '').toLowerCase()

  if (m.startsWith('gemini')) return 'gemini'
  if (m.startsWith('claude')) return 'anthropic'
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') ||
      m.startsWith('o4') || m.startsWith('openai')) {
    return 'openai'
  }

  return null
}

// A model ID that is not an API identifier is worth catching before the request.
//
// "Claude Opus 5" routes to Anthropic on its prefix but is a display name — the
// exact mistake that broke this plugin once before. Reported at load, not as a
// failed request the researcher has already waited for.
export function describeModelProblem (model) {
  const name = String(model || '').trim()
  if (!name) return 'no Model ID is set in Preferences'

  const provider = providerFor(name)
  if (provider == null) {
    return `"${name}" is not a recognized hosted model ID — ` +
      'Autropy routes claude-*, gemini-* and gpt-*/o1/o3/o4 IDs'
  }

  if (!hasValidModelFormat(name, provider)) {
    return `"${name}" looks like a display name rather than an API identifier ` +
      '(for example claude-opus-5, not "Claude Opus 5")'
  }

  return null
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

// A second line of defence behind the prompt's quoting instruction (see
// prompt.js), for the case where the model does not follow it — which happens,
// especially when it is quoting from a transcription it has itself just
// described as corrupted, rather than composing prose of its own.
//
// This does not guess at content. It resolves a single structural ambiguity —
// whether a `"` the model wrote was meant to CLOSE a string or was a literal
// character inside one — using the same rule a person fixing this by eye would
// use: a real closing quote is followed by a JSON separator (`,` `}` `]` `:`)
// or the end of the response; anything else means the quote was content, so it
// is escaped in place.
//
// It cannot make this worse. A misjudged quote does not silently produce a
// plausible-but-wrong result — treating content as a delimiter desyncs the
// string/non-string tracking for everything after it, which almost always
// produces bare, unquoted tokens where JSON requires punctuation, and that
// fails to parse. So the only two outcomes are: the ambiguity resolves and the
// response parses, or it doesn't and parseResult falls through to the original,
// honest parse error against the model's actual, unmodified text.
function repairUnescapedQuotes (text) {
  let out = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (!inString) {
      out += ch
      if (ch === '"') inString = true
      continue
    }

    if (escaped) {
      out += ch
      escaped = false
      continue
    }

    if (ch === '\\') {
      out += ch
      escaped = true
      continue
    }

    if (ch === '"') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      const next = text[j]

      if (next === undefined || ',}]:'.includes(next)) {
        out += ch
        inString = false
      } else {
        out += '\\"'
      }
      continue
    }

    out += ch
  }

  return out
}

// Models sometimes wrap JSON in markdown fences even when asked not to.
//
// `validate` is a parameter because a second kind of call is coming: the
// item-level synthesis returns a different shape and must not be forced through
// the per-photo schema.
function parseResult (text, validate = validateResult) {
  if (!text || typeof text !== 'string') {
    throw new Error('[AUTROPY] the provider returned an empty response body')
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1].trim() : text.trim()

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (firstErr) {
    try {
      parsed = JSON.parse(repairUnescapedQuotes(raw))
    } catch {
      // The repair attempt's own error is not what the researcher needs — the
      // original error, against the model's actual text, is the honest one.
      throw new Error(
        `[AUTROPY] could not read the model's response as JSON: ${firstErr.message}\n` +
        `Response began: ${raw.slice(0, 300)}`)
    }
  }

  return validate(parsed)
}

// A truncated response is a budget problem, not a malformed-JSON problem.
// Saying so plainly avoids sending the researcher after a phantom parse bug.
function requireComplete (stopReason, provider) {
  const truncated = ['max_tokens', 'MAX_TOKENS', 'length']
  if (!truncated.includes(stopReason)) return

  throw new Error(
    `[AUTROPY] ${provider} stopped before finishing its response (it hit the ` +
    'token limit), so the analysis is incomplete. This usually means the model ' +
    'spent its budget reasoning. Try again, or use a different model.')
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

async function callGemini (prompt, model, apiKey, { image, signal }) {
  requireModelFormat(model, 'gemini', 'gemini-2.5-flash')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const parts = [{ text: prompt }]
  if (image) {
    parts.push({ inline_data: { mime_type: image.mediaType, data: image.base64 } })
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        maxOutputTokens: MAX_TOKENS
      }
    })
  })

  if (!res.ok) {
    throw await providerError('Gemini', res)
  }

  const data = await res.json()
  const candidate = data?.candidates?.[0]

  if (!candidate) {
    throw new Error(
      '[AUTROPY] Gemini returned no candidates — the request may have been ' +
      `blocked. Full response: ${JSON.stringify(data)}`)
  }

  requireComplete(candidate.finishReason, 'Gemini')

  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(`[AUTROPY] Gemini stopped with reason: ${candidate.finishReason}`)
  }

  const text = candidate?.content?.parts?.[0]?.text
  if (!text) {
    throw new Error(`[AUTROPY] Gemini returned no text content: ${JSON.stringify(candidate)}`)
  }

  return { text, servedModel: data?.modelVersion || model }
}

// ---------------------------------------------------------------------------
// OpenAI and OpenAI-compatible endpoints
// ---------------------------------------------------------------------------

async function callOpenAI (prompt, model, apiKey, { image, signal, baseUrl }) {
  const root = baseUrl || 'https://api.openai.com/v1'

  const content = [{ type: 'text', text: prompt }]
  if (image) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${image.mediaType};base64,${image.base64}` }
    })
  }

  const res = await fetch(`${root}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    signal,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      temperature: 0.2,
      max_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' }
    })
  })

  if (!res.ok) {
    throw await providerError('OpenAI', res)
  }

  const data = await res.json()
  const choice = data?.choices?.[0]

  requireComplete(choice?.finish_reason, 'the model')

  const text = choice?.message?.content
  if (!text) {
    throw new Error(`[AUTROPY] the provider returned no content: ${JSON.stringify(data)}`)
  }

  return { text, servedModel: data?.model || model }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

// Gemini is asked for `responseMimeType: 'application/json'` and OpenAI for
// `response_format: json_object` — both providers guarantee, at the API level,
// that what comes back is syntactically valid JSON. Anthropic's Messages API
// has no equivalent free-text mode. Without one, "valid JSON" depended on the
// model getting every escape right in the middle of free-text generation —
// including while quoting a phrase from a transcription it had itself called
// corrupted — and a prompt instruction asking it to (see prompt.js) measurably
// reduced but did not eliminate that.
//
// Tool use is Anthropic's equivalent guarantee. Forcing a single tool call
// moves responsibility for JSON-encoding the answer from the model's own token
// stream to Anthropic's own tool-call serialization — the API decides how to
// escape a literal `"` when it packages `content[].input`, not the model
// composing text a character at a time. `JSON.stringify(block.input)` below
// therefore cannot produce anything parseResult can choke on: it is
// synthesizing that JSON text itself, from an already-parsed value, not
// re-parsing text the provider sent.
const TOOL_NAME = 'submit_analysis'

const RESULT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    document_type: {
      type: 'string',
      enum: ['photograph', 'manuscript', 'letter', 'administrative_document',
        'press_clipping', 'postcard', 'map', 'drawing', 'printed_book',
        'object', 'unknown']
    },
    possible_tags: { type: 'array', items: { type: 'string' } },
    metadata_suggestions: {
      type: 'object',
      properties: {
        title: { type: ['string', 'null'] },
        date: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] }
      },
      required: ['title', 'date', 'description']
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: [
    'summary', 'document_type', 'possible_tags', 'metadata_suggestions', 'confidence'
  ]
}

const SYNTHESIS_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    item_summary: { type: 'string' },
    metadata_suggestions: {
      type: 'object',
      properties: {
        title: { type: ['string', 'null'] },
        date: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] }
      },
      required: ['title', 'date', 'description']
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: ['item_summary', 'metadata_suggestions', 'confidence']
}

// The escape hatch — and the reason it had to exist.
//
// `tool_choice: { type: 'any' }` guarantees a tool call. It does not guarantee
// that the call fits the schema: Anthropic checks that a tool by that name was
// offered and passes the arguments through, so a model that wants to say
// something the schema has no room for — a page it cannot read, a scruple about
// the content — says it anyway, under whatever key it invents. That is exactly
// what happened on page 2 of a two-page letter: a `submit_analysis` call whose
// only key was `constraint`, which arrived at validateResult as an analysis
// with no summary and was reported as the model misbehaving.
//
// It was not misbehaving. It was answering the only question it had been left
// any way to answer. A model given one legal move and something else to say
// will make an illegal move rather than stay silent. So there are two tools
// now: the analysis, and a way to say why there is no analysis. A
// `report_problem` call surfaces as the model's own sentence — a failure the
// researcher can read and act on — instead of a field-name puzzle.
const PROBLEM_TOOL = 'report_problem'

const PROBLEM_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'Why this page cannot be analyzed, in one or two sentences.'
    }
  },
  required: ['reason']
}

// `thinking` is deliberately omitted rather than disabled. On current Claude
// models adaptive thinking is the default, and explicitly disabling it is
// documented to make some models leak reasoning tags or describe a tool call in
// visible text instead of making it. Since the researcher can type any model ID
// here, the portable choice is to leave thinking alone and give `max_tokens`
// enough headroom — see MAX_TOKENS.
//
// `tool_choice: { type: 'any' }` rather than naming submit_analysis: there are
// two tools on offer and the choice between them is the point. Forcing the
// analysis tool by name would take the escape hatch away again, which is the
// condition that produced the `constraint` failure in the first place.
async function anthropicTurn (messages, model, apiKey, schema, signal) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      messages,
      tools: [{
        name: TOOL_NAME,
        description: 'Submit the structured analysis of this page.',
        input_schema: schema || RESULT_TOOL_SCHEMA
      }, {
        name: PROBLEM_TOOL,
        description:
          'Report that this page cannot be analyzed, and why. Use this rather ' +
          'than submitting an incomplete, invented, or off-schema analysis.',
        input_schema: PROBLEM_TOOL_SCHEMA
      }],
      tool_choice: { type: 'any' }
    })
  })

  if (!res.ok) {
    throw await providerError('Anthropic', res)
  }

  const data = await res.json()

  if (data?.stop_reason === 'refusal') {
    throw new Error(
      '[AUTROPY] Claude declined to analyze this image. If the document is ' +
      'sensitive, consider a local model instead.')
  }

  requireComplete(data?.stop_reason, 'Claude')

  const problem = data?.content?.find(b => b.type === 'tool_use' && b.name === PROBLEM_TOOL)
  if (problem) {
    const reason = String(problem.input?.reason ?? '').trim()
    throw new Error(
      '[AUTROPY] Claude could not analyze this page: ' +
      (reason || 'it gave no reason.'))
  }

  const block = data?.content?.find(b => b.type === 'tool_use' && b.name === TOOL_NAME)
  if (!block?.input) {
    throw new Error(
      '[AUTROPY] Claude did not answer through either tool it was offered ' +
      `(stop_reason: ${data?.stop_reason ?? 'none'}).`)
  }

  return { data, block }
}

async function callAnthropic (prompt, model, apiKey, { image, signal, schema, validate }) {
  requireModelFormat(model, 'anthropic', 'claude-sonnet-5')

  const content = []
  if (image) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.base64 }
    })
  }
  content.push({ type: 'text', text: prompt })

  const messages = [{ role: 'user', content }]

  // The second attempt is not a retry. It is the same conversation continued,
  // with the validator's own complaint handed back as the tool's result — which
  // is what tool use is for: a tool that rejects its arguments says why, and the
  // caller corrects itself. The model still has the image, the transcription and
  // its own previous answer in view, so it is correcting a specific mistake
  // rather than starting cold.
  //
  // It is not free: the whole conversation, image included, is re-sent and
  // re-billed. Two attempts, not more. A model that submits the wrong shape
  // twice with its mistake spelled out will not find it on the third try, and
  // the researcher would be paying for the guess.
  for (let attempt = 0; ; attempt++) {
    const { data, block } = await anthropicTurn(messages, model, apiKey, schema, signal)
    const servedModel = data?.model || model

    // Re-serialized rather than passed through as an object, so every caller —
    // and every existing test — keeps dealing in the same `{ text, servedModel }`
    // shape as Gemini and OpenAI. This round trip cannot reintroduce the quoting
    // bug it exists to avoid: `block.input` is already a parsed value, and
    // JSON.stringify of a parsed value is always valid, correctly escaped JSON.
    const text = JSON.stringify(block.input)

    if (typeof validate !== 'function') return { text, servedModel }

    try {
      validate(block.input)
      return { text, servedModel }
    } catch (err) {
      if (attempt > 0) {
        throw new Error(
          `${err.message}\nClaude was shown this and asked to correct it, and ` +
          `answered the same way again. What it sent: ${text.slice(0, 400)}`)
      }

      messages.push({ role: 'assistant', content: data.content })
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content:
            `${err.message}\n\nResubmit through ${TOOL_NAME} with every required ` +
            `field filled in. If this page genuinely cannot be analyzed, call ` +
            `${PROBLEM_TOOL} instead and say why.`
        }]
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// One call to a model, with or without an image.
//
//   model    — the provider's API identifier
//   prompt   — the fully assembled prompt
//   apiKey   — the single configured key; see providerFor on why one key
//              constrains which models may be offered
//   image    — { base64, mediaType }, or omitted for a text-only call such as
//              the item-level synthesis
//   signal   — AbortSignal, so navigating away cancels an in-flight analysis
//   validate — schema for the response; defaults to the per-photo one
//   baseUrl  — OpenAI-compatible endpoint for non-hosted models
//
// Returns { result, servedModel }. `servedModel` is what the provider says it
// actually ran, which can differ from what was asked for when the ID is an
// alias — and provenance should record what ran, not what was requested.
export async function analyze ({
  model, prompt, apiKey, image = null, signal, validate, baseUrl
} = {}) {
  if (!prompt) throw new Error('[AUTROPY] analyze called with no prompt')
  if (!model) {
    throw new Error(
      '[AUTROPY] no model configured. Set Model ID in Preferences → Plugins → Autropy.')
  }

  let payload = null
  if (image) {
    if (!image.base64) throw new Error('[AUTROPY] analyze called with an empty image')
    payload = {
      base64: image.base64,
      mediaType: requireSupportedMediaType(image.mediaType || DEFAULT_MEDIA_TYPE)
    }
  }

  // Only callAnthropic reads this — Gemini and OpenAI already constrain their
  // own output to valid JSON via responseMimeType / response_format and have
  // no schema parameter to pass it to. Chosen by identity against the same
  // `validate` function parseResult already uses to pick a response shape,
  // so this never has to be threaded through as a separate argument at every
  // call site — it is the same "which shape is this?" question, answered once.
  const schema = validate === validateSynthesis ? SYNTHESIS_TOOL_SCHEMA : RESULT_TOOL_SCHEMA

  // The validator goes to the provider too, not only to parseResult. Only
  // callAnthropic uses it, and for a different purpose: parseResult validates
  // to decide whether the analysis is usable, callAnthropic validates to decide
  // whether to hand the model back its own mistake and let it try again. The
  // default matches parseResult's, so the two never disagree about what a good
  // answer looks like.
  const opts = {
    image: payload, signal, baseUrl, schema, validate: validate || validateResult
  }

  let call
  switch (providerFor(model)) {
    case 'gemini': call = callGemini; break
    case 'anthropic': call = callAnthropic; break
    case 'openai': call = callOpenAI; break
    default:
      // Local / self-hosted OpenAI-compatible endpoint. Not supported in this
      // release: reaching an endpoint is only part of the problem — such servers
      // differ on JSON response_format, image data URLs and auth headers, so
      // claiming support without testing against a named target would be
      // dishonest.
      throw new Error(
        `[AUTROPY] "${model}" is not a recognized hosted model. Use an ID starting ` +
        'with gemini-, gpt-, o1/o3/o4, or claude-. Local OpenAI-compatible models ' +
        'are not supported in this release.')
  }

  const { text, servedModel } = await call(prompt, model, apiKey, opts)

  return { result: parseResult(text, validate), servedModel }
}

// Kept as the image-analysis shorthand. Returns the result alone.
export async function analyzeImage (base64, prompt, model, apiKey, options = {}) {
  if (!base64) throw new Error('[AUTROPY] analyzeImage called with no image data')

  const { result } = await analyze({
    model,
    prompt,
    apiKey,
    image: { base64, mediaType: options.mediaType },
    signal: options.signal,
    baseUrl: options.baseUrl
  })

  return result
}
