// panel-template.js — review panel HTML template function
//
// CONFIRMED: panel contents per build spec:
//   1. Header row: document_type (left) + confidence % (right)
//   2. Editable textarea pre-filled with AI summary
//   3. Tag chips with per-chip accept/reject; existing vs. new chips styled differently
//   4. Metadata suggestions table — only rendered when suggestMetadata option is on
//   5. "Apply accepted" and "Dismiss" buttons
//
// CONFIRMED (dom_injection_test_results.md): Tropy has NO CSS custom properties on :root.
//   All color/font values are hardcoded computed values from DevTools inspection.
//
// CONFIRMED (dom_injection_test_results.md): autropy- prefix is clean (0 matches on fresh load).
//
// CONFIRMED (dom_injection_test_results.md): panel uses position:absolute; bottom:0 overlay
//   inside .esper-container. max-height:60% prevents panel from eclipsing the full image

import { escapeAttr, escapeHtml } from './html.js'
import { ABSENT, UNWRITABLE } from './result-schema.js'
import {
  UNCERTAIN,
  appliedSummary,
  isFieldAccepted,
  isLocked,
  isTagAccepted,
  photoEntry,
  uncertainOperations
} from './run.js'

// ---------------------------------------------------------------------------
// Chip helpers
// ---------------------------------------------------------------------------

// Existing project tags get an outlined style; new AI-suggested tags get a
// filled style with a leading + to signal they will be created on apply.
//
// `data-accepted` is now a projection of the run, not the source of truth. It
// stays in the markup because the CSS keys off it, but the click handler writes
// into the run and re-reads from there — a re-render used to silently reset
// every metadata row and re-accept every chip.
function renderChip (tagName, isExisting, accepted, locked) {
  const modifier = isExisting ? 'autropy-chip--existing' : 'autropy-chip--new'
  const label = isExisting ? tagName : `+ ${tagName}`
  const interactive = locked ? '' : ' role="button" tabindex="0"'
  const title = locked
    ? (accepted ? 'Written to this item' : 'Not written')
    : (isExisting ? 'Existing project tag' : 'New tag — will be created on apply')

  return `<span
    class="autropy-chip ${modifier}"
    data-tag="${escapeAttr(tagName)}"
    data-accepted="${accepted ? 'true' : 'false'}"${interactive}
    title="${escapeAttr(title)}"
  >${escapeHtml(label)} <span class="autropy-chip__toggle">&#10003;</span></span>`
}

// ---------------------------------------------------------------------------
// Metadata suggestions table
// ---------------------------------------------------------------------------

