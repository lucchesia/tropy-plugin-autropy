// image.js — prepares a photo for a vision model.
//
// Tropy exposes its own sharp wrapper on the plugin context (`context.sharp`),
// so this happens in process, straight from the photo's path. That matters for
// three separate reasons:
//
//  1. Size. Archival scans are large, base64 inflates them by about a third,
//     and providers cap image payloads — Anthropic at 10 MB. A 9 MB TIFF became
//     12.3 MB of base64 and was rejected outright.
//  2. Cost. Claude downscales anything larger than ~1568 px on the long edge
//     before it looks at it, so sending more pixels buys nothing and is billed
//     as more tokens.
//  3. Format. TIFF is ordinary in archives and no vision API accepts it.
//     Re-encoding to JPEG makes those photos usable at all.
//
// The `page` handling is not optional: a PDF or multi-page TIFF puts every page
// behind the *same* path and distinguishes them only by `page`. Without it, a
// two-page item analyzes page one twice.

// Claude's effective ceiling. Larger is downscaled server-side anyway, and this
// keeps a typical page render well under a megabyte.
export const SCAN_EDGE = 1568

// Providers reject anything above this; checked after rendering as a backstop.
const MAX_BASE64_BYTES = 10 * 1024 * 1024

// Formats every current vision API accepts, for the no-sharp fallback path.
export const SUPPORTED_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
]

// Renders a photo to base64 JPEG at most `edge` px on its long side.
//
// Returns { base64, mediaType, bytes, page }.
export async function renderPhoto (sharp, photo, { edge = SCAN_EDGE } = {}) {
  if (!photo?.path) {
    throw new Error('[AUTROPY] this photo has no file path, so it cannot be analyzed')
  }

  // Tropy can hold photos behind non-file protocols; sharp cannot open those.
  if (photo.protocol && photo.protocol !== 'file') {
    throw new Error(
      `[AUTROPY] photo ${photo.id} is not a local file (protocol "${photo.protocol}"), ` +
      'so Autropy cannot read it.')
  }

  const options = {}
  if (photo.page > 0) options.page = photo.page
  if (photo.density > 0) options.density = photo.density

  const image = await sharp.open(photo.path, options)

  const buffer = await image
    // Honour EXIF orientation before resizing, so a sideways scan is not
    // handed to the model sideways — it is reading the document, not just
    // looking at it.
    .rotate()
    .resize({
      width: edge,
      height: edge,
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: 80 })
    .toBuffer()

  const base64 = buffer.toString('base64')

  if (base64.length > MAX_BASE64_BYTES) {
    throw new Error(
      `[AUTROPY] this page is still ${Math.round(base64.length / 1024 / 1024)} MB ` +
      'after downscaling, which exceeds the provider limit. Report this — it ' +
      'should not happen at the default scan size.')
  }

  return {
    base64,
    mediaType: 'image/jpeg',
    bytes: buffer.length,
    page: photo.page ?? 0
  }
}

// Fallback for a Tropy that does not expose `context.sharp`: read the file as
// it sits on disk. No downscaling and no format conversion are possible, so
// this validates instead — an honest refusal beats a provider error the
// researcher cannot act on.
export async function readPhotoUnprocessed (readFile, photo) {
  if (!photo?.path) {
    throw new Error('[AUTROPY] this photo has no file path, so it cannot be analyzed')
  }

  const mediaType = photo.mimetype || 'image/jpeg'

  if (!SUPPORTED_MEDIA_TYPES.includes(mediaType)) {
    throw new Error(
      `[AUTROPY] this photo is ${mediaType}, which AI providers do not accept, and ` +
      'this Tropy version does not give Autropy the image tools needed to convert it.')
  }

  if (photo.page > 0) {
    throw new Error(
      `[AUTROPY] this photo is page ${photo.page + 1} of a multi-page file, which ` +
      'this Tropy version does not give Autropy the image tools to extract.')
  }

  const buffer = await readFile(photo.path)
  const base64 = buffer.toString('base64')

  if (base64.length > MAX_BASE64_BYTES) {
    const mb = (base64.length / 1024 / 1024).toFixed(1)
    throw new Error(
      `[AUTROPY] this image is too large to analyze (${mb} MB encoded, limit 10 MB) ` +
      'and this Tropy version does not give Autropy the image tools to downscale it.')
  }

  return { base64, mediaType, bytes: buffer.length, page: 0 }
}
