// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/scheduler', () => ({
  scheduleRebuild: vi.fn(),
  isRebuildLikelySlow: () => false,
}));
vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));
vi.mock('../src/ui/overlay', () => ({ showOverlay: vi.fn(), hideOverlay: vi.fn() }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));
vi.mock('../src/ui/dialogs', () => ({ confirmDialog: vi.fn(), alertDialog: vi.fn() }));
vi.mock('../src/ui/partPanel', () => ({
  applyPartKind: vi.fn(),
  renderBaseColorSwatches: vi.fn(),
  refreshShapeParamInputs: vi.fn(),
}));
vi.mock('../src/ui/artworkListPanel', () => ({ renderArtworkList: vi.fn() }));
vi.mock('../src/ui/fitPanel', () => ({
  refreshFitInputsFromState: vi.fn(),
  updateOffsetSliderRanges: vi.fn(),
}));
vi.mock('../src/ui/depthPanel', () => ({ refreshDepthControls: vi.fn() }));
vi.mock('../src/ui/colorList', () => ({ refreshAutoMergeControl: vi.fn() }));

import { initRestoreBanner } from '../src/ui/restoreBanner';
import {
  applyRestoredSession,
  holdSavedSessionUntilAnswered,
  saveSession,
  SessionPartsError,
  type PersistedSession,
} from '../src/state/persist';
import { loadPartsLibrary, onAssemblyPartsChanged } from '../src/assembly/parts';
import { applyPartKind } from '../src/ui/partPanel';
import { state } from '../src/state/store';
import type { AssemblyPart, ArtworkInstance, DesignSource } from '../src/types';
import { WARNINGS, clearWarnings } from '../src/warnings';

const SESSION_KEY = 'tmt-mosaic:session:v1';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
  '<rect x="0" y="0" width="10" height="10" fill="#ff0000"/></svg>';

/** Saved on the footrest, with one design on it — the restore the boot's wheel is replaced by. */
function footrestSession(): PersistedSession {
  return {
    version: 1,
    savedAt: Date.now(),
    shapeKind: 'assembly',
    scalePct: 150,
    offsetX: 7,
    offsetY: 8,
    flipX: true,
    flipY: true,
    rotationDeg: 30,
    globalDepth: 2.2,
    printerId: 'snapmaker-u1',
    asmRadius: 150,
    assembly: { kindId: 'footrest', variantId: null },
    baseFilamentId: null,
    autoMergeLevel: 2,
    baseColorKey: null,
    baseColorMembers: [],
    mergeGroups: [],
    colorSettings: {},
    explicitDepths: true,
    keptApart: [],
    sources: [{ id: 's1', kind: 'upload', name: 'a.svg', svgText: SVG }],
    artworks: [
      {
        id: 'a1',
        sourceId: 's1',
        zoneId: null,
        offsetU: 0,
        offsetV: 0,
        scalePct: 100,
        rotationDeg: 0,
        flipX: false,
        flipY: false,
        mode: 'sticker',
      },
    ],
    activeArtworkId: 'a1',
  } as PersistedSession;
}

// What the app held before the click: a chair on the Kit variant, so the variant has a value that
// the footrest (which has none) would visibly overwrite.
const bootParts = [{ id: 1, roleId: 'handle-left', loaded: true }] as AssemblyPart[];
const bootSources = [] as DesignSource[];
const bootArtworks = [] as ArtworkInstance[];

beforeEach(() => {
  localStorage.clear();
  clearWarnings();
  document.body.innerHTML =
    '<div id="restore-banner" hidden><p></p></div>' +
    '<button id="btn-restore-session"></button>' +
    '<button id="btn-restore-dismiss"></button>' +
    '<div id="warnings"></div>';
  onAssemblyPartsChanged(() => {});
  vi.mocked(applyPartKind).mockClear();
  state.assembly.kindId = 'chair-body';
  state.assembly.variantId = 'kit';
  state.assembly.parts = bootParts;
  state.assembly.library = [
    { id: 'wheel-half', name: 'Wheel', file: 'stl/wheel-half.3mf' },
    { id: 'wheel-hub-cap', name: 'Cap', file: 'stl/wheel-hub-cap.3mf' },
    { id: 'footrest', name: 'Footrest', file: 'stl/footrest.3mf' },
  ];
  state.sources = bootSources;
  state.artworks = bootArtworks;
  state.activeArtworkId = null;
  state.printerId = 'bambu-a1';
  state.globalDepth = 1;
  state.scalePct = 100;
  state.asmRadius = 140;
  // The part file, not the manifest: the manifest came back, so the footrest is offered and the
  // load really starts; the network then drops out from under it.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
});

function expectUntouched(): void {
  expect(state.assembly.kindId).toBe('chair-body');
  expect(state.assembly.variantId).toBe('kit');
  expect(state.assembly.parts).toBe(bootParts);
  expect(state.sources).toBe(bootSources);
  expect(state.artworks).toBe(bootArtworks);
  expect(state.printerId).toBe('bambu-a1');
  expect(state.globalDepth).toBe(1);
  expect(state.scalePct).toBe(100);
  expect(state.asmRadius).toBe(140);
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('a restore whose parts do not load', () => {
  it('puts back the kind, variant, parts and settings when a part fetch rejects', async () => {
    await expect(applyRestoredSession(footrestSession())).rejects.toBeInstanceOf(SessionPartsError);
    expectUntouched();
  });

  it('does the same when the parts library itself never arrived', async () => {
    state.assembly.library = [];
    await loadPartsLibrary(); // fetch rejects: settled, empty
    state.assembly.parts = bootParts;

    await expect(applyRestoredSession(footrestSession())).rejects.toBeInstanceOf(SessionPartsError);
    expectUntouched();
  });

  it('does the same when the load itself throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    onAssemblyPartsChanged(() => {
      throw new Error('render blew up');
    });

    await expect(applyRestoredSession(footrestSession())).rejects.toBeInstanceOf(SessionPartsError);
    expectUntouched();
  });

  it('says so by name, re-renders the previous part, and keeps the session to offer again', async () => {
    const saved = JSON.stringify(footrestSession());
    localStorage.setItem(SESSION_KEY, saved);
    holdSavedSessionUntilAnswered();

    initRestoreBanner();
    document.getElementById('btn-restore-session')!.click();
    await settle();

    expectUntouched();
    expect(WARNINGS.map((w) => w.message)).toEqual([
      "Couldn't restore your session: the Footrest didn't load. Reload the page to try again.",
    ]);
    expect(applyPartKind).toHaveBeenCalled();
    expect(localStorage.getItem(SESSION_KEY)).toBe(saved);

    // Writes stay on, and the bare boot's own save must not clear the session it can still offer.
    saveSession();
    expect(localStorage.getItem(SESSION_KEY)).toBe(saved);
  });
});
