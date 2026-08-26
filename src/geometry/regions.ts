import * as turf from '@turf/turf';
import polygonClipping from 'polygon-clipping';
import type { Loop, PolyFeature, ResolvedRegion, SVGShape } from '../types';
import { signedArea } from '../svg/path';
import { deltaE, hexToLab } from '../color';
import { warnBuild } from '../warnings';
import { reportProgress } from '../progress';
import { throwIfCancelled } from '../cancel';
import { rethrowStackOverflowAs } from '../errors';

type Ring = number[][];

/**
 * Collapse consecutive points closer together than a tiny epsilon.
 * The most common real cause of "self-intersecting path" boolean failures is floating-point
 * noise: two flattened curve segments meeting at a seam that's off by ~1e-10 instead of being
 * bit-identical, which strict polygon-clipping treats as a non-simple polygon.
 */
export function dedupeRing(ring: Loop, eps = 1e-6): Loop {
  if (ring.length < 4) return ring;
  const out: Loop = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i],
      prev = out[out.length - 1];
    if (Math.hypot(p.x - prev.x, p.y - prev.y) > eps) out.push(p);
  }
  if (
    out.length > 1 &&
    Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= eps
  ) {
    out.pop(); // drop redundant closing point, we re-close below
  }
  if (out.length < 3) return ring;
  out.push(out[0]);
  return out;
}

export function loopToRing(loop: Loop, forceCCW?: boolean): Ring | null {
  let pts = loop.slice();
  if (pts.length < 3) return null;
  const first = pts[0],
    last = pts[pts.length - 1];
  if (Math.abs(first.x - last.x) > 1e-9 || Math.abs(first.y - last.y) > 1e-9)
    pts.push({ x: first.x, y: first.y });
  pts = dedupeRing(pts);
  if (pts.length < 4) return null; // degenerated to nothing after cleanup
  const area = signedArea(pts); // >0 = CCW in standard math orientation
  let ring: Ring = pts.map((p) => [p.x, p.y]);
  const isCCW = area > 0;
  if (forceCCW !== undefined && isCCW !== forceCCW) ring = ring.reverse();
  return ring;
}

/**
 * Build a turf (Multi)Polygon feature for one SVG shape (one <path> etc., possibly multiple
 * subpaths).
 *
 * Hole-vs-solid is resolved by geometric nesting depth, not winding sign. SVG has two fill rules:
 * "nonzero", where tools conventionally wind holes opposite their exterior, and "evenodd", where a
 * hole can legally share its exterior's winding (common from Affinity Designer/Illustrator).
 * Containment depth (odd = hole, even = solid island) is correct for both on any well-formed path.
 *
 * That depth resolution is O(rings²·len): every subpath ring is point-in-polygon tested against
 * every other. Not a live issue on anything in use, and benchmarked rather than assumed
 * (scripts/bench-shape-to-feature.ts): the worst real file measured 5.88ms, public/patterns/
 * zebra.svg, a single 69-subpath path, an order of magnitude under the 30ms yield budget. It
 * matters more than that number suggests because the caller maps this over every shape *before*
 * the first yield, so the failure mode is a frozen tab rather than a slow one. The untested risk
 * is a dense Illustrator export, hundreds of subpaths in one <path> (fur, stipple line art), which
 * no current sample exercises; measure such a file rather than guessing a threshold now.
 *
 * Raster tracing is the first producer that could plausibly reach it, and is held off by the
 * despeckle floor rather than by luck. MAX_COMPONENTS (src/raster/trace.ts) is what holds it down,
 * and it is a target rather than a bound (see its own note): re-run the bench if that cap is
 * raised or the floor lowered.
 *
 * Separately, thousands of nested rings or <g> elements deep enough to overflow the JS call stack
 * fail with a named "unusually deeply nested" error instead of a raw stack-overflow message, but
 * neither this nor `walk` in src/svg/parse.ts is actually depth-limited.
 */
