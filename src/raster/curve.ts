import type { Pt } from '../types';

/**
 * Sub-pixel curve fitting for one boundary chain, after Selinger's Potrace algorithm ("Potrace: a
 * polygon-based tracing algorithm"). Written from the published description — potrace itself is
 * GPL and this repo is MIT, so nothing here is ported from its source.
 *
 * The point of the module: a traced boundary walked on the pixel lattice can only turn in whole
 * pixels, which ships a staircase on every diagonal — 0.54mm across the wheel at the 512px the
 * pipeline used to work at, printable rather than merely visible. Fitting a curve through those
 * same pixels recovers sub-pixel accuracy without spending resolution on it, which is also what
 * made the working size affordable to raise for flat art afterwards (see decode.ts).
 */
export interface CurveParams {
  /** Corner threshold. A fitted vertex at or above this stays a hard corner; below it curves. */
  alphaMax: number;
  /** Max deviation in pixels when flattening a fitted curve to line segments. */
  flatness: number;
}

/**
 * How far a vertex may move off its lattice position, in pixels.
 *
 * 0.5 is a correctness bound, not a taste one. A boundary between two regions is one pixel wide at
 * its thinnest, so letting a vertex travel further than half a pixel could push it through a
 * neighbouring feature and invert a thin ring. The fit never needs more: the worst case is a 45°
 * staircase, whose lattice corners sit 1/(2√2) ≈ 0.354px off the line through them.
 */
const MAX_VERTEX_SHIFT = 0.5;

/**
 * Ceiling on how many points one straight run may cover.
 *
 * Purely a cost guard — straightness is checked incrementally in O(1), but the penalty DP below is
 * O(n · run), so an unbounded run makes a long straight edge quadratic. Breaking a run early only
 * plants an extra vertex mid-line, which the smoothing pass then reads as collinear and rounds
 * away, so it costs nothing visually.
 */
const MAX_RUN = 400;

/** Potrace's ceiling on alpha: at 4/3 every vertex reads as smooth and no corner survives. */
const ALPHA_CEILING = 4 / 3;

/** Below this the corner would be pinched hard enough to double back; Potrace clamps the same way. */
const ALPHA_FLOOR = 0.55;

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

/**
 * Fit one chain of lattice points to a sub-pixel polyline.
 *
 * `closed` chains are island boundaries with no junction on them and are fitted cyclically.
 * Open chains run between junctions shared with other chains, so **both endpoints are returned
 * exactly as given** — that is what lets two regions splice the same fitted points and still tile
 * exactly. Output runs in the same direction as the input and never repeats a point.
 */
export function fitChain(points: Pt[], closed: boolean, params: CurveParams): Pt[] {
  const n = points.length;
  if (n < 4) return points.map((p) => ({ x: p.x, y: p.y }));

  const sums = prefixSums(points, closed);
  const reach = straightReach(points, closed);
  const cuts = bestPolygon(points, closed, reach, sums);
  // Two cuts is a straight run end to end — the right answer for a diagonal, not a failed fit.
  // Only an empty result (no path through the DP) falls back to the lattice points.
  if (cuts.length < 2) return points.map((p) => ({ x: p.x, y: p.y }));

  const vertices = adjustVertices(points, closed, cuts, sums);
  const fitted = decimate(
    dropCollinear(dedupe(smooth(vertices, closed, params), closed), closed),
    closed,
    params.flatness,
  );

  // Features thinner than the straightness test's own slack cannot be fitted. The cone carries a
  // half-pixel of widening at each bound, so every point of a one-pixel-thick shape stays inside it
  // and the whole boundary — down one side, around the end, back the other — reads as a single
  // straight run. The polygon that falls out of that is a sliver, not the shape.
  //
  // Falling back to the lattice costs nothing here: a feature one pixel across has no staircase to
  // remove, so the thing the fit exists to fix isn't present. Guarded on area because that is what
  // the failure destroys, and only for closed chains, where the ring's own area is meaningful.
  if (closed && !keepsItsArea(points, fitted)) return points.map((p) => ({ x: p.x, y: p.y }));
  return fitted;
}

