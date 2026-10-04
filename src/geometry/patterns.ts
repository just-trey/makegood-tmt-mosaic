import type { PolyFeature } from '../types';
import { mapFeatureCoords } from './manifold';
import { unionAllCooperative } from './regions';
import type { FillExtent } from './zones';

/**
 * The SVG-space cell one tile of a fill pattern occupies — the document's viewBox (parsing bakes
 * the viewBox origin out, so that cell starts at 0,0), or the artwork's bounding box when the file
 * declares no viewBox. One period of the pattern in each axis.
 */
export interface TileCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Refuse to fill beyond this many tiles: a pattern scaled down far enough (5% on a chair panel)
 * would ask turf for tens of thousands of unions and hang the tab. Also written out in
 * docs/troubleshooting.md's heading for the refusal message; change both in the same commit.
 */
export const MAX_FILL_TILES = 1024;

/**
 * Refuse to repeat a design when one color's tiles would carry more points than this. Guards the 3D
 * cut: past it Manifold's WASM heap runs out ("memory access out of bounds") and the part exports
 * with no artwork. (The clipping engine's limit is SWEEP_SEGMENT_CAP, regions.ts.)
 *
 * Measured on a 240mm face with this at Infinity, `node_modules/.bin/vite-node
 * scripts/bench-fill-build.ts zebra 240 <scale> [0.5]` (docs/findings/2026-09-24-tile-union-cap.md):
 * zebra filled at 544,400, 600,201 and 658,724 points (285-390s) and ran out of memory at 719,969.
 * 600k keeps zebra's 544,400 and dalmatian's 503,100 (the likeliest fills past 500k) with 17% under
 * the failure; the margin stays, since memory also follows the part's own mesh.
 */
export const FILL_POINT_BUDGET = 600_000;

/** Points in a feature's rings, which is what a tiled union pays for. */
export function featureVertexCount(f: PolyFeature | null): number {
  if (!f) return 0;
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.reduce((n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0), 0);
}

/** Which integer tile offsets (in SVG user units) a fill needs to cover its zone. */
export interface TileGrid {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
  pitchX: number;
  pitchY: number;
  count: number;
}

/** Why a fill couldn't be tiled, so the user isn't told to raise Scale where that won't help. */
export type TileRefusal =
  /** The design declares no repeat size: a zero-width or zero-height tile cell. */
  | 'no-tile-size'
  /** The placement collapses — it maps the whole tile to a line or a point, so it can't be inverted. */
  | 'not-invertible'
  /** The surface mapping isn't affine, so a grid laid out in SVG space wouldn't land as a grid. */
  | 'not-affine'
  /** The design is small enough against the surface to need more than MAX_FILL_TILES copies. */
  | 'too-many-tiles'
  /** Repeating the design would carry more points than FILL_POINT_BUDGET. */
  | 'too-detailed'
  /** A color's tiles joined into one shape too big for the clipping engine, found while tiling. */
  | 'joins-too-big';

/**
 * Filled in by `tileCoverage` on refusal; `detail` only on 'too-detailed'. Whether a bigger Scale
 * rescues the fill is not here: that needs the placer at the panel's largest Scale, which only the
 * caller has.
 */
export interface TileRefusalReport {
  reason?: TileRefusal;
  detail?: { tiles: number; points: number };
}

/**
 * The tile offsets that cover `extent` once placed, found by inverting the placement. Tiling is in
 * SVG space *before* placement: every `placer()` is affine, so an SVG-axis grid lands correctly
 * rotated, scaled and mirrored, with phase and size following the fit sliders. Each extent corner
 * maps back to a tile index; the range is padded one tile per side so a shape overhanging its cell
 * still reaches in.
 *
 * Null when the map isn't invertible or affine, the design has no repeat size, or the fill exceeds
 * MAX_FILL_TILES or FILL_POINT_BUDGET; `refusal` (an out-parameter, so other callers keep the plain
 * answer) says which. `vertsPerTile` is the biggest single color's count, which the budget was
 * measured against; the refusal covers the whole design, or colors land out of register.
 */
