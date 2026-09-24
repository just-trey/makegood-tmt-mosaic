// Traces every face the Advanced dropdown offers (the first six patches) of every packed part in
// public/stl/ and reports, per patch, how many rings closed, how many boundary edges no ring could
// take, and the median time of N runs. The two numbers a change to extractPatchBoundary has to
// hold: zero open edges everywhere, and chair-seat-center patch 0 (the default patch, hit on every
// chair load) well under 2 ms — an earlier attempt took it to 317 ms.
//
//   npx vite-node scripts/bench-patch-boundary.mjs [N=30]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { detectFlatPatches, extractPatchBoundary } from '../src/geometry/meshparts.ts';
import { read3MFIndexed } from './lib/zonebake.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const N = Number(process.argv[2] || 30);
const library = JSON.parse(readFileSync(resolve(REPO, 'public/stl/parts.json'), 'utf8'));

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const rows = [];
let withOpen = 0;
for (const e of library) {
  const mesh = await read3MFIndexed(readFileSync(resolve(REPO, 'public', e.file)));
  const soup = new Float32Array(mesh.tris.length * 9);
  mesh.tris.forEach((t, i) => t.forEach((vi, k) => soup.set(mesh.verts[vi], i * 9 + k * 3)));
  const patches = detectFlatPatches(soup).slice(0, 6);
  patches.forEach((p, pi) => {
    const times = [];
    let result;
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      result = extractPatchBoundary(soup, p.triIndices);
      times.push(performance.now() - t0);
    }
    if (result.openEdges) withOpen++;
    rows.push({
      part: e.id,
      patch: pi,
      tris: p.triIndices.length,
      rings: result.loops.length,
      openEdges: result.openEdges,
      medianMs: +median(times).toFixed(3),
    });
  });
}
console.table(rows.filter((r) => r.patch === 0 || r.openEdges || r.medianMs > 2));
console.log(`patches with an open edge: ${withOpen}/${rows.length}`);
const seat = rows.find((r) => r.part === 'chair-seat-center' && r.patch === 0);
console.log(`chair-seat-center patch 0: ${seat.medianMs} ms median of ${N}`);
const slowest = rows.reduce((w, r) => (r.medianMs > w.medianMs ? r : w));
console.log(`slowest: ${slowest.part} patch ${slowest.patch}, ${slowest.medianMs} ms`);
