import { baseColorHex, state } from '../state/store';
import { nearestFilamentName } from '../state/filaments';
import { getLastAssemblyBuild, holdExport, isExportReady } from '../app/rebuild';
import { whenIdle } from '../app/idle';
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
  'Reposition it in your slicer before printing.',
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
 * Drop any placement message left from a previous export (a smaller printer, or a part swapped back
 * to its verified mesh) so this attempt reports only its own. Callers must re-render afterwards on
 * every path including bail-outs: WARNINGS backs the pills, and mutating it without a render leaves them disagreeing.
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
 * with the left panel byte-identical — a multi-day, multi-kilogram print behind an unlabelled button.
 *
 * Reads the build the viewport already shows (a lookup, not a geometry pass) and the same data
 * `exportPrintReady3MF` writes: kept parts, shipped colours, `resolvePlacement`, plate grouping.
 * Plates are stated only when hints determine them: the greedy packer needs real footprints, and a
 * guessed number is worse than none on the readout checked before committing a spool.
 */
export function renderExportSummary(): void {
  const el = document.querySelector<HTMLElement>('#export-summary');
  if (!el) return;
  // Tied to the button, not the last build: the rebuild doesn't clear `lastAssemblyBuild` when artwork is removed, which left "13 parts · 11 plates" beside an export button that rebuild had just disabled.
  if (!isExportReady()) {
    el.hidden = true;
    return;
  }
  const rows: string[] = [];

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
}

/**
 * Which plate each part is pinned to: the baked placement's hint, except the wheel's rotated
 * duplicate halves (the same mesh again), which each claim the next plate after the primary's.
 * One implementation for the export and the summary promising it — the counter makes a pure
 * per-part lookup impossible, and a copy in the summary would be a second rule.
 */
function platePlan(kept: { part: Parameters<typeof resolvePlacement>[0] }[]): {
  part: Parameters<typeof resolvePlacement>[0];
  resolution: ReturnType<typeof resolvePlacement>;
  plateHint?: number;
}[] {
  let nextHalfPlate = 2;
  // The resolution rides along because resolvePlacement fingerprints the mesh (O(vertices)); this runs every rebuild for the summary, and without returning it the export pays a second pass per part.
  return kept.map(({ part }) => {
    const resolution = resolvePlacement(part);
    const baked = resolution.verified ? resolution.placement.plateHint : undefined;
    const isDuplicateHalf = part.roleId === 'wheel-half' && part.isDuplicateOf != null;
    return { part, resolution, plateHint: isDuplicateHalf ? nextHalfPlate++ : baked };
  });
}

/**
 * The part outputs that will reach the file: one whose pocket cut consumed the whole part has no
 * body to export. Shared with the pre-export summary, which must count the same parts. `report`
 * raises this as a warning from the export while the summary stays silent: it runs every rebuild,
 * and a pill from a passive readout would arrive with no action behind it.
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
 * The last guardrail before an incomplete-coverage chair export downloads: rebuild.ts shows an info
 * pill the whole time it's true, easy to have scrolled past by Export. Escalated to warn() as the
 * last moment before the file (the gap that caught scripts/export-chair-examples.mjs's own author).
 * Doesn't block: the app's pattern is warn-but-proceed (see the missing-geometry filter below), and
 * a hard block, themed dialog or not, would be a bigger behavior change than intended.
 */
function warnIfIncompleteZoneCoverage(): void {
  for (let i = WARNINGS.length - 1; i >= 0; i--) {
    if (WARNINGS[i].message.endsWith(COVERAGE_WARNING_SUFFIX)) WARNINGS.splice(i, 1);
  }
  const { total, covered } = zoneCoverage();
  if (total > 1 && covered < total) {
    warn(
      `Exporting with artwork on ${covered} of ${total} zones. The other ${total - covered} ` +
        (total - covered === 1 ? 'zone ' : 'zones ') +
        COVERAGE_WARNING_SUFFIX,
    );
  }
}

