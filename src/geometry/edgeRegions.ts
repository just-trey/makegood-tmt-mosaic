import * as turf from '@turf/turf';
import type { PolyFeature, SVGShape } from '../types';
import type { ManifoldAPI } from './manifold';
import { boolOpWithRetry, shapeToFeature } from './regions';
import { warnBuild } from '../warnings';

type Ring = number[][];

/**
 * How close a region has to come to the design-face boundary to count as touching it.
 *
 * A coincidence tolerance, not a distance anyone chose: regions arrive here already clipped to the
 * boundary, so one that reached the outline has vertices the clipper put *exactly* on it, and this
 * only has to survive the float noise of that clip. Deliberately far below anything a user would
 * recognise as a gap — it is never shown, never offered as a setting, and must not become either
 * (see the tolerance rule in CLAUDE.md).
 */
export const EDGE_TOUCH_TOL_MM = 0.1;

/**
 * How much area a polygon has to lose to the erosion before it counts as touching the outline.
 *
 * **Absolute, and that is the whole point.** The erosion shaves a band `EDGE_TOUCH_TOL_MM` wide
 * along whatever stretch the polygon shares with the boundary, so the area it removes goes with
 * the *contact length* — it has nothing to do with how big the polygon is. A relative threshold
 * (`kept < area * 0.999`) therefore gets harder to trip the larger the region grows, which is
 * backwards: a 6350 mm² region flush against a 110 mm-radius outline over a 6.5 mm arc loses
 * 0.65 mm² and needs 6.35 mm² to register, so it came out "interior" and printed a base-colour
 * band along exactly the rim this rule exists to colour. Caught in review; `tests/zones.test.ts`
 * pins it. A second measurement of the same failure: a 43000 mm² block sharing 8 mm of the
 * outline also read as interior.
 *
 * The value is `EDGE_TOUCH_TOL_MM × 0.05 mm` — a contact one twentieth of a millimetre long, far
 * below anything a nozzle resolves, so shorter contacts are corner touches rather than rims. That
 * is still eight orders of magnitude above the clipper's float noise on 100 mm coordinates, so
 * there is no band of inputs where the two considerations compete.
 */
const MIN_TOUCH_AREA_MM2 = EDGE_TOUCH_TOL_MM * 0.05;

/** Planar shoelace area of a turf feature, in mm². `turf.area` is geodesic and wrong here. */
function featureArea(feat: PolyFeature): number {
  const g = feat.geometry;
  const polys: Ring[][] =
    g.type === 'Polygon' ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][]);
  let total = 0;
  for (const rings of polys) {
    for (let ri = 0; ri < rings.length; ri++) {
      const r = rings[ri];
      let a = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++)
        a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
      // ring 0 is the outer boundary, the rest are holes
      total += ri === 0 ? Math.abs(a) / 2 : -Math.abs(a) / 2;
    }
  }
  return total;
}

/** Axis-aligned bounds of a feature: [minX, minY, maxX, maxY]. */
function featureBounds(feat: PolyFeature): [number, number, number, number] {
  const g = feat.geometry;
  const polys: Ring[][] =
    g.type === 'Polygon' ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][]);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const rings of polys)
    for (const p of rings[0]) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  return [minX, minY, maxX, maxY];
}

/** Each connected polygon of a feature as its own feature (outer ring plus its holes). */
function connectedPolygons(feat: PolyFeature): PolyFeature[] {
  const g = feat.geometry;
  if (g.type === 'Polygon') return [feat];
  return (g.coordinates as Ring[][]).map(
    (rings) =>
      ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: rings },
      }) as PolyFeature,
  );
}

/** Recombine a set of single-polygon features into one feature, or null if there are none. */
function combine(polys: PolyFeature[]): PolyFeature | null {
  if (!polys.length) return null;
  if (polys.length === 1) return polys[0];
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'MultiPolygon',
      coordinates: polys.map((p) => p.geometry.coordinates as Ring[]),
    },
  } as PolyFeature;
}

/**
 * Shrink a boundary polygon inward by `tolMm`, as a turf feature.
 *
 * Manifold's 2D engine, not `turf.buffer`: turf 6.5's buffer is *geodesic* and would read these
 * millimetre coordinates as degrees. Same offset call `narrowFeatureArea` uses, and the
 * toPolygons → shapeToFeature round-trip `repairSelfIntersections` uses, so the winding and
 * outer/hole re-nesting are handled by code already in service.
 *
 * Returns null when the boundary erodes away entirely — a face thinner than the tolerance, where
 * "interior" is not a place that exists and every region on it is an edge region.
 */
