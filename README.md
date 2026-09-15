<div align="center">

# AUTROPY

**AI-assisted analysis of archival images for [Tropy](https://tropy.org)**

</div>

AUTROPY sends a photograph from your Tropy project to a multimodal AI model and proposes a
description, tags and metadata for it. Everything it proposes appears in a review panel below the
image. Nothing is written to your project until you accept it.

---

## Installation

Download the latest release from the **Releases** page of this repository, then in Tropy:
**Preferences → Plugins → Install Plugin** and select the zip.

Tropy reloads every open window the moment a plugin is installed — no restart needed for a
first install. The one case that does need one: **if you are upgrading an Autropy you already have
installed**, quit Tropy completely (Cmd+Q) and relaunch. Tropy keeps running the previously loaded
copy of its code until the app restarts, even though Preferences reports the new version installed.

Then open **Preferences → Plugins → Autropy** and set a **Model ID** and an **API Key**. The plugin
does nothing until you invoke it.

Requires **Tropy Beta** (currently 1.18.0-beta.5 or later). See
[Tropy compatibility](#tropy-compatibility).

> **This is a beta.** It writes notes, tags and metadata into your project. Back up your `.tropy`
> file before using it on work you care about, and read [Limitations](#limitations).

---

## Usage

Select an item and choose **File → Export → Autropy**, or open the item and click the Autropy icon
in the image toolbar. (Tropy builds that menu from the plugin's export hook, which is why an
analysis appears under Export.)

A badge in the corner of the window reports progress while the analysis runs. The review panel opens
below the image when it is ready.

### The review panel

| | |
|---|---|
| **Summary** | Editable prose describing the image. Edit it freely, or empty the box to decline it. |
| **Tags** | One chip per suggested tag. Click to accept or reject. Tags already in your project are styled differently from new ones. |
| **Metadata** | Suggested field values, accepted row by row. Only shown when **Suggest Metadata** is on. |
| **Apply accepted** | Writes what you accepted, and only that. |
| **Dismiss** | Discards everything. Nothing is written. |
| **Re-analyze** | Asks the model again and starts a fresh review. |

If a suggested value would overwrite something you already have, the row shows
**replaces: _your current value_**. Tropy stores one value per field, so accepting it is a
replacement.

A field the model returned nothing for is shown greyed out with the reason instead of disappearing.
Most often it reads *left alone — this item already has a value*: the prompt asks the model not to
duplicate metadata your item already holds, so a second run can legitimately propose less than the
first.

### Multi-page items

When an item has several photos, Autropy asks before spending anything:

> This item has 6 photos, and you are on photo 2.
> Analyzing all of them makes 5 new request(s) to the model; 1 page(s) were already analyzed with
> this model and prompt and will be reused without being billed again.
>
> One further request then writes the item summary from those pages.
>
> **[Analyze all 6 photos] [Only this photo] [Cancel]**

Pages are analyzed one at a time. The panel gains a pager — `◀ Page 3 of 6 ▶` — and paging moves
Tropy's photo selection with it, so you are always looking at the page you are reviewing. **Stop**
ends the run, keeping every page already analyzed.

A page that fails does not end the run. It is marked failed in the pager, the rest continue, and the
panel reports how many did not work. Failed and unreached pages write nothing.

**Each page is read with the three pages before it in view**, so a letter that continues across pages
is read as one document. The preceding pages are given to the model as Autropy's own summaries, not
as source text. One consequence is worth knowing: a page summary is not an independent reading of
that page alone, and the note says so.

**Tags belong to the item, not to a page.** On a multi-page item they appear once, with the item
summary, as a single de-duplicated list. Accepting a tag sets it on every page that proposed it.

**Metadata is not suggested per page.** Tropy keeps one value per field, so six pages proposing six
descriptions would mean the last one silently wins. Item metadata comes from the item summary.

### The item summary

The **item summary** describes the item as a whole. On a multi-page item it is written in the same
pass as the pages, from their summaries, in one further text-only request — it reads the page
descriptions, not the images again. It is the first view in the pager, before page 1, and the first
note written, so it sits at the top of the item's notes.

It is reviewed exactly like a page summary: edit the text, or empty the box to decline it.

Tropy has no item-level note, so it is attached to the first analyzed page. It says in its first line
that it describes the whole item, and carries a different glyph from a page note.

If you edit a page summary afterwards, the item summary is marked stale: neither its text nor its
metadata can be applied until you press **Generate again**, which is one more request. An item
description derived from text you have since corrected would not describe your item.

**A one-page item has no separate item summary.** That page is the item, so its summary is labelled
and written as the item's summary, at no extra request.

If some pages could not be analyzed, the model is told so and the summary says how many pages it
covers.

### Transcriptions

If a photo already has a transcription in Tropy, Autropy sends it with the image and asks the model
to treat it as the primary source for textual content, noting where the image contradicts it. The
most recent completed transcription is used; an unfinished recognition job is skipped. Only the plain
text is sent, never the ALTO XML.

How the transcription is described to the model is itself a provenance claim, so Autropy says only
what Tropy records. A transcription carrying ALTO data or a job id came from a text-recognition
engine and is described as one — *"may contain recognition errors"*. Anything else reached Tropy some
other way, and Tropy stores nothing about whose text it is, so it is described as *"origin is not
recorded; do not assume it is machine output"*. Calling a researcher's own transcription machine
output would invite the model to second-guess careful work.

Adding or changing a transcription invalidates that page's cached analysis. The log records
`with transcription` or `no transcription` for each page.

### After you apply

Once something has been written, the panel becomes a receipt rather than a form. Reopening it shows
what was written, when and by which model, and offers **Close**, **Re-analyze** and **Undo this analysis**. Notes cannot
be written twice safely, so an applied analysis is not re-applied.

**Re-analyze** is a new analysis: applying it adds to what is already on the item rather than
replacing it, and the panel says so.

If a write's outcome is uncertain — the connection to Tropy dropped at the wrong moment, so it may or
may not have been saved — Autropy does not repeat it and does not offer to. It names what to check.
Every note carries the id of the run that wrote it, so searching your notes for `run <id>` finds it.

### Undoing an analysis

The receipt also offers **Undo this analysis**. It removes the notes that analysis wrote, detaches the
tags it added, and puts back the metadata values it replaced — after asking, and listing what will go.

What it deliberately leaves alone:

- **A tag your item already had.** Autropy re-applying a tag you had applied yourself changed nothing,
  so undoing it would remove your tag, not its own.
- **The tag itself.** A tag is detached from this item only. It stays in your project, on every other
  item that carries it.
- **A field you have edited since.** If a value no longer matches what Autropy wrote, you have changed
  it, and your version is kept. Autropy says which fields it left.
- **A write it never had confirmed.** If Tropy's acknowledgement was lost, Autropy does not know
  whether there is anything to remove, so it names the write instead of deleting on a guess.

A field that was empty before the analysis is emptied again, rather than left holding the suggestion.

Once everything has been undone, the panel unlocks: the suggestions are still there and can be applied
again. That is deliberate — trying a model on real material means being able to apply it, look, and
put the item back.

**On Tropy Beta 1.18.0-beta.5, removing a tag through Undo does not work — verified live, and it is
Tropy's bug, not Autropy's.** `DELETE /project/:project/items/:id/tags`, the only route that detaches
one tag from one item, crashes inside Tropy's own REST layer on every call: `Cannot set properties of
undefined (setting 'rsvp')`. No request shape avoids it. Notes and metadata undo normally; when a tag
removal fails this way, Autropy says so and names the tags — remove them by hand in the item's Tags
panel.

---

## Plugin configuration

Autropy supports several instances at once — one per model or provider — each with its own settings.
Add instances with the **⊕** button in Preferences → Plugins.

| Field | Description | Default |
|---|---|---|
| **Model ID** | The provider's API identifier, e.g. `claude-opus-5`, `gemini-2.5-flash`, `gpt-4o`. Not the display name. Also recorded in provenance notes | _(required)_ |
| **API Key** | Your key for that provider. Stored as plain text by Tropy in `plugins/config.json` | _(required)_ |
| **Tropy API Port** | Port Tropy's local API listens on. Tropy's default is `2019`; a second concurrent instance takes `2029` | `2029` |
| **Suggest Metadata** | Read existing item metadata and propose values for empty or improvable fields | `false` |
| **Custom Prompt** | Replaces the default analysis instructions. The JSON output format is always appended | _(blank)_ |
| **Output Language** | Language for the model's prose, e.g. `Portuguese`, `French`. Blank lets the model follow the document. JSON keys, field names and tags are always English | _(blank)_ |

Only one Autropy toolbar icon appears, whichever instance loads first. Other instances are reachable
through **File → Export**, which lists them by name.

### Output language and the provenance header

**Output Language** sets the language of the model's prose. The provenance header Autropy writes at
the top of each note follows it for **Portuguese, Spanish, French, Italian and German**; any other
value, or a blank field, gives an English header.

Those strings are translated inside the plugin and never by the model — a provenance claim written by
the thing whose provenance it records is a suggestion, not a claim. The panel's own controls stay in
English; they are the plugin's interface, not part of your record.

---

## Supported models

| Provider | Example Model ID |
|---|---|
| Anthropic | `claude-opus-5`, `claude-sonnet-5` |
| Google Gemini | `gemini-2.5-flash`, `gemini-2.5-pro` |
| OpenAI | `gpt-4o` |

Any model string the provider's API accepts can be entered directly. The provider is derived from the
prefix: `claude-` → Anthropic, `gemini-` → Google, `gpt-` / `o1-` / `o3-` / `o4-` → OpenAI.

Use the API identifier, not the display name — `claude-opus-5`, not `Claude Opus 5`. Autropy checks
the Model ID at startup and writes what is wrong with it to the log. Provider errors are reported as
sentences: a mistyped ID points you at Preferences, a refused key says so, a rate limit says so, with
the provider's own response below.

To read the same item with a different model, change the Model ID in Preferences and press
**Re-analyze**. There is no model picker in the review panel: each key belongs to one provider, and
the two settings live together.

**Image formats.** Providers accept JPEG, PNG, GIF and WebP. TIFF — common in archival collections —
is accepted by none of them; Autropy says so rather than sending a file that will be rejected.

**Local models are not supported in this release.** Every model Autropy can reach is a hosted API.
See [Privacy and data handling](#privacy-and-data-handling).

---

## The analysis prompt

With **Custom Prompt** left blank, Autropy sends the prompt below, plus the item's existing metadata
and tag vocabulary, any transcription, and on a multi-page item the preceding page summaries.

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

A custom prompt replaces the analysis instructions only. The JSON format block is always appended;
you do not need to include it and cannot override it.

---

## Provenance

Every note Autropy writes carries provenance twice — a header you read before the prose, and a
machine-readable footer.

```
📚 Machine-generated item summary — describes all pages of this item
Generated 2026-09-13 16:02 by claude-opus-5
Based on 8 page summaries.

<the summary>

---
[AUTROPY] model: claude-opus-5 | 2026-09-13T19:02:11Z | v0.5.0-beta.1 | run mu05syns-2
```

A page note reads `📄 Machine-generated page summary` and says what that reading was built from —
whether a transcription was available, and whether preceding pages were in view.

The header is there because provenance a reader meets after the prose has been read as fact arrives
too late. The two glyphs distinguish an item summary from the page notes beside it.

The footer lets you search your notes for the `[AUTROPY]` marker, see which model and plugin version
produced a given analysis, and find a write whose outcome was uncertain by its run id.

Both are written whether or not you edited the summary before applying: they record what the model
produced and when, not what you accepted.

**Applied metadata carries no provenance yet.** A machine-proposed value and a hand-entered one are
indistinguishable once written. The `replaces:` warning tells you at the moment of accepting; it does
not persist.

---

## Privacy and data handling

Autropy sends image data to an external AI provider. **Do not use it on sensitive documents,
unpublished archival material under access restrictions, or copyright-protected images** without
authorization. Consult your institution's data governance policies and any agreements covering the
collections you work with.

**Every model Autropy can reach is a hosted API**, so every analysis sends the image off your
machine. If your research requires that images never leave your machine, this release is not suitable
for that material.

Image data is sent only when you invoke Autropy on a specific item, and only for that item's photos.
Nothing is sent automatically, in the background, or on a schedule. There is no telemetry.

Your API key is stored by Tropy in `plugins/config.json` on your own machine. It is sent only to the
provider your Model ID belongs to.

Autropy refuses to read or write when it cannot prove which project it is addressing — see
[Tropy compatibility](#tropy-compatibility). That also prevents another project's metadata from being
swept into a prompt.

---

## Tropy compatibility

Autropy reads and writes through Tropy's local REST API, whose shape changed during the 1.18 beta
cycle.

**Tropy 1.18.0-beta.5 and later** namespace every route under a project id —
`/project/<id>/data/<item>`. Older builds used flat routes — `/project/data/<item>`. beta.5 ships a
compatibility redirect for the old form, but it fails with **HTTP 500** for any URL with a trailing
segment, which affects any plugin or script addressing a Tropy item by id. Autropy detects which
shape the running Tropy uses and addresses it accordingly.

### Which project Autropy writes to

Tropy's API accepts the literal project id `current`, which resolves to the frontmost project
window — not necessarily the window the plugin is running in, and resolved when the request arrives
rather than when you check it.

**Autropy never uses `current`.** It reads the open project's file path from its own window,
addresses that project explicitly, and verifies the path Tropy reports before writing anything. If it
cannot prove the target — no project open, two projects sharing a filename, or the project changing
between analysis and Apply — it refuses to write and says why. Nothing is written on a failed check.

On startup Autropy logs one line naming the plugin version, the port and the model. Logs are at
`~/Library/Logs/Tropy Beta/` on macOS.

---

## Limitations

- **One item at a time.** Selecting several items analyzes only the one you are viewing.
- **No provenance on applied metadata fields.** Notes carry provenance; metadata values do not.
- **No local or offline models.** Every analysis reaches a hosted API.
- **TIFF images are rejected** rather than transcoded.
- **"File → Export → Autropy" is a misleading label.** This is analysis, not export. Tropy exposes
  only import, export, extract and transcribe hooks, so an item-scoped action has nowhere else to
  live. This needs a change in Tropy itself.
- **The toolbar icon does not indicate** whether a photo has already been analyzed.
- **Analyses are cached in memory only** and are lost when Tropy restarts.
- **An interrupted write can be unconfirmed.** Tags and metadata can be retried safely; a note cannot,
  because it may already exist — so Autropy asks you to check rather than offering a retry that could
  duplicate it.

---

## Building from source

```bash
git clone https://github.com/lucchesia/tropy-plugin-autropy
cd tropy-plugin-autropy
npm install
npm run build
npm test
```

To build the same zip the Releases page serves:

```bash
npm run package     # writes dist/tropy-plugin-autropy-v<version>.zip
```

Install it through **Preferences → Plugins → Install Plugin**. A full quit (Cmd+Q) and relaunch is
required on every iteration, because this reinstalls at the same path each time: Tropy's plugin loader
caches an imported module by file path, so it keeps running whichever copy of the code was imported
first in this Tropy session, no matter how many times the files on disk change underneath it. Quitting
is what clears that cache — the project window has nothing to do with it.

---

## Feedback

Issues and pull requests are welcome on this repository. Feedback on the plugin API, the interface,
or the integration approach is particularly welcome — Autropy is intended as a constructive
contribution to the Tropy ecosystem.

---

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE).

Copyright © 2026 Anita Lucchesi. Developed with the assistance of Claude (Anthropic).
