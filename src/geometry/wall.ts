import type { PolyFeature } from '../types';
import { NOZZLE_MM } from './depth';

/**
 * The surfaces a cut down a flat face's axis leaves the part through, projected onto the face's
 * X/Z plane with each corner's distance behind the face. The wall under a point is the least of
 * those distances among the triangles over it.
 */
export interface WallField {
  /** per triangle: x0, z0, t0, x1, z1, t1, x2, z2, t2, where t is the distance behind the face */
  tri: Float64Array;
  /** per triangle: minX, minZ, maxX, maxZ of its projection */
  box: Float64Array;
  /** per triangle: its smallest t */
  tmin: Float64Array;
  /** triangle indices by ascending `tmin`, so a search can stop once nothing left can be thinner */
  order: Uint32Array;
}

/**
 * How far a triangle's normal must lean out of the face plane to count as a surface the cut can
 * leave through. A vertical side wall projects to a line, and float noise can tip it either way: a
 * part's own outer wall, tipped exit-facing, reads as a 0mm wall along the face's edge.
 */
const MIN_NORMAL_Y = 1e-3;

/**
 * A triangle no further behind the face than this is at the face, not under it: detectFlatPatches
 * groups a face by plane offset to 0.01mm. The shipped footrest has a downward-facing sliver in
 * its face's plane at a corner of the outline, which read as a 0mm wall over 11.80mm
 * (tests/zones.test.ts).
 */
const AT_FACE_MM = 0.01;

/**
 * Exit-facing triangles only: the first surface under the face is always an exit, and the tops of
 * ribs deeper down face back up. That also drops the face itself and a chamfer climbing to it,
 * which meet the face's edge at 0mm. Assumes outward winding, as the Manifold cut of it does.
 */
export function buildWallField(positions: Float32Array, faceY: number, nsign: number): WallField {
  const n = positions.length / 9;
  const tri = new Float64Array(n * 9);
  const box = new Float64Array(n * 4);
  const tmin = new Float64Array(n);
  let kept = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i],
      az = positions[i + 2];
    const bx = positions[i + 3],
      bz = positions[i + 5];
    const cx = positions[i + 6],
      cz = positions[i + 8];
    const ux = bx - ax,
      uy = positions[i + 4] - positions[i + 1],
      uz = bz - az;
    const vx = cx - ax,
      vy = positions[i + 7] - positions[i + 1],
      vz = cz - az;
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0) || Math.abs(ny) < MIN_NORMAL_Y * len) continue;
    // The cut travels -nsign along Y; a surface it leaves through has its outward normal that way.
    if (nsign * ny >= 0) continue;
    const t0 = nsign * (faceY - positions[i + 1]);
    const t1 = nsign * (faceY - positions[i + 4]);
    const t2 = nsign * (faceY - positions[i + 7]);
    if (Math.max(t0, t1, t2) <= AT_FACE_MM) continue;
    const o = kept * 9;
    tri[o] = ax;
    tri[o + 1] = az;
    tri[o + 2] = t0;
    tri[o + 3] = bx;
    tri[o + 4] = bz;
    tri[o + 5] = t1;
    tri[o + 6] = cx;
    tri[o + 7] = cz;
    tri[o + 8] = t2;
    const b = kept * 4;
    box[b] = Math.min(ax, bx, cx);
    box[b + 1] = Math.min(az, bz, cz);
    box[b + 2] = Math.max(ax, bx, cx);
    box[b + 3] = Math.max(az, bz, cz);
    tmin[kept] = Math.min(t0, t1, t2);
    kept++;
  }
  const order = Uint32Array.from({ length: kept }, (_, k) => k);
  order.sort((p, q) => tmin[p] - tmin[q]);
  return {
    tri: tri.subarray(0, kept * 9),
    box: box.subarray(0, kept * 4),
    tmin: tmin.subarray(0, kept),
    order,
  };
}

/**
 * The region's edges bucketed on a grid over its bbox, so a triangle only meets the edges near it
 * and a containment test walks one row: 14-16ms for 60,000 edges on the wheel
 * (scripts/measure-wall.ts).
 */
class EdgeGrid {
  private readonly cells: number[][];
  private readonly stamp: Uint32Array;
  private gen = 0;
  private readonly cw: number;
  private readonly ch: number;

