import type { ImageStats, RasterImage, TraceParams } from './types';
import { ALPHA_THRESHOLD } from './types';

/**
 * Bits per channel kept when bucketing a pixel for the edge-density measurement. 3 bits (8 levels
 * per channel) is coarse enough that a smooth gradient still reads as "changing" while JPEG ringing
 * and downscale fringing around a flat-color edge mostly don't.
 */
const EDGE_BUCKET_SHIFT = 5;

/**
 * Where the flat-art and photograph regimes are taken to start and end. Between them the trace
 * parameters interpolate, so there is no cliff an image can sit on the wrong side of.
 *
 * These two are the plan's "measure, don't guess" numbers: they are seeded from the rasterized
 * fixtures in scripts/gen-raster-fixtures.mjs (flat art lands near 0.05, photographs near 0.6) and
 * should be re-checked against that set rather than adjusted by eye on one file.
 */
const FLAT_EDGE_DENSITY = 0.12;
const PHOTO_EDGE_DENSITY = 0.45;

/**
 * Where the working resolution switches, as opposed to where the trace parameters interpolate.
 *
 * Deliberately a hard line rather than another interpolation: the decoder has to pick one size to
 * draw at, and a value halfway between two resolutions doesn't exist. Set at the midpoint of the
 * band the parameters blend across, so an image has to read clearly more photographic than flat
 * before it loses the detail pass.
 */
const PHOTO_RESOLUTION_CUTOFF = (FLAT_EDGE_DENSITY + PHOTO_EDGE_DENSITY) / 2;

/** Whether an image is photographic enough that extra working resolution would buy noise. */
export function isPhotographic(edgeDensity: number): boolean {
  return edgeDensity >= PHOTO_RESOLUTION_CUTOFF;
}

const FLAT_PARAMS: TraceParams = {
  blurRadius: 0,
  despeckleFrac: 0.00015,
  alphaMax: 1.0,
  flatness: 0.25,
};

/**
 * Blur added when the detail pass ran, to replace the low-pass it gave up.
 *
 * The downscale to the working size was always doing double duty as a noise filter — see decode.ts.
 * A 1588px source averaged 3:1 down to 512px loses the anti-aliased fringe along every colour
 * boundary before quantization sees it; the detail pass only averages 1.5:1, so those pixels
 * survive, fall between two palette entries and get assigned alternately. A cartoon's eye came back
 * striped blue and white.
 *
 * It is conditional because the loss is. An image small enough that the detail pass never enlarges
 * it — the working size is capped, never upscaled — was not downscaled any harder on the old path
 * either, so nothing was given up and there is nothing to replace. Applying it there does real
 * damage instead: on 12x12 pixel art it erased thirteen of fourteen dark pixels, taking an isolated
 * pixel, a one-pixel cross and an eight-pixel bar with it.
 */
const DETAIL_PASS_BLUR = 1;
const PHOTO_PARAMS: TraceParams = {
  blurRadius: 2,
  despeckleFrac: 0.0022,
  alphaMax: 1.2,
  flatness: 0.4,
};

/**
 * Nozzle width in mm: the reference for what a printer can lay down at all.
 *
 * A component with less area than one nozzle square cannot hold a single extrusion of any shape,
 * so nothing this floor removes was going to print. That is deliberately the weakest claim
 * available about a feature size, and it is why the Detail slider does not scale it: coarseness is
 * a taste control and this is not one. Everything between one nozzle and comfortably printable
 * stays the fractional floor's business.
 */
const NOZZLE_MM = 0.4;

/**
 * Despeckle floor in working pixels for a design placed at `mmPerPixel`, or 0 where the placement
 * is unknown and the fractional floor is the only one there is.
 *
 * The fractional floor means the same thing at any input resolution, which is what it was chosen
 * for, but it cannot mean anything in millimetres: the same image auto-fit to the 185mm footrest
 * and to the smallest hubcap's 30mm face gets floors over six times apart in printed size. This is
 * the half that does not move with the picture.
 */
export function printableFloorPx(mmPerPixel: number): number {
  if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0) return 0;
  return Math.round((NOZZLE_MM / mmPerPixel) ** 2);
}

