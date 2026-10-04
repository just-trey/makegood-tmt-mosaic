import type { ImageStats, RasterImage, TraceParams } from './types';
import { ALPHA_THRESHOLD } from './types';
import { NOZZLE_MM } from '../geometry/depth';

/** The Detail slider's multiplier on despeckle/simplify strength: 4x at full left, 1/4 at full right. */
export function detailStrength(detail: number): number {
  const clamped = Math.max(DETAIL_MIN, Math.min(DETAIL_MAX, detail));
  return Math.pow(DETAIL_RANGE, (DETAIL_DEFAULT - clamped) / DETAIL_DEFAULT);
}

/** Bits per channel kept when bucketing a pixel for edge density. 3 bits (8 levels) is coarse enough that a smooth gradient still reads as "changing" while JPEG ringing and downscale fringing around a flat-color edge mostly don't. */
const EDGE_BUCKET_SHIFT = 5;

/**
 * Where the flat-art and photograph regimes start and end; trace parameters interpolate between, so
 * no image sits on the wrong side of a cliff. Neither endpoint is measured, only their midpoint
 * (PHOTO_RESOLUTION_CUTOFF); their seed fixtures (scripts/gen-raster-fixtures.mjs) aren't in the
 * tree. Real flat art reaches 0.2042 (`vite-node scripts/bench-raster.ts corpus`), 1.7x the flat endpoint.
 */
const FLAT_EDGE_DENSITY = 0.12;
const PHOTO_EDGE_DENSITY = 0.45;

/**
 * Where the working resolution switches, as opposed to where parameters interpolate. A hard line:
 * the decoder must pick one size and a value between two resolutions doesn't exist. At the midpoint
 * of the blend band, so an image must read clearly more photographic than flat to lose the detail
 * pass. Measured (`vite-node scripts/bench-raster.ts corpus`): flat art tops out at 0.2042, six of
 * seven photographs start at 0.2905, and the seventh (a balloon on clear sky, 0.1762) suits flat treatment.
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
 * Blur added when the detail pass ran, replacing the low-pass it gave up.
 *
 * The downscale to working size doubled as a noise filter (decode.ts): a 1588px source averaged 3:1
 * to 512px loses the anti-aliased fringe along every colour boundary before quantization, while the
 * detail pass averages only 1.5:1, so those pixels survive, fall between two palette entries and get
 * assigned alternately — a cartoon's eye came back striped blue and white.
 *
 * Conditional because the loss is: an image too small to be enlarged (working size is capped, never
 * upscaled) gave up nothing, and applying it there does damage — on 12x12 pixel art it erased
 * thirteen of fourteen dark pixels, an isolated pixel, a one-pixel cross and an eight-pixel bar included.
 */
const DETAIL_PASS_BLUR = 1;

const PHOTO_PARAMS: TraceParams = {
  blurRadius: 2,
  despeckleFrac: 0.0022,
  alphaMax: 1.2,
  flatness: 0.4,
};

/**
 * Despeckle floor in working pixels for a design placed at `mmPerPixel`, or 0 where placement is
 * unknown and the fractional floor is all there is.
 *
 * The fractional floor means the same at any input resolution but nothing in millimetres: the same
 * image auto-fit to the 185mm footrest and the smallest hubcap's 30mm face gets floors over six
 * times apart in printed size. This is the half that doesn't move with the picture.
 *
 * **Deliberately not scaled by the Detail slider**, unlike the feature floor in `despeckleFloorPx`:
 * coarseness is taste, one nozzle square isn't — below it a component can't hold a single extrusion.
 * Between one nozzle and comfortably printable is the fractional floor's business.
 */
export function printableFloorPx(mmPerPixel: number): number {
  if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0) return 0;
  return Math.round((NOZZLE_MM / mmPerPixel) ** 2);
}

/**
 * Smallest printed feature flat art keeps when placement is known, as a square's side in mm. Four
 * nozzle widths, from a measured band (docs/findings/2026-08-24-despeckle-floor-recalibration.md):
 * on the flat corpus at the wheel placement every floor from 1.1mm to 5.3mm traced visually
 * identically, the quality cliff (mario loses eye, teeth and emblem) starts past 5.3mm, and ring
 * counts inflate the shapeToFeature quadratic below about 1.5mm. 1.6mm sits inside with margin.
 */
export const DESPECKLE_FEATURE_MM = 4 * NOZZLE_MM;