export async function exportPrintReady3MF(): Promise<void> {
  const bodyColor = baseColorHex().toUpperCase();
  // captured now, not read at track() time: the export button disables during the awaits but #shape-kind doesn't, so state.assembly.kindId can move mid-export
  const exportedKindId = state.assembly.kindId;

  const built = getLastAssemblyBuild();
  if (!built || !built.partOutputs.length) return;
  clearStalePlacementNotices();
  warnIfIncompleteZoneCoverage();
  const palette = built.palette;
  const kept = keptPartOutputs(built, (msg) => warn(msg));
  // Only palette colors with an inlay on some exported part become materials; one whose regions all
  // fell off would ship as a filament nothing references, costing an AMS slot (the build warns naming such colors).
  const shipped = shippedColorIndices(kept);
  const matIndexByColor = new Map<number, number>();
  const materials: ExportMaterial[] = [{ name: 'Body', color: bodyColor }];
  palette.forEach((p, ci) => {
    if (!shipped.has(ci)) return;
    matIndexByColor.set(ci, materials.length);
    materials.push({ name: nearestFilamentName(p.hex), color: p.hex });
  });
  // Plate layout comes from PLACEMENT — verified constants, not computed. platePlan applies it and the pre-export summary reads the same plan, so they can't disagree.
  const plan = platePlan(kept);
  const parts: ExportPart[] = kept.map(
    ({ part, bodySoup, inlaySoups, bodyIndexed, inlayIndexed }, i) => {
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
    },
  );
  const fname = `mosaic-${state.assembly.kindId}.3mf`;

  // the color list posts this live; re-run against the export's own material count, the authoritative one
  refreshSlotBudgetNotice(materials.length);
  const curtain = showOverlay('Exporting print-ready 3MF…');
  await new Promise((r) => setTimeout(r, 10));
  try {
    const printer = getPrinter(state.printerId);
    const { blob, warnings: placementWarnings } = await build3MFCombined(materials, parts, {
      printer,
    });
    placementWarnings.forEach((msg) => warn(msg));
    track('export', {
      format: '3mf',
      mode: 'assembly',
      printer: state.printerId,
      colors: materials.length - 1,
      warnings: placementWarnings.length,
      ...(exportedKindId ? { kind: exportedKindId } : {}),
    });
    download(blob, fname);
  } catch (e) {
    console.error(e);
    track('export_failed', { format: '3mf' });
    await alertDialog('Export failed: ' + (e as Error).message);
  }
  // outside the try: the per-part messages above were emitted before it, so a failed build still has to render them rather than leave the previous attempt's pills
  renderWarnings();
  hideOverlay(curtain);
}

/**
 * Guards the export button against re-entrancy. Confirmed live (5 rapid clicks on #btn-export): it
 * had no guard, and every click ran its own full export and download. The flag is the guard,
 * checked before the export starts. The button is held off from the click to the end (holdExport),
 * so a rebuild finishing during the wait can't re-enable a button whose clicks would be ignored.
 */
let exporting = false;

async function guardExport(run: () => Promise<void>): Promise<void> {
  if (exporting) return;
  exporting = true;
  holdExport(true);
  try {
    // A rebuild in flight would pair the last build's meshes with settings already changed (body
    // colour, kind, part angles). After it, they agree, or the build failed and there's no export.
    await whenIdle();
    if (isExportReady()) await run();
  } finally {
    exporting = false;
    holdExport(false);
  }
}

export function initExportPanel(): void {
  $<HTMLSelectElement>('#p-printer').addEventListener('change', (e) => {
    state.printerId = (e.target as HTMLSelectElement).value;
    // Affects geometry only through a kind whose build parameter is bounded by the plate (the
    // hubcap diameter) — clampBuildParamToPrinter regenerates then and is a no-op otherwise. It's
    // also the one state change needing its own autosave trigger and slot-count redraw, not a rebuild's.
    void clampBuildParamToPrinter();
    // Every placement message names a bed, plate size or verified pose, so a printer switch invalidates all of them. They were cleared only by the *next* export, leaving pills naming a 350x320mm plate over a part on a 256mm bed.
    clearStalePlacementNotices();
    // re-posts the slot-budget pill against the new printer's numbers as well as redrawing the line
    refreshSlotCountCapacity();
    renderExportSummary();
    renderWarnings();
    schedulePersist();
  });
  const exportBtn = $<HTMLButtonElement>('#btn-export');
  exportBtn.addEventListener('click', () => void guardExport(exportPrintReady3MF));
}
