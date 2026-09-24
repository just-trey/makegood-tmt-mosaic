// @vitest-environment jsdom
//
// docs/tech-debt.md's "Numeric coercion has no lint rule" section named this as a latent bug:
// bindShapeInput() read a numeric floor from the input's authored `min=` attribute with a bare
// parseFloat. A non-numeric `min=` parses to NaN, and `v >= NaN` is false for every v, so the
// guard rejected every value typed into the field, not just invalid ones.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));
vi.mock('../src/assembly/parts', () => ({ maybeAutoLoadAssembly: vi.fn() }));
vi.mock('../src/state/artwork', () => ({
  clampArtworkModes: vi.fn(),
  clearArtworkZoneBindings: vi.fn(),
}));
vi.mock('../src/ui/artworkListPanel', () => ({ renderArtworkList: vi.fn() }));
vi.mock('../src/ui/artworkPanel', () => ({ renderPatternPicker: vi.fn() }));
vi.mock('../src/ui/assemblyPanel', () => ({
  applyBuildParam: vi.fn(),
  applyHubcapSilhouette: vi.fn(),
  renderAssemblyPartList: vi.fn(),
  renderAssemblyRoleControls: vi.fn(),
  syncAssemblyKindControls: vi.fn(),
}));
vi.mock('../src/ui/fitPanel', () => ({ updateOffsetSliderRanges: vi.fn() }));
vi.mock('../src/ui/depthPanel', () => ({ refreshDepthControls: vi.fn() }));
vi.mock('../src/ui/shapeThumb', () => ({ refreshShapeThumb: vi.fn() }));
vi.mock('../src/ui/exportPanel', () => ({ clearStalePlacementNotices: vi.fn() }));
vi.mock('../src/ui/warningsView', () => ({ renderWarnings: vi.fn() }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));

import { initPartPanel } from '../src/ui/partPanel';
import { state } from '../src/state/store';

/** Mirrors tests/part-switch-confirm.test.ts's DOM subset, with an authored (non-numeric) `min=`
 * on #p-diameter — the markup case the bug lived in, not anything a user typed. */
function mountPartPanelDom(): void {
  document.body.innerHTML = `
    <div id="shape-thumb"></div>
    <select id="shape-kind"></select>
    <div id="shape-params-disc"><input id="p-diameter" value="80" min="not-a-number" /><input id="p-thickness" value="4" /></div>
    <div id="shape-params-rect"><input id="p-width" value="80" /><input id="p-height" value="60" /><input id="p-thickness-r" value="4" /></div>
    <div id="shape-params-round"><input id="p-width-rr" value="80" /><input id="p-height-rr" value="60" /><input id="p-corner" value="8" /><input id="p-thickness-rr" value="4" /></div>
    <div id="shape-params-stl">
      <div id="stl-dropzone"><input type="file" id="stl-input" /></div>
      <input id="p-facez" value="0" /><input id="p-width-stl" value="80" /><input id="p-height-stl" value="60" /><input id="p-thickness-stl" value="4" />
      <button id="btn-autoz"></button>
    </div>
    <div id="shape-params-assembly">
      <input id="p-asm-radius" value="138" />
      <input id="p-asm-buildparam" />
      <input type="checkbox" id="p-asm-silhouette" />
    </div>
    <div id="base-color-swatches"></div>
    <button id="btn-export-stl"></button>
    <div id="export-hint"></div>
  `;
}

beforeEach(() => {
  mountPartPanelDom();
  state.shapeKind = 'disc';
  initPartPanel();
});

describe('a field bound with a non-numeric min= attribute', () => {
  it('still accepts a valid typed value', () => {
    const field = document.querySelector<HTMLInputElement>('#p-diameter')!;
    field.value = '95';
    field.dispatchEvent(new Event('input'));

    expect(field.classList.contains('invalid')).toBe(false);
    expect(state.disc.diameter).toBe(95);
  });
});
