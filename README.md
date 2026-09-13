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

### Transcriptions

If a photo already has a transcription in Tropy, Autropy sends it with the image and tells the model
to use it as the primary source for the text, saying where the image contradicts it. The most recent
completed transcription is used; a recognition job that has not finished is skipped.

**How the transcription is described is itself a provenance claim**, so Autropy says only what Tropy
records. A transcription carrying ALTO data or a job id came from a text-recognition engine, and is
described as one — *"may contain recognition errors"*. Anything else reached Tropy another way and
Tropy stores nothing about whose text it is, so it is described as *"origin is not recorded; do not
assume it is machine output"*.

That distinction matters in both directions. Calling a researcher's own transcription machine output
invites the model to second-guess careful work — the same error as attributing a machine's value to
the researcher, pointed the other way.

Only the plain text is sent — never the ALTO XML, which is tens of kilobytes of coordinates per page
and would be billed as input tokens for nothing.

Adding or changing a transcription invalidates that page's cached analysis, so re-running picks it
up. The log says `with transcription` or `no transcription` per page.

### Multi-page items

When an item has more than one photo, Autropy asks before it spends anything:

> This item has 6 photos, and you are on photo 2.
> Analyzing all of them makes 5 new request(s) to the model; 1 page(s) were already
> analyzed with this model and prompt and will be reused without being billed again.
>
> **[Analyze all 6 photos] [Only this photo] [Cancel]**

Pages are analyzed **one at a time**, and the panel gains a pager — `◀ Page 3 of 6 ▶` — with a
running count. The first page to finish opens the panel, so you can start reading while the rest
run. Paging moves Tropy's own photo selection too, so you are always looking at the page you are
reviewing.

**Stop** appears while a run is in flight. It keeps every page already analyzed and makes no further
requests.

A page that fails does not end the run: it is marked failed in the pager, the others continue, and
the panel says how many did not work. Failed and unreached pages write nothing.

Each page keeps its own summary, editable independently, and **Apply accepted** writes one note per
page. Tags are pooled across the whole item and de-duplicated.

**Each page is read with the three pages before it in view.** A dossier is not a pile of unrelated
images — page four is often the second half of a letter begun on page three — so each page's prompt
carries Autropy's summaries of the pages just before it, described to the model as machine readings
that may be wrong. The cost of this is worth knowing: a page summary is no longer an independent
reading of that page, and the note it becomes says so. The window is capped at three so that one bad
reading cannot travel the length of a long item, and so a 111-page item does not end up carrying
itself in every prompt.

**Metadata is not suggested per page.** Tropy keeps one value per field, so six pages proposing six
descriptions would mean the last one silently wins. It comes from the item summary instead.
Single-photo items are unaffected and still suggest metadata as before.

### The item summary

**Item summary** is one description of the item as a whole, written from the page summaries. On a
multi-page item it is written in the same pass and is what the panel opens on; the pages sit behind
the pager. It is a text-only request — it reads the page descriptions, not the images again — and
the scope dialog counts it before anything is billed.

It is reviewed and written **exactly like a page summary**: edit the text, or empty the box to
decline it. There is no separate checkbox. An earlier version made it opt-in, which meant you could
generate an item summary, read it, press Apply, and have nothing written.

Tropy has no item-level note, so it attaches to the first analyzed page. Its first line says it
describes the whole item, and it carries a different glyph from a page note so the two are
distinguishable at a glance.

If you edit a page summary afterwards, the item summary is marked stale and neither its text nor its
metadata can be applied until you press **Generate again** — an item description quietly derived
from text you had already rejected would be the worst mistake this tool could make. Regenerating is
one more request, which is the honest price of having corrected the page.

It also offers **item metadata** — title, date and description for the whole item, accepted row by
row, with the same `replaces:` warning as anywhere else.

If some pages could not be analyzed, the model is told so and the summary says how many pages it
actually covers. If the item summary itself fails, the page summaries are kept and reviewable.

### Comparing models

The review panel has a model picker. Pick a model and press **Re-analyze** to read the same document
with a different one.

