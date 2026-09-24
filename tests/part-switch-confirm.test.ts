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
    <div id="shape-params-assembly">
      <input id="p-asm-radius" value="138" />
      <input id="p-asm-buildparam" />
      <input type="checkbox" id="p-asm-silhouette" />
    </div>
    <div id="base-color-swatches"></div>
  `;
}

beforeEach(() => {
  vi.mocked(confirmDialog).mockReset();
  mountPartPanelDom();
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