export function shapeToFeature(shape: SVGShape): PolyFeature | null {
  const rings = shape.loops
    .map((l) => ({ raw: l, areaAbs: Math.abs(signedArea(l)) }))
    .filter((r) => r.areaAbs > 1e-7);
  if (!rings.length) return null;
  const n = rings.length;

  function pointInRaw(raw: Loop, pt: { x: number; y: number }): boolean {
    let inside = false;
    for (let i = 0, j = raw.length - 1; i < raw.length; j = i++) {
      const xi = raw[i].x,
        yi = raw[i].y,
        xj = raw[j].x,
        yj = raw[j].y;
      const hit = yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
      if (hit) inside = !inside;
    }
    return inside;
  }

  /**
   * The point used to ask "is this ring inside that one".
   *
   * Rings of one shape never cross, so in exact arithmetic any point of a ring answers for all of
   * it. The exception is a probe sitting exactly *on* the other ring, where an even-odd ray cast
   * is undefined, and a shape's rings do meet at isolated points all the time.
   *
   * The first vertex is the worst choice, systematically so for traced artwork: `spliceChains`
   * (raster/trace.ts) rotates every ring to start on a chain boundary, which is a junction, so
   * precisely where another ring passes through. Measured on a 28x28 three-way fixture, a 13-unit
   * hole read as "outside" its own component on `raw[0]` alone, while 25 of its other 26 vertices
   * and all 26 edge midpoints read inside. It was emitted as a solid island, painting over its own
   * cavity and swallowing the differently-coloured region in it.
   *
   * An edge midpoint fixes it: coincidence there needs the rings to share a whole segment, which
   * the crack graph cannot produce (a component's outer and hole rings are always different
   * chains). Computed once per ring, so it costs nothing in the quadratic loop below.
   */
  const probeOf = (raw: Loop) => ({ x: (raw[0].x + raw[1].x) / 2, y: (raw[0].y + raw[1].y) / 2 });

  // immediate parent = smallest-area ring that contains this ring (excluding itself)
  const parent = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let bestArea = Infinity,
      bestIdx = -1;
    const testPt = probeOf(rings[i].raw);
    for (let j = 0; j < n; j++) {
      if (i === j || rings[j].areaAbs <= rings[i].areaAbs) continue;
      if (rings[j].areaAbs < bestArea && pointInRaw(rings[j].raw, testPt)) {
        bestArea = rings[j].areaAbs;
        bestIdx = j;
      }
    }
    parent[i] = bestIdx;
  }
  const depth = new Array<number>(n).fill(-1);
  function getDepth(i: number): number {
    if (depth[i] !== -1) return depth[i];
    return (depth[i] = parent[i] === -1 ? 0 : 1 + getDepth(parent[i]));
  }
  try {
    for (let i = 0; i < n; i++) getDepth(i);
  } catch (e) {
    rethrowStackOverflowAs(
      e,
      "This SVG has unusually deeply nested geometry (rings nested past a normal depth) and couldn't be processed.",
    );
  }

  const children: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) if (parent[i] !== -1) children[parent[i]].push(i);

  const polys: Ring[][] = [];
  function emitPoly(i: number): void {
    const extRing = loopToRing(rings[i].raw, true);
    if (!extRing) return;
    const holeRings: Ring[] = [];
    children[i].forEach((c) => {
      const hr = loopToRing(rings[c].raw, false);
      if (hr) holeRings.push(hr);
      children[c].forEach((gc) => emitPoly(gc)); // depth+2 descendants are separate solid islands
    });
    polys.push([extRing, ...holeRings]);
  }
  try {
    for (let i = 0; i < n; i++) if (depth[i] === 0) emitPoly(i);
  } catch (e) {
    rethrowStackOverflowAs(
      e,
      "This SVG has unusually deeply nested geometry (rings nested past a normal depth) and couldn't be processed.",
    );
  }
  if (!polys.length) return null;

  const geom =
    polys.length === 1
      ? { type: 'Polygon' as const, coordinates: polys[0] }
      : { type: 'MultiPolygon' as const, coordinates: polys };
  return { type: 'Feature', properties: {}, geometry: geom } as PolyFeature;
}

