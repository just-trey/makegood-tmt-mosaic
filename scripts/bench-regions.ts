// Where the paint-order boolean pass spends its time, and what the n-ary rewrite of it bought.
// Backs the "rebuild performance" section of docs/tech-debt.md.
//
//   node_modules/.bin/vite-node scripts/bench-regions.ts attribute [file...]  shipping vs the old fold
//   node_modules/.bin/vite-node scripts/bench-regions.ts variants  [file...]  every candidate, side by side
//   node_modules/.bin/vite-node scripts/bench-regions.ts scaling   [n...]     batch size against shape count
//   node_modules/.bin/vite-node scripts/bench-regions.ts merge     [spec...]  the real pass's per-color merge
//   node_modules/.bin/vite-node scripts/bench-regions.ts chunks    [spec...]  that merge against chunk size
//
// A spec is a file, or a synthetic single-color fixture: dots:N, scatter:N or overlap:N.
//
// `replicaPairwise` is the loop as it stood before COVERED_BATCH: one safeDiff and two safeUnions
// per shape, against an accumulator folded one shape at a time. It is kept, and kept exact, for
// two reasons. It is the baseline every speedup is quoted against, and it is the oracle the areas
// are checked against — a variant that is faster and wrong is the failure this bench exists to
// catch, and `attribute` runs it against the real `computeNetRegionsByColor` so the check lands on
// shipping code rather than on another replica.
//
// It was validated as a replica while it still described shipping: within 3% of the real pass on
// every corpus file, and identical areas. That 3% is also the evidence that Turf's wrappers cost
// nothing, since this replica calls the engine directly where the real pass went through Turf, and
// both were pairwise. Keep it that way. If it stops matching the *areas* the real pass produces,
// the rewrite changed behaviour and that is the finding.
//
// One known asymmetry, left in deliberately: the replica drops the cooperative yield, so the real
// pass pays a ~1ms setTimeout every 30ms that the replica does not (~3% on the dense file). That
// biases *against* the shipping pass, so every speedup `attribute` prints is a floor rather than a
// claim. Do not read the time drift closer than that; the area check is the exact one.
//
// The candidates are reached through the same retry ladder the real helpers use. Without it they
// look faster and drift up to 8% in area, because an op that throws falls back to a degraded
// answer. A variant that is fast because it threw more is not faster.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files chosen for shape count, not for looks: the 135-path SVG is the one tech-debt.md quotes. */
const CORPUS = [
  'stubs/temp/Sunny MLP 2.svg',
  'stubs/temp/snoopy.svg',
  'stubs/temp/pappa.svg',
  'stubs/temp/smurfette.svg',
  'stubs/dino ring.svg',
  'public/patterns/dalmatian.svg',
];

// jsdom has no 2d canvas, so normalizeColor's oracle would return null and collapse every fill to
// black. That would merge the corpus down to one color and benchmark a pass nobody runs. Hex is
// all the corpus uses (checked), so a hex-only oracle is enough.
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
      else if (/^#[0-9a-f]{3}$/.test(str))
        value =
          '#' +
          str
            .slice(1)
            .split('')
            .map((c) => c + c)
            .join('');
    },
  };
} as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;

const pc = (await import('polygon-clipping')).default;
const { parseSVGDocument } = await import('../src/svg/parse');
const { toFiniteInt } = await import('../src/util/number');
const {
  computeNetRegionsByColor,
  cleanFeature,
  planarArea,
  safeUnionAllCooperative,
  shapeToFeature,
  yieldToBrowser,
  YIELD_BUDGET_MS,
} = await import('../src/geometry/regions');
type PolyFeature = import('../src/types').PolyFeature;
type SVGShape = import('../src/types').SVGShape;
type Ring = number[][];
type Poly = Ring[];

const now = () => performance.now();

function load(file: string): { name: string; shapes: SVGShape[] } {
  const full = path.isAbsolute(file) ? file : path.join(REPO, file);
  const parsed = parseSVGDocument(readFileSync(full, 'utf-8'));
  return { name: path.basename(file), shapes: parsed.shapes };
}

function vertexCount(f: PolyFeature | null): number {
  if (!f) return 0;
  const gm = f.geometry;
  const polys = gm.type === 'Polygon' ? [gm.coordinates as Poly] : (gm.coordinates as Poly[]);
  return polys.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0);
}

function toPC(f: PolyFeature): Poly[] {
  const gm = f.geometry;
  return gm.type === 'Polygon' ? [gm.coordinates as Poly] : (gm.coordinates as Poly[]);
}

