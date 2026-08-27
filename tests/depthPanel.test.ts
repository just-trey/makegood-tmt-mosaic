// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));

import { refreshDepthControls } from '../src/ui/depthPanel';
import { state } from '../src/state/store';

/** The Depth panel rows this module touches, and nothing else. */
function mountDepthDom(): void {
  document.body.innerHTML = `
    <input type="number" id="p-depth" value="1.0" />
    <div class="depth-overrides" id="depth-overrides" hidden></div>
    <div class="row" id="p-recess-bg-row">
      <input type="checkbox" id="p-recess-bg" />
      <span class="hint" id="bg-depth-hint" style="display: none">uses the default depth</span>
    </div>`;
}

const recessRow = () => document.querySelector<HTMLElement>('#p-recess-bg-row')!;

beforeEach(() => {
  mountDepthDom();
  state.globalDepth = 1.0;
  state.recessBg = false;
});

/**
 * Seed the row to the opposite of what the case expects. An implementation that never touches it
 * leaves the fixture's value in place, so a case seeded to its own expectation passes unfixed —
 * '' is both "untouched" and "shown".
 */
const seedRow = (display: string) => {
  recessRow().style.display = display;
};

describe('the background-recess row against the current mode', () => {
  it('is hidden on an assembly part, whose build never reads recessBg', () => {
    seedRow('');
    state.shapeKind = 'assembly';

    refreshDepthControls();

    expect(recessRow().style.display).toBe('none');
  });

  it('is shown in a flat mode, where buildGeometry does read it', () => {
    seedRow('none');
    state.shapeKind = 'disc';

    refreshDepthControls();

    expect(recessRow().style.display).toBe('');
  });

  it('stops hiding it when a flat mode follows an assembly part', () => {
    seedRow('');
    state.shapeKind = 'assembly';
    refreshDepthControls();
    expect(recessRow().style.display).toBe('none');

    state.shapeKind = 'disc';
    refreshDepthControls();

    expect(recessRow().style.display).toBe('');
  });

  it('leaves state.recessBg alone while hidden, so a flat mode gets it back', () => {
    state.recessBg = true;
    state.shapeKind = 'assembly';

    refreshDepthControls();

    expect(state.recessBg).toBe(true);
  });
});