/** The fractional despeckle floor: `despeckleFrac` as working pixels, never under the no-op 1. */
export function fracFloorPx(params: TraceParams, w: number, h: number): number {
  return Math.max(1, Math.round(params.despeckleFrac * w * h));
}

/**
 * The despeckle floor a trace applies, in working pixels: sized in mm for flat art with a known
 * placement, bounded below by the nozzle and above by the fraction; photographs and unknown
 * placements keep the fraction alone. Measurements per branch, including why a photo's floor is
 * taste, in docs/findings/2026-08-24-despeckle-floor-recalibration.md.
 */
export function despeckleFloorPx(
  params: TraceParams,
  w: number,
  h: number,
  stats: ImageStats,
  detail: number,
  mmPerPixel = 0,
): number {
  const frac = fracFloorPx(params, w, h);
  // Gate on the placement being known, not `printable` nonzero: past ~0.4mm per pixel it rounds to 0 with the placement known, and a small logo placed large is where the fraction despeckles multi-mm features.
  if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0) return frac;
  const printable = printableFloorPx(mmPerPixel);
  if (isPhotographic(stats.edgeDensity)) return Math.max(frac, printable);
  const feature = Math.round((DESPECKLE_FEATURE_MM / mmPerPixel) ** 2 * detailStrength(detail));
  // Never 0: past ~3mm per working pixel the feature floor rounds to 0, which traceLabelMap reads as "placement unknown, use the fraction" — the inversion of what that coarse a placement means. 1 is the no-op floor.
  return Math.max(1, printable, Math.min(frac, feature));
}

/**
 * Ceiling on alphaMax. Past 4/3 the corner test accepts every vertex, so higher means "no corners
 * survive", not "smoother" (a square logo gets rounded corners). The interpolation can't reach it;
 * the clamp keeps that true if endpoints are retuned.
 */
const ALPHA_MAX_LIMIT = 4 / 3;

/**
 * Flatness floor and ceiling, in pixels. The floor stops full-right Detail turning a sub-pixel
 * tolerance into a point-count explosion — ring length is what `shapeToFeature` is quadratic in
 * (src/geometry/regions.ts), so this is a performance guard, not taste.
 */
const FLATNESS_MIN = 0.1;
const FLATNESS_MAX = 2;

/** Detail slider midpoint — the value at which the auto-derived parameters are used unchanged. */
export const DETAIL_DEFAULT = 50;

/** The slider's own ends, shared so markup and reading code can't drift. Derived, not 100: detailStrength's exponent is symmetric about the midpoint, so only twice it lands on the 1/4 DETAIL_RANGE promises at full right. */
export const DETAIL_MIN = 0;
export const DETAIL_MAX = 2 * DETAIL_DEFAULT;

/** How far Detail pulls the auto-derived strength each way: 4 means full-left quadruples the despeckle floor and simplify tolerance (bolder, fewer regions), full-right quarters them. */
const DETAIL_RANGE = 4;

/**
 * Fraction of pixels differing from a 4-neighbor once bucketed coarsely — the whole flat-art-vs-
 * photograph decision. The two differ in the *proportion* taken by transitions, not their colors:
 * flat art has them on thin outlines around constant fields, a photograph nearly everywhere. Fully
 * transparent pixels are skipped so a small logo on a big transparent sheet is judged on the logo.
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

  const strength = detailStrength(detail);

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  return {
    // An enlarged image gets exactly the detail-pass compensation, never the lerped share on top: on
    // mario the extra pixel widened every anti-aliased boundary into a band that quantized to a third
    // color (brown fringe on every black outline) and staircased the label boundary, and blur 1
    // alone has neither defect while keeping the eye the striping fix is for
    // (docs/findings/2026-08-24-despeckle-floor-recalibration.md). An image worked at its own size
    // keeps the lerped blur: that case wasn't measured and has no detail-pass compensation to fall back on.
    blurRadius: ranDetailPass
      ? DETAIL_PASS_BLUR
      : Math.round(lerp(FLAT_PARAMS.blurRadius, PHOTO_PARAMS.blurRadius)),
    despeckleFrac: lerp(FLAT_PARAMS.despeckleFrac, PHOTO_PARAMS.despeckleFrac) * strength,
    alphaMax: clamp(lerp(FLAT_PARAMS.alphaMax, PHOTO_PARAMS.alphaMax), 0, ALPHA_MAX_LIMIT),
    flatness: clamp(
      lerp(FLAT_PARAMS.flatness, PHOTO_PARAMS.flatness) * strength,
      FLATNESS_MIN,
      FLATNESS_MAX,
    ),
  };
}
