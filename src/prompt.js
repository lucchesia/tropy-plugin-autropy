// prompt.js — default prompt constant and prompt assembly logic
//
// CONFIRMED: when a custom prompt is provided, it replaces the analytical
//   instructions but the JSON output format block is ALWAYS appended.
//   Without the format block, the model returns prose and JSON.parse fails.
//
// CONFIRMED: the default prompt below supersedes the Streamlit-phase scholarly.txt.
//   Updated to a stronger scholarly instruction set with a revised JSON output structure.
//   Source: autropy_default_prompt.txt provided by Anita Lucchesi, 2026-04-11.

// FUTURE: A second-pass item-level synthesis prompt is planned — it would take
// all per-photo AUTROPY summaries for a multipage item and synthesize them into
// a single scholarly item summary with a suggested title. See the Jupyter notebook
// phase prompts for the original design. Not implemented in alpha.

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
export function buildPrompt (userPrompt, existingTags, itemMetadata, outputLanguage) {
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

  // JSON format block is always appended — required for parseResult() to succeed.
  let prompt = `${instructionBlock}\n\n${JSON_FORMAT_BLOCK}`

  // Language instruction — appended last, after the format block, so the model
  // sees it as a final override. Keys and field names stay in English regardless.
  if (outputLanguage && outputLanguage.trim().length > 0) {
    prompt += `\n\nWrite all prose output (summary field, metadata suggestion values) in: ${outputLanguage.trim()}. JSON keys, field names, document_type values, and tag strings must remain in English.`
  }

  return prompt
}