export function erodeBoundary(
  wasm: ManifoldAPI,
  boundary: PolyFeature,
  tolMm: number,
): PolyFeature | null {
  const g = boundary.geometry;
  const polys: Ring[][] =
    g.type === 'Polygon' ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][]);
  const contours = polys.flat().filter((r) => r.length >= 4);
  if (!contours.length) return null;
  const cs = new wasm.CrossSection(contours as [number, number][][], 'NonZero');
  try {
    const eroded = cs.offset(-tolMm, 'Miter', 2, 16);
    try {
      const rings = eroded.toPolygons();
      if (!rings.length) return null;
      const shape: SVGShape = {
        fill: '',
        order: 0,
        loops: rings.map((ring) => ring.map(([x, y]) => ({ x, y }))),
      };
      return shapeToFeature(shape);
    } finally {
      eroded.delete();
    }
  } finally {
    cs.delete();
  }
}

/**
 * A uniform bucket grid over the eroded boundary's *segments*, so a polygon can ask "does the
 * boundary run anywhere near me?" without touching the other 99% of it.
 *
 * This exists because the obvious implementation — one `turf.intersect` per polygon against the
 * whole eroded face — is quadratic in disguise, and traced artwork is exactly the input that
 * exposes it. Measured on a 2000-vertex silhouette carrying 600 small islands: **1920ms per color
 * per part**, which on a busy image with eight colors is fifteen seconds added to every rebuild.
 * With this prefilter only the polygons genuinely near the outline pay a boolean.
 *
 * A face with many HOLES erodes them too, so their rims are grid segments and "near the boundary"
 * stops being rare. Measured with 600 artwork polygons on a 220mm face: 13ms at no holes, 351ms at
 * 200, 599ms at 293, per color per part. Not reachable today, and measured rather than assumed:
 * every silhouette in the raster corpus traces to a face with at most one hole, and rebuild times
 * are unchanged against a single-loop face. The despeckle floor and MAX_COMPONENTS are what hold
 * it off, the cap loosely (see its note in raster/trace.ts); re-measure if either moves.
 */
class SegmentGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly cell: number;
  private readonly segs: number[][] = [];
  private readonly minX: number;
  private readonly minY: number;
  private col = (x: number): number => Math.floor((x - this.minX) / this.cell);
  private row = (y: number): number => Math.floor((y - this.minY) / this.cell);

  constructor(rings: Ring[]) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const r of rings)
      for (const p of r) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
    this.minX = minX;
    this.minY = minY;
    // ~64 cells across the longer axis: enough that a small island touches one or two, cheap
    // enough that a coarse boundary doesn't build a huge map. Guarded against a degenerate extent.
    const extent = Math.max(maxX - minX, maxY - minY);
    this.cell = extent > 0 ? extent / 64 : 1;
    for (const r of rings)
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const idx = this.segs.length;
        this.segs.push([
          Math.min(r[j][0], r[i][0]),
          Math.min(r[j][1], r[i][1]),
          Math.max(r[j][0], r[i][0]),
          Math.max(r[j][1], r[i][1]),
        ]);
        const s = this.segs[idx];
        for (let cx = this.col(s[0]); cx <= this.col(s[2]); cx++)
          for (let cy = this.row(s[1]); cy <= this.row(s[3]); cy++) {
            const k = cx * 100003 + cy;
            const at = this.cells.get(k);
            if (at) at.push(idx);
            else this.cells.set(k, [idx]);
          }
      }
  }

  /** Whether any boundary segment's bbox overlaps this one. Conservative: false means "nowhere near". */
  near(x0: number, y0: number, x1: number, y1: number): boolean {
    for (let cx = this.col(x0); cx <= this.col(x1); cx++)
      for (let cy = this.row(y0); cy <= this.row(y1); cy++) {
        const at = this.cells.get(cx * 100003 + cy);
        if (!at) continue;
        for (const i of at) {
          const s = this.segs[i];
          if (s[0] <= x1 && s[2] >= x0 && s[1] <= y1 && s[3] >= y0) return true;
        }
      }
    return false;
  }
}

