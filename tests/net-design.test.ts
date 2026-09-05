import { describe, expect, it } from 'vitest';
import { ConformalZoneMapper, type ConformalChart } from '../src/geometry/conformal';
import {
  netGizmoMapper,
  netOffsetToZone,
  netToZoneBuildInput,
  type DesignPlacement,
} from '../src/geometry/zones';
import type { ArtworkBuildInput } from '../src/geometry/assembly';
import type { ParsedSVG } from '../src/types';
import { ARC_U, H, makeCylinderChart } from './lib/cylinderChart';

/**
 * A design bound to the whole part is one placement per zone, each moved onto that zone's sheet.
 * The proof here is geometric, not algebraic: two charts of the SAME quarter-cylinder differing
 * only by a rigid move of their UV stand in for two sheets of a net, so a whole-part placement has
 * to reach the same point of that surface through both. Any error in `netToZoneBuildInput` moves
 * one of them off the other.
 */

/** The net's own space is chart A's UV, so A sits at the identity and B carries the whole move. */
const NET_BOUNDS = { minU: 0, minV: 0, maxU: ARC_U, maxV: H };
const netCentre: [number, number] = [ARC_U / 2, H / 2];

const rot = (deg: number, p: readonly [number, number]): [number, number] => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r),
    s = Math.sin(r);
  return [c * p[0] - s * p[1], s * p[0] + c * p[1]];
};

/**
 * The cylinder chart with its UV rigidly moved by `R(phi)·uv + w` — same surface, same triangles,
 * a differently laid-out sheet. Its net transform is therefore the inverse of that move.
 */
function movedUVChart(phiDeg: number, w: readonly [number, number]): ConformalChart {
  const c = makeCylinderChart();
  const uv = Float32Array.from(c.uv);
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  for (let i = 0; i < uv.length; i += 2) {
    const [u, v] = rot(phiDeg, [uv[i], uv[i + 1]]);
    uv[i] = u + w[0];
    uv[i + 1] = v + w[1];
    minU = Math.min(minU, uv[i]);
    maxU = Math.max(maxU, uv[i]);
    minV = Math.min(minV, uv[i + 1]);
    maxV = Math.max(maxV, uv[i + 1]);
  }
  const boundary = c.boundary.map((p) => {
    const [u, v] = rot(phiDeg, [p[0], p[1]]);
    return [u + w[0], v + w[1]];
  });
  return { ...c, uv, boundary, zoneBounds: { minU, minV, maxU, maxV } };
}

/** `R(-phi)·(uv_B - w)` takes chart B's UV back to the net, in the sidecar's own field names. */
function inversePlacement(
  phiDeg: number,
  w: readonly [number, number],
): { rotationDeg: number; offsetU: number; offsetV: number } {
  const t = rot(-phiDeg, [-w[0], -w[1]]);
  return { rotationDeg: -phiDeg, offsetU: t[0], offsetV: t[1] };
}

const PHI = 23;
const W: [number, number] = [140, -75];
const chartA: ConformalChart = { ...makeCylinderChart(), zoneBounds: NET_BOUNDS };
const chartB = movedUVChart(PHI, W);
const placeA = { rotationDeg: 0, offsetU: 0, offsetV: 0 };
const placeB = inversePlacement(PHI, W);
const centreA: [number, number] = netCentre;
const centreB: [number, number] = [
  (chartB.zoneBounds!.minU + chartB.zoneBounds!.maxU) / 2,
  (chartB.zoneBounds!.minV + chartB.zoneBounds!.maxV) / 2,
];

const mapperA = new ConformalZoneMapper(null, chartA, 'sheet-a');
const mapperB = new ConformalZoneMapper(null, chartB, 'sheet-b');

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
  zoneId: '*whole',
  scaleMult: 1,
  offX: 6,
  offZ: -4,
  flipX: false,
  flipY: false,
  rotationDeg: 31,
  ...over,
});

const SVG_POINTS = [
  [5, 5],
  [11, 5],
  [5, 2],
  [1, 8.5],
  [7.25, -1],
];

/** Where a whole-part placement puts an SVG point, in net mm — the placer, read in net space. */
function netPoint(a: ArtworkBuildInput, pt: number[]): [number, number] {
  const p = toPlacement(a);
  const x = (pt[0] - p.svgC.cx) * p.mmPerUnit * p.xFlip;
  const y = (pt[1] - p.svgC.cy) * p.mmPerUnit * p.zMul;
  const r = rot(p.rotationDeg, [x, y]);
  return [r[0] + a.offX + netCentre[0], r[1] + a.offZ + netCentre[1]];
}

/** Chart B's UV read back in net mm, using the sidecar's transform in the forward direction. */
const bToNet = (p: number[]): [number, number] => {
  const r = rot(placeB.rotationDeg, [p[0], p[1]]);
  return [r[0] + placeB.offsetU, r[1] + placeB.offsetV];
};

