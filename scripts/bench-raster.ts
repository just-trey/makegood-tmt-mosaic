// What a traced raster costs the region pipeline, and the four raster numbers that were left to
// measurement rather than argument.
//
//   node_modules/.bin/vite-node scripts/bench-raster.ts [size...]   synthetic cost curves
//   node_modules/.bin/vite-node scripts/bench-raster.ts corpus      edge density over real files
//   node_modules/.bin/vite-node scripts/bench-raster.ts colors      regions against palette size
//   node_modules/.bin/vite-node scripts/bench-raster.ts curve       alphaMax x flatness sweep
//   node_modules/.bin/vite-node scripts/bench-raster.ts scale       working size against downscale
//   node_modules/.bin/vite-node scripts/bench-raster.ts render      edge density against export size
//   node_modules/.bin/vite-node scripts/bench-raster.ts alpha       alphaMax against a known-square shape
//   node_modules/.bin/vite-node scripts/bench-raster.ts sizes       edge density against measurement size
//   node_modules/.bin/vite-node scripts/bench-raster.ts blur        compensating blur against downscale
//   node_modules/.bin/vite-node scripts/bench-raster.ts knee        does a knee survive a cheaper image?
//
// corpus, colors and curve read the cached corpus. scale, render and alpha bring their own source.
// sizes, blur and knee take their file list from CORPUS and decode afresh, so they need the files
// present; knee also reads the cache for each source's carried edgeDensity.
//
// The synthetic mode settles a cost question: the working resolution (MAX_WORKING_EDGE) and
// whether shapes group per color or per connected component. Procedural sources are right for it
// because it is about the *shape* of the cost curve, and only a generated image lets the ring
// count be pushed past what any real file produces to find where each strategy breaks.
//
// The two costs pull in opposite directions and neither can be reasoned about from the other:
//
//   - `shapeToFeature` resolves hole-vs-solid by testing every ring in a shape against every other
//     ring, so it is O(rings² · len) *within one shape*. Grouping per color puts every ring of a
//     color in one shape and is the expensive case here. It also runs synchronously, before
//     computeNetRegionsByColor's first yield, so whatever it costs is frozen main thread.
//   - The paint-order pass runs ~3 polygon booleans per shape against a growing accumulator, so
//     grouping per component (hundreds of shapes) is the expensive case there. That pass is the
//     ~9s-on-135-paths hot spot recorded in docs/tech-debt.md.
//
// The four corpus modes settle taste questions instead, and synthetic sources are wrong for every
// one of them: a generated image has no anti-aliased fringe, no JPEG ringing, no scanner texture
// and no lossy history, which is the entire subject. They run against real files decoded through
// the browser (scripts/lib/rastercorpus.ts) and drive quantize/traceLabelMap directly, because a
// sweep has to set the parameters autoParams would otherwise derive.
import { parseRasterImage } from '../src/raster/parse';
import type { ShapeGranularity } from '../src/raster/parse';
import { computeNetRegionsByColor, shapeToFeature } from '../src/geometry/regions';
import { MAX_COLORS, MIN_COLORS, quantize } from '../src/raster/quantize';
import { traceLabelMap } from '../src/raster/trace';
import { fitChain } from '../src/raster/curve';
import { autoParams, isPhotographic, measureImage, DETAIL_DEFAULT } from '../src/raster/stats';
import { MAX_WORKING_EDGE, MEASURE_EDGE, workingSize } from '../src/raster/decode';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORPUS,
  loadCorpus,
  decodeAtEdges,
  decodeManyAtEdges,
  renderAtEdges,
  writeAuthoredSources,
} from './lib/rastercorpus';
import type { CorpusGroup, DecodedSource, Provenance } from './lib/rastercorpus';
import type { RasterImage, TraceParams } from '../src/raster/types';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import type { Pt, SVGShape } from '../src/types';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise — the closest a procedural source gets to a photograph's local structure. */
function valueNoise(
  w: number,
  h: number,
  cells: number,
  seed: number,
): (x: number, y: number) => number {
  const rng = mulberry32(seed);
  const g: number[] = [];
  for (let i = 0; i < (cells + 1) * (cells + 1); i++) g.push(rng());
  const at = (i: number, j: number) => g[Math.min(cells, j) * (cells + 1) + Math.min(cells, i)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = (x / w) * cells,
      fy = (y / h) * cells;
    const i = Math.floor(fx),
      j = Math.floor(fy);
    const tx = smooth(fx - i),
      ty = smooth(fy - j);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * tx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tx;
    return a + (b - a) * ty;
  };
}

function photoLike(w: number, h: number): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const r = valueNoise(w, h, 14, 1);
  const g = valueNoise(w, h, 11, 2);
  const b = valueNoise(w, h, 9, 3);
  const grain = mulberry32(7);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = (grain() - 0.5) * 18;
      data[i] = r(x, y) * 255 + n;
      data[i + 1] = g(x, y) * 255 + n;
      data[i + 2] = b(x, y) * 255 + n;
      data[i + 3] = 255;
    }
  return { data, w, h };
}

function flatArtLike(w: number, h: number): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const field = valueNoise(w, h, 5, 42);
  const palette = [
    [232, 62, 62],
    [46, 134, 222],
    [253, 203, 110],
    [39, 174, 96],
    [44, 62, 80],
  ];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = palette[Math.min(palette.length - 1, Math.floor(field(x, y) * palette.length))];
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  return { data, w, h };
}

function ringStats(shapes: SVGShape[]) {
  let rings = 0,
    points = 0,
    maxRings = 0;
  for (const s of shapes) {
    rings += s.loops.length;
    maxRings = Math.max(maxRings, s.loops.length);
    for (const l of s.loops) points += l.length;
  }
  return { rings, points, maxRings };
}

