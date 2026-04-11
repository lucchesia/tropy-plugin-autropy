// plugin.js — AUTROPY plugin orchestration
//
// Entry point for the Tropy export hook. Injects a toolbar toggle button,
// runs AI analysis on the active photo, and manages the review panel lifecycle.
//
// CONFIRMED: export hook is the correct trigger — not transcribe. Reasons:
//   - fires on selected items with full photo paths and existing metadata
//   - works on Tropy 1.17 stable and 1.18 Beta
//   - does not misrepresent AI analysis as OCR/transcription
//
// CONFIRMED: writes nothing to Tropy until user presses "Apply accepted".

import { readFileSync } from 'node:fs'
import { analyzeImage } from './api.js'
import {
  fetchExistingTags,
  applyTag,
  writeAnalysisNote,
  fetchItemMetadata
} from './tropy.js'
import { buildPrompt } from './prompt.js'
import { buildPanelHTML } from './panel-template.js'

// Provenance constants — appear in every AUTROPY-generated note.
// CONFIRMED: format is "[AUTROPY] model: <id> | <ISO timestamp> | v<version>"
const AUTROPY_NOTE_MARKER = '[AUTROPY]'
const AUTROPY_VERSION = '0.1.0-alpha.1'

// ---------------------------------------------------------------------------
// Plugin class
// ---------------------------------------------------------------------------

