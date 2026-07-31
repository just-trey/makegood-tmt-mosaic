import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

// The gizmo frame is pure math over state; the viewport only contributes the model group's
// transform — the post-rebuild grid lift plus, for a kind that authors one, its display rotation.
// Stubbed with a real (identity) Group rather than a WebGL scene, so the model→world helpers run
// their actual matrix math here instead of being faked into always agreeing.
vi.mock('../src/scene/viewport', async () => {
  const three = await import('three');
  const group = new three.Group();
  return {
    getModelGroup: () => group,
    modelToWorldPoint: (v: THREE.Vector3) => {
      group.updateMatrixWorld();
      return v.applyMatrix4(group.matrixWorld);
    },
    modelToWorldDir: (v: THREE.Vector3) => v.applyQuaternion(group.quaternion),
    syncToModelGroup: vi.fn(),
    requestFrame: vi.fn(),
  };
});

import { computeFaceFrame } from '../src/scene/faceFrame';
import { loadArtworkSource, setArtworkZone } from '../src/state/artwork';
import { state } from '../src/state/store';
import type { ConformalChart } from '../src/geometry/conformal';
import type { AssemblyPart, ParsedSVG } from '../src/types';

/**
 * A flat 100x100mm chart lying in the plane through `origin` spanned by `uDir` x `vDir`, so its
 * face normal is uDir x vDir exactly. Two of these on different parts is all it takes to tell
 * which zone the gizmo resolved to.
 */
function planeChart(
  origin: [number, number, number],
  uDir: [number, number, number],
  vDir: [number, number, number],
): ConformalChart {
  const S = 100;
  const positions3: number[] = [];
  const uv: number[] = [];
  for (const [su, sv] of [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]) {
    positions3.push(
      origin[0] + uDir[0] * su * S + vDir[0] * sv * S,
      origin[1] + uDir[1] * su * S + vDir[1] * sv * S,
      origin[2] + uDir[2] * su * S + vDir[2] * sv * S,
    );
    uv.push(su * S, sv * S);
  }
  return {
    positions3: Float32Array.from(positions3),
    uv: Float32Array.from(uv),
    triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    normalSign: 1,
    boundary: [
      [0, 0],
      [S, 0],
      [S, S],
      [0, S],
    ],
  };
}

function zonedPart(id: number, zoneId: string, chart: ConformalChart): AssemblyPart {
  return {
    id,
    name: `part-${id}`,
    roleId: 'r',
    positions: new Float32Array(chart.positions3),
    patches: null,
    patchIdx: 0,
    boundaryLoop: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
    zones: [{ id: zoneId, name: zoneId, chart }],
    topZ: 0,
    baseDepth: 1,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
  } as unknown as AssemblyPart;
}

const parsed = (): ParsedSVG =>
  ({
    shapes: [],
    bbox: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
    rawSVGCircle: null,
    userUnitMM: 1,
  }) as unknown as ParsedSVG;

// chart A faces +X (the chair's left panel); chart B faces +Y (its seat)
const CHART_A = planeChart([170, 0, -600], [0, 0, 1], [0, 1, 0]);
const CHART_B = planeChart([-50, 233, -450], [1, 0, 0], [0, 0, 1]);

beforeEach(() => {
  state.shapeKind = 'assembly';
  state.assembly.kindId = 'chair-body';
  state.sources = [];
  state.artworks = [];
  state.activeArtworkId = null;
  state.offsetX = 0;
  state.offsetY = 0;
  state.scalePct = 100;
  state.rotationDeg = 0;
  state.flipX = false;
  state.flipY = false;
  state.assembly.parts = [zonedPart(1, 'left', CHART_A), zonedPart(2, 'seat', CHART_B)];
});

describe('assembly gizmo frame follows the active artwork instance', () => {
  it('sits on the zone the active instance is bound to, not the first zoned part', () => {
    const a = loadArtworkSource(parsed(), 'a.svg');
    setArtworkZone(a.id, 'seat');

    const frame = computeFaceFrame();

    expect(frame).not.toBeNull();
    // seat chart's normal is uDir x vDir = +X x +Z = -Y... the mapper orients it outward, so just
    // assert it matches the seat chart and NOT the left panel's ±X
    expect(Math.abs(frame!.normal.x)).toBeLessThan(1e-6);
    expect(Math.abs(frame!.normal.y)).toBeCloseTo(1, 6);
  });

  it('switching the active instance moves the frame to that instance’s zone', () => {
    const a = loadArtworkSource(parsed(), 'a.svg');
    setArtworkZone(a.id, 'seat');
    const b = loadArtworkSource(parsed(), 'b.svg');
    setArtworkZone(b.id, 'left');

    // b is active after loading
    const onLeft = computeFaceFrame()!;
    expect(Math.abs(onLeft.normal.x)).toBeCloseTo(1, 6);

    state.activeArtworkId = a.id;
    const onSeat = computeFaceFrame()!;
    expect(Math.abs(onSeat.normal.y)).toBeCloseTo(1, 6);
    expect(onSeat.origin.distanceTo(onLeft.origin)).toBeGreaterThan(1);
  });

  it('falls back to the first zoned part when the instance has no zone binding', () => {
    loadArtworkSource(parsed(), 'a.svg'); // zone: null

    const frame = computeFaceFrame()!;

    expect(Math.abs(frame.normal.x)).toBeCloseTo(1, 6); // part 1 / zone "left"
  });
});
