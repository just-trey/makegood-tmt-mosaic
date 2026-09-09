// How WIDE every baked `cutRegions` piece on the chair actually is, by morphological opening
// against the real boolean engine, swept over candidate guard widths.
//
// Written for docs/findings/2026-09-08-cut-region-width.md, which asks whether a min-width test at
// the bake can separate hairline dust from real design surface. `CLIP_REMNANT_FLOOR_MM2` is an
// AREA floor and a long enough hairline clears it: the one #296 removed was 0.020 x 8.08mm.
//
// Per PIECE, never per chart or per zone. measure-seam-overlap.mjs records quoting a margin off
// the wrong granularity as a wrong turn that published a figure wrong by 15x.
//
// Usage: npx vite-node scripts/measure-cut-width.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';
import { planarArea } from '../src/geometry/regions';
import { CLIP_REMNANT_FLOOR_MM2 } from '../src/geometry/depth';
import { getManifold } from '../src/geometry/manifold';
import { ASSEMBLY_KINDS } from '../src/assembly/kinds';
import { regionNetArea, MIN_CUT_PIECE_MM2 } from './lib/zonebake.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const z = JSON.parse(readFileSync(path.join(REPO, 'public/stl/chair-body-zones.json'), 'utf8'));
const wasm = await getManifold();

const WIDTHS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8];
const REPORT_W = [0.2, 0.4];

const closed = (r) => [...r, r[0]];
const multi = (rs) =>
  turf.multiPolygon(rs.map((r) => [closed(r.outer), ...(r.holes ?? []).map(closed)]));
const ringsOf = (r) => [r.outer, ...(r.holes ?? [])];
const loopArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
const perimOf = (pts) => {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p;
};
const bboxOfRing = (pts) => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
};
// Bbox centre, used only to match a hole to the same hole after the opening. Not a sample of
// surface, so the centroid-falls-outside-a-sliver trap measure-seam-overlap.mjs records does not
// arise here: nothing in this script reads a value at a point.
const bboxCentre = (pts) => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
};

// EvenOdd over the piece's own rings, matching how `subtractRegions` builds its subject: an
// outer with holes inside it is exactly what EvenOdd is for. NonZero here would read a
// clockwise hole as solid and measure a width the part does not have.
const sectionOf = (rings) => new wasm.CrossSection(rings, 'EvenOdd');

/** Area left after `offset(-w/2)` then `offset(+w/2)` — the exact pair narrowFeatureArea makes. */
const openedArea = (rings, w) => {
  const cs = sectionOf(rings);
  try {
    const eroded = cs.offset(-w / 2, 'Miter', 2, 16);
    try {
      if (eroded.isEmpty()) return 0;
      const opened = eroded.offset(w / 2, 'Miter', 2, 16);
      try {
        return opened.area();
      } finally {
        opened.delete();
      }
    } finally {
      eroded.delete();
    }
  } finally {
    cs.delete();
  }
};