/**
 * Ratio below which a fitted ring is treated as a failed fit rather than a rounded one.
 *
 * Doubles as the contract for the whole module: fitting never costs a closed feature more than
 * 15% of its area, and where it would, the pixels are kept instead. Rounding a corner off a shape
 * a few pixels across is what crosses this line, and that is the right trade — a feature that
 * small is at or under the nozzle width, so there is nothing to gain by smoothing it and real
 * fidelity to lose.
 */
const MIN_AREA_RATIO = 0.85;

function keepsItsArea(lattice: Pt[], fitted: Pt[]): boolean {
  const before = Math.abs(ringArea(lattice));
  if (before === 0) return true;
  return Math.abs(ringArea(fitted)) / before >= MIN_AREA_RATIO;
}

function ringArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Moment prefix sums, so the DP can score a candidate segment in O(1) instead of walking it.
 * A closed chain is scored over a doubled index range, which is why these run to 2n there.
 */
interface Sums {
  n: number;
  x: Float64Array;
  y: Float64Array;
  xx: Float64Array;
  yy: Float64Array;
  xy: Float64Array;
  at: (i: number) => Pt;
}

function prefixSums(points: Pt[], closed: boolean): Sums {
  const n = points.length;
  const len = closed ? 2 * n : n;
  const at = closed ? (i: number) => points[i % n] : (i: number) => points[i];
  const x = new Float64Array(len + 1);
  const y = new Float64Array(len + 1);
  const xx = new Float64Array(len + 1);
  const yy = new Float64Array(len + 1);
  const xy = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) {
    const p = at(i);
    x[i + 1] = x[i] + p.x;
    y[i + 1] = y[i] + p.y;
    xx[i + 1] = xx[i] + p.x * p.x;
    yy[i + 1] = yy[i] + p.y * p.y;
    xy[i + 1] = xy[i] + p.x * p.y;
  }
  return { n, x, y, xx, yy, xy, at };
}

/** Sum of squared perpendicular distances from points[a..b] to the line through their endpoints. */
function segmentPenalty(s: Sums, a: number, b: number): number {
  const count = b - a + 1;
  if (count < 3) return 0;
  const p0 = s.at(a);
  const p1 = s.at(b);
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const norm = dx * dx + dy * dy;
  if (norm === 0) return 0;

  const sx = s.x[b + 1] - s.x[a];
  const sy = s.y[b + 1] - s.y[a];
  const sxx = s.xx[b + 1] - s.xx[a];
  const syy = s.yy[b + 1] - s.yy[a];
  const sxy = s.xy[b + 1] - s.xy[a];

  // Σ((x-x0)dy - (y-y0)dx)² expanded over the moments, divided by |d|².
  const cxx = sxx - 2 * p0.x * sx + count * p0.x * p0.x;
  const cyy = syy - 2 * p0.y * sy + count * p0.y * p0.y;
  const cxy = sxy - p0.x * sy - p0.y * sx + count * p0.x * p0.y;
  return Math.max(0, (dy * dy * cxx - 2 * dx * dy * cxy + dx * dx * cyy) / norm);
}

/**
 * For each index, the furthest index still reachable by a straight run.
 *
 * Straightness is Potrace's, and the reason it is not a chord-distance test is the 45° staircase:
 * its lattice corners sit 1/√2 ≈ 0.707px off their own chord, so any half-pixel corridor would
 * refuse to straighten a diagonal and every diagonal would keep every step. The test used instead
 * is directional — a run stops once all four step directions have occurred, or once the cone of
 * directions still consistent with a straight line closes.
 *
 * Known gap, deliberately left here rather than tightened: the cone cannot see a feature thinner
 * than its own slack. Each bound is widened half a pixel toward the corner of the pixel the offset
 * lands in, so the entire boundary of a one-pixel-thick region stays inside it and reads as one
 * straight run. Rejecting any run that reverses along an axis does catch it — a genuinely straight
 * run never uses a direction and its opposite — but measured, that shortens runs everywhere and
 * costs 34% more output points on photographic sources, for a case `unfitCollapsedChains`
 * (trace.ts) already catches by area at no cost. The guard there is the load-bearing one.
 */
