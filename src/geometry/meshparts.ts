import JSZip from 'jszip';
import type { FlatPatch } from '../types';

/**
 * Minimal 3MF reader: it's a zip containing 3D/3dmodel.model (XML). Returns a flat triangle
 * soup matching what STLLoader gives, so downstream code doesn't care which format.
 */
export async function load3MF(arrayBuffer: ArrayBuffer): Promise<{
  positions: Float32Array;
  triCount: number;
  vertices: Float32Array;
  indices: Uint32Array;
}> {
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
    for (const v of vElems)
      allVerts.push([
        +(v.getAttribute('x') || 0),
        +(v.getAttribute('y') || 0),
        +(v.getAttribute('z') || 0),
      ]);
    const tElems = mesh.getElementsByTagName('triangle');
    for (const t of tElems)
      allTris.push([
        base + +(t.getAttribute('v1') || 0),
        base + +(t.getAttribute('v2') || 0),
        base + +(t.getAttribute('v3') || 0),
      ]);
  }
  const positions = new Float32Array(allTris.length * 9);
  allTris.forEach((tri, i) => {
    tri.forEach((vi, k) => {
      positions[i * 9 + k * 3] = allVerts[vi][0];
      positions[i * 9 + k * 3 + 1] = allVerts[vi][1];
      positions[i * 9 + k * 3 + 2] = allVerts[vi][2];
    });
  });
  // The unique vertex list in file order, kept alongside the (unwelded) soup so a baked design-zone
  // chart — whose `verts` index this exact order — can be resolved back to 3D positions at load.
  // For a single-object part (every packed library part) this is just that object's <vertex> list.
  const vertices = new Float32Array(allVerts.length * 3);
  allVerts.forEach((v, i) => vertices.set(v, i * 3));
  // The <triangle> elements are already an index into that list, and `positions` above is just it
  // expanded. Returned rather than dropped so display shading can read the sharing the file states
  // instead of rediscovering it by hashing every corner.
  const indices = new Uint32Array(allTris.length * 3);
  allTris.forEach((tri, i) => indices.set(tri, i * 3));
  return { positions, triCount: allTris.length, vertices, indices };
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
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-9) continue;
    const nu = [n[0] / len, n[1] / len, n[2] / len];
    const area = len / 2;
    const offset = nu[0] * p0[0] + nu[1] * p0[1] + nu[2] * p0[2];
    const key = [nu[0].toFixed(2), nu[1].toFixed(2), nu[2].toFixed(2), offset.toFixed(2)].join(',');
    let b = buckets.get(key);
    if (!b) {
      b = { area: 0, normal: nu, offset, triIndices: [] };
      buckets.set(key, b);
    }
    b.area += area;
    b.triIndices.push(i);
  }
  return Array.from(buckets.values()).sort((a, b) => b.area - a.area);
}

export interface PatchBoundary {
  /** Closed rings of [x,y,z] points, each with the patch on its left. */
  loops: number[][][];
  /**
   * Boundary edges no closed ring could take. Non-zero only for a patch whose triangles overlap or
   * fold (a vertex with more edges leaving than arriving), and it means the face's shape is only
   * partly known. Zero for every selectable face of every packed part (tests/patch-boundary.test.ts).
   */
  openEdges: number;
}

/**
 * Chain the boundary edges of a triangle patch into closed loops (an edge with no matching
 * reverse edge in the patch is a boundary edge).
 *
 * Keyed by directed edge, not by vertex. Two loops of one patch meet at a point often (a hole
 * touching the outline, two islands sharing a corner) and that vertex then has two edges leaving
 * it. A vertex-keyed walk kept one and lost the other, returning a chain that ran off the end as
 * if it were a ring: 19 of the 114 faces the Advanced dropdown offers. At such a vertex the leaving
 * edge is chosen by angle so the wedge between arriving and leaving is face interior, which is what
 * keeps a bowtie as two rings and never sends a walk across a hole.
 */
