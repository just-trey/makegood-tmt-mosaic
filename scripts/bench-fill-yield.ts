// What a Fill with a Sticker on top of it costs to build on the wheel, and whether their inlays
// overlap in the export.
//
// Run with: node_modules/.bin/vite-node scripts/bench-fill-yield.ts [sticker.svg] [--pattern=zebra]
//   [--scale=50] [--repeat=5]
//   sticker.svg  the design laid on the fill (default: a plain three-colour sticker, inline below)
//   --pattern    a name under public/patterns (default zebra)
//   --scale      the sticker's Scale, in percent (default 50)
//
// Runs `buildAssemblyGeometry` itself, the shipping path, on the three real wheel parts (Top, its
// rotated Bottom copy, and the Cap) set up the way `asmAdoptMesh` sets them up. The first run
// includes the colour pass, which is memoised after that, exactly as in the app.
//
// **Read `yield ms`, not the build's `ms`, for what the fill's cut-back costs.** The whole build
// is too noisy to resolve it: one unchanged build ran 17.8s and 32.7s on the same box. `yield ms`
// is sampled by the V8 profiler out of that same build, as the time spent inside the two functions
// the cut-back adds (`YIELD_FNS`), so it is read off the shipped code rather than a replica. It is
// 0 on a commit without them.
//
// `overlap mm³` is the volume two different colours' inlays share, summed over every pair on
// every part. It is the defect this bench was written for: nonzero means the export carries two
// inlay solids claiming the same space.
import { JSDOM } from 'jsdom';
import { Session } from 'node:inspector/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same hex-only canvas oracle as bench-tile-union.ts: jsdom has no 2d canvas, so normalizeColor
// would collapse every fill to black and merge the pattern into one colour.
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
const { detectFlatPatches, extractPatchBoundary, excludeTriangles, load3MF, loopXZArea } =
  await import('../src/geometry/meshparts');
const { getManifold, soupToManifold, manifoldDelete } = await import('../src/geometry/manifold');
const { WARNINGS, clearWarnings } = await import('../src/warnings');
type AssemblyPart = import('../src/types').AssemblyPart;
type ArtworkBuildInput = import('../src/geometry/assembly').ArtworkBuildInput;

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string =>
  args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt;
const stickerPath = args.find((a) => !a.startsWith('--'));
const pattern = flag('pattern', 'zebra');
const scalePct = Number(flag('scale', '50'));
const repeats = Number(flag('repeat', '5'));

const STICKER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">
  <rect x="0" y="0" width="60" height="20" fill="#c1272d"/>
  <rect x="0" y="20" width="60" height="20" fill="#f5d020"/>
  <rect x="0" y="40" width="60" height="20" fill="#1e5fa8"/>
