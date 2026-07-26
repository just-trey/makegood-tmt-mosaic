import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FlatZoneMapper, implicitZoneFor, type DesignPlacement } from '../src/geometry/zones';
import type { AssemblyPart } from '../src/types';

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
    boundaryLoop: [
      [-20, 10, -20],
      [20, 10, -20],
      [20, 10, 20],
      [-20, 10, 20],
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
  if (isRect && part.boundaryLoop && part.boundaryLoop.length) {
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const q of part.boundaryLoop) {
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
        boundaryLoop: [
          [-5, 10, -5],
          [15, 10, -5],
          [15, 10, 15],
          [-5, 10, 15],
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

  it('resolveCutDepth passes through, unless the zone is cut-through', () => {
    expect(new FlatZoneMapper(boxPart(), [], false).resolveCutDepth(2)).toBe(2);
    const through = new FlatZoneMapper(
      boxPart({ cutThrough: true, cutThroughDepth: 3 }),
      [],
      false,
    );
    expect(through.resolveCutDepth(2)).toBe(3);
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
        boundaryLoop: [
          [-5, 10, -5],
          [15, 10, -5],
          [15, 10, 15],
          [-5, 10, 15],
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
