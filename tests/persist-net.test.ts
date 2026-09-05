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
import { WHOLE_CHAIR_ZONE } from '../src/geometry/zones';
import type { ConformalChart } from '../src/geometry/conformal';
import type { ZoneNet } from '../src/geometry/zoneCharts';
import type { ArtworkInstance, AssemblyPart } from '../src/types';

/**
 * The reserved zone id is meant to travel through save/restore like any other zone id (no new
 * persisted shape) — this is the same round-trip persist-mirror.test.ts proves for the Mirror
 * flag, aimed at `WHOLE_CHAIR_ZONE` instead.
 */

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

function chartWithBounds(): ConformalChart {
  return {
    positions3: new Float32Array(),
    uv: new Float32Array(),
    triangles: new Uint32Array(),
    normalSign: 1,
    boundary: [],
    zoneBounds: { minU: 0, minV: 0, maxU: 10, maxV: 10 },
  };
}

function netZonedPart(id: number, zoneId: string): AssemblyPart {
  return {
    id,
    name: `part-${id}`,
    roleId: 'r',
    positions: null,
    patches: null,
    patchIdx: 0,
    boundaryLoops: null,
    zones: [{ id: zoneId, name: zoneId, chart: chartWithBounds() }],
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

const NET: ZoneNet = {
  templateFile: 'net-template.svg',
  bounds: { minU: 0, minV: 0, maxU: 20, maxV: 20 },
  zones: {
    left: { rotationDeg: 0, offsetU: 0, offsetV: 0, attached: true },
    back: { rotationDeg: 0, offsetU: 0, offsetV: 0, attached: true },
  },
};

function session(artworks: PersistedSession['artworks']): PersistedSession {
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
    globalDepth: 1.5,
    recessBg: true,
    printerId: 'snapmaker-u1',
    asmRadius: 140,
    assembly: { kindId: 'chair-body', variantId: null },
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
  state.assembly.net = null;
  state.sources = [];
  state.artworks = [];
  state.activeArtworkId = null;
  vi.mocked(asmLoadFullAssembly).mockReset();
  vi.mocked(asmLoadFullAssembly).mockImplementation(async () => {});
});

describe('the reserved Whole-chair zone id across a reload', () => {
  it('the id itself round-trips through save and restore, same as a real zone id', () => {
    state.sources = [
      { id: 's1', kind: 'upload', name: 'a.svg', svgText: SVG, parsed: null },
    ] as unknown as typeof state.sources;
    state.artworks = [instance({ zone: { partId: 0, zoneId: WHOLE_CHAIR_ZONE } })];

    saveSession();
    const saved = loadSavedSession()!;
    expect(saved.artworks[0].zoneId).toBe(WHOLE_CHAIR_ZONE);
  });

  it('restores bound to Whole chair once the net is loaded', async () => {
    vi.mocked(asmLoadFullAssembly).mockImplementationOnce(async () => {
      state.assembly.parts = [netZonedPart(1, 'left'), netZonedPart(2, 'back')];
      state.assembly.net = NET;
    });

    await applyRestoredSession(session([{ ...instance(), zoneId: WHOLE_CHAIR_ZONE }]));

    expect(state.artworks[0].zone?.zoneId).toBe(WHOLE_CHAIR_ZONE);
  });

  it('falls back to All zones, with a named warning, once the net no longer offers it', async () => {
    // Same path a renamed/retired real zone takes (see docs/troubleshooting.md, "designs were on
    // zones this part no longer has") — the reserved id is offered through the same list, so a
    // sidecar shipped without a net reads it the same way.
    vi.mocked(asmLoadFullAssembly).mockImplementationOnce(async () => {
      state.assembly.parts = [netZonedPart(1, 'left')];
      state.assembly.net = null;
    });

    await applyRestoredSession(session([{ ...instance(), zoneId: WHOLE_CHAIR_ZONE }]));

    expect(state.artworks[0].zone).toBeNull();
  });

  it('keeps the binding while no zones are offered yet (parts manifest still in flight)', async () => {
    // asmLoadFullAssembly's mock default (a no-op) leaves state.assembly.parts empty, the same
    // "not yet" case persist-mirror.test.ts covers for a real zone id.
    await applyRestoredSession(session([{ ...instance(), zoneId: WHOLE_CHAIR_ZONE }]));

    expect(state.assembly.parts).toEqual([]);
    expect(state.artworks[0].zone?.zoneId).toBe(WHOLE_CHAIR_ZONE);
  });
});