// Renders the metadata accept/reject table.
// The document type row is ALWAYS included (not gated by suggestMetadata) because
// the inferred type is a first-class output of every analysis run.
// Additional metadata rows (title, date, description) are included only when
// suggestMetadata is true and the AI returned values for those fields.
//
// All rows use data-field matching the DC_WRITE_URIS keys in dc.js so that
// #applyAccepted() can write accepted rows without any additional wiring.
function renderMetadataTable (run, photoId, suggestMetadata) {
  const entry = photoEntry(run, photoId)
  const result = entry?.result ?? {}
  const docType = result.document_type || 'unknown'
  const metadataSuggestions = result.metadata_suggestions
  const locked = isLocked(run)
  const current = run.itemMetadata || {}

  // Accepting a suggestion for a field that already holds something REPLACES it,
  // and Tropy keeps one value per property. That has to be visible before the
  // click, not discovered afterwards: the model answers in an English vocabulary
  // ("drawing") and will happily overwrite a curated Portuguese one ("Desenho"),
  // with nothing left to say which was the researcher's.
  const valueCell = (field, value) => {
    const existing = current[field]
    const replaces = (existing != null && String(existing).trim() &&
      String(existing).trim() !== String(value).trim())
      ? `<span class="autropy-meta-row__replaces">replaces: ${escapeHtml(existing)}</span>`
      : ''

    return `<td class="autropy-meta-row__value">${escapeHtml(value)}${replaces}</td>`
  }

  // When the run is locked there is nothing to accept, so the button is replaced
  // by a word saying what happened to that field rather than a control that
  // would either do nothing or invite a duplicate write.
  const actionCell = (field, accepted) => {
    if (locked) {
      return `<td class="autropy-meta-row__action autropy-meta-row__outcome">${
        accepted ? 'written' : '—'}</td>`
    }
    return `<td class="autropy-meta-row__action">
          <button class="autropy-meta-row__accept">${accepted ? 'Undo' : 'Accept'}</button>
        </td>`
  }

  const row = (field, value, accepted) => `
      <tr class="autropy-meta-row" data-field="${escapeAttr(field)}" data-accepted="${
  accepted ? 'true' : 'false'}">
        <td class="autropy-meta-row__field">${escapeHtml(field)}</td>
        ${valueCell(field, value)}
        ${actionCell(field, accepted)}
      </tr>`

  // The type row used to render unconditionally, which meant "Suggest Metadata"
  // did not in fact gate every metadata write: with it off, accepting this row
  // still wrote dc:type. The inferred type is still shown — it is the panel's
  // header — but offering to write it is a metadata suggestion like any other.
  const typeRow = suggestMetadata
    ? row('type', docType, isFieldAccepted(run, photoId, 'type'))
    : ''

  let extraRows = ''
  if (suggestMetadata && metadataSuggestions && typeof metadataSuggestions === 'object') {
    extraRows = Object.entries(metadataSuggestions)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([field, value]) =>
        row(field, String(value), isFieldAccepted(run, photoId, field)))
      .join('')
  }

  // Fields the prompt asked for that produced nothing. Shown, muted and without
  // an Accept button, because "the model declined" and "the model failed" look
  // identical in a panel that only lists what came back — and they call for
  // opposite responses. The declined case is usually the prompt working as
  // designed: it tells the model not to duplicate values the item already holds,
  // which is why a second run with a different model can return fewer fields
  // than the first.
  let suppressedRows = ''
  if (suggestMetadata && Array.isArray(result.suppressed)) {
    suppressedRows = result.suppressed.map(({ field, reason }) => {
      const held = current[field]
      const explanation = reason === UNWRITABLE
        ? 'Autropy cannot write this field'
        : (held != null && String(held).trim())
            ? 'left alone — this item already has a value'
            : reason === ABSENT
              ? 'the model did not return this field'
              : 'the model had nothing to suggest'

      return `
      <tr class="autropy-meta-row autropy-meta-row--suppressed" data-field="${
  escapeAttr(field)}">
        <td class="autropy-meta-row__field">${escapeHtml(field)}</td>
        <td class="autropy-meta-row__value">${escapeHtml(explanation)}</td>
        <td class="autropy-meta-row__action"></td>
      </tr>`
    }).join('')
  }

  if (!typeRow && !extraRows && !suppressedRows) return ''

  return `
    <section class="autropy-section">
      <table class="autropy-meta-table">
        <colgroup>
          <col class="autropy-meta-col--field">
          <col>
          <col class="autropy-meta-col--action">
        </colgroup>
        <thead>
          <tr>
            <th>Field</th>
            <th>Suggested value</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${typeRow}${extraRows}${suppressedRows}</tbody>
      </table>
    </section>`
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