  private constructor(
    readonly e: Float64Array,
    private readonly n: number,
    readonly minX: number,
    readonly minZ: number,
    readonly maxX: number,
    readonly maxZ: number,
    private readonly g: number,
  ) {
    this.cw = (maxX - minX) / g || 1;
    this.ch = (maxZ - minZ) / g || 1;
    this.cells = Array.from({ length: g * g }, () => []);
    this.stamp = new Uint32Array(n);
    for (let k = 0; k < n; k++) {
      const o = k * 4;
      const c0 = this.col(Math.min(e[o], e[o + 2])),
        c1 = this.col(Math.max(e[o], e[o + 2]));
      const r0 = this.row(Math.min(e[o + 1], e[o + 3])),
        r1 = this.row(Math.max(e[o + 1], e[o + 3]));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.cells[r * g + c].push(k);
    }
  }

  static of(feat: PolyFeature): EdgeGrid | null {
    const g = feat.geometry;
    const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as number[][][][];
    const out: number[] = [];
    let minX = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxZ = -Infinity;
    for (const rings of polys)
      for (const ring of rings)
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i],
            q = ring[(i + 1) % ring.length];
          if (p[0] < minX) minX = p[0];
          if (p[0] > maxX) maxX = p[0];
          if (p[1] < minZ) minZ = p[1];
          if (p[1] > maxZ) maxZ = p[1];
          if (p[0] !== q[0] || p[1] !== q[1]) out.push(p[0], p[1], q[0], q[1]);
        }
    const n = out.length / 4;
    if (!n) return null;
    const side = Math.max(1, Math.min(128, Math.ceil(Math.sqrt(n))));
    return new EdgeGrid(Float64Array.from(out), n, minX, minZ, maxX, maxZ, side);
  }

  private col(x: number): number {
    return Math.max(0, Math.min(this.g - 1, Math.floor((x - this.minX) / this.cw)));
  }

  private row(z: number): number {
    return Math.max(0, Math.min(this.g - 1, Math.floor((z - this.minZ) / this.ch)));
  }

  /** Even-odd, across every ring, which is what a turf (Multi)Polygon's holes mean. */
  contains(x: number, z: number): boolean {
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return false;
    const e = this.e;
    const gen = ++this.gen;
    const r = this.row(z);
    let inside = false;
    for (let c = this.col(x); c < this.g; c++)
      for (const k of this.cells[r * this.g + c]) {
        if (this.stamp[k] === gen) continue;
        this.stamp[k] = gen;
        const o = k * 4;
        const az = e[o + 1],
          bz = e[o + 3];
        if (az > z === bz > z) continue;
        const ax = e[o];
        if (x < ax + ((z - az) * (e[o + 2] - ax)) / (bz - az)) inside = !inside;
      }
    return inside;
  }

  /** Every edge whose bbox cell range meets this box, once each. */
  near(minX: number, minZ: number, maxX: number, maxZ: number, visit: (k: number) => void): void {
    if (maxX < this.minX || minX > this.maxX || maxZ < this.minZ || minZ > this.maxZ) return;
    const gen = ++this.gen;
    const c0 = this.col(minX),
      c1 = this.col(maxX),
      r0 = this.row(minZ),
      r1 = this.row(maxZ);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++)
        for (const k of this.cells[r * this.g + c]) {
          if (this.stamp[k] === gen) continue;
          this.stamp[k] = gen;
          visit(k);
        }
  }
}

/**
 * The thinnest wall anywhere under a region, or Infinity where nothing lies under it. Exact, not
 * sampled: distance is linear on a triangle, so its least value over the overlap sits at a triangle
 * corner in the region, a region corner in the triangle, or an edge crossing. A strip narrower than
 * any sample spacing is exactly the wall a sampled check steps over.
 */
