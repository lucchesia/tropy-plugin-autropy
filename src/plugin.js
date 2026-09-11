// plugin.js — Autropy plugin orchestration.
//
// Entry point for the Tropy export hook. Injects a toolbar toggle, runs AI
// analysis on the active photo, and manages the review panel lifecycle.
//
// The export hook is the right trigger — not transcribe — because it fires on
// selected items with full photo paths and existing metadata, and does not
// misrepresent AI analysis as OCR.
//
// The resulting menu item reads "File → Export → Autropy", which is misleading:
// this is analysis, not a file export. Tropy derives the label from productName
// and `hooks: {export: true}` takes only a boolean, so it cannot be changed from
// here. This is a shared constraint — tropy-plugin-segmenter documents the same
// one: plugins can only appear in the import, export, extract and transcribe
// menus, so export is the only place an item-scoped action can live.
//
// Nothing is written to Tropy until the researcher presses "Apply accepted".

import { readFileSync } from 'node:fs'
// Imported rather than duplicated as a constant: the version previously lived
// in four places and had already drifted (the installed build said alpha.1
// while the repo said alpha.2), which corrupts note provenance.
import { version as AUTROPY_VERSION } from '../package.json'
import { analyzeImage } from './api.js'
import {
  ACKNOWLEDGED,
  ProjectIdentityError,
  REJECTED,
  RestProjectGateway,
  UNKNOWN
} from './gateway.js'
import { buildPrompt } from './prompt.js'
import { buildPanelHTML, renderStatusLines } from './panel-template.js'
import { escapeHtml, textToParagraphs } from './html.js'

const AUTROPY_NOTE_MARKER = '[AUTROPY]'

const DEFAULT_PORT = 2029
const NAV_POLL_MS = 300

// Tropy's option form yields strings, and `Number(x) || DEFAULT` would accept
// -5 and 3.7 as ports.
function resolvePort (value) {
  const n = Number(value)
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n
  return DEFAULT_PORT
}

class AutropyPlugin {
  constructor (options, context) {
    this.options = Object.assign({}, AutropyPlugin.defaults, options)
    this.context = context
  }

  #state = { itemId: null, photoId: null, result: null, existingTags: [] }
  #panelInjected = false
  #toolbarInjected = false
  #domObserver = null
  #navUnsub = null
  #analysisCache = new Map()   // photoId → cached analysis, avoids paying twice

  #gateway = null
  #activeRun = null            // { id, controller, itemId, photoId } while analyzing
  #runCounter = 0
  #notices = []                // status lines for the panel
  #retryable = []              // rejected writes only — never notes

  // ── Tropy state access ───────────────────────────────────────────────────

