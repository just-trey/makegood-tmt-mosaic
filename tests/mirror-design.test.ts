import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConformalZoneMapper } from '../src/geometry/conformal';
import {
  FlatZoneMapper,
  mirroredBuildInput,
  type DesignPlacement,
  type KeepSide,
} from '../src/geometry/zones';
import {
  buildAssemblyGeometry,
  clipToKeptSide,
  mirrorClipFailedWarning,
  mirrorHalfNotice,
  type ArtworkBuildInput,
  type AssemblyBuildInput,
} from '../src/geometry/assembly';
import * as turf from '@turf/turf';
import { getManifold, manifoldToMeshes, type ManifoldAPI } from '../src/geometry/manifold';
import type { AssemblyPart, ParsedSVG, PolyFeature } from '../src/types';
import { WARNINGS, clearWarnings } from '../src/warnings';
import { ARC_U, H, R, makeCylinderChart, makeMirroredCylinderChart } from './lib/cylinderChart';

/**
 * Mirror-design: a design bound to one zone of a mirrored pair is also cut on its twin,
 * reflected; on a self-mirrored zone it is reflected across the zone's own centre line, each copy
 * keeping its own half. The geometry sees the reflection as an ordinary second artwork, so what
 * these check is that `mirroredBuildInput`'s three field changes really are the reflection, and
 * that the half clip reaches both readers of a placed region.
 */

/** DesignPlacement the way buildAssemblyGeometry derives it, at 1mm per unit about SVG (5, 5). */
const toPlacement = (a: ArtworkBuildInput): DesignPlacement => ({
  svgC: { cx: 5, cy: 5, r: 5 },
  mmPerUnit: 1,
  xFlip: a.flipX ? -1 : 1,
  zMul: a.flipY ? 1 : -1,
  offX: a.offX,
  offZ: a.offZ,
  rotationDeg: a.rotationDeg,
});

const input = (over: Partial<ArtworkBuildInput> = {}): ArtworkBuildInput => ({
  parsed: {} as ParsedSVG,
  zoneId: 'right',
  scaleMult: 1,
  offX: 7.5,
  offZ: -3,
  flipX: false,
  flipY: false,
  rotationDeg: 37,
  ...over,
});

const SVG_POINTS = [
  [5, 5],
  [12, 5],
  [5, 1],
  [-2, 9.5],
  [8.25, -3],
];

describe('mirroredBuildInput reflects a placement across a twin pair', () => {
  const twinA = new ConformalZoneMapper(null, makeCylinderChart(), 'right');
  const twinB = new ConformalZoneMapper(null, makeMirroredCylinderChart(), 'left');

  it.each([
    ['rotated, unflipped', input()],
    ['rotated, flipped', input({ flipX: true })],
    ['rotated, flipped both ways, offset left', input({ flipX: true, flipY: true, offX: -4 })],
    ['unrotated', input({ rotationDeg: 0 })],
  ])('%s: every placed point lands at the reflection on the twin', (_name, a) => {
    const b = mirroredBuildInput(a, 'left');
    expect(b.zoneId).toBe('left');
    const placeA = twinA.placer(toPlacement(a));
    const placeB = twinB.placer(toPlacement(b));
    for (const pt of SVG_POINTS) {
      const [uA, vA] = placeA(pt);
      const [uB, vB] = placeB(pt);
      // both charts span u 0..ARC_U, so the reflection about the centre is u' = ARC_U − u
      expect(uB).toBeCloseTo(ARC_U - uA, 6);
      expect(vB).toBeCloseTo(vA, 6);
      // and in 3D the twin's point is the mirror image across x = 0 of the primary's, to the
      // float32 the chart positions are stored at
      const pA = twinA.frameAt(uA - ARC_U / 2, vA - H / 2).origin;
      const pB = twinB.frameAt(uB - ARC_U / 2, vB - H / 2).origin;
      expect(pB.x).toBeCloseTo(-pA.x, 5);
      expect(pB.y).toBeCloseTo(pA.y, 5);
      expect(pB.z).toBeCloseTo(pA.z, 5);
    }
  });

  it('reflects about a self-mirrored zone’s own centre line the same way', () => {
    const a = input({ zoneId: 'front', keepSide: 'right' });
    const b = mirroredBuildInput(a, 'front');
    expect(b.zoneId).toBe('front');
    expect(b.keepSide).toBe('left');
    expect(b.reflected).toBe(true);
    const placeA = twinA.placer(toPlacement(a));
    const placeB = twinA.placer(toPlacement(b));
    for (const pt of SVG_POINTS) {
      const [uA, vA] = placeA(pt);
      const [uB, vB] = placeB(pt);
      expect(uB).toBeCloseTo(ARC_U - uA, 6);
      expect(vB).toBeCloseTo(vA, 6);
    }
  });

  it('is an involution on the placement fields', () => {
    const a = input();
    const back = mirroredBuildInput(mirroredBuildInput(a, 'left'), 'right');
    expect(back).toEqual({ ...a, reflected: true });
  });
});