export function extractPatchBoundary(positions: Float32Array, triIndices: number[]): PatchBoundary {
  const posOf = new Map<string, number[]>();
  function addVert(x: number, y: number, z: number): string {
    const k = [x, y, z].map((v) => v.toFixed(4)).join(',');
    posOf.set(k, [x, y, z]);
    return k;
  }
  const seen = new Map<string, number>(); // edge "a|b" -> count
  let nx = 0,
    ny = 0,
    nz = 0;
  triIndices.forEach((i) => {
    const o = i * 9;
    const pts = [0, 1, 2].map((k) =>
      addVert(positions[o + k * 3], positions[o + k * 3 + 1], positions[o + k * 3 + 2]),
    );
    for (let k = 0; k < 3; k++) {
      const a = pts[k],
        b = pts[(k + 1) % 3];
      seen.set(a + '|' + b, (seen.get(a + '|' + b) || 0) + 1);
    }
    const e1x = positions[o + 3] - positions[o],
      e1y = positions[o + 4] - positions[o + 1],
      e1z = positions[o + 5] - positions[o + 2];
    const e2x = positions[o + 6] - positions[o],
      e2y = positions[o + 7] - positions[o + 1],
      e2z = positions[o + 8] - positions[o + 2];
    nx += e1y * e2z - e1z * e2y;
    ny += e1z * e2x - e1x * e2z;
    nz += e1x * e2y - e1y * e2x;
  });

  // Directed boundary edges in first-seen order, which is also the order rings start from.
  const tail: string[] = [];
  const head: string[] = [];
  const outsAt = new Map<string, number[]>();
  const insAt = new Map<string, number[]>();
  for (const key of seen.keys()) {
    const [a, b] = key.split('|');
    if (seen.has(b + '|' + a)) continue;
    const e = tail.length;
    tail.push(a);
    head.push(b);
    const outs = outsAt.get(a);
    if (outs) outs.push(e);
    else outsAt.set(a, [e]);
    const ins = insAt.get(b);
    if (ins) ins.push(e);
    else insAt.set(b, [e]);
  }
  const E = tail.length;

  // Angles are measured in the patch plane, counter-clockwise about the winding normal, so the
  // patch lies to the left of every boundary edge and the interior wedge at a vertex runs
  // counter-clockwise from a leaving edge to an arriving one.
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const ax = Math.abs(nx) < 0.9 ? 1 : 0,
    ay = ax ? 0 : 1;
  let ux = ay * nz,
    uy = -ax * nz,
    uz = ax * ny - ay * nx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const wx = ny * uz - nz * uy,
    wy = nz * ux - nx * uz,
    wz = nx * uy - ny * ux;
  const angleFrom = (v: string, to: string): number => {
    const p = posOf.get(v)!,
      q = posOf.get(to)!;
    const dx = q[0] - p[0],
      dy = q[1] - p[1],
      dz = q[2] - p[2];
    return Math.atan2(dx * wx + dy * wy + dz * wz, dx * ux + dy * uy + dz * uz);
  };

  // next[e] is the edge a walk takes after arriving along e, or -1. Each leaving edge is given to
  // at most one arriving edge, so following `next` from any edge either returns to it or ends: a
  // walk can never enter a cycle it did not start on, which is what let an earlier attempt spin
  // to its iteration guard on the chair's default face.
  const next = new Int32Array(E).fill(-1);
  const hasPrev = new Uint8Array(E);
  for (const [v, outs] of outsAt) {
    const ins = insAt.get(v);
    if (!ins) continue;
    if (outs.length === 1 && ins.length === 1) {
      next[ins[0]] = outs[0];
      hasPrev[outs[0]] = 1;
      continue;
    }
    // Around the vertex counter-clockwise, a leaving edge opens an interior wedge and the next
    // arriving edge closes it. Two spokes share an angle only when two different vertices sit on
    // one ray from v (overlapping soup); leaving-before-arriving there just keeps the order
    // deterministic.
    const spokes = outs
      .map((e) => ({ e, out: true, ang: angleFrom(v, head[e]) }))
      .concat(ins.map((e) => ({ e, out: false, ang: angleFrom(v, tail[e]) })))
      .sort((p, q) => p.ang - q.ang || (p.out === q.out ? 0 : p.out ? -1 : 1));
    const open: number[] = [];
    const onStack = new Set<number>();
    // Exactly two passes, because the order is circular: an arriving edge sorted before its
    // leaving edge can only pop it once pass one has pushed the wrap-around, and after pass two
    // every arriving edge still unpaired has no unpaired leaving edge left to take.
    for (let pass = 0; pass < 2; pass++) {
      for (const s of spokes) {
        if (s.out) {
          if (!hasPrev[s.e] && !onStack.has(s.e)) {
            open.push(s.e);
            onStack.add(s.e);
          }
        } else if (next[s.e] === -1 && open.length) {
          const o = open.pop()!;
          onStack.delete(o);
          next[s.e] = o;
          hasPrev[o] = 1;
        }
      }
    }
  }

  // Linear: every edge is marked the first time any walk reaches it, and a walk that ends anywhere
  // but its own start is an open chain, so no chain is retried from each of its edges in turn.
  const used = new Uint8Array(E);
  let openEdges = 0;
  const loops: number[][][] = [];
  for (let start = 0; start < E; start++) {
    if (used[start]) continue;
    const loop: number[][] = [];
    let cur = start;
    do {
      used[cur] = 1;
      loop.push(posOf.get(tail[cur])!);
      cur = next[cur];
    } while (cur !== start && cur !== -1 && !used[cur]);
    if (cur === start) loops.push(loop);
    else openEdges += loop.length;
  }
  return { loops, openEdges };
}

/**
 * Unsigned shoelace area of a loop projected to X/Z, the plane a design face is measured in. The
 * one rule for "which loop is the face outline": the app and scripts/gen-templates.mjs both sort
 * by it, and a template traced from a hole is the wrong drawing at the wrong size.
 */
export function loopXZArea(loop: number[][]): number {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++)
    a += loop[j][0] * loop[i][2] - loop[i][0] * loop[j][2];
  return Math.abs(a) / 2;
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
