import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  asmPartFaceNormal,
  asmPartTransformGroup,
  buildAssemblyGeometry,
  rotatePointY,
  type ArtworkBuildInput,
  type AssemblyBuildInput,
} from '../src/geometry/assembly';
import { getManifold } from '../src/geometry/manifold';
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

/** Two non-overlapping squares (red, blue) in one document — used to give one color multiple
 * contributing artworks (see the CSG failure-handling tests below) while keeping a second color
 * that only ever gets one contributor. */
function twoColorSquaresParsed(): ParsedSVG {
  return {
    shapes: [
      {
        fill: '#ff0000',
        loops: [
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
            { x: 0, y: 0 },
          ],
        ],
        order: 0,
      },
      {
        fill: '#0000ff',
        loops: [
          [
            { x: 10, y: 0 },
            { x: 20, y: 0 },
            { x: 20, y: 10 },
            { x: 10, y: 10 },
            { x: 10, y: 0 },
          ],
        ],
        order: 1,
      },
    ],
    bbox: { minX: 0, minY: 0, maxX: 20, maxY: 10 },
    rawSVGCircle: { cx: 10, cy: 5, r: 10 },
  };
}

/**
 * The single-artwork shorthand: placement fields are accepted flat, as the build itself took them
 * before artwork instances existed, and folded into one unbound artwork. Pass `artworks` instead
 * to place several.
 */
type BaseOverrides = Partial<Omit<AssemblyBuildInput, 'artworks'>> &
  Partial<ArtworkBuildInput> & { artworks?: ArtworkBuildInput[] };

