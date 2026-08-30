// Finds where Fill mode's tile union starts dropping tiles, against the real turf 6.5.
//
// Run with: node_modules/.bin/vite-node scripts/bench-tile-union.ts [pattern] [n,n,n]
//   pattern  a name under public/patterns (default zebra)
//   n        tile grid spans to sweep, so n=20 means a 20x20 grid (default 13,17,21,25)
//
// turf 6.5's clipper does not throw when it gives up on a big union: it returns a partial result,
// which reaches the user as a `Couldn't merge the shapes` warning naming no cause and a part that
// is missing geometry. So the signal is the points in the result: a run that fails produces FEWER
// points out than one an eighth its size.
//
// `mergeFailures` is a yes/no beside it, not a count. warnBuild dedupes on the exact message and
// every failure here shares one label, so the column can only ever read 0 or 1.
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
const { computeNetRegionsByColor } = await import('../src/geometry/regions');
const { featureVertexCount, tileFeature } = await import('../src/geometry/patterns');
const { WARNINGS, clearWarnings } = await import('../src/warnings');

const pattern = process.argv[2] ?? 'zebra';
const spans = (process.argv[3] ?? '13,17,21,25').split(',').map(Number);

const parsed = parseSVGDocument(
  readFileSync(path.join(REPO, 'public/patterns', `${pattern}.svg`), 'utf-8'),
);
const { byColor } = await computeNetRegionsByColor(parsed.shapes);
const vb = parsed.viewBox;
if (!vb) throw new Error(`${pattern}.svg declares no viewBox, so it has no tile period`);

// The heaviest colour, because the tile union runs once per colour: that is the operation the
// ceiling applies to, not the design's total.
const [hex, feature] = Object.entries(byColor).sort(
  (a, b) => featureVertexCount(b[1]) - featureVertexCount(a[1]),
)[0];
const perTile = featureVertexCount(feature);
console.log(`${pattern}.svg colour ${hex}: ${perTile} points per tile, ${vb.w}x${vb.h} tile\n`);
console.log('tiles\tpointsIn\tpointsOut\tmergeFailures\tms');

for (const n of spans) {
  clearWarnings();
  const t0 = performance.now();
  const out = await tileFeature(feature, {
    i0: 0,
    i1: n - 1,
    j0: 0,
    j1: n - 1,
    pitchX: vb.w,
    pitchY: vb.h,
    count: n * n,
  });
  const ms = Math.round(performance.now() - t0);
  const fails = WARNINGS.filter((w) => /Couldn't merge the shapes/.test(w.message)).length;
  console.log(
    `${n * n}\t${n * n * perTile}\t${featureVertexCount(out)}\t${fails}\t${ms}`.replace(
      /\t/g,
      '\t\t',
    ),
  );
}
