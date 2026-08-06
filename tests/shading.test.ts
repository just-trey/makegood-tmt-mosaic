import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bufferGeometryFromTris } from '../src/app/rebuild';

// Display shading. The property is the crease threshold, not "there are normals" — plain
// computeVertexNormals() also produces normals, and that is exactly what this replaced. So each
// case is chosen to fail loudly under a specific regression:
//
//   - the 20 degree fold smooths, which a revert to computeVertexNormals() breaks (non-indexed
//     geometry gives every vertex its own face normal, so nothing ever blends);
//   - the 45 degree fold stays sharp, which a bump to three's 60 degree default breaks. 45 is not
//     arbitrary: it is a chamfer meeting its face, the case CREASE_ANGLE_RAD exists to protect.

/**
 * Two triangles sharing the edge (0,0,0)-(1,0,0), with `foldDeg` between their face normals.
 * Wound so both normals point the same way at zero fold, which the fixture check below asserts
 * rather than assumes.
 */
function foldedPair(foldDeg: number): Float32Array {
  const f = (foldDeg * Math.PI) / 180;
  const e0 = [0, 0, 0]; // shared edge, start
  const e1 = [1, 0, 0]; // shared edge, end
  const apexA = [0.5, 1, 0]; // triangle A lies in z = 0
  const apexB = [0.5, -Math.cos(f), Math.sin(f)]; // swung out of that plane by f
  // A, then B with the shared edge reversed so both faces wind the same way
  return new Float32Array([...e0, ...e1, ...apexA, ...e1, ...e0, ...apexB]);
}

function faceNormal(pos: THREE.BufferAttribute, tri: number): THREE.Vector3 {
  const a = new THREE.Vector3().fromBufferAttribute(pos, tri * 3);
  const b = new THREE.Vector3().fromBufferAttribute(pos, tri * 3 + 1);
  const c = new THREE.Vector3().fromBufferAttribute(pos, tri * 3 + 2);
  return new THREE.Vector3()
    .subVectors(c, b)
    .cross(new THREE.Vector3().subVectors(a, b))
    .normalize();
}

const normalAt = (geo: THREE.BufferGeometry, i: number): THREE.Vector3 =>
  new THREE.Vector3().fromBufferAttribute(geo.attributes.normal as THREE.BufferAttribute, i);

describe('bufferGeometryFromTris shading', () => {
  it('builds the fixture at the fold angle it claims', () => {
    for (const deg of [20, 45]) {
      const geo = bufferGeometryFromTris(foldedPair(deg));
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const angle = (faceNormal(pos, 0).angleTo(faceNormal(pos, 1)) * 180) / Math.PI;
      expect(angle).toBeCloseTo(deg, 4);
    }
  });

  it('smooths a shallow fold — a tessellated curve reads as one surface', () => {
    const geo = bufferGeometryFromTris(foldedPair(20));
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const nA = faceNormal(pos, 0);
    // vertices 0 and 1 are triangle A's ends of the shared edge; both are also in triangle B, so
    // their normals must be the blend of the two faces, not A's own.
    for (const i of [0, 1]) expect(normalAt(geo, i).angleTo(nA)).toBeGreaterThan(1e-3);
    // the unshared apex has only one face and keeps it, under any threshold
    expect(normalAt(geo, 2).angleTo(nA)).toBeLessThan(1e-6);
  });

  it('keeps a 45 degree fold sharp — a chamfer stays a chamfer', () => {
    const geo = bufferGeometryFromTris(foldedPair(45));
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const nA = faceNormal(pos, 0);
    for (const i of [0, 1, 2]) expect(normalAt(geo, i).angleTo(nA)).toBeLessThan(1e-6);
  });

  it('preserves the input positions exactly', () => {
    const soup = foldedPair(45);
    const geo = bufferGeometryFromTris(soup);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    expect(pos.count).toBe(6);
    for (let i = 0; i < soup.length; i++) expect(pos.array[i]).toBeCloseTo(soup[i], 6);
  });
});