  // `context.window.store` is the plugin's own window's Redux store, which is
  // the only trustworthy answer to "which project am I in": the REST API's
  // `current` means the FRONTMOST window, which may not be this one.
  //
  // It is an escape hatch rather than a supported API — tropy-plugin-segmenter
  // says as much — so every use is guarded and degrades rather than throwing.
  #store () {
    const store = this.context?.window?.store
    return (store && typeof store.getState === 'function') ? store : null
  }

  #getState () {
    const store = this.#store()
    if (store) return store.getState()

    try {
      return tropy.state() // eslint-disable-line no-undef
    } catch {
      return null
    }
  }

  #projectPath () {
    return this.#getState()?.project?.path ?? null
  }

  // The photo is authoritative for which item we are on: `nav.items[0]` is the
  // first item in *click* order, which need not be the item owning this photo.
  #readNav (state = this.#getState()) {
    const photoId = state?.nav?.photo
    const photo = photoId ? state?.photos?.[photoId] : null
    const itemId = photo?.item ?? state?.nav?.items?.[0] ?? null
    return { itemId, photoId: photoId ?? null, photo }
  }

  #gatewayFor (projectPath, port) {
    if (this.#gateway?.projectPath === projectPath && this.#gateway?.port === port) {
      return this.#gateway
    }

    this.#gateway = new RestProjectGateway({
      projectPath,
      port,
      logger: this.context.logger
    })

    return this.#gateway
  }

  // ── export hook ──────────────────────────────────────────────────────────

  // The `items` argument is a JSON-LD object whose graph carries no numeric ids,
  // so it cannot be used for REST writes. State is read instead.
  async export (items) {
    this.context.logger.warn(
      `[AUTROPY] export hook fired — ${items?.['@graph']?.length ?? 0} item(s) in payload`)
    await this.#runAnalysis()
  }

  // ── analysis ─────────────────────────────────────────────────────────────

  async #runAnalysis () {
    this.#injectToolbarToggle()

    const { logger } = this.context
    const { model, apiKey, prompt, suggestMetadata, outputLanguage } = this.options
    const port = resolvePort(this.options.port)

    // One analysis at a time. Without this, impatient clicks before the panel
    // appears each start their own billed request.
    if (this.#activeRun) {
      logger.warn('[AUTROPY] analysis already running — ignoring this click')
      return
    }

    const { itemId, photoId, photo } = this.#readNav()

    if (!photoId || !itemId) {
      this.#fatal(
        'No photo selected',
        'Select an item and open one of its photos, then click the Autropy icon.')
      return
    }

    if (!photo?.path) {
      this.#fatal(
        'This photo has no file',
        `Tropy has no file path for photo ${photoId}, so there is nothing to analyze.`)
      return
    }

    const cached = this.#analysisCache.get(photoId)
    if (cached) {
      logger.warn(`[AUTROPY] using cached analysis for photo ${photoId}`)
      this.#notices = cached.notices.slice()
      this.#showResult(cached, itemId, photoId)
      return
    }

    const runId = ++this.#runCounter
    const controller = new AbortController()
    this.#activeRun = { id: runId, controller, itemId, photoId }
    this.#notices = []
    this.#watchNav()

    logger.warn(`[AUTROPY] starting analysis — item ${itemId}, photo ${photoId}`)

    try {
      const gateway = this.#gatewayFor(this.#projectPath(), port)

      // Both reads only enrich the prompt, so neither is allowed to end the
      // run. Before this, a failing metadata read — which is exactly what
      // Tropy beta.5 caused — aborted the whole analysis with no visible sign.
      const existingTags = await this.#readOrDegrade(
        () => gateway.getTags(), [],
        'Existing project tags could not be read, so every suggested tag shows as new.')

      const existingTagNames = existingTags.map(t => t.name)

      let itemMetadata = null
      if (suggestMetadata) {
        itemMetadata = await this.#readOrDegrade(
          () => gateway.getMetadata(itemId), null,
          'This item\'s existing metadata could not be read, so suggestions may repeat values already recorded.')
      }

      const finalPrompt = buildPrompt(prompt, existingTagNames, itemMetadata, outputLanguage)

      // Images are read from disk: the photo object carries an absolute path.
      const base64 = readFileSync(photo.path).toString('base64')

      logger.warn(`[AUTROPY] calling model: ${model}...`)
      const result = await analyzeImage(base64, finalPrompt, model, apiKey, {
        mediaType: photo.mimetype,
        signal: controller.signal
      })

      logger.warn(
        `[AUTROPY] analysis complete — confidence ${result.confidence ?? 'not reported'}`)

      // The run may have been superseded while the model was working. Showing
      // it now would put one photo's analysis over a different photo.
      if (this.#activeRun?.id !== runId) {
        logger.warn('[AUTROPY] analysis finished after navigating away — discarding result')
        return
      }

      const current = this.#readNav()
      if (current.photoId !== photoId || current.itemId !== itemId) {
        logger.warn('[AUTROPY] active photo changed during analysis — discarding result')
        return
      }

      const entry = {
        result,
        existingTagNames,
        existingTags,
        suggestMetadata,
        notices: this.#notices.slice()
      }

      this.#analysisCache.set(photoId, entry)
      this.#showResult(entry, itemId, photoId)
    } catch (err) {
      if (controller.signal.aborted) {
        logger.warn('[AUTROPY] analysis cancelled')
        return
      }

      logger.error({ stack: err.stack }, `[AUTROPY] analysis failed: ${err.message}`)
      this.#fatal('Autropy could not analyze this photo', err.message)
    } finally {
      if (this.#activeRun?.id === runId) this.#activeRun = null
    }
  }

  // Runs a prompt-enriching read, downgrading failure to a notice.
  async #readOrDegrade (read, fallback, notice) {
    try {
      return await read()
    } catch (err) {
      this.context.logger.warn(`[AUTROPY] degraded read: ${err.message}`)
      this.#notices.push({ kind: 'info', text: notice })
      return fallback
    }
  }

  #showResult (entry, itemId, photoId) {
    // #injectPanel clears #state via #removePanel, so #state is set afterwards;
    // the Apply handler and the nav watcher both read it.
    this.#injectPanel(entry.result, entry.existingTagNames, entry.suggestMetadata)
    this.#state = {
      itemId,
      photoId,
      result: entry.result,
      existingTags: entry.existingTags || []
    }
    this.#watchNav()
    this.#renderStatus()
  }

  // ── toolbar ──────────────────────────────────────────────────────────────

  // Finds the esper tool group by icon CSS class rather than button title, so
  // injection is locale-independent (button titles are translated).
  //
  // A `#toolbarInjected` flag is not sufficient on its own: React re-renders can
  // remove the injected node while leaving the flag set, which would silently
  // skip re-injection forever.
  #injectToolbarToggle () {
    if (this.#toolbarInjected) {
      if (document.getElementById('autropy-toggle')) return
      this.#toolbarInjected = false
      this.context.logger.warn('[AUTROPY] toolbar toggle was removed from DOM — re-injecting')
    }

    let esperGroup = null
    for (const g of document.querySelectorAll('.tool-group')) {
      if (g.querySelector('.icon-transcription-large, .icon-transcription-split-view')) {
        esperGroup = g
        break
      }
    }

    // Not an error: the esper toolbar only exists once an item with a photo is
    // selected. load() watches for it with a MutationObserver.
    if (!esperGroup) return

    // Tropy's icon toolbar items are <span class="btn btn-md btn-icon">.
    const btn = document.createElement('span')
    btn.id = 'autropy-toggle'
    btn.className = 'btn btn-md btn-icon'
    btn.title = 'Autropy — analyze this photo'
    btn.innerHTML = `<span class="icon icon-autropy"><svg width="16" height="16" viewBox="0 0 16 16"><g class="line" fill="currentColor"><path fill-rule="evenodd" d="M6,1a5,5,0,1,0,5,5A5,5,0,0,0,6,1Zm0,8.5A3.5,3.5,0,1,1,9.5,6,3.5,3.5,0,0,1,6,9.5Z"/><path d="M9.2,9.2l5.1,5.1a.5.5,0,0,1-.7.7L8.5,9.9a.5.5,0,0,1,.7-.7Z"/><path d="M6,4.2l.5,1.3L7.8,6l-1.3.5L6,7.8,5.5,6.5,4.2,6l1.3-.5Z"/></g></svg></span>`

    btn.addEventListener('click', () => {
      const panel = document.getElementById('autropy-panel')
      if (panel) {
        // Show/hide only — never re-analyze. Re-analysis happens when the
        // photo changes, which closes the panel.
        panel.style.display = panel.style.display === 'none' ? '' : 'none'
        return
      }

      this.#runAnalysis().catch(err => {
        this.context.logger.error(
          { stack: err.stack }, `[AUTROPY] analysis failed: ${err.message}`)
      })
    })

    // Insert as a NEW tool-group before the esper group. Appending into the
    // existing group lets Tropy's own group handlers fire and break the toggle.
    const newGroup = document.createElement('div')
    newGroup.className = 'tool-group'
    newGroup.appendChild(btn)
    esperGroup.parentNode.insertBefore(newGroup, esperGroup)

    this.#toolbarInjected = true
    this.context.logger.warn('[AUTROPY] toolbar toggle injected before esper tool-group')
  }

  // ── panel ────────────────────────────────────────────────────────────────

  // Injects into `.esper-container` (stable across React re-renders) as an
  // absolutely positioned child. Injecting as a flex sibling breaks the layout.
  #injectPanel (result, existingTagNames, suggestMetadata) {
    this.#removePanel()

    const container = document.querySelector('.esper-container')
    if (!container) {
      // Cannot be reported in the panel — the panel needs this container.
      this.#fatal(
        'Autropy could not open its panel',
        'The Tropy image viewer was not found on screen. Open a photo in the ' +
        'item view and try again.')
      return
    }

    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative'
    }

    const wrapper = document.createElement('div')
    wrapper.innerHTML = buildPanelHTML(result, existingTagNames, suggestMetadata)

    if (!document.getElementById('autropy-styles')) {
      document.head.appendChild(wrapper.querySelector('style'))
    }

    container.appendChild(wrapper.querySelector('#autropy-panel'))
    this.#panelInjected = true

    this.#wirePanelEvents()
    this.context.logger.warn('[AUTROPY] review panel injected into .esper-container')
  }

  #wirePanelEvents () {
    // Keyboard isolation. Esper registers onKeyDown on section.esper via React
    // synthetic events and has no editable-field check, so without this every
    // keystroke in the textarea also triggers an image shortcut. Events that
    // stop before reaching the React root never reach those handlers.
    //
    // keyup matters too: Tropy releases the quicktool on keyup, so space would
    // activate panning even when the textarea handled the keydown correctly.
    const blockEsper = e => {
      e.stopPropagation()
      e.stopImmediatePropagation()
    }

    const panel = document.getElementById('autropy-panel')
    if (panel) {
      panel.addEventListener('keydown', blockEsper)
      panel.addEventListener('keyup', blockEsper)
    }

    const summary = document.getElementById('autropy-summary')
    if (summary) {
      summary.addEventListener('keydown', blockEsper)
      summary.addEventListener('keyup', blockEsper)
      // Without focus here, focus stays on section.esper and all keys are
      // treated as image shortcuts.
      summary.focus()
    }

    document.querySelectorAll('.autropy-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.dataset.accepted = String(chip.dataset.accepted !== 'true')
      })
      chip.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          chip.click()
        }
      })
    })

    document.querySelectorAll('.autropy-meta-row__accept').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.autropy-meta-row')
        if (!row) return
        const accepted = row.dataset.accepted === 'true'
        row.dataset.accepted = String(!accepted)
        btn.textContent = accepted ? 'Accept' : 'Undo'
      })
    })

    document.getElementById('autropy-apply')?.addEventListener('click', () => {
      this.#applyAccepted().catch(err => {
        this.context.logger.error({ stack: err.stack }, `[AUTROPY] apply failed: ${err.message}`)
        this.#notices.push({ kind: 'warn', text: err.message })
        this.#renderStatus()
      })
    })

    document.getElementById('autropy-dismiss')?.addEventListener('click', () => {
      this.#dismissPanel()
    })
  }

  // ── navigation watching ──────────────────────────────────────────────────

  // Cancels an in-flight analysis and closes a stale panel when the researcher
  // navigates away.
  //
  // Uses store.subscribe — confirmed available and used by tropy-plugin-segmenter
  // — falling back to polling only when the store escape hatch is missing.
  #watchNav () {
    this.#navUnsub?.()
    this.#navUnsub = null

    if (!this.#activeRun && !this.#state.photoId) return

    const check = () => {
      const state = this.#getState()
      if (!state?.nav) return

      const { itemId, photoId } = this.#readNav(state)

      const run = this.#activeRun
      if (run && (run.photoId !== photoId || run.itemId !== itemId)) {
        this.context.logger.warn('[AUTROPY] navigation changed during analysis — cancelling')
        run.controller.abort()
        this.#activeRun = null
      }

      if (this.#panelInjected && this.#state.photoId &&
          (this.#state.photoId !== photoId || this.#state.itemId !== itemId)) {
        this.context.logger.warn('[AUTROPY] navigation changed — closing stale panel')
        this.#removePanel()
      }
    }

    const store = this.#store()
    if (store && typeof store.subscribe === 'function') {
      this.#navUnsub = store.subscribe(check)
      return
    }

    const interval = setInterval(check, NAV_POLL_MS)
    this.#navUnsub = () => clearInterval(interval)
  }

  // ── status area ──────────────────────────────────────────────────────────

  #renderStatus () {
    const area = document.getElementById('autropy-status')
    if (!area) return

    area.innerHTML = renderStatusLines(this.#notices)

    if (this.#retryable.length > 0) {
      const retry = document.createElement('button')
      retry.className = 'autropy-btn'
      retry.id = 'autropy-retry'
      retry.textContent = `Retry ${this.#retryable.length} failed write(s)`
      retry.addEventListener('click', () => {
        this.#applyAccepted({ only: this.#retryable.slice() }).catch(err => {
          this.context.logger.error({ stack: err.stack }, `[AUTROPY] retry failed: ${err.message}`)
        })
      })
      area.appendChild(retry)
    }
  }

  // Turns a gateway outcome into a status line, and records it for retry when —
  // and only when — repeating it is safe.
  #recordOutcome (outcome, { retry } = {}) {
    if (!outcome) return

    const { status, describe, detail, targetChanged } = outcome

    if (status === ACKNOWLEDGED) {
      this.#notices.push({ kind: 'ok', text: `Done: ${describe}.` })

      if (targetChanged) {
        this.#notices.push({
          kind: 'unknown',
          text: 'The frontmost project changed during this write — please confirm ' +
                'it landed in the project you meant.'
        })
      }
      return
    }

    if (status === REJECTED) {
      this.#notices.push({ kind: 'warn', text: `Tropy refused: ${describe} (${detail}).` })
      if (retry) this.#retryable.push(retry)
      return
    }

    if (status === UNKNOWN) {
      // No retry offered. A note that may already exist must not be written
      // twice, and we cannot tell from here whether it landed.
      this.#notices.push({
        kind: 'unknown',
        text: `Unconfirmed: ${describe}. The connection to Tropy dropped, so this ` +
              'may or may not have been saved — check in Tropy before trying again.'
      })
    }
  }

  // ── apply ────────────────────────────────────────────────────────────────

  async #applyAccepted ({ only = null } = {}) {
    const { logger } = this.context
    const { itemId, photoId } = this.#state
    const port = resolvePort(this.options.port)

    if (!itemId || !photoId) {
      throw new Error('[AUTROPY] nothing to apply — no active item or photo')
    }

    // The panel may have sat open for minutes while the summary was edited, so
    // neither the analysed photo nor the write target can be assumed current.
    const current = this.#readNav()
    if (current.photoId !== photoId || current.itemId !== itemId) {
      this.#fatal(
        'Nothing was written',
        'The photo on screen is no longer the one that was analyzed, so Autropy ' +
        'stopped rather than write to the wrong item. Re-run the analysis.')
      this.#removePanel()
      return
    }

    const gateway = this.#gatewayFor(this.#projectPath(), port)

    try {
      await gateway.assertWriteTarget()
    } catch (err) {
      logger.error({ stack: err.stack }, `[AUTROPY] refused to write: ${err.message}`)
      this.#fatal('Nothing was written', err.message)
      return
    }

    this.#retryable = []
    if (!only) this.#notices = this.#notices.filter(n => n.kind === 'info')

    const tagNames = only
      ? only.filter(r => r.kind === 'tag').map(r => r.name)
      : [...document.querySelectorAll('.autropy-chip[data-accepted="true"]')]
          .map(chip => chip.dataset.tag)

    const acceptedMeta = only
      ? Object.assign({}, ...only.filter(r => r.kind === 'metadata').map(r => r.fields))
      : Object.fromEntries(
          [...document.querySelectorAll('.autropy-meta-row[data-accepted="true"]')]
            .map(row => [
              row.dataset.field,
              row.querySelector('.autropy-meta-row__value')?.textContent
            ])
            .filter(([field, value]) => field && value))

    const summary = document.getElementById('autropy-summary')?.value || ''

    // Re-read tags so tag ids are current — another window or a manual edit may
    // have created one of these names since the analysis ran.
    const existingTags = await this.#readOrDegrade(
      () => gateway.getTags(), [],
      'Existing tags could not be re-read; a tag may be created that already exists.')

    for (const tagName of tagNames) {
      const outcome = await gateway.applyTag(itemId, tagName, existingTags)
      this.#recordOutcome(outcome, { retry: { kind: 'tag', name: tagName } })
    }

    // Notes are written only on a first apply: they are the one non-idempotent
    // write here, so a retry pass must never repeat one.
    if (!only) {
      const html = this.#buildNoteHtml(summary)
      if (html) {
        const outcome = await gateway.createNote(photoId, html)
        this.#recordOutcome(outcome)
        if (outcome.status === ACKNOWLEDGED && outcome.noteId) {
          logger.warn(`[AUTROPY] note ${outcome.noteId} written to photo ${photoId}`)
        }
      }
    }

    if (Object.keys(acceptedMeta).length > 0) {
      const outcome = await gateway.saveMetadata(itemId, acceptedMeta)
      this.#recordOutcome(outcome, { retry: { kind: 'metadata', fields: acceptedMeta } })
    }

    const unresolved = this.#notices.some(n => n.kind === 'warn' || n.kind === 'unknown')

    if (unresolved) {
      // Keep the panel open: the researcher needs to see what did and did not
      // land, and closing it would discard the only record of that.
      this.#renderStatus()
      logger.warn(`[AUTROPY] apply finished with unresolved writes — item ${itemId}`)
      return
    }

    logger.warn(`[AUTROPY] apply complete — item ${itemId}`)
    this.#removePanel()
  }

  #buildNoteHtml (summary) {
    const body = textToParagraphs(summary)
    if (!body) return null

    const provenance =
      `${AUTROPY_NOTE_MARKER} model: ${this.options.model} | ` +
      `${new Date().toISOString()} | v${AUTROPY_VERSION}`

    return `${body}<p>---<br>${escapeHtml(provenance)}</p>`
  }

  // ── teardown ─────────────────────────────────────────────────────────────

  #dismissPanel () {
    this.context.logger.warn(
      `[AUTROPY] dismissed — item ${this.#state.itemId}, nothing written`)
    this.#removePanel()
  }

  #removePanel () {
    this.#navUnsub?.()
    this.#navUnsub = null
    document.getElementById('autropy-panel')?.remove()
    this.#panelInjected = false
    this.#notices = []
    this.#retryable = []
    this.#state = { itemId: null, photoId: null, result: null, existingTags: [] }
  }

  // Fatal errors go to Tropy's own dialog, not the panel: the panel lives inside
  // .esper-container, so it cannot report that .esper-container is missing.
  #fatal (message, detail) {
    this.context.logger.warn(`[AUTROPY] ${message} — ${detail}`)

    try {
      this.context.dialog?.show('message-box', { type: 'error', message, detail })
    } catch (err) {
      this.context.logger.error(
        { stack: err.stack }, `[AUTROPY] could not show dialog: ${err.message}`)
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async load () {
    // First line in the log, unconditionally, before anything can fail.
    //
    // This exists because of a real debugging dead end: a stale build stayed
    // installed after a rebuild, and the log gave no way to tell which version
    // was running — so identical symptoms looked like the fix had not worked.
    // Whatever else happens, the log now says what is actually loaded.
    this.context.logger.warn(
      `[AUTROPY] v${AUTROPY_VERSION} loaded — port ${resolvePort(this.options.port)}, ` +
      `model "${this.options.model || '(not set)'}"`)

    // load() runs before Tropy renders the toolbar, and the esper tool group
    // only exists once an item with a photo is selected — which may be much
    // later. A MutationObserver injects the moment it appears.
    this.#injectToolbarToggle()

    if (!this.#toolbarInjected) {
      this.#domObserver = new MutationObserver(() => {
        this.#injectToolbarToggle()
        if (this.#toolbarInjected) {
          this.#domObserver?.disconnect()
          this.#domObserver = null
        }
      })
      this.#domObserver.observe(document.body, { childList: true, subtree: true })
    }

    // Report the API surface once per session, whether or not the researcher
    // ever clicks. Without this line the last breakage left no trace of which
    // Tropy or which route shape was in play.
    const projectPath = this.#projectPath()
    const port = resolvePort(this.options.port)

    this.#gatewayFor(projectPath, port).resolve().catch(err => {
      if (err instanceof ProjectIdentityError) {
        this.context.logger.warn(`[AUTROPY] preflight: ${err.message}`)
      } else {
        this.context.logger.error({ stack: err.stack }, `[AUTROPY] preflight failed: ${err.message}`)
      }
    })
  }

  async unload () {
    this.#activeRun?.controller.abort()
    this.#activeRun = null
    this.#domObserver?.disconnect()
    this.#domObserver = null
    this.#navUnsub?.()
    this.#navUnsub = null
    this.#analysisCache.clear()
    this.#gateway = null
    // The button is wrapped in a tool-group we created — remove the wrapper.
    document.getElementById('autropy-toggle')?.closest('.tool-group')?.remove()
    document.getElementById('autropy-panel')?.remove()
    document.getElementById('autropy-styles')?.remove()
    this.#toolbarInjected = false
    this.#panelInjected = false
  }
}

AutropyPlugin.defaults = {
  model: '',
  apiKey: '',
  port: DEFAULT_PORT,
  suggestMetadata: false,
  prompt: '',
  outputLanguage: ''
}

module.exports = AutropyPlugin
