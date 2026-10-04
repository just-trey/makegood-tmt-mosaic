import * as THREE from 'three';
import * as turf from '@turf/turf';
import type { PolyFeature } from '../types';
import type { NetZoneExclusion } from './zoneCharts';
import {
  extrudeRegionToSoup,
  manifoldDelete,
  manifoldIsValid,
  manifoldToMeshes,
  soupToManifold,
  type ManifoldAPI,
  type ManifoldSolid,
} from './manifold';
import { intersectQuiet, safeDiff, safeUnionAll } from './regions';
import { warn } from '../warnings';
import {
  rotatePointY,
  type CutRegion,
  type NetExclusion,
  type CutterOptions,
  type DesignPlacement,
  type FillExtent,
  type KeepSide,
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
 * How far (mm) outside the chart a cutter vertex may land and still snap to the nearest triangle;
 * past it the artwork is misplaced and the cut fails rather than being dragged onto the surface.
 *
 * Set by the bake, not taste: a part's claim (`subRegions`) is slightly more generous than its
 * triangulation. Across all 26 shipped chair charts (2026-09-04, the `claims no patch further off
 * its triangles than the snap tolerance` cases in tests/chair-zones.test.ts): worst **2.150mm**
 * (`right/chair-wing-right`), then 2.104 (`back/chair-seat-back-top`) and 2.101
 * (`left/chair-storage-left`), the rest under 1mm. So 3 gives ~28% headroom, and a re-bake that
 * widens the gap fails CI instead of silently dropping cuts.
 *
 * **Measure by refinement, never by rastering**: a grid of step h under-reports this 1-Lipschitz
 * distance by up to h/√2, and the peaks are narrow tendrils. A 1mm raster read 1.915mm and made 2
 * look safe; it is not. The test hill-climbs each seed from a coarse scan.
 *
 * Once 0.5 for stickers and 2mm for fills; the gaps sit inside the claim and hit both modes, which
 * dropped two colors off the chair's seat-back parts. Real fix: re-bake claims to match their
 * triangulation. Deferred: it invalidates every downloaded template and the sidecar.
 */
export const CHART_SNAP_MM = 3;

/**
 * One baked UV chart: a patch of a part's surface mesh unwrapped into a flat 2D space where
 * 1 UV unit = 1 mm of surface (true scale). Baked, loaded from the kind's zones sidecar; tests
 * hand-build analytic ones.
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
   * This part's own slice of the zone, in UV mm: the cutter's clip. On a seam-spanning zone each
   * part gets only its share, so artwork can't be cut past the chart this mapper can warp.
   * `boundary` stays zone-wide, like the template.
   */
  subRegions?: { outer: number[][]; holes: number[][][] }[];
  /**
   * What this part may actually cut: `subRegions` less `deadRegions`, baked, with pieces under one
   * nozzle square removed. Absent on a hand-built chart, where `boundary()` falls back to doing the
   * subtraction itself.
   */
  cutRegions?: { outer: number[][]; holes: number[][][] }[];
  /**
   * Surface of this chart another part hides once assembled, already shrunk by the bake's bleed.
   * Subtracted from `boundary()` so hidden surface spends no filament changes, and exposed via
   * `deadArea()` for the viewport shading. Absent and empty both mean "nothing is hidden".
   */
  deadRegions?: { outer: number[][]; holes: number[][][] }[];
  /**
   * The whole zone's UV bbox across every part's chart (the template's space). Placement and fill
   * anchor here, so a seam-spanning zone places one design across its parts, not a copy per half.
   * Absent on a hand-built chart, which falls back to its own UV bbox.
   */
  zoneBounds?: { minU: number; minV: number; maxU: number; maxV: number };
  /**
   * Patches of this zone's UV that another sheet of the whole-part net owns. Only a design bound
   * to the whole part consults them: on that binding this zone must not cut there, because the
   * zone named in each entry does. Absent on a kind with no net, and on every zone whose sheet
   * lies over no other.
   */
  netExcluded?: NetZoneExclusion[];
}

/** A viewport shading mesh: interleaved 3D positions plus the chart UV each vertex came from. */
export interface OverlayMesh {
  positions: Float32Array;
  uv: Float32Array;
}

