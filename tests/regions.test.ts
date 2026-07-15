import { describe, expect, it } from 'vitest';
import {
  cleanFeature,
  computeNetRegionsByColor,
  dedupeRing,
  shapeToFeature,
} from '../src/geometry/regions';
import type { PolyFeature, SVGShape } from '../src/types';

function square(x0: number, y0: number, size: number) {
  return [
    { x: x0, y: y0 },
    { x: x0 + size, y: y0 },
    { x: x0 + size, y: y0 + size },
    { x: x0, y: y0 + size },
  ];
}

/** Planar shoelace area of a Polygon/MultiPolygon feature (exterior minus holes). */
function planarArea(f: PolyFeature | null): number {
  if (!f) return 0;
  const ringArea = (r: number[][]) => {
    let s = 0;
    for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    return s / 2;
  };
  const polyArea = (p: number[][][]) =>
    p.reduce(
      (s, ring, i) => s + (i === 0 ? Math.abs(ringArea(ring)) : -Math.abs(ringArea(ring))),
      0,
    );
  const g = f.geometry;
  return g.type === 'Polygon'
    ? polyArea(g.coordinates as number[][][])
    : (g.coordinates as number[][][][]).reduce((s, p) => s + polyArea(p), 0);
}

describe('dedupeRing', () => {
  it('collapses consecutive near-duplicate points', () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 0, y: 1e-9 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 },
    ];
    const out = dedupeRing(ring);
    expect(out).toHaveLength(5); // 4 distinct + closing point
    expect(out[0]).toEqual(out[out.length - 1]);
  });
});

describe('shapeToFeature', () => {
  it('resolves a hole by containment depth even when it shares the exterior winding', () => {
    // letter-O: both rings wound the same way — the winding-sign heuristic would get this
    // wrong for evenodd files; containment depth must not.
    const shape: SVGShape = {
      fill: '#000000',
      loops: [square(0, 0, 10), square(3, 3, 4)],
      order: 0,
    };
    const f = shapeToFeature(shape)!;
    expect(f.geometry.type).toBe('Polygon');
    expect((f.geometry.coordinates as number[][][]).length).toBe(2); // exterior + 1 hole
    expect(planarArea(f)).toBeCloseTo(100 - 16, 6);
  });

  it('treats depth-2 nesting as a solid island inside a hole', () => {
    const shape: SVGShape = {
      fill: '#000000',
      loops: [square(0, 0, 20), square(4, 4, 10), square(7, 7, 2)],
      order: 0,
    };
    const f = shapeToFeature(shape)!;
    expect(planarArea(f)).toBeCloseTo(400 - 100 + 4, 6);
  });
});

describe('cleanFeature', () => {
  it('drops zero-area sliver holes', () => {
    const f: PolyFeature = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
          [
            [2, 2],
            [5, 2],
            [2, 2],
          ], // out-and-back sliver
        ],
      },
    };
    const out = cleanFeature(f)!;
    expect((out.geometry.coordinates as number[][][]).length).toBe(1);
  });

  it('returns null when the exterior degenerates', () => {
    const f: PolyFeature = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [5, 0],
            [0, 0],
          ],
        ],
      },
    };
    expect(cleanFeature(f)).toBeNull();
  });
});

describe('computeNetRegionsByColor', () => {
  it('subtracts later paint from earlier colors (paint order)', () => {
    const shapes: SVGShape[] = [
      { fill: '#ff0000', loops: [square(0, 0, 10)], order: 0 },
      { fill: '#000000', loops: [square(3, 3, 4)], order: 1 }, // painted on top
    ];
    const { byColor } = computeNetRegionsByColor(shapes);
    expect(planarArea(byColor['#ff0000'])).toBeCloseTo(100 - 16, 4);
    expect(planarArea(byColor['#000000'])).toBeCloseTo(16, 4);
  });
});
