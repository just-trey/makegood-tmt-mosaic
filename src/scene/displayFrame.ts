import * as THREE from 'three';
import type { AssemblyKind, DisplayFrame } from '../types';

/** World up in the Z-up viewport scene (see `camera.up` in viewport.ts). */
const WORLD_UP = new THREE.Vector3(0, 0, 1);
/** Where an authored `front` turns: −Y, the default camera's side, so a kind opens front-first. */
const WORLD_FRONT = new THREE.Vector3(0, -1, 0);

/**
 * Native to display rotation (`up` to world up, `front` to the camera). Directions, not angles:
 * "+Y is up" can be checked against the mesh, where a re-pack would silently break an Euler
 * triple. `front` is re-orthogonalized, so authored vectors needn't be exactly perpendicular.
 */
export function displayQuaternion(df: DisplayFrame): THREE.Quaternion {
  const up = new THREE.Vector3(...df.up);
  const front = new THREE.Vector3(...df.front);
  if (up.lengthSq() < 1e-12 || front.lengthSq() < 1e-12) return new THREE.Quaternion();
  up.normalize();
  front.addScaledVector(up, -front.dot(up));
  if (front.lengthSq() < 1e-12) return new THREE.Quaternion(); // front ∥ up: no frame to build
  front.normalize();
  // Both frames as orthonormal basis matrices; the rotation mapping one to the other is B·Aᵀ.
  const native = new THREE.Matrix4().makeBasis(
    new THREE.Vector3().crossVectors(up, front),
    up,
    front,
  );
  const display = new THREE.Matrix4().makeBasis(
    new THREE.Vector3().crossVectors(WORLD_UP, WORLD_FRONT),
    WORLD_UP,
    WORLD_FRONT,
  );
  return new THREE.Quaternion().setFromRotationMatrix(display.multiply(native.transpose()));
}

/** The kind's display rotation, or identity for a kind that authors none. */
export function displayQuaternionFor(kind: AssemblyKind | null | undefined): THREE.Quaternion {
  return kind?.displayFrame ? displayQuaternion(kind.displayFrame) : new THREE.Quaternion();
}

/**
 * Opening view direction (target → camera): −Y for a display-framed kind (already turned front to
 * −Y), else the ±Y face normal of the plate-like kinds. Same side-and-above offset for both.
 */
export function assemblyViewDir(
  kind: AssemblyKind | null | undefined,
  viewSign: number,
): THREE.Vector3 {
  return new THREE.Vector3(0.35, kind?.displayFrame ? -0.9 : 0.9 * viewSign, 0.4);
}
