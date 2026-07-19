import { baseColorHex, state } from '../state/store';
import { nearestFilamentName } from '../state/filaments';
import { getLastAssemblyBuild, getLastBuild } from '../app/rebuild';
import { asmPartFaceNormal } from '../geometry/assembly';
import {
  build3MFCombined,
  WHEEL_TOP_ROT_DEG,
  WHEEL_TOP_POS,
  WHEEL_CAP_ROT_DEG,
  WHEEL_CAP_POS,
  WHEEL_PRIME_TOWER_DELTA,
  FOOTREST_PLATE_R,
  FOOTREST_PRIME_TOWER_DELTA,
  type ExportMaterial,
  type ExportPart,
  type ExportSub,
} from '../export/threemf';
import { getPrinter } from '../export/printers';
import { meshToSTLBytes, soupFromObject } from '../export/stl';
import { zipStore, type ZipEntry } from '../export/zip';
import { hideOverlay, showOverlay } from './overlay';
import { $ } from './dom';
import { WARNINGS, warn } from '../warnings';
import { renderWarnings } from './warningsView';
import { track } from '../analytics/track';

// suffixes of the two placement-warning messages build3MFCombined can emit — used to clear a
// stale one from a previous export attempt before reporting this attempt's
const PLACEMENT_WARNING_SUFFIXES = [
  'even at its best-fit rotation.',
  'double-check for overlap in your slicer.',
];

function download(blob: Blob, fname: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
}

async function exportPrintReady3MF(): Promise<void> {
  let materials: ExportMaterial[], parts: ExportPart[], fname: string;
  const bodyColor = baseColorHex().toUpperCase();

  if (state.shapeKind === 'assembly') {
    const built = getLastAssemblyBuild();
    if (!built || !built.partOutputs.length) return;
    const palette = built.palette;
    materials = [{ name: 'Body', color: bodyColor }].concat(
      palette.map((p) => ({ name: nearestFilamentName(p.hex), color: p.hex })),
    );
    // wheel-specific plate layout: the primary "top" half + the "cap" share plate 1, each
    // rotated-duplicate "top" (the wheel's other half) gets its own subsequent plate. Rotation
    // and position are fixed constants taken from a real, tested MakeGood TMT export (see
    // WHEEL_TOP_POS/WHEEL_CAP_POS in src/export/threemf.ts) — not computed, since the wheel's
    // geometry and required orientation are a specific, externally-verified product.
    let nextHalfPlate = 2;
    parts = built.partOutputs
      .filter((o) => o.bodySoup && o.bodySoup.length)
      .map(({ part, bodySoup, inlaySoups, bodyIndexed, inlayIndexed }) => {
        const nrm = asmPartFaceNormal(part, state.assembly.parts);
        const nsign = nrm && nrm[1] < 0 ? -1 : 1;
        const subs: ExportSub[] = [
          { name: 'Body', matIndex: 0, soup: bodySoup, indexed: bodyIndexed },
        ];
        Object.entries(inlaySoups).forEach(([ci, soup]) => {
          subs.push({
            name: nearestFilamentName(palette[+ci].hex),
            matIndex: +ci + 1,
            soup,
            indexed: inlayIndexed?.[+ci],
          });
        });
        let plateHint: number | undefined,
          rotZdeg: number | undefined,
          plateR: number[][] | undefined,
          fixedPos: { x: number; y: number } | undefined,
          primeTowerDelta: { x: number; y: number } | undefined,
          objectSettings: Record<string, string> | undefined;
        if (part.roleId === 'top') {
          plateHint = part.isDuplicateOf == null ? 1 : nextHalfPlate++;
          rotZdeg = WHEEL_TOP_ROT_DEG;
          fixedPos = WHEEL_TOP_POS;
          primeTowerDelta = WHEEL_PRIME_TOWER_DELTA;
        } else if (part.roleId === 'cap') {
          plateHint = 1;
          rotZdeg = WHEEL_CAP_ROT_DEG;
          fixedPos = WHEEL_CAP_POS;
        } else if (part.roleId === 'footrest') {
          // place the footrest at its verified reference pose (standing rotation baked from its
          // reference 3MF — see FOOTREST_PLATE_R). No fixedPos: plateHint routes it through
          // placeHintedGroup, whose no-fixedPos branch centers it on every plate, with the prime
          // tower held relative (FOOTREST_PRIME_TOWER_DELTA). Support off + no brim per the user's
          // verified reference.
          plateHint = 1;
          plateR = FOOTREST_PLATE_R;
          primeTowerDelta = FOOTREST_PRIME_TOWER_DELTA;
          objectSettings = { brim_type: 'no_brim', enable_support: '0' };
        }
        return {
          name: part.name,
          nsign,
          bodySoup,
          subs,
          plateHint,
          rotZdeg,
          plateR,
          fixedPos,
          primeTowerDelta,
          objectSettings,
        };
      });
    fname = `mosaic-${state.assembly.kindId}.3mf`;
  } else {
    const built = getLastBuild();
    if (!built) return;
    // flat-plate mode: the already-built slab-stack body + per-color plugs become one
    // multi-part object. nsign 0 = exported upright, no face-down tilt — the design face
    // is already +Z and the underside already sits at Z=0.
    materials = [{ name: 'Body', color: bodyColor }].concat(
      built.colorMeshes.map((c) => ({
        name: c.isBackground ? 'Background' : nearestFilamentName(c.color),
        color: c.color,
      })),
    );
    const bodySoup = soupFromObject(built.baseGroup);
    const subs = [{ name: 'Body', matIndex: 0, soup: bodySoup }].concat(
      built.colorMeshes.map((c, i) => ({
        name: materials[i + 1].name,
        matIndex: i + 1,
        soup: soupFromObject(c.mesh),
      })),
    );
    parts = [{ name: 'Mosaic plate', nsign: 0, bodySoup, subs }];
    fname = 'mosaic-plate.3mf';
  }

  showOverlay('Exporting print-ready 3MF…');
  await new Promise((r) => setTimeout(r, 10));
  try {
    const printer = getPrinter(state.printerId);
    const { blob, warnings: placementWarnings } = await build3MFCombined(materials, parts, {
      printer,
    });
    // drop any stale placement warning from a previous export (e.g. a smaller printer) before
    // reporting this attempt's — otherwise a fixed/switched export still shows an old warning
    for (let i = WARNINGS.length - 1; i >= 0; i--) {
      if (PLACEMENT_WARNING_SUFFIXES.some((s) => WARNINGS[i].message.endsWith(s)))
        WARNINGS.splice(i, 1);
    }
    placementWarnings.forEach((msg) => warn(msg));
    renderWarnings();
    track('export', {
      format: '3mf',
      mode: state.shapeKind === 'assembly' ? 'assembly' : 'flat',
      printer: state.printerId,
      colors: materials.length - 1,
      warnings: placementWarnings.length,
    });
    download(blob, fname);
  } catch (e) {
    console.error(e);
    track('export_failed', { format: '3mf' });
    alert('Export failed: ' + (e as Error).message);
  }
  hideOverlay();
}