function fromPC(polys: Poly[]): PolyFeature | null {
  if (!polys.length) return null;
  const geom =
    polys.length === 1
      ? { type: 'Polygon' as const, coordinates: polys[0] }
      : { type: 'MultiPolygon' as const, coordinates: polys };
  return { type: 'Feature', properties: {}, geometry: geom } as PolyFeature;
}

interface Cost {
  shapeToFeature: number;
  cleanInputs: number;
  engineDiff: number;
  engineUnion: number;
  cleanOutputs: number;
  diffOps: number;
  unionOps: number;
  /** Ops that threw and were rescued by the truncate ladder. */
  retries: number;
  /** Ops that threw at every precision and fell back to a degraded answer. */
  failures: number;
  errors: string[];
  total: number;
}

const zeroCost = (): Cost => ({
  shapeToFeature: 0,
  cleanInputs: 0,
  engineDiff: 0,
  engineUnion: 0,
  cleanOutputs: 0,
  diffOps: 0,
  unionOps: 0,
  retries: 0,
  failures: 0,
  errors: [],
  total: 0,
});

/** The truncate ladder from boolOpWithRetry, on raw coordinate arrays so the direct-engine
 * variants keep the same fallback machinery the Turf ones get. */
const RETRY_PRECISIONS = [10, 8, 6];
function truncGeom(polys: Poly[], precision: number): Poly[] {
  const f = Math.pow(10, precision);
  return polys.map((p) =>
    p.map((r) => r.map((pt) => [Math.round(pt[0] * f) / f, Math.round(pt[1] * f) / f])),
  );
}

/**
 * Run an engine op through the same retry ladder the shipping helpers use, recording what threw.
 *
 * Every failure here is a real user-visible degradation ("Couldn't merge the shapes"), so a
 * variant that is fast because it threw more is not faster. `onFail` returns the degraded answer
 * the shipping code would have returned.
 */
function withRetry<T>(cost: Cost, args: Poly[][], run: (args: Poly[][]) => T, onFail: () => T): T {
  try {
    return run(args);
  } catch (e) {
    cost.errors.push((e as Error)?.constructor?.name || 'Error');
    for (const p of RETRY_PRECISIONS) {
      try {
        const out = run(args.map((a) => truncGeom(a, p)));
        cost.retries++;
        return out;
      } catch {
        /* next precision */
      }
    }
    cost.failures++;
    return onFail();
  }
}

/**
 * The paint-order loop as it stood before COVERED_BATCH, with a timer between every step.
 *
 * safeUnion/safeDiff clean *both* inputs on every call, so `covered` was scrubbed twice per shape
 * and again as an output; the attribution below is what priced that. The yield is dropped, because
 * a bench has no browser to repaint.
 */
function replicaPairwise(shapes: SVGShape[]): { byColor: Record<string, PolyFeature>; cost: Cost } {
  const cost = zeroCost();
  const t0 = now();

  let t = now();
  const features = shapes.map(shapeToFeature).map((f, i) => ({ f, color: shapes[i].fill }));
  cost.shapeToFeature = now() - t;

  const byColor: Record<string, PolyFeature> = {};
  let covered: PolyFeature | null = null;

  const op = (
    kind: 'diff' | 'union',
    a: PolyFeature | null,
    b: PolyFeature | null,
  ): PolyFeature | null => {
    t = now();
    const ca = cleanFeature(a);
    const cb = cleanFeature(b);
    cost.cleanInputs += now() - t;
    if (!ca) return kind === 'diff' ? null : cb;
    if (!cb) return ca;
    if (kind === 'diff') cost.diffOps++;
    else cost.unionOps++;
    t = now();
    const r = withRetry(
      cost,
      [toPC(ca), toPC(cb)],
      ([x, y]) => (kind === 'diff' ? pc.difference(x, y) : pc.union(x, y)),
      () => null,
    );
    const spent = now() - t;
    if (kind === 'diff') cost.engineDiff += spent;
    else cost.engineUnion += spent;
    if (r === null) return ca; // the degraded answer safeDiff/safeUnion return on total failure
    t = now();
    const out = cleanFeature(fromPC(r));
    cost.cleanOutputs += now() - t;
    return out;
  };

  for (let i = features.length - 1; i >= 0; i--) {
    const { f, color } = features[i];
    if (!f) continue;
    const visible = covered ? op('diff', f, covered) : f;
    if (visible) {
      byColor[color] = byColor[color]
        ? (op('union', byColor[color], visible) as PolyFeature)
        : visible;
    }
    covered = covered ? op('union', covered, f) : f;
  }
  cost.total = now() - t0;
  return { byColor, cost };
}

