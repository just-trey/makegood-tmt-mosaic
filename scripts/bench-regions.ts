// Where the paint-order boolean pass spends its time, and what the n-ary rewrite of it bought.
// Backs the "rebuild performance" section of docs/tech-debt.md.
//
//   node_modules/.bin/vite-node scripts/bench-regions.ts attribute [file...]  shipping vs the old fold
//   node_modules/.bin/vite-node scripts/bench-regions.ts variants  [file...]  every candidate, side by side
//   node_modules/.bin/vite-node scripts/bench-regions.ts scaling   [n...]     batch size against shape count
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
const { computeNetRegionsByColor, cleanFeature, planarArea, shapeToFeature } =
  await import('../src/geometry/regions');
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
 * overlap each other. A disjoint set would make every difference a no-op and measure nothing.
 */
function syntheticShapes(n: number, seed = 1): SVGShape[] {
  let a = seed;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const CANVAS = 1000;
  const VERTS = 64;
  const shapes: SVGShape[] = [
    {
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
    },
  ];
  const palette = ['#e01b24', '#3584e4', '#33d17a', '#f6d32d', '#9141ac', '#1e1c18'];
  for (let i = 1; i < n; i++) {
    const cx = rnd() * CANVAS;
    const cy = rnd() * CANVAS;
    const r = 40 + rnd() * 120;
    const wob = 0.15 + rnd() * 0.35;
    const phase = rnd() * Math.PI * 2;
    const loop = Array.from({ length: VERTS }, (_, k) => {
      const th = (2 * Math.PI * k) / VERTS;
      const rr = r * (1 + wob * Math.sin(3 * th + phase));
      return { x: cx + rr * Math.cos(th), y: cy + rr * Math.sin(th) };
    });
    loop.push({ ...loop[0] });
    shapes.push({ fill: palette[i % palette.length], order: i, loops: [loop] });
  }
  return shapes;
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

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'attribute') await attribute(rest.length ? rest : CORPUS);
else if (mode === 'variants') await variants(rest.length ? rest : CORPUS);
else if (mode === 'scaling') await scaling(rest.length ? rest.map(Number) : [50, 100, 200, 400]);
else {
  console.error('usage: bench-regions.ts attribute|variants [file...] | scaling [n...]');
  process.exit(1);
}
