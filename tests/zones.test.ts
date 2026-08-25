import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FlatZoneMapper, implicitZoneFor, type DesignPlacement } from '../src/geometry/zones';
import { getManifold } from '../src/geometry/manifold';
import type { AssemblyPart, PolyFeature } from '../src/types';

/** An axis-aligned rectangle as a turf polygon feature, in the face's own X/Z mm frame. */
function square(x0: number, y0: number, x1: number, y1: number): PolyFeature {
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

/** Several disjoint polygons as one feature, the way a traced color's regions arrive. */
function multi(polys: PolyFeature[]): PolyFeature {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'MultiPolygon',
      coordinates: polys.map((p) => p.geometry.coordinates),
    },
  } as PolyFeature;
}

/** Planar shoelace area (mm²) — turf.area is geodesic and meaningless on these coordinates. */
function area(feat: PolyFeature): number {
  const g = feat.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let total = 0;
  for (const rings of polys as number[][][][]) {
    for (let ri = 0; ri < rings.length; ri++) {
      const r = rings[ri];
      let a = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++)
        a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
      total += ri === 0 ? Math.abs(a) / 2 : -Math.abs(a) / 2;
    }
  }
  return total;
}

function boxPart(overrides: Partial<AssemblyPart> = {}): AssemblyPart {
  const geo = new THREE.BoxGeometry(40, 10, 40).toNonIndexed();
  geo.translate(0, 5, 0);
  return {
    id: 1,
    name: 'test box',
    roleId: 'role',
    positions: Float32Array.from(geo.attributes.position.array as Float32Array),
    patches: null,
    patchIdx: 0,
    boundaryLoops: [
      [
        [-20, 10, -20],
        [20, 10, -20],
        [20, 10, 20],
        [-20, 10, 20],
      ],
    ],
    patchNormal: [0, 1, 0],
    topZ: 10,
    baseDepth: 0,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
    ...overrides,
  };
}

/**
 * The same box face with a 10mm square hole through the middle of it. The hole ring carries more
 * points than the outline on purpose: that is the input that told the old vertex-count sort the
 * hole was the face.
 */
function holedPart(overrides: Partial<AssemblyPart> = {}): AssemblyPart {
  const hole: number[][] = [];
  for (let i = 0; i < 40; i++) {
    const t = (i / 40) * 4;
    const leg = Math.floor(t),
      f = t - leg;
    const c: [number, number][] = [
      [-5 + 10 * f, -5],
      [5, -5 + 10 * f],
      [5 - 10 * f, 5],
      [-5, 5 - 10 * f],
    ];
    hole.push([c[leg][0], 10, c[leg][1]]);
  }
  return boxPart({
    boundaryLoops: [
      [
        [-20, 10, -20],
        [20, 10, -20],
        [20, 10, 20],
        [-20, 10, 20],
      ],
      hole,
    ],
    ...overrides,
  });
}

/** The design placement the original inline `placeOnPart` folded in — identity offsets/scale. */
function placement(overrides: Partial<DesignPlacement> = {}): DesignPlacement {
  return {
    svgC: { cx: 5, cy: 5, r: 5 },
    mmPerUnit: 1,
    xFlip: 1,
    zMul: -1,
    offX: 0,
    offZ: 0,
    rotationDeg: 0,
    ...overrides,
  };
}

/**
 * The pre-refactor inline placement math, verbatim, as the oracle the mapper must reproduce.
 * Mirrors what `buildAssemblyGeometry`/`placeOnPart` computed before the zone extraction.
 */
