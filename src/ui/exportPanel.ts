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
import { CHAIR_PLACEMENT } from '../export/chairPlacement';
import { getPrinter } from '../export/printers';
import { meshToSTLBytes, soupFromObject } from '../export/stl';
import { zipStore, type ZipEntry } from '../export/zip';
import { hideOverlay, showOverlay } from './overlay';
import { $ } from './dom';
import { WARNINGS, warn } from '../warnings';
import { renderWarnings } from './warningsView';
import { track } from '../analytics/track';

// suffixes of the placement-warning messages build3MFCombined can emit — used to clear a
// stale one from a previous export attempt before reporting this attempt's
const PLACEMENT_WARNING_SUFFIXES = [
  'even at its best-fit rotation.',
  'double-check for overlap in your slicer.',
  'reposition it in your slicer before printing.',
  'move the tower in your slicer.',
];

/** The placement fields a part can have baked; the rest of ExportPart comes from the build. */
type PartPlacement = Pick<
  ExportPart,
  | 'plateHint'
  | 'rotZdeg'
  | 'plateR'
  | 'fixedPos'
  | 'primeTowerDelta'
  | 'primeTowerDeltaByPlate'
  | 'objectSettings'
>;

/**
 * Verified plate placement per part, keyed by library part id. Every entry traces back to a
 * project file whose print pose a human checked in the slicer — never computed here. See the
 * constants' own provenance comments in src/export/threemf.ts, and chairPlacement.ts (generated)
 * for the chair's 15.
 *
 * Keyed by library part rather than role because the chair's two caster roles resolve to a
 * different mesh per hardware variant, and Standard and Kit sit on different plates. Roles whose
 * id and library part id coincide (the wheel's and the footrest's) still resolve for a
 * hand-uploaded mesh, via the roleId fallback at the lookup.
 */
const PLACEMENT: Record<string, PartPlacement> = {
  'wheel-half': {
    plateHint: 1,
    rotZdeg: WHEEL_TOP_ROT_DEG,
    fixedPos: WHEEL_TOP_POS,
    primeTowerDelta: WHEEL_PRIME_TOWER_DELTA,
  },
  'wheel-hub-cap': { plateHint: 1, rotZdeg: WHEEL_CAP_ROT_DEG, fixedPos: WHEEL_CAP_POS },
  // Support off per the user's verified reference (brim is off globally — see brim_type in
  // bambuProjectSettings). No fixedPos: the reference's own translation is just the Snapmaker U1's
  // bed center and isn't portable, so plateHint routes it through placeHintedGroup's centering
  // branch with the tower held relative.
  footrest: {
    plateHint: 1,
    plateR: FOOTREST_PLATE_R,
    primeTowerDelta: FOOTREST_PRIME_TOWER_DELTA,
    objectSettings: { enable_support: '0' },
  },
  ...CHAIR_PLACEMENT,
};

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
    // Plate layout comes from PLACEMENT above — verified constants, not computed. The wheel's
    // primary "top" half + "cap" share plate 1; each rotated-duplicate "top" (the wheel's other
    // half) claims the next plate after that, which is the counter here.
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
        const placement = PLACEMENT[part.libraryPartId ?? part.roleId];
        return {
          name: part.name,
          nsign,
          bodySoup,
          subs,
          ...placement,
          // the wheel's rotated duplicate halves are the one placement that can't be a constant:
          // each copy is the same mesh again and claims its own plate after the primary's.
          ...(part.roleId === 'wheel-half' && part.isDuplicateOf != null
            ? { plateHint: nextHalfPlate++ }
            : {}),
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