async function run(name: string, img: RasterImage, granularity: ShapeGranularity) {
  const t0 = performance.now();
  const { parsed, palette, componentCount, capped } = parseRasterImage(
    img,
    { colors: 8, detail: DETAIL_DEFAULT },
    granularity,
  );
  const traceMs = performance.now() - t0;

  const { rings, points, maxRings } = ringStats(parsed.shapes);

  const t1 = performance.now();
  for (const s of parsed.shapes) shapeToFeature(s);
  const stfMs = performance.now() - t1;

  const t2 = performance.now();
  await computeNetRegionsByColor(parsed.shapes, () => {});
  const regionsMs = performance.now() - t2;

  return {
    name,
    granularity,
    size: `${img.w}x${img.h}`,
    colors: palette.length,
    components: componentCount,
    shapes: parsed.shapes.length,
    rings,
    maxRings,
    points,
    capped,
    traceMs: +traceMs.toFixed(1),
    stfMs: +stfMs.toFixed(1),
    regionsMs: +regionsMs.toFixed(1),
    totalMs: +(traceMs + regionsMs).toFixed(1),
  };
}

/**
 * Turn angles sharp enough to be a corner rather than a flattened curve.
 *
 * This is the only direct read on the failure `alphaMax` actually has: too high and a square logo
 * comes back with rounded corners, which shows up here as sharp turns disappearing. Point count
 * cannot see it, because rounding a corner replaces one hard vertex with several soft ones and can
 * leave the total unchanged or higher. Flattening barely moves it either way, since a finer
 * `flatness` subdivides curves into segments that are individually straighter.
 */
const SHARP_TURN_RAD = Math.PI / 3;

function sharpTurns(shapes: SVGShape[]): number {
  let sharp = 0;
  for (const s of shapes)
    for (const loop of s.loops) {
      const n = loop.length;
      if (n < 3) continue;
      for (let i = 0; i < n; i++) {
        const a = loop[(i - 1 + n) % n],
          b = loop[i],
          c = loop[(i + 1) % n];
        const ux = b.x - a.x,
          uy = b.y - a.y,
          vx = c.x - b.x,
          vy = c.y - b.y;
        const lu = Math.hypot(ux, uy),
          lv = Math.hypot(vx, vy);
        if (lu < 1e-9 || lv < 1e-9) continue;
        const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
        if (Math.acos(cos) >= SHARP_TURN_RAD) sharp++;
      }
    }
  return sharp;
}

/**
 * One trace with the parameters supplied rather than derived.
 *
 * Bypasses parseRasterImage because every sweep below exists to vary a number autoParams would
 * otherwise pick. It is the same two calls parseRasterImage makes, in the same order, so the
 * shapes are what would ship at those settings.
 */
function traceWith(img: RasterImage, colors: number, params: TraceParams) {
  const t0 = performance.now();
  const map = quantize(img, colors, params.blurRadius);
  const { components, capped } = traceLabelMap(map, params);
  const ms = performance.now() - t0;
  const painted = new Set(components.map((c) => map.palette[c.label]));
  const shapes: SVGShape[] = components.map((c, i) => ({
    fill: map.palette[c.label],
    loops: c.loops,
    order: i,
  }));
  const { rings, points } = ringStats(shapes);
  return {
    components: components.length,
    painted: painted.size,
    rings,
    points,
    sharp: sharpTurns(shapes),
    capped,
    ms: +ms.toFixed(1),
    shapes,
  };
}

/**
 * Whether the detail pass enlarged this image, read the way parse.ts reads it.
 *
 * Long edge, not width: a portrait source can be under MEASURE_EDGE across and still have been
 * worked above it, and getting this backwards silently moves the compensating blur on exactly the
 * sources the blur exists for.
 */
const ranDetailPass = (img: RasterImage) => Math.max(img.w, img.h) > MEASURE_EDGE;

/**
 * Load only what was asked for, then drop the dependencies that came along.
 *
 * `loadCorpus` pulls in anything a selected entry derives from, which the sweeps should not then
 * report on. Names are validated inside `loadCorpus`, before any file is opened.
 */
async function pick(names: string[]): Promise<DecodedSource[]> {
  const loaded = await loadCorpus(names);
  return names.length ? loaded.filter((s) => names.includes(s.name)) : loaded;
}

