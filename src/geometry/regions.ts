import * as turf from '@turf/turf';
import type { Loop, PolyFeature, ResolvedRegion, SVGShape } from '../types';
import { signedArea } from '../svg/path';
import { blendHexes } from '../color';
import { warn } from '../warnings';
import { reportProgress } from '../progress';

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
 * Hole-vs-solid is resolved by geometric nesting depth (containment), not winding-direction
 * sign. SVG supports two fill rules: "nonzero" (authoring tools conventionally wind holes
 * opposite their exterior) and "evenodd" (a hole can legally share its exterior's winding —
 * common from Affinity Designer/Illustrator). Containment depth (odd nesting depth = hole,
 * even = solid island) gives the correct answer for both fill rules on any well-formed path.
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

  // immediate parent = smallest-area ring that contains this ring (excluding itself)
  const parent = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let bestArea = Infinity,
      bestIdx = -1;
    const testPt = rings[i].raw[0];
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
  for (let i = 0; i < n; i++) getDepth(i);

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
  for (let i = 0; i < n; i++) if (depth[i] === 0) emitPoly(i);
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
 * Turf 6.5's bundled polygon-clipping recurses without bound when two inputs share edges whose
 * coordinates differ only at ~1e-14 (exactly what circle arcs vs. star-boundary regions
 * produce). Quantizing collapses those phantom distinctions, so on failure retry at decreasing
 * precision — 1e-10 mm is far below anything a printer can express, so retries are
 * geometrically free.
 */
function boolOpWithRetry(
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
  warn(
    `Boolean union failed${label ? ` for ${label}` : ''} (likely a self-intersecting path in the source SVG) — using the unmerged shape as a fallback, so this region may be missing part of its area.`,
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
  warn(
    `Boolean subtraction failed${label ? ` for ${label}` : ''} (likely a self-intersecting path in the source SVG) — that region may overlap its neighbor instead of having the overlap cut out.`,
  );
  return a;
}

export function safeIntersect(
  a: PolyFeature | null,
  b: PolyFeature | null,
  label?: string,
): PolyFeature | null {
  if (!a || !b) return null;
  try {
    return turf.intersect(a, b) as PolyFeature | null;
  } catch {
    warn(
      `Clipping color region to the part face failed${label ? ` for ${label}` : ''} — region left unclipped, may extend past the face edge.`,
    );
    return a;
  }
}

/** How long a boolean pass runs before yielding a frame to the browser. */
export const YIELD_BUDGET_MS = 30;

/** A macrotask yield (setTimeout, not a microtask) so the browser can repaint the progress
 * curtain between chunks — microtasks/Promise.resolve() would not unblock rendering. */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

/**
 * Union a list of features via balanced pairwise merging (pairs, then pairs of pairs), yielding
 * to the browser on a time budget and reporting progress. A left-fold accumulation re-processes
 * the ever-growing accumulator on every step; the tree does the same math in O(log n) levels and
 * benchmarks 2–4x faster on dense designs. safeUnion's fallback semantics are preserved per merge.
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
 * Compute, per color, the net *visible* region accounting for paint order
 * (later elements occlude earlier ones).
 *
 * Visibility is f minus the accumulated union of everything painted above it. Subtracting each
 * later element individually (with a bbox pre-filter) is algebraically identical and looked
 * attractive, but benchmarked ~2x SLOWER on real artwork — full-canvas backgrounds and lineart
 * overlap everything, so the filter rarely prunes and the pairwise diffs multiply. The
 * accumulator stays.
 *
 * This is the dominant cost of a rebuild (all the polygon booleans), so it runs cooperatively:
 * after every ~YIELD_BUDGET_MS of work it yields a frame and reports progress, keeping the tab
 * responsive and the "Rebuilding…" curtain live instead of freezing the main thread on a dense
 * SVG. See src/progress.ts and the scheduler.
 */
export async function computeNetRegionsByColor(
  shapes: SVGShape[],
  onProgress: (fraction: number) => void = reportProgress,
): Promise<{
  byColor: Record<string, PolyFeature>;
}> {
  const features = shapes.map(shapeToFeature).map((f, idx) => ({ f, color: shapes[idx].fill }));
  const byColor: Record<string, PolyFeature> = {};
  let covered: PolyFeature | null = null;
  const total = features.length || 1;
  let lastYield = performance.now();
  for (let i = features.length - 1; i >= 0; i--) {
    const { f, color } = features[i];
    if (f) {
      const visible = covered ? safeDiff(f, covered, `color ${color}`) : f;
      if (visible) {
        byColor[color] = byColor[color]
          ? (safeUnion(byColor[color], visible, `color ${color}`) as PolyFeature)
          : visible;
      }
      covered = covered ? safeUnion(covered, f, `an element under color ${color}`) : f;
    }
    onProgress((total - i) / total);
    if (performance.now() - lastYield > YIELD_BUDGET_MS) {
      await yieldToBrowser();
      lastYield = performance.now();
    }
  }
  return { byColor };
}

/**
 * Resolve raw per-color regions into the final list of "regions to cut", collapsing any
 * user-defined merge groups (2+ raw colors sharing one recess/one filament) into a single
 * region each. Everything downstream (depth, geometry, export) treats a merged group exactly
 * like a normal color, keyed by a stable group id instead of a hex.
 */
export function applyColorMerges(
  byColor: Record<string, PolyFeature>,
  mergeGroups: string[][],
): ResolvedRegion[] {
  const used = new Set<string>();
  const out: ResolvedRegion[] = [];
  (mergeGroups || []).forEach((group) => {
    const members = group.filter((h) => byColor[h]);
    if (members.length < 2) return;
    let feat: PolyFeature | null = null;
    members.forEach((h) => {
      feat = feat ? safeUnion(feat, byColor[h]) : byColor[h];
      used.add(h);
    });
    if (!feat) return;
    const key = 'merge:' + members.slice().sort().join(',');
    out.push({ key, members, feature: feat, isMerge: true, previewColor: blendHexes(members) });
  });
  Object.keys(byColor).forEach((h) => {
    if (used.has(h)) return;
    out.push({ key: h, members: [h], feature: byColor[h], isMerge: false, previewColor: h });
  });
  return out;
}
