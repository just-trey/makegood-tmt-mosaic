/**
 * How much of a flank zone the assembled wheel stands in front of, and how much a tire ring on top
 * of it would add. Exists so the figures in docs/tech-debt.md's tire section re-derive: they are
 * geometry projections rather than bake output, and nothing else in the repo produces them.
 *
 * Definitions, because "the wheel's shadow" has more than one reasonable reading:
 *
 *   - **straight-on shadow** — the zone surface a ray along the flank's own outward axis (+x on
 *     `left`, -x on `right`) reaches a cover body from, within COVER_RAY_MM. Not the hemisphere
 *     test the bake classifies with: this is the wheel's silhouette projected flat, which is what
 *     the tech-debt table compares the baked figure against.
 *   - **baked dead** — the same charts' `deadRegions` out of the shipped sidecar, summed. The
 *     difference between the two is the 20mm visible-region bleed.
 *   - **tire ring** — the extra shadow if each caster carried a band `--tire-mm` wide outside its
 *     rim. **Unmeasured**: the width is scaled off a photograph, and the ring is built here rather
 *     than in the bake for exactly that reason. Reported so the number in the doc is reproducible,
 *     never so it can be built on.
 *
 * Area is measured in the chart's UV, which is true millimetres of surface, and only over the
 * charts each zone actually carries. Sampling matches the bake: COVER_SAMPLE_MM2 patches per
 * triangle, capped at SUB_CELLS_MAX to a side, one sample at each patch centroid.
 *
 * Usage (needs stubs/dead-zones.3mf, which lives outside the repo):
 *   npx vite-node scripts/measure-wheel-shadow.mjs
 *   npx vite-node scripts/measure-wheel-shadow.mjs --tire-mm 30
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  at,
  bodyIndex,
  coverOccludes,
  COVER_RAY_MM,
  COVER_SAMPLE_MM2,
  read3MFIndexed,
  read3MFObjectsByColor,
  regionNetArea,
  registerCovers,
  subCells,
  SUB_CELLS_MAX,
} from './lib/zonebake.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'scripts/zone-configs/chair-body.json';
const SIDECAR = 'public/stl/chair-body-zones.json';
const ZONES = ['left', 'right'];

const tireArg = process.argv.indexOf('--tire-mm');
const TIRE_MM = tireArg > 0 ? Number(process.argv[tireArg + 1]) : 0;

const config = JSON.parse(fs.readFileSync(path.join(REPO, CONFIG), 'utf8'));
const sidecar = JSON.parse(fs.readFileSync(path.join(REPO, SIDECAR), 'utf8'));

const parts = [];
for (const p of config.parts) {
  const mesh = await read3MFIndexed(fs.readFileSync(path.join(REPO, p.file)));
  parts.push({ libraryPartId: p.libraryPartId, ...mesh });
}
const objects = await read3MFObjectsByColor(
  fs.readFileSync(path.join(REPO, config.covers.file)),
  config.covers.file,
);
const { covers } = registerCovers(config, parts, objects);

/**
 * A copy of every cover grown outward from its own axis by `mm`, as the tire band would be. Radial
 * about the mirror axis, since that is the wheel's axle: each vertex moves away from the axle line
 * by `mm`, which turns a disc of radius r into one of r + mm and leaves the axle-aligned extent
 * alone.
 */
function grown(bodies, mm) {
  const axis = 'xyz'.indexOf(config.covers.mirrorAxis);
  const other = [0, 1, 2].filter((k) => k !== axis);
  return bodies.map((b) => {
    let cu = 0,
      cv = 0;
    for (const v of b.verts) {
      cu += v[other[0]];
      cv += v[other[1]];
    }
    cu /= b.verts.length;
    cv /= b.verts.length;
    return {
      tris: b.tris,
      verts: b.verts.map((v) => {
        const du = v[other[0]] - cu,
          dv = v[other[1]] - cv;
        const r = Math.hypot(du, dv);
        if (!(r > 0)) return [...v];
        const out = [...v];
        out[other[0]] = cu + du * (1 + mm / r);
        out[other[1]] = cv + dv * (1 + mm / r);
        return out;
      }),
    };
  });
}

