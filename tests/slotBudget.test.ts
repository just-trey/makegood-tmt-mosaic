import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/export/printers', () => ({
  getPrinter: vi.fn(() => ({
    label: 'Test Printer',
    slotsPerUnit: 4,
    slotsMax: 16,
    unitLabel: 'AMS unit',
  })),
  DEFAULT_PRINTER_ID: 'p1',
}));

import { refreshSlotBudgetNotice, slotTier, SLOT_PILL_SUFFIX } from '../src/ui/slotBudget';
import { getPrinter, type Printer } from '../src/export/printers';
import { WARNINGS, clearWarnings, clearBuildWarnings } from '../src/warnings';

const chaining = {
  label: 'Test Printer',
  slotsPerUnit: 4,
  slotsMax: 16,
  unitLabel: 'AMS unit',
} as Printer;
const fixed = {
  label: 'Snapmaker-like',
  slotsPerUnit: 4,
  slotsMax: 4,
  unitLabel: 'toolchanger',
} as Printer;

const notices = (): { message: string; level: string }[] =>
  WARNINGS.filter((w) => w.message.endsWith(SLOT_PILL_SUFFIX));

beforeEach(() => {
  clearWarnings();
  vi.mocked(getPrinter).mockReturnValue(chaining);
  // module-level "what's posted" state carries across tests; a no-design refresh resets it through
  // the public API rather than reaching into the module
  refreshSlotBudgetNotice(0);
  clearWarnings();
});

/** What the warnings panel's × does. */
function dismiss(message: string): void {
  const i = WARNINGS.findIndex((w) => w.message === message);
  WARNINGS.splice(i, 1);
}

describe('slotTier', () => {
  it('treats one unit as a budget, not a ceiling, on a printer that chains', () => {
    expect(slotTier(4, chaining)).toBe('fits');
    expect(slotTier(5, chaining)).toBe('multi-unit');
    expect(slotTier(16, chaining)).toBe('multi-unit');
    expect(slotTier(17, chaining)).toBe('over-max');
  });

  it('steps straight from fits to over-max when the printer cannot chain', () => {
    expect(slotTier(4, fixed)).toBe('fits');
    expect(slotTier(5, fixed)).toBe('over-max');
  });
});

describe('refreshSlotBudgetNotice', () => {
  it('says nothing when the design fits a single unit', () => {
    refreshSlotBudgetNotice(4);

    expect(notices()).toEqual([]);
  });

  it('notes — does not warn — a count the printer can still reach with more units', () => {
    refreshSlotBudgetNotice(5);

    expect(notices()).toHaveLength(1);
    expect(notices()[0].level).toBe('info');
    expect(notices()[0].message).toContain('5 filament slots needed');
    // Both halves matter for an info-level pill: the single-unit limit is the problem, and the
    // printer's real maximum is the reassurance that keeps this out of `warn`. Dropping the
    // second leaves an info that only offers to take colors away.
    expect(notices()[0].message).toContain('more than the 4 in a single AMS unit');
    expect(notices()[0].message).toContain('up to 16');
  });

  it('warns only past what the printer can print in one go', () => {
    refreshSlotBudgetNotice(17);

    expect(notices()).toHaveLength(1);
    expect(notices()[0].level).toBe('warn');
    expect(notices()[0].message).toContain('tops out at 16');
  });

  it('warns as soon as one unit is exceeded on a printer that cannot chain', () => {
    vi.mocked(getPrinter).mockReturnValue(fixed);

    refreshSlotBudgetNotice(5);

    expect(notices()).toHaveLength(1);
    expect(notices()[0].level).toBe('warn');
    expect(notices()[0].message).toContain('tops out at 4');
  });

  it('replaces the previous pill rather than stacking a second tier on it', () => {
    refreshSlotBudgetNotice(17);
    expect(notices()[0].level).toBe('warn');

    refreshSlotBudgetNotice(5);

    expect(notices()).toHaveLength(1);
    expect(notices()[0].level).toBe('info');
  });

  it('clears the pill once the design fits again', () => {
    refreshSlotBudgetNotice(5);
    expect(notices()).toHaveLength(1);

    refreshSlotBudgetNotice(3);

    expect(notices()).toEqual([]);
  });

  it('clears the pill when there is no design at all', () => {
    refreshSlotBudgetNotice(5);

    refreshSlotBudgetNotice(0);

    expect(notices()).toEqual([]);
  });

  it('survives a rebuild, since it tracks standing state rather than one build’s diagnostics', () => {
    refreshSlotBudgetNotice(5);

    clearBuildWarnings();

    expect(notices()).toHaveLength(1);
  });

  // Convention 3: one problem, one primary remedy. The alternatives ("→ base", a second unit,
  // manual swaps) moved to the help dialog, so the pill must NOT list them, and auto-merge stays
  // unnamed because it is the control least likely to actually get under the limit.
  it.each([
    ['multi-unit', 5, chaining],
    ['over-max', 5, fixed],
  ])('states one remedy, hand-merging, in the %s message', (_l, slots, printer) => {
    vi.mocked(getPrinter).mockReturnValue(printer as Printer);

    refreshSlotBudgetNotice(slots as number);

    const m = notices()[0].message;
    expect(m).toContain('drag one color row onto another');
    expect(m).not.toContain('→ base');
    expect(m).not.toContain('auto-merge');
    expect(m).not.toContain('swap filament');
  });

  it('ends both tiers with the suffix clearSlotBudgetNotices matches', () => {
    for (const [slots, printer] of [
      [5, chaining],
      [5, fixed],
    ] as const) {
      vi.mocked(getPrinter).mockReturnValue(printer as Printer);
      refreshSlotBudgetNotice(slots);
      // The length check is the half that catches the stacking regression: a suffix that stopped
      // matching would leave the previous tier's pill posted alongside the new one.
      expect(notices()).toHaveLength(1);
      expect(notices()[0].message.endsWith(SLOT_PILL_SUFFIX)).toBe(true);
    }
  });
});

describe('refreshSlotBudgetNotice — dismissal', () => {
  it('stays dismissed while the situation is unchanged', () => {
    refreshSlotBudgetNotice(5);
    dismiss(notices()[0].message);

    refreshSlotBudgetNotice(5); // any later render — a depth nudge, a rebuild
    refreshSlotBudgetNotice(5);

    expect(notices()).toEqual([]);
  });

  it('comes back when the slot count changes', () => {
    refreshSlotBudgetNotice(5);
    dismiss(notices()[0].message);

    refreshSlotBudgetNotice(6);

    expect(notices()).toHaveLength(1);
    expect(notices()[0].message).toContain('6 filament slots needed');
  });

  it('comes back when the printer changes, even at the same count', () => {
    refreshSlotBudgetNotice(5);
    dismiss(notices()[0].message);

    vi.mocked(getPrinter).mockReturnValue(fixed);
    refreshSlotBudgetNotice(5);

    expect(notices()).toHaveLength(1);
    expect(notices()[0].level).toBe('warn');
  });

  it('comes back after the design drops below the threshold and rises again', () => {
    refreshSlotBudgetNotice(5);
    dismiss(notices()[0].message);

    refreshSlotBudgetNotice(3); // fits now — nothing to say
    refreshSlotBudgetNotice(5); // and over again: worth saying afresh

    expect(notices()).toHaveLength(1);
  });
});
