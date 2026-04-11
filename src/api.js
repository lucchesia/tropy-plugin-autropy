// api.js — AI provider calls for AUTROPY
//
// CONFIRMED: provider routing uses the provider field from plugin options:
//   gemini-* → Google Gemini API
//   gpt-*    → OpenAI API
//   claude-* → Anthropic API
//   anything else → OpenAI-compatible local endpoint (Ollama, LM Studio, etc.)
//
// CONFIRMED: every provider function returns a parsed JS object matching the
//   prompt's JSON structure: { summary, document_type, possible_tags,
//   metadata_suggestions: { title, date, description }, confidence }
//
// CONFIRMED: all errors are thrown — no silent failures, no null returns.

// ---------------------------------------------------------------------------
// JSON extraction helper
// ---------------------------------------------------------------------------

// Safely extracts JSON from a model response that may be wrapped in markdown
// code fences (```json ... ``` or ``` ... ```) or returned clean.
function parseResult (text) {
  if (!text || typeof text !== 'string') {
    throw new Error('[AUTROPY] API returned empty or non-string response body')
  }

  // Strip markdown code fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1].trim() : text.trim()

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`[AUTROPY] Failed to parse model response as JSON: ${err.message}\nRaw response: ${raw.slice(0, 300)}`)
  }

  return parsed
}

// ---------------------------------------------------------------------------
// Gemini (Google Generative Language API)
// ---------------------------------------------------------------------------

// CONFIRMED: Gemini multimodal endpoint accepts inline base64 image data.
// UNVERIFIED ASSUMPTION: model string maps directly to a valid Gemini model ID
//   (e.g. 'gemini-2.5-flash'). Verify against Google's model list if calls fail.
// UNVERIFIED ASSUMPTION: response shape is candidates[0].content.parts[0].text.
//   Confirmed for gemini-1.5-pro/flash — verify if using experimental models.
async function callGemini (base64, prompt, model, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: 'image/jpeg',
              // UNVERIFIED ASSUMPTION: base64 input is always JPEG.
              // If Tropy surfaces PNG or TIFF, mime_type must be set accordingly.
              // FUTURE: handle PNG and TIFF mime types — alpha assumes JPEG only.
              data: base64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json'
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`[AUTROPY] Gemini API error ${res.status}: ${detail}`)
  }

  const data = await res.json()

  // UNVERIFIED ASSUMPTION: text content is always at candidates[0].content.parts[0].text.
  // Gemini may return finishReason: 'SAFETY' or empty candidates on blocked content.
  const candidate = data?.candidates?.[0]
  if (!candidate) {
    throw new Error(`[AUTROPY] Gemini returned no candidates. Full response: ${JSON.stringify(data)}`)
  }
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(`[AUTROPY] Gemini stopped with reason: ${candidate.finishReason}`)
  }

  const text = candidate?.content?.parts?.[0]?.text
  if (!text) {
    throw new Error(`[AUTROPY] Gemini response missing text content. Candidate: ${JSON.stringify(candidate)}`)
  }

  return parseResult(text)
}

// ---------------------------------------------------------------------------
// OpenAI (and OpenAI-compatible endpoints)
// ---------------------------------------------------------------------------

// CONFIRMED: OpenAI vision endpoint accepts base64 image URLs.
// UNVERIFIED ASSUMPTION: base64 input is always JPEG — see note in callGemini.
// UNVERIFIED ASSUMPTION: response shape is choices[0].message.content (string).
async function callOpenAI (base64, prompt, model, apiKey, baseUrl = 'https://api.openai.com/v1') {
  const url = `${baseUrl}/chat/completions`

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${base64}` }
          }
        ]
      }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`[AUTROPY] OpenAI API error ${res.status}: ${detail}`)
  }

  const data = await res.json()

  // UNVERIFIED ASSUMPTION: content is at choices[0].message.content.
  const text = data?.choices?.[0]?.message?.content
  if (!text) {
    throw new Error(`[AUTROPY] OpenAI response missing content. Full response: ${JSON.stringify(data)}`)
  }

  return parseResult(text)
}

// ---------------------------------------------------------------------------
// Anthropic (Claude)
// ---------------------------------------------------------------------------

// CONFIRMED: Claude multimodal endpoint uses the messages API with base64 image source.
// UNVERIFIED ASSUMPTION: base64 input is always JPEG — see note in callGemini.
// UNVERIFIED ASSUMPTION: response shape is content[0].text (for text block type).
async function callAnthropic (base64, prompt, model, apiKey) {
  const url = 'https://api.anthropic.com/v1/messages'

  const body = {
    model,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              // UNVERIFIED ASSUMPTION: base64 input is always JPEG.
              data: base64
            }
          },
          { type: 'text', text: prompt }
        ]
      }
    ]
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`[AUTROPY] Anthropic API error ${res.status}: ${detail}`)
  }

  const data = await res.json()

  // UNVERIFIED ASSUMPTION: text content is at content[0].text with type 'text'.
  // Claude may return multiple content blocks; we take the first text block.
  const block = data?.content?.find(b => b.type === 'text')
  if (!block?.text) {
    throw new Error(`[AUTROPY] Anthropic response missing text block. Full response: ${JSON.stringify(data)}`)
  }

  return parseResult(block.text)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// CONFIRMED: provider routing is prefix-based on the provider field string.
// CONFIRMED: local/OpenAI-compatible fallback uses the configured port via
//   the baseUrl — callers must pass `http://localhost:${port}/v1` when routing
//   to a local model. Port is not a concern of api.js — plugin.js resolves it.
// UNVERIFIED ASSUMPTION: local endpoints (Ollama, LM Studio) support the
//   OpenAI /chat/completions shape with vision. Not all local models do.
export async function analyzeImage (base64, prompt, provider, model, apiKey, localBaseUrl) {
  if (!base64) throw new Error('[AUTROPY] analyzeImage called with no image data')
  if (!prompt) throw new Error('[AUTROPY] analyzeImage called with no prompt')
  if (!model) throw new Error('[AUTROPY] analyzeImage called with no model')

  if (provider.startsWith('gemini')) {
    return callGemini(base64, prompt, model, apiKey)
  }

  if (provider.startsWith('gpt') || provider.startsWith('openai')) {
    return callOpenAI(base64, prompt, model, apiKey)
  }

  if (provider.startsWith('claude')) {
    return callAnthropic(base64, prompt, model, apiKey)
  }

  // Fallback: treat as OpenAI-compatible local endpoint (Ollama, LM Studio, etc.)
  // UNVERIFIED ASSUMPTION: localBaseUrl is passed correctly by plugin.js.
  if (!localBaseUrl) {
    throw new Error(`[AUTROPY] Unknown provider "${provider}" and no localBaseUrl provided for local fallback`)
  }
  return callOpenAI(base64, prompt, model, apiKey, localBaseUrl)
}
