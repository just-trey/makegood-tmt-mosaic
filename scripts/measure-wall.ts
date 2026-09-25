// How thin the wall under each shipped design face gets, against the part-wide depth bound, and
// what measuring it costs.
//
//   node_modules/.bin/vite-node scripts/measure-wall.ts
//
// Backs the numbers quoted at `FlatZoneMapper.boundByWall` and `maxCutDepth`. Every selectable
// patch (the part panel offers the top six by area) on the fetched meshes, plus the generated
// hubcap at its default diameter. "wall" is the thinnest wall anywhere under the whole face, so a
// region cut deeper than it goes through somewhere; "bound" is maxCutDepth(), Infinity where the
// face declines.
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AssemblyPart, FlatPatch, PolyFeature } from '../src/types';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.DOMParser = dom.window.DOMParser;

const { read3MF, readMesh } = (await import(
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
  './lib/mesh.mjs'
)) as {
  read3MF: (buf: Buffer) => Promise<Float32Array>;
  readMesh: (file: string) => Promise<Float32Array>;
};
const { detectFlatPatches } = await import('../src/geometry/meshparts');
const { applyAsmPatchChoice } = await import('../src/assembly/parts');
const { FlatZoneMapper } = await import('../src/geometry/zones');
const { buildWallField, minWallUnder } = await import('../src/geometry/wall');
const { buildHubcapBody, HUBCAP_DEFAULT_DIAMETER_MM } = await import('../src/geometry/hubcap');

const PATCHES_PER_PART = 6;

/** A part with `patch` chosen, its face fields written by the app's own applyAsmPatchChoice. */
function partWithPatch(positions: Float32Array, patches: FlatPatch[], rank: number): AssemblyPart {
  const part = {
    id: 1,
    name: 'measured',
    roleId: 'r',
    positions,
    patches,
    patchIdx: rank,
    baseDepth: 3,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
  } as unknown as AssemblyPart;
  applyAsmPatchChoice(part);
  return part;
}

const fmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : String(v));

function report(label: string, positions: Float32Array, patches: FlatPatch[], rank: number): void {
  const part = partWithPatch(positions, patches, rank);
  const mapper = new FlatZoneMapper(part, [part], true, null);
  const face = mapper.boundary();
  const faceY = mapper.frameAt(0, 0).origin.y;
  const t0 = performance.now();
  const field = buildWallField(positions, faceY, mapper.nsign);
  const t1 = performance.now();
  const wall = face ? minWallUnder(field, face) : NaN;
  const t2 = performance.now();
  const n = patches[rank].normal.map((c) => c.toFixed(2)).join(', ');
  console.log(
    `${label.padEnd(12)} ${String(rank).padStart(4)}  (${n.padEnd(17)})  ${fmt(mapper.maxCutDepth()).padStart(8)}` +
      `  ${fmt(wall).padStart(8)}  ${(t1 - t0).toFixed(1).padStart(6)}  ${(t2 - t1).toFixed(1).padStart(6)}`,
  );
}

console.log('\nThinnest wall under each selectable face, mm; time in ms\n');
console.log('part         rank  face normal            bound      wall   field   query');
console.log('-'.repeat(78));
for (const id of ['wheel-half', 'footrest']) {
  const positions = await read3MF(readFileSync(path.join(REPO, 'public', 'stl', `${id}.3mf`)));
  const patches = detectFlatPatches(positions);
  for (let r = 0; r < Math.min(PATCHES_PER_PART, patches.length); r++)
    report(id, positions, patches, r);
}
{
  const clips = await readMesh(path.join(REPO, 'public', 'stl', 'hubcap-clips.3mf'));
  const body = await buildHubcapBody(
    { kind: 'circle', diameterMm: HUBCAP_DEFAULT_DIAMETER_MM },
    clips,
  );
  const patches = detectFlatPatches(body.positions);
  // Only the +Y face: the role's preferFaceNormal, and the one side a design goes on.
  report(
    'hubcap',
    body.positions,
    patches,
    patches.findIndex((p) => p.normal[1] > 0.9),
  );
}

// Query cost against edge count: one colour made of many small decagons laid over the wheel's
// face, as a traced photo's colour arrives. Unclipped, so the wall it finds means nothing here.
console.log('\nQuery time against region size, wheel-half rank 0\n');
{
  const positions = await read3MF(readFileSync(path.join(REPO, 'public', 'stl', 'wheel-half.3mf')));
  const part = partWithPatch(positions, detectFlatPatches(positions), 0);
  const mapper = new FlatZoneMapper(part, [part], false, null);
  const field = buildWallField(positions, mapper.frameAt(0, 0).origin.y, mapper.nsign);
  for (const count of [100, 1000, 6000]) {
    const side = Math.ceil(Math.sqrt(count));
    const polys: number[][][][] = [];
    for (let k = 0; k < count; k++) {
      const cx = -100 + (200 * (k % side)) / side;
      const cz = -100 + (200 * Math.floor(k / side)) / side;
      const ring: number[][] = [];
      for (let j = 0; j < 10; j++)
        ring.push([cx + Math.cos((j * Math.PI) / 5), cz + Math.sin((j * Math.PI) / 5)]);
      ring.push(ring[0]);
      polys.push([ring]);
    }
    const feat = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: polys },
    } as PolyFeature;
    const t0 = performance.now();
    minWallUnder(field, feat);
    console.log(
      `${String(count).padStart(5)} polygons, ${String(count * 10).padStart(5)} edges: ${(performance.now() - t0).toFixed(1)} ms`,
    );
  }
}
