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
 * Turf (Multi)Polygon for one SVG shape. Holes by containment depth (odd = hole), not winding:
 * correct under both "nonzero" and "evenodd", where a hole can share its exterior's winding
 * (common from Affinity Designer/Illustrator).
 *
 * Depth resolution is O(rings²·len) and runs over every shape *before* the first yield, so the
 * failure mode is a frozen tab. Worst real file: public/patterns/zebra.svg, one 69-subpath path,
 * 5.88ms against the 30ms yield budget (scripts/bench-shape-to-feature.ts). Unmeasured: a dense
 * Illustrator export, hundreds of subpaths in one <path> (fur, stipple). Raster tracing is held off
 * by the despeckle floor and MAX_COMPONENTS (src/raster/trace.ts); re-bench if either loosens.
 *
 * Deep nesting fails with a named "unusually deeply nested" error, but neither this nor `walk` in
 * src/svg/parse.ts is actually depth-limited.
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
   * The probe for "is this ring inside that one": an edge midpoint, never a vertex. A ray cast is
   * undefined for a probe *on* the other ring, and `spliceChains` (raster/trace.ts) starts every
   * ring on a junction, where other rings pass. On a 28x28 three-way fixture `raw[0]` read a
   * 13-unit hole as outside its component (25 of its 26 other vertices and all 26 midpoints read
   * inside), emitting a solid island over its own cavity. Coincidence at a midpoint needs a shared
   * segment, which the crack graph cannot produce.
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
): CappedResult {
  try {
    return { ok: true, val: cleanFeature(fn(a, b)) };
  } catch (e) {
    if (isSizeLimit(e)) return { ok: false, tooBig: true };
    for (const p of [10, 8, 6]) {
      try {
        const ta = turf.truncate(a, { precision: p, mutate: false });
        const tb = turf.truncate(b, { precision: p, mutate: false });
        return { ok: true, val: cleanFeature(fn(ta, tb)) };
      } catch (e2) {
        if (isSizeLimit(e2)) return { ok: false, tooBig: true };
      }
    }
    return { ok: false };
  }
}

/**
 * The engine's two size limits, told apart from its precision failures by their messages (pinned
 * in tests/regions-sweep-cap.test.ts). Truncating coordinates cannot bring either under, so a
 * retry is four doomed sweeps of the same size.
 */
function isSizeLimit(e: unknown): boolean {
  return e instanceof Error && /queue size too big|too many sweep line segments/.test(e.message);
}

/**
 * Most segments one engine call can hold: polygon-clipping 0.15.7 queues two sweep events per
 * segment and throws past 1,000,000 (tests/regions-sweep-cap.test.ts takes it exactly and one
 * square past). Its other limit, 1,000,000 sweep-line pieces, multiplies with crossings (500 strips
 * each way reach it from 4,000 segments); uncountable ahead, so caught as `tooBig`.
 */
export const SWEEP_SEGMENT_CAP = 500_000;

/** Segments the engine queues for a feature: one per ring edge, closing edge included. */
export function segmentCount(f: PolyFeature | null): number {
  return f ? toGeom(f).reduce((n, p) => n + polySegments(p), 0) : 0;
}

/** Segments left for the subject once every clip is in the call. */
export function roomBesideClips(clips: (PolyFeature | null)[], cap = SWEEP_SEGMENT_CAP): number {
  return clips.reduce((n, c) => n - segmentCount(c), cap);
}

/**
 * Whether `subject` can be clipped by `clips`, all in one call, however it is split: its biggest
 * polygon is the one piece no split divides. The same test the split itself refuses on.
 */
export function fitsBesideClips(
  subject: PolyFeature | null,
  clips: (PolyFeature | null)[],
  cap = SWEEP_SEGMENT_CAP,
): boolean {
  const room = roomBesideClips(clips, cap);
  return !!subject && toGeom(subject).every((p) => polySegments(p) <= room);
}