/** Where an image lands on the flat/photo axis, and whether that matches what it is. */
async function modeCorpus(names: string[]) {
  const sources = await pick(names);
  // Only an unfiltered run can be short: a filter is a deliberate subset, and `loadCorpus` already
  // throws when a named source is absent. Without this guard the line fired on every filtered run
  // and named sources sitting on disk.
  const absent = names.length ? [] : CORPUS.filter((c) => !sources.some((s) => s.name === c.name));
  const rows = sources.map((s) => {
    const p = autoParams({ edgeDensity: s.edgeDensity }, DETAIL_DEFAULT, ranDetailPass(s.working));
    return {
      name: s.name,
      from: s.provenance,
      expect: s.group,
      source: `${s.srcW}x${s.srcH}`,
      working: `${s.working.w}x${s.working.h}`,
      downscale: +s.downscale.toFixed(2),
      edgeDensity: +s.edgeDensity.toFixed(4),
      reads: s.photographic ? 'photo' : 'flat',
      blur: p.blurRadius,
      despeckle: +p.despeckleFrac.toFixed(5),
      alphaMax: +p.alphaMax.toFixed(3),
      flatness: +p.flatness.toFixed(3),
      // What the file is, against what the statistic reads. Named `mismatch` rather than
      // `MISREAD`: a photograph of a clear sky reading flat is a mismatch and the right treatment
      // at once, so a column that called it a defect would be permanently wrong about one row.
      // 'middle' entries are allowed either answer and are never marked.
      mismatch: s.mismatchesGroup ? 'yes' : '',
    };
  });
  rows.sort((a, b) => a.edgeDensity - b.edgeDensity);
  console.table(rows);

  // Banded by provenance as well as group: pooling curated stock photography with the real files
  // would let its skew toward defocused, denoised frames read as a property of photographs.
  const band = (g: CorpusGroup, from?: Provenance) => {
    const d = sources
      .filter((s) => s.group === g && (from === undefined || s.provenance === from))
      .map((s) => s.edgeDensity);
    return d.length ? { lo: Math.min(...d), hi: Math.max(...d), n: d.length } : null;
  };
  const flat = band('flat');
  const photo = band('photo', 'real');
  const stock = band('photo', 'stock');
  const allPhoto = band('photo');
  // Read out of the code under test. A literal here would keep asserting the old cutoff after the
  // retune this bench exists to argue for, while the table's `reads` column used the new one.
  const cutoff = (() => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (isPhotographic(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  })();
  const say = (label: string, b: ReturnType<typeof band>) =>
    b
      ? `${label} ${b.lo.toFixed(4)} .. ${b.hi.toFixed(4)} (n=${b.n})`
      : `${label} not in this selection`;
  console.log(
    '\n' +
      say('flat cluster ', flat) +
      '\n' +
      say('photo (real) ', photo) +
      '\n' +
      say('photo (stock)', stock) +
      (absent.length
        ? `\n  INCOMPLETE: ${absent.length} source(s) not present: ${absent.map((a) => a.name).join(', ')}`
        : '') +
      '\n' +
      (flat && allPhoto
        ? `gap (all)     ${(allPhoto.lo - flat.hi).toFixed(4)}` +
          (allPhoto.lo <= flat.hi
            ? ' (negative: at least one photograph is inside the flat band)'
            : '')
        : 'gap (all)     needs both clusters') +
      (flat && stock
        ? `\ngap (stock)   ${(stock.lo - flat.hi).toFixed(4)}` +
          (stock.lo <= flat.hi
            ? ' (negative: the stock band overlaps the flat band too)'
            : ` (cutoff ${cutoff.toFixed(4)} is ${cutoff > flat.hi && cutoff < stock.lo ? 'inside' : 'OUTSIDE'} it)`)
        : ''),
  );
  // Named so a second one reads as new. `photo` is a balloon against a clear sky: a mismatch and
  // the correct treatment at once, and the only one this corpus is expected to produce.
  const flagged = sources.filter((s) => s.mismatchesGroup).map((f) => f.name);
  if (flagged.length)
    console.log(
      `mismatch     ${flagged.join(', ')}` +
        (flagged.length === 1 && flagged[0] === 'photo'
          ? '  (expected: its content is a clear sky and genuinely flat)'
          : '  <- unexpected, check this'),
    );
  for (const m of sources.filter((s) => s.group === 'middle'))
    console.log(
      `middle: ${m.name} ${m.edgeDensity.toFixed(4)} reads ${m.photographic ? 'photo' : 'flat'}`,
    );
}

/** Region count against palette size: the curve a knee detector would have to read. */
async function modeColors(names: string[]) {
  const sources = await pick(names);
  // Every step is +1 so `growth` is comparable across the whole ladder. The earlier uneven ladder
  // (…6, 8, 10, 12) scored two-step ratios against one-step ones, which inflated exactly the late
  // steps a knee detector is trying to rule out.
  const ks = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const rows = [];
  for (const s of sources) {
    const params = autoParams(
      { edgeDensity: s.edgeDensity },
      DETAIL_DEFAULT,
      ranDetailPass(s.working),
    );
    let prev = 0;
    for (const k of ks) {
      const r = traceWith(s.working, k, params);
      rows.push({
        name: s.name,
        colors: k,
        sensible: k === s.colors ? '<-' : '',
        painted: r.painted,
        components: r.components,
        // The knee signal. A step that multiplies components far above its neighbours is the
        // palette spending its surplus on fringe rather than on a colour that was really there.
        growth: prev ? +(r.components / prev).toFixed(2) : null,
        points: r.points,
        capped: r.capped,
        ms: r.ms,
      });
      prev = r.components;
    }
  }
  console.table(rows);
}

/**
 * alphaMax x flatness, on the sources whose right answer is known by looking at them.
 *
 * The two failure directions are asymmetric and only one is visible in a preview, so both need a
 * number: a rounded square logo shows as `sharp` collapsing, a faceted arc as `sharp` climbing on
 * a source that has no corners.
 */
async function modeCurve(names: string[]) {
  // Chosen for what each one knows the answer to: the screenshot is nothing but square corners,
  // the logo is letterforms against a curved sock, the pattern is curves with no corner anywhere,
  // and the scan and the photograph are where a fitted curve has the most to lose.
  const defaults = ['ui-screenshot', 'red-sox-logo', 'pattern-cow', 'kid-drawing', 'photo'];
  // A mode's own default list is not a user filter. Passing it as one made `loadCorpus` throw on
  // any absent source, so `curve` hard-failed on a clean checkout while `corpus` and `colors`
  // degraded with a notice. Load everything, then narrow to whatever actually arrived.
  const sources = names.length
    ? await pick(names)
    : (await pick([])).filter((s) => defaults.includes(s.name));
  if (!sources.length)
    throw new Error(`none of the default sources are present: ${defaults.join(', ')}`);
  // The top rung is exactly 4/3, not 1.334. ALPHA_MAX_LIMIT is 4/3, and a rung above it measures a
  // value autoParams can never produce; the two differ in behaviour, because a vertex with
  // ddenom === 0 has alpha initialised to 4/3 and so still passes `alpha >= alphaMax` at exactly
  // the limit. `alpha` mode probes the same value, and the two modes must agree.
  const alphas = [0.8, 0.9, 1.0, 1.1, 1.2, 4 / 3];
  const flats = [0.1, 0.25, 0.4, 0.6];
  const rows = [];
  for (const s of sources) {
    const base = autoParams(
      { edgeDensity: s.edgeDensity },
      DETAIL_DEFAULT,
      ranDetailPass(s.working),
    );
    for (const alphaMax of alphas)
      for (const flatness of flats) {
        const r = traceWith(s.working, s.colors, { ...base, alphaMax, flatness });
        rows.push({
          name: s.name,
          colors: s.colors,
          alphaMax,
          flatness,
          points: r.points,
          sharp: r.sharp,
          sharpPer1k: +((r.sharp / Math.max(1, r.points)) * 1000).toFixed(1),
          components: r.components,
          capped: r.capped,
          ms: r.ms,
        });
      }
  }
  console.table(rows);
  console.log(
    '\nshipping endpoints: flat art alphaMax 1.0 / flatness 0.25, photo 1.2 / 0.4.' +
      '\nALPHA_MAX_LIMIT is 4/3, where every vertex is forced into a cubic and a square logo comes' +
      '\nback rounded. See `alpha` mode for that on a shape with a known right answer.',
  );
}

/**
 * What the same picture does at several working sizes.
 *
 * The open question this answers is whether DETAIL_PASS_BLUR should be a constant. It compensates
 * for low-pass filtering the downscale used to do, so a source that was never shrunk gets a blur
 * paying back a loss it never took. Each rung is traced twice, with and without it, so the two can
 * be compared at a known ratio rather than at the single one that prompted the constant.
 */
async function modeScale(args: string[]) {
  const file = args[0] || 'stubs/mario.png';
  // Blanket-8 is the trap the curve sweep already fell into once: a palette size well past what a
  // source has puts the trace into fringe specks, and the ladder then compares speck counts. When
  // the file is a corpus entry, use the size that entry records as right for it.
  // Normalised, not compared raw: `./public/...` and `public/...` are the same file, and matching
  // by string made the second one miss its entry, losing both the pinned renderEdge and the palette
  // size and landing in the blanket-8 trap the comment below warns about.
  const sameFile = (a?: string, b?: string) =>
    a !== undefined && b !== undefined && path.normalize(a) === path.normalize(b);
  const entry = CORPUS.find((c) => sameFile(c.file, file));
  // Rejected rather than defaulted: `Number('six') || entry?.colors` would silently fall back, and
  // what it falls back toward on an unknown file is the blanket-8 palette the comment above calls a
  // trap. A typo here would quietly produce a table measuring fringe specks.
  if (args[1] !== undefined) {
    const asked = Number(args[1]);
    if (!Number.isInteger(asked) || asked < MIN_COLORS || asked > MAX_COLORS)
      throw new Error(
        `colors must be a whole number between ${MIN_COLORS} and ${MAX_COLORS}, got ${args[1]}. ` +
          `quantize clamps outside that range, and the footer would then name a size it never used.`,
      );
  }
  const colors = args[1] !== undefined ? Number(args[1]) : (entry?.colors ?? 8);
  // MEASURE_EDGE and MAX_WORKING_EDGE are forced in rather than assumed present: they are the only
  // two sizes decodeImageFile can produce, so a ladder that lost one to a retune would crash on the
  // reference draw or silently empty the `ships` column, which is the table's whole point.
  const edges = [...new Set([256, 384, 512, 768, 1024, 1588, MEASURE_EDGE, MAX_WORKING_EDGE])].sort(
    (a, b) => a - b,
  );
  const { srcW, srcH, images } = await decodeAtEdges(file, edges, entry?.renderEdge);
  const reference = images.get(MEASURE_EDGE)!;
  const { edgeDensity } = measureImage(reference);
  // decodeImageFile only ever produces one working size for a given file: MEASURE_EDGE for a
  // photograph, MAX_WORKING_EDGE for anything else, and neither upscales. Every other rung is a
  // hypothetical, and marking them all as shipping is what forced the first report to hand-annotate
  // its own table.
  // Matched on the size a rung actually produces, not on the edge asked for. `workingSize` caps
  // and never upscales, so a 500x898 source ships at 898 however large the request was, and every
  // rung at or above it produces the same pixels. First match wins; the rest are duplicates.
  const cap = isPhotographic(edgeDensity) ? MEASURE_EDGE : MAX_WORKING_EDGE;
  const shipsLongEdge = Math.max(...Object.values(workingSize(srcW, srcH, cap)));
  let shipsMarked = false;
  const rows = [];
  for (const edge of edges) {
    const img = images.get(edge)!;
    const downscale = +(Math.max(srcW, srcH) / Math.max(img.w, img.h)).toFixed(2);
    for (const compensated of [false, true]) {
      const params = autoParams({ edgeDensity }, DETAIL_DEFAULT, compensated);
      const r = traceWith({ ...img, edgeDensity }, colors, params);
      const shipping =
        !shipsMarked &&
        Math.max(img.w, img.h) === shipsLongEdge &&
        ranDetailPass(img) === compensated;
      if (shipping) shipsMarked = true;
      rows.push({
        // Annotated like `sizes` does: a source smaller than the rung is measured at its own size,
        // so several rungs can be byte-identical and the table must not look like several results.
        workingEdge:
          Math.max(img.w, img.h) === edge ? edge : `${edge} (@${Math.max(img.w, img.h)})`,
        size: `${img.w}x${img.h}`,
        downscale,
        // What the app would actually do at this rung, so the two rows can be told apart from the
        // one the shipping path picks.
        ships: shipping ? 'yes' : '',
        detailPassBlur: compensated ? 'on' : 'off',
        blur: params.blurRadius,
        painted: r.painted,
        components: r.components,
        points: r.points,
        // Surfaced because capping collapses counts instead of trimming them: a capped row is not
        // comparable to an uncapped one, and headline results are read off this table.
        capped: r.capped,
        ms: r.ms,
      });
    }
  }
  console.table(rows);
  console.log(
    `\n${file} is ${srcW}x${srcH}, edgeDensity ${edgeDensity.toFixed(4)} measured at ` +
      `${Math.max(reference.w, reference.h)}` +
      (Math.max(reference.w, reference.h) === MEASURE_EDGE
        ? ''
        : ` (MEASURE_EDGE is ${MEASURE_EDGE}, but nothing is upscaled)`) +
      `, traced at ${colors} colors.` +
      '\nDETAIL_PASS_BLUR is 1, added on top of the interpolated blur whenever the working long' +
      '\nedge exceeds MEASURE_EDGE. The `ships` column marks the row the app would actually take.' +
      '\nAny source between 513 and 1024px takes it at downscale 1.00, paying back a low-pass' +
      '\nfiltering that never happened. That is the case the constant was never tuned for.',
  );
}

/**
 * The same vector artwork rasterized at several sizes, measured at each.
 *
 * Isolates the half of edge density that has nothing to do with what the picture is of. A pattern
 * exported small is measured at its own size, where its stripes take up a large share of the
 * pixels, and reads photographic; exported large it is measured after a downscale to MEASURE_EDGE
 * and reads flat. Nothing about the artwork changed.
 */
async function modeRender(args: string[]) {
  const file = args[0] || 'public/patterns/zebra.svg';
  // SVG only, and refused rather than quietly wrong: `renderEdge` re-rasterizes a vector at each
  // size, which is the whole premise. A raster source has one resolution, so every rung above it
  // would return the same pixels, reproducing the defect this mode was fixed for.
  if (!file.toLowerCase().endsWith('.svg'))
    throw new Error(
      `render mode needs a vector source, got ${file}. A raster file cannot be re-exported at a ` +
        `larger size, so every rung above its own resolution would measure the same pixels.`,
    );
  const edges = [128, 192, 256, 384, 512, 768, 1024, 1536, 2048];
  const rendered = await renderAtEdges(file, edges);
  const rows = [];
  for (const edge of edges) {
    const { image } = rendered.get(edge)!;
    const { edgeDensity } = measureImage(image);
    rows.push({
      renderEdge: edge,
      measuredAt: `${image.w}x${image.h}`,
      edgeDensity: +edgeDensity.toFixed(4),
      reads: isPhotographic(edgeDensity) ? 'photo' : 'flat',
    });
  }
  console.table(rows);
  console.log(
    `\n${file} is the same artwork at every one of these sizes.` +
      '\n`reads` asks isPhotographic() rather than a copy of the cutoff, so this mode keeps' +
      '\nchallenging the threshold after the threshold moves.' +
      '\nAnything that crosses here crossed on export resolution alone.',
  );
}

/**
 * What `alphaMax` does to a shape whose right answer is not in doubt.
 *
 * The corpus sweep cannot settle this. `sharp` counts turns in the *output* polyline, so on a
 * jagged anti-aliased boundary a fully smoothed fit still zigzags and the count goes up, which
 * reads as faceting when it is the opposite. A clean lattice square has one correct answer at every
 * setting, so it separates "corners kept" from "output is noisy". Getting this backwards put an
 * inverted conclusion into three drafts of the findings report.
 */
async function modeAlpha() {
  const S = 40;
  const square: Pt[] = [];
  for (let x = 0; x < S; x++) square.push({ x, y: 0 });
  for (let y = 0; y < S; y++) square.push({ x: S, y });
  for (let x = S; x > 0; x--) square.push({ x, y: S });
  for (let y = S; y > 0; y--) square.push({ x: 0, y });

  const area = (loop: Pt[]) => {
    let a = 0;
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i];
      const q = loop[(i + 1) % loop.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  };

  const truth = S * S;
  const rows = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 4 / 3].map((alphaMax) => {
    const out = fitChain(square, true, { alphaMax, flatness: 0.1 });
    return {
      alphaMax: +alphaMax.toFixed(4),
      points: out.length,
      sharp: sharpTurns([{ fill: '#000', loops: [out], order: 0 }]),
      area: +area(out).toFixed(1),
      areaLostPct: +(((truth - area(out)) / truth) * 100).toFixed(2),
    };
  });
  console.table(rows);
  console.log(
    `\nA ${S}x${S} lattice square, true area ${truth}, flatness 0.1.` +
      '\ncurve.ts computes alpha = (1 - 1/dd)/0.75, supremum exactly 4/3, and keeps a corner only' +
      '\nwhen alpha >= alphaMax. At 4/3 no fitted vertex reaches it, so every one becomes a cubic' +
      '\nand the square comes back rounded. The one exception is a degenerate vertex, where' +
      '\nddenom is 0 and alpha is initialised to 4/3, which still passes at exactly the limit.' +
      '\nThat is what ALPHA_MAX_LIMIT and ALPHA_CEILING both say.',
  );
}

