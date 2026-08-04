import type { RasterImage } from './types';
import { measureImage, isPhotographic } from './stats';

/**
 * Longest edge, in pixels, that flat art is worked at — line drawings, logos, cartoons, anything
 * whose fidelity lives in its outlines.
 *
 * This used to be 512 for everything, on two arguments. The measured one (scripts/bench-raster.ts)
 * was that tracing cost climbs far faster than pixel count. The physical one was that 512px across
 * the wheel's 276mm is 0.54mm per pixel, already coarser than a 0.4mm nozzle, so more resolution
 * would resolve detail that cannot be printed.
 *
 * The physical argument was about *detail* and it still holds. What it never covered is that the
 * lattice was also the output vertex set, so 512 was simultaneously deciding how much of the image
 * survived and how jagged its edges were. Curve fitting (curve.ts) separated those, and re-measured
 * the first: a 1588px cartoon traced at 512 loses the pupils and highlights out of its eyes, and at
 * 1024 keeps them. The cost is affordable precisely because fitting cut point counts — flat art at
 * 1024 carries fewer points (2050) than the old lattice tracer produced at 512 (4676).
 */
export const MAX_WORKING_EDGE = 1024;

/**
 * Working size for photographic sources, and the fixed size every image is measured at.
 *
 * Photographs are the case the old cost argument was really about: at 1024 they carry 11.5k points
 * against 4.7k at 512, for detail that is mostly sensor noise rather than anything a nozzle will
 * lay down. They stay here.
 *
 * It doubles as the measurement size because edge density is resolution-dependent — the same image
 * reads flatter the larger it is decoded — and the flat-vs-photo thresholds in stats.ts, plus every
 * blur and despeckle strength derived from them, were calibrated at this size.
 */
export const MEASURE_EDGE = 512;

/**
 * Is this buffer a raster image the decoder can handle?
 *
 * Sniffed from the leading bytes rather than from `File.type` or the extension: a drag-and-drop
 * often arrives with an empty type, and users rename files. The magic numbers cannot be fooled and
 * cost a dozen lines.
 */
export function isRasterBuffer(buf: Uint8Array): boolean {
  const at = (i: number) => (i < buf.length ? buf[i] : -1);
  const png = at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47;
  const jpeg = at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
  const webp =
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50;
  return png || jpeg || webp;
}

/** Target size preserving aspect, capped at `maxEdge`. Never upscales. */
export function workingSize(w: number, h: number, maxEdge: number): { w: number; h: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

function drawAt(bitmap: ImageBitmap, maxEdge: number): RasterImage {
  const { w, h } = workingSize(bitmap.width, bitmap.height, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser could not open a 2D canvas to read the image.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

/**
 * Decode an image file to RGBA pixels at the working size its own content earns.
 *
 * Two passes, and the first one is not wasted: the image is always drawn at MEASURE_EDGE and
 * measured there, both because that is the size stats.ts's thresholds were calibrated against and
 * because the answer decides the second pass. Flat art is redrawn larger, where its outlines have
 * detail worth keeping; a photograph keeps the first draw, where the extra pixels would buy noise.
 *
 * `imageOrientation: 'from-image'` matters more than it looks: a photo straight off a phone
 * carries its rotation in EXIF, and without this the artwork would arrive sideways with no
 * control in the app able to explain why.
 */
export async function decodeImageFile(file: Blob): Promise<RasterImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This image could not be decoded — check the file is a valid PNG or JPEG.');
  }
  try {
    const reference = drawAt(bitmap, MEASURE_EDGE);
    const { edgeDensity } = measureImage(reference);
    if (isPhotographic(edgeDensity)) return { ...reference, edgeDensity };

    const detailed = drawAt(bitmap, MAX_WORKING_EDGE);
    return { ...detailed, edgeDensity };
  } finally {
    bitmap.close();
  }
}