function inlinePlace(
  part: AssemblyPart,
  p: DesignPlacement,
  isRect: boolean,
): (pt: number[]) => number[] {
  const nrm = part.patchNormal ?? null;
  const nsign = nrm && nrm[1] < 0 ? -1 : 1;
  let faceCx = 0,
    faceCz = 0;
  if (isRect && part.boundaryLoops && part.boundaryLoops.length) {
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const q of part.boundaryLoops[0]) {
      minX = Math.min(minX, q[0]);
      maxX = Math.max(maxX, q[0]);
      minZ = Math.min(minZ, q[2]);
      maxZ = Math.max(maxZ, q[2]);
    }
    faceCx = (minX + maxX) / 2;
    faceCz = (minZ + maxZ) / 2;
  }
  const rot = (x: number, z: number, px: number, pz: number, deg: number): [number, number] => {
    const r = (deg * Math.PI) / 180,
      c = Math.cos(r),
      s = Math.sin(r);
    const dx = x - px,
      dz = z - pz;
    return [px + dx * c - dz * s, pz + dx * s + dz * c];
  };
  return (pt: number[]): number[] => {
    const xMul = p.xFlip * (nsign > 0 ? -1 : 1);
    let x = (pt[0] - p.svgC.cx) * p.mmPerUnit * xMul;
    let z = (pt[1] - p.svgC.cy) * p.mmPerUnit * p.zMul;
    if (p.rotationDeg) {
      const rr = rot(x, z, 0, 0, p.rotationDeg);
      x = rr[0];
      z = rr[1];
    }
    x += p.offX + faceCx;
    z += p.offZ + faceCz;
    if (part.isDuplicateOf) {
      const r = rot(x, z, part.pivotX, part.pivotZ, -part.angleDeg);
      x = r[0];
      z = r[1];
    }
    return [x, z];
  };
}

const SAMPLE_PTS = [
  [0, 0],
  [10, 0],
  [10, 10],
  [3, 7],
  [5, 5],
];

describe('FlatZoneMapper.placer reproduces the pre-refactor placement', () => {
  const cases: Array<{ name: string; part: AssemblyPart; isRect: boolean; p: DesignPlacement }> = [
    { name: 'wheel (+Y face, centered anchor)', part: boxPart(), isRect: false, p: placement() },
    {
      name: 'wheel with offset/scale/rotation',
      part: boxPart(),
      isRect: false,
      p: placement({ mmPerUnit: 2, offX: 3, offZ: -4, rotationDeg: 30 }),
    },
    {
      name: 'rect centers on an off-center face',
      part: boxPart({
        boundaryLoops: [
          [
            [-5, 10, -5],
            [15, 10, -5],
            [15, 10, 15],
            [-5, 10, 15],
          ],
        ],
      }),
      isRect: true,
      p: placement(),
    },
    {
      name: '-Y face (no X mirror)',
      part: boxPart({ patchNormal: [0, -1, 0] }),
      isRect: false,
      p: placement(),
    },
    {
      name: 'flipX/flipY mirrors',
      part: boxPart(),
      isRect: false,
      p: placement({ xFlip: -1, zMul: 1 }),
    },
    {
      name: 'rotated duplicate remaps the design slice',
      part: boxPart({ isDuplicateOf: 9, pivotX: 5, pivotZ: 0, angleDeg: 180 }),
      isRect: false,
      p: placement({ offX: 2 }),
    },
  ];

  for (const { name, part, isRect, p } of cases) {
    it(name, () => {
      const place = new FlatZoneMapper(part, [part], isRect).placer(p);
      const oracle = inlinePlace(part, p, isRect);
      for (const pt of SAMPLE_PTS) {
        const got = place(pt);
        const want = oracle(pt);
        expect(got[0]).toBeCloseTo(want[0], 10);
        expect(got[1]).toBeCloseTo(want[1], 10);
      }
    });
  }
});

