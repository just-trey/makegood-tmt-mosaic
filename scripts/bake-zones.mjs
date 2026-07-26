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
import { bakeZones, read3MFIndexed } from './lib/zonebake.mjs';

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

let result;
try {
  result = bakeZones(config, parts, (msg) => console.log(`  ${msg}`));
} catch (e) {
  die(e.message);
}

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
