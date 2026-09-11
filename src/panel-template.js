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

// ---------------------------------------------------------------------------
// Chip helpers
// ---------------------------------------------------------------------------

// Existing project tags get an outlined style; new AI-suggested tags get a
// filled style with a leading + to signal they will be created on apply.
// CONFIRMED: chip accept/reject state is tracked via data-accepted attribute
//   and toggled by the click handler wired in plugin.js.
function renderChip (tagName, isExisting) {
  const modifier = isExisting ? 'autropy-chip--existing' : 'autropy-chip--new'
  const label = isExisting ? tagName : `+ ${tagName}`
  return `<span
    class="autropy-chip ${modifier}"
    data-tag="${escapeAttr(tagName)}"
    data-accepted="true"
    role="button"
    tabindex="0"
    title="${isExisting ? 'Existing project tag' : 'New tag — will be created on apply'}"
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
function renderMetadataTable (docType, metadataSuggestions, suggestMetadata) {
  const typeRow = `
      <tr class="autropy-meta-row" data-field="type" data-accepted="false">
        <td class="autropy-meta-row__field">type</td>
        <td class="autropy-meta-row__value">${escapeHtml(docType || 'unknown')}</td>
        <td class="autropy-meta-row__action">
          <button class="autropy-meta-row__accept">Accept</button>
        </td>
      </tr>`

  let extraRows = ''
  if (suggestMetadata && metadataSuggestions && typeof metadataSuggestions === 'object') {
    extraRows = Object.entries(metadataSuggestions)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([field, value]) => `
      <tr class="autropy-meta-row" data-field="${escapeAttr(field)}" data-accepted="false">
        <td class="autropy-meta-row__field">${escapeHtml(field)}</td>
        <td class="autropy-meta-row__value">${escapeHtml(String(value))}</td>
        <td class="autropy-meta-row__action">
          <button class="autropy-meta-row__accept">Accept</button>
        </td>
      </tr>`)
      .join('')
  }

  return `
    <section class="autropy-section">
      <table class="autropy-meta-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Suggested value</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${typeRow}${extraRows}</tbody>
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
const PANEL_STYLES = `
<style id="autropy-styles">
  #autropy-panel {
    /* CONFIRMED (dom_injection_test_results.md): absolute overlay at bottom of .esper-container */
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    max-height: 60%;   /* prevents panel from eclipsing the image */
    overflow-y: auto;
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

  .autropy-meta-row__field {
    color: rgb(128,128,128); /* UNVERIFIED: muted text */
    padding: 3px 4px;
    white-space: nowrap;
  }

  .autropy-meta-row__value {
    padding: 3px 8px;
  }

  .autropy-meta-row[data-accepted="true"] .autropy-meta-row__value {
    text-decoration: line-through;
    opacity: 0.5;
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
   * and metadata are. The panel is the scroll container (max-height + overflow
   * -y: auto), and a long AI description pushed these buttons out of view with
   * no way back — keyboard events are deliberately swallowed inside the panel,
   * so there was no way to close it at all. */
  /* A model-written description runs to several lines and would otherwise crowd
   * out every other row. Cap it and let it scroll in place. */
  .autropy-meta-row__value {
    display: block;
    max-height: 4.6em;
    overflow-y: auto;
    overflow-wrap: anywhere;
  }

  .autropy-actions {
    position: sticky;
    bottom: 0;
    z-index: 1;
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    padding: 8px 0 2px;
    margin-top: auto;
    background: rgb(246,246,246);       /* CONFIRMED from DevTools */
    box-shadow: 0 -8px 8px -8px rgba(0,0,0,0.18);
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
      box-shadow: 0 -8px 8px -8px rgba(0,0,0,0.5);
    }

    .autropy-status {
      border-color: rgb(60,60,60);
      background: rgb(46,46,46);
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

// Returns a self-contained HTML string for the review panel.
// Callers:
//   result          — parsed AI response { summary, document_type, possible_tags,
//                     metadata_suggestions, confidence }
//   existingTagNames — array of tag name strings already in the project
//   suggestMetadata  — boolean; controls whether the metadata table is rendered
//
// `result` has already passed validateResult(), so possible_tags is an array and
// confidence is either a number in 0–1 or null.
export function buildPanelHTML (result, existingTagNames, suggestMetadata) {
  const {
    summary = '',
    document_type: docType = 'unknown',
    possible_tags: tags = [],
    metadata_suggestions: metaSuggestions = null,
    confidence = null
  } = result

  const existingSet = new Set(
    (existingTagNames || []).map(n => n.toLowerCase())
  )

  const chips = tags.map(tag =>
    renderChip(tag, existingSet.has(tag.toLowerCase()))
  ).join('')

  // Omitted rather than shown as 0% or NaN% when the model gave no figure.
  const confidencePct = confidence == null ? '' : `${Math.round(confidence * 100)}%`

  // Metadata section always rendered (for the type row); extra rows gated by suggestMetadata
  const metaSection = renderMetadataTable(docType, metaSuggestions, suggestMetadata)

  return `
    ${PANEL_STYLES}
    <div id="autropy-panel">
      <div class="autropy-header">
        <span class="autropy-header__type">${escapeHtml(docType)}</span>
        <span class="autropy-header__confidence">${confidencePct}</span>
      </div>

      <textarea
        id="autropy-summary"
        class="autropy-summary"
        rows="4"
      >${escapeHtml(summary)}</textarea>

      <div class="autropy-chips" id="autropy-chips">
        ${chips}
      </div>

      ${metaSection}

      <div class="autropy-status" id="autropy-status"></div>

      <div class="autropy-actions">
        <button class="autropy-btn" id="autropy-dismiss">Dismiss</button>
        <button class="autropy-btn autropy-btn--primary" id="autropy-apply">Apply accepted</button>
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
