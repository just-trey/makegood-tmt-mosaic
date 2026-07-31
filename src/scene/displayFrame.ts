import * as THREE from 'three';
import type { AssemblyKind, DisplayFrame } from '../types';

/** World up in the Z-up viewport scene (see `camera.up` in viewport.ts). */
const WORLD_UP = new THREE.Vector3(0, 0, 1);
/**
 * The world direction an authored `front` is turned to face: −Y, the side the default camera sits
 * on (viewport.ts parks it at negative Y looking back along +Y), so a kind opens showing its front
 * rather than its back.
 */
const WORLD_FRONT = new THREE.Vector3(0, -1, 0);

/**
 * Rotation carrying a kind's native coordinates into display coordinates — its `up` onto world up
 * and its `front` toward the camera.
 *
 * Derived from the two authored directions rather than stored as angles: the data then reads as a
 * statement about the part ("+Y is up, +Z is the front") that can be checked against the mesh,
 * and a re-pack that changed the native frame shows up as a wrong-looking vector here instead of a
 * silently-wrong Euler triple. `front` is re-orthogonalized against `up` so hand-authored vectors
 * need not be exactly perpendicular.
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
 * The view direction (target → camera) a kind should open at. A kind with a display frame has
 * already been turned so its front faces −Y, so the camera goes there; the ±Y face-normal guess
 * only makes sense for the plate-like kinds posed by the "design face is a Y-plane" convention.
 * Both keep the same slight side-and-above offset so the opening framing reads the same.
 */
export function assemblyViewDir(
  kind: AssemblyKind | null | undefined,
  viewSign: number,
): THREE.Vector3 {
  return new THREE.Vector3(0.35, kind?.displayFrame ? -0.9 : 0.9 * viewSign, 0.4);
}