/**
 * Edge density of the same file measured at several sizes.
 *
 * The size control. Stock photographs are far larger than the corpus's real files, so the flat
 * versus photo separation had to be checked against the alternative explanation that it is an
 * artefact of downscale ratio rather than content. It is not, and the confound runs the reassuring
 * way: heavier downscale *lowers* density, and the largest files still score the highest.
 *
 * It also shows the separation is only stable because the app pins the measurement at MEASURE_EDGE.
 * Measured elsewhere the ordering breaks: flat art reads photographic at 256.
 */
async function modeSizes(args: string[]) {
  // Both decode constants forced in, for the same reason `scale` does it: the footer says
  // MEASURE_EDGE is the deciding column, and a retune must not remove that column from the table.
  const edges = [...new Set([256, 512, 1024, 1600, MEASURE_EDGE, MAX_WORKING_EDGE])].sort(
    (a, b) => a - b,
  );
  // Regenerated before the existence check below, so an edit to GRADIENT_SVG cannot leave this
  // mode measuring the previous render while `corpus` measures the current one. A no-op unless
  // an authored source is named, since none is in the default list.
  writeAuthoredSources();
  const wanted = args.length
    ? args
    : ['stock-gravel', 'stock-crowd', 'stock-bokeh-food', 'photo', 'mario'];
  // Straight from CORPUS: this mode needs a path and two labels, all of which are static, so
  // decoding the whole corpus first would launch a browser to learn nothing.
  const entries = wanted.map((name) => {
    const entry = CORPUS.find((c) => c.name === name);
    if (!entry)
      throw new Error(
        `no corpus source named ${name}. Known: ${CORPUS.map((c) => c.name).join(', ')}`,
      );
    if (!entry.file)
      throw new Error(
        `${name} is derived from another source and has no file of its own, so it cannot be ` +
          `re-drawn at another size. Pick a source with a file.`,
      );
    // This mode bypasses the corpus loader, so it has to say how to get each kind of source back.
    // stubs/ is gitignored, and three of the five defaults are fetched rather than committed.
    if (!existsSync(path.join(REPO, entry.file))) {
      // Keyed on where the file lives, not on provenance: `real` covers both repo-tracked sources
      // under public/ and gitignored ones under stubs/, and telling someone that a committed
      // pattern is unreproducible would send them looking for the wrong problem.
      const how =
        entry.provenance === 'stock'
          ? 'run `node scripts/fetch-raster-stock.mjs` to fetch it'
          : entry.file.startsWith('stubs/')
            ? 'it lives in gitignored stubs/ and is not reproducible from a clean checkout'
            : 'it should be committed under this path, so the checkout is incomplete';
      throw new Error(`${name} is missing at ${entry.file}: ${how}.`);
    }
    return entry;
  });

  const decoded = await decodeManyAtEdges(
    entries.map((e) => ({ file: e.file!, renderEdge: e.renderEdge })),
    edges,
  );
  const rows: Record<string, string | number>[] = [];
  for (const [i, entry] of entries.entries()) {
    const { srcW, srcH, images } = decoded[i];
    const row: Record<string, string | number> = {
      name: entry.name,
      from: entry.provenance,
      is: entry.group,
      source: `${srcW}x${srcH}`,
    };
    for (const e of edges) {
      const img = images.get(e)!;
      const d = measureImage(img).edgeDensity;
      // The size measured, not the size asked for. `drawInPage` scales by min(1, edge / longEdge),
      // so a small source silently repeats itself across the wider columns and the table would
      // invite reading down a column that holds two different measurements.
      const at = Math.max(img.w, img.h);
      row[`@${e}`] =
        `${d.toFixed(3)} ${isPhotographic(d) ? 'photo' : 'flat'}${at === e ? '' : ` (@${at})`}`;
    }
    rows.push(row);
  }
  console.table(rows);
  // Derived from this run, not asserted from the default list. The footer used to state that the
  // orderings at 256 and 512 disagree and to cite the bokeh exception, both of which came from the
  // five default sources and stayed on screen whatever was actually measured.
  const readAt = (r: Record<string, string | number>, e: number) =>
    String(r[`@${e}`]).includes('photo');
  const order = (e: number) => rows.map((r) => `${r.name}:${readAt(r, e) ? 'P' : 'f'}`).join(' ');
  const disagree = order(256) !== order(MEASURE_EDGE);
  console.log(
    `\nThe app always measures at ${MEASURE_EDGE}, which is the only column that decides anything.` +
      '\nA column heading is the size asked for; the size actually measured is in the cell, since' +
      '\nnothing is ever upscaled.' +
      `\n\nRegime at 256:   ${order(256)}` +
      `\nRegime at ${MEASURE_EDGE}:   ${order(MEASURE_EDGE)}` +
      (disagree
        ? '\nThese disagree, which is the point: a reading is meaningless without its size.'
        : '\nThese agree on this selection, which does not mean they always do.'),
  );
}

