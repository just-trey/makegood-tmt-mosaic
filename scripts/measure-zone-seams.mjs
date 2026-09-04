/**
 * Whether two zones' charts meet, and how well one registers onto the other across the join, off
 * the SHIPPED sidecar and part files. Answers the question a whole-chair sheet turns on: a design
 * can only be cut across a seam where the two zones abut AND a rigid move takes one chart's UV onto
 * the other's within the slack a chart already tolerates. Read the SHARED-vertex fit for that
 * verdict: the nearest-point one pairs A's boundary with whatever B has within SEAM_FIT_MM, which
 * off the seam is not the same place at all. Shared means coincident within the config's weld
 * tolerance, so two zones meeting across a printed seam count as meeting.
 *
 * Reading, the nearest-point search and the Procrustes fit are the bake's own (`read3MFIndexed`,
 * `nearestPoints`, `procrustesFit`, `measureZoneSeam` in lib/zonebake.mjs), not re-implemented: a
 * measurement script that computes its figure a second way IS a second figure.
 *
 * Usage:
 *   npx vite-node scripts/measure-zone-seams.mjs [public/stl/chair-body-zones.json] \
 *     [--config scripts/zone-configs/chair-body.json]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  measureZoneSeam,
  SEAM_FIT_MM,
  SEAM_GAP_BUCKETS_MM,
  sharedVertTolMm,
  zoneSeamPoints,
} from './lib/zonebake.mjs';
import { configPartVerts } from './lib/zoneparts.mjs';
import { CHART_SNAP_MM } from '../src/geometry/conformal.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const cfgIdx = args.indexOf('--config');
const configPath = cfgIdx >= 0 ? args[cfgIdx + 1] : 'scripts/zone-configs/chair-body.json';
if (!configPath) {
  console.error('--config needs a path');
  process.exit(1);
}
/**
 * Which of the two files this is. The positional argument here is the SIDECAR where
 * measure-zone-mirror.mjs takes the CONFIG, and handing over the wrong one used to die deep in the
 * walk on "zone.charts is not iterable", which names neither file.
 */
const kindOf = (o) =>
  Array.isArray(o?.zones) && o.zones.every((z) => Array.isArray(z.charts))
    ? 'sidecar'
    : Array.isArray(o?.parts) && Array.isArray(o?.zones)
      ? 'config'
      : 'neither';
const readJSON = (rel) => {
  const o = JSON.parse(fs.readFileSync(path.resolve(REPO, rel), 'utf8'));
  return { rel, o, kind: kindOf(o) };
};
const insist = (f, want) => {
  if (f.kind === want) return f.o;
  console.error(
    `${f.rel} is a zone ${f.kind === 'neither' ? 'file this script does not recognise' : f.kind}, ` +
      `and this script wants the ${want}. Usage: measure-zone-seams.mjs ` +
      `[public/stl/<kind>-zones.json] [--config scripts/zone-configs/<kind>.json]`,
  );
  process.exit(1);
};
const config = insist(readJSON(configPath), 'config');
const sidecarPath =
  args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--config') ??
  `public/stl/${config.kindId}-zones.json`;
const sidecar = insist(readJSON(sidecarPath), 'sidecar');

const vertsOf = await configPartVerts(config, REPO);

const sharedTol = sharedVertTolMm(config);
const pts = new Map(sidecar.zones.map((z) => [z.id, zoneSeamPoints(z, vertsOf)]));
const fmt = (x, dp) => (x === null || x === undefined ? '-' : x.toFixed(dp));
/** Why there is no fit: under 3 pairs a similarity passes through them all and scores a fake 0. */
const noFit = (pairs) => (pairs < 3 ? `n < 3 (${pairs})` : '-');
const rows = [];
for (const a of sidecar.zones)
  for (const b of sidecar.zones) {
    if (a.id === b.id) continue;
    const m = measureZoneSeam(pts.get(a.id), pts.get(b.id), sharedTol);
    rows.push({
      seam: `${a.id} -> ${b.id}`,
      [`within ${SEAM_GAP_BUCKETS_MM.join(' / ')}mm`]: `${m.counts.join(' / ')} of ${m.of}`,
      'median gap': fmt(m.medianMm, 1),
      shared: m.shared,
      'rigid (deg, rms, p95, max)': m.rigid
        ? `${fmt(m.rigid.thetaDeg, 2)}, ${fmt(m.rigid.rms, 2)}, ${fmt(m.rigid.p95, 2)}, ` +
          `${fmt(m.rigid.max, 2)} (${m.rigid.n})`
        : noFit(m.counts[2]),
      'similarity (deg, scale, rms)': m.similarity
        ? `${fmt(m.similarity.thetaDeg, 2)}, x${fmt(m.similarity.scale, 4)}, ` +
          `${fmt(m.similarity.rms, 2)}`
        : noFit(m.counts[2]),
      'shared rigid (deg, rms, p95, max)': m.sharedRigid
        ? `${fmt(m.sharedRigid.thetaDeg, 2)}, ${fmt(m.sharedRigid.rms, 2)}, ` +
          `${fmt(m.sharedRigid.p95, 2)}, ${fmt(m.sharedRigid.max, 2)}`
        : noFit(m.shared),
      // The scale is the point of this one: a net attaches sheets by rotation and translation
      // only, so a shared seam whose best fit wants to resize is not one a design can cross.
      'shared similarity (deg, scale, rms)': m.sharedSimilarity
        ? `${fmt(m.sharedSimilarity.thetaDeg, 2)}, x${fmt(m.sharedSimilarity.scale, 4)}, ` +
          `${fmt(m.sharedSimilarity.rms, 2)}`
        : noFit(m.shared),
    });
  }
console.log(
  `\n  ${sidecarPath}: A's chart-boundary vertices against B's surface, fits on the pairs ` +
    `within ${SEAM_FIT_MM}mm, shared = coincident within ${sharedTol.samePartMm}mm on one part ` +
    `/ ${sharedTol.crossPartMm}mm across parts\n  (a design crosses a seam only where the SHARED ` +
    `rigid p95 is under CHART_SNAP_MM = ${CHART_SNAP_MM})\n`,
);
console.table(rows);
