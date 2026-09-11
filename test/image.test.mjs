// Image preparation. Every case here is one that failed or would have failed
// against a real archival collection.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SCAN_EDGE, readPhotoUnprocessed, renderPhoto } from '../src/image.js'

// Minimal stand-in for Tropy's sharp wrapper, recording the pipeline it was
// asked to run.
function fakeSharp (bytes = 120_000) {
  const calls = { open: null, rotate: 0, resize: null, jpeg: null }

  const pipeline = {
    rotate () { calls.rotate += 1; return pipeline },
    resize (opts) { calls.resize = opts; return pipeline },
    jpeg (opts) { calls.jpeg = opts; return pipeline },
    async toBuffer () { return Buffer.alloc(bytes, 0x41) }
  }

  return {
    calls,
    sharp: {
      async open (path, options) {
        calls.open = { path, options }
        return pipeline
      }
    }
  }
}

const photo = (over = {}) => ({
  id: 1050, item: 1049, path: '/a/scan.tif', protocol: 'file', page: 0, ...over
})

test('renders to JPEG, downscaled, honouring EXIF orientation', async () => {
  const { sharp, calls } = fakeSharp()
  const scan = await renderPhoto(sharp, photo())

  assert.equal(scan.mediaType, 'image/jpeg')
  assert.equal(calls.rotate, 1, 'must rotate before resizing, or text arrives sideways')
  assert.deepEqual(calls.resize, {
    width: SCAN_EDGE, height: SCAN_EDGE, fit: 'inside', withoutEnlargement: true
  })
  assert.equal(calls.jpeg.quality, 80)
})

test('never enlarges a small scan', async () => {
  const { sharp, calls } = fakeSharp()
  await renderPhoto(sharp, photo())

  assert.equal(calls.resize.withoutEnlargement, true)
})

test('selects the right page of a multi-page file', async () => {
  // A PDF or multi-page TIFF puts every page behind the SAME path and tells
  // them apart only by `page`. Without this a two-page item analyzes page one
  // twice — silently, with plausible-looking output.
  const { sharp, calls } = fakeSharp()
  await renderPhoto(sharp, photo({ page: 1 }))

  assert.equal(calls.open.options.page, 1)
})

test('omits page for a single-page file rather than passing 0', async () => {
  const { sharp, calls } = fakeSharp()
  await renderPhoto(sharp, photo({ page: 0 }))

  assert.equal('page' in calls.open.options, false)
})

test('passes density through when Tropy records one', async () => {
  const { sharp, calls } = fakeSharp()
  await renderPhoto(sharp, photo({ density: 300 }))

  assert.equal(calls.open.options.density, 300)
})

test('refuses a photo that is not a local file', async () => {
  const { sharp } = fakeSharp()

  await assert.rejects(
    () => renderPhoto(sharp, photo({ protocol: 'https' })),
    /not a local file/)
})

test('refuses a photo with no path', async () => {
  const { sharp } = fakeSharp()

  await assert.rejects(() => renderPhoto(sharp, photo({ path: null })), /no file path/)
})

test('a render still over the provider limit is reported, not sent', async () => {
  // Should be unreachable at the default edge; a backstop rather than a guess.
  const { sharp } = fakeSharp(9 * 1024 * 1024)   // ~12 MB once base64-encoded

  await assert.rejects(
    () => renderPhoto(sharp, photo()),
    err => /exceeds the provider limit/.test(err.message) && /Report this/.test(err.message))
})

// ── fallback path, for a Tropy without context.sharp ──────────────────────

test('the fallback reads the file as-is and reports its real media type', async () => {
  const scan = await readPhotoUnprocessed(
    async () => Buffer.alloc(1000), photo({ path: '/a/scan.png', mimetype: 'image/png' }))

  assert.equal(scan.mediaType, 'image/png')
  assert.equal(scan.bytes, 1000)
})

test('the fallback refuses TIFF, explaining why it cannot convert', async () => {
  await assert.rejects(
    () => readPhotoUnprocessed(async () => Buffer.alloc(10), photo({ mimetype: 'image/tiff' })),
    err => /image\/tiff/.test(err.message) && /image tools/.test(err.message))
})

test('the fallback refuses a multi-page file it cannot page into', async () => {
  await assert.rejects(
    () => readPhotoUnprocessed(async () => Buffer.alloc(10), photo({ page: 1, mimetype: 'image/jpeg' })),
    /page 2 of a multi-page file/)
})

test('the fallback reports an oversized image in megabytes, with the limit', async () => {
  // The exact failure a researcher hit: a 9 MB scan is 12.3 MB encoded.
  await assert.rejects(
    () => readPhotoUnprocessed(
      async () => Buffer.alloc(9 * 1024 * 1024), photo({ mimetype: 'image/jpeg' })),
    err => /too large to analyze/.test(err.message) && /limit 10 MB/.test(err.message))
})
