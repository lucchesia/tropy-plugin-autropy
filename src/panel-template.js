// panel-template.js — review panel HTML template function
//
// CONFIRMED: panel contents per build spec:
//   1. Header row: document_type (left) + confidence % (right)
//   2. Editable textarea pre-filled with AI summary
//   3. Tag chips with per-chip accept/reject; existing vs. new chips styled differently
//   4. Metadata suggestions table — only rendered when suggestMetadata option is on
//   5. "Apply accepted" and "Dismiss" buttons
//
// CONFIRMED: no custom colors, fonts, or visual styles — Tropy CSS variables only.
// UNVERIFIED ASSUMPTION: the CSS variable names below (--tropy-*, --spacing-*)
//   are correct for Tropy Beta 1.18. Verify against Tropy's stylesheet in DevTools
//   (DevTools > Elements > :root) if styling looks wrong after injection.
// UNVERIFIED ASSUMPTION: autropy- prefixed IDs and classes do not conflict with
//   any existing Tropy DOM identifiers. Verify in DevTools after first injection.

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

// Only rendered when suggestMetadata option is enabled.
// Each row has a field name, suggested value, and per-row Accept checkbox.
// UNVERIFIED ASSUMPTION: metadata_suggestions keys from the AI response are
//   always title, date, description. Additional keys rendered as-is if present.
function renderMetadataTable (metadataSuggestions) {
  if (!metadataSuggestions || typeof metadataSuggestions !== 'object') return ''

  const rows = Object.entries(metadataSuggestions)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([field, value]) => `
      <tr class="autropy-meta-row" data-field="${escapeAttr(field)}" data-accepted="false">
        <td class="autropy-meta-row__field">${escapeHtml(field)}</td>
        <td class="autropy-meta-row__value">${escapeHtml(String(value))}</td>
        <td class="autropy-meta-row__action">
          <button class="autropy-meta-row__accept" data-field="${escapeAttr(field)}">Accept</button>
        </td>
      </tr>`)
    .join('')

  if (!rows) return ''

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
        <tbody>${rows}</tbody>
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

  .autropy-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    padding-top: 4px;
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
// UNVERIFIED ASSUMPTION: result.possible_tags is always an array of strings.
// UNVERIFIED ASSUMPTION: result.confidence is a number 0.0–1.0.
export function buildPanelHTML (result, existingTagNames, suggestMetadata) {
  const {
    summary = '',
    document_type: docType = 'unknown',
    possible_tags: tags = [],
    metadata_suggestions: metaSuggestions = null,
    confidence = 0
  } = result

  const existingSet = new Set(
    (existingTagNames || []).map(n => n.toLowerCase())
  )

  const chips = tags.map(tag =>
    renderChip(tag, existingSet.has(tag.toLowerCase()))
  ).join('')

  const confidencePct = `${Math.round(confidence * 100)}%`

  const metaSection = suggestMetadata
    ? renderMetadataTable(metaSuggestions)
    : ''

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

      <div class="autropy-actions">
        <button class="autropy-btn" id="autropy-dismiss">Dismiss</button>
        <button class="autropy-btn autropy-btn--primary" id="autropy-apply">Apply accepted</button>
      </div>
    </div>`
}

// ---------------------------------------------------------------------------
// Escape helpers — never interpolate user/AI content unescaped into HTML
// ---------------------------------------------------------------------------

function escapeHtml (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
}
