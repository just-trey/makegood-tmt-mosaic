import { describe, expect, it } from 'vitest';
import {
  applyColorMerges,
  cleanFeature,
  computeNetRegionsByColor,
  dedupeRing,
  dropUnprintableRemnants,
  intersectChecked,
  safeIntersect,
  shapeToFeature,
} from '../src/geometry/regions';
import type { Loop, PolyFeature, SVGShape } from '../src/types';

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

  // Containment is probed with a point of the inner ring, and a ring that starts exactly on its
  // parent's outline puts that probe in the ray cast's undefined case. Traced artwork hits it every
  // time: spliceChains (raster/trace.ts) rotates every ring to start on a junction, which is by
  // definition a point another ring passes through. Probing raw[0] read the hole as "outside", so
  // it was emitted as a solid island and the shape painted over its own cavity.
  it('resolves a hole whose first vertex sits on its parent ring', () => {
    const outer: Loop = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    // Starts at (10, 5) — a point lying exactly on the outer ring's right edge.
    const hole: Loop = [
      { x: 10, y: 5 },
      { x: 6, y: 8 },
      { x: 6, y: 2 },
    ];
    const f = shapeToFeature({ fill: '#000000', loops: [outer, hole], order: 0 })!;
    expect((f.geometry.coordinates as number[][][]).length).toBe(2); // exterior + 1 hole
    expect(planarArea(f)).toBeCloseTo(100 - 12, 6);
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

  // Centered concentric squares (not sharing a corner point like `square()` above) so
  // point-in-polygon containment tests never land exactly on another ring's boundary.
  function concentricSquare(half: number) {
    return [
      { x: -half, y: -half },
      { x: half, y: -half },
      { x: half, y: half },
      { x: -half, y: half },
    ];
  }

  // getDepth memoizes in loop order, so it only recurses deeply if the innermost ring is
  // *earlier* in the loops array than the rings it's nested inside — building outermost-first
  // (like a normal authoring tool would) never stack-overflows regardless of nesting count.
  // n is empirically tuned (overflows ~9000 on this machine/Node version) with ~35% headroom;
  // a future Node/V8 stack-size change could shift the real threshold enough to need retuning.
  it('names deeply nested rings instead of a raw stack overflow (getDepth path)', () => {
    const n = 12000;
    const loops: Loop[] = [];
    for (let i = n - 1; i >= 0; i--) loops.push(concentricSquare(n - i));
    const shape: SVGShape = { fill: '#000000', loops, order: 0 };
    expect(() => shapeToFeature(shape)).toThrow(/nested.*geometry|geometry.*nested/i);
    try {
      shapeToFeature(shape);
    } catch (e) {
      expect((e as Error).message).not.toMatch(/call stack/i);
    }
  });

  // emitPoly recurses on every 2 levels of containment depth (odd depths are holes, not
  // recursion targets) and allocates per frame, so it overflows at a shallower ring count than
  // getDepth even in ordinary outermost-first order. Same empirical-tuning caveat as above
  // (overflows ~6000 on this machine/Node version).
  it('names deeply nested rings instead of a raw stack overflow (emitPoly path)', () => {
    const n = 8000;
    const loops: Loop[] = [];
    for (let i = 0; i < n; i++) loops.push(concentricSquare(n - i));
    const shape: SVGShape = { fill: '#000000', loops, order: 0 };
    expect(() => shapeToFeature(shape)).toThrow(/nested.*geometry|geometry.*nested/i);
    try {
      shapeToFeature(shape);
    } catch (e) {
      expect((e as Error).message).not.toMatch(/call stack/i);
    }
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

describe('intersectChecked', () => {
  it('reads an input emptied by cleanup as a clean empty clip, not a failure', () => {
    const sliver: PolyFeature = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [5, 0],
            [10, 0],
            [0, 0],
          ],
        ],
      },
    };
    const box: PolyFeature = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, -1],
            [10, -1],
            [10, 1],
            [0, 1],
            [0, -1],
          ],
        ],
      },
    };
    expect(intersectChecked(sliver, box)).toEqual({ feat: null, clipped: true });
    expect(intersectChecked(box, null)).toEqual({ feat: null, clipped: true });
    expect(intersectChecked(box, box).clipped).toBe(true);
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