async function exportSTLSet(): Promise<void> {
  const built = getLastBuild();
  if (!built) return;
  showOverlay('Exporting STL set…');
  await new Promise((r) => setTimeout(r, 10));
  try {
    const files: ZipEntry[] = [{ name: 'base.stl', data: meshToSTLBytes(built.baseGroup) }];
    built.colorMeshes.forEach((c, idx) => {
      let label: string;
      if (c.isBackground) label = 'background';
      else if (c.isMergeGroup)
        label = 'merged_' + c.members.map((h) => h.replace('#', '')).join('+');
      else label = c.color.replace('#', '');
      files.push({
        name: `color_${String(idx + 1).padStart(2, '0')}_${label}.stl`,
        data: meshToSTLBytes(c.mesh),
      });
    });
    const readme = `Mosaic for TMT export
======================
${built.colorMeshes.length} color STL(s) + base.stl (uncut plate body).

Bambu Studio workflow:
1. File > Import > import all STLs from this folder as separate objects.
2. Select all imported objects, right-click > "Assemble" (or drag them onto one another) so they share one build plate position and register as one multi-part object.
3. In the object list, click each part and assign it a filament / AMS slot from the color swatch.
4. Slice as normal — Bambu Studio will generate the per-color toolpaths and AMS color changes automatically.

Generated by TMT Mosaic, a MakeGood tool for the Toddler Mobility Trainer
(TMT) — makegood.design / 3d-mobility.org. A browser-based tool, not
affiliated with Bambu Lab.
`;
    files.push({ name: 'README.txt', data: new TextEncoder().encode(readme) });
    const blob = zipStore(files);
    track('export', {
      format: 'stl_zip',
      mode: 'flat',
      printer: state.printerId,
      colors: built.colorMeshes.length,
    });
    download(blob, 'mosaic-export.zip');
  } catch (e) {
    console.error(e);
    track('export_failed', { format: 'stl_zip' });
    alert('Export failed: ' + (e as Error).message);
  }
  hideOverlay();
}

export function initExportPanel(): void {
  $<HTMLSelectElement>('#p-printer').addEventListener('change', (e) => {
    state.printerId = (e.target as HTMLSelectElement).value;
  });
  $('#btn-export').addEventListener('click', () => void exportPrintReady3MF());
  $('#btn-export-stl').addEventListener('click', () => void exportSTLSet());
}