/**
 * Scrub degenerate rings from a feature. Boolean ops can EMIT degenerate rings even from clean
 * input: a difference whose edges run along each other leaves a zero-area sliver "hole" (an
 * out-and-back point sequence). Feeding that sliver into a later union sends turf 6.5's
 * sweep-line into unbounded recursion, so every feature is scrubbed both entering and leaving
 * safeUnion/safeDiff: drop near-duplicate consecutive vertices and any ring with ~zero area.
 */
export function cleanFeature(f: PolyFeature | null): PolyFeature | null {
  if (!f || !f.geometry) return f;
  const EPS = 1e-9;
  function ringArea(r: Ring): number {
    let s = 0;
    for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    return s / 2;
  }
  function cleanRing(coords: Ring): Ring | null {
    const out: Ring = [];
    coords.forEach((p) => {
      const prev = out[out.length - 1];
      if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > EPS) out.push(p);
    });
    while (
      out.length > 1 &&
      Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= EPS
    )
      out.pop();
    if (out.length < 3) return null;
    out.push([out[0][0], out[0][1]]);
    return Math.abs(ringArea(out)) > EPS ? out : null;
  }
  function cleanPoly(rings: Ring[]): Ring[] | null {
    const ext = cleanRing(rings[0]);
    if (!ext) return null; // exterior degenerated -> whole polygon (and its holes) goes
    const holes = rings
      .slice(1)
      .map(cleanRing)
      .filter((r): r is Ring => !!r);
    return [ext, ...holes];
  }
  const g = f.geometry;
  const polys = (g.type === 'Polygon' ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][]))
    .map(cleanPoly)
    .filter((p): p is Ring[] => !!p);
  if (!polys.length) return null;
  const geom =
    polys.length === 1
      ? { type: 'Polygon' as const, coordinates: polys[0] }
      : { type: 'MultiPolygon' as const, coordinates: polys };
  return { type: 'Feature', properties: f.properties || {}, geometry: geom } as PolyFeature;
}

/**
 * Planar shoelace area of a feature (exterior minus holes, per polygon). turf.area is geodesic: it
 * reads coordinates as lon/lat degrees, and SVG/mm coordinates far outside ±90° wrap its spherical
 * trig into garbage, including negative per-polygon areas, on real artwork. Every area ratio and
 * dominant-member comparison in the pipeline must use this instead.
 */
export function planarArea(f: PolyFeature | null): number {
  if (!f || !f.geometry) return 0;
  function ringArea(r: Ring): number {
    let s = 0;
    for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    return Math.abs(s / 2);
  }
  function polyArea(rings: Ring[]): number {
    const holes = rings.slice(1).reduce((s, r) => s + ringArea(r), 0);
    return Math.max(0, ringArea(rings[0]) - holes);
  }
  const g = f.geometry;
  return g.type === 'Polygon'
    ? polyArea(g.coordinates as Ring[])
    : (g.coordinates as Ring[][]).reduce((s, p) => s + polyArea(p), 0);
}

/**
 * Turf 6.5's bundled polygon-clipping recurses without bound when two inputs share edges differing
 * only at ~1e-14, exactly what circle arcs against star-boundary regions produce. Quantizing
 * collapses those phantom distinctions, so on failure retry at decreasing precision. 1e-10 mm is
 * far below anything a printer can express, so retries are geometrically free.
 */
export function boolOpWithRetry(
  fn: (a: PolyFeature, b: PolyFeature) => PolyFeature | null,
  a: PolyFeature,
  b: PolyFeature,
): { ok: boolean; val?: PolyFeature | null } {
  try {
    return { ok: true, val: cleanFeature(fn(a, b)) };
  } catch {
    for (const p of [10, 8, 6]) {
      try {
        const ta = turf.truncate(a, { precision: p, mutate: false });
        const tb = turf.truncate(b, { precision: p, mutate: false });
        return { ok: true, val: cleanFeature(fn(ta, tb)) };
      } catch {
        /* next precision */
      }
    }
    return { ok: false };
  }
}

/** MultiPolygon coordinates, the form the clipping engine takes and returns. */
type Geom = Ring[][];

function toGeom(f: PolyFeature): Geom {
  const g = f.geometry;
  return g.type === 'Polygon' ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][]);
}

