/**
 * What relates the covers file's paired caster bodies to each other: a mirror, or a rotation.
 *
 * Exists so `symmetrizeCovers`' figures re-derive. It moves poses and leaves meshes alone because
 * this pair is NOT mirror-symmetric, and that claim rests on numbers nothing else in the repo
 * produces. It also states the residual under the mirror the function used to apply, which is how
 * far real geometry moved while it did.
 *
 * Method, and why each piece is not re-implemented here:
 *
 *   - bodies come from `registerCovers` with `mirrorAxis` taken off, so they are the same covers
 *     the bake sees, in the bake frame, before any symmetrizing touches them
 *   - pairing is the bake's own rule: equal triangle count, midpoints within MIRROR_PAIR_TOL_MM of
 *     each other's reflection
 *   - distances are `nearestPointDistances`, the search `symmetrizeCovers` reports its residual
 *     with. Point SETS, never index for index: two bodies that are each other's image need not
 *     list vertices in the same order
 *
 * The candidate maps are the 48 signed axis permutations, each applied about the pair's own
 * midpoints, so a map's score is shape against shape with the poses already agreed. Determinant
 * says which are rotations (+1) and which are mirrors (-1).
 *
 * Usage (needs stubs/dead-zones.3mf, which lives outside the repo):
 *   npx vite-node scripts/measure-caster-axis-map.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  nearestPointDistances,
  read3MFIndexed,
  read3MFObjectsByColor,
  registerCovers,
} from './lib/zonebake.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'scripts/zone-configs/chair-body.json';
/** Above the 21.976mm answer and below the 280mm body, the same band symmetrizeCovers reports in. */
const CAP_MM = 50;
/** "Moved by more than a print layer or two", for the count of vertices a mirror displaces. */
const OVER_MM = 1;
/** The bake's own pairing tolerance; imported would be better, but it is module-private there. */
const PAIR_TOL_MM = 5;

const config = JSON.parse(fs.readFileSync(path.join(REPO, CONFIG), 'utf8'));
const axis = 'xyz'.indexOf(config.covers.mirrorAxis);
if (axis < 0) throw new Error(`${CONFIG}: covers.mirrorAxis must be "x", "y" or "z"`);

const parts = [];
for (const p of config.parts) {
  const mesh = await read3MFIndexed(fs.readFileSync(path.join(REPO, p.file)));
  parts.push({ libraryPartId: p.libraryPartId, ...mesh });
}
const objects = await read3MFObjectsByColor(
  fs.readFileSync(path.join(REPO, config.covers.file)),
  config.covers.file,
);
// mirrorAxis off, so registerCovers returns the covers unposed and unsymmetrized.
const raw = { ...config, covers: { ...config.covers, mirrorAxis: undefined } };
const { covers } = registerCovers(raw, parts, objects);

const bounds = (verts) => {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const v of verts)
    for (let k = 0; k < 3; k++) {
      if (v[k] < mn[k]) mn[k] = v[k];
      if (v[k] > mx[k]) mx[k] = v[k];
    }
  return {
    dims: [0, 1, 2].map((k) => mx[k] - mn[k]),
    mid: [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2),
  };
};
const flip = (v) => v.map((x, k) => (k === axis ? -x : x));
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const worst = (d) => d.reduce((w, x) => (x > w ? x : w), 0);

/** The 48 signed axis permutations, as 3x3 matrices, with their determinants. */
const MAPS = [];
for (const p of [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
])
  for (const s0 of [1, -1])
    for (const s1 of [1, -1])
      for (const s2 of [1, -1]) {
        const s = [s0, s1, s2];
        const R = [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ];
        for (let r = 0; r < 3; r++) R[r][p[r]] = s[r];
        const det =
          R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
          R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
          R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
        const name = [0, 1, 2].map((r) => `${s[r] < 0 ? '-' : ''}${'xyz'[p[r]]}`).join(', ');
        MAPS.push({ R, det, name });
      }

const info = covers.map((c) => ({ c, b: bounds(c.verts) }));
const used = new Set();
let pairs = 0;
for (let i = 0; i < info.length; i++) {
  if (used.has(i)) continue;
  let partner = -1;
  let best = Infinity;
  for (let j = 0; j < info.length; j++) {
    if (j === i || used.has(j) || info[j].c.tris.length !== info[i].c.tris.length) continue;
    const d = dist3(info[i].b.mid, flip(info[j].b.mid));
    if (d < best) {
      best = d;
      partner = j;
    }
  }
  if (partner < 0 || best > PAIR_TOL_MM) continue;
  used.add(i);
  used.add(partner);
  pairs++;
  const A = info[i];
  const B = info[partner];
  // Both bodies about their own midpoints, so a map is judged on shape with the pose agreed.
  const a0 = A.c.verts.map((v) => v.map((x, k) => x - A.b.mid[k]));
  const b0 = B.c.verts.map((v) => v.map((x, k) => x - B.b.mid[k]));
  console.log(
    `\npair ${pairs}: ${A.c.verts.length} vs ${B.c.verts.length} vertices, ` +
      `${A.b.dims.map((d) => d.toFixed(3)).join(' x ')} against ` +
      `${B.b.dims.map((d) => d.toFixed(3)).join(' x ')}mm, ` +
      `midpoints ${best.toFixed(3)}mm from mirrored`,
  );
  const scored = MAPS.map((m) => {
    const mapped = a0.map((v) =>
      [0, 1, 2].map((r) => m.R[r][0] * v[0] + m.R[r][1] * v[1] + m.R[r][2] * v[2]),
    );
    const d = nearestPointDistances(b0, mapped, CAP_MM);
    const back = nearestPointDistances(mapped, b0, CAP_MM);
    return {
      ...m,
      residual: Math.max(worst(d), worst(back)),
      over: d.filter((x) => x > OVER_MM).length,
    };
  });
  const mirrorName = [0, 1, 2].map((k) => `${k === axis ? '-' : ''}${'xyz'[k]}`).join(', ');
  const applied = scored.find((m) => m.name === mirrorName);
  console.log(
    `  under the ${config.covers.mirrorAxis} mirror (${applied.name}): ` +
      `residual ${applied.residual.toFixed(3)}mm, ` +
      `${applied.over} of ${b0.length} vertices over ${OVER_MM}mm`,
  );
  const exact = scored.filter((m) => m.residual < OVER_MM).sort((x, y) => x.residual - y.residual);
  for (const m of exact)
    console.log(
      `  exact map (${m.name}): residual ${m.residual.toFixed(3)}mm, ` +
        `determinant ${m.det > 0 ? '+1 (rotation)' : '-1 (mirror)'}`,
    );
  if (!exact.length) console.log(`  no signed axis permutation maps this pair within ${OVER_MM}mm`);
}
if (!pairs) console.log('no mirror-paired cover bodies found');