describe('netToZoneBuildInput places one design across the sheets of a net', () => {
  it.each([
    ['rotated, unflipped', input()],
    ['rotated, flipped', input({ flipX: true })],
    ['flipped both ways, offset left', input({ flipX: true, flipY: true, offX: -9 })],
    ['unrotated', input({ rotationDeg: 0 })],
    ['offset onto the far edge', input({ offX: 14, offZ: 11, rotationDeg: -47 })],
  ])('%s: both sheets place every point at the same place on the surface', (_name, a) => {
    const bA = netToZoneBuildInput(a, 'sheet-a', placeA, netCentre, centreA);
    const bB = netToZoneBuildInput(a, 'sheet-b', placeB, netCentre, centreB);
    expect(bA.zoneId).toBe('sheet-a');
    expect(bB.zoneId).toBe('sheet-b');
    // The net transform carries no reflection, so nothing about handedness moves.
    expect(bB.flipX).toBe(a.flipX);
    expect(bB.flipY).toBe(a.flipY);
    expect(bB.rotationDeg).toBeCloseTo(a.rotationDeg - placeB.rotationDeg, 9);

    const pA = mapperA.placer(toPlacement(bA));
    const pB = mapperB.placer(toPlacement(bB));
    for (const pt of SVG_POINTS) {
      const uvA = pA(pt);
      const uvB = pB(pt);
      const want = netPoint(a, pt);
      // sheet A is the net's own space, so its placer already answers in net mm
      expect(uvA[0]).toBeCloseTo(want[0], 6);
      expect(uvA[1]).toBeCloseTo(want[1], 6);
      // sheet B answers in its own UV; pushed back through its net transform it is the same point
      const [nu, nv] = bToNet(uvB);
      expect(nu).toBeCloseTo(want[0], 6);
      expect(nv).toBeCloseTo(want[1], 6);
      // and the two land on the same place of the shared surface, which is the whole claim
      const posA = mapperA.frameAt(uvA[0] - centreA[0], uvA[1] - centreA[1]).origin;
      const posB = mapperB.frameAt(uvB[0] - centreB[0], uvB[1] - centreB[1]).origin;
      expect(posB.x).toBeCloseTo(posA.x, 4);
      expect(posB.y).toBeCloseTo(posA.y, 4);
      expect(posB.z).toBeCloseTo(posA.z, 4);
    }
  });

  it('is the identity on a sheet the net leaves where it found it', () => {
    const a = input();
    expect(netToZoneBuildInput(a, 'sheet-a', placeA, netCentre, netCentre)).toEqual({
      ...a,
      zoneId: 'sheet-a',
    });
  });

  it('takes the net centre to each sheet’s own centre', () => {
    for (const [place, centre] of [
      [placeA, centreA],
      [placeB, centreB],
    ] as const) {
      const [u, v] = netOffsetToZone([0, 0], place, netCentre, centre);
      // an offset of zero is the design on the anchor, which every sheet answers as its own zero
      const back = rot(place.rotationDeg, [u + centre[0], v + centre[1]]);
      expect(back[0] + place.offsetU).toBeCloseTo(netCentre[0], 6);
      expect(back[1] + place.offsetV).toBeCloseTo(netCentre[1], 6);
    }
  });
});

describe('netGizmoMapper reads a sheet in net coordinates', () => {
  const gA = netGizmoMapper(mapperA, placeA, netCentre, centreA);
  const gB = netGizmoMapper(mapperB, placeB, netCentre, centreB);

  it('places an SVG point at the same net mm through either sheet', () => {
    const a = input({ rotationDeg: 19, offX: -3, offZ: 5 });
    const pA = gA.placer(toPlacement(a));
    const pB = gB.placer(toPlacement(a));
    for (const pt of SVG_POINTS) {
      const want = netPoint(a, pt);
      for (const got of [pA(pt), pB(pt)]) {
        expect(got[0]).toBeCloseTo(want[0], 6);
        expect(got[1]).toBeCloseTo(want[1], 6);
      }
    }
  });

  it('answers a net offset with the same point on the surface through either sheet', () => {
    for (const [du, dv] of [
      [0, 0],
      [12, -8],
      [-20, 15],
    ]) {
      const fA = gA.frameAt(du, dv);
      const fB = gB.frameAt(du, dv);
      expect(fA.offChartMM).toBe(0);
      expect(fB.offChartMM).toBe(0);
      expect(fB.origin.x).toBeCloseTo(fA.origin.x, 4);
      expect(fB.origin.y).toBeCloseTo(fA.origin.y, 4);
      expect(fB.origin.z).toBeCloseTo(fA.origin.z, 4);
      // the axes a drag runs along are the net's, so the two sheets agree on those too
      expect(fB.uAxis.dot(fA.uAxis)).toBeCloseTo(1, 4);
      expect(fB.vAxis.dot(fA.vAxis)).toBeCloseTo(1, 4);
    }
  });

  it('turns a sheet’s own axes by the net rotation rather than passing them through', () => {
    const raw = mapperB.frameAt(0, 0);
    const net = gB.frameAt(0, 0);
    // sheet B is laid at -PHI on the net, so its own +u is PHI off the net's +u
    expect(net.uAxis.angleTo(raw.uAxis)).toBeCloseTo((Math.abs(PHI) * Math.PI) / 180, 3);
  });
});
