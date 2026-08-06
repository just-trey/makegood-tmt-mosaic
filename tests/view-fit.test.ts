import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIT_FILL, fitDistance } from '../src/scene/viewport';

// The initial camera fit. Asserted by actually projecting the box through a camera placed at the
// returned distance, not by re-deriving the formula here — a test that recomputed the same
// arithmetic would agree with a wrong implementation. Two shipped bugs motivate this: the chair
// (tall, deep, not disc-like) was cropped by a half-extent radius, and the wheel (a flat disc) was
// framed a third too small by a bounding-sphere one.

const UP = new THREE.Vector3(0, 0, 1); // the app's world up

/** Max |x|,|y| of the box's 8 corners in NDC, viewed from `dist` along `dir`. Over 1 = cropped. */
function ndcExtent(
  box: THREE.Box3,
  center: THREE.Vector3,
  dir: THREE.Vector3,
  dist: number,
  fovDeg: number,
  aspect: number,
): number {
  const cam = new THREE.PerspectiveCamera(fovDeg, aspect, 0.1, 1e6);
  cam.up.copy(UP);
  cam.position.copy(center).addScaledVector(dir, dist);
  cam.lookAt(center);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const v = new THREE.Vector3();
  let worst = 0;
  for (let i = 0; i < 8; i++) {
    v.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ).project(cam);
    worst = Math.max(worst, Math.abs(v.x), Math.abs(v.y));
  }
  return worst;
}

/** Real proportions, so a regression reads as the part it would actually break. */
const SHAPES: Array<{ name: string; size: [number, number, number] }> = [
  { name: 'chair (tall, deep)', size: [380, 658, 700] },
  { name: 'wheel (flat disc)', size: [280, 280, 30] },
  { name: 'footrest (flat slab)', size: [200, 160, 25] },
  { name: 'cube', size: [100, 100, 100] },
  { name: 'sliver', size: [300, 4, 4] },
];

const ASPECTS = [1600 / 1100, 900 / 1200, 1, 21 / 9];
const DIRS = [
  new THREE.Vector3(0.35, -0.9, 0.4).normalize(),
  new THREE.Vector3(0.5, -0.85, 0.6).normalize(),
  new THREE.Vector3(0, 0, 1), // straight down world up — the degenerate basis case
  // and just off it: near-parallel is NOT the degenerate case, and treating it as one picks a
  // basis rotated 90° from the camera's. OrbitControls clamps its polar angle to EPS = 1e-6, so
  // a user orbiting to top-down lands here.
  new THREE.Vector3(0, 1e-7, 1).normalize(),
  new THREE.Vector3(1, 0, 0),
];

describe('fitDistance', () => {
  for (const { name, size } of SHAPES) {
    for (const aspect of ASPECTS) {
      it(`fits ${name} at aspect ${aspect.toFixed(2)} from every view direction`, () => {
        const box = new THREE.Box3(
          new THREE.Vector3(-size[0] / 2, -size[1] / 2, 0),
          new THREE.Vector3(size[0] / 2, size[1] / 2, size[2]),
        );
        const center = box.getCenter(new THREE.Vector3());
        for (const dir of DIRS) {
          const dist = fitDistance(box, center, dir, 40, aspect, UP);
          const extent = ndcExtent(box, center, dir, dist, 40, aspect);
          expect(extent).toBeLessThanOrEqual(1);
          // and not wastefully far: the binding axis lands on FIT_FILL, which is what stops a
          // conservative fix from trading a cropped part for a tiny one. Imported rather than
          // repeated here — a copied 0.9 would drift silently the day the constant moves.
          expect(extent).toBeCloseTo(FIT_FILL, 2);
        }
      });
    }
  }

  // The assertions above import FIT_FILL, so they pin "the solver hits its configured target"
  // rather than the target itself — retuning the margin shouldn't fail them. This is what still
  // catches a typo in the constant (0.09 for 0.9), which would frame every part tiny and which
  // nothing in CI would otherwise notice.
  it('keeps the fill target usable', () => {
    expect(FIT_FILL).toBeGreaterThan(0.5);
    expect(FIT_FILL).toBeLessThanOrEqual(1);
  });

  it('backs off no closer than the minimum for a degenerate box', () => {
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
    const dir = new THREE.Vector3(0, -1, 0);
    const dist = fitDistance(box, new THREE.Vector3(), dir, 40, 1.5, UP);
    expect(dist).toBeGreaterThan(0);
    expect(Number.isFinite(dist)).toBe(true);
  });
});