/**
 * Thrown by a union told to refuse rather than degrade when it is too big to run. Fill mode asks
 * for it: its fallback is one tile placed instead of a part that is quietly half blank.
 */
export class UnionTooBig extends Error {
  constructor() {
    super('A union is too big for the clipping engine, even split.');
  }
}

function polySegments(rings: Ring[]): number {
  return rings.reduce((n, r) => n + r.length - 1, 0);
}

type Box = [number, number, number, number];

/** Of the exterior ring alone: a hole lies inside it. */
function polyBox(rings: Ring[]): Box {
  const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of rings[0]) {
    if (p[0] < b[0]) b[0] = p[0];
    if (p[1] < b[1]) b[1] = p[1];
    if (p[0] > b[2]) b[2] = p[0];
    if (p[1] > b[3]) b[3] = p[1];
  }
  return b;
}

function boxOf(polys: Geom): Box {
  const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polys) {
    const q = polyBox(p);
    b[0] = Math.min(b[0], q[0]);
    b[1] = Math.min(b[1], q[1]);
    b[2] = Math.max(b[2], q[2]);
    b[3] = Math.max(b[3], q[3]);
  }
  return b;
}

/** Closed, so two boxes that only touch count: touching polygons still have to weld. */
function boxesMeet(a: Box, b: Box): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

const UNION = (x: PolyFeature, y: PolyFeature): PolyFeature | null =>
  turf.union(x, y) as PolyFeature | null;

const BOOL_OPS = {
  union: UNION,
  intersect: (x: PolyFeature, y: PolyFeature) => INTERSECT(x, y),
  difference: (x: PolyFeature, y: PolyFeature) => DIFFERENCE(x, y),
};

/** What `boolOpUnderCap` did. `tooBig` is set on a failure no split could bring under the cap. */
export interface CappedResult {
  ok: boolean;
  val?: PolyFeature | null;
  tooBig?: boolean;
}

/**
 * `boolOpWithRetry` split into calls each under SWEEP_SEGMENT_CAP; only an op over the cap splits.
 * Exact, because both sides are merged sets (as every boolean result is): a polygon whose box
 * misses the other side skips the engine, and each polygon's clip depends on nothing else. One
 * call failing fails the op, so the caller's warning covers it all. One polygon over the cap (a
 * fill whose background welds across every seam) is `tooBig`, never run.
 */
export function boolOpUnderCap(
  kind: keyof typeof BOOL_OPS,
  a: PolyFeature,
  b: PolyFeature,
  cap = SWEEP_SEGMENT_CAP,
): CappedResult {
  const fn = BOOL_OPS[kind];
  if (segmentCount(a) + segmentCount(b) <= cap) return boolOpWithRetry(fn, a, b);
  if (kind === 'union') {
    const r = unionUnderCap(toGeom(a), toGeom(b), cap, { calls: 0 });
    return r.ok ? { ok: true, val: fromGeom(r.val) } : r;
  }
  return splitSubject(a, [b], kind === 'difference', (g) => boolOpWithRetry(fn, g, b), cap);
}

/**
 * `run` over `subject` a group of polygons at a time, each group sized to share one call with
 * every clip. A polygon whose box misses the clips skips the engine: nothing of it survives an
 * intersect (`keepFar` false), and a subtraction leaves it whole (`keepFar` true).
 */
function splitSubject(
  subject: PolyFeature,
  clips: PolyFeature[],
  keepFar: boolean,
  run: (group: PolyFeature) => CappedResult,
  cap: number,
): CappedResult {
  const room = roomBesideClips(clips, cap);
  const clipBox = boxOf(clips.flatMap(toGeom));
  const out: Geom = [];
  let group: Geom = [];
  let groupSegs = 0;
  let failed: CappedResult | null = null;
  const flush = (): boolean => {
    if (!group.length) return true;
    const r = run(fromGeom(group)!);
    group = [];
    groupSegs = 0;
    if (!r.ok) failed = r;
    else if (r.val) for (const p of toGeom(r.val)) out.push(p);
    return r.ok;
  };
  for (const p of toGeom(subject)) {
    if (!boxesMeet(polyBox(p), clipBox)) {
      if (keepFar) out.push(p);
      continue;
    }
    const s = polySegments(p);
    if (s > room) return { ok: false, tooBig: true };
    if (group.length && groupSegs + s > room && !flush()) return failed!;
    group.push(p);
    groupSegs += s;
  }
  if (!flush()) return failed!;
  return { ok: true, val: fromGeom(out) };
}

