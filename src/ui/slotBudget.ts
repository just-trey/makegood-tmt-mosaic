import { state } from '../state/store';
import { getPrinter, type Printer } from '../export/printers';
import { WARNINGS, warnBuild, noticeBuild } from '../warnings';

/**
 * How a slot count sits against the selected printer. Three tiers, not two, because one AMS unit
 * is a budget rather than a capacity: most volunteers have exactly one, so passing 4 is worth
 * saying — but the Bambus chain up to 16 (25 on an H2D across both nozzles), and calling a 6-slot
 * design an error on a printer that prints it fine would be the tool inventing a limit. Only the
 * printer's real maximum is an error. The Snapmaker U1 is the case where both numbers are 4, so it
 * steps straight from 'fits' to 'over-max'.
 */
export type SlotTier = 'fits' | 'multi-unit' | 'over-max';

export function slotTier(slotsNeeded: number, printer: Printer): SlotTier {
  if (slotsNeeded > printer.amsSlotsMax) return 'over-max';
  if (slotsNeeded > printer.amsSlotsPerUnit) return 'multi-unit';
  return 'fits';
}

// suffixes of the two messages below — same clear-before-reporting pattern as
// PLACEMENT_WARNING_SUFFIXES in exportPanel.ts, and pinned by tests/slotBudget.test.ts so a reword
// can't silently stop them clearing and leave both tiers' pills stacked
export const SLOT_MULTI_UNIT_NOTICE_SUFFIX = 'or swap filament manually mid-print.';
export const SLOT_OVER_MAX_WARNING_SUFFIX = 'in a single print — reduce colors with auto-merge.';

export function clearSlotBudgetNotices(): void {
  for (let i = WARNINGS.length - 1; i >= 0; i--) {
    const m = WARNINGS[i].message;
    if (m.endsWith(SLOT_MULTI_UNIT_NOTICE_SUFFIX) || m.endsWith(SLOT_OVER_MAX_WARNING_SUFFIX))
      WARNINGS.splice(i, 1);
  }
}

/**
 * Post the pill for wherever the current design sits against the current printer, replacing any
 * previous one. Called from the color list on every render and from the printer picker — the
 * condition is true the whole time it's true, so it says so the whole time rather than ambushing
 * the user at the download. Export re-runs it against its own material count as a last check.
 *
 * warnBuild/noticeBuild rather than warn/notice: acting on the message (auto-merge the colors down)
 * schedules a rebuild, and a standing pill would be left contradicting a slot line that has since
 * gone quiet. Switching printers schedules no rebuild, so that path clears explicitly instead.
 *
 * Mutates WARNINGS only — every caller renders the panel itself, as the coverage check does.
 */
export function refreshSlotBudgetNotice(slotsNeeded: number): void {
  clearSlotBudgetNotices();
  if (!slotsNeeded) return;
  const printer = getPrinter(state.printerId);
  const tier = slotTier(slotsNeeded, printer);
  if (tier === 'over-max') {
    warnBuild(
      `${slotsNeeded} AMS slots needed, but ${printer.label} tops out at ` +
        `${printer.amsSlotsMax} ${SLOT_OVER_MAX_WARNING_SUFFIX}`,
    );
  } else if (tier === 'multi-unit') {
    noticeBuild(
      `${slotsNeeded} AMS slots needed — more than the ${printer.amsSlotsPerUnit} in a single ` +
        `AMS unit. ${printer.label} supports up to ${printer.amsSlotsMax} across daisy-chained ` +
        `units; with one unit you'll need to reduce colors with auto-merge, ` +
        SLOT_MULTI_UNIT_NOTICE_SUFFIX,
    );
  }
}