/**
 * Candidate: clean every input once, up front, and never again.
 *
 * cleanFeature is idempotent, so re-scrubbing a feature that just came out of a boolean is
 * provably wasted work, and the shipping loop does it three times per shape on the accumulator
 * alone. Nothing about the engine changes, which is what makes this the control for the n-ary
 * variants: whatever it does not win is not attributable to Turf's wrappers.
 */
function replicaCleanOnce(shapes: SVGShape[]): {
  byColor: Record<string, PolyFeature>;
  cost: Cost;
} {
  const cost = zeroCost();
  const t0 = now();

  let t = now();
  const features = shapes.map(shapeToFeature).map((f, i) => ({ f, color: shapes[i].fill }));
  cost.shapeToFeature = now() - t;
  t = now();
  const cleaned = features.map(({ f, color }) => {
    const c = cleanFeature(f);
    return { geom: c ? toPC(c) : null, color };
  });
  cost.cleanInputs = now() - t;

  const byColor: Record<string, Poly[]> = {};
  let covered: Poly[] | null = null;

  for (let i = cleaned.length - 1; i >= 0; i--) {
    const { geom, color } = cleaned[i];
    if (!geom) continue;
    let visible: Poly[] | null = geom;
    if (covered) {
      cost.diffOps++;
      t = now();
      visible = withRetry(
        cost,
        [geom, covered],
        ([x, y]) => pc.difference(x, y),
        () => geom,
      );
      cost.engineDiff += now() - t;
    }
    if (visible && visible.length) {
      const prev = byColor[color];
      if (prev) {
        cost.unionOps++;
        t = now();
        const v = visible;
        byColor[color] = withRetry(
          cost,
          [prev, v],
          ([x, y]) => pc.union(x, y),
          () => prev,
        );
        cost.engineUnion += now() - t;
      } else byColor[color] = visible;
    }
    if (covered) {
      cost.unionOps++;
      t = now();
      const cov: Poly[] = covered;
      covered = withRetry<Poly[]>(
        cost,
        [cov, geom],
        ([x, y]) => pc.union(x, y),
        () => cov,
      );
      cost.engineUnion += now() - t;
    } else covered = geom;
  }

  t = now();
  const out = finishFeatures(byColor);
  cost.cleanOutputs += now() - t;
  cost.total = now() - t0;
  return { byColor: out, cost };
}

/**
 * Candidate: the engine n-ary, with the accumulator collapsed every `batch` shapes.
 *
 * Within a batch the accumulator is stale, so the visibility difference is taken against it *and*
 * every not-yet-folded shape above this one, in one call: `difference(f, covered, ...pending)` is
 * a single sweep and is algebraically identical to subtracting a fully up-to-date union. Per-color
 * pieces are collected and unioned once at the end rather than folded in one at a time.
 *
 * batch = 1 collapses at the shipping cadence, so it separates "n-ary sweeps helped" from
 * "skipping the pairwise accumulator helped".
 */
