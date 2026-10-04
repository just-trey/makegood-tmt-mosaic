// Times Fill mode's tile union, and says whether it kept every tile, against the real turf 6.5.
//
// Run with: node_modules/.bin/vite-node scripts/bench-tile-union.ts [pattern] [n,n,n] [colour]
//   pattern  a name under public/patterns (default zebra)
//   n        tile grid spans to sweep: 20 is a 20x20 grid, 3x300 is 3 rows of 300 (default
//            13,17,21,25)
//   colour   the hex of the colour to tile (default the one with the most points per tile)
//
// A union that loses tiles shows as areaKept under 1: every bundled pattern is drawn inside its
// own cell, so n tiles should cover exactly n times one tile's area. `mergeFailures` is a yes/no
// beside it, not a count: warnBuild dedupes on the exact message and every failure here shares one
// label. `refused` is a union too big for the engine even split (UnionTooBig), which fill mode
// turns into one tile and a warning.
//
// This is the shipping path, not a replica: tileFeature -> unionAllCooperative -> safeUnion, over
// the feature computeNetRegionsByColor builds for one colour of a real bundled pattern. The only
// thing invented is the grid, which stands in for the placer a live build would supply.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same hex-only canvas oracle as bench-regions.ts, and for the same reason: jsdom has no 2d
// canvas, so normalizeColor would collapse every fill to black and merge the pattern to one colour.
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
const { computeNetRegionsByColor, planarArea, UnionTooBig } =
  await import('../src/geometry/regions');
const { featureVertexCount, tileFeature } = await import('../src/geometry/patterns');
const { WARNINGS, clearWarnings } = await import('../src/warnings');

const pattern = process.argv[2] ?? 'zebra';
const spans = (process.argv[3] ?? '13,17,21,25').split(',').map((span) => {
  const [r, c] = span.split('x').map(Number);
  return { rows: r, cols: c ?? r };
});
const only = process.argv[4]?.toLowerCase();

const parsed = parseSVGDocument(
  readFileSync(path.join(REPO, 'public/patterns', `${pattern}.svg`), 'utf-8'),
);
const { byColor } = await computeNetRegionsByColor(parsed.shapes);
const vb = parsed.viewBox;
if (!vb) throw new Error(`${pattern}.svg declares no viewBox, so it has no tile period`);

// The heaviest colour by default, because the refusal budget is set against it.
const [hex, feature] = only
  ? [only, byColor[only]]
  : Object.entries(byColor).sort((a, b) => featureVertexCount(b[1]) - featureVertexCount(a[1]))[0];
if (!feature) throw new Error(`${pattern}.svg has no colour ${only}`);
const perTile = featureVertexCount(feature);
const tileArea = planarArea(feature);
console.log(`${pattern}.svg colour ${hex}: ${perTile} points per tile, ${vb.w}x${vb.h} tile\n`);
console.log('tiles\tpointsIn\tpointsOut\tareaKept\tmergeFailures\tms');

for (const { rows, cols } of spans) {
  clearWarnings();
  const n = rows * cols;
  const t0 = performance.now();
  let out = null;
  try {
    out = await tileFeature(feature, {
      i0: 0,
      i1: cols - 1,
      j0: 0,
      j1: rows - 1,
      pitchX: vb.w,
      pitchY: vb.h,
      count: n,
    });
  } catch (e) {
    if (!(e instanceof UnionTooBig)) throw e;
  }
  const ms = Math.round(performance.now() - t0);
  const fails = WARNINGS.filter((w) => /Couldn't merge the shapes/.test(w.message)).length;
  const kept = out ? (planarArea(out) / (n * tileArea)).toFixed(6) : 'refused';
  console.log(
    `${n}\t${n * perTile}\t${featureVertexCount(out)}\t${kept}\t${fails}\t${ms}`.replace(
      /\t/g,
      '\t\t',
    ),
  );
}
