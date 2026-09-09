export interface Mesh {
  pos: Float32Array;
  idx: Uint32Array;
}

export type Vec3 = [number, number, number];

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

export function meshBounds(m: Mesh): Box3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = m.pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  return { min, max };
}

export function boxCenter(b: Box3): Vec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

export function boxSize(b: Box3): Vec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

export function boxesOverlap(a: Box3, b: Box3, pad = 0): boolean {
  for (let k = 0; k < 3; k++) if (a.max[k] + pad < b.min[k] || b.max[k] + pad < a.min[k]) return false;
  return true;
}

/** Row-major 3x4 affine: [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz]. */
export type Affine = number[];

export const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export function applyAffine(a: Affine, p: Vec3): Vec3 {
  return [
    a[0] * p[0] + a[1] * p[1] + a[2] * p[2] + a[3],
    a[4] * p[0] + a[5] * p[1] + a[6] * p[2] + a[7],
    a[8] * p[0] + a[9] * p[1] + a[10] * p[2] + a[11],
  ];
}

export function composeAffine(a: Affine, b: Affine): Affine {
  // a ∘ b : apply b first, then a
  const out: Affine = new Array(12).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
    out[r * 4 + 3] = a[r * 4] * b[3] + a[r * 4 + 1] * b[7] + a[r * 4 + 2] * b[11] + a[r * 4 + 3];
  }
  return out;
}

export function translation(t: Vec3): Affine {
  return [1, 0, 0, t[0], 0, 1, 0, t[1], 0, 0, 1, t[2]];
}

export function rotationZ(deg: number): Affine {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}

export function rotationX(deg: number): Affine {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0];
}

export function rotationY(deg: number): Affine {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0];
}

export function transformMesh(m: Mesh, a: Affine): Mesh {
  const pos = new Float32Array(m.pos.length);
  for (let i = 0; i < m.pos.length; i += 3) {
    const p = applyAffine(a, [m.pos[i], m.pos[i + 1], m.pos[i + 2]]);
    pos[i] = p[0];
    pos[i + 1] = p[1];
    pos[i + 2] = p[2];
  }
  const det =
    a[0] * (a[5] * a[10] - a[6] * a[9]) - a[1] * (a[4] * a[10] - a[6] * a[8]) + a[2] * (a[4] * a[9] - a[5] * a[8]);
  const idx = new Uint32Array(m.idx);
  if (det < 0) for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  return { pos, idx };
}

export function mergeMeshes(meshes: Mesh[]): Mesh {
  let np = 0, ni = 0;
  for (const m of meshes) {
    np += m.pos.length;
    ni += m.idx.length;
  }
  const pos = new Float32Array(np);
  const idx = new Uint32Array(ni);
  let po = 0, io = 0;
  for (const m of meshes) {
    pos.set(m.pos, po);
    for (let i = 0; i < m.idx.length; i++) idx[io + i] = m.idx[i] + po / 3;
    po += m.pos.length;
    io += m.idx.length;
  }
  return { pos, idx };
}

