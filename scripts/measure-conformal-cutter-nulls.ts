// Counts how often a chair zone's cutter comes back null during a real Fill build.
//
// Run with: node_modules/.bin/vite-node scripts/measure-conformal-cutter-nulls.ts \
//   [pattern] [zone] [scale] [offX] [offZ] [libraryPartId]
//   pattern        a name under public/patterns (default zebra)
//   zone           a zone id from public/stl/chair-body-zones.json (default left)
//   scale          scaleMult, 1 = the Scale control at 100% (default 1)
//   offX, offZ     placement offset in mm (default 0 0)
//   libraryPartId  build only this part of the zone, which is faster (default: every part)
//
// A first-attempt null from ConformalZoneMapper.buildCutter is where the extrude repair in
// assembly.ts starts, and a null on every rung is the chair's `Couldn't cut color … into …`. The
// count includes the repair's own retries, so `nulls 0` is the clean result and anything else
// needs the per-region detail. The build is the shipping buildAssemblyGeometry over the packed
// meshes and baked charts, with the parts built as tests/chair-build.test.ts builds them and the
// defaults a freshly loaded design gets (100% scale, 1mm depth, Fill).
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same hex-only canvas oracle as bench-tile-union.ts: jsdom has no 2d canvas, so normalizeColor
// would collapse every fill to black and merge the pattern to one colour.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.DOMParser = dom.window.DOMParser;
g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
dom.window.HTMLCanvasElement.prototype.getContext = function () {
  let value = '#000000';
  return {
    get fillStyle() {
      return value;
    },
    set fillStyle(s: string) {
      const str = String(s).trim().toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(str)) value = str;
    },
  };
} as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;

const { parseSVGDocument } = await import('../src/svg/parse');
const { buildAssemblyGeometry } = await import('../src/geometry/assembly');
const { ConformalZoneMapper } = await import('../src/geometry/conformal');
const { reconstructChart } = await import('../src/geometry/zoneCharts');
const { getManifold } = await import('../src/geometry/manifold');
const { WARNINGS, clearWarnings } = await import('../src/warnings');
// @ts-expect-error — plain-JS tooling module, no .d.ts
const { read3MFIndexed } = await import('./lib/zonebake.mjs');
type AssemblyPart = import('../src/types').AssemblyPart;
type DesignZone = import('../src/types').DesignZone;
type ZoneSidecar = import('../src/geometry/zoneCharts').ZoneSidecar;

const [pattern = 'zebra', zoneId = 'left', scale = '1', offX = '0', offZ = '0', only] =
  process.argv.slice(2);

await getManifold();
const sidecar: ZoneSidecar = JSON.parse(
  readFileSync(path.join(REPO, 'public/stl/chair-body-zones.json'), 'utf8'),
);
const zone = sidecar.zones.find((z) => z.id === zoneId);
if (!zone) throw new Error(`no zone "${zoneId}" in chair-body-zones.json`);

const parts: AssemblyPart[] = [];
for (const c of zone.charts) {
  if (only && c.libraryPartId !== only) continue;
  const m = await read3MFIndexed(
    readFileSync(path.join(REPO, 'public/stl', `${c.libraryPartId}.3mf`)),
  );
  const vertices = new Float32Array(m.verts.length * 3);
  m.verts.forEach((v: number[], i: number) => vertices.set(v, i * 3));
  const positions = new Float32Array(m.tris.length * 9);
  m.tris.forEach((t: number[], i: number) =>
    t.forEach((vi, k) => positions.set(m.verts[vi], i * 9 + k * 3)),
  );
  const zones: DesignZone[] = [];
  for (const z of sidecar.zones)
    for (const ch of z.charts)
      if (ch.libraryPartId === c.libraryPartId)
        zones.push({ id: z.id, name: z.name, chart: reconstructChart(z, ch, vertices) });
  // Only `zones` decides how a charted part is cut; the flat-patch fields are stand-ins, exactly
  // as in tests/chair-build.test.ts.
  parts.push({
    id: parts.length + 1,
    name: c.libraryPartId,
    roleId: c.libraryPartId,
    libraryPartId: c.libraryPartId,
    positions,
    vertices,
    zones,
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
  });
}

let calls = 0;
let nulls = 0;
const real = ConformalZoneMapper.prototype.buildCutter;
ConformalZoneMapper.prototype.buildCutter = function (...args) {
  calls++;
  const out = real.apply(this, args);
  if (!out) nulls++;
  return out;
};

const parsed = parseSVGDocument(
  readFileSync(path.join(REPO, 'public/patterns', `${pattern}.svg`), 'utf8'),
);
clearWarnings();
const t0 = performance.now();
const build = await buildAssemblyGeometry({
  artworks: [
    {
      parsed,
      name: `${pattern}.svg`,
      zoneId,
      scaleMult: Number(scale),
      offX: Number(offX),
      offZ: Number(offZ),
      flipX: false,
      flipY: false,
      rotationDeg: 0,
      mode: 'fill',
    },
  ],
  parts,
  mergeGroups: [],
  colorSettings: {},
  globalDepth: 1,
  radius: 138,
  designFit: 'rect',
});
const ms = Math.round(performance.now() - t0);
const cutWarnings = WARNINGS.map((w) => w.message).filter((m) => m.startsWith("Couldn't cut"));
// A refused fill falls back to one tile and says why; without this a low count reads as clean.
const refused = WARNINGS.map((w) => w.message).filter((m) => /tile|repeat/i.test(m));
const inlays = (build?.partOutputs ?? []).map(
  (o) => `${o.part.name}:${Object.keys(o.inlaySoups).length}`,
);
console.log(
  [pattern, zoneId, scale, offX, offZ, only ?? '*'].join(' '),
  `| cutter calls ${calls}, nulls ${nulls} (retries included) | inlays ${inlays.join(' ') || 'none'}`,
  `| couldn't-cut ${cutWarnings.length} | ${ms}ms`,
);
[...cutWarnings, ...refused].forEach((w) => console.log(`  ! ${w}`));