/** A turf result back in the outer/holes form the baked regions and the overlay triangulator use. */
const polyRings = (f: PolyFeature): { outer: number[][]; holes: number[][][] }[] => {
  const g = f.geometry;
  const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as number[][][][];
  return polys
    .filter((p) => p.length)
    .map(([outer, ...holes]) => ({ outer: outer as number[][], holes: holes as number[][][] }));
};

/** GeoJSON rings repeat their first point; baked loops don't, so close before handing to turf. */
const closeRing = (ring: number[][]): number[][] => {
  const r = ring.map((p) => [p[0], p[1]]);
  const a = r[0],
    b = r[r.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) r.push([a[0], a[1]]);
  return r;
};

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
  private deadComputed = false;
  private deadPoly: PolyFeature | null = null;
  private netExclCache: NetExclusion[] | null = null;

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
   * Nearest chart triangle to (u,v): ring search outward from the containing cell, stopping once no
   * closer triangle can exist. Always returns the best found; callers judge `dist` (0 = inside).
   * `giveUpMM` caps the search for a caller needing only "on the chart or not": an outside query
   * walks rings up to the whole grid, and the gizmo asks dozens of times per pointer-move across
   * every part of the zone. Uncapped by default, so the cut path is untouched.
   */
  private lookup(u: number, v: number, giveUpMM?: number): ChartHit | null {
    const cu = this.cellIdxU(u),
      cv = this.cellIdxV(v);
    const maxRing = Math.max(this.gridNU, this.gridNV);
    const minCell = Math.min(this.cellU, this.cellV);
    let best: ChartHit | null = null;
    for (let r = 0; r <= maxRing; r++) {
      if (best && best.dist === 0) break;
      // any triangle in ring r is at least (r-1)*minCell away; nothing further out can win
      if (best && best.dist < (r - 1) * minCell) break;
      if (giveUpMM !== undefined && (r - 1) * minCell > giveUpMM) break;
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
   * The UV region a cut on this chart is clipped to: this part's sub-regions when baked (a
   * MultiPolygon: a share can be several islands), else the whole zone outline — identical on a
   * single-part zone.
   */
  boundary(): PolyFeature | null {
    if (this.boundaryComputed) return this.boundaryPoly;
    this.boundaryComputed = true;
    // The baked clip: this part's claim less dead surface, cleaned of unprintable pieces. Deriving
    // it here leaves dust along the two sets' shared traced edges (55 of the chair's 142 pieces).
    // Presence, not length: a baked EMPTY list means nothing cuttable, and deriving would bring the
    // dust back; absent means a hand-built chart, the only case the derivation is for.
    const cut = this.chart.cutRegions;
    if (cut) {
      if (!cut.length) {
        this.boundaryPoly = turf.multiPolygon([]) as PolyFeature;
        return this.boundaryPoly;
      }
      try {
        this.boundaryPoly = turf.multiPolygon(
          cut.map((r) => [closeRing(r.outer), ...r.holes.map(closeRing)]),
        ) as PolyFeature;
      } catch {
        this.boundaryPoly = null;
      }
      return this.boundaryPoly;
    }
    const sub = this.chart.subRegions;
    try {
      this.boundaryPoly = sub?.length
        ? (turf.multiPolygon(
            sub.map((r) => [closeRing(r.outer), ...r.holes.map(closeRing)]),
          ) as PolyFeature)
        : (turf.polygon([
            closeRing(this.chart.boundary),
            ...(this.chart.holes ?? []).map(closeRing),
          ]) as PolyFeature);
    } catch {
      this.boundaryPoly = null;
    }
    // Hidden surface takes no artwork: subtracting it from the clip is the whole mechanism.
    // safeDiff, not turf.difference, for the retry ladder and warning (a silent catch reported turf
    // 6.5 flakes as "nothing is hidden"). Its two empty-looking outcomes are opposites, both
    // wanted: a FAILURE keeps the clip unsubtracted (wasteful, never wrong-looking; a null boundary
    // would cut everywhere); an EMPTY RESULT means everything is hidden, so the clip admits
    // nothing. No shipped chart reaches that (most-covered: `seat-right`'s storage sliver at 99.4%;
    // tests/chair-zones.test.ts pins that none is hidden outright).
    //
    // **Partial clipping stays silent, deliberately**, like a design straddling a zone boundary:
    // viewport and template hatch the dead area before any artwork is placed, and a "most of it was
    // trimmed" trigger needs a fraction no measurement chooses. A color trimmed to NOTHING is named
    // in buildAssemblyGeometry.
    const dead = this.deadArea();
    if (this.boundaryPoly && dead)
      this.boundaryPoly =
        safeDiff(
          this.boundaryPoly,
          dead,
          `the hidden surface on "${this.zoneId ?? 'this zone'}"`,
        ) ?? (turf.multiPolygon([]) as PolyFeature);
    return this.boundaryPoly;
  }

  /**
   * The canvas this zone yields to other sheets of the net, per owning zone, in chart UV. NOT in
   * `boundary()`: that clip serves every binding, this only whole-part designs, so a design bound
   * here by name still cuts here and the partition loses no surface.
   */
  netExcluded(): NetExclusion[] {
    if (this.netExclCache) return this.netExclCache;
    const out: NetExclusion[] = [];
    for (const e of this.chart.netExcluded ?? []) {
      let poly: PolyFeature | null;
      try {
        // turf builds a hollow feature from zero loops without complaint; null it so the entry
        // takes the untrimmable path instead of intersecting nothing and saying nothing.
        poly = e.regions.length
          ? (turf.multiPolygon(
              e.regions.map((r) => [closeRing(r.outer), ...r.holes.map(closeRing)]),
            ) as PolyFeature)
          : null;
      } catch {
        poly = null;
      }
      // Kept with a null region, not dropped: dropping puts the patch back on both sheets silently.
      // clipToNetShare reads null as "cannot trim" and the build names it. The bbox is a min/max
      // over the baked loops (src/turf.d.ts declares no bbox); with no loops it is unbounded, not
      // inverted, so every design consults the entry and the null region fails out loud.
      const bbox = e.regions.length
        ? [Infinity, Infinity, -Infinity, -Infinity]
        : [-Infinity, -Infinity, Infinity, Infinity];
      for (const r of e.regions)
        for (const [u, v] of r.outer) {
          if (u < bbox[0]) bbox[0] = u;
          if (v < bbox[1]) bbox[1] = v;
          if (u > bbox[2]) bbox[2] = u;
          if (v > bbox[3]) bbox[3] = v;
        }
      out.push({ toName: e.toName, region: poly, bbox, joins: e.joins, tearMm: e.tearMm });
    }
    return (this.netExclCache = out);
  }

  /**
   * Surface another part hides once assembled (already bleed-shrunk at bake time), as one
   * MultiPolygon in chart UV, or null when nothing is hidden. `boundary()` subtracts it from the
   * artwork clip; the viewport shades it so the clip is visible before any artwork is placed.
   */
  deadArea(): PolyFeature | null {
    if (this.deadComputed) return this.deadPoly;
    this.deadComputed = true;
    const dead = this.chart.deadRegions;
    if (!dead?.length) return null;
    try {
      this.deadPoly = turf.multiPolygon(
        dead.map((r) => [closeRing(r.outer), ...r.holes.map(closeRing)]),
      ) as PolyFeature;
    } catch {
      this.deadPoly = null;
    }
    return this.deadPoly;
  }

  /**
   * One half of the zone's UV bbox, split at the centre the placer anchors on (`uvCu`), so "right
   * of centre" here and "reflected about centre" in mirroredBuildInput are the same line. Padded
   * outward by the zone's own extent: the clip answers only which side of the line ink sits on,
   * and ink placed past the bounds is still on one side of it.
   */
  sideClip(side: KeepSide): PolyFeature | null {
    const bb = this.uvBBox;
    const w = bb.maxX - bb.minX,
      h = bb.maxY - bb.minY;
    if (!(w > 0) || !(h > 0)) return null;
    const u0 = side === 'right' ? this.uvCu : bb.minX - w;
    const u1 = side === 'right' ? bb.maxX + w : this.uvCu;
    const v0 = bb.minY - h,
      v1 = bb.maxY + h;
    return turf.polygon([
      [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
        [u0, v0],
      ],
    ]) as PolyFeature;
  }

  /**
   * The zone's UV bbox (this chart's own when none was baked), not the boundary's: a fill tiles
   * everything the zone carries and `boundary()` clips it back. Zone-wide, so a seam-spanning
   * zone's tile grid keeps one origin and phase across parts.
   */
  fillExtent(): FillExtent | null {
    const bb = this.uvBBox;
    return bb.maxX > bb.minX && bb.maxY > bb.minY ? bb : null;
  }

  /**
   * Always the setting, in one piece. A conformal zone has no cut-through mode and no edge rule:
   * its "boundary" is where this part's share of a chart ends, which is a seam against the
   * neighbouring printed piece, not an outer wall anyone sees.
   */
  resolveCutRegions(feat: PolyFeature, depthSetting: number): CutRegion[] {
    return [{ feat, depth: depthSetting }];
  }

  /**
   * Declines to bound. A conformal zone cuts along its chart's normal field rather than one axis,
   * so "how far the part extends behind the face" has no single answer here — and the flat zone's
   * measurement, applied to this part's flat patch, describes a face these cuts do not use.
   */
  maxCutDepth(): number {
    return Infinity;
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

  /**
   * Display mesh of the chart's hidden surface, for the viewport shading: `deadRegions` through
   * `regionOverlayMesh`, or null when nothing is hidden.
   */
  deadOverlayMesh(liftMm = 0.4, refineMm = 4): OverlayMesh | null {
    const dead = this.chart.deadRegions;
    if (!dead?.length) return null;
    const built = this.regionOverlayMesh(dead, liftMm, refineMm);
    // warn(), not warnBuild(): rebuild.ts caches this mesh per chart, so a build-scoped pill would
    // show on the rebuild that computed it and vanish on every cache hit after. The key dedupes it.
    if (built.failed)
      warn(
        `Couldn't shade the hidden surface on "${this.zoneId ?? 'this zone'}". ` +
          `Artwork still won't cut there. Only the hatching is missing. Please report this.`,
        `dead-overlay-${this.zoneId ?? ''}`,
      );
    return built.mesh;
  }

  /**
   * Display mesh of the canvas this chart yields (`netExcluded`), shaded while a whole-part design
   * is placed; null when it yields nothing.
   *
   * **Clipped to `boundary()` first, load-bearing**: exclusions are ZONE-wide and `lookup` answers
   * the nearest triangle at any distance, so warped raw, `left`'s 8,668mm² patch (u 497..631) would
   * also land on `chair-wing-left` and `chair-wheel-mount-left` (charts reaching u 224 and u 434).
   * It is the cutter's own clip, so hatch and cut agree by construction. Removing hidden surface is
   * incidental: dead and yielded regions meet on 0.0mm² over all 14 charts carrying exclusions
   * (yielded-canvas overlay test, tests/chair-zones.test.ts).
   *
   * `intersectQuiet`, not `safeIntersect`, which returns UNCLIPPED on a flake — the very smear
   * being prevented. A flake draws no hatch; `clipToNetShare`'s notice still names a design
   * reaching it.
   */
  netExcludedOverlayMesh(liftMm = 0.4, refineMm = 4): OverlayMesh | null {
    const yielded = safeUnionAll(
      this.netExcluded().map((e) => e.region),
      `the canvas "${this.zoneId ?? 'this zone'}" yields`,
    );
    const mine = intersectQuiet(yielded, this.boundary());
    if (!mine) return null;
    const regions = polyRings(mine);
    if (!regions.length) return null;
    // No warning on `failed`, unlike the dead hatch: this one only says a whole-part design lands
    // elsewhere, and `clipToNetShare` already names where, at the moment it happens.
    return this.regionOverlayMesh(regions, liftMm, refineMm).mesh;
  }

  /**
   * Rings in chart UV triangulated, subdivided so they follow the curvature, each vertex lifted
   * `liftMm` off the surface along its smooth normal. Returns interleaved 3D positions plus the UV
   * each vertex came from (true mm, for a striped texture), and how many regions the triangulator
   * could not use. Pure display: no boolean engine, not watertight, and T-junctions from the
   * per-triangle subdivision are fine at this lift.
   */
  private regionOverlayMesh(
    regions: { outer: number[][]; holes: number[][][] }[],
    liftMm: number,
    refineMm: number,
  ): { mesh: OverlayMesh | null; failed: number } {
    // No triangles means no surface, and is the only input where `lookup` returns null (queries
    // clamp into the grid and the ring search spans it), so the emit loop drops nothing.
    if (!this.chart.triangles.length) return { mesh: null, failed: 0 };
    const positions: number[] = [];
    const uvOut: number[] = [];
    let failed = 0;
    const emit = (tri: number[][]): void => {
      const pts: number[][] = [];
      for (const [u, v] of tri) {
        // Nearest triangle at any distance, no CHART_SNAP_MM: that refuses MISPLACED ARTWORK, and a
        // dead region is cut against this chart's own triangles at bake time. Over all 12 charts of
        // public/stl/chair-body-zones.json carrying one, the worst corner is 0.0006mm off
        // (tests/chair-zones.test.ts pins it); a bound would pinhole the hatch. Yielded regions are
        // zone-wide, hence netExcludedOverlayMesh's `boundary()` clip.
        const hit = this.lookup(u, v);
        // Unreachable given the guard above, and narrowing rather than a `!` so it stays that way.
        if (!hit) return;
        const { p, n } = this.surfacePoint(hit);
        pts.push([p[0] + liftMm * n[0], p[1] + liftMm * n[1], p[2] + liftMm * n[2]]);
      }
      for (let k = 0; k < 3; k++) {
        positions.push(pts[k][0], pts[k][1], pts[k][2]);
        uvOut.push(tri[k][0], tri[k][1]);
      }
    };
    const subdivide = (tri: number[][], depth: number): void => {
      let longest = 0;
      let li = 0;
      for (let k = 0; k < 3; k++) {
        const a = tri[k],
          b = tri[(k + 1) % 3];
        const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
        if (d > longest) {
          longest = d;
          li = k;
        }
      }
      if (depth >= 10 || longest <= refineMm * refineMm) {
        emit(tri);
        return;
      }
      const a = tri[li],
        b = tri[(li + 1) % 3],
        c = tri[(li + 2) % 3];
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      subdivide([a, m, c], depth + 1);
      subdivide([m, b, c], depth + 1);
    };
    // triangulateShape indexes into contour-then-holes concatenated, but drops a ring's last point
    // when it repeats the first. Strip those here so the index it returns and `all` stay the same
    // list; letting it strip them shifts every index after the first closed ring.
    const open = (ring: number[][]): number[][] => {
      const a = ring[0],
        b = ring[ring.length - 1];
      return ring.length > 1 && a[0] === b[0] && a[1] === b[1] ? ring.slice(0, -1) : ring;
    };
    for (const region of regions) {
      const outer = open(region.outer);
      const holes = region.holes.map(open);
      const contour = outer.map(([u, v]) => new THREE.Vector2(u, v));
      const holePts = holes.map((h) => h.map(([u, v]) => new THREE.Vector2(u, v)));
      const all = [...outer, ...holes.flat()];
      let tris: number[][];
      try {
        tris = THREE.ShapeUtils.triangulateShape(contour, holePts);
      } catch {
        tris = [];
      }
      // The one drop left, taking a whole patch of hatching: counted so the caller warns, since a
      // missing hatch over clipped surface reads as a place artwork is welcome. Empty lists count
      // too: this triangulator returns one about as often as it throws.
      if (!tris.length) {
        failed++;
        continue;
      }
      for (const [i, j, k] of tris) subdivide([all[i], all[j], all[k]], 0);
    }
    return {
      mesh: positions.length
        ? { positions: Float32Array.from(positions), uv: Float32Array.from(uvOut) }
        : null,
      failed,
    };
  }

  frameAt(u: number, v: number, giveUpMM?: number): ZoneFrame {
    const qu = u + this.uvCu,
      qv = v + this.uvCv;
    const hit = this.lookup(qu, qv, giveUpMM);
    if (!hit) {
      // empty/degenerate chart — return a harmless identity-ish frame rather than crash the gizmo
      return {
        origin: new THREE.Vector3(qu, 0, qv),
        uAxis: new THREE.Vector3(1, 0, 0),
        vAxis: new THREE.Vector3(0, 0, 1),
        normal: new THREE.Vector3(0, 1, 0),
        offChartMM: Infinity,
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
    return {
      origin: new THREE.Vector3(p[0], p[1], p[2]),
      uAxis,
      vAxis,
      normal,
      offChartMM: hit.dist,
    };
  }
}
