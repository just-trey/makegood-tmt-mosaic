import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { cleanRing, mpBounds, type MultiPolygon } from '../design/poly';
import { toManifold } from './csg';
import type { Mesh } from './mesh';
import type { HeightSampler } from './raycast';

export interface CutterResult {
  /** The cutter, in the surface's local frame. Caller owns it. */
  manifold: Manifold;
  /** Fraction of the region's grid with no part under it (design hanging off the part). */
  offPart: number;
  /** Thinnest wall found under the design, in mm, or null if nothing was under it. */
  minWallMm: number | null;
  /** Shallowest depth actually cut, after thin walls pulled it up. Equals the request when nothing was capped. */
  minDepthMm: number;
  /** Fraction of the design that had to be cut shallower than asked. */
  cappedFraction: number;
}

/**
 * Heights and floor depths on a grid over the region, with cells that have no part under them
 * filled from the nearest that does. Cells off the part borrow a neighbour's height, so the
 * slab stays continuous and simply cuts nothing out there.
 */
class HeightGrid {
  readonly w: number;
  readonly h: number;
  readonly x0: number;
  readonly y0: number;
  readonly height: Float32Array;
  readonly depth: Float32Array;
  readonly onPart: Uint8Array;
  readonly relief: number;
  offCells = 0;
  cappedCells = 0;
  minWall: number | null = null;
  minDepth: number;

  constructor(sampler: HeightSampler, minX: number, minY: number, maxX: number, maxY: number, readonly cell: number, depthMm: number, wallKeepMm: number) {
    this.x0 = minX - cell;
    this.y0 = minY - cell;
    this.w = Math.max(2, Math.ceil((maxX - minX) / cell) + 3);
    this.h = Math.max(2, Math.ceil((maxY - minY) / cell) + 3);
    const n = this.w * this.h;
    this.height = new Float32Array(n);
    this.depth = new Float32Array(n).fill(depthMm);
    this.onPart = new Uint8Array(n);
    this.minDepth = depthMm;
    const known = new Uint8Array(n);
    let queue: number[] = [];
    let zMin = Infinity, zMax = -Infinity;
    for (let j = 0; j < this.h; j++)
      for (let i = 0; i < this.w; i++) {
        const k = j * this.w + i;
        const x = this.x0 + i * cell, y = this.y0 + j * cell;
        const z = sampler.top(x, y);
        if (z === null) {
          this.offCells++;
          continue;
        }
        this.height[k] = z;
        this.onPart[k] = 1;
        known[k] = 1;
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
        const wall = sampler.thickness(x, y);
        if (wall !== null && wall > 0.05) {
          if (this.minWall === null || wall < this.minWall) this.minWall = wall;
          // A thin wall pulls the floor up locally instead of refusing the whole color; the
          // floor stays a hair below the surface so the solid never collapses.
          const allowed = Math.max(0.05, wall - wallKeepMm);
          if (depthMm > allowed) {
            this.depth[k] = allowed;
            this.cappedCells++;
            if (allowed < this.minDepth) this.minDepth = allowed;
          }
        }
        queue.push(k);
      }
    this.relief = queue.length ? zMax - zMin : 0;
    if (queue.length === 0) {
      this.height.fill(sampler.maxZ + 5);
      return;
    }
    while (queue.length) {
      const next: number[] = [];
      for (const k of queue) {
        const i = k % this.w, j = (k - i) / this.w;
        const nb = [i > 0 ? k - 1 : -1, i < this.w - 1 ? k + 1 : -1, j > 0 ? k - this.w : -1, j < this.h - 1 ? k + this.w : -1];
        for (const m of nb)
          if (m >= 0 && !known[m]) {
            known[m] = 1;
            this.height[m] = this.height[k];
            next.push(m);
          }
      }
      queue = next;
    }
  }

  /** A closed "terrain block": top follows the surface plus clearance, bottom follows it minus depth. */
  slab(topClearMm: number): Mesh {
    const { w, h } = this;
    const n = w * h;
    const pos = new Float32Array(n * 6);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const x = this.x0 + i * this.cell, y = this.y0 + j * this.cell;
        pos[k * 3] = x;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = this.height[k] + topClearMm;
        pos[(n + k) * 3] = x;
        pos[(n + k) * 3 + 1] = y;
        pos[(n + k) * 3 + 2] = this.height[k] - this.depth[k];
      }
    const idx: number[] = [];
    for (let j = 0; j < h - 1; j++)
      for (let i = 0; i < w - 1; i++) {
        const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
        idx.push(a, b, d, a, d, c);
        idx.push(n + a, n + d, n + b, n + a, n + c, n + d);
      }
    // Walls around the rectangle, outward facing.
    const wall = (p: number, q: number) => idx.push(p, q, n + q, p, n + q, n + p);
    for (let i = 0; i < w - 1; i++) {
      wall(i + 1, i);
      wall((h - 1) * w + i, (h - 1) * w + i + 1);
    }
    for (let j = 0; j < h - 1; j++) {
      wall(j * w, (j + 1) * w);
      wall((j + 1) * w + w - 1, j * w + w - 1);
    }
    return { pos, idx: Uint32Array.from(idx) };
  }
}

/**
 * A solid that follows the part's surface under a region. The region is extruded by Manifold
 * (a valid solid whatever polygon-clipping handed over) and intersected with a slab whose top
 * sits a little above the surface and whose floor sits `depth` below it, sampled on a grid.
 * The slab's size depends on the surface's area, not the outline's complexity, which is what
 * keeps a thousand-stripe fill affordable. On a flat face the slab is skipped: the prism is
 * cut straight to depth. Built in the surface's local frame (design x/y in mm, Z toward the
 * viewer).
 */
export function buildCutter(wasm: ManifoldToplevel, region: MultiPolygon, sampler: HeightSampler, depthMm: number, wallKeepMm = 0, gridMm = 2, topClearMm = 1): CutterResult {
  const polys: [number, number][][] = [];
  for (const poly of region) for (const ring of poly) {
    const c = cleanRing(ring, 1e-4);
    if (c) polys.push(c);
  }
  const b = mpBounds(region);
  if (polys.length === 0 || !b) throw new Error('empty region');
  const grid = new HeightGrid(sampler, b.minX, b.minY, b.maxX, b.maxY, gridMm, depthMm, wallKeepMm);
  const cs = new wasm.CrossSection(polys, 'EvenOdd');
  let manifold: Manifold;
  if (grid.relief < 0.2 && grid.cappedCells === 0) {
    let top = -Infinity;
    for (let k = 0; k < grid.height.length; k++) if (grid.onPart[k] && grid.height[k] > top) top = grid.height[k];
    if (top === -Infinity) top = sampler.maxZ;
    const prism = cs.extrude(depthMm + topClearMm);
    manifold = prism.translate([0, 0, top - depthMm]);
    prism.delete();
  } else {
    const zLo = sampler.minZ - depthMm - 5, zHi = sampler.maxZ + topClearMm + 5;
    const prism = cs.extrude(zHi - zLo);
    const placed = prism.translate([0, 0, zLo]);
    prism.delete();
    const slab = toManifold(wasm, grid.slab(topClearMm));
    manifold = placed.intersect(slab);
    placed.delete();
    slab.delete();
  }
  cs.delete();
  const cells = Math.max(1, grid.w * grid.h);
  return { manifold, offPart: grid.offCells / cells, minWallMm: grid.minWall, minDepthMm: grid.minDepth, cappedFraction: grid.cappedCells / cells };
}