You do not configure the list. At startup Autropy asks your provider which models your API key can
actually reach and offers those, so the picker is current rather than a list baked into the plugin
that goes stale within months. Tropy's plugin preferences cannot render a dropdown of arbitrary
values — the only selects it offers are bound to Tropy's own ontology — so **Model ID** stays a text
field, and it is what decides which provider is asked.

A model you have already run on this item is marked *already run*: switching back to it is instant
and costs nothing, so you can hold two readings of the same page side by side.

Only your Model ID's own provider is ever contacted, and only models from that provider are offered.
There is one API key, and Autropy will not send an Anthropic key to OpenAI — the fetched list is
filtered by the same rule as anything you could have typed. Entries it refuses — wrong provider, or
a display name like `Claude Opus 5` instead of `claude-opus-5` — are named in the log with the
reason. If the list cannot be fetched at all (offline, or a key without permission to read it), the
picker simply offers your configured model, as before.

### When the model says nothing

A field the model returned nothing for is now shown greyed out with the reason, rather than simply
missing. Most often it reads *left alone — this item already has a value*: the prompt tells the model
not to duplicate metadata your item already holds, so a second run can legitimately suggest **less**
than the first. That is the prompt working, not a failure.

If a suggestion would overwrite something, the row says **replaces: <your current value>**. Tropy
keeps one value per field, so accepting it is a replacement — worth knowing before the click rather
than after.

### After you apply

Once something has been written, the panel becomes a **receipt** rather than a form. Re-opening it
shows what was written, when, and by which model — and offers only **Close** and **Re-analyze**.

That is deliberate. Notes are the one thing AUTROPY writes that cannot be written twice safely, and
an applied panel that still looked editable was how a second **Apply accepted** came to add a second
note for the same analysis.

**Re-analyze** asks the model again and starts a fresh review. It is a new analysis, so applying it
adds to what is already on the item rather than replacing it — the panel says so when that is the
case.

If a write's outcome is *uncertain* — the connection to Tropy dropped at the wrong moment, so it may
or may not have been saved — AUTROPY will not repeat it and will not offer to. It names what to
check instead. Every note carries the id of the run that wrote it, so searching your notes for
`run <id>` finds it.

---

## Human in the loop — by design

AUTROPY is built around a firm principle: **the system proposes, the researcher decides.**

Every suggestion is provisional. The AI may be wrong. Archival work requires source criticism, and that applies to machine-generated descriptions just as it does to any other secondary source. AUTROPY is designed to reduce repetitive manual work — not to replace curatorial judgment.

All notes written by AUTROPY carry a machine-readable provenance footer so you can always tell which notes are human-written and which are AI-generated, and with which model.

---

## Installation

AUTROPY is currently in active development (v0.1.0-alpha.3) and not yet available as a packaged release. To try it, build from source — see below.

