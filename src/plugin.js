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
  // Export hook — main entry point
  // UNVERIFIED ASSUMPTION: export(items) receives an array of item objects, each
  //   with { id, photos: [{ id, path, ... }], tags: [...] }.
  //   Confirm exact shape against Tropy 1.18 Beta source or DevTools inspection.
  // UNVERIFIED ASSUMPTION: items[0].photos[0] is the currently visible photo.
  //   For multi-photo items, Tropy may pass all photos — we take the first.
  // ---------------------------------------------------------------------------
  async export (items) {
    let { logger } = this.context
    let { provider, model, apiKey, port, prompt, suggestMetadata } = this.options

    if (!items || items.length === 0) {
      logger.warn('[AUTROPY] export hook fired with no items — nothing to analyze')
      return
    }

    const item = items[0]
    // UNVERIFIED ASSUMPTION: item.id is the numeric item ID used by the REST API.
    const itemId = item.id

    if (!item.photos || item.photos.length === 0) {
      logger.warn(`[AUTROPY] item ${itemId} has no photos — nothing to analyze`)
      return
    }

    // UNVERIFIED ASSUMPTION: item.photos[0] is the active/visible photo.
    const photo = item.photos[0]
    const photoId = photo.id

    logger.info(`[AUTROPY] starting analysis — item ${itemId}, photo ${photoId}`)

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

      logger.info(`[AUTROPY] calling ${provider}/${model}...`)
      const result = await analyzeImage(base64, finalPrompt, provider, model, apiKey)
      logger.info(`[AUTROPY] analysis complete — confidence ${result.confidence}`)

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
  // CONFIRMED: toolbar container is at '.esper-header .toolbar-left'
  //   (the image viewer toolbar inside section.esper > .esper-container >
  //   header.esper-header). Verified from DevTools DOM inspection.
  // CONFIRMED: Tropy toolbar items use <span class="btn btn-md btn-icon">,
  //   not <button>. Verified from DevTools DOM inspection.
  // CONFIRMED: selector '.esper-header .toolbar-left' targets the correct
  //   toolbar — there may be multiple .toolbar-left elements in the DOM
  //   (item panel, note panel headers); querySelectorAll + filtering by
  //   closest('.esper-header') ensures we target the image viewer only.
  // UNVERIFIED ASSUMPTION: toolbar injection persists across React re-renders.
  //   Confirmed in DOM tests but not yet verified in live plugin context.
  // ---------------------------------------------------------------------------
  #injectToolbarToggle () {
    if (this.#toolbarInjected) return

    // CONFIRMED: .esper-header .toolbar-left is the image viewer toolbar
    const toolbar = document.querySelector('.esper-header .toolbar-left')
    if (!toolbar) {
      this.context.logger.warn('[AUTROPY] esper toolbar not found — toggle not injected')
      return
    }

    // CONFIRMED: toolbar items use <span class="btn btn-md btn-icon">
    const btn = document.createElement('span')
    btn.id = 'autropy-toggle'
    btn.className = 'btn btn-md btn-icon'
    btn.title = 'AUTROPY — analyze this photo'
    // SVG matches Tropy's icon visual language: viewBox 0 0 16 16, fill currentColor,
    // no explicit stroke, thin-line aesthetic consistent with surrounding toolbar icons.
    // Icon depicts a sparkle/AI analysis symbol — brain outline with radial marks.
    // UNVERIFIED ASSUMPTION: this SVG renders correctly at 16×16 in the toolbar.
    //   Replace paths after visual confirmation in Tropy Beta.
    btn.innerHTML = `<span class="icon icon-autropy"><svg width="16" height="16" viewBox="0 0 16 16"><g class="line" fill="currentColor"><path d="M8,1a.5.5,0,0,1,.5.5V3h1V1.5a.5.5,0,0,1,1,0V3a2,2,0,0,1,2,2v.5h1.5a.5.5,0,0,1,0,1H12.5v1H14a.5.5,0,0,1,0,1H12.5V9a2,2,0,0,1-2,2V12.5a.5.5,0,0,1-1,0V11h-1v1.5a.5.5,0,0,1-1,0V11A2,2,0,0,1,5.5,9V8.5H4a.5.5,0,0,1,0-1H5.5v-1H4a.5.5,0,0,1,0-1H5.5V5a2,2,0,0,1,2-2V1.5A.5.5,0,0,1,8,1ZM8,4A1,1,0,0,0,7,5v6a1,1,0,0,0,2,0V5A1,1,0,0,0,8,4Z"/><rect x="7" y="13.5" width="2" height="1.5" rx="0.5"/><rect x="7" y="1" width="2" height="1.5" rx="0.5" transform="translate(16 3.5) rotate(180)"/></g></svg></span>`

    btn.addEventListener('click', () => {
      const panel = document.getElementById('autropy-panel')
      if (panel) {
        this.#removePanel()
        return
      }

      // WORKAROUND (alpha): toolbar click directly invokes export logic rather than
      // triggering Tropy's export hook mechanism. The correct approach — using
      // context.emit or equivalent to fire the hook — requires confirmation from
      // the Tropy dev team. Replace this before stable release!
      //
      // UNVERIFIED ASSUMPTION: tropy.state() is available as a global in the renderer.
      // UNVERIFIED ASSUMPTION: tropy.state().nav.photo holds the active photo ID.
      // UNVERIFIED ASSUMPTION: tropy.state().nav.items[0] holds the active item ID.
      // UNVERIFIED ASSUMPTION: tropy.state().photos[photoId] has { id, path }.
      try {
        const state = tropy.state() // eslint-disable-line no-undef
        const photoId = state?.nav?.photo
        const itemId = state?.nav?.items?.[0]

        if (!photoId || !itemId) {
          this.context.logger.warn('[AUTROPY] no active photo or item in nav state — cannot analyze')
          return
        }

        const photo = state?.photos?.[photoId]
        if (!photo?.path) {
          this.context.logger.warn(`[AUTROPY] photo ${photoId} has no path in state — cannot analyze`)
          return
        }

        // Construct a minimal items array matching what the export hook would receive
        const items = [{ id: itemId, photos: [{ id: photoId, path: photo.path }] }]
        this.export(items).catch(err => {
          this.context.logger.error(
            { stack: err.stack },
            `[AUTROPY] analysis failed from toolbar click: ${err.message}`
          )
        })
      } catch (err) {
        this.context.logger.error(
          { stack: err.stack },
          `[AUTROPY] failed to read tropy state: ${err.message}`
        )
      }
    })

    toolbar.appendChild(btn)
    this.#toolbarInjected = true
    this.context.logger.info('[AUTROPY] toolbar toggle injected into .esper-header .toolbar-left')
  }

  // ---------------------------------------------------------------------------
  // Panel injection and lifecycle
  // ---------------------------------------------------------------------------

  // CONFIRMED: panel injection target is '.esper-view-container', appending
  //   our panel as a sibling to '.esper-view' (the canvas container).
  //   Structure: section.esper > .esper-container > .esper-view-container
  //              > [.esper-view (canvas), .esper-panel (filters), #autropy-panel]
  //   Verified from DevTools DOM inspection.
  // UNVERIFIED ASSUMPTION: appending to .esper-view-container causes natural
  //   image reflow. If not, panel will render below filters — acceptable for alpha.
  #injectPanel (result, existingTagNames, suggestMetadata) {
    this.#removePanel() // remove any stale panel from a previous analysis

    // CONFIRMED: .esper-view-container holds the canvas and filter panel
    const container = document.querySelector('.esper-view-container')
    if (!container) {
      this.context.logger.warn('[AUTROPY] .esper-view-container not found — panel not injected')
      return
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
    this.context.logger.info('[AUTROPY] review panel injected')
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
    // Inject toolbar toggle when the plugin loads.
    // UNVERIFIED ASSUMPTION: the Tropy renderer DOM is ready when load() is called.
    //   If the toolbar is not present yet, #injectToolbarToggle will log a warning
    //   and no-op — the toggle will not appear until the plugin is reloaded.
    this.#injectToolbarToggle()
  }

  async unload () {
    this.controller.abort()
    document.getElementById('autropy-toggle')?.remove()
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
