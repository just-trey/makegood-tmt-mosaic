import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { creasedNormalsFromIndex, indexMatchesSoup } from '../src/geometry/creasedNormals';
import type { IndexedMesh } from '../src/types';

// The indexed crease pass replaces three's `toCreasedNormals` wherever a mesh already carries its
// vertex sharing. Two properties matter and neither is "there are normals":
//
//   1. It agrees with what it replaced. Not exactly — it shares vertices by index identity where
//      three buckets positions to 0.01mm — so the bound is stated as a corner count, and a
//      regression that broke the crease rule outright would blow past it immediately.
//   2. The crease threshold still decides: a shallow fold smooths, a sharp one does not.
//
// `positions` really being `indices` expanded, which is what makes the normals land on the right
// triangles at all, is asserted in load3mf-indexed.test.ts against a synthetic mesh.
//
// The 3MF here is read by a regex scan rather than through load3MF, and this file is deliberately
// NOT in the jsdom environment. jsdom's getElementsByTagName is a live collection, so walking a
// real part's 23k <vertex> elements through it is quadratic: the same test cost 573s that way.

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CREASE = (30 * Math.PI) / 180;

/** A real packed part: 46k triangles, chamfers, and the mixed curvature the crease angle exists
 * for. A synthetic cube would pass every assertion here while proving nothing about either. */
let part: { positions: Float32Array; vertices: Float32Array; indices: Uint32Array };

beforeAll(async () => {
  const zip = await JSZip.loadAsync(
    readFileSync(resolve(REPO, 'public/stl/chair-handle-left.3mf')),
  );
  const xml = await zip.file('3D/3dmodel.model')!.async('string');
  const verts: number[] = [];
  const tris: number[] = [];
  let m: RegExpExecArray | null;
  const vRe = /<vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/g;
  while ((m = vRe.exec(xml))) verts.push(+m[1], +m[2], +m[3]);
  const tRe = /<triangle\s+v1="([^"]*)"\s+v2="([^"]*)"\s+v3="([^"]*)"/g;
  while ((m = tRe.exec(xml))) tris.push(+m[1], +m[2], +m[3]);
  const vertices = Float32Array.from(verts);
  const indices = Uint32Array.from(tris);
  const positions = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    positions.set(vertices.subarray(indices[i] * 3, indices[i] * 3 + 3), i * 3);
  }
  part = { positions, vertices, indices };
});

const indexedOf = (): IndexedMesh => ({ positions: part.vertices, indices: part.indices });

describe('creasedNormalsFromIndex', () => {
  it('produces one unit normal per soup corner', () => {
    const normals = creasedNormalsFromIndex(indexedOf(), CREASE);
    expect(normals.length).toBe(part.positions.length);
    for (let i = 0; i < normals.length; i += 3 * 613) {
      const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
      expect(len).toBeCloseTo(1, 5);
    }
  });

  it('agrees with toCreasedNormals on all but a fraction of a percent of corners', () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(part.positions.slice(), 3));
    const ref = toCreasedNormals(geo, CREASE).attributes.normal.array as Float32Array;
    const mine = creasedNormalsFromIndex(indexedOf(), CREASE);

    let over1 = 0;
    const corners = mine.length / 3;
    for (let i = 0; i < corners; i++) {
      const o = i * 3;
      const dot = Math.min(
        1,
        Math.max(-1, ref[o] * mine[o] + ref[o + 1] * mine[o + 1] + ref[o + 2] * mine[o + 2]),
      );
      if ((Math.acos(dot) * 180) / Math.PI > 1) over1++;
    }
    // Measured at 65 of 138954 on this part (0.05%). The bound is deliberately loose enough not to
    // be a tripwire on a three upgrade, and tight enough that dropping the crease rule (which
    // would disagree on a large share of corners) fails it.
    expect(over1 / corners).toBeLessThan(0.005);
  });

  it('keeps a sharp fold sharp and a shallow one smooth', () => {
    // Two quads meeting along y=0: one folded 20 degrees (under the threshold, smooth across the
    // seam), one folded 90 (over it, each side keeps its own normal).
    const check = (foldDeg: number, expectShared: boolean): void => {
      const r = (foldDeg * Math.PI) / 180;
      const positions = Float32Array.from([
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        0,
        1,
        0,
        0,
        1,
        1,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        0,
        -Math.cos(r),
        Math.sin(r),
        1,
        0,
        0,
        1,
        0,
        0,
        0,
        -Math.cos(r),
        Math.sin(r),
        1,
        -Math.cos(r),
        Math.sin(r),
      ]);
      const verts = Float32Array.from([
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        0,
        1,
        1,
        0,
        0,
        -Math.cos(r),
        Math.sin(r),
        1,
        -Math.cos(r),
        Math.sin(r),
      ]);
      const indices = Uint32Array.from([0, 1, 2, 1, 3, 2, 0, 4, 1, 1, 4, 5]);
      const soup = new Float32Array(indices.length * 3);
      for (let i = 0; i < indices.length; i++)
        soup.set(verts.subarray(indices[i] * 3, indices[i] * 3 + 3), i * 3);
      expect(Array.from(soup)).toEqual(Array.from(positions));

      const n = creasedNormalsFromIndex({ positions: verts, indices }, CREASE);
      // Corner 0 is vertex 0 on the flat quad; corner 6 is vertex 0 on the folded one.
      const flat = [n[0], n[1], n[2]];
      const folded = [n[18], n[19], n[20]];
      const dot = flat[0] * folded[0] + flat[1] * folded[1] + flat[2] * folded[2];
      if (expectShared) expect(dot).toBeGreaterThan(0.999);
      else expect(dot).toBeLessThan(0.999);
    };
    check(20, true);
    check(90, false);
  });
});

describe('indexMatchesSoup', () => {
  it('accepts an index that describes the soup and rejects one that does not', () => {
    expect(indexMatchesSoup(indexedOf(), part.positions)).toBe(true);
    expect(indexMatchesSoup(undefined, part.positions)).toBe(false);
    // A stale index left behind by a mesh swap: the exact case AssemblyRole.buildMesh creates.
    const stale: IndexedMesh = { positions: part.vertices, indices: part.indices.slice(0, 30) };
    expect(indexMatchesSoup(stale, part.positions)).toBe(false);
  });

  it('rejects an index that reaches past its own vertex list', () => {
    // Right triangle count, so the length check passes; one index out of range. Unguarded this
    // reads undefined out of the Float32Array and every normal downstream comes out NaN, which
    // renders as a missing part rather than a wrong-looking one.
    const indices = part.indices.slice();
    indices[indices.length - 1] = part.vertices.length / 3;
    expect(indexMatchesSoup({ positions: part.vertices, indices }, part.positions)).toBe(false);
  });
});