// Injected once alongside the panel.
// All color/font tokens are hardcoded computed values confirmed from DevTools
// inspection of a running Tropy Beta 1.18 instance — Tropy has no CSS custom
// properties on :root, so values must be hardcoded.
//
// CONFIRMED from DevTools: panel background rgb(246,246,246)
// CONFIRMED from DevTools: font-family system-ui
// CONFIRMED from DevTools: font-size 13px
// CONFIRMED from DevTools: text color rgb(34,34,34)
// CONFIRMED from DevTools: border color rgb(210,210,210)
// UNVERIFIED: muted text rgb(128,128,128) — reasonable midpoint, not inspected
// UNVERIFIED: accent blue #5b8dd9 — chosen to harmonize; replace after visual check
//
// NOTE: this is a template literal, so no backticks anywhere inside it — not
// even in a CSS comment. One ends the literal early and breaks the module.
export const PANEL_STYLES = `
<style id="autropy-styles">
  #autropy-panel {
    /* CONFIRMED (dom_injection_test_results.md): absolute overlay at bottom of .esper-container */
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    max-height: 60%;   /* prevents panel from eclipsing the image */
    max-width: 100%;
    /* Clip horizontally, never spill. Without this, one long AI-written
     * metadata value widened the panel's content box, overflowed the image
     * viewer, and gave the whole Tropy window a horizontal scrollbar — which
     * pushed the project panel off the left edge of the screen and made it
     * look as though Tropy itself had broken. Contain our own mess. */
    overflow: hidden auto;
    overscroll-behavior: contain;
    z-index: 50;       /* above canvas; below Tropy modal dialogs */
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid rgb(210,210,210); /* CONFIRMED from DevTools */
    background: rgb(246,246,246);           /* CONFIRMED from DevTools */
    font-family: system-ui;                 /* CONFIRMED from DevTools */
    font-size: 13px;                        /* CONFIRMED from DevTools */
    color: rgb(34,34,34);                   /* CONFIRMED from DevTools */
    box-sizing: border-box;
  }

  /* The toolbar icon while a model call is in flight. A run takes ten to twenty
   * seconds and the panel does not exist yet, so without this the only feedback
   * for a click is a log line nobody is watching. */
  .autropy-toggle--busy {
    opacity: 0.45;
    cursor: progress;
  }

  .autropy-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11px;
    color: rgb(128,128,128); /* UNVERIFIED: muted text — not confirmed from DevTools */
  }

  .autropy-header__type {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .autropy-header__confidence {
    font-variant-numeric: tabular-nums;
  }

  .autropy-summary {
    width: 100%;
    min-height: 64px;
    padding: 6px 8px;
    border: 1px solid rgb(210,210,210); /* CONFIRMED from DevTools */
    border-radius: 3px;
    background: rgb(255,255,255);
    color: rgb(34,34,34);               /* CONFIRMED from DevTools */
    font-family: system-ui;             /* CONFIRMED from DevTools */
    font-size: 13px;                    /* CONFIRMED from DevTools */
    resize: vertical;
    box-sizing: border-box;
  }

  /* A run that has been applied is history, not a form. The readonly textarea
   * keeps the text selectable and copyable while making it obvious that editing
   * it here would change nothing in Tropy. */
  #autropy-panel[data-locked="true"] .autropy-summary {
    background: rgb(240,240,240);
    color: rgb(90,90,90);
    cursor: default;
  }

  .autropy-banner {
    padding: 6px 8px;
    border-radius: 3px;
    border: 1px solid rgb(210,210,210); /* CONFIRMED from DevTools */
    background: rgb(240,240,240);
    font-size: 12px;
    line-height: 1.4;
  }

  .autropy-banner--uncertain {
    border-color: #b03a3a;
  }

  .autropy-banner__line {
    font-variant-numeric: tabular-nums;
  }

  .autropy-banner__uncertain {
    margin-top: 4px;
    font-weight: 500;
  }

  .autropy-banner__uncertain ul {
    margin: 4px 0 0;
    padding-left: 18px;
  }

  .autropy-meta-row__outcome {
    padding: 3px 4px;
    font-size: 11px;
    color: rgb(128,128,128); /* UNVERIFIED: muted text */
  }

  .autropy-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .autropy-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    cursor: pointer;
    user-select: none;
    transition: opacity 0.1s;
  }

  /* Existing project tag — outlined */
  /* UNVERIFIED: accent color #5b8dd9 — replace after visual check in Tropy */
  .autropy-chip--existing {
    border: 1px solid #5b8dd9;
    color: #5b8dd9;
    background: transparent;
  }

  /* New AI-suggested tag — filled */
  /* UNVERIFIED: accent color #5b8dd9 — replace after visual check in Tropy */
  .autropy-chip--new {
    border: 1px solid #5b8dd9;
    background: #5b8dd9;
    color: rgb(255,255,255);
  }

  /* Rejected state — dimmed */
  .autropy-chip[data-accepted="false"] {
    opacity: 0.4;
  }

  .autropy-chip[data-accepted="false"] .autropy-chip__toggle::before {
    content: "\\2715"; /* ✕ */
  }

  .autropy-chip[data-accepted="true"] .autropy-chip__toggle::before {
    content: "\\2713"; /* ✓ */
  }

  /* Hide the raw HTML entity fallback — replaced by ::before */
  .autropy-chip__toggle {
    font-size: 0;
  }
  .autropy-chip__toggle::before {
    font-size: 10px;
  }

  .autropy-section {
    border-top: 1px solid rgb(210,210,210); /* CONFIRMED from DevTools */
    padding-top: 6px;
  }

  .autropy-meta-table {
    width: 100%;
    /* 'fixed' is essential, not cosmetic: with the default 'auto', the long
     * description cell's intrinsic width wins over 'width: 100%' and the table
     * grows past the panel. Column widths come from the colgroup. */
    table-layout: fixed;
    border-collapse: collapse;
    font-size: 11px;
  }

  .autropy-meta-table th {
    text-align: left;
    color: rgb(128,128,128); /* UNVERIFIED: muted text */
    font-weight: 500;
    padding: 2px 4px;
    border-bottom: 1px solid rgb(210,210,210); /* CONFIRMED from DevTools */
  }

  /* With table-layout: fixed the column widths come from here, so the middle
   * column absorbs whatever is left and nothing can push the table wider. */
  .autropy-meta-col--field { width: 76px; }
  .autropy-meta-col--action { width: 78px; }

  .autropy-meta-row__field {
    color: rgb(128,128,128); /* UNVERIFIED: muted text */
    padding: 3px 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* No height cap and no inner scrollbar. Capping this cell put a second
   * scrollbar in the middle of the table and clipped the description mid-line,
   * which is worse than a tall row: the panel is already the scroll container
   * (max-height + overflow-y) and the action row is sticky, so a long value
   * costs a scroll, not a lost button. 'overflow-wrap: anywhere' is what keeps
   * an unbroken string from widening the table. */
  .autropy-meta-row__value {
    padding: 3px 8px;
    overflow-wrap: anywhere;
  }

  /* Accepted reads as affirmed, not cancelled.
   *
   * This used to be 'text-decoration: line-through; opacity: 0.5', so pressing
   * Accept struck the value out — which looks exactly like rejecting it. On a
   * panel where the chips use dimming to mean rejected, the same visual meant
   * the opposite thing one section lower. */
  /* Shown under a suggestion that would overwrite an existing value. Tropy keeps
   * one value per property, so accepting such a row is a replacement, and the
   * old value is not recoverable from the panel afterwards. */
  /* A field the prompt asked for that produced nothing. Present so the absence
   * is legible, muted so it cannot be mistaken for a suggestion. */
  .autropy-meta-row--suppressed .autropy-meta-row__value {
    color: rgb(128,128,128); /* UNVERIFIED: muted text */
    font-style: italic;
  }

  .autropy-meta-row__replaces {
    display: block;
    margin-top: 2px;
    font-size: 10px;
    color: #b8642a;
  }

  .autropy-meta-row[data-accepted="true"] .autropy-meta-row__value {
    font-weight: 500;
    box-shadow: inset 2px 0 0 #5b8dd9;
  }

  .autropy-meta-row__accept {
    padding: 1px 6px;
    font-size: 11px;
    border: 1px solid rgb(210,210,210); /* CONFIRMED from DevTools */
    background: rgb(246,246,246);       /* CONFIRMED from DevTools */
    color: rgb(34,34,34);               /* CONFIRMED from DevTools */
    border-radius: 3px;
    cursor: pointer;
  }

  /* Sticky so Dismiss and Apply are reachable no matter how long the summary
   * and metadata are. The panel is the scroll container (max-height +
   * overflow-y: auto), and a long AI description pushed these buttons out of
   * view with no way back — keyboard events are deliberately swallowed inside
   * the panel, so there was no way to close it at all.
   *
   * No shadow or border: a separator here reads as a stray rule across the
   * panel. The opaque background alone is enough to keep the buttons legible
   * over whatever scrolls beneath them. */
  .autropy-actions {
    position: sticky;
    bottom: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 0 2px;
    margin-top: auto;
    background: rgb(246,246,246);       /* CONFIRMED from DevTools */
  }

  /* Pushes the buttons right while leaving the model picker on the left. */
  .autropy-actions__spacer {
    flex: 1 1 auto;
  }

  .autropy-model {
    max-width: 45%;
    padding: 3px 4px;
    font-size: 11px;
    font-family: system-ui;             /* CONFIRMED from DevTools */
    border-radius: 3px;
    border: 1px solid rgb(210,210,210); /* CONFIRMED from DevTools */
    background: rgb(255,255,255);
    color: rgb(34,34,34);               /* CONFIRMED from DevTools */
  }

  .autropy-btn {
    padding: 4px 12px;
    font-size: 13px;                    /* CONFIRMED from DevTools */
    border-radius: 3px;
    cursor: pointer;
    font-family: system-ui;             /* CONFIRMED from DevTools */
    border: 1px solid rgb(210,210,210); /* CONFIRMED from DevTools */
    background: rgb(246,246,246);       /* CONFIRMED from DevTools */
    color: rgb(34,34,34);               /* CONFIRMED from DevTools */
  }

  /* UNVERIFIED: accent color #5b8dd9 — replace after visual check in Tropy */
  .autropy-btn--primary {
    background: #5b8dd9;
    border-color: #5b8dd9;
    color: rgb(255,255,255);
  }

  /* Status area — degraded reads before analysis, write outcomes after Apply.
   * Hidden until there is something to say, so the panel is unchanged in the
   * ordinary case where everything worked. */
  .autropy-status:empty {
    display: none;
  }

  .autropy-status {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px 8px;
    margin-top: 2px;
    font-size: 12px;
    line-height: 1.4;
    border-radius: 3px;
    border: 1px solid rgb(210,210,210);
    background: rgb(240,240,240);
  }

  .autropy-status__line {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }

  .autropy-status__mark {
    flex: none;
    font-weight: 600;
  }

  .autropy-status__line--ok .autropy-status__mark { color: #3c8c4a; }
  .autropy-status__line--warn .autropy-status__mark { color: #b8642a; }
  .autropy-status__line--unknown .autropy-status__mark { color: #b03a3a; }
  .autropy-status__line--info .autropy-status__mark { color: rgb(128,128,128); }

  /* An unknown write is the one case the researcher must check by hand, so it
   * gets emphasis rather than sitting level with the rest. */
  .autropy-status__line--unknown {
    font-weight: 500;
  }

  /* ---------------------------------------------------------------------------
   * Dark mode overrides
   * Uses @media (prefers-color-scheme: dark) — works when Tropy follows the OS
   * theme setting. If Tropy ever gains an independent theme toggle that doesn't
   * track the OS, a class-based selector will need to be added here too.
   * Token values chosen to approximate Tropy's dark palette from the screenshot.
   * UNVERIFIED: exact values — adjust after visual check in Tropy dark mode.
   * --------------------------------------------------------------------------- */
  @media (prefers-color-scheme: dark) {
    #autropy-panel {
      background: rgb(38,38,38);
      border-top-color: rgb(60,60,60);
      color: rgb(204,204,204);
    }

    .autropy-header {
      color: rgb(120,120,120);
    }

    .autropy-summary {
      background: rgb(26,26,26);
      border-color: rgb(60,60,60);
      color: rgb(204,204,204);
    }

    .autropy-chip--existing {
      border-color: #5b8dd9;
      color: #7aaae0;
      background: transparent;
    }

    .autropy-chip--new {
      border-color: #5b8dd9;
      background: #3a5f8a;
      color: rgb(220,220,220);
    }

    .autropy-section {
      border-top-color: rgb(60,60,60);
    }

    .autropy-meta-table th {
      color: rgb(120,120,120);
      border-bottom-color: rgb(60,60,60);
    }

    .autropy-meta-row__field {
      color: rgb(120,120,120);
    }

    .autropy-meta-row__accept {
      border-color: rgb(60,60,60);
      background: rgb(50,50,50);
      color: rgb(204,204,204);
    }

    .autropy-btn {
      border-color: rgb(60,60,60);
      background: rgb(50,50,50);
      color: rgb(204,204,204);
    }

    /* Must match #autropy-panel's dark background — the actions row is sticky,
     * so content scrolls underneath it. */
    .autropy-actions {
      background: rgb(38,38,38);
    }

    .autropy-status {
      border-color: rgb(60,60,60);
      background: rgb(46,46,46);
    }

    #autropy-panel[data-locked="true"] .autropy-summary {
      background: rgb(32,32,32);
      color: rgb(150,150,150);
    }

    .autropy-banner {
      border-color: rgb(60,60,60);
      background: rgb(46,46,46);
    }

    .autropy-banner--uncertain {
      border-color: #e88b8b;
    }

    .autropy-meta-row__outcome {
      color: rgb(120,120,120);
    }

    .autropy-meta-row__replaces {
      color: #e0a06a;
    }

    .autropy-model {
      border-color: rgb(60,60,60);
      background: rgb(50,50,50);
      color: rgb(204,204,204);
    }

    .autropy-status__line--ok .autropy-status__mark { color: #7cc98a; }
    .autropy-status__line--warn .autropy-status__mark { color: #e0a06a; }
    .autropy-status__line--unknown .autropy-status__mark { color: #e88b8b; }

    .autropy-btn--primary {
      background: #5b8dd9;
      border-color: #5b8dd9;
      color: rgb(255,255,255);
    }
  }
</style>`