</svg>`;

let nextId = 1;
/** One library part, faced the way asmAdoptMesh + applyAsmPatchChoice face it (largest patch). */
async function libraryPart(
  file: string,
  name: string,
  extra: Partial<AssemblyPart> = {},
): Promise<AssemblyPart> {
  const buf = readFileSync(path.join(REPO, 'public/stl', file));
  const r = await load3MF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const patches = detectFlatPatches(r.positions);
  const patch = patches[0];
  const { loops } = extractPatchBoundary(r.positions, patch.triIndices);
  loops.sort((a, b) => loopXZArea(b) - loopXZArea(a));
  return {
    id: nextId++,
    name,
    roleId: file,
    positions: r.positions,
    vertices: r.vertices,
    patches,
    patchIdx: 0,
    boundaryLoops: loops,
    restPositions: excludeTriangles(r.positions, patch.triIndices),
    patchNormal: patch.normal,
    topZ: patch.offset,
    baseDepth: 0,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
    ...extra,
  };
}

const top = await libraryPart('wheel-half.3mf', 'Top');
const parts: AssemblyPart[] = [
  top,
  { ...top, id: nextId++, name: 'Bottom', isDuplicateOf: top.id, angleDeg: 180 },
  await libraryPart('wheel-hub-cap.3mf', 'Cap', { cutThrough: true, cutThroughDepth: 3 }),
];

const fillParsed = parseSVGDocument(
  readFileSync(path.join(REPO, 'public/patterns', `${pattern}.svg`), 'utf-8'),
);
const stickerParsed = parseSVGDocument(
  stickerPath ? readFileSync(path.resolve(stickerPath), 'utf-8') : STICKER,
);
const artwork = (parsed: typeof fillParsed, mode: 'fill' | 'sticker', scaleMult: number) =>
  ({
    parsed,
    name: mode,
    zoneId: null,
    scaleMult,
    maxScaleMult: 4,
    offX: 0,
    offZ: 0,
    flipX: false,
    flipY: false,
    rotationDeg: 0,
    mode,
  }) satisfies ArtworkBuildInput;

const wasm = await getManifold();
/** Volume shared by every pair of different colours' inlays on every part, in mm³. */
function inlayOverlap(outputs: { inlaySoups: Record<number, Float32Array> }[]): number {
  let total = 0;
  for (const o of outputs) {
    const solids = Object.values(o.inlaySoups).map((s) => soupToManifold(wasm, s));
    for (let i = 0; i < solids.length; i++)
      for (let j = i + 1; j < solids.length; j++) {
        const both = wasm.Manifold.intersection(solids[i], solids[j]);
        total += both.volume();
        manifoldDelete(both);
      }
    solids.forEach(manifoldDelete);
  }
  return total;
}

/** The two functions the fill's cut-back runs: the mask per zone, and the subtraction per color. */
const YIELD_FNS = new Set(['differenceAllChecked', 'placedInkFeatures']);

interface ProfileNode {
  id: number;
  callFrame: { functionName: string };
  children?: number[];
}
interface Profile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}

/** Milliseconds of samples whose stack passes through any of `fns`, counted once per sample. */
function inclusiveMs(profile: Profile, fns: Set<string>): number {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const inside = new Set<number>();
  const mark = (id: number): void => {
    if (inside.has(id)) return;
    inside.add(id);
    byId.get(id)?.children?.forEach(mark);
  };
  for (const n of profile.nodes) if (fns.has(n.callFrame.functionName)) mark(n.id);
  let us = 0;
  profile.samples.forEach((id, i) => {
    if (inside.has(id)) us += profile.timeDeltas[i] ?? 0;
  });
  return us / 1000;
}

const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.setSamplingInterval', { interval: 100 });

console.log(
  `wheel, ${pattern} Fill + ${stickerPath ? path.basename(stickerPath) : 'inline sticker'} ` +
    `at ${scalePct}%\n`,
);
console.log('run\tms\tyield ms\toverlap mm³\tinlays\twarnings');
const times: number[] = [];
const yields: number[] = [];
for (let run = 1; run <= repeats; run++) {
  clearWarnings();
  await session.post('Profiler.start');
  const t0 = performance.now();
  const built = await buildAssemblyGeometry({
    artworks: [artwork(fillParsed, 'fill', 1), artwork(stickerParsed, 'sticker', scalePct / 100)],
    parts,
    mergeGroups: [],
    colorSettings: {},
    globalDepth: 1,
    radius: 138,
    autoMergeLevel: 1,
  });
  const ms = performance.now() - t0;
  const { profile } = await session.post('Profiler.stop');
  const yieldMs = inclusiveMs(profile as Profile, YIELD_FNS);
  times.push(ms);
  yields.push(yieldMs);
  if (!built) throw new Error('build returned nothing');
  const inlays = built.partOutputs.reduce((n, o) => n + Object.keys(o.inlaySoups).length, 0);
  console.log(
    `${run}\t${Math.round(ms)}\t${Math.round(yieldMs)}\t\t${inlayOverlap(built.partOutputs).toFixed(2)}\t\t${inlays}\t` +
      JSON.stringify(WARNINGS.map((w) => w.message)),
  );
}
const median = (xs: number[]): number =>
  Math.round([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]);
console.log(`\nmedian build ${median(times)}ms, of which the cut-back ${median(yields)}ms`);
session.disconnect();
