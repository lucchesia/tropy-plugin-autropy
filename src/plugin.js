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
  // PLACEHOLDER: the exact SVG markup and toolbar selector were confirmed during
  //   DevTools console testing. Retrieve the tested version from the console
  //   session and replace this entire method body before first live test.
  //
  // UNVERIFIED ASSUMPTION: the toolbar container is at selector
  //   '.toolbar .toolbar-left' — confirm in DevTools > Elements.
  // UNVERIFIED ASSUMPTION: creating a <button> element and appending to the
  //   toolbar persists across React re-renders (confirmed in DOM tests, but
  //   verify the exact selector still holds for Tropy Beta 1.18).
  // ---------------------------------------------------------------------------
  #injectToolbarToggle () {
    if (this.#toolbarInjected) return

    const toolbar = document.querySelector('.toolbar .toolbar-left') // UNVERIFIED selector
    if (!toolbar) {
      this.context.logger.warn('[AUTROPY] toolbar container not found — toggle not injected')
      return
    }

    const btn = document.createElement('button')
    btn.id = 'autropy-toggle'
    btn.className = 'btn icon-btn'           // UNVERIFIED: Tropy button class
    btn.title = 'AUTROPY — analyze this photo'
    // PLACEHOLDER: replace innerHTML with the exact tested SVG from the console session.
    // The tested icon uses: viewBox="0 0 24 24", stroke-width="1.5",
    // stroke-linecap="round", no fill — matching Tropy's icon visual language.
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16"
      fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <!-- PLACEHOLDER: insert exact tested SVG path data here -->
      <circle cx="12" cy="12" r="9"/>
      <path d="M12 8v4l2 2"/>
    </svg>`

    btn.addEventListener('click', () => {
      const panel = document.getElementById('autropy-panel')
      if (panel) {
        this.#removePanel()
      } else {
        // Re-trigger export on the currently selected item.
        // UNVERIFIED ASSUMPTION: context.emit or similar API exists to trigger
        //   the export hook programmatically from the toolbar click.
        // This path needs DevTools verification — may need a different approach.
        this.context.logger.info('[AUTROPY] toolbar toggle clicked — awaiting export hook')
      }
    })

    toolbar.appendChild(btn)
    this.#toolbarInjected = true
    this.context.logger.info('[AUTROPY] toolbar toggle injected')
  }

  // ---------------------------------------------------------------------------
  // Panel injection and lifecycle
  // ---------------------------------------------------------------------------

  // UNVERIFIED ASSUMPTION: the image column container selector is correct.
  //   Confirmed to exist during DOM testing, but verify selector in DevTools.
  // UNVERIFIED ASSUMPTION: appending the panel to the image column and setting
  //   flex-direction: column on the container causes natural image reflow.
  //   If not, the panel will overlay — acceptable for alpha per build spec.
  #injectPanel (result, existingTagNames, suggestMetadata) {
    this.#removePanel() // remove any stale panel from a previous analysis

    // UNVERIFIED ASSUMPTION: image column container selector.
    // Confirmed to work during DOM testing — verify if Tropy updates its markup.
    const container = document.querySelector('.image-panel .image')
    if (!container) {
      this.context.logger.warn('[AUTROPY] image container not found — panel not injected')
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
