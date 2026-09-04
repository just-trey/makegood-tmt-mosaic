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
  measureZoneMirror,
  MIN_ISLAND_AREA_MM2,
  nearestPoints,
  read3MFIndexed,
  SIMPLIFY_TOL_MM,
  WELD_TOL_MM,
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

// The config the sidecar was baked with: seam checks judge welds at ITS tolerances, so retuning
// the config and rebaking cannot leave this file silently judging at a stale constant.
const zoneConfig: { seamWeldTolMm?: number; weldTolMm?: number } = JSON.parse(
  readFileSync(resolve(REPO, 'scripts/zone-configs/chair-body.json'), 'utf8'),
);

// packed vertices (file order) + triangle count per charted part, straight from the packed 3MF;
// `verts` is the same list unnarrowed, as the bake's own measurements read it
const partMesh = new Map<string, { vertices: Float32Array; verts: number[][]; triCount: number }>();

beforeAll(async () => {
  const ids = new Set<string>();
  for (const z of sidecar.zones) for (const c of z.charts) ids.add(c.libraryPartId);
  for (const id of ids) {
    const mesh = await read3MFIndexed(readFileSync(stlPath(id)));
    const vertices = new Float32Array(mesh.verts.length * 3);
    mesh.verts.forEach((v: number[], i: number) => vertices.set(v, i * 3));
    partMesh.set(id, { vertices, verts: mesh.verts, triCount: mesh.tris.length });
  }
}, 60000);

const closed = (loop: number[][]): number[][] => [...loop, loop[0]];
const regionPolygon = (r: { outer: number[][]; holes: number[][][] }): PolyFeature =>
  turf.polygon([closed(r.outer), ...r.holes.map(closed)]) as PolyFeature;