function replicaNary(
  shapes: SVGShape[],
  batch: number,
): { byColor: Record<string, PolyFeature>; cost: Cost } {
  const cost = zeroCost();
  const t0 = now();

  let t = now();
  const features = shapes.map(shapeToFeature).map((f, i) => ({ f, color: shapes[i].fill }));
  cost.shapeToFeature = now() - t;
  t = now();
  const cleaned = features.map(({ f, color }) => {
    const c = cleanFeature(f);
    return { geom: c ? toPC(c) : null, color };
  });
  cost.cleanInputs = now() - t;

  const pieces: Record<string, Poly[][]> = {};
  let covered: Poly[] | null = null;
  let pending: Poly[][] = [];

  const collapse = (): void => {
    if (!pending.length) return;
    const args = covered ? [covered, ...pending] : pending;
    const prev = covered;
    cost.unionOps++;
    t = now();
    covered = withRetry(
      cost,
      args,
      (a) => pc.union(a[0], ...a.slice(1)),
      // Total failure of the collapse means the accumulator misses those shapes, which is the
      // n-ary shape of safeUnion's "used unmerged" degradation.
      () => prev ?? args[0],
    );
    cost.engineUnion += now() - t;
    pending = [];
  };

  for (let i = cleaned.length - 1; i >= 0; i--) {
    const { geom, color } = cleaned[i];
    if (!geom) continue;
    let visible: Poly[] | null = geom;
    if (covered || pending.length) {
      const clippings = covered ? [covered, ...pending] : pending.slice();
      cost.diffOps++;
      t = now();
      visible = withRetry(
        cost,
        [geom, ...clippings],
        (a) => pc.difference(a[0], ...a.slice(1)),
        () => geom,
      );
      cost.engineDiff += now() - t;
    }
    if (visible && visible.length) (pieces[color] ||= []).push(visible);
    pending.push(geom);
    if (pending.length >= batch) collapse();
  }

  const byColor: Record<string, Poly[]> = {};
  for (const [color, list] of Object.entries(pieces)) {
    if (list.length === 1) {
      byColor[color] = list[0];
      continue;
    }
    cost.unionOps++;
    t = now();
    byColor[color] = withRetry(
      cost,
      list,
      (a) => pc.union(a[0], ...a.slice(1)),
      () => list[0],
    );
    cost.engineUnion += now() - t;
  }

  t = now();
  const out = finishFeatures(byColor);
  cost.cleanOutputs += now() - t;
  cost.total = now() - t0;
  return { byColor: out, cost };
}

function finishFeatures(byColor: Record<string, Poly[]>): Record<string, PolyFeature> {
  const out: Record<string, PolyFeature> = {};
  for (const [color, polys] of Object.entries(byColor)) {
    const f = cleanFeature(fromPC(polys));
    if (f) out[color] = f;
  }
  return out;
}

/**
 * Run every timed path once, discarded, so none of them is measured cold.
 *
 * Both the baseline and the candidates, because warming only the baseline would tilt it the other
 * way. `attribute` needs it too: without it the first file measured charges its warm-up to the
 * real pass and the replica reads 10% faster on ordering alone.
 */
function warmUp(shapes: SVGShape[]): void {
  replicaPairwise(shapes);
  replicaCleanOnce(shapes);
  replicaNary(shapes, 8);
  replicaNary(shapes, Number.MAX_SAFE_INTEGER);
}

const ms = (n: number) => `${n.toFixed(0)}ms`;
const pct = (n: number, total: number) => `${((100 * n) / total).toFixed(0)}%`;

function areaSignature(byColor: Record<string, PolyFeature>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(byColor)) out[k] = planarArea(v);
  return out;
}

/** Worst per-color relative area drift against the shipping result, plus any color that appeared
 * or vanished. Area is the check that catches a variant subtracting the wrong thing. */
function compare(
  base: Record<string, number>,
  cand: Record<string, number>,
): { worstRel: number; missing: string[]; extra: string[] } {
  const missing = Object.keys(base).filter((k) => !(k in cand));
  const extra = Object.keys(cand).filter((k) => !(k in base));
  let worstRel = 0;
  for (const [k, a] of Object.entries(base)) {
    if (!(k in cand)) continue;
    const rel = a > 0 ? Math.abs(cand[k] - a) / a : cand[k] === 0 ? 0 : 1;
    worstRel = Math.max(worstRel, rel);
  }
  return { worstRel, missing, extra };
}

function printCost(label: string, cost: Cost): void {
  const t = cost.total;
  console.log(
    `  ${label.padEnd(22)} ${ms(t).padStart(8)}   ` +
      `shapeToFeature ${ms(cost.shapeToFeature).padStart(7)} ${pct(cost.shapeToFeature, t).padStart(4)}   ` +
      `cleanIn ${ms(cost.cleanInputs).padStart(7)} ${pct(cost.cleanInputs, t).padStart(4)}   ` +
      `diff ${ms(cost.engineDiff).padStart(7)} ${pct(cost.engineDiff, t).padStart(4)}   ` +
      `union ${ms(cost.engineUnion).padStart(7)} ${pct(cost.engineUnion, t).padStart(4)}   ` +
      `cleanOut ${ms(cost.cleanOutputs).padStart(7)} ${pct(cost.cleanOutputs, t).padStart(4)}   ` +
      `ops ${cost.diffOps}d/${cost.unionOps}u   retry ${cost.retries}   fail ${cost.failures}` +
      (cost.errors.length ? `   threw ${[...new Set(cost.errors)].join('/')}` : ''),
  );
}

