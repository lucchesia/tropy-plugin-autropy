// prompt.js — default prompt constant and prompt assembly logic
//
// CONFIRMED: when a custom prompt is provided, it replaces the analytical
//   instructions but the JSON output format block is ALWAYS appended.
//   Without the format block, the model returns prose and JSON.parse fails.
//
// CONFIRMED: the default prompt below supersedes the Streamlit-phase scholarly.txt.
//   Updated to a stronger scholarly instruction set with a revised JSON output structure.
//   Source: autropy_default_prompt.txt provided by Anita Lucchesi, 2026-04-11.

// The item-level synthesis is at the bottom of this file: a second pass that
// reads the per-page summaries a researcher has reviewed and proposes one
// description for the whole item.

// ---------------------------------------------------------------------------
// Analysis instructions — what the model should do (replaceable by custom prompt)
// ---------------------------------------------------------------------------

const ANALYSIS_INSTRUCTIONS = `You are a highly specialized historian and archival researcher analyzing a photographic reproduction of an archival item.

**Analytical approach:**
- Use the image to describe both visual and physical features: document type, layout, handwriting, seals, stamps, paper condition, watermarks, overlays, folds, or any signs of authenticity and provenance.
- A single image may contain multiple overlapping documents or layers. Focus your analysis on the primary or topmost document. Mention secondary layers only when clearly visible and directly relevant.
- If a transcription is available in the Tropy item, treat it as the primary source for textual content. Use the image to complement and contextualize — not to replace — what the transcription already captures.
- If no transcription is available, analyze the visible text directly. Explicitly state when handwriting, language, image quality, or partial visibility limits your reading. Do not guess or fabricate text.
- Identify the language(s) in use across the document whenever determinable.
- Be transparent about uncertainty. A cautious and honest description is more valuable than a confident but incorrect one.`

// ---------------------------------------------------------------------------
// JSON output format block — ALWAYS appended, even when using a custom prompt.
// Without this block the model returns prose and JSON.parse fails silently.
// ---------------------------------------------------------------------------

const JSON_FORMAT_BLOCK = `**Your response must be valid JSON only — no preamble, no markdown, no explanation outside the JSON block:**

{
  "summary": "<3-6 sentences of scholarly prose integrating visual and textual analysis. Identify document type, purpose, people, places, dates, and institutions when visible. State explicitly if a transcription was used (e.g. 'Based on the available transcription...') or if only partial text could be interpreted from the image.>",
  "document_type": "<one of: photograph | manuscript | letter | administrative_document | press_clipping | postcard | map | drawing | printed_book | object | unknown>",
  "possible_tags": ["<lowercase singular English tags — prefer existing project tags when appropriate>"],
  "metadata_suggestions": {
    "title": "<suggested title if the current one is absent or clearly improvable, otherwise null>",
    "date": "<date or date range if determinable from visual or textual evidence, otherwise null>",
    "description": "<a concise archival description suitable for the metadata field, otherwise null>"
  },
  "confidence": <0.0–1.0 reflecting your overall confidence given image quality, legibility, and available evidence>
}`

// The full default prompt — both sections combined.
export const DEFAULT_PROMPT = `${ANALYSIS_INSTRUCTIONS}\n\n${JSON_FORMAT_BLOCK}`

// ---------------------------------------------------------------------------
// buildPrompt(userPrompt, existingTags, itemMetadata, outputLanguage)
//
// CONFIRMED: custom prompt replaces ANALYSIS_INSTRUCTIONS only.
//   JSON_FORMAT_BLOCK is always appended — it is not part of "the prompt" that
//   the user customizes. Without it the model returns prose and JSON.parse fails.
//
// CONFIRMED: tags hint appended to default path only (not to custom prompts).
// CONFIRMED: itemMetadata hint appended to default path only.
//
// outputLanguage: if set, appends a language instruction for prose output.
//   JSON keys and field names always remain in English regardless of this setting.
// ---------------------------------------------------------------------------
// transcription: the photo's existing transcription text, or null.
//
//   Appended on BOTH the default and custom-prompt paths, unlike the tag and
//   metadata hints. It is source material, not prompt tuning: the default
//   instructions already say "if a transcription is available, treat it as the
//   primary source for textual content", and for months nothing supplied one —
//   so every analysis of a transcribed page opened by announcing that no
//   transcription was available and read the handwriting from the image instead.
// Accepts either { text, source } from the gateway, or a bare string — in which
// case the origin is treated as unrecorded, because it is.
function normalizeTranscription (transcription) {
  if (!transcription) return null

  const text = typeof transcription === 'string'
    ? transcription.trim()
    : String(transcription.text ?? '').trim()

  if (!text) return null

  const source = (typeof transcription === 'object' && transcription.source === 'job')
    ? 'job'
    : 'unknown'

  return { text, source }
}

