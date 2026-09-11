// nav.js — Tropy's view mode, and the action that changes it.
//
// Small on purpose: the action shape below is copied from Tropy's own bundle,
// and a wrong shape would dispatch silently and do nothing. Keeping it here
// makes it assertable in a test without a DOM.
//
// VERIFIED against Tropy Beta 1.18.0-beta.5 (app.asar):
//
//   MODE = { PROJECT: 'project', ITEM: 'item' }
//   const update = createAction(NAV.UPDATE)          // NAV.UPDATE = 'nav.update'
//   const mode = {
//     item ()    { return update({ mode: NAV.MODE.ITEM }) },
//     project () { return update({ mode: NAV.MODE.PROJECT }) }
//   }
//
// and reduced as a plain merge, so dispatching it is synchronous and runs no
// command:
//
//   case NAV.UPDATE: return { ...state, ...payload }

export const ITEM_MODE = 'item'
export const PROJECT_MODE = 'project'

// The action Tropy itself dispatches to open the item view.
export function itemModeAction () {
  return { type: 'nav.update', payload: { mode: ITEM_MODE } }
}

// Selects a photo within the open item. Same reducer as the mode switch, so it
// is synchronous and carries no command. Used by the panel's pager: reviewing
// page 3 should mean looking at page 3, not reading its summary over page 1.
export function photoAction (photoId) {
  return { type: 'nav.update', payload: { photo: photoId } }
}

export function navMode (state) {
  return state?.nav?.mode ?? null
}

// The photos of an item, in the item's own order.
//
// NOT sorted by `photo.page`: page is an index *within a source file*, so every
// photo of a six-scan item has page 0, and a two-page PDF and a JPEG in the same
// item would interleave. `state.items[id].photos` is the order Tropy shows in
// the filmstrip, which is the order the researcher means.
export function itemPhotoIds (state, itemId) {
  const photos = state?.items?.[itemId]?.photos
  return Array.isArray(photos) ? [...photos] : []
}

// Deliberately narrow: only a mode Tropy has positively reported as 'project'
// counts. An unreadable state is not "probably project mode" — guessing wrong
// would refuse to show a result that was already paid for.
export function isProjectMode (state) {
  return navMode(state) === PROJECT_MODE
}

export function isItemMode (state) {
  return navMode(state) === ITEM_MODE
}
