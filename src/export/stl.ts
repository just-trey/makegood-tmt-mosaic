import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

const exporter = new STLExporter();

export function meshToSTLBytes(obj: THREE.Object3D): Uint8Array {
  const result = exporter.parse(obj as THREE.Mesh, { binary: true }) as unknown as DataView;
  return new Uint8Array(result.buffer as ArrayBuffer, result.byteOffset, result.byteLength);
}

export function meshToSTLBlob(obj: THREE.Object3D): Blob {
  return new Blob([meshToSTLBytes(obj) as BlobPart], { type: 'application/octet-stream' });
}

/** Write a raw triangle soup (N*9 interleaved xyz) as a binary STL. */
export function trisToSTLBlob(float32arr: Float32Array): Blob {
  const triCount = float32arr.length / 9;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, triCount, true);
  let o = 84;
  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    const ax = float32arr[b],
      ay = float32arr[b + 1],
      az = float32arr[b + 2];
    const bx = float32arr[b + 3],
      by = float32arr[b + 4],
      bz = float32arr[b + 5];
    const cx = float32arr[b + 6],
      cy = float32arr[b + 7],
      cz = float32arr[b + 8];
    const e1x = bx - ax,
      e1y = by - ay,
      e1z = bz - az,
      e2x = cx - ax,
      e2y = cy - ay,
      e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    dv.setFloat32(o, nx, true);
    dv.setFloat32(o + 4, ny, true);
    dv.setFloat32(o + 8, nz, true);
    dv.setFloat32(o + 12, ax, true);
    dv.setFloat32(o + 16, ay, true);
    dv.setFloat32(o + 20, az, true);
    dv.setFloat32(o + 24, bx, true);
    dv.setFloat32(o + 28, by, true);
    dv.setFloat32(o + 32, bz, true);
    dv.setFloat32(o + 36, cx, true);
    dv.setFloat32(o + 40, cy, true);
    dv.setFloat32(o + 44, cz, true);
    dv.setUint16(o + 48, 0, true);
    o += 50;
  }
  return new Blob([buf], { type: 'application/octet-stream' });
}

/**
 * Flatten a THREE mesh/group into a world-space triangle soup, so flat-plate mode's built
 * meshes (slab-stack body + per-color plugs, each with a position.z offset) can feed the
 * same build3MFCombined pipeline assembly mode uses.
 */
export function soupFromObject(root: THREE.Object3D): Float32Array {
  const out: number[] = [];
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    const mesh = o as THREE.Mesh;
    const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  });
  return Float32Array.from(out);
}
