import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  asmPartFaceNormal,
  asmPartTransformGroup,
  buildAssemblyGeometry,
  rotatePointY,
  type AssemblyBuildInput,
} from '../src/geometry/assembly';
import type { AssemblyPart, ParsedSVG } from '../src/types';
import { WARNINGS, clearWarnings } from '../src/warnings';

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

function redSquareParsed(): ParsedSVG {
  const loops = [
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 },
    ],
  ];
  return {
    shapes: [{ fill: '#ff0000', loops, order: 0 }],
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    rawSVGCircle: { cx: 5, cy: 5, r: 5 },
  };
}

function baseInput(overrides: Partial<AssemblyBuildInput> = {}): AssemblyBuildInput {
  return {
    parsed: redSquareParsed(),
    parts: [boxPart()],
    mergeGroups: [],
    colorSettings: {},
    globalDepth: 2,
    radius: 10,
    scaleMult: 1,
    offX: 0,
    offZ: 0,
    flipX: false,
    flipY: false,
    ...overrides,
  };
}

function yRange(soup: Float32Array): { min: number; max: number } {
  let min = Infinity,
    max = -Infinity;
  for (let i = 1; i < soup.length; i += 3) {
    if (soup[i] < min) min = soup[i];
    if (soup[i] > max) max = soup[i];
  }
  return { min, max };
}

