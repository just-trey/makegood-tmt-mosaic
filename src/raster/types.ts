/** A decoded, already-downscaled image: RGBA rows, top-left origin, same y-down sense as SVG. */
export interface RasterImage {
  data: Uint8ClampedArray;
  w: number;
  h: number;
  /**
   * Edge density as measured at the fixed reference size, carried alongside the pixels because it
   * cannot be re-derived from them once the working size varies: the same image measures flatter
   * the larger it is decoded, since edges take up a smaller share of the pixels. Re-measuring the
   * working image would quietly move the flat-vs-photo thresholds — and the blur and despeckle
   * strengths that hang off them — every time the working size changed.
   */
  edgeDensity?: number;
  /**
   * Source long edge over working long edge, carried for the same reason as edgeDensity: the
   * working pixels no longer say how hard they were averaged. Past ~2:1 the downscale destroys the
   * anti-aliased fringe (see the fringe gate in parse.ts), and sub-2px width in what remains is
   * drawn content, not debris. Absent means "not resized or not known", both safe to treat as 1.
   */
  downscale?: number;
}

/**
 * A quantized image: one palette index per pixel, or BACKGROUND for pixels the trace must not
 * cover (transparent ones). `palette[i]` is the `#rrggbb` a label-`i` region paints with.
 */
export interface LabelMap {
  labels: Int16Array;
  w: number;
  h: number;
  palette: string[];
}

/** Label for a pixel that belongs to no region — transparent, and left as bare part surface. */
export const BACKGROUND = -1;

/**
 * Below this alpha a pixel is background — no region, bare part surface (see BACKGROUND).
 *
 * Lives here rather than next to the decoder so that the decoder can ask `measureImage` how
 * photographic an image is without the two modules importing each other in a circle.
 */
export const ALPHA_THRESHOLD = 128;

/** What `measureImage` reports about an image, and `autoParams` turns into trace settings. */
export interface ImageStats {
  /**
   * Fraction of pixels whose 3x3 neighborhood isn't uniform under a coarse quantization.
   * Flat art scores low (edges are thin lines between large constant fields); a photograph
   * scores high (almost every pixel differs from its neighbors).
   */
  edgeDensity: number;
}

export interface TraceParams {
  /** Box-blur radius in pixels applied before quantization; 0 disables the pass entirely. */
  blurRadius: number;
  /** Components smaller than this fraction of the image area are absorbed into their neighbor. */
  despeckleFrac: number;
  /**
   * Corner threshold: a fitted vertex below this stays a hard corner, above it becomes curved.
   * Unlike the other two this is a shape classifier rather than a coarseness control, and its
   * meaningful range is bounded (see ALPHA_MAX_LIMIT), which is why the Detail slider doesn't
   * scale it.
   */
  alphaMax: number;
  /** Max deviation in pixels when flattening a fitted curve to line segments. */
  flatness: number;
}

export interface RasterOptions {
  /** Target palette size — the Artwork panel's "Colors" slider. */
  colors: number;
  /** User multiplier on the auto-derived despeckle/simplify strength — the "Detail" slider. */
  detail: number;
  /**
   * mm per working pixel at the placement this trace is for. It resolves the whole despeckle
   * floor (`despeckleFloorPx`): sized in mm for flat art, which can lower it below the image
   * fraction as well as raise it. Absent where the placement is not knowable: a bench sweep, or a
   * session restored from before it was saved, and those keep the fractional floor.
   */
  mmPerPixel?: number;
}
