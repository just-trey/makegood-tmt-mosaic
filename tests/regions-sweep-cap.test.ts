import * as turf from '@turf/turf';
import polygonClipping from 'polygon-clipping';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  boolOpUnderCap,
  boolOpWithRetry,
  differenceAllChecked,
  differenceChecked,
  intersectChecked,
  planarArea,
  safeUnion,
  segmentCount,
  SWEEP_SEGMENT_CAP,
  UnionTooBig,
} from '../src/geometry/regions';
import { tileFeature } from '../src/geometry/patterns';
import type { PolyFeature } from '../src/types';
import { WARNINGS, clearWarnings } from '../src/warnings';

/** `cols` x `rows` unit squares on a pitch of 2, so none touches another: a merged set. */
function squareGrid(cols: number, rows: number, x0: number, y0: number): PolyFeature {
  const polys: number[][][][] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const x = x0 + 2 * i,
        y = y0 + 2 * j;
      polys.push([
        [
          [x, y],
          [x + 1, y],
          [x + 1, y + 1],
          [x, y + 1],
          [x, y],
        ],
      ]);
    }
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiPolygon', coordinates: polys },
  };
}

function box(x0: number, y0: number, x1: number, y1: number): PolyFeature {
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
  };
}

// polygon-clipping 0.15.7 throws once one call holds more than 500,000 segments (1,000,000 queued
// sweep events). 300 x 220 squares at 4 segments each is 264,000 a side: under it alone, over it
// together.
const COLS = 300;
const ROWS = 220;
const PER_SIDE = COLS * ROWS;

describe('a boolean past the clipping engine’s segment cap', () => {
  beforeEach(() => clearWarnings());

  it(
    'unions two sides whose segments together pass the cap, losing nothing',
    { timeout: 120000 },
    () => {
      const a = squareGrid(COLS, ROWS, 0, 0);
      // b's first row sits half a square up into a's last row, so the two sides really do overlap
      // along one seam and the union has something to weld there.
      const b = squareGrid(COLS, ROWS, 0, 2 * (ROWS - 1) + 0.5);
      const u = safeUnion(a, b, 'test');
      expect(WARNINGS.map((w) => w.message)).toEqual([]);
      // Each welded pair covers 1.5 rather than 2.
      expect(planarArea(u)).toBeCloseTo(2 * PER_SIDE - 0.5 * COLS, 6);
    },
  );

  it('clips a subject past the cap to a boundary', { timeout: 120000 }, () => {
    const a = squareGrid(COLS, 2 * ROWS, 0, 0);
    // Halfway through a column of squares, so the clip really cuts some of them.
    const r = intersectChecked(a, box(-1, -1, 2 * COLS, 2 * ROWS + 0.5));
    expect(r.clipped).toBe(true);
    expect(planarArea(r.feat)).toBeCloseTo(COLS * ROWS + 0.5 * COLS, 6);
  });

  it('subtracts a boundary from a subject past the cap', { timeout: 120000 }, () => {
    const a = squareGrid(COLS, 2 * ROWS, 0, 0);
    const r = differenceChecked(a, box(-1, -1, 2 * COLS, 2 * ROWS + 0.5));
    expect(r.trimmed).toBe(true);
    expect(planarArea(r.feat)).toBeCloseTo(COLS * ROWS - 0.5 * COLS, 6);
  });

  // A fill giving way to the stickers on its zone subtracts all of them in one sweep.
  it('subtracts several clippings at once from a subject past the cap', { timeout: 120000 }, () => {
    const a = squareGrid(COLS, 2 * ROWS, 0, 0);
    const r = differenceAllChecked(a, [
      box(-1, -1, 2 * COLS, 2 * ROWS + 0.5),
      box(-1, 600, 2 * COLS, 700),
    ]);
    expect(r.trimmed).toBe(true);
    // Half a row more than ROWS under the first box, 50 whole rows under the second.
    expect(planarArea(r.feat)).toBeCloseTo(COLS * ROWS - 0.5 * COLS - 50 * COLS, 6);
  });
});

/** `n` unit-wide strips 2 apart, across (`h`) or down (`v`) a 2n square. */
function strips(dir: 'h' | 'v', n: number): PolyFeature {
  const polys: number[][][][] = [];
  for (let i = 0; i < n; i++) {
    const t = 2 * i + (dir === 'v' ? 0.5 : 0);
    const ring =
      dir === 'h'
        ? [
            [0, t],
            [2 * n, t],
            [2 * n, t + 1],
            [0, t + 1],
            [0, t],
          ]
        : [
            [t, -1],
            [t + 1, -1],
            [t + 1, 2 * n],
            [t, 2 * n],
            [t, -1],
          ];
    polys.push([ring]);
  }
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiPolygon', coordinates: polys },
  };
}

// The engine's other limit counts the pieces its sweep line holds, crossings included, so 4,000
// input segments can reach it: 500 strips each way cross 250,000 times.
describe('the engine limit on crossings', () => {
  it('throws, well under the segment cap', { timeout: 120000 }, () => {
    const coords = (f: PolyFeature) => f.geometry.coordinates as never;
    expect(() => polygonClipping.union(coords(strips('h', 500)), coords(strips('v', 500)))).toThrow(
      /too many sweep line segments/,
    );
  });

  it('is reported too big, the same as the segment cap', { timeout: 120000 }, () => {
    expect(boolOpUnderCap('union', strips('h', 500), strips('v', 500))).toEqual({
      ok: false,
      tooBig: true,
    });
  });
});

