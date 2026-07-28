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
  // Every zone now spans several printed parts, so the whole zone has to be in the scene: a design
  // centred on the zone's UV bbox lands wherever that centre falls, which is generally not the
  // first chart's part. Build the zone's full part set and require the cut to land somewhere in it,
  // with every part it touches still watertight.
  it.each(sidecar.zones.map((z) => [z.id, z] as const))(
    'zone %s carves a pocket into the parts it covers and leaves each watertight',
    async (zoneId, zone) => {
      clearWarnings();
      const entries: { part: AssemblyPart; mesh: Awaited<ReturnType<typeof loadPacked>> }[] = [];
      for (const c of zone.charts) {
        const mesh = await loadPacked(c.libraryPartId);
        const part = chairPart(
          c.libraryPartId,
          mesh,
          zonesFor(c.libraryPartId, mesh).filter((z) => z.id === zoneId),
        );
        entries.push({ part, mesh });
      }
      const parts = entries.map((e) => e.part);

      const { offX, offZ } = zoneTarget(zoneId);
      const build = await buildAssemblyGeometry(
        chairInput(parts, 60, [{ zoneId: null, offX, offZ }]),
      );
      expect(build, 'build returned null').not.toBeNull();

      const wasm = await getManifold();
      let cutParts = 0;
      for (const { part, mesh } of entries) {
        const out = build!.partOutputs.find((o) => o.part.id === part.id)!;
        expect(out, `no output for ${part.id}`).toBeTruthy();
        const inlays = Object.values(out.inlaySoups);
        if (!inlays.length) {
          // untouched by this design: the body must come back byte-for-byte uncut
          expect(out.bodySoup.length).toBe(mesh.positions.length);
          continue;
        }
        cutParts++;
        expect(inlays.every((s) => s.length > 0)).toBe(true);
        const cut = soupToManifold(wasm, out.bodySoup);
        const orig = soupToManifold(wasm, mesh.positions);
        expect(manifoldIsValid(cut), `cut body not manifold: ${part.id}`).toBe(true);
        expect(cut.volume()).toBeLessThan(orig.volume());
        // a 60mm sticker at 1mm deep removes a sliver, not a chunk of the part
        expect(cut.volume()).toBeGreaterThan(orig.volume() * 0.9);
        cut.delete();
        orig.delete();
      }
      expect(
        cutParts,
        `no inlay on any part (warnings: ${WARNINGS.map((w) => w.message).join(' | ')})`,
      ).toBeGreaterThan(0);
    },
    240000,
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
      // Every hole must actually sit inside the outline it is a hole of. Summing areas instead was
      // the old proxy for this, and it stopped meaning anything once a zone's UV footprint had
      // several lobes: the second lobe was being filed as a "hole" of the first, so the sum
      // exceeded the outer while nothing was nested at all.
      const inside = (pt: number[], loop: number[][]): boolean => {
        let c = false;
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
          const [xi, yi] = loop[i];
          const [xj, yj] = loop[j];
          if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)
            c = !c;
        }
        return c;
      };
      // Probed at edge midpoints, not at h[0]: a hole can be tangent to the outline it sits in (one
      // of `back`'s 18 is), and there the first vertex lies exactly ON the boundary, where a
      // crossing-number test has no defined answer. Same reason the bake's own containment test
      // votes rather than trusting one vertex.
      const nestedIn = (inner: number[][], outerLoop: number[][]): boolean => {
        const n = Math.min(inner.length, 9);
        let votes = 0;
        for (let s = 0; s < n; s++) {
          const i = Math.floor((s * inner.length) / n);
          const [x1, y1] = inner[i];
          const [x2, y2] = inner[(i + 1) % inner.length];
          if (inside([(x1 + x2) / 2, (y1 + y2) / 2], outerLoop)) votes++;
        }
        return votes * 2 > n;
      };
      for (const h of zone.holes ?? []) {
        expect(nestedIn(h, zone.boundary), `${_id} hole outside its outline`).toBe(true);
        expect(Math.abs(signedArea(h))).toBeLessThan(outer);
      }
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

/**
 * A spot in the zone guaranteed to be on real design surface: the bbox centre of the largest
 * sub-region any of its parts contributes, with the placement offsets that put a design's centre
 * there. Offset 0/0 puts the design at the zone's UV centre, which on a zone with holes and several
 * lobes is not necessarily over any surface at all — a small design there catches slivers or
 * nothing, which is a property of the chair, not a bug.
 */
function zoneTarget(zoneId: string): { partId: string; offX: number; offZ: number } {
  const zone = sidecar.zones.find((z) => z.id === zoneId)!;
  let best: { partId: string; outer: number[][]; area: number } | null = null;
  const area = (r: number[][]): number => {
    let a = 0;
    for (let i = 0; i < r.length; i++) {
      const p = r[i],
        q = r[(i + 1) % r.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a / 2);
  };
  for (const ch of zone.charts)
    for (const r of ch.subRegions) {
      const a = area(r.outer);
      if (!best || a > best.area) best = { partId: ch.libraryPartId, outer: r.outer, area: a };
    }
  const xs = best!.outer.map((p) => p[0]);
  const ys = best!.outer.map((p) => p[1]);
  const cu = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cv = (Math.min(...ys) + Math.max(...ys)) / 2;
  // placer(): uv = designCentred + (offX, offZ) + zone bbox centre
  return {
    partId: best!.partId,
    offX: cu - zone.uvBounds.maxU / 2,
    offZ: cv - zone.uvBounds.maxV / 2,
  };
}

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
    const l = zoneTarget('left');
    const r = zoneTarget('right');
    const leftId = l.partId;
    const rightId = r.partId;
    const leftMesh = await loadPacked(leftId);
    const rightMesh = await loadPacked(rightId);
    const mk = (): AssemblyPart[] => [
      chairPart(
        leftId,
        leftMesh,
        zonesFor(leftId, leftMesh).filter((z) => z.id === 'left'),
      ),
      chairPart(
        rightId,
        rightMesh,
        zonesFor(rightId, rightMesh).filter((z) => z.id === 'right'),
      ),
    ];

    const small = 30;
    const big = 70;
    const partsA = mk();
    const a = chairInput(partsA, 60, [
      { zoneId: 'left', sizeMM: small, offX: l.offX, offZ: l.offZ },
      { zoneId: 'right', sizeMM: big, offX: r.offX, offZ: r.offZ },
    ]);
    const partsB = mk();
    const b = chairInput(partsB, 60, [
      { zoneId: 'left', sizeMM: big, offX: l.offX, offZ: l.offZ },
      { zoneId: 'right', sizeMM: small, offX: r.offX, offZ: r.offZ },
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
    const { partId, offX, offZ } = zoneTarget('left');
    const mesh = await loadPacked(partId);
    const zones = zonesFor(partId, mesh).filter((z) => z.id === 'left');
    const bound = chairPart(partId, mesh, zones);
    const unbound = chairPart(partId, mesh, zones);
    const a = await removedVolume(bound, chairInput([bound], 60, [{ zoneId: 'left', offX, offZ }]));
    const b = await removedVolume(
      unbound,
      chairInput([unbound], 60, [{ zoneId: null, offX, offZ }]),
    );
    expect(a).toBeGreaterThan(0);
    expect(b).toBeCloseTo(a, 6);
  }, 180000);
});
