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
 * Is this buffer a raster image rather than an SVG?
 *
 * Sniffed from the leading bytes rather than from `File.type` or the extension: a drag-and-drop
 * often arrives with an empty type, and users rename files. The magic numbers cannot be fooled and
 * cost a dozen lines.
 *
 * Deliberately "is it raster", not "can we decode it". GIF, BMP and TIFF are here even though the
 * pipeline has never been aimed at them, because the alternative is worse: anything this returns
 * false for goes to the SVG parser and comes back "SVG could not be parsed — check the file is
 * valid XML", which is true but useless, since the file isn't malformed XML, it's not XML at all.
 * Routed here, GIF and BMP simply work (the browser decodes both), and a TIFF gets decodeImageFile's
 * honest "this format could not be decoded" instead.
 */
export function isRasterBuffer(buf: Uint8Array): boolean {
  const magic = (offset: number, ...bytes: number[]) =>
    bytes.every((b, i) => offset + i < buf.length && buf[offset + i] === b);
  const png = magic(0, 0x89, 0x50, 0x4e, 0x47);
  const jpeg = magic(0, 0xff, 0xd8, 0xff);
  const webp = magic(0, 0x52, 0x49, 0x46, 0x46) && magic(8, 0x57, 0x45, 0x42, 0x50);
  const gif = magic(0, 0x47, 0x49, 0x46, 0x38); // GIF87a / GIF89a
  const bmp = magic(0, 0x42, 0x4d);
  const tiff = magic(0, 0x49, 0x49, 0x2a, 0x00) || magic(0, 0x4d, 0x4d, 0x00, 0x2a);
  return png || jpeg || webp || gif || bmp || tiff;
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
    throw new Error(
      'This image could not be decoded — the browser cannot read this format, or the file is ' +
        'damaged. PNG, JPG and WebP always work; TIFF never does. Re-export it as a PNG.',
    );
  }
  try {
    const srcEdge = Math.max(bitmap.width, bitmap.height);
    const reference = drawAt(bitmap, MEASURE_EDGE);
    const { edgeDensity } = measureImage(reference);
    if (isPhotographic(edgeDensity))
      return { ...reference, edgeDensity, downscale: srcEdge / Math.max(reference.w, reference.h) };

    const detailed = drawAt(bitmap, MAX_WORKING_EDGE);
    return { ...detailed, edgeDensity, downscale: srcEdge / Math.max(detailed.w, detailed.h) };
  } finally {
    bitmap.close();
  }
}
