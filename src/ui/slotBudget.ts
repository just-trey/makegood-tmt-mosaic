import { state } from '../state/store';
import { getPrinter, type Printer } from '../export/printers';
import { WARNINGS, warn, notice } from '../warnings';
import { isRasterSource } from '../state/artwork';
import { MIN_COLORS } from '../raster/quantize';

/**
 * How a slot count sits against the selected printer. Three tiers, not two: one unit is a budget,
 * not a capacity (most volunteers have exactly one, so passing 4 is worth saying), but the Bambus
 * chain up to 16 (25 on an H2D across both nozzles) and calling a 6-slot design an error on a
 * printer that prints it would invent a limit. Only the real maximum is an error. The Snapmaker U1
 * has both numbers at 4, so it steps from 'fits' straight to 'over-max'.
 */
export type SlotTier = 'fits' | 'multi-unit' | 'over-max';

export function slotTier(slotsNeeded: number, printer: Printer): SlotTier {
  if (slotsNeeded > printer.slotsMax) return 'over-max';
  if (slotsNeeded > printer.slotsPerUnit) return 'multi-unit';
  return 'fits';
}

// The two remedies a pill can end with, and the handle clearSlotBudgetNotices uses to find a
// posted pill — the clear-before-reporting pattern of PLACEMENT_WARNING_SUFFIXES in exportPanel.ts,
// pinned by tests/slotBudget.test.ts so a reword can't stop them clearing and stack tiers or variants.
// Each message names exactly one (convention 3); which one depends on what is loaded, see colorsSliderCanHelp.
export const SLOT_PILL_MERGE = 'drag one color row onto another to merge them.';
export const SLOT_PILL_SLIDER = 'lower Colors on an image design.';
export const SLOT_PILL_SUFFIXES = [SLOT_PILL_MERGE, SLOT_PILL_SLIDER];

export function isSlotPill(message: string): boolean {
  return SLOT_PILL_SUFFIXES.some((s) => message.endsWith(s));
}

export function clearSlotBudgetNotices(): void {
  for (let i = WARNINGS.length - 1; i >= 0; i--) {
    if (isSlotPill(WARNINGS[i].message)) WARNINGS.splice(i, 1);
  }
}

// The Colors slider exists only on an image design, and one already down to MIN_COLORS has nothing
// left to give. With several designs one image that can still lose colors is enough to name it:
// the slider is a target count where hand-merging is a hunt through a list that can sit far
// below the pill, and the mixed case can't tell which design the extra colors came from.
function colorsSliderCanHelp(): boolean {
  return state.sources.some((s) => isRasterSource(s) && s.raster.palette.length > MIN_COLORS);
}

function slotBudgetMessage(
  slotsNeeded: number,
): { message: string; level: 'warn' | 'info' } | null {
  if (!slotsNeeded) return null;
  const printer = getPrinter(state.printerId);
  const tier = slotTier(slotsNeeded, printer);
  // One problem, one primary remedy (convention 3). The "→ base" and manual mid-print swap
  // alternatives are in the help dialog's "Merging into filament slots" (convention 6: a mechanism goes there).
  //
  // The multi-unit tier keeps "prints up to N" though it reads like a second remedy: it's the
  // reassurance making this tier `info` not `warn` (see slotTier); without it the pill only offers to take colors away.
  //
  // "in one print", not "across more units": how a printer reaches slotsMax differs (the H2D's 25th
  // slot is an external spool on its second nozzle, not a chained unit — printers.ts); slotsMax is
  // what it can address in one print, the only phrasing true of all three.
  //
  // Hand-merging is the fallback and auto-merge deliberately unnamed: it walks a similarity
  // threshold, not a target count, and on the one real 7-color volunteer SVG measured it moved 7
  // slots to 6 only at Strong (AUTO_MERGE_LEVELS in geometry/regions.ts) — the control least likely to work.
  const remedy = colorsSliderCanHelp() ? SLOT_PILL_SLIDER : SLOT_PILL_MERGE;
  if (tier === 'over-max') {
    return {
      level: 'warn',
      message:
        `${slotsNeeded} filament slots needed, but ${printer.label} tops out at ` +
        `${printer.slotsMax} in a single print. To fit, ` +
        remedy,
    };
  }
  if (tier === 'multi-unit') {
    return {
      level: 'info',
      message:
        `${slotsNeeded} filament slots needed, more than the ${printer.slotsPerUnit} in a ` +
        `single ${printer.unitLabel}. ${printer.label} prints up to ${printer.slotsMax} in one ` +
        `print. To fit a single ${printer.unitLabel}, ` +
        remedy,
    };
  }
  return null;
}

/** The exact message currently posted, so a re-render can tell "still true" from "user dismissed". */
let postedMessage: string | null = null;

/**
 * Post the pill for where the current design sits against the current printer, replacing any
 * previous one. Called on every color-list render and from the printer picker: the condition is
 * true the whole time, so it says so rather than ambushing the user at download. Export re-runs it
 * against its own material count.
 *
 * Posting every render would make the × inert (dismiss, nudge a depth field, it's back), and per
 * docs/tech-debt.md this pill is up for the *typical* design — a permanent undismissable duplicate
 * of the line above. So a dismissal sticks while the statement holds; a different printer, tier or
 * count says it again. Plain warn/notice, not the Build variants: this tracks standing state and
 * clears itself on every call. Mutates WARNINGS only — callers render, as the coverage check does.
 */
export function refreshSlotBudgetNotice(slotsNeeded: number): void {
  const next = slotBudgetMessage(slotsNeeded);
  // checked before the clear below, which would destroy the evidence: our pill missing from WARNINGS with its message unchanged means the user dismissed it
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
