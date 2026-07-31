import * as THREE from 'three';
import * as turf from '@turf/turf';
import type { PolyFeature } from '../types';
import {
  extrudeRegionToSoup,
  manifoldDelete,
  manifoldIsValid,
  manifoldToMeshes,
  soupToManifold,
  type ManifoldAPI,
  type ManifoldSolid,
} from './manifold';
import {
  rotatePointY,
  type CutterOptions,
  type DesignPlacement,
  type FillExtent,
  type ZoneFrame,
  type ZoneMapper,
} from './zones';

/**
 * Target edge length (mm) the flat cutter prism is refined to before warping. Short enough that
 * bending a refined face onto the surface tracks its curvature well below print resolution;
 * halved once on retry when the warped solid comes out non-manifold.
 */
export const WARP_REFINE_MM = 1.5;

/**
 * Refinement (mm) for a fill-mode cutter, which spans the whole zone rather than a sticker-sized
 * patch. At WARP_REFINE_MM a full chair panel would warp hundreds of thousands of triangles per
 * color; the coarser step cuts that ~4x. Pattern edges are the visible detail here and they keep
 * their own resolution — only the flat interior of each shape is subdivided more coarsely.
 */
export const FILL_REFINE_MM = 3;

/**
 * How far (mm) outside the chart a cutter vertex may land and still be snapped to the nearest
 * chart triangle. Anything past this is misplaced artwork, and fails the cut rather than being
 * silently dragged onto the surface.
 *
 * The number is set by the bake, not by taste: a part's baked claim on a zone (`subRegions`) is
 * slightly more generous than the triangulation inside it, so points within the claim can sit a
 * little off every real triangle. Measured across all 25 shipped chair charts (2026-07-31): worst
 * **2.150mm** (`right/chair-wing-right`), then 2.104 (`back/chair-seat-back-top`) and 2.102
 * (`left/chair-storage-left`); every other chart stays under 1mm. So 3 bounds a real bake artifact
 * with ~28% headroom, and `tests/chair-zones.test.ts` pins it — a re-bake that widens the gap fails
 * CI instead of silently dropping cuts.
 *
 * **Measure this by refinement, never by rastering.** The depth is a distance function, so it is
 * 1-Lipschitz: sampling it on a grid of step h under-reports by up to h/√2, and the peaks here are
 * narrow spikes where the claim outline pokes a thin tendril past the end of the triangulation. A
 * 1mm raster put the worst at 1.915mm and made 2 look like it had headroom; it does not. The test
 * seeds from a coarse scan and then hill-climbs each seed, which is what produces the figures above.
 *
 * This used to be 0.5 for stickers with a separate 2mm for fills, on the theory that only a fill
 * runs along the clipped boundary. That was wrong: the gaps sit inside the claim, so they hit both
 * modes identically — a sticker large enough to cover one just failed, which is what dropped two
 * colors off the chair's seat-back parts.
 *
 * The real fix is re-baking so each claim matches its triangulation, which would let this go back
 * to a tight misplacement guard instead of tracking a bake artifact. See README tech debt.
 */
export const CHART_SNAP_MM = 3;

/**
 * One baked UV chart: a patch of a part's surface mesh unwrapped into a flat 2D space where
 * 1 UV unit = 1 mm of surface (true scale). Produced by the zone bake pipeline (Phase 4) and
 * loaded from the kind's zones sidecar (Phase 5); tests hand-build analytic ones.
 *
 * Convention: UV is the surface as seen from OUTSIDE, +v up ("up" per the zone's bake config),
 * u/v right-handed. Triangle winding is CCW in UV when `normalSign` is +1; −1 says the baked
 * winding reads CW-from-outside and the computed normals must be flipped.
 */