// ---------------------------------------------------------------------------
// Main template function
// ---------------------------------------------------------------------------

// The banner an applied run carries instead of its controls.
//
// A researcher who re-opens a panel needs one question answered before anything
// else: was this already written? Before this existed the panel looked identical
// whether or not Apply had run, which is how a second Apply came to write a
// second note.
function renderAppliedBanner (run) {
  const applied = appliedSummary(run)
  if (!applied) return ''

  const when = new Date(applied.at).toLocaleString()
  const counts = [
    `${applied.notes} note${applied.notes === 1 ? '' : 's'}`,
    `${applied.fields} field${applied.fields === 1 ? '' : 's'}`,
    `${applied.tags} tag${applied.tags === 1 ? '' : 's'}`
  ].join(', ')

  let detail = `Applied ${when} · ${applied.model} · ${counts}`
  if (applied.rejected > 0) detail += ` · ${applied.rejected} refused`

  // The uncertain case is spelled out in full rather than counted. It is the one
  // outcome Autropy will not resolve on the researcher's behalf, so it has to
  // say exactly what to look for and where.
  let uncertain = ''
  if (applied.state === UNCERTAIN) {
    const items = uncertainOperations(run)
      .map(op => `<li>${escapeHtml(op.describe || op.key)}</li>`)
      .join('')
    uncertain = `
        <div class="autropy-banner__uncertain">
          The connection to Tropy dropped during these writes, so they may or may
          not have been saved. Check in Tropy before re-running — searching your
          notes for <code>run ${escapeHtml(run.id)}</code> will find them.
          <ul>${items}</ul>
        </div>`
  }

  return `
      <div class="autropy-banner autropy-banner--${escapeAttr(applied.state)}">
        <div class="autropy-banner__line">${escapeHtml(detail)}</div>${uncertain}
      </div>`
}

