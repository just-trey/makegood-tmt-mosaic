import JSZip from 'jszip';
import type { FlatPatch } from '../types';

/**
 * Minimal 3MF reader: it's a zip containing 3D/3dmodel.model (XML). Returns a flat triangle
 * soup matching what STLLoader gives, so downstream code doesn't care which format.
 */
export async function load3MF(arrayBuffer: ArrayBuffer): Promise<{ positions: Float32Array; triCount: number }> {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const modelFile = zip.file('3D/3dmodel.model');
  if (!modelFile) throw new Error('Not a valid 3MF: missing 3D/3dmodel.model');
  const xmlText = await modelFile.async('string');
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const objects = doc.getElementsByTagName('object');
  const allVerts: number[][] = [];
  const allTris: number[][] = [];
  for (const obj of objects) {
    const mesh = obj.getElementsByTagName('mesh')[0];
    if (!mesh) continue;
    const base = allVerts.length;
    const vElems = mesh.getElementsByTagName('vertex');
    for (const v of vElems) allVerts.push([+(v.getAttribute('x') || 0), +(v.getAttribute('y') || 0), +(v.getAttribute('z') || 0)]);
    const tElems = mesh.getElementsByTagName('triangle');
    for (const t of tElems) allTris.push([base + +(t.getAttribute('v1') || 0), base + +(t.getAttribute('v2') || 0), base + +(t.getAttribute('v3') || 0)]);
  }
  const positions = new Float32Array(allTris.length * 9);
  allTris.forEach((tri, i) => {
    tri.forEach((vi, k) => {
      positions[i * 9 + k * 3] = allVerts[vi][0];
      positions[i * 9 + k * 3 + 1] = allVerts[vi][1];
      positions[i * 9 + k * 3 + 2] = allVerts[vi][2];
    });
  });
  return { positions, triCount: allTris.length };
}

/**
 * Detect flat coplanar patches by clustering triangles on rounded (normal, plane offset),
 * returned ranked by total area. The largest patch is the default design face; the caller
 * can pick a different one from the ranked list.
 */
export function detectFlatPatches(positions: Float32Array): FlatPatch[] {
  const triCount = positions.length / 9;
  const buckets = new Map<string, FlatPatch>();
  for (let i = 0; i < triCount; i++) {
    const o = i * 9;
    const p0 = [positions[o], positions[o + 1], positions[o + 2]];
    const p1 = [positions[o + 3], positions[o + 4], positions[o + 5]];
    const p2 = [positions[o + 6], positions[o + 7], positions[o + 8]];
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-9) continue;
    const nu = [n[0] / len, n[1] / len, n[2] / len];
    const area = len / 2;
    const offset = nu[0] * p0[0] + nu[1] * p0[1] + nu[2] * p0[2];
    const key = [nu[0].toFixed(2), nu[1].toFixed(2), nu[2].toFixed(2), offset.toFixed(2)].join(',');
    let b = buckets.get(key);
    if (!b) { b = { area: 0, normal: nu, offset, triIndices: [] }; buckets.set(key, b); }
    b.area += area; b.triIndices.push(i);
  }
  return Array.from(buckets.values()).sort((a, b) => b.area - a.area);
}

/**
 * Chain the boundary edges of a triangle patch into closed loops (an edge with no matching
 * reverse edge in the patch is a boundary edge). Returns loops of [x,y,z] points.
 */
export function extractPatchBoundary(positions: Float32Array, triIndices: number[]): number[][][] {
  const edgeMap = new Map<string, string>(); // vertex-key -> next vertex-key along the boundary
  const posOf = new Map<string, number[]>();
  function addVert(x: number, y: number, z: number): string {
    const k = [x, y, z].map(v => v.toFixed(4)).join(',');
    posOf.set(k, [x, y, z]);
    return k;
  }
  const seen = new Map<string, number>(); // edge "a|b" -> count
  triIndices.forEach(i => {
    const o = i * 9;
    const pts = [0, 1, 2].map(k => addVert(positions[o + k * 3], positions[o + k * 3 + 1], positions[o + k * 3 + 2]));
    for (let k = 0; k < 3; k++) {
      const a = pts[k], b = pts[(k + 1) % 3];
      seen.set(a + '|' + b, (seen.get(a + '|' + b) || 0) + 1);
    }
  });
  seen.forEach((_cnt, key) => {
    const [a, b] = key.split('|');
    const rev = b + '|' + a;
    if (!seen.has(rev)) edgeMap.set(a, b);
  });
  const loops: number[][][] = [];
  const used = new Set<string>();
  for (const start of edgeMap.keys()) {
    if (used.has(start)) continue;
    const loop = [start]; used.add(start);
    let cur = edgeMap.get(start)!;
    let guard = 0;
    while (cur !== start && edgeMap.has(cur) && !used.has(cur) && guard++ < 100000) {
      loop.push(cur); used.add(cur); cur = edgeMap.get(cur)!;
    }
    loops.push(loop.map(k => posOf.get(k)!));
  }
  return loops;
}

/**
 * A part's geometry minus one patch's triangles — preview-only context so the viewport can show
 * what an insert sits inside without z-fighting the replaced face.
 */
export function excludeTriangles(positions: Float32Array, excludeIndices: number[]): Float32Array {
  const exclude = new Set(excludeIndices);
  const triCount = positions.length / 9;
  const out = new Float32Array((triCount - exclude.size) * 9);
  let w = 0;
  for (let i = 0; i < triCount; i++) {
    if (exclude.has(i)) continue;
    const o = i * 9;
    for (let k = 0; k < 9; k++) out[w++] = positions[o + k];
  }
  return out;
}