function xzRange(soup: Float32Array): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i],
      z = soup[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

describe('buildAssemblyGeometry', () => {
  it('cuts a pocket into the part and produces a flush inlay', { timeout: 30000 }, async () => {
    const built = (await buildAssemblyGeometry(baseInput()))!;
    expect(built).not.toBeNull();
    expect(built.palette).toHaveLength(1);
    expect(built.palette[0].hex).toBe('#ff0000');
    expect(built.detectedColors).toEqual([{ hex: '#ff0000', areaPct: 100 }]);

    const out = built.partOutputs[0];
    // uncut box is 12 tris (108 floats); a pocketed body must have more geometry
    expect(out.bodySoup.length).toBeGreaterThan(108);
    expect(out.bodyIndexed).toBeDefined();

    const inlay = out.inlaySoups[0];
    expect(inlay).toBeDefined();
    // inlay is flush with the face (y=10) and exactly globalDepth deep
    const r = yRange(inlay);
    expect(r.max).toBeCloseTo(10, 4);
    expect(r.min).toBeCloseTo(8, 4);
    // the part caps the cutter's overshoot, so the body never grows past the face
    expect(yRange(out.bodySoup).max).toBeCloseTo(10, 4);
  });

  it(
    'honors a per-color depth override via the asm: settings key',
    { timeout: 30000 },
    async () => {
      const built = (await buildAssemblyGeometry(
        baseInput({ colorSettings: { 'asm:#ff0000': { depth: 4 } } }),
      ))!;
      const r = yRange(built.partOutputs[0].inlaySoups[0]);
      expect(r.min).toBeCloseTo(6, 4);
      expect(r.max).toBeCloseTo(10, 4);
    },
  );

  it('emits the untouched body when no cuts land on the part', { timeout: 30000 }, async () => {
    const built = (await buildAssemblyGeometry(baseInput({ offX: 1000, offZ: 1000 })))!;
    const part = built.partOutputs[0];
    expect(part.inlaySoups).toEqual({});
    expect(part.bodySoup).toEqual(Float32Array.from(part.part.positions!));
  });

  it(
    'rect designFit maps the SVG 1:1 in mm, ignoring Design radius',
    { timeout: 30000 },
    async () => {
      // wheel mode would scale the 10-unit square by radius/circleR (=2) to 20mm; rect maps it 1:1.
      const built = (await buildAssemblyGeometry(baseInput({ designFit: 'rect', radius: 10 })))!;
      const inlay = built.partOutputs[0].inlaySoups[0];
      expect(inlay).toBeDefined();
      const r = xzRange(inlay);
      expect(r.maxX - r.minX).toBeCloseTo(10, 4);
      expect(r.maxZ - r.minZ).toBeCloseTo(10, 4);
    },
  );

  it(
    'rect designFit scales by the SVG physical size (userUnitMM), not raw units',
    { timeout: 30000 },
    async () => {
      // a 10-unit square whose file declares 0.5mm per user unit must cut a 5mm region — this is
      // the guard against an editor re-exporting the template at a larger internal resolution.
      const parsed: ParsedSVG = { ...redSquareParsed(), userUnitMM: 0.5 };
      const built = (await buildAssemblyGeometry(baseInput({ designFit: 'rect', parsed })))!;
      const r = xzRange(built.partOutputs[0].inlaySoups[0]);
      expect(r.maxX - r.minX).toBeCloseTo(5, 4);
      expect(r.maxZ - r.minZ).toBeCloseTo(5, 4);
    },
  );

  it(
    'rect designFit fits a size-less SVG to the face via its viewBox',
    { timeout: 30000 },
    async () => {
      // No userUnitMM (an editor stripped the mm size, e.g. Affinity's width="100%"), but the
      // viewBox is 20 units across a 40mm face -> fit 2mm per unit, so the 10-unit square cuts a
      // 20mm region instead of landing 1:1. This is what keeps a template trace life-size.
      const parsed: ParsedSVG = { ...redSquareParsed(), viewBox: { w: 20, h: 20 } };
      const built = (await buildAssemblyGeometry(baseInput({ designFit: 'rect', parsed })))!;
      const r = xzRange(built.partOutputs[0].inlaySoups[0]);
      expect(r.maxX - r.minX).toBeCloseTo(20, 4);
      expect(r.maxZ - r.minZ).toBeCloseTo(20, 4);
    },
  );

  it(
    'rect designFit reports no size verdict until a part has loaded',
    { timeout: 30000 },
    async () => {
      // A library part still fetching has no face to measure yet. Claiming a 1:1 placement here
      // would be contradicted moments later by the rebuild the part's own load triggers, so the
      // build stays quiet instead of emitting a notice it's about to walk back.
      clearWarnings();
      const parsed: ParsedSVG = { ...redSquareParsed(), viewBox: { w: 20, h: 20 } };
      await buildAssemblyGeometry(
        baseInput({ designFit: 'rect', parsed, parts: [boxPart({ loaded: false })] }),
      );
      expect(WARNINGS.filter((w) => /absolute width\/height/.test(w.message))).toEqual([]);

      // …and once it has loaded, the auto-fit notice does appear.
      await buildAssemblyGeometry(baseInput({ designFit: 'rect', parsed }));
      expect(WARNINGS.filter((w) => /auto-fit to the part face/.test(w.message))).toHaveLength(1);
    },
  );

  it('rect designFit centers the design on an off-center face', { timeout: 30000 }, async () => {
    // a face whose bbox center is (5,5) in native X/Z — rect placement should land the artwork
    // there, not at the part origin (where wheel mode anchors).
    const part = boxPart({
      boundaryLoop: [
        [-5, 10, -5],
        [15, 10, -5],
        [15, 10, 15],
        [-5, 10, 15],
      ],
    });
    const built = (await buildAssemblyGeometry(baseInput({ designFit: 'rect', parts: [part] })))!;
    const inlay = built.partOutputs[0].inlaySoups[0];
    expect(inlay).toBeDefined();
    const r = xzRange(inlay);
    expect((r.minX + r.maxX) / 2).toBeCloseTo(5, 4);
    expect((r.minZ + r.maxZ) / 2).toBeCloseTo(5, 4);
  });
});

describe('rotatePointY', () => {
  it('rotates about the pivot', () => {
    const [x, z] = rotatePointY(1, 0, 0, 0, 90);
    expect(x).toBeCloseTo(0);
    expect(z).toBeCloseTo(1);
    const [px, pz] = rotatePointY(6, 2, 5, 2, 180);
    expect(px).toBeCloseTo(4);
    expect(pz).toBeCloseTo(2);
  });
});

describe('asmPartFaceNormal', () => {
  it('falls back to the source part for duplicates', () => {
    const src = boxPart({ id: 1, patchNormal: [0, -1, 0] });
    const dup = boxPart({ id: 2, isDuplicateOf: 1, patchNormal: undefined });
    expect(asmPartFaceNormal(dup, [src, dup])).toEqual([0, -1, 0]);
    expect(asmPartFaceNormal(boxPart({ patchNormal: undefined }), [])).toBeNull();
  });
});

describe('asmPartTransformGroup', () => {
  it('is the identity for a primary part', () => {
    const { outer, add } = asmPartTransformGroup(boxPart());
    const mesh = new THREE.Object3D();
    add(mesh);
    outer.updateMatrixWorld(true);
    expect(mesh.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([0, 0, 0]);
  });

  it('renders a duplicate at the same place rotatePointY maps it', () => {
    const part = boxPart({ isDuplicateOf: 1, pivotX: 5, pivotZ: 0, angleDeg: 90 });
    const { outer, add } = asmPartTransformGroup(part);
    const mesh = new THREE.Object3D();
    add(mesh);
    outer.updateMatrixWorld(true);
    const p = mesh.getWorldPosition(new THREE.Vector3());
    const [ex, ez] = rotatePointY(0, 0, part.pivotX, part.pivotZ, part.angleDeg);
    expect(p.x).toBeCloseTo(ex);
    expect(p.z).toBeCloseTo(ez);
    expect(ex).toBeCloseTo(5);
    expect(ez).toBeCloseTo(-5);
  });
});