async function attribute(files: string[]): Promise<void> {
  console.log('\nShipping computeNetRegionsByColor against the pairwise loop it replaced\n');
  for (const file of files) {
    const { name, shapes } = load(file);
    warmUp(shapes);
    // The real pass is warmed on a *separate parse* of the same file. It memoizes on the shapes
    // array's identity, so warming it on `shapes` would make the timed call a cache hit and report
    // near-zero. Without this it was the one timed path running cold, against a warm replica.
    await computeNetRegionsByColor(load(file).shapes, () => {});
    const t0 = now();
    const real = await computeNetRegionsByColor(shapes, () => {});
    const realMs = now() - t0;

    const rep = replicaPairwise(shapes);
    const c = compare(areaSignature(real.byColor), areaSignature(rep.byColor));

    const verts = Object.values(real.byColor).reduce((s, f) => s + vertexCount(f), 0);
    console.log(
      `${name}  ${shapes.length} shapes, ${Object.keys(real.byColor).length} colors, ` +
        `${verts} result vertices`,
    );
    console.log(`  ${'real (shipping)'.padEnd(22)} ${ms(realMs).padStart(8)}`);
    printCost('pairwise (was)', rep.cost);
    console.log(
      `  pairwise takes ${(rep.cost.total / realMs).toFixed(2)}x real's time, ` +
        `and lands ${(100 * c.worstRel).toFixed(3)}% off its worst area` +
        (c.missing.length ? `, MISSING ${c.missing.join(',')}` : '') +
        (c.extra.length ? `, EXTRA ${c.extra.join(',')}` : '') +
        '\n',
    );
  }
}

async function variants(files: string[]): Promise<void> {
  console.log('\nCandidates against the pairwise loop (area-checked)\n');
  for (const file of files) {
    const { name, shapes } = load(file);
    // Warm every path on this file's own geometry before timing any of it. The baseline runs
    // first, so without this it absorbs the JIT warm-up and every candidate reads faster than it
    // is: n=50 measured 324ms cold against 230ms warm, which shipped a 2.5x into a code comment
    // where the truth was 1.9x.
    warmUp(shapes);
    const base = replicaPairwise(shapes);
    const sig = areaSignature(base.byColor);
    console.log(`${name}  ${shapes.length} shapes, ${Object.keys(base.byColor).length} colors`);
    printCost('pairwise (was)', base.cost);

    const cands: [string, () => { byColor: Record<string, PolyFeature>; cost: Cost }][] = [
      ['clean-once', () => replicaCleanOnce(shapes)],
      ['n-ary batch=1', () => replicaNary(shapes, 1)],
      ['n-ary batch=8', () => replicaNary(shapes, 8)],
      ['n-ary batch=32', () => replicaNary(shapes, 32)],
      ['n-ary batch=all', () => replicaNary(shapes, Number.MAX_SAFE_INTEGER)],
    ];
    for (const [label, run] of cands) {
      const r = run();
      printCost(label, r.cost);
      const c = compare(sig, areaSignature(r.byColor));
      const speed = base.cost.total / r.cost.total;
      const flags = [
        `${speed.toFixed(2)}x`,
        `worst area drift ${(100 * c.worstRel).toFixed(3)}%`,
        c.missing.length ? `MISSING ${c.missing.join(',')}` : '',
        c.extra.length ? `EXTRA ${c.extra.join(',')}` : '',
      ].filter(Boolean);
      console.log(`  ${''.padEnd(22)} ${flags.join('   ')}`);
    }
    console.log('');
  }
}

/**
 * A synthetic design of `n` overlapping shapes, so the batch size can be chosen from a curve
 * rather than from the one 140-shape file that happens to exist.
 *
 * Deliberately the hard case the accumulator comment describes: a full-canvas background at the
 * bottom of the paint order that every later shape overlaps, then blobs scattered dense enough to
 * overlap each other. It is not the worst case: disjoint blobs never collapse the accumulator, and
 * 400 of them took 15.9s through the real pass (`merge dots:400`) where this set's 400 take ~0.7s
 * at batch 8 (`scaling 400`).
 */
function syntheticShapes(n: number, seed = 1): SVGShape[] {
  const rnd = seeded(seed);
  const palette = ['#e01b24', '#3584e4', '#33d17a', '#f6d32d', '#9141ac', '#1e1c18'];
  const shapes = [background()];
  for (let i = 1; i < n; i++) {
    const cx = rnd() * CANVAS;
    const cy = rnd() * CANVAS;
    const r = 40 + rnd() * 120;
    const wob = 0.15 + rnd() * 0.35;
    const phase = rnd() * Math.PI * 2;
    shapes.push(blob(palette[i % palette.length], i, cx, cy, r, wob, phase));
  }
  return shapes;
}

