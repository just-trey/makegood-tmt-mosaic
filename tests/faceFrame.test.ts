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
    modelWorldMatrix: () => {
      group.updateMatrixWorld();
      return group.matrixWorld;
    },
    modelToWorldDir: (v: THREE.Vector3) => v.applyQuaternion(group.quaternion),
    syncToModelGroup: vi.fn(),
    requestFrame: vi.fn(),
  };
});

import { computeFaceFrame } from '../src/scene/faceFrame';
import { designMmPerUnit, memoLargestDesignFace } from '../src/geometry/assembly';
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
    // faceXZBBox reads x/z of a 3D loop — a 200x200 design face, the size reference the build
    // auto-fits a viewBox to when the SVG declares no absolute mm size
    boundaryLoops: [
      [
        [0, 0, 0],
        [200, 0, 0],
        [200, 0, 200],
        [0, 0, 200],
      ],
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

// Placement anchors a rect design on its document canvas, so a design drawn away from the middle
// of its sheet is cut away from the middle of the zone. The frame has to track that: designGizmo's
// move hit-test accepts a click at |u| <= halfW, |v| <= halfH from `origin`, so a frame left behind
// on the anchor selects bare surface and drags artwork the user never grabbed.
describe('assembly gizmo frame encloses the artwork the cut places', () => {
  // CHART_A is S(u,v) = [170, v, -600 + u] over UV 0..100, so its UV center (50,50) — where an
  // anchor-centered frame would sit — is world [170, 50, -550].
  const onSheet = (bbox: ParsedSVG['bbox']): ParsedSVG =>
    ({
      shapes: [],
      bbox,
      rawSVGCircle: null,
      userUnitMM: 1,
      canvas: { w: 100, h: 100 },
    }) as unknown as ParsedSVG;

  const frameFor = (bbox: ParsedSVG['bbox']): NonNullable<ReturnType<typeof computeFaceFrame>> => {
    const a = loadArtworkSource(onSheet(bbox), 'sheet.svg');
    setArtworkZone(a.id, 'left');
    return computeFaceFrame()!;
  };

  it('stays on the anchor for a design that fills its sheet', () => {
    const frame = frameFor({ minX: 0, minY: 0, maxX: 100, maxY: 100 });

    expect(frame.origin.y).toBeCloseTo(50, 6);
    expect(frame.origin.z).toBeCloseTo(-550, 6);
    expect(frame.halfW).toBeCloseTo(50, 6);
    expect(frame.halfH).toBeCloseTo(50, 6);
  });

  it('follows a design drawn in one corner of its sheet', () => {
    // 20x20 of content in the sheet's top-left. SVG y runs opposite v, so the content center at
    // SVG (10,10) is UV (10, 90) — world [170, 90, -590], two-fifths of the zone away from the
    // anchor in each axis.
    const frame = frameFor({ minX: 0, minY: 0, maxX: 20, maxY: 20 });

    expect(frame.origin.x).toBeCloseTo(170, 6);
    expect(frame.origin.y).toBeCloseTo(90, 6);
    expect(frame.origin.z).toBeCloseTo(-590, 6);
    expect(frame.halfW).toBeCloseTo(10, 6);
    expect(frame.halfH).toBeCloseTo(10, 6);
  });
});

/**
 * The gizmo must resolve the design's mm-per-unit through the build's own resolver rather than
 * restating it. This is not an edge case: every artwork the app ships a stub for declares
 * `width="100%"`, so `userUnitMM` is null and the build's auto-fit-viewBox-to-design-face branch is
 * the normal path. The gizmo used to assume 1 unit = 1 mm there and drew a frame several times the
 * size of the cut — and, because the same number scales the content-vs-anchor displacement, one
 * that sat well away from the artwork it was meant to enclose.
 */
describe('assembly gizmo frame is sized by the build’s scale resolver', () => {
  // width="100%" + a viewBox: no declared mm size, but a viewBox to fit to the 200x200 design face
  const noDeclaredSize = (): ParsedSVG =>
    ({
      shapes: [],
      bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      rawSVGCircle: null,
      userUnitMM: null,
      viewBox: { w: 100, h: 100 },
      canvas: { w: 100, h: 100 },
    }) as unknown as ParsedSVG;

  it('auto-fits the viewBox to the design face instead of assuming 1 unit = 1 mm', () => {
    const parsedSVG = noDeclaredSize();
    const a = loadArtworkSource(parsedSVG, 'no-size.svg');
    setArtworkZone(a.id, 'left');

    const face = memoLargestDesignFace(state.assembly.parts)();
    expect(face).toEqual({ w: 200, h: 200 });
    const mmPerUnit = designMmPerUnit(parsedSVG, 1, 50, {
      isRect: true,
      radius: 138,
      designFace: () => face,
    });
    expect(mmPerUnit).toBeCloseTo(2, 6); // 200mm face / 100 viewBox units

    const frame = computeFaceFrame()!;
    // 100 content units at 2 mm/unit = 200mm across, so half is 100
    expect(frame.halfW).toBeCloseTo(100, 6);
    expect(frame.halfH).toBeCloseTo(100, 6);
    // the pre-fix value, spelled out so a regression to `userUnitMM ?? 1` reads as one
    expect(frame.halfW).not.toBeCloseTo(50, 6);
  });

  it('still honors a declared mm size when the file has one', () => {
    const a = loadArtworkSource(
      {
        ...noDeclaredSize(),
        userUnitMM: 0.5,
      } as unknown as ParsedSVG,
      'sized.svg',
    );
    setArtworkZone(a.id, 'left');

    expect(computeFaceFrame()!.halfW).toBeCloseTo(25, 6); // 100 units * 0.5 / 2
  });
});

/**
 * A zone routinely spans several printed parts — the chair's `left` covers four — and each part
 * carries only its own slice of the zone's shared UV space. The frame has to resolve against the
 * slice that actually holds the design center; asking any other one gets its nearest-triangle
 * answer instead, which on the real chair is ~100mm away on a neighbouring part.
 */
describe('assembly gizmo frame picks the part the design center lands on', () => {
  /** A 100x100mm patch of the shared zone UV space, starting at `u0` along u. */
  const slice = (u0: number): ConformalChart => {
    const S = 100;
    const positions3: number[] = [];
    const uv: number[] = [];
    for (const [su, sv] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]) {
      // S(u,v) = [170, v, -600 + u], the same flat plane CHART_A uses
      positions3.push(170, sv * S, -600 + u0 + su * S);
      uv.push(u0 + su * S, sv * S);
    }
    return {
      positions3: Float32Array.from(positions3),
      uv: Float32Array.from(uv),
      triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      normalSign: 1,
      boundary: [
        [u0, 0],
        [u0 + S, 0],
        [u0 + S, S],
        [u0, S],
      ],
      // shared across the zone, as the bake measures it — this is what makes (0,0) the ZONE centre
      zoneBounds: { minU: 0, minV: 0, maxU: 800, maxV: 100 },
    };
  };

  it('resolves to the holding part rather than a nearer-but-wrong neighbour', () => {
    // zone centre is u=400. Ordered so a naive scan that lets its cursor move mid-loop walks
    // 0 -> 1 -> 2 and then back over 1, never reaching the part at index 3 that actually holds it.
    state.assembly.parts = [
      zonedPart(1, 'left', slice(150)), // 150..250, 150mm off
      zonedPart(2, 'left', slice(0)), //     0..100, 300mm off
      zonedPart(3, 'left', slice(420)), // 420..520,  20mm off
      zonedPart(4, 'left', slice(300)), // 300..410, HOLDS u=400
    ];
    const a = loadArtworkSource(parsed(), 'a.svg');
    setArtworkZone(a.id, 'left');

    const frame = computeFaceFrame()!;

    expect(frame.offSurfaceMM).toBe(0);
    // S(400, 50) on the holding slice = [170, 50, -200]
    expect(frame.origin.x).toBeCloseTo(170, 6);
    expect(frame.origin.z).toBeCloseTo(-200, 6);
  });
});

