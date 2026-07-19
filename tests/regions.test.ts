import { describe, expect, it } from 'vitest';
import {
  applyColorMerges,
  cleanFeature,
  computeNetRegionsByColor,
  dedupeRing,
  safeIntersect,
  shapeToFeature,
} from '../src/geometry/regions';
import type { PolyFeature, SVGShape } from '../src/types';

function squareFeature(size: number): PolyFeature {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [size, 0],
          [size, size],
          [0, size],
          [0, 0],
        ],
      ],
    },
  };
}

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

describe('safeIntersect', () => {
  it('clips a feature with a zero-area sliver hole without throwing', () => {
    const withSliver: PolyFeature = {
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
    const square5: PolyFeature = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [5, 0],
            [5, 5],
            [0, 5],
            [0, 0],
          ],
        ],
      },
    };
    const out = safeIntersect(withSliver, square5);
    expect(out).not.toBeNull();
    expect(planarArea(out)).toBeCloseTo(25, 4);
  });

  it('returns null for disjoint inputs rather than throwing', () => {
    const a = shapeToFeature({ fill: '#000', loops: [square(0, 0, 5)], order: 0 })!;
    const b = shapeToFeature({ fill: '#000', loops: [square(20, 20, 5)], order: 0 })!;
    expect(safeIntersect(a, b)).toBeNull();
  });
});

describe('computeNetRegionsByColor', () => {
  it('subtracts later paint from earlier colors (paint order)', async () => {
    const shapes: SVGShape[] = [
      { fill: '#ff0000', loops: [square(0, 0, 10)], order: 0 },
      { fill: '#000000', loops: [square(3, 3, 4)], order: 1 }, // painted on top
    ];
    const { byColor } = await computeNetRegionsByColor(shapes);
    expect(planarArea(byColor['#ff0000'])).toBeCloseTo(100 - 16, 4);
    expect(planarArea(byColor['#000000'])).toBeCloseTo(16, 4);
  });

  it('memoizes on shapes array identity — a repeat call skips recompute', async () => {
    const shapes: SVGShape[] = [{ fill: '#ff0000', loops: [square(0, 0, 10)], order: 0 }];
    const first = await computeNetRegionsByColor(shapes);
    const progress: number[] = [];
    const second = await computeNetRegionsByColor(shapes, (f) => progress.push(f));
    expect(second).toBe(first); // same object back == no recompute happened
    expect(progress).toEqual([1]);
  });

  it('does not reuse the cache across different shapes arrays, even with identical content', async () => {
    const shapesA: SVGShape[] = [{ fill: '#ff0000', loops: [square(0, 0, 10)], order: 0 }];
    const shapesB: SVGShape[] = [{ fill: '#ff0000', loops: [square(0, 0, 10)], order: 0 }];
    const a = await computeNetRegionsByColor(shapesA);
    const b = await computeNetRegionsByColor(shapesB);
    expect(b).not.toBe(a);
    expect(planarArea(b.byColor['#ff0000'])).toBeCloseTo(planarArea(a.byColor['#ff0000']), 6);
  });
});

describe('applyColorMerges', () => {
  // '#fe0101' is a near-identical red (ΔE well under Slight's cutoff of 3); '#0000ff' is far away.
  function byColorFixture(): Record<string, PolyFeature> {
    return {
      '#ff0000': squareFeature(5),
      '#fe0101': squareFeature(20), // largest area -> the dominant member if merged with the reds
      '#0000ff': squareFeature(10),
    };
  }

  it('auto-merges visually near-identical colors at Slight, leaves distant colors apart', () => {
    const out = applyColorMerges(byColorFixture(), [], { autoMergeLevel: 1 });
    const merged = out.find((r) => r.isMerge)!;
    expect(merged).toBeDefined();
    expect(merged.members.sort()).toEqual(['#fe0101', '#ff0000']);
    expect(out.find((r) => r.key === '#0000ff' && !r.isMerge)).toBeDefined();
  });

  it('does not auto-merge anything at level 0 (None)', () => {
    const out = applyColorMerges(byColorFixture(), [], { autoMergeLevel: 0 });
    expect(out.every((r) => !r.isMerge)).toBe(true);
    expect(out).toHaveLength(3);
  });

  it('takes the dominant (largest-area) member as the merged group preview color, not a blend', () => {
    const out = applyColorMerges(byColorFixture(), [], { autoMergeLevel: 1 });
    const merged = out.find((r) => r.isMerge)!;
    expect(merged.previewColor).toBe('#fe0101'); // area 400 > area 25 for '#ff0000'
  });

  it('ranks dominance by planar area — SVG coordinates are not lat/lon', () => {
    // A square straddling "latitude" 90 has ~zero geodesic area, so turf.area would wrongly
    // demote it below a much smaller square; planar shoelace keeps the true ranking.
    const nearPole: PolyFeature = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 88],
            [4, 88],
            [4, 92],
            [0, 92],
            [0, 88],
          ],
        ],
      },
    };
    const out = applyColorMerges({ '#ff0000': squareFeature(2), '#fe0101': nearPole }, [], {
      autoMergeLevel: 1,
    });
    const merged = out.find((r) => r.isMerge)!;
    expect(merged.previewColor).toBe('#fe0101'); // planar area 16 > 4
  });

  it('excludes base-assigned colors from the resolved regions entirely', () => {
    const out = applyColorMerges(byColorFixture(), [], { baseColors: ['#0000ff'] });
    expect(out.find((r) => r.members.includes('#0000ff'))).toBeUndefined();
    expect(out).toHaveLength(2);
  });

  it('keeps a pinned (keptApart) color as its own singleton even within auto-merge threshold', () => {
    const out = applyColorMerges(byColorFixture(), [], {
      autoMergeLevel: 1,
      keptApart: ['#ff0000'],
    });
    expect(out.find((r) => r.key === '#ff0000' && !r.isMerge)).toBeDefined();
    expect(out.find((r) => r.isMerge && r.members.includes('#ff0000'))).toBeUndefined();
    // the other near-identical red is still on its own too, since its only auto-merge partner is pinned
    expect(out.find((r) => r.key === '#fe0101' && !r.isMerge)).toBeDefined();
  });

  it('unions manual merge groups with auto-merge clusters (either link fuses a pair)', () => {
    const byColor = { ...byColorFixture(), '#00ff00': squareFeature(1) };
    const out = applyColorMerges(byColor, [['#0000ff', '#00ff00']], { autoMergeLevel: 1 });
    const merged = out.find((r) => r.members.includes('#0000ff'))!;
    expect(merged.isMerge).toBe(true);
    expect(merged.members.sort()).toEqual(['#0000ff', '#00ff00']);
  });
});