describe('sideClip', () => {
  it('is a half-plane split at the chart centre, covering the whole zone', () => {
    const mapper = new ConformalZoneMapper(null, makeCylinderChart(), 'front');
    const right = mapper.sideClip('right')!;
    const left = mapper.sideClip('left')!;
    const xs = (f: PolyFeature): number[] =>
      (f.geometry.coordinates as number[][][])[0].map((p) => p[0]);
    // the chart's UVs are float32, so its centre is float32 ARC_U halved
    const centre = Math.fround(ARC_U) / 2;
    expect(Math.min(...xs(right))).toBeCloseTo(centre, 9);
    expect(Math.max(...xs(right))).toBeGreaterThanOrEqual(ARC_U);
    expect(Math.max(...xs(left))).toBeCloseTo(centre, 9);
    expect(Math.min(...xs(left))).toBeLessThanOrEqual(0);
  });

  it('a region with nothing in it once cleaned is empty, not removed and not a failure', () => {
    // Three collinear points crossing the line enclose no area: the clipper is never asked, so
    // the cutter neither warns of a failed crop nor says a half was kept.
    const mapper = new ConformalZoneMapper(null, makeCylinderChart(), 'front');
    const half = {
      side: 'right' as const,
      centreU: ARC_U / 2,
      clip: mapper.sideClip('right')!,
      zoneName: 'Front',
    };
    const sliver = turf.polygon([
      [
        [ARC_U / 2 - 5, 10],
        [ARC_U / 2, 10],
        [ARC_U / 2 + 5, 10],
        [ARC_U / 2 - 5, 10],
      ],
    ]) as PolyFeature;
    expect(clipToKeptSide(sliver, half)).toEqual({ feat: null, removed: false, failed: false });
  });

  it('is null on a flat face, which has no baked centre to mirror about', () => {
    const part = { positions: null, boundaryLoops: null, isDuplicateOf: null } as AssemblyPart;
    expect(new FlatZoneMapper(part, [part], true).sideClip()).toBeNull();
  });
});

/** A filled square, `s` mm on a side, in true mm; its own centre is the anchor. */
function squareParsed(s: number): ParsedSVG {
  return {
    shapes: [
      {
        fill: '#ff0000',
        loops: [
          [
            { x: 0, y: 0 },
            { x: s, y: 0 },
            { x: s, y: s },
            { x: 0, y: s },
            { x: 0, y: 0 },
          ],
        ],
        order: 0,
      },
    ],
    bbox: { minX: 0, minY: 0, maxX: s, maxY: s },
    rawSVGCircle: null,
    userUnitMM: 1,
  };
}