/**
 * The compensating blur, on and off, at a fixed working size.
 *
 * **It cannot tell you whether the benefit tracks the downscale**, despite the ladder: re-rendering
 * a vector holds the anti-aliased fringe fixed, and that fringe is the mechanism DETAIL_PASS_BLUR
 * replaces. Doing that properly needs a raster resampled per rung, which this mode is not built for
 * and neither is `decodeAtEdges`. See docs/findings/2026-08-20-blur-vs-downscale.md.
 *
 * What it does show is that the compensation's effect is a property of the artwork.
 *
 * `edgeDensity` and `baseBlur` are printed because the interpolated blur rounds 0 to 1 at density
 * 0.2025, so a source near there flips between rungs and its rows are not comparable.
 */
async function modeBlur(args: string[]) {
  const sizes = [1024, 1536, 2048, 3072, 4096];
  // All five vector sources, not a subset: the sample size is the standing caveat on this
  // measurement, and gradient-illustration is the only one that is not two flat colours.
  const wanted = args.length
    ? args
    : CORPUS.filter((c) => c.file?.toLowerCase().endsWith('.svg')).map((c) => c.name);
  writeAuthoredSources();
  const entries = wanted.map((name) => {
    const entry = CORPUS.find((c) => c.name === name);
    if (!entry)
      throw new Error(
        `no corpus source named ${name}. Known: ${CORPUS.map((c) => c.name).join(', ')}`,
      );
    if (!entry.file || !entry.file.toLowerCase().endsWith('.svg'))
      throw new Error(
        `${name} is not a vector source. This mode re-renders artwork at several sizes to vary the ` +
          `downscale with the content held fixed, which only a vector source allows.`,
      );
    if (!existsSync(path.join(REPO, entry.file)))
      throw new Error(`${name} is missing at ${entry.file}.`);
    return entry;
  });

  const rows: {
    name: string;
    source: number;
    downscale: number;
    edgeDensity: number;
    reads: string;
    baseBlur: number;
    withComp: number;
    componentsOff: number;
    componentsOn: number;
    capped: boolean;
    change: string;
    verdict: string;
  }[] = [];
  for (const size of sizes) {
    const workingEdge = Math.min(MAX_WORKING_EDGE, size);
    // Batched by size: one browser for every source at this rung rather than one per pair.
    const decoded = await decodeManyAtEdges(
      entries.map((e) => ({ file: e.file!, renderEdge: size })),
      [MEASURE_EDGE, workingEdge],
    );
    entries.forEach((entry, i) => {
      const { srcW, srcH, images } = decoded[i];
      const { edgeDensity } = measureImage(images.get(MEASURE_EDGE)!);
      const working = images.get(workingEdge)!;
      const downscale = +(Math.max(srcW, srcH) / Math.max(working.w, working.h)).toFixed(2);
      const run = (compensated: boolean) => {
        const p = autoParams({ edgeDensity }, DETAIL_DEFAULT, compensated);
        const r = traceWith({ ...working, edgeDensity }, entry.colors, p);
        return { n: r.components, capped: r.capped, blur: p.blurRadius };
      };
      const off = run(false);
      const on = run(true);
      rows.push({
        name: entry.name,
        source: size,
        downscale,
        // Printed because the interpolated blur rounds 0 to 1 at density 0.2025, and a source
        // near there flips between rungs, which makes its rows incomparable.
        edgeDensity: +edgeDensity.toFixed(4),
        // The photo branch never takes the compensation, so such a rung is not a comparison at
        // all. Marked rather than dropped, so the table is never shorter than the ladder. It does
        // not fire on any source eligible today, and its `downscale` would be wrong if it did,
        // since a photographic source is worked at 512 rather than 1024.
        reads: isPhotographic(edgeDensity) ? 'PHOTO (not compensated)' : 'flat',
        baseBlur: off.blur,
        withComp: on.blur,
        componentsOff: off.n,
        componentsOn: on.n,
        // Capping collapses counts instead of trimming them, so a capped pair is not comparable
        // and could print a meaningless "no change".
        capped: off.capped || on.capped,
        change: `${on.n > off.n ? '+' : ''}${(((on.n - off.n) / Math.max(1, off.n)) * 100).toFixed(0)}%`,
        verdict: on.n < off.n ? 'helps' : on.n > off.n ? 'hurts' : 'no change',
      });
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.source - b.source);
  console.table(rows);
  // Derived from the run, not asserted: a flat control arm is what disqualifies a vector ladder
  // from answering the ratio question, and the reader has to be able to see it in their own output.
  // Capped rows excluded: capping collapses the count rather than trimming it, so a source clipped
  // at MAX_COMPONENTS could show a frozen arm that has nothing to do with the ladder.
  const byName = new Map<string, number[]>();
  for (const r of rows)
    if (!r.capped) byName.set(r.name, [...(byName.get(r.name) ?? []), r.componentsOff]);
  const capped = [...new Set(rows.filter((r) => r.capped).map((r) => r.name))];
  // A partial ladder cannot support "never moves": with rungs missing to capping, a frozen arm may
  // just be two rungs that happen to agree.
  const complete = [...byName.entries()].filter(([, v]) => v.length === sizes.length);
  const flat = complete.filter(([, v]) => new Set(v).size === 1).map(([n]) => n);
  const partial = [...byName.entries()]
    .filter(([, v]) => v.length !== sizes.length)
    .map(([n]) => n);
  console.log(
    '\nControl arm (componentsOff) per source: ' +
      [...byName.entries()].map(([n, v]) => `${n} ${v.join('/')}`).join('   '),
  );
  if (capped.length) console.log(`\ncapped, excluded from the check below: ${capped.join(', ')}`);
  if (partial.length) console.log(`\nincomplete ladder, not judged: ${partial.join(', ')}`);
  console.log(
    !complete.length
      ? '\nNo source has a complete ladder, so nothing was checked.'
      : flat.length
        ? `\n${flat.join(', ')} never move across the ladder, so for them the ratio changed in name` +
          '\nonly and this run cannot say whether it predicts the compensation. See' +
          '\ndocs/findings/2026-08-20-blur-vs-downscale.md.'
        : '\nNo control arm is frozen. Necessary for reading a verdict against the ratio, and not' +
          '\nsufficient: check the movement tracks the ladder rather than a baseBlur flip, which is' +
          '\nwhat disqualified the vector run in the findings report.',
  );
}

/**
 * Would a knee detector reach the same answer from a cheaper, smaller copy of the image?
 *
 * A detector runs on every image load, and the full ladder costs seconds, so it would have to work
 * on a smaller draw. Each rung is a real browser decode at that size, and its trace parameters are
 * derived the way parse.ts derives them for that size, so a column is what the app would actually
 * have produced had it worked the image there.
 */
async function modeKnee(args: string[]) {
  const KS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  // Both decode constants forced in, as `scale` and `sizes` do: they are the only sizes
  // decodeImageFile can produce, and losing one silently empties the SHIPS column.
  const AT = [...new Set([192, 256, 384, MEASURE_EDGE, MAX_WORKING_EDGE])].sort((a, b) => a - b);
  // Curated rather than the whole corpus: a no-arg run would otherwise decode every source,
  // including derived ones that have no file of their own, after minutes of browser work.
  const sources = await pick(
    args.length
      ? args
      : ['pattern-cow', 'red-sox-logo', 'cartoon', 'mario', 'ui-screenshot', 'kid-drawing'],
  );
  for (const s of sources) {
    const e = CORPUS.find((c) => c.name === s.name)!;
    if (!e.file)
      throw new Error(
        `${s.name} is derived from another source and has no file of its own, so it cannot be ` +
          `re-decoded at another size.`,
      );
  }

  // Real decodes, not a resample here: the app area-averages through drawImage at high quality, and
  // the whole question is what downsampling does to the anti-aliased fringe. Point-sampling in this
  // file would answer a question about a different operation.
  const decoded = await decodeManyAtEdges(
    sources.map((s) => {
      const e = CORPUS.find((c) => c.name === s.name)!;
      return { file: e.file!, renderEdge: e.renderEdge };
    }),
    AT,
  );

  // Largest single-step jump over uncapped steps, taking the k before it. Capping collapses the
  // count rather than trimming it, which reads as the strongest possible knee pointing the wrong way.
  const kneeOf = (pts: { k: number; n: number; capped: boolean }[]) => {
    let best = 0;
    let at = -1;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].capped || pts[i - 1].capped) continue;
      const g = pts[i].n / Math.max(1, pts[i - 1].n);
      if (g > best) {
        best = g;
        at = i;
      }
    }
    return { k: best >= 3 && at > 0 ? pts[at - 1].k : null, growth: +best.toFixed(1) };
  };

  const rows = [];
  for (const [i, s] of sources.entries()) {
    const { images, srcW, srcH } = decoded[i];
    const row: Record<string, string | number> = { name: s.name, right: s.colors };
    for (const edge of AT) {
      const img = images.get(edge)!;
      const at = Math.max(img.w, img.h);
      if (at < edge) {
        // workingSize never upscales, so a source smaller than the rung was not resampled at all
        // and its cell would silently repeat a neighbour's.
        row[`@${edge}`] = `n/a (source is ${srcW}x${srcH})`;
        continue;
      }
      // Exactly parse.ts: edgeDensity is carried from the fixed reference draw, and the detail-pass
      // blur is decided by this image's own long edge. Deriving it once from the full working image
      // would hold that blur on for every smaller column and invent knees that do not ship.
      const params = autoParams({ edgeDensity: s.edgeDensity }, DETAIL_DEFAULT, at > MEASURE_EDGE);
      const t0 = performance.now();
      const pts = KS.map((k) => {
        const r = traceWith({ ...img, edgeDensity: s.edgeDensity }, k, params);
        return { k, n: r.components, capped: r.capped };
      });
      const ms = performance.now() - t0;
      const { k, growth } = kneeOf(pts);
      // Capping collapses the count instead of trimming it, so a capped rung is not part of the
      // curve. `cartoon` caps at 5 of 11 rungs, which a bare cell would hide.
      const cappedAt = pts.filter((x) => x.capped).length;
      // The size the app would really work this source at. Every other column is diagnostic, and
      // some apply a detail-pass blur the shipping path never would.
      // A photographic source is capped at MEASURE_EDGE, not MAX_WORKING_EDGE. Ignoring that put
      // SHIPS on a column that also carries a detail-pass blur a photograph never receives.
      const cap = isPhotographic(s.edgeDensity) ? MEASURE_EDGE : MAX_WORKING_EDGE;
      const fit = workingSize(srcW, srcH, cap);
      const ships = at === Math.max(fit.w, fit.h);
      row[`@${edge}`] =
        `${k ?? 'none'} (${growth}x, ${ms.toFixed(0)}ms, blur ${params.blurRadius}` +
        `${cappedAt ? `, ${cappedAt}/${KS.length} capped` : ''})${ships ? ' SHIPS' : ''}`;
    }
    rows.push(row);
  }
  console.table(rows);
  console.log(
    '\nEach cell: the palette size a knee rule picks at that working size, the growth it fired on,' +
      '\nwhat the ladder cost, the blur that size would really get, and how many rungs capped.' +
      '\nSHIPS marks the size the app would actually work that source at; every other column is' +
      '\ndiagnostic. `right` is what the corpus entry records.',
  );
}

