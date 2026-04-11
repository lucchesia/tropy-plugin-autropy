// prompt.js — default prompt constant and prompt assembly logic
//
// CONFIRMED: the custom prompt field (plugin options) replaces the default
//   entirely when non-empty — it does not append to it. (from build spec)
// CONFIRMED: the default prompt below supersedes the Streamlit-phase scholarly.txt.
//   Updated to a stronger scholarly instruction set with a revised JSON output structure.
//   Source: autropy_default_prompt.txt provided by Anita Lucchesi, 2026-04-11.

// FUTURE: A second-pass item-level synthesis prompt is planned — it would take
// all per-photo AUTROPY summaries for a multipage item and synthesize them into
// a single scholarly item summary with a suggested title. See the Jupyter notebook
// phase prompts for the original design. Not implemented in alpha.

export const DEFAULT_PROMPT = `You are a highly specialized historian and archival researcher analyzing a photographic reproduction of an archival item.

**Analytical approach:**
- Use the image to describe both visual and physical features: document type, layout, handwriting, seals, stamps, paper condition, watermarks, overlays, folds, or any signs of authenticity and provenance.
- A single image may contain multiple overlapping documents or layers. Focus your analysis on the primary or topmost document. Mention secondary layers only when clearly visible and directly relevant.
- If a transcription is available in the Tropy item, treat it as the primary source for textual content. Use the image to complement and contextualize — not to replace — what the transcription already captures.
- If no transcription is available, analyze the visible text directly. Explicitly state when handwriting, language, image quality, or partial visibility limits your reading. Do not guess or fabricate text.
- Identify the language(s) in use across the document whenever determinable.
- Be transparent about uncertainty. A cautious and honest description is more valuable than a confident but incorrect one.

**Your response must be valid JSON only — no preamble, no markdown, no explanation outside the JSON block:**

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

// CONFIRMED: custom prompt replaces default entirely — no merging.
// CONFIRMED: tags hint appended to ground the model in the project's vocabulary.
// UNVERIFIED ASSUMPTION: existingTags is an array of tag name strings.
//   Needs confirmation once tropy.js reads tags from the REST API.
// UNVERIFIED ASSUMPTION: itemMetadata is a plain object of field → value pairs
//   (e.g. { title: 'untitled', date: null, creator: 'Unknown' }).
//   Needs confirmation once tropy.js reads item metadata from the REST API.
export function buildPrompt (userPrompt, existingTags, itemMetadata) {
  // Use the user's custom prompt verbatim if one is provided
  if (userPrompt && userPrompt.trim().length > 0) {
    return userPrompt.trim()
  }

  let prompt = DEFAULT_PROMPT

  // Append existing project tags as a grounding hint so the model prefers
  // terms already in use over inventing new synonyms.
  if (Array.isArray(existingTags) && existingTags.length > 0) {
    const tagList = existingTags.map(t => `"${t}"`).join(', ')
    prompt += `\n\nEXISTING PROJECT TAGS (prefer these where applicable): ${tagList}`
  }

  // Append current item metadata so the model knows which fields are already
  // filled and which are empty — avoids redundant suggestions on populated fields.
  // UNVERIFIED ASSUMPTION: null/undefined/empty-string values mean the field is
  //   unfilled. Confirm against actual Tropy API response shape.
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
      prompt += `\n\nCURRENT ITEM METADATA (already filled fields — do not duplicate; focus on empty ones):\n${lines}`
    }
  }

  return prompt
}