function straightReach(points: Pt[], closed: boolean): Int32Array {
  const n = points.length;
  const limit = closed ? n : n - 1;
  const reach = new Int32Array(n);
  const at = closed ? (i: number) => points[i % n] : (i: number) => points[i];

  for (let i = 0; i < n; i++) {
    const p0 = at(i);
    const seen = [0, 0, 0, 0];
    let c0x = 0,
      c0y = 0,
      c1x = 0,
      c1y = 0;
    let j = i;
    // An open chain has no wrap to walk into: j+1 must stay a real index.
    const max = closed ? Math.min(i + MAX_RUN, i + limit) : Math.min(i + MAX_RUN, n - 1);

    while (j < max) {
      const prev = at(j);
      const next = at(j + 1);
      const dir = next.x > prev.x ? 0 : next.y > prev.y ? 1 : next.x < prev.x ? 2 : 3;
      seen[dir] = 1;
      if (seen[0] && seen[1] && seen[2] && seen[3]) break;

      const ox = next.x - p0.x;
      const oy = next.y - p0.y;
      if (cross(c0x, c0y, ox, oy) < 0 || cross(c1x, c1y, ox, oy) > 0) break;

      if (Math.abs(ox) > 1 || Math.abs(oy) > 1) {
        // The two bounds are widened toward *opposite* corners of the pixel the offset lands in —
        // they describe the strip the pixel path may occupy, not the lattice point itself. Using one
        // shared corner for both collapses the cone to a single ray on the second step, after which
        // nothing is ever straight and every staircase survives intact.
        const lox = ox + (oy >= 0 && (oy > 0 || ox < 0) ? 1 : -1);
        const loy = oy + (ox <= 0 && (ox < 0 || oy < 0) ? 1 : -1);
        if (cross(c0x, c0y, lox, loy) >= 0) {
          c0x = lox;
          c0y = loy;
        }
        const hix = ox + (oy <= 0 && (oy < 0 || ox < 0) ? 1 : -1);
        const hiy = oy + (ox >= 0 && (ox > 0 || oy < 0) ? 1 : -1);
        if (cross(c1x, c1y, hix, hiy) <= 0) {
          c1x = hix;
          c1y = hiy;
        }
      }
      j++;
    }
    reach[i] = j;
  }

  // A cycle needs at least three vertices to enclose anything. Without this a long thin shape —
  // a one-pixel bar, say — can read as two straight runs end to end, and the "polygon" the DP
  // returns is a line segment with zero area, which deletes the feature from the export.
  if (closed) {
    const cap = Math.max(1, Math.floor(n / 3));
    for (let i = 0; i < n; i++) reach[i] = Math.min(reach[i], i + cap);
  }
  return reach;
}

/**
 * Minimum-vertex polygon over the straight runs, tie-broken by total squared deviation.
 *
 * Fewest segments alone leaves a polygon that is technically minimal and visibly wrong — it will
 * happily pick the run that reaches furthest even when a slightly shorter one hugs the pixels far
 * better — so the penalty decides between equal-length solutions.
 *
 * A closed chain is cut as if it were open from index 0, then closed. That plants one vertex at an
 * arbitrary point on a smooth island, but the smoothing pass reads it as collinear and rounds it
 * away, so it does not show; the alternative is a cyclic DP for a vertex the fit discards anyway.
 */
function bestPolygon(points: Pt[], closed: boolean, reach: Int32Array, sums: Sums): number[] {
  const n = points.length;
  const end = closed ? n : n - 1;
  // Sentinel has to fit in an Int32: Number.MAX_SAFE_INTEGER truncates to -1 here, which silently
  // makes every "fewer hops?" test false and leaves the DP with no path at all.
  const hops = new Int32Array(end + 1).fill(0x7fffffff);
  const cost = new Float64Array(end + 1).fill(Infinity);
  const from = new Int32Array(end + 1).fill(-1);
  hops[0] = 0;
  cost[0] = 0;

  for (let i = 0; i < end; i++) {
    if (from[i] < 0 && i !== 0) continue;
    const far = Math.min(reach[i % n], end);
    for (let j = i + 1; j <= far; j++) {
      const h = hops[i] + 1;
      const c = cost[i] + segmentPenalty(sums, i, j);
      if (h < hops[j] || (h === hops[j] && c < cost[j])) {
        hops[j] = h;
        cost[j] = c;
        from[j] = i;
      }
    }
  }

  if (from[end] < 0) return [];
  const cuts: number[] = [];
  for (let i = end; i > 0; i = from[i]) cuts.push(i);
  cuts.push(0);
  cuts.reverse();
  return cuts;
}