describe('FlatZoneMapper surface geometry', () => {
  it('exposes the face normal and Y direction', () => {
    const up = new FlatZoneMapper(boxPart(), [], false);
    expect(up.faceNormal).toEqual([0, 1, 0]);
    expect(up.nsign).toBe(1);
    const down = new FlatZoneMapper(boxPart({ patchNormal: [0, -1, 0] }), [], false);
    expect(down.nsign).toBe(-1);
  });

  it('falls back to the source part normal for a duplicate', () => {
    const src = boxPart({ id: 1, patchNormal: [0, -1, 0] });
    const dup = boxPart({ id: 2, isDuplicateOf: 1, patchNormal: undefined });
    expect(new FlatZoneMapper(dup, [src, dup], false).faceNormal).toEqual([0, -1, 0]);
  });

  it('builds a boundary polygon in native X/Z, and none for a cut-through part', () => {
    const b = new FlatZoneMapper(boxPart(), [], false).boundary();
    expect(b).not.toBeNull();
    // native X/Z ring: the +Y face at y=10 spans x,z ∈ [-20, 20]
    const ring = (b!.geometry.coordinates as number[][][])[0];
    const xs = ring.map((c) => c[0]);
    const zs = ring.map((c) => c[1]);
    expect(Math.min(...xs)).toBeCloseTo(-20);
    expect(Math.max(...xs)).toBeCloseTo(20);
    expect(Math.min(...zs)).toBeCloseTo(-20);
    expect(Math.max(...zs)).toBeCloseTo(20);
    expect(new FlatZoneMapper(boxPart({ cutThrough: true }), [], false).boundary()).toBeNull();
  });

  it('builds the boundary as a polygon with holes when the face has them', () => {
    // A 40mm face with a 10mm square hole in it, the shape a doughnut silhouette cuts. The hole is
    // deliberately given more vertices than the outline: the old sort keyed on vertex count and
    // would have taken the hole for the face.
    const b = new FlatZoneMapper(holedPart(), [], false).boundary();
    expect(b).not.toBeNull();
    const rings = b!.geometry.coordinates as number[][][];
    expect(rings).toHaveLength(2);
    // 40² outer less the 10² hole, so the hole is subtracted rather than merely present
    expect(area(b!)).toBeCloseTo(1600 - 100, 5);
  });

  it('measures the face bbox off the outline, never off a hole', () => {
    // Same trap the other way round: fillExtent and the rect design center both read the face's
    // extent, and a hole read as the face shrinks the design to a quarter of its size.
    expect(new FlatZoneMapper(holedPart(), [], false).fillExtent()).toEqual({
      minX: -20,
      minY: -20,
      maxX: 20,
      maxY: 20,
    });
  });

  it('fillExtent is the design face bbox', () => {
    // the box's face loop spans a 40mm square, inset from nothing here
    expect(new FlatZoneMapper(boxPart(), [], false).fillExtent()).toEqual({
      minX: -20,
      minY: -20,
      maxX: 20,
      maxY: 20,
    });
  });

  it('fillExtent covers a cut-through part’s whole footprint, not just its patch', () => {
    // the design on a cut-through part spans the whole surface, so a fill must tile over the
    // part's own X/Z extent — here twice the size of the (deliberately shrunk) face loop
    const through = new FlatZoneMapper(
      boxPart({
        cutThrough: true,
        boundaryLoops: [
          [
            [-5, 10, -5],
            [5, 10, -5],
            [5, 10, 5],
            [-5, 10, 5],
          ],
        ],
      }),
      [],
      false,
    );
    expect(through.boundary()).toBeNull(); // no clip target at all
    expect(through.fillExtent()).toEqual({ minX: -20, minY: -20, maxX: 20, maxY: 20 });
  });

  it('still clips when the face has no area in the plane it is cut in', () => {
    // A sideways patch (a model exported Z-up, dropped on a part): every loop point shares one X,
    // so the face projects to a line. A null boundary would mean "no clip" and let the cut run
    // unbounded at an arbitrary plane, so this has to stay a clip target that keeps nothing.
    const sideways = new FlatZoneMapper(
      boxPart({
        patchNormal: [1, 0, 0],
        boundaryLoops: [
          [
            [5, 0, -10],
            [5, 0, 10],
            [5, 20, 10],
            [5, 20, -10],
          ],
        ],
      }),
      [],
      false,
    );
    const b = sideways.boundary();
    expect(b).not.toBeNull();
    expect(area(b!)).toBeCloseTo(0, 6);
  });

  it('fillExtent is null when the part has no face loop to measure', () => {
    expect(new FlatZoneMapper(boxPart({ boundaryLoops: null }), [], false).fillExtent()).toBeNull();
  });

  it('resolveCutRegions passes through, unless the zone is cut-through', () => {
    const feat = square(-10, -10, 10, 10);
    const plain = new FlatZoneMapper(boxPart(), [], false).resolveCutRegions(feat, 2);
    expect(plain).toEqual([{ feat, depth: 2 }]);
    const through = new FlatZoneMapper(
      boxPart({ cutThrough: true, cutThroughDepth: 3 }),
      [],
      false,
    );
    // The whole region, at the part's through-depth — and NOT flagged `edge`: that flag drives the
    // edge-rule notice, and the wheel cap has cut this way since it shipped.
    expect(through.resolveCutRegions(feat, 2)).toEqual([{ feat, depth: 3 }]);
  });

  it('resolveCutRegions ignores the edge rule without the boolean engine', () => {
    // The gizmo builds mappers with wasm: null and never cuts. Splitting is the only thing that
    // needs the engine, so a null one must fall back to the plain recess rather than throw.
    const feat = square(-10, -10, 10, 10);
    const m = new FlatZoneMapper(boxPart({ edgeCutThroughDepth: 3 }), [], false, null);
    expect(m.resolveCutRegions(feat, 1)).toEqual([{ feat, depth: 1 }]);
  });

  it('splits edge-touching regions from interior ones under an edge rule', async () => {
    const wasm = await getManifold();
    // The box's design face spans [-20, 20]²: one region flush against the +X wall, one island
    // well inside it, handed over as a single two-polygon feature the way a traced color arrives.
    const touching = square(10, -5, 20, 5);
    const inside = square(-5, -5, 5, 5);
    const both = multi([touching, inside]);
    const m = new FlatZoneMapper(boxPart({ edgeCutThroughDepth: 3 }), [], false, wasm);
    const regions = m.resolveCutRegions(both, 1);

    expect(regions).toHaveLength(2);
    const edge = regions.find((r) => r.edge);
    const interior = regions.find((r) => !r.edge);
    expect(edge?.depth).toBe(3);
    expect(interior?.depth).toBe(1);
    // Whole polygons, never a sub-band: the edge slice is the touching square entire (100mm²),
    // not the 0.1mm strip along the wall it shares with the boundary.
    expect(area(edge!.feat)).toBeCloseTo(100, 5);
    expect(area(interior!.feat)).toBeCloseTo(100, 5);
  });

  it('leaves a wholly-interior region alone under an edge rule', async () => {
    const wasm = await getManifold();
    const feat = square(-5, -5, 5, 5);
    const m = new FlatZoneMapper(boxPart({ edgeCutThroughDepth: 3 }), [], false, wasm);
    const regions = m.resolveCutRegions(feat, 1);
    expect(regions).toEqual([{ feat, depth: 1 }]);
  });

  it('calls a region on a hole’s inner rim an edge, not an interior recess', async () => {
    const wasm = await getManifold();
    const m = new FlatZoneMapper(holedPart({ edgeCutThroughDepth: 3 }), [], false, wasm);
    // Already clipped to the holed face, so it stops at the hole and shares that rim with it. A
    // silhouette's inner rim is as much of the part's outer wall as its outline is, and cutting
    // this as a recess is what leaves a base-color band around the hole.
    const onRim = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-12, -12],
            [-5, -12],
            [-5, -5],
            [5, -5],
            [5, -12],
            [12, -12],
            [12, 12],
            [-12, 12],
            [-12, -12],
          ],
        ],
      },
    } as PolyFeature;
    const regions = m.resolveCutRegions(onRim, 1);
    expect(regions).toHaveLength(1);
    expect(regions[0].edge).toBe(true);
    expect(regions[0].depth).toBe(3);

    // …and one sitting between the hole and the outline, touching neither, still stays a recess.
    const between = square(6, 6, 12, 12);
    expect(m.resolveCutRegions(between, 1)).toEqual([{ feat: between, depth: 1 }]);
  });

  it('catches a region crossing a concave face’s inner edge', async () => {
    const wasm = await getManifold();
    // An L-shaped face: the [0,20]² quadrant is missing. This is the case the bbox prefilter
    // cannot answer — the region sits well inside the face's *bounding box* while still crossing
    // its edge — and it is the shape every real silhouette has (a cross, a character). Without the
    // boolean fallback behind the segment-grid prefilter, this comes out interior and its edge
    // prints in base color.
    const L: number[][] = [
      [-20, 10, -20],
      [20, 10, -20],
      [20, 10, 0],
      [0, 10, 0],
      [0, 10, 20],
      [-20, 10, 20],
    ];
    const straddling = square(-8, -8, 2, 2); // crosses the notch's inner corner at (0, 0)
    const m = new FlatZoneMapper(
      boxPart({ edgeCutThroughDepth: 3, boundaryLoops: [L] }),
      [],
      false,
      wasm,
    );
    const regions = m.resolveCutRegions(straddling, 1);
    expect(regions).toHaveLength(1);
    expect(regions[0].edge).toBe(true);
    expect(regions[0].depth).toBe(3);

    // …and one tucked into the L's arm, away from every edge, still stays a recess.
    const tucked = square(-15, -15, -8, -8);
    const inner = m.resolveCutRegions(tucked, 1);
    expect(inner).toEqual([{ feat: tucked, depth: 1 }]);
  });

  it('catches a large region sharing only a short stretch of the outline', async () => {
    const wasm = await getManifold();
    // The bug a relative area threshold produced, and the reason the threshold is absolute now.
    // The erosion removes 0.1mm × contact-length, which has nothing to do with the region's area —
    // so `kept < area * 0.999` got *harder* to trip the bigger the region grew. Here: a 15×15mm
    // block whose corner is clipped by the face's diagonal wall, touching over ~1.4mm. It loses
    // ~0.14mm² of 220mm², which the old test read as "lost nothing" and cut as a recess, leaving a
    // base-color band on exactly the rim the rule exists to color.
    //
    // The contact must be away from a bbox extreme or the bbox prefilter answers first and the
    // area test never runs — which is why the original tests missed this entirely. The numbers are
    // chosen so the two thresholds actually disagree: 43246mm² of region losing 0.85mm² to the
    // erosion needed 43.2mm² under the relative rule, and needs 0.005mm² under the absolute one.
    // A hubcap-sized face, since the failure only bites once the region is large.
    const chamfered: number[][] = [
      [-110, 10, -110],
      [110, 10, -110],
      [110, 10, 100],
      [100, 10, 110],
      [-110, 10, 110],
    ];
    const m = new FlatZoneMapper(
      boxPart({ edgeCutThroughDepth: 3, boundaryLoops: [chamfered] }),
      [],
      false,
      wasm,
    );
    // A big block already clipped to that face: its own corner is the face's chamfer, so it shares
    // exactly the 8.5mm stretch between (108, 102) and (102, 108) with the outline.
    const block = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-100, -100],
            [108, -100],
            [108, 102],
            [102, 108],
            [-100, 108],
            [-100, -100],
          ],
        ],
      },
    } as PolyFeature;
    const regions = m.resolveCutRegions(block, 1);
    expect(regions).toHaveLength(1);
    expect(regions[0].edge).toBe(true);
    expect(regions[0].depth).toBe(3);
  });

  it('does not fire the edge rule on an unclipped region', async () => {
    const wasm = await getManifold();
    // safeIntersect hands the region back UNCLIPPED when the clipper fails. Unclipped means it
    // reaches past the boundary everywhere, which this rule would read as "all of it is on the
    // outer wall" and cut the whole color 3mm through — a hole where the pre-rule behavior was
    // merely an oversized recess. The recess is the safe direction, so the flag turns the rule off.
    const huge = square(-500, -500, 500, 500);
    const m = new FlatZoneMapper(boxPart({ edgeCutThroughDepth: 3 }), [], false, wasm);
    expect(m.resolveCutRegions(huge, 1, { clipped: false })).toEqual([{ feat: huge, depth: 1 }]);
    // …and with the clip having succeeded, the same region is genuinely all-edge.
    expect(m.resolveCutRegions(huge, 1)[0].edge).toBe(true);
  });

  it('takes an all-edge region entirely through', async () => {
    const wasm = await getManifold();
    // Artwork covering the whole face — the single-color silhouette case. Every polygon touches,
    // so there is no interior slice at all and nothing is left cutting at the setting.
    const feat = square(-20, -20, 20, 20);
    const m = new FlatZoneMapper(boxPart({ edgeCutThroughDepth: 3 }), [], false, wasm);
    const regions = m.resolveCutRegions(feat, 1);
    expect(regions).toHaveLength(1);
    expect(regions[0].depth).toBe(3);
    expect(regions[0].edge).toBe(true);
  });

  it('frameAt anchors at the face plane with the right axes', () => {
    const f = new FlatZoneMapper(boxPart(), [], false).frameAt(3, -4);
    expect(f.origin.toArray()).toEqual([3, 10, -4]); // (offsetX, faceY, offsetY), no rect center
    expect(f.uAxis.toArray()).toEqual([1, 0, 0]);
    expect(f.vAxis.toArray()).toEqual([0, 0, 1]);
    expect(f.normal.toArray()).toEqual([0, 1, 0]);
    // rect: origin includes the off-center face center (5,5)
    const rect = new FlatZoneMapper(
      boxPart({
        boundaryLoops: [
          [
            [-5, 10, -5],
            [15, 10, -5],
            [15, 10, 15],
            [-5, 10, 15],
          ],
        ],
      }),
      [],
      true,
    ).frameAt(0, 0);
    expect(rect.origin.toArray()).toEqual([5, 10, 5]);
  });
});

