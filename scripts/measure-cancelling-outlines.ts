// How often a real design would raise the "outlines cross over themselves and cancel out" warning
// (cancelsOut, src/geometry/regions.ts), and how many loops shapeToFeature drops for net area at
// all. Every file here prints as drawn, so any `cancels` count is a false positive.
//
//   node_modules/.bin/vite-node scripts/measure-cancelling-outlines.ts          SVGs + raster corpus
//   node_modules/.bin/vite-node scripts/measure-cancelling-outlines.ts svg      SVGs only
//
// SVGs: tests/fixtures/patterns, public/templates, and every *.svg under gitignored stubs/ when
// present. Raster: the scripts/lib/rastercorpus.ts corpus (needs stubs/ and Playwright's Chromium),
// traced at both palette sizes the app reaches by default and at Detail default and max.
import { JSDOM } from 'jsdom';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SVGShape } from '../src/types';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Hex-only fillStyle oracle, as bench-regions.ts: a named fill collapses to black, which changes
// no loop's geometry, and geometry is all this counts.
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
const { cancelsOut, shapeToFeature } = await import('../src/geometry/regions');
const { signedArea } = await import('../src/svg/path');

interface Row {
  source: string;
  shapes: number;
  loops: number;
  /** Loops at or under shapeToFeature's net-area floor: empty ones and cancelling ones. */
  belowFloor: number;
  cancels: number;
  /** Shapes shapeToFeature returned null for. */
  shapesGone: number;
}

function count(source: string, shapes: SVGShape[]): Row {
  let loops = 0,
    belowFloor = 0,
    cancels = 0,
    shapesGone = 0;
  for (const s of shapes) {
    loops += s.loops.length;
    belowFloor += s.loops.filter((l) => Math.abs(signedArea(l)) <= 1e-7).length;
    cancels += s.loops.filter(cancelsOut).length;
    if (!shapeToFeature(s)) shapesGone++;
  }
  return { source, shapes: shapes.length, loops, belowFloor, cancels, shapesGone };
}

function svgFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) out.push(...svgFiles(full));
    else if (e.toLowerCase().endsWith('.svg')) out.push(full);
  }
  return out.sort();
}

const rows: Row[] = [];
const svgDirs = ['tests/fixtures/patterns', 'public/templates', 'stubs'];
for (const dir of svgDirs) {
  for (const file of svgFiles(path.join(REPO, dir))) {
    const rel = path.relative(REPO, file);
    try {
      rows.push(count(rel, parseSVGDocument(readFileSync(file, 'utf8')).shapes));
    } catch (e) {
      console.log(`skip ${rel}: ${(e as Error).message}`);
    }
  }
}

if (process.argv[2] !== 'svg') {
  const { loadCorpus } = await import('./lib/rastercorpus');
  const { parseRasterImage } = await import('../src/raster/parse');
  const { DETAIL_DEFAULT, DETAIL_MAX } = await import('../src/raster/stats');
  for (const src of await loadCorpus()) {
    for (const colors of [...new Set([6, src.colors])]) {
      for (const detail of [DETAIL_DEFAULT, DETAIL_MAX]) {
        const label = `raster ${src.name} colors=${colors} detail=${detail}`;
        try {
          rows.push(count(label, parseRasterImage(src.working, { colors, detail }).parsed.shapes));
        } catch (e) {
          console.log(`skip ${label}: ${(e as Error).message}`);
        }
      }
    }
  }
}

console.table(rows);
const sum = (k: keyof Omit<Row, 'source'>, raster: boolean) =>
  rows.filter((r) => r.source.startsWith('raster') === raster).reduce((n, r) => n + r[k], 0);
for (const raster of [false, true]) {
  const n = rows.filter((r) => r.source.startsWith('raster') === raster).length;
  console.log(
    `${raster ? 'raster traces' : 'SVG files'}: ${n} runs, ${sum('loops', raster)} loops, ` +
      `${sum('belowFloor', raster)} under the floor, ${sum('cancels', raster)} cancel out, ` +
      `${sum('shapesGone', raster)} shapes gone`,
  );
}