function fromGeom(polys: Geom): PolyFeature | null {
  if (!polys.length) return null;
  const geom =
    polys.length === 1
      ? { type: 'Polygon' as const, coordinates: polys[0] }
      : { type: 'MultiPolygon' as const, coordinates: polys };
  return { type: 'Feature', properties: {}, geometry: geom } as PolyFeature;
}

function truncGeom(polys: Geom, precision: number): Geom {
  const f = Math.pow(10, precision);
  return polys.map((p) =>
    p.map((r) => r.map((pt) => [Math.round(pt[0] * f) / f, Math.round(pt[1] * f) / f])),
  );
}

/**
 * `boolOpWithRetry` for an n-ary op, called on the clipping engine directly rather than through
 * Turf.
 *
 * Turf's union/difference are one-line wrappers that take exactly two features and hand their
 * coordinates to this same engine, so a pairwise fold pays a full sweep per pair. The engine
 * itself is n-ary: one sweep over every input. Measured (scripts/bench-regions.ts) that is where
 * essentially all of the pass's time was, and n-ary sweeps take ~45% of it off.
 *
 * The retry ladder is the same one and matters as much: without it the direct calls fall back on
 * inputs Turf's truncate would have rescued, and a degraded region is a wrong region, not a slow
 * one.
 */
function naryOpWithRetry(
  fn: (args: Geom[]) => Geom,
  args: Geom[],
): { ok: boolean; val?: PolyFeature | null } {
  try {
    return { ok: true, val: cleanFeature(fromGeom(fn(args))) };
  } catch {
    for (const p of [10, 8, 6]) {
      try {
        return { ok: true, val: cleanFeature(fromGeom(fn(args.map((a) => truncGeom(a, p))))) };
      } catch {
        /* next precision */
      }
    }
    return { ok: false };
  }
}

/**
 * Union every feature in one engine sweep.
 *
 * **A failed sweep falls back to the pairwise fold, it does not give up on the batch.** One sweep
 * covering n features has one outcome for all of them, so returning "the first one" on failure
 * would discard the other n-1 -- where the fold this replaced lost exactly the one shape that
 * failed. Re-folding gives every pair its own retry ladder and restores that: a bad shape costs a
 * shape. It runs only after a total failure, so the fast path never pays for it.
 */
export function safeUnionAll(features: (PolyFeature | null)[], label?: string): PolyFeature | null {
  const live = features.map(cleanFeature).filter((f): f is PolyFeature => !!f);
  if (live.length < 2) return live[0] ?? null;
  const r = naryOpWithRetry((a) => polygonClipping.union(a[0], ...a.slice(1)), live.map(toGeom));
  if (r.ok) return r.val ?? null;
  let acc: PolyFeature | null = live[0];
  for (let i = 1; i < live.length; i++) acc = safeUnion(acc, live[i], label);
  return acc;
}

/**
 * `safeUnionAll` for a list whose length the artwork decides, not a constant.
 *
 * Same sweep, but the fallback is `unionAllCooperative` rather than a straight-line fold: it
 * yields on the same budget and merges as a balanced tree. The sync fold above is fine where the
 * caller bounds the batch (COVERED_BATCH caps it at 8 pairwise ops), and is a frozen tab where it
 * does not -- a colour can carry hundreds of pieces, and the fallback runs precisely when the
 * engine is already struggling with them.
 */
export async function safeUnionAllCooperative(
  features: (PolyFeature | null)[],
  label?: string,
): Promise<PolyFeature | null> {
  const live = features.map(cleanFeature).filter((f): f is PolyFeature => !!f);
  if (live.length < 2) return live[0] ?? null;
  const r = naryOpWithRetry((a) => polygonClipping.union(a[0], ...a.slice(1)), live.map(toGeom));
  if (r.ok) return r.val ?? null;
  return unionAllCooperative(live, undefined, label);
}

/**
 * Subtract every clipping from `subject` in one engine sweep. Falls back to subtracting them one
 * at a time for the same reason `safeUnionAll` re-folds: a failed sweep otherwise leaves the
 * subject untrimmed against clippings that would each have succeeded on their own.
 */
