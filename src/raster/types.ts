/** A decoded, already-downscaled image: RGBA rows, top-left origin, same y-down sense as SVG. */
export interface RasterImage {
  data: Uint8ClampedArray;
  w: number;
  h: number;
  /**
   * Edge density as measured at the fixed reference size, carried with the pixels because it can't be
   * re-derived once the working size varies: the same image measures flatter the larger it's
   * decoded. Re-measuring would move the flat-vs-photo thresholds, and the blur and despeckle
   * strengths hanging off them, whenever the working size changed.
   */
  edgeDensity?: number;
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

/** Below this alpha a pixel is background (see BACKGROUND). Lives here, not by the decoder, so the decoder can ask `measureImage` without the two modules importing each other in a circle. */
export const ALPHA_THRESHOLD = 128;

/** What `measureImage` reports about an image, and `autoParams` turns into trace settings. */
export interface ImageStats {
  /** Fraction of pixels whose 3x3 neighborhood isn't uniform under a coarse quantization. Flat art scores low (thin edges between constant fields), a photograph high. */
  edgeDensity: number;
}

export interface TraceParams {
  /** Box-blur radius in pixels applied before quantization; 0 disables the pass entirely. */
  blurRadius: number;
  /** Components smaller than this fraction of the image area are absorbed into their neighbor. */
  despeckleFrac: number;
  /** Corner threshold: a fitted vertex below this stays a hard corner, above it curves. A shape classifier, not a coarseness control — its meaningful range is bounded (ALPHA_MAX_LIMIT), so Detail doesn't scale it. */
  alphaMax: number;
  /** Max deviation in pixels when flattening a fitted curve to line segments. */
  flatness: number;
}

export interface RasterOptions {
  /** Target palette size — the Artwork panel's "Colors" slider. */
  colors: number;
  /** User multiplier on the auto-derived despeckle/simplify strength — the "Detail" slider. */
  detail: number;
  /** mm per working pixel at the placement traced for; resolves the whole despeckle floor (`despeckleFloorPx`), sized in mm for flat art, which can lower it below the image fraction as well as raise it. Absent where unknowable (a bench sweep, or a session saved before it existed), which keeps the fractional floor. */
  mmPerPixel?: number;
  /** The image's name, used only in the empty-trace error message. Optional so bench sweeps and fixtures that never surface that error needn't invent one. */
  name?: string;
}