describe('dropUnprintableRemnants', () => {
  const FLOOR = 0.16; // one 0.4mm nozzle square, as CLIP_REMNANT_FLOOR_MM2

  /** An axis-aligned rectangle as its own polygon, in mm. */
  const rect = (x0: number, y0: number, w: number, h: number): number[][] => [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + h],
    [x0, y0 + h],
    [x0, y0],
  ];
  const feat = (...polys: number[][][]): PolyFeature =>
    ({
      type: 'Feature',
      properties: {},
      geometry:
        polys.length === 1
          ? { type: 'Polygon', coordinates: [polys[0]] }
          : { type: 'MultiPolygon', coordinates: polys.map((p) => [p]) },
    }) as PolyFeature;
  const areas = (f: PolyFeature | null): number[] => {
    if (!f) return [];
    const g = f.geometry as { type: string; coordinates: number[][][] | number[][][][] };
    const polys =
      g.type === 'Polygon' ? [g.coordinates as number[][][]] : (g.coordinates as number[][][][]);
    return polys.map((rings) => {
      const r = rings[0];
      let a = 0;
      for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
      return Math.abs(a / 2);
    });
  };

  // The chair's own numbers: a 2,634mm² live band and a 0.0253mm² hairline, which is what the
  // Front clip on `chair-seat-back-top` returns. The hairline's bbox is 0.020 x 8.08mm and would
  // be 0.1616mm² if it were a filled rectangle — over this floor. It is 0.0253 because it tapers,
  // which is the same thing the docstring says about area admitting a long enough hairline.
  it('drops a hairline the clip cut out of a real region, and keeps the region', () => {
    const before = feat(rect(0, 0, 80, 32.93)); // 2634mm², the live band
    const after = feat(rect(0, 0, 80, 32.93), rect(70, 150, 0.02, 1.265)); // + a 0.0253mm² sliver
    const kept = areas(dropUnprintableRemnants(after, before, FLOOR));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBeCloseTo(2634.4, 1);
  });

  // The failure the per-feature gate had: every piece under the floor, summing well over it, and
  // no clip having touched any of them. A vector stipple, or fill mode tiling a small motif.
  it('keeps a stipple of sub-floor dots the clip never touched', () => {
    const dots = Array.from({ length: 40 }, (_, i) => rect(i * 2, 0, 0.3, 0.3)); // 0.09mm² each
    const f = feat(...dots);
    expect(areas(f).reduce((s, a) => s + a, 0)).toBeGreaterThan(FLOOR);
    expect(areas(dropUnprintableRemnants(f, f, FLOOR))).toHaveLength(40);
  });

  // clipToKeptSide hands the feature back verbatim when the design does not cross the centre line,
  // and all three clips do the same when their boolean fails. Nothing may be dropped there — not
  // even the sub-floor dot, which the earlier per-feature gate deleted because the FEATURE cleared
  // the floor while that piece of it did not.
  it('drops nothing when the clip was a no-op', () => {
    const f = feat(rect(0, 0, 10, 10), rect(50, 0, 0.3, 0.3)); // 100mm² and a 0.09mm² dot
    const kept = areas(dropUnprintableRemnants(f, f, FLOOR));
    expect(kept).toHaveLength(2);
    expect(kept[1]).toBeCloseTo(0.09, 6);
  });

  it('keeps every piece when the clip took nothing off a printable one', () => {
    const before = feat(rect(0, 0, 10, 10));
    expect(areas(dropUnprintableRemnants(before, before, FLOOR))).toEqual([100]);
  });

  it('passes a null result straight through', () => {
    expect(dropUnprintableRemnants(null, feat(rect(0, 0, 10, 10)), FLOOR)).toBeNull();
  });
});
