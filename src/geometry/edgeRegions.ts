import * as turf from '@turf/turf';
import type { PolyFeature, SVGShape } from '../types';
import type { ManifoldAPI } from './manifold';
import { boolOpWithRetry, shapeToFeature } from './regions';
import { warnBuild } from '../warnings';

type Ring = number[][];

/**
 * How close a region must come to the design-face boundary to count as touching it. A coincidence
 * tolerance, not a chosen distance: a clipped region that reached the outline has vertices
 * *exactly* on it, so this only survives the clip's float noise. Never shown, never a setting
 * (CLAUDE.md's tolerance rule).
 */
export const EDGE_TOUCH_TOL_MM = 0.1;

/**
 * Area a polygon must lose to the erosion to count as touching the outline. **Absolute**: the
 * erosion shaves a band `EDGE_TOUCH_TOL_MM` wide along the shared stretch, so the loss scales with
 * contact length, not size. A relative threshold (`kept < area * 0.999`) failed big regions: a
 * 6350 mm² region flush against a 110 mm-radius outline over a 6.5 mm arc loses 0.65 mm² but needed
 * 6.35 mm², read "interior", and printed a base-colour band along the rim (`tests/zones.test.ts`
 * pins it); a 43000 mm² block sharing 8 mm of outline did the same.
 * `EDGE_TOUCH_TOL_MM × 0.05 mm` is a contact a twentieth of a mm long, below any nozzle (shorter is
 * a corner touch), yet eight orders of magnitude above clipper noise on 100 mm coordinates.
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
 * Shrink a boundary polygon inward by `tolMm`. Manifold's 2D engine, not `turf.buffer` (geodesic in
 * 6.5: reads mm as degrees), with the toPolygons → shapeToFeature round-trip
 * `repairSelfIntersections` uses for winding and re-nesting. Null when the boundary erodes away: no
 * interior exists, so every region is an edge region.
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
 * A bucket grid over the eroded boundary's *segments*, so a polygon can ask "is the boundary near
 * me?" without touching the other 99% of it. One `turf.intersect` per polygon against the whole
 * face is quadratic in disguise: a 2000-vertex silhouette with 600 small islands took **1920ms per
 * color per part**, fifteen seconds a rebuild at eight colors.
 *
 * A face with many HOLES erodes them too, so "near the boundary" stops being rare: 600 polygons on
 * a 220mm face took 13ms at no holes, 351ms at 200, 599ms at 293, per color per part. Unreachable
 * today: every raster-corpus silhouette traces to at most one hole. The despeckle floor and
 * MAX_COMPONENTS (loosely; raster/trace.ts) hold it off; re-measure if either moves.
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
 * Split a placed, clipped region into the parts touching the design face's outer edge and the rest.
 * **Whole connected polygons, never a sub-band**: cutting only the strip near the edge would leave
 * a 3mm trench through the middle of a color. `eroded` is passed in so one erosion serves every
 * color; null means the face vanished under the tolerance and everything is edge.
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
    // No boundary segment near it, so it is wholly on one side and one point decides: almost every
    // polygon of a traced image, and why the split doesn't cost seconds per color (SegmentGrid).
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
      // Interior, the safe way: a recess where a through-cut was wanted still prints; a through-cut
      // where a recess was wanted is a hole. Warned, since a colour stopping short of the rim reads
      // as the feature broken.
      warnBuild(
        `Couldn't tell whether ${label ?? 'a region'} reaches the part's outer edge. It was cut ` +
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
