// Every place two parts of one zone claim the same UV: how big each PIECE is, how narrow, whether
// it clears the cut's area floor, and whether it extrudes on both parts.
//
// Written for docs/findings/2026-09-07-seam-ribbon-closed.md, which closed "A seam sliver warns as
// if artwork were lost" as not a defect. Per PIECE, not per pair: a pair's intersect can be several
// pieces, and the narrowest of them is what a design clipped down to one of them would face.
//
// Usage: npx vite-node scripts/measure-seam-overlap.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';
import { planarArea } from '../src/geometry/regions';
import { CLIP_REMNANT_FLOOR_MM2 } from '../src/geometry/depth';
import { ConformalZoneMapper } from '../src/geometry/conformal';
import { reconstructChart } from '../src/geometry/zoneCharts';
import {
  getManifold,
  manifoldIsValid,
  manifoldDelete,
  soupToManifold,
} from '../src/geometry/manifold';
import { read3MFIndexed } from './lib/zonebake.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const z = JSON.parse(readFileSync(path.join(REPO, 'public/stl/chair-body-zones.json'), 'utf8'));
const closed = (r) => [...r, r[0]];
const multi = (rs) => turf.multiPolygon(rs.map((r) => [closed(r.outer), ...r.holes.map(closed)]));
const wasm = await getManifold();

const meshes = new Map();
async function vertsOf(id) {
  if (!meshes.has(id)) {
    const m = await read3MFIndexed(readFileSync(path.join(REPO, 'public/stl', `${id}.3mf`)));
    const v = new Float32Array(m.verts.length * 3);
    m.verts.forEach((p, i) => v.set(p, i * 3));
    meshes.set(id, v);
  }
  return meshes.get(id);
}
/** Each polygon of a feature on its own. */
const piecesOf = (f) => {
  const g = f.geometry;
  return (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((rings) =>
    turf.polygon(rings),
  );
};
// Walks any nesting, because a pair's intersect can be a MultiPolygon while a single piece is a
// Polygon, and reading the deeper one a level too shallow silently returns Infinity.
const bboxOf = (f) => {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < x0) x0 = c[0];
      if (c[1] < y0) y0 = c[1];
      if (c[0] > x1) x1 = c[0];
      if (c[1] > y1) y1 = c[1];
      return;
    }
    for (const k of c) walk(k);
  };
  walk(f.geometry.coordinates);
  return [x1 - x0, y1 - y0];
};
// Outer ring only. `planarArea` subtracts holes, so counting hole perimeter here would divide a
// hole-subtracted area by a hole-inclusive perimeter and understate the width. No shipped overlap
// piece has a hole; a re-bake producing one would otherwise publish a wrong "thinnest".
const perimOf = (f) => {
  let p = 0;
  const ring = f.geometry.coordinates[0];
  for (let i = 0; i < ring.length - 1; i++)
    p += Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
  return p;
};

// The pair counts the report quotes, on both fields: the cut clips to `cutRegions`, and the
// original item was written against `subRegions`.
for (const field of ['subRegions', 'cutRegions']) {
  let pairs = 0,
    worst = 0,
    where = '',
    pairNarrow = Infinity;
  for (const zone of z.zones) {
    const cs = zone.charts.filter((c) => (c[field] ?? []).length);
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) {
        const hit = turf.intersect(multi(cs[i][field]), multi(cs[j][field]));
        if (!hit) continue;
        const a = Math.abs(planarArea(hit));
        if (a <= 0) continue;
        pairs++;
        // The narrow side of the WHOLE pair's intersect, which is the figure the first draft of
        // the report quoted before it was measured per piece. Printed so that correction is
        // re-derivable rather than remembered.
        const [pw, ph] = bboxOf(hit);
        pairNarrow = Math.min(pairNarrow, Math.min(pw, ph));
        if (a > worst) {
          worst = a;
          where = `${zone.id} ${cs[i].libraryPartId}/${cs[j].libraryPartId}`;
        }
      }
  }
  console.log(
    `${field.padEnd(11)} ${pairs} overlapping pair(s), worst ${worst.toFixed(2)}mm² on ${where}; ` +
      `thinnest pair by bbox ${pairNarrow.toFixed(4)}mm`,
  );
}
console.log('');

