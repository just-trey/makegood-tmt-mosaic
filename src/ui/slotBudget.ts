import { state } from '../state/store';
import { getPrinter, type Printer } from '../export/printers';
import { WARNINGS, warn, notice } from '../warnings';

/**
 * How a slot count sits against the selected printer. Three tiers, not two, because one unit
 * is a budget rather than a capacity: most volunteers have exactly one, so passing 4 is worth
 * saying — but the Bambus chain up to 16 (25 on an H2D across both nozzles), and calling a 6-slot
 * design an error on a printer that prints it fine would be the tool inventing a limit. Only the
 * printer's real maximum is an error. The Snapmaker U1 is the case where both numbers are 4, so it
 * steps straight from 'fits' to 'over-max'.
 */
export type SlotTier = 'fits' | 'multi-unit' | 'over-max';

export function slotTier(slotsNeeded: number, printer: Printer): SlotTier {
  if (slotsNeeded > printer.slotsMax) return 'over-max';
  if (slotsNeeded > printer.slotsPerUnit) return 'multi-unit';
  return 'fits';
}

// suffixes of the two messages below — same clear-before-reporting pattern as
// PLACEMENT_WARNING_SUFFIXES in exportPanel.ts, and pinned by tests/slotBudget.test.ts so a reword
// can't silently stop them clearing and leave both tiers' pills stacked
export const SLOT_MULTI_UNIT_NOTICE_SUFFIX = 'or swap filament manually mid-print.';
export const SLOT_OVER_MAX_WARNING_SUFFIX = '(auto-merge alone may not be enough).';

export function clearSlotBudgetNotices(): void {
  for (let i = WARNINGS.length - 1; i >= 0; i--) {
    const m = WARNINGS[i].message;
    if (m.endsWith(SLOT_MULTI_UNIT_NOTICE_SUFFIX) || m.endsWith(SLOT_OVER_MAX_WARNING_SUFFIX))
      WARNINGS.splice(i, 1);
  }
}

function slotBudgetMessage(
  slotsNeeded: number,
): { message: string; level: 'warn' | 'info' } | null {
  if (!slotsNeeded) return null;
  const printer = getPrinter(state.printerId);
  const tier = slotTier(slotsNeeded, printer);
  // Both messages name the controls that actually collapse slots, and both hedge auto-merge on
  // purpose: it walks a similarity threshold, not a target count, and against the one real 7-color
  // volunteer SVG measured so far it moved 7 slots to 6, and only at Strong (see docs/tech-debt.md,
  // "Auto-merge is a similarity control"). Merging two rows by hand, or printing one in the body,
  // is the reliable way down — leading with auto-merge would send people to the control least
  // likely to work.
  const howToReduce =
    'drag one color row onto another to merge them, or "→ base" to print one in the body';
  if (tier === 'over-max') {
    return {
      level: 'warn',
      message:
        `${slotsNeeded} filament slots needed, but ${printer.label} tops out at ` +
        `${printer.slotsMax} in a single print. Either ${howToReduce} ` +
        SLOT_OVER_MAX_WARNING_SUFFIX,
    };
  }
  if (tier === 'multi-unit') {
    return {
      level: 'info',
      message:
        `${slotsNeeded} filament slots needed — more than the ${printer.slotsPerUnit} in a ` +
        `single ${printer.unitLabel}. ${printer.label} supports up to ${printer.slotsMax} ` +
        `across daisy-chained units; with one ${printer.unitLabel}, ${howToReduce}, ` +
        SLOT_MULTI_UNIT_NOTICE_SUFFIX,
    };
  }
  return null;
}

/** The exact message currently posted, so a re-render can tell "still true" from "user dismissed". */
let postedMessage: string | null = null;

/**
 * Post the pill for wherever the current design sits against the current printer, replacing any
 * previous one. Called from the color list on every render and from the printer picker — the
 * condition is true the whole time it's true, so it says so the whole time rather than ambushing
 * the user at the download. Export re-runs it against its own material count as a last check.
 *
 * Posting on every render would make the pill's own × inert — dismiss it, nudge a depth field, it
 * is back — and per docs/tech-debt.md this pill is up for the *typical* design, so that would be a
 * permanent undismissable duplicate of the line right above it. So a dismissal sticks for exactly
 * as long as the statement holds: a different printer, tier, or slot count is a different thing to
 * say, and says it. Plain warn/notice rather than the Build variants for the same reason — this
 * tracks standing state, not one rebuild's diagnostics, and clears itself here on every call.
 *
 * Mutates WARNINGS only — every caller renders the panel itself, as the coverage check does.
 */
export function refreshSlotBudgetNotice(slotsNeeded: number): void {
  const next = slotBudgetMessage(slotsNeeded);
  // checked before the clear below, which would otherwise destroy the evidence: our pill missing
  // from WARNINGS while its message is unchanged means the user dismissed it
  const dismissed =
    postedMessage !== null &&
    next?.message === postedMessage &&
    !WARNINGS.some((w) => w.message === postedMessage);
  clearSlotBudgetNotices();
  if (!next) {
    postedMessage = null;
    return;
  }
  if (dismissed) return;
  (next.level === 'warn' ? warn : notice)(next.message);
  postedMessage = next.message;
}
