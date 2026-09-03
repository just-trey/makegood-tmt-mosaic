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
 * Two 50mm designs sharing 2mm of edge come to 4%, so that case stays quiet.
 *
 * The upper bound on this number is the app's own cascade. Stepping a second design diagonally by
 * `INSTANCE_CASCADE_MM` (state/artwork.ts) leaves two w×w designs covering ((w−d)/w)² of each
 * other, so the warning only fires for w ≥ d/(1−√fraction): 16mm at a quarter, 11.7mm at a tenth.
 * A quarter meant the app could cascade two 12mm stickers into an 11% overlap and say nothing about
 * geometry it had positioned itself. A tenth stays well above incidental edge contact, and the
 * cascade now steps a design smaller than that clear of the one it lands on rather than into a
 * silent sub-threshold overlap, so the two meet at every size (CASCADE_CLEAR_MAX_MM).
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
   * The regions this design actually cuts, placed. Lazy and read only for a pair whose quads
   * already overlap enough to warn, so the common case never pays to transform them.
   *
   * Omit it and the quads decide alone, which is what every caller did before the ink gate landed.
   */
  ink?: () => InkPolygon[];
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
 * `subject` clipped to a CONVEX window, by Sutherland-Hodgman.
 *
 * Deliberately not turf: clipping against a convex window is exact in a dozen lines and can't
 * throw, where the turf path would put a boolean (and its retry/fallback machinery, see
 * regions.ts) on the rebuild's hot loop. Convexity of the WINDOW is what makes this valid; the
 * subject may be concave, in which case the result can carry degenerate edges along the window
 * boundary that join otherwise disjoint pieces. Those cost nothing here because every caller
 * wants the area, which they leave unchanged.
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
 * How much of `ink` lands inside a convex `window`, in the same mm as the quads. Pass no window for
 * all of it.
 *
 * Holes are subtracted, so a frame's ink is its border and not the sheet it encloses, which is the
 * whole point of consulting the ink at all.
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
 * Which pairs of designs on one zone cover enough of each other to be a problem, in list order.
 *
 * Two fills always qualify: a fill repeats across the whole zone by definition, so a second one is
 * guaranteed to land on the first. A fill paired with a sticker is deliberately left alone — a
 * pattern background under a sticker is a real workflow, and flagging it would fire on the intended
 * use (see the note in docs/tech-debt.md on what that combination isn't checked for).
 *
 * Quads first, then ink. The quads answer "could these cut into each other" cheaply, and on their
 * own they answer it wrong for a design nested in another's hollow — a logo centered in a frame
 * reads as fully covered while the recesses never touch. So a pair that clears the quad test is
 * then asked how much of each design's ink reaches their shared rectangle, and dropped when the
 * smaller of those two areas is itself under the threshold.
 *
 * That second number is an upper bound on the real ink-on-ink overlap, never the overlap itself:
 * ink lives inside its own quad, so ink(A) ∩ ink(B) sits inside both "ink in the shared rectangle"
 * areas. Bounding rather than computing is what keeps the boolean this check exists to stay off out
 * of the rebuild — and being an upper bound is what makes dropping a pair safe, since a bound under
 * the threshold puts the true overlap under it too. The remaining approximation is the other way:
 * two designs whose ink fills the shared rectangle without ever touching still warn, which is what
 * warnOverlappingDesigns's "may" admits.
 *
 * The two gates measure against different denominators on purpose: the quad against the smaller
 * footprint, the ink against the smaller design's own ink. Sparse artwork is why. Line art covering
 * a twentieth of its sheet can land dead on another copy of itself and still put only a twentieth
 * of a footprint in the shared rectangle, so measuring the ink against the footprint would silence
 * exactly the designs that overlap hardest.
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
        // Against the smaller design's INK, not its bounding box. Against the box, a design whose
        // ink covers under a tenth of its own sheet could never reach the threshold however
        // completely it lands on another: two identical 60mm frames drawn with a 1.5mm border sit
        // exactly on top of each other at 9.75% of the box.
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
