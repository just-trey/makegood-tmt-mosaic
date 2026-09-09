// How much of every baked `cutRegions` piece lies OFF the chart's own triangles.
//
// Written for docs/findings/2026-09-09-cut-ribbon-offsurface.md, which asks the question
// docs/tech-debt.md left open: are the thin cut-region strips surface a cover hides? They are not
// surface at all. `subRegions` is the chart boundary loop put through `simplifyLoop`, so it wanders
// off the real patch by up to SIMPLIFY_TOL_MM in both directions; `deadRegions` is the dead set
// intersected with the chart's RAW triangle rings, so along a shared edge it follows the patch
// exactly. Subtracting the second from the first cuts the outward half of that slack free as its
// own polygon.
//
// The oracle is the chart's own triangulation out of the shipped sidecar — `chartTris` over `uv`,
// the same arrays the runtime mapper builds `lookup` from. Nothing in the bake ever compared
// `subRegions` against it, so this is not the boolean that produced the pieces asked a second time.
//
// Per PIECE, never per chart or per zone, for the reason measure-cut-width.mjs records.
//
// Usage: npx vite-node scripts/measure-cut-offsurface.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getManifold } from '../src/geometry/manifold';
import { regionNetArea, SIMPLIFY_TOL_MM, MIN_HOLE_AREA_MM2 } from './lib/zonebake.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const z = JSON.parse(readFileSync(path.join(REPO, 'public/stl/chair-body-zones.json'), 'utf8'));
const wasm = await getManifold();

const ringsOf = (r) => [r.outer, ...(r.holes ?? [])];
const triRingsOf = (chart) =>
  chart.chartTris.map((t) => t.map((i) => [chart.uv[2 * i], chart.uv[2 * i + 1]]));

// NonZero over the raw triangle rings, which is how the bake builds the `chartCS` it clips the dead
// set to. Disjoint triangles of either winding read as inside under NonZero, so a mixed-winding
// chart needs no special case; the summed-area check below is what would catch one anyway.
const chartSection = (chart) => new wasm.CrossSection(triRingsOf(chart), 'NonZero');

/**
 * The chart's outer silhouette, its own holes filled in. Off-surface area INSIDE this is a hole the
 * triangulation has and `subRegions` does not — the bake drops interior loops under
 * MIN_HOLE_AREA_MM2 or MIN_HOLE_WIDTH_MM and says so in its log. Outside it is edge slack, which
 * Douglas-Peucker bounds at the simplify tolerance. The two have different causes and different
 * depths, so a single off-surface number would average a 0.19mm ribbon against a 2mm filled slot.
 */
const filledSection = (chartCS) => {
  const outers = chartCS
    .toPolygons()
    .map((ring) => ring.map(([x, y]) => [x, y]))
    .filter((pts) => {
      let a = 0;
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        a += x1 * y2 - x2 * y1;
      }
      return a > 0;
    });
  return new wasm.CrossSection(outers, 'NonZero');
};
// EvenOdd over a piece's own rings: an outer with holes inside it is exactly what EvenOdd is for.
const pieceSection = (piece) => new wasm.CrossSection(ringsOf(piece), 'EvenOdd');

