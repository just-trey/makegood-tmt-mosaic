import { baseColorHex, state } from '../state/store';
import { nearestFilamentName } from '../state/filaments';
import { getLastAssemblyBuild, getLastBuild } from '../app/rebuild';
import { asmPartFaceNormal } from '../geometry/assembly';
import {
  build3MFCombined,
  type ExportMaterial,
  type ExportPart,
  type ExportSub,
} from '../export/threemf';
import { placementNotice, resolvePlacement } from '../export/placement';
import { getPrinter } from '../export/printers';
import { meshToSTLBytes, soupFromObject } from '../export/stl';
import { zipStore, type ZipEntry } from '../export/zip';
import { hideOverlay, showOverlay } from './overlay';
import { $ } from './dom';
import { WARNINGS, warn, notice } from '../warnings';
import { renderWarnings } from './warningsView';
import { track } from '../analytics/track';

// suffixes of the placement-related messages this module and build3MFCombined can emit — used to
// clear a stale one from a previous export attempt before reporting this attempt's
const PLACEMENT_WARNING_SUFFIXES = [
  'even at its best-fit rotation.',
  'double-check for overlap in your slicer.',
  'reposition it in your slicer before printing.',
  'move the tower in your slicer.',
  // placementNotice's mesh-identity guard — every variant of it ends this way, which
  // tests/placement.test.ts pins so a reworded message can't silently stop being cleared
  'placed automatically — check it in your slicer before printing.',
];

function download(blob: Blob, fname: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
}

/**
 * Drop any placement message left over from a previous export attempt (a smaller printer, or a part
 * since swapped back to its verified library mesh) so this attempt reports only its own. Callers
 * must re-render afterwards on every path, including the ones that bail — WARNINGS is the model
 * behind the on-screen pills, and mutating it without a render leaves the two disagreeing.
 */
function clearStalePlacementNotices(): void {
  for (let i = WARNINGS.length - 1; i >= 0; i--) {
    if (PLACEMENT_WARNING_SUFFIXES.some((s) => WARNINGS[i].message.endsWith(s)))
      WARNINGS.splice(i, 1);
  }
}

export async function exportPrintReady3MF(): Promise<void> {
  let materials: ExportMaterial[], parts: ExportPart[], fname: string;
  const bodyColor = baseColorHex().toUpperCase();

  if (state.shapeKind === 'assembly') {
    const built = getLastAssemblyBuild();
    if (!built || !built.partOutputs.length) return;
    clearStalePlacementNotices();
    const palette = built.palette;
    materials = [{ name: 'Body', color: bodyColor }].concat(
      palette.map((p) => ({ name: nearestFilamentName(p.hex), color: p.hex })),
    );
    // Plate layout comes from PLACEMENT above — verified constants, not computed. The wheel's
    // primary "top" half + "cap" share plate 1; each rotated-duplicate "top" (the wheel's other
    // half) claims the next plate after that, which is the counter here.
    let nextHalfPlate = 2;
    parts = built.partOutputs
      .filter((o) => {
        if (o.bodySoup.length) return true;
        warn(
          `Part "${o.part.name}" has no geometry to export — its pocket cut went all the way ` +
            `through, likely because its depth exceeds the wall thickness there.`,
        );
        return false;
      })
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
        const resolution = resolvePlacement(part);
        const note = placementNotice(part.name, resolution);
        if (note) (note.level === 'warn' ? warn : notice)(note.message);
        return {
          name: part.name,
          nsign,
          bodySoup,
          subs,
          ...(resolution.verified ? resolution.placement : {}),
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
    clearStalePlacementNotices();
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
    placementWarnings.forEach((msg) => warn(msg));
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
  // outside the try: the per-part messages above were emitted before it, so a failed build still
  // has to render them rather than leaving the pills showing the previous attempt's
  renderWarnings();
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