export function safeDiffAll(
  subject: PolyFeature | null,
  clippings: (PolyFeature | null)[],
  label?: string,
): PolyFeature | null {
  const s = cleanFeature(subject);
  if (!s) return null;
  const live = clippings.map(cleanFeature).filter((f): f is PolyFeature => !!f);
  if (!live.length) return s;
  const r = naryOpWithRetry(
    (a) => polygonClipping.difference(a[0], ...a.slice(1)),
    [toGeom(s), ...live.map(toGeom)],
  );
  if (r.ok) return r.val ?? null;
  let acc: PolyFeature | null = s;
  for (const c of live) acc = safeDiff(acc, c, label);
  return acc;
}

/**
 * Diagnostics from the boolean helpers, tee'd into the memoized pass's record (if one is running)
 * on the way to the warning list. computeNetRegionsByColor's result is cached across rebuilds, so
 * a cache hit has to replay them (see the cache-hit branch below).
 */
let boolDiagnostics: string[] | null = null;

function warnBool(message: string): void {
  boolDiagnostics?.push(message);
  warnBuild(message);
}

export function safeUnion(
  a: PolyFeature | null,
  b: PolyFeature | null,
  label?: string,
): PolyFeature | null {
  a = cleanFeature(a);
  b = cleanFeature(b);
  if (!a) return b;
  if (!b) return a;
  const r = boolOpWithRetry((x, y) => turf.union(x, y) as PolyFeature | null, a, b);
  if (r.ok) return r.val ?? null;
  warnBool(
    `Couldn't merge the shapes${label ? ` for ${label}` : ''}. They are used unmerged, so this region may be missing part of its area.`,
  );
  return a;
}

export function safeDiff(
  a: PolyFeature | null,
  b: PolyFeature | null,
  label?: string,
): PolyFeature | null {
  a = cleanFeature(a);
  b = cleanFeature(b);
  if (!a) return null;
  if (!b) return a;
  const r = boolOpWithRetry((x, y) => turf.difference(x, y) as PolyFeature | null, a, b);
  if (r.ok) return r.val ?? null;
  warnBool(
    `Couldn't trim the overlap${label ? ` for ${label}` : ''}. That region may overlap its neighbor instead of being trimmed back.`,
  );
  return a;
}

export function safeIntersect(
  a: PolyFeature | null,
  b: PolyFeature | null,
  label?: string,
): PolyFeature | null {
  return safeIntersectChecked(a, b, label).feat;
}

/**
 * `safeIntersect`, but saying whether the clip actually happened.
 *
 * The fallback returns the region **unclipped**, indistinguishable from a successful clip to a
 * caller that only reads `feat`. That matters to the edge-cut-through rule, which reads "reaches
 * past the face boundary" as "stands on the part's outer wall": an unclipped region reaches past
 * everywhere, so a clipper failure turned an oversized recess into a hole clean through the part.
 * Callers depending on the input really being bounded by the face ask for the flag.
 */
export function safeIntersectChecked(
  a: PolyFeature | null,
  b: PolyFeature | null,
  label?: string,
): { feat: PolyFeature | null; clipped: boolean } {
  a = cleanFeature(a);
  b = cleanFeature(b);
  if (!a || !b) return { feat: null, clipped: false };
  const r = boolOpWithRetry((x, y) => turf.intersect(x, y) as PolyFeature | null, a, b);
  if (r.ok) return { feat: r.val ?? null, clipped: true };
  warnBool(
    `Clipping color region to the design face failed${label ? ` for ${label}` : ''}. Region left unclipped, may extend past the face edge.`,
  );
  return { feat: a, clipped: false };
}

/** How long a boolean pass runs before yielding a frame to the browser. */
export const YIELD_BUDGET_MS = 30;

/** A macrotask yield (setTimeout, not a microtask) so the browser can repaint the progress curtain
 * between chunks. Promise.resolve() would not unblock rendering. */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

/**
 * Union a list of features by balanced pairwise merging (pairs, then pairs of pairs), yielding on
 * a time budget and reporting progress. A left fold re-processes the ever-growing accumulator
 * every step; the tree does the same math in O(log n) levels and benchmarks 2-4x faster on dense
 * designs. safeUnion's fallback semantics are preserved per merge.
 */
