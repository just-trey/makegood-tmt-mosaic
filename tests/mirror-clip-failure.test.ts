import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssemblyPart, ParsedSVG } from '../src/types';
import { WARNINGS, clearWarnings } from '../src/warnings';
import { ARC_U, H, R, makeCylinderChart } from './lib/cylinderChart';

// Break the polygon intersect for the HALF CLIP only. Its clip rectangle is the zone bbox padded
// outward by the zone's own extent (ConformalZoneMapper.sideClip), so it is the one intersect
// whose second operand reaches negative UV; the boundary clip's operand is the chart outline,
// which starts at (0, 0). Throwing on every retry precision makes boolOpWithRetry give up, which
// is the `failed` arm of clipToKeptSide.
vi.mock('@turf/turf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@turf/turf')>();
  return {
    ...actual,
    intersect: (
      a: Parameters<typeof actual.intersect>[0],
      b: Parameters<typeof actual.intersect>[1],
    ) => {
      const ring = (b as { geometry: { coordinates: number[][][] } }).geometry.coordinates[0];
      if (ring.some((p) => p[0] < 0 || p[1] < 0)) throw new Error('forced half-clip failure');
      return actual.intersect(a, b);
    },
  };
});

const { buildAssemblyGeometry, mirrorClipFailedWarning } = await import('../src/geometry/assembly');
const { mirroredBuildInput } = await import('../src/geometry/zones');
const { getManifold, manifoldToMeshes } = await import('../src/geometry/manifold');

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

describe('the half clip when its boolean fails', () => {
  let part: AssemblyPart;

  beforeAll(async () => {
    const wasm = await getManifold();
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

  it('names the design and zone once, says nothing about a kept half, and still cuts both in full', async () => {
    const own = {
      parsed: squareParsed(20),
      name: 'logo',
      zoneId: 'front',
      scaleMult: 1,
      offX: 3,
      offZ: 0,
      flipX: false,
      flipY: false,
      rotationDeg: 0,
      keepSide: 'right' as const,
    };
    const build = await buildAssemblyGeometry({
      artworks: [own, mirroredBuildInput(own, 'front')],
      parts: [part],
      mergeGroups: [],
      colorSettings: {},
      globalDepth: 1,
      radius: 0,
      designFit: 'rect',
    });
    expect(build).not.toBeNull();

    const failed = WARNINGS.filter((w) => w.message === mirrorClipFailedWarning('logo', 'Front'));
    expect(failed).toHaveLength(1);
    expect(WARNINGS.some((w) => /crosses the centre line/.test(w.message))).toBe(false);
    // the generic design-face message must not stand in for the named one
    expect(WARNINGS.some((w) => /Region left unclipped/.test(w.message))).toBe(false);

    // Both inputs cut whole: the primary's [c−7, c+13] and the reflection's [c−13, c+7] together
    // still reach 13mm each side of the centre, and neither half was dropped.
    const inlays = Object.values(build!.partOutputs[0].inlaySoups);
    expect(inlays).toHaveLength(1);
    let min = Infinity,
      max = -Infinity;
    for (let i = 0; i < inlays[0].length; i += 3) {
      const u = R * Math.atan2(inlays[0][i], inlays[0][i + 2]);
      if (u < min) min = u;
      if (u > max) max = u;
    }
    expect(max - ARC_U / 2).toBeCloseTo(13, 0);
    expect(ARC_U / 2 - min).toBeCloseTo(13, 0);
  }, 60000);
});