/**
 * Engine calls one split union may make before it gives up as `tooBig`. The halving below always
 * shrinks the first half's problem but not the second's, so nothing else bounds it.
 */
const SPLIT_CALL_LIMIT = 256;

/**
 * The union half of `boolOpUnderCap`. Polygons out of reach of the other side pass through; the
 * rest go to the engine, and if even they pass the cap, the side with more of them is halved along
 * its longer axis and merged in one half at a time. Halving is what rescues a long, thin fill,
 * where every polygon of a row can sit within reach of the seam below it.
 */
function unionUnderCap(
  pa: Geom,
  pb: Geom,
  cap: number,
  budget: { calls: number },
): { ok: true; val: Geom } | { ok: false; tooBig?: boolean } {
  const engine = (x: Geom, y: Geom): { ok: true; val: Geom } | { ok: false; tooBig?: boolean } => {
    budget.calls++;
    const r = boolOpWithRetry(UNION, fromGeom(x)!, fromGeom(y)!);
    return r.ok ? { ok: true, val: r.val ? toGeom(r.val) : [] } : { ok: false, tooBig: r.tooBig };
  };
  if (!pa.length || !pb.length) return { ok: true, val: [...pa, ...pb] };
  const segsOf = (g: Geom): number => g.reduce((n, p) => n + polySegments(p), 0);
  if (segsOf(pa) + segsOf(pb) <= cap) return engine(pa, pb);
  // Narrowed twice: b's polygons within reach of a, then a's within reach of those. The second
  // pass is what keeps a tile union's merge to the rows either side of one seam.
  const aBox = boxOf(pa);
  const bNear = pb.filter((p) => boxesMeet(polyBox(p), aBox));
  const nearBox = boxOf(bNear);
  const aNear = bNear.length ? pa.filter((p) => boxesMeet(polyBox(p), nearBox)) : [];
  const nearA = new Set(aNear);
  const nearB = new Set(bNear);
  const out: Geom = [];
  for (const p of pa) if (!nearA.has(p)) out.push(p);
  for (const p of pb) if (!nearB.has(p)) out.push(p);
  let merged: { ok: true; val: Geom } | { ok: false; tooBig?: boolean };
  if (!aNear.length) merged = { ok: true, val: bNear };
  else if (segsOf(aNear) + segsOf(bNear) <= cap) merged = engine(aNear, bNear);
  else {
    const [x, y] = aNear.length >= bNear.length ? [aNear, bNear] : [bNear, aNear];
    if (x.length < 2 || budget.calls >= SPLIT_CALL_LIMIT) return { ok: false, tooBig: true };
    const [x1, x2] = halves(x);
    const first = unionUnderCap(x1, y, cap, budget);
    merged = first.ok ? unionUnderCap(first.val, x2, cap, budget) : first;
  }
  if (!merged.ok) return merged;
  for (const p of merged.val) out.push(p);
  return { ok: true, val: out };
}

