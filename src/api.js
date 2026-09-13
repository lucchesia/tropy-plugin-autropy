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

import { validateResult } from './result-schema.js'

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
  } catch (err) {
    throw new Error(
      `[AUTROPY] could not read the model's response as JSON: ${err.message}\n` +
      `Response began: ${raw.slice(0, 300)}`)
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

// `thinking` is deliberately omitted rather than disabled. On current Claude
// models adaptive thinking is the default, and explicitly disabling it is
// documented to make some models leak reasoning tags or describe a tool call in
// visible text instead of making it. Since the researcher can type any model ID
// here, the portable choice is to leave thinking alone and give `max_tokens`
// enough headroom — see MAX_TOKENS.
async function callAnthropic (prompt, model, apiKey, { image, signal }) {
  requireModelFormat(model, 'anthropic', 'claude-sonnet-5')

  const content = []
  if (image) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.base64 }
    })
  }
  content.push({ type: 'text', text: prompt })

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
      messages: [{ role: 'user', content }]
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

  const block = data?.content?.find(b => b.type === 'text')
  if (!block?.text) {
    throw new Error(`[AUTROPY] Claude returned no text block: ${JSON.stringify(data)}`)
  }

  return { text: block.text, servedModel: data?.model || model }
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

  const opts = { image: payload, signal, baseUrl }

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
