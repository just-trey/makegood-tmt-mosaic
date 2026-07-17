import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { meshToSTLBytes, soupFromObject, trisToSTLBlob } from '../src/export/stl';

async function stlView(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

describe('trisToSTLBlob', () => {
  it('writes a valid binary STL for one triangle', async () => {
    const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const blob = trisToSTLBlob(soup);
    expect(blob.size).toBe(84 + 50);
    const dv = await stlView(blob);
    expect(dv.getUint32(80, true)).toBe(1);
    // CCW triangle in the XY plane -> +Z normal
    expect(dv.getFloat32(84, true)).toBeCloseTo(0);
    expect(dv.getFloat32(88, true)).toBeCloseTo(0);
    expect(dv.getFloat32(92, true)).toBeCloseTo(1);
    // vertices round-trip in order after the normal
    expect(dv.getFloat32(96 + 12, true)).toBeCloseTo(1);
    // attribute byte count is zero
    expect(dv.getUint16(84 + 48, true)).toBe(0);
  });

  it('emits a zero normal (not NaN) for a degenerate triangle', async () => {
    const blob = trisToSTLBlob(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]));
    const dv = await stlView(blob);
    expect(dv.getFloat32(84, true)).toBe(0);
    expect(dv.getFloat32(88, true)).toBe(0);
    expect(dv.getFloat32(92, true)).toBe(0);
  });
});

describe('soupFromObject', () => {
  it('flattens an indexed mesh into a world-space triangle soup', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    mesh.position.set(10, 0, 0);
    const soup = soupFromObject(mesh);
    expect(soup.length).toBe(12 * 9);
    let minX = Infinity,
      maxX = -Infinity;
    for (let i = 0; i < soup.length; i += 3) {
      minX = Math.min(minX, soup[i]);
      maxX = Math.max(maxX, soup[i]);
    }
    expect(minX).toBeCloseTo(9);
    expect(maxX).toBeCloseTo(11);
  });

  it('applies nested group transforms and skips non-mesh nodes', () => {
    const group = new THREE.Group();
    group.position.set(0, 5, 0);
    const inner = new THREE.Group();
    inner.position.set(0, 1, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    inner.add(mesh);
    group.add(inner);
    group.add(new THREE.Object3D());
    const soup = soupFromObject(group);
    let minY = Infinity;
    for (let i = 1; i < soup.length; i += 3) minY = Math.min(minY, soup[i]);
    expect(minY).toBeCloseTo(5);
  });
});

describe('meshToSTLBytes', () => {
  it('exports a box as 12 binary STL triangles', () => {
    const bytes = meshToSTLBytes(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    expect(bytes.length).toBe(84 + 12 * 50);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(80, true)).toBe(12);
  });
});
