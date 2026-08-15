import { describe, expect, it } from 'vitest';
import {
  MAX_FILL_TILES,
  tileCoverage,
  tileFeature,
  type TileGrid,
  type TileRefusal,
} from '../src/geometry/patterns';
import { mapFeatureCoords } from '../src/geometry/manifold';
import { planarArea, safeIntersect } from '../src/geometry/regions';
import type { PolyFeature } from '../src/types';

function rect(x0: number, y0: number, x1: number, y1: number): PolyFeature {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
          [x0, y0],
        ],
      ],
    },
  } as PolyFeature;
}

/** An affine placer of the kind every ZoneMapper.placer() returns: scale, rotate, translate. */
function affine(scale: number, deg: number, tx: number, ty: number): (pt: number[]) => number[] {
  const r = (deg * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  return (pt) => {
    const x = pt[0] * scale,
      y = pt[1] * scale;
    return [x * c - y * s + tx, x * s + y * c + ty];
  };
}

const CELL = { x: 0, y: 0, w: 10, h: 10 };

describe('tileCoverage', () => {
  it('spans the extent in tile steps, padded one tile per side', () => {
    const grid = tileCoverage((pt) => pt, CELL, { minX: 0, minY: 0, maxX: 30, maxY: 30 })!;
    expect(grid).not.toBeNull();
    expect({ i0: grid.i0, i1: grid.i1, j0: grid.j0, j1: grid.j1 }).toEqual({
      i0: -1,
      i1: 4,
      j0: -1,
      j1: 4,
    });
    expect(grid.pitchX).toBe(10);
    expect(grid.count).toBe(36);
  });

  it('covers the whole extent under a rotated, scaled and offset placement', async () => {
    const place = affine(1.7, 33, 12, -5);
    const extent = { minX: -40, minY: -25, maxX: 35, maxY: 60 };
    const grid = tileCoverage(place, CELL, extent)!;
    expect(grid).not.toBeNull();
    const tiled = (await tileFeature(rect(0, 0, 10, 10), grid))!;
    const placed = mapFeatureCoords(tiled, place);
    const inside = safeIntersect(placed, rect(extent.minX, extent.minY, extent.maxX, extent.maxY));
    const extentArea = (extent.maxX - extent.minX) * (extent.maxY - extent.minY);
    // full coverage: the tiling ∩ the extent IS the extent (a bbox check would pass on a rotated
    // grid that leaves corners bare)
    expect(planarArea(inside!)).toBeCloseTo(extentArea, 3);
  });

  it('mirrored placements (negative determinant) still resolve a grid', () => {
    const grid = tileCoverage((pt) => [-pt[0], pt[1]], CELL, {
      minX: -30,
      minY: 0,
      maxX: 0,
      maxY: 10,
    });
    expect(grid).not.toBeNull();
    expect(grid!.count).toBeGreaterThan(0);
  });

  it('refuses a fill that would need more than MAX_FILL_TILES tiles', () => {
    const tiny = { x: 0, y: 0, w: 0.5, h: 0.5 };
    const grid = tileCoverage((pt) => pt, tiny, { minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(grid).toBeNull();
    // sanity: the same extent with a workable tile size is allowed
    expect(
      tileCoverage((pt) => pt, CELL, { minX: 0, minY: 0, maxX: 100, maxY: 100 })!.count,
    ).toBeLessThanOrEqual(MAX_FILL_TILES);
  });

  it('refuses a degenerate cell or a non-invertible placement', () => {
    expect(
      tileCoverage((pt) => pt, { x: 0, y: 0, w: 0, h: 10 }, { minX: 0, minY: 0, maxX: 1, maxY: 1 }),
    ).toBeNull();
    expect(tileCoverage(() => [0, 0], CELL, { minX: 0, minY: 0, maxX: 30, maxY: 30 })).toBeNull();
  });

  it('refuses a non-affine placement rather than laying a wrong grid', () => {
    const bent = (pt: number[]): number[] => [pt[0], pt[1] + pt[0] * pt[0] * 0.01];
    expect(tileCoverage(bent, CELL, { minX: 0, minY: 0, maxX: 30, maxY: 30 })).toBeNull();
  });

  // The four refusals share one return value and used to share one message. Whoever reports them
  // needs to tell them apart, so each one has to name itself.
  it('says which of the four refusals it was', () => {
    const reasonFor = (
      place: (pt: number[]) => number[],
      cell: typeof CELL,
      extent: { minX: number; minY: number; maxX: number; maxY: number },
    ): TileRefusal | undefined => {
      const out: { reason?: TileRefusal } = {};
      expect(tileCoverage(place, cell, extent, out)).toBeNull();
      return out.reason;
    };
    const wide = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(reasonFor((pt) => pt, { x: 0, y: 0, w: 0, h: 10 }, wide)).toBe('no-tile-size');
    expect(reasonFor(() => [0, 0], CELL, wide)).toBe('not-invertible');
    expect(
      reasonFor((pt) => [pt[0], pt[1] + pt[0] * pt[0] * 0.01], CELL, {
        minX: 0,
        minY: 0,
        maxX: 30,
        maxY: 30,
      }),
    ).toBe('not-affine');
    expect(reasonFor((pt) => pt, { x: 0, y: 0, w: 0.5, h: 0.5 }, wide)).toBe('too-many-tiles');
  });

  it('leaves the reason untouched when the fill tiles fine', () => {
    const out: { reason?: TileRefusal } = {};
    expect(
      tileCoverage((pt) => pt, CELL, { minX: 0, minY: 0, maxX: 30, maxY: 30 }, out),
    ).not.toBeNull();
    expect(out.reason).toBeUndefined();
  });
});

describe('tileFeature', () => {
  const grid3 = (): TileGrid => ({
    i0: 0,
    i1: 2,
    j0: 0,
    j1: 2,
    pitchX: 10,
    pitchY: 10,
    count: 9,
  });

  it('repeats a disjoint shape once per tile', async () => {
    const out = (await tileFeature(rect(2, 2, 7, 7), grid3()))!;
    expect(out).not.toBeNull();
    expect(planarArea(out)).toBeCloseTo(9 * 25, 6);
    expect((out.geometry.coordinates as unknown[]).length).toBe(9);
  });

  it('welds a border-straddling shape into one polygon across the seam', async () => {
    // the two halves of a shape that wraps the tile's right edge, as a tileable pattern draws it
    const straddle: PolyFeature = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          rect(8, 0, 10, 10).geometry.coordinates,
          rect(0, 0, 2, 10).geometry.coordinates,
        ],
      },
    } as PolyFeature;
    const out = (await tileFeature(straddle, {
      i0: 0,
      i1: 1,
      j0: 0,
      j1: 0,
      pitchX: 10,
      pitchY: 10,
      count: 2,
    }))!;
    expect(out).not.toBeNull();
    // [0,2] ∪ [8,12] ∪ [18,20] — the halves at x=10 must have merged, not stayed two pieces
    expect(out.geometry.type).toBe('MultiPolygon');
    expect((out.geometry.coordinates as unknown[]).length).toBe(3);
    expect(planarArea(out)).toBeCloseTo(80, 6);
    // the welded piece is one 8→12 rectangle, not two touching at x=10
    const xs = (out.geometry.coordinates as number[][][][])
      .map((poly) => poly[0].map((p) => p[0]))
      .find((r) => Math.min(...r) === 8)!;
    expect(Math.max(...xs)).toBe(12);
  });

  it('reports progress while unioning', async () => {
    const seen: number[] = [];
    await tileFeature(rect(2, 2, 7, 7), grid3(), (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeCloseTo(1, 6);
  });
});
