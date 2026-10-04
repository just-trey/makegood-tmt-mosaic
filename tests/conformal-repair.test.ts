import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAssemblyGeometry, type AssemblyBuildInput } from '../src/geometry/assembly';
import { ConformalZoneMapper } from '../src/geometry/conformal';
import {
  getManifold,
  manifoldIsValid,
  manifoldToMeshes,
  REPAIR_ERODE_MM,
  soupToManifold,
  type ManifoldAPI,
} from '../src/geometry/manifold';
import type { AssemblyPart, ParsedSVG, PolyFeature, SVGShape } from '../src/types';
import { WARNINGS, clearWarnings } from '../src/warnings';
import { H, R, makeCylinderChart } from './lib/cylinderChart';

// The extrude repair (REPAIR_ERODE_MM) on a conformal zone. It used to run only when a mapper
// handed back a soup that would not seal, and the conformal mapper tests its own prism before
// warping and answers null instead, so a self-touching region on the chair skipped the repair a
// flat part gets and went straight to "Couldn't cut color".

type Pt = { x: number; y: number };
const loop = (pts: number[][]): Pt[] => [...pts, pts[0]].map(([x, y]) => ({ x, y }));

/**
 * A 20mm square with a triangular hole whose tip touches the outer edge at one point: valid to
 * turf, and the pinched topology the triangulator cannot seal. Area 400 − 32 = 368mm².
 */
const PINCHED: Pt[][] = [
  loop([
    [0, 0],
    [20, 0],
    [20, 20],
    [0, 20],
  ]),
  loop([
    [0, 10],
    [8, 14],
    [8, 6],
  ]),
];
const PINCHED_AREA = 368;

const shape = (fill: string, loops: Pt[][], order: number): SVGShape => ({ fill, loops, order });

const parsed = (shapes: SVGShape[]): ParsedSVG => ({
  shapes,
  bbox: { minX: 0, minY: 0, maxX: 40, maxY: 20 },
  rawSVGCircle: null,
  userUnitMM: 1,
});

function ringArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++)
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2;
}

/** Net area of a feature: outer rings minus holes, whatever winding the caller used. */
function featureArea(f: PolyFeature): number {
  const g = f.geometry;
  const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as number[][][][];
  return polys.reduce(
    (s, [outer, ...holes]) =>
      s + Math.abs(ringArea(outer)) - holes.reduce((t, h) => t + Math.abs(ringArea(h)), 0),
    0,
  );
}

let wasm: ManifoldAPI;
let part: AssemblyPart;

beforeAll(async () => {
  wasm = await getManifold();
  // The solid cylinder whose quarter surface is the chart, as conformal.test.ts and
  // mirror-design.test.ts cut it: Manifold's runs along Z, rotated onto Y to match.
  const solid = wasm.Manifold.cylinder(H, R, R, 128).rotate([-90, 0, 0]);
  const positions = manifoldToMeshes(solid).soup;
  solid.delete();
  part = {
    id: 1,
    name: 'shell',
    roleId: 'shell',
    positions,
    zones: [{ id: 'front', name: 'Front', chart: makeCylinderChart() }],
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
afterEach(() => vi.restoreAllMocks());

const input = (svg: ParsedSVG): AssemblyBuildInput => ({
  artworks: [
    {
      parsed: svg,
      name: 'pinched',
      zoneId: 'front',
      scaleMult: 1,
      offX: 0,
      offZ: 0,
      flipX: false,
      flipY: false,
      rotationDeg: 0,
    },
  ],
  parts: [part],
  mergeGroups: [],
  colorSettings: {},
  globalDepth: 1,
  radius: 0,
  designFit: 'rect',
});

const cutWarnings = (): string[] =>
  WARNINGS.map((w) => w.message).filter((m) => m.startsWith("Couldn't cut color"));

describe('the extrude repair on a conformal zone', () => {
  it('cuts a self-touching region instead of dropping its color', async () => {
    const real = ConformalZoneMapper.prototype.buildCutter;
    const answers: boolean[] = [];
    vi.spyOn(ConformalZoneMapper.prototype, 'buildCutter').mockImplementation(function (
      this: ConformalZoneMapper,
      ...args
    ) {
      const out = real.apply(this, args);
      answers.push(out !== null);
      return out;
    });
    const build = await buildAssemblyGeometry(input(parsed([shape('#ff0000', PINCHED, 0)])));
    // The region the build hands the mapper is still pinched, or this would pass unrepaired.
    expect(answers).toEqual([false, true]);
    expect(cutWarnings()).toEqual([]);
    const inlays = Object.values(build!.partOutputs[0].inlaySoups);
    expect(inlays).toHaveLength(1);
    const inlay = soupToManifold(wasm, inlays[0]);
    try {
      expect(manifoldIsValid(inlay)).toBe(true);
      // Area times the 1mm depth, narrowed by r/R at mid-depth (R − 0.5): 361.9mm³. Measured
      // 364.4, 0.7% over. A filled-in hole is 8.7% over, and a flat prism would be 1.7%.
      const expected = PINCHED_AREA * ((R - 0.5) / R);
      expect(Math.abs(inlay.volume() - expected) / expected).toBeLessThan(0.01);
    } finally {
      inlay.delete();
    }
  }, 60000);

  // Code rules 1 and 3: a region the repair can't seal still names its color, and only its color.
  it('still warns for a color no rung can seal, and cuts the other color', async () => {
    const small = loop([
      [30, 7],
      [36, 7],
      [36, 13],
      [30, 13],
    ]);
    const real = ConformalZoneMapper.prototype.buildCutter;
    let refused = 0;
    vi.spyOn(ConformalZoneMapper.prototype, 'buildCutter').mockImplementation(function (
      this: ConformalZoneMapper,
      feat,
      depth,
      overshoot,
      opts,
    ) {
      // The pinched region is 368mm² (a little less once eroded); the other color is 36mm².
      if (featureArea(feat) > 100) {
        refused++;
        return null;
      }
      return real.call(this, feat, depth, overshoot, opts);
    });
    const build = await buildAssemblyGeometry(
      input(parsed([shape('#ff0000', PINCHED, 0), shape('#0000ff', [small], 1)])),
    );
    expect(refused).toBe(1 + REPAIR_ERODE_MM.length);
    expect(cutWarnings()).toEqual([`Couldn't cut color #ff0000 into "shell".`]);
    const cut = Object.keys(build!.partOutputs[0].inlaySoups).map(
      (ci) => build!.palette[Number(ci)].hex,
    );
    expect(cut).toEqual(['#0000ff']);
  }, 60000);
});