// The width at which the opening first returns nothing, to 1e-4mm. Erosion emptiness IS that
// threshold: an empty erosion has nothing to dilate back from, so it is twice the largest circle
// that fits anywhere in the piece. Bisected rather than read off the sweep so the sweep's
// empty/not-empty answers have a second derivation to agree with. NOT independent of the fill
// rule: both ask the same `offset(-w/2).isEmpty()`, so a wrong rule would satisfy both. What it
// catches is a sweep/bisection disagreement, and `CrossSection.area()` against `regionNetArea` is
// what checks the rings and the rule.
const criticalWidth = (rings) => {
  const cs = sectionOf(rings);
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
    // The chart bboxes reach 278mm, so the bracket has to clear that before it gives up.
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

// A point comfortably inside a ring, for asking whether that spot is still a hole after the
// opening. pointOnFeature can land ON the boundary, and an opening returns a boundary to where it
// was only up to its 16-segment arc discretisation, so a boundary sample flickers in and out.
// Sampling an inset copy puts the point 0.05mm clear of that, then it is checked against the ring
// it came from.
const interiorPoint = (ring) => {
  const ccw = loopArea(ring) < 0 ? [...ring].reverse() : ring;
  const cs = new wasm.CrossSection([ccw], 'NonZero');
  const inset = cs.offset(-0.05, 'Miter', 2, 16);
  const polys = inset.isEmpty() ? [] : inset.toPolygons();
  inset.delete();
  cs.delete();
  const biggest = polys
    .map((poly) => poly.map(([x, y]) => [x, y]))
    .filter((pts) => loopArea(pts) > 0)
    .sort((a, b) => loopArea(b) - loopArea(a))[0];
  return biggest ? turf.pointOnFeature(turf.polygon([closed(biggest)])) : null;
};

const rows = [];
let worstAreaGap = 0;
for (const zone of z.zones)
  for (const chart of zone.charts)
    (chart.cutRegions ?? []).forEach((piece, i) => {
      const rings = ringsOf(piece);
      const net = regionNetArea(piece);
      const cs = sectionOf(rings);
      const csArea = cs.area();
      cs.delete();
      worstAreaGap = Math.max(worstAreaGap, Math.abs(csArea - net) / Math.max(net, 1e-9));
      const outerPerim = perimOf(piece.outer);
      const [bw, bh] = bboxOfRing(piece.outer);
      rows.push({
        where: `${zone.id}/${chart.libraryPartId}#${i}`,
        net,
        csArea,
        holes: (piece.holes ?? []).length,
        bboxShort: Math.min(bw, bh),
        bboxLong: Math.max(bw, bh),
        fill: bw * bh > 0 ? net / (bw * bh) : 0,
        proxyNet: outerPerim > 0 ? (4 * net) / outerPerim : 0,
        proxyOuter: outerPerim > 0 ? (4 * Math.abs(loopArea(piece.outer))) / outerPerim : 0,
        critical: criticalWidth(rings),
        opened: WIDTHS.map((w) => openedArea(rings, w)),
        rings,
      });
    });

console.log(`${rows.length} cutRegions pieces on chair-body.`);
console.log(
  `Area floor in force at the bake: MIN_CUT_PIECE_MM2 ${MIN_CUT_PIECE_MM2}mm² ` +
    `(= CLIP_REMNANT_FLOOR_MM2 ${CLIP_REMNANT_FLOOR_MM2}mm²).`,
);
console.log(
  `CrossSection area vs regionNetArea: worst disagreement ${(worstAreaGap * 100).toFixed(4)}% ` +
    `(rings and fill rule agree if this is ~0).\n`,
);

// Cross-check: a piece the sweep opens to empty at w must have critical < w, and one that keeps
// area must have critical >= w. A disagreement means one of the two measures is wrong.
let disagree = 0;
for (const r of rows)
  WIDTHS.forEach((w, k) => {
    if ((r.opened[k] === 0) !== r.critical < w) disagree++;
  });
console.log(
  disagree === 0
    ? 'Sweep and bisected critical width agree on every piece at every width.'
    : `WARNING: sweep and critical width disagree on ${disagree} piece/width pairs.`,
);

rows.sort((a, b) => a.critical - b.critical);
// Both sides on the CrossSection's own basis: `opened` is a `CrossSection.area()`, and dividing it
// by `regionNetArea` mixes two measures the script itself finds disagreeing by up to 0.0273% —
// which is the same size as the noise floor this fraction is read for.
const lostAt = (r, w) => {
  const k = WIDTHS.indexOf(w);
  return r.csArea > 0 ? Math.max(0, (r.csArea - r.opened[k]) / r.csArea) : 0;
};
console.log('\nEvery piece, narrowest first. lost@ is the fraction of the piece the opening eats.');
console.log(
  '  width  4A/P-net  4A/P-out    net mm²   bbox short x long   fill  slender  holes  lost@0.2  lost@0.4  where',
);
for (const r of rows)
  console.log(
    `${r.critical.toFixed(4).padStart(7)}  ${r.proxyNet.toFixed(4).padStart(8)}  ` +
      `${r.proxyOuter.toFixed(4).padStart(8)}  ${r.net.toFixed(3).padStart(9)}  ` +
      `${r.bboxShort.toFixed(3).padStart(8)} x ${r.bboxLong.toFixed(2).padStart(6)}  ` +
      `${r.fill.toFixed(3).padStart(5)}  ${(r.bboxLong / r.critical).toFixed(0).padStart(7)}  ` +
      `${String(r.holes).padStart(5)}  ${lostAt(r, 0.2).toFixed(3).padStart(8)}  ` +
      `${lostAt(r, 0.4).toFixed(3).padStart(8)}  ${r.where}`,
  );

const totalArea = rows.reduce((s, r) => s + r.net, 0);
console.log(
  `\nSweep over ${totalArea.toFixed(1)}mm² of cut region in all. "empty" = the whole piece opens ` +
    'to nothing, which is what a guard would drop.',
);
console.log(
  '  width  empty  their mm²  empty % of all  widest dropped  narrowest kept   gap  part-eaten>50%',
);
for (const w of WIDTHS) {
  const k = WIDTHS.indexOf(w);
  const empty = rows.filter((r) => r.opened[k] === 0);
  const kept = rows.filter((r) => r.opened[k] > 0);
  const partial = rows.filter((r) => r.opened[k] > 0 && r.opened[k] < r.net * 0.5);
  const emptyArea = empty.reduce((s, r) => s + r.net, 0);
  const hiDrop = empty.length ? Math.max(...empty.map((r) => r.critical)) : 0;
  const loKeep = kept.length ? Math.min(...kept.map((r) => r.critical)) : Infinity;
  // With nothing dropped there is no separation to report, and `loKeep / 0` prints Infinity —
  // which reads as exactly the daylight this column exists to deny.
  const gap = empty.length && kept.length ? (loKeep / hiDrop).toFixed(2) : 'n/a';
  console.log(
    `${w.toFixed(2).padStart(7)}  ${String(empty.length).padStart(5)}  ` +
      `${emptyArea.toFixed(3).padStart(9)}  ` +
      `${((100 * emptyArea) / totalArea).toFixed(4).padStart(14)}  ` +
      `${hiDrop.toFixed(4).padStart(14)}  ${loKeep.toFixed(4).padStart(14)}  ` +
      `${gap.padStart(4)}  ` +
      `${String(partial.length).padStart(14)}`,
  );
}

// The safety question a total cannot answer: a chart whose cut region is nearly all dropped has
// lost design surface, however small the chair-wide fraction looks.
console.log("\nWorst-hit chart at each width, by share of that chart's own cutRegions area:");
console.log('  width  chart drops most   its mm² gone  of its mm²  share  pieces gone/all');
for (const w of WIDTHS) {
  const k = WIDTHS.indexOf(w);
  const by = new Map();
  for (const r of rows) {
    const c = r.where.split('#')[0];
    const e = by.get(c) ?? { gone: 0, all: 0, n: 0, tot: 0 };
    e.all += r.net;
    e.tot += 1;
    if (r.opened[k] === 0) {
      e.gone += r.net;
      e.n += 1;
    }
    by.set(c, e);
  }
  const [where, e] = [...by].sort((a, b) => b[1].gone / b[1].all - a[1].gone / a[1].all)[0];
  console.log(
    `${w.toFixed(2).padStart(7)}  ${where.padEnd(34)}${e.gone.toFixed(3).padStart(6)}  ` +
      `${e.all.toFixed(1).padStart(10)}  ${((100 * e.gone) / e.all).toFixed(3).padStart(5)}%  ` +
      `${e.n}/${e.tot}`,
  );
}

for (const w of REPORT_W) {
  const k = WIDTHS.indexOf(w);
  const dropped = new Map();
  const all = new Map();
  for (const r of rows) {
    const part = r.where.split('#')[0];
    all.set(part, (all.get(part) ?? 0) + 1);
    if (r.opened[k] === 0) dropped.set(part, (dropped.get(part) ?? 0) + 1);
  }
  console.log(
    `\nDropped at ${w}mm, by zone/part: ` +
      [...dropped]
        .sort()
        .map(([p, n]) => `${p} ${n}/${all.get(p)}`)
        .join(', '),
  );
}

const ws = rows.map((r) => r.critical).sort((a, b) => a - b);
if (ws.some((x) => !Number.isFinite(x))) console.log('WARNING: a piece width failed to bracket.');
let gapAt = 0;
let gapRatio = 1;
for (let i = 1; i < ws.length; i++)
  if (ws[i] / ws[i - 1] > gapRatio) {
    gapRatio = ws[i] / ws[i - 1];
    gapAt = i;
  }
// gapAt stays 0 when there is no consecutive pair to compare — one piece, or every width equal.
if (!gapAt)
  console.log(
    '\nWidest ratio gap between consecutive pieces: none, fewer than two distinct widths.',
  );
else
  console.log(
    `\nWidest ratio gap between consecutive pieces: ${ws[gapAt - 1].toFixed(4)}mm to ` +
      `${ws[gapAt].toFixed(4)}mm, a factor of ${gapRatio.toFixed(2)} ` +
      `(${gapAt} piece(s) below it, ${ws.length - gapAt} above).`,
  );
console.log(
  `Narrowest piece ${ws[0].toFixed(4)}mm, median ${ws[(ws.length / 2) | 0].toFixed(4)}mm, ` +
    `widest ${ws[ws.length - 1].toFixed(4)}mm.`,
);
// The global gap sits far above anything a guard would cut at, so the tail gets its own ladder:
// a guard needs daylight where the dust ends, not between two large pieces.
const tail = ws.filter((x) => x < 1);
console.log(`\nEvery step in the narrow tail (${tail.length} pieces under 1mm), for the gap:`);
console.log('   from       to   factor');
for (let i = 1; i < tail.length; i++)
  console.log(
    `${tail[i - 1].toFixed(4).padStart(7)}  ${tail[i].toFixed(4).padStart(7)}  ` +
      `${(tail[i] / tail[i - 1]).toFixed(3).padStart(7)}`,
  );

// What the 4·area/perimeter proxy that motivated this investigation actually got right. It is a
// sort key at best: printed against the truth so the correction is re-derivable, not remembered.
{
  const ratio = rows.map((r) => ({ ...r, k: r.proxyNet / r.critical }));
  const lo = ratio.reduce((a, b) => (b.k < a.k ? b : a));
  const hi = ratio.reduce((a, b) => (b.k > a.k ? b : a));
  console.log(
    `\nProxy 4A/P against the opening: understates by up to ${(1 / lo.k).toFixed(2)}x ` +
      `(${lo.where}, ${lo.proxyNet.toFixed(4)} vs ${lo.critical.toFixed(4)}mm) and overstates by ` +
      `up to ${hi.k.toFixed(2)}x (${hi.where}, ${hi.proxyNet.toFixed(4)} vs ` +
      `${hi.critical.toFixed(4)}mm).`,
  );
  for (const t of [0.15, 0.4]) {
    const byProxy = new Set(rows.filter((r) => r.proxyNet < t).map((r) => r.where));
    const byTrue = new Set(rows.filter((r) => r.critical < t).map((r) => r.where));
    const both = [...byTrue].filter((w) => byProxy.has(w)).length;
    console.log(
      `  under ${t}mm: ${byProxy.size} pieces by proxy, ${byTrue.size} by opening, ` +
        `${both} in both.`,
    );
  }
  const sortedProxy = [...rows].sort((a, b) => a.proxyNet - b.proxyNet);
  console.log(
    `  narrowest by proxy is ${sortedProxy[0].where}; by opening it is ${rows[0].where}, ` +
      `which the proxy ranks #${sortedProxy.findIndex((r) => r.where === rows[0].where) + 1}.`,
  );
  const med = (xs) => [...xs].sort((a, b) => a - b)[(xs.length / 2) | 0];
  console.log(
    `  median piece: ${med(rows.map((r) => r.proxyNet)).toFixed(4)}mm by proxy, ` +
      `${med(rows.map((r) => r.critical)).toFixed(4)}mm by opening.`,
  );
}

// Width is not the only shape a guard could test on, so the same ladder for slenderness (bbox long
// side over opening width). If neither has daylight, the absence is about the population.
{
  const sl = rows.map((r) => r.bboxLong / r.critical).sort((a, b) => a - b);
  const steps = sl
    .slice(1)
    .map((x, i) => ({ from: sl[i], to: x, k: x / sl[i] }))
    .sort((a, b) => b.k - a.k);
  console.log(`\nBiggest steps in slenderness (bbox long / opening width) over all ${sl.length}:`);
  for (const t of steps.slice(0, 6))
    console.log(
      `${t.from.toFixed(2).padStart(9)} to ${t.to.toFixed(2).padStart(8)}  ` +
        `factor ${t.k.toFixed(3)}`,
    );
}

// Holes are not narrow features: an opening erodes solid, so a real slot should come back
// untouched. Checked rather than assumed — and never fed into a width figure above.
console.log('\nHoles inside cutRegions pieces, narrowest first (a hole is not a width):');
const holes = [];
for (const zone of z.zones)
  for (const chart of zone.charts)
    (chart.cutRegions ?? []).forEach((piece, i) => {
      (piece.holes ?? []).forEach((h, j) => {
        const [w, hh] = bboxOfRing(h);
        holes.push({
          where: `${zone.id}/${chart.libraryPartId}#${i} hole${j}`,
          rings: ringsOf(piece),
          ring: h,
          area: Math.abs(loopArea(h)),
          meanWidth: (4 * Math.abs(loopArea(h))) / perimOf(h),
          short: Math.min(w, hh),
          long: Math.max(w, hh),
        });
      });
    });
holes.sort((a, b) => a.short - b.short);
console.log('   bbox short x long     mm²     4A/P   where');
for (const h of holes)
  console.log(
    `${h.short.toFixed(3).padStart(12)} x ${h.long.toFixed(2).padStart(6)}  ` +
      `${h.area.toFixed(2).padStart(7)}  ${h.meanWidth.toFixed(3).padStart(7)}  ${h.where}`,
  );

// Every hole, not just the named one: an opening erodes solid, so no hole should ever close.
// Counted across all hole-bearing pieces rather than argued from the definition.
{
  const withHoles = rows.filter((r) => r.holes > 0);
  const before = withHoles.reduce(
    (s, r) => s + r.rings.slice(1).reduce((t, h) => t + Math.abs(loopArea(h)), 0),
    0,
  );
  console.log(
    `\n${withHoles.length} pieces carry ${withHoles.reduce((s, r) => s + r.holes, 0)} holes, ` +
      `${before.toFixed(1)}mm² in all. Holes surviving the opening:`,
  );
  // Ring count and surviving-hole count are different questions: the opening can split one hole
  // into two rings or merge two into one, so both are printed.
  console.log('  width  rings left  their mm²  originals no longer a hole');
  for (const w of WIDTHS) {
    let n = 0;
    let a = 0;
    const gone = [];
    const withPiece = [];
    const offHole = [];
    for (const r of withHoles) {
      const cs = sectionOf(r.rings);
      const eroded = cs.offset(-w / 2, 'Miter', 2, 16);
      const opened = eroded.isEmpty() ? null : eroded.offset(w / 2, 'Miter', 2, 16);
      const left = [];
      for (const poly of opened ? opened.toPolygons() : []) {
        const pts = poly.map(([x, y]) => [x, y]);
        const ar = loopArea(pts);
        if (ar < 0) {
          n += 1;
          a += -ar;
          left.push(pts);
        }
      }
      // Is a point that WAS in this hole still in a hole? pointOnFeature, not a bbox or vertex
      // mean, and checked against the ring: the mean of a crescent's vertices is outside it, which
      // is the sampling trap measure-seam-overlap.mjs records. A hole that stops being a hole has
      // merged into the outer boundary — the SOLID beside it was thinner than the width, not the
      // hole itself.
      r.rings.slice(1).forEach((h, j) => {
        const pt = interiorPoint(h);
        if (!pt || !turf.booleanPointInPolygon(pt, turf.polygon([closed(h)])))
          offHole.push(`${r.where} hole${j}`);
        // The whole piece opening to nothing takes its holes with it, and that is not the opening
        // closing a hole. Counted apart, or a part whose pieces vanish prints a `gone` total that
        // reads as breaking the "an opening cannot close a hole" invariant this table checks.
        else if (!opened) withPiece.push(`${r.where} hole${j}`);
        else if (!left.some((ring) => turf.booleanPointInPolygon(pt, turf.polygon([closed(ring)]))))
          gone.push(`${r.where} hole${j}`);
      });
      opened?.delete();
      eroded.delete();
      cs.delete();
    }
    console.log(
      `${w.toFixed(2).padStart(7)}  ${String(n).padStart(10)}  ${a.toFixed(1).padStart(9)}` +
        (gone.length ? `  ${gone.length}: ${gone.join(', ')}` : '  0') +
        (withPiece.length
          ? `   (${withPiece.length} went with a piece that opened to nothing)`
          : '') +
        (offHole.length ? `   WARNING sample outside: ${offHole.join(', ')}` : ''),
    );
  }
}

// The 1.43 x 16.56mm radiused slot MIN_HOLE_WIDTH_MM's docstring names, followed through the sweep
// on its own piece: does the opening still leave a hole of that size there?
const slot = holes.reduce((best, h) =>
  Math.abs(h.short - 1.43) + Math.abs(h.long - 16.56) <
  Math.abs(best.short - 1.43) + Math.abs(best.long - 16.56)
    ? h
    : best,
);
console.log(
  `\nThe named 1.43 x 16.56mm slot resolves to ${slot.where}: ` +
    `${slot.short.toFixed(3)} x ${slot.long.toFixed(2)}mm, ${slot.area.toFixed(2)}mm².`,
);
const slotC = bboxCentre(slot.ring);
console.log('  width   hole still there   its mm²   bbox short x long');
for (const w of WIDTHS) {
  const cs = sectionOf(slot.rings);
  const eroded = cs.offset(-w / 2, 'Miter', 2, 16);
  const opened = eroded.isEmpty() ? null : eroded.offset(w / 2, 'Miter', 2, 16);
  const polys = opened ? opened.toPolygons() : [];
  let best = null;
  for (const p of polys) {
    const pts = p.map(([x, y]) => [x, y]);
    if (loopArea(pts) >= 0) continue; // negative area = a hole in this fill convention
    const c = bboxCentre(pts);
    const d = Math.hypot(c[0] - slotC[0], c[1] - slotC[1]);
    if (!best || d < best.d) best = { d, pts };
  }
  const line = best
    ? (() => {
        const [bw, bh] = bboxOfRing(best.pts);
        return (
          `${'yes'.padStart(16)}  ${Math.abs(loopArea(best.pts)).toFixed(2).padStart(8)}  ` +
          `${Math.min(bw, bh).toFixed(3).padStart(8)} x ${Math.max(bw, bh).toFixed(2)}`
        );
      })()
    : `${'NO'.padStart(16)}`;
  console.log(`${w.toFixed(2).padStart(7)}  ${line}`);
  opened?.delete();
  eroded.delete();
  cs.delete();
}

// The 0.15mm seam overlaps are a DIFFERENT population: each is the intersection of two charts'
// claims, not a piece of either chart's own cutRegions. Confirmed here rather than carried over
// from the seam report as a constraint on this guard.
const overlaps = [];
for (const zone of z.zones) {
  const cs = zone.charts.filter((c) => (c.cutRegions ?? []).length);
  for (let i = 0; i < cs.length; i++)
    for (let j = i + 1; j < cs.length; j++) {
      const hit = turf.intersect(multi(cs[i].cutRegions), multi(cs[j].cutRegions));
      if (!hit) continue;
      const g = hit.geometry;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      for (const p of polys) {
        const f = turf.polygon(p);
        const area = Math.abs(planarArea(f));
        if (area <= 0) continue;
        const outer = p[0].slice(0, -1);
        const [w, h] = bboxOfRing(outer);
        overlaps.push({
          where: `${zone.id} ${cs[i].libraryPartId}/${cs[j].libraryPartId}`,
          area,
          short: Math.min(w, h),
          critical: criticalWidth(p.map((r) => r.slice(0, -1))),
        });
      }
    }
}
const overFloor = overlaps.filter((o) => o.area >= CLIP_REMNANT_FLOOR_MM2);
console.log(`\n${overlaps.length} seam-overlap pieces, ${overFloor.length} over the area floor.`);
console.log(
  `  thinnest over the floor: ${Math.min(...overFloor.map((o) => o.short)).toFixed(4)}mm by bbox, ` +
    `${Math.min(...overFloor.map((o) => o.critical)).toFixed(4)}mm by opening.`,
);
// An overlap that WAS a cutRegions piece would make the seam figure a constraint on this guard.
const coincide = overlaps.filter((o) =>
  rows.some((r) => Math.abs(r.net - o.area) < 1e-6 && Math.abs(r.bboxShort - o.short) < 1e-6),
);
console.log(
  `  overlap pieces that are themselves a cutRegions piece: ${coincide.length} of ${overlaps.length}.`,
);

const withZones = ASSEMBLY_KINDS.filter((k) => k.zonesFile);
console.log(
  `\nKinds with a zonesFile, and so with cutRegions at all: ${withZones.length} of ` +
    `${ASSEMBLY_KINDS.length} (${withZones.map((k) => k.id).join(', ') || 'none'}). ` +
    `The rest: ${ASSEMBLY_KINDS.filter((k) => !k.zonesFile)
      .map((k) => k.id)
      .join(', ')}.`,
);