// Returns a self-contained HTML string for the review panel.
//
//   run              — the run being reviewed; the source of truth for every
//                      accept decision, the summary draft and the write ledger
//   photoId          — which of the run's photos this view shows
//   existingTagNames — tag names already in the project, for chip styling
//   suggestMetadata  — whether the metadata suggestion rows are rendered
//
// Results have already passed validateResult(), so possible_tags is an array and
// confidence is either a number in 0–1 or null.
export function buildPanelHTML ({
  run, photoId, existingTagNames, suggestMetadata, modelChoices = []
}) {
  const entry = photoEntry(run, photoId)
  const result = entry?.result ?? {}
  const {
    document_type: docType = 'unknown',
    possible_tags: tags = [],
    confidence = null
  } = result

  const locked = isLocked(run)

  const existingSet = new Set(
    (existingTagNames || []).map(n => n.toLowerCase())
  )

  const chips = tags.map(tag =>
    renderChip(
      tag,
      existingSet.has(tag.toLowerCase()),
      isTagAccepted(run, photoId, tag),
      locked)
  ).join('')

  // Omitted rather than shown as 0% or NaN% when the model gave no figure.
  const confidencePct = confidence == null ? '' : `${Math.round(confidence * 100)}%`

  // Metadata section always rendered (for the type row); extra rows gated by suggestMetadata
  const metaSection = renderMetadataTable(run, photoId, suggestMetadata)

  // The draft, not the model's original text: the researcher's edits are the
  // thing worth preserving across a re-render.
  const summary = entry?.summaryDraft ?? ''

  const actions = locked
    ? `<button class="autropy-btn" id="autropy-dismiss">Close</button>
        <button class="autropy-btn autropy-btn--primary" id="autropy-reanalyze">Re-analyze</button>`
    : `<button class="autropy-btn" id="autropy-dismiss">Dismiss</button>
        <button class="autropy-btn" id="autropy-reanalyze">Re-analyze</button>
        <button class="autropy-btn autropy-btn--primary" id="autropy-apply">Apply accepted</button>`

  // Offered only when there is more than one model to choose between, so the
  // ordinary single-model panel is unchanged.
  //
  // Switching to a model already run on this photo costs nothing and bills
  // nothing — the picker doubles as a way to compare two readings of the same
  // document side by side, which is why cached entries say so.
  const picker = (modelChoices?.length > 1)
    ? `<select id="autropy-model" class="autropy-model" title="Analyze with a different model">${
      modelChoices.map(({ model, cached }) => `<option value="${escapeAttr(model)}"${
        model === run.model ? ' selected' : ''}>${escapeHtml(model)}${
        cached && model !== run.model ? ' · already run' : ''}</option>`).join('')
    }</select>`
    : ''

  return `
    ${PANEL_STYLES}
    <div id="autropy-panel" data-locked="${locked ? 'true' : 'false'}" data-run="${
  escapeAttr(run.id)}">
      <div class="autropy-header">
        <span class="autropy-header__type">${escapeHtml(docType)}</span>
        <span class="autropy-header__confidence">${confidencePct}</span>
      </div>
      ${renderAppliedBanner(run)}

      <textarea
        id="autropy-summary"
        class="autropy-summary"
        rows="4"${locked ? ' readonly' : ''}
      >${escapeHtml(summary)}</textarea>

      <div class="autropy-chips" id="autropy-chips">
        ${chips}
      </div>

      ${metaSection}

      <div class="autropy-status" id="autropy-status"></div>

      <div class="autropy-actions">
        ${picker}
        <span class="autropy-actions__spacer"></span>
        ${actions}
      </div>
    </div>`
}