export function tileCoverage(
  place: (pt: number[]) => number[],
  cell: TileCell,
  extent: FillExtent,
  vertsPerTile: number,
  refusal?: TileRefusalReport,
): TileGrid | null {
  // Reset on entry, not per branch: the out-parameter invites reuse across two calls, and every
  // exit including the successful one has to leave it describing this call and no earlier one.
  if (refusal) {
    refusal.reason = undefined;
    refusal.detail = undefined;
  }
  const refuse = (reason: TileRefusal): null => {
    if (refusal) refusal.reason = reason;
    return null;
  };
  if (!(cell.w > 0) || !(cell.h > 0)) return refuse('no-tile-size');
  const p00 = place([cell.x, cell.y]);
  const pu = place([cell.x + cell.w, cell.y]);
  const pv = place([cell.x, cell.y + cell.h]);
  // images of one tile step along each SVG axis
  const ax = pu[0] - p00[0],
    ay = pu[1] - p00[1];
  const bx = pv[0] - p00[0],
    by = pv[1] - p00[1];
  const det = ax * by - ay * bx;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return refuse('not-invertible');

  // The grid is only valid because `place` is affine; probe a few interior/corner points against
  // what the linear map predicts rather than trusting that. The corner alone misses curvature
  // along a single axis (which still satisfies the parallelogram identity), hence the midpoints.
  const tol = 1e-6 * (Math.hypot(ax, ay) + Math.hypot(bx, by) + 1);
  for (const [s, t] of [
    [1, 1],
    [0.5, 0.5],
    [0.5, 0],
    [0, 0.5],
  ]) {
    const q = place([cell.x + s * cell.w, cell.y + t * cell.h]);
    if (
      Math.abs(q[0] - (p00[0] + s * ax + t * bx)) > tol ||
      Math.abs(q[1] - (p00[1] + s * ay + t * by)) > tol
    )
      return refuse('not-affine');
  }

  let minI = Infinity,
    maxI = -Infinity,
    minJ = Infinity,
    maxJ = -Infinity;
  for (const [X, Y] of [
    [extent.minX, extent.minY],
    [extent.maxX, extent.minY],
    [extent.minX, extent.maxY],
    [extent.maxX, extent.maxY],
  ]) {
    const dx = X - p00[0],
      dy = Y - p00[1];
    const i = (by * dx - bx * dy) / det;
    const j = (ax * dy - ay * dx) / det;
    if (!Number.isFinite(i) || !Number.isFinite(j)) return refuse('not-invertible');
    if (i < minI) minI = i;
    if (i > maxI) maxI = i;
    if (j < minJ) minJ = j;
    if (j > maxJ) maxJ = j;
  }
  const i0 = Math.floor(minI) - 1,
    i1 = Math.floor(maxI) + 1;
  const j0 = Math.floor(minJ) - 1,
    j1 = Math.floor(maxJ) + 1;
  const count = (i1 - i0 + 1) * (j1 - j0 + 1);
  // Unreachable today (i1 >= i0; indices range-checked above), but kept apart from the tile-count
  // case: "raise Scale" against a broken index range is the wrong-cause advice this split removes.
  if (!Number.isFinite(count) || count <= 0) return refuse('not-invertible');
  if (count > MAX_FILL_TILES) return refuse('too-many-tiles');
  // After the tile cap, not before: over MAX_FILL_TILES both are true and the count is the older,
  // more specific complaint.
  if (count * vertsPerTile > FILL_POINT_BUDGET) {
    if (refusal) refusal.detail = { tiles: count, points: vertsPerTile };
    return refuse('too-detailed');
  }
  return { i0, i1, j0, j1, pitchX: cell.w, pitchY: cell.h, count };
}

/**
 * One color's regions repeated across the grid, in SVG space. The copies must be *unioned*, not
 * just collected: a tileable pattern draws every border-straddling shape on both sides of the seam,
 * so neighbouring copies overlap exactly — and an overlapping MultiPolygon extrudes into a
 * self-intersecting cutter that Manifold rejects as non-watertight.
 *
 * Throws UnionTooBig when the copies weld into one polygon too big for the clipping engine, which
 * no split can divide: dalmatian's background does, one polygon per fill however many tiles.
 */
export async function tileFeature(
  feature: PolyFeature,
  grid: TileGrid,
  onProgress?: (fraction: number) => void,
  label?: string,
): Promise<PolyFeature | null> {
  const copies: PolyFeature[] = [];
  for (let j = grid.j0; j <= grid.j1; j++) {
    for (let i = grid.i0; i <= grid.i1; i++) {
      const dx = i * grid.pitchX,
        dy = j * grid.pitchY;
      copies.push(
        i === 0 && j === 0 ? feature : mapFeatureCoords(feature, (pt) => [pt[0] + dx, pt[1] + dy]),
      );
    }
  }
  return unionAllCooperative(copies, onProgress, label, true);
}