const CANVAS = 1000;

function seeded(seed: number): () => number {
  let a = seed;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function background(): SVGShape {
  return {
    fill: '#ffffff',
    order: 0,
    loops: [
      [
        { x: 0, y: 0 },
        { x: CANVAS, y: 0 },
        { x: CANVAS, y: CANVAS },
        { x: 0, y: CANVAS },
        { x: 0, y: 0 },
      ],
    ],
  };
}

/** A 64-vertex three-lobed blob, the one shape every synthetic fixture here is built from. */
function blob(
  fill: string,
  order: number,
  cx: number,
  cy: number,
  r: number,
  wob: number,
  phase: number,
): SVGShape {
  const VERTS = 64;
  const loop = Array.from({ length: VERTS }, (_, k) => {
    const th = (2 * Math.PI * k) / VERTS;
    const rr = r * (1 + wob * Math.sin(3 * th + phase));
    return { x: cx + rr * Math.cos(th), y: cy + rr * Math.sin(th) };
  });
  loop.push({ ...loop[0] });
  return { fill, order, loops: [loop] };
}

/** Batch sizes swept by `scaling`. Override with MOSAIC_BENCH_BATCHES=2,4,8. */
const BATCHES = (process.env.MOSAIC_BENCH_BATCHES || '8,32,128,all')
  .split(',')
  .map((s) => (s.trim() === 'all' ? Number.MAX_SAFE_INTEGER : Number(s)));

async function scaling(counts: number[]): Promise<void> {
  console.log('\nBatch size against shape count, on synthetic overlapping artwork\n');
  for (const n of counts) {
    const shapes = syntheticShapes(n);
    warmUp(shapes);
    const base = replicaPairwise(shapes);
    const sig = areaSignature(base.byColor);
    console.log(`n=${n}`);
    printCost('pairwise (was)', base.cost);
    for (const batch of BATCHES) {
      const label = batch === Number.MAX_SAFE_INTEGER ? 'all' : String(batch);
      const r = replicaNary(shapes, batch);
      printCost(`n-ary batch=${label}`, r.cost);
      const c = compare(sig, areaSignature(r.byColor));
      console.log(
        `  ${''.padEnd(22)} ${(base.cost.total / r.cost.total).toFixed(2)}x   ` +
          `worst area drift ${(100 * c.worstRel).toFixed(3)}%` +
          (c.missing.length ? `   MISSING ${c.missing.length}` : '') +
          (c.extra.length ? `   EXTRA ${c.extra.length}` : ''),
      );
    }
    console.log('');
  }
}

type UnionFn = (g: Poly[], ...gs: Poly[][]) => Poly[];
const pcMut = pc as unknown as { union: UnionFn; difference: UnionFn };
const realUnion = pcMut.union;
const realDifference = pcMut.difference;

/** Every n-ary engine union the real pass makes after its visibility loop, with its arguments and
 * how long the one call took. The pass reports exactly 0.9 when that loop ends, and only the
 * per-color merge runs after it, so the progress callback is the phase marker. A merge that falls
 * back to the pairwise fold goes through Turf's own copy of the engine, which this does not see. */
async function capturedMerge(shapes: SVGShape[]): Promise<{
  mergeMs: number;
  lists: Poly[][][];
  longest: number;
  engineMs: number;
  foldLongest: number;
  diffLongest: number;
  passMs: number;
}> {
  const lists: Poly[][][] = [];
  let longest = 0;
  let engineMs = 0;
  let foldLongest = 0;
  let diffLongest = 0;
  let mergeStart = -1;
  // A call that throws is timed too: the retry ladder re-runs it, and every attempt is main thread.
  pcMut.union = (...args: Poly[][]) => {
    const t = now();
    try {
      return realUnion(args[0], ...args.slice(1));
    } finally {
      const spent = now() - t;
      if (mergeStart >= 0) {
        engineMs += spent;
        longest = Math.max(longest, spent);
        lists.push(args);
      } else foldLongest = Math.max(foldLongest, spent);
    }
  };
  pcMut.difference = (...args: Poly[][]) => {
    const t = now();
    try {
      return realDifference(args[0], ...args.slice(1));
    } finally {
      diffLongest = Math.max(diffLongest, now() - t);
    }
  };
  const t0 = now();
  try {
    await computeNetRegionsByColor(shapes, (f) => {
      if (f >= 0.9 && mergeStart < 0) mergeStart = now();
    });
  } finally {
    pcMut.union = realUnion;
    pcMut.difference = realDifference;
  }
  const passMs = now() - t0;
  return {
    mergeMs: mergeStart < 0 ? 0 : now() - mergeStart,
    lists,
    longest,
    engineMs,
    foldLongest,
    diffLongest,
    passMs,
  };
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Synthetic single-shade artwork for the per-color merge: `n` pieces of one fill over a
 * background, laid out so they reach the merge as `n` separate pieces.
 *
 * - `dots`: a grid of disjoint blobs, so the union collapses nothing (a spotted pattern).
 * - `scatter`: small blobs at random, overlapping in clusters.
 * - `overlap`: large blobs at random, overlapping almost everywhere. */
function singleShade(kind: 'dots' | 'scatter' | 'overlap', n: number, seed = 1): SVGShape[] {
  const rnd = seeded(seed);
  const side = Math.ceil(Math.sqrt(n));
  const cell = CANVAS / side;
  const shapes = [background()];
  for (let i = 0; i < n; i++) {
    if (kind === 'dots') {
      const cx = ((i % side) + 0.5) * cell;
      const cy = (Math.floor(i / side) + 0.5) * cell;
      shapes.push(blob('#1e1c18', i + 1, cx, cy, cell * 0.3, 0.2, i));
      continue;
    }
    const cx = rnd() * CANVAS;
    const cy = rnd() * CANVAS;
    const r = kind === 'scatter' ? 8 + rnd() * 16 : 40 + rnd() * 120;
    const wob = 0.15 + rnd() * 0.35;
    const phase = rnd() * Math.PI * 2;
    shapes.push(blob('#1e1c18', i + 1, cx, cy, r, wob, phase));
  }
  return shapes;
}

/** Timed runs per measurement in `merge` and `chunks`, after one warm-up. MOSAIC_BENCH_REPEATS=1 for
 * the 800-piece fixtures, whose whole pass runs for minutes. */
const REPEATS = positiveInt('MOSAIC_BENCH_REPEATS', process.env.MOSAIC_BENCH_REPEATS || '5');

function positiveInt(name: string, raw: string): number {
  const n = toFiniteInt(raw);
  if (n === null || n < 1 || String(n) !== raw.trim()) throw new Error(`${name}: bad value ${raw}`);
  return n;
}

const SYNTHETIC = /^(dots|scatter|overlap):(\d+)$/;
function loadAny(spec: string): { name: string; shapes: SVGShape[] } {
  const m = SYNTHETIC.exec(spec);
  if (!m) return load(spec);
  return { name: spec, shapes: singleShade(m[1] as 'dots' | 'scatter' | 'overlap', Number(m[2])) };
}

async function merge(specs: string[]): Promise<void> {
  console.log(
    `\nThe real pass's per-color merge phase (median of ${REPEATS}, each on a fresh parse)\n`,
  );
  let total = 0;
  for (const spec of specs) {
    await capturedMerge(loadAny(spec).shapes); // warm
    const runs = [];
    for (let r = 0; r < REPEATS; r++) runs.push(await capturedMerge(loadAny(spec).shapes));
    const ms = median(runs.map((r) => r.mergeMs));
    const longest = median(runs.map((r) => r.longest));
    const engine = median(runs.map((r) => r.engineMs));
    const fold = median(runs.map((r) => r.foldLongest));
    const diff = median(runs.map((r) => r.diffLongest));
    const pass = median(runs.map((r) => r.passMs));
    const pieces = runs[0].lists.map((l) => l.length);
    total += ms;
    console.log(
      `  ${spec.padEnd(28)} merge ${ms.toFixed(1).padStart(7)}ms   longest engine call ` +
        `${longest.toFixed(1).padStart(7)}ms   in engine ${engine.toFixed(1).padStart(7)}ms   engine unions ${pieces.length}   ` +
        `largest list ${pieces.length ? Math.max(...pieces) : 0} pieces   ` +
        `| whole pass ${pass.toFixed(0)}ms, longest fold ${fold.toFixed(1)}ms, ` +
        `longest difference ${diff.toFixed(1)}ms`,
    );
  }
  console.log(`  ${'total'.padEnd(28)} merge ${total.toFixed(1).padStart(7)}ms`);
}

/** Chunk sizes swept by `chunks`. Override with MOSAIC_BENCH_CHUNKS=50,100,all. */
const CHUNKS = (process.env.MOSAIC_BENCH_CHUNKS || '25,50,100,200,400,all')
  .split(',')
  .map((s) =>
    s.trim() === 'all' ? Number.MAX_SAFE_INTEGER : positiveInt('MOSAIC_BENCH_CHUNKS', s),
  );

/**
 * Candidate, not shipping: the per-color merge handed to the engine `chunk` pieces at a time, then
 * the chunk results the same way, yielding between chunks. `chunk` >= the list length is exactly
 * the shipping call, so `all` is the baseline.
 */
async function unionPiecesChunked(
  pieces: PolyFeature[],
  chunk: number,
): Promise<PolyFeature | null> {
  const size = Math.max(2, chunk);
  let level = pieces;
  let lastYield = now();
  while (level.length > size) {
    const next: PolyFeature[] = [];
    for (let i = 0; i < level.length; i += size) {
      const u = await safeUnionAllCooperative(level.slice(i, i + size));
      if (u) next.push(u);
      if (now() - lastYield > YIELD_BUDGET_MS) {
        await yieldToBrowser();
        lastYield = now();
      }
    }
    level = next;
  }
  return safeUnionAllCooperative(level);
}

/**
 * The per-color merge at each chunk size, on the exact piece lists the real pass handed its merge.
 * `all` is the unchunked single sweep. Areas are checked against it: a chunking that is fast
 * because a union failed and fell back is not faster.
 */
async function chunks(specs: string[]): Promise<void> {
  console.log(
    `\nPer-color merge against chunk size (median of ${REPEATS}, area-checked against all)\n`,
  );
  for (const spec of specs) {
    const { name, shapes } = loadAny(spec);
    const { lists } = await capturedMerge(shapes);
    const inputs = lists.map((l) => l.map((g) => fromPC(g) as PolyFeature));
    const pieces = inputs.map((l) => l.length);
    const verts = inputs.reduce((s, l) => s + l.reduce((t, f) => t + vertexCount(f), 0), 0);
    console.log(
      `${name}  ${inputs.length} merged colors, largest ${Math.max(0, ...pieces)} pieces, ` +
        `${verts} input vertices`,
    );
    let base: Record<string, number> | null = null;
    const ALL = Number.MAX_SAFE_INTEGER;
    for (const chunk of [ALL, ...CHUNKS.filter((c) => c !== ALL)]) {
      const label = chunk === ALL ? 'all' : String(chunk);
      const once = async () => {
        let longest = 0;
        let calls = 0;
        pcMut.union = (...args: Poly[][]) => {
          const t = now();
          const out = realUnion(args[0], ...args.slice(1));
          longest = Math.max(longest, now() - t);
          calls++;
          return out;
        };
        const t0 = now();
        const out: Record<string, number> = {};
        try {
          for (let c = 0; c < inputs.length; c++) {
            const merged = await unionPiecesChunked(inputs[c], chunk);
            out[String(c)] = merged ? planarArea(merged) : 0;
          }
        } finally {
          pcMut.union = realUnion;
        }
        return { ms: now() - t0, longest, calls, areas: out };
      };
      await once(); // warm
      const runs = [];
      for (let r = 0; r < REPEATS; r++) runs.push(await once());
      base ??= runs[0].areas;
      const c = compare(base, runs[0].areas);
      console.log(
        `  chunk=${label.padEnd(5)} ${median(runs.map((r) => r.ms))
          .toFixed(1)
          .padStart(8)}ms   ` +
          `longest call ${median(runs.map((r) => r.longest))
            .toFixed(1)
            .padStart(7)}ms   ` +
          `calls ${String(runs[0].calls).padStart(4)}   ` +
          `worst area drift ${(100 * c.worstRel).toFixed(4)}%`,
      );
    }
    console.log('');
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'attribute') await attribute(rest.length ? rest : CORPUS);
else if (mode === 'variants') await variants(rest.length ? rest : CORPUS);
else if (mode === 'chunks')
  await chunks(rest.length ? rest : ['dots:800', 'scatter:800', 'overlap:800']);
else if (mode === 'merge') await merge(rest.length ? rest : CORPUS);
else if (mode === 'scaling') await scaling(rest.length ? rest.map(Number) : [50, 100, 200, 400]);
else {
  console.error(
    'usage: bench-regions.ts attribute|variants [file...] | scaling [n...] | merge|chunks [spec...]',
  );
  process.exit(1);
}
