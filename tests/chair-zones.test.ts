import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
import {
  fingerprintMatches,
  meshFingerprint,
  reconstructChart,
  SIDECAR_SCHEMA,
  type ZoneSidecar,
} from '../src/geometry/zoneCharts';
import { planarArea } from '../src/geometry/regions';
import { CHART_SNAP_MM, ConformalZoneMapper } from '../src/geometry/conformal';
import {
  getManifold,
  manifoldIsValid,
  soupToManifold,
  type ManifoldAPI,
} from '../src/geometry/manifold';
import type { PolyFeature } from '../src/types';
import {
  read3MFIndexed,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
} from '../scripts/lib/zonebake.mjs';

// End-to-end check of the baked chair sidecar on the REAL chair meshes (the real-geometry analog of
// the synthetic-cylinder conformal test): every charted part's fingerprint matches, each chart
// reconstructs against the packed mesh, and the reconstructed chart drives ConformalZoneMapper to a
// watertight warped cutter. Reads only tracked public/stl assets.

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const stlPath = (id: string): string => resolve(REPO, 'public/stl', `${id}.3mf`);

const sidecar: ZoneSidecar = JSON.parse(
  readFileSync(resolve(REPO, 'public/stl/chair-body-zones.json'), 'utf8'),
);

// packed vertices (file order) + triangle count per charted part, straight from the packed 3MF
const partMesh = new Map<string, { vertices: Float32Array; triCount: number }>();

beforeAll(async () => {
  const ids = new Set<string>();
  for (const z of sidecar.zones) for (const c of z.charts) ids.add(c.libraryPartId);
  for (const id of ids) {
    const mesh = await read3MFIndexed(readFileSync(stlPath(id)));
    const vertices = new Float32Array(mesh.verts.length * 3);
    mesh.verts.forEach((v: number[], i: number) => vertices.set(v, i * 3));
    partMesh.set(id, { vertices, triCount: mesh.tris.length });
  }
}, 60000);

const closed = (loop: number[][]): number[][] => [...loop, loop[0]];
const regionPolygon = (r: { outer: number[][]; holes: number[][][] }): PolyFeature =>
  turf.polygon([closed(r.outer), ...r.holes.map(closed)]) as PolyFeature;

