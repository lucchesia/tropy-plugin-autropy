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

import { readFile } from 'node:fs/promises'
// Imported rather than duplicated as a constant: the version previously lived
// in four places and had already drifted (the installed build said alpha.1
// while the repo said alpha.2), which corrupts note provenance.
import { version as AUTROPY_VERSION } from '../package.json'
import { analyzeImage } from './api.js'
import { isItemMode, isProjectMode, itemModeAction } from './nav.js'
import {
  ACKNOWLEDGED,
  ProjectIdentityError,
  REJECTED,
  RestProjectGateway,
  UNKNOWN
} from './gateway.js'
import { readPhotoUnprocessed, renderPhoto } from './image.js'
import { buildPrompt } from './prompt.js'
import { buildPanelHTML, renderStatusLines } from './panel-template.js'
import { escapeHtml, textToParagraphs } from './html.js'
import {
  ACKNOWLEDGED as OP_ACKNOWLEDGED,
  COMPLETE as COMPLETE_LEDGER,
  PENDING as OP_PENDING,
  REJECTED as OP_REJECTED,
  UNKNOWN as OP_UNKNOWN,
  appliedSummary,
  collectWrites,
  createRun,
  digest,
  imageFingerprint,
  isLocked,
  ledgerState,
  metadataOp,
  noteOp,
  photoCacheKey,
  photoEntry,
  recordOperation,
  retryableOperations,
  runCacheKey,
  setFailed,
  setResult,
  setSummaryDraft,
  tagOp,
  toggleField,
  toggleTag
} from './run.js'

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

    // `load()` is not a Tropy hook. Tropy's plugin manager does exactly two
    // things with a plugin: `new Plugin(options, context)`, then
    // `instances[id][action](...)` for a menu action (export/import/extract/
    // transcribe). Verified in Tropy Beta 1.18.0-beta.5:
    //
    //   this.instances[i] = new Plugin(options ?? {}, this.getContext(plugin))
    //   exec = async ({ id, action }, ...args) => this.instances[id][action](...args)
    //
    // So load() had never run in any released build. That is why the version
    // line was missing from the log, why the preflight never reported, and why
    // the toolbar icon only appeared *after* File > Export > Autropy had been
    // used once — the export hook injects it as a side effect.
    //
    // Not awaited: a constructor cannot await, and a throw here makes Tropy
    // drop the plugin with only "failed to create plugin" in the log.
    this.load().catch(err => {
      context?.logger?.error?.(
        { stack: err?.stack }, `[AUTROPY] load failed: ${err?.message}`)
    })
  }

  // What is on screen: which run, and which of its photos. Everything the
  // researcher decides lives in the run, not here and not in the DOM.
  #current = null              // { run, photoId } while a panel is open
  #loaded = false
  #panelInjected = false
  #toolbarInjected = false
  #domObserver = null
  #navUnsub = null

  // Two caches, because they answer different questions.
  //
  //   #runs       — the researcher's work: edits, accept decisions, and the
  //                 ledger of what was written. Keyed per project/item/model.
  //   #photoCache — the paid-for model output. Keyed on everything that changes
  //                 the answer, so a changed prompt, tag vocabulary, model or
  //                 image is a miss rather than a stale hit.
  //
  // The old single cache was keyed on photoId alone, which made both mistakes at
  // once: it served one project's analysis for another project's photo of the
  // same id, and it replayed an applied analysis as an editable panel.
  #runs = new Map()
  #photoCache = new Map()

  #containerPosition = null    // Tropy's own inline position, to restore on cleanup
  #gateway = null
  #activeRun = null            // { id, controller, itemId, photoId } while analyzing
  #runCounter = 0

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

  // Resolves once `project.path` appears, or null if it never does. Used only
  // by the preflight: every other caller runs after the researcher has acted,
  // by which time a project is open.
  #awaitProjectPath (timeout = 30000) {
    const now = this.#projectPath()
    if (now) return Promise.resolve(now)

    const store = this.#store()
    if (!store || typeof store.subscribe !== 'function') return Promise.resolve(null)

    return new Promise(resolve => {
      let unsub = null
      let timer = null

      const finish = value => {
        unsub?.()
        clearTimeout(timer)
        resolve(value)
      }

      timer = setTimeout(() => finish(null), timeout)
      unsub = store.subscribe(() => {
        const path = this.#projectPath()
        if (path) finish(path)
      })

      // The path can land between the read above and the subscription.
      const path = this.#projectPath()
      if (path) finish(path)
    })
  }

  // The photo is authoritative for which item we are on: `nav.items[0]` is the
  // first item in *click* order, which need not be the item owning this photo.
  #readNav (state = this.#getState()) {
    const photoId = state?.nav?.photo
    const photo = photoId ? state?.photos?.[photoId] : null
    const itemId = photo?.item ?? state?.nav?.items?.[0] ?? null
    return { itemId, photoId: photoId ?? null, photo }
  }

  // In project mode Tropy parks the entire item view off-screen to the right —
  // `.item-view` carries `transform: translate3d(calc(100% - <panel>px), 0, 0)`
  // — and `.esper-container`, where the panel lives, goes with it. Injecting
  // there while in project mode builds a panel nobody can see, and then
  // focusing it drags the whole Tropy window sideways (see #unscrollAncestors).
  //
  // So switch to item mode first, using the same plain action Tropy dispatches
  // when an item is opened: `nav.update` is reduced as `{ ...state, ...payload }`,
  // so it is synchronous and carries no command or side effect.
  //
  // Returns false only when the mode is known to be 'project' and there is no
  // store to change it with. An unknown mode proceeds as before rather than
  // blocking on a state read that may not be available.
  #enterItemMode () {
    if (!isProjectMode(this.#getState())) return true

    const store = this.#store()
    if (!store || typeof store.dispatch !== 'function') return false

    store.dispatch(itemModeAction())
    this.context.logger.warn('[AUTROPY] switched Tropy to item mode to show the panel')

    return isItemMode(this.#getState())
  }

  // Repairs the one way Autropy can move Tropy's whole window.
  //
  // Tropy's layout overflows horizontally by design — in project mode the item
  // view is translated a full width to the right — and the ancestors that hide
  // the overflow use `overflow: hidden`. That stops the *user* scrolling; it
  // does not stop the browser scrolling programmatically to reveal a focused
  // element. So focusing the summary set scrollLeft on one of those ancestors
  // and shifted the entire app left, with no scrollbar to drag back: project
  // sidebar off the left edge, item panel stranded mid-screen, panels no longer
  // resizable, and no recovery short of restarting Tropy. It read as Tropy
  // breaking, which is why it took three attempts to find.
  //
  // `focus({ preventScroll: true })` prevents our own case; this puts back
  // anything else that scrolls the chain. Horizontal axis only, and only when
  // non-zero: nothing in this ancestor chain scrolls horizontally in normal use
  // (the item table's scroll container is in a different subtree).
  #unscrollAncestors (el) {
    for (let node = el; node; node = node.parentElement) {
      if (node.scrollLeft) node.scrollLeft = 0
    }
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

  async #runAnalysis ({ force = false } = {}) {
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

    const projectPath = this.#projectPath()
    const key = runCacheKey({ projectPath, itemId, model })
    const existing = this.#runs.get(key)

    // Reopening an existing run is free and, crucially, faithful: the ledger
    // comes back with it, so an applied run reopens read-only instead of as a
    // fresh form that would write a second note.
    if (existing && !force && photoEntry(existing, photoId)?.status === 'done') {
      logger.warn(
        `[AUTROPY] reopening run ${existing.id} for photo ${photoId} ` +
        `(${ledgerState(existing)})`)
      this.#openPanel(existing, photoId)
      return
    }

    const run = createRun({ projectPath, itemId, model, photoIds: [photoId] })

    // Re-analysis after something was written is legitimate — the researcher
    // asked for it — but applying the new run will add a second note rather
    // than replace the first. Say so rather than let it surprise them.
    if (existing && isLocked(existing)) {
      const prior = appliedSummary(existing)
      run.notices.push({
        kind: 'info',
        text: `An earlier run (${existing.model}, ${new Date(prior.at).toLocaleString()}) ` +
              'already wrote to this item. Applying this one adds to that rather than ' +
              'replacing it.'
      })
    }

    this.#runs.set(key, run)

    const runId = ++this.#runCounter
    const controller = new AbortController()
    this.#activeRun = { id: runId, controller, itemId, photoId }
    this.#watchNav()

    logger.warn(
      `[AUTROPY] starting analysis — run ${run.id}, item ${itemId}, photo ${photoId}`)

    try {
      const gateway = this.#gatewayFor(projectPath, port)

      // Both reads only enrich the prompt, so neither is allowed to end the
      // run. Before this, a failing metadata read — which is exactly what
      // Tropy beta.5 caused — aborted the whole analysis with no visible sign.
      const existingTags = await this.#readOrDegrade(
        run, () => gateway.getTags(), [],
        'Existing project tags could not be read, so every suggested tag shows as new.')

      const existingTagNames = existingTags.map(t => t.name)

      let itemMetadata = null
      if (suggestMetadata) {
        itemMetadata = await this.#readOrDegrade(
          run, () => gateway.getMetadata(itemId), null,
          'This item\'s existing metadata could not be read, so suggestions may repeat values already recorded.')
      }

      const finalPrompt = buildPrompt(prompt, existingTagNames, itemMetadata, outputLanguage)

      run.existingTagNames = existingTagNames
      run.existingTags = existingTags
      run.suggestMetadata = suggestMetadata

      // Kept so the panel can show which suggestions would REPLACE something.
      // Tropy holds one value per property, so an accepted suggestion for a
      // filled field overwrites it with nothing left to say which value was the
      // researcher's own.
      run.itemMetadata = itemMetadata

      // The cache key covers the assembled prompt, so it already reflects the
      // tag vocabulary and the item's current metadata: fill a field or add a
      // tag and the next run is a miss, as it should be. `force` skips the
      // lookup entirely — Re-analyze means re-analyze.
      const cacheKey = photoCacheKey({
        projectPath,
        itemId,
        photoId,
        model,
        promptDigest: digest(finalPrompt),
        imageFingerprint: imageFingerprint(photo)
      })

      const cached = force ? null : this.#photoCache.get(cacheKey)

      if (cached) {
        logger.warn(`[AUTROPY] reusing a paid-for analysis of photo ${photoId}`)
        setResult(run, photoId, cached)
        this.#openPanel(run, photoId)
        return
      }

      // Downscale and re-encode via Tropy's own sharp. Sending the original is
      // what made a 9 MB scan fail: base64 inflates it past the provider's
      // 10 MB ceiling, and anything over ~1568 px is downscaled server-side
      // anyway. This also selects the right page of a multi-page file.
      const { sharp } = this.context
      const scan = sharp
        ? await renderPhoto(sharp, photo, {})
        : await readPhotoUnprocessed(readFile, photo)

      logger.warn(
        `[AUTROPY] calling model: ${model} — ${Math.round(scan.bytes / 1024)} KB ` +
        `${scan.mediaType}${photo.page > 0 ? `, page ${photo.page + 1}` : ''}`)

      const result = await analyzeImage(scan.base64, finalPrompt, model, apiKey, {
        mediaType: scan.mediaType,
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

      this.#photoCache.set(cacheKey, { result })
      setResult(run, photoId, { result })
      this.#openPanel(run, photoId)
    } catch (err) {
      if (controller.signal.aborted) {
        logger.warn('[AUTROPY] analysis cancelled')
        return
      }

      setFailed(run, photoId, err)
      logger.error({ stack: err.stack }, `[AUTROPY] analysis failed: ${err.message}`)
      this.#fatal('Autropy could not analyze this photo', err.message)
    } finally {
      if (this.#activeRun?.id === runId) this.#activeRun = null
    }
  }

  // Runs a prompt-enriching read, downgrading failure to a notice on the run.
  async #readOrDegrade (run, read, fallback, notice) {
    try {
      return await read()
    } catch (err) {
      this.context.logger.warn(`[AUTROPY] degraded read: ${err.message}`)
      run.notices.push({ kind: 'info', text: notice })
      return fallback
    }
  }

  // Puts a run on screen. `#current` is set after injection because the panel
  // may refuse — it reports why itself, and subscribing to navigation without a
  // panel would only schedule a #closePanel for a panel that does not exist.
  #openPanel (run, photoId) {
    if (!this.#injectPanel(run, photoId)) return

    this.#current = { run, photoId }
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
  #injectPanel (run, photoId) {
    this.#closePanel()

    // The analysis is already cached by this point, so refusing here costs
    // nothing: clicking the icon in the item view replays it without a second
    // billed request.
    if (!this.#enterItemMode()) {
      this.#fatal(
        'Autropy needs the item view',
        'The analysis is ready, but Tropy is in project view — the panel would ' +
        'open off-screen. Double-click the item to open it in the item view, ' +
        'then click the Autropy icon in the image toolbar. The analysis is kept, ' +
        'so this will not run again.')
      return false
    }

    const container = document.querySelector('.esper-container')
    if (!container) {
      // Cannot be reported in the panel — the panel needs this container.
      this.#fatal(
        'Autropy could not open its panel',
        'The Tropy image viewer was not found on screen. Open a photo in the ' +
        'item view and try again.')
      return false
    }

    // The panel is an absolute overlay, so the container has to be a positioned
    // ancestor. This mutates one of Tropy's own elements, so remember what was
    // there and put it back in #closePanel — leaving a host app's layout
    // permanently altered is how the image viewer ends up misbehaving after the
    // panel is gone.
    if (getComputedStyle(container).position === 'static') {
      this.#containerPosition = { el: container, value: container.style.position }
      container.style.position = 'relative'
    }

    const wrapper = document.createElement('div')
    wrapper.innerHTML = buildPanelHTML({
      run,
      photoId,
      existingTagNames: run.existingTagNames || [],
      suggestMetadata: run.suggestMetadata ?? this.options.suggestMetadata
    })

    if (!document.getElementById('autropy-styles')) {
      document.head.appendChild(wrapper.querySelector('style'))
    }

    const panel = wrapper.querySelector('#autropy-panel')
    container.appendChild(panel)
    this.#panelInjected = true

    this.#wirePanelEvents(panel, run, photoId)

    // After wiring, because wiring focuses the summary.
    this.#unscrollAncestors(panel)

    this.context.logger.warn(
      `[AUTROPY] review panel injected — run ${run.id}, ${ledgerState(run)}`)

    return true
  }

  // `panel` is passed in and every lookup is scoped to it. These queries used to
  // run against the whole document, which happened to work only because exactly
  // one panel exists at a time.
  #wirePanelEvents (panel, run, photoId) {
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

    panel.addEventListener('keydown', blockEsper)
    panel.addEventListener('keyup', blockEsper)

    const locked = isLocked(run)

    const summary = panel.querySelector('#autropy-summary')
    if (summary) {
      summary.addEventListener('keydown', blockEsper)
      summary.addEventListener('keyup', blockEsper)

      // Every keystroke goes into the run. Reading the textarea only at Apply
      // time meant an edit was lost the moment anything re-rendered the panel.
      summary.addEventListener('input', () => {
        setSummaryDraft(run, photoId, summary.value)
      })
      // Without focus here, focus stays on section.esper and all keys are
      // treated as image shortcuts.
      //
      // `preventScroll` is load-bearing. A plain focus() asks the browser to
      // reveal the element, which scrolls every ancestor that can be scrolled —
      // including ones with `overflow: hidden`, which then offer the user no
      // scrollbar to undo it. That is what shifted Tropy's whole window
      // sideways; see #unscrollAncestors.
      summary.focus({ preventScroll: true })
    }

    if (!locked) {
      panel.querySelectorAll('.autropy-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          toggleTag(run, photoId, chip.dataset.tag)
          chip.dataset.accepted = String(
            !!photoEntry(run, photoId)?.accept.tags.includes(chip.dataset.tag))
        })
        chip.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            chip.click()
          }
        })
      })

      panel.querySelectorAll('.autropy-meta-row__accept').forEach(btn => {
        btn.addEventListener('click', () => {
          const row = btn.closest('.autropy-meta-row')
          if (!row) return

          toggleField(run, photoId, row.dataset.field)

          // Re-read from the run rather than flipping the attribute, so the
          // markup can never drift from the state Apply will actually use.
          const accepted = !!photoEntry(run, photoId)
            ?.accept.fields.includes(row.dataset.field)
          row.dataset.accepted = String(accepted)
          btn.textContent = accepted ? 'Undo' : 'Accept'
        })
      })
    }

    panel.querySelector('#autropy-apply')?.addEventListener('click', () => {
      this.#applyAccepted(run, photoId).catch(err => {
        this.context.logger.error({ stack: err.stack }, `[AUTROPY] apply failed: ${err.message}`)
        run.notices.push({ kind: 'warn', text: err.message })
        this.#renderStatus()
      })
    })

    panel.querySelector('#autropy-reanalyze')?.addEventListener('click', () => {
      this.#runAnalysis({ force: true }).catch(err => {
        this.context.logger.error(
          { stack: err.stack }, `[AUTROPY] re-analysis failed: ${err.message}`)
      })
    })

    panel.querySelector('#autropy-dismiss')?.addEventListener('click', () => {
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

    if (!this.#activeRun && !this.#current) return

    const check = () => {
      const state = this.#getState()
      if (!state?.nav) return

      const { itemId, photoId } = this.#readNav(state)

      const active = this.#activeRun
      if (active && (active.photoId !== photoId || active.itemId !== itemId)) {
        this.context.logger.warn('[AUTROPY] navigation changed during analysis — cancelling')
        active.controller.abort()
        this.#activeRun = null
      }

      if (this.#panelInjected && this.#current &&
          (this.#current.photoId !== photoId || this.#current.run.itemId !== itemId)) {
        this.context.logger.warn('[AUTROPY] navigation changed — closing stale panel')
        this.#closePanel()
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
    const run = this.#current?.run
    const area = document.getElementById('autropy-status')
    if (!area || !run) return

    area.innerHTML = renderStatusLines(run.notices)

    const retryable = retryableOperations(run)
    if (retryable.length > 0) {
      const retry = document.createElement('button')
      retry.className = 'autropy-btn'
      retry.id = 'autropy-retry'
      retry.textContent = `Retry ${retryable.length} refused write(s)`
      retry.addEventListener('click', () => {
        this.#applyAccepted(run, this.#current.photoId, { retryOnly: true }).catch(err => {
          this.context.logger.error({ stack: err.stack }, `[AUTROPY] retry failed: ${err.message}`)
        })
      })
      area.appendChild(retry)
    }
  }

  // Turns a gateway outcome into a ledger entry and a status line.
  //
  // The ledger entry is the part that matters: it is written the moment the
  // outcome is known, so a run that dies between two writes still knows which
  // of them landed.
  #recordOutcome (run, { key, kind, outcome }) {
    if (!outcome) return

    const { status, describe, detail, targetChanged, noteId } = outcome

    if (status === ACKNOWLEDGED) {
      recordOperation(run, { key, kind, status: OP_ACKNOWLEDGED, describe, noteId })
      run.notices.push({ kind: 'ok', text: `Done: ${describe}.` })

      if (targetChanged) {
        run.notices.push({
          kind: 'unknown',
          text: 'The frontmost project changed during this write — please confirm ' +
                'it landed in the project you meant.'
        })
      }
      return
    }

    if (status === REJECTED) {
      recordOperation(run, { key, kind, status: OP_REJECTED, describe, detail })
      run.notices.push({ kind: 'warn', text: `Tropy refused: ${describe} (${detail}).` })
      return
    }

    if (status === UNKNOWN) {
      // Terminal. A note that may already exist must not be written twice, and
      // nothing observable from here distinguishes a write that never landed
      // from one whose acknowledgement was lost on the way back.
      recordOperation(run, { key, kind, status: OP_UNKNOWN, describe, detail })
      run.notices.push({
        kind: 'unknown',
        text: `Unconfirmed: ${describe}. The connection to Tropy dropped, so this ` +
              'may or may not have been saved — check in Tropy before trying again.'
      })
    }
  }

  // ── apply ────────────────────────────────────────────────────────────────

  async #applyAccepted (run, photoId, { retryOnly = false } = {}) {
    const { logger } = this.context
    const { itemId } = run
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
      this.#closePanel()
      return
    }

    const gateway = this.#gatewayFor(run.projectPath, port)

    try {
      await gateway.assertWriteTarget()
    } catch (err) {
      logger.error({ stack: err.stack }, `[AUTROPY] refused to write: ${err.message}`)
      this.#fatal('Nothing was written', err.message)
      return
    }

    // Outcome lines are rebuilt each pass; the informational notices from the
    // analysis stay, because they still describe how these suggestions were
    // produced.
    run.notices = run.notices.filter(n => n.kind === 'info')

    // What may be written is decided by the ledger, not by the DOM and not by a
    // flag. An acknowledged or unknown note is never re-emitted, which is what
    // makes a duplicate note impossible rather than merely unlikely.
    const { notes, tags, fields } = collectWrites(run)

    if (retryOnly && notes.length === 0 && tags.length === 0 &&
        Object.keys(fields).length === 0) {
      run.notices.push({ kind: 'info', text: 'Nothing left that is safe to retry.' })
      this.#renderStatus()
      return
    }

    // Re-read tags so tag ids are current — another window or a manual edit may
    // have created one of these names since the analysis ran.
    const existingTags = await this.#readOrDegrade(
      run, () => gateway.getTags(), [],
      'Existing tags could not be re-read; a tag may be created that already exists.')

    for (const tagName of tags) {
      recordOperation(run, { key: tagOp(tagName), kind: 'tag', status: OP_PENDING })
      const outcome = await gateway.applyTag(itemId, tagName, existingTags)
      this.#recordOutcome(run, { key: tagOp(tagName), kind: 'tag', outcome })
    }

    for (const note of notes) {
      const html = this.#buildNoteHtml(run, note.text)
      if (!html) continue

      const key = noteOp(note.photoId)
      recordOperation(run, { key, kind: 'note', status: OP_PENDING })

      const outcome = await gateway.createNote(note.photoId, html)
      this.#recordOutcome(run, { key, kind: 'note', outcome })

      if (outcome.status === ACKNOWLEDGED && outcome.noteId) {
        logger.warn(`[AUTROPY] note ${outcome.noteId} written to photo ${note.photoId}`)
      }
    }

    if (Object.keys(fields).length > 0) {
      const key = metadataOp(itemId)
      recordOperation(run, { key, kind: 'metadata', status: OP_PENDING })

      const outcome = await gateway.saveMetadata(itemId, fields)

      if (outcome) {
        this.#recordOutcome(run, { key, kind: 'metadata', outcome })
      } else {
        // saveMetadata returns null when every accepted field was dropped as
        // unwritable. That used to pass through #recordOutcome's null guard and
        // leave no trace at all — an accepted row that silently did nothing.
        recordOperation(run, {
          key,
          kind: 'metadata',
          status: OP_REJECTED,
          describe: `saving metadata on item ${itemId}`,
          detail: 'none of the accepted fields can be written to Tropy'
        })
        run.notices.push({
          kind: 'warn',
          text: 'None of the accepted metadata fields can be written to Tropy, so ' +
                'nothing was saved for them.'
        })
      }
    }

    const state = ledgerState(run)

    if (state !== COMPLETE_LEDGER) {
      // Keep the panel open: the researcher needs to see what did and did not
      // land, and closing it would discard the only record of that.
      this.#renderPanelInPlace(run, photoId)
      logger.warn(
        `[AUTROPY] apply finished ${state} — run ${run.id}, item ${itemId}`)
      return
    }

    logger.warn(`[AUTROPY] apply complete — run ${run.id}, item ${itemId}`)

    // Re-rendered rather than closed, so the panel becomes the receipt: what was
    // written, when, and by which model. Closing it here is what let a second
    // Apply look like a first one.
    this.#renderPanelInPlace(run, photoId)
  }

  // Rebuilds the panel from the run without touching the caches, so a locked run
  // picks up its read-only rendering and its banner.
  #renderPanelInPlace (run, photoId) {
    if (this.#injectPanel(run, photoId)) {
      this.#current = { run, photoId }
      this.#watchNav()
      this.#renderStatus()
    }
  }

  #buildNoteHtml (run, summary) {
    const body = textToParagraphs(summary)
    if (!body) return null

    // `run.model` and not `this.options.model`: the preference can have changed
    // since the analysis ran, and a note that names the wrong model is a
    // provenance error in the researcher's own data.
    //
    // The run id is here so an `unknown` write can be found by hand — it is the
    // one outcome Autropy refuses to resolve on the researcher's behalf.
    const provenance =
      `${AUTROPY_NOTE_MARKER} model: ${run.model} | ` +
      `${new Date().toISOString()} | v${AUTROPY_VERSION} | run ${run.id}`

    return `${body}<p>---<br>${escapeHtml(provenance)}</p>`
  }

  // ── teardown ─────────────────────────────────────────────────────────────

  #dismissPanel () {
    const run = this.#current?.run
    this.context.logger.warn(
      `[AUTROPY] panel closed — item ${run?.itemId ?? 'none'}, ledger ` +
      `${run ? ledgerState(run) : 'none'}`)
    this.#closePanel()
  }

  // Closes the panel without destroying the run.
  //
  // This used to be #removePanel, and it wiped the researcher's decisions, the
  // status notices and any record of what had been written — which is why a
  // re-opened panel came back as a blank form and a second Apply wrote a second
  // note. The run outlives its panel now; only the DOM goes.
  #closePanel () {
    this.#navUnsub?.()
    this.#navUnsub = null
    document.getElementById('autropy-panel')?.remove()
    this.#restoreContainerPosition()
    this.#panelInjected = false
    this.#current = null
  }

  #restoreContainerPosition () {
    const saved = this.#containerPosition
    if (!saved) return

    // Restore the empty string too — that removes the inline declaration and
    // hands the element back to Tropy's own stylesheet.
    saved.el.style.position = saved.value
    this.#containerPosition = null
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
    // Called from the constructor, since Tropy has no load hook. Guarded in
    // case a future Tropy grows one and calls it too.
    if (this.#loaded) return
    this.#loaded = true

    // First line in the log, unconditionally, before anything can fail.
    //
    // This exists because of a real debugging dead end: a stale build stayed
    // installed after a rebuild, and the log gave no way to tell which version
    // was running — so identical symptoms looked like the fix had not worked.
    // Whatever else happens, the log now says what is actually loaded.
    this.context.logger.warn(
      `[AUTROPY] v${AUTROPY_VERSION} loaded — port ${resolvePort(this.options.port)}, ` +
      `model "${this.options.model || '(not set)'}"`)

    // Plugins are constructed during project.init, so the body may not be
    // parsed yet. Nothing below can touch the DOM until it is.
    if (!document.body) {
      await new Promise(resolve =>
        document.addEventListener('DOMContentLoaded', resolve, { once: true }))
    }

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
    //
    // Plugins are constructed during project.init, *before* Tropy opens the
    // project db, so `state.project.path` is still null here. Running the
    // preflight immediately produced a scary and wrong first impression —
    // "cannot determine which project this window has open… Open a project and
    // try again" — while the project was in the middle of opening. Wait for the
    // path instead, and if it never arrives (no project opened this session)
    // say nothing: there is nothing to preflight against.
    const projectPath = await this.#awaitProjectPath()
    if (!projectPath) return

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
    this.#runs.clear()
    this.#photoCache.clear()
    this.#gateway = null
    // The button is wrapped in a tool-group we created — remove the wrapper.
    document.getElementById('autropy-toggle')?.closest('.tool-group')?.remove()
    document.getElementById('autropy-panel')?.remove()
    document.getElementById('autropy-styles')?.remove()
    this.#restoreContainerPosition()
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