/**
 * Move each polygon vertex to the point that best satisfies the two pixel runs meeting there.
 *
 * This is the stage that actually removes the staircase: the lattice corner is replaced by the
 * least-squares intersection of lines fitted to the runs on either side of it. Open-chain endpoints
 * are skipped — they are junctions shared with other chains and must stay exactly where they are.
 */
function adjustVertices(points: Pt[], closed: boolean, cuts: number[], sums: Sums): Pt[] {
  const segCount = cuts.length - 1;
  const lines: { nx: number; ny: number; cx: number; cy: number }[] = [];
  for (let k = 0; k < segCount; k++) lines.push(fitLine(sums, cuts[k], cuts[k + 1]));

  const out: Pt[] = [];
  for (let k = 0; k < segCount; k++) {
    const idx = cuts[k];
    const lattice = sums.at(idx);
    const pinned = !closed && k === 0;
    if (pinned) {
      out.push({ x: lattice.x, y: lattice.y });
      continue;
    }
    const a = lines[(k - 1 + segCount) % segCount];
    const b = lines[k];
    out.push(meet(a, b, lattice));
  }
  if (!closed) {
    const last = sums.at(cuts[segCount]);
    out.push({ x: last.x, y: last.y });
  }
  return out;
}

/** Total-least-squares line through points[a..b], as a unit normal plus a point on it. */
function fitLine(
  s: Sums,
  a: number,
  b: number,
): { nx: number; ny: number; cx: number; cy: number } {
  const count = b - a + 1;
  const sx = s.x[b + 1] - s.x[a];
  const sy = s.y[b + 1] - s.y[a];
  const cx = sx / count;
  const cy = sy / count;
  const sxx = (s.xx[b + 1] - s.xx[a]) / count - cx * cx;
  const syy = (s.yy[b + 1] - s.yy[a]) / count - cy * cy;
  const sxy = (s.xy[b + 1] - s.xy[a]) / count - cx * cy;

  // Normal is the eigenvector of the smaller eigenvalue of the scatter matrix.
  const t = (sxx + syy) / 2;
  const d = Math.sqrt(Math.max(0, ((sxx - syy) / 2) ** 2 + sxy * sxy));
  const small = t - d;
  let nx = sxy;
  let ny = small - sxx;
  if (Math.abs(nx) + Math.abs(ny) < 1e-12) {
    nx = small - syy;
    ny = sxy;
  }
  const len = Math.hypot(nx, ny);
  if (len < 1e-12) {
    const p0 = s.at(a);
    const p1 = s.at(b);
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dl = Math.hypot(dx, dy) || 1;
    return { nx: -dy / dl, ny: dx / dl, cx, cy };
  }
  return { nx: nx / len, ny: ny / len, cx, cy };
}

type Line = { nx: number; ny: number; cx: number; cy: number };

