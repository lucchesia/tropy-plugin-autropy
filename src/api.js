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

function requireModelFormat (model, provider, example) {
  if (MODEL_PATTERNS[provider].test(model)) return

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

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

// Models sometimes wrap JSON in markdown fences even when asked not to.
function parseResult (text) {
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

  return validateResult(parsed)
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

async function callGemini (base64, prompt, model, apiKey, { mediaType, signal }) {
  requireModelFormat(model, 'gemini', 'gemini-2.5-flash')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mediaType, data: base64 } }
        ]
      }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        maxOutputTokens: MAX_TOKENS
      }
    })
  })

  if (!res.ok) {
    throw new Error(`[AUTROPY] Gemini API error ${res.status}: ${await res.text()}`)
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

  return parseResult(text)
}

// ---------------------------------------------------------------------------
// OpenAI and OpenAI-compatible endpoints
// ---------------------------------------------------------------------------

async function callOpenAI (base64, prompt, model, apiKey, { mediaType, signal, baseUrl }) {
  const root = baseUrl || 'https://api.openai.com/v1'

  const res = await fetch(`${root}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    signal,
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } }
        ]
      }],
      temperature: 0.2,
      max_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' }
    })
  })

  if (!res.ok) {
    throw new Error(`[AUTROPY] OpenAI API error ${res.status}: ${await res.text()}`)
  }

  const data = await res.json()
  const choice = data?.choices?.[0]

  requireComplete(choice?.finish_reason, 'the model')

  const text = choice?.message?.content
  if (!text) {
    throw new Error(`[AUTROPY] the provider returned no content: ${JSON.stringify(data)}`)
  }

  return parseResult(text)
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
async function callAnthropic (base64, prompt, model, apiKey, { mediaType, signal }) {
  requireModelFormat(model, 'anthropic', 'claude-sonnet-5')

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
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: prompt }
        ]
      }]
    })
  })

  if (!res.ok) {
    throw new Error(`[AUTROPY] Anthropic API error ${res.status}: ${await res.text()}`)
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

  return parseResult(block.text)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// options:
//   mediaType — the photo's real MIME type from Tropy (defaults to JPEG)
//   signal    — AbortSignal, so navigating away cancels an in-flight analysis
//   baseUrl   — OpenAI-compatible endpoint for non-hosted models
export async function analyzeImage (base64, prompt, model, apiKey, options = {}) {
  if (!base64) throw new Error('[AUTROPY] analyzeImage called with no image data')
  if (!prompt) throw new Error('[AUTROPY] analyzeImage called with no prompt')
  if (!model) {
    throw new Error(
      '[AUTROPY] no model configured. Set Model ID in Preferences → Plugins → Autropy.')
  }

  const mediaType = requireSupportedMediaType(options.mediaType || DEFAULT_MEDIA_TYPE)
  const opts = { ...options, mediaType }

  const m = model.toLowerCase()

  if (m.startsWith('gemini')) return callGemini(base64, prompt, model, apiKey, opts)
  if (m.startsWith('claude')) return callAnthropic(base64, prompt, model, apiKey, opts)

  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') ||
      m.startsWith('o4') || m.startsWith('openai')) {
    return callOpenAI(base64, prompt, model, apiKey, opts)
  }

  // Local / self-hosted OpenAI-compatible endpoint. Not supported in this
  // release: reaching an endpoint is only part of the problem — such servers
  // differ on JSON response_format, image data URLs and auth headers, so
  // claiming support without testing against a named target would be dishonest.
  throw new Error(
    `[AUTROPY] "${model}" is not a recognized hosted model. Use an ID starting ` +
    'with gemini-, gpt-, o1/o3/o4, or claude-. Local OpenAI-compatible models ' +
    'are not supported in this release.')
}