/**
 * The gizmo redraws mid-drag by passing the design's displacement from the center of the frame it
 * captured at pointerdown — while `state.offsetX/Y` already hold the new position. A frame that
 * reads those live inside `pointAt` therefore counts the delta twice and sends the outline off at
 * double the cursor.
 */
describe('gizmo frame reports positions relative to its own center', () => {
  const flatFrame = () => {
    state.shapeKind = 'disc';
    state.marginPct = 0;
    state.disc = { ...state.disc, diameter: 200, thickness: 3 };
    state.parsed = parsed();
    state.offsetX = 0;
    state.offsetY = 0;
    return computeFaceFrame()!;
  };

  it('does not move a flat frame’s pointAt when the drag writes a new offset', () => {
    const f = flatFrame();
    const before = f.pointAt(10, 0);

    state.offsetX = 10; // what a 10mm move drag has already written by redraw time

    expect(f.pointAt(10, 0).distanceTo(before)).toBeLessThan(1e-9);
    // one delta from the frame's origin, not two
    expect(f.pointAt(10, 0).distanceTo(f.origin)).toBeCloseTo(10, 6);
  });

  it('does the same on an assembly frame', () => {
    const a = loadArtworkSource(parsed(), 'a.svg');
    setArtworkZone(a.id, 'left');
    const f = computeFaceFrame()!;
    const before = f.pointAt(10, 0);

    state.offsetX = 10;

    expect(f.pointAt(10, 0).distanceTo(before)).toBeLessThan(1e-9);
    expect(f.pointAt(10, 0).distanceTo(f.origin)).toBeCloseTo(10, 6);
  });
});