class AutropyPlugin {
  constructor (options, context) {
    this.options = Object.assign({}, AutropyPlugin.defaults, options)
    this.context = context
    this.controller = new AbortController()

    // State held for the duration of an active analysis session.
    // Cleared on dismiss or successful apply.
    this.#state = {
      itemId: null,
      photoId: null,
      result: null,
      existingTags: []
    }
  }

  // Private state — not exposed to Tropy
  #state = {}
  #panelInjected = false
  #toolbarInjected = false

  // ---------------------------------------------------------------------------
  // Export hook — menu trigger entry point
  //
  // CONFIRMED (dom_injection_test_results.md): alpha trigger is toolbar icon click
  //   only. Export hook is kept to provide the File > Export menu item, but
  //   delegates directly to #runAnalysis() rather than reading the items parameter.
  //
  // UNVERIFIED: items parameter shape — array element shape is not confirmed.
  //   Using tropy.state() instead (confirmed working in dom_injection_test_results.md).
  // ---------------------------------------------------------------------------
  async export (items) {
    console.log('[AUTROPY] export called — items:', JSON.stringify(items))
    // ALPHA: items shape unconfirmed. Fall through to tropy.state() path.
    await this.#runAnalysis()
  }

  // ---------------------------------------------------------------------------
  // #runAnalysis — shared analysis entry point for toolbar click and export hook
  //
  // CONFIRMED (dom_injection_test_results.md):
  //   tropy.state().nav.items[0]  → active item ID (integer)
  //   tropy.state().nav.photo     → active photo ID (integer)
  //   tropy.state().photos[id]    → full photo object including .path and .item
  // ---------------------------------------------------------------------------
  async #runAnalysis () {
    let { logger } = this.context
    let { provider, model, apiKey, port, prompt, suggestMetadata } = this.options

    // CONFIRMED: tropy global and Redux state are available in the renderer process
    let state
    try {
      state = tropy.state() // eslint-disable-line no-undef
    } catch (err) {
      logger.warn('[AUTROPY] tropy.state() not available — cannot analyze')
      return
    }

    const photoId = state?.nav?.photo
    const itemId = state?.nav?.items?.[0]

    if (!photoId || !itemId) {
      logger.warn('[AUTROPY] no active photo or item in nav state — cannot analyze')
      return
    }

    // CONFIRMED: photo object in Redux state includes .path (absolute filesystem path)
    const photo = state?.photos?.[photoId]
    if (!photo?.path) {
      logger.warn(`[AUTROPY] photo ${photoId} has no path in state — cannot analyze`)
      return
    }

    logger.warn(`[AUTROPY] starting analysis — item ${itemId}, photo ${photoId}`)

    try {
      // Fetch project tags for grounding the prompt and chip styling
      const existingTags = await fetchExistingTags(port)
      const existingTagNames = existingTags.map(t => t.name)

      // Optionally fetch item metadata for the prompt extension
      let itemMetadata = null
      if (suggestMetadata) {
        itemMetadata = await fetchItemMetadata(port, itemId)
      }

      const finalPrompt = buildPrompt(prompt, existingTagNames, itemMetadata)

      // Read image bytes from disk — images are NOT served via the REST API.
      // CONFIRMED: photo.path is the absolute filesystem path to the image file.
      const imageBuffer = readFileSync(photo.path)
      const base64 = imageBuffer.toString('base64')

      logger.warn(`[AUTROPY] calling ${provider}/${model}...`)
      const result = await analyzeImage(base64, finalPrompt, provider, model, apiKey)
      logger.warn(`[AUTROPY] analysis complete — confidence ${result.confidence}`)

      // Stash state for use by panel event handlers
      this.#state = { itemId, photoId, result, existingTags }

      // Inject the review panel into the Tropy DOM
      this.#injectPanel(result, existingTagNames, suggestMetadata)
    } catch (err) {
      logger.error({ stack: err.stack }, `[AUTROPY] analysis failed: ${err.message}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Toolbar toggle injection
  //
  // CONFIRMED (dom_injection_test_results.md):
  //   - Find the esper tool-group by button titles (locale-aware, not by index)
  //   - Insert AUTROPY as a new div.tool-group BEFORE the esper group
  //   - Do NOT append the btn into an existing group — Tropy's own group click
  //     handlers fire and break the toggle (shows only a CSS flash)
  //   - Toolbar items use <span class="btn btn-md btn-icon">, not <button>
  //   - SVG icon (magnifying glass + sparkle) confirmed rendering at 16×16
  // ---------------------------------------------------------------------------
  #injectToolbarToggle () {
    if (this.#toolbarInjected) return

    // CONFIRMED (2026-04-11, DevTools): esper tool-group is group index 10 and contains
    // "Show full text overlay" — unique to this group. "Maximize this view" also appears
    // in group 16 (note panel) so is ambiguous; use "Show full text overlay" instead.
    let esperGroup = null
    for (const g of document.querySelectorAll('.tool-group')) {
      const titles = [...g.querySelectorAll('.btn')].map(b => b.title)
      if (titles.some(t => t.includes('Show full text overlay') || t.includes('overlay'))) {
        esperGroup = g
        break
      }
    }

    if (!esperGroup) {
      this.context.logger.warn('[AUTROPY] esper toolbar group not found — toggle not injected')
      return
    }

    // CONFIRMED: toolbar items use <span class="btn btn-md btn-icon">
    const btn = document.createElement('span')
    btn.id = 'autropy-toggle'
    btn.className = 'btn btn-md btn-icon'
    btn.title = 'AUTROPY — analyze this photo'
    // CONFIRMED (dom_injection_test_results.md): magnifying glass + sparkle SVG
    // renders correctly at 16×16 in the Tropy Beta toolbar.
    btn.innerHTML = `<span class="icon icon-autropy"><svg width="16" height="16" viewBox="0 0 16 16"><g class="line" fill="currentColor"><path fill-rule="evenodd" d="M6,1a5,5,0,1,0,5,5A5,5,0,0,0,6,1Zm0,8.5A3.5,3.5,0,1,1,9.5,6,3.5,3.5,0,0,1,6,9.5Z"/><path d="M9.2,9.2l5.1,5.1a.5.5,0,0,1-.7.7L8.5,9.9a.5.5,0,0,1,.7-.7Z"/><path d="M6,4.2l.5,1.3L7.8,6l-1.3.5L6,7.8,5.5,6.5,4.2,6l1.3-.5Z"/></g></svg></span>`

    btn.addEventListener('click', () => {
      const panel = document.getElementById('autropy-panel')
      if (panel) {
        this.#removePanel()
        return
      }

      this.#runAnalysis().catch(err => {
        this.context.logger.error(
          { stack: err.stack },
          `[AUTROPY] analysis failed from toolbar click: ${err.message}`
        )
      })
    })

    // CONFIRMED: insert new tool-group BEFORE the esper group (not into it)
    const newGroup = document.createElement('div')
    newGroup.className = 'tool-group'
    newGroup.appendChild(btn)
    esperGroup.parentNode.insertBefore(newGroup, esperGroup)

    this.#toolbarInjected = true
    this.context.logger.warn('[AUTROPY] toolbar toggle injected before esper tool-group')
  }

  // ---------------------------------------------------------------------------
  // Panel injection and lifecycle
  // ---------------------------------------------------------------------------

  // CONFIRMED (dom_injection_test_results.md):
  //   - Inject into '.esper-container' (the image viewer div), NOT section.esper
  //   - Panel positioned as position:absolute; bottom:0; left:0; right:0
  //   - Set container to position:relative if static (required for absolute child)
  //   - max-height:60% prevents panel from eclipsing the full image
  //   - .esper-container is stable across React re-renders — injection persists
  //   - Do NOT inject as flex sibling of .esper-container — disrupts flex layout
  #injectPanel (result, existingTagNames, suggestMetadata) {
    this.#removePanel() // remove any stale panel from a previous analysis

    // CONFIRMED: .esper-container is the image viewer div
    const container = document.querySelector('.esper-container')
    if (!container) {
      this.context.logger.warn('[AUTROPY] .esper-container not found — panel not injected')
      return
    }

    // Ensure container can position absolute children
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative'
    }

    const wrapper = document.createElement('div')
    wrapper.innerHTML = buildPanelHTML(result, existingTagNames, suggestMetadata)

    // Append styles (idempotent — buildPanelHTML includes <style id="autropy-styles">)
    if (!document.getElementById('autropy-styles')) {
      document.head.appendChild(wrapper.querySelector('style'))
    }

    const panel = wrapper.querySelector('#autropy-panel')
    container.appendChild(panel)
    this.#panelInjected = true

    this.#wirePanelEvents()
    this.context.logger.warn('[AUTROPY] review panel injected into .esper-container')
  }

  #wirePanelEvents () {
    // Chip toggle — flip data-accepted on click
    document.querySelectorAll('.autropy-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const current = chip.dataset.accepted === 'true'
        chip.dataset.accepted = String(!current)
      })
      chip.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          chip.click()
        }
      })
    })

    // Metadata row accept buttons
    document.querySelectorAll('.autropy-meta-row__accept').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.autropy-meta-row')
        if (row) row.dataset.accepted = 'true'
      })
    })

    // Apply accepted
    const applyBtn = document.getElementById('autropy-apply')
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        this.#applyAccepted().catch(err => {
          this.context.logger.error(
            { stack: err.stack },
            `[AUTROPY] apply failed: ${err.message}`
          )
        })
      })
    }

    // Dismiss
    const dismissBtn = document.getElementById('autropy-dismiss')
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => this.#dismissPanel())
    }
  }

  async #applyAccepted () {
    let { logger } = this.context
    let { port } = this.options
    let { itemId, photoId } = this.#state

    if (!itemId || !photoId) {
      throw new Error('[AUTROPY] #applyAccepted called with no active item/photo state')
    }

    // Collect accepted tag names from chip state
    const acceptedTags = []
    document.querySelectorAll('.autropy-chip[data-accepted="true"]').forEach(chip => {
      acceptedTags.push(chip.dataset.tag)
    })

    // Collect accepted metadata field values
    // UNVERIFIED ASSUMPTION: metadata write-back via REST API uses the same
    //   /project/data/<id> endpoint with PATCH or PUT. Not yet confirmed —
    //   metadata apply is a no-op until the write endpoint is verified.
    const acceptedMeta = {}
    document.querySelectorAll('.autropy-meta-row[data-accepted="true"]').forEach(row => {
      const field = row.dataset.field
      const value = row.querySelector('.autropy-meta-row__value')?.textContent
      if (field && value) acceptedMeta[field] = value
    })

    // Read the (possibly edited) summary from the textarea
    const summary = document.getElementById('autropy-summary')?.value || ''

    // Re-fetch existing tags so applyTag can check for name collisions
    const existingTags = await fetchExistingTags(port)

    // Write accepted tags
    for (const tagName of acceptedTags) {
      try {
        await applyTag(port, itemId, tagName, existingTags)
        logger.info(`[AUTROPY] applied tag "${tagName}" to item ${itemId}`)
      } catch (err) {
        logger.warn(
          { stack: err.stack },
          `[AUTROPY] tag write failed for "${tagName}": ${err.message}`
        )
      }
    }

    // Write analysis note with provenance footer
    await writeAnalysisNote(
      port,
      photoId,
      summary,
      this.options.model,
      AUTROPY_VERSION
    )
    logger.info(`[AUTROPY] note written to photo ${photoId}`)

    if (Object.keys(acceptedMeta).length > 0) {
      // UNVERIFIED ASSUMPTION: metadata write endpoint exists.
      // Logging intent only — no write until endpoint is confirmed.
      logger.warn(
        '[AUTROPY] metadata write-back not yet implemented — accepted metadata logged only:',
        acceptedMeta
      )
    }

    this.#removePanel()
    logger.info(`[AUTROPY] apply complete — item ${itemId}`)
  }

  #dismissPanel () {
    this.context.logger.info(
      `[AUTROPY] dismissed — item ${this.#state.itemId}, no writes made`
    )
    this.#removePanel()
  }

  #removePanel () {
    document.getElementById('autropy-panel')?.remove()
    this.#panelInjected = false
    this.#state = { itemId: null, photoId: null, result: null, existingTags: [] }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async load () {
    // Retry toolbar injection until the esper DOM is ready.
    // CONFIRMED: load() fires before Tropy has rendered the toolbar — a direct
    // call to #injectToolbarToggle() at this point finds no .tool-group elements
    // and silently no-ops. Retry with 500 ms intervals for up to 10 seconds.
    this.#scheduleToolbarInjection(0)
  }

  #scheduleToolbarInjection (attempts) {
    if (this.#toolbarInjected) return
    if (attempts > 20) {
      this.context.logger.warn('[AUTROPY] toolbar not injected after 20 attempts — DOM never became ready')
      return
    }
    this.#injectToolbarToggle()
    if (!this.#toolbarInjected) {
      setTimeout(() => this.#scheduleToolbarInjection(attempts + 1), 500)
    }
  }

  async unload () {
    this.controller.abort()
    // CONFIRMED: button is wrapped in a new .tool-group — remove the wrapper, not just the btn
    document.getElementById('autropy-toggle')?.closest('.tool-group')?.remove()
    document.getElementById('autropy-panel')?.remove()
    document.getElementById('autropy-styles')?.remove()
    this.#toolbarInjected = false
    this.#panelInjected = false
  }
}

// ---------------------------------------------------------------------------
// Defaults — merged with per-instance options from package.json at runtime
// ---------------------------------------------------------------------------

AutropyPlugin.defaults = {
  instanceName: '',
  provider: '',
  model: '',
  apiKey: '',
  port: 2029,
  suggestMetadata: false,
  prompt: ''
}

module.exports = AutropyPlugin