/**
 * Ceiling on alphaMax. Past 4/3 the corner test accepts every vertex, so a higher number doesn't
 * mean "smoother", it means "no corners survive anywhere" — a square logo comes back with rounded
 * corners. The interpolation below can't reach it, but the clamp keeps that true if the endpoints
 * are ever retuned.
 */
const ALPHA_MAX_LIMIT = 4 / 3;

/**
 * Flatness floor and ceiling, in pixels. The floor is what stops full-right Detail from turning a
 * sub-pixel sampling tolerance into a point-count explosion: ring length is what `shapeToFeature`
 * is quadratic in (see its note in src/geometry/regions.ts), so this bound is a performance guard,
 * not a taste one.
 */
const FLATNESS_MIN = 0.1;
const FLATNESS_MAX = 2;

/** Detail slider midpoint — the value at which the auto-derived parameters are used unchanged. */
export const DETAIL_DEFAULT = 50;

/**
 * How far the Detail slider can pull the auto-derived strength in each direction. 4 means full-left
 * quadruples the despeckle floor and simplify tolerance (bolder, fewer regions) and full-right
 * quarters them (finer, more regions).
 */
const DETAIL_RANGE = 4;

/**
 * Fraction of pixels that differ from a 4-neighbor once bucketed coarsely.
 *
 * This is the whole flat-art-vs-photograph decision. It works because the two differ in the
 * *proportion* of the image taken up by transitions, not in their colors: flat art puts its
 * transitions on thin outlines around large constant fields, a photograph has one nearly
 * everywhere. Fully transparent pixels are skipped so a small logo on a big transparent sheet is
 * judged on the logo rather than on the empty margin around it.
 */
export function measureImage(img: RasterImage): ImageStats {
  const { data, w, h } = img;
  const bucket = (i: number) =>
    ((data[i] >> EDGE_BUCKET_SHIFT) << 16) |
    ((data[i + 1] >> EDGE_BUCKET_SHIFT) << 8) |
    (data[i + 2] >> EDGE_BUCKET_SHIFT);

  let counted = 0;
  let edges = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < ALPHA_THRESHOLD) continue;
      counted++;
      const b = bucket(i);
      const right = x + 1 < w ? (y * w + x + 1) * 4 : -1;
      const down = y + 1 < h ? ((y + 1) * w + x) * 4 : -1;
      if (
        (right >= 0 && data[right + 3] >= ALPHA_THRESHOLD && bucket(right) !== b) ||
        (down >= 0 && data[down + 3] >= ALPHA_THRESHOLD && bucket(down) !== b)
      )
        edges++;
    }
  }
  return { edgeDensity: counted ? edges / counted : 0 };
}

/** Trace settings for an image, from what it measures as and where the user put Detail. */
export function autoParams(
  stats: ImageStats,
  detail: number = DETAIL_DEFAULT,
  ranDetailPass = false,
): TraceParams {
  const span = PHOTO_EDGE_DENSITY - FLAT_EDGE_DENSITY;
  const t = Math.max(0, Math.min(1, (stats.edgeDensity - FLAT_EDGE_DENSITY) / span));
  const lerp = (a: number, b: number) => a + (b - a) * t;

  const clampedDetail = Math.max(0, Math.min(100, detail));
  const strength = Math.pow(DETAIL_RANGE, (DETAIL_DEFAULT - clampedDetail) / DETAIL_DEFAULT);

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  return {
    blurRadius:
      Math.round(lerp(FLAT_PARAMS.blurRadius, PHOTO_PARAMS.blurRadius)) +
      (ranDetailPass ? DETAIL_PASS_BLUR : 0),
    despeckleFrac: lerp(FLAT_PARAMS.despeckleFrac, PHOTO_PARAMS.despeckleFrac) * strength,
    alphaMax: clamp(lerp(FLAT_PARAMS.alphaMax, PHOTO_PARAMS.alphaMax), 0, ALPHA_MAX_LIMIT),
    flatness: clamp(
      lerp(FLAT_PARAMS.flatness, PHOTO_PARAMS.flatness) * strength,
      FLATNESS_MIN,
      FLATNESS_MAX,
    ),
  };
}
