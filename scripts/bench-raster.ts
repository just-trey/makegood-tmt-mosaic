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
import { CORPUS, loadCorpus, decodeAtEdges, renderAtEdges } from './lib/rastercorpus';
import type { CorpusGroup, DecodedSource } from './lib/rastercorpus';
import type { RasterImage, TraceParams } from '../src/raster/types';
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
  const rows = sources.map((s) => {
    const p = autoParams({ edgeDensity: s.edgeDensity }, DETAIL_DEFAULT, ranDetailPass(s.working));
    return {
      name: s.name,
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
      // A file whose group says flat or photo and whose measurement says the other is the defect
      // this table exists to find. 'middle' entries are allowed either answer.
      MISREAD: s.group !== 'middle' && s.photographic !== (s.group === 'photo') ? 'YES' : '',
    };
  });
  rows.sort((a, b) => a.edgeDensity - b.edgeDensity);
  console.table(rows);

  const band = (g: CorpusGroup) => {
    const d = sources.filter((s) => s.group === g).map((s) => s.edgeDensity);
    return d.length ? { lo: Math.min(...d), hi: Math.max(...d), n: d.length } : null;
  };
  const flat = band('flat');
  const photo = band('photo');
  const say = (label: string, b: ReturnType<typeof band>) =>
    b
      ? `${label} ${b.lo.toFixed(4)} .. ${b.hi.toFixed(4)} (n=${b.n})`
      : `${label} not in this selection`;
  console.log(
    '\n' +
      say('flat cluster ', flat) +
      '\n' +
      say('photo cluster', photo) +
      '\n' +
      (flat && photo
        ? `gap           ${(photo.lo - flat.hi).toFixed(4)}` +
          (photo.lo <= flat.hi ? ' (negative: the clusters overlap)' : '')
        : 'gap           needs both clusters'),
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
  const wanted = names.length
    ? names
    : ['ui-screenshot', 'red-sox-logo', 'pattern-cow', 'kid-drawing', 'photo'];
  const sources = await pick(wanted);
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
  const entry = CORPUS.find((c) => c.file === file);
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
  const { srcW, srcH, images } = await decodeAtEdges(file, edges);
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
        workingEdge: edge,
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
    `\n${file} is ${srcW}x${srcH}, edgeDensity ${edgeDensity.toFixed(4)} measured at ${MEASURE_EDGE},` +
      ` traced at ${colors} colors.` +
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
  default: {
    // Numeric arguments keep the original invocation working, which the header and two tech-debt
    // sections quote. A non-numeric word is a typo, not a request for the synthetic bench.
    const args = [mode, ...rest].filter((a) => a !== undefined);
    const bad = args.filter((a) => !Number.isFinite(Number(a)));
    if (bad.length)
      throw new Error(
        `unknown mode ${bad.join(', ')}. Modes: corpus, colors, curve, scale, render, alpha, ` +
          `or one or more pixel sizes for the synthetic bench.`,
      );
    await modeSynthetic(args.map(Number).filter(Boolean));
  }
}