export function minWallUnder(field: WallField, feat: PolyFeature): number {
  const grid = EdgeGrid.of(feat);
  if (!grid) return Infinity;
  const { tri, box, tmin, order } = field;
  const e = grid.e;
  let best = Infinity;
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    if (tmin[i] >= best) break;
    const b = i * 4;
    if (box[b + 2] < grid.minX || box[b] > grid.maxX) continue;
    if (box[b + 3] < grid.minZ || box[b + 1] > grid.maxZ) continue;
    const o = i * 9;
    const ax = tri[o],
      az = tri[o + 1],
      at = tri[o + 2];
    const bx = tri[o + 3],
      bz = tri[o + 4],
      bt = tri[o + 5];
    const cx = tri[o + 6],
      cz = tri[o + 7],
      ct = tri[o + 8];
    if (at < best && grid.contains(ax, az)) best = at;
    if (bt < best && grid.contains(bx, bz)) best = bt;
    if (ct < best && grid.contains(cx, cz)) best = ct;
    const d = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    const inTri = (px: number, pz: number): void => {
      const u = ((px - ax) * (cz - az) - (cx - ax) * (pz - az)) / d;
      const v = ((bx - ax) * (pz - az) - (px - ax) * (bz - az)) / d;
      if (u < 0 || v < 0 || u + v > 1) return;
      const t = at + u * (bt - at) + v * (ct - at);
      if (t < best) best = t;
    };
    const cross = (
      px: number,
      pz: number,
      qx: number,
      qz: number,
      sx: number,
      sz: number,
      st: number,
      ex: number,
      ez: number,
      et: number,
    ): void => {
      const rx = ex - sx,
        rz = ez - sz,
        wx = qx - px,
        wz = qz - pz;
      const den = rx * wz - rz * wx;
      if (den === 0) return;
      const s = ((px - sx) * wz - (pz - sz) * wx) / den;
      const r = ((px - sx) * rz - (pz - sz) * rx) / den;
      if (s < 0 || s > 1 || r < 0 || r > 1) return;
      const t = st + s * (et - st);
      if (t < best) best = t;
    };
    grid.near(box[b], box[b + 1], box[b + 2], box[b + 3], (k) => {
      const eo = k * 4;
      const px = e[eo],
        pz = e[eo + 1],
        qx = e[eo + 2],
        qz = e[eo + 3];
      inTri(px, pz);
      inTri(qx, qz);
      cross(px, pz, qx, qz, ax, az, at, bx, bz, bt);
      cross(px, pz, qx, qz, bx, bz, bt, cx, cz, ct);
      cross(px, pz, qx, qz, cx, cz, ct, ax, az, at);
    });
  }
  return best;
}

/** A part's triangles bucketed on a uniform grid, for short rays cast from its surface inward. */
export interface RayMesh {
  /** per triangle: its three corners, xyz */
  tri: Float64Array;
  /** per triangle: its unit outward normal */
  nrm: Float64Array;
  min: number[];
  cell: number;
  dims: number[];
  /** triangles of cell c are `items[start[c]]` up to `items[start[c + 1]]` */
  start: Uint32Array;
  items: Uint32Array;
  stamp: Uint32Array;
  gen: number;
}

export function buildRayMesh(positions: Float32Array): RayMesh {
  const n = (positions.length / 9) | 0;
  const tri = Float64Array.from(positions.subarray(0, n * 9));
  const nrm = new Float64Array(n * 3);
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 9; i += 3)
    for (let a = 0; a < 3; a++) {
      const c = tri[i + a];
      if (c < min[a]) min[a] = c;
      if (c > max[a]) max[a] = c;
    }
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ux = tri[o + 3] - tri[o],
      uy = tri[o + 4] - tri[o + 1],
      uz = tri[o + 5] - tri[o + 2];
    const vx = tri[o + 6] - tri[o],
      vy = tri[o + 7] - tri[o + 1],
      vz = tri[o + 8] - tri[o + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nrm[t * 3] = nx / len;
    nrm[t * 3 + 1] = ny / len;
    nrm[t * 3 + 2] = nz / len;
  }
  const ext = max.map((m, a) => Math.max(m - min[a], 1e-6));
  // About two triangles per occupied cell: a surface mesh fills cells by area, not volume.
  const area = ext[0] * ext[1] + ext[1] * ext[2] + ext[0] * ext[2];
  const cell = Math.max(Math.sqrt((2 * area) / Math.max(n, 1)), 0.25);
  const dims = ext.map((e) => Math.min(256, Math.max(1, Math.ceil(e / cell))));
  const idx = (c: number, a: number): number =>
    Math.min(dims[a] - 1, Math.max(0, Math.floor((c - min[a]) / cell)));
  const range = new Int32Array(n * 6);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    for (let a = 0; a < 3; a++) {
      range[t * 6 + a] = idx(Math.min(tri[o + a], tri[o + 3 + a], tri[o + 6 + a]), a);
      range[t * 6 + 3 + a] = idx(Math.max(tri[o + a], tri[o + 3 + a], tri[o + 6 + a]), a);
    }
  }
  const start = new Uint32Array(dims[0] * dims[1] * dims[2] + 1);
  const visit = (t: number, f: (c: number) => void): void => {
    const r = t * 6;
    for (let x = range[r]; x <= range[r + 3]; x++)
      for (let y = range[r + 1]; y <= range[r + 4]; y++)
        for (let z = range[r + 2]; z <= range[r + 5]; z++) f((x * dims[1] + y) * dims[2] + z);
  };
  for (let t = 0; t < n; t++) visit(t, (c) => start[c + 1]++);
  for (let c = 1; c < start.length; c++) start[c] += start[c - 1];
  const fill = start.slice(0, -1);
  const items = new Uint32Array(start[start.length - 1]);
  for (let t = 0; t < n; t++) visit(t, (c) => (items[fill[c]++] = t));
  return { tri, nrm, min, cell, dims, start, items, stamp: new Uint32Array(n), gen: 0 };
}