export interface ConformalChart {
  /** chart-vertex 3D positions in the part's native frame, interleaved xyz (mm) */
  positions3: Float32Array;
  /** chart-vertex UVs in the zone's shared 2D space, interleaved u,v (true mm) */
  uv: Float32Array;
  /** chart-local vertex index triples */
  triangles: Uint32Array;
  normalSign: 1 | -1;
  /** zone outer boundary ring in UV mm (need not repeat the first point) */
  boundary: number[][];
  /** interior hole rings in UV mm */
  holes?: number[][][];
  /**
   * This part's own slice of the zone, in UV mm — what the cutter is clipped to. Absent (or a
   * single region equal to the zone outline) while a zone lives on one printed part; on a zone
   * that spans a seam each part gets only its own share, so artwork can't be cut past the chart
   * this mapper can actually warp against. `boundary` stays the whole zone: the template is
   * zone-wide regardless of how many parts carry it.
   */
  subRegions?: { outer: number[][]; holes: number[][][] }[];
  /**
   * The whole zone's UV bbox, measured across every part's chart at bake time — the template's
   * coordinate space. Placement and fill tiling anchor here rather than on this chart's own
   * vertices, so a zone spanning a seam places one design across the parts (each part cutting its
   * share of it) instead of a whole copy centred on each half. Absent for a hand-built chart, which
   * falls back to this chart's UV bbox — identical for a single-part zone.
   */
  zoneBounds?: { minU: number; minV: number; maxU: number; maxV: number };
}

interface ChartHit {
  tri: number;
  b0: number;
  b1: number;
  b2: number;
  /** UV distance (mm) from the query to the triangle; 0 when inside */
  dist: number;
}

/**
 * The curved-surface counterpart of FlatZoneMapper: artwork is placed and clipped in the chart's
 * flat UV mm space exactly like on a flat face, extruded to a flat prism in (u, depth, v), then
 * bent onto the surface by refining the prism and mapping every vertex (u, h, v) →
 * S(u,v) + h·N̂(u,v) — S by barycentric lookup into the chart, N̂ the smooth (area-weighted
 * per-vertex) surface normal, so h<0 carves a constant-thickness pocket into the material and
 * the overshoot pokes out along the local outward normal. The warped cutter feeds the same
 * Manifold difference/intersection pipeline as a flat prism.
 */
export class ConformalZoneMapper implements ZoneMapper {
  readonly faceNormal: number[] | null;
  readonly nsign: number;

  private readonly vertNormals: Float32Array;
  /** per-triangle cached UV corners + 1/det of the UV linear map (0 = UV-degenerate, unusable) */
  private readonly triUV: Float64Array;
  private readonly invDet: Float64Array;
  private readonly uvCu: number;
  private readonly uvCv: number;
  private readonly uvBBox: FillExtent;
  // uniform UV grid over the chart bbox for triangle lookup
  private readonly gridMinU: number;
  private readonly gridMinV: number;
  private readonly cellU: number;
  private readonly cellV: number;
  private readonly gridNU: number;
  private readonly gridNV: number;
  private readonly cells: number[][];
  private boundaryComputed = false;
  private boundaryPoly: PolyFeature | null = null;