// The constant is only worth anything while it matches the engine. Pinned on both sides of the line
// so a polygon-clipping bump that moves it fails here, not in a user's fill.
describe('SWEEP_SEGMENT_CAP', () => {
  const coords = (f: PolyFeature) => f.geometry.coordinates as number[][][][];

  it('is exactly what one engine call can hold', { timeout: 120000 }, () => {
    const full = squareGrid(500, SWEEP_SEGMENT_CAP / 4 / 500, 0, 0);
    expect(segmentCount(full)).toBe(SWEEP_SEGMENT_CAP);
    expect(() => polygonClipping.union(coords(full) as never)).not.toThrow();
  });

  it('is one square short of a throw', () => {
    const over = squareGrid(500, SWEEP_SEGMENT_CAP / 4 / 500, 0, 0);
    coords(over).push(coords(squareGrid(1, 1, -10, -10))[0]);
    expect(() => polygonClipping.union(coords(over) as never)).toThrow(/queue size too big/);
  });
});

/** An octagon centred on (cx, cy): enough vertices that a cap of a few dozen splits a set of them. */
function octagon(cx: number, cy: number, r: number): number[][][] {
  const ring = Array.from({ length: 8 }, (_, k) => {
    const t = (Math.PI * k) / 4;
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
  });
  return [[...ring, ring[0]]];
}

function octagons(cols: number, rows: number, x0: number, y0: number): PolyFeature {
  const polys: number[][][][] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) polys.push(octagon(x0 + 3 * i, y0 + 3 * j, 1.2));
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiPolygon', coordinates: polys },
  };
}

/** Area in one and not the other, both ways round: zero only when the two cover the same ground. */
function xorArea(x: PolyFeature | null, y: PolyFeature | null): number {
  if (!x || !y) return planarArea(x) + planarArea(y);
  return (
    planarArea(turf.difference(x, y) as PolyFeature | null) +
    planarArea(turf.difference(y, x) as PolyFeature | null)
  );
}

// The split has to be the same op, not an approximation of it. A cap of 60 segments forces it on
// shapes small enough to check against one unsplit call.
describe('boolOpUnderCap, split', () => {
  // b overlaps a's bottom-right corner and runs past it, so the union has polygons to weld and
  // polygons on both sides to pass through, and most of the subject lies outside the clip. At 32
  // segments b leaves a group room for three of a's octagons.
  const a = octagons(6, 6, 0, 0);
  const b = octagons(4, 1, 13.5, 1.5);
  const CAP = 60;

  it.each(['union', 'intersect', 'difference'] as const)('%s matches one unsplit call', (kind) => {
    expect(segmentCount(a) + segmentCount(b)).toBeGreaterThan(CAP);
    const whole = boolOpWithRetry(
      (x, y) =>
        (kind === 'union'
          ? turf.union(x, y)
          : kind === 'intersect'
            ? turf.intersect(x, y)
            : turf.difference(x, y)) as PolyFeature | null,
      a,
      b,
    );
    const split = boolOpUnderCap(kind, a, b, CAP);
    expect(split.ok).toBe(true);
    expect(planarArea(split.val!)).toBeGreaterThan(0);
    expect(planarArea(split.val!)).toBeCloseTo(planarArea(whole.val!), 9);
    expect(xorArea(split.val!, whole.val!)).toBeLessThan(1e-9);
  });
});

/** A 10 x 10 square at x0 with a `pts`-point round hole: one polygon, heavy only in its hole. */
function holedSquare(x0: number, pts: number): PolyFeature {
  const hole = Array.from({ length: pts }, (_, k) => {
    const t = (-2 * Math.PI * k) / pts;
    return [x0 + 5 + 3 * Math.cos(t), 5 + 3 * Math.sin(t)];
  });
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x0, 0],
          [x0 + 10, 0],
          [x0 + 10, 10],
          [x0, 10],
          [x0, 0],
        ],
        [...hole, hole[0]],
      ],
    },
  };
}

// Two tiles of a design whose background touches every edge of its cell weld into one polygon
// carrying both holes. Over the cap that polygon cannot be built by any split, and fill mode has
// to hear so rather than receive half of it.
describe('a union no split can bring under the cap', () => {
  const HOLE = SWEEP_SEGMENT_CAP / 2;

  it('is reported too big, without the engine being asked', () => {
    const r = boolOpUnderCap('union', holedSquare(0, HOLE), holedSquare(10, HOLE));
    expect(r).toEqual({ ok: false, tooBig: true });
  });

  it('is a refusal from tileFeature, never a partial fill', async () => {
    const grid = { i0: 0, i1: 1, j0: 0, j1: 0, pitchX: 10, pitchY: 10, count: 2 };
    await expect(tileFeature(holedSquare(0, HOLE), grid)).rejects.toBeInstanceOf(UnionTooBig);
  });

  it('still falls back and warns for every other caller', () => {
    clearWarnings();
    const a = holedSquare(0, HOLE);
    expect(planarArea(safeUnion(a, holedSquare(10, HOLE), 'test'))).toBeCloseTo(planarArea(a), 6);
    expect(WARNINGS.map((w) => w.message)).toEqual([
      "Couldn't merge the shapes for test. They are used unmerged, so this region may be missing part of its area.",
    ]);
  });

  it('is reported too big as a clip too', () => {
    const r = boolOpUnderCap('intersect', holedSquare(0, SWEEP_SEGMENT_CAP), holedSquare(0, 4));
    expect(r).toEqual({ ok: false, tooBig: true });
  });
});
