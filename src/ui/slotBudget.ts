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

// The primary remedy both tiers end with, and the handle clearSlotBudgetNotices uses to find a
// posted pill — same clear-before-reporting pattern as PLACEMENT_WARNING_SUFFIXES in
// exportPanel.ts, and pinned by tests/slotBudget.test.ts so a reword can't silently stop them
// clearing and leave both tiers' pills stacked. One constant rather than one per tier: convention
// 3 gives each message a single primary remedy and it is the same remedy, so two would encode a
// distinction that no longer exists.
export const SLOT_PILL_SUFFIX = 'drag one color row onto another to merge them.';

export function clearSlotBudgetNotices(): void {
  for (let i = WARNINGS.length - 1; i >= 0; i--) {
    if (WARNINGS[i].message.endsWith(SLOT_PILL_SUFFIX)) WARNINGS.splice(i, 1);
  }
}

function slotBudgetMessage(
  slotsNeeded: number,
): { message: string; level: 'warn' | 'info' } | null {
  if (!slotsNeeded) return null;
  const printer = getPrinter(state.printerId);
  const tier = slotTier(slotsNeeded, printer);
  // One problem, one primary remedy (convention 3). The alternatives the pill used to list, "→
  // base" and manual mid-print swaps, are in the help dialog's "Merging into filament slots"
  // section, which is where convention 6 puts a mechanism.
  //
  // The multi-unit tier keeps its "prints up to N" clause even though that reads like a second
  // remedy. It is not one: it is the reassurance that makes this tier `info` rather than `warn`
  // (see slotTier above, "calling a 6-slot design an error on a printer that prints it fine would
  // be the tool inventing a limit"). Cutting it leaves an info-level pill that only offers to take
  // colors away.
  //
  // "in one print", not "across more units": how a printer reaches slotsMax differs per machine,
  // and the H2D's 25th slot is an external spool on its second nozzle rather than another chained
  // unit (see printers.ts). slotsMax is defined as what it can address in one print, so that is
  // the only phrasing true of all three.
  //
  // Hand-merging is the primary on purpose, and auto-merge is deliberately not named: it walks a
  // similarity threshold rather than a target count, and against the one real 7-color volunteer
  // SVG measured so far it moved 7 slots to 6, and only at Strong (see AUTO_MERGE_LEVELS in
  // geometry/regions.ts). Leading with it would send people to the control least likely to work.
  if (tier === 'over-max') {
    return {
      level: 'warn',
      message:
        `${slotsNeeded} filament slots needed, but ${printer.label} tops out at ` +
        `${printer.slotsMax} in a single print. To fit, ` +
        SLOT_PILL_SUFFIX,
    };
  }
  if (tier === 'multi-unit') {
    return {
      level: 'info',
      message:
        `${slotsNeeded} filament slots needed, more than the ${printer.slotsPerUnit} in a ` +
        `single ${printer.unitLabel}. ${printer.label} prints up to ${printer.slotsMax} in one ` +
        `print. To fit a single ${printer.unitLabel}, ` +
        SLOT_PILL_SUFFIX,
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