const rows = [];
for (const zone of z.zones) {
  const cs = zone.charts.filter((c) => (c.cutRegions ?? []).length);
  for (let i = 0; i < cs.length; i++)
    for (let j = i + 1; j < cs.length; j++) {
      const hit = turf.intersect(multi(cs[i].cutRegions), multi(cs[j].cutRegions));
      if (!hit) continue;
      for (const piece of piecesOf(hit)) {
        const area = Math.abs(planarArea(piece));
        if (area <= 0) continue;
        const [w, h] = bboxOf(piece);
        const perim = perimOf(piece);
        const built = [];
        for (const c of [cs[i], cs[j]]) {
          const mapper = new ConformalZoneMapper(
            wasm,
            reconstructChart(zone, c, await vertsOf(c.libraryPartId)),
          );
          const soup = mapper.buildCutter(piece, 1, 0.5, {});
          if (!soup || !soup.length) built.push(null);
          else {
            const man = soupToManifold(wasm, soup);
            built.push(manifoldIsValid(man) ? soup : null);
            manifoldDelete(man);
          }
        }
        // Where the SAME UV point lands on each part, which is the question "is this one spot cut
        // twice, or two surfaces either side of a join". Straight from each mapper's own warp,
        // rather than inferred from the two extruded solids, whose centroids also differ by their
        // normals.
        //
        // pointOnFeature, not centroid: a centroid is the vertex mean and falls OUTSIDE a curved
        // sliver, which on 4 of the chair's 41 pieces sampled surface neither part owns and
        // published a 1.116mm maximum that is not a separation at all.
        const [cxp, cyp] = turf.pointOnFeature(piece).geometry.coordinates;
        const inside = turf.booleanPointInPolygon(turf.point([cxp, cyp]), piece);
        const pts = [];
        for (const c of [cs[i], cs[j]]) {
          const mp = new ConformalZoneMapper(
            wasm,
            reconstructChart(zone, c, await vertsOf(c.libraryPartId)),
          );
          // frameAt takes an offset from the zone's own anchor, which is what uvCu/uvCv hold.
          const f = mp.frameAt(cxp - zone.uvBounds.maxU / 2, cyp - zone.uvBounds.maxV / 2);
          // `=== 0`, not `isFinite`. frameAt snaps a query to the nearest triangle and reports how
          // far it moved; Infinity is only an empty chart. Accepting anything non-Infinite
          // published 7 of 82 samples that had been snapped by up to 0.0863mm.
          pts.push(f.offChartMM === 0 ? [f.origin.x, f.origin.y, f.origin.z] : null);
        }
        const apart =
          pts[0] && pts[1]
            ? Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1], pts[0][2] - pts[1][2])
            : null;
        rows.push({
          where: `${zone.id} ${cs[i].libraryPartId}/${cs[j].libraryPartId}`,
          area,
          bboxNarrow: Math.min(w, h),
          meanWidth: perim > 0 ? (2 * area) / perim : 0,
          overFloor: area >= CLIP_REMNANT_FLOOR_MM2,
          builtBoth: built.every(Boolean),
          apart,
          sampledInside: inside,
        });
      }
    }
}
rows.sort((a, b) => a.meanWidth - b.meanWidth);
console.log(
  `${rows.length} overlap pieces across the chair. Floor is ${CLIP_REMNANT_FLOOR_MM2}mm².\n`,
);
console.log('  2A/P   bbox-narrow      area   >floor  both cut   apart   where');
for (const r of rows)
  console.log(
    `${r.meanWidth.toFixed(4).padStart(7)}  ${r.bboxNarrow.toFixed(4).padStart(11)}  ` +
      `${r.area.toFixed(3).padStart(9)}  ${(r.overFloor ? 'yes' : 'no ').padStart(6)}  ` +
      `${(r.builtBoth ? 'yes' : 'NO ').padStart(8)}  ${(r.apart === null ? '  n/a' : r.apart.toFixed(3)).padStart(6)}   ${r.where}`,
  );