describe('chair zone sidecar', () => {
  it('is the chair-body sidecar with the five shipped zones', () => {
    expect(sidecar.kindId).toBe('chair-body');
    expect(sidecar.zones.map((z) => z.id).sort()).toEqual([
      'back',
      'front',
      'left',
      'right',
      'seat',
    ]);
  });

  it('fingerprints match the packed meshes the charts index into', () => {
    for (const z of sidecar.zones) {
      for (const c of z.charts) {
        const m = partMesh.get(c.libraryPartId)!;
        // pins the runtime TS fingerprint to scripts/lib/zonebake.mjs (baked into the sidecar)
        expect(
          fingerprintMatches(sidecar, c.libraryPartId, m.vertices, m.triCount),
          c.libraryPartId,
        ).toBe(true);
      }
    }
  });

  it('is the schema this build reads', () => {
    expect(sidecar.schema).toBe(SIDECAR_SCHEMA);
  });

  it('rejects a mesh whose triangle count drifted from the bake', () => {
    const z = sidecar.zones[0];
    const m = partMesh.get(z.charts[0].libraryPartId)!;
    expect(fingerprintMatches(sidecar, z.charts[0].libraryPartId, m.vertices, m.triCount + 1)).toBe(
      false,
    );
    expect(meshFingerprint(m.vertices, m.triCount).bboxHash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('chart reconstruction', () => {
  it('resolves each chart vertex to the packed mesh position it indexes', () => {
    for (const z of sidecar.zones) {
      for (const c of z.charts) {
        const m = partMesh.get(c.libraryPartId)!;
        const chart = reconstructChart(z, c, m.vertices);
        expect(chart.positions3.length).toBe(c.verts.length * 3);
        expect(chart.uv.length).toBe(c.verts.length * 2);
        expect(chart.triangles.length).toBe(c.chartTris.length * 3);
        // spot-check: reconstructed position N is exactly the packed vertex chart.verts[N]
        for (const n of [0, Math.floor(c.verts.length / 2), c.verts.length - 1]) {
          const vi = c.verts[n];
          expect(chart.positions3[n * 3]).toBe(m.vertices[vi * 3]);
          expect(chart.positions3[n * 3 + 2]).toBe(m.vertices[vi * 3 + 2]);
        }
        // every triangle index stays in range (ConformalZoneMapper's own guard would else throw)
        for (const t of chart.triangles) expect(t).toBeLessThan(c.verts.length);
      }
    }
  });

  it('carries each chart’s per-part clip region through to the mapper', () => {
    for (const z of sidecar.zones) {
      for (const c of z.charts) {
        const m = partMesh.get(c.libraryPartId)!;
        expect(c.subRegions.length, `${z.id}/${c.libraryPartId}`).toBeGreaterThan(0);
        expect(reconstructChart(z, c, m.vertices).subRegions).toBe(c.subRegions);
      }
    }
  });

  // Every shipped zone now spans printed parts, which is the whole point of the seam weld — so the
  // per-part clip regions must PARTITION the zone: each part's share strictly smaller than the
  // whole, no part overlapping another, and the shares together covering the zone. A part whose
  // share crept past its own triangles would cut artwork into a neighbour it doesn't own.
  it('splits each zone into per-part clip regions that together cover it', () => {
    // Reference area straight off the baked UV triangles — independent of the loops under test, so
    // "the regions add up" can't be true by construction.
    const chartUVArea = (c: (typeof sidecar.zones)[number]['charts'][number]): number => {
      let a = 0;
      for (const [i, j, k] of c.chartTris)
        a += Math.abs(
          (c.uv[2 * j] - c.uv[2 * i]) * (c.uv[2 * k + 1] - c.uv[2 * i + 1]) -
            (c.uv[2 * k] - c.uv[2 * i]) * (c.uv[2 * j + 1] - c.uv[2 * i + 1]),
        );
      return a / 2;
    };

    for (const z of sidecar.zones) {
      expect(z.charts.length, z.id).toBeGreaterThan(1);
      let sum = 0;
      let uvArea = 0;
      for (const c of z.charts) {
        const own = c.subRegions.reduce((s, r) => s + Math.abs(planarArea(regionPolygon(r))), 0);
        expect(own, `${z.id}/${c.libraryPartId}`).toBeGreaterThan(0);
        sum += own;
        uvArea += chartUVArea(c);
      }
      // 0.2mm boundary simplification and the dropped sub-MIN_ISLAND_AREA_MM2 slivers keep this
      // from being exact; a part claiming surface it doesn't own would blow well past 2%.
      expect(sum / uvArea, z.id).toBeCloseTo(1, 1);
    }
  });

  // The area check above is necessary but NOT sufficient for a partition: two parts overlapping by
  // 30cm² while a 30cm² strip of the zone goes unclaimed sums to exactly the right total. Overlap
  // is the half that actually corrupts output — where two parts both claim a patch of UV, the same
  // artwork is cut into both, so the design appears twice at the seam on the printed chair.
  it('gives no two parts of a zone an overlapping claim on the same UV', () => {
    for (const z of sidecar.zones) {
      // bbox computed off the outer ring rather than turf.bbox — src/turf.d.ts declares only the
      // handful of turf entry points the app actually uses, and bbox isn't one of them.
      const claims = z.charts.map((c) => ({
        id: c.libraryPartId,
        regions: c.subRegions.map((r) => ({
          poly: regionPolygon(r),
          box: r.outer.reduce(
            (b, [x, y]) => [
              Math.min(b[0], x),
              Math.min(b[1], y),
              Math.max(b[2], x),
              Math.max(b[3], y),
            ],
            [Infinity, Infinity, -Infinity, -Infinity],
          ),
        })),
      }));
      const zoneArea = claims.reduce(
        (s, c) => s + c.regions.reduce((t, r) => t + Math.abs(planarArea(r.poly)), 0),
        0,
      );
      for (let i = 0; i < claims.length; i++)
        for (let j = i + 1; j < claims.length; j++) {
          let overlap = 0;
          for (const a of claims[i].regions)
            for (const b of claims[j].regions) {
              if (a.box[0] > b.box[2] || b.box[0] > a.box[2]) continue;
              if (a.box[1] > b.box[3] || b.box[1] > a.box[3]) continue;
              const hit = turf.intersect(a.poly, b.poly);
              if (hit) overlap += Math.abs(planarArea(hit as PolyFeature));
            }
          // Not zero: two parts that share a seam have their common boundary traced separately from
          // each side, and 0.2mm of loop simplification lets the two traces cross. Measured on the
          // shipped bake, every one of the 23 overlapping pairs shares a seam and the worst is
          // 29.85mm² (wing-right/wheel-mount-right) on a 124,500mm² zone — 0.024%, a 0.15mm ribbon.
          // A part whose region genuinely crept across a seam onto its neighbour's patch would
          // scale as creep × seam length: even 1mm over a 200mm seam is 0.16%, caught here.
          expect(overlap / zoneArea, `${z.id}: ${claims[i].id} vs ${claims[j].id}`).toBeLessThan(
            0.0005,
          );
        }
    }
  });

  // The clip region the cutter is actually built against: this part's own share, NOT the zone
  // outline. Handing it the zone outline is what pushes artwork past the chart the warp can
  // resolve, where it reads as off-chart and the colour vanishes from every part at once.
  it('the mapper’s clip region is that chart’s own sub-region, as a MultiPolygon', () => {
    const z = sidecar.zones[0];
    const c = z.charts[0];
    const m = partMesh.get(c.libraryPartId)!;
    const poly = new ConformalZoneMapper(null, reconstructChart(z, c, m.vertices)).boundary()!;

    expect(poly.geometry.type).toBe('MultiPolygon');
    const own = c.subRegions.reduce((s, r) => s + Math.abs(planarArea(regionPolygon(r))), 0);
    expect(planarArea(poly)).toBeCloseTo(own, 3);
    // and it is genuinely a share of the zone, not the whole thing. Compared against the sum over
    // every chart, not `zone.boundary` — that field carries only the largest lobe of a zone whose
    // UV footprint has many, so one part's share can legitimately exceed it.
    const whole = z.charts.reduce(
      (s, ch) => s + ch.subRegions.reduce((t, r) => t + Math.abs(planarArea(regionPolygon(r))), 0),
      0,
    );
    expect(planarArea(poly)).toBeLessThan(whole);
  });

  // Placement/fill anchor on the zone bbox, so it has to cover every chart's UV — a chart poking
  // outside it would place its share of the design off the anchor the template is drawn against.
  it('gives the mapper a zone bbox that covers every chart’s UV', () => {
    for (const z of sidecar.zones) {
      const b = z.uvBounds;
      expect(b.minU, z.id).toBe(0);
      expect(b.minV, z.id).toBe(0);
      for (const c of z.charts) {
        const m = partMesh.get(c.libraryPartId)!;
        expect(reconstructChart(z, c, m.vertices).zoneBounds).toBe(b);
        for (let i = 0; i < c.uv.length; i += 2) {
          expect(c.uv[i]).toBeGreaterThanOrEqual(b.minU - 1e-3);
          expect(c.uv[i]).toBeLessThanOrEqual(b.maxU + 1e-3);
          expect(c.uv[i + 1]).toBeGreaterThanOrEqual(b.minV - 1e-3);
          expect(c.uv[i + 1]).toBeLessThanOrEqual(b.maxV + 1e-3);
        }
      }
    }
  });

  it('throws when the mesh is too small for the chart indices', () => {
    const z = sidecar.zones[0];
    const c = z.charts[0];
    expect(() => reconstructChart(z, c, new Float32Array(9))).toThrow(/stale/);
  });
});

describe('reconstructed charts drive the conformal mapper on real geometry', () => {
  let wasm: ManifoldAPI;
  beforeAll(async () => {
    wasm = await getManifold();
  }, 30000);

  // A feature provably inside the chart: the first chart triangle in UV, shrunk 15% toward its
  // centroid so it clears the chart edge. (The zone boundary centroid can fall in a hole for the
  // irregular side charts, which is a placement question for the build, not a warp-engine test.)
  const firstTriFeature = (uv: number[], triangles: Uint32Array): PolyFeature => {
    const p = [0, 1, 2].map((k) => [uv[triangles[k] * 2], uv[triangles[k] * 2 + 1]]);
    const cu = (p[0][0] + p[1][0] + p[2][0]) / 3;
    const cv = (p[0][1] + p[1][1] + p[2][1]) / 3;
    const shr = ([u, v]: number[]): number[] => [cu + (u - cu) * 0.85, cv + (v - cv) * 0.85];
    const ring = [shr(p[0]), shr(p[1]), shr(p[2]), shr(p[0])];
    return turf.polygon([ring]) as PolyFeature;
  };

  it.each(['left', 'right', 'back', 'seat'])(
    'zone %s: frameAt lands on the part and a warped cutter is watertight',
    (zoneId) => {
      const z = sidecar.zones.find((zz) => zz.id === zoneId)!;
      const c = z.charts[0];
      const m = partMesh.get(c.libraryPartId)!;
      const chart = reconstructChart(z, c, m.vertices);
      const mapper = new ConformalZoneMapper(wasm, chart);

      // the face frame at the chart center sits on the part's mesh (within its bbox)
      const f = mapper.frameAt(0, 0);
      const mn = [Infinity, Infinity, Infinity],
        mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < m.vertices.length; i += 3)
        for (let k = 0; k < 3; k++) {
          mn[k] = Math.min(mn[k], m.vertices[i + k]);
          mx[k] = Math.max(mx[k], m.vertices[i + k]);
        }
      for (const [k, comp] of [f.origin.x, f.origin.y, f.origin.z].entries()) {
        expect(comp).toBeGreaterThanOrEqual(mn[k] - 1);
        expect(comp).toBeLessThanOrEqual(mx[k] + 1);
      }
      expect(Math.abs(f.normal.length() - 1)).toBeLessThan(1e-6);

      // a chart-interior feature bends onto the surface as a watertight solid
      const soup = mapper.buildCutter(firstTriFeature([...chart.uv], chart.triangles), 1.5, 0.5);
      expect(soup, `${zoneId} cutter`).not.toBeNull();
      const man = soupToManifold(wasm, soup!);
      expect(manifoldIsValid(man)).toBe(true);
      expect(man.volume()).toBeGreaterThan(0);
      man.delete();
    },
    20000,
  );
});

// The tolerance CHART_SNAP_MM has to cover, measured rather than assumed. A part's baked claim on
// a zone is slightly more generous than the triangulation inside it, so points within the claim can
// sit a little off every real triangle; a cutter vertex landing in one of those gaps is snapped, or
// the whole colour is dropped from that part when it's further out than the tolerance allows.
//
// That is exactly how the chair's seat-back parts lost two colours in sticker mode while the old
// tolerance was 0.5mm. Pinning the invariant here means a re-bake that opens a wider gap fails CI,
// instead of silently dropping cuts on whichever design happens to cover the spot.
describe('baked claims stay inside the snap tolerance', () => {
  const pointInRing = (px: number, py: number, ring: number[][]): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0],
        yi = ring[i][1],
        xj = ring[j][0],
        yj = ring[j][1];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const distToSeg = (
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): number => {
    const dx = bx - ax,
      dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  it.each(
    sidecar.zones.flatMap((z) =>
      z.charts.map((c) => [`${z.id}/${c.libraryPartId}`, z, c] as const),
    ),
  )(
    '%s claims no patch further off its triangles than the snap tolerance',
    (who, zone, chartMeta) => {
      const chart = reconstructChart(
        zone,
        chartMeta,
        partMesh.get(chartMeta.libraryPartId)!.vertices,
      );
      const { uv, triangles } = chart;
      const triCount = triangles.length / 3;
      const corners = (t: number): number[] => {
        const i0 = triangles[t * 3],
          i1 = triangles[t * 3 + 1],
          i2 = triangles[t * 3 + 2];
        return [uv[i0 * 2], uv[i0 * 2 + 1], uv[i1 * 2], uv[i1 * 2 + 1], uv[i2 * 2], uv[i2 * 2 + 1]];
      };
      const covered = (px: number, py: number): boolean => {
        for (let t = 0; t < triCount; t++) {
          const [ax, ay, bx, by, cx, cy] = corners(t);
          const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
          if (Math.abs(d) < 1e-12) continue;
          const l0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
          const l1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
          if (l0 >= -1e-9 && l1 >= -1e-9 && 1 - l0 - l1 >= -1e-9) return true;
        }
        return false;
      };
      const offChart = (px: number, py: number): number => {
        let best = Infinity;
        for (let t = 0; t < triCount; t++) {
          const [ax, ay, bx, by, cx, cy] = corners(t);
          best = Math.min(
            best,
            distToSeg(px, py, ax, ay, bx, by),
            distToSeg(px, py, bx, by, cx, cy),
            distToSeg(px, py, cx, cy, ax, ay),
          );
        }
        return best;
      };

      let worst = 0;
      for (const sub of chart.subRegions ?? []) {
        const xs = sub.outer.map((p) => p[0]),
          ys = sub.outer.map((p) => p[1]);
        const [u0, u1] = [Math.min(...xs), Math.max(...xs)];
        const [v0, v1] = [Math.min(...ys), Math.max(...ys)];
        // 1mm raster: the gaps this is guarding against are thin ribbons metres long in aggregate,
        // not sub-millimetre specks, and a finer step multiplies a whole-sidecar scan for no signal.
        for (let su = u0; su <= u1; su += 1)
          for (let sv = v0; sv <= v1; sv += 1) {
            if (!pointInRing(su, sv, sub.outer)) continue;
            if (sub.holes.some((h) => pointInRing(su, sv, h))) continue;
            if (covered(su, sv)) continue;
            const d = offChart(su, sv);
            if (d > worst) worst = d;
          }
      }
      // Worst on the shipped bake is 1.915mm (chair-storage-left/left) — this has ~4% headroom, so a
      // failure here means the bake changed, not that the raster got unlucky.
      expect(worst, `${who} worst uncovered depth`).toBeLessThan(CHART_SNAP_MM);
    },
    60000,
  );
});
