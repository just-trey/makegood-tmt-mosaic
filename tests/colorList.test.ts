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
import { state } from '../src/state/store';
import { getPrinter } from '../src/export/printers';
import { WARNINGS, clearWarnings } from '../src/warnings';
import { scheduleRebuild } from '../src/app/scheduler';

function entry(color: string, overrides: Partial<ColorListEntry> = {}): ColorListEntry {
  return {
    color,
    key: color,
    members: [color],
    isMergeGroup: false,
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

describe('renderColorList — depth field', () => {
  const depthInput = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>('.color-row .depth-input')!;

  beforeEach(() => {
    state.colorSettings = {};
    state.globalDepth = 1;
  });

  it('does not write the rendered depth back into colorSettings', () => {
    // The bug this guards: seeding colorSettings from the build's (already clamped) depth pinned
    // every row to it, so the next build compared the clamped value against itself, fell silent,
    // and kept cutting a depth nobody asked for.
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });

    expect(state.colorSettings).toEqual({});
  });

  it('shows the global depth for a row with no override, and follows it when it changes', () => {
    state.globalDepth = 6;
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });
    expect(depthInput().value).toBe('6.00');

    state.globalDepth = 1.5;
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });
    expect(depthInput().value).toBe('1.50');
  });

  it('shows a per-row override instead of the global', () => {
    state.colorSettings = { '#ff0000': { depth: 2.5 } };
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });

    expect(depthInput().value).toBe('2.50');
  });

  it('stores a typed 0 rather than substituting a default', () => {
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });
    depthInput().value = '0';
    depthInput().dispatchEvent(new Event('change'));

    expect(state.colorSettings['#ff0000']).toEqual({ depth: 0 });
  });

  it('drops the override when the field is cleared, returning the row to the global depth', () => {
    state.colorSettings = { '#ff0000': { depth: 2.5 } };
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });
    depthInput().value = '';
    depthInput().dispatchEvent(new Event('change'));

    expect(state.colorSettings['#ff0000']).toBeUndefined();
  });
});

describe('renderColorList — depth override affordance', () => {
  const depthInput = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>('.color-row .depth-input')!;
  const resetBtn = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('.color-row .depth-reset');

  beforeEach(() => {
    state.colorSettings = {};
    state.globalDepth = 1;
  });

  it('marks a row that carries its own depth, and offers a way back', () => {
    // Without this the global Depth field silently not moving a row had no visible cause and no
    // visible undo — clearing the field was the only way, and only the help panel said so.
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });
    expect(resetBtn()).toBeNull();
    expect(depthInput().classList.contains('overridden')).toBe(false);

    state.colorSettings = { '#ff0000': { depth: 2.5 } };
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });
    expect(resetBtn()).not.toBeNull();
    expect(depthInput().classList.contains('overridden')).toBe(true);
  });

  it('explains the override on the field that carries it, not on the one that does not', () => {
    // The explanation used to sit on the *non*-overridden field, so hovering the field that looked
    // different to ask why returned an empty tooltip — and the only text that answered it was on a
    // 19x17px glyph the user had to guess was hoverable.
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });
    expect(depthInput().title).toContain('Following the default');

    state.colorSettings = { '#ff0000': { depth: 2.5 } };
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });
    expect(depthInput().title).toContain('2.50 mm');
    expect(depthInput().title).toContain('1.00 mm default');
    expect(resetBtn()!.title).toContain('Reset to the default depth');
  });

  it('gives the reset the same button chrome as the rest of the row', () => {
    // Borderless and dim, it was styled identically to the `depth` label and the `mm` unit beside
    // it and shared nothing with the real button in the row above — so nothing at rest said it was
    // clickable.
    state.colorSettings = { '#ff0000': { depth: 2.5 } };
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });

    expect(resetBtn()!.classList.contains('btn')).toBe(true);
  });

  it('drops the override when reset is clicked', () => {
    state.colorSettings = { '#ff0000': { depth: 2.5 } };
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });

    resetBtn()!.click();

    expect(state.colorSettings['#ff0000']).toBeUndefined();
  });

  it('marks a row set to the same value as the global — it is still pinned', () => {
    state.globalDepth = 1;
    state.colorSettings = { '#ff0000': { depth: 1 } };
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });

    expect(resetBtn()).not.toBeNull();
  });
});

