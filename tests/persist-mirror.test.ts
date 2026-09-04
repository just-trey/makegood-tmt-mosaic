// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { asmLoadFullAssembly } from '../src/assembly/parts';
import { state } from '../src/state/store';
import type { ArtworkInstance, AssemblyPart, ZoneMirror } from '../src/types';

/**
 * An instance's Mirror flag has to survive a reload like its other placement fields, and a
 * session saved before the flag existed has to come back with it off. The save path spreads the
 * instance; the restore path lists fields one by one, which is where a new one goes missing.
 */

/** svg/parse.ts normalizes colors through a canvas 2D context, which jsdom has none of. */
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => {
    let fillStyle = '#000000';
    return {
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(v: string) {
        fillStyle = v;
      },
    };
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
  '<rect x="0" y="0" width="10" height="10" fill="#ff0000"/></svg>';

const instance = (over: Partial<ArtworkInstance> = {}): ArtworkInstance => ({
  id: 'a1',
  sourceId: 's1',
  zone: null,
  offsetU: 0,
  offsetV: 0,
  scalePct: 100,
  rotationDeg: 0,
  flipX: false,
  flipY: false,
  mode: 'sticker',
  ...over,
});

/** A minimal zoned part carrying one named DesignZone, for the mirror-survives-restore test. */
function zonedPart(id: number, zoneId: string, mirror?: ZoneMirror): AssemblyPart {
  return {
    id,
    name: `part-${id}`,
    roleId: 'r',
    positions: null,
    patches: null,
    patchIdx: 0,
    boundaryLoops: null,
    zones: [{ id: zoneId, name: zoneId, mirror }],
    topZ: 0,
    baseDepth: 1,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
  };
}

function session(artworks: PersistedSession['artworks']): PersistedSession {
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
    baseFilamentId: 'blue',
    autoMergeLevel: 2,
    baseColorKey: null,
    baseColorMembers: [],
    mergeGroups: [],
    colorSettings: {},
    explicitDepths: true,
    keptApart: [],
    sources: [{ id: 's1', kind: 'upload', name: 'a.svg', svgText: SVG }],
    artworks,
    activeArtworkId: 'a1',
  } as PersistedSession;
}

beforeEach(() => {
  localStorage.clear();
  state.shapeKind = 'disc';
  state.assembly.kindId = null;
  state.assembly.parts = [];
  state.sources = [];
  state.artworks = [];
  state.activeArtworkId = null;
});

describe('the Mirror flag across a reload', () => {
  it('the field itself round-trips through save and restore', async () => {
    state.sources = [
      { id: 's1', kind: 'upload', name: 'a.svg', svgText: SVG, parsed: null },
    ] as unknown as typeof state.sources;
    state.artworks = [instance({ mirror: true })];

    saveSession();
    const saved = loadSavedSession()!;
    expect(saved.artworks[0].mirror).toBe(true);
  });

  it('a session saved before the flag existed restores with it off', async () => {
    // instance() carries no `mirror` key at all, which is what an older session looks like
    await applyRestoredSession(session([{ ...instance(), zoneId: null }]));
    expect(state.artworks).toHaveLength(1);
    expect(state.artworks[0].mirror).toBeFalsy();
  });

  it('drops on restore once the rebound target is no zone at all', async () => {
    // shapeKind 'disc' in session() takes the non-assembly restore branch, which unbinds every
    // zone (see applyRestoredSession's `keepSavedZones = false`) — so even a saved mirror:true
    // has nothing left to mirror onto and setArtworkZone's own clearing rule drops it.
    await applyRestoredSession(session([{ ...instance({ mirror: true }), zoneId: 'right' }]));
    expect(state.artworks[0].mirror).toBe(false);
  });

  it('survives restore while no zones are offered yet (parts manifest still in flight)', async () => {
    // asmLoadFullAssembly returns quietly while the parts manifest is still loading, so the restore
    // sees no zones at all. It keeps the saved zone binding on that reading (an empty zone list is
    // not evidence of anything); the flag has to be kept on the same reading, or a saved mirrored
    // design comes back cutting one side with nothing said.
    const saved = session([{ ...instance({ mirror: true }), zoneId: 'right' }]);
    saved.shapeKind = 'assembly';
    saved.assembly = { kindId: 'chair-body', variantId: null };

    await applyRestoredSession(saved);

    expect(state.assembly.parts).toEqual([]);
    expect(state.artworks[0].zone?.zoneId).toBe('right');
    expect(state.artworks[0].mirror).toBe(true);
  });

  it('survives restore when rebound to a zone that still offers a mirror', async () => {
    // restoreArtworkPool lands mirror:true on the instance before setArtworkZone ever runs; this
    // is the case that flag has to survive — the saved zone is still offered and still mirrors.
    vi.mocked(asmLoadFullAssembly).mockImplementationOnce(async () => {
      state.assembly.parts = [zonedPart(1, 'right', { twin: 'left' })];
    });
    const saved = session([{ ...instance({ mirror: true }), zoneId: 'right' }]);
    saved.shapeKind = 'assembly';
    saved.assembly = { kindId: 'wheel', variantId: null };

    await applyRestoredSession(saved);

    expect(state.artworks[0].zone).toEqual({ partId: 1, zoneId: 'right' });
    expect(state.artworks[0].mirror).toBe(true);
  });
});
