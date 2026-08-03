/** A decoded, already-downscaled image: RGBA rows, top-left origin, same y-down sense as SVG. */
export interface RasterImage {
  data: Uint8ClampedArray;
  w: number;
  h: number;
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
  /** RDP tolerance in pixels. */
  simplifyTol: number;
}

export interface RasterOptions {
  /** Target palette size — the Artwork panel's "Colors" slider. */
  colors: number;
  /** User multiplier on the auto-derived despeckle/simplify strength — the "Detail" slider. */
  detail: number;
}
