// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

/**
 * The gizmo's move hit-test decides whether a viewport click grabs the artwork or orbits the
 * camera, so it has to accept exactly the region the frame is *drawn* over. The outline is traced
 * on the surface; the tangent rectangle spanned by uAxis/vAxis is a different region wherever the
 * part curves. These tests drive the real pointer handlers against a synthetic FaceFrame whose
 * `pointAt` makes the two disagree by a known amount.
 */

// Camera looks straight down -Z at the frame, so world XY maps to NDC with no rotation to reason
// about. Positioned far enough back that the whole frame is comfortably inside the view.
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
camera.position.set(0, 0, 500);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();

const controls = { enabled: true, addEventListener: vi.fn() };
const dom = Object.assign(document.createElement('canvas'), {
  setPointerCapture: vi.fn(),
  releasePointerCapture: vi.fn(),
  hasPointerCapture: () => true,
});

vi.mock('../src/app/scheduler', () => ({
  scheduleRebuild: vi.fn(),
  isRebuildLikelySlow: () => true, // assemblies defer the recut to pointerup
}));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));
vi.mock('../src/scene/viewport', () => ({
  addSceneOverlay: vi.fn(),
  getCamera: () => camera,
  getControls: () => controls,
  getDomElement: () => dom,
  invalidate: vi.fn(),
  // The pointer→NDC conversion is the viewport's job, not this module's: tests hand NDC straight
  // through so they can aim at a projected world point without plumbing a canvas size.
  pointerToNDC: (e: PointerEvent) => new THREE.Vector2(e.clientX, e.clientY),
  setInteracting: vi.fn(),
}));

const computeFaceFrame = vi.fn();
vi.mock('../src/scene/faceFrame', () => ({ computeFaceFrame: () => computeFaceFrame() }));

import { initDesignGizmo, isGizmoDragging, refreshGizmo } from '../src/scene/designGizmo';

/**
 * A frame whose surface pulls every on-face displacement in by `shrink`. At 0.5 the drawn outline
 * is half the size of the tangent rectangle, which is the same *kind* of disagreement the chair's
 * flank produces (there the outline curves away from the plane) with an exactly known answer.
 */
function frameWithShrink(shrink: number) {
  return {
    origin: new THREE.Vector3(0, 0, 0),
    uAxis: new THREE.Vector3(1, 0, 0),
    vAxis: new THREE.Vector3(0, 1, 0),
    normal: new THREE.Vector3(0, 0, 1),
    halfW: 100,
    halfH: 100,
    pointAt: (du: number, dv: number) => new THREE.Vector3(du * shrink, dv * shrink, 0),
    offSurfaceMM: 0,
    offSurfaceAt: () => 0,
    offsetX: 0,
    offsetY: 0,
    scalePct: 100,
    rotationDeg: 0,
  };
}

/** NDC of a world point under the test camera — where a user would click to hit it. */
function ndcOf(x: number, y: number): THREE.Vector2 {
  const p = new THREE.Vector3(x, y, 0).project(camera);
  return new THREE.Vector2(p.x, p.y);
}

function clickAt(world: [number, number]): boolean {
  const ndc = ndcOf(world[0], world[1]);
  dom.dispatchEvent(
    new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: ndc.x, clientY: ndc.y }),
  );
  const grabbed = isGizmoDragging();
  dom.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
  return grabbed;
}

beforeEach(() => {
  controls.enabled = true;
});

describe('gizmo move hit-test matches the frame as drawn', () => {
  it('ignores a click outside the traced outline that the tangent rectangle would accept', () => {
    computeFaceFrame.mockReturnValue(frameWithShrink(0.5));
    initDesignGizmo();

    // Drawn outline reaches ±50; the tangent rectangle reaches ±100. A click at 75 is between the
    // two — outside everything the user can see, but a 'move' under the old flat test.
    expect(clickAt([75, 0])).toBe(false);
    expect(clickAt([0, 75])).toBe(false);
    // and the orbit it hands back is not left disabled
    expect(controls.enabled).toBe(true);
  });

  it('still grabs a click inside the traced outline', () => {
    computeFaceFrame.mockReturnValue(frameWithShrink(0.5));
    refreshGizmo();

    expect(clickAt([0, 0])).toBe(true);
    expect(clickAt([40, -40])).toBe(true);
  });

  it('accepts out to the full extent when the surface is flat', () => {
    // shrink 1 is the flat case, where outline and tangent rectangle coincide — the region must not
    // have quietly shrunk for parts that were never curved.
    computeFaceFrame.mockReturnValue(frameWithShrink(1));
    refreshGizmo();

    expect(clickAt([90, 90])).toBe(true);
    expect(clickAt([110, 0])).toBe(false);
  });

  it('follows the frame’s rotation', () => {
    const f = { ...frameWithShrink(1), rotationDeg: 45 };
    computeFaceFrame.mockReturnValue(f);
    refreshGizmo();

    // The 45°-rotated square's corners reach ±141 along the axes but its edges pull in to ±71 on
    // the diagonals, so these two points swap membership versus the unrotated frame.
    expect(clickAt([130, 0])).toBe(true);
    expect(clickAt([90, 90])).toBe(false);
  });
});
