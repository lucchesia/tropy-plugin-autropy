// View mode, and the two things that shifted Tropy's entire window sideways.
//
// The failure these guard against was reported three times and misread twice as
// a CSS overflow problem. What actually happened: the panel was injected into
// `.esper-container` while Tropy was in project mode, where Tropy parks the
// whole item view off-screen with `transform: translate3d(calc(100% - Npx),0,0)`.
// Focusing the summary then asked the browser to reveal an off-screen element,
// so it scrolled the ancestors that hide that overflow — and because they use
// `overflow: hidden`, the researcher got no scrollbar to scroll back. The
// project sidebar ended up off the left edge of the screen, the item panel
// stranded mid-window and unresizable, with no recovery but restarting Tropy.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  ITEM_MODE,
  PROJECT_MODE,
  isItemMode,
  isProjectMode,
  itemModeAction,
  navMode
} from '../src/nav.js'

const PLUGIN_SOURCE = new URL('../src/plugin.js', import.meta.url)

// ── the action ─────────────────────────────────────────────────────────────

test('itemModeAction matches the action Tropy dispatches to open the item view', () => {
  // Copied from Tropy Beta 1.18.0-beta.5: `createAction(NAV.UPDATE)` with
  // NAV.UPDATE = 'nav.update', called as `update({ mode: NAV.MODE.ITEM })`.
  // A wrong type or a payload nested one level off dispatches silently and
  // does nothing, leaving the panel off-screen with no error anywhere.
  assert.deepEqual(itemModeAction(), {
    type: 'nav.update',
    payload: { mode: 'item' }
  })
})

test('the mode values are Tropy spellings, not ours', () => {
  assert.equal(ITEM_MODE, 'item')
  assert.equal(PROJECT_MODE, 'project')
})

// ── reading the mode ───────────────────────────────────────────────────────

test('reads nav.mode where Tropy keeps it', () => {
  assert.equal(navMode({ nav: { mode: 'project' } }), 'project')
  assert.ok(isProjectMode({ nav: { mode: 'project' } }))
  assert.ok(isItemMode({ nav: { mode: 'item' } }))
})

test('an unreadable state is not treated as project mode', () => {
  // Refusing on a guess would withhold an analysis the researcher already paid
  // for. Unknown means "carry on as before", not "probably project mode".
  for (const state of [null, undefined, {}, { nav: {} }, { nav: { mode: null } }]) {
    assert.equal(isProjectMode(state), false, `${JSON.stringify(state)}`)
    assert.equal(isItemMode(state), false, `${JSON.stringify(state)}`)
  }
})

test('project mode and item mode are not each other', () => {
  assert.equal(isItemMode({ nav: { mode: 'project' } }), false)
  assert.equal(isProjectMode({ nav: { mode: 'item' } }), false)
})

// ── source assertions ──────────────────────────────────────────────────────
//
// These read plugin.js as text. That is a poor substitute for driving a real
// DOM, but there is no DOM in this test runner and no jsdom dependency, and
// both lines below are one-character regressions away from re-breaking the
// window in a way that looks like Tropy's fault rather than ours.

test('the summary is focused without scrolling any ancestor', () => {
  const source = readFileSync(PLUGIN_SOURCE, 'utf8')

  assert.match(source, /summary\.focus\(\{ preventScroll: true \}\)/)
  assert.doesNotMatch(
    source, /\.focus\(\s*\)/,
    'a bare focus() reveals the element by scrolling every scrollable ancestor')
})

test('the panel is not injected without first ensuring item mode', () => {
  const source = readFileSync(PLUGIN_SOURCE, 'utf8')
  const inject = source.indexOf('#injectPanel (')

  assert.ok(inject > 0, 'expected #injectPanel to exist')

  const body = source.slice(inject, source.indexOf(".querySelector('.esper-container')", inject))
  assert.match(body, /#enterItemMode\(\)/,
    'the mode check has to come before the container lookup, not after')
})

test('load() is driven from the constructor, because Tropy has no load hook', () => {
  // Tropy's plugin manager only does `new Plugin(options, context)` and then
  // `instances[id][action](...)`. Waiting to be called back meant load() never
  // ran at all: no version line in the log, no preflight, and no toolbar icon
  // until the export menu had been used once.
  const source = readFileSync(PLUGIN_SOURCE, 'utf8')
  const ctor = source.indexOf('constructor (options, context)')
  const end = source.indexOf('#current = null', ctor)

  assert.ok(end > ctor, 'expected the field block to follow the constructor')

  const body = source.slice(ctor, end)

  assert.match(body, /this\.load\(\)/)
  assert.match(body, /\.catch\(/, 'an unhandled rejection here loses the plugin silently')
})

test('a refused panel does not leave state and a nav subscription behind', () => {
  const source = readFileSync(PLUGIN_SOURCE, 'utf8')
  const open = source.indexOf('#openPanel (run, photoId)')

  assert.ok(open > 0, 'expected #openPanel to exist')

  const body = source.slice(open, open + 400)

  assert.match(body, /if \(!this\.#injectPanel\([^)]*\)\) return/)
})

test('ancestor scroll is put back after the panel is wired', () => {
  const source = readFileSync(PLUGIN_SOURCE, 'utf8')

  const wire = source.indexOf('this.#wirePanelEvents(')
  const unscroll = source.indexOf('this.#unscrollAncestors(')

  assert.ok(wire > 0, 'expected #wirePanelEvents to be called')
  assert.ok(unscroll > 0, 'expected #unscrollAncestors to be called')
  assert.ok(unscroll > wire, 'it has to run after wiring, which is what focuses')
})
