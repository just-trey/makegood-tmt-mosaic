import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
import {
  fingerprintMatches,
  meshFingerprint,
  reconstructChart,
  type ZoneSidecar,
} from '../src/geometry/zoneCharts';
import { ConformalZoneMapper } from '../src/geometry/conformal';
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

describe('chair zone sidecar', () => {
  it('is the chair-body sidecar with the four first-pass zones', () => {
    expect(sidecar.kindId).toBe('chair-body');
    expect(sidecar.zones.map((z) => z.id).sort()).toEqual(['back', 'left', 'right', 'seat']);
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
