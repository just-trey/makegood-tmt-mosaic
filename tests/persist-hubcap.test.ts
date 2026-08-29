// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));
vi.mock('../src/ui/overlay', () => ({ showOverlay: vi.fn(), hideOverlay: vi.fn() }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));
vi.mock('../src/ui/dialogs', () => ({ confirmDialog: vi.fn(), alertDialog: vi.fn() }));
vi.mock('../src/assembly/parts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/assembly/parts')>();
  return { ...actual, asmLoadFullAssembly: vi.fn(async () => {}) };
});

import {
  applyRestoredSession,
  loadSavedSession,
  saveSession,
  type PersistedSession,
} from '../src/state/persist';
import { state } from '../src/state/store';
import { ASSEMBLY_KINDS } from '../src/assembly/kinds';

/**
 * The hubcap's two build inputs both have to survive a reload, and only one of them did.
 *
 * `hubcapDiameterMm` was persisted from the day the control shipped; `hubcapSilhouette` was added
 * to the store beside it and not to the snapshot, so a session restored with a character-shaped
 * hubcap came back as a plain disc — with the artwork still on it, so nothing looked broken enough
 * to explain.
 */

/** Enough loaded work for saveSession to consider the session worth keeping. */
function withLoadedWork(): void {
  state.sources = [
    { id: 's1', kind: 'upload', name: 'a.svg', svgText: '<svg/>', parsed: null },
  ] as unknown as typeof state.sources;
  state.artworks = [{ id: 'a1', sourceId: 's1' }] as unknown as typeof state.artworks;
}

beforeEach(() => {
  localStorage.clear();
  state.hubcapSilhouette = false;
  state.hubcapDiameterMm = 220;
});

describe('the hubcap’s shape survives a reload', () => {
  it('saves the silhouette toggle alongside the diameter', () => {
    withLoadedWork();
    state.hubcapSilhouette = true;
    state.hubcapDiameterMm = 190;

    saveSession();

    const saved = loadSavedSession();
    expect(saved?.hubcapSilhouette).toBe(true);
    expect(saved?.hubcapDiameterMm).toBe(190);
  });

  it('saves it off as readily as on, so turning it off sticks too', () => {
    withLoadedWork();
    state.hubcapSilhouette = false;

    saveSession();

    // false, not absent: absent is how a pre-silhouette session reads, and those must not be
    // distinguishable from a user who deliberately turned it off.
    expect(loadSavedSession()?.hubcapSilhouette).toBe(false);
  });
});

/**
 * A restored diameter used to be clamped against the plate alone (min(plate.w, plate.d)), 10mm
 * looser than the live field's ceiling (buildParamMax: plate minus 2×PLATE_EDGE_MARGIN_MM=5, and
 * a kind's own maxMm when it has one). See docs/tech-debt.md's now-deleted "A restored hubcap
 * diameter is clamped looser than the live control allows".
 */
function minimalSession(over: Partial<PersistedSession> = {}): PersistedSession {
  return {
    version: 1,
    savedAt: Date.now(),
    shapeKind: 'assembly',
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
    globalDepth: 1,
    recessBg: false,
    printerId: 'snapmaker-u1',
    asmRadius: 138,
    assembly: { kindId: 'hubcap', variantId: null },
    baseFilamentId: null,
    autoMergeLevel: 0,
    baseColorKey: null,
    baseColorMembers: [],
    mergeGroups: [],
    colorSettings: {},
    keptApart: [],
    sources: [],
    artworks: [],
    activeArtworkId: null,
    ...over,
  } as PersistedSession;
}

describe('a restored hubcap diameter is clamped to the same ceiling the live field uses', () => {
  const hubcapKind = ASSEMBLY_KINDS.find((k) => k.id === 'hubcap')!;

  afterEach(() => {
    delete hubcapKind.buildParam!.maxMm;
  });

  // snapmaker-u1's plate is 270×270 (src/export/printers.ts). The live field's ceiling
  // (buildParamMax) is the plate minus 2×PLATE_EDGE_MARGIN_MM(5) on each axis: 270-10=260. The old
  // restore clamp was min(plate.w, plate.d) = 270 alone, so a saved 268 — above the field's ceiling
  // but below the plate — survived a restore unclamped.
  it('clamps to the field ceiling (260), not the plate alone (270)', async () => {
    await applyRestoredSession(minimalSession({ hubcapDiameterMm: 268 }));

    expect(state.hubcapDiameterMm).toBe(260);
  });

  // A value already inside the field's ceiling passes through untouched — the fix must not clamp
  // more aggressively than the field does.
  it('leaves a diameter that already fits the field ceiling alone', async () => {
    await applyRestoredSession(minimalSession({ hubcapDiameterMm: 200 }));

    expect(state.hubcapDiameterMm).toBe(200);
  });

  // A kind's own maxMm (buildParam.maxMm) is part of the live field's ceiling and the old restore
  // clamp ignored it entirely — it only ever looked at the plate.
  it('honors a kind maxMm below the plate margin, not just the plate', async () => {
    hubcapKind.buildParam!.maxMm = 150;

    await applyRestoredSession(minimalSession({ hubcapDiameterMm: 300 }));

    expect(state.hubcapDiameterMm).toBe(150);
  });

  // Pre-existing behavior for a kind with no buildParam (or one that no longer exists) must be
  // untouched: closing this finding must not regress a non-hubcap session's restore.
  it('keeps the old plate-only clamp for a kind with no buildParam', async () => {
    const wheelKind = ASSEMBLY_KINDS.find((k) => k.id === 'wheel')!;
    expect(wheelKind.buildParam).toBeUndefined();

    await applyRestoredSession(
      minimalSession({
        printerId: 'bambu-x1c', // 256×256 plate
        assembly: { kindId: 'wheel', variantId: null },
        hubcapDiameterMm: 999,
      }),
    );

    expect(state.hubcapDiameterMm).toBe(256);
  });
});