**Tropy compatibility:** requires **Tropy 1.18.0-beta.5 or later**, or Tropy 1.17.x. See [Tropy compatibility](#tropy-compatibility) for why the version matters.

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

To run the test suite:

```bash
npm test
```

**For development and testing**, you can symlink the plugin directory instead of repackaging on every change. Quit Tropy first, and move any existing install aside — `ln -s` into an existing directory creates a link *inside* it rather than replacing it:

```bash
P="$HOME/Library/Application Support/Tropy Beta/plugins/tropy-plugin-autropy"
[ -e "$P.bak" ] && { echo "$P.bak already exists — resolve it first"; exit 1; }
[ -e "$P" ] && mv "$P" "$P.bak"
ln -s "$(pwd)" "$P"
```

Each iteration is then `npm run build` followed by a full **Cmd+Q** and relaunch. A complete quit is required — reopening the project window does not reload plugin code.

---

## Configuration

AUTROPY supports multiple simultaneous instances — one per AI provider or model. Each instance has its own API key and settings. Add instances with the **⊕** button in Preferences → Plugins.

| Field | Description | Default |
|---|---|---|
| **Model ID** | The provider's **API identifier**, e.g. `claude-sonnet-5`, `gemini-2.5-flash`, `gpt-4o` — also recorded in provenance notes. Not the display name: `claude-sonnet-5`, never `Claude Sonnet 5` | _(required)_ |
| **API Key** | Your API key for the selected provider. Stored as plain text in Tropy's `plugins/config.json` | _(required)_ |
| **Tropy API Port** | Port the Tropy local REST API listens on. Tropy's default is `2019`; a second concurrent instance takes `2029`. Check the log line AUTROPY writes on startup if writes are going nowhere | `2029` |
| **Suggest Metadata** | When enabled, AUTROPY reads existing item metadata and suggests values for empty or incomplete fields | `false` |
| **Custom Prompt** | Optional. Leave blank to use the default prompt (see below). Paste your own to customize what the AI focuses on | _(blank)_ |
| **Output Language** | Language for AI prose output — e.g. `Portuguese`, `French`. Leave blank to let the model choose based on document content. JSON keys and tags are always in English regardless of this setting. | _(blank = auto)_ |

---

## Supported models

| Provider | Example Model ID | Notes |
|---|---|---|
| Anthropic | `claude-sonnet-5` | Good balance for nuanced historical description |
| Anthropic | `claude-opus-5` | Highest quality, higher cost |
| Google Gemini | `gemini-2.5-flash` | Fast and cost-effective for image analysis |
| Google Gemini | `gemini-2.5-pro` | Higher quality, slower |
| OpenAI | `gpt-4o` | Strong general-purpose multimodal model |

You can use any model string supported by the provider's API — enter it directly in the Model ID field. The provider is auto-detected from the prefix: `gemini-` → Google, `gpt-` / `o1-` / `o3-` / `o4-` → OpenAI, `claude-` → Anthropic.

**Use the API identifier, not the display name.** `claude-sonnet-5` works; `Claude Sonnet 5` is rejected by the provider. AUTROPY now catches this before spending a request and tells you what to change.

**Image formats:** AI providers accept JPEG, PNG, GIF and WebP. TIFF — common in archival collections — is not accepted by any of them, and AUTROPY will say so rather than sending a file that gets rejected. Transcoding is planned.

### Local models — not supported in this release

Earlier documentation described running AUTROPY against a local OpenAI-compatible endpoint such as [Ollama](https://ollama.com). **That path was never functional** — the base URL was never passed through to the provider call — and it has been removed rather than left as a broken promise.

Reaching such an endpoint is only part of the problem: OpenAI-compatible servers differ in their support for JSON `response_format`, image data URLs, authorization headers and model naming, so "OpenAI-compatible" is not enough to guarantee AUTROPY works against an arbitrary one. Support will return tested against a specific named target. Until then, see [Privacy and data governance](#privacy-and-data-governance) for what that means for sensitive material.

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

Every note written by AUTROPY carries provenance twice: a header you read before the prose, and a
machine-readable footer.

```
📚 Machine-generated item summary — describes all pages of this item
Generated 2026-09-13 16:02 by claude-opus-5
Based on 8 page summaries, as you reviewed them.

<the summary>

---
[AUTROPY] model: claude-opus-5 | 2026-09-13T19:02:11Z | v0.5.0-alpha.1 | run mu05syns-2
```

A page note looks the same with `📄 Machine-generated page summary`, and says what that reading was
built from — whether a transcription was available, and whether preceding pages were in view.

The header exists because provenance a reader meets *after* the prose has already been read as fact
arrived too late. The two glyphs exist so an item summary is distinguishable from the page notes it
sits beside.

The footer stays because it is machine-readable. It lets you:
- Filter or search for AUTROPY notes programmatically using the `[AUTROPY]` marker
- Know exactly which model produced a given analysis, and which plugin version
- Find a write whose outcome was **unknown**, by its run id — the one case AUTROPY will not resolve
  for you

Both are written regardless of whether you edited the summary before applying: they record what the
model produced and when, not what you accepted.

---

## Privacy and data governance

AUTROPY sends photograph data to external AI APIs. **Do not use external providers to process sensitive documents, unpublished archival materials under access restrictions, or copyright-protected images** unless you have explicit authorization to do so. When in doubt, consult your institution's data governance policies and any agreements with the collections you are working with.

**There is currently no local-processing option.** Every model AUTROPY can reach in this release is a hosted API, so every analysis sends the image off your machine. If your research requires that images never leave your machine, **this release is not suitable for that material** — see [Local models](#local-models--not-supported-in-this-release). Earlier versions of this README recommended a local-model path for sensitive collections; that path did not work, and saying otherwise was the more serious error.

Image data is sent only when you click the AUTROPY toolbar icon on a specific photo, and only for that photo. Nothing is sent automatically or in the background.

AUTROPY also refuses to read or write when it cannot prove which project it is talking to — see [Tropy compatibility](#tropy-compatibility). That protects against another project's metadata being swept into a prompt and sent to a provider.

---

## Tropy compatibility

AUTROPY reads and writes through Tropy's local REST API, and that API's shape changed during the 1.18 beta cycle.

**Tropy 1.18.0-beta.5 and later** namespace every route under a project id — `/project/<id>/data/<item>`. Older builds used flat routes — `/project/data/<item>`. beta.5 ships a compatibility redirect for the old form, but it is broken for any URL with a trailing segment (it calls `.join('/')` on a value that arrives as a string), so those requests fail with **HTTP 500**. That is what stopped AUTROPY v0.1.0-alpha.2 from working, and it affects any plugin or script addressing a Tropy item by id.

AUTROPY detects which shape the running Tropy uses and addresses it accordingly, so alpha.3 works on both.

### Which project AUTROPY writes to

Tropy's API accepts the literal project id `current`, which resolves to the **frontmost** project window — not necessarily the window the plugin is running in, and it is resolved when the request arrives rather than when you check it. Using it could send one project's metadata to an AI provider while you look at another, or write suggestions into the wrong project.

**AUTROPY never uses `current`.** It reads the open project's file path from its own window, addresses that project explicitly, and verifies the path Tropy reports before writing anything. If it cannot prove the target — no project open, two projects sharing a filename, or the project changing between analysis and Apply — it refuses to write and tells you why. Nothing is written on a failed check.

On **Tropy 1.17.x** there is no project-scoped route at all, so this guarantee is weaker: AUTROPY verifies before and after each operation, which is enough to discard a read before it reaches a provider, but a write can only be reported after the fact. **On 1.17.x, keep a single project window open while analyzing.**

On startup AUTROPY logs one line naming the Tropy version, the route shape and the verified project path. If something goes wrong, that line is the place to start.

---

## Known limitations

- **One item at a time.** Selecting several items still analyzes only the one you are viewing.
- **No provenance on metadata fields.** Notes carry a provenance footer; applied metadata values do not, so a machine-written value and a hand-written one are indistinguishable once applied. The `replaces:` warning tells you at the moment of accepting; it does not persist.
- **No local/offline model support** in this release — see [Local models](#local-models--not-supported-in-this-release).
- **TIFF images are rejected** rather than transcoded.
- **"File → Export → Autropy" is a misleading label.** This is analysis, not export. Tropy derives the label from the plugin name and only exposes import, export, extract and transcribe hooks, so an item-scoped action has nowhere else to live. `tropy-plugin-segmenter` documents the same constraint; it needs a change in Tropy itself.
- **Toolbar icon locale coverage** is confirmed in English and Portuguese (PT-BR); other locales are expected to work but untested — see [issue #1](https://github.com/lucchesia/tropy-plugin-autropy/issues/1).
- **The toolbar icon does not indicate** whether a photo has already been analyzed.
- **Analyses are cached in memory only** and are lost when Tropy restarts. There is no force-re-analyze.
- **An interrupted write can be unconfirmed.** If the connection to Tropy drops mid-Apply, AUTROPY reports the write as unconfirmed rather than guessing. Tags and metadata can be retried safely; a note cannot, because it may already exist — so AUTROPY asks you to check rather than offering a retry that could duplicate it.

---

## Contributing

AUTROPY is in active early development. Issues and pull requests are welcome.

If you are a Tropy user or developer with feedback on the plugin API, UX, or integration approach, please open an issue — this plugin is intended to be a constructive contribution to the Tropy ecosystem and we welcome dialogue with the Tropy team.

---

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE).

Copyright © 2026 Anita Lucchesi.