/** Area left after `offset(-w/2)` then `offset(+w/2)` — the pair measure-cut-width.mjs sweeps. */
const criticalWidth = (piece) => {
  const cs = pieceSection(piece);
  const gone = (w) => {
    const e = cs.offset(-w / 2, 'Miter', 2, 16);
    try {
      return e.isEmpty();
    } finally {
      e.delete();
    }
  };
  try {
    let lo = 0;
    let hi = 0.05;
    while (!gone(hi) && hi < 4096) hi *= 2;
    if (hi >= 4096) return Infinity;
    while (hi - lo > 1e-4) {
      const mid = (lo + hi) / 2;
      if (gone(mid)) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  } finally {
    cs.delete();
  }
};

/**
 * How far past the chart's edge the off-surface part of a piece reaches: the smallest dilation of
 * the chart that swallows it. Bisected on emptiness rather than measured point to point, so it is
 * the same kind of answer as criticalWidth and needs no nearest-triangle search to be right about
 * triangles outside the piece's own bbox — the trap that made a first pass read 6.9mm on a piece
 * whose real reach is 0.19mm.
 */
const outsideDepth = (outside, chartCS) => {
  const clear = (d) => {
    const grown = chartCS.offset(d, 'Round', 2, 16);
    try {
      const rem = outside.subtract(grown);
      try {
        return rem.isEmpty();
      } finally {
        rem.delete();
      }
    } finally {
      grown.delete();
    }
  };
  let lo = 0;
  let hi = 0.05;
  while (!clear(hi) && hi < 1024) hi *= 2;
  if (hi >= 1024) return Infinity;
  while (hi - lo > 1e-4) {
    const mid = (lo + hi) / 2;
    if (clear(mid)) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
};

const rows = [];
const checks = [];
for (const zone of z.zones)
  for (const chart of zone.charts) {
    const chartCS = chartSection(chart);
    const filled = filledSection(chartCS);
    // Rings against the union: a chart that self-overlapped, or wound its triangles so NonZero
    // cancelled some, would read a footprint under its summed triangle area. This is what checks
    // the oracle itself, and it is the only check here independent of the boolean.
    const summed = triRingsOf(chart).reduce(
      (s, [a, b, c]) =>
        s + Math.abs(((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2),
      0,
    );
    checks.push({
      chart: `${zone.id}/${chart.libraryPartId}`,
      summed,
      union: chartCS.area(),
      rel: Math.abs(chartCS.area() - summed) / summed,
    });
    (chart.cutRegions ?? []).forEach((piece, i) => {
      const pcs = pieceSection(piece);
      const outside = pcs.subtract(chartCS);
      const offArea = outside.area();
      const offHole = outside.intersect(filled);
      const offEdge = outside.subtract(filled);
      rows.push({
        holeArea: offHole.area(),
        edgeArea: offEdge.area(),
        edgeDepth: offEdge.area() > 0 ? outsideDepth(offEdge, chartCS) : 0,
        holeDepth: offHole.area() > 0 ? outsideDepth(offHole, chartCS) : 0,
        zone: zone.id,
        part: chart.libraryPartId,
        i,
        hasDead: (chart.deadRegions ?? []).length > 0,
        net: regionNetArea(piece),
        width: criticalWidth(piece),
        offArea,
        offFrac: offArea / pcs.area(),
        depth: offArea > 0 ? outsideDepth(outside, chartCS) : 0,
        bbox: (() => {
          const us = piece.outer.map((q) => q[0]);
          const vs = piece.outer.map((q) => q[1]);
          return [Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs)].sort(
            (x, y) => x - y,
          );
        })(),
      });
      offHole.delete();
      offEdge.delete();
      outside.delete();
      pcs.delete();
    });
    filled.delete();
    chartCS.delete();
  }

const worst = checks.reduce((a, b) => (a.rel > b.rel ? a : b));
console.log(
  `${rows.length} cutRegions pieces on chair-body, over ${checks.length} charts.\n` +
    `Chart footprint against summed triangle area: worst disagreement ` +
    `${(worst.rel * 100).toFixed(4)}% on ${worst.chart}.\n` +
    `SIMPLIFY_TOL_MM = ${SIMPLIFY_TOL_MM}.\n`,
);

rows.sort((a, b) => b.offFrac - a.offFrac || a.net - b.net);
console.log(
  'Every piece, most off-surface first. "off" is area outside the chart\'s own triangles.',
);
console.log(
  `${'piece'.padEnd(42)} ${'dead?'.padStart(5)} ${'net mm²'.padStart(10)} ${'width'.padStart(8)} ${'off mm²'.padStart(9)} ${'off %'.padStart(7)} ${'bbox mm'.padStart(17)} ${'edge mm²'.padStart(9)} ${'edgeDep'.padStart(7)} ${'hole mm²'.padStart(9)} ${'holeDep'.padStart(7)}`,
);
for (const r of rows)
  console.log(
    `${`${r.zone}/${r.part}#${r.i}`.padEnd(42)} ${(r.hasDead ? 'yes' : 'no').padStart(5)} ` +
      `${r.net.toFixed(3).padStart(10)} ${r.width.toFixed(4).padStart(8)} ` +
      `${r.offArea.toFixed(4).padStart(9)} ${(r.offFrac * 100).toFixed(2).padStart(6)}% ` +
      `${`${r.bbox[0].toFixed(3)} x ${r.bbox[1].toFixed(1)}`.padStart(17)} ` +
      `${r.edgeArea.toFixed(4).padStart(9)} ${r.edgeDepth.toFixed(4).padStart(7)} ` +
      `${r.holeArea.toFixed(4).padStart(9)} ${r.holeDepth.toFixed(4).padStart(7)}`,
  );

/* ------------------------------------------------------- the edge excursions past the tolerance */

// Douglas-Peucker cannot move a boundary further than its tolerance, so an EDGE excursion past
// SIMPLIFY_TOL_MM is not simplification slack and wants naming rather than averaging into the
// column above. Each one printed with the chart's own components beside it, because "the claim
// bridges two components of a chart" was the first guess and these numbers are what retired it.
console.log(
  `\nEdge components reaching more than SIMPLIFY_TOL_MM (${SIMPLIFY_TOL_MM}) past the chart:`,
);
let deepN = 0;
let deepArea = 0;
let deepUnderHoleFloor = 0;
for (const zone of z.zones)
  for (const chart of zone.charts) {
    const chartCS = chartSection(chart);
    const filled = filledSection(chartCS);
    (chart.cutRegions ?? []).forEach((piece, i) => {
      const pcs = pieceSection(piece);
      const off = pcs.subtract(chartCS);
      const edge = off.subtract(filled);
      off.delete();
      for (const comp of edge.decompose()) {
        const d = comp.area() > 1e-9 ? outsideDepth(comp, chartCS) : 0;
        if (d > SIMPLIFY_TOL_MM) {
          deepN++;
          deepArea += comp.area();
          if (comp.area() < MIN_HOLE_AREA_MM2) deepUnderHoleFloor++;
          const pts = comp.toPolygons().flat();
          const us = pts.map((q) => q[0]);
          const vs = pts.map((q) => q[1]);
          console.log(
            `  ${`${zone.id}/${chart.libraryPartId}#${i}`.padEnd(40)} ` +
              `${comp.area().toFixed(4).padStart(9)}mm² deep ${d.toFixed(4)} ` +
              `at u ${Math.min(...us).toFixed(1)}..${Math.max(...us).toFixed(1)} ` +
              `v ${Math.min(...vs).toFixed(1)}..${Math.max(...vs).toFixed(1)}`,
          );
          const comps = chartCS.decompose();
          console.log(
            `    that chart is ${comps.length} component(s): ` +
              comps.map((c) => `${c.area().toFixed(2)}mm²`).join(', '),
          );
          for (const c of comps) c.delete();
        }
        comp.delete();
      }
      edge.delete();
      pcs.delete();
    });
    filled.delete();
    chartCS.delete();
  }
console.log(
  `  ${deepN} such component(s), ${deepArea.toFixed(3)}mm² in all; ${deepUnderHoleFloor} of them ` +
    `under MIN_HOLE_AREA_MM2 (${MIN_HOLE_AREA_MM2}). A component under that floor and touching ` +
    `the outer boundary is a dropped hole in cause and an edge in position, which is the case the ` +
    `split above cannot separate. One at or over the floor would not be, and would want its own look.`,
);

/* ------------------------------------------------- the cross-check that is not the boolean */

// The off-surface fraction, asked again without the boolean engine: sample points inside the piece
// and test each against the raw triangles. It shares nothing with the CrossSection path but the
// rings both are entitled to trust, so a wrong fill rule or a bad subtract shows up as the two
// disagreeing. Only on the pieces the conclusion rests on — the sampler is O(points x triangles)
// and the big regions do not need it.
const SAMPLES = 2000;
let seed = 7;
// mulberry32, not an LCG. `seed * 1103515245` exceeds 2^53 and loses its low bits in a double, so
// that generator repeats after 5,233 pairs — on `left/chair-wing-left#7`, whose bbox the rejection
// sampler accepts rarely, 2000 nominal draws were 332 distinct points. Every operation here is
// Math.imul or a shift, so the state stays exactly 32 bits.
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const insideRing = (p, ring) => {
  let c = false;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    if (y1 > p[1] !== y2 > p[1] && p[0] < x1 + ((p[1] - y1) * (x2 - x1)) / (y2 - y1)) c = !c;
  }
  return c;
};
const inTri = (p, [a, b, c]) => {
  const s = (q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = s(a, b);
  const d2 = s(b, c);
  const d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

console.log('\nSampled against the raw triangles, no boolean engine, on the pieces that carry the');
console.log('conclusion. "boolean" is the off % from the table above.');
console.log(
  `${'piece'.padEnd(42)} ${'sampled'.padStart(8)} ${'boolean'.padStart(8)} ${'delta'.padStart(7)}`,
);
let worstDelta = 0;
let minSamples = Infinity;
for (const r of rows.filter((q) => q.offFrac >= 0.5)) {
  const chart = z.zones.find((q) => q.id === r.zone).charts.find((c) => c.libraryPartId === r.part);
  const piece = chart.cutRegions[r.i];
  const rings = triRingsOf(chart);
  const us = piece.outer.map((q) => q[0]);
  const vs = piece.outer.map((q) => q[1]);
  const [x0, x1] = [Math.min(...us), Math.max(...us)];
  const [y0, y1] = [Math.min(...vs), Math.max(...vs)];
  // Triangles whose bbox meets the piece's. Enough for an INSIDE test, which is all this asks —
  // the nearest-triangle DISTANCE is the thing that needs every triangle, and that is what
  // outsideDepth does through the engine instead.
  const cand = rings.filter((t) => {
    const tx = t.map((q) => q[0]);
    const ty = t.map((q) => q[1]);
    return !(
      Math.max(...tx) < x0 ||
      Math.min(...tx) > x1 ||
      Math.max(...ty) < y0 ||
      Math.min(...ty) > y1
    );
  });
  let n = 0;
  let off = 0;
  for (let guard = 0; n < SAMPLES && guard < 4_000_000; guard++) {
    const p = [x0 + rnd() * (x1 - x0), y0 + rnd() * (y1 - y0)];
    if (!insideRing(p, piece.outer)) continue;
    if ((piece.holes ?? []).some((h) => insideRing(p, h))) continue;
    n++;
    if (!cand.some((t) => inTri(p, t))) off++;
  }
  if (!n) throw new Error(`${r.zone}/${r.part}#${r.i}: the sampler accepted no point at all`);
  minSamples = Math.min(minSamples, n);
  const sampled = off / n;
  worstDelta = Math.max(worstDelta, Math.abs(sampled - r.offFrac));
  console.log(
    `${`${r.zone}/${r.part}#${r.i}`.padEnd(42)} ${(sampled * 100).toFixed(2).padStart(7)}% ` +
      `${(r.offFrac * 100).toFixed(2).padStart(7)}% ${((sampled - r.offFrac) * 100).toFixed(2).padStart(6)}%`,
  );
}
console.log(
  `Worst disagreement between the two derivations: ${(worstDelta * 100).toFixed(2)} percentage points, ` +
    `at ${minSamples} accepted samples on the thinnest piece (${SAMPLES} asked for). The rejection ` +
    `sampler gives up after 4,000,000 draws, so a piece far thinner than these would report fewer ` +
    `and say so here rather than quietly resolve worse.`,
);

const mostly = rows.filter((r) => r.offFrac >= 0.5);
const band = rows.filter((r) => r.offArea > 0);
// `Math.max()` of nothing is -Infinity, and a sidecar with no off-surface area at all is exactly
// what the proposed bake fix plus a re-bake should produce — so the run that confirms the fix is
// the run this would have printed nonsense on.
const deepest = (rs, k) =>
  rs.length ? `${Math.max(...rs.map((r) => r[k])).toFixed(4)}mm` : 'nothing off-surface at all';
console.log('\nHow far off-surface the population goes:');
for (const cut of [0.5, 0.9, 0.99, 1]) {
  const set = rows.filter((r) => r.offFrac >= cut - 1e-9);
  console.log(
    `  at least ${(cut * 100).toFixed(0)}% off: ${String(set.length).padStart(2)} pieces, ` +
      `${set.reduce((s, r) => s + r.net, 0).toFixed(3)}mm² between them`,
  );
}
console.log(
  `\nPieces at least half off-surface: ${mostly.length} of ${rows.length}, ` +
    `${mostly.reduce((s, r) => s + r.net, 0).toFixed(3)}mm² between them.\n` +
    `All of them are on a chart that carries a dead region: ` +
    `${mostly.every((r) => r.hasDead)}.\n` +
    `Deepest EDGE reach, over every piece with off-surface edge area: ` +
    `${deepest(band, 'edgeDepth')} against SIMPLIFY_TOL_MM ` +
    `${SIMPLIFY_TOL_MM}. Deepest HOLE reach: ` +
    `${deepest(band, 'holeDepth')} — a loop the triangulation has and ` +
    `subRegions does not, dropped under MIN_HOLE_AREA_MM2 or MIN_HOLE_WIDTH_MM and logged by the ` +
    `bake, so bounded by a dropped hole's inradius rather than by the simplify tolerance.`,
);

// The control. A chart with no dead region ships `subRegions` as its cut region verbatim, so it
// carries the SAME simplification slack — the difference is only that nothing cut the slack free
// into its own polygon. If the off-surface fraction separated the two populations by anything but
// that, the mechanism above would be the wrong story.
const withDead = rows.filter((r) => r.hasDead);
const noDead = rows.filter((r) => !r.hasDead);
const stat = (rs) => ({
  n: rs.length,
  off: rs.reduce((s, r) => s + r.offArea, 0),
  net: rs.reduce((s, r) => s + r.net, 0),
});
const a = stat(withDead);
const b = stat(noDead);
console.log(
  `\nCharts WITH a dead region: ${a.n} pieces, ${a.off.toFixed(2)}mm² off-surface of ` +
    `${a.net.toFixed(0)}mm².\n` +
    `Charts WITHOUT one:        ${b.n} pieces, ${b.off.toFixed(2)}mm² off-surface of ` +
    `${b.net.toFixed(0)}mm² — one piece each, and the slack stays attached to it.`,
);