  /**
   * `wasm` may be null for a read-only mapper (the gizmo builds one synchronously just to read
   * frameAt/placer/boundary, where the boolean engine isn't needed and may not be loaded yet);
   * buildCutter throws rather than silently dropping a cut if one is ever asked for.
   */
  constructor(
    private readonly wasm: ManifoldAPI | null,
    private readonly chart: ConformalChart,
    readonly zoneId: string | null = null,
  ) {
    const { positions3, uv, triangles, normalSign } = chart;
    const vertCount = (positions3.length / 3) | 0;
    if (uv.length !== vertCount * 2)
      throw new Error(`chart uv count ${uv.length / 2} != vertex count ${vertCount}`);
    if (triangles.length % 3 !== 0)
      throw new Error('chart triangle index count not divisible by 3');
    const triCount = (triangles.length / 3) | 0;
    if (!triCount) throw new Error('chart has no triangles');
    // Validate indices here, where the (disk-loaded, possibly mismatched) sidecar data enters:
    // an out-of-range index would NaN-poison the normals and only surface later as a mysterious
    // failed cut.
    for (const i of triangles)
      if (i >= vertCount) throw new Error(`chart triangle index ${i} >= vertex count ${vertCount}`);

    // Per-vertex smooth normals (area-weighted: unnormalized cross products sum) and the
    // area-weighted average chart normal for the ZoneMapper faceNormal/nsign contract.
    const acc = new Float64Array(vertCount * 3);
    const avg = [0, 0, 0];
    this.triUV = new Float64Array(triCount * 6);
    this.invDet = new Float64Array(triCount);
    for (let t = 0; t < triCount; t++) {
      const i0 = triangles[t * 3],
        i1 = triangles[t * 3 + 1],
        i2 = triangles[t * 3 + 2];
      const ax = positions3[i0 * 3],
        ay = positions3[i0 * 3 + 1],
        az = positions3[i0 * 3 + 2];
      const e1x = positions3[i1 * 3] - ax,
        e1y = positions3[i1 * 3 + 1] - ay,
        e1z = positions3[i1 * 3 + 2] - az;
      const e2x = positions3[i2 * 3] - ax,
        e2y = positions3[i2 * 3 + 1] - ay,
        e2z = positions3[i2 * 3 + 2] - az;
      const cx = (e1y * e2z - e1z * e2y) * normalSign;
      const cy = (e1z * e2x - e1x * e2z) * normalSign;
      const cz = (e1x * e2y - e1y * e2x) * normalSign;
      for (const vi of [i0, i1, i2]) {
        acc[vi * 3] += cx;
        acc[vi * 3 + 1] += cy;
        acc[vi * 3 + 2] += cz;
      }
      avg[0] += cx;
      avg[1] += cy;
      avg[2] += cz;

      const u0 = uv[i0 * 2],
        v0 = uv[i0 * 2 + 1];
      const u1 = uv[i1 * 2],
        v1 = uv[i1 * 2 + 1];
      const u2 = uv[i2 * 2],
        v2 = uv[i2 * 2 + 1];
      this.triUV.set([u0, v0, u1, v1, u2, v2], t * 6);
      const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
      this.invDet[t] = Math.abs(det) > 1e-9 ? 1 / det : 0;
    }
    this.vertNormals = new Float32Array(vertCount * 3);
    for (let v = 0; v < vertCount; v++) {
      const nx = acc[v * 3],
        ny = acc[v * 3 + 1],
        nz = acc[v * 3 + 2];
      const len = Math.hypot(nx, ny, nz) || 1;
      this.vertNormals[v * 3] = nx / len;
      this.vertNormals[v * 3 + 1] = ny / len;
      this.vertNormals[v * 3 + 2] = nz / len;
    }
    const avgLen = Math.hypot(avg[0], avg[1], avg[2]);
    this.faceNormal = avgLen > 0 ? [avg[0] / avgLen, avg[1] / avgLen, avg[2] / avgLen] : null;
    this.nsign = this.faceNormal && this.faceNormal[1] < 0 ? -1 : 1;

    // UV bbox of this chart's own vertices — the lookup grid's extent, and the placement anchor
    // when the bake supplied no zone-wide bbox. Lookup cell ≈ 2× median UV edge so a typical query
    // lands in a cell holding a handful of triangles.
    let minU = Infinity,
      maxU = -Infinity,
      minV = Infinity,
      maxV = -Infinity;
    for (let v = 0; v < vertCount; v++) {
      const u = uv[v * 2],
        vv = uv[v * 2 + 1];
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (vv < minV) minV = vv;
      if (vv > maxV) maxV = vv;
    }
    // Anchor placement/fill on the zone's bbox when the bake baked one: it is the same for every
    // part of a seam-spanning zone, where each chart's own bbox is only that part's half.
    const zb = chart.zoneBounds;
    const anchor =
      zb && zb.maxU > zb.minU && zb.maxV > zb.minV
        ? { minX: zb.minU, minY: zb.minV, maxX: zb.maxU, maxY: zb.maxV }
        : { minX: minU, minY: minV, maxX: maxU, maxY: maxV };
    this.uvCu = (anchor.minX + anchor.maxX) / 2;
    this.uvCv = (anchor.minY + anchor.maxY) / 2;
    this.uvBBox = anchor;

    const edgeLens: number[] = [];
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) {
        const a = triangles[t * 3 + k],
          b = triangles[t * 3 + ((k + 1) % 3)];
        edgeLens.push(Math.hypot(uv[a * 2] - uv[b * 2], uv[a * 2 + 1] - uv[b * 2 + 1]));
      }
    }
    edgeLens.sort((a, b) => a - b);
    const median = edgeLens[(edgeLens.length / 2) | 0] || 1;
    const cell = Math.max(2 * median, 1e-3);
    this.gridMinU = minU;
    this.gridMinV = minV;
    this.gridNU = Math.min(512, Math.max(1, Math.ceil((maxU - minU) / cell)));
    this.gridNV = Math.min(512, Math.max(1, Math.ceil((maxV - minV) / cell)));
    this.cellU = (maxU - minU) / this.gridNU || 1;
    this.cellV = (maxV - minV) / this.gridNV || 1;
    this.cells = Array.from({ length: this.gridNU * this.gridNV }, () => []);
    for (let t = 0; t < triCount; t++) {
      if (!this.invDet[t]) continue; // UV-degenerate: no invertible barycentric map
      const o = t * 6;
      const tMinU = Math.min(this.triUV[o], this.triUV[o + 2], this.triUV[o + 4]);
      const tMaxU = Math.max(this.triUV[o], this.triUV[o + 2], this.triUV[o + 4]);
      const tMinV = Math.min(this.triUV[o + 1], this.triUV[o + 3], this.triUV[o + 5]);
      const tMaxV = Math.max(this.triUV[o + 1], this.triUV[o + 3], this.triUV[o + 5]);
      const c0 = this.cellIdxU(tMinU),
        c1 = this.cellIdxU(tMaxU);
      const r0 = this.cellIdxV(tMinV),
        r1 = this.cellIdxV(tMaxV);
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) this.cells[r * this.gridNU + c].push(t);
    }
  }

  private cellIdxU(u: number): number {
    return Math.min(this.gridNU - 1, Math.max(0, Math.floor((u - this.gridMinU) / this.cellU)));
  }
  private cellIdxV(v: number): number {
    return Math.min(this.gridNV - 1, Math.max(0, Math.floor((v - this.gridMinV) / this.cellV)));
  }

  /**
   * Barycentric coordinates of the point of `tri` closest to (u,v) in UV, and the UV distance to
   * it: inside → the point's own barycentrics at distance 0, outside → clamped to the nearest
   * edge/corner.
   */
  private closestOnTri(t: number, u: number, v: number): ChartHit {
    const o = t * 6;
    const u0 = this.triUV[o],
      v0 = this.triUV[o + 1],
      u1 = this.triUV[o + 2],
      v1 = this.triUV[o + 3],
      u2 = this.triUV[o + 4],
      v2 = this.triUV[o + 5];
    const inv = this.invDet[t];
    const b1 = ((u - u0) * (v2 - v0) - (v - v0) * (u2 - u0)) * inv;
    const b2 = ((v - v0) * (u1 - u0) - (u - u0) * (v1 - v0)) * inv;
    const b0 = 1 - b1 - b2;
    const eps = -1e-9;
    if (b0 >= eps && b1 >= eps && b2 >= eps) return { tri: t, b0, b1, b2, dist: 0 };
    // clamp to the nearest of the three edges
    let best: ChartHit | null = null;
    const edges: [number, number, number, number, number][] = [
      [u0, v0, u1, v1, 0],
      [u1, v1, u2, v2, 1],
      [u2, v2, u0, v0, 2],
    ];
    for (const [ax, ay, bx, by, e] of edges) {
      const dx = bx - ax,
        dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const s = len2 > 0 ? Math.min(1, Math.max(0, ((u - ax) * dx + (v - ay) * dy) / len2)) : 0;
      const qx = ax + s * dx,
        qy = ay + s * dy;
      const d = Math.hypot(u - qx, v - qy);
      if (!best || d < best.dist) {
        const bb = [0, 0, 0];
        bb[e] = 1 - s;
        bb[(e + 1) % 3] = s;
        best = { tri: t, b0: bb[0], b1: bb[1], b2: bb[2], dist: d };
      }
    }
    return best!;
  }

  /**
   * Nearest chart triangle to (u,v): ring search outward from the containing grid cell, stopping
   * once no closer triangle can exist in an unvisited ring. Always returns the best candidate
   * found — callers decide whether `dist` (0 = inside the chart) is within tolerance.
   */
  private lookup(u: number, v: number): ChartHit | null {
    const cu = this.cellIdxU(u),
      cv = this.cellIdxV(v);
    const maxRing = Math.max(this.gridNU, this.gridNV);
    const minCell = Math.min(this.cellU, this.cellV);
    let best: ChartHit | null = null;
    for (let r = 0; r <= maxRing; r++) {
      if (best && best.dist === 0) break;
      // any triangle in ring r is at least (r-1)*minCell away; nothing further out can win
      if (best && best.dist < (r - 1) * minCell) break;
      for (let dr = -r; dr <= r; dr++) {
        for (let dc = -r; dc <= r; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== r) continue;
          const row = cv + dr,
            col = cu + dc;
          if (row < 0 || row >= this.gridNV || col < 0 || col >= this.gridNU) continue;
          for (const t of this.cells[row * this.gridNU + col]) {
            const hit = this.closestOnTri(t, u, v);
            if (!best || hit.dist < best.dist) best = hit;
            if (best.dist === 0) return best;
          }
        }
      }
    }
    return best;
  }

  /** S(u,v) and N̂(u,v): barycentric interpolation of chart positions and smooth vertex normals. */
  private surfacePoint(hit: ChartHit): { p: number[]; n: number[] } {
    const { positions3, triangles } = this.chart;
    const i0 = triangles[hit.tri * 3],
      i1 = triangles[hit.tri * 3 + 1],
      i2 = triangles[hit.tri * 3 + 2];
    const p = [0, 0, 0];
    const n = [0, 0, 0];
    const vs = [i0, i1, i2];
    const bs = [hit.b0, hit.b1, hit.b2];
    for (let k = 0; k < 3; k++) {
      const vi = vs[k],
        b = bs[k];
      for (let a = 0; a < 3; a++) {
        p[a] += b * positions3[vi * 3 + a];
        n[a] += b * this.vertNormals[vi * 3 + a];
      }
    }
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return { p, n: [n[0] / len, n[1] / len, n[2] / len] };
  }

  /**
   * SVG-space → chart UV (mm). Unlike the flat mapper there is no per-face mirror correction:
   * the bake convention already orients UV as seen from outside the surface, so artwork reads
   * right by construction — only the user's own flips apply. Rect-style placement: 1:1 in mm,
   * auto-centered on the zone's UV bbox (this chart's own bbox only when the bake supplied none),
   * so every part of a seam-spanning zone maps the design to the same place in zone UV.
   */
  placer(p: DesignPlacement): (pt: number[]) => number[] {
    const { uvCu, uvCv } = this;
    return (pt: number[]): number[] => {
      let u = (pt[0] - p.svgC.cx) * p.mmPerUnit * p.xFlip;
      let v = (pt[1] - p.svgC.cy) * p.mmPerUnit * p.zMul;
      if (p.rotationDeg) {
        const r = rotatePointY(u, v, 0, 0, p.rotationDeg);
        u = r[0];
        v = r[1];
      }
      return [u + p.offX + uvCu, v + p.offZ + uvCv];
    };
  }

  /**
   * The UV region a cut on this chart is clipped to: this part's own sub-regions when the bake
   * supplied them (a MultiPolygon, since a part's share of a zone can be several islands),
   * otherwise the whole zone outline. Identical geometry for a single-part zone — every chart's
   * only sub-region is the zone itself — so this is inert until a zone actually spans a seam.
   */
  boundary(): PolyFeature | null {
    if (this.boundaryComputed) return this.boundaryPoly;
    this.boundaryComputed = true;
    const close = (ring: number[][]): number[][] => {
      const r = ring.map((p) => [p[0], p[1]]);
      const a = r[0],
        b = r[r.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) r.push([a[0], a[1]]);
      return r;
    };
    const sub = this.chart.subRegions;
    try {
      this.boundaryPoly = sub?.length
        ? (turf.multiPolygon(
            sub.map((r) => [close(r.outer), ...r.holes.map(close)]),
          ) as PolyFeature)
        : (turf.polygon([
            close(this.chart.boundary),
            ...(this.chart.holes ?? []).map(close),
          ]) as PolyFeature);
    } catch {
      this.boundaryPoly = null;
    }
    return this.boundaryPoly;
  }

  /**
   * The zone's UV bounding box (this chart's own when the bake supplied none), not the baked
   * boundary's: a fill tiles over everything the zone can carry, and `boundary()` still clips the
   * result back to this part's share of it. Zone-wide so the tile grid of a seam-spanning zone has
   * one origin and phase across the parts rather than restarting on each.
   */
  fillExtent(): FillExtent | null {
    const bb = this.uvBBox;
    return bb.maxX > bb.minX && bb.maxY > bb.minY ? bb : null;
  }

  resolveCutDepth(depthSetting: number): number {
    return depthSetting;
  }

  buildCutter(
    feat: PolyFeature,
    depth: number,
    overshoot: number,
    opts?: CutterOptions,
  ): Float32Array | null {
    if (!this.wasm) throw new Error('ConformalZoneMapper: buildCutter needs the boolean engine');
    // Flat prism in cutter space: x=u, z=v, y=−h ∈ [−overshoot, +depth]. The warp
    // (u,v,h) → S + h·N̂ is orientation-REVERSING for a right-handed as-seen-from-outside UV
    // chart (det[S_u, N̂, S_v] = −1 — peeling the surface flat with h up flips handedness), so
    // the prism is extruded MIRRORED (sign=−1 keeps its winding outward) and h negated in the
    // warp; the two reflections cancel and the warped cutter comes out a proper outward solid
    // instead of an inside-out one that would subtract its own complement.
    const soup = extrudeRegionToSoup(feat, 0, depth, overshoot, -1);
    if (!soup || !soup.length) return null;
    // A warp that comes out non-manifold (usually pocket depth exceeding local concave curvature
    // pinching the inner surface) sometimes resolves at finer refinement; retry once at L/2.
    const base = opts?.refineMM && opts.refineMM > 0 ? opts.refineMM : WARP_REFINE_MM;
    for (const L of [base, base / 2]) {
      const out = this.tryWarp(soup, L, CHART_SNAP_MM);
      if (out === 'outside') return null;
      if (out) return out;
    }
    return null;
  }

  private tryWarp(
    soup: Float32Array,
    refineLen: number,
    snapMM: number,
  ): Float32Array | 'outside' | null {
    let prism: ManifoldSolid | null = null;
    let fine: ManifoldSolid | null = null;
    let warped: ManifoldSolid | null = null;
    let outside = false;
    try {
      prism = soupToManifold(this.wasm!, soup);
      if (!manifoldIsValid(prism)) return null;
      fine = prism.refineToLength(refineLen);
      // Never throw from inside the WASM callback (no clean unwind through the C++ frames) —
      // flag out-of-chart vertices, keep warping with the clamped hit, and fail after.
      warped = fine.warpBatch((verts, count) => {
        for (let i = 0; i < count; i++) {
          const u = verts[i * 3],
            h = -verts[i * 3 + 1], // mirrored prism: y=−h (see buildCutter)
            v = verts[i * 3 + 2];
          const hit = this.lookup(u, v);
          if (!hit) {
            outside = true;
            continue;
          }
          if (hit.dist > snapMM) outside = true;
          const { p, n } = this.surfacePoint(hit);
          verts[i * 3] = p[0] + h * n[0];
          verts[i * 3 + 1] = p[1] + h * n[1];
          verts[i * 3 + 2] = p[2] + h * n[2];
        }
      });
      if (outside) return 'outside';
      if (!manifoldIsValid(warped)) return null;
      return manifoldToMeshes(warped).soup;
    } catch {
      return outside ? 'outside' : null;
    } finally {
      manifoldDelete(warped);
      manifoldDelete(fine);
      manifoldDelete(prism);
    }
  }

  frameAt(u: number, v: number): ZoneFrame {
    const qu = u + this.uvCu,
      qv = v + this.uvCv;
    const hit = this.lookup(qu, qv);
    if (!hit) {
      // empty/degenerate chart — return a harmless identity-ish frame rather than crash the gizmo
      return {
        origin: new THREE.Vector3(qu, 0, qv),
        uAxis: new THREE.Vector3(1, 0, 0),
        vAxis: new THREE.Vector3(0, 0, 1),
        normal: new THREE.Vector3(0, 1, 0),
      };
    }
    const { p, n } = this.surfacePoint(hit);
    const normal = new THREE.Vector3(n[0], n[1], n[2]);
    // ∂S/∂u of the triangle's linear UV→3D map, projected off the smooth normal so the frame
    // stays orthonormal; vAxis = normal × uAxis points along +v by the right-handed convention.
    const { positions3, triangles } = this.chart;
    const o = hit.tri * 6;
    const i0 = triangles[hit.tri * 3],
      i1 = triangles[hit.tri * 3 + 1],
      i2 = triangles[hit.tri * 3 + 2];
    const dv1 = this.triUV[o + 3] - this.triUV[o + 1];
    const dv2 = this.triUV[o + 5] - this.triUV[o + 1];
    const inv = this.invDet[hit.tri];
    const dPdu = new THREE.Vector3();
    for (let a = 0; a < 3; a++) {
      const e1 = positions3[i1 * 3 + a] - positions3[i0 * 3 + a];
      const e2 = positions3[i2 * 3 + a] - positions3[i0 * 3 + a];
      dPdu.setComponent(a, (e1 * dv2 - e2 * dv1) * inv);
    }
    const uAxis = dPdu.addScaledVector(normal, -dPdu.dot(normal));
    if (uAxis.lengthSq() < 1e-12) uAxis.set(1, 0, 0);
    uAxis.normalize();
    const vAxis = new THREE.Vector3().crossVectors(normal, uAxis);
    return { origin: new THREE.Vector3(p[0], p[1], p[2]), uAxis, vAxis, normal };
  }
}
