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
 *
 * The number reaches the user twice: interpolated into the refusal message, and written out in
 * docs/troubleshooting.md's heading for that message, which quotes the string as a reader would
 * search for it. Change this and that heading is silently wrong — update it in the same commit.
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
 * Why a fill couldn't be tiled. Four separate failures used to reach one `null`, and the caller
 * told the user to raise Scale for all of them — advice that is right for exactly one.
 */
export type TileRefusal =
  /** The design declares no repeat size: a zero-width or zero-height tile cell. */
  | 'no-tile-size'
  /** The placement collapses — it maps the whole tile to a line or a point, so it can't be inverted. */
  | 'not-invertible'
  /** The surface mapping isn't affine, so a grid laid out in SVG space wouldn't land as a grid. */
  | 'not-affine'
  /** The design is small enough against the surface to need more than MAX_FILL_TILES copies. */
  | 'too-many-tiles';

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
 * the whole grid wrong rather than slightly off), when the design has no repeat size at all, or
 * when the fill needs more than MAX_FILL_TILES.
 *
 * `refusal`, when passed, is filled in with which of those it was. It is an out-parameter rather
 * than a richer return type so a caller that only wants "can this be tiled?" keeps the plain
 * `TileGrid | null` answer; the one caller that reports to a user needs the reason, because the
 * four have nothing in common to say about them.
 */
export function tileCoverage(
  place: (pt: number[]) => number[],
  cell: TileCell,
  extent: FillExtent,
  refusal?: { reason?: TileRefusal },
): TileGrid | null {
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
  // The non-finite/non-positive half is unreachable today (i1 >= i0 always, and the indices were
  // range-checked above) but is not folded into the tile-count case: they get opposite advice, and
  // "raise Scale" against a broken index range would be the exact wrong-cause problem this split
  // exists to remove.
  if (!Number.isFinite(count) || count <= 0) return refuse('not-invertible');
  if (count > MAX_FILL_TILES) return refuse('too-many-tiles');
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