const over = rows.filter((r) => r.overFloor);
console.log(`\n${over.length} of ${rows.length} pieces clear the floor.`);
console.log(
  `Thinnest that does: ${Math.min(...over.map((r) => r.meanWidth)).toFixed(4)}mm by 2A/P, ` +
    `${Math.min(...over.map((r) => r.bboxNarrow)).toFixed(4)}mm by bbox.`,
);
console.log(
  `Failed to build on one or both parts: ${rows.filter((r) => !r.builtBoth).length}` +
    ` (${over.filter((r) => !r.builtBoth).length} of them over the floor).`,
);
const outside = rows.filter((r) => !r.sampledInside).length;
if (outside) console.log(`WARNING: the sample point fell outside ${outside} piece(s)`);
const snapped = rows.filter((r) => r.apart === null).length;
if (snapped)
  console.log(`${snapped} piece(s) had a sample land off one part's chart and are not counted`);
const ap = rows.map((r) => r.apart).filter((x) => x !== null);
if (ap.length)
  console.log(
    `Same UV point lands ${Math.min(...ap).toFixed(3)} to ${Math.max(...ap).toFixed(3)}mm apart on ` +
      `the two parts (${ap.length} pieces measured).`,
  );

// Where buildCutter actually returns null, which is NOT a width. Ribbons on one real chart, swept
// over width and length independently, each clipped to that chart's own cut region first — which
// is what the build always does, and without which the nulls are just the strip leaving the chart.
{
  const zone = z.zones.find((x) => x.id === 'back');
  const chart = zone.charts.find((c) => c.libraryPartId === 'chair-seat-back-top');
  const mapper = new ConformalZoneMapper(
    wasm,
    reconstructChart(zone, chart, await vertsOf(chart.libraryPartId)),
  );
  const clip = multi(chart.cutRegions);
  const all = chart.cutRegions.flatMap((r) => r.outer);
  const cu = (Math.min(...all.map((p) => p[0])) + Math.max(...all.map((p) => p[0]))) / 2;
  const cv = (Math.min(...all.map((p) => p[1])) + Math.max(...all.map((p) => p[1]))) / 2;
  const widths = [0.2, 0.05, 0.01, 0.002, 0.001];
  const lengths = [1, 5, 20, 40, 80, 120];
  console.log(`\nribbons on back/chair-seat-back-top, clipped to its cut region first`);
  console.log('  width  ' + lengths.map((l) => `${l}mm`.padStart(9)).join(''));
  for (const w of widths) {
    const cells = lengths.map((len) => {
      const raw = turf.polygon([
        [
          [cu - w / 2, cv - len / 2],
          [cu + w / 2, cv - len / 2],
          [cu + w / 2, cv + len / 2],
          [cu - w / 2, cv + len / 2],
          [cu - w / 2, cv - len / 2],
        ],
      ]);
      let piece;
      try {
        piece = turf.intersect(raw, clip);
      } catch {
        return 'clipfail'.padStart(9);
      }
      if (!piece) return 'off-chart'.padStart(9);
      const soup = mapper.buildCutter(piece, 1, 0.5, {});
      if (!soup || !soup.length) return 'null'.padStart(9);
      const man = soupToManifold(wasm, soup);
      const ok = manifoldIsValid(man);
      manifoldDelete(man);
      return (ok ? 'ok' : 'invalid').padStart(9);
    });
    console.log(`${w.toFixed(3).padStart(7)}  ` + cells.join(''));
  }
}