// The rolling window of preceding page summaries.
//
// A dossier is not a pile of unrelated images: page four is often the second
// half of a letter begun on page three. Without this the model reads every page
// cold and the item summary has to reconstruct continuity that was there all
// along.
//
// It is capped rather than cumulative. An unbounded window would make the last
// page of a 111-photo item carry the whole item in its prompt — paid for on
// every page, and dominated by material the page itself has nothing to do with.
// Capping it also bounds how far one bad reading can travel forward.
export const CONTEXT_WINDOW = 3

export function buildContextBlock (context) {
  if (!Array.isArray(context) || context.length === 0) return ''

  const lines = context
    .slice(-CONTEXT_WINDOW)
    .map(c => `  [page ${c.page}] ${String(c.text).trim()}`)
    .join('\n')

  if (!lines) return ''

  return '\n\nPRECEDING PAGES OF THIS SAME ITEM (Autropy\'s own summaries of the ' +
    'pages just before this one, given so you can follow a document that ' +
    'continues across pages. They are machine readings, not transcriptions, and ' +
    'may be wrong — describe THIS page, and use them only to place it):\n' +
    lines
}

export function buildPrompt (
  userPrompt, existingTags, itemMetadata, outputLanguage, transcription = null,
  context = null
) {
  let instructionBlock

  if (userPrompt && userPrompt.trim().length > 0) {
    // Custom prompt replaces the analytical instructions.
    // The user is responsible for their own instructions;
    // we do NOT append tags or metadata hints here.
    instructionBlock = userPrompt.trim()
  } else {
    instructionBlock = ANALYSIS_INSTRUCTIONS

    // Append existing project tags as a grounding hint so the model prefers
    // terms already in use over inventing new synonyms.
    if (Array.isArray(existingTags) && existingTags.length > 0) {
      const tagList = existingTags.map(t => `"${t}"`).join(', ')
      instructionBlock += `\n\nEXISTING PROJECT TAGS (prefer these where applicable): ${tagList}`
    }

    // Append current item metadata so the model knows which fields are already
    // filled and which are empty — avoids redundant suggestions on populated fields.
    if (itemMetadata && typeof itemMetadata === 'object') {
      const lines = Object.entries(itemMetadata)
        .map(([field, value]) => {
          const display = (value === null || value === undefined || value === '')
            ? '(empty)'
            : String(value)
          return `  ${field}: ${display}`
        })
        .join('\n')

      if (lines.length > 0) {
        instructionBlock += `\n\nCURRENT ITEM METADATA (already filled fields — do not duplicate; focus on empty ones):\n${lines}`
      }
    }
  }

  // The transcription goes in before the format block, on both paths.
  //
  // How it is described is a provenance claim, so it says only what Tropy
  // actually records. A transcription with ALTO data or a job id came from a
  // recognition engine and may contain recognition errors. Anything else
  // arrived some other way and Tropy records nothing about whose text it is —
  // calling that "machine-produced" would tell the model that a researcher's
  // own careful transcription is OCR output to be second-guessed.
  const t = normalizeTranscription(transcription)

  let transcriptionBlock = ''
  if (t) {
    const origin = t.source === 'job'
      ? 'produced by a text-recognition job in Tropy, so it may contain ' +
        'recognition errors'
      : 'recorded in Tropy alongside this image; its origin is not recorded, so ' +
        'do not assume it is machine output'

    transcriptionBlock =
      `\n\nTRANSCRIPTION OF THIS PAGE (${origin} — use it as the primary source ` +
      'for textual content, and say where the image contradicts it):\n' +
      `"""\n${t.text}\n"""`
  }

  // The preceding pages, so a document that runs across pages can be read as
  // one. This is what makes a page summary useful to the item summary built
  // from it — but it also means this page's reading is no longer independent of
  // the pages before it, and the model is told exactly what it is being given:
  // Autropy's own machine summaries, not transcriptions, and possibly wrong.
  const contextBlock = buildContextBlock(context)

  // JSON format block is always appended — required for parseResult() to succeed.
  let prompt =
    `${instructionBlock}${contextBlock}${transcriptionBlock}\n\n${JSON_FORMAT_BLOCK}`

  // Language instruction — appended last, after the format block, so the model
  // sees it as a final override. Keys and field names stay in English regardless.
  if (outputLanguage && outputLanguage.trim().length > 0) {
    prompt += `\n\nWrite all prose output (summary field, metadata suggestion values) in: ${outputLanguage.trim()}. JSON keys, field names, document_type values, and tag strings must remain in English.`
  }

  return prompt
}