export function triNormal(m: Mesh, t: number): Vec3 {
  const a = m.idx[t * 3] * 3, b = m.idx[t * 3 + 1] * 3, c = m.idx[t * 3 + 2] * 3;
  const ux = m.pos[b] - m.pos[a], uy = m.pos[b + 1] - m.pos[a + 1], uz = m.pos[b + 2] - m.pos[a + 2];
  const vx = m.pos[c] - m.pos[a], vy = m.pos[c + 1] - m.pos[a + 1], vz = m.pos[c + 2] - m.pos[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  return l > 0 ? [nx / l, ny / l, nz / l] : [0, 0, 0];
}

export function triArea(m: Mesh, t: number): number {
  const a = m.idx[t * 3] * 3, b = m.idx[t * 3 + 1] * 3, c = m.idx[t * 3 + 2] * 3;
  const ux = m.pos[b] - m.pos[a], uy = m.pos[b + 1] - m.pos[a + 1], uz = m.pos[b + 2] - m.pos[a + 2];
  const vx = m.pos[c] - m.pos[a], vy = m.pos[c + 1] - m.pos[a + 1], vz = m.pos[c + 2] - m.pos[a + 2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

export function meshVolume(m: Mesh): number {
  let v = 0;
  for (let t = 0; t < m.idx.length; t += 3) {
    const a = m.idx[t] * 3, b = m.idx[t + 1] * 3, c = m.idx[t + 2] * 3;
    v +=
      m.pos[a] * (m.pos[b + 1] * m.pos[c + 2] - m.pos[b + 2] * m.pos[c + 1]) -
      m.pos[a + 1] * (m.pos[b] * m.pos[c + 2] - m.pos[b + 2] * m.pos[c]) +
      m.pos[a + 2] * (m.pos[b] * m.pos[c + 1] - m.pos[b + 1] * m.pos[c]);
  }
  return v / 6;
}

export interface FlatPatch {
  normal: Vec3;
  centroid: Vec3;
  areaMm2: number;
  tris: number[];
}

/**
 * Connected groups of near-coplanar triangles, largest first. The design face of a flat part is
 * the biggest one; the rest are offered as alternatives so nobody has to know what a normal is.
 */
export function flatPatches(m: Mesh, angleDeg = 3, planeTolMm = 0.4, minAreaMm2 = 100): FlatPatch[] {
  const nt = m.idx.length / 3;
  const normals: Vec3[] = new Array(nt);
  const areas = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    normals[t] = triNormal(m, t);
    areas[t] = triArea(m, t);
  }
  // Edge -> triangles adjacency through shared vertex indices.
  const edgeMap = new Map<string, number[]>();
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const a = m.idx[t * 3 + k], b = m.idx[t * 3 + ((k + 1) % 3)];
      const key = a < b ? a + ',' + b : b + ',' + a;
      const l = edgeMap.get(key);
      if (l) l.push(t);
      else edgeMap.set(key, [t]);
    }
  const cosTol = Math.cos((angleDeg * Math.PI) / 180);
  const visited = new Uint8Array(nt);
  const patches: FlatPatch[] = [];
  const centroidOf = (t: number): Vec3 => {
    const a = m.idx[t * 3] * 3, b = m.idx[t * 3 + 1] * 3, c = m.idx[t * 3 + 2] * 3;
    return [(m.pos[a] + m.pos[b] + m.pos[c]) / 3, (m.pos[a + 1] + m.pos[b + 1] + m.pos[c + 1]) / 3, (m.pos[a + 2] + m.pos[b + 2] + m.pos[c + 2]) / 3];
  };
  const order = Array.from({ length: nt }, (_, i) => i).sort((a, b) => areas[b] - areas[a]);
  for (const seed of order) {
    if (visited[seed] || areas[seed] === 0) continue;
    const n0 = normals[seed];
    const c0 = centroidOf(seed);
    const d0 = n0[0] * c0[0] + n0[1] * c0[1] + n0[2] * c0[2];
    const tris: number[] = [];
    const stack = [seed];
    visited[seed] = 1;
    let area = 0;
    const cen: Vec3 = [0, 0, 0];
    while (stack.length) {
      const t = stack.pop()!;
      tris.push(t);
      area += areas[t];
      const c = centroidOf(t);
      cen[0] += c[0] * areas[t];
      cen[1] += c[1] * areas[t];
      cen[2] += c[2] * areas[t];
      for (let k = 0; k < 3; k++) {
        const a = m.idx[t * 3 + k], b = m.idx[t * 3 + ((k + 1) % 3)];
        const key = a < b ? a + ',' + b : b + ',' + a;
        for (const u of edgeMap.get(key) ?? []) {
          if (visited[u]) continue;
          const nu = normals[u];
          if (nu[0] * n0[0] + nu[1] * n0[1] + nu[2] * n0[2] < cosTol) continue;
          const cu = centroidOf(u);
          if (Math.abs(n0[0] * cu[0] + n0[1] * cu[1] + n0[2] * cu[2] - d0) > planeTolMm) continue;
          visited[u] = 1;
          stack.push(u);
        }
      }
    }
    if (area >= minAreaMm2) patches.push({ normal: n0, centroid: [cen[0] / area, cen[1] / area, cen[2] / area], areaMm2: area, tris });
  }
  patches.sort((a, b) => b.areaMm2 - a.areaMm2);
  return patches;
}
