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
const bboxOf = (f) => {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const ring of f.geometry.coordinates)
    for (const [x, y] of ring) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  return [x1 - x0, y1 - y0];
};
const perimOf = (f) => {
  let p = 0;
  for (const ring of f.geometry.coordinates)
    for (let i = 0; i < ring.length - 1; i++)
      p += Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
  return p;
};

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
        const [cxp, cyp] = turf.centroid(piece).geometry.coordinates;
        const pts = [];
        for (const c of [cs[i], cs[j]]) {
          const mp = new ConformalZoneMapper(
            wasm,
            reconstructChart(zone, c, await vertsOf(c.libraryPartId)),
          );
          // frameAt takes an offset from the zone's own anchor, which is what uvCu/uvCv hold.
          const f = mp.frameAt(cxp - zone.uvBounds.maxU / 2, cyp - zone.uvBounds.maxV / 2);
          pts.push(Number.isFinite(f.offChartMM) ? [f.origin.x, f.origin.y, f.origin.z] : null);
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
const ap = rows.map((r) => r.apart).filter((x) => x !== null);
if (ap.length)
  console.log(
    `Same UV point lands ${Math.min(...ap).toFixed(3)} to ${Math.max(...ap).toFixed(3)}mm apart on ` +
      `the two parts (${ap.length} pieces measured).`,
  );
