import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  asmPartFaceNormal,
  asmPartTransformGroup,
  buildAssemblyGeometry,
  designAnchor,
  designMmPerUnit,
  fillRefusalMessage,
  memoLargestDesignFace,
  rotatePointY,
  type ArtworkBuildInput,
  type AssemblyBuildInput,
} from '../src/geometry/assembly';
import { getManifold } from '../src/geometry/manifold';
import { build3MFCombined, type ExportPart, type ExportSub } from '../src/export/threemf';
import { getPrinter } from '../src/export/printers';
import { partObjectSummaries } from './lib/threemf';
import type { AssemblyPart, AssemblyPartOutput, ParsedSVG } from '../src/types';
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
 * Two colors placed against a 40mm-square design face at `radius: 20` (mmPerUnit 1, centred on
 * (20, 20)): red is a tall bar flush against one wall of the face, blue a small island in the
 * middle. Exactly the shape of the edge-rule question — one color reaching the part's outer edge,
 * one not — with the two on separate palette slots so their inlays can be measured apart.
 */
function edgeAndInteriorParsed(): ParsedSVG {
  const rect = (x0: number, y0: number, x1: number, y1: number) => [
    [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
      { x: x0, y: y0 },
    ],
  ];
  return {
    shapes: [
      { fill: '#ff0000', loops: rect(0, 0, 10, 40), order: 0 },
      { fill: '#0000ff', loops: rect(15, 15, 25, 25), order: 1 },
    ],
    bbox: { minX: 0, minY: 0, maxX: 40, maxY: 40 },
    rawSVGCircle: { cx: 20, cy: 20, r: 20 },
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
    // The in-memory assertions below stop one layer above the file that ships, and the bug these
    // branches exist for was an export bug — an uncut body shipping alongside inlay solids in the
    // same volume. These two build the real 3MF from the same output and read back what it
    // contains, mirroring exportPanel.ts's ExportPart wiring so the test and the app agree.
    function toExportPart(out: AssemblyPartOutput): ExportPart {
      const subs: ExportSub[] = [
        { name: 'Body', matIndex: 0, soup: out.bodySoup, indexed: out.bodyIndexed },
      ];
      Object.entries(out.inlaySoups).forEach(([ci, soup]) =>
        subs.push({
          name: `color${ci}`,
          matIndex: +ci + 1,
          soup,
          indexed: out.inlayIndexed?.[+ci],
        }),
      );
      return { name: out.part.name, nsign: 1, bodySoup: out.bodySoup, subs };
    }

    async function exportSummary(out: AssemblyPartOutput) {
      const { blob } = await build3MFCombined(
        [{ name: 'Body', color: '#cccccc' }],
        [toExportPart(out)],
        { printer: getPrinter('bambu-x1c') },
      );
      const summaries = await partObjectSummaries(blob);
      expect(summaries).toHaveLength(1);
      return summaries[0];
    }

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

          // ...and the exported file carries exactly that: body plus blue's inlay alone. The
          // extruder pins which color survived — red's would be redIdx + 2.
          const summary = await exportSummary(part);
          expect(summary.bodyCount).toBe(1);
          expect(summary.inlayCount).toBe(1);
          expect(summary.extruders).toEqual([1, blueIdx + 2]);

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

          // ...and nothing inlay-shaped reached the file either: the exported part is its body
          // and nothing else, so there is no solid left overlapping the uncut volume.
          const summary = await exportSummary(part);
          expect(summary.bodyCount).toBe(1);
          expect(summary.inlayCount).toBe(0);

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

    it(
      'frees the body solid when the boolean succeeds but converting its mesh throws',
      { timeout: 30000 },
      async () => {
        // The leak this pins: Manifold.difference returns a live solid, then manifoldToMeshes
        // throws inside it (getMesh / a RangeError allocating the vertex array on a huge
        // result). If the handle isn't freed in a finally, that solid is unreachable WASM
        // memory — the exact failure the uncut-export path is supposed to avoid.
        const wasm = await getManifold();
        const proto = Object.getPrototypeOf(wasm.Manifold.prototype);
        // First getMesh call in the build is the body's, so once is enough to hit only it.
        const getMeshSpy = vi.spyOn(proto, 'getMesh').mockImplementationOnce(() => {
          throw new Error('mock getMesh failure');
        });
        const deleteSpy = vi.spyOn(proto, 'delete');
        clearWarnings();
        try {
          const built = (await buildAssemblyGeometry(baseInput()))!;
          const part = built.partOutputs[0];

          // treated as a body-cut failure: uncut body, no inlays
          expect(part.bodySoup).toEqual(Float32Array.from(part.part.positions!));
          expect(part.inlaySoups).toEqual({});

          // Three solids exist and must all be freed: the cut prism, the part mesh, and the
          // body that difference() successfully produced before getMesh threw. Two deletes
          // would mean the body handle leaked.
          expect(deleteSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
        } finally {
          getMeshSpy.mockRestore();
          deleteSpy.mockRestore();
        }
      },
    );

    it(
      'keeps the cut body but names the color and says the recess prints empty when only the ' +
        'inlay intersection fails',
      { timeout: 30000 },
      async () => {
        // The asymmetric case: the body difference succeeds, so the pocket is already cut and
        // redoing it is the expensive half — the part ships with a real recess and no inlay.
        const wasm = await getManifold();
        const intersectSpy = vi.spyOn(wasm.Manifold, 'intersection').mockImplementation(() => {
          throw new Error('mock intersection failure');
        });
        const deleteSpy = vi.spyOn(Object.getPrototypeOf(wasm.Manifold.prototype), 'delete');
        clearWarnings();
        try {
          const built = (await buildAssemblyGeometry(baseInput()))!;
          const part = built.partOutputs[0];

          // the body really was cut — this is not the export-uncut escape
          expect(part.bodySoup).not.toEqual(Float32Array.from(part.part.positions!));
          expect(part.inlaySoups).toEqual({});

          // the warning has to name the color and say the recess ships empty, or it's
          // indistinguishable from the alarming-but-harmless seam-sliver case
          const w = WARNINGS.find((x) => /couldn't fit the inlay/i.test(x.message));
          expect(w).toBeDefined();
          expect(w!.message).toMatch(/#ff0000/);
          expect(w!.message).toMatch(/empty recess/i);

          // No leak: the cut prism, the part mesh, and the successfully-built body must all be
          // freed even though every intersection threw.
          expect(deleteSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
        } finally {
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
    'rect designFit anchors on the document canvas, not the drawn content',
    { timeout: 30000 },
    async () => {
      // A template sheet spanning the whole 40mm face with a 10mm square drawn in one corner of
      // it. The square is asking to be cut in that corner — anchoring on its own bbox instead
      // would re-center it on the face, which is what dropped a fender-shaped design onto the
      // neighbouring part of the chair's `left` zone. The +Y face mirrors X (placeOnPart's
      // nsign > 0 branch), so the SVG's top-left corner maps to the face's +X/+Z corner.
      //
      // The sheet states its canvas as a declared mm box with no viewBox — the case a re-exported
      // template hits, and the one that still re-centered after the first cut of this fix.
      const parsed: ParsedSVG = {
        ...redSquareParsed(),
        rawSVGCircle: null,
        userUnitMM: 1,
        viewBox: null,
        canvas: { w: 40, h: 40 },
      };
      const built = (await buildAssemblyGeometry(baseInput({ designFit: 'rect', parsed })))!;
      const r = xzRange(built.partOutputs[0].inlaySoups[0]);
      expect(r.maxX - r.minX).toBeCloseTo(10, 3);
      expect(r.maxZ - r.minZ).toBeCloseTo(10, 3);
      expect((r.minX + r.maxX) / 2).toBeCloseTo(15, 3);
      expect((r.minZ + r.maxZ) / 2).toBeCloseTo(15, 3);
    },
  );

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

describe('fillRefusalMessage', () => {
  // docs/ui-conventions.md 2 and 3: name something the user can act on, one problem and one
  // primary remedy. One message for four causes advised raising Scale for all of them.
  const reasons = ['too-many-tiles', 'no-tile-size', 'not-invertible', 'not-affine'] as const;

  it('gives every cause its own wording, naming the part', () => {
    const msgs = reasons.map((r) => fillRefusalMessage('zebra.svg', 'Handle (left)', r));
    expect(new Set(msgs).size).toBe(reasons.length);
    msgs.forEach((m) => expect(m).toContain('Handle (left)'));
    // Both remedies write fit state that only reaches the active design, so a pill that names
    // only the part sends the user to change the wrong one.
    msgs.forEach((m) => expect(m).toContain('zebra.svg'));
  });

  it('offers "Raise Scale" only where scaling up is what fixes it', () => {
    const scaled = reasons.filter((r) => /Raise Scale/.test(fillRefusalMessage('d.svg', 'P', r)));
    expect(scaled).toEqual(['too-many-tiles']);
  });

  it('states one remedy per message, not a list', () => {
    for (const r of reasons) {
      const m = fillRefusalMessage('d.svg', 'P', r);
      // One remedy each, and every cause has to carry one — a message with none is a report
      // rather than something the user can act on (convention 2).
      const offers = [
        /Raise Scale/,
        /Reset to auto-fit/,
        /Place separate designs/,
        /Use a design with/,
      ].filter((re) => re.test(m)).length;
      expect(offers).toBe(1);
    }
  });

  it('tells two designs failing the same way on one part apart', () => {
    // warnings.ts dedupes on the exact string, so these have to differ or the second is swallowed.
    expect(fillRefusalMessage('a.svg', 'Top', 'too-many-tiles')).not.toBe(
      fillRefusalMessage('b.svg', 'Top', 'too-many-tiles'),
    );
  });

  it('says so rather than guessing when no cause was recorded', () => {
    const m = fillRefusalMessage('d.svg', 'P', undefined);
    expect(m).not.toMatch(/Raise Scale/);
    expect(m).toContain("didn't record");
  });
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

/**
 * The anchor and scale resolvers are shared with the gizmo (src/scene/faceFrame.ts) so a frame is
 * drawn around the same design the build cuts. They were closures inside buildAssemblyGeometry;
 * these pin the contract now that a second caller depends on it, and keep the `notice` routing
 * explicit — the build reports, the gizmo (which re-resolves on every refresh) stays silent.
 */
describe('shared design anchor and scale resolvers', () => {
  const face = () => ({ w: 200, h: 200 });

  it('anchors a rect design on its document canvas, a wheel design on its circle', () => {
    const parsed: ParsedSVG = { ...redSquareParsed(), canvas: { w: 100, h: 80 } };
    expect(designAnchor(parsed, true)).toEqual({ cx: 50, cy: 40, r: 50 });
    expect(designAnchor(parsed, false)).toEqual({ cx: 5, cy: 5, r: 5 });
  });

  it('falls back to the content bbox when there is no canvas and no circle', () => {
    const parsed: ParsedSVG = { ...redSquareParsed(), rawSVGCircle: null };
    expect(designAnchor(parsed, true)).toEqual({ cx: 5, cy: 5, r: 5 });
  });

  it('scales a wheel design by the design radius over the anchor radius', () => {
    const ctx = { isRect: false, radius: 138, designFace: face };
    expect(designMmPerUnit(redSquareParsed(), 1, 5, ctx)).toBeCloseTo(138 / 5, 9);
    // a fill tile is a real-world period, so forceRect maps it in mm on the wheel too
    expect(designMmPerUnit({ ...redSquareParsed(), userUnitMM: 0.5 }, 1, 5, ctx, true)).toBe(0.5);
  });

  it('prefers a declared mm size, else auto-fits the viewBox to the design face', () => {
    const ctx = { isRect: true, radius: 138, designFace: face };
    expect(designMmPerUnit({ ...redSquareParsed(), userUnitMM: 0.5 }, 2, 5, ctx)).toBe(1);
    // meet-fit: the smaller axis ratio, matching SVG's own default fitting
    const noSize: ParsedSVG = { ...redSquareParsed(), viewBox: { w: 100, h: 50 } };
    expect(designMmPerUnit(noSize, 1, 5, ctx)).toBeCloseTo(2, 9); // min(200/100, 200/50)
  });

  it('places 1:1 when there is no declared size and no viewBox', () => {
    const ctx = { isRect: true, radius: 138, designFace: face };
    expect(designMmPerUnit(redSquareParsed(), 3, 5, ctx)).toBe(3);
  });

  it('reports through `notice` only when one is passed', () => {
    const ctx = { isRect: true, radius: 138, designFace: face };
    const noSize: ParsedSVG = { ...redSquareParsed(), viewBox: { w: 100, h: 100 } };
    const said: string[] = [];
    designMmPerUnit(noSize, 1, 5, ctx, false, (m) => said.push(m));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/auto-fit to the part face/);
    // the gizmo's call: same answer, nothing added to the warnings panel
    expect(() => designMmPerUnit(noSize, 1, 5, ctx)).not.toThrow();
  });

  it('measures the largest loaded design face and memoizes it', () => {
    const small = boxPart({ id: 1 });
    const big = boxPart({
      id: 2,
      boundaryLoop: [
        [-50, 10, -30],
        [50, 10, -30],
        [50, 10, 30],
        [-50, 10, 30],
      ],
    });
    expect(memoLargestDesignFace([small, big])()).toEqual({ w: 100, h: 60 });
    // a part still fetching has no face to measure, so nothing is claimed
    expect(memoLargestDesignFace([boxPart({ loaded: false })])()).toBeNull();

    const once = memoLargestDesignFace([small]);
    expect(once()).toBe(once());
  });
});

describe('buildAssemblyGeometry zero-depth handling', () => {
  beforeEach(() => clearWarnings());

  it('raises a zero depth to a depth that prints, and says so', { timeout: 30000 }, async () => {
    const built = (await buildAssemblyGeometry(
      baseInput({ colorSettings: { 'asm:#ff0000': { depth: 0 } } }),
    ))!;
    const r = yRange(built.partOutputs[0].inlaySoups[0]);
    expect(r.max).toBeCloseTo(10, 4);
    // one typical layer, not the 0.02 mm geometry tolerance — a tenth of a layer slices to
    // nothing while still costing an AMS slot
    expect(r.min).toBeCloseTo(9.8, 4);
    expect(WARNINGS.map((w) => w.message)).toContain(
      'Depth for "#ff0000" was set to 0.00 mm, which is not a depth that can cut — it was raised to 0.20 mm.',
    );
  });

  it(
    'keeps the color on a cutThrough part instead of dropping it',
    { timeout: 30000 },
    async () => {
      // Dropping it deleted the color's list row (a color with no inlay area anywhere gets none),
      // taking away the depth field the warning tells you to correct.
      const built = (await buildAssemblyGeometry(
        baseInput({
          parts: [boxPart({ cutThrough: true, cutThroughDepth: 3 })],
          colorSettings: { 'asm:#ff0000': { depth: 0 } },
        }),
      ))!;

      expect(built.partOutputs[0].inlaySoups[0]).toBeDefined();
    },
  );

  it(
    'reports the raised setting, never a cut depth a cutThrough part did not make',
    { timeout: 30000 },
    async () => {
      // resolveCutDepth discards the setting on a cutThrough part and takes the hole the whole
      // way through. A message naming a cut depth understated a 3 mm through-hole as 0.02 mm.
      const built = (await buildAssemblyGeometry(
        baseInput({
          parts: [boxPart({ cutThrough: true, cutThroughDepth: 3 })],
          colorSettings: { 'asm:#ff0000': { depth: 0 } },
        }),
      ))!;

      const r = yRange(built.partOutputs[0].inlaySoups[0]);
      expect(r.max - r.min).toBeGreaterThan(2.5); // really cut through, not 0.2 mm
      expect(WARNINGS.every((w) => !w.message.includes('was cut at'))).toBe(true);
      expect(WARNINGS.some((w) => w.message.includes('it was raised to 0.20 mm.'))).toBe(true);
    },
  );

  it(
    'still cuts a cutThrough part all the way through at a normal depth',
    { timeout: 30000 },
    async () => {
      const built = (await buildAssemblyGeometry(
        baseInput({ parts: [boxPart({ cutThrough: true, cutThroughDepth: 3 })] }),
      ))!;
      const r = yRange(built.partOutputs[0].inlaySoups[0]);
      // the through-cut is deeper than the 2 mm globalDepth would have made it
      expect(r.max - r.min).toBeGreaterThan(2.5);
      expect(WARNINGS.filter((w) => w.message.startsWith('Depth for color'))).toHaveLength(0);
    },
  );
});

describe('buildAssemblyGeometry depth labels and thin cuts', () => {
  beforeEach(() => clearWarnings());

  it('names a merged group the way the color list labels it', { timeout: 30000 }, async () => {
    // The dominant hex is never rendered as text for a merged row, so naming it points the user
    // at a row that doesn't exist. Flat mode was fixed for this; assembly kept the bug until the
    // label rule moved into one shared place.
    await buildAssemblyGeometry(
      baseInput({
        parsed: twoColorSquaresParsed(),
        mergeGroups: [['#ff0000', '#0000ff']],
        globalDepth: 0,
      }),
    );

    expect(WARNINGS.some((w) => w.message.startsWith('Depth for "Merged (2)" was set to'))).toBe(
      true,
    );
    expect(WARNINGS.every((w) => !w.message.startsWith('Depth for color'))).toBe(true);
  });

  it('honors a positive depth thinner than a layer', { timeout: 30000 }, async () => {
    const built = (await buildAssemblyGeometry(
      baseInput({ colorSettings: { 'asm:#ff0000': { depth: 0.12 } } }),
    ))!;

    const r = yRange(built.partOutputs[0].inlaySoups[0]);
    expect(r.max - r.min).toBeCloseTo(0.12, 4);
    const note = WARNINGS.find((w) => w.message.includes('thinner than the usual'));
    expect(note).toBeDefined();
    expect(note!.level).toBe('info');
  });

  it(
    'stays quiet about a thin depth on a part that cuts through anyway',
    { timeout: 30000 },
    async () => {
      // The note predicts a print outcome ("won't show up at 0.2 mm layers"), and resolveCutDepth
      // discards the setting on a cutThrough part — so the pill claimed an invisible recess while
      // the cap was being cut 3 mm clean through. Same trap as the zero-depth message above, which
      // is why the gate asks the mapper what it did rather than reading part.cutThrough here.
      const built = (await buildAssemblyGeometry(
        baseInput({
          parts: [boxPart({ cutThrough: true, cutThroughDepth: 3 })],
          colorSettings: { 'asm:#ff0000': { depth: 0.12 } },
        }),
      ))!;

      const r = yRange(built.partOutputs[0].inlaySoups[0]);
      expect(r.max - r.min).toBeGreaterThan(2.5); // cut through, not 0.12 mm
      expect(WARNINGS.filter((w) => w.message.includes('thinner than the usual'))).toEqual([]);
    },
  );

  it('still notes a thin depth when some part does cut to it', { timeout: 30000 }, async () => {
    // The gate is per-part and warnings dedupe by message, so a color spanning both kinds of
    // part must still get the note — it is true of the part that honors the setting.
    await buildAssemblyGeometry(
      baseInput({
        parts: [
          boxPart({ cutThrough: true, cutThroughDepth: 3 }),
          boxPart({ id: 2, name: 'plain box' }),
        ],
        colorSettings: { 'asm:#ff0000': { depth: 0.12 } },
      }),
    );

    expect(WARNINGS.filter((w) => w.message.includes('thinner than the usual'))).toHaveLength(1);
  });
});

describe('buildAssemblyGeometry edge-cut-through rule', () => {
  beforeEach(() => clearWarnings());

  /** A part's inlay for a given color. By hex, because palette order is not the document's. */
  const inlayFor = (
    built: NonNullable<Awaited<ReturnType<typeof buildAssemblyGeometry>>>,
    hex: string,
  ): Float32Array => {
    const ci = built.palette.findIndex((p) => p.hex === hex);
    const soup = built.partOutputs[0].inlaySoups[ci];
    expect(soup).toBeDefined();
    return soup;
  };

  /** The build shared by most of these: red flush against the face wall, blue in the middle. */
  const edgeInput = (over: BaseOverrides = {}) =>
    baseInput({
      parsed: edgeAndInteriorParsed(),
      radius: 20,
      parts: [boxPart({ edgeCutThroughDepth: 3 })],
      ...over,
    });

  it(
    'cuts an edge-touching color through and leaves an interior one recessed',
    { timeout: 30000 },
    async () => {
      // The whole feature. Without it a hubcap cut to its artwork's shape has the picture recessed
      // 1mm into a 3mm shell, so the outline it was cut to reads as base-color plastic from the
      // side — which is the one thing cutting it to shape was for.
      const built = (await buildAssemblyGeometry(edgeInput()))!;
      const red = yRange(inlayFor(built, '#ff0000'));
      const blue = yRange(inlayFor(built, '#0000ff'));
      // face is at y=10; red took the part's 3mm edge depth, blue the 2mm globalDepth
      expect(red.max).toBeCloseTo(10, 4);
      expect(red.max - red.min).toBeCloseTo(3, 4);
      expect(blue.max - blue.min).toBeCloseTo(2, 4);
      // and each landed where it was drawn: red flush with the face wall, blue an inner island
      expect(xzRange(inlayFor(built, '#ff0000')).maxX).toBeCloseTo(20, 4);
      expect(xzRange(inlayFor(built, '#0000ff')).maxX).toBeCloseTo(5, 4);
    },
  );

  it('names the through-cut colors and not the interior one', { timeout: 30000 }, async () => {
    await buildAssemblyGeometry(edgeInput());
    const note = WARNINGS.find((w) => w.message.includes("the part's outer edge"));
    expect(note).toBeDefined();
    expect(note!.level).toBe('info'); // see edgeCutThroughNotice — challenged and kept as ℹ
    expect(note!.message).toContain('"#ff0000"');
    expect(note!.message).not.toContain('#0000ff');
    expect(note!.message).toContain('3.00 mm');
  });

  it('says nothing at all when no artwork reaches the edge', { timeout: 30000 }, async () => {
    // The notice must not fire on every silhouette build regardless of where the artwork sits,
    // or it stops carrying information.
    await buildAssemblyGeometry(baseInput({ parts: [boxPart({ edgeCutThroughDepth: 3 })] }));
    expect(WARNINGS.filter((w) => w.message.includes("the part's outer edge"))).toEqual([]);
  });

  it('is inert on a part with no edge rule', { timeout: 30000 }, async () => {
    // Same artwork, plain part: the regression guard for every shipped kind. Red must go back to
    // the 2mm recess it has always been cut at.
    const built = (await buildAssemblyGeometry(edgeInput({ parts: [boxPart()] })))!;
    const red = yRange(inlayFor(built, '#ff0000'));
    expect(red.max - red.min).toBeCloseTo(2, 4);
    expect(WARNINGS.filter((w) => w.message.includes("the part's outer edge"))).toEqual([]);
  });

  it('overrides an explicit per-color depth at the edge only', { timeout: 30000 }, async () => {
    // The decision recorded in the plan: edge wins, and the notice names the color so someone who
    // set a depth deliberately can see it happened. Red is entirely at the edge here, so its 0.5mm
    // setting is fully replaced — and the thin-depth note must not also fire about a 3mm hole.
    await buildAssemblyGeometry(edgeInput({ colorSettings: { 'asm:#ff0000': { depth: 0.12 } } }));
    const note = WARNINGS.find((w) => w.message.includes("the part's outer edge"));
    expect(note!.message).toContain('"#ff0000"');
    expect(WARNINGS.filter((w) => w.message.includes('thinner than the usual'))).toEqual([]);
  });

  it(
    'still notes a thin depth for the interior half of a split color',
    { timeout: 30000 },
    async () => {
      // One color with regions on both sides of the rule. The edge slice is cut 3mm and must not
      // be described as too thin to print; the interior slice really is cut at 0.12mm and must
      // still be — this is the invariant the cutThrough gate above was written to protect,
      // re-asked for a color that is cut at two depths at once rather than one.
      const parsed = edgeAndInteriorParsed();
      parsed.shapes[1].fill = '#ff0000'; // fold the interior island into the edge color
      await buildAssemblyGeometry(
        edgeInput({ parsed, colorSettings: { 'asm:#ff0000': { depth: 0.12 } } }),
      );
      expect(WARNINGS.filter((w) => w.message.includes('thinner than the usual'))).toHaveLength(1);
      expect(WARNINGS.some((w) => w.message.includes("the part's outer edge"))).toBe(true);
    },
  );

  it('keeps both slices of a split color in one inlay', { timeout: 30000 }, async () => {
    // The two prisms land in the same colorPrisms[ci] list and get unioned, so a split color
    // still exports as one inlay solid rather than losing whichever slice was built second.
    const parsed = edgeAndInteriorParsed();
    parsed.shapes[1].fill = '#ff0000';
    const built = (await buildAssemblyGeometry(edgeInput({ parsed })))!;
    const soup = built.partOutputs[0].inlaySoups[0];
    expect(soup).toBeDefined();
    const r = yRange(soup);
    expect(r.max).toBeCloseTo(10, 4);
    expect(r.min).toBeCloseTo(7, 4); // the deeper (edge) slice sets the floor
    const xz = xzRange(soup);
    expect(xz.maxX).toBeCloseTo(20, 4); // the edge bar, flush with the face wall
    expect(xz.minX).toBeCloseTo(-5, 4); // and the interior island, still present
  });
});
