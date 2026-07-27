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
 * Refuse to fill beyond this many tiles. A pattern scaled down far enough (5% on a chair panel)
 * would otherwise ask turf for tens of thousands of unions and hang the tab; the user sees a
 * warning and one tile instead.
 */
export const MAX_FILL_TILES = 1024;

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

/**
 * The tile offsets that cover `extent` once placed, computed by inverting the placement.
 *
 * Tiling happens in SVG user space, *before* the placement is applied: every `placer()` is a pure
 * affine map, so a grid laid out on the SVG axes lands as a correctly rotated, scaled and mirrored
 * grid on the surface — and because offset/scale/rotation all live inside that same map, tile phase
 * and tile size follow the fit sliders for free. Inverting it here is what tells us which copies
 * are actually needed: map each corner of the zone's extent back to SVG space, read off its tile
 * index, and take the range (padded one tile per side, so a shape overhanging its own cell still
 * reaches in from outside).
 *
 * Returns null when the map isn't invertible, isn't affine (a future non-affine mapper would make
 * the whole grid wrong rather than slightly off), or when the fill needs more than MAX_FILL_TILES.
 */
export function tileCoverage(
  place: (pt: number[]) => number[],
  cell: TileCell,
  extent: FillExtent,
): TileGrid | null {
  if (!(cell.w > 0) || !(cell.h > 0)) return null;
  const p00 = place([cell.x, cell.y]);
  const pu = place([cell.x + cell.w, cell.y]);
  const pv = place([cell.x, cell.y + cell.h]);
  // images of one tile step along each SVG axis
  const ax = pu[0] - p00[0],
    ay = pu[1] - p00[1];
  const bx = pv[0] - p00[0],
    by = pv[1] - p00[1];
  const det = ax * by - ay * bx;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;

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
      return null;
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
    if (!Number.isFinite(i) || !Number.isFinite(j)) return null;
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
  if (!Number.isFinite(count) || count <= 0 || count > MAX_FILL_TILES) return null;
  return { i0, i1, j0, j1, pitchX: cell.w, pitchY: cell.h, count };
}

/**
 * One color's regions repeated across the grid, in SVG space. The copies must be *unioned*, not
 * just collected: a tileable pattern draws every border-straddling shape on both sides of the seam,
 * so neighbouring copies overlap exactly — and an overlapping MultiPolygon extrudes into a
 * self-intersecting cutter that Manifold rejects as non-watertight.
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
  return unionAllCooperative(copies, onProgress, label);
}