describe('renderColorList — reset survives the field it sits next to', () => {
  beforeEach(() => {
    state.colorSettings = {};
    state.globalDepth = 1;
  });

  it('clears the override on mousedown, before the blur that would re-store it', () => {
    // Clicking ↺ blurs the depth field first. That blur fires the field's change handler, which
    // re-stores the override and schedules the rebuild that re-renders the list — destroying the
    // button before its click could land, so the first click appeared to do nothing.
    state.colorSettings = { '#ff0000': { depth: 2.5 } };
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });

    const btn = document.querySelector<HTMLElement>('.color-row .depth-reset')!;
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);

    expect(state.colorSettings['#ff0000']).toBeUndefined();
    // the default must be prevented, or the blur-change still fires and puts the override back
    expect(ev.defaultPrevented).toBe(true);
  });

  it('rebuilds once for one press, not once per event', () => {
    // The handler is bound to both mousedown and click so a keyboard activation still works. When
    // the rebuild is slow enough that the row is still mounted, the click arrives at a button that
    // has already done its job — and an unguarded second call marks the scene dirty and buys a
    // whole extra CSG pass. Slow rebuilds are exactly the ones that got doubled.
    state.colorSettings = { '#ff0000': { depth: 2.5 } };
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });
    vi.mocked(scheduleRebuild).mockClear();

    const btn = document.querySelector<HTMLElement>('.color-row .depth-reset')!;
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(state.colorSettings['#ff0000']).toBeUndefined();
    expect(vi.mocked(scheduleRebuild)).toHaveBeenCalledTimes(1);
  });

  it('still clears on a keyboard activation, which raises click without mousedown', () => {
    state.colorSettings = { '#ff0000': { depth: 2.5 } };
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });

    document.querySelector<HTMLElement>('.color-row .depth-reset')!.click();

    expect(state.colorSettings['#ff0000']).toBeUndefined();
  });

  it('still resets when a rebuild re-rendered the list between render and click', () => {
    // What the live run caught and the mousedown-only fix missed: editing the field fires change
    // immediately, so a rebuild is already in flight and replaces the list's innerHTML. A handler
    // bound to the button from the previous render is on a detached node by the time the click
    // lands. Delegation from the container is what survives that.
    state.colorSettings = { '#ff0000': { depth: 2.5 } };
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });

    // the rebuild the field's change scheduled, landing before the user's click
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });

    const btn = document.querySelector<HTMLElement>('.color-row .depth-reset')!;
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    expect(state.colorSettings['#ff0000']).toBeUndefined();
  });

  it('ignores the pending edit that fires after the reset tears the field out', () => {
    // Found by driving the real app: preventDefault stops the click blurring the field, but the
    // rebuild then removes the focused input and Chrome fires its pending change on removal —
    // re-storing the override the reset just cleared, one beat too late to see on screen.
    state.colorSettings = { '#ff0000': { depth: 2.5 } };
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });
    const input = document.querySelector<HTMLInputElement>('.color-row .depth-input')!;

    input.value = '3.3'; // typed, never committed
    document
      .querySelector<HTMLElement>('.color-row .depth-reset')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('change')); // the last gasp on removal

    expect(state.colorSettings['#ff0000']).toBeUndefined();
  });

  it('suppresses exactly one change, so a still-mounted row stays editable', () => {
    // The row is only replaced when a rebuild re-renders the list. While one is already in flight
    // — or when it throws, which skips renderColorList entirely — the field stays mounted, and a
    // marker left set would swallow every later edit to it, without even scheduling a rebuild.
    state.colorSettings = { '#ff0000': { depth: 2.5 } };
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });
    const input = document.querySelector<HTMLInputElement>('.color-row .depth-input')!;

    document
      .querySelector<HTMLElement>('.color-row .depth-reset')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('change')); // the one the reset is guarding against

    // no re-render happened; the user now types a real value into the same field
    input.value = '1.75';
    input.dispatchEvent(new Event('change'));

    expect(state.colorSettings['#ff0000']).toEqual({ depth: 1.75 });
  });

  it('re-arms on typing, even when the reset produced no change to consume the marker', () => {
    state.colorSettings = { '#ff0000': { depth: 2.5 } };
    renderColorList([entry('#ff0000')], { rawColorCount: 1 });
    const input = document.querySelector<HTMLInputElement>('.color-row .depth-input')!;

    document
      .querySelector<HTMLElement>('.color-row .depth-reset')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    input.value = '1.75';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));

    expect(state.colorSettings['#ff0000']).toEqual({ depth: 1.75 });
  });
});
