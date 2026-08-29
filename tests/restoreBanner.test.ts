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
vi.mock('../src/assembly/parts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/assembly/parts')>();
  return { ...actual, asmLoadFullAssembly: vi.fn(async () => {}) };
});
// The failure path under test returns before any of these render — stubbed wholesale, same as
// tests/rebuild-scene.test.ts, so importing restoreBanner.ts doesn't drag in three.js/canvas work
// this test has no interest in.
vi.mock('../src/ui/partPanel', () => ({
  setShapeKind: vi.fn(),
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
import { SESSION_WRITES_DISABLED_MSG, type PersistedSession } from '../src/state/persist';
import { state } from '../src/state/store';
import { WARNINGS, clearWarnings, warn } from '../src/warnings';

const SESSION_KEY = 'tmt-mosaic:session:v1';

function session(over: Partial<PersistedSession> = {}): PersistedSession {
  return {
    version: 1,
    savedAt: Date.now(),
    shapeKind: 'disc',
    disc: { diameter: 90, thickness: 5 },
    rect: { width: 100, height: 70, thickness: 3 },
    round: { width: 100, height: 70, corner: 12, thickness: 3 },
    stlPlate: { width: 120, height: 80, thickness: 6, faceZ: 2 },
    marginPct: 7,
    scalePct: 100,
    offsetX: 0,
    offsetY: 0,
    flipX: false,
    flipY: false,
    rotationDeg: 0,
    globalDepth: 1.5,
    recessBg: true,
    printerId: 'snapmaker-u1',
    asmRadius: 140,
    assembly: { kindId: null, variantId: null },
    baseFilamentId: null,
    autoMergeLevel: 2,
    baseColorKey: null,
    baseColorMembers: [],
    mergeGroups: [],
    colorSettings: {},
    explicitDepths: true,
    keptApart: [],
    sources: [],
    artworks: [],
    activeArtworkId: null,
    ...over,
  } as PersistedSession;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML =
    '<div id="restore-banner" hidden><p></p></div>' +
    '<button id="btn-restore-session"></button>' +
    '<button id="btn-restore-dismiss"></button>' +
    '<div id="warnings"></div>';
  state.shapeKind = 'disc';
  state.assembly.kindId = null;
  state.assembly.parts = [];
  state.sources = [];
  state.artworks = [];
});

describe('initRestoreBanner: a restore that fails part-way', () => {
  // decodeWorkingImage needs a real Image; jsdom has none, so this fails the way an unreadable
  // data URL fails in a real browser: onerror, promptly.
  class FailingImage {
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    set src(_v: string) {
      queueMicrotask(() => this.onerror?.());
    }
  }

  // The per-source loop warns about the raster it could not decode (keyed 'r1'), then reaches an
  // SVG source whose svgText is not a string and throws — the same shape as
  // tests/session-restore.test.ts's "clears the restoring flag even when the restore throws".
  // `state.sources` is never committed (the throw happens before Object.assign), so once the
  // catch below reports the failure, that 'r1' warning describes a source no longer part of the
  // attempt at all — orphaned by the very failure that discarded it.
  const failingSession = () =>
    session({
      sources: [
        {
          id: 'r1',
          kind: 'raster',
          name: 'photo.png',
          svgText: '',
          raster: { png: 'data:image/png;base64,NOTVALID', colors: 4, detail: 50 },
        },
        { id: 's1', kind: 'upload', name: 'a.svg', svgText: null as unknown as string },
      ],
    });

  it('does not leave the aborted attempt’s own warning standing next to the failure message', async () => {
    vi.stubGlobal('Image', FailingImage);
    clearWarnings();
    localStorage.setItem(SESSION_KEY, JSON.stringify(failingSession()));

    initRestoreBanner();
    document.getElementById('btn-restore-session')!.click();

    // Let the raster decode's rejected promise and the outer restore's catch both settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(WARNINGS.some((w) => w.key === 'r1')).toBe(false);
    expect(WARNINGS.some((w) => w.message === SESSION_WRITES_DISABLED_MSG)).toBe(true);
  });

  // A stronger check than the test above: not just that 'r1' is gone, but that the final list is
  // exactly the one failure message — nothing from before the click (dropped by
  // applyRestoredSessionInner's own opening clear) or from the aborted attempt itself survives.
  it('leaves the warning list holding only the failure message', async () => {
    vi.stubGlobal('Image', FailingImage);
    clearWarnings();
    warn('a warning from before the restore was attempted', 'unrelated-key');
    localStorage.setItem(SESSION_KEY, JSON.stringify(failingSession()));

    initRestoreBanner();
    document.getElementById('btn-restore-session')!.click();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(WARNINGS).toEqual([expect.objectContaining({ message: SESSION_WRITES_DISABLED_MSG })]);
  });
});