/**
 * The off-surface warning has to answer for where the design is being dragged TO. The frame is
 * captured at pointerdown, so its own `offSurfaceMM` keeps reporting the start of the gesture —
 * silent through exactly the drag that takes the artwork off the part.
 */
describe('gizmo frame answers off-surface for a displaced center', () => {
  it('tracks the design center leaving the chart', () => {
    const a = loadArtworkSource(parsed(), 'a.svg');
    setArtworkZone(a.id, 'left'); // CHART_A: 100x100 of UV, so ±50 from its center
    const f = computeFaceFrame()!;

    expect(f.offSurfaceMM).toBe(0);
    expect(f.offSurfaceAt(0, 0, 5)).toBe(0);
    expect(f.offSurfaceAt(20, -20, 5)).toBe(0);
    // 10mm past the chart edge — beyond the budget, so only "further than the tolerance" is promised
    expect(f.offSurfaceAt(60, 0, 5)).toBeGreaterThan(5);
    expect(f.offSurfaceAt(0, -60, 5)).toBeGreaterThan(5);
  });

  it('is always on-surface for a flat plate, which has no chart to leave', () => {
    state.shapeKind = 'disc';
    state.parsed = parsed();

    expect(computeFaceFrame()!.offSurfaceAt(1e4, 1e4, 5)).toBe(0);
  });
});

/**
 * The outline is traced along the surface, not across the tangent plane, so a frame on a curved
 * zone lies on the part instead of hanging in space beside it.
 */
describe('assembly gizmo frame traces the surface', () => {
  // CHART_A is the flat plane S(u,v) = [170, v, -600 + u], where the two agree exactly.
  it('matches the tangent plane on a flat chart', () => {
    const a = loadArtworkSource(parsed(), 'a.svg');
    setArtworkZone(a.id, 'left');
    const f = computeFaceFrame()!;

    for (const [du, dv] of [
      [0, 0],
      [12, -7],
      [-20, 25],
    ]) {
      const onPlane = f.origin.clone().addScaledVector(f.uAxis, du).addScaledVector(f.vAxis, dv);
      expect(f.pointAt(du, dv).distanceTo(onPlane)).toBeLessThan(1e-6);
    }
  });

  it('leaves the tangent plane where the surface bends away from it', () => {
    // A chart folded 90° along its middle: past the fold the surface drops away from the plane the
    // frame is tangent to, by exactly the arc it turned through.
    const bent: ConformalChart = {
      // v runs +Y; u runs +Z for the first 50mm, then turns to +X
      positions3: Float32Array.from([
        0, 0, 0, 0, 100, 0, 0, 0, 50, 0, 100, 50, 50, 0, 50, 50, 100, 50,
      ]),
      uv: Float32Array.from([0, 0, 0, 100, 50, 0, 50, 100, 100, 0, 100, 100]),
      triangles: Uint32Array.from([0, 2, 3, 0, 3, 1, 2, 4, 5, 2, 5, 3]),
      normalSign: 1,
      boundary: [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ],
    };
    state.assembly.parts = [zonedPart(1, 'left', bent)];
    const a = loadArtworkSource(parsed(), 'a.svg');
    setArtworkZone(a.id, 'left');
    const f = computeFaceFrame()!;

    // 40mm along +u from the chart center sits 15mm past the fold, so it has turned the corner
    const du = 40;
    const onPlane = f.origin.clone().addScaledVector(f.uAxis, du);
    expect(f.pointAt(du, 0).distanceTo(onPlane)).toBeGreaterThan(5);
  });
});
