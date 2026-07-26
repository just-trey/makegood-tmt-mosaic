import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildAssemblyGeometry, type AssemblyBuildInput } from '../src/geometry/assembly';
import { zoneMappersFor } from '../src/geometry/zoneMappers';
import { FlatZoneMapper } from '../src/geometry/zones';
import { ConformalZoneMapper } from '../src/geometry/conformal';
import { reconstructChart, type ZoneSidecar } from '../src/geometry/zoneCharts';
import { getManifold, manifoldIsValid, soupToManifold } from '../src/geometry/manifold';
import type { AssemblyPart, DesignZone, ParsedSVG } from '../src/types';
import { WARNINGS, clearWarnings } from '../src/warnings';
import {
  read3MFIndexed,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
} from '../scripts/lib/zonebake.mjs';

// The conformal cut path end-to-end on the real chair: baked sidecar → reconstructed charts on
// real AssemblyParts → buildAssemblyGeometry → pockets actually carved into the real meshes. The
// unit-level warp is covered by conformal.test.ts (synthetic cylinder) and chair-zones.test.ts
// (real charts, one cutter); this pins the *build's* dispatch and multi-zone bookkeeping.

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const sidecar: ZoneSidecar = JSON.parse(
  readFileSync(resolve(REPO, 'public/stl/chair-body-zones.json'), 'utf8'),
);

interface LoadedMesh {
  positions: Float32Array;
  vertices: Float32Array;
  triCount: number;
}
const meshes = new Map<string, LoadedMesh>();

async function loadPacked(id: string): Promise<LoadedMesh> {
  const cached = meshes.get(id);
  if (cached) return cached;
  const m = await read3MFIndexed(readFileSync(resolve(REPO, 'public/stl', `${id}.3mf`)));
  const vertices = new Float32Array(m.verts.length * 3);
  m.verts.forEach((v: number[], i: number) => vertices.set(v, i * 3));
  const positions = new Float32Array(m.tris.length * 9);
  m.tris.forEach((t: number[], i: number) => {
    t.forEach((vi, k) => positions.set(m.verts[vi], i * 9 + k * 3));
  });
  const out = { positions, vertices, triCount: m.tris.length };
  meshes.set(id, out);
  return out;
}

/** The zones the sidecar bakes onto one library part, resolved against its packed mesh. */
function zonesFor(id: string, mesh: LoadedMesh): DesignZone[] {
  const out: DesignZone[] = [];
  for (const zone of sidecar.zones)
    for (const chart of zone.charts)
      if (chart.libraryPartId === id)
        out.push({
          id: zone.id,
          name: zone.name,
          chart: reconstructChart(zone, chart, mesh.vertices),
        });
  return out;
}

let nextId = 1;
function chairPart(id: string, mesh: LoadedMesh, zones: DesignZone[]): AssemblyPart {
  // A real chair part still gets a flat patch + boundary from mesh loading; only `zones` decides
  // how it is cut, so the loop stays representative with a stand-in loop here.
  return {
    id: nextId++,
    name: id,
    roleId: id,
    libraryPartId: id,
    positions: mesh.positions,
    vertices: mesh.vertices,
    zones,
    patches: null,
    patchIdx: 0,
    boundaryLoop: [
      [-1, 0, -1],
      [1, 0, -1],
      [1, 0, 1],
    ],
    patchNormal: [0, 1, 0],
    topZ: 0,
    baseDepth: 0,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
  };
}

/** A filled square in true mm (userUnitMM=1), big enough to straddle a chart's holes. */
function squareParsed(sizeMM: number): ParsedSVG {
  const s = sizeMM;
  return {
    shapes: [
      {
        fill: '#ff0000',
        loops: [
          [
            { x: 0, y: 0 },
            { x: s, y: 0 },
            { x: s, y: s },
            { x: 0, y: s },
            { x: 0, y: 0 },
          ],
        ],
        order: 0,
      },
    ],
    bbox: { minX: 0, minY: 0, maxX: s, maxY: s },
    rawSVGCircle: null,
    userUnitMM: 1,
  };
}

function chairInput(parts: AssemblyPart[], sizeMM = 60): AssemblyBuildInput {
  return {
    parsed: squareParsed(sizeMM),
    parts,
    mergeGroups: [],
    colorSettings: {},
    globalDepth: 1,
    radius: 0,
    designFit: 'rect',
    scaleMult: 1,
    offX: 0,
    offZ: 0,
    flipX: false,
    flipY: false,
    rotationDeg: 0,
  };
}

beforeAll(async () => {
  await getManifold();
  const ids = new Set<string>();
  for (const z of sidecar.zones) for (const c of z.charts) ids.add(c.libraryPartId);
  for (const id of ids) await loadPacked(id);
}, 120000);

