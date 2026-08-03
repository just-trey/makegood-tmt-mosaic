// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColorListEntry } from '../src/ui/colorList';

vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/state/filaments', () => ({ nearestFilamentName: vi.fn(() => 'Generic PETG') }));
vi.mock('../src/export/printers', () => ({
  getPrinter: vi.fn(() => ({ label: 'Test Printer', amsSlotsPerUnit: 4, amsSlotsMax: 16 })),
  DEFAULT_PRINTER_ID: 'p1',
}));

import { renderColorList, refreshSlotCountCapacity } from '../src/ui/colorList';
import { getPrinter } from '../src/export/printers';
import { WARNINGS, clearWarnings } from '../src/warnings';

function entry(color: string, overrides: Partial<ColorListEntry> = {}): ColorListEntry {
  return {
    color,
    key: color,
    members: [color],
    isMergeGroup: false,
    depth: 0.6,
    areaPct: 10,
    isBackground: false,
    ...overrides,
  };
}

const slotLine = (): HTMLElement => document.querySelector<HTMLElement>('#slot-count')!;

beforeEach(() => {
  vi.mocked(getPrinter).mockReturnValue({
    label: 'Test Printer',
    amsSlotsPerUnit: 4,
    amsSlotsMax: 16,
  } as ReturnType<typeof getPrinter>);
  document.body.innerHTML =
    '<div id="color-list"></div><div id="slot-count"></div><div id="stat-colors"></div>';
  // an empty render resets slotBudget's "what's posted" memory, which is module-level and would
  // otherwise make the next test's identical pill look like one the user had dismissed
  renderColorList(null);
  clearWarnings();
});

describe('renderColorList — slot count line', () => {
  const colors = (n: number): ColorListEntry[] =>
    Array.from({ length: n }, (_, i) => entry(`#00000${i}`));

  it('counts one AMS slot per cut color plus one for the body', () => {
    renderColorList(colors(2), { rawColorCount: 2 });

    expect(slotLine().textContent).toBe('2 colors → 3 AMS slots needed');
    expect(slotLine().classList.contains('multi-unit')).toBe(false);
    expect(slotLine().classList.contains('over-capacity')).toBe(false);
  });

  it('notes, but does not flag, a count past one AMS unit the printer can still reach', () => {
    renderColorList(colors(4), { rawColorCount: 4 }); // 5 slots: > 4 per unit, <= 16 max

    expect(slotLine().textContent).toBe('4 colors → 5 AMS slots needed');
    expect(slotLine().classList.contains('multi-unit')).toBe(true);
    expect(slotLine().classList.contains('over-capacity')).toBe(false);
    expect(slotLine().title).toContain('needs more than one unit');
  });

  it('flags the line only past what the printer can print in one go', () => {
    renderColorList(colors(16), { rawColorCount: 16 }); // 17 slots, past the 16 max

    expect(slotLine().textContent).toBe('16 colors → 17 AMS slots needed');
    expect(slotLine().classList.contains('over-capacity')).toBe(true);
    expect(slotLine().classList.contains('multi-unit')).toBe(false);
  });

  it('goes straight from fine to flagged on a printer that cannot chain units', () => {
    vi.mocked(getPrinter).mockReturnValue({
      label: 'Snapmaker-like',
      amsSlotsPerUnit: 4,
      amsSlotsMax: 4,
    } as ReturnType<typeof getPrinter>);

    renderColorList(colors(3), { rawColorCount: 3 }); // 4 slots — exactly full
    expect(slotLine().classList.contains('over-capacity')).toBe(false);
    expect(slotLine().classList.contains('multi-unit')).toBe(false);

    renderColorList(colors(4), { rawColorCount: 4 }); // 5 slots — impossible, no second unit
    expect(slotLine().classList.contains('over-capacity')).toBe(true);
    expect(slotLine().classList.contains('multi-unit')).toBe(false);
  });

  it('reports the caller’s slot count when it exceeds the visible row count', () => {
    // assembly mode: a palette color with no inlay area anywhere is dropped from the list but
    // still ships as a 3MF material, so the export needs a slot the rows don't account for
    renderColorList([entry('#ff0000')], { rawColorCount: 2, slotsNeeded: 3 });

    expect(slotLine().textContent).toBe('2 colors → 3 AMS slots needed');
  });

  it('posts the slot-budget pill as the list renders, not only at export time', () => {
    renderColorList(colors(4), { rawColorCount: 4 }); // 5 slots, past one unit

    expect(WARNINGS.map((w) => w.message)).toContainEqual(
      expect.stringContaining('5 AMS slots needed'),
    );
  });

  it('re-posts the pill against the new printer when the picker changes', () => {
    renderColorList(colors(4), { rawColorCount: 4 });
    expect(WARNINGS).toHaveLength(1);

    vi.mocked(getPrinter).mockReturnValue({
      label: 'Snapmaker-like',
      amsSlotsPerUnit: 4,
      amsSlotsMax: 4,
    } as ReturnType<typeof getPrinter>);
    refreshSlotCountCapacity();

    expect(WARNINGS).toHaveLength(1);
    expect(WARNINGS[0].level).toBe('warn');
    expect(WARNINGS[0].message).toContain('tops out at 4');
  });

  it('drops the pill along with the line when the colors go away', () => {
    renderColorList(colors(4), { rawColorCount: 4 });
    expect(WARNINGS).toHaveLength(1);

    renderColorList(null);

    expect(WARNINGS).toEqual([]);
  });

  it('says "1 color", not "1 colors"', () => {
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });

    expect(slotLine().textContent).toBe('1 color → 2 AMS slots needed');
  });

  it('drops the previous list’s slot count when the colors go away', () => {
    renderColorList(colors(4), { rawColorCount: 4 });
    expect(slotLine().classList.contains('multi-unit')).toBe(true);

    renderColorList(null);

    expect(slotLine().textContent).toBe('');
    expect(slotLine().classList.contains('multi-unit')).toBe(false);
    expect(slotLine().classList.contains('over-capacity')).toBe(false);
  });

  it('does not resurrect a cleared count when the printer picker changes', () => {
    renderColorList([entry('#ff0000'), entry('#00ff00')], { rawColorCount: 2 });
    renderColorList(null);

    refreshSlotCountCapacity();

    expect(slotLine().textContent).toBe('');
  });
});
