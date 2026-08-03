// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColorListEntry } from '../src/ui/colorList';

vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/state/filaments', () => ({ nearestFilamentName: vi.fn(() => 'Generic PETG') }));
vi.mock('../src/export/printers', () => ({
  getPrinter: vi.fn(() => ({ label: 'Test Printer', amsSlotCapacity: 4 })),
  DEFAULT_PRINTER_ID: 'p1',
}));

import { renderColorList, refreshSlotCountCapacity } from '../src/ui/colorList';

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
  document.body.innerHTML =
    '<div id="color-list"></div><div id="slot-count"></div><div id="stat-colors"></div>';
});

describe('renderColorList — slot count line', () => {
  it('counts one AMS slot per cut color plus one for the body', () => {
    renderColorList([entry('#ff0000'), entry('#00ff00')], { rawColorCount: 2 });

    expect(slotLine().textContent).toBe('2 colors → 3 AMS slots needed');
    expect(slotLine().classList.contains('over-capacity')).toBe(false);
  });

  it('flags the line when the count exceeds the printer’s AMS capacity', () => {
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'].map((c) => entry(c));
    renderColorList(colors, { rawColorCount: 4 });

    expect(slotLine().textContent).toBe('4 colors → 5 AMS slots needed');
    expect(slotLine().classList.contains('over-capacity')).toBe(true);
  });

  it('reports the caller’s slot count when it exceeds the visible row count', () => {
    // assembly mode: a palette color with no inlay area anywhere is dropped from the list but
    // still ships as a 3MF material, so the export needs a slot the rows don't account for
    renderColorList([entry('#ff0000')], { rawColorCount: 2, slotsNeeded: 3 });

    expect(slotLine().textContent).toBe('2 colors → 3 AMS slots needed');
  });

  it('says "1 color", not "1 colors"', () => {
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });

    expect(slotLine().textContent).toBe('1 color → 2 AMS slots needed');
  });

  it('drops the previous list’s slot count when the colors go away', () => {
    renderColorList([entry('#ff0000'), entry('#00ff00'), entry('#0000ff'), entry('#ffff00')], {
      rawColorCount: 4,
    });
    expect(slotLine().classList.contains('over-capacity')).toBe(true);

    renderColorList(null);

    expect(slotLine().textContent).toBe('');
    expect(slotLine().classList.contains('over-capacity')).toBe(false);
  });

  it('does not resurrect a cleared count when the printer picker changes', () => {
    renderColorList([entry('#ff0000'), entry('#00ff00')], { rawColorCount: 2 });
    renderColorList(null);

    refreshSlotCountCapacity();

    expect(slotLine().textContent).toBe('');
  });
});