function halves(polys: Geom): [Geom, Geom] {
  const b = boxOf(polys);
  const axis = b[2] - b[0] >= b[3] - b[1] ? 0 : 1;
  const centre = (p: Ring[]): number => {
    const q = polyBox(p);
    return (q[axis] + q[axis + 2]) / 2;
  };
  const sorted = [...polys].sort((p, q) => centre(p) - centre(q));
  const mid = sorted.length >> 1;
  return [sorted.slice(0, mid), sorted.slice(mid)];
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

/**
 * Drop pieces of a clipped region too small to print, and say how many went. A clip boundary
 * running ALONG an edge (a dead region sharing its chart's outline, two claims meeting at a seam)
 * hands back a hairline, which still extrudes: the chair shipped a 0.0253mm² one, 0.020mm wide and
 * 8.08mm long on `chair-seat-back-top`'s Front chart, cutting a 0.4mm mark under the cushion.
 *
 * **Per piece**: on that chart the clip returns the 2,634mm² band AND the hairline, and a floor on
 * the total keeps both.
 *
 * **Never asks whether the clip made a piece small** — not answerable from a boolean's output. The
 * clipper fuses touching inputs (two abutting 0.3 x 0.2mm dots inside the boundary came back as
 * nothing), and `boolOpWithRetry`'s catch truncates at 1e-10, 1e-8, 1e-6. Applied flat; the caller
 * reports what went.
 *
 * An area admits a long enough hairline and refuses a dot one nozzle across. **An area on
 * purpose**: this sees design INK, so a width test would delete a deliberate 0.3mm stroke
 * (docs/audience.md). At the bake no width separates dust from surface either:
 * docs/findings/2026-09-08-cut-region-width.md, `npx vite-node scripts/measure-cut-width.mjs`.
 * Ink sweep: docs/findings/2026-09-27-clip-ink-sweep.md, `RUN_CLIP_INK_SWEEP=1 npx vitest run
 * scripts/measure-clip-ink.test.ts` — 9.4% of pieces sit below this floor, mostly one pattern's
 * fine detail. Open in docs/tech-debt.md: "Whether a near-floor clipped-ink piece is dust or a
 * drawn detail is unmeasured". Bake pieces off their chart's triangles are the bake's to clip,
 * not this floor's: 0 of 82 at least half off since the clip (`npx vite-node
 * scripts/measure-cut-offsurface.mjs`).
 *
 * Retired: the seam overlap. All 45 chair overlap pieces build a cutter on both parts, and
 * `buildCutter` extrudes a ribbon one micron wide and 120mm long fine (`npx vite-node
 * scripts/measure-seam-overlap.mjs`, docs/findings/2026-09-07-seam-ribbon-closed.md).
 */
export function dropUnprintableRemnants(
  feat: PolyFeature | null,
  floorMM2: number,
): { feat: PolyFeature | null; dropped: number } {
  if (!feat) return { feat, dropped: 0 };
  const polys = toGeom(feat);
  const kept = polys.filter((rings) => planarArea(fromGeom([rings])) >= floorMM2);
  if (kept.length === polys.length) return { feat, dropped: 0 };
  return { feat: fromGeom(kept), dropped: polys.length - kept.length };
}

function truncGeom(polys: Geom, precision: number): Geom {
  const f = Math.pow(10, precision);
  return polys.map((p) =>
    p.map((r) => r.map((pt) => [Math.round(pt[0] * f) / f, Math.round(pt[1] * f) / f])),
  );
}

/**
 * `boolOpWithRetry` for an n-ary op on the engine directly: Turf's union/difference take exactly
 * two features, so a pairwise fold pays a sweep per pair, and n-ary sweeps take ~45% off the pass
 * (scripts/bench-regions.ts). Same retry ladder, or inputs truncate rescues degrade (wrong, not
 * slow).
 */
function naryOpWithRetry(fn: (args: Geom[]) => Geom, args: Geom[]): CappedResult {
  try {
    return { ok: true, val: cleanFeature(fromGeom(fn(args))) };
  } catch (e) {
    if (isSizeLimit(e)) return { ok: false, tooBig: true };
    for (const p of [10, 8, 6]) {
      try {
        return { ok: true, val: cleanFeature(fromGeom(fn(args.map((a) => truncGeom(a, p))))) };
      } catch (e2) {
        if (isSizeLimit(e2)) return { ok: false, tooBig: true };
      }
    }
    return { ok: false };
  }
}

/**
 * Union every feature in one engine sweep. **A failed sweep falls back to the pairwise fold**, or
 * one failure would discard n-1 features; re-folding gives every pair its own retry ladder, so a
 * bad shape costs one shape. The fast path never pays for it.
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
 * `safeUnionAll` for an artwork-sized list: the fallback is `unionAllCooperative` (yielding,
 * balanced tree). The sync fold is fine where the caller bounds the batch (COVERED_BATCH: 8), and
 * a frozen tab where not — a colour can carry hundreds of pieces, and the fallback runs exactly
 * when the engine is already struggling.
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
  const r = differenceAllChecked(subject, clippings);
  if (r.trimmed) return r.feat;
  let acc: PolyFeature | null = r.feat;
  for (const c of clippings) acc = safeDiff(acc, c, label);
  return acc;
}

/**
 * The one sweep of `safeDiffAll`, with no fallback and no warning: the subject back whole and
 * `trimmed: false` when the sweep fails, for a caller that names the failure itself.
 */
export function differenceAllChecked(
  subject: PolyFeature | null,
  clippings: (PolyFeature | null)[],
): { feat: PolyFeature | null; trimmed: boolean } {
  const s = cleanFeature(subject);
  if (!s) return { feat: null, trimmed: true };
  const live = clippings.map(cleanFeature).filter((f): f is PolyFeature => !!f);
  if (!live.length) return { feat: s, trimmed: true };
  const sweep = (g: PolyFeature): CappedResult =>
    naryOpWithRetry(
      (a) => polygonClipping.difference(a[0], ...a.slice(1)),
      [toGeom(g), ...live.map(toGeom)],
    );
  const r =
    segmentCount(s) <= roomBesideClips(live, SWEEP_SEGMENT_CAP)
      ? sweep(s)
      : splitSubject(s, live, true, sweep, SWEEP_SEGMENT_CAP);
  return r.ok ? { feat: r.val ?? null, trimmed: true } : { feat: s, trimmed: false };
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

/** `refuseTooBig` throws UnionTooBig where the fallback below would otherwise drop `b`. */
export function safeUnion(
  a: PolyFeature | null,
  b: PolyFeature | null,
  label?: string,
  refuseTooBig = false,
): PolyFeature | null {
  a = cleanFeature(a);
  b = cleanFeature(b);
  if (!a) return b;
  if (!b) return a;
  const r = boolOpUnderCap('union', a, b);
  if (r.ok) return r.val ?? null;
  if (r.tooBig && refuseTooBig) throw new UnionTooBig();
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
  const r = differenceChecked(a, b);
  if (!r.trimmed)
    warnBool(
      `Couldn't trim the overlap${label ? ` for ${label}` : ''}. That region may overlap its neighbor instead of being trimmed back.`,
    );
  return r.feat;
}

/**
 * `safeDiff` without its warning, saying whether the subtraction happened: the fallback returns the
 * subject WHOLE, which reads like "took nothing off", so `clipToNetShare` would name a zone a mark
 * moved to while it is still cut here too. Nothing to subtract is a success.
 */
export function differenceChecked(
  a: PolyFeature | null,
  b: PolyFeature | null,
): { feat: PolyFeature | null; trimmed: boolean } {
  a = cleanFeature(a);
  b = cleanFeature(b);
  if (!a) return { feat: null, trimmed: true };
  if (!b) return { feat: a, trimmed: true };
  const r = boolOpUnderCap('difference', a, b);
  return r.ok ? { feat: r.val ?? null, trimmed: true } : { feat: a, trimmed: false };
}

const DIFFERENCE = (x: PolyFeature, y: PolyFeature): PolyFeature | null =>
  turf.difference(x, y) as PolyFeature | null;

export function safeIntersect(
  a: PolyFeature | null,
  b: PolyFeature | null,
  label?: string,
): PolyFeature | null {
  return safeIntersectChecked(a, b, label).feat;
}

/**
 * `safeIntersect`, saying whether the clip happened: the fallback returns the region **unclipped**,
 * which the edge-cut-through rule reads as standing on the outer wall everywhere — a clipper
 * failure turned a recess into a hole clean through. Callers relying on the face bound ask.
 */
export function safeIntersectChecked(
  a: PolyFeature | null,
  b: PolyFeature | null,
  label?: string,
): { feat: PolyFeature | null; clipped: boolean } {
  const r = intersectChecked(a, b);
  if (!r.clipped && r.feat)
    warnBool(
      `Clipping color region to the design face failed${label ? ` for ${label}` : ''}. Region left unclipped, may extend past the face edge.`,
    );
  return r;
}

/**
 * `safeIntersectChecked` without its warning, for a caller whose clip is not to the design face
 * and whose failure it names itself. The fallback is the same: the subject back, unclipped. An
 * input with nothing in it is a clean empty result, not a failure: there was nothing to clip.
 */
export function intersectChecked(
  a: PolyFeature | null,
  b: PolyFeature | null,
): { feat: PolyFeature | null; clipped: boolean } {
  a = cleanFeature(a);
  b = cleanFeature(b);
  if (!a || !b) return { feat: null, clipped: true };
  const r = boolOpUnderCap('intersect', a, b);
  return r.ok ? { feat: r.val ?? null, clipped: true } : { feat: a, clipped: false };
}

const INTERSECT = (x: PolyFeature, y: PolyFeature): PolyFeature | null =>
  turf.intersect(x, y) as PolyFeature | null;

/**
 * The overlap of two features, or null for "no overlap" AND "the boolean flaked". For a DIAGNOSTIC
 * intersect that only picks which message a build owes: `safeIntersect` returns UNCLIPPED (an
 * overlap for every input), and `safeIntersectChecked` warns about exported geometry it never
 * shaped. A silent flake is the safe direction: the caller keeps its older message.
 */
export function intersectQuiet(a: PolyFeature | null, b: PolyFeature | null): PolyFeature | null {
  a = cleanFeature(a);
  b = cleanFeature(b);
  if (!a || !b) return null;
  const r = boolOpUnderCap('intersect', a, b);
  return r.ok ? (r.val ?? null) : null;
}

/** How long a boolean pass runs before yielding a frame to the browser. */
export const YIELD_BUDGET_MS = 30;

/** A macrotask yield (setTimeout, not a microtask): on the page it lets the curtain repaint, in the
 * build worker it lets a cancel message in. Promise.resolve() would do neither. */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

/**
 * Union a list of features by balanced pairwise merging (pairs, then pairs of pairs), yielding on
 * a time budget and reporting progress. A left fold re-processes the ever-growing accumulator
 * every step; the tree does the same math in O(log n) levels and benchmarks 2-4x faster on dense
 * designs. safeUnion's fallback semantics are preserved per merge, `refuseTooBig` included.
 */
export async function unionAllCooperative(
  features: (PolyFeature | null)[],
  onProgress?: (fraction: number) => void,
  label?: string,
  refuseTooBig = false,
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
      const u = safeUnion(level[i], level[i + 1], label, refuseTooBig);
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
 * Shapes subtracted individually before the accumulator folds. Both ends lose: batch 1 is the old
 * pairwise cadence; never folding collapses on dense designs, every difference carrying every shape
 * above it (400 shapes: 13552ms vs 1257ms pairwise and 704ms at 8 — **11x the loop it replaced and
 * 19x this**). 8 suits the whole curve: over 50/100/200/400 synthetic overlapping shapes it runs
 * 1.9x, 1.8x, 1.9x, 1.8x the pairwise loop, on a flat plateau from 4 through 12; bigger batches win
 * at 50 shapes (3.0x) and lose as above at 400.
 * Bounds shapes per call, not vertices: 800 disjoint blobs never collapse and one fold took 281ms
 * ("Many disjoint shapes", docs/tech-debt.md).
 */
const COVERED_BATCH = 8;

/** Memo for the pass below, keyed on the parsed shapes' identity. */
let regionsCacheKey: SVGShape[] | null = null;
let regionsCacheVal: { byColor: Record<string, PolyFeature> } | null = null;
let regionsCacheDiagnostics: string[] = [];

/**
 * Per color, the net *visible* region under paint order: f minus the union of everything above it.
 * A per-shape diff with a bbox pre-filter is identical but ~2x SLOWER on real artwork (backgrounds
 * and lineart overlap everything), so the accumulator stays. It folds in batches, deliberately
 * stale: each difference subtracts it *and* the unfolded shapes above in one call, the same set.
 * With one union per color at the end: 1.5-2.9x the pairwise fold, areas identical
 * (scripts/bench-regions.ts). The dominant rebuild cost, so it yields every ~YIELD_BUDGET_MS.
 *
 * Unbuilt on purpose: a `disjoint` fast path. Raster regions are disjoint by construction, so every
 * safeDiff here is a no-op; it would enable per-component raster granularity and cut the per-color
 * path's 136ms, but at its 8 shades the time is elsewhere. It pays on SVGs of many disjoint shapes:
 * "Many disjoint shapes" in docs/tech-debt.md.
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
    // Cached regions may be degraded and nothing re-runs on a hit, so replay the pass's warnings:
    // they are build-scoped and this rebuild cleared them.
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
          // No label: a batch spans several colors, so naming one points at an arbitrary member.
          covered = safeUnionAll(covered ? [covered, ...pending] : pending);
          pending = [];
        }
      }
      // This loop owns the first 90% and the merge the rest, or the bar sits full while still busy.
      onProgress(0.9 * ((total - i) / total));
      if (performance.now() - lastYield > YIELD_BUDGET_MS) {
        // Safe here: pure 2D work holding no Manifold solids (src/cancel.ts). And it is where heavy
        // designs spend their time: a 6000-region wheel sat at 11% for the whole 140.4s the
        // 2026-08-24 cycle measured.
        throwIfCancelled();
        await yieldToBrowser();
        lastYield = performance.now();
      }
    }
    // One sweep per color, unchunked: pieces are interior-disjoint, so chunking only dissolves
    // shared edges and the last sweep still carries nearly every vertex. On 800 pieces, chunks of
    // 25-400 took the longest call from 345ms to 248-322ms at 1.3-1.9x the total; at 400, 186ms to
    // 146-194ms at 1.05-1.7x (`bench-regions.ts chunks dots:800 dots:400`), with no plateau.
    // Pairwise (unionAllCooperative) cost dino ring 123ms -> 158ms in #218. A raster trace arrives
    // with one piece per color (parseRasterImage).
    const byColor: Record<string, PolyFeature> = {};
    const colors = Object.entries(pieces);
    for (let c = 0; c < colors.length; c++) {
      const [color, list] = colors[c];
      const merged =
        list.length === 1 ? list[0] : await safeUnionAllCooperative(list, `color ${color}`);
      if (merged) byColor[color] = merged;
      onProgress(0.9 + (0.1 * (c + 1)) / colors.length);
      if (performance.now() - lastYield > YIELD_BUDGET_MS) {
        // Same safety as the visibility loop above. Without it a cancel landing here waited out
        // every remaining color's sweep.
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
 * Auto-merge slider stops (index = slider value, 0 off): CIE76 ΔE cutoffs measured on stubs/.
 * Slight dedupes export/anti-aliasing near-duplicates (pappa.svg's reds at ΔE 0.4) without touching
 * real differences (snoopy.svg's closest pair, ΔE 91.7). Medium starts banding shading ramps;
 * Strong collapses toward hue families.
 *
 * Known gap: the audience asks a slot-count question ("make this fit my 4-slot AMS Lite",
 * docs/audience.md). On two volunteer SVGs None/Slight/Medium/Strong gave 7/7/7/6 slots (7-color
 * chair) and 8/7/7/7 (7-color wheel). A "fit N slots" input binary-searching a threshold needs a
 * wider artwork sample to tune against.
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
