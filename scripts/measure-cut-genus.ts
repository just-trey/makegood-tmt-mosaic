// Topology of each chair part after one zone is cut: genus and solid count before and after, and
// how many zero-volume pieces the cut leaves. A recess changes neither genus nor solid count.
//
//   node_modules/.bin/vite-node scripts/measure-cut-genus.ts [zone] [depthMm]
//
// Defaults to the left side at the default 1mm, with one square covering the whole zone.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AssemblyPart, ParsedSVG } from '../src/types';
import type { ZoneSidecar } from '../src/geometry/zoneCharts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZONE = process.argv[2] ?? 'left';
const DEPTH = Number(process.argv[3] ?? 1);
const SIZE_MM = 700; // bigger than the largest zone, so the square covers all of it

const { buildAssemblyGeometry } = await import('../src/geometry/assembly');
const { reconstructChart } = await import('../src/geometry/zoneCharts');
const { getManifold, soupToManifold } = await import('../src/geometry/manifold');
const { read3MFIndexed } = (await import(
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
  './lib/zonebake.mjs'
)) as { read3MFIndexed: (buf: Buffer) => Promise<{ verts: number[][]; tris: number[][] }> };

const sidecar = JSON.parse(
  readFileSync(path.join(REPO, 'public', 'stl', 'chair-body-zones.json'), 'utf8'),
) as ZoneSidecar;
const zone = sidecar.zones.find((z) => z.id === ZONE);
if (!zone) throw new Error(`no zone "${ZONE}" in the chair sidecar`);

const wasm = await getManifold();
const parts: AssemblyPart[] = [];
for (const [i, chart] of zone.charts.entries()) {
  const id = chart.libraryPartId;
  const m = await read3MFIndexed(readFileSync(path.join(REPO, 'public', 'stl', `${id}.3mf`)));
  const vertices = new Float32Array(m.verts.length * 3);
  m.verts.forEach((v, k) => vertices.set(v, k * 3));
  const positions = new Float32Array(m.tris.length * 9);
  m.tris.forEach((t, k) => t.forEach((vi, c) => positions.set(m.verts[vi], k * 9 + c * 3)));
  parts.push({
    id: i + 1,
    name: id,
    roleId: id,
    libraryPartId: id,
    positions,
    vertices,
    zones: [{ id: zone.id, name: zone.name, chart: reconstructChart(zone, chart, vertices) }],
    patches: null,
    patchIdx: 0,
    boundaryLoops: [
      [
        [-1, 0, -1],
        [1, 0, -1],
        [1, 0, 1],
      ],
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
  } as AssemblyPart);
}

const S = SIZE_MM;
const square: ParsedSVG = {
  shapes: [
    {
      fill: '#ff0000',
      loops: [
        [
          { x: 0, y: 0 },
          { x: S, y: 0 },
          { x: S, y: S },
          { x: 0, y: S },
          { x: 0, y: 0 },
        ],
      ],
      order: 0,
    },
  ],
  bbox: { minX: 0, minY: 0, maxX: S, maxY: S },
  rawSVGCircle: null,
  userUnitMM: 1,
};
const build = await buildAssemblyGeometry({
  artworks: [
    {
      parsed: square,
      zoneId: ZONE,
      scaleMult: 1,
      offX: 0,
      offZ: 0,
      flipX: false,
      flipY: false,
      rotationDeg: 0,
    },
  ],
  parts,
  mergeGroups: [],
  colorSettings: {},
  globalDepth: DEPTH,
  radius: 0,
  designFit: 'rect',
});
if (!build) throw new Error('the build returned nothing');

console.log(`\nZone "${ZONE}" cut ${DEPTH}mm deep; solids are pieces over 1mm³\n`);
console.log('part                        genus     solids   slivers');
console.log('-'.repeat(56));
for (const part of parts) {
  const out = build.partOutputs.find((o) => o.part.id === part.id)!;
  const before = soupToManifold(wasm, part.positions!);
  const after = soupToManifold(wasm, out.bodySoup);
  const pieces = after.decompose();
  const solids = pieces.filter((p) => Math.abs(p.volume()) > 1);
  const main = pieces.reduce((a, b) => (b.volume() > a.volume() ? b : a));
  console.log(
    `${part.name.padEnd(26)} ${`${before.genus()} -> ${main.genus()}`.padEnd(9)} ${String(solids.length).padStart(6)}   ${String(pieces.length - solids.length).padStart(7)}`,
  );
  for (const p of pieces) p.delete();
  before.delete();
  after.delete();
}
