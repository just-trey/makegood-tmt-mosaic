import type { RasterImage } from './types';

/**
 * Round-tripping a raster design through the saved session.
 *
 * **The working image, re-encoded — not the dropped file, not raw pixels.**
 *
 * Raw pixels were measured and rejected: 1024x1024 RGBA is 4.0 MB before JSON, against a MAX_BYTES
 * of 4 MB for the whole session. Re-encoded (2026-08-17, Chromium): flat art at 1024px is **24 KB**
 * as PNG, a photograph at 512px **703 KB**.
 *
 * PNG, not WebP (4 KB and 108 KB on the same two): lossless means a restored design quantizes to the
 * palette it had when saved; lossy would shift colours before the quantizer and could return a
 * filament list the user didn't choose. Caveat: the canvas round trip premultiplies alpha, so alpha
 * 1-254 can come back a step off; fully opaque and transparent pixels (flat art, cut-out photos) are exact.
 *
 * The working image, not the original, because it is what the pipeline traced: `decodeImageFile`
 * resolved the working size from the image's statistics, and re-reading the original would redo that
 * and could restore a near-threshold source at a different resolution.
 */
export function encodeWorkingImage(image: RasterImage): string | null {
  // Null rather than a throw, whole body in the try: this runs inside snapshotSession, outside saveSession's try, so an escape takes down the whole session over one image. The caller leaves that source out, as the app did for every image before this existed.
  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.w;
    canvas.height = image.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // A fresh ImageData, not wrapping `image.data`: the source may be SharedArrayBuffer-backed, which the ImageData constructor's types refuse.
    const out = ctx.createImageData(image.w, image.h);
    out.data.set(image.data);
    ctx.putImageData(out, 0, 0);
    // toDataURL, not toBlob: snapshotSession is synchronous, and an await between reading state and writing it lets a beforeunload save lose the race.
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** The inverse, for session restore. */
export async function decodeWorkingImage(dataUrl: string): Promise<RasterImage> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    // Bounded: `onload`/`onerror` may never settle in some environments, and a hung decode would stall the restore with the banner dismissed and nothing on screen. A local data URL not decoded by now isn't going to.
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