describe('implicitZoneFor', () => {
  it('returns a FlatZoneMapper for a part with no baked zones', () => {
    expect(implicitZoneFor(boxPart(), [], false)).toBeInstanceOf(FlatZoneMapper);
  });
});

/**
 * Assembly mode had no upper bound on depth at all: 20mm and 9999mm on the wheel both built and
 * exported with zero warnings, while flat mode clamped and warned for the same input, and
 * depth.ts's own comment claimed both did. The flat modes then left the UI, which made the
 * unbounded path the only one a user can reach.
 */
describe('maxCutDepth', () => {
  // The box is 10 tall with its design face on top, so a recess has 10mm behind it, less the floor
  // that keeps a clamped cut from becoming a hole.
  it('measures the material behind the face, less the through floor', () => {
    expect(new FlatZoneMapper(boxPart(), [], false).maxCutDepth()).toBeCloseTo(10 - 0.05, 6);
  });

  // The cut runs down Y (buildCutter extrudes from faceY along that axis), so this measurement
  // only means anything for a face whose normal has a Y component. Everything else declines.
  //
  // That is the bug being pinned: projecting onto `patchNormal` instead returned a distance the
  // cut never travels, and wheel-half's -Z patch — selectable from the design-face dropdown, which
  // offers the top six patches unfiltered — read 139.88mm against 24.13mm of real material. The
  // mistyped depth the clamp exists to catch went straight through it.
  it('declines on a face the cut axis cannot measure, rather than guessing', () => {
    const sideFacing = boxPart({ patchNormal: [0, 0, -1], topZ: -20 });
    expect(new FlatZoneMapper(sideFacing, [], false).maxCutDepth()).toBe(Infinity);
  });

  // A tilted face is the same class: faceY (topZ / nrm.y) lands outside the mesh, so the extent
  // comes out negative. Clamping on that cut every colour on the part at 0.2mm while telling the
  // user it was "deeper than the part goes".
  it('declines on a tilted face rather than clamping to the minimum', () => {
    const tilted = boxPart({ patchNormal: [-0.95, 0.3, 0], topZ: -90 });
    expect(new FlatZoneMapper(tilted, [], false).maxCutDepth()).toBe(Infinity);
  });

  // Same reasoning at the other end: a part too thin to hold the minimum printable recess is a
  // fact about the geometry, and "deeper than the part goes" is a message about the user's number.
  it('declines when the part cannot hold a printable recess', () => {
    expect(new FlatZoneMapper(boxPart({ topZ: -4.9 }), [], false).maxCutDepth()).toBe(Infinity);
  });

  // A face pointing the other way has the same material behind it, in the other direction.
  it('handles a face pointing the other way', () => {
    const flipped = boxPart({ patchNormal: [0, -1, 0], topZ: 0 });
    expect(new FlatZoneMapper(flipped, [], false).maxCutDepth()).toBeCloseTo(10 - 0.05, 6);
  });

  // An unloaded part must clamp nothing, or a depth would be silently pinned to whatever a missing
  // mesh implies.
  it('declines when the part has no mesh yet', () => {
    const bare = boxPart({ positions: null as unknown as Float32Array });
    expect(new FlatZoneMapper(bare, [], false).maxCutDepth()).toBe(Infinity);
  });
});