export async function unionAllCooperative(
  features: (PolyFeature | null)[],
  onProgress?: (fraction: number) => void,
  label?: string,
): Promise<PolyFeature | null> {
  let level = features.filter((f): f is PolyFeature => !!f);
  if (!level.length) return null;
  const totalOps = Math.max(level.length - 1, 1);
  let done = 0;
  let lastYield = performance.now();
  while (level.length > 1) {
    const next: PolyFeature[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
        continue;
      }
      const u = safeUnion(level[i], level[i + 1], label);
      if (u) next.push(u);
      done++;
      onProgress?.(done / totalOps);
      if (performance.now() - lastYield > YIELD_BUDGET_MS) {
        await yieldToBrowser();
        lastYield = performance.now();
      }
    }
    level = next;
  }
  return level[0] ?? null;
}

/**
 * How many shapes are subtracted individually before the accumulator is folded.
 *
 * Not a tuning knob to taste: the two ends both lose. Folding every shape (batch 1) is the old
 * pairwise cadence and gains almost nothing. Never folding wins on a small design and collapses on
 * a dense one, because every difference then carries every shape above it: at 400 shapes it
 * measured 13552ms against 1257ms for the old pairwise loop and 704ms for batch 8, so **11x the
 * loop it replaced and 19x this**.
 *
 * 8 is chosen for the whole curve rather than for the best reading at any one size. Over
 * 50/100/200/400 synthetic overlapping shapes it runs 1.9x, 1.8x, 1.9x, 1.8x against the pairwise
 * loop, and a finer sweep puts 4 through 12 on a flat plateau with 8 on it. Bigger batches beat it
 * at 50 shapes (3.0x) and are the numbers above at 400.
 *
 * It also bounds one engine call, which is what keeps the yield below honest. A batch of every
 * shape is one atomic multi-second sweep with no frame to give back.
 */
const COVERED_BATCH = 8;

/** Memo for the pass below, keyed on the parsed shapes' identity. */
let regionsCacheKey: SVGShape[] | null = null;
let regionsCacheVal: { byColor: Record<string, PolyFeature> } | null = null;
let regionsCacheDiagnostics: string[] = [];

/**
 * Compute, per color, the net *visible* region accounting for paint order
 * (later elements occlude earlier ones).
 *
 * Visibility is f minus the accumulated union of everything painted above it. Subtracting each
 * later element individually with a bbox pre-filter is algebraically identical but benchmarked ~2x
 * SLOWER on real artwork: full-canvas backgrounds and lineart overlap everything, so the filter
 * rarely prunes and the pairwise diffs multiply. The accumulator stays.
 *
 * The accumulator is folded in batches rather than one shape at a time, and the per-color pieces
 * are unioned once at the end, so both n-ary ops reach the engine as a single sweep. Within a
 * batch the accumulator is deliberately stale: the visibility difference subtracts it *and* the
 * not-yet-folded shapes above this one in the same call, which is the same set the up-to-date
 * accumulator would have held. Measured 1.5-2.9x on real artwork against the pairwise fold, with
 * per-color areas identical (scripts/bench-regions.ts).
 *
 * The dominant cost of a rebuild, so it runs cooperatively: every ~YIELD_BUDGET_MS it yields a
 * frame and reports progress, keeping the tab responsive on a dense SVG. See src/progress.ts.
 *
 * Unbuilt on purpose: a `disjoint` fast path. Raster-traced regions are disjoint by construction,
 * so every safeDiff here is provably a no-op and the whole pass collapses to array concatenation.
 * It would make per-component raster granularity viable and cut the per-color path's 136ms too,
 * but at the 8 shades that path actually produces the pass is not where the time goes. Build it
 * only if MAX_COMPONENTS (src/raster/trace.ts) is ever raised enough to change that.
 */
