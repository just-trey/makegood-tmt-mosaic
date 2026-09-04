/**
 * How well each zone's chart is the reflection of its mirror, off the SHIPPED sidecar and part
 * files, so the residuals the bake wrote re-derive without a rebake (90s and the covers file,
 * which lives outside the repo).
 *
 * Pairing, reading and measurement are the bake's own (`pairMirrorZones`, `read3MFIndexed`,
 * `measureZoneMirror` in lib/zonebake.mjs), not re-implemented: a measurement script that
 * computes its figure a second way IS a second figure.
 *
 * Also fits a similarity (rotation + scale, about the paired points' centroids) on top of the
 * reflection and reports what it changes. That is the evidence that the bbox-centre reflection
 * is the whole transform and there is no constant to tune: on the chair the fit is a fraction
 * of a degree and a few parts in 10,000.
 *
 * Usage:
 *   npx vite-node scripts/measure-zone-mirror.mjs [scripts/zone-configs/chair-body.json] [--pair-mm 0.5]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  MIRROR_VERT_PAIR_MM,
  measureZoneMirror,
  pairMirrorZones,
  procrustesFit,
  read3MFIndexed,
} from './lib/zonebake.mjs';
import { CHART_SNAP_MM } from '../src/geometry/conformal.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const pairIdx = args.indexOf('--pair-mm');
const cap = pairIdx >= 0 ? Number(args[pairIdx + 1]) : MIRROR_VERT_PAIR_MM;
if (!(cap > 0)) {
  console.error('--pair-mm needs a positive number');
  process.exit(1);
}
const configPath =
  args.find((a, i) => !a.startsWith('--') && (i === 0 || args[i - 1] !== '--pair-mm')) ??
  'scripts/zone-configs/chair-body.json';
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
  const mesh = await read3MFIndexed(fs.readFileSync(path.resolve(REPO, p.file)));
  partVerts.set(p.libraryPartId, mesh.verts);
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
  const m = measureZoneMirror(zone, other, axis, vertsOf, cap);
  const fit = procrustesFit(m.pairList);
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
    'best fit (deg, scale, rms)': fit
      ? `${fit.thetaDeg.toFixed(3)}, x${fit.scale.toFixed(5)}, ${fit.rms.toFixed(3)}`
      : 'no pairs',
    sidecar: baked
      ? `${baked.pairs}/${baked.rms}/${baked.p95}/${baked.max}` +
        (baked.pairs === m.pairs && Math.abs(baked.rms - m.rms) < 0.0006 ? '' : ' MISMATCH')
      : 'none',
  });
}
console.log(
  `\n  mirror across ${config.mirrorAxis}, vertices paired within ${cap}mm, ` +
    `residual in mm (warn bar: p95 > CHART_SNAP_MM = ${CHART_SNAP_MM})\n`,
);
console.table(rows);
