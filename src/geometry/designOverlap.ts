/**
 * Do two designs on one zone land on top of each other? Each color's inlay is `part ∩ prism`, so
 * where designs of *different* colors cross, the export carries two inlays in one volume and the
 * slicer picks arbitrarily. Preview and color list both look right, so it is caught at placement.
 * Works in the zone's 2D design space (mm), so it covers flat faces and conformal charts alike.
 */

/**
 * Fraction of the smaller design's placed footprint another must cover before it is worth saying.
 * Not zero: side-by-side designs touch boxes by a mm or two (two 50mm designs sharing 2mm of edge:
 * 4%). Capped by the app's own cascade: stepping by `INSTANCE_CASCADE_MM` (state/artwork.ts) leaves
 * two w×w designs covering ((w−d)/w)², so it fires only for w ≥ d/(1−√fraction): 16mm at a quarter,
 * 11.7mm at a tenth. A quarter let two cascaded 12mm stickers overlap 11% silently; the cascade now
 * steps smaller designs clear (CASCADE_CLEAR_MAX_MM), so the two meet at every size.
 */
export const OVERLAP_WARN_FRACTION = 0.1;

/**
 * One of a design's placed ink regions: outer ring first, then its holes, GeoJSON order. Rings are
 * open (no repeated closing point), in the same mm as `quad`.
 */
export type InkPolygon = number[][][];

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
  /**
   * The regions this design actually cuts, placed. Lazy: read only for a pair whose quads already
   * overlap enough to warn. Omitted, the quads decide alone.
   */
  ink?: () => InkPolygon[];
  /**
   * Placements that are one design by construction (a mirrored design and its reflection) share
   * a group and are never compared: the fill/fill arm warns before any quad or ink is read, and
   * "switch one to Sticker" is advice about a placement the user never made.
   */
  group?: string;
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
 * `subject` clipped to a CONVEX window by Sutherland-Hodgman: exact, can't throw, and keeps a turf
 * boolean off the rebuild's hot loop. A concave subject can leave degenerate edges along the window
 * joining disjoint pieces, which leave the area (all any caller wants) unchanged.
 */
export function clipToConvex(subject: number[][], window: number[][]): number[][] {
  let out = counterClockwise(subject);
  const clip = counterClockwise(window);
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
  return out;
}

/**
 * Area of the intersection of two CONVEX polygons. Both quads here are the affine image of a
 * bounding box, so each is a valid window for the other.
 */
export function convexIntersectionArea(subject: number[][], clipPoly: number[][]): number {
  const out = clipToConvex(subject, clipPoly);
  return out.length >= 3 ? Math.abs(signedArea(out)) : 0;
}

/**
 * Area of `ink` inside a convex `window` (all of it with none). Holes subtract, so a frame's ink is
 * its border, not the sheet it encloses — the point of consulting ink at all.
 */
function inkArea(ink: InkPolygon[], window?: number[][]): number {
  let total = 0;
  for (const rings of ink) {
    let a = 0;
    for (let i = 0; i < rings.length; i++) {
      const ring = window ? clipToConvex(rings[i], window) : rings[i];
      if (ring.length < 3) continue;
      a += (i === 0 ? 1 : -1) * Math.abs(signedArea(ring));
    }
    if (a > 0) total += a;
  }
  return total;
}

function crossing(prev: number[], cur: number[], dp: number, dc: number): number[] {
  const t = dp / (dp - dc);
  return [prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])];
}

/**
 * Pairs of designs on one zone that cover enough of each other to be a problem, in list order.
 * Two fills always qualify. Fill plus sticker is left alone: a pattern under a sticker is the
 * intended workflow, and the build cuts the fill back from under it.
 *
 * Quads first, then ink (docs/pipeline.md step 4): quads alone call a logo centred in a frame fully
 * covered. The ink figure is an upper bound on ink-on-ink overlap, so dropping a pair under it is
 * safe and no boolean runs on the rebuild; ink filling the shared box without touching still warns
 * (warnOverlappingDesigns's "may"). Denominators differ on purpose: line art covering a twentieth
 * of its sheet, dead on another copy, puts only a twentieth of a footprint in the box, so ink
 * measured against the footprint would silence the hardest overlaps.
 */
export function overlappingDesignPairs(placed: PlacedDesign[]): [PlacedDesign, PlacedDesign][] {
  const pairs: [PlacedDesign, PlacedDesign][] = [];
  const inkCache = new Map<PlacedDesign, InkPolygon[]>();
  const inkOf = (d: PlacedDesign): InkPolygon[] => {
    let v = inkCache.get(d);
    if (!v) inkCache.set(d, (v = d.ink!()));
    return v;
  };
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i],
        b = placed[j];
      if (a.group !== undefined && a.group === b.group) continue;
      if (a.fill !== b.fill) continue;
      if (a.fill && b.fill) {
        pairs.push([a, b]);
        continue;
      }
      const areaA = Math.abs(signedArea(a.quad)),
        areaB = Math.abs(signedArea(b.quad));
      const smaller = Math.min(areaA, areaB);
      if (!(smaller > 0)) continue; // a design with no extent can't cover anything
      const shared = clipToConvex(a.quad, b.quad);
      if (shared.length < 3) continue;
      if (Math.abs(signedArea(shared)) / smaller < OVERLAP_WARN_FRACTION) continue;
      if (a.ink && b.ink) {
        // Against the smaller design's INK, not its box: two identical 60mm frames with a 1.5mm
        // border sit exactly on top of each other at 9.75% of the box.
        const smallerInk = Math.min(inkArea(inkOf(a)), inkArea(inkOf(b)));
        if (!(smallerInk > 0)) continue; // one of them cuts nothing
        const reach = Math.min(inkArea(inkOf(a), shared), inkArea(inkOf(b), shared));
        if (reach / smallerInk < OVERLAP_WARN_FRACTION) continue;
      }
      pairs.push([a, b]);
    }
  }
  return pairs;
}