export async function computeNetRegionsByColor(
  shapes: SVGShape[],
  onProgress: (fraction: number) => void = reportProgress,
): Promise<{
  byColor: Record<string, PolyFeature>;
}> {
  // `shapes` (ParsedSVG.shapes) is always assigned fresh from a parse and never mutated in place,
  // so identity is a safe cache key. Depth/fit/margin/color tweaks don't touch it at all.
  if (shapes === regionsCacheKey && regionsCacheVal) {
    // Cached regions may be degraded ones a failed boolean fell back to. No op re-runs on a hit,
    // so replay what the computing pass reported: warnings are build-scoped, the rebuild now using
    // these regions cleared them, and the degradation is still on screen.
    for (const m of regionsCacheDiagnostics) warnBuild(m);
    onProgress(1);
    return regionsCacheVal;
  }
  const outerDiagnostics = boolDiagnostics;
  const diagnostics: string[] = [];
  boolDiagnostics = diagnostics;
  try {
    const features = shapes.map(shapeToFeature).map((f, idx) => ({ f, color: shapes[idx].fill }));
    const pieces: Record<string, PolyFeature[]> = {};
    let covered: PolyFeature | null = null;
    let pending: PolyFeature[] = [];
    const total = features.length || 1;
    let lastYield = performance.now();
    for (let i = features.length - 1; i >= 0; i--) {
      const { f, color } = features[i];
      if (f) {
        const visible =
          covered || pending.length
            ? safeDiffAll(f, covered ? [covered, ...pending] : pending, `color ${color}`)
            : f;
        if (visible) (pieces[color] ||= []).push(visible);
        pending.push(f);
        if (pending.length >= COVERED_BATCH) {
          // No label: a batch spans whatever colors fell in it, so naming this shape's color would
          // point the user at one arbitrary member of it. The old pairwise fold could name a color
          // honestly because it folded exactly one shape.
          covered = safeUnionAll(covered ? [covered, ...pending] : pending);
          pending = [];
        }
      }
      // The per-color merge below is real work, so the visibility loop stops short of 1: it owns
      // the first 90% and the merge owns the rest. Reporting 1 here and then merging is how a
      // progress bar sits full while the tab is still busy.
      onProgress(0.9 * ((total - i) / total));
      if (performance.now() - lastYield > YIELD_BUDGET_MS) {
        // Safe here, unlike anywhere inside the per-part cut: this pass is pure 2D polygon work
        // and holds no Manifold solids, so a throw leaks nothing (see src/cancel.ts). It is also
        // where a heavy design actually spends its time — a 6000-region wheel sat at 11% for the
        // whole 140.4s the 2026-08-24 cycle measured, which is this loop, not the CSG below it.
        throwIfCancelled();
        await yieldToBrowser();
        lastYield = performance.now();
      }
    }
    // One sweep per color, and unlike the accumulator fold it is bounded by nothing: the piece
    // count comes from the artwork. The yield below runs *between* colors, so a single color with
    // very many pieces is still one atomic call. Measured small on everything real (30ms over the
    // corpus, 18ms worst), and worth keeping n-ary: folding it cooperatively instead costs dino
    // ring 123ms -> 158ms. The unbounded case is a raster trace near MAX_COMPONENTS with one
    // dominant shade, and it is written up in docs/tech-debt.md rather than closed with a chunk
    // size nobody measured.
    const byColor: Record<string, PolyFeature> = {};
    const colors = Object.entries(pieces);
    for (let c = 0; c < colors.length; c++) {
      const [color, list] = colors[c];
      const merged =
        list.length === 1 ? list[0] : await safeUnionAllCooperative(list, `color ${color}`);
      if (merged) byColor[color] = merged;
      onProgress(0.9 + (0.1 * (c + 1)) / colors.length);
      if (performance.now() - lastYield > YIELD_BUDGET_MS) {
        // Same safety as the visibility loop above, and the same reason to want it: this merge is
        // the unbounded case the comment on COVERED_BATCH names, so a cancel landing here waited
        // it out with no check of its own.
        throwIfCancelled();
        await yieldToBrowser();
        lastYield = performance.now();
      }
    }
    onProgress(1); // artwork with no usable shapes never entered either loop
    const result = { byColor };
    regionsCacheKey = shapes;
    regionsCacheVal = result;
    regionsCacheDiagnostics = diagnostics;
    return result;
  } finally {
    boolDiagnostics = outerDiagnostics;
  }
}

