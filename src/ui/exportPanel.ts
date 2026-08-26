import { baseColorHex, state } from '../state/store';
import { nearestFilamentName } from '../state/filaments';
import { getLastAssemblyBuild, getLastBuild } from '../app/rebuild';
import { asmPartFaceNormal, shippedColorIndices } from '../geometry/assembly';
import {
  build3MFCombined,
  groupByPlateHint,
  partsCarryPlateHints,
  type ExportMaterial,
  type ExportPart,
  type ExportSub,
} from '../export/threemf';
import { placementNotice, resolvePlacement } from '../export/placement';
import { zoneCoverage } from '../state/artwork';
import { getPrinter } from '../export/printers';
import { clampBuildParamToPrinter } from './assemblyPanel';
import { refreshSlotCountCapacity } from './colorList';
import { refreshSlotBudgetNotice } from './slotBudget';
import { meshToSTLBytes, soupFromObject } from '../export/stl';
import { zipStore, type ZipEntry } from '../export/zip';
import { hideOverlay, showOverlay } from './overlay';
import { $ } from './dom';
import { WARNINGS, warn, notice } from '../warnings';
import { schedulePersist } from '../state/persist';
import { renderWarnings } from './warningsView';
import { track } from '../analytics/track';
import { alertDialog } from './dialogs';

