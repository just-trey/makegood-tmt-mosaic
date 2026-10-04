// @vitest-environment jsdom
//
// syncPair() moved from a bare `parseFloat(...) || 0` to toFiniteNumber(...) ?? 0, for the parsing
// -helper convention (docs/tech-debt.md). A real <input type="number"> can't actually hold a
// non-finite string like "Infinity" — the browser (and jsdom, matching it) sanitizes the property
// assignment to "" before any JS sees it — so this is a no-behavior-change swap for every value
// the field can really hold. This test pins that: a non-numeric field still falls back to 0.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/scheduler', () => ({
  scheduleRebuild: vi.fn(),
  isRebuildLikelySlow: vi.fn(() => false),
}));
vi.mock('../src/scene/designGizmo', () => ({ refreshGizmo: vi.fn() }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));

import { initFitPanel } from '../src/ui/fitPanel';
import { state } from '../src/state/store';

function mountFitPanelDom(): void {
  document.body.innerHTML = `
    <div id="p-margin-row"></div>
    <div id="p-fit-hint"></div>
    <input id="p-margin" type="range" value="0" />
    <input id="p-margin-num" type="number" value="0" />
    <input id="p-scale" type="range" value="100" />
    <input id="p-scale-num" type="number" value="100" />
    <input id="p-offset-x-slider" type="range" value="0" />
    <input id="p-offset-x" type="number" value="0" />
    <input id="p-offset-y-slider" type="range" value="0" />
    <input id="p-offset-y" type="number" value="0" />
    <input id="p-rot" type="range" value="0" />
    <input id="p-rot-num" type="number" value="0" />
    <input id="p-flip-x" type="checkbox" />
    <input id="p-flip-y" type="checkbox" />
    <button id="btn-reset-fit"></button>
  `;
}

beforeEach(() => {
  mountFitPanelDom();
  initFitPanel();
});

describe('clearing a fit field', () => {
  // The offset-x pair is unclamped (clampNum=false), so its handler reads the typed field's own
  // value straight through — unlike scale/margin, which snap the number field back to the slider
  // first, and a range input sanitizes an invalid assignment before that value is ever read.
  it('falls back to 0, same as the bare parseFloat this replaced', () => {
    const num = document.querySelector<HTMLInputElement>('#p-offset-x')!;
    num.value = '';
    num.dispatchEvent(new Event('input'));
    expect(state.offsetX).toBe(0);
  });
});
