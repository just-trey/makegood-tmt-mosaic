import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  buildAssemblyGeometry,
  type ArtworkBuildInput,
  type AssemblyBuildInput,
} from '../src/geometry/assembly';
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

/** One unbound square unless `artworks` names zones explicitly. */
function chairInput(
  parts: AssemblyPart[],
  sizeMM = 60,
  artworks?: { zoneId: string | null; sizeMM?: number; offX?: number; offZ?: number }[],
): AssemblyBuildInput {
  const one = (zoneId: string | null, size: number, offX = 0, offZ = 0): ArtworkBuildInput => ({
    parsed: squareParsed(size),
    zoneId,
    scaleMult: 1,
    offX,
    offZ,
    flipX: false,
    flipY: false,
    rotationDeg: 0,
  });
  return {
    artworks: artworks
      ? artworks.map((a) => one(a.zoneId, a.sizeMM ?? sizeMM, a.offX, a.offZ))
      : [one(null, sizeMM)],
    parts,
    mergeGroups: [],
    colorSettings: {},
    globalDepth: 1,
    radius: 0,
    designFit: 'rect',
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

describe('conformal build on the real chair', () => {
  it.each(sidecar.zones.map((z) => [z.id, z.charts[0].libraryPartId]))(
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

  // The first `right` bake shipped a broken outline — fragmented boundary loops left it with no
  // ring spanning the chart (largest −4326mm² against `left`'s +27352mm²) and "holes" enclosing
  // more than the outer ring, so the zone silently refused every cut. Both halves of that are
  // pinned here: the outline is a sane polygon, and the winding is outward like the others.
  it.each(sidecar.zones.map((z) => [z.id, z] as const))(
    'zone %s has a consistent, outward-wound outline',
    (_id, zone) => {
      const signedArea = (r: number[][]): number => {
        let a = 0;
        for (let i = 0; i < r.length; i++) {
          const p = r[i],
            q = r[(i + 1) % r.length];
          a += p[0] * q[1] - q[0] * p[1];
        }
        return a / 2;
      };
      const outer = signedArea(zone.boundary);
      expect(outer).toBeGreaterThan(0);
      const holes = (zone.holes ?? []).reduce((s, h) => s + Math.abs(signedArea(h)), 0);
      expect(holes).toBeLessThan(outer);
    },
  );

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

describe('per-zone artwork binding', () => {
  /** How much material a build removed from one part. */
  async function removedVolume(part: AssemblyPart, input: AssemblyBuildInput): Promise<number> {
    const build = await buildAssemblyGeometry(input);
    const out = build!.partOutputs.find((o) => o.part.id === part.id)!;
    const wasm = await getManifold();
    const cut = soupToManifold(wasm, out.bodySoup);
    const orig = soupToManifold(wasm, part.positions!);
    const removed = orig.volume() - cut.volume();
    cut.delete();
    orig.delete();
    return removed;
  }

  it('ignores an artwork bound to a zone the part does not carry', async () => {
    clearWarnings();
    const mesh = await loadPacked('chair-storage-left');
    const part = chairPart(
      'chair-storage-left',
      mesh,
      zonesFor('chair-storage-left', mesh).filter((z) => z.id === 'left'),
    );
    const build = await buildAssemblyGeometry(chairInput([part], 60, [{ zoneId: 'right' }]));
    const out = build!.partOutputs.find((o) => o.part.id === part.id)!;
    // the part carries `left` only, so a `right`-bound design must not fall through onto it
    expect(Object.keys(out.inlaySoups)).toHaveLength(0);
    expect(out.bodySoup.length).toBe(mesh.positions.length);
    expect(WARNINGS).toHaveLength(0);
  }, 120000);

  it('routes two differently-sized designs to their own zones in one build', async () => {
    const leftMesh = await loadPacked('chair-storage-left');
    const rightMesh = await loadPacked('chair-storage-right');
    const mk = (): AssemblyPart[] => [
      chairPart(
        'chair-storage-left',
        leftMesh,
        zonesFor('chair-storage-left', leftMesh).filter((z) => z.id === 'left'),
      ),
      chairPart(
        'chair-storage-right',
        rightMesh,
        zonesFor('chair-storage-right', rightMesh).filter((z) => z.id === 'right'),
      ),
    ];

    const small = 30;
    const big = 70;
    const partsA = mk();
    const a = chairInput(partsA, 60, [
      { zoneId: 'left', sizeMM: small },
      { zoneId: 'right', sizeMM: big },
    ]);
    const partsB = mk();
    const b = chairInput(partsB, 60, [
      { zoneId: 'left', sizeMM: big },
      { zoneId: 'right', sizeMM: small },
    ]);

    // Swapping which zone each design is bound to swaps which part loses the most material. If
    // binding were ignored (both designs cut onto every zone) the two builds would be identical.
    const aLeft = await removedVolume(partsA[0], a);
    const aRight = await removedVolume(partsA[1], a);
    const bLeft = await removedVolume(partsB[0], b);
    const bRight = await removedVolume(partsB[1], b);

    for (const v of [aLeft, aRight, bLeft, bRight]) expect(v).toBeGreaterThan(0);
    expect(aLeft).toBeLessThan(aRight);
    expect(bLeft).toBeGreaterThan(bRight);
    // Each part's pocket really followed its binding across the swap. Not an equality check
    // between the two zones: the same design removes slightly different volume on each, since
    // `left` and `right` curve differently — which is the whole point of a conformal wrap.
    expect(bLeft / aLeft).toBeGreaterThan(2);
    expect(aRight / bRight).toBeGreaterThan(2);
  }, 180000);

  it('cuts an unbound artwork exactly where an explicitly bound one lands', async () => {
    // Every flow that exists before the panel can add a second design sends one unbound artwork,
    // so "unbound" has to keep meaning "wherever the part offers" — here, the same pocket.
    const mesh = await loadPacked('chair-storage-left');
    const zones = zonesFor('chair-storage-left', mesh).filter((z) => z.id === 'left');
    const bound = chairPart('chair-storage-left', mesh, zones);
    const unbound = chairPart('chair-storage-left', mesh, zones);
    const a = await removedVolume(bound, chairInput([bound], 60, [{ zoneId: 'left' }]));
    const b = await removedVolume(unbound, chairInput([unbound], 60, [{ zoneId: null }]));
    expect(a).toBeGreaterThan(0);
    expect(b).toBeCloseTo(a, 6);
  }, 180000);
});
