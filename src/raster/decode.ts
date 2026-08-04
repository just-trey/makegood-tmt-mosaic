import type { RasterImage } from './types';

/**
 * Longest edge, in pixels, the pipeline works at. Everything downstream is bounded by this:
 * quantization is O(pixels) and the tracer walks pixel boundaries. The bilinear downscale doubles
 * as the first noise filter.
 *
 * 512 rather than something larger for two independent reasons, one measured and one physical.
 * Measured (scripts/bench-raster.ts, hostile noise source): 512 costs ~550ms across measure +
 * quantize + trace where 768 costs ~1.4s, because component count — and so tracing — climbs far
 * faster than the pixel count. Physical: 512px across the largest part the app targets (the wheel,
 * 276mm) is 0.54mm per pixel, already coarser than a 0.4mm nozzle can express, so the extra
 * resolution would be resolving detail that cannot be printed.
 *
 * What this number does *not* bound any more is edge smoothness. It used to, because the pixel
 * lattice was also the output vertex set, which put a 0.54mm staircase on every diagonal; curve.ts
 * now fits sub-pixel curves through those pixels, so outlines stay smooth at any print size and
 * raising this would buy finer *detail*, not cleaner edges.
 */
export const MAX_WORKING_EDGE = 512;

/** Below this alpha a pixel is background — no region, bare part surface (see BACKGROUND). */
export const ALPHA_THRESHOLD = 128;

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

/** Target size preserving aspect, capped at MAX_WORKING_EDGE. Never upscales. */
export function workingSize(w: number, h: number): { w: number; h: number } {
  const scale = Math.min(1, MAX_WORKING_EDGE / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/**
 * Decode an image file to RGBA pixels at working size.
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
    const { w, h } = workingSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('This browser could not open a 2D canvas to read the image.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    return { data, w, h };
  } finally {
    bitmap.close();
  }
}
