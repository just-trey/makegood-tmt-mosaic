import type { RasterImage } from './types';

/**
 * Round-tripping a raster design through the saved session.
 *
 * **The working image, re-encoded, not the file the user dropped and not the raw pixels.**
 *
 * Raw pixels were measured and rejected when this was first written: 1024x1024 RGBA is 4.0 MB
 * before JSON encoding, against a MAX_BYTES of 4 MB for the whole session, so a single flat-art
 * image filled the budget on its own.
 *
 * Re-encoded, the same pixels measure (2026-08-17, this app in Chromium): flat art at 1024px is
 * **24 KB** as PNG, a photograph at 512px is **703 KB**. Both fit several times over.
 *
 * PNG rather than WebP, which measured 4 KB and 108 KB on the same two: lossless means a restored
 * design quantizes to the palette it had when saved. Lossy would shift colours before the
 * quantizer sees them and could come back with a different palette, which is a filament list the
 * user did not choose.
 *
 * One caveat on "lossless": the canvas round trip premultiplies alpha, so a pixel with alpha
 * between 1 and 254 can come back a step off. Fully opaque and fully transparent pixels, which is
 * what flat art and a cut-out photograph are made of, are exact.
 *
 * The working image, not the original file, because the working image is what the pipeline
 * actually traced. `decodeImageFile` has already resolved the working size from the image's own
 * statistics; re-reading the original would redo that decision, and a source whose stats put it
 * near a threshold could restore at a different resolution than it was saved at.
 */
export function encodeWorkingImage(image: RasterImage): string | null {
  // Null rather than a throw, and the whole body inside the try: this runs inside snapshotSession,
  // which is outside saveSession's own try, so anything escaping here takes a whole session down
  // over one image. The caller falls back to leaving that source out, which is what the app did
  // for every image before this existed.
  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.w;
    canvas.height = image.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // Copied into a fresh ImageData rather than wrapping `image.data`: the source may be backed by
    // a SharedArrayBuffer, which the ImageData constructor's types (rightly) refuse.
    const out = ctx.createImageData(image.w, image.h);
    out.data.set(image.data);
    ctx.putImageData(out, 0, 0);
    // toDataURL, not toBlob: snapshotSession is synchronous, and making it async would put an
    // await between reading the state and writing it, where a save fired from beforeunload can
    // lose the race.
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** The inverse, for session restore. */
export async function decodeWorkingImage(dataUrl: string): Promise<RasterImage> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    // Bounded, because `onload`/`onerror` is a promise that some environments never settle: a
    // decoder that neither succeeds nor reports failure would hang the whole restore with the
    // banner already dismissed and nothing on screen to explain it. A local data URL that has not
    // decoded in this long is not going to.
    const timer = setTimeout(
      () => reject(new Error('saved image took too long to decode')),
      15_000,
    );
    const done = (fn: () => void) => () => {
      clearTimeout(timer);
      fn();
    };
    img.onload = done(resolve);
    img.onerror = done(() => reject(new Error('saved image could not be decoded')));
    img.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context for decoding the image');
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data, w: width, h: height };
}