/** UV mm² of a chart whose sample points see a cover along `dir`. */
function shadowArea(chart, dir, index) {
  const { positions3, uv, triangles } = chart;
  const p3 = (i) => [positions3[i * 3], positions3[i * 3 + 1], positions3[i * 3 + 2]];
  const p2 = (i) => [uv[i * 2], uv[i * 2 + 1]];
  let area = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const a3 = p3(triangles[t]),
      b3 = p3(triangles[t + 1]),
      c3 = p3(triangles[t + 2]);
    const a2 = p2(triangles[t]),
      b2 = p2(triangles[t + 1]),
      c2 = p2(triangles[t + 2]);
    const triUV =
      Math.abs((b2[0] - a2[0]) * (c2[1] - a2[1]) - (c2[0] - a2[0]) * (b2[1] - a2[1])) / 2;
    const k = Math.max(1, Math.min(SUB_CELLS_MAX, Math.ceil(Math.sqrt(triUV / COVER_SAMPLE_MM2))));
    const cells = subCells(k);
    for (const cell of cells) {
      const s = (cell[0][0] + cell[1][0] + cell[2][0]) / 3;
      const u = (cell[0][1] + cell[1][1] + cell[2][1]) / 3;
      if (coverOccludes(index, at(a3, b3, c3, s, u), dir, COVER_RAY_MM) >= 0)
        area += triUV / cells.length;
    }
  }
  return area;
}

/** Which way is out: the sign the chart's own triangle normals agree on along the mirror axis. */
function outwardDir(chart) {
  const axis = 'xyz'.indexOf(config.covers.mirrorAxis);
  const { positions3, triangles } = chart;
  let sum = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const g = (i, k) => positions3[triangles[t + i] * 3 + k];
    const e1 = [0, 1, 2].map((k) => g(1, k) - g(0, k));
    const e2 = [0, 1, 2].map((k) => g(2, k) - g(0, k));
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    sum += n[axis];
  }
  const dir = [0, 0, 0];
  dir[axis] = sum >= 0 ? 1 : -1;
  return dir;
}

const bare = bodyIndex(covers);
const tired = TIRE_MM > 0 ? bodyIndex(grown(covers, TIRE_MM)) : null;

console.log(`covers: ${config.covers.file}, sidecar: ${SIDECAR}`);
console.log(
  `sampling: ${COVER_SAMPLE_MM2}mm² patches, ${COVER_RAY_MM}mm ray${TIRE_MM ? `, tire ring ${TIRE_MM}mm (UNMEASURED)` : ''}`,
);
for (const zoneId of ZONES) {
  const zone = sidecar.zones.find((z) => z.id === zoneId);
  let shadow = 0,
    withTire = 0,
    baked = 0;
  for (const c of zone.charts) {
    const part = parts.find((p) => p.libraryPartId === c.libraryPartId);
    const chart = {
      positions3: Float32Array.from(c.verts.flatMap((vi) => [...part.verts[vi]])),
      uv: Float32Array.from(c.uv),
      triangles: Uint32Array.from(c.chartTris.flat()),
    };
    const dir = outwardDir(chart);
    shadow += shadowArea(chart, dir, bare);
    if (tired) withTire += shadowArea(chart, dir, tired);
    baked += (c.deadRegions ?? []).reduce((s, r) => s + regionNetArea(r), 0);
  }
  console.log(
    `zone "${zoneId}": straight-on wheel shadow ${shadow.toFixed(0)}mm², ` +
      `baked dead ${baked.toFixed(0)}mm²` +
      (tired ? `, tire ring adds ${(withTire - shadow).toFixed(0)}mm²` : ''),
  );
}
