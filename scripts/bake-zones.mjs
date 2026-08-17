// Bakes a kind's design zones from a zone config: welds the kind's packed part meshes in their
// assembled pose, segments and LSCM-unwraps each configured zone, and writes the assembly-level
// zones sidecar (public/stl/<kindId>-zones.json) plus true-size per-zone template SVGs
// (public/templates/). The committed sidecar and templates are the real artifacts; this script is
// the reproducible recipe — tweak the config numbers, re-run, inspect the templates.
//
//   npx vite-node scripts/bake-zones.mjs scripts/zone-configs/<kind>.json
//
// Config shape (all lengths mm, all directions in the parts' assembled frame):
//   {
//     "schema": 1,
//     "kindId": "chair-body",
//     "parts": [{ "libraryPartId": "chair-side-left", "file": "public/stl/chair-side-left.3mf" }],
//     "zones": [{ "id": "chair-left", "name": "Left side",
//                 "seedNormal": [-1, 0, 0],      // or "seedPoint": [x, y, z]
//                 "maxAngleDeg": 70, "up": [0, 1, 0] }]
//   }
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  bakeZones,
  read3MFIndexed,
  read3MFObjectsByColor,
  registerCovers,
} from './lib/zonebake.mjs';
import { getManifold } from '../src/geometry/manifold.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function die(msg) {
  console.error(`\n  ERROR: ${msg}\n`);
  process.exit(1);
}

const configPath = process.argv[2];
if (!configPath || process.argv.length > 3) die('usage: bake-zones.mjs <zone-config.json>');

let config;
try {
  config = JSON.parse(fs.readFileSync(path.resolve(REPO, configPath), 'utf8'));
} catch (e) {
  die(`could not read ${configPath}: ${e.message}`);
}

const parts = [];
for (const p of config.parts ?? []) {
  const file = path.resolve(REPO, p.file);
  let mesh;
  try {
    mesh = await read3MFIndexed(fs.readFileSync(file));
  } catch (e) {
    die(`could not read ${p.file}: ${e.message}`);
  }
  if (!mesh.tris.length) die(`${p.file} has zero triangles`);
  parts.push({ libraryPartId: p.libraryPartId, ...mesh });
  console.log(`  loaded      ${p.file}: ${mesh.verts.length} vertices, ${mesh.tris.length} tris`);
}

const opts = {};
if (config.covers) {
  const file = path.resolve(REPO, config.covers.file);
  if (!fs.existsSync(file))
    die(
      `${config.covers.file} not found.\n  This is the whole-assembly export marking the parts ` +
        `that cover this kind's design surface; it lives outside the repo (stubs/ is gitignored). ` +
        `Without it the bake cannot tell which surface is hidden.`,
    );
  let objects;
  try {
    objects = await read3MFObjectsByColor(fs.readFileSync(file));
  } catch (e) {
    die(`could not read covers file ${config.covers.file}: ${e.message}`);
  }
  try {
    const reg = registerCovers(config, parts, objects);
    opts.covers = reg.covers;
    console.log(
      `  covers      ${config.covers.file}: ${reg.covers.length} cover bodies, ` +
        `registered against ${reg.matched} parts (residual ${reg.residual.toFixed(3)}mm)`,
    );
  } catch (e) {
    die(e.message);
  }
  opts.wasm = await getManifold();
}

let result;
try {
  result = bakeZones(config, parts, (msg) => console.log(`  ${msg}`), opts);
} catch (e) {
  die(e.message);
}

// The chair's sidecar is 1.7MB raw / 638KB gzipped, up from 125KB when each zone stopped at one
// part -- a zone spanning the whole chair simply carries more triangles. Measured composition: 41%
// chartTris, 30% uv, 16% tris, 9% verts, so it is mostly index arrays and rounding the UVs buys
// little. Real fix is delta-encoding the index arrays or a binary format; not urgent, it loads
// async after first paint. Don't quantise UVs below ~0.01mm chasing this: two chart vertices closer
// than the quantum would collapse into a degenerate UV triangle and the warp's barycentric lookup
// divides by its area.
const sidecarPath = path.resolve(REPO, 'public/stl', `${config.kindId}-zones.json`);
fs.writeFileSync(sidecarPath, JSON.stringify(result.sidecar));
console.log(
  `\n  wrote       public/stl/${config.kindId}-zones.json ` +
    `(${(fs.statSync(sidecarPath).size / 1024).toFixed(0)} KB, ${result.sidecar.zones.length} zone(s))`,
);
for (const t of result.templates) {
  fs.writeFileSync(path.resolve(REPO, 'public/templates', t.file), t.svg);
  console.log(`  wrote       public/templates/${t.file}`);
}
for (const w of result.warnings) console.warn(`  ! ${w}`);
