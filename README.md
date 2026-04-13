# AUTROPY
### AI-assisted multimodal analysis for Tropy

AUTROPY is a [Tropy](https://tropy.org) plugin that uses multimodal AI to help researchers analyze archival photographs and documents. It suggests image descriptions, tags, and metadata — but writes nothing to your project until you explicitly review and accept each suggestion.

Developed by [Anita Lucchesi](https://github.com/lucchesia) with Claude Code (Anthropic), 2026.

---

## What it does

When you are viewing an item in Tropy, clicking the AUTROPY icon in the toolbar sends the active photograph to an AI model of your choice. The analysis results appear in a review panel directly below the image — so you are always looking at the photograph while evaluating the suggestions.

From the review panel you can:

- Read and edit the AI-generated image description before accepting it
- Accept or reject each suggested tag individually — existing project tags are visually distinguished from new ones
- Accept or reject suggested metadata field values (optional, see settings)
- Press **Apply accepted** to write only what you approved to Tropy
- Press **Dismiss** to discard everything without any writes

Nothing is written to your project until you press **Apply accepted**.

---

## Human in the loop — by design

AUTROPY is built around a firm principle: **the system proposes, the researcher decides.**

Every suggestion is provisional. The AI may be wrong. Archival work requires source criticism, and that applies to machine-generated descriptions just as it does to any other secondary source. AUTROPY is designed to reduce repetitive manual work — not to replace curatorial judgment.

All notes written by AUTROPY carry a machine-readable provenance footer so you can always tell which notes are human-written and which are AI-generated, and with which model.

---

## Installation

AUTROPY is currently in active development (v0.1.0-alpha.1) and not yet available as a packaged release. To try it, build from source — see below.

If you are a Tropy developer or tester evaluating the plugin, please contact the author directly.

---

## Building from source

```bash
git clone https://github.com/lucchesia/tropy-plugin-autropy
cd tropy-plugin-autropy
npm install
npm run build
```

To install, package the built plugin and install via Tropy Preferences → Plugins:

```bash
cd ..
zip -r tropy-plugin-autropy.zip tropy-plugin-autropy \
  --exclude "tropy-plugin-autropy/.git*" \
  --exclude "tropy-plugin-autropy/node_modules/*"
```

Then: **Preferences → Plugins → Install Plugin** → select the zip → restart Tropy completely (Cmd+Q).

**For development and testing**, you can symlink the plugin directory instead of repackaging on every change:

```bash
ln -s "$(pwd)" "$HOME/Library/Application Support/Tropy Beta/plugins/tropy-plugin-autropy"
```

Then reload Tropy and enable the plugin in Preferences → Plugins.

---

## Configuration

AUTROPY supports multiple simultaneous instances — one per AI provider or model. Each instance has its own API key and settings. Add instances with the **⊕** button in Preferences → Plugins.

| Field | Description | Default |
|---|---|---|
| **Model ID** | API model identifier, e.g. `gemini-2.5-flash`, `gpt-4o`, `claude-sonnet-4-6` — also recorded in provenance notes | _(required)_ |
| **API Key** | Your API key for the selected provider | _(required)_ |
| **Tropy API Port** | Port the Tropy local REST API listens on | `2029` |
| **Suggest Metadata** | When enabled, AUTROPY reads existing item metadata and suggests values for empty or incomplete fields | `false` |
| **Custom Prompt** | Optional. Leave blank to use the default prompt (see below). Paste your own to customize what the AI focuses on | _(blank)_ |
| **Output Language** | Language for AI prose output — e.g. `Portuguese`, `French`. Leave blank to let the model choose based on document content. JSON keys and tags are always in English regardless of this setting. | _(blank = auto)_ |

---

## Supported models

| Provider | Example Model ID | Notes |
|---|---|---|
| Google Gemini | `gemini-2.5-flash` | Fast and cost-effective for image analysis |
| Google Gemini | `gemini-2.5-pro` | Higher quality, slower |
| OpenAI | `gpt-4o` | Strong general-purpose multimodal model |
| Anthropic | `claude-sonnet-4-6` | Good for nuanced historical description |

You can use any model string supported by the provider's API — enter it directly in the Model ID field. The provider is auto-detected from the prefix: `gemini-` → Google, `gpt-` / `o1-` / `o3-` / `o4-` → OpenAI, `claude-` → Anthropic. Any other prefix is treated as an OpenAI-compatible local endpoint (e.g. [Ollama](https://ollama.com) with a vision-capable model).

---

## Default Analysis Prompt

When the Custom Prompt field is left blank, AUTROPY sends the following prompt to the model. It is shown here in full so you know exactly what the AI is being asked, and so you have a starting point if you want to write your own.

```
You are a highly specialized historian and archival researcher analyzing a
photographic reproduction of an archival item.

Analytical approach:
- Use the image to describe both visual and physical features: document type,
  layout, handwriting, seals, stamps, paper condition, watermarks, overlays,
  folds, or any signs of authenticity and provenance.
- A single image may contain multiple overlapping documents or layers. Focus
  your analysis on the primary or topmost document. Mention secondary layers
  only when clearly visible and directly relevant.
- If a transcription is available in the Tropy item, treat it as the primary
  source for textual content. Use the image to complement and contextualize —
  not to replace — what the transcription already captures.
- If no transcription is available, analyze the visible text directly.
  Explicitly state when handwriting, language, image quality, or partial
  visibility limits your reading. Do not guess or fabricate text.
- Identify the language(s) in use across the document whenever determinable.
- Be transparent about uncertainty. A cautious and honest description is more
  valuable than a confident but incorrect one.

Your response must be valid JSON only — no preamble, no markdown, no
explanation outside the JSON block:

{
  "summary": "<3-6 sentences of scholarly prose integrating visual and textual
    analysis. Identify document type, purpose, people, places, dates, and
    institutions when visible. State explicitly if a transcription was used
    or if only partial text could be interpreted from the image.>",
  "document_type": "<one of: photograph | manuscript | letter |
    administrative_document | press_clipping | postcard | map | drawing |
    printed_book | object | unknown>",
  "possible_tags": ["<lowercase singular English tags — prefer existing
    project tags when appropriate>"],
  "metadata_suggestions": {
    "title": "<suggested title if absent or clearly improvable, otherwise null>",
    "date": "<date or date range if determinable from visual or textual
      evidence, otherwise null>",
    "description": "<a concise archival description suitable for the metadata
      field, otherwise null>"
  },
  "confidence": <0.0–1.0 reflecting your overall confidence given image
    quality, legibility, and available evidence>
}
```

To write your own prompt, paste it into the Custom Prompt field in plugin settings. Your prompt replaces the default analysis instructions. The JSON output format is automatically appended — you do not need to include it, and you should not try to override it.

---

## Provenance and auditability

Every note written by AUTROPY ends with a machine-readable provenance line:

```
---
[AUTROPY] model: gemini-2.5-flash | 2026-04-11T10:32:00Z | v0.1.0-alpha.1
```

This allows you to:
- Distinguish AI-generated notes from human-written ones at a glance
- Know exactly which model version produced a given analysis
- Audit machine contributions to your project chronologically
- Filter or search for AUTROPY notes programmatically using the `[AUTROPY]` marker

The provenance line is appended regardless of whether you edit the summary before applying — it records what the model produced and when, not what you accepted.

---

## Privacy and data governance

AUTROPY sends photograph data to external AI APIs. **Do not use external providers to process sensitive documents, unpublished archival materials under access restrictions, or copyright-protected images** unless you have explicit authorization to do so. When in doubt, consult your institution's data governance policies and any agreements with the collections you are working with.

If your research requires full local processing — no data leaving your machine — AUTROPY supports local AI models that expose an OpenAI-compatible API endpoint (such as [Ollama](https://ollama.com) with a vision-capable model). Configure the Model ID field with your local model's identifier. This is the recommended approach for sensitive collections.

Image data is sent only when you click the AUTROPY toolbar icon on a specific photo. Nothing is sent automatically or in the background.

---

## Contributing

AUTROPY is in active early development. Issues and pull requests are welcome.

If you are a Tropy user or developer with feedback on the plugin API, UX, or integration approach, please open an issue — this plugin is intended to be a constructive contribution to the Tropy ecosystem and we welcome dialogue with the Tropy team.

---

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE).

Copyright © 2026 Anita Lucchesi.
