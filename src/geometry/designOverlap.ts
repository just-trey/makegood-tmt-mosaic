/**
 * Do two designs placed on the same zone land on top of each other?
 *
 * Two artworks cut into one surface are independent cutters: the body takes the union of their
 * pockets (fine), but each color's inlay is `part ∩ prism` (see buildAssemblyGeometry), so where
 * two designs of *different* colors cross, the export carries two inlay solids occupying the same
 * volume and a slicer resolves that arbitrarily. Nothing downstream detects it — the preview and
 * the color list both look right — so it has to be caught at placement time.
 *
 * Everything here works in the zone's own 2D design space (mm), which is what both mappers'
 * `placer()` produces, so the same test covers a flat face and a conformal chart.
 */

/**
 * How much of the smaller design's placed footprint another design must cover before this is worth
 * saying out loud, as a fraction of that smaller footprint's area.
 *
 * Not zero: two designs deliberately placed side by side routinely touch bounding boxes by a
 * millimetre or two of whitespace, and warning about that would train users to ignore the pill.
 * A quarter is well clear of that and well under the stacked case this exists for — a second design
 * loaded onto a single-zone part starts one cascade step (state/artwork.ts) from the first, which
 * on any part the app ships leaves >90% covered.
 */
export const OVERLAP_WARN_FRACTION = 0.25;

/** One design as placed on one zone, ready to be compared against the others on that zone. */
export interface PlacedDesign {
  /** what to call it in a warning — the design source's name */
  name: string;
  /**
   * The design's content bounding box pushed through the zone's placer: a convex quad, since both
   * placers are affine. Ignored for a fill, whose coverage is the whole zone rather than this.
   */
  quad: number[][];
  /** fill mode repeats the design across the entire zone */
  fill: boolean;
}

function signedArea(poly: number[][]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i],
      q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function counterClockwise(poly: number[][]): number[][] {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

/**
 * Area of the intersection of two CONVEX polygons, by Sutherland–Hodgman clipping.
 *
 * Deliberately not turf: clipping a convex subject against a convex window is exact in a dozen
 * lines and can't throw, where the turf path would put a boolean (and its retry/fallback
 * machinery, see regions.ts) on the rebuild's hot loop for two rectangles. Convexity is what makes
 * this valid, and it holds because every quad here is the affine image of a bounding box.
 */
export function convexIntersectionArea(subject: number[][], clipPoly: number[][]): number {
  let out = counterClockwise(subject);
  const clip = counterClockwise(clipPoly);
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i],
      b = clip[(i + 1) % clip.length];
    const ex = b[0] - a[0],
      ey = b[1] - a[1];
    // left of the edge (or on it) is inside, given counter-clockwise winding
    const side = (p: number[]): number => ex * (p[1] - a[1]) - ey * (p[0] - a[0]);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j],
        prev = input[(j + input.length - 1) % input.length];
      const dc = side(cur),
        dp = side(prev);
      if (dc >= 0) {
        if (dp < 0) out.push(crossing(prev, cur, dp, dc));
        out.push(cur);
      } else if (dp >= 0) {
        out.push(crossing(prev, cur, dp, dc));
      }
    }
  }
  return out.length >= 3 ? Math.abs(signedArea(out)) : 0;
}

function crossing(prev: number[], cur: number[], dp: number, dc: number): number[] {
  const t = dp / (dp - dc);
  return [prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])];
}

/**
 * Which pairs of designs on one zone cover enough of each other to be a problem, in list order.
 *
 * Two fills always qualify: a fill repeats across the whole zone by definition, so a second one is
 * guaranteed to land on the first. A fill paired with a sticker is deliberately left alone — a
 * pattern background under a sticker is a real workflow, and flagging it would fire on the intended
 * use (see the note in docs/tech-debt.md on what that combination isn't checked for).
 */
export function overlappingDesignPairs(placed: PlacedDesign[]): [PlacedDesign, PlacedDesign][] {
  const pairs: [PlacedDesign, PlacedDesign][] = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i],
        b = placed[j];
      if (a.fill !== b.fill) continue;
      if (a.fill && b.fill) {
        pairs.push([a, b]);
        continue;
      }
      const areaA = Math.abs(signedArea(a.quad)),
        areaB = Math.abs(signedArea(b.quad));
      const smaller = Math.min(areaA, areaB);
      if (!(smaller > 0)) continue; // a design with no extent can't cover anything
      if (convexIntersectionArea(a.quad, b.quad) / smaller >= OVERLAP_WARN_FRACTION)
        pairs.push([a, b]);
    }
  }
  return pairs;
}