describe('the half clip on a self-mirrored zone', () => {
  let wasm: ManifoldAPI;
  let part: AssemblyPart;
  const NAME = 'logo';
  const NOTICE = mirrorHalfNotice(NAME, 'Front', 'right');

  beforeAll(async () => {
    wasm = await getManifold();
    // A solid cylinder whose quarter surface is the chart (conformal.test.ts cuts the same one):
    // Manifold's runs along Z, rotated onto Y to match the chart.
    const solid = wasm.Manifold.cylinder(H, R, R, 128).rotate([-90, 0, 0]);
    const positions = manifoldToMeshes(solid).soup;
    solid.delete();
    part = {
      id: 1,
      name: 'shell',
      roleId: 'shell',
      positions,
      zones: [{ id: 'front', name: 'Front', mirror: { self: true }, chart: makeCylinderChart() }],
      patches: null,
      patchIdx: 0,
      boundaryLoops: [
        [
          [-1, 0, -1],
          [1, 0, -1],
          [1, 0, 1],
        ],
      ],
      patchNormal: [0, 1, 0],
      topZ: 0,
      baseDepth: 0,
      isDuplicateOf: null,
      pivotX: 0,
      pivotZ: 0,
      angleDeg: 0,
      loaded: true,
      cutThrough: false,
    };
  }, 30000);

  beforeEach(() => clearWarnings());

  /** The design and its reflection, exactly as rebuild.ts expands a mirrored instance. */
  const mirrored = (offX: number, keepSide: KeepSide = 'right'): AssemblyBuildInput => {
    const own: ArtworkBuildInput = {
      parsed: squareParsed(20),
      name: NAME,
      zoneId: 'front',
      scaleMult: 1,
      offX,
      offZ: 0,
      flipX: false,
      flipY: false,
      rotationDeg: 0,
      keepSide,
    };
    return {
      artworks: [own, mirroredBuildInput(own, 'front')],
      parts: [part],
      mergeGroups: [],
      colorSettings: {},
      globalDepth: 1,
      radius: 0,
      designFit: 'rect',
    };
  };

  /** Arc-length range of the inlay's vertices around the axis: where on the chart it was cut. */
  const inlayURange = (soup: Float32Array): { min: number; max: number } => {
    let min = Infinity,
      max = -Infinity;
    for (let i = 0; i < soup.length; i += 3) {
      const u = R * Math.atan2(soup[i], soup[i + 2]);
      if (u < min) min = u;
      if (u > max) max = u;
    }
    return { min, max };
  };

  it('cuts a design crossing the centre as two mirrored halves, and says so once', async () => {
    const build = await buildAssemblyGeometry(mirrored(3));
    expect(build).not.toBeNull();
    const inlays = Object.values(build!.partOutputs[0].inlaySoups);
    expect(inlays).toHaveLength(1);
    // primary keeps u ∈ [c, c+13] of its [c−7, c+13]; the reflection keeps [c−13, c]: together a
    // band symmetric about the centre, 13mm each way, with the crossing 7mm cut off both
    const { min, max } = inlayURange(inlays[0]);
    const c = ARC_U / 2;
    expect(max - c).toBeCloseTo(13, 0);
    expect(c - min).toBeCloseTo(13, 0);
    // once, and about the primary's side: the reflection also loses its crossing part, and a
    // second notice reading "its left half is kept" would contradict the first
    expect(WARNINGS.filter((w) => w.message === NOTICE)).toHaveLength(1);
    expect(WARNINGS.filter((w) => /crosses the centre line/.test(w.message))).toHaveLength(1);
    expect(WARNINGS.some((w) => /overlap|Two placements/.test(w.message))).toBe(false);
  }, 60000);

  it('says the failure out loud when the zone has no centre line to clip at', async () => {
    // A flat face offers no sideClip. keepSide reaching one is a degenerate input, but the outcome
    // is a doubled cut, so it is named rather than left to the overlap warning.
    const flat: AssemblyPart = {
      ...part,
      id: 2,
      name: 'plate',
      zones: undefined,
      boundaryLoops: [
        [
          [-40, 60, -40],
          [40, 60, -40],
          [40, 60, 40],
          [-40, 60, 40],
        ],
      ],
      patchNormal: [0, 1, 0],
      topZ: 60,
    };
    const both = mirrored(3);
    both.parts = [flat];
    both.artworks = both.artworks.map((a) => ({ ...a, zoneId: null }));
    await buildAssemblyGeometry(both);
    expect(
      WARNINGS.filter((w) => w.message === mirrorClipFailedWarning(NAME, 'plate')),
    ).toHaveLength(1);
    expect(WARNINGS.some((w) => /crosses the centre line/.test(w.message))).toBe(false);
  }, 60000);

  it('the half kept is the one the design sits on, whichever the tie rule names', async () => {
    // Drawn left of the centre with the tie rule saying right: the design still prints where it
    // was drawn and mirrors to the right, rather than both halves clipping to nothing.
    const build = await buildAssemblyGeometry(mirrored(-3, 'right'));
    const inlays = Object.values(build!.partOutputs[0].inlaySoups);
    expect(inlays).toHaveLength(1);
    const { min, max } = inlayURange(inlays[0]);
    const c = ARC_U / 2;
    expect(max - c).toBeCloseTo(13, 0);
    expect(c - min).toBeCloseTo(13, 0);
    expect(
      WARNINGS.filter((w) => w.message === mirrorHalfNotice(NAME, 'Front', 'left')),
    ).toHaveLength(1);
  }, 60000);

  it('says nothing for a design that does not cross', async () => {
    const build = await buildAssemblyGeometry(mirrored(12));
    const inlays = Object.values(build!.partOutputs[0].inlaySoups);
    expect(inlays).toHaveLength(1);
    // primary at [c+2, c+22] whole, its reflection at [c−22, c−2] whole
    const { min, max } = inlayURange(inlays[0]);
    const c = ARC_U / 2;
    expect(max - c).toBeCloseTo(22, 0);
    expect(c - min).toBeCloseTo(22, 0);
    expect(WARNINGS.some((w) => /crosses the centre line/.test(w.message))).toBe(false);
    expect(WARNINGS.some((w) => /overlap|Two placements/.test(w.message))).toBe(false);
  }, 60000);

  it('without keepSide the same two inputs overlap, which is what the clip exists to stop', async () => {
    const both = mirrored(3);
    both.artworks = both.artworks.map((a) => ({ ...a, keepSide: undefined }));
    await buildAssemblyGeometry(both);
    expect(WARNINGS.some((w) => /^Two placements of "logo" overlap/.test(w.message))).toBe(true);
    expect(WARNINGS.some((w) => /crosses the centre line/.test(w.message))).toBe(false);
  }, 60000);

  it('a pair sharing mirrorPair is never compared, so a mirrored Fill is not told to switch', async () => {
    const both = mirrored(3);
    both.artworks = both.artworks.map((a) => ({
      ...a,
      keepSide: undefined,
      mode: 'fill' as const,
      mirrorPair: 'a1',
    }));
    await buildAssemblyGeometry(both);
    expect(WARNINGS.some((w) => /both set to Fill|overlap/.test(w.message))).toBe(false);
  }, 60000);
});