async function modeSynthetic(sizes: number[]) {
  const rows = [];
  for (const size of sizes.length ? sizes : [384, 512, 768]) {
    for (const [name, make] of [
      ['flat-art', flatArtLike],
      ['photo', photoLike],
    ] as const) {
      const img = make(size, size);
      for (const g of ['color', 'component'] as const) rows.push(await run(name, img, g));
    }
  }
  console.table(rows);
  console.log(
    '\nYIELD_BUDGET_MS is 30. `stfMs` is synchronous main-thread time before the first yield;\n' +
      'anything near or above 30 there is a visible stall with a frozen progress curtain.',
  );
}

const [mode, ...rest] = process.argv.slice(2);
switch (mode) {
  case 'corpus':
    await modeCorpus(rest);
    break;
  case 'colors':
    await modeColors(rest);
    break;
  case 'curve':
    await modeCurve(rest);
    break;
  case 'scale':
    await modeScale(rest);
    break;
  case 'render':
    await modeRender(rest);
    break;
  case 'alpha':
    await modeAlpha();
    break;
  case 'sizes':
    await modeSizes(rest);
    break;
  case 'blur':
    await modeBlur(rest);
    break;
  case 'knee':
    await modeKnee(rest);
    break;
  default: {
    // Numeric arguments keep the original invocation working, which the header and two tech-debt
    // sections quote. A non-numeric word is a typo, not a request for the synthetic bench.
    const args = [mode, ...rest].filter((a) => a !== undefined);
    const bad = args.filter((a) => !Number.isFinite(Number(a)));
    if (bad.length)
      throw new Error(
        `unknown mode ${bad.join(', ')}. Modes: corpus, colors, curve, scale, render, alpha, ` +
          `sizes, blur, knee, ` +
          `or one or more pixel sizes for the synthetic bench.`,
      );
    await modeSynthetic(args.map(Number).filter(Boolean));
  }
}