/** Least-squares meeting point of two fitted lines, clamped near the lattice vertex it replaces. */
function meet(a: Line, b: Line, lattice: Pt): Pt {
  const a00 = a.nx * a.nx + b.nx * b.nx;
  const a01 = a.nx * a.ny + b.nx * b.ny;
  const a11 = a.ny * a.ny + b.ny * b.ny;
  const r0 = a.nx * (a.nx * a.cx + a.ny * a.cy) + b.nx * (b.nx * b.cx + b.ny * b.cy);
  const r1 = a.ny * (a.nx * a.cx + a.ny * a.cy) + b.ny * (b.nx * b.cx + b.ny * b.cy);
  const det = a00 * a11 - a01 * a01;

  let x = lattice.x;
  let y = lattice.y;
  // A near-zero determinant means the two runs are parallel — a vertex on a straight stretch, where
  // there is no intersection to move to and the lattice point is already on the line.
  if (Math.abs(det) > 1e-9) {
    x = (r0 * a11 - r1 * a01) / det;
    y = (a00 * r1 - a01 * r0) / det;
  }
  return {
    x: clamp(x, lattice.x - MAX_VERTEX_SHIFT, lattice.x + MAX_VERTEX_SHIFT),
    y: clamp(y, lattice.y - MAX_VERTEX_SHIFT, lattice.y + MAX_VERTEX_SHIFT),
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Corner detection and curve emission.
 *
 * Each vertex is replaced by the run between its neighbouring segment midpoints: a sharp vertex
 * (alpha at or above alphaMax) keeps the corner, a shallow one becomes a cubic through it. Open
 * chains additionally emit the two half-segments at their pinned ends, so the output still starts
 * and finishes exactly on the junction points.
 */
function smooth(v: Pt[], closed: boolean, params: CurveParams): Pt[] {
  const m = v.length;
  if (m < 3) return v;

  /**
   * Where a vertex's curve starts and ends on each adjacent segment.
   *
   * Textbook Potrace uses the segment midpoints, which is fine when the two segments are of similar
   * length and destructive when they are not: at the corner of a 30x1 bar the "midpoint" of the long
   * edge is fifteen pixels away, so the curve rounds off half the bar and better than half its area
   * goes with it. Backing both shoulders off by half the *shorter* neighbour keeps the symmetric
   * case identical to Potrace while bounding what a lopsided corner can eat.
   */
  const shoulder = (cur: Pt, toward: Pt, d: number): Pt => {
    const dx = toward.x - cur.x;
    const dy = toward.y - cur.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) return { x: cur.x, y: cur.y };
    const t = Math.min(d, len / 2) / len;
    return { x: cur.x + dx * t, y: cur.y + dy * t };
  };
  const out: Pt[] = [];

  const first = closed ? 0 : 1;
  const last = closed ? m - 1 : m - 2;
  if (!closed) out.push(v[0]);

  for (let k = first; k <= last; k++) {
    const prev = v[(k - 1 + m) % m];
    const cur = v[k];
    const next = v[(k + 1) % m];
    const reach =
      Math.min(
        Math.hypot(cur.x - prev.x, cur.y - prev.y),
        Math.hypot(next.x - cur.x, next.y - cur.y),
      ) / 2;
    const m0 = shoulder(cur, prev, reach);
    const m1 = shoulder(cur, next, reach);

    const denom = ddenom(prev, next);
    let alpha = ALPHA_CEILING;
    if (denom !== 0) {
      const dd = Math.abs(
        cross(cur.x - prev.x, cur.y - prev.y, next.x - cur.x, next.y - cur.y) / denom,
      );
      alpha = dd > 1 ? (1 - 1 / dd) / 0.75 : 0;
    }

    if (alpha >= params.alphaMax) {
      pushPt(out, m0);
      pushPt(out, cur);
      pushPt(out, m1);
      continue;
    }
    const a = clamp(alpha, ALPHA_FLOOR, 1);
    const c1 = { x: m0.x + a * (cur.x - m0.x), y: m0.y + a * (cur.y - m0.y) };
    const c2 = { x: m1.x + a * (cur.x - m1.x), y: m1.y + a * (cur.y - m1.y) };
    pushPt(out, m0);
    flattenCubic(out, m0, c1, c2, m1, params.flatness);
    pushPt(out, m1);
  }

  if (!closed) out.push(v[m - 1]);
  return out;
}

/**
 * Scale for the corner measure: the L1 span between the two neighbours, which makes alpha a shape
 * ratio rather than a size one, so a corner reads the same whether it is three pixels across or
 * thirty. The max-norm looks like a reasonable substitute and is not — it runs ~40% small on a
 * diagonal, inflating alpha enough that every vertex of a coarse polygon reads as a corner and a
 * traced circle comes back as a polygon.
 */
function ddenom(a: Pt, b: Pt): number {
  return Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
}

function pushPt(out: Pt[], p: Pt): void {
  const prev = out[out.length - 1];
  if (prev && Math.abs(prev.x - p.x) < 1e-9 && Math.abs(prev.y - p.y) < 1e-9) return;
  out.push({ x: p.x, y: p.y });
}

/** Adaptive-depth flattening: enough segments that the chord never strays past `flatness`. */
function flattenCubic(out: Pt[], p0: Pt, p1: Pt, p2: Pt, p3: Pt, flatness: number): void {
  const dev =
    Math.hypot(p1.x - (p0.x + p3.x) / 2, p1.y - (p0.y + p3.y) / 2) +
    Math.hypot(p2.x - (p0.x + p3.x) / 2, p2.y - (p0.y + p3.y) / 2);
  const steps = Math.max(1, Math.min(24, Math.ceil(Math.sqrt(dev / Math.max(flatness, 1e-3)) * 2)));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pushPt(out, {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
}

/**
 * Drop points that sit on the straight line between their neighbours.
 *
 * A hard corner is emitted as midpoint-corner-midpoint, and both midpoints lie exactly on the
 * straight edges either side — so a square arrives as eight points describing four corners. They
 * are geometrically harmless but they inflate ring length, which `shapeToFeature` is quadratic in.
 * Open-chain endpoints are never candidates: they are pinned and must survive verbatim.
 */
function dropCollinear(pts: Pt[], closed: boolean): Pt[] {
  const n = pts.length;
  if (n < 3) return pts;
  const keep: Pt[] = [];
  const first = closed ? 0 : 1;
  const last = closed ? n - 1 : n - 2;
  if (!closed) keep.push(pts[0]);
  for (let i = first; i <= last; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const area = Math.abs(cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y));
    const span = Math.hypot(c.x - a.x, c.y - a.y);
    if (span < 1e-9 || area / span > 1e-6) keep.push(b);
  }
  if (!closed) keep.push(pts[n - 1]);
  return keep.length >= (closed ? 3 : 2) ? keep : pts;
}

/**
 * Ramer–Douglas–Peucker over the *fitted* polyline, at the same sub-pixel tolerance the curves were
 * flattened to.
 *
 * This is not the simplification the fit replaced. That one ran on lattice points, where a
 * half-pixel tolerance cannot straighten a 45° staircase and a larger one facets curves — which is
 * the whole reason tracing moved to curve fitting. Here the input is already smooth and already
 * sub-pixel, so dropping points that no reader could distinguish costs nothing and cannot
 * reintroduce a step. It is a point-count control, and it is needed: without it a photographic
 * source produced roughly five times the points of the old tracer, because RDP on the lattice had
 * been quietly discarding the noise in those boundaries rather than following it.
 *
 * Explicit stack, not recursion — a fitted chain can still run to thousands of points, and this
 * repo has scar tissue for that class of overflow (rethrowStackOverflowAs in regions.ts).
 */
function decimate(pts: Pt[], closed: boolean, tol: number): Pt[] {
  const n = pts.length;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [from, to] = stack.pop() as [number, number];
    if (to <= from + 1) continue;
    const ax = pts[from].x;
    const ay = pts[from].y;
    const dx = pts[to].x - ax;
    const dy = pts[to].y - ay;
    const len = Math.hypot(dx, dy);
    let worst = -1;
    let worstD = tol;
    for (let i = from + 1; i < to; i++) {
      const d = len
        ? Math.abs(cross(dx, dy, pts[i].x - ax, pts[i].y - ay)) / len
        : Math.hypot(pts[i].x - ax, pts[i].y - ay);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([from, worst], [worst, to]);
  }

  const out: Pt[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out.length >= (closed ? 3 : 2) ? out : pts;
}

function dedupe(pts: Pt[], closed: boolean): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) pushPt(out, p);
  // Only a cycle may shed a coincident last point. An open chain that starts and ends on the same
  // junction — a boundary that leaves and returns to it — is legitimately shaped that way, and
  // dropping its final point would unpin the end the caller splices against.
  if (closed && out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) out.pop();
  }
  return out;
}