/** Even-odd point-in-feature over every ring: outer rings admit, holes reject. */
function pointInFeature(rings: Ring[], x: number, y: number): boolean {
  let inside = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}

/** A point known to lie on the polygon: the first vertex of its outer ring. */
function firstVertex(poly: PolyFeature): number[] | null {
  const rings = poly.geometry.coordinates as Ring[];
  return rings[0]?.[0] ?? null;
}

/** Every ring of a feature, outer and hole alike. */
function allRings(feat: PolyFeature): Ring[] {
  const g = feat.geometry;
  const polys: Ring[][] =
    g.type === 'Polygon' ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][]);
  return polys.flat();
}

/**
 * Split a placed, already-boundary-clipped region into the parts that touch the design face's
 * outer edge and the parts that don't.
 *
 * **Whole connected polygons, never a sub-band.** A region straddling the boundary goes into
 * `edge` entire. Cutting only the strip within the tolerance would leave a 3mm trench running
 * through the middle of a color, which is not what "artwork touching the outer edge cuts the
 * full thickness" means — and would print as a groove the artist never drew.
 *
 * `eroded` is passed in rather than computed here so one erosion serves every color on a zone;
 * a null `eroded` means the face vanished under the tolerance and everything is an edge region.
 */
export function splitAtBoundary(
  feat: PolyFeature,
  eroded: PolyFeature | null,
  label?: string,
): { edge: PolyFeature | null; interior: PolyFeature | null } {
  if (!eroded) return { edge: feat, interior: null };
  const [ex0, ey0, ex1, ey1] = featureBounds(eroded);
  const rings = allRings(eroded);
  const grid = new SegmentGrid(rings);
  const edge: PolyFeature[] = [];
  const interior: PolyFeature[] = [];
  for (const poly of connectedPolygons(feat)) {
    const [px0, py0, px1, py1] = featureBounds(poly);
    // One-sided and cheap: a polygon reaching outside the eroded face's *bounding box* certainly
    // reaches outside the eroded face, so it is an edge region without a boolean. The converse
    // proves nothing, so anything inside the box still gets measured below.
    if (px0 < ex0 || py0 < ey0 || px1 > ex1 || py1 > ey1) {
      edge.push(poly);
      continue;
    }
    // No boundary segment anywhere near it, so it cannot straddle the eroded edge — it is wholly
    // on one side, and one point decides which. This is the case for almost every polygon of a
    // detailed traced image, and skipping the boolean for them is what keeps the split from
    // costing seconds per color (see SegmentGrid).
    if (!grid.near(px0, py0, px1, py1)) {
      // A vertex, not a centroid: a polygon can be concave enough not to contain its own centroid,
      // and a vertex is guaranteed to be on it. Landing exactly on `eroded`'s boundary is not
      // reachable here — that would mean a segment was near.
      const v = firstVertex(poly);
      (v && pointInFeature(rings, v[0], v[1]) ? interior : edge).push(poly);
      continue;
    }
    const r = boolOpWithRetry((x, y) => turf.intersect(x, y) as PolyFeature | null, poly, eroded);
    if (!r.ok) {
      // Classified interior, which is exactly the behavior before this rule existed: a recess
      // where a through-cut was wanted is the old, printable result, while a through-cut where a
      // recess was wanted is a hole in the part. So the unknown case falls the safe way — and
      // says so, because the visible symptom (one color's edge stops short of the rim) reads as
      // the feature being broken rather than as one region the clipper couldn't measure.
      warnBuild(
        `Couldn't tell whether ${label ?? 'a region'} reaches the part's outer edge — it was cut ` +
          `as a recess rather than through.`,
      );
      interior.push(poly);
      continue;
    }
    // Area rather than a containment predicate: turf 6.5's booleanContains is unreliable on the
    // many-ring multipolygons a traced silhouette produces, and the areas are already exact.
    const inside = r.val ?? null;
    const area = featureArea(poly);
    const keptArea = inside ? featureArea(inside) : 0;
    if (area > 0 && area - keptArea > MIN_TOUCH_AREA_MM2) edge.push(poly);
    else interior.push(poly);
  }
  return { edge: combine(edge), interior: combine(interior) };
}
