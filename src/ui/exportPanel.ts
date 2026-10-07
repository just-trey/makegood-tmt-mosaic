import { baseColorHex, state } from '../state/store';
import { nearestFilamentName } from '../state/filaments';
import {
  exportBlockedReason,
  getLastAssemblyBuild,
  holdExport,
  isExportReady,
} from '../app/rebuild';
import { whenIdle } from '../app/idle';
import { asmPartFaceNormal, shippedColorIndices } from '../geometry/assembly';
import {
  build3MFCombined,
  groupByPlateHint,
  layoutPlates,
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
import { WARNINGS, warn, noticeBuild, warnBuild } from '../warnings';
import { schedulePersist } from '../state/persist';
import { renderWarnings } from './warningsView';
import { track } from '../analytics/track';
import { alertDialog } from './dialogs';

// suffixes of the placement-related messages this module and layoutPlates can emit — used to clear
// the last build's or printer's before stating this one's
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
  // layoutPlates' note for a baked layout on a bed nobody checked it on
  'Check the parts and prime tower in your slicer before printing.',
];

function download(blob: Blob, fname: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
}

/**
 * Drop every placement message standing (another printer, or a part swapped back to its verified
 * mesh) so only the current one's are stated. Callers must re-render afterwards on every path
 * including bail-outs: WARNINGS backs the pills, and mutating it without a render leaves them disagreeing.
 */
export function clearStalePlacementNotices(): void {
  for (let i = WARNINGS.length - 1; i >= 0; i--) {
    if (PLACEMENT_WARNING_SUFFIXES.some((s) => WARNINGS[i].message.endsWith(s)))
      WARNINGS.splice(i, 1);
  }
}

/** The usual hint stands while Export is on, so it is read from the page once rather than duplicated here. */
let defaultHint: string | null = null;

export function renderExportHint(): void {
  const el = document.querySelector<HTMLElement>('#export-hint');
  if (!el) return;
  defaultHint ??= el.textContent;
  el.textContent = exportBlockedReason() ?? defaultHint;
}