/**
 * As AT_FACE_MM: a surface this close to where the ray starts is the one it starts on. Tested on the
 * plane as well as the hit: a ray started on the lip of a groove (below) runs down its side, which
 * read as a 0.01-0.02mm wall (drop the plane test and re-run scripts/measure-wall.ts).
 */
const AT_SURFACE_MM = 0.01;

/**
 * A gap the ray crosses back into material within this is not the back of the wall. The chair has
 * shallow grooves along some chart edges: a ray just beside one leaves through its near-vertical side
 * and re-enters through its far side, which clamped the default 1mm depth on chair-wing-left (the
 * "leaves the default depth alone" cases in tests/chair-build.test.ts fail without it).
 */
const REENTRY_GAP_MM = NOZZLE_MM;

/**
 * Distance along the unit ray (o, d) to the first surface it leaves the part through and stays out
 * of, or Infinity when none lies within `maxT`. A hit's side comes from the triangle's outward
 * normal, so the surface the ray starts on is the one it enters through.
 */
export function exitDistance(
  m: RayMesh,
  o: readonly number[],
  d: readonly number[],
  maxT: number,
): number {
  const { tri, nrm, min, cell, dims, start, items, stamp } = m;
  const gen = ++m.gen;
  const reach = maxT + REENTRY_GAP_MM;
  // Clip the ray to the grid's box, then walk its cells in order (Amanatides-Woo).
  let t0 = 0,
    t1 = reach;
  for (let a = 0; a < 3; a++) {
    const lo = min[a],
      hi = min[a] + dims[a] * cell;
    if (d[a] === 0) {
      if (o[a] < lo || o[a] > hi) return Infinity;
      continue;
    }
    const ta = (lo - o[a]) / d[a],
      tb = (hi - o[a]) / d[a];
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  if (t0 > t1) return Infinity;
  const cur = [0, 1, 2].map((a) =>
    Math.min(dims[a] - 1, Math.max(0, Math.floor((o[a] + t0 * d[a] - min[a]) / cell))),
  );
  const step = d.map((v) => Math.sign(v));
  const tNext = [0, 1, 2].map((a) =>
    step[a] === 0 ? Infinity : (min[a] + (cur[a] + (step[a] > 0 ? 1 : 0)) * cell - o[a]) / d[a],
  );
  const tDelta = d.map((v) => (v === 0 ? Infinity : cell / Math.abs(v)));
  // Signed: +t leaves the part, -t enters it.
  const hits: number[] = [];
  for (;;) {
    const c = (cur[0] * dims[1] + cur[1]) * dims[2] + cur[2];
    for (let k = start[c]; k < start[c + 1]; k++) {
      const t = items[k];
      if (stamp[t] === gen) continue;
      stamp[t] = gen;
      const nx = nrm[t * 3],
        ny = nrm[t * 3 + 1],
        nz = nrm[t * 3 + 2];
      const facing = nx * d[0] + ny * d[1] + nz * d[2];
      if (facing === 0) continue;
      const p = t * 9;
      const plane = (o[0] - tri[p]) * nx + (o[1] - tri[p + 1]) * ny + (o[2] - tri[p + 2]) * nz;
      if (Math.abs(plane) < AT_SURFACE_MM) continue;
      const hit = rayTri(tri, p, o, d);
      if (hit > AT_SURFACE_MM && hit <= reach) hits.push(facing > 0 ? hit : -hit);
    }
    const a = tNext[0] < tNext[1] ? (tNext[0] < tNext[2] ? 0 : 2) : tNext[1] < tNext[2] ? 1 : 2;
    if (tNext[a] > t1) break;
    cur[a] += step[a];
    if (cur[a] < 0 || cur[a] >= dims[a]) break;
    tNext[a] += tDelta[a];
  }
  hits.sort((p, q) => Math.abs(p) - Math.abs(q));
  for (let i = 0; i < hits.length; i++) {
    const t = hits[i];
    if (t < 0 || t > maxT) continue;
    let back = false;
    for (let j = i + 1; j < hits.length && Math.abs(hits[j]) < t + REENTRY_GAP_MM; j++)
      if (hits[j] < 0) back = true;
    if (!back) return t;
  }
  return Infinity;
}

/** Möller-Trumbore, two-sided: the caller has already picked the side. */
function rayTri(tri: Float64Array, p: number, o: readonly number[], d: readonly number[]): number {
  const e1x = tri[p + 3] - tri[p],
    e1y = tri[p + 4] - tri[p + 1],
    e1z = tri[p + 5] - tri[p + 2];
  const e2x = tri[p + 6] - tri[p],
    e2y = tri[p + 7] - tri[p + 1],
    e2z = tri[p + 8] - tri[p + 2];
  const px = d[1] * e2z - d[2] * e2y,
    py = d[2] * e2x - d[0] * e2z,
    pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det;
  const sx = o[0] - tri[p],
    sy = o[1] - tri[p + 1],
    sz = o[2] - tri[p + 2];
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return Infinity;
  const qx = sy * e1z - sz * e1y,
    qy = sz * e1x - sx * e1z,
    qz = sx * e1y - sy * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/**
 * Walls sampled on a square grid in a chart's UV, `step` mm apart: point (i, j) sits at
 * (i * step, j * step), stored at `(i - i0) * nj + (j - j0)`. NaN where the grid point is off the
 * chart; Infinity where no exit lies within `cap`.
 */
export interface SampledWall {
  step: number;
  cap: number;
  i0: number;
  j0: number;
  ni: number;
  nj: number;
  wall: Float32Array;
  /** indices of the finite walls, thinnest first */
  order: Uint32Array;
}

export function sortSampledWall(f: Omit<SampledWall, 'order'>): SampledWall {
  const finite: number[] = [];
  for (let k = 0; k < f.wall.length; k++) if (Number.isFinite(f.wall[k])) finite.push(k);
  finite.sort((p, q) => f.wall[p] - f.wall[q]);
  return { ...f, order: Uint32Array.from(finite) };
}

/**
 * The thinnest wall under a region, or Infinity: the samples inside it, then its outline every
 * `step`. An outline point reads the four samples round it, so a stroke too narrow to hold one is
 * still bounded. Where one of those is off the chart, the point is near the chart's edge, where the
 * wall can fall fast, so `atEdge` measures the point itself: chair-handle-left reads 4.61mm without
 * it, 2.03mm with (scripts/measure-wall.ts).
 */
export function minSampledWallUnder(
  f: SampledWall,
  feat: PolyFeature,
  atEdge: (u: number, v: number) => number,
): number {
  const grid = EdgeGrid.of(feat);
  if (!grid) return Infinity;
  const { step, i0, j0, ni, nj, wall, order } = f;
  let best = Infinity;
  for (let oi = 0; oi < order.length; oi++) {
    const k = order[oi];
    const i = i0 + Math.floor(k / nj),
      j = j0 + (k % nj);
    if (grid.contains(i * step, j * step)) {
      best = wall[k];
      break;
    }
  }
  const sample = (i: number, j: number): number =>
    i < i0 || j < j0 || i >= i0 + ni || j >= j0 + nj ? NaN : wall[(i - i0) * nj + (j - j0)];
  const e = grid.e;
  for (let k = 0; k < e.length; k += 4) {
    const n = Math.max(1, Math.ceil(Math.hypot(e[k + 2] - e[k], e[k + 3] - e[k + 1]) / step));
    for (let s = 0; s <= n; s++) {
      const u = e[k] + ((e[k + 2] - e[k]) * s) / n,
        v = e[k + 1] + ((e[k + 3] - e[k + 1]) * s) / n;
      const i = Math.floor(u / step),
        j = Math.floor(v / step);
      let offChart = false;
      for (const w of [sample(i, j), sample(i + 1, j), sample(i, j + 1), sample(i + 1, j + 1)])
        if (Number.isNaN(w)) offChart = true;
        else if (w < best) best = w;
      if (offChart) best = Math.min(best, atEdge(u, v));
    }
  }
  return best;
}