function baseInput(overrides: BaseOverrides = {}): AssemblyBuildInput {
  const {
    parsed,
    zoneId,
    scaleMult,
    offX,
    offZ,
    flipX,
    flipY,
    rotationDeg,
    mode,
    artworks,
    ...rest
  } = overrides;
  return {
    artworks: artworks ?? [
      {
        parsed: parsed ?? redSquareParsed(),
        zoneId: zoneId ?? null,
        scaleMult: scaleMult ?? 1,
        offX: offX ?? 0,
        offZ: offZ ?? 0,
        flipX: flipX ?? false,
        flipY: flipY ?? false,
        rotationDeg: rotationDeg ?? 0,
        mode: mode ?? 'sticker',
      },
    ],
    parts: [boxPart()],
    mergeGroups: [],
    colorSettings: {},
    globalDepth: 2,
    radius: 10,
    ...rest,
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

  describe('CSG failure handling', () => {
    it(
      "drops just the color whose zone cutters fail to merge, keeping the part's other colors cut",
      { timeout: 30000 },
      async () => {
        // Two artworks both painting red (so #ff0000 gets two prisms on the single implicit
        // zone, which the build has to Manifold.union together), plus one contributing blue
        // (a single prism, never reaching that union call).
        const artworks: ArtworkBuildInput[] = [
          {
            parsed: twoColorSquaresParsed(),
            zoneId: null,
            scaleMult: 1,
            offX: 0,
            offZ: 0,
            flipX: false,
            flipY: false,
            rotationDeg: 0,
            mode: 'sticker',
          },
          {
            parsed: redSquareParsed(),
            zoneId: null,
            scaleMult: 1,
            offX: 0,
            offZ: 0,
            flipX: false,
            flipY: false,
            rotationDeg: 0,
            mode: 'sticker',
          },
        ];

        const wasm = await getManifold();
        const unionSpy = vi.spyOn(wasm.Manifold, 'union').mockImplementation(() => {
          throw new Error('mock union failure');
        });
        // `owned` (assembly.ts) tracks every solid created for this part and frees them all via
        // manifoldDelete — including the two red prisms whose union failed, which are pushed
        // into `owned` before the union is even attempted. Spying on the underlying .delete()
        // that manifoldDelete calls is the only way to observe that from outside the module.
        // The getPrototypeOf hop is load-bearing, not stylistic: `wasm.Manifold.prototype` itself
        // is an empty Embind shim object that real solids don't actually chain through, so
        // `vi.spyOn(wasm.Manifold.prototype, 'delete')` succeeds silently but records zero calls
        // (verified experimentally — no error, just nothing captured). The real bound prototype,
        // and the one solid instances resolve `.delete` against, is one level up.
        const deleteSpy = vi.spyOn(Object.getPrototypeOf(wasm.Manifold.prototype), 'delete');
        clearWarnings();
        try {
          const built = (await buildAssemblyGeometry(baseInput({ artworks })))!;
          expect(built).not.toBeNull();
          expect(built.palette.map((p) => p.hex).sort()).toEqual(['#0000ff', '#ff0000']);

          const redIdx = built.palette.findIndex((p) => p.hex === '#ff0000');
          const blueIdx = built.palette.findIndex((p) => p.hex === '#0000ff');
          const part = built.partOutputs[0];
          // red's merge failed and was dropped — no inlay for it, but the part is not abandoned
          expect(part.inlaySoups[redIdx]).toBeUndefined();
          // blue only ever had one contributing prism (no union call), so it survives and cuts
          expect(part.inlaySoups[blueIdx]).toBeDefined();
          // the body was still cut (by blue's prism), not left untouched
          expect(part.bodySoup).not.toEqual(Float32Array.from(part.part.positions!));

          expect(
            WARNINGS.some(
              (w) =>
                /couldn't combine the cut solids/i.test(w.message) && /#ff0000/.test(w.message),
            ),
          ).toBe(true);

          // No leak: this build creates exactly 5 solids that need freeing — red's two
          // (never-merged) prisms, blue's one prism, the part mesh, and blue's inlay — and all
          // five must still be deleted even though red's merge threw partway through the loop.
          expect(deleteSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
        } finally {
          unionSpy.mockRestore();
          deleteSpy.mockRestore();
        }
      },
    );

    it(
      'exports uncut and without inlays when the body-cut boolean fails, instead of shipping ' +
        'a cut/inlay pair that would overlap',
      { timeout: 30000 },
      async () => {
        const wasm = await getManifold();
        const diffSpy = vi.spyOn(wasm.Manifold, 'difference').mockImplementation(() => {
          throw new Error('mock difference failure');
        });
        const intersectSpy = vi.spyOn(wasm.Manifold, 'intersection');
        // See the getPrototypeOf note in the test above — spying on `wasm.Manifold.prototype`
        // directly compiles fine but silently misses every real .delete() call.
        const deleteSpy = vi.spyOn(Object.getPrototypeOf(wasm.Manifold.prototype), 'delete');
        clearWarnings();
        try {
          const built = (await buildAssemblyGeometry(baseInput()))!;
          expect(built).not.toBeNull();
          const part = built.partOutputs[0];

          // same shape as the existing non-watertight-mesh branch: uncut body, no inlays
          expect(part.inlaySoups).toEqual({});
          expect(part.bodySoup).toEqual(Float32Array.from(part.part.positions!));
          // no half-done inlay was even attempted once the body cut itself failed
          expect(intersectSpy).not.toHaveBeenCalled();

          expect(
            WARNINGS.some(
              (w) =>
                /boolean cut failed/i.test(w.message) &&
                /uncut and without inlays/i.test(w.message),
            ),
          ).toBe(true);

          // No leak: the single cut prism and the part mesh must still be freed even though the
          // difference threw and no inlay was ever built.
          expect(deleteSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        } finally {
          diffSpy.mockRestore();
          intersectSpy.mockRestore();
          deleteSpy.mockRestore();
        }
      },
    );
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

  it(
    'rotationDeg spins the design about its center (90° swaps X/Z extents)',
    { timeout: 30000 },
    async () => {
      // a 20mm × 6mm rect design (rect fit, 1:1) — at 0° it cuts a wide-and-short region; rotated
      // 90° about its center the same region becomes narrow-and-tall, so the extents swap while the
      // center stays put.
      const wideParsed: ParsedSVG = {
        shapes: [
          {
            fill: '#ff0000',
            loops: [
              [
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                { x: 20, y: 6 },
                { x: 0, y: 6 },
                { x: 0, y: 0 },
              ],
            ],
            order: 0,
          },
        ],
        bbox: { minX: 0, minY: 0, maxX: 20, maxY: 6 },
        rawSVGCircle: null,
        userUnitMM: 1,
      };
      const flat = (await buildAssemblyGeometry(
        baseInput({ designFit: 'rect', parsed: wideParsed, rotationDeg: 0 }),
      ))!;
      const turned = (await buildAssemblyGeometry(
        baseInput({ designFit: 'rect', parsed: wideParsed, rotationDeg: 90 }),
      ))!;
      const a = xzRange(flat.partOutputs[0].inlaySoups[0]);
      const b = xzRange(turned.partOutputs[0].inlaySoups[0]);
      expect(a.maxX - a.minX).toBeCloseTo(20, 3);
      expect(a.maxZ - a.minZ).toBeCloseTo(6, 3);
      // swapped
      expect(b.maxX - b.minX).toBeCloseTo(6, 3);
      expect(b.maxZ - b.minZ).toBeCloseTo(20, 3);
      // center unchanged (design centered on the face at origin)
      expect((b.minX + b.maxX) / 2).toBeCloseTo((a.minX + a.maxX) / 2, 3);
      expect((b.minZ + b.maxZ) / 2).toBeCloseTo((a.minZ + a.maxZ) / 2, 3);
    },
  );
});

describe('fill mode', () => {
  /** A 4mm square centered in a 10mm-square tile — one period of a (very plain) pattern. */
  function tileParsed(): ParsedSVG {
    return {
      shapes: [
        {
          fill: '#ff0000',
          loops: [
            [
              { x: 3, y: 3 },
              { x: 7, y: 3 },
              { x: 7, y: 7 },
              { x: 3, y: 7 },
              { x: 3, y: 3 },
            ],
          ],
          order: 0,
        },
      ],
      bbox: { minX: 3, minY: 3, maxX: 7, maxY: 7 },
      rawSVGCircle: null,
      userUnitMM: 1,
      viewBox: { w: 10, h: 10 },
    };
  }

  it('repeats the tile across the whole face and clips it there', { timeout: 60000 }, async () => {
    const parsed = tileParsed();
    const sticker = (await buildAssemblyGeometry(baseInput({ parsed })))!;
    const fill = (await buildAssemblyGeometry(baseInput({ parsed, mode: 'fill' })))!;
    const s = xzRange(sticker.partOutputs[0].inlaySoups[0]);
    const f = xzRange(fill.partOutputs[0].inlaySoups[0]);
    // one copy is a single 20mm region (wheel mode scales it to the design radius); the fill
    // reaches across the whole 40mm face and stops exactly at its edge, where the clip lands
    expect(s.maxX - s.minX).toBeCloseTo(20, 3);
    expect(f.minX).toBeCloseTo(-20, 3);
    expect(f.maxX).toBeCloseTo(20, 3);
    expect(f.minZ).toBeCloseTo(-20, 3);
    expect(f.maxZ).toBeCloseTo(20, 3);
    // and it really is many copies, not one stretched one
    expect(fill.partOutputs[0].inlaySoups[0].length).toBeGreaterThan(
      8 * sticker.partOutputs[0].inlaySoups[0].length,
    );
  });

  it(
    'a fill anchors on its tile, ignoring the wheel design-circle scaling',
    { timeout: 60000 },
    async () => {
      // Design radius rescales a circle-anchored sticker; a tile is a real-world period, so the
      // same fill has to come out identical at any radius.
      const near = (await buildAssemblyGeometry(
        baseInput({ parsed: tileParsed(), mode: 'fill', radius: 10 }),
      ))!;
      const far = (await buildAssemblyGeometry(
        baseInput({ parsed: tileParsed(), mode: 'fill', radius: 40 }),
      ))!;
      const a = xzRange(near.partOutputs[0].inlaySoups[0]);
      const b = xzRange(far.partOutputs[0].inlaySoups[0]);
      expect(b.minX).toBeCloseTo(a.minX, 4);
      expect(b.maxX).toBeCloseTo(a.maxX, 4);
      expect(far.partOutputs[0].inlaySoups[0].length).toBe(
        near.partOutputs[0].inlaySoups[0].length,
      );
    },
  );

  it(
    'refuses an unreasonable tile count, warns, and places a single copy',
    { timeout: 60000 },
    async () => {
      clearWarnings();
      const built = (await buildAssemblyGeometry(
        baseInput({ parsed: tileParsed(), mode: 'fill', scaleMult: 0.05 }),
      ))!;
      expect(WARNINGS.some((w) => /more than \d+ tiles/.test(w.message))).toBe(true);
      const r = xzRange(built.partOutputs[0].inlaySoups[0]);
      expect(r.maxX - r.minX).toBeCloseTo(0.2, 3); // the lone 4mm square at 5%
    },
  );

  it('a circle-less fill skips the wheel auto-center notice', { timeout: 60000 }, async () => {
    clearWarnings();
    await buildAssemblyGeometry(baseInput({ parsed: tileParsed(), mode: 'fill' }));
    expect(WARNINGS.filter((w) => /no <circle>/.test(w.message))).toEqual([]);
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
