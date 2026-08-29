// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// DOM-only: stub every rendering/geometry side effect the change handler reaches so the test
// exercises only the confirm-dialog decision, not the rest of the pipeline (mirrors
// tests/assemblyPanel.test.ts's approach for the same file's siblings).
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
vi.mock('../src/ui/dialogs', () => ({ confirmDialog: vi.fn() }));

import { initPartPanel } from '../src/ui/partPanel';
import { confirmDialog } from '../src/ui/dialogs';
import { state } from '../src/state/store';
import { ASSEMBLY_KINDS } from '../src/assembly/kinds';
import type { AssemblyPart } from '../src/types';

const offered = ASSEMBLY_KINDS.filter((k) => !k.hidden);
const [kindA, kindB] = offered;

function part(): AssemblyPart {
  return { id: 1, name: 'Part', loaded: true } as unknown as AssemblyPart;
}

/** The parts of index.html's Part panel this module touches, and nothing else. */
function mountPartPanelDom(): void {
  document.body.innerHTML = `
    <div id="shape-thumb"></div>
    <select id="shape-kind"></select>
    <div id="shape-params-disc"><input id="p-diameter" value="80" /><input id="p-thickness" value="4" /></div>
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
  vi.mocked(confirmDialog).mockReset();
  mountPartPanelDom();
  state.shapeKind = 'assembly';
  state.assembly.kindId = kindA.id;
  state.assembly.parts = [part()];
  initPartPanel();
});

describe('switching the part dropdown', () => {
  it('does not ask the user to confirm — nothing they placed is lost', async () => {
    const sel = document.querySelector<HTMLSelectElement>('#shape-kind')!;
    sel.value = 'asm:' + kindB.id;
    sel.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(confirmDialog).not.toHaveBeenCalled();
    expect(state.assembly.kindId).toBe(kindB.id);
  });
});
