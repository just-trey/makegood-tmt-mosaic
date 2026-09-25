import type { PolyFeature } from '../types';

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
