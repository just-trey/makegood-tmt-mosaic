import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolyFeature } from '../src/types';

// A split op runs as several engine calls, so one of them can fail while the others succeed. What
// comes back must then be the caller's usual fallback for the WHOLE op, with its usual warning,
// never the calls that happened to work stitched together as though they were all of it.
let intersectCalls = 0;
vi.mock('@turf/turf', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    union: () => {
      throw new Error('forced union failure');
    },
    intersect: (x: PolyFeature) => {
      if (intersectCalls++ === 0) return x;
      throw new Error('forced intersect failure');
    },
  };
});

const {
  boolOpUnderCap,
  planarArea,
  safeIntersectChecked,
  safeUnion,
  segmentCount,
  SWEEP_SEGMENT_CAP,
} = await import('../src/geometry/regions');
const { WARNINGS, clearWarnings } = await import('../src/warnings');

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

const messages = (): string[] => WARNINGS.map((w) => w.message);

describe('a split op with one failing engine call', () => {
  beforeEach(() => {
    clearWarnings();
    intersectCalls = 0;
  });

  it('hands the clip back whole and says so', () => {
    const a = squareGrid(300, 440, 0, 0);
    expect(segmentCount(a)).toBeGreaterThan(SWEEP_SEGMENT_CAP);
    const clip: PolyFeature = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-1, -1],
            [700, -1],
            [700, 900],
            [-1, 900],
            [-1, -1],
          ],
        ],
      },
    };
    const r = safeIntersectChecked(a, clip, 'test');
    // The first group came back; the second did not. Keeping the first would ship half a clip.
    expect(intersectCalls).toBeGreaterThan(1);
    expect(r.clipped).toBe(false);
    expect(planarArea(r.feat)).toBe(planarArea(a));
    expect(messages()).toEqual([
      'Clipping color region to the design face failed for test. Region left unclipped, may extend past the face edge.',
    ]);
  });

  it('keeps the first side and names the merge that failed', () => {
    const a = squareGrid(300, 220, 0, 0);
    const b = squareGrid(300, 220, 0, 438.5);
    expect(segmentCount(a) + segmentCount(b)).toBeGreaterThan(SWEEP_SEGMENT_CAP);
    const u = safeUnion(a, b, 'test');
    expect(planarArea(u)).toBe(planarArea(a));
    expect(messages()).toEqual([
      "Couldn't merge the shapes for test. They are used unmerged, so this region may be missing part of its area.",
    ]);
  });

  // One polygon over the cap can't be split, so the engine is not asked: here it would answer.
  it('reports an unsplittable clip too big without calling the engine', () => {
    const n = SWEEP_SEGMENT_CAP;
    const ring = Array.from({ length: n }, (_, k) => {
      const t = (2 * Math.PI * k) / n;
      return [Math.cos(t), Math.sin(t)];
    });
    const disc: PolyFeature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
    };
    const clip = squareGrid(1, 1, -0.5, -0.5);
    expect(boolOpUnderCap('intersect', disc, clip)).toEqual({ ok: false, tooBig: true });
    expect(intersectCalls).toBe(0);
  });
});
