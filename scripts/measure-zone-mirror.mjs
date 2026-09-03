/**
 * How well each zone's chart is the reflection of its mirror, off the SHIPPED sidecar and part
 * files, so the residuals the bake wrote can be re-derived without a rebake (90s and the covers
 * file, which lives outside the repo).
 *
 * Pairing and measurement are the bake's own (`pairMirrorZones`, `measureZoneMirror` in
 * lib/zonebake.mjs), not re-implemented here: a measurement script that computes its figure a
 * second way IS a second figure. What this adds is reading the parts the way the app does — every
 * <object> of the packed 3MF in file order, vertices offset per object exactly as load3MF and
 * read3MF walk them — so a wrong vertex order would show up as a residual of centimetres, not as
 * a plausible number.
 *
 * Usage:
 *   npx vite-node scripts/measure-zone-mirror.mjs [scripts/zone-configs/chair-body.json]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { eachElement, meshVerts, modelXML } from './lib/mesh.mjs';
import { MIRROR_VERT_PAIR_MM, measureZoneMirror, pairMirrorZones } from './lib/zonebake.mjs';
import { CHART_SNAP_MM } from '../src/geometry/conformal.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.argv[2] ?? 'scripts/zone-configs/chair-body.json';
const config = JSON.parse(fs.readFileSync(path.resolve(REPO, configPath), 'utf8'));
if (!config.mirrorAxis) {
  console.error(`${configPath} declares no mirrorAxis; nothing to measure`);
  process.exit(1);
}
const axis = 'xyz'.indexOf(config.mirrorAxis);
const sidecar = JSON.parse(
  fs.readFileSync(path.resolve(REPO, 'public/stl', `${config.kindId}-zones.json`), 'utf8'),
);

const partVerts = new Map();
for (const p of config.parts) {
  const xml = await modelXML(fs.readFileSync(path.resolve(REPO, p.file)));
  const verts = [];
  for (const { body } of eachElement(xml, 'object')) {
    if (!body) continue;
    for (const v of meshVerts(body)) verts.push(v);
  }
  partVerts.set(p.libraryPartId, verts);
}
const vertsOf = (id) => {
  const v = partVerts.get(id);
  if (!v) throw new Error(`sidecar chart names part "${id}", which the config does not list`);
  return v;
};

const { mirror, warnings } = pairMirrorZones(config.zones, axis);
for (const w of warnings) console.warn(`  ! ${w}`);
const rows = [];
for (const zone of sidecar.zones) {
  const rel = mirror.get(zone.id);
  if (!rel) continue;
  const other = rel.self ? zone : sidecar.zones.find((z) => z.id === rel.twin);
  const m = measureZoneMirror(zone, other, axis, vertsOf);
  const baked = zone.mirror?.residualMm;
  rows.push({
    pair: `${zone.id} -> ${rel.self ? zone.id + ' (self)' : rel.twin}`,
    paired: `${m.pairs} of ${m.of}`,
    rms: m.rms.toFixed(3),
    p95: m.p95.toFixed(3),
    max: m.max.toFixed(3),
    'bbox gap (u x v)': rel.self
      ? '-'
      : `${Math.abs(zone.uvBounds.maxU - other.uvBounds.maxU).toFixed(3)} x ` +
        `${Math.abs(zone.uvBounds.maxV - other.uvBounds.maxV).toFixed(3)}`,
    sidecar: baked
      ? `${baked.pairs}/${baked.rms}/${baked.p95}/${baked.max}` +
        (baked.pairs === m.pairs && Math.abs(baked.rms - m.rms) < 0.0006 ? '' : ' MISMATCH')
      : 'none',
  });
}
console.log(
  `\n  mirror across ${config.mirrorAxis}, vertices paired within ${MIRROR_VERT_PAIR_MM}mm, ` +
    `residual in mm (warn bar: p95 > CHART_SNAP_MM = ${CHART_SNAP_MM})\n`,
);
console.table(rows);