// ---------------------------------------------------------------------------
// Item-level synthesis — the second pass over a multi-page item
//
// Text only: it reads the page summaries, not the images again. Re-sending six
// scans to ask a question about text already extracted from them would be paid
// for twice and answered no better.
//
// It is given the DRAFTS as the researcher left them. If page three was
// corrected by hand, the item description must be built from the correction —
// an item summary quietly derived from text its author already rejected would
// be the worst error this tool could make.
// ---------------------------------------------------------------------------

const SYNTHESIS_INSTRUCTIONS = `You are a historian and archival researcher writing a single catalogue-level description of ONE archival item, working from page-level descriptions of its photographs.

**Your task:**
- Read the page descriptions below as parts of one document or dossier, in order.
- Write one connected scholarly account of the item as a whole: what it is, what it concerns, who and what it names, and the span of dates it covers.
- Identify what carries across pages — a case, a correspondence, a file — rather than restating each page in turn.
- Where the pages disagree or one is uncertain, say so plainly instead of resolving it silently.
- Do not introduce facts that are not present in the page descriptions. You are not looking at the images.`

const SYNTHESIS_FORMAT_BLOCK = `**Your response must be valid JSON only — no preamble, no markdown, no explanation outside the JSON block:**

{
  "item_summary": "<4-8 sentences describing the item as a whole, as a catalogue entry would.>",
  "metadata_suggestions": {
    "title": "<a title for the whole item, otherwise null>",
    "date": "<the date or date range the item as a whole covers, otherwise null>",
    "description": "<a concise archival description of the whole item suitable for a metadata field, otherwise null>"
  },
  "confidence": <0.0-1.0 reflecting how well the page descriptions support a single account>
}`

// pages: [{ photoId, text }] in item order, already filtered to analyzed pages.
// incomplete: true when some pages failed or were never run, which the model is
//   told so it can qualify rather than imply completeness it does not have.
export function buildSynthesisPrompt (pages, {
  itemMetadata = null,
  outputLanguage = '',
  incomplete = false,
  total = null
} = {}) {
  let block = SYNTHESIS_INSTRUCTIONS

  if (incomplete && total != null) {
    block += `\n\nNOTE: only ${pages.length} of this item's ${total} pages could be analyzed. ` +
      'Describe what these pages show and state explicitly that the item is only ' +
      'partially covered.'
  }

  if (itemMetadata && typeof itemMetadata === 'object') {
    const lines = Object.entries(itemMetadata)
      .map(([field, value]) => {
        const display = (value === null || value === undefined || value === '')
          ? '(empty)'
          : String(value)
        return `  ${field}: ${display}`
      })
      .join('\n')

    if (lines.length > 0) {
      block += '\n\nCURRENT ITEM METADATA (already filled fields — do not duplicate; ' +
        `focus on empty ones):\n${lines}`
    }
  }

  const pageText = pages
    .map((p, i) => `--- PAGE ${i + 1} of ${pages.length} ---\n${p.text}`)
    .join('\n\n')

  let prompt = `${block}\n\nPAGE DESCRIPTIONS:\n\n${pageText}\n\n${SYNTHESIS_FORMAT_BLOCK}`

  if (outputLanguage && outputLanguage.trim().length > 0) {
    prompt += `\n\nWrite all prose output in: ${outputLanguage.trim()}. JSON keys and ` +
      'field names must remain in English.'
  }

  return prompt
}
