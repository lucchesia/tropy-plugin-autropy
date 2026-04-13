# tropy-plugin-autropy

A [Tropy](https://tropy.org) plugin for AI-assisted analysis of archival photographs and documents.

Autropy sends the active photo to a multimodal AI model (Gemini, GPT-4o, Claude, or any compatible local model), receives a structured analysis — summary, document type, suggested tags, metadata suggestions — and presents them in a review panel inside the Tropy image viewer. Nothing is written to your project until you explicitly approve each suggestion.

**Status: alpha (v0.1.0-alpha.1).** Core functionality confirmed working. See [Known issues](#known-issues) below.

---

## What it does

- Analyzes the active photo using a multimodal AI model
- Presents results in a panel overlaid on the Tropy image viewer
- Tag suggestions appear as individual chips — accept or reject each one independently
- AI-generated summary is editable before it is written as a note
- Inferred document type and metadata suggestions (title, date, description) have per-field accept buttons
- Nothing is written to Tropy until you press **Apply accepted**
- Every note written by Autropy carries a provenance marker: `[AUTROPY] model: <id> | <timestamp> | v<version>`

---

## Requirements

- Tropy 1.18 Beta or later (uses the Tropy REST API on localhost)
- An API key for a supported model provider, or a locally running compatible model
- Tropy must be running with a project open when you trigger analysis

---

## Installation

1. Download the latest `.zip` from [Releases](https://github.com/lucchesia/tropy-plugin-autropy/releases) (or build from source — see below)
2. In Tropy: **Preferences → Plugins → Install Plugin** → select the zip
3. Restart Tropy completely (Cmd+Q, then reopen)
4. In Preferences → Plugins, find **Autropy** and enter your model ID and API key

---

## Configuration

| Option | Description | Default |
|---|---|---|
| Model ID | API model identifier — e.g. `gemini-2.5-flash`, `gpt-4o`, `claude-opus-4-6` | _(required)_ |
| API Key | Key for the model provider | _(required)_ |
| Tropy API Port | Port the Tropy REST API is listening on | `2029` |
| Suggest Metadata | Also suggest title, date, description fields | `false` |
| Custom Prompt | Override the default analysis prompt | _(optional)_ |

The provider is auto-detected from the model ID prefix: `gemini-` → Google, `gpt-` / `o1-` / `o3-` / `o4-` → OpenAI, `claude-` → Anthropic. Any other prefix routes to a local model via `localBaseUrl`.

---

## Usage

**Triggering analysis:**
- Select an item in Tropy with at least one photo
- **File → Export → Autropy** (the export hook is the primary trigger)
- Or click the Autropy icon in the esper toolbar (appears after the first analysis run)

**Reviewing results:**
- A panel slides up from the bottom of the image viewer
- Edit the summary text if needed
- Click tag chips to toggle accept/reject (green = accepted, dimmed = rejected)
- Click **Accept** next to any metadata field to include it in the write-back
- Press **Apply accepted** to write approved tags, the note, and any accepted metadata to Tropy
- Press **Dismiss** to discard without writing anything

**Toolbar icon:**
- Once injected, the icon toggles the panel open/closed without re-running analysis
- Analysis for the same photo is cached for the session — re-triggering via File → Export shows the cached result instantly

---

## Building from source

```bash
git clone https://github.com/lucchesia/tropy-plugin-autropy.git
cd tropy-plugin-autropy
npm install
npm run build
```

To package for installation:

```bash
cd ..
zip -r tropy-plugin-autropy.zip tropy-plugin-autropy \
  --exclude "tropy-plugin-autropy/.git*" \
  --exclude "tropy-plugin-autropy/node_modules/*"
```

Then install the zip via Tropy Preferences → Plugins.

---

## How it works

The plugin uses Tropy's `export` hook as its trigger. On activation:

1. Reads the active item and photo IDs from `tropy.state().nav`
2. Reads the image from disk via the photo's filesystem path (images are not served by the REST API)
3. Calls the configured AI model with the image and analysis prompt
4. Injects a review panel into the esper image viewer container
5. On "Apply accepted": writes approved tags via `POST /project/items/{id}/tags`, writes the summary as a note via `POST /project/notes`, and writes accepted metadata fields via `POST /project/data/{id}`

All write operations go through the Tropy REST API (default port 2029). Tags are created if they don't exist and applied by numeric ID.

---

## Known issues

- **Dark mode**: panel responds to `prefers-color-scheme` — confirmed working with Tropy's theme. Color tokens are approximated and may need refinement.
- **"File → Export → Autropy" label**: the Export verb is derived from the hook type and cannot be overridden without a Tropy core change. The menu label is misleading — this is analysis, not file export. A custom hook label option would be needed upstream.
- **Toolbar icon state**: the icon does not visually distinguish "this photo has been analyzed" from "this photo has not been analyzed." This would require a plugin API for managed toolbar button state.
- **Multi-page items**: only the currently active photo is analyzed. A planned second pass would loop all photos and synthesize an item-level description.
- **Multi-item batch**: selecting multiple items does not trigger batch analysis. Planned.

---

## Note for Tropy contributors and developers

This plugin was built through direct DOM injection and the existing REST API — no custom plugin API was used beyond the `export` hook and `tropy.state()`. A few things encountered during development that would benefit from upstream support:

- **Custom hook label**: the export hook label cannot be overridden. An option like `hooks: { export: { label: "Analyze with Autropy" } }` would prevent the misleading "Export" framing.
- **Managed toolbar button state**: plugins currently have no way to set visual state on toolbar buttons (active, inactive, has-result). This makes it impossible to signal to the user whether the current photo has been analyzed.
- **Plugin panel registration**: formal support for registering a panel within the esper view (rather than injecting into the DOM directly) would make plugins like this more stable across Tropy updates.

Feedback, issues, and pull requests welcome.

---

## License

MIT