describe('chair zone sidecar', () => {
  it('is the chair-body sidecar with the eight shipped zones', () => {
    expect(sidecar.kindId).toBe('chair-body');
    expect(sidecar.zones.map((z) => z.id).sort()).toEqual([
      'back',
      'front',
      'left',
      'right',
      'seat-left',
      'seat-right',
      'wing-left',
      'wing-right',
    ]);
  });

  it('no zone reaches the seat pan, which the cushion covers whole', () => {
    const parts = sidecar.zones.flatMap((z) => z.charts.map((c) => c.libraryPartId));
    expect(parts).not.toContain('chair-seat-center');
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

  // Every zone but the fenders spans printed parts, which is the whole point of the seam weld — so
  // the per-part clip regions must PARTITION the zone: each part's share strictly smaller than the
  // whole, no part overlapping another, and the shares together covering the zone. A part whose
  // share crept past its own triangles would cut artwork into a neighbour it doesn't own. The
  // fender zones live on one part (the wing's forward face never reaches a seam), so for them the
  // partition is the single chart covering the zone.
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
      const singlePart = z.id === 'wing-left' || z.id === 'wing-right';
      expect(z.charts.length, z.id).toBeGreaterThan(singlePart ? 0 : 1);
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
    const overlaps: {
      where: string;
      overlap: number;
      zone: string;
      a: string;
      b: string;
      box: number[];
    }[] = [];
    const growBox = (box: number[], coords: unknown): number[] => {
      if (Array.isArray(coords) && typeof coords[0] === 'number') {
        const [x, y] = coords as number[];
        return [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
      }
      return Array.isArray(coords) ? coords.reduce((b, c) => growBox(b, c), box) : box;
    };
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
          let box = [Infinity, Infinity, -Infinity, -Infinity];
          for (const a of claims[i].regions)
            for (const b of claims[j].regions) {
              if (a.box[0] > b.box[2] || b.box[0] > a.box[2]) continue;
              if (a.box[1] > b.box[3] || b.box[1] > a.box[3]) continue;
              const hit = turf.intersect(a.poly, b.poly);
              if (hit) {
                overlap += Math.abs(planarArea(hit as PolyFeature));
                box = growBox(box, hit.geometry.coordinates);
              }
            }
          // Not zero: two parts that share a seam have their common boundary traced separately from
          // each side, and 0.2mm of loop simplification lets the two traces cross. A part whose
          // region genuinely crept across a seam onto its neighbour's patch would scale as
          // creep × seam length: even 1mm over a 200mm seam is 0.16%, caught here.
          expect(overlap / zoneArea, `${z.id}: ${claims[i].id} vs ${claims[j].id}`).toBeLessThan(
            0.0005,
          );
          if (overlap > 0)
            overlaps.push({
              where: `${z.id}: ${claims[i].id}/${claims[j].id}`,
              overlap,
              zone: z.id,
              a: claims[i].id,
              b: claims[j].id,
              box,
            });
        }
    }

    // The figures docs/tech-debt.md and this file's own comments cite, computed rather than
    // remembered. 20 pairs, and the worst is 29.85mm² on `right`, whose per-part regions sum to
    // 124,747mm² — 0.024%, a 0.15mm ribbon along a shared seam.
    expect(overlaps.length).toBe(20);
    const worst = overlaps.reduce((w, o) => (o.overlap > w.overlap ? o : w));
    expect(worst.where).toBe('right: chair-wing-right/chair-wheel-mount-right');
    expect(worst.overlap).toBeGreaterThan(29.8);
    expect(worst.overlap).toBeLessThan(29.9);

    // "all seam-sharing" is the load-bearing half of the claim: an overlap between two parts that
    // do NOT meet on the printed chair is a claim that crept, not a traced boundary. Two parts
    // share a seam when the bake welded them — a vertex of one within the config's seamWeldTolMm
    // of a vertex of the other — and only chart vertices AT the overlap (within CHART_SNAP_MM of
    // its UV box) may vouch: almost every adjacent part pair touches somewhere, so a whole-part
    // search would bless a patch that crept far from any seam.
    const seamTol = zoneConfig.seamWeldTolMm ?? zoneConfig.weldTolMm ?? WELD_TOL_MM;
    for (const o of overlaps) {
      const z = sidecar.zones.find((zz) => zz.id === o.zone)!;
      const atOverlap = (partId: string): number[][] => {
        const c = z.charts.find((cc) => cc.libraryPartId === partId)!;
        const verts = partMesh.get(partId)!.verts;
        const out: number[][] = [];
        for (let i = 0; i < c.verts.length; i++) {
          const u = c.uv[2 * i];
          const v = c.uv[2 * i + 1];
          if (
            u >= o.box[0] - CHART_SNAP_MM &&
            u <= o.box[2] + CHART_SNAP_MM &&
            v >= o.box[1] - CHART_SNAP_MM &&
            v <= o.box[3] + CHART_SNAP_MM
          )
            out.push(verts[c.verts[i]]);
        }
        return out;
      };
      const touching = nearestPoints(atOverlap(o.a), atOverlap(o.b), seamTol).filter(
        (n: { d: number }) => n.d <= seamTol,
      ).length;
      expect(touching, `${o.where} overlap without a shared seam`).toBeGreaterThan(0);
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

// The covers file marks the wheels and cushions; the bake turns what they hide into per-chart
// deadRegions. These pin the shipped shape of that data and the runtime clip subtraction.
describe('hidden surface (deadRegions)', () => {
  const deadArea = (c: (typeof sidecar.zones)[number]['charts'][number]): number =>
    (c.deadRegions ?? []).reduce((s, r) => s + Math.abs(planarArea(regionPolygon(r))), 0);

  it('lands where the covers sit: wheels and cushions, not the back or the fenders', () => {
    const zoneDead = new Map(
      sidecar.zones.map((z) => [z.id, z.charts.reduce((s, c) => s + deadArea(c), 0)]),
    );
    // wheel over each flank's mount, cushion over the seat, backrest cushion over `front`
    expect(zoneDead.get('left')!).toBeGreaterThan(500);
    expect(zoneDead.get('right')!).toBeGreaterThan(500);
    expect(zoneDead.get('seat-left')!).toBeGreaterThan(10000);
    expect(zoneDead.get('seat-right')!).toBeGreaterThan(10000);
    expect(zoneDead.get('front')!).toBeGreaterThan(5000);
    // the back faces away from every cover, and nothing sits in front of a fender
    expect(zoneDead.get('back')).toBe(0);
    expect(zoneDead.get('wing-left')).toBe(0);
    expect(zoneDead.get('wing-right')).toBe(0);
  });

  // The regression guard for the whole point of this bake. The chair is mirror-symmetric and so are
  // its covers, so a mirrored pair that disagrees means the ANSWER is asymmetric, not the chair.
  //
  // 5% is the measured headroom, not a target: this bake lands at 1.23% (left/right), 0.15%
  // (seat-left/right) and 3.80% (the front zone's two handles). What is left is the two flanks
  // being tessellated differently (37,820 against 29,822 triangles on the fenders) and therefore
  // unwrapping differently, which no amount of classifying can remove. Before the classifier asked
  // its question at each sample AND its mirror, and before the bleed was moved after the smoothing,
  // the same pairs read 5.3% and 100% — one flank kept the whole wheel shadow on its fender and the
  // other kept none of it.
  it('mirrored pairs hide the same area on both sides', () => {
    const zoneDead = new Map(
      sidecar.zones.map((z) => [z.id, z.charts.reduce((s, c) => s + deadArea(c), 0)]),
    );
    const apart = (a: number, b: number): number =>
      a + b === 0 ? 0 : (200 * Math.abs(a - b)) / (a + b);
    for (const [a, b] of [
      ['left', 'right'],
      ['seat-left', 'seat-right'],
      ['wing-left', 'wing-right'],
    ])
      expect(apart(zoneDead.get(a)!, zoneDead.get(b)!), `${a} vs ${b}`).toBeLessThan(5);

    // Same check one level down, where a single zone spans a mirrored pair of parts.
    for (const z of sidecar.zones) {
      const byPart = new Map(z.charts.map((c) => [c.libraryPartId, deadArea(c)]));
      for (const [id, area] of byPart) {
        if (!id.endsWith('-left')) continue;
        const twin = byPart.get(`${id.slice(0, -'-left'.length)}-right`);
        if (twin === undefined) continue;
        expect(apart(area, twin), `${z.id}: ${id} vs its twin`).toBeLessThan(5);
      }
    }
  });

  it('every dead region stays inside its own chart’s claim', () => {
    // Dead regions are cut against the chart's exact triangle union; the claim is the same
    // surface after 0.2mm loop simplification, so their edges disagree by thin ribbons. 25mm²
    // covers a 0.2mm ribbon along a 100mm+ boundary; a dead region genuinely reaching past its
    // chart would exceed this by the area of whatever it grabbed.
    for (const z of sidecar.zones)
      for (const c of z.charts) {
        if (!c.deadRegions?.length) continue;
        const claim = c.subRegions.reduce((s, r) => s + Math.abs(planarArea(regionPolygon(r))), 0);
        expect(deadArea(c), `${z.id}/${c.libraryPartId}`).toBeLessThan(claim + 25);
      }
  });

  it('boundary() hands the cutter the claim minus the hidden surface', () => {
    const z = sidecar.zones.find((zz) => zz.id === 'seat-left')!;
    const c = z.charts.find((ch) => ch.libraryPartId === 'chair-wheel-mount-left')!;
    expect(deadArea(c)).toBeGreaterThan(0);
    const m = partMesh.get(c.libraryPartId)!;
    const mapper = new ConformalZoneMapper(null, reconstructChart(z, c, m.vertices));
    const claim = c.subRegions.reduce((s, r) => s + Math.abs(planarArea(regionPolygon(r))), 0);
    expect(Math.abs(planarArea(mapper.deadArea()!))).toBeCloseTo(deadArea(c), 1);
    // Subtraction shrinks the clip by about the dead area. What is left over is the same
    // simplified-vs-exact edge disagreement as above, so the budget is that mechanism rather than a
    // round number: a SIMPLIFY_TOL_MM-wide ribbon along the dead region's own perimeter. On this
    // chart that is 574mm of perimeter, so 115mm², and the bake lands at 6.8mm² — a bare number
    // tight enough to catch anything would only be pinning which chart this test happens to read.
    const perimeter = (c.deadRegions ?? []).reduce(
      (s, r) =>
        s +
        [r.outer, ...r.holes].reduce(
          (t, loop) =>
            t +
            loop.reduce((u, pt, i) => {
              const q = loop[(i + 1) % loop.length];
              return u + Math.hypot(q[0] - pt[0], q[1] - pt[1]);
            }, 0),
          0,
        ),
      0,
    );
    expect(Math.abs(planarArea(mapper.boundary()!) - (claim - deadArea(c)))).toBeLessThan(
      SIMPLIFY_TOL_MM * perimeter,
    );
  });

  it('no shipped chart is hidden outright', () => {
    // buildAssemblyGeometry used to branch before tiling on a chart whose claim is entirely dead,
    // where boundary() is the empty MultiPolygon. It attributed a fill off the untiled source and
    // saved nothing, because no chart of this bake reaches it. This is the pin behind that
    // deletion: a bake that hides a whole chart fails here, naming it, and the branch is worth
    // having back at that point.
    for (const z of sidecar.zones)
      for (const c of z.charts) {
        const m = partMesh.get(c.libraryPartId)!;
        const mapper = new ConformalZoneMapper(null, reconstructChart(z, c, m.vertices));
        expect(planarArea(mapper.boundary()!), `${z.id}/${c.libraryPartId}`).toBeGreaterThan(0);
      }
  });

  it('a chart without the field means nothing is hidden, not an error', () => {
    const z = sidecar.zones.find((zz) => zz.id === 'seat-left')!;
    const c = z.charts.find((ch) => ch.libraryPartId === 'chair-wheel-mount-left')!;
    const m = partMesh.get(c.libraryPartId)!;
    const stripped = { ...c };
    delete stripped.deadRegions;
    const mapper = new ConformalZoneMapper(null, reconstructChart(z, stripped, m.vertices));
    expect(mapper.deadArea()).toBeNull();
    const claim = c.subRegions.reduce((s, r) => s + Math.abs(planarArea(regionPolygon(r))), 0);
    expect(planarArea(mapper.boundary()!)).toBeCloseTo(claim, 0);
  });

  // Every chart that carries dead regions, not a representative one: this is what conformal.ts's
  // deadOverlayMesh cites for dropping the CHART_SNAP_MM bound on its lookup. A corner landing off
  // the triangulation would answer null there, drop its triangle, and leave a pinhole in the hatch
  // over surface the cut really does clip — so "no chart does" has to be checked on all of them.
  it('the viewport overlay mesh sits on the part, a hair above the surface', () => {
    let checked = 0;
    for (const z of sidecar.zones)
      for (const c of z.charts) {
        if (!c.deadRegions?.length) continue;
        checked++;
        const m = partMesh.get(c.libraryPartId)!;
        const mapper = new ConformalZoneMapper(null, reconstructChart(z, c, m.vertices), z.id);
        const overlay = mapper.deadOverlayMesh();
        const where = `${z.id}/${c.libraryPartId}`;
        expect(overlay, where).not.toBeNull();
        expect(overlay!.positions.length, where).toBeGreaterThan(0);
        expect(overlay!.positions.length / 3, where).toBe(overlay!.uv.length / 2);
        const mn = [Infinity, Infinity, Infinity];
        const mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < m.vertices.length; i += 3)
          for (let k = 0; k < 3; k++) {
            mn[k] = Math.min(mn[k], m.vertices[i + k]);
            mx[k] = Math.max(mx[k], m.vertices[i + k]);
          }
        for (let i = 0; i < overlay!.positions.length; i += 3)
          for (let k = 0; k < 3; k++) {
            expect(overlay!.positions[i + k], where).toBeGreaterThanOrEqual(mn[k] - 1);
            expect(overlay!.positions[i + k], where).toBeLessThanOrEqual(mx[k] + 1);
          }
      }
    // The count conformal.ts's comment quotes. A rebake that changes it dates that comment too.
    expect(checked).toBe(12);
  });
});

describe('mirror relations', () => {
  const zone = (id: string): (typeof sidecar.zones)[number] =>
    sidecar.zones.find((z) => z.id === id)!;

  it('pairs the flanks, seat sides and fenders, and mirrors the front and back on themselves', () => {
    for (const [a, b] of [
      ['left', 'right'],
      ['seat-left', 'seat-right'],
      ['wing-left', 'wing-right'],
    ]) {
      expect(zone(a).mirror, a).toMatchObject({ twin: b });
      expect(zone(b).mirror, b).toMatchObject({ twin: a });
    }
    expect(zone('front').mirror).toMatchObject({ self: true });
    expect(zone('back').mirror).toMatchObject({ self: true });
    expect(sidecar.zones.every((z) => z.mirror)).toBe(true);
  });

  // The same slack the runtime grants a chart against its own triangulation. A reflection landing
  // further off would put a mirrored design visibly off its twin.
  it('every reflection lands inside the snap tolerance at the 95th percentile', () => {
    for (const z of sidecar.zones)
      expect(z.mirror!.residualMm.p95, z.id).toBeLessThan(CHART_SNAP_MM);
  });

  // Headroom over the measured bake, not targets. Re-derive with
  // `npx vite-node scripts/measure-zone-mirror.mjs`, which prints the same figures the sidecar
  // holds: left 0.178 / right 0.189 rms over 5,146 / 5,521 pairs; seat-left 0.033 / seat-right
  // 0.038; both fenders 0.024; back 0.504 over 7,428; front 0.815 over 3,708. A rise past these
  // means the twins' charts unwrapped differently, not that a mirrored design moved.
  //
  // Two bounds are loose because a zone's own geometry is not symmetric, not because the mirror is
  // weak. `back` absorbs the two storage-box corner strips claimWedge hands it, and they are 155
  // triangles on the left against 156 on the right — the boxes are tessellated differently — so
  // 0.7 covers a measured 0.504 whose p95 (0.761) is a quarter of CHART_SNAP_MM. `front` absorbs
  // 63 vertices on the same corner sitting up to 7.51mm off, which carry an rms of 0.815 over a
  // p95 of 0.647.
  it.each([
    ['left', 0.25],
    ['right', 0.25],
    ['seat-left', 0.05],
    ['seat-right', 0.05],
    ['wing-left', 0.05],
    ['wing-right', 0.05],
    ['back', 0.7],
    ['front', 1.0],
  ])('%s reflects onto its mirror within %s mm rms', (id, bound) => {
    expect(zone(id).mirror!.residualMm.rms).toBeLessThan(bound);
  });

  it('the baked residuals are what the shipped meshes give', () => {
    const vertsOf = (id: string): number[][] => partMesh.get(id)!.verts;
    for (const z of sidecar.zones) {
      const rel = z.mirror!;
      const other = 'self' in rel ? z : zone(rel.twin);
      const m = measureZoneMirror(z, other, 0, vertsOf);
      expect(m.pairs, z.id).toBe(rel.residualMm.pairs);
      expect(m.rms, z.id).toBeCloseTo(rel.residualMm.rms, 3);
      expect(m.p95, z.id).toBeCloseTo(rel.residualMm.p95, 3);
      expect(m.max, z.id).toBeCloseTo(rel.residualMm.max, 3);
    }
  }, 60000);
});

describe('reconstructed charts drive the conformal mapper on real geometry', () => {
  let wasm: ManifoldAPI;
  beforeAll(async () => {
    wasm = await getManifold();
  }, 30000);

  // A feature provably inside the chart: the first chart triangle in UV that the pipeline would
  // still be cutting at all, shrunk 15% toward its centroid so it clears the chart edge. (The zone
  // boundary centroid can fall in a hole for the irregular side charts, which is a placement
  // question for the build, not a warp-engine test.)
  //
  // MIN_ISLAND_AREA_MM2 is the floor because below it there is nothing to be watertight about: an
  // island that small is dropped from the clip region before any cutter is built. Triangle 0 of
  // `seat-right`'s storage crumb is 0.130mm², a prism about 0.45mm on a side, and warping one that
  // small onto curved surface inverts its winding — a scale limit of the warp that no shipped
  // feature reaches, and reading it as a failure only hides the zones this is meant to cover.
  const firstTriFeature = (uv: number[], triangles: Uint32Array): PolyFeature => {
    const triArea = (t: number): number => {
      const q = [0, 1, 2].map((k) => [
        uv[triangles[3 * t + k] * 2],
        uv[triangles[3 * t + k] * 2 + 1],
      ]);
      return (
        Math.abs(
          (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]),
        ) / 2
      );
    };
    let t = 0;
    while (t + 1 < triangles.length / 3 && triArea(t) < MIN_ISLAND_AREA_MM2) t++;
    const p = [0, 1, 2].map((k) => [
      uv[triangles[3 * t + k] * 2],
      uv[triangles[3 * t + k] * 2 + 1],
    ]);
    const cu = (p[0][0] + p[1][0] + p[2][0]) / 3;
    const cv = (p[0][1] + p[1][1] + p[2][1]) / 3;
    const shr = ([u, v]: number[]): number[] => [cu + (u - cu) * 0.85, cv + (v - cv) * 0.85];
    const ring = [shr(p[0]), shr(p[1]), shr(p[2]), shr(p[0])];
    return turf.polygon([ring]) as PolyFeature;
  };

  it.each(['left', 'right', 'back', 'seat-left', 'seat-right', 'wing-left', 'wing-right'])(
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

  /**
   * The three charts whose claim reaches furthest off their own triangulation, pinned ~5% above
   * their measured depths (the mirror bounds above carry their own looser headroom, 23-40%).
   * Everything else is held to 1mm, which is what
   * src/geometry/conformal.ts means by "the rest under 1mm" — and these 26 cases are the
   * measurement it cites, one per shipped chart.
   */
  const DEEPEST = new Map([
    ['right/chair-wing-right', 2.26],
    ['back/chair-seat-back-top', 2.21],
    ['left/chair-storage-left', 2.21],
  ]);

  it('runs one case per shipped chart, which is the count conformal.ts names', () => {
    expect(sidecar.zones.reduce((n, z) => n + z.charts.length, 0)).toBe(26);
  });

  /** Spatial index cell, and the radius past which a gap is too big to be a bake artifact anyway. */
  const BUCKET_MM = 6;
  /** Coarse scan step; anything above it becomes a hill-climb seed. */
  const SEED_MM = 0.5;

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
      // Bucket the triangles so a query touches a handful instead of all ~2000: without this the
      // seed scan below is O(claim area x triCount) and takes minutes per chart.
      const buckets = new Map<string, number[]>();
      const key = (cu: number, cv: number): string => `${cu},${cv}`;
      for (let t = 0; t < triCount; t++) {
        const [ax, ay, bx, by, cx, cy] = corners(t);
        const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        // The runtime lookup skips UV-degenerate triangles (invDet === 0 in conformal.ts), so they
        // neither cover a point nor offer a snap target. Skip them here or this measures something
        // weaker than the check it exists to guard.
        if (Math.abs(d) <= 1e-9) continue;
        for (let cu = Math.floor((Math.min(ax, bx, cx) - BUCKET_MM) / BUCKET_MM); ; cu++) {
          if (cu > Math.floor((Math.max(ax, bx, cx) + BUCKET_MM) / BUCKET_MM)) break;
          for (let cv = Math.floor((Math.min(ay, by, cy) - BUCKET_MM) / BUCKET_MM); ; cv++) {
            if (cv > Math.floor((Math.max(ay, by, cy) + BUCKET_MM) / BUCKET_MM)) break;
            const k = key(cu, cv);
            const b = buckets.get(k);
            if (b) b.push(t);
            else buckets.set(k, [t]);
          }
        }
      }

      /** Distance from (px, py) to the triangulation; 0 inside it. A distance, so 1-Lipschitz. */
      const offChart = (px: number, py: number): number => {
        let best = Infinity;
        for (const t of buckets.get(key(Math.floor(px / BUCKET_MM), Math.floor(py / BUCKET_MM))) ??
          []) {
          const [ax, ay, bx, by, cx, cy] = corners(t);
          const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
          const l0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
          const l1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
          if (l0 >= -1e-9 && l1 >= -1e-9 && 1 - l0 - l1 >= -1e-9) return 0;
          best = Math.min(
            best,
            distToSeg(px, py, ax, ay, bx, by),
            distToSeg(px, py, bx, by, cx, cy),
            distToSeg(px, py, cx, cy, ax, ay),
          );
        }
        return best === Infinity ? BUCKET_MM : best;
      };

      let worst = 0;
      for (const sub of chart.subRegions ?? []) {
        const inClaim = (px: number, py: number): boolean =>
          pointInRing(px, py, sub.outer) && !sub.holes.some((h) => pointInRing(px, py, h));
        const xs = sub.outer.map((p) => p[0]),
          ys = sub.outer.map((p) => p[1]);
        const [u0, u1] = [Math.min(...xs), Math.max(...xs)];
        const [v0, v1] = [Math.min(...ys), Math.max(...ys)];
        // Scan coarsely for candidates, then hill-climb each one. A plain raster CANNOT measure
        // this: offChart is 1-Lipschitz, so a step-h grid under-reports the peak by up to h/√2, and
        // the peaks are narrow spikes where the claim outline pokes a tendril past the end of the
        // triangulation. A 1mm raster reported 1.915mm where the true worst is 2.150mm — enough to
        // make an over-tolerance bake look like it passed.
        const seeds: [number, number, number][] = [];
        // Seed from the outline itself, not just the grid: a tendril narrower than SEED_MM falls
        // between grid samples entirely, and its tip is a ring vertex by construction. These points
        // are reachable — a clipped cutter's own vertices land on this outline.
        for (const ring of [sub.outer, ...sub.holes])
          for (const [pu, pv] of ring) {
            const d = offChart(pu, pv);
            if (d > worst) worst = d;
            if (d > SEED_MM) seeds.push([pu, pv, d]);
          }
        for (let su = u0; su <= u1; su += SEED_MM)
          for (let sv = v0; sv <= v1; sv += SEED_MM) {
            if (!inClaim(su, sv)) continue;
            const d = offChart(su, sv);
            if (d > worst) worst = d;
            if (d > SEED_MM) seeds.push([su, sv, d]);
          }
        for (const [su, sv, d0] of seeds) {
          let bu = su,
            bv = sv,
            bd = d0;
          for (let step = SEED_MM / 2; step > 0.002; step /= 2)
            for (let du = -2; du <= 2; du++)
              for (let dv = -2; dv <= 2; dv++) {
                const pu = bu + du * step,
                  pv = bv + dv * step;
                if (!inClaim(pu, pv)) continue;
                const d = offChart(pu, pv);
                if (d > bd) {
                  bd = d;
                  bu = pu;
                  bv = pv;
                }
              }
          if (bd > worst) worst = bd;
        }
      }
      // The invariant, then the headroom over the measured bake that conformal.ts cites: three
      // charts sit above 2mm (2.150 right/chair-wing-right, 2.104 back/chair-seat-back-top, 2.101
      // left/chair-storage-left) and every other one is under 1mm, the next being 0.991. A failure
      // means the bake changed, not that the scan got unlucky — the hill-climb above is what makes
      // that distinction trustworthy.
      expect(worst, `${who} worst uncovered depth`).toBeLessThan(CHART_SNAP_MM);
      expect(worst, `${who} against its measured depth`).toBeLessThan(DEEPEST.get(who) ?? 1.0);
    },
    60000,
  );
});