export function clearExportStatus(): void {
  const el = document.querySelector<HTMLElement>('#export-status');
  if (!el) return;
  el.textContent = '';
  el.hidden = true;
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))}\u00a0KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)}\u00a0MB`;
}

function showExportStatus(fname: string, plates: number | null, filaments: number, bytes: number) {
  const el = document.querySelector<HTMLElement>('#export-status');
  if (!el) return;
  const bits = [`Saved ${fname}`];
  // non-breaking spaces so a wrapped line never strands a unit from its number
  if (plates) bits.push(`${plates}\u00a0plate${plates === 1 ? '' : 's'}`);
  bits.push(`${filaments}\u00a0filament${filaments === 1 ? '' : 's'}`, formatSize(bytes));
  el.textContent = bits.join(' · ');
  el.hidden = false;
}

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
  const plates = fixedPlates(platePlan(kept));
  rows.push(`${kept.length} part${kept.length === 1 ? '' : 's'}`);
  if (plates) {
    rows.push(`${plates.length} plate${plates.length === 1 ? '' : 's'}`);
    el.dataset.plates = plates.map((pl) => pl.join(', ')).join(' | ');
  } else {
    delete el.dataset.plates;
  }
  rows.push(`${filaments.length} filament${filaments.length === 1 ? '' : 's'}`);
  const { total: zoneTotal, covered: zoneCovered } = zoneCoverage();
  // Beside the button, where the build's standing warning is easy to have scrolled past.
  const coverage =
    zoneTotal > 1 && zoneCovered < zoneTotal
      ? `<div class="export-summary-coverage">Artwork on ${zoneCovered} of ${zoneTotal} zones</div>`
      : '';
  el.innerHTML =
    `<div class="export-summary-line">${rows.join(' · ')}</div>` +
    coverage +
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

/** Part names per plate, or null when the plan doesn't pin plates (the slicer places them then). */
function fixedPlates(plan: ReturnType<typeof platePlan>): string[][] | null {
  const hinted = plan.map((h) => ({ name: h.part.name, plateHint: h.plateHint }));
  if (!partsCarryPlateHints(hinted)) return null;
  return groupByPlateHint(hinted, (h) => h.plateHint).map((pl) => pl.map((h) => h.name));
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

type PlacementNote = { message: string; level: 'warn' | 'info' };

/**
 * The materials and parts the export writes for `built`, and the per-part placement notes. One
 * builder for the export and the notes stated before it, so the two can't disagree. `report` as
 * in keptPartOutputs.
 */
function exportInputs(
  built: NonNullable<ReturnType<typeof getLastAssemblyBuild>>,
  report?: (msg: string) => void,
): {
  materials: ExportMaterial[];
  parts: ExportPart[];
  notes: PlacementNote[];
  plateCount: number | null;
} {
  const palette = built.palette;
  const kept = keptPartOutputs(built, report);
  // Only palette colors with an inlay on some exported part become materials; one whose regions all
  // fell off would ship as a filament nothing references, costing an AMS slot (the build warns naming such colors).
  const shipped = shippedColorIndices(kept);
  const matIndexByColor = new Map<number, number>();
  const materials: ExportMaterial[] = [{ name: 'Body', color: baseColorHex().toUpperCase() }];
  palette.forEach((p, ci) => {
    if (!shipped.has(ci)) return;
    matIndexByColor.set(ci, materials.length);
    materials.push({ name: nearestFilamentName(p.hex), color: p.hex });
  });
  // Plate layout comes from PLACEMENT — verified constants, not computed. platePlan applies it and the pre-export summary reads the same plan, so they can't disagree.
  const plan = platePlan(kept);
  const notes: PlacementNote[] = [];
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
      if (note) notes.push(note);
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
  return { materials, parts, notes, plateCount: fixedPlates(plan)?.length ?? null };
}

const layoutNotes = (layout: { warnings: string[]; notices: string[] }): PlacementNote[] => [
  ...layout.warnings.map((message) => ({ message, level: 'warn' as const })),
  ...layout.notices.map((message) => ({ message, level: 'info' as const })),
];

/** Build-scoped: they describe one build on one printer, so the next pass's clearBuildWarnings drops them with it. */
function postPlacementNotes(notes: PlacementNote[]): void {
  notes.forEach((n) => (n.level === 'warn' ? warnBuild : noticeBuild)(n.message));
}

/**
 * State the placement notes for the build on screen and the selected printer, after every rebuild
 * and printer switch: computed inside the export, they arrived only after the file was saved.
 */
export function refreshPlacementNotices(): void {
  const t0 = performance.now();
  clearStalePlacementNotices();
  const built = getLastAssemblyBuild();
  if (built && isExportReady()) {
    try {
      const { parts, notes } = exportInputs(built);
      postPlacementNotes([
        ...notes,
        ...layoutNotes(layoutPlates(parts, { printer: getPrinter(state.printerId) })),
      ]);
    } catch (e) {
      // A readout must not cost the rebuild; the export runs the same code and reports its own failure.
      console.error(e);
    }
  }
  refreshMs = performance.now() - t0;
  renderWarnings();
}

let refreshMs = 0;
/** The last refreshPlacementNotices' cost, for scripts/bench-placement-notes.mjs (window.__mosaic). */
export function lastPlacementRefreshMs(): number {
  return refreshMs;
}

export async function exportPrintReady3MF(): Promise<void> {
  // captured now, not read at track() time: the export button disables during the awaits but #shape-kind doesn't, so state.assembly.kindId can move mid-export
  const exportedKindId = state.assembly.kindId;

  const built = getLastAssemblyBuild();
  if (!built || !built.partOutputs.length) return;
  clearStalePlacementNotices();
  clearExportStatus();
  const { materials, parts, notes, plateCount } = exportInputs(built, (msg) => warn(msg));
  postPlacementNotes(notes);
  const fname = `mosaic-${state.assembly.kindId}.3mf`;

  // the color list posts this live; re-run against the export's own material count, the authoritative one
  refreshSlotBudgetNotice(materials.length);
  const curtain = showOverlay('Exporting print-ready 3MF…');
  await new Promise((r) => setTimeout(r, 10));
  try {
    const printer = getPrinter(state.printerId);
    const layout = await build3MFCombined(materials, parts, { printer });
    const { blob, warnings: placementWarnings } = layout;
    postPlacementNotes(layoutNotes(layout));
    track('export', {
      format: '3mf',
      mode: 'assembly',
      printer: state.printerId,
      colors: materials.length - 1,
      warnings: placementWarnings.length,
      ...(exportedKindId ? { kind: exportedKindId } : {}),
    });
    download(blob, fname);
    showExportStatus(fname, plateCount, materials.length, blob.size);
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
    // re-posts the slot-budget pill against the new printer's numbers as well as redrawing the line
    refreshSlotCountCapacity();
    renderExportSummary();
    // Every placement message names a bed, plate size or verified pose, so a switch re-states them all; renders.
    refreshPlacementNotices();
    schedulePersist();
  });
  const exportBtn = $<HTMLButtonElement>('#btn-export');
  exportBtn.addEventListener('click', () => void guardExport(exportPrintReady3MF));
}