// suffixes of the placement-related messages this module and build3MFCombined can emit — used to
// clear a stale one from a previous export attempt before reporting this attempt's
export const PLACEMENT_WARNING_SUFFIXES = [
  'even at its best-fit rotation.',
  'double-check for overlap in your slicer.',
  'reposition it in your slicer before printing.',
  // both arms of the blocked-tower message (threemf.ts), which differ by whether a position
  // was saved at all
  'so your slicer will place it. Check it before printing.',
  'so move the tower in your slicer.',
  // placementNotice's mesh-identity guard — every variant of it ends this way, which
  // tests/placement.test.ts pins so a reworded message can't silently stop being cleared
  'placed automatically. Check it in your slicer before printing.',
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
export function clearStalePlacementNotices(): void {
  for (let i = WARNINGS.length - 1; i >= 0; i--) {
    if (PLACEMENT_WARNING_SUFFIXES.some((s) => WARNINGS[i].message.endsWith(s)))
      WARNINGS.splice(i, 1);
  }
}

const COVERAGE_WARNING_SUFFIX = 'will print body-colored with no design.';

/**
 * What the export will contain, stated before the button is pressed (convention 24).
 *
 * The measured gap: exporting the chair produced a 34 MB, 11-plate, 13-object, 5-filament file
 * with the left panel byte-identical before and after. That is a multi-day, multi-kilogram print
 * behind an unlabelled button.
 *
 * Reads the build the viewport is already showing, so it costs a lookup rather than a pass over
 * geometry, and it is the same data `exportPrintReady3MF` writes: the same kept parts, the same
 * shipped colours, the same `resolvePlacement` and the same plate-grouping rule.
 *
 * Plates are stated only when hints determine them. The greedy packer needs real footprints, and a
 * number this panel guessed would be worse than no number on the one readout a volunteer checks
 * before committing a spool.
 */
export function renderExportSummary(): void {
  const el = document.querySelector<HTMLElement>('#export-summary');
  if (!el) return;
  // Tied to the button it describes, rather than to the last build: neither rebuild path clears
  // `lastBuild` when the artwork is removed, so reading the build alone left "13 parts · 11
  // plates" sitting beside an export button that same rebuild had just disabled.
  if ($<HTMLButtonElement>('#btn-export').disabled) {
    el.hidden = true;
    return;
  }
  const rows: string[] = [];

  if (state.shapeKind === 'assembly') {
    const built = getLastAssemblyBuild();
    const kept = built ? keptPartOutputs(built) : [];
    if (!kept.length) {
      el.hidden = true;
      return;
    }
    const shipped = shippedColorIndices(kept);
    const filaments = [
      { name: 'Body', hex: baseColorHex() },
      ...built!.palette.flatMap((p, ci) =>
        shipped.has(ci) ? [{ name: nearestFilamentName(p.hex), hex: p.hex }] : [],
      ),
    ];
    const hinted = platePlan(kept).map((h) => ({ name: h.part.name, plateHint: h.plateHint }));
    rows.push(`${kept.length} part${kept.length === 1 ? '' : 's'}`);
    if (partsCarryPlateHints(hinted)) {
      const plates = groupByPlateHint(hinted, (h) => h.plateHint);
      rows.push(`${plates.length} plate${plates.length === 1 ? '' : 's'}`);
      el.dataset.plates = plates.map((pl) => pl.map((h) => h.name).join(', ')).join(' | ');
    } else {
      delete el.dataset.plates;
    }
    rows.push(`${filaments.length} filament${filaments.length === 1 ? '' : 's'}`);
    el.innerHTML =
      `<div class="export-summary-line">${rows.join(' · ')}</div>` +
      `<div class="export-summary-swatches">${filaments
        .map(
          (f) =>
            `<span class="export-summary-swatch" style="background:${f.hex}" title="${f.name}"></span>`,
        )
        .join('')}</div>` +
      (el.dataset.plates
        ? `<div class="export-summary-plates">${el.dataset.plates
            .split(' | ')
            .map((p, i) => `Plate ${i + 1}: ${p}`)
            .join('<br>')}</div>`
        : '');
    el.hidden = false;
    return;
  }

  const built = getLastBuild();
  if (!built) {
    el.hidden = true;
    return;
  }
  const filaments = [
    { name: 'Body', hex: baseColorHex() },
    ...built.colorMeshes.map((c) => ({
      name: c.isBackground ? 'Background' : nearestFilamentName(c.color),
      hex: c.color,
    })),
  ];
  el.innerHTML =
    `<div class="export-summary-line">1 plate · ${filaments.length} filament${
      filaments.length === 1 ? '' : 's'
    }</div>` +
    `<div class="export-summary-swatches">${filaments
      .map(
        (f) =>
          `<span class="export-summary-swatch" style="background:${f.hex}" title="${f.name}"></span>`,
      )
      .join('')}</div>`;
  el.hidden = false;
}

/**
 * Which plate each part is pinned to: the baked placement's hint, except the wheel's rotated
 * duplicate halves, which are the same mesh again and each claim the next plate after the
 * primary's.
 *
 * One implementation, used by the export and by the summary that promises what the export will do.
 * The counter is why this cannot be a pure per-part lookup, and why a copy in the summary would
 * have been a second rule rather than the same one.
 */
function platePlan(kept: { part: Parameters<typeof resolvePlacement>[0] }[]): {
  part: Parameters<typeof resolvePlacement>[0];
  resolution: ReturnType<typeof resolvePlacement>;
  plateHint?: number;
}[] {
  let nextHalfPlate = 2;
  // The resolution rides along because resolvePlacement fingerprints the part mesh, an O(vertices)
  // scan. This runs on every rebuild for the summary; without returning it the export would pay
  // for a second pass per part on top.
  return kept.map(({ part }) => {
    const resolution = resolvePlacement(part);
    const baked = resolution.verified ? resolution.placement.plateHint : undefined;
    const isDuplicateHalf = part.roleId === 'wheel-half' && part.isDuplicateOf != null;
    return { part, resolution, plateHint: isDuplicateHalf ? nextHalfPlate++ : baked };
  });
}

/**
 * The part outputs that will actually reach the file: one whose pocket cut consumed the whole part
 * has no body left to export.
 *
 * Shared with the pre-export summary below, which must count the same parts the export will write.
 * `report` is how the export raises this as a warning and the summary stays silent — the summary
 * runs on every rebuild, and a pill posted from a passive readout would arrive with no action
 * behind it.
 */
function keptPartOutputs(
  built: NonNullable<ReturnType<typeof getLastAssemblyBuild>>,
  report?: (msg: string) => void,
): typeof built.partOutputs {
  return built.partOutputs.filter((o) => {
    if (o.bodySoup.length) return true;
    report?.(
      `Part "${o.part.name}" has no geometry to export. Its pocket cut went all the way ` +
        `through, likely because its depth exceeds the wall thickness there.`,
    );
    return false;
  });
}

/**
 * The last guardrail before an incomplete-coverage chair export downloads: rebuild.ts already
 * surfaces this as an info pill the whole time it's true, but that pill is easy to have scrolled
 * past by the time the user reaches Export. Escalated to warn() here rather than notice() because
 * this is the last moment before the file — the same coverage gap that caught
 * scripts/export-chair-examples.mjs's own author. Doesn't block the export: the app's pattern
 * throughout is warn-but-proceed (see the missing-geometry filter below) — a hard block on every
 * incomplete-coverage export, themed dialog or not, would be a bigger behavior change than this
 * warning is trying to make.
 */
function warnIfIncompleteZoneCoverage(): void {
  for (let i = WARNINGS.length - 1; i >= 0; i--) {
    if (WARNINGS[i].message.endsWith(COVERAGE_WARNING_SUFFIX)) WARNINGS.splice(i, 1);
  }
  const { total, covered } = zoneCoverage();
  if (total > 1 && covered < total) {
    warn(
      `Exporting with artwork on ${covered} of ${total} zones, ${total - covered} ` +
        (total - covered === 1 ? 'zone ' : 'zones ') +
        COVERAGE_WARNING_SUFFIX,
    );
  }
}

export async function exportPrintReady3MF(): Promise<void> {
  let materials: ExportMaterial[], parts: ExportPart[], fname: string;
  const bodyColor = baseColorHex().toUpperCase();

  if (state.shapeKind === 'assembly') {
    const built = getLastAssemblyBuild();
    if (!built || !built.partOutputs.length) return;
    clearStalePlacementNotices();
    warnIfIncompleteZoneCoverage();
    const palette = built.palette;
    const kept = keptPartOutputs(built, (msg) => warn(msg));
    // Only palette colors with an inlay on some exported part become materials. A color whose
    // regions all fell off the parts would otherwise ship as a filament nothing references,
    // costing the user an AMS slot that prints nothing (the build warns naming such colors).
    const shipped = shippedColorIndices(kept);
    const matIndexByColor = new Map<number, number>();
    materials = [{ name: 'Body', color: bodyColor }];
    palette.forEach((p, ci) => {
      if (!shipped.has(ci)) return;
      matIndexByColor.set(ci, materials.length);
      materials.push({ name: nearestFilamentName(p.hex), color: p.hex });
    });
    // Plate layout comes from PLACEMENT — verified constants, not computed. platePlan applies it,
    // and the pre-export summary reads the same plan so the two cannot disagree about what the
    // file will contain.
    const plan = platePlan(kept);
    parts = kept.map(({ part, bodySoup, inlaySoups, bodyIndexed, inlayIndexed }, i) => {
      const nrm = asmPartFaceNormal(part, state.assembly.parts);
      const nsign = nrm && nrm[1] < 0 ? -1 : 1;
      const subs: ExportSub[] = [
        { name: 'Body', matIndex: 0, soup: bodySoup, indexed: bodyIndexed },
      ];
      Object.entries(inlaySoups).forEach(([ci, soup]) => {
        subs.push({
          name: nearestFilamentName(palette[+ci].hex),
          matIndex: matIndexByColor.get(+ci)!,
          soup,
          indexed: inlayIndexed?.[+ci],
        });
      });
      const { resolution } = plan[i];
      const note = placementNotice(part.name, resolution);
      if (note) (note.level === 'warn' ? warn : notice)(note.message);
      return {
        name: part.name,
        nsign,
        bodySoup,
        subs,
        ...(resolution.verified ? resolution.placement : {}),
        ...(plan[i].plateHint != null ? { plateHint: plan[i].plateHint } : {}),
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

  // the color list already posts this live; re-run it here against the export's own material count,
  // which is the authoritative one
  refreshSlotBudgetNotice(materials.length);
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
    await alertDialog('Export failed: ' + (e as Error).message);
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
2. Select all imported objects, then right-click > "Assemble" (or drag them together).
   That gives them one build plate position, as a single multi-part object.
3. In the object list, click each part and assign it a filament / AMS slot from the color swatch.
4. Slice as normal. Bambu Studio will generate the per-color toolpaths and AMS color changes automatically.

Generated by TMT Mosaic, a MakeGood tool for the Toddler Mobility Trainer
(TMT): makegood.design / 3d-mobility.org. A browser-based tool, not
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
    await alertDialog('Export failed: ' + (e as Error).message);
  }
  hideOverlay();
}

/**
 * Guards both export buttons against re-entrancy — confirmed live (5 rapid clicks on #btn-export)
 * that neither export function had any guard at all: every click ran its own full export and
 * download, independent of any already in flight. The flag is the actual guard, checked before
 * either export starts; the `disabled` toggle on top is only a visual affordance during the
 * export, not the mechanism — rebuild.ts owns #btn-export's disabled state the rest of the time
 * (enabled/disabled based on whether the current build has exportable geometry), and this
 * shouldn't fight that ownership by unconditionally forcing it back to enabled once an export
 * that raced with a rebuild finishes.
 */
let exporting = false;

async function guardExport(btn: HTMLButtonElement, run: () => Promise<void>): Promise<void> {
  if (exporting) return;
  exporting = true;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  try {
    await run();
  } finally {
    exporting = false;
    btn.disabled = wasDisabled;
  }
}

export function initExportPanel(): void {
  $<HTMLSelectElement>('#p-printer').addEventListener('change', (e) => {
    state.printerId = (e.target as HTMLSelectElement).value;
    // Affects geometry only through a kind whose build parameter is bounded by the plate (the
    // hubcap's diameter) — clampBuildParamToPrinter regenerates in that one case and is a no-op
    // otherwise. Beyond that this is still the one state change that needs its own explicit
    // autosave trigger rather than piggybacking on rebuildCurrent()'s, and its own slot-count
    // redraw rather than picking one up from a rebuild.
    void clampBuildParamToPrinter();
    // Every placement message names a bed, a plate size or a verified pose, so a printer switch
    // invalidates all of them at once. They used to be cleared only by the *next* export, which
    // left pills naming a 350x320mm plate sitting over a part on a 256mm bed.
    clearStalePlacementNotices();
    // re-posts the slot-budget pill against the new printer's numbers as well as redrawing the line
    refreshSlotCountCapacity();
    renderExportSummary();
    renderWarnings();
    schedulePersist();
  });
  const exportBtn = $<HTMLButtonElement>('#btn-export');
  exportBtn.addEventListener('click', () => void guardExport(exportBtn, exportPrintReady3MF));
  const exportStlBtn = $<HTMLButtonElement>('#btn-export-stl');
  exportStlBtn.addEventListener('click', () => void guardExport(exportStlBtn, exportSTLSet));
}