describe('zone dispatch', () => {
  it('gives an unzoned part the implicit flat zone (unchanged behavior)', async () => {
    const mesh = await loadPacked(sidecar.zones[0].charts[0].libraryPartId);
    const part = chairPart('plain', mesh, []);
    delete part.zones;
    const mappers = zoneMappersFor(part, [part], true, null);
    expect(mappers).toHaveLength(1);
    expect(mappers[0]).toBeInstanceOf(FlatZoneMapper);
  });

  it('gives a charted part one conformal mapper per baked zone', async () => {
    const id = sidecar.zones[0].charts[0].libraryPartId;
    const mesh = await loadPacked(id);
    const part = chairPart(id, mesh, zonesFor(id, mesh));
    const mappers = zoneMappersFor(part, [part], true, null);
    expect(mappers.length).toBe(part.zones!.length);
    expect(mappers.every((m) => m instanceof ConformalZoneMapper)).toBe(true);
  });

  it('gives a structural (zone-less) part NO mapper rather than falling back to its flat patch', async () => {
    const mesh = await loadPacked(sidecar.zones[0].charts[0].libraryPartId);
    const part = chairPart('caster-stand-in', mesh, []);
    expect(zoneMappersFor(part, [part], true, null)).toHaveLength(0);
  });
});

// The `right` zone's first-pass bake is defective and is excluded below: its boundary loops came
// out fragmented (no single loop spans the chart — the largest is −4326mm² against `left`'s
// +27352mm², with scrambled winding), so the bake took a fragment as the outer ring and demoted
// the rest to holes. The resulting clip region claims up to 42mm of area the chart never covers.
// The build handles it correctly — warns and declines rather than cutting into nothing, which is
// what `right's bake is inconsistent` below pins — but the zone itself needs re-baking with
// pinch-tolerant loop chaining before it can take artwork. Tracked as the chair re-bake task.
const CUTTABLE_ZONES = ['left', 'back', 'seat'];

describe('conformal build on the real chair', () => {
  it.each(
    sidecar.zones
      .filter((z) => CUTTABLE_ZONES.includes(z.id))
      .map((z) => [z.id, z.charts[0].libraryPartId]),
  )(
    'zone %s carves a pocket into %s and leaves it watertight',
    async (zoneId, partId) => {
      clearWarnings();
      const mesh = await loadPacked(partId);
      const zones = zonesFor(partId, mesh).filter((z) => z.id === zoneId);
      expect(zones).toHaveLength(1);
      const part = chairPart(partId, mesh, zones);

      const build = await buildAssemblyGeometry(chairInput([part]));
      expect(build, 'build returned null').not.toBeNull();
      const out = build!.partOutputs.find((o) => o.part.id === part.id)!;
      expect(
        out,
        `no part output (warnings: ${WARNINGS.map((w) => w.message).join(' | ')})`,
      ).toBeTruthy();

      // the artwork actually cut: an inlay solid exists and the body lost volume
      const inlays = Object.values(out.inlaySoups);
      expect(
        inlays.length,
        `no inlay produced (warnings: ${WARNINGS.map((w) => w.message).join(' | ')})`,
      ).toBe(1);
      expect(inlays[0].length).toBeGreaterThan(0);

      const wasm = await getManifold();
      const cut = soupToManifold(wasm, out.bodySoup);
      const orig = soupToManifold(wasm, mesh.positions);
      expect(manifoldIsValid(cut), 'cut body not manifold').toBe(true);
      expect(cut.volume()).toBeLessThan(orig.volume());
      // a 60mm sticker at 1mm deep removes a sliver, not a chunk of the part
      expect(cut.volume()).toBeGreaterThan(orig.volume() * 0.9);
      cut.delete();
      orig.delete();
    },
    120000,
  );

  it("right's bake is inconsistent, so the build warns instead of cutting into nothing", async () => {
    clearWarnings();
    const zone = sidecar.zones.find((z) => z.id === 'right')!;
    // the defect itself: a valid ring cannot enclose less area than the holes punched out of it
    const ringArea = (r: number[][]): number => {
      let a = 0;
      for (let i = 0; i < r.length; i++) {
        const p = r[i],
          q = r[(i + 1) % r.length];
        a += p[0] * q[1] - q[0] * p[1];
      }
      return Math.abs(a) / 2;
    };
    const holes = (zone.holes ?? []).reduce((s, h) => s + ringArea(h), 0);
    expect(holes).toBeGreaterThan(ringArea(zone.boundary));

    const partId = zone.charts[0].libraryPartId;
    const mesh = await loadPacked(partId);
    const part = chairPart(
      partId,
      mesh,
      zonesFor(partId, mesh).filter((z) => z.id === 'right'),
    );
    const build = await buildAssemblyGeometry(chairInput([part]));
    const out = build!.partOutputs.find((o) => o.part.id === part.id)!;
    expect(Object.keys(out.inlaySoups)).toHaveLength(0);
    expect(out.bodySoup.length).toBe(mesh.positions.length);
    // and it says so, rather than dropping the color silently
    expect(WARNINGS.map((w) => w.message).join(' ')).toMatch(/Couldn't build the cut solid/);
  }, 120000);

  it('leaves a zone-less part completely uncut', async () => {
    clearWarnings();
    const id = sidecar.zones[0].charts[0].libraryPartId;
    const mesh = await loadPacked(id);
    const part = chairPart(id, mesh, []);
    const build = await buildAssemblyGeometry(chairInput([part]));
    const out = build!.partOutputs.find((o) => o.part.id === part.id)!;
    expect(Object.keys(out.inlaySoups)).toHaveLength(0);
    expect(out.bodySoup.length).toBe(mesh.positions.length);
    expect(WARNINGS).toHaveLength(0);
  });
});
