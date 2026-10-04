// How many specks under CLIP_REMNANT_FLOOR_MM2 the app's own clip leaves when a design covers a
// whole chart: each one is a "too fine to print" notice on a plain full-bleed design. Counted per
// chart that carries a dead region, which are the charts whose cut region the bake clips.
//
// Usage: npx vite-node scripts/measure-cut-specks.ts [sidecar.json ...]
//   (defaults to public/stl/chair-body-zones.json; pass an older sidecar to compare)
import { readFileSync } from 'node:fs';
import * as turf from '@turf/turf';
import { safeIntersectChecked, dropUnprintableRemnants } from '../src/geometry/regions';
import { CLIP_REMNANT_FLOOR_MM2 } from '../src/geometry/depth';
import type { PolyFeature } from '../src/types';

type Region = { outer: number[][]; holes: number[][][] };
type Chart = { libraryPartId: string; cutRegions: Region[]; deadRegions?: Region[] };

const close = (r: number[][]): number[][] =>
  r.length && (r[0][0] !== r.at(-1)![0] || r[0][1] !== r.at(-1)![1]) ? [...r, r[0]] : r;
// Far past any chart's UV, so the clip is the cut region's own outline and nothing else.
const COVER = turf.polygon([
  [
    [-2000, -2000],
    [2000, -2000],
    [2000, 2000],
    [-2000, 2000],
    [-2000, -2000],
  ],
]) as PolyFeature;

const files = process.argv.slice(2);
for (const f of files.length ? files : ['public/stl/chair-body-zones.json']) {
  const sidecar = JSON.parse(readFileSync(f, 'utf8')) as {
    zones: { id: string; charts: Chart[] }[];
  };
  console.log(f);
  let total = 0;
  for (const z of sidecar.zones)
    for (const c of z.charts) {
      if (!(c.deadRegions ?? []).length) continue;
      const cut = turf.multiPolygon(
        c.cutRegions.map((r) => [close(r.outer), ...r.holes.map(close)]),
      ) as PolyFeature;
      const r = safeIntersectChecked(COVER, cut);
      const d = dropUnprintableRemnants(r.feat, CLIP_REMNANT_FLOOR_MM2);
      total += d.dropped;
      console.log(
        `  ${`${z.id}/${c.libraryPartId}`.padEnd(38)} ${String(c.cutRegions.length).padStart(3)} ` +
          `pieces, ${String(d.dropped).padStart(3)} speck(s)${r.clipped ? '' : ' (clip FAILED)'}`,
      );
    }
  console.log(`  ${total} speck(s) in all.`);
}