/**
 * Auto-merge slider stops. Index = slider value, 0 is "off". CIE76 ΔE cutoffs measured against the
 * stubs/ sample artwork. Slight dedupes near-identical export/anti-aliasing artifacts (pappa.svg's
 * near-duplicate reds sit at ΔE 0.4) without touching real differences (snoopy.svg's closest pair
 * is ΔE 91.7). Medium starts banding intentional shading ramps; Strong collapses toward hue
 * families.
 */
export const AUTO_MERGE_LEVELS = [
  { label: 'None', threshold: 0 },
  { label: 'Slight', threshold: 3 },
  { label: 'Medium', threshold: 10 },
  { label: 'Strong', threshold: 18 },
] as const;

export interface ApplyColorMergesOptions {
  /** index into AUTO_MERGE_LEVELS; 0 or omitted = no auto-merge */
  autoMergeLevel?: number;
  /** raw hexes assigned to the base material; excluded from regions entirely */
  baseColors?: string[];
  /** raw hexes the user explicitly pulled out of a group; pinned as singletons */
  keptApart?: string[];
}

class UnionFind {
  private parent = new Map<string, string>();
  add(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x: string): string {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a),
      rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Resolve raw per-color regions into the regions to cut. Base-assigned colors are excluded, then
 * manual merge groups and the auto-merge slider's ΔE clusters are unioned (either link fuses a
 * pair), then `keptApart` pins split back out as singletons. Everything downstream treats a merged
 * group like a normal color, keyed by a stable group id instead of a hex.
 *
 * Auto-clusters are computed live from `byColor` per call, never persisted, which is what makes
 * the slider reversible: dragging it down re-splits colors instead of leaving them stuck.
 */
export function applyColorMerges(
  byColor: Record<string, PolyFeature>,
  mergeGroups: string[][],
  opts: ApplyColorMergesOptions = {},
): ResolvedRegion[] {
  const baseSet = new Set(opts.baseColors || []);
  const pinSet = new Set(opts.keptApart || []);
  const colors = Object.keys(byColor).filter((h) => !baseSet.has(h));
  const colorSet = new Set(colors);

  const uf = new UnionFind();
  colors.forEach((h) => uf.add(h));

  (mergeGroups || []).forEach((group) => {
    const members = group.filter((h) => colorSet.has(h));
    for (let i = 1; i < members.length; i++) uf.union(members[0], members[i]);
  });

  const threshold = AUTO_MERGE_LEVELS[opts.autoMergeLevel || 0]?.threshold || 0;
  if (threshold > 0) {
    const clusterable = colors.filter((h) => !pinSet.has(h));
    const labs = new Map(clusterable.map((h) => [h, hexToLab(h)]));
    for (let i = 0; i < clusterable.length; i++) {
      for (let j = i + 1; j < clusterable.length; j++) {
        const a = clusterable[i],
          b = clusterable[j];
        if (deltaE(labs.get(a)!, labs.get(b)!) <= threshold) uf.union(a, b);
      }
    }
  }

  const groups = new Map<string, string[]>();
  colors.forEach((h) => {
    if (pinSet.has(h)) return; // pins are emitted as their own singleton below
    const root = uf.find(h);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(h);
  });

  const out: ResolvedRegion[] = [];
  groups.forEach((members) => {
    if (members.length < 2) {
      const h = members[0];
      out.push({ key: h, members: [h], feature: byColor[h], isMerge: false, previewColor: h });
      return;
    }
    let feat: PolyFeature | null = null;
    members.forEach((h) => {
      feat = feat ? safeUnion(feat, byColor[h]) : byColor[h];
    });
    if (!feat) return;
    // The merged slot prints as a real artwork color, never a blended average: the dominant
    // (largest-area) member's exact hex.
    const dominant = members
      .slice()
      .sort((a, b) => planarArea(byColor[b]) - planarArea(byColor[a]))[0];
    const key = 'merge:' + members.slice().sort().join(',');
    out.push({ key, members, feature: feat, isMerge: true, previewColor: dominant });
  });
  colors.forEach((h) => {
    if (pinSet.has(h))
      out.push({ key: h, members: [h], feature: byColor[h], isMerge: false, previewColor: h });
  });
  return out;
}