// ---------------------------------------------------------------------------
// Status lines
// ---------------------------------------------------------------------------

const STATUS_MARKS = {
  ok: '✓',        // ✓ written and confirmed by Tropy
  warn: '×',      // × Tropy refused it; safe to retry
  unknown: '?',        // ? we do not know whether it landed
  info: '·'       // · context, not an outcome
}

// Renders the status area contents. `lines` is [{ kind, text }] where kind is
// one of ok | warn | unknown | info.
//
// `unknown` exists because a REST write can be acknowledged by SQLite and still
// fail to reach us — a dropped connection after the commit is indistinguishable
// from one before it. Tags and metadata can simply be re-read and retried;
// a note cannot, so the researcher is told to look rather than offered a button
// that might duplicate it.
export function renderStatusLines (lines) {
  if (!Array.isArray(lines) || lines.length === 0) return ''

  return lines.map(({ kind = 'info', text = '' }) => {
    const mark = STATUS_MARKS[kind] || STATUS_MARKS.info
    return `<div class="autropy-status__line autropy-status__line--${escapeAttr(kind)}">` +
      `<span class="autropy-status__mark" aria-hidden="true">${mark}</span>` +
      `<span>${escapeHtml(text)}</span>` +
      '</div>'
  }).join('')
}

// Escaping lives in html.js — the note writer needs the same helpers, and the
// data layer must not import a UI template to get them.
