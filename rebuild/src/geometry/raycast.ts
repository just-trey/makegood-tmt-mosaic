import type { Mesh } from './mesh';

/**
 * Heights of a mesh's surface along +Z over a (x, y) point, front-most first. A uniform grid
 * over the mesh's footprint keeps a query to the handful of triangles under the point, which is
 * what makes sampling a few thousand cutter vertices per color affordable.
 */
export class HeightSampler {
  private readonly cell: number;
  private readonly x0: number;
  private readonly y0: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly cells: Int32Array[];
  readonly minZ: number;
  readonly maxZ: number;

  constructor(
    private readonly mesh: Mesh,
    cellMm = 4,
  ) {
    const p = mesh.pos;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 1] > maxY) maxY = p[i + 1];
      if (p[i + 2] < minZ) minZ = p[i + 2];
      if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
    this.minZ = minZ;
    this.maxZ = maxZ;
    this.cell = cellMm;
    this.x0 = minX;
    this.y0 = minY;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cellMm) + 1);
    this.ny = Math.max(1, Math.ceil((maxY - minY) / cellMm) + 1);
    const lists: number[][] = new Array(this.nx * this.ny);
    const idx = mesh.idx;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const tx0 = Math.min(p[a], p[b], p[c]), tx1 = Math.max(p[a], p[b], p[c]);
      const ty0 = Math.min(p[a + 1], p[b + 1], p[c + 1]), ty1 = Math.max(p[a + 1], p[b + 1], p[c + 1]);
      const cx0 = Math.floor((tx0 - minX) / cellMm), cx1 = Math.floor((tx1 - minX) / cellMm);
      const cy0 = Math.floor((ty0 - minY) / cellMm), cy1 = Math.floor((ty1 - minY) / cellMm);
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = cy * this.nx + cx;
          (lists[k] ??= []).push(t / 3);
        }
    }
    this.cells = lists.map((l) => (l ? Int32Array.from(l) : new Int32Array(0)));
  }

  /** All surface heights under (x, y), descending, with the crossing direction (+1 entering solid from above). */
  hits(x: number, y: number): { z: number; enter: boolean }[] {
    const cx = Math.floor((x - this.x0) / this.cell);
    const cy = Math.floor((y - this.y0) / this.cell);
    if (cx < 0 || cy < 0 || cx >= this.nx || cy >= this.ny) return [];
    const list = this.cells[cy * this.nx + cx];
    if (!list || list.length === 0) return [];
    const p = this.mesh.pos, idx = this.mesh.idx;
    const out: { z: number; enter: boolean }[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i] * 3;
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ax = p[a], ay = p[a + 1], bx = p[b], by = p[b + 1], cx2 = p[c], cy2 = p[c + 1];
      const d = (by - cy2) * (ax - cx2) + (cx2 - bx) * (ay - cy2);
      if (Math.abs(d) < 1e-12) continue;
      const l0 = ((by - cy2) * (x - cx2) + (cx2 - bx) * (y - cy2)) / d;
      const l1 = ((cy2 - ay) * (x - cx2) + (ax - cx2) * (y - cy2)) / d;
      const l2 = 1 - l0 - l1;
      const e = -1e-9;
      if (l0 < e || l1 < e || l2 < e) continue;
      const z = l0 * p[a + 2] + l1 * p[b + 2] + l2 * p[c + 2];
      // Triangle winding seen from +Z: CCW means its normal has +Z, i.e. a front face.
      out.push({ z, enter: d > 0 });
    }
    out.sort((u, v) => v.z - u.z);
    return out;
  }

  /** Height of the front-most surface, or null when (x, y) is off the part. */
  top(x: number, y: number): number | null {
    const h = this.hits(x, y);
    return h.length ? h[0].z : null;
  }

  /** Solid thickness behind the front surface at (x, y), or null when off the part. */
  thickness(x: number, y: number): number | null {
    const h = this.hits(x, y);
    if (h.length === 0) return null;
    // Walk down from the top: the first exit after the top entry closes the front wall.
    let depthIn = 0;
    const z0 = h[0].z;
    for (let i = 0; i < h.length; i++) {
      depthIn += h[i].enter ? 1 : -1;
      if (depthIn <= 0 && i > 0) return Math.max(0, z0 - h[i].z);
    }
    return z0 - h[h.length - 1].z;
  }
}
